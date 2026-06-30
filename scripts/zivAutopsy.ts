/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  zivAutopsy.ts — READ-ONLY FORENSIC AUTOPSY of the Ziv Config-C LONG book  ║
 * ║                                                                            ║
 * ║  PURE SIMULATION. NO DB writes. NO IBKR. NO orders. NO deploy. NO SSH.     ║
 * ║                                                                            ║
 * ║  Re-generates the SAME Config-C LONG trade population as                   ║
 * ║  scripts/zivCatalogOOS.ts (ENTRY decision + free-roll/Chandelier EXIT walk ║
 * ║  copied BYTE-IDENTICAL), over the 214-ticker live catalogue, then runs a   ║
 * ║  trade-level autopsy answering four specific death-cause questions.        ║
 * ║                                                                            ║
 * ║  Trade-level autopsy is SIZING-INDEPENDENT: we analyse the trade list      ║
 * ║  itself (R, tier, mfeR, daysHeld, EMA-distance), NOT a sized equity curve. ║
 * ║  No portfolio/ClusterGuard layer here. Split by window where noted         ║
 * ║  (2025 from 2025-01-01, 2026 from 2026-01-01).                             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * RUN (manager runs this on the droplet — has Yahoo/DB data; 214 tickers is slow):
 *   node --import tsx --env-file=.env scripts/zivAutopsy.ts
 *
 * BUILD-CHECK (local, no run):
 *   npx esbuild scripts/zivAutopsy.ts --bundle --platform=node --packages=external --outdir=/tmp/autbc
 *
 * DATA SOURCE / SCORING / ENTRY / EXIT are identical to zivCatalogOOS.ts (see that
 * file's header). The ONLY additions here are per-trade forensic fields, computed
 * by re-walking the SAME bars from entry to exit:
 *   mfeR          = max over held bars of (barHigh − entry)/(entry − initialSL)
 *   daysHeld      = exitIndex − entryIndex (bars held)
 *   entryEma20Dist= (entry − EMA20)/EMA20 at the entry bar (EMA20 from bars via calcEMA)
 *   entryEma50Dist= (entry − EMA50)/EMA50 at the entry bar (EMA50 = res.ema50)
 *   tier          = "Gold Retest" | "Gold Breakout" (already known from the engine)
 */

import "dotenv/config";
import { fetchBarsForTicker } from "../server/marketData";
import { calcZivEngineScore, calcEMA, type Bar, type ZivScoreResult } from "../server/zivEngine";
import { confirmVolume } from "../server/volumeConfirm";
import { DEFAULT_60_ASSETS } from "../server/routers/portfolio";

// ─── Universe (the ~214-stock live catalogue) ────────────────────────────────
const TICKERS: string[] = DEFAULT_60_ASSETS.map(a => a.ticker);

// ─── Engine / trade-model parameters (mirror zivCatalogOOS.ts Config C) ──────
const BARS_DAYS = 420;               // fetchBarsForTicker(ticker, 420) — ~back to 2024-10
const MIN_BARS = 50;                 // zivEngine needs >= 50 bars; skip a bar if fewer
const ENTRY_MIN_SCORE = 7.5;         // gate score threshold for gold entries

const SL_LOOKBACK = 10;              // structural SL = min(low) over last 10 bars (i-9..i)
const RC2_MAX_RISK_PCT = 12;         // RC-2 guard: skip entry if (entry-SL)/entry > 12%
const FIRST_TARGET_R = 2;            // free-roll trigger: bank 50% at +2R
const FREE_ROLL_FRACTION = 0.5;      // partial-close fraction at +2R
const TIME_STOP_BARS = 10;           // pre-free-roll time-stop: held > 10 bars before +2R
const CHANDELIER_ATR_MULT = 2.5;     // chand = peakHigh − 2.5×ATR (live isLong branch)
const ATR_PERIOD = 14;               // computeAtr14 — SIMPLE (non-Wilder) mean True Range

// ─── Windows (entryDate filter; both run to last bar / today) ────────────────
const WINDOWS: { label: string; start: string }[] = [
  { label: "2025", start: "2025-01-01" },
  { label: "2026", start: "2026-01-01" },
];
const EARLIEST_WINDOW_START = WINDOWS.reduce(
  (min, w) => (w.start < min ? w.start : min),
  WINDOWS[0].start,
);

/**
 * SIMPLE 14-period ATR — byte-for-byte computeAtr14 (server/slCalculator.ts:251):
 * mean True Range over the last min(14, len-1) bars (NOT Wilder smoothing).
 */
function computeAtr14Local(window: Bar[]): number | null {
  if (window.length < 2) return null;
  const period = Math.min(ATR_PERIOD, window.length - 1);
  let atrSum = 0;
  for (let i = window.length - period; i < window.length; i++) {
    const tr = Math.max(
      window[i].high - window[i].low,
      Math.abs(window[i].high - window[i - 1].close),
      Math.abs(window[i].low - window[i - 1].close),
    );
    atrSum += tr;
  }
  return atrSum / period;
}

type ExitReason = "SL" | "TIME" | "TRAIL" | "TRAIL_OPEN" | "OPEN";

// ── Forensic trade record: the base RawTrade fields + per-trade autopsy fields. ──
interface AutopsyTrade {
  ticker: string;
  entryDate: string;
  exitDate: string;
  tier: string;
  entry: number;
  sl: number;
  exitReason: ExitReason;
  r: number;                 // TOTAL R-multiple = leg1R + leg2R
  stopDistPct: number;       // (entry - sl) / entry
  // ── autopsy additions ──
  mfeR: number;              // max favorable excursion in R = max held (high-entry)/(entry-sl)
  daysHeld: number;          // exitIndex − entryIndex (bars held)
  entryEma20Dist: number;    // (entry − EMA20)/EMA20 at entry bar
  entryEma50Dist: number;    // (entry − EMA50)/EMA50 at entry bar
}

/**
 * CONFIG C entry decision (current live), LONG only — BYTE-IDENTICAL to
 * zivCatalogOOS.ts wantsEntryConfigC:
 *   ENTER when  (tier === "Gold Retest"   && score >= 7.5 && weeklyEma50Slope > 0)
 *           OR  (tier === "Gold Breakout" && score >= 7.5 && weeklyEma50Slope > 0
 *                && confirmVolume(bars, donchian20High, "long").confirmed)
 */
function wantsEntryConfigC(res: ZivScoreResult, windowBars: Bar[]): boolean {
  const weeklyAligned = res.weeklyEma50Slope > 0;
  const scoreOk = res.score >= ENTRY_MIN_SCORE;

  const retestEntry = res.tier === "Gold Retest" && scoreOk && weeklyAligned;
  if (retestEntry) return true;

  const isGoldBreakout = res.tier === "Gold Breakout" && scoreOk && weeklyAligned;
  if (!isGoldBreakout) return false;
  return confirmVolume(windowBars, res.donchian20High, "long").confirmed;
}

/**
 * Simulate Config C over one ticker's bars — ENTRY + EXIT walk BYTE-IDENTICAL to
 * zivCatalogOOS.ts simulateConfigC, with autopsy fields computed inline.
 * Pushes AutopsyTrades into `out`.
 */
function simulateConfigC(ticker: string, bars: Bar[], out: AutopsyTrade[]): void {
  let i = 0;
  while (i < bars.length && bars[i].date < EARLIEST_WINDOW_START) i++;

  for (; i < bars.length; i++) {
    if (i + 1 < MIN_BARS) continue;
    if (i + 1 < SL_LOOKBACK) continue;

    const windowBars = bars.slice(0, i + 1);
    let res: ZivScoreResult;
    try {
      res = calcZivEngineScore(windowBars);
    } catch {
      continue;
    }
    if (res.tier === "No Data" || res.tier === "Error") continue;
    if (!wantsEntryConfigC(res, windowBars)) continue;

    // ── ENTRY ─────────────────────────────────────────────────────────────────
    const entry = bars[i].close;
    const slWindow = bars.slice(i - (SL_LOOKBACK - 1), i + 1);
    const sl = Math.min(...slWindow.map(b => b.low));
    if (!(sl < entry) || !(entry > 0)) continue;

    const riskPct = ((entry - sl) / entry) * 100;
    if (riskPct > RC2_MAX_RISK_PCT) continue;

    const risk = entry - sl;
    const firstTarget = entry + FIRST_TARGET_R * risk;

    // ── EXIT walk-forward — REAL two-stage free-roll + Chandelier trail ─────────
    let exitDate = bars[bars.length - 1].date;
    let exitReason: ExitReason = "OPEN";
    let exitIndex = bars.length - 1;

    let reachedFirstTarget = false;
    let leg1R = 0;
    let leg2R = 0;

    let currentStop = sl;
    let highestHigh = bars[i].high;
    let trailStop = -Infinity;

    for (let j = i + 1; j < bars.length; j++) {
      const bar = bars[j];
      const heldBars = j - i;

      if (!reachedFirstTarget) {
        if (bar.low <= currentStop) {
          exitReason = "SL"; exitDate = bar.date; exitIndex = j;
          leg1R = (currentStop - entry) / risk;
          leg2R = 0;
          break;
        }
        if (bar.high >= firstTarget) {
          reachedFirstTarget = true;
          leg1R = FREE_ROLL_FRACTION * FIRST_TARGET_R;
          currentStop = entry;
          highestHigh = Math.max(highestHigh, bar.high);
          const atr = computeAtr14Local(bars.slice(0, j + 1));
          if (atr != null && atr > 0) {
            const chand = highestHigh - CHANDELIER_ATR_MULT * atr;
            trailStop = Math.max(currentStop, chand);
          } else {
            trailStop = currentStop;
          }
          currentStop = trailStop;
          continue;
        }
        if (heldBars > TIME_STOP_BARS) {
          exitReason = "TIME"; exitDate = bar.date; exitIndex = j;
          leg1R = (bar.close - entry) / risk;
          leg2R = 0;
          break;
        }
        if (j === bars.length - 1) {
          exitReason = "OPEN"; exitDate = bar.date; exitIndex = j;
          leg1R = (bar.close - entry) / risk;
          leg2R = 0;
        }
      } else {
        highestHigh = Math.max(highestHigh, bar.high);
        const atr = computeAtr14Local(bars.slice(0, j + 1));
        if (atr != null && atr > 0) {
          const chand = highestHigh - CHANDELIER_ATR_MULT * atr;
          trailStop = Math.max(trailStop, chand);
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

    if (i === bars.length - 1) {
      exitDate = bars[i].date; exitReason = "OPEN"; exitIndex = i;
      leg1R = 0; leg2R = 0; reachedFirstTarget = false;
    }

    const r = Math.round((leg1R + leg2R) * 100) / 100;

    // ── AUTOPSY FIELDS (re-walk the SAME held bars i+1..exitIndex) ─────────────
    // mfeR uses the FULL-position risk (entry − initialSL) as the R unit — the same
    // unit the +2R free-roll trigger is measured in (firstTarget = entry + 2·risk).
    // We scan inclusive of the exit bar's high (a peak on the exit bar still counts).
    let maxHigh = bars[i].high;
    for (let j = i + 1; j <= exitIndex && j < bars.length; j++) {
      if (bars[j].high > maxHigh) maxHigh = bars[j].high;
    }
    const mfeR = risk > 0 ? (maxHigh - entry) / risk : 0;
    const daysHeld = exitIndex - i;

    // EMA20 from bars (calcEMA — same routine the engine uses for ema50/ema20).
    // EMA50 taken from the engine result (res.ema50) to stay byte-faithful to scoring.
    const closesUpToEntry = windowBars.map(b => b.close);
    const ema20 = calcEMA(closesUpToEntry, 20);
    const ema50 = res.ema50;
    const entryEma20Dist = ema20 > 0 ? (entry - ema20) / ema20 : 0;
    const entryEma50Dist = ema50 > 0 ? (entry - ema50) / ema50 : 0;

    out.push({
      ticker,
      entryDate: bars[i].date,
      exitDate,
      tier: res.tier,
      entry,
      sl,
      exitReason,
      r,
      stopDistPct: (entry - sl) / entry,
      mfeR: Math.round(mfeR * 1000) / 1000,
      daysHeld,
      entryEma20Dist: Math.round(entryEma20Dist * 10000) / 10000,
      entryEma50Dist: Math.round(entryEma50Dist * 10000) / 10000,
    });

    i = exitIndex;
  }
}

// ─── Small stat helpers ──────────────────────────────────────────────────────
function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
function sum(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0);
}
function pct(n: number, d: number): number {
  return d > 0 ? (n / d) * 100 : 0;
}
function pad(s: string | number, w: number): string {
  const str = String(s);
  return str.length >= w ? str : str + " ".repeat(w - str.length);
}
function padL(s: string | number, w: number): string {
  const str = String(s);
  return str.length >= w ? str : " ".repeat(w - str.length) + str;
}
function sign(n: number): string { return n >= 0 ? "+" : ""; }
function f1(n: number): string { return (Math.round(n * 10) / 10).toFixed(1); }
function f2(n: number): string { return (Math.round(n * 100) / 100).toFixed(2); }

// Trades whose entryDate falls in a given window (>= start).
function inWindow(trades: AutopsyTrade[], start: string): AutopsyTrade[] {
  return trades.filter(t => t.entryDate >= start);
}

// ════════════════════════════════════════════════════════════════════════════
// Q1 — SL AUTOPSY: how do LOSING trades die?
// ════════════════════════════════════════════════════════════════════════════
function reportQ1(trades: AutopsyTrade[]): void {
  console.log("");
  console.log("════════════════════════════════════════════════════════════════════════════");
  console.log("Q1 — SL AUTOPSY (how do LOSING trades, final R < 0, die?) — ALL windows pooled");
  console.log("════════════════════════════════════════════════════════════════════════════");

  const losers = trades.filter(t => t.r < 0);

  // Buckets:
  //  (a) immediate structural SL : exitReason SL AND daysHeld <= 3
  //  (b) slow SL                 : exitReason SL AND daysHeld > 3
  //  (c) TIME-stop death         : exitReason TIME
  //  (d) TRAIL gave-back         : exitReason TRAIL / TRAIL_OPEN (rode up then trailed to a loss)
  //  (other) OPEN losers (rare; end-of-data still red) reported separately so % sums clean.
  const immediateSL = losers.filter(t => t.exitReason === "SL" && t.daysHeld <= 3);
  const slowSL      = losers.filter(t => t.exitReason === "SL" && t.daysHeld > 3);
  const timeStop    = losers.filter(t => t.exitReason === "TIME");
  const trailGive   = losers.filter(t => t.exitReason === "TRAIL" || t.exitReason === "TRAIL_OPEN");
  const openLoser   = losers.filter(t => t.exitReason === "OPEN");

  console.log(`  Total trades: ${trades.length} | Losers (R<0): ${losers.length}`);
  console.log("");
  console.log(
    `  ${pad("death cause", 30)}${padL("n", 6)}${padL("%losers", 9)}${padL("avgDaysHeld", 13)}${padL("avgMfeR", 9)}${padL("avgR", 8)}`,
  );
  console.log(`  ${"─".repeat(75)}`);

  const row = (label: string, b: AutopsyTrade[]) => {
    console.log(
      `  ${pad(label, 30)}${padL(b.length, 6)}${padL(f1(pct(b.length, losers.length)) + "%", 9)}` +
      `${padL(f1(avg(b.map(t => t.daysHeld))), 13)}${padL(f2(avg(b.map(t => t.mfeR))), 9)}` +
      `${padL(sign(avg(b.map(t => t.r))) + f2(avg(b.map(t => t.r))), 8)}`,
    );
  };
  row("(a) immediate SL (held<=3)", immediateSL);
  row("(b) slow SL (held>3)", slowSL);
  row("(c) TIME-stop death", timeStop);
  row("(d) TRAIL gave-back", trailGive);
  row("(.) OPEN/end-of-data losers", openLoser);

  // Verdict: fast vs slow death by where the mass of losers sits.
  const fastN = immediateSL.length;
  const slowN = slowSL.length + timeStop.length + trailGive.length;
  const verdict = fastN > slowN
    ? `FAST — losers mostly die as immediate structural SL (held<=3): ${fastN} fast vs ${slowN} slow.`
    : `SLOW — losers mostly languish / give back (slow SL + TIME + TRAIL): ${slowN} slow vs ${fastN} fast.`;
  console.log("");
  console.log(`  VERDICT Q1: ${verdict}`);
}

// ════════════════════════════════════════════════════════════════════════════
// Q2 — EMA-20 vs EMA-50 entry zone.
// ════════════════════════════════════════════════════════════════════════════
function reportQ2(trades: AutopsyTrade[]): void {
  console.log("");
  console.log("════════════════════════════════════════════════════════════════════════════");
  console.log("Q2 — ENTRY ZONE: shallow (bounced off EMA-20) vs deep (at/below EMA-50)");
  console.log("════════════════════════════════════════════════════════════════════════════");

  // shallow : |entryEma20Dist| <= 2%  (entry within ±2% of EMA20 → bounced off the 20)
  // deep    : entry at/below EMA50, i.e. entryEma50Dist <= 0
  //           (price near/under the 50 → bought a deeper / more-faded pullback)
  // Mutually-exclusive priority: shallow first; then deep; remainder "mid" (between the two).
  const shallow = trades.filter(t => Math.abs(t.entryEma20Dist) <= 0.02);
  const deep    = trades.filter(t => !(Math.abs(t.entryEma20Dist) <= 0.02) && t.entryEma50Dist <= 0);
  const mid     = trades.filter(t => !(Math.abs(t.entryEma20Dist) <= 0.02) && !(t.entryEma50Dist <= 0));

  const zoneRow = (label: string, b: AutopsyTrade[]) => {
    const wins = b.filter(t => t.r > 0).length;
    console.log(
      `  ${pad(label, 28)}${padL(b.length, 7)}${padL(f1(pct(wins, b.length)) + "%", 8)}` +
      `${padL(sign(avg(b.map(t => t.r))) + f2(avg(b.map(t => t.r))), 9)}` +
      `${padL(sign(sum(b.map(t => t.r))) + f1(sum(b.map(t => t.r))) + "R", 10)}`,
    );
  };

  console.log(
    `  ${pad("zone", 28)}${padL("count", 7)}${padL("win%", 8)}${padL("avgR", 9)}${padL("totR", 10)}`,
  );
  console.log(`  ${"─".repeat(62)}`);
  zoneRow("shallow (±2% of EMA20)", shallow);
  zoneRow("mid (between 20 and 50)", mid);
  zoneRow("deep (at/below EMA50)", deep);

  // Where do winners vs losers cluster?
  const winners = trades.filter(t => t.r > 0);
  const losers = trades.filter(t => t.r < 0);
  const shareShallow = (g: AutopsyTrade[]) =>
    pct(g.filter(t => Math.abs(t.entryEma20Dist) <= 0.02).length, g.length);
  const shareDeep = (g: AutopsyTrade[]) =>
    pct(g.filter(t => !(Math.abs(t.entryEma20Dist) <= 0.02) && t.entryEma50Dist <= 0).length, g.length);

  console.log("");
  console.log(`  Winners (n=${winners.length}): ${f1(shareShallow(winners))}% shallow / ${f1(shareDeep(winners))}% deep`);
  console.log(`  Losers  (n=${losers.length}): ${f1(shareShallow(losers))}% shallow / ${f1(shareDeep(losers))}% deep`);

  const shallowAvgR = avg(shallow.map(t => t.r));
  const deepAvgR = avg(deep.map(t => t.r));
  const verdict = shallowAvgR > deepAvgR
    ? `YES — shallow EMA-20 entries beat deep EMA-50 entries (avgR ${f2(shallowAvgR)} vs ${f2(deepAvgR)}). Deep = buying faded momentum.`
    : `NO — deep entries are not worse than shallow on avgR (${f2(deepAvgR)} vs ${f2(shallowAvgR)}); depth is not the differentiator.`;
  console.log("");
  console.log(`  VERDICT Q2: ${verdict}`);
}

// ════════════════════════════════════════════════════════════════════════════
// Q3 — EXPECTANCY SPLIT: Gold Breakout vs Gold Retest, per window + combined.
// ════════════════════════════════════════════════════════════════════════════
function reportQ3(allTrades: AutopsyTrade[]): void {
  console.log("");
  console.log("════════════════════════════════════════════════════════════════════════════");
  console.log("Q3 — EXPECTANCY SPLIT: Gold Retest (~7-8) vs Gold Breakout (9-10)");
  console.log("════════════════════════════════════════════════════════════════════════════");

  const tierRow = (b: AutopsyTrade[]) => {
    const wins = b.filter(t => t.r > 0).length;
    const totR = sum(b.map(t => t.r));
    return {
      n: b.length,
      winPct: pct(wins, b.length),
      avgR: avg(b.map(t => t.r)),
      totR,
    };
  };

  const blocks: { label: string; trades: AutopsyTrade[] }[] = [
    { label: "2025",     trades: inWindow(allTrades, "2025-01-01") },
    { label: "2026",     trades: inWindow(allTrades, "2026-01-01") },
    { label: "COMBINED", trades: inWindow(allTrades, EARLIEST_WINDOW_START) },
  ];

  console.log(
    `  ${pad("window", 10)}${pad("tier", 16)}${padL("count", 7)}${padL("win%", 8)}${padL("avgR", 9)}${padL("totR(sumR)", 12)}`,
  );
  console.log(`  ${"─".repeat(62)}`);
  for (const blk of blocks) {
    const retest   = blk.trades.filter(t => t.tier === "Gold Retest");
    const breakout = blk.trades.filter(t => t.tier === "Gold Breakout");
    for (const [tierLabel, b] of [["Gold Retest", retest], ["Gold Breakout", breakout]] as const) {
      const s = tierRow(b);
      console.log(
        `  ${pad(blk.label, 10)}${pad(tierLabel, 16)}${padL(s.n, 7)}${padL(f1(s.winPct) + "%", 8)}` +
        `${padL(sign(s.avgR) + f2(s.avgR), 9)}${padL(sign(s.totR) + f1(s.totR) + "R", 12)}`,
      );
    }
    console.log(`  ${"·".repeat(62)}`);
  }

  // Verdict on the COMBINED book: which tier is +EV, which drags.
  const combined = inWindow(allTrades, EARLIEST_WINDOW_START);
  const rt = tierRow(combined.filter(t => t.tier === "Gold Retest"));
  const bo = tierRow(combined.filter(t => t.tier === "Gold Breakout"));
  const tierVerdict = (name: string, s: { avgR: number; totR: number }) =>
    `${name} ${s.avgR >= 0 ? "+EV" : "-EV"} (avgR ${sign(s.avgR)}${f2(s.avgR)}, sumR ${sign(s.totR)}${f1(s.totR)}R)`;
  console.log("");
  console.log(`  VERDICT Q3 (combined): ${tierVerdict("Retest", rt)} | ${tierVerdict("Breakout", bo)}.`);
}

// ════════════════════════════════════════════════════════════════════════════
// Q4 — Does the 2R free-roll target kill RETESTS? (peaked then gave it all back)
// ════════════════════════════════════════════════════════════════════════════
function reportQ4(allTrades: AutopsyTrade[]): void {
  console.log("");
  console.log("════════════════════════════════════════════════════════════════════════════");
  console.log("Q4 — 2R FREE-ROLL vs RETESTS: peaked >=1.5R then died <0.5R? — ALL windows");
  console.log("════════════════════════════════════════════════════════════════════════════");

  const retest = allTrades.filter(t => t.tier === "Gold Retest");

  // Gave-it-all-back: mfeR >= 1.5 (real profit) but finalR < 0.5 (never banked the 2R free-roll).
  const gaveBack = retest.filter(t => t.mfeR >= 1.5 && t.r < 0.5);
  const losingRetest = retest.filter(t => t.r < 0);

  console.log(`  Retest trades: ${retest.length}`);
  console.log(
    `  Peaked >=1.5R then ended <0.5R: ${gaveBack.length} ` +
    `(${f1(pct(gaveBack.length, retest.length))}% of retests)`,
  );
  console.log(`  avg mfeR of LOSING retest trades (R<0): ${f2(avg(losingRetest.map(t => t.mfeR)))} ` +
    `(n=${losingRetest.length})`);

  // mfeR histogram for retests: [<0.5, 0.5-1, 1-1.5, 1.5-2, 2+]
  const buckets: { label: string; test: (m: number) => boolean }[] = [
    { label: "<0.5",    test: m => m < 0.5 },
    { label: "0.5-1",   test: m => m >= 0.5 && m < 1.0 },
    { label: "1-1.5",   test: m => m >= 1.0 && m < 1.5 },
    { label: "1.5-2",   test: m => m >= 1.5 && m < 2.0 },
    { label: "2+",      test: m => m >= 2.0 },
  ];
  console.log("");
  console.log(`  ── mfeR histogram (RETEST trades, n=${retest.length}) ──`);
  console.log(`  ${pad("mfeR bucket", 14)}${padL("n", 6)}${padL("%", 8)}${padL("avgFinalR", 11)}`);
  console.log(`  ${"─".repeat(39)}`);
  for (const bk of buckets) {
    const b = retest.filter(t => bk.test(t.mfeR));
    console.log(
      `  ${pad(bk.label, 14)}${padL(b.length, 6)}${padL(f1(pct(b.length, retest.length)) + "%", 8)}` +
      `${padL(sign(avg(b.map(t => t.r))) + f2(avg(b.map(t => t.r))), 11)}`,
    );
  }

  // Verdict: is 2R too far for retests?
  const peaked15plus = retest.filter(t => t.mfeR >= 1.5);
  const peaked15ButLost = peaked15plus.filter(t => t.r < 0.5);
  const giveBackRate = pct(peaked15ButLost.length, peaked15plus.length);
  const verdict = giveBackRate >= 50
    ? `YES — of retests that reached >=1.5R, ${f1(giveBackRate)}% gave it back to <0.5R. 2R target is too FAR; a closer bank would salvage these.`
    : `NO — only ${f1(giveBackRate)}% of retests that reached >=1.5R gave it back to <0.5R; most that peak go on to bank. 2R target is not the leak.`;
  console.log("");
  console.log(`  VERDICT Q4: ${verdict}`);
}

function printDisclaimer(): void {
  console.log("");
  console.log("════════════════════════════════════════════════════════════════════════════");
  console.log("DISCLAIMER — read before trusting any number above");
  console.log("════════════════════════════════════════════════════════════════════════════");
  console.log("  • DAILY-BAR MFE OVERSTATES THE PEAK: mfeR is measured on DAILY highs, which");
  console.log("    can exceed the price actually reachable intraday before the same bar's low");
  console.log("    would have stopped the residual out — so the 'gave it all back' counts in Q4");
  console.log("    are an UPPER bound on how often we truly touched a banked profit.");
  console.log("  • SAME-BAR ORDERING: within one daily bar we cannot know whether the high or");
  console.log("    the low printed first; the exit walk resolves SL-first on a tie (conservative");
  console.log("    on the downside) but mfeR still credits that bar's full high — so a bar that");
  console.log("    both peaked and stopped is counted as having reached the peak.");
  console.log("  • EMA20 from bars / EMA50 from the engine result: EMA20 is recomputed locally");
  console.log("    via calcEMA (same routine the engine uses), EMA50 is res.ema50 — both as of");
  console.log("    the entry bar. Zone thresholds (±2% / at-or-below 50) are heuristic cuts.");
  console.log("  • LONG-ONLY, NO FRICTION, THIN 2025 WARMUP — same caveats as zivCatalogOOS.ts:");
  console.log("    shorts omitted, zero slippage/commissions, and the 2025 window opens on only");
  console.log("    ~50 bars of late-2024 warmup so early-2025 scores lean on short history.");
  console.log("  • SIZING-INDEPENDENT: this is a TRADE-LEVEL autopsy of the raw R-list — no");
  console.log("    portfolio/ClusterGuard/heat layer is applied. R counts every signal equally.");
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("Ziv FORENSIC AUTOPSY — READ-ONLY (no DB writes, no IBKR, no orders, no SSH)");
  console.log(`Engine: CONFIG C (current live), LONG-ONLY. Universe: ${TICKERS.length} tickers (DEFAULT_60_ASSETS).`);
  console.log(`Entry/exit BYTE-IDENTICAL to zivCatalogOOS.ts. Windows: 2025 (>=2025-01-01), 2026 (>=2026-01-01).`);
  console.log("Per-trade autopsy fields: mfeR, daysHeld, tier, entryEma20Dist, entryEma50Dist.");

  // Build the FULL Config-C LONG trade list ONCE across all tickers.
  const allTrades: AutopsyTrade[] = [];
  let processed = 0;
  let skippedNoData = 0;
  for (const ticker of TICKERS) {
    processed++;
    if (processed % 20 === 0) {
      console.log(`[PROGRESS] ${processed}/${TICKERS.length} tickers processed, ${allTrades.length} trades so far.`);
    }
    try {
      let bars = await fetchBarsForTicker(ticker, BARS_DAYS);
      if (!bars || bars.length < MIN_BARS) {
        skippedNoData++;
        continue;
      }
      bars = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

      const lastDate = bars[bars.length - 1].date;
      if (lastDate < EARLIEST_WINDOW_START) {
        skippedNoData++;
        continue;
      }
      const warmupBefore = bars.filter(b => b.date < EARLIEST_WINDOW_START).length;
      if (warmupBefore < MIN_BARS) {
        skippedNoData++;
        continue;
      }

      simulateConfigC(ticker, bars, allTrades);
    } catch (e) {
      console.log(`[WARN] ${ticker}: ${(e as Error).message ?? e}. Skipping ticker.`);
      continue;
    }
  }

  console.log("");
  console.log(`[DONE BUILDING] ${allTrades.length} total Config-C LONG entries across ${TICKERS.length - skippedNoData} usable tickers (${skippedNoData} skipped: no data / thin warmup).`);

  // Q1 + Q2 + Q4 pool both windows (combined population from EARLIEST_WINDOW_START).
  // Q3 splits by window explicitly.
  const combined = inWindow(allTrades, EARLIEST_WINDOW_START);

  reportQ1(combined);
  reportQ2(combined);
  reportQ3(allTrades);
  reportQ4(combined);
  printDisclaimer();

  console.log("");
  console.log(`Done. ${allTrades.length} Config-C LONG trades autopsied. (Simulation only — no live actions taken.)`);
}

main().catch(err => {
  console.error(`[FATAL] ${(err as Error).stack ?? err}`);
  process.exit(1);
});
