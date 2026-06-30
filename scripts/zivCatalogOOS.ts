/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  zivCatalogOOS.ts — READ-ONLY full-catalogue out-of-sample portfolio       ║
 * ║  backtest of the REAL current-live engine (Config C), LONG-ONLY.           ║
 * ║                                                                            ║
 * ║  PURE SIMULATION. NO DB writes. NO IBKR. NO orders. NO deploy. NO SSH.     ║
 * ║                                                                            ║
 * ║  Replays daily bars for the ~214-stock live catalogue (DEFAULT_60_ASSETS)  ║
 * ║  through the REAL Ziv engine (calcZivEngineScore) using the CURRENT-LIVE    ║
 * ║  Config-C entry (Gold Retest OR volume-confirmed Gold Breakout, weekly-     ║
 * ║  aligned, score >= 7.5) and the REAL "Open Skies v3" free-roll + Chandelier ║
 * ║  trail exit. The full trade list is generated ONCE across all available     ║
 * ║  history, then the portfolio equity-curve sim is run SEPARATELY for two     ║
 * ║  out-of-sample windows (2025-YTD and 2026-YTD) by filtering on entryDate.   ║
 * ║                                                                            ║
 * ║  SHORTS ARE OMITTED. This is the LONG side of the engine only — the live    ║
 * ║  regime/breadth short-gate is not modeled offline.                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * RUN (manager runs this on the droplet — has Yahoo/DB data; 214 tickers is slow):
 *   node --import tsx --env-file=.env scripts/zivCatalogOOS.ts
 *
 * BUILD-CHECK (local, no run):
 *   npx esbuild scripts/zivCatalogOOS.ts --bundle --platform=node --packages=external --outdir=/tmp/oosbc
 *
 * DATA SOURCE: only `fetchBarsForTicker` (server/marketData.ts) → DB cache / Yahoo.
 * Scoring uses the REAL `calcZivEngineScore` (server/zivEngine.ts) and the REAL
 * `confirmVolume` (server/volumeConfirm.ts). The Config-C entry + free-roll/trail
 * exit are COPIED from scripts/zivBacktest.ts (Config "C" path); the portfolio
 * equity-curve/leverage logic is ADAPTED from scripts/zivBacktestSizing.ts. Both
 * source files export nothing, so the relevant blocks are copied here. NO P&L or
 * price formula is re-implemented beyond those faithful copies.
 *
 * ── FIELD-NAME ASSUMPTIONS (so the manager can fix fast if a name is off) ─────
 *   Bar (server/zivEngine.ts):        { date: "YYYY-MM-DD"; open; high; low; close; volume? }
 *   ZivScoreResult fields used: .score, .tier, .donchian20High, .weeklyEma50Slope.
 *   Tier literals: "Gold Retest", "Gold Breakout".
 *   confirmVolume(bars, level, "long").confirmed: boolean.
 *   DEFAULT_60_ASSETS (server/routers/portfolio.ts): { ticker; companyName; sector; sortOrder }[].
 */

import "dotenv/config";
import { fetchBarsForTicker } from "../server/marketData";
import { calcZivEngineScore, type Bar, type ZivScoreResult } from "../server/zivEngine";
import { confirmVolume } from "../server/volumeConfirm";
import { DEFAULT_60_ASSETS } from "../server/routers/portfolio";

// ─── Universe (the ~214-stock live catalogue) ────────────────────────────────
const TICKERS: string[] = DEFAULT_60_ASSETS.map(a => a.ticker);

// ─── Engine / trade-model parameters (mirror scripts/zivBacktest.ts Config C) ─
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

// ─── Out-of-sample windows (entryDate filter; both run to last bar / today) ──
const WINDOWS: { label: string; start: string }[] = [
  { label: "WINDOW 2025", start: "2025-01-01" },
  { label: "WINDOW 2026", start: "2026-01-01" },
];
// Earliest tradeable date across all windows — entries before this are never used by
// any window, so we skip deciding them entirely (small speed win on 214 tickers).
const EARLIEST_WINDOW_START = WINDOWS.reduce(
  (min, w) => (w.start < min ? w.start : min),
  WINDOWS[0].start,
);

// ─── Portfolio sizing parameters (per the spec) ──────────────────────────────
const START_EQUITY = 100_000;        // $100k single compounding account
const LEVERAGE = 1.9;                // gross notional of OPEN positions ≤ LEVERAGE × equity
const HEAT_CAP = 0.20;               // Σ open riskDollars / equity ≤ 0.20 → skip new entry
const MAX_POSITION_USD = 85_000;     // cap notional of any single position
const RISK_PCT = 0.01;               // riskDollars = 1% × equityAtEntry

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

// ── Raw Config-C trade. r and stopDistPct are all the portfolio sim needs; the
//    rest is for the trade-log / winners-losers reporting. ──
interface RawTrade {
  ticker: string;
  entryDate: string;
  exitDate: string;
  tier: string;
  entry: number;
  sl: number;
  exitReason: ExitReason;
  r: number;                 // TOTAL R-multiple = leg1R + leg2R
  stopDistPct: number;       // (entry - sl) / entry → notional = riskDollars / stopDistPct
}

/**
 * CONFIG C entry decision (current live), LONG only. Copied from zivBacktest.ts
 * wantsEntry("C"):
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
  // confirmVolume is degrade-safe: missing/zero volume → not confirmed → no entry.
  return confirmVolume(windowBars, res.donchian20High, "long").confirmed;
}

/**
 * Simulate Config C over one ticker's bars (REAL free-roll+trail exit, copied from
 * zivBacktest.ts simulateConfig with config pinned to "C"). Pushes RawTrades into `out`.
 *
 * We DECIDE entries on bars whose date >= EARLIEST_WINDOW_START (earlier = warmup only).
 * Window filtering on entryDate happens later, per-window, in the portfolio sim — so a
 * single full trade list serves both windows.
 */
function simulateConfigC(ticker: string, bars: Bar[], out: RawTrade[]): void {
  // First bar we will consider entering on (date >= earliest window start). Everything
  // before is warmup that still feeds calcZivEngineScore / the structural stop.
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
      continue; // engine should never throw; never let one bad bar abort the run
    }
    if (res.tier === "No Data" || res.tier === "Error") continue;
    if (!wantsEntryConfigC(res, windowBars)) continue;

    // ── ENTRY ─────────────────────────────────────────────────────────────────
    const entry = bars[i].close;
    const slWindow = bars.slice(i - (SL_LOOKBACK - 1), i + 1);
    const sl = Math.min(...slWindow.map(b => b.low));
    if (!(sl < entry) || !(entry > 0)) continue;

    const riskPct = ((entry - sl) / entry) * 100;
    // RC-2 guard — mirror the live "skip when stop is too wide" rule.
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
        // ── PHASE 1: full size, stop at initial SL, time-stop active. SL-first on tie. ──
        if (bar.low <= currentStop) {
          exitReason = "SL"; exitDate = bar.date; exitIndex = j;
          leg1R = (currentStop - entry) / risk;     // full position exits → ≈ -1R
          leg2R = 0;
          break;
        }
        if (bar.high >= firstTarget) {
          // ── PHASE 2: tag +2R. Bank 50%, move residual stop to breakeven, seed trail. ──
          reachedFirstTarget = true;
          leg1R = FREE_ROLL_FRACTION * FIRST_TARGET_R; // 0.5 × 2 = +1.0R, locked
          currentStop = entry;                          // breakeven on residual 50%
          highestHigh = Math.max(highestHigh, bar.high);
          const atr = computeAtr14Local(bars.slice(0, j + 1));
          if (atr != null && atr > 0) {
            const chand = highestHigh - CHANDELIER_ATR_MULT * atr;
            trailStop = Math.max(currentStop, chand);   // never below breakeven
          } else {
            trailStop = currentStop;                    // degrade: hold BE if ATR unavailable
          }
          currentStop = trailStop;
          continue; // residual rides from the next bar onward
        }
        // Time-stop applies ONLY pre-free-roll: held strictly > TIME_STOP_BARS → exit at close.
        if (heldBars > TIME_STOP_BARS) {
          exitReason = "TIME"; exitDate = bar.date; exitIndex = j;
          leg1R = (bar.close - entry) / risk;
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
          trailStop = Math.max(trailStop, chand);       // tighten-only ratchet
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

    // Edge case: signal on the very last bar (no j to walk) → flat at entry.
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

    // Re-enter only on a LATER bar: jump i to the exit bar (loop's i++ moves past it).
    i = exitIndex;
  }
}

// ─── Portfolio equity-curve simulator (adapted from zivBacktestSizing.ts) ─────
// Chronological event stream over a SUBSET of trades (one window). An entry opens a
// position at entryDate (sized off realized equity-at-entry); it realizes P&L into
// equity at exitDate. Concurrent positions allowed. NEW entries are subject to three
// caps, each of which can SKIP or TRIM the entry (and is counted):
//   • gross leverage ≤ LEVERAGE × equity   (trim notional to headroom; 0 headroom → skip)
//   • portfolio heat ≤ HEAT_CAP            (Σ open riskDollars / equity ≤ 0.20 → SKIP)
//   • maxPositionUsd                       (cap a single position's notional → trim)
//
// SIZING (per the spec):
//   riskDollars = RISK_PCT × equityAtEntry
//   notional    = riskDollars / stopDistPct
//   tradePnl    = R × riskDollars        (R is sizing-independent; $ scales with size)
// When notional is trimmed by leverage or maxPositionUsd, riskDollars (hence tradePnl)
// scales by the SAME factor, so a capped trade's realized P&L shrinks proportionally.

interface EventRec {
  date: string;
  kind: "ENTRY" | "EXIT";
  tradeIndex: number;
}

interface OpenPos {
  tradeIndex: number;
  ticker: string;
  notional: number;      // actual (post-cap) gross notional held
  riskDollars: number;   // actual (post-cap) risk $ — feeds the heat calc
  pnl: number;           // realized $ P&L credited at exitDate
  exitDate: string;
}

interface ClosedTrade {
  ticker: string;
  entryDate: string;
  exitDate: string;
  exitReason: ExitReason;
  r: number;
  pnl: number;           // realized $ (post-cap)
  skipped: boolean;      // heat-skipped (no position taken)
}

interface PortfolioResult {
  window: string;
  totalTrades: number;        // entries that actually took a (non-zero) position
  tickersTraded: number;
  wins: number;
  winPct: number;
  totalR: number;             // sum of R over taken trades
  finalEquity: number;
  finalReturnPct: number;
  maxDrawdownPct: number;
  leverageCapHits: number;
  heatSkips: number;
  maxPosCapHits: number;
  exitBreakdown: Record<string, number>;
  topWinners: ClosedTrade[];
  topLosers: ClosedTrade[];
  curve: Array<{ date: string; equity: number }>;
}

/**
 * Run the portfolio sim for ONE window (the caller pre-filters rawTrades by entryDate).
 * Realized-equity convention: equity updates only on EXIT. Sizing for a NEW entry uses
 * realized equity AT THAT MOMENT (open positions' unrealized P&L excluded — conservative).
 */
function runPortfolio(windowTrades: RawTrade[], windowLabel: string): PortfolioResult {
  const events: EventRec[] = [];
  windowTrades.forEach((t, idx) => {
    events.push({ date: t.entryDate, kind: "ENTRY", tradeIndex: idx });
    events.push({ date: t.exitDate, kind: "EXIT", tradeIndex: idx });
  });
  // Ties: EXITs before ENTRYs on the same date (free capital/headroom + realize the
  // close before sizing a same-day open). Stable within kind by entry order.
  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "EXIT" ? -1 : 1;
    return a.tradeIndex - b.tradeIndex;
  });

  let equity = START_EQUITY;
  let peakEquity = START_EQUITY;
  let maxDrawdownPct = 0;

  let leverageCapHits = 0;
  let heatSkips = 0;
  let maxPosCapHits = 0;

  const openByTradeIndex = new Map<number, OpenPos>();
  const closed: ClosedTrade[] = [];
  const tickersTraded = new Set<string>();

  const curve: Array<{ date: string; equity: number }> = [
    { date: windowTrades.length ? windowTrades[0].entryDate : EARLIEST_WINDOW_START, equity },
  ];

  const grossOpenNotional = (): number => {
    let s = 0;
    for (const p of openByTradeIndex.values()) s += p.notional;
    return s;
  };
  const grossOpenRisk = (): number => {
    let s = 0;
    for (const p of openByTradeIndex.values()) s += p.riskDollars;
    return s;
  };

  for (const ev of events) {
    const t = windowTrades[ev.tradeIndex];

    if (ev.kind === "ENTRY") {
      const equityAtEntry = equity;
      let riskDollars = RISK_PCT * equityAtEntry;

      // ── Heat cap: Σ open riskDollars / equity ≤ HEAT_CAP → SKIP the new entry. ──
      const heatAfter = (grossOpenRisk() + riskDollars) / (equityAtEntry > 0 ? equityAtEntry : 1);
      if (heatAfter > HEAT_CAP) {
        heatSkips++;
        closed.push({
          ticker: t.ticker, entryDate: t.entryDate, exitDate: t.exitDate,
          exitReason: t.exitReason, r: t.r, pnl: 0, skipped: true,
        });
        continue; // no position opened — nothing to realize at exit
      }

      let notional = riskDollars / t.stopDistPct;

      // ── maxPositionUsd cap: trim notional (and risk$) to MAX_POSITION_USD. ──
      if (notional > MAX_POSITION_USD) {
        const scale = MAX_POSITION_USD / notional;
        notional *= scale;
        riskDollars *= scale;
        maxPosCapHits++;
      }

      // ── Gross-leverage cap: trim to remaining headroom. 0 headroom → ~0 size. ──
      const headroom = Math.max(0, LEVERAGE * equityAtEntry - grossOpenNotional());
      if (notional > headroom) {
        const scale = headroom > 0 ? headroom / notional : 0;
        notional *= scale;
        riskDollars *= scale;
        leverageCapHits++;
      }

      const pnl = t.r * riskDollars; // R is sizing-independent; $ scales with post-cap size

      openByTradeIndex.set(ev.tradeIndex, {
        tradeIndex: ev.tradeIndex,
        ticker: t.ticker,
        notional,
        riskDollars,
        pnl,
        exitDate: t.exitDate,
      });
    } else {
      const pos = openByTradeIndex.get(ev.tradeIndex);
      if (!pos) continue; // heat-skipped (never opened) — no exit to realize
      openByTradeIndex.delete(ev.tradeIndex);

      equity += pos.pnl;
      tickersTraded.add(pos.ticker);

      closed.push({
        ticker: t.ticker, entryDate: t.entryDate, exitDate: t.exitDate,
        exitReason: t.exitReason, r: t.r, pnl: pos.pnl, skipped: false,
      });

      if (equity > peakEquity) peakEquity = equity;
      const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;

      curve.push({ date: ev.date, equity: Math.round(equity) });
    }
  }

  const taken = closed.filter(c => !c.skipped);
  const wins = taken.filter(c => c.r > 0).length;
  const totalR = taken.reduce((s, c) => s + c.r, 0);

  const exitBreakdown: Record<string, number> = {};
  for (const c of taken) exitBreakdown[c.exitReason] = (exitBreakdown[c.exitReason] ?? 0) + 1;

  const byPnlDesc = [...taken].sort((a, b) => b.pnl - a.pnl);
  const topWinners = byPnlDesc.slice(0, 10);
  const topLosers = [...taken].sort((a, b) => a.pnl - b.pnl).slice(0, 10);

  return {
    window: windowLabel,
    totalTrades: taken.length,
    tickersTraded: tickersTraded.size,
    wins,
    winPct: taken.length > 0 ? (wins / taken.length) * 100 : 0,
    totalR: Math.round(totalR * 100) / 100,
    finalEquity: Math.round(equity),
    finalReturnPct: ((equity - START_EQUITY) / START_EQUITY) * 100,
    maxDrawdownPct: maxDrawdownPct * 100,
    leverageCapHits,
    heatSkips,
    maxPosCapHits,
    exitBreakdown,
    topWinners,
    topLosers,
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
    if (dir1 !== dir2 || dir1 !== 0) out.push(cur);
  }
  out.push(curve[curve.length - 1]);
  return out;
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
function sign(n: number): string { return n >= 0 ? "+" : ""; }

function printWindowReport(res: PortfolioResult): void {
  console.log("");
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`═══ ${res.window} (lev ${LEVERAGE}×) ═══`);
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`  SHORTS ARE OMITTED — this is the LONG side of the engine only.`);
  console.log(`  total trades        : ${res.totalTrades}`);
  console.log(`  tickers traded      : ${res.tickersTraded}`);
  console.log(`  win%                : ${res.winPct.toFixed(1)}%  (${res.wins}/${res.totalTrades})`);
  console.log(`  total R             : ${sign(res.totalR)}${res.totalR.toFixed(2)}R`);
  console.log(`  portfolio return %  : ${sign(res.finalReturnPct)}${res.finalReturnPct.toFixed(2)}%`);
  console.log(`  final equity $      : $${res.finalEquity.toLocaleString()}`);
  console.log(`  max drawdown %      : ${res.maxDrawdownPct.toFixed(2)}%`);
  console.log(`  leverage-cap hits   : ${res.leverageCapHits}`);
  console.log(`  heat-skips          : ${res.heatSkips}`);
  console.log(`  maxPositionUsd hits : ${res.maxPosCapHits}`);

  // Exit-reason breakdown.
  const order: ExitReason[] = ["SL", "TIME", "TRAIL", "TRAIL_OPEN", "OPEN"];
  const breakdown = order
    .filter(k => res.exitBreakdown[k])
    .map(k => `${k}=${res.exitBreakdown[k]}`)
    .join("  ");
  console.log(`  exit-reason breakdown: ${breakdown || "(none)"}`);

  // Top-10 $ winners.
  console.log("");
  console.log(`  ── TOP-10 $ WINNERS ──`);
  console.log(`  ${pad("TICKER", 8)}${pad("ENTRY", 12)}${pad("EXIT", 12)}${pad("REASON", 12)}${padL("R", 8)}${padL("PNL_$", 12)}`);
  for (const t of res.topWinners) {
    console.log(`  ${pad(t.ticker, 8)}${pad(t.entryDate, 12)}${pad(t.exitDate, 12)}${pad(t.exitReason, 12)}${padL(t.r.toFixed(2), 8)}${padL(sign(t.pnl) + "$" + Math.round(t.pnl).toLocaleString(), 12)}`);
  }
  // Top-10 $ losers.
  console.log("");
  console.log(`  ── TOP-10 $ LOSERS ──`);
  console.log(`  ${pad("TICKER", 8)}${pad("ENTRY", 12)}${pad("EXIT", 12)}${pad("REASON", 12)}${padL("R", 8)}${padL("PNL_$", 12)}`);
  for (const t of res.topLosers) {
    console.log(`  ${pad(t.ticker, 8)}${pad(t.entryDate, 12)}${pad(t.exitDate, 12)}${pad(t.exitReason, 12)}${padL(t.r.toFixed(2), 8)}${padL(sign(t.pnl) + "$" + Math.round(t.pnl).toLocaleString(), 12)}`);
  }

  // Equity-curve inflection points.
  console.log("");
  console.log(`  ── EQUITY-CURVE INFLECTION POINTS ──`);
  const parts = res.curve.map(p => `(${p.date}, $${p.equity.toLocaleString()})`);
  console.log(`  ${parts.join("  →  ")}`);

  // Machine-readable line for downstream parsing.
  console.log(`[JSON] ${JSON.stringify({
    window: res.window,
    leverage: LEVERAGE,
    totalTrades: res.totalTrades,
    tickersTraded: res.tickersTraded,
    winPct: Math.round(res.winPct * 10) / 10,
    totalR: res.totalR,
    finalReturnPct: Math.round(res.finalReturnPct * 100) / 100,
    finalEquity: res.finalEquity,
    maxDrawdownPct: Math.round(res.maxDrawdownPct * 100) / 100,
    leverageCapHits: res.leverageCapHits,
    heatSkips: res.heatSkips,
    maxPosCapHits: res.maxPosCapHits,
    exitBreakdown: res.exitBreakdown,
    topWinners: res.topWinners.map(t => ({ ticker: t.ticker, entryDate: t.entryDate, r: t.r, pnl: Math.round(t.pnl) })),
    topLosers: res.topLosers.map(t => ({ ticker: t.ticker, entryDate: t.entryDate, r: t.r, pnl: Math.round(t.pnl) })),
    curve: res.curve,
  })}`);
}

function printDisclaimer(): void {
  console.log("");
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`SIMPLIFICATIONS / DISCLAIMER — read before trusting any number above`);
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`  • SHORTS OMITTED: this models the LONG side only. The live regime/breadth`);
  console.log(`    short-gate is not reproduced offline, so this UNDERSTATES P&L in bear`);
  console.log(`    stretches where live shorts would profit — though live also BLOCKS shorts`);
  console.log(`    in a bull tape, so the omission is directionally consistent with live.`);
  console.log(`  • GATES NOT MODELED: correlation / ClusterGuard, breadth, confluence,`);
  console.log(`    liquidity, and sector gates are NOT applied here. This makes the sim`);
  console.log(`    OPTIMISTIC on concurrency and concentration — the real engine would have`);
  console.log(`    blocked many of these simultaneous correlated longs.`);
  console.log(`  • DAILY-BAR TRAIL OVERSTATES: the Chandelier trail is evaluated on DAILY`);
  console.log(`    highs/lows, letting winners "run" further than the live INTRADAY tick-`);
  console.log(`    level stop would have allowed. Real exits are tighter → less R.`);
  console.log(`  • NO FRICTION: zero slippage, zero commissions, perfect fills at signal`);
  console.log(`    close and at the exact stop/trail level. Live is worse on all three.`);
  console.log(`  • THIN 2025 WARMUP: with fetchBarsForTicker(..,420) reaching ~2024-10, the`);
  console.log(`    2025 window opens on only ~50 bars of late-2024 warmup, so early-2025`);
  console.log(`    scores lean on a short history — treat early-2025 entries with caution.`);
  console.log(`  • CAPS MODEL HEADROOM ONLY: leverage/heat/maxPosition caps trim or skip new`);
  console.log(`    size but do NOT model margin calls, overnight gap risk, or IBKR forced`);
  console.log(`    liquidation. Max-DD is measured on REALIZED equity and is a FLOOR, not a`);
  console.log(`    ceiling — a correlated cluster gap-down is materially worse.`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`Ziv Catalogue OOS Backtest — READ-ONLY (no DB writes, no IBKR, no orders, no SSH)`);
  console.log(`Engine: CONFIG C (current live), LONG-ONLY. Universe: ${TICKERS.length} tickers (DEFAULT_60_ASSETS).`);
  console.log(`Entry: (Gold Retest OR vol-confirmed Gold Breakout) & score >= ${ENTRY_MIN_SCORE} & weeklySlope > 0.`);
  console.log(`SL = ${SL_LOOKBACK}-bar low | RC-2 skip if (entry-SL)/entry > ${RC2_MAX_RISK_PCT}%.`);
  console.log(`Exit = REAL free-roll+trail: bank 50% @ +2R → BE → Chandelier (highHigh − ${CHANDELIER_ATR_MULT}×ATR${ATR_PERIOD} simple), time-stop >${TIME_STOP_BARS} bars pre-2R, SL-first on tie.`);
  console.log(`Portfolio: $${START_EQUITY.toLocaleString()} compounding, ${RISK_PCT * 100}% risk/trade, lev ≤ ${LEVERAGE}×, heat ≤ ${HEAT_CAP * 100}%, maxPos $${MAX_POSITION_USD.toLocaleString()}.`);
  console.log(`Windows: ${WINDOWS.map(w => `${w.label} (entryDate >= ${w.start})`).join("  |  ")}.`);
  console.log(`SHORTS ARE OMITTED — long side of the engine only.`);

  // 1) Build the FULL Config-C trade list ONCE across all tickers (one fetch per ticker).
  const allTrades: RawTrade[] = [];
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
        continue; // not enough warmup history for the engine
      }
      bars = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

      // Skip a ticker with no bars at/after the earliest window start (nothing tradeable).
      const lastDate = bars[bars.length - 1].date;
      if (lastDate < EARLIEST_WINDOW_START) {
        skippedNoData++;
        continue;
      }
      // Require >= MIN_BARS of warmup BEFORE the earliest window start (else the first
      // window's early scores would be thin past the documented caveat — skip ticker).
      const warmupBefore = bars.filter(b => b.date < EARLIEST_WINDOW_START).length;
      if (warmupBefore < MIN_BARS) {
        skippedNoData++;
        continue;
      }

      simulateConfigC(ticker, bars, allTrades);
    } catch (e) {
      // Wrap EACH ticker — gateway flakiness / bad data must never abort the full run.
      console.log(`[WARN] ${ticker}: ${(e as Error).message ?? e}. Skipping ticker.`);
      continue;
    }
  }

  console.log("");
  console.log(`[DONE BUILDING] ${allTrades.length} total Config-C LONG entries across ${TICKERS.length - skippedNoData} usable tickers (${skippedNoData} skipped: no data / thin warmup).`);

  // 2) Run the PORTFOLIO sim SEPARATELY for each window (filter trades by entryDate).
  for (const w of WINDOWS) {
    const windowTrades = allTrades
      .filter(t => t.entryDate >= w.start)
      .sort((a, b) => {
        if (a.entryDate !== b.entryDate) return a.entryDate < b.entryDate ? -1 : 1;
        if (a.exitDate !== b.exitDate) return a.exitDate < b.exitDate ? -1 : 1;
        return a.ticker < b.ticker ? -1 : 1;
      });
    const res = runPortfolio(windowTrades, w.label);
    printWindowReport(res);
  }

  printDisclaimer();

  console.log("");
  console.log(`Done. ${allTrades.length} Config-C LONG trades; ${WINDOWS.length} windows sized. (Simulation only — no live actions taken.)`);
}

main().catch(err => {
  console.error(`[FATAL] ${(err as Error).stack ?? err}`);
  process.exit(1);
});
