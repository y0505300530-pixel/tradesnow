/**
 * elzaV3Harness.ts — Elza v3 Shallow Momentum simulation (READ-ONLY)
 *
 * Pivot from deep EMA-50 retest → shallow EMA-20/10 momentum + fast time-stop.
 *
 * RUN: npx tsx scripts/elzaV3Harness.ts
 */
import "dotenv/config";
import { fetchBarsForTicker } from "../server/marketData";
import { calcZivEngineScore, calcEMA, type Bar, type ZivScoreResult } from "../server/zivEngine";
import { confirmVolume } from "../server/volumeConfirm";
import { DEFAULT_60_ASSETS } from "../server/routers/portfolio";

const TICKERS = DEFAULT_60_ASSETS.map(a => a.ticker);

// ─── v3 entry ────────────────────────────────────────────────────────────────
const ENTRY_MIN_SCORE = 7.5;
const BREAKOUT_MIN_SCORE = 9;
const EMA_TOUCH_PCT = 1.5;          // within 1.5% of EMA-20 or EMA-10
const EMA50_TOUCH_LOOKBACK = 5;       // bars — if low touches EMA-50 → REJECT
const EMA50_TOUCH_BUFFER = 0.002;     // 0.2% above EMA-50 counts as touch

// ─── v3 exit (unchanged free-roll + chandelier) ────────────────────────────
const SL_LOOKBACK = 10;
const RC2_MAX_RISK_PCT = 12;
const FIRST_TARGET_R = 2;
const FREE_ROLL_FRACTION = 0.5;
const CHANDELIER_ATR_MULT = 2.5;
const ATR_PERIOD = 14;

// ─── v3 fast time-stop ─────────────────────────────────────────────────────
const TIME_STOP_BARS = 4;             // hard 4 trading days (was 10)
const TIME_STOP_MIN_R = 1.0;          // must reach +1R within 4 days or market-close kill

// ─── portfolio baseline ──────────────────────────────────────────────────────
const START_EQUITY = 100_000;
const LEVERAGE = 1.0;
const MAX_CONCURRENT = 10;
const MAX_BREAKOUT_OPEN = 2;          // limited breakout slots
const HEAT_CAP = 0.20;
const MAX_POSITION_USD = 85_000;
const RISK_PCT = 0.01;

const BARS_DAYS = 420;
const MIN_BARS = 50;
const WINDOWS = [
  { label: "2025", start: "2025-01-01" },
  { label: "2026 YTD", start: "2026-01-01" },
];
const EARLIEST = WINDOWS.reduce((m, w) => (w.start < m ? w.start : m), WINDOWS[0].start);

type ExitReason = "SL" | "TIME" | "TRAIL" | "TRAIL_OPEN" | "OPEN";
type EntryKind = "shallow" | "breakout";

interface RawTrade {
  ticker: string;
  entryDate: string;
  exitDate: string;
  entryKind: EntryKind;
  tier: string;
  entryScore: number;
  entry: number;
  sl: number;
  exitReason: ExitReason;
  r: number;
  stopDistPct: number;
  reached1R: boolean;
  reached2R: boolean;
  barsHeld: number;
  maxR: number;
}

function computeAtr14(window: Bar[]): number | null {
  if (window.length < 2) return null;
  const period = Math.min(ATR_PERIOD, window.length - 1);
  let atrSum = 0;
  for (let i = window.length - period; i < window.length; i++) {
    atrSum += Math.max(
      window[i].high - window[i].low,
      Math.abs(window[i].high - window[i - 1].close),
      Math.abs(window[i].low - window[i - 1].close),
    );
  }
  return atrSum / period;
}

/** Hard reject: any bar in lookback whose low touches or breaks EMA-50 */
function touchesEma50Recently(bars: Bar[], i: number): boolean {
  const start = Math.max(MIN_BARS - 1, i - EMA50_TOUCH_LOOKBACK + 1);
  for (let k = start; k <= i; k++) {
    const slice = bars.slice(0, k + 1);
    const closes = slice.map(b => b.close);
    const ema50 = calcEMA(closes, Math.min(50, closes.length));
    if (ema50 <= 0) continue;
    if (bars[k].low <= ema50 * (1 + EMA50_TOUCH_BUFFER)) return true;
  }
  return false;
}

/** Shallow: price within EMA_TOUCH_PCT of EMA-20 OR EMA-10 */
function isShallowTouch(bars: Bar[], i: number): boolean {
  const slice = bars.slice(0, i + 1);
  const closes = slice.map(b => b.close);
  const entry = bars[i].close;
  const ema20 = calcEMA(closes, Math.min(20, closes.length));
  const ema10 = calcEMA(closes, Math.min(10, closes.length));
  const d20 = ema20 > 0 ? Math.abs(entry - ema20) / ema20 * 100 : 999;
  const d10 = ema10 > 0 ? Math.abs(entry - ema10) / ema10 * 100 : 999;
  return d20 <= EMA_TOUCH_PCT || d10 <= EMA_TOUCH_PCT;
}

function wantsEntryV3(res: ZivScoreResult, bars: Bar[], i: number): EntryKind | null {
  if (res.tier === "No Data" || res.tier === "Error") return null;
  if (res.score < ENTRY_MIN_SCORE || res.weeklyEma50Slope <= 0) return null;
  if (touchesEma50Recently(bars, i)) return null;

  if (res.tier === "Gold Breakout" && res.score >= BREAKOUT_MIN_SCORE) {
    if (confirmVolume(bars, res.donchian20High, "long").confirmed) return "breakout";
  }

  if (isShallowTouch(bars, i)) return "shallow";
  return null;
}

function simulateV3(ticker: string, bars: Bar[], out: RawTrade[]): void {
  let i = 0;
  while (i < bars.length && bars[i].date < EARLIEST) i++;

  for (; i < bars.length; i++) {
    if (i + 1 < MIN_BARS || i + 1 < SL_LOOKBACK) continue;

    const windowBars = bars.slice(0, i + 1);
    let res: ZivScoreResult;
    try { res = calcZivEngineScore(windowBars); } catch { continue; }

    const kind = wantsEntryV3(res, windowBars, i);
    if (!kind) continue;

    const entry = bars[i].close;
    const sl = Math.min(...bars.slice(i - (SL_LOOKBACK - 1), i + 1).map(b => b.low));
    if (!(sl < entry) || !(entry > 0)) continue;

    const riskPct = ((entry - sl) / entry) * 100;
    if (riskPct > RC2_MAX_RISK_PCT) continue;

    const risk = entry - sl;
    const target1R = entry + TIME_STOP_MIN_R * risk;
    const firstTarget = entry + FIRST_TARGET_R * risk;

    let exitDate = bars[bars.length - 1].date;
    let exitReason: ExitReason = "OPEN";
    let exitIndex = bars.length - 1;
    let reachedFirstTarget = false;
    let reached1R = false;
    let leg1R = 0;
    let leg2R = 0;
    let maxR = 0;
    let barsHeld = 0;

    let currentStop = sl;
    let highestHigh = bars[i].high;
    let trailStop = -Infinity;

    for (let j = i + 1; j < bars.length; j++) {
      barsHeld = j - i;
      const bar = bars[j];
      maxR = Math.max(maxR, (bar.high - entry) / risk);
      if (bar.high >= target1R) reached1R = true;

      if (!reachedFirstTarget) {
        if (bar.low <= currentStop) {
          exitReason = "SL"; exitDate = bar.date; exitIndex = j;
          leg1R = (currentStop - entry) / risk;
          break;
        }
        if (bar.high >= firstTarget) {
          reachedFirstTarget = true;
          leg1R = FREE_ROLL_FRACTION * FIRST_TARGET_R;
          currentStop = entry;
          highestHigh = Math.max(highestHigh, bar.high);
          const atr = computeAtr14(bars.slice(0, j + 1));
          trailStop = atr && atr > 0
            ? Math.max(entry, highestHigh - CHANDELIER_ATR_MULT * atr)
            : entry;
          currentStop = trailStop;
          continue;
        }
        // v3 fast time-stop: 4 bars, must have hit +1R
        if (barsHeld >= TIME_STOP_BARS && !reached1R) {
          exitReason = "TIME"; exitDate = bar.date; exitIndex = j;
          leg1R = (bar.close - entry) / risk;
          break;
        }
        if (j === bars.length - 1) {
          exitReason = "OPEN"; exitDate = bar.date; exitIndex = j;
          leg1R = (bar.close - entry) / risk;
        }
      } else {
        highestHigh = Math.max(highestHigh, bar.high);
        const atr = computeAtr14(bars.slice(0, j + 1));
        if (atr && atr > 0) {
          trailStop = Math.max(trailStop, highestHigh - CHANDELIER_ATR_MULT * atr);
        }
        currentStop = trailStop;
        if (bar.low <= currentStop) {
          exitReason = "TRAIL"; exitDate = bar.date; exitIndex = j;
          leg2R = FREE_ROLL_FRACTION * ((currentStop - entry) / risk);
          break;
        }
        if (j === bars.length - 1) {
          exitReason = "TRAIL_OPEN"; exitDate = bar.date; exitIndex = j;
          leg2R = FREE_ROLL_FRACTION * ((bar.close - entry) / risk);
        }
      }
    }

    out.push({
      ticker,
      entryDate: bars[i].date,
      exitDate,
      entryKind: kind,
      tier: res.tier,
      entryScore: res.score,
      entry,
      sl,
      exitReason,
      r: Math.round((leg1R + leg2R) * 100) / 100,
      stopDistPct: (entry - sl) / entry,
      reached1R,
      reached2R: reachedFirstTarget,
      barsHeld,
      maxR: Math.round(maxR * 100) / 100,
    });
    i = exitIndex;
  }
}

// ─── Portfolio (v3: 10-slot cluster cap + breakout limit) ─────────────────────
interface PortfolioResult {
  label: string;
  tradesTaken: number;
  tradesSkippedConcurrency: number;
  tradesSkippedBreakoutCap: number;
  heatSkips: number;
  wins: number;
  winPct: number;
  totalR: number;
  finalEquity: number;
  finalReturnPct: number;
  maxDrawdownPct: number;
  exitBreakdown: Record<string, number>;
  shallowStats: { n: number; totalR: number; winPct: number };
  breakoutStats: { n: number; totalR: number; winPct: number };
  timeStopCount: number;
  avgBarsHeld: number;
  curve: Array<{ date: string; equity: number }>;
}

function runPortfolioV3(windowTrades: RawTrade[], label: string): PortfolioResult {
  const events: { date: string; kind: "E" | "X"; idx: number }[] = [];
  windowTrades.forEach((t, idx) => {
    events.push({ date: t.entryDate, kind: "E", idx });
    events.push({ date: t.exitDate, kind: "X", idx });
  });
  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "X" ? -1 : 1;
    return a.idx - b.idx;
  });

  let equity = START_EQUITY;
  let peak = START_EQUITY;
  let maxDD = 0;
  let concurrencySkips = 0;
  let breakoutSkips = 0;
  let heatSkips = 0;

  const open = new Map<number, { risk: number; notional: number; kind: EntryKind }>();
  const closed: Array<{ t: RawTrade; pnl: number; taken: boolean }> = [];
  const curve: Array<{ date: string; equity: number }> = [
    { date: windowTrades[0]?.entryDate ?? EARLIEST, equity },
  ];

  const grossNotional = () => [...open.values()].reduce((s, o) => s + o.notional, 0);
  const grossRisk = () => [...open.values()].reduce((s, o) => s + o.risk, 0);
  const openBreakouts = () => [...open.values()].filter(o => o.kind === "breakout").length;

  for (const ev of events) {
    const t = windowTrades[ev.idx];
    if (ev.kind === "E") {
      if (open.size >= MAX_CONCURRENT) {
        concurrencySkips++;
        closed.push({ t, pnl: 0, taken: false });
        continue;
      }
      if (t.entryKind === "breakout" && openBreakouts() >= MAX_BREAKOUT_OPEN) {
        breakoutSkips++;
        closed.push({ t, pnl: 0, taken: false });
        continue;
      }

      let risk = RISK_PCT * equity;
      if ((grossRisk() + risk) / equity > HEAT_CAP) {
        heatSkips++;
        closed.push({ t, pnl: 0, taken: false });
        continue;
      }

      let notional = risk / t.stopDistPct;
      if (notional > MAX_POSITION_USD) {
        const s = MAX_POSITION_USD / notional;
        notional = MAX_POSITION_USD;
        risk *= s;
      }
      const head = Math.max(0, LEVERAGE * equity - grossNotional());
      if (notional > head) {
        const s = head > 0 ? head / notional : 0;
        notional *= s;
        risk *= s;
      }
      if (notional < 500) {
        closed.push({ t, pnl: 0, taken: false });
        continue;
      }

      open.set(ev.idx, { risk, notional, kind: t.entryKind });
    } else {
      const o = open.get(ev.idx);
      if (!o) continue;
      open.delete(ev.idx);
      const pnl = t.r * o.risk;
      equity += pnl;
      closed.push({ t, pnl, taken: true });
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? (peak - equity) / peak : 0;
      if (dd > maxDD) maxDD = dd;
      curve.push({ date: ev.date, equity: Math.round(equity) });
    }
  }

  const taken = closed.filter(c => c.taken);
  const wins = taken.filter(c => c.t.r > 0).length;
  const exitBreakdown: Record<string, number> = {};
  for (const c of taken) exitBreakdown[c.t.exitReason] = (exitBreakdown[c.t.exitReason] ?? 0) + 1;

  const shallow = taken.filter(c => c.t.entryKind === "shallow");
  const breakout = taken.filter(c => c.t.entryKind === "breakout");
  const stat = (arr: typeof taken) => ({
    n: arr.length,
    totalR: Math.round(arr.reduce((s, c) => s + c.t.r, 0) * 100) / 100,
    winPct: arr.length ? (arr.filter(c => c.t.r > 0).length / arr.length) * 100 : 0,
  });

  return {
    label,
    tradesTaken: taken.length,
    tradesSkippedConcurrency: concurrencySkips,
    tradesSkippedBreakoutCap: breakoutSkips,
    heatSkips,
    wins,
    winPct: taken.length ? (wins / taken.length) * 100 : 0,
    totalR: Math.round(taken.reduce((s, c) => s + c.t.r, 0) * 100) / 100,
    finalEquity: Math.round(equity),
    finalReturnPct: ((equity - START_EQUITY) / START_EQUITY) * 100,
    maxDrawdownPct: maxDD * 100,
    exitBreakdown,
    shallowStats: stat(shallow),
    breakoutStats: stat(breakout),
    timeStopCount: taken.filter(c => c.t.exitReason === "TIME").length,
    avgBarsHeld: taken.length ? taken.reduce((s, c) => s + c.t.barsHeld, 0) / taken.length : 0,
    curve,
  };
}

function spyBenchmark(spyBars: Bar[], start: string) {
  const win = spyBars.filter(b => b.date >= start).sort((a, b) => a.date.localeCompare(b.date));
  if (win.length < 2) return null;
  const base = win[0].close;
  let peak = START_EQUITY;
  let maxDD = 0;
  for (const b of win) {
    const eq = START_EQUITY * (b.close / base);
    if (eq > peak) peak = eq;
    maxDD = Math.max(maxDD, peak > 0 ? (peak - eq) / peak : 0);
  }
  const last = win[win.length - 1].close;
  return {
    returnPct: ((last / base) - 1) * 100,
    maxDDPct: maxDD * 100,
  };
}

function sign(n: number) { return n >= 0 ? "+" : ""; }

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  ELZA v3 — Shallow Momentum Harness (2025–2026 OOS)         ║");
  console.log("║  Entry: EMA-20/10 touch | Reject EMA-50 touch | 4d/+1R TS  ║");
  console.log("║  Portfolio: 1.0× lev | max 10 slots | breakout cap 2       ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const all: RawTrade[] = [];
  let n = 0;
  for (const ticker of TICKERS) {
    n++;
    if (n % 40 === 0) console.log(`[load] ${n}/${TICKERS.length}`);
    try {
      let bars = await fetchBarsForTicker(ticker, BARS_DAYS);
      if (bars.length < MIN_BARS) continue;
      bars = [...bars].sort((a, b) => a.date.localeCompare(b.date));
      if (bars[bars.length - 1].date < EARLIEST) continue;
      simulateV3(ticker, bars, all);
    } catch { /* skip */ }
  }

  all.sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  console.log(`\nRaw v3 signals (2025+): ${all.length}`);
  console.log(`  shallow: ${all.filter(t => t.entryKind === "shallow").length} | breakout: ${all.filter(t => t.entryKind === "breakout").length}`);

  let spyBars: Bar[] = [];
  try {
    spyBars = [...(await fetchBarsForTicker("SPY", BARS_DAYS))].sort((a, b) => a.date.localeCompare(b.date));
  } catch { console.log("[WARN] SPY fetch failed"); }

  for (const w of WINDOWS) {
    const winTrades = all.filter(t => t.entryDate >= w.start);
    const pf = runPortfolioV3(winTrades, w.label);
    const spy = spyBenchmark(spyBars, w.start);

    console.log(`\n${"═".repeat(64)}`);
    console.log(`WINDOW ${w.label}`);
    console.log(`${"═".repeat(64)}`);
    console.log(`  Trades taken:        ${pf.tradesTaken}`);
    console.log(`  Queue-lock skips:    ${pf.tradesSkippedConcurrency} (10-slot cap)`);
    console.log(`  Breakout cap skips:  ${pf.tradesSkippedBreakoutCap}`);
    console.log(`  Heat skips:          ${pf.heatSkips}`);
    console.log(`  Win%:                ${pf.winPct.toFixed(1)}%`);
    console.log(`  Total R:             ${sign(pf.totalR)}${pf.totalR.toFixed(1)}R`);
    console.log(`  Portfolio return:    ${sign(pf.finalReturnPct)}${pf.finalReturnPct.toFixed(1)}%  ($${pf.finalEquity.toLocaleString()})`);
    console.log(`  Max DD:              ${pf.maxDrawdownPct.toFixed(1)}%`);
    console.log(`  Avg bars held:       ${pf.avgBarsHeld.toFixed(1)}`);
    console.log(`  Time-stop exits:     ${pf.timeStopCount} (${pf.tradesTaken ? (100 * pf.timeStopCount / pf.tradesTaken).toFixed(0) : 0}%)`);
    console.log(`  Exits: ${JSON.stringify(pf.exitBreakdown)}`);
    console.log(`  Shallow: n=${pf.shallowStats.n} win%=${pf.shallowStats.winPct.toFixed(0)}% R=${sign(pf.shallowStats.totalR)}${pf.shallowStats.totalR}`);
    console.log(`  Breakout: n=${pf.breakoutStats.n} win%=${pf.breakoutStats.winPct.toFixed(0)}% R=${sign(pf.breakoutStats.totalR)}${pf.breakoutStats.totalR}`);

    if (spy) {
      const alpha = pf.finalReturnPct - spy.returnPct;
      console.log(`\n  SPY buy&hold:        ${sign(spy.returnPct)}${spy.returnPct.toFixed(1)}%  (maxDD ${spy.maxDDPct.toFixed(1)}%)`);
      console.log(`  Alpha vs SPY:        ${sign(alpha)}${alpha.toFixed(1)}%`);
      const verdict = pf.finalReturnPct >= spy.returnPct
        ? "POSITIVE-ALPHA vs SPY"
        : spy.returnPct > 0 && pf.finalReturnPct < 0
          ? "NEGATIVE-ALPHA (severe) — v3 still losing in bull"
          : "UNDERPERFORMED SPY";
      console.log(`  VERDICT:             ${verdict}`);
    }
  }

  console.log("\n=== END ELZA v3 HARNESS ===");
}

main().catch(e => { console.error(e); process.exit(1); });
