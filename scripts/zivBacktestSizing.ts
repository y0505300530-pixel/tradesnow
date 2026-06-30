/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  zivBacktestSizing.ts — READ-ONLY portfolio equity-curve + risk sweep      ║
 * ║                                                                            ║
 * ║  PURE SIMULATION. NO DB writes. NO IBKR. NO orders. NO deploy.             ║
 * ║                                                                            ║
 * ║  Takes the SAME ZIV setups as Config A ("Ziv-pure", == current-live        ║
 * ║  Config C's retest core) and models AGGRESSIVE sizing + leverage on top.   ║
 * ║  The per-trade R values are SIZING-INDEPENDENT — they are produced by the   ║
 * ║  real free-roll+trail exit (copied verbatim from scripts/zivBacktest.ts).   ║
 * ║  Sizing only scales the $; R never changes. So we run Config A once to get   ║
 * ║  the chronological trade list (entryDate, exitDate, ticker, R, stopDistPct), ║
 * ║  then drive a $100k COMPOUNDING portfolio sim with concurrent positions and  ║
 * ║  a 1.8× gross-leverage cap across a sweep of risk-per-trade values.          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * RUN (manager runs this on the droplet — has Yahoo/DB data; local has none):
 *   node --import tsx --env-file=.env scripts/zivBacktestSizing.ts
 *
 * BUILD-CHECK (local, no run):
 *   npx esbuild scripts/zivBacktestSizing.ts --bundle --platform=node --packages=external --outdir=/tmp/btc3
 *
 * DATA SOURCE: only `fetchBarsForTicker` (server/marketData.ts) → DB cache / Yahoo.
 * Scoring uses the REAL `calcZivEngineScore` (server/zivEngine.ts) and REAL
 * `confirmVolume` (server/volumeConfirm.ts). No P&L/price formula is re-implemented;
 * the exit model is copied byte-for-byte from scripts/zivBacktest.ts (Config A path).
 *
 * NB: the Config-A engine/exit block below is a faithful COPY of scripts/zivBacktest.ts
 * (that file exports nothing). If zivBacktest.ts changes, re-sync the copied block.
 */

import "dotenv/config";
import { fetchBarsForTicker } from "../server/marketData";
import { calcZivEngineScore, type Bar, type ZivScoreResult } from "../server/zivEngine";
import { confirmVolume } from "../server/volumeConfirm";

// ─── Parameters (mirror scripts/zivBacktest.ts exactly) ──────────────────────
const TICKERS = ["SNDK", "MU", "INTC", "NVDA", "RKLB"] as const;
const BACKTEST_START = "2026-01-01";
const BARS_DAYS = 420;
const MIN_BARS = 50;
const ENTRY_MIN_SCORE = 7.5;

const SL_LOOKBACK = 10;
const RC2_MAX_RISK_PCT = 12;
const FIRST_TARGET_R = 2;
const FREE_ROLL_FRACTION = 0.5;
const TIME_STOP_BARS = 10;
const CHANDELIER_ATR_MULT = 2.5;
const ATR_PERIOD = 14;

// ─── Portfolio sizing parameters (this file's contribution) ──────────────────
const START_EQUITY = 100_000;        // $100k single compounding account
const LEVERAGE_CAP = 1.8;            // gross notional of OPEN positions ≤ 1.8 × equity
const RUIN_THRESHOLD = 0.20;         // equity ≤ 20% of start = effectively blown up
const RISK_SWEEP = [0.01, 0.02, 0.03, 0.05, 0.08, 0.10]; // 1%..10%
const TARGET_RETURN = 1.00;          // solve for the riskPct yielding ≈ +100%

// computeAtr14Local — SIMPLE 14-bar mean True Range (== server/slCalculator.ts:251).
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

// ── Raw Config-A trade (sizing-INDEPENDENT). r and stopDistPct are all sizing needs. ──
interface RawTrade {
  ticker: string;
  entryDate: string;
  exitDate: string;
  tier: string;
  entry: number;
  sl: number;
  exitReason: ExitReason;
  r: number;                 // TOTAL R-multiple = leg1R + leg2R
  stopDistPct: number;       // (entry - sl) / entry  → notional = riskDollars / stopDistPct
}

/**
 * CONFIG A entry decision (Ziv-pure / retest-only). Copied from zivBacktest.ts wantsEntry("A").
 *   tier === "Gold Retest" AND score >= 7.5 AND weeklyEma50Slope > 0.
 */
function wantsEntryConfigA(res: ZivScoreResult): boolean {
  const weeklyAligned = res.weeklyEma50Slope > 0;
  const scoreOk = res.score >= ENTRY_MIN_SCORE;
  return res.tier === "Gold Retest" && scoreOk && weeklyAligned;
}

/**
 * Simulate Config A over one ticker's bars (REAL free-roll+trail exit, copied from
 * zivBacktest.ts simulateConfig with config pinned to "A"). Pushes RawTrades into `out`.
 * Only the fields the sizing sim needs are retained.
 */
function simulateConfigA(ticker: string, bars: Bar[], out: RawTrade[]): void {
  let i = 0;
  while (i < bars.length && bars[i].date < BACKTEST_START) i++;

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
    if (!wantsEntryConfigA(res)) continue;

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
    });

    i = exitIndex;
  }
}

// ─── Portfolio equity-curve simulator ────────────────────────────────────────
// Process trades in chronological order. An entry opens a position at entryDate
// (sizing off equity-at-entry); it realizes P&L into equity at exitDate. Multiple
// positions can be open at once (concurrent). The 1.8× gross-leverage cap is
// enforced at each entry against the notional of all currently-open positions.
//
// SIZING (per the spec):
//   riskDollars   = riskPct × equityAtEntry        (1% .. 10% of CURRENT equity)
//   notional      = riskDollars / stopDistPct       (so a $X stop move = riskDollars)
//   tradePnl      = R × riskDollars                 (R is sizing-independent)
//
// LEVERAGE CAP: when opening, if (openNotional + notional) > 1.8×equity, scale the
//   new position DOWN to the remaining headroom = max(0, 1.8×equity − openNotional).
//   Both notional AND riskDollars (hence tradePnl) scale by the same factor, so the
//   realized P&L of a capped trade shrinks proportionally. A cap "hit" is counted
//   whenever the requested notional is trimmed (scale < 1). If headroom is 0 the
//   trade still "occurs" but with ~0 size (it contributes ~0 P&L) — documented.

interface EventRec {
  date: string;
  kind: "ENTRY" | "EXIT";
  tradeIndex: number;
}

interface OpenPos {
  tradeIndex: number;
  ticker: string;
  notional: number;     // actual (post-cap) gross notional held
  pnlAtExit: number;    // realized $ P&L credited at exitDate
  exitDate: string;
}

interface SweepResult {
  riskPct: number;
  finalEquity: number;
  finalReturnPct: number;
  maxDrawdownPct: number;
  leverageCapHits: number;
  longestLossStreak: number;
  ruin: boolean;
  curve: Array<{ date: string; equity: number }>; // inflection points (post-exit equity)
}

/**
 * Run the portfolio sim for one riskPct. Returns the equity-curve summary.
 *
 * Realized-equity convention: equity is updated ONLY when a position EXITS (its P&L
 * is credited at exitDate). Drawdown / streak / ruin are measured on this realized
 * equity curve — matching the spec's "peak-to-trough on realized equity". Sizing for
 * a NEW entry uses the realized equity AT THE MOMENT of that entry (open positions are
 * not yet realized, so their unrealized P&L does not inflate sizing — conservative).
 */
function runPortfolio(rawTrades: RawTrade[], riskPct: number): SweepResult {
  // Build a chronological event stream. Ties: process EXITs before ENTRYs on the same
  // date so freed capital/headroom is available to a same-day entry (and realized
  // equity reflects the close before sizing the open). Stable within kind by entryDate.
  const events: EventRec[] = [];
  rawTrades.forEach((t, idx) => {
    events.push({ date: t.entryDate, kind: "ENTRY", tradeIndex: idx });
    events.push({ date: t.exitDate, kind: "EXIT", tradeIndex: idx });
  });
  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "EXIT" ? -1 : 1; // EXIT before ENTRY same day
    return a.tradeIndex - b.tradeIndex;
  });

  let equity = START_EQUITY;
  let peakEquity = START_EQUITY;
  let maxDrawdownPct = 0;
  let ruin = false;

  // Loss-streak tracking (over exits in chronological order, by trade R sign).
  let curStreak = 0;
  let longestLossStreak = 0;

  let leverageCapHits = 0;
  const openByTradeIndex = new Map<number, OpenPos>();
  const curve: Array<{ date: string; equity: number }> = [
    { date: rawTrades.length ? rawTrades[0].entryDate : BACKTEST_START, equity },
  ];

  const grossOpenNotional = (): number => {
    let s = 0;
    for (const p of openByTradeIndex.values()) s += p.notional;
    return s;
  };

  for (const ev of events) {
    const t = rawTrades[ev.tradeIndex];

    if (ev.kind === "ENTRY") {
      // Size off CURRENT realized equity.
      const equityAtEntry = equity;
      const requestedRiskDollars = riskPct * equityAtEntry;
      const requestedNotional = requestedRiskDollars / t.stopDistPct;

      // Leverage cap: trim to remaining headroom.
      const headroom = Math.max(0, LEVERAGE_CAP * equityAtEntry - grossOpenNotional());
      let scale = 1;
      if (requestedNotional > headroom) {
        scale = headroom > 0 ? headroom / requestedNotional : 0;
        leverageCapHits++;
      }
      const notional = requestedNotional * scale;
      const riskDollars = requestedRiskDollars * scale;
      const pnlAtExit = t.r * riskDollars; // R is sizing-independent; $ scales with size

      openByTradeIndex.set(ev.tradeIndex, {
        tradeIndex: ev.tradeIndex,
        ticker: t.ticker,
        notional,
        pnlAtExit,
        exitDate: t.exitDate,
      });
    } else {
      // EXIT: realize P&L into equity.
      const pos = openByTradeIndex.get(ev.tradeIndex);
      if (!pos) continue; // should not happen
      openByTradeIndex.delete(ev.tradeIndex);

      equity += pos.pnlAtExit;

      // Drawdown on realized equity.
      if (equity > peakEquity) peakEquity = equity;
      const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;

      // Ruin flag.
      if (equity <= RUIN_THRESHOLD * START_EQUITY) ruin = true;

      // Loss-streak (by realized trade R sign).
      if (t.r < 0) {
        curStreak++;
        if (curStreak > longestLossStreak) longestLossStreak = curStreak;
      } else {
        curStreak = 0;
      }

      curve.push({ date: ev.date, equity: Math.round(equity) });
    }
  }

  return {
    riskPct,
    finalEquity: Math.round(equity),
    finalReturnPct: ((equity - START_EQUITY) / START_EQUITY) * 100,
    maxDrawdownPct: maxDrawdownPct * 100,
    leverageCapHits,
    longestLossStreak,
    ruin,
    curve: compactCurve(curve),
  };
}

/** Reduce the equity curve to inflection points (drop collinear/flat runs). */
function compactCurve(
  curve: Array<{ date: string; equity: number }>,
): Array<{ date: string; equity: number }> {
  if (curve.length <= 2) return curve;
  const out: Array<{ date: string; equity: number }> = [curve[0]];
  for (let k = 1; k < curve.length - 1; k++) {
    const prev = out[out.length - 1];
    const cur = curve[k];
    const next = curve[k + 1];
    const dir1 = Math.sign(cur.equity - prev.equity);
    const dir2 = Math.sign(next.equity - cur.equity);
    // Keep this point if the direction of the curve changes here (an inflection),
    // or if equity moved at all relative to the last kept point.
    if (dir1 !== dir2 || dir1 !== 0) out.push(cur);
  }
  out.push(curve[curve.length - 1]);
  return out;
}

/**
 * Solve for the riskPct that yields ≈ TARGET_RETURN final return.
 * finalReturn is monotincreasing-ish in riskPct over the relevant range (more size →
 * more $ on the same R sequence), but the leverage cap flattens it at the top, so we
 * SCAN fine-grained (0.5%..15% by 0.1%) and pick the riskPct whose finalReturn is
 * closest to the target. Returns null if even the max scanned risk can't reach it.
 */
function solveForTargetReturn(
  rawTrades: RawTrade[],
  targetReturn: number,
): { riskPct: number; result: SweepResult } | null {
  let best: { riskPct: number; result: SweepResult; err: number } | null = null;
  for (let rp = 0.005; rp <= 0.1501; rp += 0.001) {
    const riskPct = Math.round(rp * 1000) / 1000;
    const res = runPortfolio(rawTrades, riskPct);
    const err = Math.abs(res.finalReturnPct / 100 - targetReturn);
    if (best === null || err < best.err) best = { riskPct, result: res, err };
  }
  if (!best) return null;
  return { riskPct: best.riskPct, result: best.result };
}

// ─── Reporting helpers ───────────────────────────────────────────────────────
function pad(s: string | number, w: number): string {
  const str = String(s);
  return str.length >= w ? str : str + " ".repeat(w - str.length);
}
function padL(s: string | number, w: number): string {
  const str = String(s);
  return str.length >= w ? str : " ".repeat(w - str.length) + str;
}

function printRawTrades(rawTrades: RawTrade[]): void {
  console.log("");
  console.log(`════════════════════════════════════════════════════════════════════`);
  console.log(`CONFIG A TRADE LIST (sizing-independent R) — chronological by entryDate`);
  console.log(`════════════════════════════════════════════════════════════════════`);
  console.log(
    `${pad("TICKER", 8)}${pad("ENTRY_DATE", 12)}${pad("EXIT_DATE", 12)}${pad("REASON", 12)}` +
    `${padL("R", 8)}${padL("STOPDIST%", 11)}`,
  );
  for (const t of rawTrades) {
    console.log(
      `${pad(t.ticker, 8)}${pad(t.entryDate, 12)}${pad(t.exitDate, 12)}${pad(t.exitReason, 12)}` +
      `${padL(t.r.toFixed(2), 8)}${padL((t.stopDistPct * 100).toFixed(2), 11)}`,
    );
  }
  const totalR = rawTrades.reduce((s, t) => s + t.r, 0);
  console.log(`${"-".repeat(63)}`);
  console.log(`${pad(`${rawTrades.length} trades`, 44)}${padL(totalR.toFixed(2), 8)}`);
  console.log(`[JSON] ${JSON.stringify({ rawTrades })}`);
}

function printSweepTable(results: SweepResult[]): void {
  console.log("");
  console.log(`════════════════════════════════════════════════════════════════════`);
  console.log(`RISK-PER-TRADE SWEEP — $${START_EQUITY.toLocaleString()} compounding, ${LEVERAGE_CAP}× gross-leverage cap`);
  console.log(`════════════════════════════════════════════════════════════════════`);
  console.log(
    `${pad("RISK%", 8)}${padL("FINAL_RET%", 12)}${padL("FINAL_EQ$", 14)}${padL("MAX_DD%", 10)}` +
    `${padL("LEVCAP_HITS", 13)}${padL("LOSS_STREAK", 13)}${padL("RUIN?", 8)}`,
  );
  for (const r of results) {
    console.log(
      `${pad((r.riskPct * 100).toFixed(0) + "%", 8)}` +
      `${padL((r.finalReturnPct >= 0 ? "+" : "") + r.finalReturnPct.toFixed(1), 12)}` +
      `${padL("$" + r.finalEquity.toLocaleString(), 14)}` +
      `${padL(r.maxDrawdownPct.toFixed(1), 10)}` +
      `${padL(r.leverageCapHits, 13)}` +
      `${padL(r.longestLossStreak, 13)}` +
      `${padL(r.ruin ? "RUIN" : "no", 8)}`,
    );
  }
  console.log(`[JSON] ${JSON.stringify({ sweep: results.map(r => ({
    riskPct: r.riskPct,
    finalReturnPct: Math.round(r.finalReturnPct * 10) / 10,
    finalEquity: r.finalEquity,
    maxDrawdownPct: Math.round(r.maxDrawdownPct * 10) / 10,
    leverageCapHits: r.leverageCapHits,
    longestLossStreak: r.longestLossStreak,
    ruin: r.ruin,
  })) })}`);
}

function printEquityCurve(label: string, res: SweepResult): void {
  console.log("");
  console.log(`──── EQUITY CURVE (inflection points) — ${label} (risk ${(res.riskPct * 100).toFixed(1)}%) ────`);
  const parts = res.curve.map(p => `(${p.date}, $${p.equity.toLocaleString()})`);
  console.log(parts.join("  →  "));
  console.log(`[JSON] ${JSON.stringify({ curveLabel: label, riskPct: res.riskPct, curve: res.curve })}`);
}

function printDisclaimer(): void {
  console.log("");
  console.log(`════════════════════════════════════════════════════════════════════`);
  console.log(`DISCLAIMER — read before trusting any number above`);
  console.log(`════════════════════════════════════════════════════════════════════`);
  console.log(`  • TINY SAMPLE: ~11 trades across 5 names over ~6 months. Not statistically`);
  console.log(`    significant; one different exit flips the whole curve.`);
  console.log(`  • DAILY-BAR TRAIL OVERSTATES: the Chandelier trail is evaluated on daily`);
  console.log(`    highs/lows, which lets winners "run" further than the live INTRADAY`);
  console.log(`    tick-level stop would have allowed. Real exits are tighter → less R.`);
  console.log(`  • NO FRICTION: zero slippage, zero commissions, perfect fills at signal`);
  console.log(`    close and at the exact stop/trail level. Live is worse on all three.`);
  console.log(`  • MAX-DD IS A FLOOR, NOT A CEILING: drawdown here is measured on REALIZED`);
  console.log(`    equity only, and these 5 names are highly correlated (semis + space).`);
  console.log(`    A real correlated-cluster drawdown (all open longs gapping down together)`);
  console.log(`    is materially WORSE than the realized peak-to-trough shown here.`);
  console.log(`  • LEVERAGE CAP MODELS HEADROOM ONLY: it trims new size to fit 1.8× gross,`);
  console.log(`    but does NOT model margin calls, overnight gap risk, or IBKR maint-margin`);
  console.log(`    forced liquidation. At high riskPct the real account could be liquidated`);
  console.log(`    in a gap-down LONG before the modeled "trail exit" ever prints.`);
  console.log(`  • COMPOUNDING + CONCURRENCY: sizing uses realized equity at entry; unrealized`);
  console.log(`    open-trade P&L is intentionally excluded (conservative on the way up,`);
  console.log(`    optimistic on the way down).`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`Ziv Sizing/Leverage Backtest — READ-ONLY (no DB writes, no IBKR, no orders)`);
  console.log(`Tickers: ${TICKERS.join(", ")}  |  Window: date >= ${BACKTEST_START}`);
  console.log(`Base setups: CONFIG A (Ziv-pure retest, == current-live Config C retest core).`);
  console.log(`Portfolio: $${START_EQUITY.toLocaleString()} compounding, concurrent positions, ${LEVERAGE_CAP}× gross-leverage cap.`);
  console.log(`R is SIZING-INDEPENDENT (from real free-roll+trail exit); sizing only scales the $.`);

  // 1) Build Config-A trade list.
  const rawTrades: RawTrade[] = [];
  for (const ticker of TICKERS) {
    let bars: Bar[] = [];
    try {
      bars = await fetchBarsForTicker(ticker, BARS_DAYS);
    } catch (e) {
      console.log(`[WARN] ${ticker}: fetchBarsForTicker threw — ${(e as Error).message}. Skipping.`);
      continue;
    }
    if (!bars || bars.length < MIN_BARS) {
      console.log(`[WARN] ${ticker}: only ${bars?.length ?? 0} bars (< ${MIN_BARS}) — skipping.`);
      continue;
    }
    bars = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const tradeableCount = bars.filter(b => b.date >= BACKTEST_START).length;
    console.log(`[DATA] ${ticker}: ${bars.length} bars (${bars[0].date} → ${bars[bars.length - 1].date}), ${tradeableCount} in window.`);
    simulateConfigA(ticker, bars, rawTrades);
  }

  // Chronological by entryDate (tie-break: exitDate then ticker) for the portfolio sim.
  rawTrades.sort((a, b) => {
    if (a.entryDate !== b.entryDate) return a.entryDate < b.entryDate ? -1 : 1;
    if (a.exitDate !== b.exitDate) return a.exitDate < b.exitDate ? -1 : 1;
    return a.ticker < b.ticker ? -1 : 1;
  });

  printRawTrades(rawTrades);

  if (rawTrades.length === 0) {
    console.log(`\n[WARN] No Config-A trades produced — nothing to size. (Check data availability.)`);
    return;
  }

  // 2) Risk sweep.
  const sweep = RISK_SWEEP.map(rp => runPortfolio(rawTrades, rp));
  printSweepTable(sweep);

  // 3) Solve for ≈ +100% final return.
  const solved = solveForTargetReturn(rawTrades, TARGET_RETURN);

  // Equity curves: print the curve for the sweep point closest to 100%, plus the solved one.
  const closestSweep = sweep.reduce((best, r) =>
    Math.abs(r.finalReturnPct - 100) < Math.abs(best.finalReturnPct - 100) ? r : best,
  );
  printEquityCurve("closest sweep point to +100%", closestSweep);
  if (solved) printEquityCurve("solved for ≈ +100%", solved.result);

  // 4) Headline.
  console.log("");
  console.log(`════════════════════════════════════════════════════════════════════`);
  console.log(`HEADLINE`);
  console.log(`════════════════════════════════════════════════════════════════════`);
  if (solved) {
    const s = solved.result;
    console.log(
      `To reach ~100% you must risk ${(solved.riskPct * 100).toFixed(1)}% per trade, ` +
      `which rode a ${s.maxDrawdownPct.toFixed(1)}% max drawdown ` +
      `(final ${s.finalReturnPct >= 0 ? "+" : ""}${s.finalReturnPct.toFixed(1)}% → $${s.finalEquity.toLocaleString()}; ` +
      `levcap hits ${s.leverageCapHits}; longest loss streak ${s.longestLossStreak}; ${s.ruin ? "RUIN FLAGGED" : "no ruin"}).`,
    );
    console.log(`[JSON] ${JSON.stringify({ headline: {
      targetReturnPct: 100,
      requiredRiskPct: solved.riskPct,
      maxDrawdownPct: Math.round(s.maxDrawdownPct * 10) / 10,
      finalReturnPct: Math.round(s.finalReturnPct * 10) / 10,
      finalEquity: s.finalEquity,
      leverageCapHits: s.leverageCapHits,
      longestLossStreak: s.longestLossStreak,
      ruin: s.ruin,
    } })}`);
  } else {
    console.log(`No scanned riskPct (≤ 15%) reached +100% under the ${LEVERAGE_CAP}× leverage cap — the cap is the binding constraint.`);
  }

  printDisclaimer();

  console.log("");
  console.log(`Done. ${rawTrades.length} Config-A trades sized across ${RISK_SWEEP.length} risk levels. (Simulation only — no live actions.)`);
}

main().catch(err => {
  console.error(`[FATAL] ${(err as Error).stack ?? err}`);
  process.exit(1);
});
