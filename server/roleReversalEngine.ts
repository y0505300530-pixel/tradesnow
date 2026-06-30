/**
 * roleReversalEngine.ts — ELZA 2.0 P0-9 (Role Reversal, ליבת תורת זיו).
 *
 * A historical level that PROVED itself, then CHANGED ROLE:
 *   LONG  (V1+V2): resistance broken upward, retested from above as support.
 *     V1 — price was BELOW the level ≥5 bars, then a bar CLOSED above it.
 *     V2 — price pulled back to within ±2% of the level and CLOSED back above it.
 *   SHORT (BR1+BR2): support broken downward, retested from below as resistance.
 *     BR1 — price was ABOVE the level ≥5 bars, then a bar CLOSED below it.
 *     BR2 — price rallied to within ±2% of the level (high) and CLOSED below it.
 *
 * V3–V7 (volume / weekly / score / mentor / CYC) live in their own modules and
 * gate the entry elsewhere — this engine only detects the structural role change.
 * Pure, no DB/IBKR.
 */

export interface RRBar { high: number; low: number; close: number }
export type RRDirection = "long" | "short";

export const RR_LOOKBACK = 30;
export const RR_TOLERANCE_PCT = 2.0;
export const RR_MIN_BARS_BEFORE_BREAK = 5;

export interface RoleReversalResult {
  isReversal: boolean;
  level: number | null;
  brokeRole: boolean;   // V1 / BR1 — the level's role flipped
  retested: boolean;    // V2 / BR2 — retest of the flipped level
  distPct: number | null;
  reason: string;
}

export interface RoleReversalOpts { lookback?: number; tolerancePct?: number; minBarsBeforeBreak?: number }

export function detectRoleReversal(bars: RRBar[], direction: RRDirection = "long", opts: RoleReversalOpts = {}): RoleReversalResult {
  const lookback = opts.lookback ?? RR_LOOKBACK;
  const tol = opts.tolerancePct ?? RR_TOLERANCE_PCT;
  const minBefore = opts.minBarsBeforeBreak ?? RR_MIN_BARS_BEFORE_BREAK;
  const fail = (reason: string, level: number | null = null): RoleReversalResult =>
    ({ isReversal: false, level, brokeRole: false, retested: false, distPct: null, reason });

  if (!bars || bars.length < lookback + 5) return fail("insufficient history");
  const win = bars.slice(-(lookback + 5));
  const baseEnd = win.length - 10;           // base = window minus the recent break+retest zone
  if (baseEnd < minBefore) return fail("base too short");
  const base = win.slice(0, baseEnd);
  const post = win.slice(baseEnd);
  const last = win[win.length - 1].close;

  if (direction === "long") {
    const level = Math.max(...base.map(b => b.high));               // prior resistance
    if (!(level > 0)) return fail("no level");
    const wasBelow = base.filter(b => b.close < level).length >= minBefore;   // V1a
    const brokeAbove = post.some(b => b.close > level);                        // V1b
    const brokeRole = wasBelow && brokeAbove;
    const distPct = Math.abs(last - level) / level * 100;
    const retested = post.some(b => b.low <= level * (1 + tol / 100)) && last > level * (1 - tol / 100); // V2
    const isReversal = brokeRole && retested && distPct <= tol;
    return {
      isReversal, level: +level.toFixed(2), brokeRole, retested, distPct: +distPct.toFixed(2),
      reason: isReversal ? `LONG role reversal: ${level.toFixed(2)} resistance→support (dist ${distPct.toFixed(1)}%)`
        : !brokeRole ? "level never flipped (no break above prior resistance)"
        : !retested ? "no retest of the flipped level" : `not near level (${distPct.toFixed(1)}%)`,
    };
  }

  // SHORT mirror
  const level = Math.min(...base.map(b => b.low));                  // prior support
  if (!(level > 0)) return fail("no level");
  const wasAbove = base.filter(b => b.close > level).length >= minBefore;     // BR1a
  const brokeBelow = post.some(b => b.close < level);                         // BR1b
  const brokeRole = wasAbove && brokeBelow;
  const distPct = Math.abs(last - level) / level * 100;
  const retested = post.some(b => b.high >= level * (1 - tol / 100)) && last < level * (1 + tol / 100); // BR2
  const isReversal = brokeRole && retested && distPct <= tol;
  return {
    isReversal, level: +level.toFixed(2), brokeRole, retested, distPct: +distPct.toFixed(2),
    reason: isReversal ? `SHORT role reversal: ${level.toFixed(2)} support→resistance (dist ${distPct.toFixed(1)}%)`
      : !brokeRole ? "level never flipped (no break below prior support)"
      : !retested ? "no retest of the flipped level" : `not near level (${distPct.toFixed(1)}%)`,
  };
}
