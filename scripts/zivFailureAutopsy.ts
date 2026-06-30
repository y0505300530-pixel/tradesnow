/**
 * zivFailureAutopsy.ts — 4-question failure mechanics autopsy (READ-ONLY)
 * Run: npx tsx scripts/zivFailureAutopsy.ts
 */
import "dotenv/config";
import { fetchBarsForTicker } from "../server/marketData";
import { calcZivEngineScore, calcEMA, type Bar, type ZivScoreResult } from "../server/zivEngine";
import { confirmVolume } from "../server/volumeConfirm";
import { DEFAULT_60_ASSETS } from "../server/routers/portfolio";

const TICKERS = DEFAULT_60_ASSETS.map(a => a.ticker);
const BARS_DAYS = 420;
const MIN_BARS = 50;
const SL_LOOKBACK = 10;
const RC2_MAX = 12;
const FIRST_TARGET_R = 2;
const FREE_ROLL_FRAC = 0.5;
const TIME_STOP_BARS = 10;
const CHAND_MULT = 2.5;
const ATR_PERIOD = 14;
const EARLIEST = "2025-01-01";
const WINDOW_2026 = "2026-01-01";

const S1 = { leverage: 1.0, maxConcurrent: 12, maxPerSector: 3 };
const START = 100_000;
const RISK_PCT = 0.01;
const HEAT = 0.20;
const MAX_POS = 85_000;

const SECTOR: Record<string, string> = {};
for (const a of DEFAULT_60_ASSETS) SECTOR[a.ticker] = a.sector ?? "OTHER";

type ExitReason = "SL" | "TIME" | "TRAIL" | "TRAIL_OPEN" | "OPEN";
type EntryKind = "retest" | "breakout";

interface EnrichedTrade {
  ticker: string;
  entryDate: string;
  exitDate: string;
  entryKind: EntryKind;
  tier: string;
  entryScore: number;
  entry: number;
  sl: number;
  r: number;
  stopDistPct: number;
  exitReason: ExitReason;
  reached2R: boolean;
  leg1R: number;
  leg2R: number;
  barsHeld: number;
  maxR: number;
  distEma50Pct: number;
  distEma20Pct: number;
  goldenCross: boolean;
}

function atr14(bars: Bar[], end: number): number | null {
  if (end < 1) return null;
  const slice = bars.slice(0, end + 1);
  const period = Math.min(ATR_PERIOD, slice.length - 1);
  let sum = 0;
  for (let i = slice.length - period; i < slice.length; i++) {
    sum += Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i - 1].close),
      Math.abs(slice[i].low - slice[i - 1].close),
    );
  }
  return sum / period;
}

function entryKindOf(tier: string): EntryKind {
  return tier === "Gold Breakout" ? "breakout" : "retest";
}

function wantsEntryC(res: ZivScoreResult, bars: Bar[]): boolean {
  if (res.score < 7.5 || res.weeklyEma50Slope <= 0) return false;
  if (res.tier === "Gold Retest") return true;
  if (res.tier === "Gold Breakout") {
    return confirmVolume(bars, res.donchian20High, "long").confirmed;
  }
  return false;
}

function simulateTicker(ticker: string, bars: Bar[], out: EnrichedTrade[]): void {
  let i = 0;
  while (i < bars.length && bars[i].date < EARLIEST) i++;

  for (; i < bars.length; i++) {
    if (i + 1 < MIN_BARS || i + 1 < SL_LOOKBACK) continue;
    const windowBars = bars.slice(0, i + 1);
    let res: ZivScoreResult;
    try { res = calcZivEngineScore(windowBars); } catch { continue; }
    if (res.tier === "No Data" || res.tier === "Error") continue;
    if (!wantsEntryC(res, windowBars)) continue;

    const entry = bars[i].close;
    const sl = Math.min(...bars.slice(i - (SL_LOOKBACK - 1), i + 1).map(b => b.low));
    if (!(sl < entry)) continue;
    const riskPct = ((entry - sl) / entry) * 100;
    if (riskPct > RC2_MAX) continue;
    const risk = entry - sl;
    const target2 = entry + FIRST_TARGET_R * risk;

    const closes = windowBars.map(b => b.close);
    const ema20 = calcEMA(closes, Math.min(20, closes.length));
    const ema50 = res.ema50;
    const distEma50Pct = ema50 > 0 ? Math.abs(entry - ema50) / ema50 * 100 : 999;
    const distEma20Pct = ema20 > 0 ? Math.abs(entry - ema20) / ema20 * 100 : 999;
    const goldenCross = ema20 > ema50;

    let exitReason: ExitReason = "OPEN";
    let exitIdx = bars.length - 1;
    let reached2R = false;
    let leg1R = 0;
    let leg2R = 0;
    let maxR = 0;
    let currentStop = sl;
    let highestHigh = bars[i].high;
    let trailStop = -Infinity;
    let barsHeld = 0;

    for (let j = i + 1; j < bars.length; j++) {
      barsHeld = j - i;
      const bar = bars[j];
      maxR = Math.max(maxR, (bar.high - entry) / risk);

      if (!reached2R) {
        if (bar.low <= currentStop) {
          exitReason = "SL"; exitIdx = j;
          leg1R = (currentStop - entry) / risk;
          break;
        }
        if (bar.high >= target2) {
          reached2R = true;
          leg1R = FREE_ROLL_FRAC * FIRST_TARGET_R;
          currentStop = entry;
          highestHigh = Math.max(highestHigh, bar.high);
          const a = atr14(bars, j);
          trailStop = a && a > 0 ? Math.max(entry, highestHigh - CHAND_MULT * a) : entry;
          currentStop = trailStop;
          continue;
        }
        if (barsHeld > TIME_STOP_BARS) {
          exitReason = "TIME"; exitIdx = j;
          leg1R = (bar.close - entry) / risk;
          break;
        }
        if (j === bars.length - 1) {
          exitReason = "OPEN"; exitIdx = j;
          leg1R = (bar.close - entry) / risk;
        }
      } else {
        highestHigh = Math.max(highestHigh, bar.high);
        const a = atr14(bars, j);
        if (a && a > 0) trailStop = Math.max(trailStop, highestHigh - CHAND_MULT * a);
        currentStop = trailStop;
        if (bar.low <= currentStop) {
          exitReason = "TRAIL"; exitIdx = j;
          leg2R = FREE_ROLL_FRAC * ((currentStop - entry) / risk);
          break;
        }
        if (j === bars.length - 1) {
          exitReason = "TRAIL_OPEN"; exitIdx = j;
          leg2R = FREE_ROLL_FRAC * ((bar.close - entry) / risk);
        }
      }
    }

    const totalR = Math.round((leg1R + leg2R) * 100) / 100;
    out.push({
      ticker,
      entryDate: bars[i].date,
      exitDate: bars[exitIdx].date,
      entryKind: entryKindOf(res.tier),
      tier: res.tier,
      entryScore: res.score,
      entry,
      sl,
      r: totalR,
      stopDistPct: (entry - sl) / entry,
      exitReason,
      reached2R,
      leg1R,
      leg2R,
      barsHeld,
      maxR: Math.round(maxR * 100) / 100,
      distEma50Pct: Math.round(distEma50Pct * 100) / 100,
      distEma20Pct: Math.round(distEma20Pct * 100) / 100,
      goldenCross,
    });
    i = exitIdx;
  }
}

// S1 portfolio — returns Set of taken trade keys
function s1TakenKeys(trades: EnrichedTrade[]): Set<string> {
  const events: { date: string; kind: "E" | "X"; idx: number }[] = [];
  trades.forEach((t, idx) => {
    events.push({ date: t.entryDate, kind: "E", idx });
    events.push({ date: t.exitDate, kind: "X", idx });
  });
  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "X" ? -1 : 1;
    return a.idx - b.idx;
  });

  const taken = new Set<string>();
  const open = new Map<number, { sector: string; risk: number; notional: number }>();
  let equity = START;

  const key = (t: EnrichedTrade) => `${t.ticker}|${t.entryDate}`;

  for (const ev of events) {
    const t = trades[ev.idx];
    if (ev.kind === "E") {
      if (open.size >= S1.maxConcurrent) continue;
      const sec = SECTOR[t.ticker] ?? "OTHER";
      let secN = 0;
      for (const o of open.values()) if (o.sector === sec) secN++;
      if (secN >= S1.maxPerSector) continue;

      let risk = RISK_PCT * equity;
      let openRisk = 0;
      let openNot = 0;
      for (const o of open.values()) { openRisk += o.risk; openNot += o.notional; }
      if ((openRisk + risk) / equity > HEAT) continue;

      let notional = risk / t.stopDistPct;
      if (notional > MAX_POS) { const s = MAX_POS / notional; notional = MAX_POS; risk *= s; }
      const head = Math.max(0, S1.leverage * equity - openNot);
      if (notional > head) { const s = head > 0 ? head / notional : 0; notional *= s; risk *= s; }
      if (notional < 500) continue;

      open.set(ev.idx, { sector: sec, risk, notional });
      taken.add(key(t));
    } else {
      const o = open.get(ev.idx);
      if (!o) continue;
      equity += t.r * o.risk;
      open.delete(ev.idx);
    }
  }
  return taken;
}

function pct(n: number, d: number): string {
  return d ? (100 * n / d).toFixed(1) + "%" : "n/a";
}

function sumR(arr: EnrichedTrade[]): number {
  return Math.round(arr.reduce((s, t) => s + t.r, 0) * 100) / 100;
}

function sumPnlProxy(arr: EnrichedTrade[]): number {
  // proportional $ loss proxy: 1% risk at $100k start — for split magnitude only
  return Math.round(arr.reduce((s, t) => s + t.r * 1000, 0));
}

async function main() {
  console.log("=== ZIV FAILURE AUTOPSY — 4 questions, Config C, S1 context ===\n");

  const all: EnrichedTrade[] = [];
  const barsMap = new Map<string, Bar[]>();
  let n = 0;

  for (const ticker of TICKERS) {
    n++;
    if (n % 40 === 0) console.log(`[load] ${n}/${TICKERS.length}`);
    try {
      let bars = await fetchBarsForTicker(ticker, BARS_DAYS);
      if (bars.length < MIN_BARS) continue;
      bars = [...bars].sort((a, b) => a.date.localeCompare(b.date));
      if (bars[bars.length - 1].date < EARLIEST) continue;
      barsMap.set(ticker, bars);
      simulateTicker(ticker, bars, all);
    } catch { /* skip */ }
  }

  const w2526 = all.filter(t => t.entryDate >= EARLIEST);
  const takenKeys = s1TakenKeys(w2526);
  const s1Trades = w2526.filter(t => takenKeys.has(`${t.ticker}|${t.entryDate}`));
  const s1Losers = s1Trades.filter(t => t.r <= 0);
  const s1Winners = s1Trades.filter(t => t.r > 0);

  console.log(`Raw signals 2025+: ${w2526.length} | S1 taken: ${s1Trades.length} | S1 losers: ${s1Losers.length} | S1 winners: ${s1Winners.length}`);
  console.log(`S1 totalR: ${sumR(s1Trades)} | loserR: ${sumR(s1Losers)} | winnerR: ${sumR(s1Winners)}\n`);

  // ═══ Q1: SL AUTOPSY ═══
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Q1 — SL AUTOPSY (S1 losing trades, n=" + s1Losers.length + ")");
  console.log("═══════════════════════════════════════════════════════════════");

  type Death = "immediate_SL" | "sl_after_green" | "time_stop_pre2R" | "chandelier_post2R" | "other";
  const classify = (t: EnrichedTrade): Death => {
    if (t.reached2R && (t.exitReason === "TRAIL" || t.exitReason === "TRAIL_OPEN")) return "chandelier_post2R";
    if (t.exitReason === "TIME") return "time_stop_pre2R";
    if (t.exitReason === "SL") return t.maxR < 0.3 ? "immediate_SL" : "sl_after_green";
    return "other";
  };

  const buckets: Record<Death, EnrichedTrade[]> = {
    immediate_SL: [], sl_after_green: [], time_stop_pre2R: [], chandelier_post2R: [], other: [],
  };
  for (const t of s1Losers) buckets[classify(t)].push(t);

  for (const [k, arr] of Object.entries(buckets) as [Death, EnrichedTrade[]][]) {
    const labels: Record<Death, string> = {
      immediate_SL: "Immediate structural SL (maxR<0.3, never bounced)",
      sl_after_green: "SL after green flicker (maxR≥0.3, still pre-2R)",
      time_stop_pre2R: "Time-stop >10 bars, never reached +2R",
      chandelier_post2R: "Hit +2R free-roll, then Chandelier gave back",
      other: "Other (OPEN/end-of-data)",
    };
    console.log(`  ${labels[k]}: ${arr.length} (${pct(arr.length, s1Losers.length)}) | sumR=${sumR(arr)} | avg maxR=${arr.length ? (arr.reduce((s,x)=>s+x.maxR,0)/arr.length).toFixed(2) : 0}`);
  }

  const imm = buckets.immediate_SL.length;
  const linger = buckets.sl_after_green.length + buckets.time_stop_pre2R.length;
  const post2r = buckets.chandelier_post2R.length;
  console.log(`\n  HEADLINE Q1: ${pct(imm, s1Losers.length)} died on immediate structural break.`);
  console.log(`  ${pct(linger, s1Losers.length)} languished pre-2R (green flicker + time-stop).`);
  console.log(`  ${pct(post2r, s1Losers.length)} banked 2R then Chandelier trailed out red.\n`);

  // ═══ Q2: EMA-50 vs EMA-20 ═══
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Q2 — EMA-50 vs EMA-20 (momentum geography at entry)");
  console.log("═══════════════════════════════════════════════════════════════");

  const avg = (arr: EnrichedTrade[], f: (t: EnrichedTrade) => number) =>
    arr.length ? (arr.reduce((s, t) => s + f(t), 0) / arr.length).toFixed(2) : "n/a";

  console.log("  At S1 entry — avg distance from EMA:");
  console.log(`    ALL taken:     EMA-50 ${avg(s1Trades, t=>t.distEma50Pct)}% | EMA-20 ${avg(s1Trades, t=>t.distEma20Pct)}%`);
  console.log(`    Losers:        EMA-50 ${avg(s1Losers, t=>t.distEma50Pct)}% | EMA-20 ${avg(s1Losers, t=>t.distEma20Pct)}%`);
  console.log(`    Winners:       EMA-50 ${avg(s1Winners, t=>t.distEma50Pct)}% | EMA-20 ${avg(s1Winners, t=>t.distEma20Pct)}%`);

  const losersWide50 = s1Losers.filter(t => t.distEma50Pct > 3).length;
  const winnersTight50 = s1Winners.filter(t => t.distEma50Pct <= 1.5).length;
  console.log(`\n  Losers with entry >3% from EMA-50: ${losersWide50}/${s1Losers.length} (${pct(losersWide50, s1Losers.length)}) — buying "retest" far from mean`);
  console.log(`  Winners within 1.5% of EMA-50: ${winnersTight50}/${s1Winners.length} (${pct(winnersTight50, s1Winners.length)})`);

  // Missed runners: tickers +40% in 2025 window but no S1 winner >2R
  console.log("\n  Missed momentum (2025): tickers +40% YTD with zero S1 trade R>2:");
  let missedCount = 0;
  const missedList: string[] = [];
  for (const ticker of TICKERS) {
    const bars = barsMap.get(ticker);
    if (!bars) continue;
    const b25 = bars.filter(b => b.date >= "2025-01-01" && b.date <= "2025-12-31");
    if (b25.length < 20) continue;
    const ret = (b25[b25.length - 1].close / b25[0].close - 1) * 100;
    if (ret < 40) continue;
    const our = s1Trades.filter(t => t.ticker === ticker && t.entryDate >= "2025-01-01" && t.entryDate <= "2025-12-31");
    const bestR = our.length ? Math.max(...our.map(t => t.r)) : 0;
    if (bestR < 2) {
      missedCount++;
      if (missedList.length < 12) missedList.push(`${ticker} +${ret.toFixed(0)}% bestOurR=${bestR.toFixed(1)} signals=${our.length}`);
    }
  }
  console.log(`    Count: ${missedCount} names`);
  for (const m of missedList) console.log(`      ${m}`);

  // Would EMA-20 have triggered earlier? Count bars where price within 1.5% EMA-20 but >3% from EMA-50 in 2025 on missed names
  let ema20OnlyOpps = 0;
  for (const ticker of TICKERS) {
    const bars = barsMap.get(ticker);
    if (!bars) continue;
    for (let i = MIN_BARS; i < bars.length; i++) {
      if (bars[i].date < "2025-01-01" || bars[i].date > "2025-12-31") continue;
      const slice = bars.slice(0, i + 1);
      const closes = slice.map(b => b.close);
      const e20 = calcEMA(closes, Math.min(20, closes.length));
      const e50 = calcEMA(closes, Math.min(50, closes.length));
      const c = closes[closes.length - 1];
      const d20 = Math.abs(c - e20) / e20 * 100;
      const d50 = Math.abs(c - e50) / e50 * 100;
      if (d20 <= 1.5 && d50 > 3 && e20 > e50) ema20OnlyOpps++;
    }
  }
  console.log(`\n  2025 bar-days: price near EMA-20 (≤1.5%) BUT far from EMA-50 (>3%) while EMA20>EMA50: ${ema20OnlyOpps}`);
  console.log("  → Strong momentum names often bounce shallow (EMA-20), not deep (EMA-50). Config C waits deep.\n");

  // ═══ Q3: BREAKOUT vs RETEST split on S1 LOSSES ═══
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Q3 — BREAKOUT vs RETEST (S1 losing $ proxy via R×$1k)");
  console.log("═══════════════════════════════════════════════════════════════");

  const retestLoss = s1Losers.filter(t => t.entryKind === "retest");
  const breakoutLoss = s1Losers.filter(t => t.entryKind === "breakout");
  const retestScore78 = retestLoss.filter(t => t.entryScore >= 7 && t.entryScore < 9);
  const breakoutScore910 = breakoutLoss.filter(t => t.entryScore >= 9);

  console.log(`  Retest losers:   n=${retestLoss.length} | sumR=${sumR(retestLoss)} | $proxy=${sumPnlProxy(retestLoss)}`);
  console.log(`  Breakout losers: n=${breakoutLoss.length} | sumR=${sumR(breakoutLoss)} | $proxy=${sumPnlProxy(breakoutLoss)}`);
  console.log(`  Retest score 7-8.x losers: n=${retestScore78.length} sumR=${sumR(retestScore78)}`);
  console.log(`  Breakout score 9-10 losers: n=${breakoutScore910.length} sumR=${sumR(breakoutScore910)}`);

  const totalLossR = Math.abs(sumR(s1Losers));
  console.log(`\n  Share of S1 loser R from RETEST:   ${pct(Math.abs(sumR(retestLoss)), totalLossR)}`);
  console.log(`  Share of S1 loser R from BREAKOUT: ${pct(Math.abs(sumR(breakoutLoss)), totalLossR)}`);

  const retestAll = s1Trades.filter(t => t.entryKind === "retest");
  const breakoutAll = s1Trades.filter(t => t.entryKind === "breakout");
  console.log(`\n  Retest ALL S1:   n=${retestAll.length} win%=${pct(retestAll.filter(t=>t.r>0).length, retestAll.length)} totalR=${sumR(retestAll)}`);
  console.log(`  Breakout ALL S1: n=${breakoutAll.length} win%=${pct(breakoutAll.filter(t=>t.r>0).length, breakoutAll.length)} totalR=${sumR(breakoutAll)}\n`);

  // ═══ Q4: FREE-ROLL 2R killing retests? ═══
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Q4 — FREE-ROLL @2R vs RETEST physics (S1 retest trades)");
  console.log("═══════════════════════════════════════════════════════════════");

  const retestS1 = s1Trades.filter(t => t.entryKind === "retest");
  const reached = retestS1.filter(t => t.reached2R);
  const never2r = retestS1.filter(t => !t.reached2R);

  console.log(`  Retest S1 trades: ${retestS1.length} | reached +2R: ${reached.length} (${pct(reached.length, retestS1.length)})`);
  console.log(`  Never reached 2R: ${never2r.length} | avg maxR=${avg(never2r, t=>t.maxR)}`);

  const band15_20 = never2r.filter(t => t.maxR >= 1.5 && t.maxR < 2.0);
  const band10_15 = never2r.filter(t => t.maxR >= 1.0 && t.maxR < 1.5);
  const band08_10 = never2r.filter(t => t.maxR >= 0.8 && t.maxR < 1.0);

  console.log(`\n  Pre-2R retests that peaked 1.0-1.5R then died: ${band10_15.length} (sumR=${sumR(band10_15)})`);
  console.log(`  Pre-2R retests that peaked 1.5-2.0R then died: ${band15_20.length} (sumR=${sumR(band15_20)}) ← "almost free-roll"`);
  console.log(`  Pre-2R retests that peaked 0.8-1.0R: ${band08_10.length}`);

  const timeInBand = band15_20.filter(t => t.exitReason === "TIME");
  const slInBand = band15_20.filter(t => t.exitReason === "SL");
  console.log(`  Of 1.5-2.0R peak failures: TIME=${timeInBand.length} SL=${slInBand.length}`);

  // Hypothetical: if free-roll at 1.5R instead of 2R on retest never2r with maxR>=1.5
  const hypoSaved = band15_20.length * 0.5 * 1.5; // rough: half position banks 1.5R
  console.log(`\n  HYPOTHETICAL (not a config change): if retest free-roll fired at 1.5R instead of 2R,`);
  console.log(`  ${band15_20.length} trades might have banked ~${hypoSaved.toFixed(0)}R vs dying (upper bound, ignores trail path).`);

  const post2rLosers = retestS1.filter(t => t.reached2R && t.r <= 0);
  console.log(`  Retests that DID hit 2R but finished ≤0R (Chandelier give-back): ${post2rLosers.length}`);

  console.log("\n=== END AUTOPSY ===");
}

main().catch(e => { console.error(e); process.exit(1); });
