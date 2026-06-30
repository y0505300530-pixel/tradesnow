// server/partialCloseLogic.ts
// PURE state-machine for the Free-Roll partial close. ZERO I/O imports → unit-testable.
// All side effects (DB, IBIND) live in executePartial.ts via injected deps.

export interface PartialPos {
  id: number;
  ticker: string;
  direction: "long" | "short";
  units: number;
  entryPrice: number;
  allocatedCapital: number;
  currentPrice?: number | null;
  currentSl?: number | null;
  currentTp?: number | null;
  partialRealizedPnl?: number | null;
  isFreeRolled?: number;
  ibkrSlOrderId?: string | null;
  ibkrTpOrderId?: string | null;
}

export const MAX_SLIP_PCT = 0.01; // marketable-limit slippage cap (matches executeLiveSell)

/** Half-size plan. floor() so a 1-share position can never partial to zero. */
export function computePartialPlan(pos: PartialPos, fraction: number) {
  const qtyToClose = Math.max(1, Math.floor(pos.units * fraction));
  const exitSide: "SELL" | "BUY" = pos.direction === "long" ? "SELL" : "BUY";
  const valid = qtyToClose >= 1 && qtyToClose < pos.units;
  return { qtyToClose, exitSide, valid };
}

/** Marketable IOC limit: SELL at live−1%, BUY(cover) at live+1%. */
export function computeMarketableLimit(live: number, exitSide: "SELL" | "BUY") {
  return exitSide === "SELL"
    ? +(live * (1 - MAX_SLIP_PCT)).toFixed(2)
    : +(live * (1 + MAX_SLIP_PCT)).toFixed(2);
}

/** Breakeven stop = ENTRY ± 0.15% to clear commissions (NOT the exit fill). */
export function computeBreakeven(entryPrice: number, direction: "long" | "short") {
  return +(entryPrice * (direction === "long" ? 1.0015 : 0.9985)).toFixed(2);
}

/**
 * Pure transform of position state on a CONFIRMED partial fill.
 * - units decremented; allocatedCapital pro-rated
 * - realized PnL from the exit fill; BE stop anchored to ENTRY
 * - isFreeRolled=1, TP removed (Stage-2 open-sky)
 * Returns the next state plus _beStop / _realized for the caller to persist + re-arm.
 */
export function applyPartialFill(pos: PartialPos, qtyClosed: number, exitFillPrice: number) {
  const isLong = pos.direction === "long";
  const remaining = pos.units - qtyClosed;
  if (remaining <= 0) throw new Error("partial fill would flatten position — use full close");

  const realized = (isLong ? exitFillPrice - pos.entryPrice : pos.entryPrice - exitFillPrice) * qtyClosed;
  const beStop = computeBreakeven(pos.entryPrice, pos.direction);

  return {
    ...pos,
    units: remaining,
    allocatedCapital: +(pos.allocatedCapital * (remaining / pos.units)).toFixed(2),
    partialRealizedPnl: +(((pos.partialRealizedPnl ?? 0) + realized)).toFixed(2),
    isFreeRolled: 1,
    currentTp: null,
    ibkrTpOrderId: null,
    currentSl: beStop,
    _beStop: beStop,
    _realized: +realized.toFixed(2),
  };
}
