/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  elzaV3Decomp.ts — GAP-DECOMPOSITION harness.                              ║
 * ║                                                                            ║
 * ║  PURE SIMULATION. NO DB writes. NO IBKR. NO orders. NO deploy. NO SSH.     ║
 * ║                                                                            ║
 * ║  WHY: a loose "Harness" backtest printed +21.6% while my strict elzaV3     ║
 * ║  printed −22.1% — a 44-point gap. This script isolates how much of that    ║
 * ║  gap is {WINDOW} vs {LOGIC} vs {FRICTION} by running a 2×2×(window) matrix  ║
 * ║  on ONE identical bar set, then computing each lever in isolation.         ║
 * ║                                                                            ║
 * ║  AXES:                                                                      ║
 * ║   • WINDOW  — W-CAL2025 (entryDate in [2025-01-01, 2025-12-31], BOTH ends  ║
 * ║               filtered) vs W-18MO (entryDate >= 2025-01-01, no end).        ║
 * ║   • LOGIC   — STRICT (my elzaV3 ruleset) vs LOOSE (Cursor's Harness per     ║
 * ║               the audit). Both ride the SAME bars, SAME exit machinery,     ║
 * ║               SAME entry=close, SAME maxConcurrent 10.                       ║
 * ║   • FRICTION— FRICTIONLESS (entry=close, exits at exact level) vs REALISTIC ║
 * ║               (5bps adverse on entry AND every exit fill + flat $1/side     ║
 * ║               commission on the implied share count). R is recomputed.      ║
 * ║                                                                            ║
 * ║  STRICT base = (Gold Retest OR vol-confirmed Gold Breakout) & score>=7.5 &  ║
 * ║   weeklySlope>0 & RC-2 (entry-SL)/entry<=12%; shallow gate = entry>EMA50    ║
 * ║   AND within ±2.5% of EMA10/EMA20 (breakouts exempt); fast-kill at          ║
 * ║   heldBars===4 if mfeR<1R; maxConcurrent 10, maxPerSector 3.                ║
 * ║  LOOSE base = score>=7.5 ONLY (NO tier requirement); shallow = within ±1.5% ║
 * ║   of EMA10/EMA20; EMA50-reject = only if a LOW touched EMA50 in last 5 bars ║
 * ║   (NOT entry<=EMA50); fast-kill at heldBars>=4; NO sector cap (999);        ║
 * ║   maxConcurrent 10, same free-roll+chandelier exit, same entry=close.       ║
 * ║                                                                            ║
 * ║  SHORTS ARE OMITTED — LONG side of the engine only.                         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * RUN (manager runs this on the droplet — has Yahoo/DB data; 214 tickers is slow):
 *   node --import tsx --env-file=.env scripts/elzaV3Decomp.ts
 *
 * BUILD-CHECK (local, no run):
 *   npx esbuild scripts/elzaV3Decomp.ts --bundle --platform=node --packages=external --outdir=/tmp/decbc
 *
 * DATA SOURCE: only `fetchBarsForTicker` (server/marketData.ts). Scoring uses the REAL
 * `calcZivEngineScore` + `calcEMA` (server/zivEngine.ts) and REAL `confirmVolume`
 * (server/volumeConfirm.ts). The exit machinery, free-roll/trail logic, portfolio sim
 * and SPY benchmark are FAITHFUL ADAPTATIONS of scripts/elzaV3.ts — no P&L/price
 * formula is re-implemented beyond those copies + the documented LOOSE-mode overlays.
 */

import "dotenv/config";
import { fetchBarsForTicker } from "../server/marketData";
import { calcZivEngineScore, calcEMA, type Bar, type ZivScoreResult } from "../server/zivEngine";
import { confirmVolume } from "../server/volumeConfirm";
import { DEFAULT_60_ASSETS } from "../server/routers/portfolio";

// ─── Universe (the ~214-stock live catalogue) ────────────────────────────────
const TICKERS: string[] = DEFAULT_60_ASSETS.map(a => a.ticker);

// ─── Sector map (ticker → sector) for the per-sector cap (STRICT only) ────────
const SECTOR_BY_TICKER: Record<string, string> = {};
for (const a of DEFAULT_60_ASSETS) SECTOR_BY_TICKER[a.ticker] = a.sector ?? "OTHER";
function sectorOf(ticker: string): string {
  return SECTOR_BY_TICKER[ticker] ?? "OTHER";
}

// ─── Shared engine / trade-model parameters (mirror elzaV3.ts) ────────────────
const BARS_DAYS = 420;
const MIN_BARS = 50;
const ENTRY_MIN_SCORE = 7.5;

const SL_LOOKBACK = 10;
const RC2_MAX_RISK_PCT = 12;
const FIRST_TARGET_R = 2;
const FREE_ROLL_FRACTION = 0.5;
const CHANDELIER_ATR_MULT = 2.5;
const ATR_PERIOD = 14;

const EMA_FAST_PERIOD = 10;
const EMA_MID_PERIOD = 20;

const FAST_TIME_BAR = 4;             // fast-kill bar (STRICT: ===4; LOOSE: >=4)
const FAST_TIME_MIN_R = 1.0;
const MAX_CONCURRENT_BREAKOUTS = 2;  // STRICT breakout-slot cap (LOOSE has no breakout tier → no cap)

// ─── Friction model ───────────────────────────────────────────────────────────
const SLIPPAGE_BPS = 0.0005;         // 5 bps adverse on entry AND every exit fill
const COMMISSION_PER_SIDE = 1.0;     // flat $1/side on the implied share count

// ─── Portfolio sizing (baseline, identical for all 8 cells) ───────────────────
const START_EQUITY = 100_000;
const HEAT_CAP = 0.20;
const MAX_POSITION_USD = 85_000;
const RISK_PCT = 0.01;
const LEVERAGE = 1.0;
const MAX_CONCURRENT = 10;

// ─── LOGIC-MODE config (STRICT vs LOOSE) ──────────────────────────────────────
interface LogicMode {
  label: "STRICT" | "LOOSE";
  requireTier: boolean;        // STRICT: base needs Gold Retest/Breakout tier. LOOSE: score>=7.5 only.
  requireWeeklySlope: boolean; // both require weeklySlope>0 (audit didn't relax it) — kept true both.
  shallowBandPct: number;      // STRICT 0.025, LOOSE 0.015
  ema50RejectMode: "entry" | "lowTouch5"; // STRICT: entry<=EMA50. LOOSE: a LOW touched EMA50 in last 5 bars.
  fastKillExact: boolean;      // STRICT: heldBars===4. LOOSE: heldBars>=4 (first qualifying bar).
  maxPerSector: number;        // STRICT 3, LOOSE 999 (no cap)
  capBreakouts: boolean;       // STRICT caps concurrent breakouts at 2; LOOSE has no breakout tier concept.
}
const STRICT: LogicMode = {
  label: "STRICT",
  requireTier: true,
  requireWeeklySlope: true,
  shallowBandPct: 0.025,
  ema50RejectMode: "entry",
  fastKillExact: true,
  maxPerSector: 3,
  capBreakouts: true,
};
const LOOSE: LogicMode = {
  label: "LOOSE",
  requireTier: false,
  requireWeeklySlope: true,
  shallowBandPct: 0.015,
  ema50RejectMode: "lowTouch5",
  fastKillExact: false,
  maxPerSector: 999,
  capBreakouts: false,
};

// ─── Windows (THE KEY FIX: explicit endDate; CAL2025 filters BOTH ends) ───────
interface WindowDef { label: string; start: string; end: string | null; }
const WINDOWS: WindowDef[] = [
  { label: "W-CAL2025", start: "2025-01-01", end: "2025-12-31" },
  { label: "W-18MO",    start: "2025-01-01", end: null },
];
const EARLIEST_WINDOW_START = WINDOWS.reduce(
  (min, w) => (w.start < min ? w.start : min),
  WINDOWS[0].start,
);

const LOGIC_MODES: LogicMode[] = [STRICT, LOOSE];
const FRICTION_MODES: Array<"FRICTIONLESS" | "REALISTIC"> = ["FRICTIONLESS", "REALISTIC"];

/** SIMPLE 14-period ATR — byte-for-byte elzaV3.ts computeAtr14Local. */
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

type ExitReason = "SL" | "FAST_TIME" | "TRAIL" | "TRAIL_OPEN" | "OPEN";

/**
 * Raw trade — now records the PRICE-LEVEL fills per leg so friction can be applied
 * post-hoc without re-walking the bars:
 *   • entry          : signal close (frictionless entry).
 *   • sl             : initial structural stop (10-bar low).
 *   • leg1ExitPrice  : full-position SL/FAST_TIME/OPEN exit level (when no free-roll
 *                      happened) OR the +2R first-target level (when it did). For a
 *                      free-roll the banked 50% is realized AT the +2R level.
 *   • leg1FreeRolled : true if +2R was tagged (then leg1 = banked 50% at firstTarget,
 *                      leg2 = residual 50% at leg2ExitPrice).
 *   • leg2ExitPrice  : residual 50% trail/open exit level (only when leg1FreeRolled).
 * R is derived from these levels in `computeTradeR` for each friction mode.
 */
interface RawTrade {
  ticker: string;
  entryDate: string;
  exitDate: string;
  tier: string;
  isBreakout: boolean;
  entry: number;
  sl: number;
  exitReason: ExitReason;
  leg1FreeRolled: boolean;
  firstTarget: number;     // +2R level (leg1 bank price when free-rolled)
  leg1ExitPrice: number;   // full-position exit level when NOT free-rolled
  leg2ExitPrice: number;   // residual exit level when free-rolled
  stopDistPct: number;     // (entry - sl) / entry  → notional = riskDollars / stopDistPct (frictionless)
}

/**
 * Compute the trade's total R-multiple under a friction mode, plus a notional-relative
 * commission drag expressed in R.
 *
 * FRICTIONLESS: leg fills at their exact levels (today's behavior).
 * REALISTIC: every fill is moved adversely by SLIPPAGE_BPS — for a LONG:
 *     entry fills HIGHER (close × (1+bps)); every exit fills LOWER (level × (1−bps)).
 *   The widened entry also widens the per-share risk basis, so we recompute risk on the
 *   SLIPPED entry. Commission is 2 sides (entry + each realized exit leg) × $1, converted
 *   to R via the implied share count: shares = notionalForSizing / entryFill, riskDollars
 *   = RISK_PCT-independent here so we express commission as a fraction of riskDollars using
 *   the position's stop distance (commission$ / (risk$/share × shares) = commission$/risk$).
 *   We return R already NET of that commission drag (sizing-independent: commission scales
 *   with shares, risk$ scales with shares, so commission-in-R is sizing-invariant given the
 *   $1/side flat and the implied share count — see derivation below).
 *
 * Derivation of commission-in-R (sizing-invariant):
 *   riskPerShare = entryFill − sl   (long, slipped entry)
 *   For N shares: risk$ = N × riskPerShare ; commission$ = sides × $1
 *   commissionR = commission$ / risk$ = (sides) / (N × riskPerShare)
 *   N depends on sizing → commissionR is NOT strictly sizing-invariant. We therefore
 *   approximate N at the BASELINE 1%-risk full size (no caps): N0 = (RISK_PCT×START_EQUITY)
 *   / riskPerShare. This is a faithful "approximate; fold commission into bps if cleaner"
 *   per the spec — a deliberate, documented approximation, NOT a hidden one.
 */
function computeTradeR(
  t: RawTrade,
  friction: "FRICTIONLESS" | "REALISTIC",
): number {
  if (friction === "FRICTIONLESS") {
    const risk = t.entry - t.sl;
    if (!(risk > 0)) return 0;
    if (t.leg1FreeRolled) {
      const leg1R = FREE_ROLL_FRACTION * ((t.firstTarget - t.entry) / risk);
      const leg2R = FREE_ROLL_FRACTION * ((t.leg2ExitPrice - t.entry) / risk);
      return Math.round((leg1R + leg2R) * 100) / 100;
    }
    const fullR = (t.leg1ExitPrice - t.entry) / risk;
    return Math.round(fullR * 100) / 100;
  }

  // ── REALISTIC ──
  const entryFill = t.entry * (1 + SLIPPAGE_BPS);     // adverse (higher) entry for a long
  const risk = entryFill - t.sl;                       // risk basis widens with slipped entry
  if (!(risk > 0)) return 0;

  // Commission-in-R at baseline full size (documented approximation).
  const riskPerShare = entryFill - t.sl;
  const sharesFull = (RISK_PCT * START_EQUITY) / riskPerShare; // N0
  const commissionR_perSide = sharesFull > 0 ? COMMISSION_PER_SIDE / (sharesFull * riskPerShare) : 0;

  if (t.leg1FreeRolled) {
    const leg1Fill = t.firstTarget * (1 - SLIPPAGE_BPS); // banked 50% fills LOWER
    const leg2Fill = t.leg2ExitPrice * (1 - SLIPPAGE_BPS);
    const leg1R = FREE_ROLL_FRACTION * ((leg1Fill - entryFill) / risk);
    const leg2R = FREE_ROLL_FRACTION * ((leg2Fill - entryFill) / risk);
    // sides: entry (1) + two exit legs (2) = 3 commission sides.
    const commissionR = 3 * commissionR_perSide;
    return Math.round((leg1R + leg2R - commissionR) * 100) / 100;
  }
  const exitFill = t.leg1ExitPrice * (1 - SLIPPAGE_BPS);
  const fullR = (exitFill - entryFill) / risk;
  // sides: entry (1) + one exit (1) = 2 commission sides.
  const commissionR = 2 * commissionR_perSide;
  return Math.round((fullR - commissionR) * 100) / 100;
}

/**
 * BASE entry decision, LONG only, parameterized by logic mode.
 *   STRICT (requireTier): (Gold Retest) OR (vol-confirmed Gold Breakout), each with
 *     score>=7.5 & weeklySlope>0.
 *   LOOSE  (!requireTier): score>=7.5 only (NO tier requirement), weeklySlope>0 kept.
 *     A LOOSE entry is "breakout-like" only if the engine actually tagged Gold Breakout
 *     AND it vol-confirms — purely informational (LOOSE applies no breakout cap).
 * Returns { ok, isBreakout }.
 */
function wantsEntryBase(
  res: ZivScoreResult,
  windowBars: Bar[],
  mode: LogicMode,
): { ok: boolean; isBreakout: boolean } {
  const scoreOk = res.score >= ENTRY_MIN_SCORE;
  const weeklyOk = mode.requireWeeklySlope ? res.weeklyEma50Slope > 0 : true;
  if (!scoreOk || !weeklyOk) return { ok: false, isBreakout: false };

  if (mode.requireTier) {
    // STRICT: tier-gated, same as elzaV3 wantsEntryConfigC.
    if (res.tier === "Gold Retest") return { ok: true, isBreakout: false };
    if (res.tier === "Gold Breakout") {
      const vc = confirmVolume(windowBars, res.donchian20High, "long").confirmed;
      return { ok: vc, isBreakout: vc };
    }
    return { ok: false, isBreakout: false };
  }

  // LOOSE: score>=7.5 only. Mark breakout-like (informational) if the engine tagged it
  // a vol-confirmed breakout — but LOOSE exempts NOTHING via a cap.
  let isBreakout = false;
  if (res.tier === "Gold Breakout") {
    isBreakout = confirmVolume(windowBars, res.donchian20High, "long").confirmed;
  }
  return { ok: true, isBreakout };
}

/**
 * SHALLOW gate (non-breakout entries only; breakouts EXEMPT) parameterized by mode.
 *   ALLOW iff entry passes the EMA50-reject test AND is within band of EMA10 OR EMA20.
 *   EMA50-reject:
 *     STRICT ("entry"):     reject if entry <= EMA50.
 *     LOOSE ("lowTouch5"):  reject ONLY if a LOW touched EMA50 in the last 5 bars
 *                           (a bar low dipped to/through EMA50). entry<=EMA50 alone is OK.
 *   band: STRICT ±2.5%, LOOSE ±1.5% of EMA10/EMA20.
 */
function passesShallowGate(
  entry: number,
  ema10: number,
  ema20: number,
  ema50: number,
  recentBars: Bar[],     // last up-to-5 bars (incl. entry bar) for the LOOSE low-touch test
  mode: LogicMode,
): boolean {
  // ── EMA50-reject ──
  if (mode.ema50RejectMode === "entry") {
    if (!(entry > ema50)) return false;
  } else {
    // LOOSE: reject only if a LOW touched EMA50 in the last 5 bars.
    let lowTouched = false;
    for (const b of recentBars) {
      if (b.low <= ema50) { lowTouched = true; break; }
    }
    if (lowTouched) return false;
  }
  const band = mode.shallowBandPct;
  const near10 = ema10 > 0 && Math.abs(entry - ema10) / ema10 <= band;
  const near20 = ema20 > 0 && Math.abs(entry - ema20) / ema20 <= band;
  return near10 || near20;
}

/**
 * Simulate ONE ticker's bars under ONE logic mode, pushing RawTrades into `out`.
 * Friction is NOT applied here — it is derived later per-cell from the recorded fill
 * LEVELS. The exit machinery (SL / +2R free-roll / Chandelier / FAST_TIME) is the
 * faithful elzaV3 walk; only the fast-kill bar test differs by mode (===4 vs >=4).
 *
 * Decides entries on bars with date >= EARLIEST_WINDOW_START (earlier = warmup only).
 * Window filtering on entryDate happens later, per (window × cell).
 */
function simulateMode(
  ticker: string,
  bars: Bar[],
  out: RawTrade[],
  mode: LogicMode,
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
      continue;
    }
    if (res.tier === "No Data" || res.tier === "Error") continue;

    const base = wantsEntryBase(res, windowBars, mode);
    if (!base.ok) continue;

    const entry = bars[i].close;
    const isBreakout = base.isBreakout;

    // ── SHALLOW gate (non-breakouts only; breakouts EXEMPT). ──
    if (!isBreakout) {
      const closes = windowBars.map(b => b.close);
      const ema10 = calcEMA(closes, EMA_FAST_PERIOD);
      const ema20 = calcEMA(closes, EMA_MID_PERIOD);
      const ema50 = res.ema50;
      const recent = bars.slice(Math.max(0, i - 4), i + 1); // last up-to-5 bars incl. entry
      if (!passesShallowGate(entry, ema10, ema20, ema50, recent, mode)) {
        continue; // HARD REJECT
      }
    }

    // ── ENTRY ─────────────────────────────────────────────────────────────────
    const slWindow = bars.slice(i - (SL_LOOKBACK - 1), i + 1);
    const sl = Math.min(...slWindow.map(b => b.low));
    if (!(sl < entry) || !(entry > 0)) continue;

    const riskPct = ((entry - sl) / entry) * 100;
    if (riskPct > RC2_MAX_RISK_PCT) continue;

    const risk = entry - sl;
    const firstTarget = entry + FIRST_TARGET_R * risk;

    // ── EXIT walk-forward — free-roll + Chandelier, FAST_TIME per mode. ──
    let exitDate = bars[bars.length - 1].date;
    let exitReason: ExitReason = "OPEN";
    let exitIndex = bars.length - 1;

    let reachedFirstTarget = false;
    let leg1FreeRolled = false;
    let leg1ExitPrice = entry;   // full-position exit level when NOT free-rolled
    let leg2ExitPrice = entry;   // residual exit level when free-rolled

    let currentStop = sl;
    let highestHigh = bars[i].high;
    let trailStop = -Infinity;
    let mfeR = 0;

    for (let j = i + 1; j < bars.length; j++) {
      const bar = bars[j];
      const heldBars = j - i;

      const barMfeR = (bar.high - entry) / risk;
      if (barMfeR > mfeR) mfeR = barMfeR;

      if (!reachedFirstTarget) {
        // PHASE 1: full size, stop at initial SL, FAST_TIME active. SL-first on tie.
        if (bar.low <= currentStop) {
          exitReason = "SL"; exitDate = bar.date; exitIndex = j;
          leg1ExitPrice = currentStop; // full exit at the stop level
          break;
        }
        if (bar.high >= firstTarget) {
          // PHASE 2: tag +2R. Bank 50% at firstTarget, residual to BE/trail.
          reachedFirstTarget = true;
          leg1FreeRolled = true;
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
        // FAST_TIME — STRICT: heldBars===4. LOOSE: heldBars>=4 (first qualifying bar).
        const fastKill = mode.fastKillExact ? heldBars === FAST_TIME_BAR : heldBars >= FAST_TIME_BAR;
        if (fastKill && mfeR < FAST_TIME_MIN_R) {
          exitReason = "FAST_TIME"; exitDate = bar.date; exitIndex = j;
          leg1ExitPrice = bar.close;
          break;
        }
        if (j === bars.length - 1) {
          exitReason = "OPEN"; exitDate = bar.date; exitIndex = j;
          leg1ExitPrice = bar.close;
        }
      } else {
        // PHASE 3: residual 50% trails on the ATR-Chandelier. NO time-stop here.
        highestHigh = Math.max(highestHigh, bar.high);
        const atr = computeAtr14Local(bars.slice(0, j + 1));
        if (atr != null && atr > 0) {
          const chand = highestHigh - CHANDELIER_ATR_MULT * atr;
          trailStop = Math.max(trailStop, chand);
        }
        currentStop = trailStop;

        if (bar.low <= currentStop) {
          exitReason = "TRAIL"; exitDate = bar.date; exitIndex = j;
          leg2ExitPrice = currentStop;
          break;
        }
        if (j === bars.length - 1) {
          exitReason = "TRAIL_OPEN"; exitDate = bar.date; exitIndex = j;
          leg2ExitPrice = bar.close;
        }
      }
    }

    // Edge case: signal on the very last bar → flat at entry.
    if (i === bars.length - 1) {
      exitDate = bars[i].date; exitReason = "OPEN"; exitIndex = i;
      leg1FreeRolled = false; leg1ExitPrice = entry; leg2ExitPrice = entry;
    }

    out.push({
      ticker,
      entryDate: bars[i].date,
      exitDate,
      tier: res.tier,
      isBreakout,
      entry,
      sl,
      exitReason,
      leg1FreeRolled,
      firstTarget,
      leg1ExitPrice,
      leg2ExitPrice,
      stopDistPct: (entry - sl) / entry,
    });

    i = exitIndex;
  }
}

// ─── Portfolio sim (adapted from elzaV3.ts; sector + breakout caps per mode) ──
interface EventRec { date: string; kind: "ENTRY" | "EXIT"; tradeIndex: number; }
interface OpenPos {
  tradeIndex: number; ticker: string; sector: string; isBreakout: boolean;
  notional: number; riskDollars: number; pnl: number; exitDate: string;
}
interface ClosedTrade {
  ticker: string; entryDate: string; exitDate: string; exitReason: ExitReason;
  r: number; pnl: number; skipped: boolean;
}
interface CellResult {
  windowLabel: string;
  logic: "STRICT" | "LOOSE";
  friction: "FRICTIONLESS" | "REALISTIC";
  tradesTaken: number;
  wins: number;
  winPct: number;
  totalR: number;
  finalReturnPct: number;
  maxDrawdownPct: number;
  finalEquity: number;
}

/**
 * Run the portfolio sim for ONE (window-filtered trade list × logic mode × friction).
 * `rOf` resolves each trade's R for the chosen friction mode. Caps: concurrency (10),
 * per-sector (mode.maxPerSector), breakout-slot (mode.capBreakouts → 2), then
 * heat/leverage/maxPosition sizing trims. Realized-equity convention.
 */
function runPortfolio(
  windowTrades: RawTrade[],
  mode: LogicMode,
  friction: "FRICTIONLESS" | "REALISTIC",
  windowLabel: string,
): CellResult {
  const rOf = (t: RawTrade): number => computeTradeR(t, friction);

  const events: EventRec[] = [];
  windowTrades.forEach((t, idx) => {
    events.push({ date: t.entryDate, kind: "ENTRY", tradeIndex: idx });
    events.push({ date: t.exitDate, kind: "EXIT", tradeIndex: idx });
  });
  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "EXIT" ? -1 : 1;
    return a.tradeIndex - b.tradeIndex;
  });

  let equity = START_EQUITY;
  let peakEquity = START_EQUITY;
  let maxDrawdownPct = 0;

  const openByTradeIndex = new Map<number, OpenPos>();
  const closed: ClosedTrade[] = [];
  let breakoutSlotsInUse = 0;

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
      if (openByTradeIndex.size >= MAX_CONCURRENT) continue;
      const sec = sectorOf(t.ticker);
      if (openCountInSector(sec) >= mode.maxPerSector) continue;
      if (mode.capBreakouts && t.isBreakout && breakoutSlotsInUse >= MAX_CONCURRENT_BREAKOUTS) continue;

      const equityAtEntry = equity;
      let riskDollars = RISK_PCT * equityAtEntry;

      const heatAfter = (grossOpenRisk() + riskDollars) / (equityAtEntry > 0 ? equityAtEntry : 1);
      if (heatAfter > HEAT_CAP) {
        closed.push({
          ticker: t.ticker, entryDate: t.entryDate, exitDate: t.exitDate,
          exitReason: t.exitReason, r: rOf(t), pnl: 0, skipped: true,
        });
        continue;
      }

      let notional = riskDollars / t.stopDistPct;
      if (notional > MAX_POSITION_USD) {
        const scale = MAX_POSITION_USD / notional;
        notional *= scale; riskDollars *= scale;
      }
      const headroom = Math.max(0, LEVERAGE * equityAtEntry - grossOpenNotional());
      if (notional > headroom) {
        const scale = headroom > 0 ? headroom / notional : 0;
        notional *= scale; riskDollars *= scale;
      }

      const pnl = rOf(t) * riskDollars;

      openByTradeIndex.set(ev.tradeIndex, {
        tradeIndex: ev.tradeIndex, ticker: t.ticker, sector: sec,
        isBreakout: t.isBreakout, notional, riskDollars, pnl, exitDate: t.exitDate,
      });
      if (mode.capBreakouts && t.isBreakout) breakoutSlotsInUse++;
    } else {
      const pos = openByTradeIndex.get(ev.tradeIndex);
      if (!pos) continue;
      openByTradeIndex.delete(ev.tradeIndex);
      if (mode.capBreakouts && pos.isBreakout && breakoutSlotsInUse > 0) breakoutSlotsInUse--;

      equity += pos.pnl;
      closed.push({
        ticker: t.ticker, entryDate: t.entryDate, exitDate: t.exitDate,
        exitReason: t.exitReason, r: rOf(t), pnl: pos.pnl, skipped: false,
      });

      if (equity > peakEquity) peakEquity = equity;
      const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }
  }

  const taken = closed.filter(c => !c.skipped);
  const wins = taken.filter(c => c.r > 0).length;
  const totalR = taken.reduce((s, c) => s + c.r, 0);

  return {
    windowLabel,
    logic: mode.label,
    friction,
    tradesTaken: taken.length,
    wins,
    winPct: taken.length > 0 ? (wins / taken.length) * 100 : 0,
    totalR: Math.round(totalR * 100) / 100,
    finalReturnPct: ((equity - START_EQUITY) / START_EQUITY) * 100,
    maxDrawdownPct: maxDrawdownPct * 100,
    finalEquity: Math.round(equity),
  };
}

// ─── SPY benchmark (copied from elzaV3.ts; now respects an end-date) ──────────
interface SpyResult { windowLabel: string; returnPct: number; maxDDPct: number; }
function computeSpyBenchmark(
  windowLabel: string, spyBars: Bar[], windowStart: string, windowEnd: string | null,
): SpyResult | null {
  const inWin = spyBars
    .filter(b => b.date >= windowStart && (windowEnd == null || b.date <= windowEnd))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (inWin.length < 2) return null;
  const base = inWin[0].close;
  let peak = START_EQUITY;
  let maxDD = 0;
  let lastEq = START_EQUITY;
  for (const b of inWin) {
    const eq = START_EQUITY * (b.close / base);
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    if (dd > maxDD) maxDD = dd;
    lastEq = eq;
  }
  return {
    windowLabel,
    returnPct: ((lastEq - START_EQUITY) / START_EQUITY) * 100,
    maxDDPct: maxDD * 100,
  };
}

// ─── Window-trade filter (now BOTH ends) ──────────────────────────────────────
function tradesForWindow(allTrades: RawTrade[], start: string, end: string | null): RawTrade[] {
  return allTrades
    .filter(t => t.entryDate >= start && (end == null || t.entryDate <= end))
    .sort((a, b) => {
      if (a.entryDate !== b.entryDate) return a.entryDate < b.entryDate ? -1 : 1;
      if (a.exitDate !== b.exitDate) return a.exitDate < b.exitDate ? -1 : 1;
      return a.ticker < b.ticker ? -1 : 1;
    });
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
function cellKey(win: string, logic: string, fric: string): string { return `${win}|${logic}|${fric}`; }

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`Elza v3 GAP-DECOMPOSITION — READ-ONLY (no DB writes, no IBKR, no orders, no SSH)`);
  console.log(`Engine: REAL calcZivEngineScore, LONG-ONLY. Universe: ${TICKERS.length} tickers (DEFAULT_60_ASSETS).`);
  console.log(`Goal: split the loose(+) vs strict(−) gap into {WINDOW} vs {LOGIC} vs {FRICTION} on ONE bar set.`);
  console.log(`Windows: W-CAL2025 = entryDate in [2025-01-01, 2025-12-31] (BOTH ends) | W-18MO = entryDate >= 2025-01-01 (no end).`);
  console.log(`Logic STRICT: tier-gated (Retest|vol-Breakout), shallow ±2.5%, EMA50-reject entry<=EMA50, fast-kill ===4, sectorCap 3, breakoutCap 2.`);
  console.log(`Logic LOOSE : score>=7.5 ONLY, shallow ±1.5%, EMA50-reject only on LOW-touch-EMA50-in-5, fast-kill >=4, NO sector cap, NO breakout cap.`);
  console.log(`Friction REALISTIC: 5bps adverse entry & every exit fill + $1/side commission (implied shares, baseline size). FRICTIONLESS: exact levels.`);
  console.log(`Portfolio (all cells): $${START_EQUITY.toLocaleString()}, ${RISK_PCT * 100}% risk, leverage ${LEVERAGE}×, maxConcurrent ${MAX_CONCURRENT}, heat ≤ ${HEAT_CAP * 100}%, maxPos $${MAX_POSITION_USD.toLocaleString()}.`);
  console.log(`SHORTS ARE OMITTED — long side of the engine only.`);
  console.log("");

  // SPY once.
  let spyBars: Bar[] = [];
  try {
    spyBars = await fetchBarsForTicker("SPY", 420);
    spyBars = [...spyBars].sort((a, b) => (a.date < b.date ? -1 : 1));
    console.log(`[SPY] fetched ${spyBars.length} bars for benchmark.`);
  } catch (e) {
    console.log(`[WARN] SPY fetch failed: ${(e as Error).message ?? e}. SPY benchmark will be skipped.`);
  }

  // Build trade lists for BOTH logic modes ONCE (one fetch per ticker, two sims).
  const tradesByLogic: Record<"STRICT" | "LOOSE", RawTrade[]> = { STRICT: [], LOOSE: [] };
  let processed = 0;
  let skippedNoData = 0;

  for (const ticker of TICKERS) {
    processed++;
    if (processed % 20 === 0) {
      console.log(`[PROGRESS] ${processed}/${TICKERS.length} tickers processed (STRICT ${tradesByLogic.STRICT.length} / LOOSE ${tradesByLogic.LOOSE.length} trades).`);
    }
    try {
      let bars = await fetchBarsForTicker(ticker, BARS_DAYS);
      if (!bars || bars.length < MIN_BARS) { skippedNoData++; continue; }
      bars = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

      const lastDate = bars[bars.length - 1].date;
      if (lastDate < EARLIEST_WINDOW_START) { skippedNoData++; continue; }
      const warmupBefore = bars.filter(b => b.date < EARLIEST_WINDOW_START).length;
      if (warmupBefore < MIN_BARS) { skippedNoData++; continue; }

      simulateMode(ticker, bars, tradesByLogic.STRICT, STRICT);
      simulateMode(ticker, bars, tradesByLogic.LOOSE, LOOSE);
    } catch (e) {
      console.log(`[WARN] ${ticker}: ${(e as Error).message ?? e}. Skipping ticker.`);
      continue;
    }
  }

  console.log("");
  console.log(`[DONE BUILDING] STRICT ${tradesByLogic.STRICT.length} / LOOSE ${tradesByLogic.LOOSE.length} LONG entries across ${TICKERS.length - skippedNoData} usable tickers (${skippedNoData} skipped).`);

  // ── Run the 8-cell matrix. ──
  const cells: CellResult[] = [];
  for (const w of WINDOWS) {
    for (const mode of LOGIC_MODES) {
      const wt = tradesForWindow(tradesByLogic[mode.label], w.start, w.end);
      for (const fric of FRICTION_MODES) {
        cells.push(runPortfolio(wt, mode, fric, w.label));
      }
    }
  }
  const byKey = new Map<string, CellResult>();
  for (const c of cells) byKey.set(cellKey(c.windowLabel, c.logic, c.friction), c);

  // ── SPY per window. ──
  const spyByWindow = new Map<string, SpyResult | null>();
  for (const w of WINDOWS) {
    spyByWindow.set(w.label, computeSpyBenchmark(w.label, spyBars, w.start, w.end));
  }

  // ── MATRIX TABLE. ──
  console.log("");
  console.log(`══════════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`═══ GAP-DECOMPOSITION MATRIX — 8 cells (window × logic × friction) + SPY per window      ═══`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  ${pad("window", 12)}${pad("logic", 8)}${pad("friction", 14)}${padL("trades", 8)}${padL("win%", 9)}${padL("totalR", 10)}${padL("return%", 11)}${padL("maxDD%", 10)}`);
  console.log(`  ${"─".repeat(82)}`);
  for (const w of WINDOWS) {
    for (const mode of LOGIC_MODES) {
      for (const fric of FRICTION_MODES) {
        const c = byKey.get(cellKey(w.label, mode.label, fric))!;
        console.log(
          `  ${pad(w.label, 12)}${pad(mode.label, 8)}${pad(fric, 14)}` +
          `${padL(c.tradesTaken, 8)}${padL(c.winPct.toFixed(1) + "%", 9)}` +
          `${padL(sign(c.totalR) + c.totalR.toFixed(2), 10)}` +
          `${padL(sign(c.finalReturnPct) + c.finalReturnPct.toFixed(2) + "%", 11)}` +
          `${padL(c.maxDrawdownPct.toFixed(2) + "%", 10)}`,
        );
      }
    }
    const spy = spyByWindow.get(w.label) ?? null;
    if (spy) {
      console.log(
        `  ${pad(w.label, 12)}${pad("SPY b&h", 8)}${pad("(benchmark)", 14)}` +
        `${padL("—", 8)}${padL("—", 9)}${padL("—", 10)}` +
        `${padL(sign(spy.returnPct) + spy.returnPct.toFixed(2) + "%", 11)}` +
        `${padL(spy.maxDDPct.toFixed(2) + "%", 10)}`,
      );
    } else {
      console.log(`  ${pad(w.label, 12)}${pad("SPY b&h", 8)}${pad("(no data)", 14)}${padL("—", 8)}`);
    }
    console.log(`  ${"─".repeat(82)}`);
  }

  // ── DECOMPOSITION (each lever isolated, holding the others fixed). ──
  // Report each lever at BOTH settings of the held-fixed axes so the manager sees the
  // range, not a single cherry-picked slice. return% is the unit (matches the +21.6/−22.1).
  const ret = (win: string, logic: string, fric: string): number =>
    byKey.get(cellKey(win, logic, fric))!.finalReturnPct;

  console.log("");
  console.log(`══════════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`═══ DECOMPOSITION — each lever isolated (Δ return%, holding the other two axes fixed)     ═══`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════════`);

  // LOGIC: STRICT → LOOSE (4 holds: window × friction).
  console.log(`  STRICT → LOOSE  (adds X pts):`);
  for (const w of WINDOWS) {
    for (const fric of FRICTION_MODES) {
      const d = ret(w.label, "LOOSE", fric) - ret(w.label, "STRICT", fric);
      console.log(`     [${pad(w.label, 10)} ${pad(fric, 12)}]  LOOSE ${sign(ret(w.label, "LOOSE", fric))}${ret(w.label, "LOOSE", fric).toFixed(2)}%  −  STRICT ${sign(ret(w.label, "STRICT", fric))}${ret(w.label, "STRICT", fric).toFixed(2)}%  =  ${sign(d)}${d.toFixed(2)} pts`);
    }
  }

  // WINDOW: 18MO → CAL2025 (4 holds: logic × friction).
  console.log(`  W-18MO → W-CAL2025  (adds Y pts):`);
  for (const mode of LOGIC_MODES) {
    for (const fric of FRICTION_MODES) {
      const d = ret("W-CAL2025", mode.label, fric) - ret("W-18MO", mode.label, fric);
      console.log(`     [${pad(mode.label, 10)} ${pad(fric, 12)}]  CAL2025 ${sign(ret("W-CAL2025", mode.label, fric))}${ret("W-CAL2025", mode.label, fric).toFixed(2)}%  −  18MO ${sign(ret("W-18MO", mode.label, fric))}${ret("W-18MO", mode.label, fric).toFixed(2)}%  =  ${sign(d)}${d.toFixed(2)} pts`);
    }
  }

  // FRICTION: FRICTIONLESS → REALISTIC (4 holds: window × logic). Cost = negative Δ.
  console.log(`  FRICTIONLESS → REALISTIC  (costs Z pts):`);
  for (const w of WINDOWS) {
    for (const mode of LOGIC_MODES) {
      const d = ret(w.label, mode.label, "REALISTIC") - ret(w.label, mode.label, "FRICTIONLESS");
      console.log(`     [${pad(w.label, 10)} ${pad(mode.label, 8)}]  REALISTIC ${sign(ret(w.label, mode.label, "REALISTIC"))}${ret(w.label, mode.label, "REALISTIC").toFixed(2)}%  −  FRICTIONLESS ${sign(ret(w.label, mode.label, "FRICTIONLESS"))}${ret(w.label, mode.label, "FRICTIONLESS").toFixed(2)}%  =  ${sign(d)}${d.toFixed(2)} pts`);
    }
  }

  // ── Headline single-path decomposition: the loose-frictionless "+21.6 vibe" corner
  //    down to the strict-realistic "honest" corner, on W-CAL2025 (the apples-to-apples
  //    calendar window). Three additive steps that sum to the full corner-to-corner gap. ──
  console.log("");
  console.log(`  ── HEADLINE PATH on W-CAL2025: LOOSE/FRICTIONLESS  →  STRICT/REALISTIC ──`);
  const cal_LF = ret("W-CAL2025", "LOOSE", "FRICTIONLESS");
  const cal_SF = ret("W-CAL2025", "STRICT", "FRICTIONLESS");
  const cal_SR = ret("W-CAL2025", "STRICT", "REALISTIC");
  console.log(`     start  LOOSE/FRICTIONLESS  = ${sign(cal_LF)}${cal_LF.toFixed(2)}%`);
  console.log(`     step1  LOGIC (LOOSE→STRICT, frictionless) = ${sign(cal_SF - cal_LF)}${(cal_SF - cal_LF).toFixed(2)} pts  →  ${sign(cal_SF)}${cal_SF.toFixed(2)}%`);
  console.log(`     step2  FRICTION (frictionless→realistic, strict) = ${sign(cal_SR - cal_SF)}${(cal_SR - cal_SF).toFixed(2)} pts  →  ${sign(cal_SR)}${cal_SR.toFixed(2)}%`);
  console.log(`     end    STRICT/REALISTIC    = ${sign(cal_SR)}${cal_SR.toFixed(2)}%`);
  console.log(`     (WINDOW lever is shown separately above — it is the W-18MO vs W-CAL2025 column.)`);

  // ── FINAL VERDICT: does ANY honest cell (REALISTIC, either window) BEAT SPY? ──
  console.log("");
  console.log(`══════════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`═══ FINAL VERDICT — does ANY honest (REALISTIC) cell beat SPY in its OWN window?           ═══`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════════`);
  let anyHonestBeat = false;
  for (const w of WINDOWS) {
    const spy = spyByWindow.get(w.label) ?? null;
    for (const mode of LOGIC_MODES) {
      const c = byKey.get(cellKey(w.label, mode.label, "REALISTIC"))!;
      if (!spy) {
        console.log(`     [${pad(w.label, 10)} ${pad(mode.label, 8)} REALISTIC]  ${sign(c.finalReturnPct)}${c.finalReturnPct.toFixed(2)}%  vs SPY  (no data) → INDETERMINATE`);
        continue;
      }
      const diff = c.finalReturnPct - spy.returnPct;
      const beats = diff >= 0;
      if (beats) anyHonestBeat = true;
      console.log(`     [${pad(w.label, 10)} ${pad(mode.label, 8)} REALISTIC]  ${sign(c.finalReturnPct)}${c.finalReturnPct.toFixed(2)}%  vs SPY ${sign(spy.returnPct)}${spy.returnPct.toFixed(2)}%  →  ${beats ? "BEATS" : "LOSES TO"} SPY by ${Math.abs(diff).toFixed(2)} pts`);
    }
  }
  console.log("");
  console.log(`  >>> VERDICT: ${anyHonestBeat ? "YES — at least one REALISTIC cell beats SPY in its own window." : "NO — NO honest (REALISTIC) cell beats SPY in either window. The +21.6% was window+logic+friction illusion."}`);

  // ── Machine-readable dump. ──
  console.log("");
  console.log(`[JSON] ${JSON.stringify({
    cells: cells.map(c => ({
      window: c.windowLabel, logic: c.logic, friction: c.friction,
      trades: c.tradesTaken, winPct: Math.round(c.winPct * 10) / 10,
      totalR: c.totalR, returnPct: Math.round(c.finalReturnPct * 100) / 100,
      maxDDPct: Math.round(c.maxDrawdownPct * 100) / 100,
    })),
    spy: WINDOWS.map(w => {
      const s = spyByWindow.get(w.label) ?? null;
      return { window: w.label, returnPct: s ? Math.round(s.returnPct * 100) / 100 : null, maxDDPct: s ? Math.round(s.maxDDPct * 100) / 100 : null };
    }),
    anyHonestBeatsSpy: anyHonestBeat,
  })}`);

  printDisclaimer();

  console.log("");
  console.log(`Done. 8 cells sized + SPY per window. (Simulation only — no live actions taken.)`);
}

function printDisclaimer(): void {
  console.log("");
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`SIMPLIFICATIONS / DISCLAIMER — read before trusting any number above`);
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`  • SHORTS OMITTED: LONG side only. The live regime/breadth short-gate is not reproduced offline.`);
  console.log(`  • DAILY-BAR TRAIL/MFE OVERSTATES: the Chandelier trail AND the FAST_TIME +1R mfe-check use`);
  console.log(`    DAILY highs/lows. A daily high "reaches" +1R an intraday tick might never have permitted —`);
  console.log(`    so mfeR (FAST_TIME survival) and trail runs are OVERSTATED in BOTH logic modes.`);
  console.log(`  • FRICTION IS APPROXIMATE: 5bps adverse on entry+each exit fill is a flat haircut; real`);
  console.log(`    slippage is fill-, liquidity-, and gap-dependent. Commission-in-R is computed at the`);
  console.log(`    BASELINE 1%-risk full size (implied shares), NOT the post-cap size — a documented`);
  console.log(`    approximation per spec. REALISTIC is therefore a FLOOR on cost, likely optimistic.`);
  console.log(`  • LOOSE-mode EMA50 low-touch test uses the last 5 DAILY bars incl. the entry bar; the audit's`);
  console.log(`    exact Harness lookback convention may differ by ±1 bar.`);
  console.log(`  • THIN 2025 WARMUP: fetchBarsForTicker(..,420) reaches ~2024-10, so early-2025 entries open`);
  console.log(`    on ~50 bars of warmup — treat early-2025 entries with caution.`);
  console.log(`  • CAPS MODEL HEADROOM ONLY: leverage/heat/maxPosition trim or skip size but do NOT model`);
  console.log(`    margin calls, gap risk, or forced liquidation. Max-DD is on REALIZED equity — a FLOOR.`);
  console.log(`  • W-CAL2025 vs W-18MO share the SAME generated trades; they differ ONLY by the entryDate`);
  console.log(`    end-filter, so the WINDOW lever is a clean apples-to-apples slice of the SAME bars.`);
}

main().catch(err => {
  console.error(`[FATAL] ${(err as Error).stack ?? err}`);
  process.exit(1);
});
