/**
 * liveMarketOrder.ts — shared live-order helpers (Marketable LMT, fill resolution, closes)
 */
import { ibindRequest } from "./routers/ibkrProxy";
import { fetchIbkrLivePricesBatch } from "./marketData";

export const MARKETABLE_LMT_OFFSET = 0.0075; // 0.75% — Section 5 iron rule

export function calcMarketableLmtPrice(side: "BUY" | "SELL", livePrice: number): number {
  return side === "SELL"
    ? +(livePrice * (1 - MARKETABLE_LMT_OFFSET)).toFixed(2)
    : +(livePrice * (1 + MARKETABLE_LMT_OFFSET)).toFixed(2);
}

export async function fetchTickerLivePrice(ticker: string): Promise<number> {
  try {
    // REPOINT 2026-06-25: /iserver/marketdata/snapshot 404s on the OAuth gateway.
    // Source live price from the working POST /quotes pipeline (IBKR broker truth; returns
    // a LivePrice → use .price). On failure / 0 price → return 0 (caller blocks the close
    // with "No live price" — never prices a live close off stale EOD).
    const priceMap = await fetchIbkrLivePricesBatch([ticker], { skipCache: true });
    const lp = priceMap.get(ticker) ?? null;
    // QA fix #2: accept ONLY real-time IBKR truth for live-close pricing. A silent Yahoo/DB-cache
    // fallback (source!=='ibkr') returns 0 → caller blocks the close ("No live price") and never
    // prices a live close off a delayed/stale print.
    return (lp?.source === 'ibkr' ? Number(lp.price ?? 0) : 0) || 0;
  } catch {
    return 0;
  }
}

export interface OrderFillInfo {
  status: "filled" | "partial" | "pending" | "cancelled" | "unknown";
  filledQty: number;
  avgPrice: number | null;
  remainingQty: number;
}

export async function resolveOrderFill(orderId: string, requestedQty: number): Promise<OrderFillInfo> {
  const empty: OrderFillInfo = { status: "unknown", filledQty: 0, avgPrice: null, remainingQty: requestedQty };
  if (!orderId) return empty;
  try {
    const res = await ibindRequest("GET", "/orders");
    if (!res.ok) return empty;
    const orders: any[] = (res.body as any)?.orders ?? [];
    const match = orders.find((o: any) =>
      String(o.orderId ?? o.order_id ?? "") === String(orderId)
    );
    if (!match) {
      // Not in live list — assume filled (IBKR removes filled orders)
      return { status: "filled", filledQty: requestedQty, avgPrice: null, remainingQty: 0 };
    }
    const statusRaw = String(match.status ?? match.orderStatus ?? "").toLowerCase();
    const filledQty = Number(match.filledQuantity ?? match.filled_qty ?? 0) || 0;
    const totalQty = Number(match.totalSize ?? match.quantity ?? requestedQty) || requestedQty;
    const avgPrice = match.avgPrice ?? match.filled_price ?? match.avgFillPrice ?? null;
    if (statusRaw.includes("cancel") || statusRaw.includes("reject")) {
      return { status: "cancelled", filledQty, avgPrice: avgPrice ? Number(avgPrice) : null, remainingQty: totalQty - filledQty };
    }
    if (statusRaw.includes("fill") || filledQty >= totalQty) {
      return { status: "filled", filledQty: filledQty || totalQty, avgPrice: avgPrice ? Number(avgPrice) : null, remainingQty: 0 };
    }
    if (filledQty > 0) {
      return { status: "partial", filledQty, avgPrice: avgPrice ? Number(avgPrice) : null, remainingQty: totalQty - filledQty };
    }
    return { status: "pending", filledQty: 0, avgPrice: null, remainingQty: totalQty };
  } catch {
    return empty;
  }
}

/**
 * fetchExitFillFromTrades — last-resort exit-price capture via the gateway /trades
 * (execution) feed. When a protective order FILLS and then DISAPPEARS from /orders,
 * resolveOrderFill returns avgPrice=null (the order is gone), which used to leave the
 * close priced off a stale currentPrice → CLOSED_IBKR_NO_PRICE / fabricated $0 P&L
 * (today's MU loss). /iserver/account/trades still carries the execution avgPrice for
 * the session, so we recover it here.
 *
 * Matches the most recent SELL/BUY-cover execution for the ticker on the exit side.
 * Returns null on any uncertainty (no match, gateway not-ok, throw) → caller keeps its
 * existing fallback/CLOSED_IBKR_NO_PRICE behavior (never fabricate a price). Pure-ish:
 * accepts `injectedTrades` for deterministic tests.
 */
export async function fetchExitFillFromTrades(
  ticker: string,
  isShort: boolean,
  injectedTrades?: any[] | null,
): Promise<number | null> {
  const sym = ticker.toUpperCase().trim();
  // Exit side: long closes via SELL, short covers via BUY.
  const wantBuy = isShort;
  let trades: any[];
  try {
    if (injectedTrades != null) {
      trades = injectedTrades;
    } else {
      const r = await ibindRequest("GET", "/api/proxy/iserver/account/trades");
      if (!r.ok) return null;
      trades = (r.body as any[]) ?? [];
    }
  } catch {
    return null;
  }
  const matches = trades.filter((t: any) => {
    const tSym = String(t.symbol ?? t.ticker ?? t.conidex ?? "").toUpperCase();
    if (!tSym.includes(sym)) return false;
    const side = String(t.side ?? t.buy_sell ?? "").toUpperCase();
    return wantBuy ? side.startsWith("B") : side.startsWith("S");
  });
  if (matches.length === 0) return null;
  // Most recent execution by trade_time ("YYYYMMDD-HH:MM:SS"); fall back to array order.
  matches.sort((a: any, b: any) =>
    String(b.trade_time ?? "").localeCompare(String(a.trade_time ?? "")));
  const px = Number(matches[0].price ?? matches[0].avgPrice ?? matches[0].avg_price ?? 0);
  return px > 0 ? px : null;
}

/** Poll IBKR briefly for entry fill after bracket submission. */
export async function pollEntryFill(orderId: string, requestedQty: number, attempts = 3): Promise<OrderFillInfo> {
  let last = await resolveOrderFill(orderId, requestedQty);
  for (let i = 1; i < attempts && last.status === "pending"; i++) {
    await new Promise(r => setTimeout(r, 2000));
    last = await resolveOrderFill(orderId, requestedQty);
  }
  return last;
}

export async function cancelIbkrBracketsForTicker(accountId: string, ticker: string): Promise<void> {
  const ordRes = await ibindRequest("GET", "/orders");
  const brackets: any[] = ((ordRes.body as any)?.orders ?? []).filter((o: any) =>
    (o.description1 ?? "").toUpperCase() === ticker.toUpperCase() &&
    ["PreSubmitted", "Submitted"].includes(o.status)
  );
  for (const br of brackets) {
    await ibindRequest("DELETE", `/iserver/account/${accountId}/order/${br.orderId}`);
  }
}

export async function placeMarketableLmtClose(params: {
  accountId: string;
  conid: number;
  ticker: string;
  side: "BUY" | "SELL";
  quantity: number;
  livePrice?: number;
  mktPrice?: number;
  mktValue?: number;
}): Promise<{ ok: boolean; error?: string }> {
  const { accountId, conid, ticker, side, quantity } = params;
  if (!accountId) return { ok: false, error: "IBKR_LIVE_ACCOUNT_ID not configured" };

  await cancelIbkrBracketsForTicker(accountId, ticker);

  let livePrice = params.livePrice ?? 0;
  if (livePrice <= 0) livePrice = params.mktPrice ?? 0;
  if (livePrice <= 0 && quantity > 0) livePrice = Math.abs(params.mktValue ?? 0) / quantity;
  if (livePrice <= 0) livePrice = await fetchTickerLivePrice(ticker);
  if (livePrice <= 0) return { ok: false, error: `No live price for ${ticker}` };

  const limitPrice = calcMarketableLmtPrice(side, livePrice);
  const body = {
    conid,
    side,
    quantity,
    orderType: "LMT",
    limitPrice,
    tif: "DAY",
    outsideRth: false,
  };

  const res = await ibindRequest("POST", "/orders/close-position", body, {
    "X-Confirm-Live-Order": "yes",
  });
  const success = res.ok && !!(res.body as any)?.success;
  if (success) return { ok: true };
  return { ok: false, error: String((res.body as any)?.message ?? (res.body as any)?.error ?? `HTTP ${res.status}`) };
}
