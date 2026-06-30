/**
 * SL/TP coverage badge — longs use SELL orders, shorts use BUY (cover) orders.
 */

function fmtPrice(n: number, dec = 2): string {
  return `$${n.toFixed(dec)}`;
}

function orderSide(o: Record<string, unknown>): string {
  return String(o.side ?? o.buySell ?? o.action ?? "").toUpperCase();
}

function isBuySide(side: string): boolean {
  return side.startsWith("B");
}

function isSellSide(side: string): boolean {
  return side.startsWith("S");
}

function matchSlTpOrders(
  ibkrOrders: Record<string, unknown>[],
  ticker: string,
  type: "SL" | "TP",
  direction: "long" | "short",
): Record<string, unknown>[] {
  const tickerUp = ticker.toUpperCase();
  return ibkrOrders.filter((o) => {
    const sym = String(o.ticker ?? o.description1 ?? o.symbol ?? "").toUpperCase();
    const rawType = String(o.orderType ?? "").toUpperCase().trim();
    const side = orderSide(o);
    const isCovering = direction === "short" ? isBuySide(side) : isSellSide(side);
    const isType = type === "SL"
      ? (rawType === "STP" || rawType === "STOP" || rawType === "STOP_LIMIT" || rawType.startsWith("STOP") || rawType.startsWith("TRAIL"))
      : (rawType === "LMT" || rawType === "LIMIT");
    const isActive = o.status === "PreSubmitted" || o.status === "Submitted";
    return (sym === tickerUp || sym.replace(/\.TA$/, "") === tickerUp.replace(/\.TA$/, "")) && isType && isCovering && isActive;
  });
}

/** True when IBKR live orders (or DB order id fallback) cover SL/TP for a position. */
export function isPositionSlTpCovered(
  position: {
    ticker: string;
    units: number;
    ibkrSlOrderId?: string | null;
    ibkrTpOrderId?: string | null;
    direction?: "long" | "short";
  },
  ibkrOrders: Record<string, unknown>[],
  type: "SL" | "TP",
): boolean {
  const direction = position.direction ?? "long";
  const ibkrOrderId = type === "SL" ? position.ibkrSlOrderId : position.ibkrTpOrderId;
  const match = matchSlTpOrders(ibkrOrders, position.ticker, type, direction);
  const found = match.length > 0;
  const qtyOk = found && match.some((o) => Math.abs(Number(o.qty ?? o.totalSize ?? 0) - position.units) < 0.5);
  const synced = found && qtyOk;
  const dbConfirmed = !found && !!ibkrOrderId;
  return synced || dbConfirmed;
}

export function SlTpBadge({
  label,
  ibkrOrders,
  ticker,
  units,
  type,
  ibkrOrderId,
  direction = "long",
}: {
  label: "SL" | "TP";
  ibkrOrders: Record<string, unknown>[];
  ticker: string;
  units: number;
  type: "SL" | "TP";
  ibkrOrderId?: string | null;
  direction?: "long" | "short";
}) {
  const match = matchSlTpOrders(ibkrOrders, ticker, type, direction);

  const found = match.length > 0;
  const qtyOk = found && match.some((o) => Math.abs(Number(o.qty ?? o.totalSize ?? 0) - units) < 0.5);
  const synced = found && qtyOk;
  const dbConfirmed = !found && !!ibkrOrderId;
  const shortHint = direction === "short" ? " (BUY)" : "";

  if (synced) {
    const raw = match[0];
    const v = parseFloat(String(raw?.auxPrice ?? raw?.price ?? raw?.lmtPrice ?? 0)) || 0;
    return (
      <div className="flex flex-col items-end gap-0.5" title={`${label}${shortHint} מכוסה ב-IBKR`}>
        <span className="text-green-700 font-bold text-sm">✅</span>
        <span className="text-xs font-mono font-semibold text-green-700">
          {v > 0 ? fmtPrice(v, 2) : "MKT"}
        </span>
        {direction === "short" && (
          <span className="text-[8px] font-mono text-blue-600">BUY</span>
        )}
      </div>
    );
  }

  if (dbConfirmed) {
    return (
      <div className="flex flex-col items-end gap-0.5" title={`${label}${shortHint} — DB confirmed`}>
        <span className="text-green-700 font-bold text-sm">✅</span>
        <span className="text-xs font-mono font-semibold text-green-700">#{ibkrOrderId}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-0.5" title={`${label}${shortHint} חסר`}>
      <span className="text-red-500 font-bold text-sm">✗</span>
      {found && !qtyOk && <span className="text-xs font-mono text-amber-600">qty?</span>}
      {!found && <span className="text-xs font-mono text-slate-600">missing</span>}
      {direction === "short" && !found && (
        <span className="text-[8px] font-mono text-blue-500">BUY?</span>
      )}
    </div>
  );
}
