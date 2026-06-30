/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  elzaV3.ts — Elza v3 "SHALLOW-MOMENTUM" READ-ONLY backtest harness.        ║
 * ║                                                                            ║
 * ║  PURE SIMULATION. NO DB writes. NO IBKR. NO orders. NO deploy. NO SSH.     ║
 * ║                                                                            ║
 * ║  Replays daily bars for the ~214-stock live catalogue (DEFAULT_60_ASSETS)  ║
 * ║  through the REAL Ziv engine (calcZivEngineScore), LONG-ONLY, with the      ║
 * ║  v3 SHALLOW-MOMENTUM entry overlay and the v3 FAST TIME-STOP exit, then     ║
 * ║  runs a single sane $100k portfolio sim and benchmarks it against SPY       ║
 * ║  buy&hold over two windows (2025-YTD, 2026-YTD).                            ║
 * ║                                                                            ║
 * ║  WHAT CHANGES vs the Config-C base (zivCatalogOOS.ts / zivDiagnostics.ts):  ║
 * ║   • ENTRY — SHALLOW-MOMENTUM gate. Base scoring is UNCHANGED (calcZiv-       ║
 * ║     EngineScore, score >= 7.5, weeklyEma50Slope > 0, RC-2 skip if           ║
 * ║     (entry-SL)/entry > 0.12). THEN: a Gold-Retest entry is allowed ONLY IF   ║
 * ║     entry > EMA50 (above the 50) AND entry is within ±2.5% of EMA20 OR EMA10 ║
 * ║     (a shallow touch of the 10/20). Otherwise HARD REJECT (rejDeep):         ║
 * ║     entry <= EMA50 (deep pullback / falling knife) OR entry > 2.5% from BOTH ║
 * ║     EMA10 and EMA20 (the "mid" zone between the 20 and the 50).              ║
 * ║     A Gold-Breakout entry (score 9-10) keeps the live volume-confirm and is  ║
 * ║     EXEMPT from the shallow-EMA gate (a breakout is above all MAs), but the  ║
 * ║     portfolio caps concurrent OPEN breakouts at 2.                           ║
 * ║   • EXIT — FAST TIME-STOP. At entryIndex+4 bars, if mfeR has NOT reached     ║
 * ║     +1.0R (and the trade hasn't free-rolled at +2R), EXIT at that bar's      ║
 * ║     close (reason FAST_TIME). The old >10-bar time-stop is REMOVED. If       ║
 * ║     +1R WAS reached, the normal SL / +2R free-roll / Chandelier logic runs.  ║
 * ║   • EXITS OTHERWISE UNCHANGED: structural SL = 10-bar low; +2R free-roll     ║
 * ║     banks 50% → breakeven residual; Chandelier max(priorTrail, highHigh −    ║
 * ║     2.5×ATR14 simple). SL-first on tie preserved.                           ║
 * ║                                                                            ║
 * ║  SHORTS ARE OMITTED — LONG side of the engine only.                         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * RUN (manager runs this on the droplet — has Yahoo/DB data; 214 tickers is slow):
 *   node --import tsx --env-file=.env scripts/elzaV3.ts
 *
 * BUILD-CHECK (local, no run):
 *   npx esbuild scripts/elzaV3.ts --bundle --platform=node --packages=external --outdir=/tmp/v3bc
 *
 * DATA SOURCE: only `fetchBarsForTicker` (server/marketData.ts) → DB cache / Yahoo.
 * Scoring uses the REAL `calcZivEngineScore` + `calcEMA` (server/zivEngine.ts) and the
 * REAL `confirmVolume` (server/volumeConfirm.ts). The Config-C entry, free-roll/trail
 * exit, and portfolio/ClusterGuard sim are COPIED from scripts/zivCatalogOOS.ts; the
 * SPY benchmark is COPIED from scripts/zivDiagnostics.ts. NO P&L or price formula is
 * re-implemented beyond those faithful copies + the documented v3 overlays.
 *
 * ── FIELD-NAME ASSUMPTIONS (so the manager can fix fast if a name is off) ─────
 *   Bar (server/zivEngine.ts):        { date: "YYYY-MM-DD"; open; high; low; close; volume? }
 *   ZivScoreResult fields used: .score, .tier, .donchian20High, .weeklyEma50Slope, .ema50.
 *   calcEMA(closes: number[], period: number): number  → returns the LATEST EMA scalar.
 *   Tier literals: "Gold Retest", "Gold Breakout".
 *   confirmVolume(bars, level, "long").confirmed: boolean.
 *   DEFAULT_60_ASSETS (server/routers/portfolio.ts): { ticker; companyName; sector; sortOrder }[].
 */

import "dotenv/config";
import { fetchBarsForTicker } from "../server/marketData";
import { calcZivEngineScore, calcEMA, type Bar, type ZivScoreResult } from "../server/zivEngine";
import { confirmVolume } from "../server/volumeConfirm";
import { DEFAULT_60_ASSETS } from "../server/routers/portfolio";

// ─── Universe (the ~214-stock live catalogue) ────────────────────────────────
const TICKERS: string[] = DEFAULT_60_ASSETS.map(a => a.ticker);

// ─── Sector map (ticker → sector) for the per-sector ClusterGuard cap ─────────
const SECTOR_BY_TICKER: Record<string, string> = {};
for (const a of DEFAULT_60_ASSETS) SECTOR_BY_TICKER[a.ticker] = a.sector ?? "OTHER";
function sectorOf(ticker: string): string {
  return SECTOR_BY_TICKER[ticker] ?? "OTHER";
}

// ─── Engine / trade-model parameters (mirror zivCatalogOOS.ts Config C) ───────
const BARS_DAYS = 420;               // fetchBarsForTicker(ticker, 420) — ~back to 2024-10
const MIN_BARS = 50;                 // zivEngine needs >= 50 bars; skip a bar if fewer
const ENTRY_MIN_SCORE = 7.5;         // gate score threshold for gold entries

const SL_LOOKBACK = 10;              // structural SL = min(low) over last 10 bars (i-9..i)
const RC2_MAX_RISK_PCT = 12;         // RC-2 guard: skip entry if (entry-SL)/entry > 12%
const FIRST_TARGET_R = 2;            // free-roll trigger: bank 50% at +2R
const FREE_ROLL_FRACTION = 0.5;      // partial-close fraction at +2R
const CHANDELIER_ATR_MULT = 2.5;     // chand = peakHigh − 2.5×ATR (live isLong branch)
const ATR_PERIOD = 14;               // computeAtr14 — SIMPLE (non-Wilder) mean True Range

// ─── v3 SHALLOW-MOMENTUM entry overlay parameters ─────────────────────────────
const SHALLOW_BAND_PCT = 0.025;      // entry must be within ±2.5% of EMA10 OR EMA20
const EMA_FAST_PERIOD = 10;          // EMA10 (shallow touch lane)
const EMA_MID_PERIOD = 20;           // EMA20 (shallow touch lane)
// (EMA50 comes from the engine's res.ema50 — same value the engine scored on.)

// ─── v3 FAST TIME-STOP (dead-money cut) parameters ────────────────────────────
const FAST_TIME_BAR = 4;             // at entryIndex+4 bars (4 trading days) …
const FAST_TIME_MIN_R = 1.0;         // … if running mfeR has NOT reached +1.0R → cut at close
// NOTE: the OLD >10-bar pre-free-roll time-stop is REMOVED — the 4-day rule supersedes it.

// ─── v3 BREAKOUT lane cap (limited) ───────────────────────────────────────────
const MAX_CONCURRENT_BREAKOUTS = 2;  // at most 2 OPEN "Gold Breakout" positions at once

// ─── Out-of-sample windows (entryDate filter; both run to last bar / today) ──
const WINDOWS: { label: string; start: string }[] = [
  { label: "WINDOW 2025", start: "2025-01-01" },
  { label: "WINDOW 2026", start: "2026-01-01" },
];
const EARLIEST_WINDOW_START = WINDOWS.reduce(
  (min, w) => (w.start < min ? w.start : min),
  WINDOWS[0].start,
);

// ─── Portfolio sizing parameters (baseline, per the spec) ─────────────────────
const START_EQUITY = 100_000;        // $100k single compounding account
const HEAT_CAP = 0.20;               // Σ open riskDollars / equity ≤ 0.20 → skip new entry
const MAX_POSITION_USD = 85_000;     // cap notional of any single position
const RISK_PCT = 0.01;               // riskDollars = 1% × equityAtEntry

// ─── Baseline portfolio config (single config — no sweep) ─────────────────────
const LEVERAGE = 1.0;                // gross notional of OPEN positions ≤ 1.0 × equity
const MAX_CONCURRENT = 10;           // hard cap on simultaneously-OPEN positions
const MAX_PER_SECTOR = 3;            // hard cap on simultaneously-OPEN positions per sector

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

// v3: FAST_TIME replaces TIME; the rest are the live free-roll/trail reasons.
type ExitReason = "SL" | "FAST_TIME" | "TRAIL" | "TRAIL_OPEN" | "OPEN";

// ── Raw v3 trade. r and stopDistPct feed the portfolio sim; tier drives the
//    breakout-slot cap; the rest is for the trade-log / reporting. ──
interface RawTrade {
  ticker: string;
  entryDate: string;
  exitDate: string;
  tier: string;              // "Gold Retest" | "Gold Breakout" — drives the breakout-slot cap
  isBreakout: boolean;       // tier === "Gold Breakout" (exempt from shallow gate, capped at 2)
  entry: number;
  sl: number;
  exitReason: ExitReason;
  r: number;                 // TOTAL R-multiple = leg1R + leg2R
  stopDistPct: number;       // (entry - sl) / entry → notional = riskDollars / stopDistPct
}

/**
 * CONFIG C base entry decision (current live), LONG only. Copied from
 * zivCatalogOOS.ts wantsEntryConfigC:
 *   (tier === "Gold Retest"   && score >= 7.5 && weeklyEma50Slope > 0)
 *   OR (tier === "Gold Breakout" && score >= 7.5 && weeklyEma50Slope > 0
 *       && confirmVolume(bars, donchian20High, "long").confirmed)
 * The v3 SHALLOW-MOMENTUM gate is applied AFTER this in simulateV3 (see there).
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
 * v3 SHALLOW-MOMENTUM gate for a NON-breakout (Gold Retest) entry. Returns true to
 * ALLOW the entry, false to HARD REJECT it (caller counts rejDeep on false).
 *
 *   ALLOW  iff  entry > EMA50  (above the 50)
 *         AND   entry within ±2.5% of EMA20 OR within ±2.5% of EMA10 (shallow touch).
 *   REJECT iff  entry <= EMA50 (deep pullback / falling knife — touched/below the 50)
 *         OR    entry is more than ±2.5% from BOTH EMA10 and EMA20 (the "mid" zone).
 *
 * Breakouts are EXEMPT — this is only called for non-breakout entries.
 */
function passesShallowGate(entry: number, ema10: number, ema20: number, ema50: number): boolean {
  if (!(entry > ema50)) return false; // touched/below the 50 → deep pullback → REJECT
  const near10 = ema10 > 0 && Math.abs(entry - ema10) / ema10 <= SHALLOW_BAND_PCT;
  const near20 = ema20 > 0 && Math.abs(entry - ema20) / ema20 <= SHALLOW_BAND_PCT;
  return near10 || near20; // shallow touch of the 10 or 20 → ALLOW; else "mid" zone → REJECT
}

/**
 * Simulate the v3 engine over one ticker's bars (REAL free-roll+trail exit with the
 * v3 FAST TIME-STOP). Pushes RawTrades into `out`. For every shallow-gate HARD REJECT
 * we record the reject's BAR DATE into `rejDeepDates` so the per-window rejDeep count
 * (entries that WOULD have fallen in a given window) can be computed exactly.
 *
 * We DECIDE entries on bars whose date >= EARLIEST_WINDOW_START (earlier = warmup only).
 * Window filtering on entryDate happens later, per-window, in the portfolio sim.
 */
function simulateV3(
  ticker: string,
  bars: Bar[],
  out: RawTrade[],
  rejDeepDates: string[],
): void {
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

    const entry = bars[i].close;
    const isBreakout = res.tier === "Gold Breakout";

    // ── v3 SHALLOW-MOMENTUM gate (non-breakouts only; breakouts are EXEMPT). ──
    if (!isBreakout) {
      // EMA10/EMA20 from closes-up-to-entry via the engine's calcEMA; EMA50 = res.ema50
      // (the SAME value the engine scored on — no duplicated EMA-50 formula).
      const closes = windowBars.map(b => b.close);
      const ema10 = calcEMA(closes, EMA_FAST_PERIOD);
      const ema20 = calcEMA(closes, EMA_MID_PERIOD);
      const ema50 = res.ema50;
      if (!passesShallowGate(entry, ema10, ema20, ema50)) {
        rejDeepDates.push(bars[i].date); // deep pullback / falling knife / "mid" zone → HARD REJECT
        continue;
      }
    }

    // ── ENTRY ─────────────────────────────────────────────────────────────────
    const slWindow = bars.slice(i - (SL_LOOKBACK - 1), i + 1);
    const sl = Math.min(...slWindow.map(b => b.low));
    if (!(sl < entry) || !(entry > 0)) continue;

    const riskPct = ((entry - sl) / entry) * 100;
    // RC-2 guard — mirror the live "skip when stop is too wide" rule.
    if (riskPct > RC2_MAX_RISK_PCT) continue;

    const risk = entry - sl;
    const firstTarget = entry + FIRST_TARGET_R * risk;

    // ── EXIT walk-forward — REAL two-stage free-roll + Chandelier trail, with the
    //    v3 FAST TIME-STOP replacing the old >10-bar time-stop. ─────────────────
    let exitDate = bars[bars.length - 1].date;
    let exitReason: ExitReason = "OPEN";
    let exitIndex = bars.length - 1;

    let reachedFirstTarget = false;
    let leg1R = 0;
    let leg2R = 0;

    let currentStop = sl;
    let highestHigh = bars[i].high;
    let trailStop = -Infinity;
    let mfeR = 0; // running max favorable excursion in R (high-water of (bar.high - entry)/risk)

    for (let j = i + 1; j < bars.length; j++) {
      const bar = bars[j];
      const heldBars = j - i;

      // Track running mfeR on every bar (drives the v3 FAST_TIME +1R check).
      const barMfeR = (bar.high - entry) / risk;
      if (barMfeR > mfeR) mfeR = barMfeR;

      if (!reachedFirstTarget) {
        // ── PHASE 1: full size, stop at initial SL, FAST_TIME active. SL-first on tie. ──
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
        // ── v3 FAST TIME-STOP: at entryIndex+4 bars, if mfeR has NOT reached +1.0R
        //    (and we have NOT free-rolled — guaranteed here, this is pre-2R), cut at
        //    that bar's close. SL-first on tie is preserved (SL check above ran first).
        if (heldBars === FAST_TIME_BAR && mfeR < FAST_TIME_MIN_R) {
          exitReason = "FAST_TIME"; exitDate = bar.date; exitIndex = j;
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
      isBreakout,
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

// ─── Portfolio equity-curve simulator (adapted from zivCatalogOOS.ts) ─────────
// Chronological event stream over a window's trades. An entry opens a position at
// entryDate (sized off realized equity-at-entry); it realizes P&L into equity at
// exitDate. NEW entries are subject to caps that can REJECT or TRIM (each counted):
//   • concurrency        ≤ MAX_CONCURRENT          (reject — drop trade)
//   • per-sector         ≤ MAX_PER_SECTOR          (reject — drop trade)
//   • breakout-slot cap  ≤ MAX_CONCURRENT_BREAKOUTS (reject a NEW breakout if 2 open)
//   • gross leverage     ≤ LEVERAGE × equity        (trim notional to headroom)
//   • portfolio heat     ≤ HEAT_CAP                 (skip)
//   • maxPositionUsd                                (trim)

interface EventRec {
  date: string;
  kind: "ENTRY" | "EXIT";
  tradeIndex: number;
}
interface OpenPos {
  tradeIndex: number;
  ticker: string;
  sector: string;
  isBreakout: boolean;   // for the breakout-slot cap
  notional: number;
  riskDollars: number;
  pnl: number;
  exitDate: string;
}
interface ClosedTrade {
  ticker: string;
  entryDate: string;
  exitDate: string;
  exitReason: ExitReason;
  r: number;
  pnl: number;
  skipped: boolean;
}
interface PortfolioResult {
  window: string;
  tradesTaken: number;
  tickersTraded: number;
  wins: number;
  winPct: number;
  totalR: number;
  finalEquity: number;
  finalReturnPct: number;
  maxDrawdownPct: number;
  rejectedConcurrency: number;  // ClusterGuard: too many open positions (incl. sector + breakout)
  rejectedSector: number;
  rejectedBreakout: number;     // NEW breakout rejected because 2 breakouts already open
  fastTimeExits: number;
  leverageCapHits: number;
  heatSkips: number;
  maxPosCapHits: number;
  exitBreakdown: Record<string, number>;
  curve: Array<{ date: string; equity: number }>;
}

/**
 * Run the portfolio sim for ONE window. Realized-equity convention: equity updates
 * only on EXIT; sizing for a NEW entry uses realized equity AT THAT MOMENT.
 *
 * Reject order: concurrency → sector → breakout-slot (the v3 cap on concurrent
 * "Gold Breakout" positions). These run BEFORE the leverage/heat/maxPosition sizing
 * caps (which only trim/skip on $ headroom).
 */
function runPortfolio(windowTrades: RawTrade[], windowLabel: string): PortfolioResult {
  const events: EventRec[] = [];
  windowTrades.forEach((t, idx) => {
    events.push({ date: t.entryDate, kind: "ENTRY", tradeIndex: idx });
    events.push({ date: t.exitDate, kind: "EXIT", tradeIndex: idx });
  });
  // Ties: EXITs before ENTRYs on the same date (free capital/slots before sizing a
  // same-day open). Stable within kind by entry order.
  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "EXIT" ? -1 : 1;
    return a.tradeIndex - b.tradeIndex;
  });

  let equity = START_EQUITY;
  let peakEquity = START_EQUITY;
  let maxDrawdownPct = 0;

  let rejectedConcurrency = 0;
  let rejectedSector = 0;
  let rejectedBreakout = 0;
  let leverageCapHits = 0;
  let heatSkips = 0;
  let maxPosCapHits = 0;

  const openByTradeIndex = new Map<number, OpenPos>();
  const closed: ClosedTrade[] = [];
  const tickersTraded = new Set<string>();
  let breakoutSlotsInUse = 0; // live count of OPEN "Gold Breakout" positions

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
  const openCountInSector = (sec: string): number => {
    let n = 0;
    for (const p of openByTradeIndex.values()) if (p.sector === sec) n++;
    return n;
  };

  for (const ev of events) {
    const t = windowTrades[ev.tradeIndex];

    if (ev.kind === "ENTRY") {
      // ── Concurrency cap (drop the trade entirely BEFORE sizing). ──
      if (openByTradeIndex.size >= MAX_CONCURRENT) {
        rejectedConcurrency++;
        continue;
      }
      const sec = sectorOf(t.ticker);
      if (openCountInSector(sec) >= MAX_PER_SECTOR) {
        rejectedSector++;
        continue;
      }
      // ── v3 BREAKOUT-slot cap: a NEW breakout is rejected if 2 are already open. ──
      if (t.isBreakout && breakoutSlotsInUse >= MAX_CONCURRENT_BREAKOUTS) {
        rejectedBreakout++;
        continue;
      }

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
        continue;
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
        sector: sec,
        isBreakout: t.isBreakout,
        notional,
        riskDollars,
        pnl,
        exitDate: t.exitDate,
      });
      if (t.isBreakout) breakoutSlotsInUse++;
    } else {
      const pos = openByTradeIndex.get(ev.tradeIndex);
      if (!pos) continue; // rejected / heat-skipped (never opened) — nothing to realize
      openByTradeIndex.delete(ev.tradeIndex);
      if (pos.isBreakout && breakoutSlotsInUse > 0) breakoutSlotsInUse--;

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
  const fastTimeExits = exitBreakdown["FAST_TIME"] ?? 0;

  return {
    window: windowLabel,
    tradesTaken: taken.length,
    tickersTraded: tickersTraded.size,
    wins,
    winPct: taken.length > 0 ? (wins / taken.length) * 100 : 0,
    totalR: Math.round(totalR * 100) / 100,
    finalEquity: Math.round(equity),
    finalReturnPct: ((equity - START_EQUITY) / START_EQUITY) * 100,
    maxDrawdownPct: maxDrawdownPct * 100,
    rejectedConcurrency,
    rejectedSector,
    rejectedBreakout,
    fastTimeExits,
    leverageCapHits,
    heatSkips,
    maxPosCapHits,
    exitBreakdown,
    curve: sixPointCurve(curve),
  };
}

/** Reduce the equity curve to a 6-point sketch: START, TROUGH, END + 3 interior. */
function sixPointCurve(
  curve: Array<{ date: string; equity: number }>,
): Array<{ date: string; equity: number }> {
  if (curve.length <= 6) return curve;
  const start = curve[0];
  const end = curve[curve.length - 1];
  let trough = curve[0];
  for (const p of curve) if (p.equity < trough.equity) trough = p;
  const picks = new Map<string, { date: string; equity: number }>();
  const put = (p: { date: string; equity: number }) => picks.set(p.date, p);
  put(start);
  put(trough);
  put(end);
  for (let k = 1; k <= 3; k++) {
    const idx = Math.round((curve.length - 1) * (k / 4));
    put(curve[idx]);
  }
  return [...picks.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ─── SPY benchmark (copied from zivDiagnostics.ts computeSpyBenchmark) ─────────
interface SpyResult {
  windowLabel: string;
  returnPct: number;
  maxDDPct: number;
  curve: Array<{ date: string; equity: number }>;
}
function computeSpyBenchmark(windowLabel: string, spyBars: Bar[], windowStart: string): SpyResult | null {
  const inWin = spyBars.filter(b => b.date >= windowStart).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (inWin.length < 2) return null;
  const base = inWin[0].close;
  let peak = START_EQUITY;
  let maxDD = 0;
  const curve = inWin.map(b => {
    const eq = START_EQUITY * (b.close / base);
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    if (dd > maxDD) maxDD = dd;
    return { date: b.date, equity: Math.round(eq) };
  });
  const last = curve[curve.length - 1];
  return {
    windowLabel,
    returnPct: ((last.equity - START_EQUITY) / START_EQUITY) * 100,
    maxDDPct: maxDD * 100,
    curve,
  };
}

// ─── Reporting helpers ────────────────────────────────────────────────────────
function pad(s: string | number, w: number): string {
  const str = String(s);
  return str.length >= w ? str : str + " ".repeat(w - str.length);
}
function padL(s: string | number, w: number): string {
  const str = String(s);
  return str.length >= w ? str : " ".repeat(w - str.length) + str;
}
function sign(n: number): string { return n >= 0 ? "+" : ""; }

/**
 * Print ONE window: v3 stats block, the v3-vs-SPY side-by-side, the explicit verdict
 * line, and the exit-reason breakdown.
 */
function printWindow(r: PortfolioResult, rejDeep: number, spy: SpyResult | null): void {
  console.log("");
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  console.log(`═══ ${r.window} — Elza v3 SHALLOW-MOMENTUM (LONG side only, SHORTS OMITTED) ═══`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);

  // ── v3 stats block. ──
  console.log(`  trades-taken      : ${r.tradesTaken}`);
  console.log(`  rejDeep           : ${rejDeep}`);
  console.log(`  rejConcurrency    : ${r.rejectedConcurrency}`);
  console.log(`  rejSector         : ${r.rejectedSector}`);
  console.log(`  rejBreakout(cap2) : ${r.rejectedBreakout}`);
  console.log(`  FAST_TIME exits   : ${r.fastTimeExits}`);
  console.log(`  win%              : ${r.winPct.toFixed(1)}%`);
  console.log(`  totalR            : ${sign(r.totalR)}${r.totalR.toFixed(2)}R`);
  console.log(`  return%           : ${sign(r.finalReturnPct)}${r.finalReturnPct.toFixed(2)}%`);
  console.log(`  maxDD%            : ${r.maxDrawdownPct.toFixed(2)}%`);
  console.log(`  finalEq$          : $${r.finalEquity.toLocaleString()}`);

  // ── Exit-reason breakdown (SL / FAST_TIME / TRAIL / TRAIL_OPEN(=free-roll open) / OPEN). ──
  const eb = r.exitBreakdown;
  console.log("");
  console.log(`  ── exit-reason breakdown ──`);
  console.log(`     SL=${eb["SL"] ?? 0}  FAST_TIME=${eb["FAST_TIME"] ?? 0}  TRAIL=${eb["TRAIL"] ?? 0}  ` +
    `FREE_ROLL(TRAIL_OPEN)=${eb["TRAIL_OPEN"] ?? 0}  OPEN=${eb["OPEN"] ?? 0}`);

  // ── 6-point equity-curve sketch. ──
  console.log("");
  console.log(`  ── 6-point equity curve (start … trough … end) ──`);
  console.log(`     ${r.curve.map(p => `(${p.date}, $${p.equity.toLocaleString()})`).join("  →  ")}`);

  // ── v3 vs SPY side-by-side + explicit verdict line. ──
  console.log("");
  console.log(`  ── v3 vs SPY buy&hold $100k ──`);
  if (!spy) {
    console.log(`     [SKIP] No SPY bars in window — fetchBarsForTicker("SPY",420) returned too little.`);
    console.log(`     VERDICT: INDETERMINATE (no SPY data).`);
    return;
  }
  console.log(`     ${pad("metric", 10)}${padL("v3", 14)}${padL("SPY b&h", 14)}`);
  console.log(`     ${"─".repeat(38)}`);
  console.log(`     ${pad("return%", 10)}${padL(sign(r.finalReturnPct) + r.finalReturnPct.toFixed(2) + "%", 14)}${padL(sign(spy.returnPct) + spy.returnPct.toFixed(2) + "%", 14)}`);
  console.log(`     ${pad("maxDD%", 10)}${padL(r.maxDrawdownPct.toFixed(2) + "%", 14)}${padL(spy.maxDDPct.toFixed(2) + "%", 14)}`);

  // Explicit verdict: "v3 BEATS / LOSES TO SPY by X pts; negative-alpha YES/NO."
  const diffPts = r.finalReturnPct - spy.returnPct;
  const beats = diffPts >= 0;
  // Negative-alpha = SPY was up AND v3 underperformed SPY (the classic neg-alpha case).
  const negAlpha = spy.returnPct > 0 && r.finalReturnPct < spy.returnPct;
  console.log("");
  console.log(
    `  VERDICT ${r.window}: v3 ${beats ? "BEATS" : "LOSES TO"} SPY by ${Math.abs(diffPts).toFixed(2)} pts ` +
    `(v3 ${sign(r.finalReturnPct)}${r.finalReturnPct.toFixed(2)}% vs SPY ${sign(spy.returnPct)}${spy.returnPct.toFixed(2)}%); ` +
    `negative-alpha ${negAlpha ? "YES" : "NO"}.`,
  );

  // Machine-readable line for downstream parsing.
  console.log(`[JSON] ${JSON.stringify({
    window: r.window,
    tradesTaken: r.tradesTaken,
    rejDeep,
    rejConcurrency: r.rejectedConcurrency,
    rejSector: r.rejectedSector,
    rejBreakout: r.rejectedBreakout,
    fastTimeExits: r.fastTimeExits,
    winPct: Math.round(r.winPct * 10) / 10,
    totalR: r.totalR,
    finalReturnPct: Math.round(r.finalReturnPct * 100) / 100,
    maxDrawdownPct: Math.round(r.maxDrawdownPct * 100) / 100,
    finalEquity: r.finalEquity,
    spyReturnPct: Math.round(spy.returnPct * 100) / 100,
    spyMaxDDPct: Math.round(spy.maxDDPct * 100) / 100,
    v3MinusSpyPts: Math.round(diffPts * 100) / 100,
    beatsSpy: beats,
    negativeAlpha: negAlpha,
    exitBreakdown: r.exitBreakdown,
  })}`);
}

function printDisclaimer(): void {
  console.log("");
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`SIMPLIFICATIONS / DISCLAIMER — read before trusting any number above`);
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`  • SHORTS OMITTED: this models the LONG side only. The live regime/breadth`);
  console.log(`    short-gate is not reproduced offline.`);
  console.log(`  • DAILY-BAR TRAIL/MFE OVERSTATES: the Chandelier trail AND the v3 FAST_TIME`);
  console.log(`    +1R mfe-check are evaluated on DAILY highs/lows. A daily high "reaches"`);
  console.log(`    +1R that an intraday tick stop might never have let the position keep —`);
  console.log(`    so mfeR (hence FAST_TIME survival) and trail runs are both OVERSTATED.`);
  console.log(`  • NO FRICTION: zero slippage, zero commissions, perfect fills at signal`);
  console.log(`    close and at the exact stop/trail level. Live is worse on all three.`);
  console.log(`  • THIN 2025 WARMUP: with fetchBarsForTicker(..,420) reaching ~2024-10, the`);
  console.log(`    2025 window opens on only ~50 bars of late-2024 warmup — treat early-2025`);
  console.log(`    entries with caution.`);
  console.log(`  • CAPS MODEL HEADROOM ONLY: leverage/heat/maxPosition caps trim or skip new`);
  console.log(`    size but do NOT model margin calls, overnight gap risk, or forced`);
  console.log(`    liquidation. Max-DD is on REALIZED equity — a FLOOR, not a ceiling.`);
}

// ─── Window-trade filter (shared) ─────────────────────────────────────────────
function tradesForWindow(allTrades: RawTrade[], start: string): RawTrade[] {
  return allTrades
    .filter(t => t.entryDate >= start)
    .sort((a, b) => {
      if (a.entryDate !== b.entryDate) return a.entryDate < b.entryDate ? -1 : 1;
      if (a.exitDate !== b.exitDate) return a.exitDate < b.exitDate ? -1 : 1;
      return a.ticker < b.ticker ? -1 : 1;
    });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`Elza v3 SHALLOW-MOMENTUM Backtest — READ-ONLY (no DB writes, no IBKR, no orders, no SSH)`);
  console.log(`Engine: REAL calcZivEngineScore, LONG-ONLY. Universe: ${TICKERS.length} tickers (DEFAULT_60_ASSETS).`);
  console.log(`Base entry: (Gold Retest OR vol-confirmed Gold Breakout) & score >= ${ENTRY_MIN_SCORE} & weeklySlope > 0 & RC-2 (entry-SL)/entry <= ${RC2_MAX_RISK_PCT}%.`);
  console.log(`v3 SHALLOW gate (Retest only; breakouts EXEMPT): entry > EMA50 AND within ±${(SHALLOW_BAND_PCT * 100).toFixed(1)}% of EMA${EMA_FAST_PERIOD} OR EMA${EMA_MID_PERIOD}.`);
  console.log(`v3 HARD REJECT (rejDeep): entry <= EMA50 (deep/falling-knife) OR > ±${(SHALLOW_BAND_PCT * 100).toFixed(1)}% from BOTH EMA${EMA_FAST_PERIOD} & EMA${EMA_MID_PERIOD} (mid zone).`);
  console.log(`v3 FAST TIME-STOP: at entry+${FAST_TIME_BAR} bars, if mfeR < +${FAST_TIME_MIN_R.toFixed(1)}R (and not free-rolled) → exit at close (FAST_TIME). Old >10-bar time-stop REMOVED.`);
  console.log(`Exit otherwise: SL = ${SL_LOOKBACK}-bar low; +2R free-roll banks 50% → BE; Chandelier max(prior, highHigh − ${CHANDELIER_ATR_MULT}×ATR${ATR_PERIOD} simple). SL-first on tie.`);
  console.log(`Breakout lane: vol-confirmed, EXEMPT from shallow gate, capped at ${MAX_CONCURRENT_BREAKOUTS} concurrent OPEN breakouts.`);
  console.log(`Portfolio (baseline): $${START_EQUITY.toLocaleString()} compounding, ${RISK_PCT * 100}% risk/trade, leverage ${LEVERAGE}×, maxConcurrent ${MAX_CONCURRENT}, maxPerSector ${MAX_PER_SECTOR}, heat ≤ ${HEAT_CAP * 100}%, maxPos $${MAX_POSITION_USD.toLocaleString()}.`);
  console.log(`Windows: ${WINDOWS.map(w => `${w.label} (entryDate >= ${w.start})`).join("  |  ")}.`);
  console.log(`SHORTS ARE OMITTED — long side of the engine only.`);

  // P3: fetch SPY once (420 bars) — used by both windows.
  let spyBars: Bar[] = [];
  try {
    spyBars = await fetchBarsForTicker("SPY", 420);
    spyBars = [...spyBars].sort((a, b) => (a.date < b.date ? -1 : 1));
    console.log(`[SPY] fetched ${spyBars.length} bars for benchmark.`);
  } catch (e) {
    console.log(`[WARN] SPY fetch failed: ${(e as Error).message ?? e}. SPY benchmark will be skipped.`);
  }

  // 1) Build the FULL v3 trade list ONCE across all tickers (one fetch per ticker).
  //    rejDeep (shallow-gate rejects) is a GLOBAL trade-gen count across all bars; we
  //    also bucket it per-window below for the per-window report.
  const allTrades: RawTrade[] = [];
  const rejDeepDates: string[] = []; // bar-date of every shallow-gate HARD REJECT (for per-window rejDeep)
  let processed = 0;
  let skippedNoData = 0;

  for (const ticker of TICKERS) {
    processed++;
    if (processed % 20 === 0) {
      console.log(`[PROGRESS] ${processed}/${TICKERS.length} tickers processed, ${allTrades.length} trades so far.`);
    }
    try {
      let bars = await fetchBarsForTicker(ticker, BARS_DAYS);
      if (!bars || bars.length < MIN_BARS) { skippedNoData++; continue; }
      bars = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

      const lastDate = bars[bars.length - 1].date;
      if (lastDate < EARLIEST_WINDOW_START) { skippedNoData++; continue; }
      const warmupBefore = bars.filter(b => b.date < EARLIEST_WINDOW_START).length;
      if (warmupBefore < MIN_BARS) { skippedNoData++; continue; }

      simulateV3(ticker, bars, allTrades, rejDeepDates);
    } catch (e) {
      console.log(`[WARN] ${ticker}: ${(e as Error).message ?? e}. Skipping ticker.`);
      continue;
    }
  }

  console.log("");
  console.log(`[DONE BUILDING] ${allTrades.length} v3 LONG entries across ${TICKERS.length - skippedNoData} usable tickers (${skippedNoData} skipped). rejDeep (shallow-gate hard rejects, all bars >= ${EARLIEST_WINDOW_START}): ${rejDeepDates.length}.`);

  // 2) Per window: filter trades, run the portfolio sim, print the report + SPY verdict.
  //    rejDeep per window = shallow-gate hard rejects whose reject bar-date falls in the
  //    window (same filter convention as the taken-trade entryDate >= window.start).
  for (const w of WINDOWS) {
    const windowTrades = tradesForWindow(allTrades, w.start);
    const r = runPortfolio(windowTrades, w.label);
    const rejDeepThisWindow = rejDeepDates.filter(d => d >= w.start).length;
    const spy = computeSpyBenchmark(w.label, spyBars, w.start);
    printWindow(r, rejDeepThisWindow, spy);
  }

  printDisclaimer();

  console.log("");
  console.log(`Done. ${allTrades.length} v3 LONG trades; ${WINDOWS.length} windows sized. (Simulation only — no live actions taken.)`);
}

main().catch(err => {
  console.error(`[FATAL] ${(err as Error).stack ?? err}`);
  process.exit(1);
});
