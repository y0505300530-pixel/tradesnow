/**
 * PnlService — single source of truth for P&L formulas (server-side).
 *
 * Sign convention (matches liveOrderExecutor.ts ~line 1123):
 *   long  P&L = (exitPrice - entryPrice) * units
 *   short P&L = (entryPrice - exitPrice) * units
 *
 * `units` is always a POSITIVE number here. Direction is conveyed by the
 * `direction` field ("long" | "short"), NOT by a sign on units.
 * This matches the server-side live position model (livePositions table).
 *
 * NOTE: the client-side positionMath.ts uses a DIFFERENT convention where
 * units can be negative for shorts and P&L = (price - buyPrice) * units.
 * Both formulas are mathematically equivalent but the calling convention differs.
 */

/** Unrealized P&L in dollars for an open position. */
export function positionUnrealizedPnl(
  direction: "long" | "short",
  entryPrice: number,
  currentPrice: number,
  units: number,
): number {
  return direction === "long"
    ? (currentPrice - entryPrice) * units
    : (entryPrice - currentPrice) * units;
}

/** Realized P&L in dollars for a closed position. */
export function positionRealizedPnl(
  direction: "long" | "short",
  entryPrice: number,
  exitPrice: number,
  units: number,
): number {
  return direction === "long"
    ? (exitPrice - entryPrice) * units
    : (entryPrice - exitPrice) * units;
}

/**
 * P&L as a percentage of capital deployed.
 * Returns 0 if entryPrice * units == 0 (guard against divide-by-zero).
 */
export function pnlPct(entryPrice: number, pnl: number, units: number): number {
  const capital = entryPrice * units;
  return capital === 0 ? 0 : (pnl / capital) * 100;
}
