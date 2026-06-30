/**
 * PortfolioValueService — single source of truth for position and portfolio
 * value formulas (server-side).
 *
 * positionValue matches client/src/lib/positionMath.ts: price * units.
 * In the server model units is always positive (sign is in direction field),
 * so for longs this is straightforward market value.
 *
 * computePortfolioNlv: this is the LOCAL fallback sum (positionsValue + cash).
 * When IBKR is connected, the authoritative NLV comes from IBKR's
 * netLiquidation field (stored in portfolioAccount.lastKnownNetLiquidation).
 * Use this function only when IBKR data is unavailable or for local estimates.
 */

/** Market value of a single position: price × units. */
export function positionValue(price: number, units: number): number {
  return price * units;
}

/** Sum of positionValue across all positions. */
export function computeInvestedValue(
  positions: Array<{ price: number; units: number }>,
): number {
  return positions.reduce((sum, p) => sum + positionValue(p.price, p.units), 0);
}

/**
 * Portfolio net liquidation value (local fallback).
 * = sum of position market values + cash balance.
 *
 * NOTE: When IBKR is live, prefer portfolioAccount.lastKnownNetLiquidation
 * as the authoritative NLV. This function is the fallback for environments
 * where IBKR data is absent (e.g. paper/offline mode).
 */
export function computePortfolioNlv(positionsValue: number, cash: number): number {
  return positionsValue + cash;
}
