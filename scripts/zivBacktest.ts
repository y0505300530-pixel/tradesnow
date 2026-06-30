/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  zivBacktest.ts — READ-ONLY Ziv Engine walk-forward backtest harness       ║
 * ║                                                                            ║
 * ║  PURE SIMULATION. NO DB writes. NO IBKR. NO orders. NO deploy.             ║
 * ║  Replays 2026-YTD daily bars through the REAL zivEngine (calcZivEngineScore)║
 * ║  and simulates 1%-risk LONG swing trades under three entry configs (A/B/C).║
 * ║                                                                            ║
 * ║  EXIT MODEL = the REAL live "Open Skies v3" two-stage free-roll + trail     ║
 * ║  (server/liveOrderExecutor.ts runLiveSlMonitor). NOT the old fixed-2R TP.   ║
 * ║  Stage 1: bank 50% @ +2R, move stop on the residual 50% to breakeven.       ║
 * ║  Stage 2: trail the residual 50% with an ATR-Chandelier (highest-high-since-║
 * ║  entry − 2.5×ATR14, tighten-only) → winners RUN past 2R instead of capping. ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * RUN (manager runs this on the droplet — has Yahoo/DB data; local has none):
 *   node --import tsx --env-file=.env scripts/zivBacktest.ts
 *
 * DATA SOURCE: only `fetchBarsForTicker` (server/marketData.ts). It transparently
 * uses the DB price cache / Yahoo Finance. We never call IBKR, never write, never
 * place/cancel/modify any order. Scoring uses the REAL `calcZivEngineScore`
 * (server/zivEngine.ts) and the REAL `confirmVolume` (server/volumeConfirm.ts) —
 * no formulas are re-implemented here.
 *
 * ── FIELD-NAME ASSUMPTIONS (so the manager can fix fast if a name is off) ─────
 *   Bar (server/zivEngine.ts):        { date: string; open; high; low; close; volume? }
 *       → confirmed by reading the Bar interface; `date` is an ISO "YYYY-MM-DD" string
 *         (marketData builds it via new Date(t*1000).toISOString().slice(0,10)).
 *   ZivScoreResult (server/zivEngine.ts) fields used:
 *       .score: number, .tier: ZivTier, .donchian20High: number,
 *       .weeklyEma50Slope: number (ema50/ema200 also present but unused here).
 *   Tier string literals used: "Gold Retest", "Gold Breakout" (exact from ZivTier union).
 *   confirmVolume(bars, level, "long").confirmed: boolean (server/volumeConfirm.ts).
 *   calcZivEngineScore requires >= 50 bars; returns tier "No Data" otherwise — we skip those.
 */

import "dotenv/config";
import { fetchBarsForTicker } from "../server/marketData";
import { calcZivEngineScore, type Bar, type ZivScoreResult } from "../server/zivEngine";
import { confirmVolume } from "../server/volumeConfirm";

// ─── Parameters ──────────────────────────────────────────────────────────────
const TICKERS = ["SNDK", "MU", "INTC", "NVDA", "RKLB"] as const;
const BACKTEST_START = "2026-01-01"; // bars with date >= this are tradeable; earlier = warmup
const BARS_DAYS = 420;               // fetchBarsForTicker(ticker, 420) — ~1.5y of daily bars
const MIN_BARS = 50;                 // zivEngine needs >= 50 bars; skip a bar if fewer available
const ENTRY_MIN_SCORE = 7.5;         // gate score threshold for all gold entries

// Trade model constants
const SL_LOOKBACK = 10;              // structural SL = min(low) over last 10 bars (i-9..i)
const RC2_MAX_RISK_PCT = 12;         // RC-2 guard: skip entry if (entry-SL)/entry > 12%
const FIRST_TARGET_R = 2;            // free-roll trigger: bank 50% at +2R (= SCALE_OUT_TP1_R, slCalculator.ts:66)
const FREE_ROLL_FRACTION = 0.5;      // partial-close fraction at +2R (liveOrderExecutor.ts:1095 fraction:0.5)
const TIME_STOP_BARS = 10;           // PRE-free-roll time-stop: exit at close if held > 10 bars (does NOT apply once trailing)

// ── REAL live exit params (Open Skies v3 Chandelier, liveOrderExecutor.ts:1144 / slCalculator.ts) ──
const CHANDELIER_ATR_MULT = 2.5;     // chand = peakHigh − 2.5×ATR (liveOrderExecutor.ts:1144, isLong branch)
const ATR_PERIOD = 14;               // computeAtr14 (slCalculator.ts:251) — SIMPLE (non-Wilder) avg of TR

/**
 * SIMPLE 14-period ATR over a daily-bar window — byte-for-byte the same formula as
 * computeAtr14 (server/slCalculator.ts:251): mean True Range over the last
 * min(14, len-1) bars, where TR = max(H-L, |H-prevClose|, |L-prevClose|).
 * It is a SIMPLE average (NOT Wilder smoothing) — matching live exactly.
 * `window` is bars[0..k] inclusive; ATR is measured at its last bar.
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

// Sizing / P&L
const NLV = 100_000;                 // fixed notional NLV ($) — documented assumption, unused in $ calc directly
const RISK_PER_TRADE_USD = NLV * 0.01; // 1% risk = $1,000; trade $P&L = R * $1,000

type ConfigId = "A" | "B" | "C";
const CONFIG_NAMES: Record<ConfigId, string> = {
  A: "Ziv-pure (retest-only)",
  B: "goldBreakout-ON",
  C: "breakout + volume-confirm (current live)",
};

// ─── Trade record ────────────────────────────────────────────────────────────
// Real two-stage exit outcomes:
//   "SL"        — stopped out BEFORE +2R (both legs at initial stop → ≈ -1R).
//   "TIME"      — pre-free-roll time-stop (held > 10 bars, +2R never hit) → exit at close.
//   "TRAIL"     — reached +2R (banked 50%), residual 50% later hit the Chandelier trail.
//   "TRAIL_OPEN"— reached +2R (banked 50%), residual still riding the trail at end-of-data.
//   "OPEN"      — never reached +2R, still open at end-of-data (marked-to-last-close).
type ExitReason = "SL" | "TIME" | "TRAIL" | "TRAIL_OPEN" | "OPEN";

interface Trade {
  config: ConfigId;
  ticker: string;
  entryDate: string;
  tier: string;
  entry: number;
  sl: number;
  tp: number;            // first target (+2R) — where the 50% free-roll bank happens
  exitDate: string;      // date the FINAL leg closed (or end-of-data)
  exitReason: ExitReason;
  r: number;             // TOTAL R-multiple = sum of both legs' contributions
  pnlUSD: number;        // r * RISK_PER_TRADE_USD
  // Two-stage detail (for the trade log / audit):
  reachedFirstTarget: boolean; // did price tag +2R and bank the 50%?
  leg1R: number;               // realized R from the banked 50% (0.5×2R=+1.0R, or the SL-leg's half)
  leg2R: number;               // realized R from the trailing/residual 50%
  trailExit: number | null;    // price the residual 50% exited at (null if never reached +2R)
}

/**
 * ENTRY DECISION per config (LONG only). Returns true if the config wants to ENTER
 * at this bar given the score result computed on bars.slice(0, i+1).
 *
 * Config A — Ziv-pure (retest-only): tier === "Gold Retest" AND score >= 7.5 AND weeklyEma50Slope > 0.
 * Config B — goldBreakout-ON:        Config A's retest entries PLUS tier === "Gold Breakout"
 *                                     AND score >= 7.5 AND weeklyEma50Slope > 0.
 * Config C — breakout + volume:      Config A retests PLUS a Gold-Breakout entry ONLY when
 *                                     confirmVolume(bars, donchian20High, "long").confirmed is true.
 *
 * NB: weekly-alignment (weeklyEma50Slope > 0) is implicit in the engine for Gold tiers
 *     (tiers downgrade to "No Signal" when slope < 0), but we assert it explicitly to
 *     mirror the live entry gate exactly.
 */
function wantsEntry(
  config: ConfigId,
  res: ZivScoreResult,
  windowBars: Bar[],
): boolean {
  const weeklyAligned = res.weeklyEma50Slope > 0;
  const scoreOk = res.score >= ENTRY_MIN_SCORE;

  // Retest entry — common to all three configs.
  const retestEntry = res.tier === "Gold Retest" && scoreOk && weeklyAligned;
  if (retestEntry) return true;

  // Breakout entries differ by config.
  const isGoldBreakout = res.tier === "Gold Breakout" && scoreOk && weeklyAligned;

  if (config === "A") return false; // no breakout entries
  if (config === "B") return isGoldBreakout;
  if (config === "C") {
    if (!isGoldBreakout) return false;
    // Volume-confirm gate (current live behaviour). confirmVolume is degrade-safe:
    // missing/zero volume → not confirmed → no entry.
    return confirmVolume(windowBars, res.donchian20High, "long").confirmed;
  }
  return false;
}

/**
 * Simulate one config over one ticker's bars. Walk-forward, LONG only, one open
 * position per ticker at a time. Pushes resulting trades into `out`.
 *
 * TRADE MODEL (every assumption documented) — REAL live "Open Skies v3" two-stage exit:
 *  - We only DECIDE entries on bars whose date >= BACKTEST_START (earlier bars are warmup).
 *  - Entry price = close[i] (fill at signal-bar close). Entry date = bars[i].date.
 *  - Stop loss = structural: min(low) over the last 10 bars (i-9..i, inclusive).
 *  - Risk% = (entry - SL)/entry. RC-2 guard: if Risk% > 12% → SKIP (do not enter).
 *  - R_dollars = entry - SL (the "1R" per-share distance). firstTarget = entry + 2*R_dollars (+2R).
 *
 *  PHASE 1 — before +2R is ever tagged (full size on, stop = initialSL):
 *      * if bars[j].low  <= currentStop → FULL exit at the stop. R = (stop-entry)/R_dollars
 *        (= -1R while the stop is still at initialSL). reason "SL".
 *      * Time-stop applies ONLY here: if held > 10 bars (j - i > 10) and +2R not yet hit →
 *        exit FULL at bars[j].close, R = (close-entry)/R_dollars, reason "TIME".
 *      * SL-first on a same-bar tie (low<=stop AND high>=firstTarget) → assume stop hit intrabar.
 *
 *  PHASE 2 — the bar that first tags +2R (bars[j].high >= firstTarget):
 *      * BANK 50% at exactly +2R → leg1R = 0.5 × 2 = +1.0R (locked, realized).
 *      * Move the stop on the residual 50% to BREAKEVEN (entry). (live: slMovedToBreakEven)
 *      * Begin trailing the residual 50% with the ATR-Chandelier. NO time-stop from here.
 *      * Same-bar seed: highestHigh = max(highs entry..j); trail = max(BE, highestHigh - 2.5×ATR).
 *
 *  PHASE 3 — trail the residual 50% (live STAGE 2 Chandelier Ratchet, liveOrderExecutor.ts:1128):
 *      * Each later bar k: highestHigh = max(highestHigh, bars[k].high);
 *        chand = highestHigh - 2.5×ATR14(bars[0..k]); trail = max(priorTrail, chand)  (tighten-only).
 *      * If bars[k].low <= trail → residual 50% exits at the trail level.
 *        leg2R = 0.5 × (trailExit - entry)/R_dollars. reason "TRAIL".
 *      * End-of-data while still riding → mark residual to last close.
 *        leg2R = 0.5 × (lastClose - entry)/R_dollars. reason "TRAIL_OPEN".
 *      * KEY: a name that runs 2× (SNDK $677→$1646) lets leg2R capture a large multi-R gain,
 *        NOT a 2R cap. Total trade R = leg1R + leg2R.
 *
 *  - ATR = computeAtr14Local = SIMPLE (non-Wilder) 14-bar mean True Range (matches live computeAtr14).
 *  - Chandelier peak uses highest DAILY high since entry (live tracks the live-tick peak; daily-high
 *    is the bar-resolution analogue). 2.5×ATR multiplier = liveOrderExecutor.ts:1144 (isLong).
 *  - After any exit the ticker is FLAT and may re-enter on a later signal (i jumps to exit bar).
 */
function simulateConfig(config: ConfigId, ticker: string, bars: Bar[], out: Trade[]): void {
  // Index of first tradeable bar (date >= BACKTEST_START). Everything before is warmup.
  let i = 0;
  while (i < bars.length && bars[i].date < BACKTEST_START) i++;

  for (; i < bars.length; i++) {
    // Need >= MIN_BARS of history (inclusive of bar i) for the engine to score.
    if (i + 1 < MIN_BARS) continue;
    // Need >= SL_LOOKBACK bars of history for the structural stop.
    if (i + 1 < SL_LOOKBACK) continue;

    const windowBars = bars.slice(0, i + 1);
    let res: ZivScoreResult;
    try {
      res = calcZivEngineScore(windowBars);
    } catch {
      continue; // engine should never throw, but never let one bad bar abort the run
    }
    if (res.tier === "No Data" || res.tier === "Error") continue;

    if (!wantsEntry(config, res, windowBars)) continue;

    // ── ENTRY ────────────────────────────────────────────────────────────────
    const entry = bars[i].close;
    // Structural stop: lowest low over the last 10 bars (i-9 .. i inclusive).
    const slWindow = bars.slice(i - (SL_LOOKBACK - 1), i + 1);
    const sl = Math.min(...slWindow.map(b => b.low));

    // Guard: a degenerate stop at/above entry would give non-positive risk — skip.
    if (!(sl < entry) || !(entry > 0)) continue;

    const riskPct = ((entry - sl) / entry) * 100;
    // RC-2 guard — mirror the live "skip when stop is too wide" rule.
    if (riskPct > RC2_MAX_RISK_PCT) continue;

    const risk = entry - sl;                      // $ risk per share (the "1R" distance)
    const firstTarget = entry + FIRST_TARGET_R * risk; // +2R free-roll trigger

    // ── EXIT walk-forward — REAL two-stage free-roll + Chandelier trail ─────────
    let exitDate = bars[bars.length - 1].date;
    let exitReason: ExitReason = "OPEN";
    let exitIndex = bars.length - 1;

    let reachedFirstTarget = false;
    let leg1R = 0;                 // realized R from the banked 50% (or the SL leg's half)
    let leg2R = 0;                 // realized R from the trailing/residual 50%
    let trailExit: number | null = null;

    // Phase-2/3 trailing state (only meaningful once reachedFirstTarget):
    let currentStop = sl;          // pre-2R: initialSL. post-2R: BE then ratcheting trail.
    let highestHigh = bars[i].high;
    let trailStop = -Infinity;

    for (let j = i + 1; j < bars.length; j++) {
      const bar = bars[j];
      const heldBars = j - i;

      if (!reachedFirstTarget) {
        // ── PHASE 1: full size, stop at initial SL, time-stop active ──
        // SL-first on a same-bar tie (stop and +2R both touched) → assume stop hit intrabar.
        if (bar.low <= currentStop) {
          exitReason = "SL"; exitDate = bar.date; exitIndex = j;
          leg1R = (currentStop - entry) / risk;   // full position exits → ≈ -1R
          leg2R = 0;
          break;
        }
        if (bar.high >= firstTarget) {
          // ── PHASE 2: tag +2R. Bank 50% at exactly +2R, move residual stop to breakeven. ──
          reachedFirstTarget = true;
          leg1R = FREE_ROLL_FRACTION * FIRST_TARGET_R;   // 0.5 × 2 = +1.0R, locked
          currentStop = entry;                            // breakeven on residual 50%
          // Seed the Chandelier off the highest high through this bar.
          highestHigh = Math.max(highestHigh, bar.high);
          const atr = computeAtr14Local(bars.slice(0, j + 1));
          if (atr != null && atr > 0) {
            const chand = highestHigh - CHANDELIER_ATR_MULT * atr;
            trailStop = Math.max(currentStop, chand);     // never below breakeven
          } else {
            trailStop = currentStop;                      // degrade: hold BE if ATR unavailable
          }
          currentStop = trailStop;
          // NOTE: do NOT exit on this same bar — the residual rides from the next bar onward.
          continue;
        }
        // Time-stop applies ONLY pre-free-roll: held strictly > TIME_STOP_BARS bars → exit at close.
        if (heldBars > TIME_STOP_BARS) {
          exitReason = "TIME"; exitDate = bar.date; exitIndex = j;
          leg1R = (bar.close - entry) / risk;            // full position at close
          leg2R = 0;
          break;
        }
        // End of data, never reached +2R → mark full position to last close.
        if (j === bars.length - 1) {
          exitReason = "OPEN"; exitDate = bar.date; exitIndex = j;
          leg1R = (bar.close - entry) / risk;
          leg2R = 0;
        }
      } else {
        // ── PHASE 3: residual 50% trails on the ATR-Chandelier. NO time-stop here. ──
        highestHigh = Math.max(highestHigh, bar.high);
        const atr = computeAtr14Local(bars.slice(0, j + 1));
        if (atr != null && atr > 0) {
          const chand = highestHigh - CHANDELIER_ATR_MULT * atr;
          trailStop = Math.max(trailStop, chand);        // tighten-only ratchet
        }
        currentStop = trailStop;

        if (bar.low <= currentStop) {
          // Residual 50% stopped out at the trail level.
          exitReason = "TRAIL"; exitDate = bar.date; exitIndex = j;
          trailExit = currentStop;
          leg2R = FREE_ROLL_FRACTION * ((trailExit - entry) / risk);
          break;
        }
        // End of data still riding the trail → mark residual to last close.
        if (j === bars.length - 1) {
          exitReason = "TRAIL_OPEN"; exitDate = bar.date; exitIndex = j;
          trailExit = bar.close;
          leg2R = FREE_ROLL_FRACTION * ((trailExit - entry) / risk);
        }
      }
    }

    // Edge case: signal on the very last bar (no j to walk) → flat at entry.
    if (i === bars.length - 1) {
      exitDate = bars[i].date; exitReason = "OPEN"; exitIndex = i;
      leg1R = 0; leg2R = 0; reachedFirstTarget = false; trailExit = null;
    }

    const r = leg1R + leg2R;

    out.push({
      config,
      ticker,
      entryDate: bars[i].date,
      tier: res.tier,
      entry,
      sl,
      tp: firstTarget,
      exitDate,
      exitReason,
      r: Math.round(r * 100) / 100,
      pnlUSD: Math.round(r * RISK_PER_TRADE_USD),
      reachedFirstTarget,
      leg1R: Math.round(leg1R * 100) / 100,
      leg2R: Math.round(leg2R * 100) / 100,
      trailExit: trailExit == null ? null : Math.round(trailExit * 100) / 100,
    });

    // Re-enter only on a LATER bar: jump i to the exit bar (loop's i++ moves past it).
    i = exitIndex;
  }
}

// ─── Aggregation / reporting helpers ─────────────────────────────────────────
interface TickerStats {
  ticker: string;
  trades: number;
  wins: number;
  losses: number;
  winPct: number;
  totalR: number;
  pnlUSD: number;
}

function statsFor(ticker: string, trades: Trade[]): TickerStats {
  const wins = trades.filter(t => t.r > 0).length;
  const losses = trades.filter(t => t.r < 0).length;
  const totalR = trades.reduce((s, t) => s + t.r, 0);
  const pnlUSD = trades.reduce((s, t) => s + t.pnlUSD, 0);
  return {
    ticker,
    trades: trades.length,
    wins,
    losses,
    winPct: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    totalR: Math.round(totalR * 100) / 100,
    pnlUSD: Math.round(pnlUSD),
  };
}

function pad(s: string | number, w: number): string {
  const str = String(s);
  return str.length >= w ? str : str + " ".repeat(w - str.length);
}
function padL(s: string | number, w: number): string {
  const str = String(s);
  return str.length >= w ? str : " ".repeat(w - str.length) + str;
}

function printConfigReport(config: ConfigId, allTrades: Trade[]): TickerStats {
  const configTrades = allTrades.filter(t => t.config === config);
  console.log("");
  console.log(`════════════════════════════════════════════════════════════════════`);
  console.log(`CONFIG ${config} — ${CONFIG_NAMES[config]}`);
  console.log(`════════════════════════════════════════════════════════════════════`);
  console.log(
    `${pad("TICKER", 8)}${padL("TRADES", 8)}${padL("WINS", 7)}${padL("LOSSES", 8)}` +
    `${padL("WIN%", 8)}${padL("TOTAL_R", 10)}${padL("PNL_USD", 12)}`,
  );

  const perTicker: TickerStats[] = [];
  for (const ticker of TICKERS) {
    const tTrades = configTrades.filter(t => t.ticker === ticker);
    const st = statsFor(ticker, tTrades);
    perTicker.push(st);
    console.log(
      `${pad(st.ticker, 8)}${padL(st.trades, 8)}${padL(st.wins, 7)}${padL(st.losses, 8)}` +
      `${padL(st.winPct.toFixed(1), 8)}${padL(st.totalR.toFixed(2), 10)}${padL("$" + st.pnlUSD.toLocaleString(), 12)}`,
    );
  }

  const agg = statsFor("AGGREGATE", configTrades);
  console.log(`${"-".repeat(61)}`);
  console.log(
    `${pad(agg.ticker, 8)}${padL(agg.trades, 8)}${padL(agg.wins, 7)}${padL(agg.losses, 8)}` +
    `${padL(agg.winPct.toFixed(1), 8)}${padL(agg.totalR.toFixed(2), 10)}${padL("$" + agg.pnlUSD.toLocaleString(), 12)}`,
  );

  // Machine-readable line for downstream parsing.
  console.log(`[JSON] ${JSON.stringify({ config, name: CONFIG_NAMES[config], perTicker, aggregate: agg })}`);
  return agg;
}

function printComparison(aggs: Record<ConfigId, TickerStats>): void {
  console.log("");
  console.log(`════════════════════════════════════════════════════════════════════`);
  console.log(`3-WAY COMPARISON (A vs B vs C)`);
  console.log(`════════════════════════════════════════════════════════════════════`);
  console.log(`${pad("CONFIG", 8)}${pad("NAME", 42)}${padL("TRADES", 8)}${padL("WIN%", 8)}${padL("TOTAL_R", 10)}${padL("PNL_USD", 12)}`);
  (["A", "B", "C"] as ConfigId[]).forEach(c => {
    const a = aggs[c];
    console.log(
      `${pad(c, 8)}${pad(CONFIG_NAMES[c], 42)}${padL(a.trades, 8)}${padL(a.winPct.toFixed(1), 8)}` +
      `${padL(a.totalR.toFixed(2), 10)}${padL("$" + a.pnlUSD.toLocaleString(), 12)}`,
    );
  });
  console.log(`[JSON] ${JSON.stringify({ comparison: (["A", "B", "C"] as ConfigId[]).map(c => ({ config: c, name: CONFIG_NAMES[c], totalPnlUSD: aggs[c].pnlUSD, winPct: Math.round(aggs[c].winPct * 10) / 10, trades: aggs[c].trades })) })}`);
}

function printTradeLog(allTrades: Trade[]): void {
  console.log("");
  console.log(`════════════════════════════════════════════════════════════════════`);
  console.log(`FULL TRADE LOG`);
  console.log(`════════════════════════════════════════════════════════════════════`);
  console.log(`(REAL free-roll+trail exit: TP col = +2R first target where 50% is banked; LEG1=banked half, LEG2=trailed half)`);
  console.log(
    `${pad("CFG", 4)}${pad("TICKER", 8)}${pad("ENTRY_DATE", 12)}${pad("TIER", 15)}` +
    `${padL("ENTRY", 9)}${padL("SL", 9)}${padL("+2R", 9)}${pad("  EXIT_DATE", 13)}` +
    `${pad("  REASON", 13)}${padL("TRAIL_EX", 10)}${padL("LEG1_R", 8)}${padL("LEG2_R", 8)}${padL("R", 7)}${padL("PNL_USD", 11)}`,
  );
  // Sort by entry date for readability across all configs.
  const sorted = [...allTrades].sort((a, b) =>
    a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : a.config < b.config ? -1 : 1,
  );
  for (const t of sorted) {
    console.log(
      `${pad(t.config, 4)}${pad(t.ticker, 8)}${pad(t.entryDate, 12)}${pad(t.tier, 15)}` +
      `${padL(t.entry.toFixed(2), 9)}${padL(t.sl.toFixed(2), 9)}${padL(t.tp.toFixed(2), 9)}` +
      `${pad("  " + t.exitDate, 13)}${pad("  " + t.exitReason, 13)}` +
      `${padL(t.trailExit == null ? "-" : t.trailExit.toFixed(2), 10)}` +
      `${padL(t.leg1R.toFixed(2), 8)}${padL(t.leg2R.toFixed(2), 8)}${padL(t.r.toFixed(2), 7)}` +
      `${padL("$" + t.pnlUSD.toLocaleString(), 11)}`,
    );
  }
  console.log(`[JSON] ${JSON.stringify({ tradeLog: sorted })}`);
}

// Old fixed-2R reference (the crippled model): Config-A total was +$1,317 / +1.32R.
const FIXED2R_CONFIG_A_USD = 1317;
const FIXED2R_CONFIG_A_R = 1.32;

/** One-line BASELINE: old fixed-2R Config A vs the new REAL free-roll+trail Config A. */
function printBaselineComparison(configA: TickerStats): void {
  const deltaUsd = configA.pnlUSD - FIXED2R_CONFIG_A_USD;
  const deltaR = Math.round((configA.totalR - FIXED2R_CONFIG_A_R) * 100) / 100;
  const sign = (n: number) => (n >= 0 ? "+" : "");
  console.log("");
  console.log(`════════════════════════════════════════════════════════════════════`);
  console.log(`BASELINE — Config A: fixed-2R (old) vs free-roll+trail (REAL live exit)`);
  console.log(`════════════════════════════════════════════════════════════════════`);
  console.log(`  fixed-2R (old):        ${sign(FIXED2R_CONFIG_A_USD)}$${FIXED2R_CONFIG_A_USD.toLocaleString()}  (${sign(FIXED2R_CONFIG_A_R)}${FIXED2R_CONFIG_A_R.toFixed(2)}R)`);
  console.log(`  free-roll+trail (REAL):${sign(configA.pnlUSD)}$${configA.pnlUSD.toLocaleString()}  (${sign(configA.totalR)}${configA.totalR.toFixed(2)}R)`);
  console.log(`  ── DELTA:               ${sign(deltaUsd)}$${deltaUsd.toLocaleString()}  (${sign(deltaR)}${deltaR.toFixed(2)}R)  ← winners running past 2R`);
  console.log(`[JSON] ${JSON.stringify({ baseline: { config: "A", fixed2R: { usd: FIXED2R_CONFIG_A_USD, r: FIXED2R_CONFIG_A_R }, freeRollTrail: { usd: configA.pnlUSD, r: configA.totalR }, deltaUsd, deltaR } })}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`Ziv Engine Backtest — READ-ONLY simulation (no DB writes, no IBKR, no orders)`);
  console.log(`Tickers: ${TICKERS.join(", ")}  |  Window: bars with date >= ${BACKTEST_START}`);
  console.log(`Sizing: NLV $${NLV.toLocaleString()}, 1% risk = $${RISK_PER_TRADE_USD.toLocaleString()}/trade`);
  console.log(`Entry gate: score >= ${ENTRY_MIN_SCORE}, weekly slope > 0 | SL = 10-bar low | RC-2 skip if risk > ${RC2_MAX_RISK_PCT}%`);
  console.log(`EXIT = REAL live "Open Skies v3" free-roll+trail: bank 50% @ +2R, residual 50% to breakeven then ATR-Chandelier trail (highest-high − ${CHANDELIER_ATR_MULT}×ATR${ATR_PERIOD}, simple). Winners RUN past 2R. (NOT the old fixed-2R cap.)`);

  const allTrades: Trade[] = [];

  for (const ticker of TICKERS) {
    let bars: Bar[] = [];
    try {
      bars = await fetchBarsForTicker(ticker, BARS_DAYS);
    } catch (e) {
      console.log(`[WARN] ${ticker}: fetchBarsForTicker threw — ${(e as Error).message}. Skipping.`);
      continue;
    }
    if (!bars || bars.length < MIN_BARS) {
      console.log(`[WARN] ${ticker}: only ${bars?.length ?? 0} bars (< ${MIN_BARS}) — skipping ticker.`);
      continue;
    }
    // Defensive: ensure bars are sorted ascending by date (fetchBarsForTicker already is).
    bars = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const tradeableCount = bars.filter(b => b.date >= BACKTEST_START).length;
    console.log(`[DATA] ${ticker}: ${bars.length} bars (${bars[0].date} → ${bars[bars.length - 1].date}), ${tradeableCount} in backtest window.`);

    for (const config of ["A", "B", "C"] as ConfigId[]) {
      simulateConfig(config, ticker, bars, allTrades);
    }
  }

  // Reports
  const aggs = {} as Record<ConfigId, TickerStats>;
  for (const config of ["A", "B", "C"] as ConfigId[]) {
    aggs[config] = printConfigReport(config, allTrades);
  }
  printComparison(aggs);
  printBaselineComparison(aggs.A);
  printTradeLog(allTrades);

  console.log("");
  console.log(`Done. ${allTrades.length} total trades across 3 configs. (Simulation only — no live actions taken.)`);
}

main().catch(err => {
  console.error(`[FATAL] ${(err as Error).stack ?? err}`);
  process.exit(1);
});
