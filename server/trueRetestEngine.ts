/**
 * trueRetestEngine.ts — ELZA 2.0 P0-3 (True Retest).
 *
 * Ziv's "Gold Retest" is a STRUCTURAL event, not EMA proximity:
 *   1. price broke above a prior resistance level (priorBreakoutLevel),
 *   2. pulled back to retest that level (now support), within tolerance,
 *   3. HELD for N confirmation candles (didn't fail back below the broken level).
 *
 * The old zivEngine Tier 3 fired on `distToEma50Pct <= 3` alone — that let
 * EMA-proximity entries masquerade as retests. This detector replaces that with
 * the real pattern. No DB, no IBKR — pure over bars (unit-testable).
 */

import type { ZoneRetestContext, RetestContract } from "./zonesEngine";
import { retestBand } from "./zonesEngine";

export interface RetestBar { high: number; low: number; close: number }
export type RetestDirection = "long" | "short";

export const RETEST_LOOKBACK = 30;          // bars to search for the prior level
export const RETEST_TOLERANCE_PCT = 2.0;    // ±% of level that counts as "at the level"
export const RETEST_CONFIRM_CANDLES = 5;    // closes that must hold beyond the broken level

// ── Ziv Phase 2 — Retest-v2 (±0.5×ATR band + 5-close hold + FOMO) ───────────────
export const RETEST_HOLD_N = 5;
export const FOMO_PCT = 1.5;
export const LIMIT_ABOVE_PCT = 0.75;
const ROLE_REVERSAL_DISAGREE_PCT = 1.0;

/** ATR14 over high/low/close (pure). */
function atr14(bars: RetestBar[], period = 14): number {
  if (bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const s = trs.slice(-period);
  return s.reduce((a, b) => a + b, 0) / (s.length || 1);
}

/** Direction-aware price-action bonus (no `open` available → wick-position proxy). */
function paBonusFor(b: RetestBar, isLong: boolean): boolean {
  const range = b.high - b.low;
  if (range <= 0) return false;
  return isLong ? (b.close - b.low) >= range * 0.6   // close in upper 40% — buyers rejected the low
                : (b.high - b.close) >= range * 0.6;  // close in lower 40% — sellers rejected the high
}

/**
 * Ziv Phase 2 retest producer — populates the FROZEN RetestContract. Pure.
 * RT-02: valid = pierced the ±0.5×ATR band AND last 5 closes hold the trade side AND not FOMO.
 * A prior breakout is a rank bonus, not required. Symmetric (one sign-flipped function).
 * `level` = proximal zone edge (long zone.high / short zone.low); role-reversal level
 * overrides when it disagrees with the zone edge by >1%.
 */
export function evaluateRetestV2(
  ctx: ZoneRetestContext, bars: RetestBar[], roleReversalLevel?: number | null,
): RetestContract {
  const isLong = ctx.direction === "long";
  let level = isLong ? ctx.zone.high : ctx.zone.low;
  if (roleReversalLevel != null && level > 0
      && (Math.abs(roleReversalLevel - level) / level) * 100 > ROLE_REVERSAL_DISAGREE_PCT) {
    level = roleReversalLevel;
  }
  const atr = atr14(bars);
  const { bandLow, bandHigh } = retestBand(level, atr);
  const limitRaw = isLong ? level * (1 + LIMIT_ABOVE_PCT / 100) : level * (1 - LIMIT_ABOVE_PCT / 100);
  const fomoCap  = isLong ? level * (1 + FOMO_PCT / 100)        : level * (1 - FOMO_PCT / 100);
  const limitPrice = isLong ? Math.min(limitRaw, fomoCap) : Math.max(limitRaw, fomoCap);

  const degenerate = !bars || bars.length < RETEST_HOLD_N + 1 || atr <= 0 || bandHigh <= bandLow || level <= 0;
  if (degenerate) {
    return { side: ctx.direction, level, atr14: atr, bandLow, bandHigh, inBand: false,
      heldCloses: 0, confirmCandles: RETEST_HOLD_N, paBonus: false, fomoRejected: false, limitPrice, valid: false };
  }

  const lastClose = bars[bars.length - 1].close;
  const lookbackWin = bars.slice(-RETEST_LOOKBACK);
  const pierced = lookbackWin.some(b => b.low <= bandHigh && b.high >= bandLow);
  const inBand = pierced && (isLong ? lastClose >= bandLow : lastClose <= bandHigh);
  const heldCloses = bars.slice(-RETEST_HOLD_N).filter(b => isLong ? b.close >= bandLow : b.close <= bandHigh).length;
  const fomoRejected = isLong ? lastClose > fomoCap : lastClose < fomoCap;
  const paBonus = paBonusFor(bars[bars.length - 1], isLong);
  const valid = inBand && heldCloses >= RETEST_HOLD_N && !fomoRejected;

  return { side: ctx.direction, level, atr14: atr, bandLow, bandHigh, inBand,
    heldCloses, confirmCandles: RETEST_HOLD_N, paBonus, fomoRejected, limitPrice, valid };
}

export interface TrueRetestResult {
  isRetest: boolean;
  priorBreakoutLevel: number | null;  // LONG: broken resistance; SHORT: broken support
  distPct: number | null;        // current close distance from the level
  heldCandles: number;           // how many of the last N closes held beyond the floor/ceiling
  confirmCandles: number;
  reason: string;
}

export interface TrueRetestOpts { lookback?: number; tolerancePct?: number; confirmCandles?: number }

/**
 * Structural true retest, direction-aware (anti-drift: ONE function, sign-flipped).
 *   LONG  : prior RESISTANCE = max-high of base; price broke ABOVE; pulled back;
 *           held ABOVE the broken level for `confirm` candles. SL just BELOW the level.
 *   SHORT : prior SUPPORT    = min-low  of base; price broke BELOW; rallied back;
 *           held BELOW the broken level for `confirm` candles. SL just ABOVE the level.
 * `priorBreakoutLevel` is the broken role-reversed level (feeds invalidationLevel).
 */
export function detectTrueRetest(bars: RetestBar[], direction: RetestDirection = "long", opts: TrueRetestOpts = {}): TrueRetestResult {
  const lookback = opts.lookback ?? RETEST_LOOKBACK;
  const tol = opts.tolerancePct ?? RETEST_TOLERANCE_PCT;
  const confirm = opts.confirmCandles ?? RETEST_CONFIRM_CANDLES;
  const isLong = direction === "long";
  const fail = (reason: string, level: number | null = null, distPct: number | null = null, held = 0): TrueRetestResult =>
    ({ isRetest: false, priorBreakoutLevel: level, distPct, heldCandles: held, confirmCandles: confirm, reason });

  if (!bars || bars.length < lookback + confirm) return fail("insufficient history");
  const win = bars.slice(-(lookback + confirm));

  // Prior level = highest high (long: resistance) or lowest low (short: support) of the
  // BASE (window minus the recent break+confirm zone).
  const baseEnd = win.length - confirm - 5;     // leave ~5 bars for the break move + N confirm
  if (baseEnd < 5) return fail("base too short");
  const base = win.slice(0, baseEnd);
  const level = isLong ? Math.max(...base.map(b => b.high)) : Math.min(...base.map(b => b.low));
  if (!(level > 0)) return fail(isLong ? "no resistance level" : "no support level");

  // Break: at least one bar between the base and the confirm window CLOSED beyond the level
  // (long: above resistance; short: below support).
  const mid = win.slice(baseEnd, win.length - confirm);
  const broke = isLong ? mid.some(b => b.close > level) : mid.some(b => b.close < level);
  if (!broke) return fail(isLong ? "no breakout above prior resistance" : "no breakdown below prior support", level);

  // Hold: the last `confirm` closes stayed beyond the broken level.
  //   long  → at/above floor   = level × (1 − tol)
  //   short → at/below ceiling  = level × (1 + tol)
  const bound = isLong ? level * (1 - tol / 100) : level * (1 + tol / 100);
  const lastN = win.slice(-confirm);
  const heldCandles = lastN.filter(b => isLong ? b.close >= bound : b.close <= bound).length;
  const held = heldCandles === confirm;

  // Retest: current close pulled back NEAR the level (within tolerance) and is beyond the bound.
  const last = win[win.length - 1].close;
  const distPct = Math.abs(last - level) / level * 100;
  const nearLevel = distPct <= tol;
  const beyondBound = isLong ? last >= bound : last <= bound;

  const isRetest = held && nearLevel && beyondBound;
  const verb = isLong ? "above" : "below";
  const reason = isRetest
    ? `true retest of ${level.toFixed(2)} (dist ${distPct.toFixed(1)}%, held ${heldCandles}/${confirm})`
    : !nearLevel ? `not near level (dist ${distPct.toFixed(1)}% > ${tol}%)`
    : !held ? `failed hold (${heldCandles}/${confirm} closes ${verb} ${bound.toFixed(2)})`
    : "no retest";
  return { isRetest, priorBreakoutLevel: +level.toFixed(2), distPct: +distPct.toFixed(2), heldCandles, confirmCandles: confirm, reason };
}
