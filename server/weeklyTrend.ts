// ─── Ziv Engine Phase 1 — Weekly Trend Anchor (SSOT) ───────────────────────────
// The ONLY module allowed to classify per-ticker weekly direction/structure.
// Pure: daily bars in → WeeklyTrend out. No I/O, no DB, no clock. Aggregates the
// daily bars the engine already holds into weekly OHLC internally (one definition).
//
// Spec: docs/ziv-engine-spec/phase1-ruleset.md §3, phase1-architecture.md §2.2.
// Symmetric long/short. Hard gate: long only if WK-L, short only if WK-S.

import type { Bar } from "./zivEngine";
import { calcEMA } from "./zivEngine";

export type WeeklyDirection = "up" | "down" | "neutral";
export type WeeklyStructure =
  | "WK-L"            // bullish primary trend (HH/HL, slope>+0.2%, close>EMA50w)
  | "WK-S"            // bearish mirror
  | "CONSOLIDATION"   // דשדוש — 2+2 touches, blocks both sides
  | "FALLING_KNIFE"   // prior uptrend broke its last swing low → no long
  | "RISING_KNIFE"    // prior downtrend broke its last swing high → no short
  | "AMBIGUOUS";      // flat / insufficient data

export interface WeeklyTrend {
  direction:       WeeklyDirection;
  structure:       WeeklyStructure;
  weeklySlopePct:  number;        // PERCENT (not $ delta) — fixes the legacy slope bug
  weeklyEma50:     number;
  weeklyClose:     number;
  lastSwingHigh:   number | null;
  lastSwingLow:    number | null; // falling-knife reference + Phase-2 trail anchor
  priorSwingLow:   number | null;
  isConsolidating: boolean;
  fallingKnife:    boolean;
  reason:          string;
}

export interface WeeklyGateResult {
  pass:   boolean;
  state:  WeeklyTrend;
  reason: string;
}

// ─── Constants (verbatim from the ruleset; RECOMMENDED_DEFAULT where ⚠️) ─────────
const BARS_PER_WEEK              = 5;
const ZONE_LOOKBACK_WEEKS        = 52;
const WEEKLY_EMA_PERIOD          = 50;
const WEEKLY_SLOPE_LOOKBACK_WEEKS = 4;
const WEEKLY_SLOPE_BULL_MIN_PCT  = 0.2;
const WEEKLY_SLOPE_BEAR_MAX_PCT  = -0.2;
const WEEKLY_PRIMARY_MIN_WEEKS   = 16;   // ~4 months
const SWING_PIVOT_BARS_W         = 2;
const FALLING_KNIFE_BUFFER_PCT   = 0.5;
const KNIFE_PEAK_FRAC_MIN        = 0.4;  // the high/low must be made in the latter part (else it's a trend, not a knife)
const KNIFE_DROP_FRAC            = 0.9;  // close must be <90% of peak (long) to qualify as a knife
const CONSOL_MIN_BARS            = 8;
const CONSOL_LEVEL_TOLERANCE_PCT = 2.0;
const CONSOL_RANGE_WIDTH_MIN_PCT = 5;
const CONSOL_RANGE_WIDTH_MAX_PCT = 35;
const CONSOL_TOUCH_MIN           = 2;

/** Aggregate daily bars into weekly OHLC (5 trading-day buckets — see ruleset §3.1). */
export function aggregateToWeekly(daily: Bar[]): Bar[] {
  const weekly: Bar[] = [];
  for (let i = 0; i < daily.length; i += BARS_PER_WEEK) {
    const chunk = daily.slice(i, i + BARS_PER_WEEK);
    if (chunk.length === 0) continue;
    weekly.push({
      date:   chunk[chunk.length - 1].date,
      open:   chunk[0].open,
      high:   Math.max(...chunk.map(b => b.high)),
      low:    Math.min(...chunk.map(b => b.low)),
      close:  chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, b) => s + (b.volume ?? 0), 0),
    });
  }
  return weekly;
}

/** Swing-pivot lows: bars whose low is the strict min over ±n neighbours. */
function pivotLows(bars: Bar[], n: number): number[] {
  const out: number[] = [];
  for (let i = n; i < bars.length - n; i++) {
    let isLow = true;
    for (let j = i - n; j <= i + n; j++) if (j !== i && bars[j].low <= bars[i].low) { isLow = false; break; }
    if (isLow) out.push(bars[i].low);
  }
  return out;
}
function pivotHighs(bars: Bar[], n: number): number[] {
  const out: number[] = [];
  for (let i = n; i < bars.length - n; i++) {
    let isHigh = true;
    for (let j = i - n; j <= i + n; j++) if (j !== i && bars[j].high >= bars[i].high) { isHigh = false; break; }
    if (isHigh) out.push(bars[i].high);
  }
  return out;
}

/** Consolidation (דשדוש): ≥2 touches at a common resistance AND ≥2 at a common support,
 *  range width 5–35%, over ≥8 weekly bars. Blocks both directions when true. */
function detectConsolidation(weekly: Bar[]): boolean {
  if (weekly.length < CONSOL_MIN_BARS) return false;
  const win = weekly.slice(-Math.max(CONSOL_MIN_BARS, 12));
  const top = Math.max(...win.map(b => b.high));
  const bot = Math.min(...win.map(b => b.low));
  if (bot <= 0) return false;
  const widthPct = ((top - bot) / bot) * 100;
  if (widthPct < CONSOL_RANGE_WIDTH_MIN_PCT || widthPct > CONSOL_RANGE_WIDTH_MAX_PCT) return false;
  // Sideways-only: a one-way trend has net drift ≈ the full range. Real דשדוש oscillates
  // inside the range with little net change. Require |net drift| < half the range width.
  const first = win[0].close, last = win[win.length - 1].close;
  if (first > 0 && Math.abs((last - first) / first) * 100 > widthPct * 0.5) return false;
  const tol = CONSOL_LEVEL_TOLERANCE_PCT / 100;
  const upperTouches = win.filter(b => b.high >= top * (1 - tol)).length;
  const lowerTouches = win.filter(b => b.low <= bot * (1 + tol)).length;
  return upperTouches >= CONSOL_TOUCH_MIN && lowerTouches >= CONSOL_TOUCH_MIN;
}

function ambiguous(weeklyClose: number, reason: string): WeeklyTrend {
  return {
    direction: "neutral", structure: "AMBIGUOUS", weeklySlopePct: 0, weeklyEma50: weeklyClose,
    weeklyClose, lastSwingHigh: null, lastSwingLow: null, priorSwingLow: null,
    isConsolidating: false, fallingKnife: false, reason,
  };
}

/** Classify the weekly trend for a ticker from its DAILY bars. Pure. */
export function classifyWeeklyTrend(bars: Bar[]): WeeklyTrend {
  const weekly = aggregateToWeekly(bars).slice(-ZONE_LOOKBACK_WEEKS);
  const wClose = weekly.length ? weekly[weekly.length - 1].close : 0;
  if (weekly.length < WEEKLY_PRIMARY_MIN_WEEKS) {
    return ambiguous(wClose, `insufficient weekly history (${weekly.length}w < ${WEEKLY_PRIMARY_MIN_WEEKS}w)`);
  }

  const closes  = weekly.map(b => b.close);
  const ema50   = calcEMA(closes, Math.min(WEEKLY_EMA_PERIOD, closes.length));
  const emaNow  = calcEMA(closes, Math.min(WEEKLY_EMA_PERIOD, closes.length));
  const emaPrev = calcEMA(closes.slice(0, -WEEKLY_SLOPE_LOOKBACK_WEEKS), Math.min(WEEKLY_EMA_PERIOD, Math.max(2, closes.length - WEEKLY_SLOPE_LOOKBACK_WEEKS)));
  const slopePct = emaPrev > 0 ? ((emaNow - emaPrev) / emaPrev) * 100 : 0;

  const pl = pivotLows(weekly, SWING_PIVOT_BARS_W);
  const ph = pivotHighs(weekly, SWING_PIVOT_BARS_W);
  // fallbacks when a clean series has no interior pivot
  const trailLow  = Math.min(...weekly.slice(Math.max(0, weekly.length - 12), weekly.length - 1).map(b => b.low));
  const trailHigh = Math.max(...weekly.slice(Math.max(0, weekly.length - 12), weekly.length - 1).map(b => b.high));
  const lastSwingLow  = pl.length ? pl[pl.length - 1] : trailLow;
  const priorSwingLow = pl.length > 1 ? pl[pl.length - 2] : null;
  const lastSwingHigh = ph.length ? ph[ph.length - 1] : trailHigh;

  // half-based HH/HL structure — robust on real (non-monotonic) data
  const mid = Math.floor(closes.length / 2);
  const fHigh = Math.max(...closes.slice(0, mid)), sHigh = Math.max(...closes.slice(mid));
  const fLow  = Math.min(...closes.slice(0, mid)), sLow  = Math.min(...closes.slice(mid));
  const bullStruct = sHigh > fHigh && sLow >= fLow;
  const bearStruct = sHigh <= fHigh && sLow < fLow;

  const maxClose = Math.max(...closes), minClose = Math.min(...closes);
  const peakFrac   = closes.indexOf(maxClose) / (closes.length - 1);
  const troughFrac = closes.indexOf(minClose) / (closes.length - 1);
  const fallingKnife = peakFrac >= KNIFE_PEAK_FRAC_MIN
    && wClose < lastSwingLow * (1 - FALLING_KNIFE_BUFFER_PCT / 100)
    && wClose < maxClose * KNIFE_DROP_FRAC;
  const risingKnife = troughFrac >= KNIFE_PEAK_FRAC_MIN
    && wClose > lastSwingHigh * (1 + FALLING_KNIFE_BUFFER_PCT / 100)
    && wClose > minClose * (2 - KNIFE_DROP_FRAC);

  const isConsolidating = detectConsolidation(weekly);

  let structure: WeeklyStructure;
  let direction: WeeklyDirection;
  let reason: string;
  if (fallingKnife) {
    structure = "FALLING_KNIFE"; direction = "down"; reason = `falling knife — weekly close ${wClose.toFixed(2)} broke last swing low ${lastSwingLow.toFixed(2)}`;
  } else if (risingKnife) {
    structure = "RISING_KNIFE"; direction = "up"; reason = `rising knife — weekly close broke last swing high ${lastSwingHigh.toFixed(2)}`;
  } else if (isConsolidating) {
    structure = "CONSOLIDATION"; direction = "neutral"; reason = "weekly consolidation (דשדוש) — no trend entry either side";
  } else if (bullStruct && slopePct > WEEKLY_SLOPE_BULL_MIN_PCT && wClose > ema50) {
    structure = "WK-L"; direction = "up"; reason = `WK-L uptrend — HH/HL, slope ${slopePct.toFixed(2)}%, close>EMA50w`;
  } else if (bearStruct && slopePct < WEEKLY_SLOPE_BEAR_MAX_PCT && wClose < ema50) {
    structure = "WK-S"; direction = "down"; reason = `WK-S downtrend — LH/LL, slope ${slopePct.toFixed(2)}%, close<EMA50w`;
  } else {
    structure = "AMBIGUOUS"; direction = "neutral"; reason = `ambiguous — slope ${slopePct.toFixed(2)}%, no clean HH/HL`;
  }

  return {
    direction, structure, weeklySlopePct: slopePct, weeklyEma50: ema50, weeklyClose: wClose,
    lastSwingHigh, lastSwingLow, priorSwingLow, isConsolidating, fallingKnife, reason,
  };
}

/** HARD gate. Long permitted ONLY when WK-L; short ONLY when WK-S. Symmetric. */
export function evaluateWeeklyGate(wt: WeeklyTrend, direction: "long" | "short"): WeeklyGateResult {
  const need = direction === "long" ? "WK-L" : "WK-S";
  const pass = wt.structure === need;
  const reason = pass
    ? `${need} ok`
    : `blocked for ${direction}: weekly ${wt.structure} (need ${need}) — ${wt.reason}`;
  return { pass, state: wt, reason };
}
