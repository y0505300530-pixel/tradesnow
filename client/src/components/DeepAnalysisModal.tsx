/**
 * Shared Deep Analysis Modal — reusable per-asset Ziv Engine analysis modal.
 * Used in both AssetCatalogue and TradeManager (Holdings table).
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import {
  Loader2, RefreshCw, Zap, AlertCircle, ChevronRight, ChevronDown,
  CheckCircle2, XCircle as XCircleIcon, Target, ShieldAlert, Lightbulb, Activity, TrendingUp, ShoppingCart,
  BarChart2, MessageCircle, Send, Bot, User, ShieldOff, TrendingDown, DollarSign, ArrowUpCircle, ArrowDownCircle,
  BookmarkPlus, Check, PlusCircle, ArrowLeft,
} from "lucide-react";
import { consumeReturnTo, isValidLivePrice, intentLabelHe, type ManualOrderIntent, type ManualOrderSide } from "@/lib/manualOrderContract";
import {
  beginFlight, clearFlight, getBlockedSides, getFlight, intentToSide, setFlightPhase,
} from "@/lib/orderFlightRegistry";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toTradingViewSymbol } from "./TradingViewChart";
import { OrderStatusPopup } from "./OrderStatusPopup";
import ErrorBoundary from "./ErrorBoundary";
import { TradingCommandBar } from "./deep-analysis/TradingCommandBar";
import { ManualOrderDialog } from "./deep-analysis/ManualOrderDialog";
import { AdvancedDetails } from "./deep-analysis/AdvancedDetails";
import { DeepAnalysisHeader } from "./deep-analysis/DeepAnalysisHeader";
import { AiAnalysisPanel } from "./deep-analysis/AiAnalysisPanel";
import { AdminSlTpPanel } from "./deep-analysis/AdminSlTpPanel";
import { Z } from "@/lib/zIndex";
import {
  applyPositionMatch,
  fetchIbkrPositionsCached,
  matchTickerPosition,
} from "@/hooks/useIbkrPositions";
import type { DeepAnalysisResult, HoldingContext, PrefetchedZivH } from "./deep-analysis/types";
export type { DeepAnalysisResult, HoldingContext, PrefetchedZivH } from "./deep-analysis/types";
import { ScoreBadge, TierBadge, RecommendationBadge } from "./deep-analysis/badges";
export { ScoreBadge, TierBadge, RecommendationBadge };

// Types & badges re-exported from ./deep-analysis/* (see imports above)

// ─── Main Modal Component ───────────────────────────────────────────────────────────────────────────────
export function DeepAnalysisModal({
  ticker,
  open,
  onClose,
  holdingContext,
  prefetchedZivH,
  conid,
  navList,
  onNavigate,
  portfolioSize,
  pageMode = false,
}: {
  ticker: string | null;
  open: boolean;
  onClose: () => void;
  holdingContext?: HoldingContext;
  /** Pre-computed live ZIV H from War Room getStatus — skips portfolio holdings lookup */
  prefetchedZivH?: PrefetchedZivH | null;
  conid?: number;
  navList?: string[];
  onNavigate?: (ticker: string) => void;
  /** Combined portfolio value (H1 + H2) for accurate position sizing */
  portfolioSize?: number;
  /** When true, renders as a full page (no fixed overlay/backdrop) */
  pageMode?: boolean;
}) {
  const [, navigate] = useLocation();
  const [result, setResult] = useState<DeepAnalysisResult | null>(null);
  // Currency symbol: "$" for US stocks, "₪" for .TA stocks (comes from SSE meta event)
  const cs = result?.currencySymbol ?? "$";
  const csQ = ticker?.toUpperCase().endsWith(".TA") ? "₪" : "$";
  const [buyDialogOpen, setBuyDialogOpen] = useState(false);
  const [buyUnits, setBuyUnits] = useState("");
  const [buyPrice, setBuyPrice] = useState("");
  // SSE streaming state
  const [streamingText, setStreamingText] = useState<string | null>(null); // null = not streaming, "" = streaming started
  const [isStreaming, setIsStreaming] = useState(false);
  const sseRef = useRef<EventSource | null>(null);
  // Quick stats — shown immediately while full analysis loads
  const quickStatsQuery = trpc.portfolio.getQuickStats.useQuery(
    { ticker: ticker ?? "" },
    { enabled: open && !!ticker && !result, staleTime: 30_000 }
  );
  const quickStats = quickStatsQuery.data;

  // Live price polling — updates every 30s after analysis completes so price stays current
  const livePriceQuery = trpc.portfolio.getLivePriceForTicker.useQuery(
    { ticker: ticker ?? "" },
    {
      enabled: open && !!ticker && !!result,
      staleTime: 0,
      refetchInterval: 30_000, // poll every 30 seconds
      refetchIntervalInBackground: false,
    }
  );
  // Merge live price into result display (overrides stale analysis price)
  const livePrice = livePriceQuery.data?.price ?? result?.price ?? 0;
  const liveChangePercent = livePriceQuery.data?.changePercent ?? result?.changePercent ?? 0;

  // ZIV H Health Score
  const zivHQuery = trpc.portfolio.getZivHForTicker.useQuery(
    {
      ticker: ticker ?? "",
      entryPrice: holdingContext?.buyPrice ?? livePrice ?? 0,
      stopLoss: holdingContext?.stopLoss ?? null,
      takeProfit: holdingContext?.takeProfit ?? null,
      units: holdingContext?.units ?? undefined,
    },
    {
      enabled: open && !!ticker && !!result && !!holdingContext && !prefetchedZivH,
      staleTime: 5 * 60_000,
    }
  );
  const zivHData = prefetchedZivH ?? zivHQuery.data;

  const [signalSaved, setSignalSaved] = useState(false);
  const [tvAlertBanner, setTvAlertBanner] = useState<{ ticker: string; price: string } | null>(null);

  const addSignalMut = trpc.masterKnowledge.addSignal.useMutation({
    onSuccess: (data) => {
      setSignalSaved(true);
      const alertNote = data.priceAlertId ? " + התראת מחיר נוצרה" : "";
      toast.success(
        data.isUpdate
          ? `✅ איתות ${result?.ticker} עודכן ב-איתותים פעילים${alertNote}`
          : `✅ איתות ${result?.ticker} נוסף ל-איתותים פעילים${alertNote}`
      );
      setTimeout(() => setSignalSaved(false), 4000);
    },
    onError: (e) => toast.error(`שגיאה: ${e.message}`),
  });

  // ── Signal edit dialog state ───────────────────────────────────────────────────
  const [signalEditOpen, setSignalEditOpen] = useState(false);
  const [signalDraft, setSignalDraft] = useState<{
    ticker: string; company: string; entry: string; stopLoss: string;
    takeProfit: string; catalyst: string; zivScore: number;
  } | null>(null);

  function handleAddSignal() {
    if (!result) return;
    const buyPriceNum = result.recommendedBuyPrice;
    const tp = buyPriceNum > 0 ? (buyPriceNum * 1.15).toFixed(2) : "";
    // Open edit dialog pre-filled with AI values
    setSignalDraft({
      ticker: result.ticker,
      company: result.company,
      entry: buyPriceNum.toFixed(2),
      stopLoss: result.stopLoss.toFixed(2),
      takeProfit: tp,
      catalyst: result.ai.summary?.slice(0, 300) ?? `Ziv Score ${result.score}/10`,
      zivScore: result.score,
    });
    setSignalEditOpen(true);
  }

  function confirmAddSignal() {
    if (!signalDraft) return;
    // 1. Copy JSON payload to clipboard
    const payload = JSON.stringify({ ticker: signalDraft.ticker, action: "BUY", price: signalDraft.entry });
    const ta = document.createElement("textarea"); ta.value = payload;
    document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);

    // 2. Open TradingView chart
    window.open(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(toTradingViewSymbol(signalDraft.ticker))}`, "_blank", "noopener,noreferrer");

    // 3. Show sticky banner
    setTvAlertBanner({ ticker: signalDraft.ticker, price: signalDraft.entry });

    // 4. Save signal to Master Knowledge
    addSignalMut.mutate({
      ticker: signalDraft.ticker,
      company: signalDraft.company,
      entry: `$${signalDraft.entry}`,
      stopLoss: `$${signalDraft.stopLoss}`,
      takeProfit: signalDraft.takeProfit ? `$${signalDraft.takeProfit}` : "",
      catalyst: signalDraft.catalyst,
      source: `Deep Analysis — Ziv Score ${signalDraft.zivScore}/10`,
      signalDate: new Date().toISOString().split("T")[0],
      zivScore: signalDraft.zivScore,
    });
    setSignalEditOpen(false);
  }

  // AI Chat state
  type ChatMsg = { role: "engine" | "user"; text: string };
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // SL execution state
  const [editedSL, setEditedSL] = useState("");
  const [slDialogOpen, setSlDialogOpen] = useState(false);
  const [ibkrAccountId, setIbkrAccountId] = useState<string | null>(null);
  const [ibkrConnected, setIbkrConnected] = useState(false);
  const [ibkrConid, setIbkrConid] = useState<number>(conid ?? 0);
  const [syncConidLoading, setSyncConidLoading] = useState(false);
  // Sync conid when prop changes (e.g. when modal opens for a different holding)
  useEffect(() => { if (conid && conid > 0) setIbkrConid(conid); }, [conid]);
  const [ibkrQty, setIbkrQty] = useState("");

  // TP execution state
  const [editedTP, setEditedTP] = useState("");
  const [tpDialogOpen, setTpDialogOpen] = useState(false);
  const [ibkrTpQty, setIbkrTpQty] = useState("");

  // Manual order state (liveEngine.placeManualOrder)
  const [manualIntent, setManualIntent] = useState<ManualOrderIntent | null>(null);
  const [mktQty, setMktQty] = useState("");
  const [mktSlippage, setMktSlippage] = useState<string>("0");
  const [manualSl, setManualSl] = useState("");
  const [manualTp, setManualTp] = useState("");
  const [mktDialogOpen, setMktDialogOpen] = useState(false);
  const [manualPending, setManualPending] = useState(false);
  const [ibkrPosition, setIbkrPosition] = useState<{ qty: number; side: "long" | "short" | null }>({ qty: 0, side: null });
  // Order Status Popup state
  const [orderPopupOpen, setOrderPopupOpen] = useState(false);
  const [orderPopupData, setOrderPopupData] = useState<{
    orderId: string | null;
    ticker: string;
    side: "BUY" | "SELL";
    quantity: number;
    orderType: string;
    sentAt: Date;
    ibkrMessage?: string | null;
    intentLabel?: string | null;
    estimatedValueUsd?: number | null;
    clientOrderId?: string | null;
    trackPositionClose?: boolean;
    protection?: { stopLoss?: number | null; takeProfit?: number | null } | null;
    immediateStatus?: "success" | "failed" | null;
  } | null>(null);

  const analyzeMut = trpc.portfolio.analyzeAsset.useMutation({
    onSuccess: (data) => {
      const r = data as DeepAnalysisResult;
      applyAnalysisResult(r);
    },
    onError: (e) => toast.error(e.message),
  });

  // Shared logic to apply a completed analysis result (used by both SSE and tRPC fallback)
  const applyAnalysisResult = useCallback((r: DeepAnalysisResult) => {
    setResult(r);
    setStreamingText(null);
    setIsStreaming(false);
    // Initialize SL: engine stopLoss is ALWAYS the default for the IBKR order panel.
    setEditedSL(r.stopLoss.toFixed(2));
    // Initialize TP: saved holding TP from DB, else buy price * 1.15
    const holdingTP = holdingContext?.takeProfit;
    const tpDefault = holdingTP != null && holdingTP > 0
      ? holdingTP.toFixed(2)
      : (r.recommendedBuyPrice > 0 ? (r.recommendedBuyPrice * 1.15).toFixed(2) : "");
    setEditedTP(tpDefault);
    // Initialize quantities from holding context
    if (holdingContext?.units) {
      setIbkrQty(holdingContext.units.toString());
      setIbkrTpQty(holdingContext.units.toString());
    }
    // Seed chat with a brief context line — full analysis is shown above, no need to repeat
    setChatMessages([{
      role: "engine",
      text: `ניתוח ${r.ticker} נטען. SL מוצע: **${r.currencySymbol ?? "$"}${r.stopLoss.toFixed(2)}** (${r.stopLossPct.toFixed(1)}% סיכון). שאל אותי כל שאלה על הפוזיציה, SL, TP, או אסטרטגיה.`,
    }]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdingContext?.takeProfit, holdingContext?.units]);

  const resolveConidMut = trpc.ibkr.resolveConid.useMutation();
  const setManualConidMut = trpc.ibkr.setManualConid.useMutation();

  const utils = trpc.useUtils();

  const warQuery = trpc.insights.getWarTickerAnalysis.useQuery(
    { ticker: ticker ?? "" },
    { enabled: open && !!ticker, staleTime: 60_000 },
  );

  const longUnits = ibkrPosition.side === "long"
    ? ibkrPosition.qty
    : (holdingContext && holdingContext.units > 0 ? holdingContext.units : 0);
  const shortUnits = ibkrPosition.side === "short" ? ibkrPosition.qty : 0;

  const submitManualOrder = useCallback(async (input: {
    ticker: string;
    side: ManualOrderSide;
    intent: ManualOrderIntent;
    quantity: number;
    slippagePct?: number;
    sl?: number | null;
    tp?: number | null;
  }) => {
    const clientOrderId = beginFlight(input.ticker, input.side);
    setManualPending(true);
    const px = livePriceQuery.data?.price ?? result?.price ?? 0;
    const estUsd = input.quantity * px;
    setOrderPopupData({
      orderId: null,
      ticker: input.ticker,
      side: input.side,
      quantity: input.quantity,
      orderType: parseFloat(mktSlippage) > 0 ? "LMT" : "MKT",
      sentAt: new Date(),
      ibkrMessage: "שולח ל-IBKR...",
      intentLabel: intentLabelHe(input.intent),
      estimatedValueUsd: estUsd,
      clientOrderId,
      trackPositionClose: input.intent === "close_long" || input.intent === "close_short",
    });
    setOrderPopupOpen(true);
    setMktDialogOpen(false);

    try {
      const client = utils.client as {
        liveEngine?: {
          placeManualOrder?: {
            mutate: (i: typeof input & { clientOrderId: string }) => Promise<{
              success: boolean;
              orderId: string | null;
              ticker: string;
              side: ManualOrderSide;
              quantity: number;
              orderType: string;
              reason?: string | null;
              ibkrMessage?: string | null;
              stopLoss?: number | null;
              takeProfit?: number | null;
            }>;
          };
        };
      };
      if (!client.liveEngine?.placeManualOrder?.mutate) {
        throw new Error("placeManualOrder לא זמין — ממתין ל-merge של Claude בשרת");
      }
      const data = await client.liveEngine.placeManualOrder.mutate({ ...input, clientOrderId });
      if (!data.success) {
        throw new Error(data.reason ?? "הפקודה נדחתה");
      }
      const serverSl = data.stopLoss;
      const serverTp = data.takeProfit;
      const hasVerifiedProtection =
        serverSl != null && serverTp != null && serverSl > 0 && serverTp > 0;
      setOrderPopupData({
        orderId: data.orderId ?? null,
        ticker: data.ticker,
        side: data.side,
        quantity: data.quantity,
        orderType: data.orderType ?? "MKT",
        sentAt: new Date(),
        ibkrMessage: data.ibkrMessage ?? data.reason ?? null,
        intentLabel: intentLabelHe(input.intent),
        estimatedValueUsd: estUsd,
        clientOrderId,
        trackPositionClose: input.intent === "close_long" || input.intent === "close_short",
        protection: hasVerifiedProtection
          ? { stopLoss: serverSl, takeProfit: serverTp, verified: true }
          : undefined,
      });
      void utils.portfolio.getState.invalidate();
      void utils.liveEngine.getStatus.invalidate();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setOrderPopupData((prev) => prev ? {
        ...prev,
        ibkrMessage: msg,
        immediateStatus: "failed",
        trackPositionClose: false,
      } : null);
    } finally {
      setManualPending(false);
    }
  }, [utils, mktSlippage, livePriceQuery.data?.price, result?.price]);

  const updateHoldingMut = trpc.portfolio.updateHolding.useMutation({
    onError: (e) => console.warn("Failed to save SL/TP to DB:", e.message),
  });

  const placeLMTMut = trpc.ibkr.placeTakeProfitIbind.useMutation({
    onSuccess: (data) => {
      toast.success(`✅ Take Profit order placed (IBIND) — Order ID: ${data.orderId ?? "pending"}`);
      setTpDialogOpen(false);
      // Save TP price to DB so SL/TP Monitor shows the value
      if (holdingContext?.id && holdingContext.id > 0 && editedTP) {
        updateHoldingMut.mutate({ id: holdingContext.id, takeProfit: parseFloat(editedTP) });
      }
      utils.portfolio.getState.invalidate();
    },
    onError: (e) => toast.error(`Failed to place LMT order: ${e.message}`),
  });

  const placeSTPMut = trpc.ibkr.placeStopLossIbind.useMutation({
    onSuccess: (data) => {
      toast.success(`✅ Stop Loss order placed (IBIND) — Order ID: ${data.orderId ?? "pending"}`);
      setSlDialogOpen(false);
      // Save SL price to DB so SL/TP Monitor shows the value
      if (holdingContext?.id && holdingContext.id > 0 && editedSL) {
        updateHoldingMut.mutate({ id: holdingContext.id, stopLoss: parseFloat(editedSL) });
      }
      utils.portfolio.getState.invalidate();
    },
    onError: (e) => toast.error(`Failed to place STP order: ${e.message}`),
  });

  // Scroll modal to top when it opens
  const prevChatLengthRef = useRef(0);
  const modalScrollRef = useRef<HTMLDivElement>(null);

  // Scroll modal to top whenever it opens (or ticker changes)
  useEffect(() => {
    if (open && modalScrollRef.current) {
      modalScrollRef.current.scrollTop = 0;
    }
  }, [open, ticker]);

  // Scroll chat to bottom only when USER sends a new message (not on initial seed or engine reply)
  useEffect(() => {
    // Only auto-scroll if the LAST message is from the user (user just sent)
    if (chatMessages.length > 0 && chatMessages[chatMessages.length - 1]?.role === "user") {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevChatLengthRef.current = chatMessages.length;
  }, [chatMessages]);

  // Fetch IBKR settings from DB, then check IBIND session health
  const { user: authUser } = useAuth();
  const isAdmin = authUser?.role === "admin";
  const ibkrSettingsQuery = trpc.ibkr.getSettings.useQuery(undefined, { enabled: open && isAdmin, staleTime: 5 * 60_000 }); // cache 5 min — admin only

  useEffect(() => {
    if (!open) return;
    if (isAdmin && ibkrSettingsQuery.data?.accountId) {
      setIbkrAccountId(ibkrSettingsQuery.data.accountId);
    }
    if (conid && conid > 0) setIbkrConid(conid);

    fetch("/api/ibind/health")
      .then(r => r.json())
      .then((data: { session_active?: boolean | string; status?: string }) => {
        const ibindOk = (data.session_active === true || data.session_active === "true") && data.status === "ok";
        setIbkrConnected(ibindOk);
      })
      .catch(() => setIbkrConnected(false));
  }, [open, ibkrSettingsQuery.data, conid, isAdmin]);

  // Positions — async, cached 15s, 5s timeout; never blocks modal render
  useEffect(() => {
    if (!open || !ticker || !ibkrConnected) return;
    let cancelled = false;
    const tickerUp = ticker.toUpperCase();

    void fetchIbkrPositionsCached().then((positions) => {
      if (cancelled) return;
      const match = matchTickerPosition(positions, tickerUp);
      applyPositionMatch(match, setIbkrPosition, setIbkrConid, conid);
      if (!match?.conid || match.conid <= 0) {
        resolveConidMut.mutateAsync({ symbol: tickerUp })
          .then((resolved) => {
            if (!cancelled && resolved?.conid && resolved.conid > 0) setIbkrConid(resolved.conid);
          })
          .catch(() => {});
      }
    });

    return () => { cancelled = true; };
  }, [open, ticker, ibkrConnected, conid]);

  // Load persisted chat history from DB when ticker changes
  const chatHistoryQuery = trpc.ibkr.getChatHistory.useQuery(
    { ticker: ticker ?? "" },
    { enabled: !!ticker && open, staleTime: 60_000 } // cache 1 min
  );
  const clearChatMut = trpc.ibkr.clearChatHistory.useMutation({
    onSuccess: () => { setChatMessages([]); toast.success("היסטוריית צ'אט נמחקה"); },
  });

  // Sync DB history into local state when loaded
  useEffect(() => {
    if (chatHistoryQuery.data && chatHistoryQuery.data.length > 0) {
      setChatMessages(chatHistoryQuery.data.map(r => ({ role: r.role as "engine" | "user", text: r.text })));
      // Apply last known SL/TP from history
      const lastSL = [...chatHistoryQuery.data].reverse().find(r => r.updatedSL)?.updatedSL;
      const lastTP = [...chatHistoryQuery.data].reverse().find(r => r.updatedTP)?.updatedTP;
      if (lastSL) setEditedSL(lastSL);
      if (lastTP) setEditedTP(lastTP);
    }
  }, [chatHistoryQuery.data]);

  const tradingChatMut = trpc.ibkr.tradingChat.useMutation({
    onSuccess: (data) => {
      setChatMessages(prev => [...prev, { role: "engine", text: data.reply }]);
      // Auto-update SL/TP fields if engine detected new values
      if (data.detectedSL) {
        setEditedSL(data.detectedSL);
        toast.info(`המנוע עדכן SL ל-$${data.detectedSL}`);
      }
      if (data.detectedTP) {
        setEditedTP(data.detectedTP);
        toast.info(`המנוע עדכן TP ל-$${data.detectedTP}`);
      }
      setChatLoading(false);
    },
    onError: (e) => {
      setChatMessages(prev => [...prev, { role: "engine", text: `שגיאה בתקשורת עם המנוע: ${e.message}` }]);
      setChatLoading(false);
    },
  });

  const handleSendChat = () => {
    if (!chatInput.trim() || !result) return;
    const userMsg = chatInput.trim();
    setChatInput("");
    setChatMessages(prev => [...prev, { role: "user", text: userMsg }]);
    setChatLoading(true);

    tradingChatMut.mutate({
      ticker: result.ticker,
      userMessage: userMsg,
      chatHistory: chatMessages.slice(-10),
      analysisContext: {
        score: result.score,
        tier: result.tier,
        price: livePrice,
        ema50: result.ema50,
        ema200: result.ema200,
        rsi: result.rsi,
        atr14: result.atr14,
        weeklyEma50Slope: result.weeklyEma50Slope,
        stopLoss: result.stopLoss,
        atrStopLoss: result.atrStopLoss,
        emaStopLoss: result.emaStopLoss,
        stopLossPct: result.stopLossPct,
        recommendedBuyPrice: result.recommendedBuyPrice,
        priceAction: result.priceAction,
        zivReason: result.zivReason,
        aiRisks: result.ai.risks,
        aiEntryRationale: result.ai.positionRationale,
        passCount: result.passCount,
        totalConditions: result.conditions.length,
        positionSizeUsd: result.positionSizeUsd,
        positionSizePct: result.positionSizePct,
        tierLabel: result.tierLabel,
        tierCapFraction: result.tierCapFraction,
        totalPortfolioValue: result.totalPortfolioValue,
      },
      holdingContext: holdingContext ? {
        buyPrice: holdingContext.buyPrice,
        units: holdingContext.units,
        currentPrice: holdingContext.currentPrice,
        pnlPct: holdingContext.pnlPct,
        stopLoss: holdingContext.stopLoss ?? null,
        takeProfit: holdingContext.takeProfit ?? null,
      } : undefined,
      editedSL: editedSL ? parseFloat(editedSL) : undefined,
      editedTP: editedTP ? parseFloat(editedTP) : undefined,
    });
  };

  const addHoldingMut = trpc.portfolio.addHolding.useMutation({
    onSuccess: () => {
      toast.success(`נוסף לתיק בהצלחה!`);
      setBuyDialogOpen(false);
      setBuyUnits("");
      setBuyPrice("");
    },
    onError: (e) => toast.error(e.message),
  });

  // ── Add to Holding (H1 or H2) state ──────────────────────────────────────────
  const [addToHoldingOpen, setAddToHoldingOpen] = useState(false);
  const [addToHoldingTarget, setAddToHoldingTarget] = useState<"H1" | "H2">("H2");
  const [addToHoldingUnits, setAddToHoldingUnits] = useState("");
  const [addToHoldingPrice, setAddToHoldingPrice] = useState("");

  const addH2HoldingMut = trpc.holding2.add.useMutation({
    onSuccess: () => {
      toast.success(`✅ נוסף לתיק H2 בהצלחה!`);
      setAddToHoldingOpen(false);
      setAddToHoldingUnits("");
      setAddToHoldingPrice("");
    },
    onError: (e: { message: string }) => toast.error(e.message),
  });

  const handleOpenAddToHolding = () => {
    if (!result) return;
    setAddToHoldingPrice(result.recommendedBuyPrice > 0 ? result.recommendedBuyPrice.toFixed(2) : livePrice.toFixed(2));
    setAddToHoldingUnits(result.suggestedShares?.toString() ?? "");
    setAddToHoldingTarget("H2");
    setAddToHoldingOpen(true);
  };

  const handleConfirmAddToHolding = () => {
    if (!ticker || !result) return;
    const units = parseFloat(addToHoldingUnits);
    const price = parseFloat(addToHoldingPrice);
    if (!units || units <= 0) { toast.error("אנא הכנס כמות תקינה"); return; }
    if (!price || price <= 0) { toast.error("אנא הכנס מחיר תקין"); return; }
    if (addToHoldingTarget === "H2") {
      addH2HoldingMut.mutate({
        ticker,
        buyPriceUsd: price,  // price is already USD from Deep Analysis
        units,
        notes: `Deep Analysis | SL: $${result.stopLoss.toFixed(2)}`,
      });
    } else {
      addHoldingMut.mutate({
        ticker,
        buyPrice: price,
        units,
        notes: `Deep Analysis | SL: $${result.stopLoss.toFixed(2)}`,
      });
    }
  };

  const handleOpenBuy = () => {
    if (!result) return;
    setBuyPrice(result.recommendedBuyPrice.toFixed(2));
    setBuyUnits("");
    setBuyDialogOpen(true);
  };

  const handleOpenManualOrder = (intent: ManualOrderIntent) => {
    if (!result) return;
    if (!ticker) return;
    const side = intentToSide(intent);
    if (
      orderPopupOpen
      && orderPopupData
      && orderPopupData.ticker.toUpperCase() === ticker.toUpperCase()
      && orderPopupData.side === side
    ) {
      toast.error("יש פקודה פתוחה לטיקר/כיוון זה — בדוק ב-IBKR");
      return;
    }
    const flight = getFlight(ticker, side);
    if (flight && (flight.phase === "stalled" || flight.phase === "inflight")) {
      toast.error(
        `יש ניסיון ${side} פעיל ב-${ticker}${flight.clientOrderId ? ` (${flight.clientOrderId.slice(0, 8)}…)` : ""} — בדוק ב-IBKR`,
      );
      return;
    }
    setManualIntent(intent);
    setManualSl(result.stopLoss.toFixed(2));
    setManualTp(
      result.recommendedBuyPrice > 0
        ? (result.recommendedBuyPrice * 1.15).toFixed(2)
        : "",
    );
    if (intent === "close_long") {
      setMktQty(String(longUnits || holdingContext?.units || ""));
    } else if (intent === "close_short") {
      setMktQty(String(shortUnits || ""));
    } else {
      setMktQty(result.suggestedShares?.toString() ?? "");
    }
    setMktDialogOpen(true);
  };

  const handleClose = useCallback(() => {
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
    const currentPath = `${window.location.pathname}${window.location.search}`;
    const returnTo = consumeReturnTo(currentPath);
    if (returnTo && returnTo !== currentPath) {
      navigate(returnTo);
      return;
    }
    onClose();
  }, [navigate, onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, handleClose]);

  const handleConfirmBuy = () => {
    if (!ticker || !result) return;
    const units = parseFloat(buyUnits);
    const price = parseFloat(buyPrice);
    if (!units || units <= 0) { toast.error("אנא הכנס כמות תקינה"); return; }
    if (!price || price <= 0) { toast.error("אנא הכנס מחיר תקין"); return; }
    addHoldingMut.mutate({
      ticker,
      buyPrice: price,
      units,
      notes: `SL: $${result.stopLoss.toFixed(2)}`,
    });
  };
  // SSE-based analysis trigger — fires when modal opens for a new ticker
  useEffect(() => {
    if (!open || !ticker) return;
    // Close any existing SSE connection
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
    setResult(null);
    setStreamingText(null);
    setIsStreaming(true);

    // Build query string
    const params = new URLSearchParams({ ticker });
    if (portfolioSize) params.set("portfolioSize", String(portfolioSize));
    if (holdingContext) {
      params.set("buyPrice", String(holdingContext.buyPrice));
      params.set("units", String(holdingContext.units));
      params.set("currentPrice", String(holdingContext.currentPrice));
      params.set("pnlUsd", String(holdingContext.pnlUsd));
      params.set("pnlPct", String(holdingContext.pnlPct));
      if (holdingContext.stopLoss) params.set("stopLoss", String(holdingContext.stopLoss));
      if (holdingContext.takeProfit) params.set("takeProfit", String(holdingContext.takeProfit));
      const reason = holdingContext.whyBought ?? holdingContext.diaryReason;
      const expectation = holdingContext.expectations ?? holdingContext.diaryExpectation;
      if (reason) params.set("diaryReason", reason);
      if (expectation) params.set("diaryExpectation", expectation);
    }

    const es = new EventSource(`/api/deep-analysis/stream?${params.toString()}`);
    sseRef.current = es;

    es.addEventListener("cached", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as DeepAnalysisResult;
        applyAnalysisResult(data);
      } catch { /* ignore */ }
      es.close();
      sseRef.current = null;
    });

    es.addEventListener("meta", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as Partial<DeepAnalysisResult>;
        // Show structured data immediately — AI text will stream in
        setResult({
          ...data,
          ai: { recommendation: "", positionRationale: "", risks: "", actionTrigger: "", summary: "" },
          analyzedAt: new Date().toISOString(),
          fromCache: false,
        } as DeepAnalysisResult);
        setStreamingText(""); // start streaming mode
      } catch { /* ignore */ }
    });

    es.addEventListener("chunk", (e) => {
      const chunk = JSON.parse((e as MessageEvent).data) as string;
      setStreamingText(prev => (prev ?? "") + chunk);
    });

    es.addEventListener("done", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as DeepAnalysisResult;
        applyAnalysisResult(data);
      } catch { /* ignore */ }
      es.close();
      sseRef.current = null;
    });

    es.addEventListener("error", (e) => {
      const msg = (e as MessageEvent).data ? JSON.parse((e as MessageEvent).data) as string : "Analysis failed";
      toast.error(typeof msg === "string" ? msg : "Analysis failed");
      setIsStreaming(false);
      es.close();
      sseRef.current = null;
    });

    es.onerror = () => {
      // SSE connection error (network issue) — fall back to tRPC
      if (es.readyState === EventSource.CLOSED) {
        setIsStreaming(false);
        sseRef.current = null;
        // Fallback: use tRPC mutation
        analyzeMut.mutate({ ticker, portfolioSize: portfolioSize ?? undefined, holdingContext: holdingContext ? {
          ...holdingContext,
          diaryReason: holdingContext.whyBought ?? holdingContext.diaryReason ?? null,
          diaryExpectation: holdingContext.expectations ?? holdingContext.diaryExpectation ?? null,
        } : undefined });
      }
    };

    return () => {
      es.close();
      sseRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ticker]);

  // Cleanup SSE on modal close
  useEffect(() => {
    if (!open && sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
      setIsStreaming(false);
      setStreamingText(null);
    }
  }, [open]);

  // Lock body scroll when modal is open so background tables don't scroll
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open || !ticker) return null;
  const isLoading = isStreaming && !result;
  return (
    <>
      {/* Always-visible CLOSE — fixed to the viewport, can NEVER scroll off (incl. pageMode/mobile) */}
      <button
        type="button"
        onClick={handleClose}
        aria-label="סגור ניתוח עומק"
        className="fixed top-16 left-3 flex items-center justify-center gap-1.5 rounded-full bg-red-600 text-white shadow-xl px-4 h-11 min-h-[44px] min-w-[44px] text-sm font-bold hover:bg-red-700 active:scale-95"
        style={{ zIndex: 9999 }}
      >
        ✕ סגור
      </button>
      {/* ── Sticky TradingView Alert Banner ─────────────────────────────── */}

      {/* Full-page overlay backdrop — hidden in pageMode */}
      {!pageMode && (
        <div
          className="fixed inset-0 bg-white/60 backdrop-blur-sm"
          style={{ zIndex: Z.analysisBackdrop }}
          onClick={handleClose}
        />
      )}
      <div
        className={pageMode ? "flex w-full" : "fixed inset-x-0 top-14 md:top-0 bottom-0 flex"}
        style={pageMode ? undefined : { zIndex: Z.analysisPanel }}
      >
        <div
          className={pageMode
            ? "relative w-full flex flex-col bg-background min-h-screen"
            : "relative w-full md:mx-auto md:max-w-[1400px] flex flex-col bg-background shadow-2xl overflow-hidden"
          }
        >
          {/* Header bar — sticky */}
          <DeepAnalysisHeader
            ticker={ticker}
            company={result?.company}
            navList={navList}
            onNavigate={onNavigate}
            onClose={handleClose}
          />
          {/* Scrollable content */}
          <div ref={modalScrollRef} className={pageMode ? "flex-1 px-3 sm:px-6 py-4" : "flex-1 overflow-y-auto px-3 sm:px-6 py-4"}>
        {/* ── Progressive loading: show quickStats immediately while full analysis runs ── */}
        {isLoading && !quickStats && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-[#2563EB]" />
            <p className="text-sm text-muted-foreground">…טוען נתונים עבור {ticker}</p>
          </div>
        )}
        {/* Quick stats panel — visible while AI analysis is still loading (no result yet) */}
        {isLoading && !result && quickStats && (
          <div className="space-y-4 pb-2">
            {/* Header with price + ZIV score */}
            <div className="flex flex-wrap items-center gap-4 p-4 bg-muted/30 rounded-lg border">
              <div className="flex flex-col">
                <span className="text-xs text-muted-foreground">Current Price</span>
                <span className="font-mono font-bold text-2xl">{csQ}{quickStats.price.toFixed(2)}</span>
                <span className={`text-sm font-medium ${quickStats.changePercent >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"}`}>
                  {quickStats.changePercent >= 0 ? "+" : ""}{quickStats.changePercent.toFixed(2)}% today
                </span>
              </div>
              <div className="flex flex-col items-center">
                <span className="text-xs text-muted-foreground">Ziv Score</span>
                <ScoreBadge score={quickStats.score} />
                <TierBadge tier={quickStats.tier as ZivTier} />
              </div>
              <div className="flex-1 flex flex-col items-end gap-1">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin text-[#2563EB]" />
                  <span>ה-AI מנתח ברקע...</span>
                </div>
                <span className="text-xs text-muted-foreground">המלצות, סיכונים וגודל פוזיציה יופיעו ברגע</span>
              </div>
            </div>
            {(quickStats.company || quickStats.sector || quickStats.companyDescription) && (
              <div className="p-4 bg-muted/20 rounded-lg border space-y-1">
                {(quickStats.company || quickStats.sector) && (
                  <div className="flex items-center gap-2 flex-wrap">
                    {quickStats.company && (
                      <span className="text-sm font-bold text-gray-800">{quickStats.company}</span>
                    )}
                    {quickStats.sector && (
                      <Badge className="bg-slate-100 text-slate-600 border-0 text-[11px]">{quickStats.sector}</Badge>
                    )}
                  </div>
                )}
                {quickStats.companyDescription && (
                  <p className="text-xs text-muted-foreground leading-relaxed">{quickStats.companyDescription}</p>
                )}
              </div>
            )}
            {/* ── My Position Card (loading state) ── */}
            {holdingContext && (
              <div className="p-4 bg-white border border-blue-200 rounded-lg">
                <div className="flex items-center gap-2 mb-3">
                  <TrendingUp className="h-4 w-4 text-[#2563EB]" />
                  <span className="text-sm font-bold text-gray-800 uppercase tracking-wide">My Position</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
                  <div className="bg-gray-50 rounded-lg p-2.5 text-center">
                    <div className="text-[10px] text-slate-400 uppercase tracking-wide mb-0.5">Units</div>
                    <div className="font-mono font-bold text-lg text-gray-800">{holdingContext.units.toLocaleString()}</div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-2.5 text-center">
                    <div className="text-[10px] text-slate-400 uppercase tracking-wide mb-0.5">Buy Price</div>
                    <div className="font-mono font-bold text-lg text-blue-600">{cs}{holdingContext.buyPrice.toFixed(2)}</div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-2.5 text-center">
                    <div className="text-[10px] text-slate-400 uppercase tracking-wide mb-0.5">Position Value</div>
                    <div className="font-mono font-bold text-lg text-gray-800">${(holdingContext.units * holdingContext.currentPrice).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-2.5 text-center">
                    <div className="text-[10px] text-slate-400 uppercase tracking-wide mb-0.5">P&L</div>
                    <div className={`font-mono font-bold text-lg ${holdingContext.pnlPct >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                      ({holdingContext.pnlPct >= 0 ? '+' : ''}{holdingContext.pnlPct.toFixed(2)}%)
                    </div>
                    <div className={`font-mono text-xs ${holdingContext.pnlUsd >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                      {holdingContext.pnlUsd >= 0 ? '+' : ''}${holdingContext.pnlUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                    </div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-2.5 text-center">
                    <div className="text-[10px] text-slate-400 uppercase tracking-wide mb-0.5">Stop Loss</div>
                    {holdingContext.stopLoss && holdingContext.stopLoss > 0
                      ? <div className="font-mono font-bold text-lg text-[#FF6B6B]">{cs}{holdingContext.stopLoss.toFixed(2)}</div>
                      : <div className="font-mono text-slate-500 text-sm">—</div>
                    }
                  </div>
                  <div className="bg-gray-50 rounded-lg p-2.5 text-center">
                    <div className="text-[10px] text-slate-400 uppercase tracking-wide mb-0.5">Take Profit</div>
                    {holdingContext.takeProfit && holdingContext.takeProfit > 0
                      ? <div className="font-mono font-bold text-lg text-[#65A30D]">{cs}{holdingContext.takeProfit.toFixed(2)}</div>
                      : <div className="font-mono text-slate-500 text-sm">—</div>
                    }
                  </div>
                </div>
              </div>
            )}
            {/* Entry Conditions — available immediately from quickStats */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="space-y-4">
                {/* AI Summary skeleton */}
                <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <div className="flex items-center gap-1.5 mb-3">
                    <Lightbulb className="h-4 w-4 text-[#2563EB]" />
                    <span className="text-sm font-semibold text-blue-600">AI Summary</span>
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[#2563EB] ml-1" />
                  </div>
                  <div className="space-y-2">
                    <div className="h-3 bg-gray-200 rounded animate-pulse w-full" />
                    <div className="h-3 bg-gray-200 rounded animate-pulse w-5/6" />
                    <div className="h-3 bg-gray-200 rounded animate-pulse w-4/6" />
                  </div>
                </div>
                {/* Entry Conditions — real data */}
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Activity className="h-4 w-4 text-foreground" />
                    <span className="text-sm font-semibold uppercase tracking-wide">Entry Conditions</span>
                    <span className={`text-sm font-bold ml-1 ${quickStats.passCount >= 5 ? "text-[#65A30D]" : quickStats.passCount >= 3 ? "text-amber-600" : "text-[#FF6B6B]"}`}>
                      {quickStats.passCount}/{quickStats.conditions.length} passed
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {quickStats.conditions.map((c, i) => (
                      <div key={i} className={`flex items-start gap-1.5 p-2.5 rounded-md border text-xs ${c.pass ? "bg-emerald-50 border-emerald-300" : "bg-red-50 border-red-300"}`}>
                        {c.pass ? <CheckCircle2 className="h-3.5 w-3.5 text-[#65A30D] mt-0.5 shrink-0" /> : <XCircleIcon className="h-3.5 w-3.5 text-[#FF6B6B] mt-0.5 shrink-0" />}
                        <div>
                          <div className={`font-medium ${c.pass ? "text-[#65A30D]" : "text-[#FF6B6B]"}`}>{c.name}</div>
                          <div className="text-muted-foreground font-mono">{c.value}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="space-y-4">
                {/* Technical Indicators — real data */}
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Activity className="h-4 w-4 text-foreground" />
                    <span className="text-sm font-semibold uppercase tracking-wide">Technical Indicators</span>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { label: "EMA-50", value: `${csQ}${quickStats.ema50.toFixed(2)}`, sub: `${quickStats.distToEma50Pct >= 0 ? "+" : ""}${quickStats.distToEma50Pct.toFixed(1)}% from price` },
                      { label: "EMA-200", value: `$${quickStats.ema200.toFixed(2)}`, sub: quickStats.price > quickStats.ema200 ? "Price above ✓" : "Price below ✗" },
                      { label: "RSI-14", value: quickStats.rsi.toFixed(1), sub: quickStats.rsi < 30 ? "Oversold" : quickStats.rsi > 70 ? "Overbought" : "Neutral" },
                      { label: "Volume Ratio", value: `${quickStats.volumeRatio.toFixed(2)}x`, sub: quickStats.volumeRatio >= 1.5 ? "High volume ✓" : "Normal volume" },
                      { label: "ATR-14", value: `$${quickStats.atr14.toFixed(2)}`, sub: "Daily range" },
                      { label: "Weekly Slope", value: quickStats.weeklyEma50Slope.toFixed(3), sub: quickStats.weeklyEma50Slope > 0 ? "Rising ↑" : "Falling ↓" },
                      { label: "Price Action", value: quickStats.priceAction ?? "None", sub: quickStats.priceAction ? "Detected" : "No signal" },
                    ].map((item, i) => (
                      <div key={i} className="bg-muted/40 rounded-md px-2.5 py-2 border">
                        <div className="text-[10px] text-muted-foreground font-medium">{item.label}</div>
                        <div className="font-mono font-bold text-sm">{item.value}</div>
                        <div className="text-[10px] text-muted-foreground">{item.sub}</div>
                      </div>
                    ))}
                  </div>
                </div>
                {/* Ziv Engine Verdict */}
                <div className="p-4 bg-muted/20 border rounded-lg">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Zap className="h-4 w-4 text-[#2563EB]" />
                    <span className="text-sm font-semibold">Ziv Engine Verdict</span>
                    {quickStats.isOverride && (
                      <span className="ml-2 px-2 py-0.5 text-xs font-bold bg-orange-100 text-orange-700 border border-orange-300 rounded-full">⚡ Override</span>
                    )}
                  </div>
                  <p className="text-sm text-foreground">{quickStats.zivReason}</p>
                </div>
                {/* ZIV Breakdown v2.2 */}
                {quickStats.breakdown && (
                  <div className="p-4 bg-muted/10 border rounded-lg">
                    <div className="flex items-center gap-1.5 mb-3">
                      <Zap className="h-4 w-4 text-amber-500" />
                      <span className="text-sm font-semibold">ZIV Score Breakdown</span>
                      <span className="ml-auto text-xs text-muted-foreground font-mono">v2.2 · {(quickStats.breakdown as any).total?.toFixed(2) ?? '—'} bonus</span>
                    </div>
                    <div className="grid grid-cols-4 gap-1.5">
                      {[
                        { label: "RSI", value: (quickStats.breakdown as any).rsi ?? 0, max: 0.20, desc: "Momentum" },
                        { label: "Volume", value: (quickStats.breakdown as any).volume ?? 0, max: 0.20, desc: "Confirmation" },
                        { label: "Proximity", value: (quickStats.breakdown as any).proximity ?? 0, max: 0.20, desc: "Entry quality" },
                        { label: "Golden Cross", value: (quickStats.breakdown as any).goldenCross ?? 0, max: 0.15, desc: "EMA-20>EMA-50" },
                        { label: "52W High", value: (quickStats.breakdown as any).high52w ?? 0, max: 0.15, desc: "Near peak" },
                        { label: "ATR Coil", value: (quickStats.breakdown as any).atrContraction ?? 0, max: 0.09, desc: "Pre-breakout" },
                        { label: "Trend Str.", value: (quickStats.breakdown as any).trendStrength ?? 0, max: 0.20, desc: "Slope+bars" },
                        { label: "Profit Pot.", value: (quickStats.breakdown as any).profitPotential ?? 0, max: 0.20, desc: "Upside room" },
                      ].map((item, i) => {
                        const pct = item.max > 0 ? (item.value / item.max) * 100 : 0;
                        const barColor = pct >= 80 ? "bg-emerald-500" : pct >= 50 ? "bg-blue-400" : pct >= 20 ? "bg-amber-400" : "bg-red-300";
                        return (
                          <div key={i} className="bg-background border rounded-md p-2">
                            <div className="text-[10px] text-muted-foreground font-medium truncate">{item.label}</div>
                            <div className="font-mono font-bold text-xs mt-0.5">{item.value.toFixed(2)}<span className="text-muted-foreground font-normal">/{item.max.toFixed(2)}</span></div>
                            <div className="mt-1 h-1 bg-muted rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                            </div>
                            <div className="text-[9px] text-muted-foreground mt-0.5">{item.desc}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {/* Buy price + SL skeletons */}
                <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
                    <div className="flex items-center gap-1.5 mb-2">
                      <Target className="h-3.5 w-3.5 text-[#65A30D]" />
                      <span className="text-xs font-semibold text-[#65A30D]">Recommended Buy Price</span>
                      <Loader2 className="h-3 w-3 animate-spin text-[#65A30D] ml-1" />
                    </div>
                    <div className="h-7 bg-emerald-200/60 rounded animate-pulse w-24" />
                  </div>
                    <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                    <div className="flex items-center gap-1.5 mb-2">
                      <ShieldAlert className="h-3.5 w-3.5 text-[#FF6B6B]" />
                      <span className="text-xs font-semibold text-red-700">Stop Loss</span>
                      <Loader2 className="h-3 w-3 animate-spin text-[#FF6B6B] ml-1" />
                    </div>
                    <div className="h-7 bg-red-200/60 rounded animate-pulse w-24" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
        {!isLoading && !result && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <AlertCircle className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No analysis available</p>
            <Button size="sm" onClick={() => {
              // Retry: close existing SSE and re-trigger via state reset
              if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
              setResult(null);
              setStreamingText(null);
              setIsStreaming(true);
              const params = new URLSearchParams({ ticker: ticker ?? "" });
              if (portfolioSize) params.set("portfolioSize", String(portfolioSize));
              const es = new EventSource(`/api/deep-analysis/stream?${params.toString()}`);
              sseRef.current = es;
              es.addEventListener("cached", (e) => { try { applyAnalysisResult(JSON.parse((e as MessageEvent).data) as DeepAnalysisResult); } catch { /* ignore */ } es.close(); sseRef.current = null; });
              es.addEventListener("meta", (e) => { try { const d = JSON.parse((e as MessageEvent).data) as Partial<DeepAnalysisResult>; setResult({ ...d, ai: { recommendation: "", positionRationale: "", risks: "", actionTrigger: "", summary: "" }, analyzedAt: new Date().toISOString(), fromCache: false } as DeepAnalysisResult); setStreamingText(""); } catch { /* ignore */ } });
              es.addEventListener("chunk", (e) => { const c = JSON.parse((e as MessageEvent).data) as string; setStreamingText(p => (p ?? "") + c); });
              es.addEventListener("done", (e) => { try { applyAnalysisResult(JSON.parse((e as MessageEvent).data) as DeepAnalysisResult); } catch { /* ignore */ } es.close(); sseRef.current = null; });
              es.addEventListener("error", () => { setIsStreaming(false); es.close(); sseRef.current = null; });
              es.onerror = () => { if (es.readyState === EventSource.CLOSED) { setIsStreaming(false); sseRef.current = null; analyzeMut.mutate({ ticker: ticker ?? "" }); } };
            }}>
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
            </Button>
          </div>
        )}
        {result && (
          <div className="space-y-4 pb-2 max-w-4xl mx-auto">
            <TradingCommandBar
              ticker={ticker ?? ""}
              result={result}
              currencySymbol={cs}
              livePrice={livePrice}
              liveChangePercent={liveChangePercent}
              warAction={warQuery.data?.action}
              warScore={warQuery.data?.finalScore}
              ibkrConnected={ibkrConnected}
              ibkrConid={ibkrConid}
              manualPending={manualPending}
              blockedBuy={ticker ? getBlockedSides(ticker).buy : false}
              blockedSell={ticker ? getBlockedSides(ticker).sell : false}
              longUnits={longUnits}
              shortUnits={shortUnits}
              holdingContext={holdingContext}
              onOpenManualOrder={handleOpenManualOrder}
            />

            <AdvancedDetails
              ticker={ticker ?? ""}
              result={result}
              currencySymbol={cs}
              livePrice={livePrice}
              holdingContext={holdingContext}
              zivHData={zivHData ?? undefined}
              zivHLoading={zivHQuery.isLoading && !prefetchedZivH}
            />

            <AiAnalysisPanel
              result={result}
              holdingContext={holdingContext}
              streamingText={streamingText}
            />
            {isAdmin && (
              <AdminSlTpPanel
                result={result}
                currencySymbol={cs}
                ibkrConnected={ibkrConnected}
                editedTP={editedTP}
                onEditedTPChange={setEditedTP}
                editedSL={editedSL}
                onEditedSLChange={setEditedSL}
                ibkrTpQty={ibkrTpQty}
                onIbkrTpQtyChange={setIbkrTpQty}
                ibkrQty={ibkrQty}
                onIbkrQtyChange={setIbkrQty}
                holdingContext={holdingContext}
                placeLMTPending={placeLMTMut.isPending}
                placeSTPPending={placeSTPMut.isPending}
                onOpenTpDialog={() => setTpDialogOpen(true)}
                onOpenSlDialog={() => setSlDialogOpen(true)}
              />
            )}

            {/* Footer */}
            <div className="flex items-center justify-between pt-1 border-t text-xs text-muted-foreground">
              <span>Analyzed at {new Date(result.analyzedAt).toLocaleTimeString()}</span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-7 text-xs bg-violet-600 hover:bg-violet-700 text-white gap-1"
                  onClick={handleOpenAddToHolding}
                >
                  <PlusCircle className="h-3 w-3" /> הוסף לתיק
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setResult(null); analyzeMut.mutate({ ticker }); }}>
                  <RefreshCw className="h-3 w-3 mr-1" /> Re-analyze
                </Button>
              </div>
            </div>
          </div>
        )}
          </div>{/* end scrollable content div */}
        </div>{/* end panel */}
      </div>{/* end fixed container */}

      {/* ── SL Confirmation Dialog ── */}
      <Dialog open={slDialogOpen} onOpenChange={(o) => { if (!o) setSlDialogOpen(false); }}>
        <DialogContent className="max-w-sm" style={{ zIndex: Z.dialog }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-700">
              <ShieldOff className="h-5 w-5" />
              אישור פקודת Stop Loss
            </DialogTitle>
          </DialogHeader>
          {result && (() => {
            const slPrice = parseFloat(editedSL || "0");
            const engineSL = result.stopLoss;
            const currentPrice = livePrice;
            const slDeviation = engineSL > 0 ? Math.abs((slPrice - engineSL) / engineSL) * 100 : 0;
            const slTooHigh = slPrice > currentPrice * 0.98; // SL above 98% of current = dangerous
            const slFarFromEngine = slDeviation > 10;
            const warnings: string[] = [];
            if (slTooHigh) warnings.push(`⚠️ ה-SL ($${slPrice.toFixed(2)}) קרוב מדי למחיר השוק ($${currentPrice.toFixed(2)}) — סכנת ביצוע מידי`);
            if (slFarFromEngine) warnings.push(`⚠️ ה-SL סוטה ${slDeviation.toFixed(1)}% מהמלצת המנוע ($${engineSL.toFixed(2)})`);
            return (
              <div className="space-y-3 py-2">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="bg-gray-50 rounded-lg p-3 text-center border">
                    <p className="text-xs text-gray-500 mb-1">Ticker</p>
                    <p className="font-mono font-bold text-lg">{ticker}</p>
                  </div>
                  <div className="bg-red-50 rounded-lg p-3 text-center border border-red-200">
                    <p className="text-xs text-gray-500 mb-1">Stop Price</p>
                    <p className="font-mono font-bold text-[#FF6B6B] text-lg">{cs}{slPrice.toFixed(2)}</p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3 text-center border">
                    <p className="text-xs text-gray-500 mb-1">Quantity</p>
                    <p className="font-mono font-bold">{ibkrQty} shares</p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3 text-center border">
                    <p className="text-xs text-gray-500 mb-1">Order Type</p>
                    <p className="font-mono font-bold text-gray-700">STP · GTC</p>
                  </div>
                </div>
                {holdingContext && (
                  <div className="p-3 bg-gray-50 border rounded-lg text-xs text-gray-700">
                    <p className="font-semibold mb-1">סיכון הפסד</p>
                    <p>כניסה: ${holdingContext.buyPrice.toFixed(2)} → SL: ${slPrice.toFixed(2)}</p>
                    <p className="text-[#FF6B6B] font-semibold">הפסד מקסימלי: -${((holdingContext.buyPrice - slPrice) * parseFloat(ibkrQty || "0")).toFixed(0)} ({(((holdingContext.buyPrice - slPrice) / holdingContext.buyPrice) * 100).toFixed(1)}%)</p>
                  </div>
                )}
                {warnings.length > 0 && (
                  <div className="p-3 bg-red-50 border border-red-300 rounded-lg text-xs text-red-800 space-y-1">
                    {warnings.map((w, i) => <p key={i}>{w}</p>)}
                  </div>
                )}
                {!ibkrConnected && (
                  <div className="p-3 bg-orange-50 border border-orange-300 rounded-lg text-xs text-orange-800">
                    ⚠️ IBKR לא מחובר — הפקודה עשויה להיכשל. <a href="/ibkr" className="underline font-semibold">התחבר ל-IBKR</a>
                  </div>
                )}
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
                  ⚠️ הפקודה תבוצע ב-IBKR כפקודת <strong>SELL STP GTC</strong>. הפקודה תופעל כשהמחיר ירד ל-${slPrice.toFixed(2)}.
                </div>
              </div>
            );
          })()}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setSlDialogOpen(false)}>בטל</Button>
            <Button
              className="bg-[#FF6B6B] hover:bg-[#e05555] text-white gap-1.5"
              disabled
              title="SL/TP יוגדרו אוטומטית אחרי מילוי דרך placeManualOrder (שרת)"
              onClick={() => toast.info("הצבת SL תתבצע אחרי מילוי הפקודה — דרך השרת")}
            >
              {placeSTPMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldOff className="h-4 w-4" />}
              {placeSTPMut.isPending ? "שולח..." : "אשר ושלח פקודה"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── TP Confirmation Dialog ── */}
      <Dialog open={tpDialogOpen} onOpenChange={(o) => { if (!o) setTpDialogOpen(false); }}>
        <DialogContent className="max-w-sm" style={{ zIndex: Z.dialog }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[#65A30D]">
              <Target className="h-5 w-5" />
              אישור פקודת Take Profit
            </DialogTitle>
          </DialogHeader>
          {result && (() => {
            const tpPrice = parseFloat(editedTP || "0");
            const engineTP = result.recommendedBuyPrice > 0 ? result.recommendedBuyPrice * 1.15 : 0;
            const currentPrice = livePrice;
            const tpDeviation = engineTP > 0 ? Math.abs((tpPrice - engineTP) / engineTP) * 100 : 0;
            const tpTooLow = tpPrice > 0 && tpPrice < currentPrice * 1.01; // TP below 1% above current
            const tpFarFromEngine = tpDeviation > 15;
            const rrRatio = holdingContext && result.stopLoss > 0
              ? (tpPrice - holdingContext.buyPrice) / (holdingContext.buyPrice - result.stopLoss)
              : 0;
            const rrBad = rrRatio > 0 && rrRatio < 1.5;
            const warnings: string[] = [];
            if (tpTooLow) warnings.push(`⚠️ ה-TP ($${tpPrice.toFixed(2)}) קרוב מדי למחיר השוק ($${currentPrice.toFixed(2)}) — עלול להתבצע מידי`);
            if (tpFarFromEngine) warnings.push(`⚠️ ה-TP סוטה ${tpDeviation.toFixed(1)}% מהמלצת המנוע ($${engineTP.toFixed(2)})`);
            if (rrBad) warnings.push(`⚠️ יחס סיכון/רווח נמוך: ${rrRatio.toFixed(2)}:1 — מומלץ לפחות 1.5:1`);
            return (
              <div className="space-y-3 py-2">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="bg-gray-50 rounded-lg p-3 text-center border">
                    <p className="text-xs text-gray-500 mb-1">Ticker</p>
                    <p className="font-mono font-bold text-lg">{ticker}</p>
                  </div>
                  <div className="bg-emerald-50 rounded-lg p-3 text-center border border-emerald-200">
                    <p className="text-xs text-gray-500 mb-1">Limit Price</p>
                    <p className="font-mono font-bold text-[#65A30D] text-lg">{cs}{tpPrice.toFixed(2)}</p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3 text-center border">
                    <p className="text-xs text-gray-500 mb-1">Quantity</p>
                    <p className="font-mono font-bold">{ibkrTpQty} shares</p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3 text-center border">
                    <p className="text-xs text-gray-500 mb-1">Order Type</p>
                    <p className="font-mono font-bold text-gray-700">LMT · GTC</p>
                  </div>
                </div>
                {holdingContext && tpPrice > 0 && (
                  <div className="p-3 bg-gray-50 border rounded-lg text-xs text-gray-700">
                    <p className="font-semibold mb-1">תחזית רווח/סיכון</p>
                    <p>כניסה: ${holdingContext.buyPrice.toFixed(2)} → TP: ${tpPrice.toFixed(2)}</p>
                    <p className="text-[#65A30D] font-semibold">רווח צפוי: +${((tpPrice - holdingContext.buyPrice) * parseFloat(ibkrTpQty || "0")).toFixed(0)} (+{(((tpPrice - holdingContext.buyPrice) / holdingContext.buyPrice) * 100).toFixed(1)}%)</p>
                    {rrRatio > 0 && <p className={rrBad ? "text-orange-600" : "text-gray-600"}>יחס R/R: {rrRatio.toFixed(2)}:1</p>}
                  </div>
                )}
                {warnings.length > 0 && (
                  <div className="p-3 bg-orange-50 border border-orange-300 rounded-lg text-xs text-orange-800 space-y-1">
                    {warnings.map((w, i) => <p key={i}>{w}</p>)}
                  </div>
                )}
                {!ibkrConnected && (
                  <div className="p-3 bg-orange-50 border border-orange-300 rounded-lg text-xs text-orange-800">
                    ⚠️ IBKR לא מחובר — הפקודה עשויה להיכשל. <a href="/ibkr" className="underline font-semibold">התחבר ל-IBKR</a>
                  </div>
                )}
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
                  🎯 הפקודה תבוצע ב-IBKR כפקודת <strong>SELL LMT GTC</strong>. הפקודה תתבצע כשהמחיר יגיע ל-${tpPrice.toFixed(2)}.
                </div>
              </div>
            );
          })()}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setTpDialogOpen(false)}>בטל</Button>
            <Button
              className="bg-[#65A30D] hover:bg-[#17a87e] text-white gap-1.5"
              disabled
              title="SL/TP יוגדרו אוטומטית אחרי מילוי דרך placeManualOrder (שרת)"
              onClick={() => toast.info("הצבת TP תתבצע אחרי מילוי הפקודה — דרך השרת")}
            >
              {placeLMTMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Target className="h-4 w-4" />}
              {placeLMTMut.isPending ? "שולח..." : "אשר ושלח פקודה"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ManualOrderDialog
        open={mktDialogOpen}
        onOpenChange={(o) => { if (!o) { setMktDialogOpen(false); setManualIntent(null); } }}
        ticker={ticker ?? ""}
        manualIntent={manualIntent}
        result={result}
        currencySymbol={cs}
        livePrice={livePrice}
        mktQty={mktQty}
        onMktQtyChange={setMktQty}
        manualSl={manualSl}
        onManualSlChange={setManualSl}
        manualTp={manualTp}
        onManualTpChange={setManualTp}
        longUnits={longUnits}
        shortUnits={shortUnits}
        warScore={warQuery.data?.finalScore}
        manualPending={manualPending}
        submitDisabled={
          (!!orderPopupOpen && !!orderPopupData && !!ticker
            && orderPopupData.ticker.toUpperCase() === ticker.toUpperCase()
            && !!manualIntent && orderPopupData.side === intentToSide(manualIntent))
          || !mktQty || parseFloat(mktQty) <= 0
          || !ibkrConid || ibkrConid <= 0 || !manualIntent || !ticker
          || !isValidLivePrice(livePrice)
        }
        onSubmit={() => {
          if (!ticker || !manualIntent) return;
          const side = intentToSide(manualIntent);
          if (
            orderPopupOpen && orderPopupData
            && orderPopupData.ticker.toUpperCase() === ticker.toUpperCase()
            && orderPopupData.side === side
          ) {
            toast.error("יש פקודה פתוחה — בדוק ב-IBKR");
            return;
          }
          const qty = parseFloat(mktQty);
          if (!qty || qty <= 0 || !Number.isFinite(qty)) { toast.error("כמות לא תקינה"); return; }
          if (!isValidLivePrice(livePrice)) { toast.error("אין מחיר חי"); return; }
          const sl = manualSl ? parseFloat(manualSl) : null;
          const tp = manualTp ? parseFloat(manualTp) : null;
          void submitManualOrder({
            ticker,
            side,
            intent: manualIntent,
            quantity: qty,
            ...(parseFloat(mktSlippage) > 0 ? { slippagePct: parseFloat(mktSlippage) } : {}),
            sl: sl && !Number.isNaN(sl) ? sl : null,
            tp: tp && !Number.isNaN(tp) ? tp : null,
          });
        }}
      />

      {/* ── Quick Buy Dialog ── */}
      <Dialog open={buyDialogOpen} onOpenChange={(o) => { if (!o) { setBuyDialogOpen(false); setBuyUnits(""); setBuyPrice(""); } }}>
        <DialogContent className="max-w-sm" style={{ zIndex: Z.dialog }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[#65A30D]">
              <ShoppingCart className="h-5 w-5" />
              קנה {ticker}
            </DialogTitle>
          </DialogHeader>
          {result && (
            <div className="space-y-4 py-2">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="bg-muted/40 rounded-lg p-3 text-center">
                  <p className="text-xs text-muted-foreground mb-1">מחיר שוק</p>
                  <p className="font-mono font-bold">{cs}{livePrice.toFixed(2)}</p>
                </div>
                <div className="bg-red-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-muted-foreground mb-1">Stop Loss</p>
                  <p className="font-mono font-bold text-[#FF6B6B]">{cs}{result.stopLoss.toFixed(2)}</p>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="da-buy-price">מחיר קנייה ($)</Label>
                <Input
                  id="da-buy-price"
                  type="number" step="0.01" min="0.01" placeholder="0.00"
                  value={buyPrice}
                  onChange={(e) => setBuyPrice(e.target.value)}
                  className="font-mono"
                />
                <p className="text-xs text-[#65A30D]">מחיר כניסה מומלץ: ${result.recommendedBuyPrice.toFixed(2)}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="da-buy-units">כמות מניות</Label>
                <Input
                  id="da-buy-units"
                  type="number" step="1" min="1" placeholder="0"
                  value={buyUnits}
                  onChange={(e) => setBuyUnits(e.target.value)}
                  className="font-mono"
                  onKeyDown={(e) => { if (e.key === "Enter") handleConfirmBuy(); }}
                />
                {result.suggestedShares && (
                  <p className="text-xs text-[#2563EB]">כמות מומלצת: {result.suggestedShares} מניות</p>
                )}
                {buyPrice && buyUnits && parseFloat(buyPrice) > 0 && parseFloat(buyUnits) > 0 && (
                  <p className="text-xs text-muted-foreground">סה"כ: ${(parseFloat(buyPrice) * parseFloat(buyUnits)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                )}
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setBuyDialogOpen(false); setBuyUnits(""); setBuyPrice(""); }}>ביטול</Button>
            <Button
              className="bg-[#65A30D] hover:bg-[#17a87e] text-white gap-1.5"
              onClick={handleConfirmBuy}
              disabled={addHoldingMut.isPending || !buyUnits || !buyPrice}
            >
              {addHoldingMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />}
              אשר קנייה
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Add to Holding Dialog ───────────────────────────────────────────── */}
      <Dialog open={addToHoldingOpen} onOpenChange={(o) => { if (!o) { setAddToHoldingOpen(false); setAddToHoldingUnits(""); setAddToHoldingPrice(""); } }}>
        <DialogContent className="max-w-sm" style={{ zIndex: Z.dialog }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-violet-700">
              <PlusCircle className="h-5 w-5" />
              הוסף {ticker} לתיק
            </DialogTitle>
          </DialogHeader>
          {result && (
            <div className="space-y-4 py-2">
              {/* Target portfolio selector */}
              <div className="space-y-1.5">
                <Label>תיק יעד</Label>
                <Select value={addToHoldingTarget} onValueChange={(v) => setAddToHoldingTarget(v as "H1" | "H2")}>
                  <SelectTrigger className="font-semibold">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="H2">Holding 2 (H2) — ברירת מחדל</SelectItem>
                    <SelectItem value="H1">Holding 1 (H1)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {/* Price info */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="bg-muted/40 rounded-lg p-3 text-center">
                  <p className="text-xs text-muted-foreground mb-1">מחיר שוק</p>
                  <p className="font-mono font-bold">{cs}{livePrice.toFixed(2)}</p>
                </div>
                <div className="bg-red-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-muted-foreground mb-1">Stop Loss</p>
                  <p className="font-mono font-bold text-[#FF6B6B]">{cs}{result.stopLoss.toFixed(2)}</p>
                </div>
              </div>
              {/* Buy price */}
              <div className="space-y-1.5">
                <Label htmlFor="ath-price">מחיר קנייה ($)</Label>
                <Input
                  id="ath-price"
                  type="number" step="0.01" min="0.01" placeholder="0.00"
                  value={addToHoldingPrice}
                  onChange={(e) => setAddToHoldingPrice(e.target.value)}
                  className="font-mono"
                />
                <p className="text-xs text-[#65A30D]">מחיר כניסה מומלץ: ${result.recommendedBuyPrice.toFixed(2)}</p>
              </div>
              {/* Units */}
              <div className="space-y-1.5">
                <Label htmlFor="ath-units">כמות מניות</Label>
                <Input
                  id="ath-units"
                  type="number" step="1" min="1" placeholder="0"
                  value={addToHoldingUnits}
                  onChange={(e) => setAddToHoldingUnits(e.target.value)}
                  className="font-mono"
                  onKeyDown={(e) => { if (e.key === "Enter") handleConfirmAddToHolding(); }}
                />
                {result.suggestedShares && (
                  <p className="text-xs text-[#2563EB]">כמות מומלצת: {result.suggestedShares} מניות</p>
                )}
                {addToHoldingPrice && addToHoldingUnits && parseFloat(addToHoldingPrice) > 0 && parseFloat(addToHoldingUnits) > 0 && (
                  <p className="text-xs text-muted-foreground">סה"כ: ${(parseFloat(addToHoldingPrice) * parseFloat(addToHoldingUnits)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                )}
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setAddToHoldingOpen(false); setAddToHoldingUnits(""); setAddToHoldingPrice(""); }}>ביטול</Button>
            <Button
              className="bg-violet-600 hover:bg-violet-700 text-white gap-1.5"
              onClick={handleConfirmAddToHolding}
              disabled={addH2HoldingMut.isPending || addHoldingMut.isPending || !addToHoldingUnits || !addToHoldingPrice}
            >
              {(addH2HoldingMut.isPending || addHoldingMut.isPending) ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlusCircle className="h-4 w-4" />}
              הוסף ל-{addToHoldingTarget}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Signal Edit Dialog ───────────────────────────────────────────────── */}
      <Dialog open={signalEditOpen} onOpenChange={setSignalEditOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BookmarkPlus className="h-5 w-5 text-[#65A30D]" />
              ערוך איתות לפני שמירה
            </DialogTitle>
          </DialogHeader>
          {signalDraft && (
            <div className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">טיקר</Label>
                  <Input value={signalDraft.ticker} readOnly className="font-mono font-bold text-sm bg-muted" />
                </div>
                <div>
                  <Label className="text-xs">ציון ZIV</Label>
                  <Input
                    type="number" step="0.1" min="0" max="10"
                    value={signalDraft.zivScore}
                    onChange={(e) => setSignalDraft(d => d ? { ...d, zivScore: parseFloat(e.target.value) || 0 } : d)}
                    className="font-mono text-sm"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs">מחיר כניסה ($)</Label>
                  <Input
                    type="number" step="0.01"
                    value={signalDraft.entry}
                    onChange={(e) => setSignalDraft(d => d ? { ...d, entry: e.target.value } : d)}
                    className="font-mono text-sm text-[#65A30D] font-semibold"
                  />
                </div>
                <div>
                  <Label className="text-xs">Stop Loss ($)</Label>
                  <Input
                    type="number" step="0.01"
                    value={signalDraft.stopLoss}
                    onChange={(e) => setSignalDraft(d => d ? { ...d, stopLoss: e.target.value } : d)}
                    className="font-mono text-sm text-[#FF6B6B] font-semibold"
                  />
                </div>
                <div>
                  <Label className="text-xs">Take Profit ($)</Label>
                  <Input
                    type="number" step="0.01"
                    value={signalDraft.takeProfit}
                    onChange={(e) => setSignalDraft(d => d ? { ...d, takeProfit: e.target.value } : d)}
                    className="font-mono text-sm text-[#2563EB] font-semibold"
                  />
                </div>
              </div>
              <div>
                <Label className="text-xs">קטליסט / סיבה</Label>
                <Textarea
                  rows={3}
                  value={signalDraft.catalyst}
                  onChange={(e) => setSignalDraft(d => d ? { ...d, catalyst: e.target.value } : d)}
                  className="text-xs resize-none"
                  placeholder="סיבת הכניסה..."
                />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setSignalEditOpen(false)}>ביטול</Button>
            <Button
              onClick={confirmAddSignal}
              disabled={addSignalMut.isPending}
              className="bg-[#65A30D] hover:bg-[#17a87e] text-white"
            >
              {addSignalMut.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <BookmarkPlus className="h-4 w-4 mr-1" />}
              שמור איתות
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Order Status Popup */}
      {orderPopupOpen && orderPopupData && orderPopupData.ticker && (
        <ErrorBoundary>
          <OrderStatusPopup
            open={orderPopupOpen}
            onClose={() => {
              setOrderPopupOpen(false);
              setOrderPopupData(null);
              void utils.portfolio.getState.invalidate();
            }}
            onCloseWithOutcome={(outcome) => {
              if (!orderPopupData) return;
              const side = orderPopupData.side;
              const tk = orderPopupData.ticker;
              if (outcome === "stalled") setFlightPhase(tk, side, "stalled");
              else if (outcome === "terminal") clearFlight(tk, side);
            }}
            orderId={orderPopupData.orderId ?? null}
            ticker={orderPopupData.ticker}
            side={orderPopupData.side}
            quantity={orderPopupData.quantity ?? 0}
            orderType={orderPopupData.orderType ?? "MKT"}
            sentAt={orderPopupData.sentAt instanceof Date ? orderPopupData.sentAt : new Date()}
            ibkrMessage={orderPopupData.ibkrMessage}
            intentLabel={orderPopupData.intentLabel}
            estimatedValueUsd={orderPopupData.estimatedValueUsd}
            clientOrderId={orderPopupData.clientOrderId}
            trackPositionClose={orderPopupData.trackPositionClose}
            protection={orderPopupData.protection}
            immediateStatus={orderPopupData.immediateStatus}
            onComplete={() => {
              if (orderPopupData) clearFlight(orderPopupData.ticker, orderPopupData.side);
              void utils.portfolio.getState.invalidate();
              void utils.liveEngine.getStatus.invalidate();
            }}
          />
        </ErrorBoundary>
      )}

    </>
  );
}
