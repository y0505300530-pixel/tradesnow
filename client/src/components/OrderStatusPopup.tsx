/**
 * Order Event Manager — 7-state popup after manual / live orders.
 * submitting → pending → partial → filled → syncing → complete (+ stalled/rejected)
 */
import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, XCircle, Clock, Edit3, Trash2, AlertTriangle, Info, ExternalLink, Shield, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Z } from "@/lib/zIndex";
import {
  type OrderEventPhase,
  ORDER_EVENT_STEPS,
  isTerminalPhase,
  phaseLabelHe,
  stepIndex,
  mapIbkrToPhase,
} from "@/lib/orderEventManager";

function friendlyApiError(message: string): string {
  if (message.includes("Unexpected token") || message.includes("<html"))
    return "שגיאת תקשורת עם השרת — נסה שוב בעוד כמה שניות";
  if (/too many requests/i.test(message))
    return "יותר מדי בקשות — המתן רגע ונסה שוב";
  return message;
}

const STALLED_MS = 25_000;
const IBKR_PORTAL_URL = "https://www.interactivebrokers.com/portal";
const STALLED_BODY =
  "ייתכן שההזמנה כן בוצעה — בדוק ב-IBKR לפני שליחה חוזרת. אל תלחץ שוב על BUY/SELL עד שתאמת.";

export interface OrderProtection {
  stopLoss?: number | null;
  takeProfit?: number | null;
  /** true only when SL/TP came from server response (not dialog estimate) */
  verified?: boolean;
}

interface OrderStatusPopupProps {
  open: boolean;
  onClose: () => void;
  orderId: string | null;
  ticker: string;
  side: "BUY" | "SELL";
  quantity: number;
  orderType?: string;
  sentAt?: Date;
  intentLabel?: string | null;
  estimatedValueUsd?: number | null;
  clientOrderId?: string | null;
  immediateStatus?: "success" | "failed" | null;
  ibkrMessage?: string | null;
  trackPositionClose?: boolean;
  onComplete?: () => void;
  onCloseWithOutcome?: (outcome: "stalled" | "terminal" | "dismissed") => void;
  executionDetails?: {
    exitPrice?: number;
    realizedPnl?: number;
    realizedPnlPct?: number;
    entryPrice?: number;
    allocatedCapital?: number;
    stopLoss?: number;
    takeProfit?: number;
  } | null;
  /** SL/TP applied by server after entry fill */
  protection?: OrderProtection | null;
}

function PhaseStepper({ phase }: { phase: OrderEventPhase }) {
  if (phase === "stalled" || phase === "rejected" || phase === "cancelled") return null;
  const active = stepIndex(phase);
  const labels = ["שליחה", "ממתין", "חלקי", "בוצע", "סנכרון", "סיום"];
  return (
    <div className="flex items-center justify-between gap-0.5 px-1" aria-label="התקדמות פקודה">
      {ORDER_EVENT_STEPS.map((step, i) => {
        const done = i < active;
        const current = i === active;
        return (
          <div key={step} className="flex flex-col items-center flex-1 min-w-0">
            <div
              className={`rounded-full mb-0.5 shrink-0 ${
                done ? "w-2 h-2 bg-emerald-500" : current ? "w-2.5 h-2.5 bg-amber-500 animate-pulse" : "w-2 h-2 bg-slate-300"
              }`}
              title={labels[i]}
            />
            <span
              className={`truncate w-full text-center leading-tight ${
                current
                  ? "text-[9px] sm:text-[9px] font-bold text-amber-800"
                  : `hidden sm:inline text-[9px] ${done ? "text-emerald-700" : "text-slate-400"}`
              }`}
            >
              {labels[i]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function OrderStatusPopup({
  open,
  onClose,
  orderId,
  ticker,
  side,
  quantity,
  orderType = "MKT",
  sentAt,
  intentLabel,
  estimatedValueUsd,
  clientOrderId,
  immediateStatus,
  ibkrMessage,
  trackPositionClose = false,
  onComplete,
  onCloseWithOutcome,
  executionDetails,
  protection,
}: OrderStatusPopupProps) {
  const [phase, setPhase] = useState<OrderEventPhase>("submitting");
  const [orderDetails, setOrderDetails] = useState<Record<string, unknown> | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [newPrice, setNewPrice] = useState("");
  const [pollCount, setPollCount] = useState(0);
  const [exitDone, setExitDone] = useState(false);
  const [liveIbkrMessage, setLiveIbkrMessage] = useState<string | null>(ibkrMessage ?? null);

  const sl = protection?.verified ? protection.stopLoss : undefined;
  const tp = protection?.verified ? protection.takeProfit : undefined;
  const showProtection =
    protection?.verified === true
    && (phase === "filled" || phase === "syncing" || phase === "complete")
    && sl != null && tp != null && sl > 0 && tp > 0;

  const awaitingProtectionVerify =
    !protection?.verified
    && (phase === "filled" || phase === "syncing")
    && !trackPositionClose;

  useEffect(() => {
    if (!open) return;
    if (immediateStatus === "failed") {
      setPhase("rejected");
      if (ibkrMessage) setLiveIbkrMessage(ibkrMessage);
    } else if (immediateStatus === "success") {
      setPhase("filled");
    }
  }, [open, immediateStatus, ibkrMessage]);

  const exitProgressQuery = trpc.liveEngine.getExitProgress.useQuery(
    { ticker, orderId: orderId ?? undefined },
    {
      enabled: open && trackPositionClose && !exitDone,
      refetchInterval: 2000,
      refetchIntervalInBackground: false,
      retry: (count, err) => {
        if (count >= 3) return false;
        const msg = err.message ?? "";
        return msg.includes("Unexpected token") || msg.includes("<html");
      },
    }
  );

  useEffect(() => {
    if (!exitProgressQuery.data || !trackPositionClose) return;
    const d = exitProgressQuery.data;
    if (d.ibkrMessage) setLiveIbkrMessage(d.ibkrMessage);
    if (d.avgPrice && d.orderStatus === "filled") {
      setOrderDetails((prev) => ({ ...prev, avgPrice: d.avgPrice }));
    }
    if (d.orderStatus === "rejected" || d.orderStatus === "cancelled") {
      setPhase(d.orderStatus === "cancelled" ? "cancelled" : "rejected");
    } else if (d.done) {
      setPhase("complete");
      setExitDone(true);
      onComplete?.();
    } else if (d.orderStatus === "filled" || d.orderStatus === "filled_or_gone") {
      setPhase(d.dbOpen ? "syncing" : "filled");
    } else if (d.orderFound || d.orderStatus === "pending") {
      setPhase("pending");
    } else if (phase === "submitting") {
      setPhase("pending");
    }
  }, [exitProgressQuery.data, trackPositionClose, onComplete, phase]);

  const statusQuery = trpc.ibkr.getOrderStatus.useQuery(
    { orderId: orderId ?? "" },
    {
      enabled: open && !!orderId && !isTerminalPhase(phase) && phase !== "stalled" && !immediateStatus,
      refetchInterval: 3000,
      refetchIntervalInBackground: false,
    }
  );

  useEffect(() => {
    if (!statusQuery.data) return;
    setPollCount((c) => c + 1);
    if (statusQuery.data.found && statusQuery.data.order) {
      setOrderDetails(statusQuery.data.order);
      const o = statusQuery.data.order;
      const filledQty = Number(o.filledQty ?? 0);
      const mapped = mapIbkrToPhase(statusQuery.data.status, filledQty, quantity);
      setPhase(mapped);
    } else if (!statusQuery.data.found && statusQuery.data.status === "filled_or_cancelled") {
      if (orderType === "MKT" || pollCount >= 2) {
        setPhase("filled");
      }
    }
  }, [statusQuery.data, orderType, pollCount, quantity]);

  // filled → syncing → complete (opens — longer pause if server verified SL/TP)
  useEffect(() => {
    if (!open || trackPositionClose || immediateStatus) return;
    if (phase !== "filled") return;
    const delay = showProtection ? 2000 : 800;
    setPhase("syncing");
    const t = setTimeout(() => setPhase("complete"), delay);
    return () => clearTimeout(t);
  }, [open, phase, trackPositionClose, immediateStatus, showProtection]);

  const pollError = exitProgressQuery.error?.message ?? statusQuery.error?.message ?? null;

  const handlePopupClose = useCallback((outcome: "stalled" | "terminal" | "dismissed") => {
    onCloseWithOutcome?.(outcome);
    onClose();
  }, [onClose, onCloseWithOutcome]);

  const isStalled = phase === "stalled";
  const isTerminal = isTerminalPhase(phase);
  const inFlight = phase === "submitting" || phase === "pending" || phase === "partial" || phase === "syncing";
  // Soft hint only: while still tracking a position-close fill we *prefer* the user
  // waits, but this NEVER blocks dismissal. Protection-sync ("מסנכרן הגנה") runs in
  // the background — the order is already at IBKR, so the UI must never trap.
  const stillTracking = trackPositionClose && !exitDone && inFlight && immediateStatus !== "failed";

  // Single source of truth for "how did this close" — used by every dismiss path.
  const dismissOutcome = (): "stalled" | "terminal" | "dismissed" =>
    isStalled ? "stalled" : isTerminal ? "terminal" : "dismissed";

  useEffect(() => {
    if (!open || immediateStatus || isStalled || isTerminal) return;
    if (phase !== "submitting" && phase !== "pending") return;
    const timer = setTimeout(() => setPhase("stalled"), STALLED_MS);
    return () => clearTimeout(timer);
  }, [open, immediateStatus, isStalled, isTerminal, phase]);

  const cancelMut = trpc.ibkr.cancelGenericOrder.useMutation({
    onSuccess: () => {
      toast.success("✅ הפקודה בוטלה");
      setPhase("cancelled");
    },
    onError: (e) => toast.error(`שגיאה בביטול: ${e.message}`),
  });

  const modifyMut = trpc.ibkr.modifyOrderPrice.useMutation({
    onSuccess: (data) => {
      toast.success(`✅ המחיר עודכן ל-$${data.newPrice}`);
      setEditMode(false);
    },
    onError: (e) => toast.error(`שגיאה בעדכון: ${e.message}`),
  });

  const handleCancel = useCallback(() => {
    if (orderId) cancelMut.mutate({ orderId });
  }, [orderId, cancelMut]);

  const handleModify = useCallback(() => {
    if (!orderId || !newPrice) return;
    const price = parseFloat(newPrice);
    if (isNaN(price) || price <= 0) {
      toast.error("מחיר לא תקין");
      return;
    }
    const oType = String(orderDetails?.orderType ?? "").toUpperCase().includes("STP") ? "STP" : "LMT";
    modifyMut.mutate({ orderId, newPrice: price, orderType: oType as "LMT" | "STP" });
  }, [orderId, newPrice, orderDetails, modifyMut]);

  useEffect(() => {
    if (open) {
      setPhase(orderId ? "pending" : "submitting");
      setOrderDetails(null);
      setEditMode(false);
      setNewPrice("");
      setPollCount(0);
      setExitDone(false);
      setLiveIbkrMessage(ibkrMessage ?? null);
      if (immediateStatus === "success") setPhase("filled");
      if (immediateStatus === "failed") setPhase("rejected");
    }
  }, [open, orderId, immediateStatus, ibkrMessage]);

  const exitPhaseLabel = trackPositionClose && exitProgressQuery.data
    ? exitProgressQuery.data.done
      ? "✅ הפוזיציה נסגרה — הנייר הוסר"
      : exitProgressQuery.data.orderStatus === "filled"
        ? "פקודה בוצעה — ממתין לסנכרון..."
        : exitProgressQuery.data.dbOpen
          ? `ממתין ל-IBKR... (DB: ${exitProgressQuery.data.dbStatus ?? "open"})`
          : exitProgressQuery.data.ibkrQty
            ? `ממתין לסגירה ב-IBKR (${exitProgressQuery.data.ibkrQty} מניות)`
            : "שולח פקודה ל-IBKR..."
    : null;

  const statusIcon = phase === "complete" || phase === "filled" ? <CheckCircle2 className="h-6 w-6 text-emerald-500" />
    : phase === "stalled" ? <AlertTriangle className="h-6 w-6 text-orange-500" />
    : phase === "cancelled" || phase === "rejected" ? <XCircle className="h-6 w-6 text-red-500" />
    : <Clock className="h-6 w-6 text-amber-500 animate-pulse" />;

  const statusColor = phase === "complete" || phase === "filled" ? "bg-emerald-100 text-emerald-800 border-emerald-300"
    : phase === "syncing" ? "bg-blue-100 text-blue-800 border-blue-300"
    : phase === "partial" ? "bg-violet-100 text-violet-800 border-violet-300"
    : phase === "stalled" ? "bg-orange-100 text-orange-900 border-orange-400"
    : phase === "cancelled" || phase === "rejected" ? "bg-red-100 text-red-800 border-red-300"
    : "bg-amber-100 text-amber-800 border-amber-300";

  return (
    <Dialog open={open} onOpenChange={(v) => {
      // ALWAYS-FUNCTIONAL dismiss: Escape, backdrop, and the Radix close path all
      // route here. Never `return` early — the user must be able to leave at any
      // phase, including a hung "מסנכרן הגנה" / "ממתין" sync state.
      if (!v) handlePopupClose(dismissOutcome());
    }}>
      <DialogContent
        className="sm:max-w-md"
        style={{ zIndex: Z.orderEvent }}
        // Backdrop click + Escape are never prevented — dismissal is unconditional.
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg pr-9">
            {statusIcon}
            <span className="text-[13px] sm:text-lg font-semibold">
              {intentLabel ? `${intentLabel} — ` : "ניהול אירוע — "}{ticker}
            </span>
          </DialogTitle>
          {/* Always-rendered, never-disabled force close. ≥44px touch target, WCAG-AA. */}
          <button
            type="button"
            aria-label="סגור חלון"
            onClick={() => handlePopupClose(dismissOutcome())}
            className="absolute top-2.5 left-2.5 flex h-11 w-11 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 active:bg-slate-200"
          >
            <X className="h-5 w-5" strokeWidth={2.5} />
          </button>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <PhaseStepper phase={phase} />

          <div className="flex justify-center">
            <Badge variant="outline" className={`text-base px-4 py-1.5 font-bold border-2 ${statusColor}`}>
              {phaseLabelHe(phase)}
            </Badge>
          </div>

          {awaitingProtectionVerify && !showProtection && (
            <div className="rounded-lg p-2.5 border border-zinc-200 bg-zinc-50/80 text-[11px] text-zinc-500 flex items-start gap-2">
              <Loader2 className="h-3.5 w-3.5 shrink-0 mt-0.5 animate-spin text-zinc-400" />
              <p className="leading-snug">ממתין לאימות SL/TP מהשרת — בדוק ב-IBKR אם לא מתעדכן.</p>
            </div>
          )}

          {showProtection && (
            <div className="rounded-lg p-3.5 border-2 border-emerald-500 bg-emerald-500/15 text-sm text-emerald-950 flex items-start gap-2 shadow-sm ring-1 ring-emerald-500/20">
              <Shield className="h-5 w-5 shrink-0 mt-0.5 text-emerald-600" />
              <p className="font-semibold leading-snug text-[13px] sm:text-sm">
                ✅ {ticker} מוגן — SL ${Number(sl).toFixed(2)} · TP ${Number(tp).toFixed(2)}
              </p>
            </div>
          )}

          {exitPhaseLabel && (
            <div className="text-center text-sm text-slate-600 bg-slate-50 rounded-lg py-2 px-3 border border-slate-200">
              {exitProgressQuery.isFetching && !exitDone && (
                <Loader2 className="inline w-4 h-4 animate-spin mr-1 align-middle" />
              )}
              {exitPhaseLabel}
            </div>
          )}

          {phase === "stalled" && (
            <div className="rounded-lg p-3 border bg-orange-50 border-orange-300 text-sm text-orange-900">
              <p className="font-semibold mb-1">{phaseLabelHe("stalled")}</p>
              <p className="text-[11px] leading-snug">{STALLED_BODY}</p>
            </div>
          )}

          {pollError && (
            <div className="rounded-lg p-3 border bg-amber-50 border-amber-200 text-sm text-amber-800">
              {friendlyApiError(pollError)}
            </div>
          )}

          {(liveIbkrMessage || ibkrMessage) && (
            <div className={`rounded-lg p-3 border ${phase === "rejected" ? "bg-red-50 border-red-200" : "bg-blue-50 border-blue-200"}`}>
              <div className="flex items-start gap-2">
                {phase === "rejected" ? (
                  <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                ) : (
                  <Info className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
                )}
                <div>
                  <p className="text-xs font-semibold text-gray-600 mb-1">סטטוס IBKR:</p>
                  <p className={`text-sm font-medium ${phase === "rejected" ? "text-red-700" : "text-blue-700"}`}>
                    {liveIbkrMessage || ibkrMessage}
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 text-sm bg-gray-50 dark:bg-gray-900 rounded-lg p-4">
            <div>
              <span className="text-gray-500 text-xs">טיקר</span>
              <p className="font-bold text-base">{ticker}</p>
            </div>
            <div>
              <span className="text-gray-500 text-xs">כיוון</span>
              <p className={`font-bold text-base ${side === "BUY" ? "text-emerald-600" : "text-red-600"}`}>
                {side === "BUY" ? "🟢 קנייה" : "🔴 מכירה"}
              </p>
            </div>
            <div>
              <span className="text-gray-500 text-[11px]">כמות</span>
              <p className="font-bold text-base">
                {quantity}
                {orderDetails?.filledQty != null && Number(orderDetails.filledQty) > 0
                  && Number(orderDetails.filledQty) < quantity
                  ? ` / ${orderDetails.filledQty}` : ""}
              </p>
            </div>
            {estimatedValueUsd != null && estimatedValueUsd > 0 && (
              <div>
                <span className="text-gray-500 text-[11px]">שווי משוער</span>
                <p className="font-bold text-base">${estimatedValueUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}</p>
              </div>
            )}
            <div>
              <span className="text-gray-500 text-xs">סוג פקודה</span>
              <p className="font-bold text-base">{orderType}</p>
            </div>
            {orderId && (
              <div className="col-span-2">
                <span className="text-gray-500 text-xs">Order ID</span>
                <p className="font-mono text-xs">{orderId}</p>
              </div>
            )}
            {clientOrderId && (
              <div className="col-span-2">
                <span className="text-gray-500 text-xs">Client Order ID</span>
                <p className="font-mono text-[10px] break-all">{clientOrderId}</p>
              </div>
            )}
            {sentAt instanceof Date && (
              <div className="col-span-2">
                <span className="text-gray-500 text-xs">זמן שליחה</span>
                <p className="text-xs">{sentAt.toLocaleTimeString("he-IL")}</p>
              </div>
            )}
            {(phase === "filled" || phase === "complete") && orderDetails?.avgPrice != null && (
              <div className="col-span-2 bg-emerald-50 rounded p-2">
                <span className="text-gray-500 text-xs">שער ביצוע</span>
                <p className="font-bold text-lg text-emerald-700">${Number(orderDetails.avgPrice).toFixed(2)}</p>
              </div>
            )}
            {executionDetails && (phase === "filled" || phase === "complete") && (
              <>
                {executionDetails.realizedPnl != null && (
                  <div>
                    <span className="text-gray-500 text-xs">P&L</span>
                    <p className={`font-bold ${executionDetails.realizedPnl >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                      ${executionDetails.realizedPnl.toFixed(2)}
                    </p>
                  </div>
                )}
              </>
            )}
            {phase === "pending" && orderDetails && (
              <>
                {orderDetails.limitPrice != null && (
                  <div>
                    <span className="text-gray-500 text-xs">Limit Price</span>
                    <p className="font-bold">${Number(orderDetails.limitPrice).toFixed(2)}</p>
                  </div>
                )}
                {orderDetails.filledQty != null && Number(orderDetails.filledQty) > 0 && (
                  <div>
                    <span className="text-gray-500 text-xs">מולא חלקית</span>
                    <p className="font-bold">{String(orderDetails.filledQty)} / {quantity}</p>
                  </div>
                )}
              </>
            )}
          </div>

          {phase === "pending" && editMode && (
            <div className="flex gap-2 items-center">
              <Input type="number" step="0.01" placeholder="מחיר חדש" value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)} className="flex-1" />
              <Button size="sm" onClick={handleModify} disabled={modifyMut.isPending}>
                {modifyMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "עדכן"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditMode(false)}>ביטול</Button>
            </div>
          )}
        </div>

        <DialogFooter className="flex gap-2">
          {phase === "stalled" && (
            <Button
              variant="default"
              className="min-h-[44px] text-[11px] sm:text-sm gap-1.5 flex-1 bg-orange-600 hover:bg-orange-700"
              onClick={() => {
                window.open(IBKR_PORTAL_URL, "_blank", "noopener,noreferrer");
                handlePopupClose("stalled");
              }}
            >
              <ExternalLink className="h-4 w-4" />
              סגור / בדוק ב-IBKR
            </Button>
          )}
          {phase === "pending" && !immediateStatus && !trackPositionClose && (
            <>
              <Button variant="outline" size="sm" onClick={() => setEditMode(!editMode)} disabled={!orderId}>
                <Edit3 className="h-4 w-4 mr-1" /> ערוך מחיר
              </Button>
              <Button variant="destructive" size="sm" onClick={handleCancel}
                disabled={cancelMut.isPending || !orderId}>
                {cancelMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4 mr-1" />}
                בטל פקודה
              </Button>
            </>
          )}
          {phase !== "stalled" && (
            <Button
              variant="default"
              className="min-h-[44px] text-[11px] sm:text-sm"
              onClick={() => handlePopupClose(dismissOutcome())}
            >
              {exitDone || phase === "complete"
                ? "סיום"
                : stillTracking
                  ? "סגור (הסנכרון ימשיך ברקע)"
                  : "סגור"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
