/**
 * Per-ticker+side order flight state — STALLED on AAPL:BUY must not block MSFT or AAPL:SELL.
 */
import {
  createClientOrderId,
  type ManualOrderIntent,
  type ManualOrderSide,
  type OrderFlightPhase,
} from "@/lib/manualOrderContract";

export interface OrderFlightRecord {
  phase: OrderFlightPhase;
  clientOrderId: string;
}

const flights = new Map<string, OrderFlightRecord>();

export function orderFlightKey(ticker: string, side: ManualOrderSide): string {
  return `${ticker.toUpperCase()}:${side}`;
}

export function intentToSide(intent: ManualOrderIntent): ManualOrderSide {
  return intent === "open_long" || intent === "close_short" ? "BUY" : "SELL";
}

export function getFlight(ticker: string, side: ManualOrderSide): OrderFlightRecord | undefined {
  return flights.get(orderFlightKey(ticker, side));
}

export function isSideBlocked(ticker: string, side: ManualOrderSide): boolean {
  const f = getFlight(ticker, side);
  return f?.phase === "stalled" || f?.phase === "inflight";
}

export function getBlockedSides(ticker: string): { buy: boolean; sell: boolean } {
  return {
    buy: isSideBlocked(ticker, "BUY"),
    sell: isSideBlocked(ticker, "SELL"),
  };
}

/** Mint or reuse clientOrderId for this ticker+side flight */
export function beginFlight(ticker: string, side: ManualOrderSide): string {
  const key = orderFlightKey(ticker, side);
  const existing = flights.get(key);
  if (existing?.clientOrderId) {
    flights.set(key, { ...existing, phase: "inflight" });
    return existing.clientOrderId;
  }
  const clientOrderId = createClientOrderId();
  flights.set(key, { phase: "inflight", clientOrderId });
  return clientOrderId;
}

export function setFlightPhase(ticker: string, side: ManualOrderSide, phase: OrderFlightPhase) {
  const key = orderFlightKey(ticker, side);
  const existing = flights.get(key);
  if (!existing) return;
  flights.set(key, { ...existing, phase });
}

export function clearFlight(ticker: string, side: ManualOrderSide) {
  flights.delete(orderFlightKey(ticker, side));
}
