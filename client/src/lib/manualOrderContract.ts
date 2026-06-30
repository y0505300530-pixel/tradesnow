/**
 * UI contract for liveEngine.placeManualOrder — mirror for Claude's tRPC merge.
 * Cursor wires UI against these types only; no direct ibkr.placeMarketOrder from new flows.
 */

export type ManualOrderIntent =
  | "open_long"
  | "close_long"
  | "open_short"
  | "close_short";

export type ManualOrderSide = "BUY" | "SELL";

export interface PlaceManualOrderInput {
  ticker: string;
  side: ManualOrderSide;
  intent: ManualOrderIntent;
  quantity: number;
  /** Idempotency key — one UUID per submit attempt; server dedupes duplicates */
  clientOrderId: string;
  orderType?: "MKT" | "LMT";
  slippagePct?: number;
  sl?: number | null;
  tp?: number | null;
}

export interface PlaceManualOrderResult {
  success: boolean;
  orderId: string | null;
  ticker: string;
  side: ManualOrderSide;
  quantity: number;
  orderType: string;
  reason?: string | null;
  ibkrMessage?: string | null;
  clientOrderId?: string | null;
}

export type OrderEventPhase =
  | "submitting"
  | "pending"
  | "partial_fill"
  | "filled"
  | "syncing_db"
  | "complete"
  | "rejected"
  | "cancelled"
  | "stalled";

export function intentLabelHe(intent: ManualOrderIntent): string {
  switch (intent) {
    case "open_long": return "קניית לונג";
    case "close_long": return "מכירת לונג";
    case "open_short": return "פתיחת שורט";
    case "close_short": return "כיסוי שורט";
  }
}

export function intentToSide(intent: ManualOrderIntent): ManualOrderSide {
  return intent === "open_long" || intent === "close_short" ? "BUY" : "SELL";
}

/** One idempotency key per network submit — mint at send time, not dialog open */
export type OrderFlightPhase = "idle" | "inflight" | "stalled";

export const HOLD_TO_LIQUIDATE_MS = 600;

/** True when live price is safe for qty = floor(amount / price) presets */
export function isValidLivePrice(px: number | null | undefined): px is number {
  return typeof px === "number" && px > 0 && Number.isFinite(px);
}

/** One idempotency key per order submit — server must dedupe on this field */
export function createClientOrderId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `co-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/** Persist return path for Deep Analysis close navigation */
export function saveReturnTo(path: string) {
  try {
    sessionStorage.setItem("da_returnTo", path);
  } catch { /* ignore */ }
}

export function consumeReturnTo(fallback = "/catalogue"): string {
  try {
    const v = sessionStorage.getItem("da_returnTo");
    if (v) {
      sessionStorage.removeItem("da_returnTo");
      return v;
    }
  } catch { /* ignore */ }
  return fallback;
}
