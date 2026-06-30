// server/partialFillRegistry.ts
// orderFillPoller addition (kept as a standalone module so the live poller file is edited
// with a single 1-line hook rather than a risky inline rewrite).
//
// WIRE-IN (server/orderFillPoller.ts, inside pollPendingOrders, in the `status === "filled"`
// branch, BEFORE the normal full-close handling):
//
//     const avg = parseFloat(order.avgPrice ?? order.price ?? "0") || 0;
//     if (avg > 0 && await handlePartialFillIfAny(orderId, avg)) continue; // partial reduce — not a full close
//

type PartialIntent = { qtyToClose: number; fraction: number };
const _pending = new Map<string, { positionId: number; ticker: string } & PartialIntent>();

export function registerPendingPartial(positionId: number, ticker: string, orderId: string, intent: PartialIntent): void {
  if (!orderId) return;
  _pending.set(orderId, { positionId, ticker, ...intent });
}

export function isPendingPartial(orderId: string): boolean {
  return _pending.has(orderId);
}

/** Returns true if this orderId was a registered partial and was handled (decrement + BE re-arm). */
export async function handlePartialFillIfAny(orderId: string, avgFillPrice: number): Promise<boolean> {
  const it = _pending.get(orderId);
  if (!it) return false;
  _pending.delete(orderId);
  const { onPartialExitFilled, realDeps } = await import("./executePartial");
  await onPartialExitFilled(
    { userId: 1, positionId: it.positionId, qtyClosed: it.qtyToClose, fillPrice: avgFillPrice },
    await realDeps(),
  );
  return true;
}
