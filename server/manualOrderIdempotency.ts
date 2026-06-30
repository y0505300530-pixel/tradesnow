// server/manualOrderIdempotency.ts
// In-memory idempotency guard for MANUAL orders. The UI generates one stable `clientOrderId`
// per trade intent; if the broker round-trip stalls (the ibind gateway intermittently fails to
// return a fill within ~15s, which flips the UI to STALLED), the trader may re-submit. Without
// this guard that second submit places a DUPLICATE live order = duplicate position on real money.
//
// We remember each clientOrderId for a short window and return the FIRST result for any repeat,
// so a re-submit is a no-op echo, never a second broker order. Memory-only by design: a server
// restart inside the (short) window is rare, and the window is intentionally small.
export interface ManualOrderResult {
  success: boolean;
  orderId: string | null;
  ticker: string;
  side: "BUY" | "SELL";
  quantity: number;
  orderType: string;
  reason?: string;
  ibkrMessage?: string;
  sl?: number;   // actual stop-loss placed (powers the UI "protected" banner — C3)
  tp?: number;   // actual take-profit placed
}

type Entry =
  | { state: "in_flight"; at: number }
  | { state: "done"; at: number; result: ManualOrderResult };

const TTL_MS = 5 * 60 * 1000; // remember a clientOrderId for 5 minutes
const seen = new Map<string, Entry>();

function sweep(now: number): void {
  for (const [k, v] of seen) if (now - v.at > TTL_MS) seen.delete(k);
}

/**
 * Claim a clientOrderId before placing. Returns:
 *  - { proceed: true } → first time, caller should place the order then call `settle()`.
 *  - { proceed: false, inFlight: true } → an identical submit is mid-flight; caller must NOT place.
 *  - { proceed: false, result } → already completed; caller returns this cached result, no broker call.
 */
export function claimManualOrder(
  clientOrderId: string,
  now = Date.now(),
): { proceed: boolean; inFlight?: boolean; result?: ManualOrderResult } {
  sweep(now);
  const existing = seen.get(clientOrderId);
  if (existing) {
    if (existing.state === "done") return { proceed: false, result: existing.result };
    return { proceed: false, inFlight: true };
  }
  seen.set(clientOrderId, { state: "in_flight", at: now });
  return { proceed: true };
}

/** Record the final result for a claimed clientOrderId so repeats echo it instead of re-firing. */
export function settleManualOrder(clientOrderId: string, result: ManualOrderResult, now = Date.now()): void {
  seen.set(clientOrderId, { state: "done", at: now, result });
}

/** Release a claim that failed BEFORE any broker order was sent, so the user can legitimately retry. */
export function releaseManualOrder(clientOrderId: string): void {
  const e = seen.get(clientOrderId);
  if (e && e.state === "in_flight") seen.delete(clientOrderId);
}
