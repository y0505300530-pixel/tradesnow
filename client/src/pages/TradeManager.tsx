import { useState, useEffect, useRef, useCallback, useMemo, useReducer } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Loader2, Trash2, Plus, RefreshCw,
  Wallet, ArrowDownCircle, ArrowUpCircle, BarChart2, AlertTriangle,
  CheckCircle, ArrowRightLeft, Edit2, Check, X, TrendingUp, XCircle,
  Wifi, WifiOff, Building2, ChevronsUpDown, ChevronUp, ChevronDown,
  BookOpen, BookMarked, ShieldAlert, Target, MessageSquare, Send, Bot, TrendingDown, ShieldCheck,
} from "lucide-react";
import React, { lazy, Suspense, memo } from "react";
import type { Holding, HoldingRec, BuyOpp, SwapRec, AnalysisResult, ZivHData } from "./TradeManager/types";
import { pnlColor, actionColor, urgencyIcon, scoreColor, healthColor } from "./TradeManager/helpers";
import { ScoreBadge } from "./TradeManager/components/ScoreBadge";
import { ZivHBadge } from "./TradeManager/components/ZivHBadge";
import { HoldingRow } from "./TradeManager/components/HoldingRow";
import { AddHoldingDialog } from "./TradeManager/components/AddHoldingDialog";
import { CapitalDialog } from "./TradeManager/components/CapitalDialog";
import { BuyFromCatalogueDialog } from "./TradeManager/components/BuyFromCatalogueDialog";
import { EditCatalogueDialog } from "./TradeManager/components/EditCatalogueDialog";
import { usePortfolioState } from "./TradeManager/hooks/usePortfolioState";
import { CapitalSummaryCards } from "./TradeManager/sections/CapitalSummaryCards";
import { HoldingsSection } from "./TradeManager/sections/HoldingsSection";
import { AnalysisSection } from "./TradeManager/sections/AnalysisSection";
import { useLivePrices } from "./TradeManager/hooks/useLivePrices";
import { useUnifiedPriceStream } from "@/hooks/useUnifiedPriceStream";
import { usePortfolioMetrics, computeTodayPnl } from "@/hooks/usePortfolioMetrics";
import { useIbkrSync } from "./TradeManager/hooks/useIbkrSync";
import { RefreshControl } from "@/components/RefreshControl";
import { useIbkrRefresh } from "@/contexts/IbkrRefreshContext";
import { useIbkrMarketData, type IbkrPriceEntry } from "@/hooks/useIbkrMarketData";
import { TickerAutocomplete } from "@/components/TickerAutocomplete";
import { OrderStatusPopup } from "@/components/OrderStatusPopup";
// Heavy components — lazy loaded to reduce initial bundle size
const IBKROrderDialog = lazy(() => import("@/components/IBKROrderDialog").then(m => ({ default: m.IBKROrderDialog })));
const IBKRBracketDialog = lazy(() => import("@/components/IBKRBracketDialog").then(m => ({ default: m.IBKRBracketDialog })));
const IBINDConnectScreen = lazy(() => import("@/components/IBINDConnectScreen").then(m => ({ default: m.IBINDConnectScreen })));
const PortfolioPerformanceChart = lazy(() => import("@/components/PortfolioPerformanceChart").then(m => ({ default: m.PortfolioPerformanceChart })));
const PerformanceChart = lazy(() => import("@/components/PerformanceChart").then(m => ({ default: m.PerformanceChart })));


// ─── Quick Add Row ───────────────────────────────────────────────────────────
function QuickAddRow({ onAdded, cashBalance }: { onAdded: () => void; cashBalance: number }) {
  const [ticker, setTicker] = useState("");
  const [buyPrice, setBuyPrice] = useState("");
  const [units, setUnits] = useState("");
  const [active, setActive] = useState(false);
  const cost = parseFloat(buyPrice || "0") * parseFloat(units || "0");
  const hasInsufficientCash = cost > 0 && cost > cashBalance;
  const addMut = trpc.portfolio.addHolding.useMutation({
    onSuccess: (data) => {
      const cashAfter = data.cashAfter ?? cashBalance - cost;
      toast.success(
        `${ticker.toUpperCase()} added · Cash: $${cashAfter.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
        { duration: 4000 }
      );
      setTicker(""); setBuyPrice(""); setUnits(""); setActive(false);
      onAdded();
    },
    onError: (e) => toast.error(e.message),
  });
  const handleQuickAdd = () => {
    if (!ticker || !buyPrice || !units) return toast.error("Ticker, price and units required");
    if (hasInsufficientCash) {
      toast.warning(`Insufficient cash — need $${cost.toLocaleString(undefined, { maximumFractionDigits: 0 })} but have $${cashBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })}. Adding anyway (overdraft).`, { duration: 5000 });
    }
    addMut.mutate({ ticker: ticker.toUpperCase(), buyPrice: parseFloat(buyPrice), units: parseFloat(units) });
  };
  if (!active) {
    return (
      <TableRow
        className="border-dashed border-t cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => setActive(true)}
      >
        <TableCell colSpan={10} className="py-2.5">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Plus className="h-4 w-4" />
            <span>Quick add holding…</span>
          </div>
        </TableCell>
      </TableRow>
    );
  }
  return (
    <TableRow className="bg-muted/20 border-t-2 border-blue-200">
      <TableCell className="text-xs text-muted-foreground text-center">—</TableCell>
      <TableCell className="py-2">
        <TickerAutocomplete
          value={ticker}
          onChange={(symbol) => setTicker(symbol)}
          onEnter={handleQuickAdd}
          placeholder="AAPL"
          inputClassName="h-8 w-28 font-mono text-sm"
          autoFocus
        />
      </TableCell>
      <TableCell className="py-2" colSpan={1}>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">Quick Add</span>
          {cost > 0 && (
            <span className={`text-[10px] font-mono font-semibold ${
              hasInsufficientCash ? "text-[#FF6B6B]" : "text-[#65A30D]"
            }`}>
              {hasInsufficientCash ? "⚠ " : ""}
              Cost: ${cost.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="py-2">
        <Input
          type="number"
          placeholder="Buy $"
          value={buyPrice}
          onChange={e => setBuyPrice(e.target.value)}
          className={`h-8 w-24 text-right text-sm ${hasInsufficientCash ? "border-red-400 focus-visible:ring-red-400" : ""}`}
        />
      </TableCell>
      <TableCell className="py-2">
        <Input
          type="number"
          placeholder="Units"
          value={units}
          onChange={e => setUnits(e.target.value)}
          className={`h-8 w-20 text-right text-sm ${hasInsufficientCash ? "border-red-400 focus-visible:ring-red-400" : ""}`}
          onKeyDown={e => e.key === "Enter" && handleQuickAdd()}
        />
      </TableCell>
      <TableCell colSpan={3} />
      <TableCell colSpan={1} />
      <TableCell className="py-2">
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" className="h-7 w-7 text-[#65A30D]" onClick={handleQuickAdd} disabled={addMut.isPending}>
            {addMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" onClick={() => setActive(false)}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────────────────────────────
export default function TradeManager() {
  const [, navigate] = useLocation();
  const { user, loading: authLoading } = useAuth();
  const isAdmin = user?.role === "admin";
  const utils = trpc.useUtils();
  const [showAdd, setShowAdd] = useState(false);
  const [capitalMode, setCapitalMode] = useState<"deposit" | "withdraw" | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  // ── AI Chat state ──
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const chatInitialLoadRef = useRef(true); // prevent auto-scroll on initial history load
  const [chatHistoryLoaded, setChatHistoryLoaded] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // Load persisted chat history from DB on mount
  const { data: persistedChatHistory } = trpc.portfolio.getChatHistory.useQuery(undefined, {
    staleTime: 60_000,      // cache for 1 minute — chat history doesn't change externally
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (persistedChatHistory) {
      chatInitialLoadRef.current = true;
      setChatMessages(persistedChatHistory.map(m => ({ role: m.role as "user" | "assistant", content: m.content })));
      setChatHistoryLoaded(true);
      // Allow scroll after initial load settles
      setTimeout(() => { chatInitialLoadRef.current = false; }, 200);
    }
  }, [persistedChatHistory]);

  const portfolioChatMut = trpc.portfolio.portfolioChat.useMutation({
    onSuccess: (data) => {
      setChatMessages(prev => [...prev, { role: "assistant", content: data.reply }]);
    },
    onError: (e) => toast.error(e.message),
  });

  const handleChatSend = (holdingsRef?: any[], cashRef?: number, nlvRef?: number) => {
    const msg = chatInput.trim();
    if (!msg) return;
    setChatInput("");
    setChatMessages(prev => [...prev, { role: "user", content: msg }]);
    // Build holdings context (always available)
    const hCtx = (holdingsRef ?? []).map(h => ({
      ticker: h.ticker,
      company: h.company,
      units: h.units,
      buyPrice: h.buyPrice,
      currentPrice: h.currentPrice,
      stopLoss: h.stopLoss,
      takeProfit: h.takeProfit,
    }));
    const aCtx = {
      cashBalance: cashRef ?? 0,
      netLiquidation: nlvRef ?? 0,
    };
    portfolioChatMut.mutate({
      userMessage: msg,
      holdingsContext: hCtx.length > 0 ? JSON.stringify(hCtx) : undefined,
      accountContext: JSON.stringify(aCtx),
      analysisContext: analysis ? JSON.stringify({
        portfolioHealthScore: analysis.portfolioHealthScore,
        portfolioHealthSummary: analysis.portfolioHealthSummary,
        holdingRecommendations: analysis.holdingRecommendations,
        buyOpportunities: analysis.buyOpportunities,
        swapRecommendations: analysis.swapRecommendations,
        cashDeploymentPlan: analysis.cashDeploymentPlan,
        keyRisks: analysis.keyRisks,
        totalPortfolioValue: analysis.totalPortfolioValue,
        cashBalance: analysis.cashBalance,
      }) : undefined,
      chatHistory: chatMessages.slice(-10), // last 10 messages for context
    });
  };

  // Auto-scroll chat to bottom — only after user sends a message or AI replies, NOT on initial load
  useEffect(() => {
    if (chatInitialLoadRef.current) return; // skip initial history load
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  // ── Signal change tracking (for toast alerts) ──
  const prevSignalsRef = useRef<Record<string, string>>({});

  // ── SL/TP Monitor: Deep Analysis ──
  const [sltpDeepTicker, setSltpDeepTicker] = useState<string | null>(null);
  // ── Deep Analysis navigation: unified H1+H2 nav list ──
  const [deepNavTicker, setDeepNavTicker] = useState<string | null>(null);

  // (replacements, retestWatchlist, dailyReview state moved to AnalysisSection)
  const [diaryExpanded, setDiaryExpanded] = useState(false);

  // ── Holdings table sort state ──
  const [holdingsSortCol, setHoldingsSortCol] = useState<string | null>(null);
  const [holdingsSortDir, setHoldingsSortDir] = useState<"asc" | "desc" | null>(null);
  const handleHoldingsSort = useCallback((col: string) => {
    setHoldingsSortCol(prev => {
      if (prev === col) {
        // Cycle: desc → asc → null (unsorted)
        setHoldingsSortDir(d => {
          if (d === "desc") return "asc";
          if (d === "asc") { return null; }
          return "desc";
        });
        // When cycling to null, also clear col via a microtask
        // We handle this by checking dir===asc in the useMemo guard
        return col;
      }
      setHoldingsSortDir("desc");
      return col;
    });
  }, []);

  // ── H2 table sort state ──
  // ── H2 sort state — single reducer for atomic col+dir updates ──
  type H2SortState = { col: string | null; dir: "asc" | "desc" | null };
  const [h2Sort, dispatchH2Sort] = useReducer(
    (state: H2SortState, col: string): H2SortState => {
      if (state.col !== col) return { col, dir: "desc" };
      const nextDir: "asc" | "desc" | null = state.dir === "desc" ? "asc" : state.dir === "asc" ? null : "desc";
      return { col: nextDir === null ? null : col, dir: nextDir };
    },
    { col: "holdingValue", dir: "desc" } as H2SortState
  );
  const h2SortCol = h2Sort.col;
  const h2SortDir = h2Sort.dir;
  const handleH2Sort = useCallback((col: string) => dispatchH2Sort(col), []);

  // ── Portfolio state + ZIV H scores (extracted hook) ──
  const {
    state, isLoading, refetchState, zivHMap, zivHByTicker, zivHMapH2,
    autoRefreshInterval, setAutoRefreshInterval,
    lastRefreshedAt, setLastRefreshedAt,
    minutesSinceRefresh, setMinutesSinceRefresh,
    refreshZivH, isRefreshingZivH,
  } = usePortfolioState();

  // ── Trading Diary ──
  const { data: diaryEntries, refetch: refetchDiary } = trpc.portfolio.getDiaryEntries.useQuery();
  const [diaryAddingFor, setDiaryAddingFor] = useState<Holding | null>(null);
  const [diaryAddingLoading, setDiaryAddingLoading] = useState(false);
  const addDiaryMut = trpc.portfolio.addDiaryEntry.useMutation({
    onSuccess: (data) => {
      refetchDiary();
      setDiaryAddingFor(null);
      setDiaryAddingLoading(false);
      if (data.alreadyExisted) {
        toast.info("הנייר כבר קיים ביומן המסחר");
      } else {
        toast.success("נוסף ליומן המסחר");
      }
    },
    onError: (e) => { toast.error(e.message); setDiaryAddingLoading(false); },
  });
  const deleteDiaryMut = trpc.portfolio.deleteDiaryEntry.useMutation({
    onSuccess: () => { refetchDiary(); toast.success("נמחק מהיומן"); },
    onError: (e) => toast.error(e.message),
  });
  const updateDiaryMut = trpc.portfolio.updateDiaryEntry.useMutation({
    onSuccess: () => { refetchDiary(); setEditingDiaryId(null); toast.success("יומן עודכן"); },
    onError: (e) => toast.error(e.message),
  });
  const [editingDiaryId, setEditingDiaryId] = useState<number | null>(null);
  const [editDiaryReason, setEditDiaryReason] = useState("");
  const [editDiaryExpectations, setEditDiaryExpectations] = useState("");
  const [editDiarySL, setEditDiarySL] = useState("");
  const [editDiaryTP, setEditDiaryTP] = useState("");
  const [showClosedDiary, setShowClosedDiary] = useState(false);
  const handleAddToDiary = (h: Holding) => {
    setDiaryAddingFor(h);
    setDiaryAddingLoading(true);
    const rawSl = (h as any).stopLoss;
    const rawTp = (h as any).takeProfit;
    addDiaryMut.mutate({
      ticker: h.ticker,
      company: h.company ?? undefined,
      units: h.units,
      buyPrice: h.buyPrice,
      stopLoss: rawSl != null && rawSl !== '' ? Number(rawSl) : undefined,
      takeProfit: rawTp != null && rawTp !== '' ? Number(rawTp) : undefined,
    });
  };

  // ── Holding 2 — second manual portfolio ──
  const { data: h2Data, refetch: refetchH2 } = trpc.holding2.list.useQuery(undefined, { refetchOnMount: true });
  const [h2Expanded, setH2Expanded] = useState(true);
  const [h2ShowAdd, setH2ShowAdd] = useState(false);
  const [h2Ticker, setH2Ticker] = useState("");
  const [h2Company, setH2Company] = useState("");
  const [h2BuyPrice, setH2BuyPrice] = useState("");
  const [h2Units, setH2Units] = useState("");
  const [h2Notes, setH2Notes] = useState("");
  const [h2EditId, setH2EditId] = useState<number | null>(null);
  const [h2EditUnits, setH2EditUnits] = useState("");
  const [h2EditBuyPrice, setH2EditBuyPrice] = useState("");
  const [h2EditTicker, setH2EditTicker] = useState("");
  // Fast-add inline row state
  const [h2FastTicker, setH2FastTicker] = useState("");
  const [h2FastCompany, setH2FastCompany] = useState("");
  const [h2FastUnits, setH2FastUnits] = useState("");
  const [h2FastPrice, setH2FastPrice] = useState("");
  const [h2FastNotes, setH2FastNotes] = useState("");
  const [h2AcOpen, setH2AcOpen] = useState(false);
  const [h2AcQuery, setH2AcQuery] = useState("");
  const h2AcRef = useRef<HTMLDivElement>(null);
  const [h2DeepTicker, setH2DeepTicker] = useState<string | null>(null);
  const [h2DeepHoldingCtx, setH2DeepHoldingCtx] = useState<{ id: number; buyPrice: number; units: number; currentPrice: number; pnlUsd: number; pnlPct: number; stopLoss?: number | null; takeProfit?: number | null } | null>(null);
  const [h2AnalyzeResults, setH2AnalyzeResults] = useState<Array<{ id: number; ticker: string; zivScore: number; tier: string; action: string; reasoning: string; stopLoss: number | null; takeProfit: number | null; positionSizePct: number | null; suggestedUnits: number | null; buyPrice?: number; units?: number; currentPrice?: number }>>([]);
  const [h2Analyzing, setH2Analyzing] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setH2AcQuery(h2FastTicker.trim()), 300);
    return () => clearTimeout(t);
  }, [h2FastTicker]);
  const h2TickerSearch = trpc.searchTicker.useQuery(
    { q: h2AcQuery },
    { enabled: h2AcQuery.length >= 1, staleTime: 30_000 }
  );
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (h2AcRef.current && !h2AcRef.current.contains(e.target as Node)) setH2AcOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const h2AddMut = trpc.holding2.add.useMutation({
    onSuccess: () => { toast.success("נוסף ל-Holding 2"); refetchH2(); setH2ShowAdd(false); setH2Ticker(""); setH2Company(""); setH2BuyPrice(""); setH2Units(""); setH2Notes(""); setH2FastTicker(""); setH2FastCompany(""); setH2FastUnits(""); setH2FastPrice(""); setH2FastNotes(""); },
    onError: (e) => toast.error(e.message),
  });
  const h2RemoveMut = trpc.holding2.remove.useMutation({
    onSuccess: () => { toast.success("הוסר"); refetchH2(); },
    onError: (e) => toast.error(e.message),
  });
  const h2UpdateMut = trpc.holding2.update.useMutation({
    onSuccess: () => { toast.success("עודכן"); refetchH2(); setH2EditId(null); },
    onError: (e) => toast.error(e.message),
  });
  const h2RefreshMut = trpc.holding2.refreshPrices.useMutation({
    onSuccess: () => { refetchH2(); },
    onError: (e) => toast.error(e.message),
  });
  const h2FixIsraeliMut = trpc.holding2.fixIsraeliPrices.useMutation({
    onSuccess: (d) => {
      if (d.fixed.length > 0) toast.success(`תוקן: ${d.fixed.join(", ")}`);
      else toast.info("אין שורות לתיקון");
      refetchH2();
    },
    onError: (e) => toast.error(e.message),
  });
  const h2AnalyzeMut = trpc.portfolio.analyzeHolding2.useMutation({
    onSuccess: (data) => {
      setH2AnalyzeResults(data.results);
      setH2Analyzing(false);
      refetchH2(); // refresh H2 list so zivScore column updates immediately
      toast.success(`Holding 2: scored ${data.results.length} positions`);
    },
    onError: (e) => { toast.error(e.message); setH2Analyzing(false); },
  });

  const refreshMut = trpc.portfolio.refreshPrices.useMutation({
    onSuccess: () => {
      utils.portfolio.getState.invalidate();
      setLastRefreshedAt(new Date());
      setMinutesSinceRefresh(0);
    },
    onError: () => {},
  });

  const deleteMut = trpc.portfolio.deleteHolding.useMutation({
    onSuccess: () => { toast.success("Holding removed"); utils.portfolio.getState.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  // Market Sell quick action from Holdings table
  const [sellMarketTarget, setSellMarketTarget] = useState<Holding | null>(null);
  const [sellMarketSlippage, setSellMarketSlippage] = useState<string>("0.5");
  const [sellMarketQty, setSellMarketQty] = useState<string>("");
  // Order Status Popup state (Live Trading)
  const [orderPopupOpen, setOrderPopupOpen] = useState(false);
  const [orderPopupData, setOrderPopupData] = useState<{
    ticker: string; side: "BUY" | "SELL"; quantity: number;
    orderId: string | null; immediateStatus: "success" | "failed";
    ibkrMessage: string | null;
  } | null>(null);
  const placeMarketMut = trpc.ibkr.placeMarketOrder.useMutation({
    onSuccess: (data) => {
      setSellMarketTarget(null);
      utils.portfolio.getState.invalidate();
      setOrderPopupData({
        ticker: data.ticker,
        side: data.side as "BUY" | "SELL",
        quantity: data.quantity,
        orderId: data.orderId ?? null,
        immediateStatus: data.orderId ? "success" : "failed",
        ibkrMessage: data.orderId
          ? `Order ${data.orderId} placed successfully. Market price: $${data.marketPrice ?? "N/A"}`
          : "Order submitted but no order ID returned",
      });
      setOrderPopupOpen(true);
    },
    onError: (e) => {
      setOrderPopupData({
        ticker: sellMarketTarget?.ticker ?? "?",
        side: "SELL",
        quantity: parseInt(sellMarketQty, 10) || 0,
        orderId: null,
        immediateStatus: "failed",
        ibkrMessage: e.message,
      });
      setOrderPopupOpen(true);
    },
  });

  // Debug: raw IBIND /orders response
  const [showDebugOrders, setShowDebugOrders] = useState(false);
  const [debugOrdersData, setDebugOrdersData] = useState<any>(null);
  const [debugOrdersLoading, setDebugOrdersLoading] = useState(false);

  // External holding score map — updated by AnalysisSection callback
  const [externalHoldingScoreMap, setExternalHoldingScoreMap] = useState<Record<number, { positionSizePct: number | null; suggestedUnits: number | null }>>({});

  // ── IBKR state + sync (extracted hook) ──
  const {
    ibkrStatus, setIbkrStatus, ibkrAccountId, setIbkrAccountId,
    ibindSessionChecked, ibindSessionActive, setIbindSessionActive, ibindClosedReason, ibindClosedAt,
    ibkrSettings, ibkrGatewayUrl, stopSessionMutation,
    ibkrPositionsData, ibkrSummaryData, ibkrPnlData, ibkrPositionMap, refetchIbkrPositions,
    syncFromIbkrMut, handleSyncFromIbkr, syncSlTpMut, logJournalMut,
  } = useIbkrSync(isAdmin, authLoading);

  // ── IBKR order dialog targets ──
  const [ibkrOrderTarget, setIbkrOrderTarget] = useState<{
    ticker: string; company?: string; currentPrice?: number;
    stopLoss?: number; takeProfit?: number; suggestedUnits?: number; side: "BUY" | "SELL";
  } | null>(null);
  const [bracketOrderTarget, setBracketOrderTarget] = useState<{
    ticker: string; company?: string; currentPrice?: number;
    stopLoss?: number; takeProfit?: number; suggestedUnits?: number; side: "BUY" | "SELL";
    conid?: number;
  } | null>(null);

  // ── Catalogue state ──
  const [catalogueSearch, setCatalogueSearch] = useState("");
  const [catalogueShowAll, setCatalogueShowAll] = useState(false);
  const [holdingsLastScanned, setHoldingsLastScanned] = useState<Date | null>(null);
  const [buyTarget, setBuyTarget] = useState<{ id: number; ticker: string; company: string; score: number | null } | null>(null);
  const [editTarget, setEditTarget] = useState<{ id: number; ticker: string; company: string; sector: string } | null>(null);
  const { data: catalogueData, refetch: refetchCatalogue } = trpc.portfolio.getCatalogueWithScores.useQuery();
  const deleteAssetMut = trpc.assetCatalogue.deleteUserAsset.useMutation({
    onSuccess: () => { toast.success("Asset removed from catalogue"); refetchCatalogue(); },
    onError: (e) => toast.error(e.message),
  });
  const catalogueAll = (catalogueData ?? []).filter(a =>
    !catalogueSearch || a.ticker.toLowerCase().includes(catalogueSearch.toLowerCase()) || (a.company ?? "").toLowerCase().includes(catalogueSearch.toLowerCase())
  );
  const catalogueHasScores = catalogueData?.some(a => a.score != null);
  const catalogue = catalogueAll;

  // (Analysis mutations moved to AnalysisSection)

  // ── Holdings and account from state ──
  const holdings: Holding[] = (state?.holdings ?? []) as Holding[];
  const account = state?.account;

  // ── Sync SL/TP alerts for all holdings on mount ──
  const syncAlertsMut = trpc.portfolio.syncHoldingAlerts.useMutation();
  // ── Force SL/TP Re-sync from Ziv Engine (admin only) ──
  const forceSlResyncMut = trpc.portfolio.forceSlResync.useMutation({
    onSuccess: (data) => {
      refetchState();
      toast.success(`SL/TP עודכנו: ${data.updated} החזקות, ${data.skipped} ללא שינוי${data.errors.length > 0 ? ` | שגיאות: ${data.errors.join(', ')}` : ''}`);
    },
    onError: (e) => toast.error(`SL Resync נכשל: ${e.message}`),
  });
  // dedupHoldingsMut removed — addHolding now auto-merges duplicates
  const alertsSyncedRef = useRef(false);
  useEffect(() => {
    if (alertsSyncedRef.current) return;
    if (isLoading) return;
    if (holdings.length === 0) return;
    alertsSyncedRef.current = true;
    syncAlertsMut.mutate();
  }, [isLoading, holdings.length]);

  // ── Unified IBKR Market Data (60s pulse) ──
  const holdingTickers = useMemo(() => holdings.map(h => h.ticker), [holdings.map(h => h.ticker).join(',')]);
  const ibkrConnected = ibkrStatus === 'connected';
  // Deduplicated ticker list for Yahoo Finance query — same ticker can appear multiple times for separate positions
  const h2Tickers = useMemo(() => Array.from(new Set((h2Data ?? []).filter(r => r.units !== 0).map(r => r.ticker))), [(h2Data ?? []).filter(r => r.units !== 0).map(r => r.ticker).join(',')]);

  // ── Yahoo Finance live prices for H2 (fallback when IBKR is not connected) ──
  // Provides real change/changePercent/prevClose for TASE stocks that DB doesn't cache.
  const { data: h2YahooPrices } = trpc.portfolio.getLivePrices.useQuery(
    { tickers: h2Tickers },
    {
      enabled: h2Tickers.length > 0 && !ibkrConnected,
      staleTime: 30_000,
      refetchInterval: 60_000,
      refetchOnWindowFocus: false,
    }
  );
  const h2YahooPriceMap = useMemo(() => {
    const map: Record<string, { price: number | null; change: number | null; changePercent: number | null; prevClose: number | null; isExtendedHours?: boolean }> = {};
    (h2YahooPrices ?? []).forEach(p => {
      if (p.price != null) map[p.ticker] = { price: p.price, change: p.change, changePercent: p.changePercent, prevClose: p.prevClose, isExtendedHours: p.isExtendedHours };
    });
    return map;
  }, [h2YahooPrices]);

  // ── Unified IBKR Market Data hook (60s pulse) ──
  // Single source of truth for ALL live prices: H1, H2, Catalogue
  const { notifyUpdated } = useIbkrRefresh();
  const { h1PriceMap: ibkrH1Map, h2PriceMap: ibkrH2Map, catPriceMap: ibkrCatMap, lastUpdated: ibkrLastUpdated } = useIbkrMarketData({
    h1Tickers: holdingTickers,
    h2Tickers,
    catalogueTickers: [],  // will be set below after catalogueTickers is defined
    ibkrConnected,
  });

  // Notify global context whenever IBKR data updates
  useEffect(() => { if (ibkrLastUpdated) notifyUpdated(ibkrLastUpdated); }, [ibkrLastUpdated]);

  // H1 price map: IBKR when connected
  // For change/changePercent: prefer ibkrPositionMap[ticker].mktPrice (real-time, matches IBKR App)
  // over snapshot pre_market_price (5-min history bar, slightly lagged).
  // Formula: change = mktPrice - prevClose; changePercent = change / prevClose * 100
  // ── Yahoo Finance live prices for H1 (fallback when IBKR is not connected) ──
  const { data: h1YahooPrices } = trpc.portfolio.getLivePrices.useQuery(
    { tickers: holdingTickers },
    {
      enabled: holdingTickers.length > 0 && !ibkrConnected,
      staleTime: 30_000,
      refetchInterval: 60_000,
      refetchOnWindowFocus: false,
    }
  );
  const h1YahooPriceMap = useMemo(() => {
    const map: Record<string, { price: number | null; change: number | null; changePercent: number | null; prevClose: number | null; isExtendedHours?: boolean }> = {};
    (h1YahooPrices ?? []).forEach(p => {
      if (p.price != null) map[p.ticker] = { price: p.price, change: p.change, changePercent: p.changePercent, prevClose: p.prevClose, isExtendedHours: p.isExtendedHours };
    });
    return map;
  }, [h1YahooPrices]);

  const holdingLivePriceMap = useMemo(() => {
    // ── 3-layer priority: IBKR (primary) > Yahoo Finance live (secondary) > empty ──
    // Backend (PriceService.normalizeIbindBatch) already computes:
    //   OPEN: change = last_price - prior_close
    //   PRE/AFTER: change = pre_market_price - prior_close
    //   CLOSED: change = 0
    const map: Record<string, { price: number | null; change: number | null; changePercent: number | null; prevClose: number | null; isExtendedHours?: boolean; isClosingPrice?: boolean }> = {};
    // Layer 1: Yahoo Finance live prices (real-time, includes change/prevClose)
    Object.entries(h1YahooPriceMap).forEach(([sym, p]) => {
      if (p.price != null) map[sym] = { price: p.price, change: p.change, changePercent: p.changePercent, prevClose: p.prevClose, isExtendedHours: p.isExtendedHours };
    });
    // Layer 2: Override with IBKR when connected (most accurate/real-time)
    if (ibkrConnected) {
      Object.entries(ibkrH1Map).forEach(([sym, q]) => {
        const e = q as IbkrPriceEntry;
        map[sym] = {
          price: e.price,
          change: e.change,
          changePercent: e.changePercent,
          prevClose: e.prevClose,
          isExtendedHours: e.isExtendedHours ?? false,
          isClosingPrice: e.isClosingPrice ?? false,
        };
      });
    }
    return map;
  }, [ibkrConnected, ibkrH1Map, h1YahooPriceMap]);

  // H2 price map: 3-layer priority — IBKR (primary) > Yahoo Finance live (secondary) > DB cache (fallback)
  // This ensures TASE stocks always get real change/changePercent/prevClose even without IBKR.
  const h2LivePriceMap = useMemo(() => {
    const map: Record<string, { price: number | null; change: number | null; changePercent: number | null; prevClose: number | null; isClosingPrice?: boolean; isExtendedHours?: boolean }> = {};
    // Layer 1: DB-cached Yahoo Finance values as baseline
    (h2Data ?? []).filter(r => r.units !== 0).forEach(r => {
      const cp = r.currentPrice ?? null;
      const pc = (r as any).prevClose ?? null;
      const chgPct = r.dailyChangePercent ?? null;
      // Derive change: prefer prevClose-based (exact), fall back to reverse-engineering from %
      // Formula: prevClose = price / (1 + chgPct/100)  →  change = price - prevClose
      const chg = (cp != null && pc != null && pc > 0) ? cp - pc
        : (cp != null && chgPct != null && chgPct !== 0) ? cp - (cp / (1 + chgPct / 100))
        : null;
      if (cp != null) {
        map[r.ticker] = { price: cp, change: chg, changePercent: chgPct, prevClose: pc };
      }
    });
    // Layer 2: Yahoo Finance live prices (real-time, includes TASE change/prevClose)
    Object.entries(h2YahooPriceMap).forEach(([sym, p]) => {
      if (p.price != null) map[sym] = { price: p.price, change: p.change, changePercent: p.changePercent, prevClose: p.prevClose, isExtendedHours: p.isExtendedHours };
    });
    // Layer 3: Override with live IBKR prices when connected (most accurate/real-time)
    if (ibkrConnected) {
      Object.entries(ibkrH2Map).forEach(([sym, q]) => {
        const e = q as IbkrPriceEntry;
        map[sym] = { price: e.price, change: e.change, changePercent: e.changePercent, prevClose: e.prevClose, isClosingPrice: e.isClosingPrice, isExtendedHours: e.isExtendedHours };
      });
    }
    return map;
  }, [ibkrConnected, ibkrH2Map, h2Data, h2YahooPriceMap]);

  // ── H2 total portfolio value (for equity snapshots + chart) ──
  const h2TotalValue = useMemo(() => {
    const rows = (h2Data ?? []).filter(r => r.units !== 0);
    if (rows.length === 0) return 0;
    return rows.reduce((sum, r) => {
      const livePrice = h2LivePriceMap[r.ticker]?.price;
      const price = livePrice ?? r.currentPrice ?? r.buyPrice;
      return sum + price * r.units;
    }, 0);
  }, [h2Data, h2LivePriceMap]);

  // ── H2 summary stats ──
  const h2SummaryStats = useMemo(() => {
    const rows = (h2Data ?? []).filter(r => r.units !== 0);
    if (rows.length === 0) return null;
    let totalCost = 0;
    let todayPnl = 0;
    let hasLive = false;
    rows.forEach(r => {
      totalCost += r.buyPrice * Math.abs(r.units);
      const lp = h2LivePriceMap[r.ticker];
      if (lp?.price != null && lp?.prevClose != null && lp.prevClose > 0) {
        todayPnl += (lp.price - lp.prevClose) * r.units;
        hasLive = true;
      } else if (lp?.change != null && lp.change !== 0) {
        todayPnl += lp.change * r.units;
        hasLive = true;
      }
    });
    const totalPnl = h2TotalValue - totalCost;
    const pnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
    return { totalCost, totalPnl, pnlPct, todayPnl: hasLive ? todayPnl : null };
  }, [h2Data, h2TotalValue, h2LivePriceMap]);

  // ── Backfill buy score mutation ──
  const backfillBuyScoreMut = trpc.portfolio.backfillBuyScore.useMutation({
    onSuccess: (data) => {
      if (data.updated > 0) {
        toast.success(`\u2713 \u05e6\u05d5\u05d9\u05e0\u05d9 \u05e7\u05e0\u05d9\u05d4 \u05d0\u05d5\u05db\u05dc\u05e1\u05d5 \u05e2\u05d1\u05d5\u05e8 ${data.updated} \u05de\u05e0\u05d9\u05d5\u05ea: ${data.tickers.join(", ")}`, { duration: 5000 });
        utils.portfolio.getState.invalidate();
      }
    },
    onError: (e) => toast.error(`Backfill failed: ${e.message}`),
  });

  // ── Cancel order mutation ──
  const cancelOrderMut = trpc.ibkr.cancelOrder.useMutation({
    onSuccess: (_data, vars) => {
      toast.success(`${vars.field.toUpperCase()} order cancelled`);
      utils.portfolio.getState.invalidate();
      refetchState();
    },
    onError: (e) => toast.error(`Failed to cancel order: ${e.message}`),
  });

  // holdingScoreMap comes from AnalysisSection via callback
  const holdingScoreMap = externalHoldingScoreMap;

  const holdingsWithLiveBase: Holding[] = useMemo(() => {
    // When IBKR is connected, build the display list from IBKR positions (real source of truth)
    // Merge DB data (SL/TP, diary, scores) by ticker
    if (ibkrStatus === "connected" && ibkrPositionsData?.positions && ibkrPositionsData.positions.length > 0) {
      const dbByTicker: Record<string, Holding> = {};
      holdings.forEach(h => { dbByTicker[h.ticker.toUpperCase()] = h; });

      return ibkrPositionsData.positions.map((p, idx) => {
        const db = dbByTicker[p.ticker] ?? null;
        // avgCost from IBKR is per-share cost basis
        const avgCost = p.avgCost ?? 0;
        const mktPrice = p.mktPrice ?? 0;
        return {
          id: db?.id ?? -(idx + 1),          // negative id = IBKR-only (not in DB)
          ticker: p.ticker,
          company: db?.company ?? null,
          buyPrice: avgCost,                  // IBKR avg cost as buy price
          units: p.position,                  // IBKR quantity
          currentPrice: mktPrice || holdingLivePriceMap[p.ticker]?.price || 0,  // SSOT: mktPrice from /positions is real-time (sub-second), snapshot is fallback
          // Daily % = today's change vs yesterday's close (from IBKR snapshot or Yahoo)
          // This matches IBKR App's "CHG %" column (NOT the total return since buy)
          dailyChangePercent: holdingLivePriceMap[p.ticker]?.changePercent ?? db?.dailyChangePercent ?? null,
          zivScore: db?.zivScore ?? null,
          buyScore: db?.buyScore ?? null,
          entryTier: (db as any)?.entryTier ?? null,
          stopLoss: db?.stopLoss ?? null,     // SL from DB
          takeProfit: db?.takeProfit ?? null, // TP from DB
          notes: db?.notes ?? null,
          priceUpdatedAt: new Date().toISOString(),
          createdAt: db?.createdAt ?? new Date(),
          recPositionSizePct: holdingScoreMap[db?.id ?? -1]?.positionSizePct ?? null,
          recSuggestedUnits: holdingScoreMap[db?.id ?? -1]?.suggestedUnits ?? null,
          conid: p.conid ?? null,             // IBKR contract ID for order placement
          ibkrSlOrderId: db?.ibkrSlOrderId ?? null,  // SL order ID from DB
          ibkrTpOrderId: db?.ibkrTpOrderId ?? null,  // TP order ID from DB
          // Store IBKR unrealized P&L for display override
          _ibkrUnrealizedPnl: p.unrealizedPnl,
          _ibkrMktValue: p.mktValue,
        } as Holding & { _ibkrUnrealizedPnl?: number; _ibkrMktValue?: number };
      });
    }

    // Default: use DB holdings with Yahoo Finance live prices
    const todayStr = new Date().toISOString().slice(0, 10);
    return holdings.map(h => {
      const livePrice = holdingLivePriceMap[h.ticker]?.price ?? h.currentPrice;
      const currentPrice = livePrice ?? h.buyPrice;
      // If bought today, daily % = (currentPrice - buyPrice) / buyPrice
      // Yahoo's changePercent uses yesterday's close, which is misleading for same-day buys
      const boughtToday = h.transactionDate
        ? String(h.transactionDate).slice(0, 10) === todayStr
        : h.createdAt
          ? new Date(h.createdAt).toISOString().slice(0, 10) === todayStr
          : false;
      const dailyChangePercent = boughtToday && currentPrice && h.buyPrice
        ? (currentPrice - h.buyPrice) / h.buyPrice * 100
        : (holdingLivePriceMap[h.ticker]?.changePercent ?? h.dailyChangePercent);
      return {
        ...h,
        currentPrice: livePrice,
        dailyChangePercent,
        recPositionSizePct: holdingScoreMap[h.id]?.positionSizePct ?? null,
        recSuggestedUnits: holdingScoreMap[h.id]?.suggestedUnits ?? null,
      };
    });
  }, [holdings, ibkrStatus, ibkrPositionsData, holdingLivePriceMap, holdingScoreMap]);

  // Apply sort to holdings
  const holdingsWithLive: Holding[] = useMemo(() => {
    if (!holdingsSortCol || !holdingsSortDir) return holdingsWithLiveBase;
    return [...holdingsWithLiveBase].sort((a: any, b: any) => {
      // Derived columns
      const getVal = (h: any) => {
        if (holdingsSortCol === 'value') return (h.currentPrice ?? h.buyPrice) * h.units;
        if (holdingsSortCol === 'pnlPct') { const cost = h.buyPrice * h.units; const val = (h.currentPrice ?? h.buyPrice) * h.units; return cost > 0 ? (val - cost) / cost * 100 : 0; }
        // ZIV H score lives in zivHMap, not in the holding object itself
        if (holdingsSortCol === 'zivHScore') return (zivHMap[h.id] ?? zivHByTicker[h.ticker?.toUpperCase()])?.score ?? null;
        if (holdingsSortCol === 'todayPnl') {
          return computeTodayPnl(
            h.units,
            h.buyPrice,
            h.currentPrice ?? null,
            holdingLivePriceMap[h.ticker],
            h.dailyChangePercent,
            h.priceUpdatedAt,
            (h as { dailyBasePrice?: number | null }).dailyBasePrice ?? null,
            (h as { dailyBaseTs?: number | null }).dailyBaseTs ?? null,
            (h as { ibkrUnrealizedPnl?: number | null }).ibkrUnrealizedPnl ?? null,
            h.transactionDate ?? null,
            h.createdAt,
          );
        }
        return h[holdingsSortCol];
      };
      const av = getVal(a), bv = getVal(b);
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return holdingsSortDir === 'asc' ? cmp : -cmp;
    });
  }, [holdingsWithLiveBase, holdingsSortCol, holdingsSortDir, zivHMap, zivHByTicker, holdingLivePriceMap]);

  // ── H2 sorted rows — uses h2LivePriceMap as SSOT (same as displayed values) ──
  const h2SortedData = useMemo(() => {
    const rows = (h2Data ?? []).filter(r => r.units !== 0);
    if (!h2SortCol || !h2SortDir) return rows;
    return [...rows].sort((a: any, b: any) => {
      const getVal = (r: any) => {
        // Always use the live price (same value shown in the table cell)
        const liveData = h2LivePriceMap[r.ticker];
        const cp = liveData?.price ?? r.currentPrice ?? r.buyPrice;
        if (h2SortCol === 'currentPrice') return cp;
        if (h2SortCol === 'pnlTotal') return (cp - r.buyPrice) * r.units;
        if (h2SortCol === 'pnlPct') return r.buyPrice > 0 ? (cp - r.buyPrice) / r.buyPrice * 100 : 0;
        if (h2SortCol === 'holdingValue') return cp * r.units;
        if (h2SortCol === 'dailyChangePercent') return liveData?.changePercent ?? r.dailyChangePercent ?? null;
        if (h2SortCol === 'todayPnl') {
          return computeTodayPnl(
            r.units,
            r.buyPrice,
            r.currentPrice ?? null,
            liveData,
            r.dailyChangePercent,
            (r as { priceUpdatedAt?: string | Date | null }).priceUpdatedAt ?? null,
            (r as { dailyBasePrice?: number | null }).dailyBasePrice ?? null,
            (r as { dailyBaseTs?: number | null }).dailyBaseTs ?? null,
            undefined,
            (r as { transactionDate?: string | Date | null }).transactionDate ?? null,
            (r as { createdAt?: string | Date | null }).createdAt ?? null,
          );
        }
        if (h2SortCol === 'zivScore') return r.zivScore ?? null;
        if (h2SortCol === 'zivHScore') return zivHMapH2[r.id]?.score ?? null;
        return r[h2SortCol];
      };
      const av = getVal(a), bv = getVal(b);
      // Nulls always go to bottom regardless of sort direction
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      // Stable tiebreaker: when values are equal (e.g. same ticker with same live price), sort by id
      // This prevents React from seeing key-order changes on equal rows (visual duplication bug)
      if (cmp === 0) return a.id - b.id;
      return h2SortDir === 'asc' ? cmp : -cmp;
    });
  }, [h2Data, h2SortCol, h2SortDir, h2LivePriceMap, zivHMapH2]);

  // ── Unified Deep Analysis navigation list (H1 + H2) ──
  const deepNavList = useMemo(() => {
    const h1Tickers = holdingsWithLive.map(h => h.ticker);
    const h2Tickers = (h2Data ?? []).filter(r => r.units !== 0).map(r => r.ticker);
    // Deduplicate: H1 first, then H2 tickers not already in H1
    const seen = new Set<string>(h1Tickers);
    const h2Only = h2Tickers.filter(t => !seen.has(t));
    return [...h1Tickers, ...h2Only];
  }, [holdingsWithLive, h2Data]);

  // Helper: get holdingContext for any ticker from H1 or H2
  const getDeepNavContext = (t: string) => {
    const h1 = holdingsWithLive.find(h => h.ticker === t);
    if (h1) {
      const stopLossPrice = h1.stopLoss != null ? parseFloat(String(h1.stopLoss)) : undefined;
      const pnlDollar = h1.currentPrice ? (h1.currentPrice - h1.buyPrice) * h1.units : 0;
      const pnlPct = h1.buyPrice > 0 ? ((h1.currentPrice ?? h1.buyPrice) - h1.buyPrice) / h1.buyPrice * 100 : 0;
      return { source: 'h1' as const, conid: (h1 as any).conid ?? undefined, ctx: { id: h1.id > 0 ? h1.id : undefined, buyPrice: h1.buyPrice, units: h1.units, currentPrice: h1.currentPrice ?? h1.buyPrice, pnlUsd: pnlDollar, pnlPct, stopLoss: stopLossPrice, takeProfit: h1.takeProfit != null ? parseFloat(String(h1.takeProfit)) : undefined } };
    }
    const h2 = (h2Data ?? []).find(r => r.ticker === t && r.units !== 0);
    if (h2) {
      // FIX: prefer live SSE price from h2LivePriceMap over stale DB currentPrice
      const cp = h2LivePriceMap[h2.ticker]?.price ?? h2.currentPrice ?? h2.buyPrice;
      const pnlUsd = (cp - h2.buyPrice) * h2.units;
      const pnlPct = h2.buyPrice > 0 ? (cp - h2.buyPrice) / h2.buyPrice * 100 : 0;
      return { source: 'h2' as const, conid: undefined, ctx: { id: h2.id, buyPrice: h2.buyPrice, units: h2.units, currentPrice: cp, pnlUsd, pnlPct, stopLoss: undefined, takeProfit: undefined } };
    }
    return null;
  };

  // ── Live prices for catalogue ──
  const catalogueTickers = useMemo(() => (catalogueData ?? []).map(a => a.ticker), [(catalogueData ?? []).map(a => a.ticker).join(',')]);
  // Catalogue price map: comes from the unified IBKR hook (ibkrCatMap)
  // The hook is called above with catalogueTickers:[] because catalogueTickers is defined here.
  // We use a separate getIbkrQuotes query for catalogue to include it in the 60s pulse.
  const { data: ibkrCatalogueQuotes } = trpc.ibkr.getIbkrQuotes.useQuery(
    { symbols: catalogueTickers },
    { enabled: ibkrConnected && catalogueTickers.length > 0, staleTime: 0, refetchOnMount: 'always', refetchInterval: ibkrConnected ? 60_000 : false }
  );
  const catalogueLivePriceMap = useMemo(() => {
    const map: Record<string, number | null> = {};
    if (ibkrConnected && ibkrCatalogueQuotes?.quotes) {
      ibkrCatalogueQuotes.quotes.forEach(q => { if (q.symbol && !q.error) map[q.symbol] = q.changePercent; });
    }
    return map;
  }, [ibkrConnected, ibkrCatalogueQuotes]);

  // Portfolio totals (use live prices)
  // SHORT positions: costBasis = buyPrice × |units|, currentValue = price × |units|
  // P&L for SHORT = costBasis - currentValue (profit when price drops)
  const totalCost = holdingsWithLive.reduce((s, h) => s + h.buyPrice * Math.abs(h.units), 0);
  // SHORT: value is negative (liability); LONG: value is positive
  const totalValue = holdingsWithLive.reduce((s, h) => s + (h.currentPrice ?? h.buyPrice) * h.units, 0);
  const totalPnl = holdingsWithLive.reduce((s, h) => {
    const absUnits = Math.abs(h.units);
    const cost = h.buyPrice * absUnits;
    const val = (h.currentPrice ?? h.buyPrice) * absUnits;
    return s + (h.units < 0 ? cost - val : val - cost);
  }, 0);
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
  // Determine data source: live IBKR, or DB cache (returned by getAccountSummary when offline)
  const summarySource = ibkrSummaryData?.source; // "ibeam" | "ibind" | "db_cache" | "none" | undefined
  const summaryIsLive = summarySource === "ibeam" || summarySource === "ibind";
  const summaryIsCached = summarySource === "db_cache";

  // Portfolio Value = grossPositionValue (שווי תיק in IBKR = gross value of all positions)
  // Uses ibkrSummaryData for both live and cached cases (getAccountSummary now always returns data)
  const displayPortfolioValue = ibkrSummaryData?.summary?.grossPositionValue ?? (account?.lastKnownNLV ?? null);

  // NLV (Real Balance): netLiquidation = portfolio value minus margin/loans
  const displayNLV = ibkrSummaryData?.summary?.netLiquidation ?? (account?.lastKnownNetLiquidation ?? null);

  // Today P&L: primary source is the dedicated /pnl endpoint (ibkrPnlData.dailyPnl).
  // Fallback chain: /pnl → /account/summary dailyPnl → DB cache (same-day only) → null.
  // The /pnl endpoint is polled every 30s when IBKR is connected.
  const cachedPnlDate = account?.lastKnownNLVAt ? new Date(account.lastKnownNLVAt) : null;
  const cachedPnlIsToday = cachedPnlDate ? cachedPnlDate.toDateString() === new Date().toDateString() : false;
  const ibkrTodayPnl =
    ibkrPnlData?.dailyPnl ??                                                    // /pnl endpoint (primary)
    ibkrSummaryData?.summary?.dailyPnl ??                                       // /account/summary fallback
    (cachedPnlIsToday ? (account?.lastKnownTodayPnl ?? null) : null);           // DB cache (same-day only)

  // Cash Balance: from ibkrSummaryData (live or cached), fallback to account DB
  const cashBalance = ibkrSummaryData?.summary?.totalCash ?? (account?.lastKnownCash ?? account?.cashBalance ?? 0);

  // grandTotal = Portfolio Value (שווי תיק): grossPositionValue when available, else holdings sum
  const grandTotal = displayPortfolioValue != null ? displayPortfolioValue : (totalValue + cashBalance);

  // ── SSOT: centralized portfolio metrics ──────────────────────────────────────
  // All cards, tables, and dashboards must read from this single hook.
  const portfolioMetrics = usePortfolioMetrics({
    h1Holdings: holdingsWithLive.map(h => ({
      ticker: h.ticker,
      units: h.units,
      buyPrice: h.buyPrice,
      currentPrice: h.currentPrice ?? null,
      dailyChangePercent: h.dailyChangePercent ?? null,
      priceUpdatedAt: (h as any).priceUpdatedAt ?? null,
      // Pass through so computeTodayPnl can use the 23:30 baseline (Priority 4) + intraday-entry override:
      dailyBasePrice: (h as any).dailyBasePrice ?? null,
      dailyBaseTs: (h as any).dailyBaseTs ?? null,
      transactionDate: (h as any).transactionDate ?? null,
      createdAt: (h as any).createdAt ?? null,
      ibkrUnrealizedPnl: (h as any).ibkrUnrealizedPnl ?? null,
    })),
    h2Holdings: (h2Data ?? []).filter(r => r.units !== 0).map(r => ({
      ticker: r.ticker,
      units: r.units,
      buyPrice: r.buyPrice,
      currentPrice: r.currentPrice ?? null,
      prevClose: (r as any).prevClose ?? null,
      dailyChangePercent: r.dailyChangePercent ?? null,
      priceUpdatedAt: (r as any).priceUpdatedAt ?? null,
      dailyBasePrice: (r as any).dailyBasePrice ?? null,
      dailyBaseTs: (r as any).dailyBaseTs ?? null,
      transactionDate: (r as any).transactionDate ?? null,
      createdAt: (r as any).createdAt ?? null,
    })),
    h1LivePriceMap: holdingLivePriceMap,
    h2LivePriceMap,
    ibkr: {
      grossPositionValue: displayPortfolioValue,
      netLiquidation: displayNLV,
      dailyPnl: ibkrTodayPnl,
      totalCash: cashBalance,
      isLive: summaryIsLive,
    },
    cashBalance,
  });

  // Timestamp for last known IBKR data
  const lastIbkrSyncAt = (ibkrSummaryData as any)?.cachedAt
    ? new Date((ibkrSummaryData as any).cachedAt)
    : (account?.lastKnownNLVAt ? new Date(account.lastKnownNLVAt) : null);

  const refresh = () => utils.portfolio.getState.invalidate();

  // ── H2-aware daily snapshot: update today's snapshot when both NLV and H2 value are ready ──
  // This runs once per day (idempotent) and ensures H2 is included in the equity chart.
  const h2SnapshotMut = trpc.portfolio.recordDailySnapshot.useMutation();
  const h2SnapshotFiredRef = useRef(false);
  useEffect(() => {
    if (h2SnapshotFiredRef.current) return;
    const nlv = displayNLV;
    if (!nlv || nlv <= 0) return;
    if (h2TotalValue <= 0 && (h2Data ?? []).filter(r => r.units !== 0).length > 0) return; // wait for h2 prices
    h2SnapshotFiredRef.current = true;
    h2SnapshotMut.mutate({
      totalEquity: nlv,
      cashBalance: cashBalance ?? undefined,
      unrealizedPnL: ibkrSummaryData?.summary?.unrealizedPnl ?? undefined,
      h2Value: h2TotalValue > 0 ? h2TotalValue : undefined,
    });
  }, [displayNLV, h2TotalValue]);

  // ── Auto-refresh H2 prices on page load ──
  // If any H2 holding has priceUpdatedAt null or older than 1 hour, trigger refreshPrices silently.
  // This ensures crypto tickers (ETH/BTC/XRP) always have prevClose populated for שינוי מאתמול.
  const h2AutoRefreshedRef = useRef(false);
  useEffect(() => {
    if (h2AutoRefreshedRef.current) return;
    if (!h2Data || h2Data.length === 0) return;
    if (h2RefreshMut.isPending) return;
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const now = Date.now();
    const needsRefresh = h2Data.some(r => {
      if (r.units <= 0) return false;
      if (!r.priceUpdatedAt) return true;
      const updatedAt = new Date(r.priceUpdatedAt).getTime();
      return now - updatedAt > ONE_HOUR_MS;
    });
    if (needsRefresh) {
      h2AutoRefreshedRef.current = true;
      h2RefreshMut.mutate();
    }
  }, [h2Data]);

  // ── IBIND Session Gate ──
  // Show loading spinner while checking session, then connect screen if inactive
  if (!ibindSessionChecked) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" />
          <span className="text-sm">בודק חיבור ל-IBKR...</span>
        </div>
      </div>
    );
  }

  if (!ibindSessionActive && isAdmin) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-7xl mx-auto px-4 py-8">
          <div className="flex items-center gap-2 mb-6">
            <div className="flex flex-col leading-none">
              <span className="text-[10px] font-semibold text-[#2563EB] tracking-widest uppercase">TradeSnow</span>
              <h1 className="text-2xl font-bold tracking-tight">Trade Manager</h1>
            </div>
          </div>
          <Suspense fallback={<div className="flex items-center justify-center py-20"><div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>}>
            <IBINDConnectScreen
              closedReason={ibindClosedReason}
              closedAt={ibindClosedAt}
              onConnected={(accountId) => {
                if (accountId) setIbkrAccountId(accountId);
                setIbkrStatus("connected");
                setIbindSessionActive(true);
              }}
            />
          </Suspense>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F4F6F8] overflow-x-hidden">
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-5 overflow-x-hidden">

        {/* ── Header ── */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <div className="flex flex-col leading-none">
              <span className="text-[10px] font-semibold text-[#2563EB] tracking-widest uppercase">TradeSnow</span>
              <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight bg-gradient-to-r from-blue-700 via-indigo-600 to-violet-600 bg-clip-text text-transparent">Trade Manager</h1>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">Real portfolio · live prices · AI-powered analysis</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Broker Connect/Disconnect Button — IBIND — admin only */}
            {isAdmin && <button
              onClick={() => {
                if (ibkrStatus !== "connected") {
                  window.location.href = "/settings#ibkr";
                }
                // When connected, clicking does nothing (use Settings to disconnect)
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors cursor-pointer ${
                ibkrStatus === "connected"
                  ? "bg-emerald-500 text-white border-emerald-600 cursor-default"
                  : ibkrStatus === "connecting"
                  ? "bg-yellow-100 text-yellow-700 border-yellow-300 cursor-not-allowed"
                  : "bg-red-50 hover:bg-red-200 text-red-700 border-red-300"
              }`}
              disabled={ibkrStatus === "connecting"}
              title={ibkrStatus === "connected" ? `Broker connected${ibkrAccountId ? ` (${ibkrAccountId})` : ""}` : "Connect to IBKR or IBIND in Settings"}
            >
              {ibkrStatus === "connected" ? (
                <><Wifi className="h-3 w-3" /> {ibkrAccountId ? `IBKR ${ibkrAccountId}` : "Broker Connected"}</>
              ) : ibkrStatus === "connecting" ? (
                <><Loader2 className="h-3 w-3 animate-spin" /> Connecting...</>
              ) : (
                <><WifiOff className="h-3 w-3" /> Connect Broker</>
              )}
            </button>}
            {/* IBKR Live overlay badge — admin only */}
            {isAdmin && ibkrStatus === "connected" && ibkrPositionsData?.positions && ibkrPositionsData.positions.length > 0 && (
              <div className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-300">
                <span className="w-1.5 h-1.5 rounded-full bg-[#2563EB] animate-pulse" />
                IBKR Live · {ibkrPositionsData.positions.length} positions
              </div>
            )}
            {/* Live badge */}
            {lastRefreshedAt && (
              <div className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-300">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Live · {lastRefreshedAt.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </div>
            )}

            {/* Unified IBKR Refresh Control — shows button + last updated timestamp */}
            <RefreshControl ibkrConnected={ibkrConnected} />

            {/* SYNC NOW FROM IBKR + Disconnect — admin only */}
            {isAdmin && ibkrStatus === "connected" && (
              <>
                <Button
                  size="sm"
                  className="bg-[#65A30D] hover:bg-[#17a87e] text-white font-semibold shadow-sm"
                  onClick={handleSyncFromIbkr}
                  disabled={syncFromIbkrMut.isPending}
                  title="סנכרן את כל ה-Holdings והיתרות מ-IBKR"
                >
                  {syncFromIbkrMut.isPending
                    ? <><Loader2 className="h-4 w-4 animate-spin mr-1" /> מסנכרן...</>
                    : <><RefreshCw className="h-4 w-4 mr-1" /><span className="hidden sm:inline">SYNC NOW FROM IBKR</span><span className="sm:hidden">SYNC</span></>}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-[#FF6B6B] border-red-300 hover:bg-red-50 dark:hover:bg-red-950/20"
                  onClick={async () => {
                    if (!confirm("האם לנתק את ה-IBKR session?")) return;
                    await stopSessionMutation.mutateAsync();
                    setIbkrStatus("disconnected");
                    toast.success("נותק מ-IBKR");
                  }}
                  disabled={stopSessionMutation.isPending}
                  title="נתק את ה-IBKR session ידנית"
                >
                  <WifiOff className="h-4 w-4 mr-1.5" /> נתק
                </Button>
              </>
            )}
            {/* Force SL/TP Resync — admin only */}
            {isAdmin && (
              <Button
                size="sm"
                variant="outline"
                className="text-amber-400 border-amber-600/40 hover:bg-amber-50"
                onClick={() => forceSlResyncMut.mutate()}
                disabled={forceSlResyncMut.isPending}
                title="עדכן SL/TP לכל ה-Holdings לפי Ziv Engine"
              >
                {forceSlResyncMut.isPending
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> מעדכן SL/TP...</>
                  : <><ShieldCheck className="h-3.5 w-3.5 mr-1" /> Resync SL/TP</>}
              </Button>
            )}

          </div>
        </div>

        {/* ── Capital Summary Cards ── */}
        <CapitalSummaryCards
          holdingsWithLive={holdingsWithLive}
          holdingLivePriceMap={holdingLivePriceMap}
          totalValue={totalValue}
          totalCost={totalCost}
          totalPnl={totalPnl}
          totalPnlPct={totalPnlPct}
          cashBalance={cashBalance}
          grandTotal={grandTotal}
          displayNLV={displayNLV}
          ibkrTodayPnl={ibkrTodayPnl}
          summarySource={summarySource}
          summaryIsLive={summaryIsLive}
          summaryIsCached={summaryIsCached}
          lastIbkrSyncAt={lastIbkrSyncAt}
          isAdmin={isAdmin}
          h2Data={h2Data}
          h2LivePriceMap={h2LivePriceMap}
          portfolioMetrics={portfolioMetrics}
        />

        {/* Portfolio Equity Curve — H1 only. Combined H1+H2 chart lives in H1H2Dashboard. */}
        <Suspense fallback={<div className="h-32 flex items-center justify-center"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>}>
          <PortfolioPerformanceChart
            currentEquityValue={displayNLV ?? (totalValue > 0 ? totalValue + cashBalance : undefined)}
            cashBalance={cashBalance}
            unrealizedPnL={ibkrSummaryData?.summary?.unrealizedPnl ?? undefined}
          />
        </Suspense>

        {/* ── Holdings Section (table + SL/TP monitor + alert banners) ── */}
        <HoldingsSection
          holdingsWithLive={holdingsWithLive}
          holdings={holdings}
          holdingLivePriceMap={holdingLivePriceMap}
          zivHMap={zivHMap}
          zivHByTicker={zivHByTicker}
          ibkrStatus={ibkrStatus}
          isMarketOpen={(() => { const now = new Date(); const d = now.getUTCDay(); if (d === 0 || d === 6) return false; const m = now.getUTCMonth(); const etOff = m >= 2 && m <= 10 ? 4 : 5; const etMin = (now.getUTCHours() - etOff) * 60 + now.getUTCMinutes(); return etMin >= 570 && etMin < 960; })()}
          holdingsLastScanned={holdingsLastScanned}
          lastRefreshedAt={lastRefreshedAt}
          isLoading={isLoading}
          cashBalance={cashBalance}
          totalValue={totalValue}
          totalCost={totalCost}
          totalPnl={totalPnl}
          totalPnlPct={totalPnlPct}
          deepNavList={deepNavList}
          ibkrPositionMap={ibkrPositionMap}
          ibkrPositionsData={ibkrPositionsData}
          syncFromIbkrMut={syncFromIbkrMut}
          refreshMut={refreshMut}
          backfillBuyScoreMut={backfillBuyScoreMut}
          cancelOrderMut={cancelOrderMut}
          syncSlTpMut={syncSlTpMut}
          onRefresh={refresh}
          onSyncFromIbkr={handleSyncFromIbkr}
          onSetSellMarketTarget={setSellMarketTarget}
          onSetSellMarketSlippage={setSellMarketSlippage}
          onSetSellMarketQty={setSellMarketQty}
          onSetShowAdd={setShowAdd}
          onSetSltpDeepTicker={setSltpDeepTicker}
          onSetH2DeepTicker={setH2DeepTicker}
          onSetH2DeepHoldingCtx={setH2DeepHoldingCtx}
          getDeepNavContext={getDeepNavContext}
          holdingsSortCol={holdingsSortCol}
          holdingsSortDir={holdingsSortDir}
          onHoldingsSort={handleHoldingsSort}
          sltpDeepTicker={sltpDeepTicker}
          refetchState={refetchState}
          refetchIbkrPositions={refetchIbkrPositions}
          utils={utils}
          onRefreshZivH={refreshZivH}
          isRefreshingZivH={isRefreshingZivH}
          todayPnlIbkr={ibkrTodayPnl}
          portfolioMetrics={portfolioMetrics}
        />

        

        {/* ── Performance Chart removed — P&L per position chart moved to H1H2Dashboard ── */}

        {/* ── Trading Diary ── */}
        <Card className="border border-amber-200 shadow-md bg-white">
          <CardHeader
            className="pb-3 pt-4 px-5 cursor-pointer select-none"
            onClick={() => setDiaryExpanded(v => !v)}
          >
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <BookMarked className="h-4 w-4 text-amber-600" />
                <span>יומן מסחר — Trading Diary</span>
                {diaryEntries && diaryEntries.length > 0 && (
                  <span className="text-xs font-normal text-muted-foreground">({diaryEntries.length} רשומות)</span>
                )}
                {!diaryExpanded && (
                  <span className="text-xs font-normal text-muted-foreground ml-1 hidden md:inline">לחץ להרחבה</span>
                )}
              </CardTitle>
              <div className="flex items-center gap-2">
                {diaryAddingLoading && (
                  <div className="flex items-center gap-1.5 text-xs text-amber-600" onClick={e => e.stopPropagation()}>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>מייצר רשומת יומן עם נתוני AI...</span>
                  </div>
                )}
                {diaryExpanded
                  ? <ChevronUp className="h-4 w-4 text-amber-500" />
                  : <ChevronDown className="h-4 w-4 text-amber-500" />
                }
              </div>
            </div>
          </CardHeader>
          {diaryExpanded && (
          <CardContent className="px-0 pb-0">
            {/* Filter controls */}
            {diaryEntries && diaryEntries.length > 0 && (
              <div className="px-5 pb-2 flex items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setShowClosedDiary(v => !v)}
                >
                  {showClosedDiary ? 'הסתר סגורות' : `הצג סגורות (${(diaryEntries as any[]).filter(e => e.diaryStatus === 'closed').length})`}
                </Button>
              </div>
            )}
            {(!diaryEntries || diaryEntries.length === 0) ? (
              <div className="text-center py-10 text-muted-foreground">
                <BookOpen className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">יומן המסחר ריק — הוסף מנייה להחזקות כדי לייצר רשומה אוטומטית</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
              <Table className="min-w-[1100px]">
                  <TableHeader>
                    <TableRow className="bg-muted/30">
                      <TableHead className="font-semibold text-xs uppercase tracking-wide w-8">#</TableHead>
                      <TableHead className="font-semibold text-xs uppercase tracking-wide w-24">תאריך / עדכון</TableHead>
                      <TableHead className="font-semibold text-xs uppercase tracking-wide w-28">טיקר / חברה</TableHead>
                      <TableHead className="font-semibold text-xs uppercase tracking-wide text-right w-16">כמות</TableHead>
                      <TableHead className="font-semibold text-xs uppercase tracking-wide text-right w-24">מחיר קנייה</TableHead>
                      <TableHead className="font-semibold text-xs uppercase tracking-wide text-right w-28 text-[#FF6B6B]">סטופ לוס מומלץ</TableHead>
                      <TableHead className="font-semibold text-xs uppercase tracking-wide text-right w-28 text-[#65A30D]">יעד רווח מומלץ</TableHead>
                      <TableHead className="font-semibold text-xs uppercase tracking-wide">למה קנינו</TableHead>
                      <TableHead className="font-semibold text-xs uppercase tracking-wide">ציפייה</TableHead>
                      <TableHead className="font-semibold text-xs uppercase tracking-wide w-40">סיכום</TableHead>
                      <TableHead className="w-20"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(diaryEntries as any[])
                      .filter(e => showClosedDiary || !e.diaryStatus || e.diaryStatus === 'open')
                      .map((entry: any, idx: number) => {
                      const isEditing = editingDiaryId === entry.id;
                      const isClosed = entry.diaryStatus === 'closed';
                      return (
                      <TableRow key={entry.id} className={`hover:bg-muted/20 ${isEditing ? 'bg-amber-50' : ''} ${isClosed ? 'opacity-70 bg-white/30' : ''}`}>
                        <TableCell className="text-xs text-muted-foreground">{idx + 1}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          <div>{new Date(entry.addedAt).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' })}</div>
                          {isClosed && entry.closedAt && (
                            <div className="text-gray-400 text-[10px] mt-0.5">סגור: {new Date(entry.closedAt).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' })}</div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className={`font-bold text-sm ${isClosed ? 'text-gray-500' : 'text-amber-400 dark:text-amber-400'}`}>{entry.ticker}</div>

                        </TableCell>
                        <TableCell className="text-right text-sm font-medium">{entry.units.toLocaleString()}</TableCell>
                        <TableCell className="text-right text-sm font-semibold">${entry.buyPrice.toFixed(2)}</TableCell>
                        <TableCell className="text-right text-sm">
                          {isEditing ? (
                            <input type="number" step="0.01" className="w-20 text-xs text-right border border-red-300 rounded px-1 py-0.5" value={editDiarySL} onChange={e => setEditDiarySL(e.target.value)} />
                          ) : entry.stopLoss ? (
                            <span className="text-[#FF6B6B] font-medium">${entry.stopLoss.toFixed(2)}</span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {isEditing ? (
                            <input type="number" step="0.01" className="w-20 text-xs text-right border border-emerald-300 rounded px-1 py-0.5" value={editDiaryTP} onChange={e => setEditDiaryTP(e.target.value)} />
                          ) : entry.takeProfit ? (
                            <span className="text-[#65A30D] font-medium">${entry.takeProfit.toFixed(2)}</span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="max-w-[200px]">
                          {isEditing ? (
                            <Textarea value={editDiaryReason} onChange={e => setEditDiaryReason(e.target.value)} className="text-xs min-h-[60px] resize-none" dir="rtl" placeholder="למה קנינו את הנייר..." />
                          ) : (
                            <p className="text-xs text-muted-foreground break-words whitespace-normal leading-relaxed" dir="rtl">{entry.reason ?? '—'}</p>
                          )}
                        </TableCell>
                        <TableCell className="max-w-[200px]">
                          {isEditing ? (
                            <Textarea value={editDiaryExpectations} onChange={e => setEditDiaryExpectations(e.target.value)} className="text-xs min-h-[60px] resize-none" dir="rtl" placeholder="מה אנחנו מצפים..." />
                          ) : (
                            <p className="text-xs text-muted-foreground break-words whitespace-normal leading-relaxed" dir="rtl">{entry.expectations ?? '—'}</p>
                          )}
                        </TableCell>
                        {/* Summary column */}
                        <TableCell className="max-w-[160px]">
                          {isClosed ? (
                            <div className="flex flex-col gap-0.5">
                              {entry.pnlUsd != null && (
                                <span className={`text-sm font-bold ${entry.pnlUsd >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                                  {entry.pnlUsd >= 0 ? '+' : ''}{entry.pnlUsd.toFixed(0)}$ ({entry.pnlPct >= 0 ? '+' : ''}{entry.pnlPct?.toFixed(1) ?? '0'}%)
                                </span>
                              )}
                              {entry.closePrice && (
                                <span className="text-[10px] text-gray-400">יציאה: ${entry.closePrice.toFixed(2)}</span>
                              )}
                              {entry.postMortem && (
                                <p className="text-[10px] text-gray-500 leading-relaxed line-clamp-3" dir="rtl">{entry.postMortem}</p>
                              )}
                            </div>
                          ) : (
                            <span className="text-[10px] text-amber-500">פתוח</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            {isEditing ? (
                              <>
                                <Button size="icon" variant="ghost" className="h-7 w-7 text-[#65A30D] hover:text-[#65A30D]" disabled={updateDiaryMut.isPending}
                                  onClick={() => updateDiaryMut.mutate({ id: entry.id, reason: editDiaryReason, expectations: editDiaryExpectations, stopLoss: editDiarySL ? parseFloat(editDiarySL) : undefined, takeProfit: editDiaryTP ? parseFloat(editDiaryTP) : undefined })}>
                                  {updateDiaryMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                </Button>
                                <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={() => setEditingDiaryId(null)}>
                                  <X className="h-3.5 w-3.5" />
                                </Button>
                              </>
                            ) : (
                              <Button size="icon" variant="ghost" className="h-7 w-7 text-amber-500 hover:text-amber-400"
                                onClick={() => { setEditingDiaryId(entry.id); setEditDiaryReason(entry.reason ?? ''); setEditDiaryExpectations(entry.expectations ?? ''); setEditDiarySL(entry.stopLoss?.toFixed(2) ?? ''); setEditDiaryTP(entry.takeProfit?.toFixed(2) ?? ''); }}>
                                <Edit2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-[#FF6B6B] hover:text-[#FF6B6B]" onClick={() => deleteDiaryMut.mutate({ id: entry.id })}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
          )}
        </Card>

        {/* ── Holding 2 — Second Manual Portfolio ── */}
        <Card className="border border-sky-200 shadow-md bg-white">
          <CardHeader
            className="pb-3 pt-4 px-5 cursor-pointer select-none"
            onClick={() => setH2Expanded(v => !v)}
          >
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <span className="text-sky-400">📂</span>
                <span className="text-sky-300">Holding 2 — תיק שני</span>
                {h2Data && h2Data.length > 0 && (
                  <span className="text-xs font-normal text-muted-foreground">({h2Data.filter(r => r.units !== 0).length} מניות)</span>
                )}
              </CardTitle>
              <div className="flex flex-wrap items-center gap-2" onClick={e => e.stopPropagation()}>
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => h2RefreshMut.mutate()} disabled={h2RefreshMut.isPending}>
                  {h2RefreshMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  עדכן מחירים
                </Button>
                {h2Data && h2Data.some(r => r.ticker.endsWith(".TA")) && (
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1 border-amber-400 text-amber-400 hover:bg-amber-100" onClick={() => h2FixIsraeliMut.mutate()} disabled={h2FixIsraeliMut.isPending} title="תיקון מחירי .TA מאגורות לדולר">
                    {h2FixIsraeliMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <span>₪</span>}
                    תקן .TA
                  </Button>
                )}
                <Button size="sm" variant="outline" className={`h-7 text-xs gap-1 ${h2Analyzing ? 'border-emerald-400 bg-emerald-950/40 text-[#65A30D]' : 'border-[#17a87e] text-[#65A30D] hover:bg-emerald-950/40'}`} onClick={() => { setH2Analyzing(true); setH2AnalyzeResults([]); h2AnalyzeMut.mutate(); }} disabled={h2Analyzing || h2AnalyzeMut.isPending}>
                  {h2Analyzing ? <Loader2 className="h-3 w-3 animate-spin" /> : <BarChart2 className="h-3 w-3" />}
                  Analyze H2
                </Button>
                <Button size="sm" className="h-7 text-xs gap-1 bg-sky-700 hover:bg-sky-600 text-white" onClick={() => setH2ShowAdd(v => !v)}>
                  <Plus className="h-3 w-3" /> הוסף מנייה
                </Button>
                {h2Expanded ? <ChevronUp className="h-4 w-4 text-sky-500" /> : <ChevronDown className="h-4 w-4 text-sky-500" />}
              </div>
            </div>
            {/* ── H2 inline summary bar — identical to H1 ── */}
            {h2Data && h2Data.filter(r => r.units !== 0).length > 0 && h2SummaryStats && (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mt-2 pt-2 border-t border-border/30 text-sm" onClick={e => e.stopPropagation()}>
                <span className="font-semibold text-foreground">{h2Data.filter(r => r.units !== 0).length} פוזיציות</span>
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground text-xs">שווי תיק</span>
                  <span className="font-mono font-bold text-foreground">${h2TotalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                </div>
                {(portfolioMetrics?.h2TodayPnl ?? h2SummaryStats.todayPnl) != null && (() => {
                  const _h2TodayPnlVal = portfolioMetrics?.h2TodayPnl ?? h2SummaryStats.todayPnl!;
                  const _h2PrevClose = h2TotalValue - _h2TodayPnlVal;
                  const todayPct = _h2PrevClose > 0 ? (_h2TodayPnlVal / _h2PrevClose) * 100 : 0;
                  return (
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground text-xs">שינוי יומי</span>
                      <span className={`font-mono font-bold ${_h2TodayPnlVal > 0 ? 'text-[#65A30D]' : _h2TodayPnlVal < 0 ? 'text-[#FF6B6B]' : 'text-muted-foreground'}`}>
                        {_h2TodayPnlVal >= 0 ? '+' : ''}{todayPct.toFixed(2)}%
                      </span>
                      <span className={`text-xs font-mono ${_h2TodayPnlVal > 0 ? 'text-[#65A30D]' : _h2TodayPnlVal < 0 ? 'text-[#FF6B6B]' : 'text-muted-foreground'}`}>
                        ({_h2TodayPnlVal >= 0 ? '+' : ''}${Math.abs(_h2TodayPnlVal).toLocaleString(undefined, { maximumFractionDigits: 0 })})
                      </span>
                    </div>
                  );
                })()}
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground text-xs">P&L כולל</span>
                  <span className={`font-mono font-bold ${h2SummaryStats.totalPnl >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                    {h2SummaryStats.totalPnl >= 0 ? '+' : ''}${h2SummaryStats.totalPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                  <span className={`text-xs font-mono ${h2SummaryStats.pnlPct >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                    ({h2SummaryStats.pnlPct >= 0 ? '+' : ''}{h2SummaryStats.pnlPct.toFixed(2)}%)
                  </span>
                </div>
              </div>
            )}
          </CardHeader>
          {h2Expanded && (
            <CardContent className="px-5 pb-5 space-y-3">
              {/* H2 Summary Cards */}
              {h2SummaryStats && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-2">
                  <div className="bg-card border rounded-xl p-3 shadow-sm">
                    <p className="text-xs text-muted-foreground mb-1">שווי תיק</p>
                    <p className="text-lg font-bold text-sky-400">${h2TotalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}</p>

                  </div>
                  <div className="bg-card border rounded-xl p-3 shadow-sm">
                    <p className="text-xs text-muted-foreground mb-1">P&L כולל</p>
                    <p className={`text-lg font-bold ${h2SummaryStats.totalPnl >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                      {h2SummaryStats.totalPnl >= 0 ? '+' : ''}${h2SummaryStats.totalPnl.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                    </p>
                    <p className={`text-xs font-medium ${h2SummaryStats.pnlPct >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                      {h2SummaryStats.pnlPct >= 0 ? '+' : ''}{h2SummaryStats.pnlPct.toFixed(2)}%
                    </p>
                  </div>
                  <div className="bg-card border rounded-xl p-3 shadow-sm">
                    <p className="text-xs text-muted-foreground mb-1">TODAY P&L</p>
                    {(() => {
                      // SSOT: portfolioMetrics.h2TodayPnl (same formula as h2SummaryStats but guaranteed consistent)
                      const h2TodayDisplay = portfolioMetrics?.h2TodayPnl ?? h2SummaryStats.todayPnl;
                      return h2TodayDisplay != null ? (
                        <>
                          <p className={`text-lg font-bold ${h2TodayDisplay >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                            {h2TodayDisplay >= 0 ? '+' : ''}${Math.abs(h2TodayDisplay).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                          </p>
                          <p className="text-xs text-muted-foreground">Yahoo live</p>
                        </>
                      ) : (
                        <p className="text-lg font-bold text-muted-foreground">—</p>
                      );
                    })()} 
                  </div>
                  <div className="bg-card border rounded-xl p-3 shadow-sm">
                    <p className="text-xs text-muted-foreground mb-1">מניות</p>
                    <p className="text-lg font-bold text-sky-400">{(h2Data ?? []).filter(r => r.units !== 0).length}</p>
                    <p className="text-xs text-muted-foreground">מניות פעילות</p>
                  </div>
                </div>
              )}
              {/* Add form */}
              {h2ShowAdd && (
                <div className="bg-sky-950/20 border border-sky-800/40 rounded-lg p-4 space-y-3">
                  <p className="text-sm font-semibold text-sky-400">הוסף מנייה ל-Holding 2</p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">טיקר *</label>
                      <Input value={h2Ticker} onChange={e => setH2Ticker(e.target.value.toUpperCase())} placeholder="AAPL" className="h-8 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">שם חברה</label>
                      <Input value={h2Company} onChange={e => setH2Company(e.target.value)} placeholder="Apple Inc." className="h-8 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">מחיר קנייה *</label>
                      <Input type="number" value={h2BuyPrice} onChange={e => setH2BuyPrice(e.target.value)} placeholder="150.00" className="h-8 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">כמות *</label>
                      <Input type="number" value={h2Units} onChange={e => setH2Units(e.target.value)} placeholder="10" className="h-8 text-sm" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">הערות</label>
                    <Input value={h2Notes} onChange={e => setH2Notes(e.target.value)} placeholder="הערה אופציונלית..." className="h-8 text-sm" />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" className="bg-sky-600 hover:bg-sky-700 text-white" disabled={h2AddMut.isPending || !h2Ticker || !h2BuyPrice || !h2Units}
                      onClick={() => h2AddMut.mutate({ ticker: h2Ticker, company: h2Company || undefined, buyPrice: parseFloat(h2BuyPrice), units: parseFloat(h2Units), notes: h2Notes || undefined })}>
                      {h2AddMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null} הוסף
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setH2ShowAdd(false)}>ביטול</Button>
                  </div>
                </div>
              )}
              {/* Table — always shown so fast-add row is always accessible */}
              {(!h2Data || h2Data.filter(r => r.units !== 0).length === 0) && (
                <div className="text-center py-4 text-muted-foreground">
                  <p className="text-sm">הוסף מנייה בשורה למטה</p>
                </div>
              )}
              {true && (
                <div className="overflow-x-auto">
                  <Table className="min-w-[900px]">
                    <TableHeader>
                      <TableRow className="bg-muted/30">
                        {([
                          { key: 'ticker', label: 'טיקר', align: 'left', className: 'w-24' },
                          { key: 'units', label: 'כמות', align: 'right' },
                          { key: 'buyPrice', label: 'מחיר קנייה', align: 'right' },
                          { key: 'currentPrice', label: 'מחיר נוכחי', align: 'right' },
                          { key: 'dailyChangePercent', label: 'שינוי יומי', align: 'right' },
                          { key: 'todayPnl', label: 'Today $', align: 'right' },
                          { key: 'pnlTotal', label: 'P&L $', align: 'right' },
                          { key: 'pnlPct', label: 'P&L %', align: 'right' },
                          { key: 'holdingValue', label: 'שווי', align: 'right' },
                          { key: 'zivScore', label: 'SCORE', align: 'center' },
                          { key: 'zivHScore', label: 'H HEALTH', align: 'center' },
                        ] as const).map((col) => {
                          const { key, label, align } = col;
                          const className = 'className' in col ? col.className : undefined;
                          return (
                          <TableHead
                            key={key}
                            className={`font-semibold text-xs uppercase tracking-wide cursor-pointer select-none hover:bg-muted/50 whitespace-nowrap ${align === 'center' ? 'text-center w-16' : align === 'right' ? 'text-right' : ''} ${className ?? ''}`}
                            onClick={() => handleH2Sort(key)}
                          >
                            {label}
                            {h2SortCol === key
                              ? h2SortDir === 'asc'
                                ? <ChevronUp className="h-3 w-3 ml-1 text-sky-500 inline" />
                                : h2SortDir === 'desc'
                                  ? <ChevronDown className="h-3 w-3 ml-1 text-sky-500 inline" />
                                  : <ChevronsUpDown className="h-3 w-3 ml-1 text-muted-foreground opacity-50 inline" />
                              : <ChevronsUpDown className="h-3 w-3 ml-1 text-muted-foreground opacity-50 inline" />
                            }
                          </TableHead>
                          );
                        })}
                        <TableHead className="w-20"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {h2SortedData.map(row => {
                        // Prefer live price from h2LivePriceMap over stale DB value
                        const liveData = h2LivePriceMap[row.ticker];
                        const livePrice = liveData?.price ?? row.currentPrice;
                        const liveDailyChangePct = liveData?.changePercent ?? row.dailyChangePercent;
                        const pnlPerUnit = livePrice != null ? livePrice - row.buyPrice : null;
                        const pnlTotal = pnlPerUnit != null ? pnlPerUnit * row.units : null;
                        const pnlPctRaw = pnlPerUnit != null && row.buyPrice > 0 ? (pnlPerUnit / row.buyPrice) * 100 : null;
                        const H2_PCT_CAP = 9999;
                        const pnlPctCapped = pnlPctRaw != null && Math.abs(pnlPctRaw) > H2_PCT_CAP;
                        const pnlPct = pnlPctRaw != null ? (pnlPctCapped ? Math.sign(pnlPctRaw) * H2_PCT_CAP : pnlPctRaw) : null;
                        const holdingValue = livePrice != null ? livePrice * row.units : null;
                        const isEditingRow = h2EditId === row.id;
                        return (
                          <TableRow key={row.id} className="hover:bg-muted/20">
                            <TableCell className="font-bold">
                              {isEditingRow ? (
                                <Input type="text" value={h2EditTicker} onChange={e => setH2EditTicker(e.target.value.toUpperCase())} className="h-7 w-28 text-xs font-bold" placeholder="TICKER" />
                              ) : (
                                <button
                                  className="text-sky-400 hover:text-sky-300 hover:underline font-bold cursor-pointer bg-transparent border-0 p-0"
                                  onClick={() => navigate(`/deep-analysis/${encodeURIComponent(row.ticker)}`)}
                                  title="פתח Deep Analysis"
                                >{row.ticker}</button>
                              )}
                            </TableCell>
                            <TableCell className="text-right text-sm">
                              {isEditingRow ? (
                                <Input type="number" value={h2EditUnits} onChange={e => setH2EditUnits(e.target.value)} className="h-7 w-20 text-xs text-right" />
                              ) : row.units.toLocaleString()}
                            </TableCell>
                            <TableCell className="text-right text-sm">
                              {isEditingRow ? (
                                <Input type="number" value={h2EditBuyPrice} onChange={e => setH2EditBuyPrice(e.target.value)} className="h-7 w-24 text-xs text-right" />
                              ) : `$${row.buyPrice.toFixed(2)}`}
                            </TableCell>
                            <TableCell className="text-right text-sm font-medium">
                              {livePrice != null ? `$${livePrice.toFixed(2)}` : <span className="text-muted-foreground text-xs">—</span>}
                            </TableCell>
                            <TableCell className={`text-right text-sm font-medium ${
                              liveDailyChangePct != null ? (liveDailyChangePct >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]') : ''
                            }`}>
                              <div className="flex items-center justify-end gap-1">
                                {liveDailyChangePct != null ? `${liveDailyChangePct >= 0 ? '+' : ''}${liveDailyChangePct.toFixed(2)}%` : '—'}
                                {liveData?.isExtendedHours && (
                                  <span className="text-[10px] px-1 py-0 rounded bg-[rgba(37,99,235,0.15)] text-[#2563EB] dark:bg-[rgba(37,99,235,0.15)] dark:text-[#2563EB] font-medium leading-tight">
                                    PM
                                  </span>
                                )}
                              </div>
                            </TableCell>
                            {(() => {
                              const todayPnl = computeTodayPnl(
                                row.units,
                                row.buyPrice,
                                row.currentPrice ?? null,
                                liveData,
                                row.dailyChangePercent,
                                (row as { priceUpdatedAt?: string | Date | null }).priceUpdatedAt ?? null,
                                (row as { dailyBasePrice?: number | null }).dailyBasePrice ?? null,
                                (row as { dailyBaseTs?: number | null }).dailyBaseTs ?? null,
                                undefined,
                                (row as { transactionDate?: string | Date | null }).transactionDate ?? null,
                                (row as { createdAt?: string | Date | null }).createdAt ?? null,
                              );
                              return (
                                <TableCell className={`text-right text-sm font-medium ${
                                  todayPnl >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'
                                }`}>
                                  {`${todayPnl >= 0 ? '+' : '-'}$${Math.abs(todayPnl).toFixed(0)}`}
                                </TableCell>
                              );
                            })()}
                            <TableCell className={`text-right text-sm font-medium ${
                              pnlTotal != null ? (pnlTotal >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]') : ''
                            }`}>
                              {pnlTotal != null ? `${pnlTotal >= 0 ? '+' : ''}$${Math.abs(pnlTotal).toFixed(0)}` : '—'}
                            </TableCell>
                            <TableCell className={`text-right text-sm font-bold ${
                              pnlPct != null ? (pnlPct >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]') : ''
                            }`}>
                              {pnlPct != null ? (
                                pnlPctCapped ? (
                                  // Buy price too low (<$1) — % is meaningless, show N/A
                                  <span className="text-muted-foreground font-normal text-xs">N/A</span>
                                ) : (
                                  <>{pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</>
                                )
                              ) : '—'}
                            </TableCell>
                            <TableCell className="text-right text-sm">{holdingValue != null ? `$${holdingValue.toFixed(0)}` : <span className="text-muted-foreground text-xs">—</span>}</TableCell>
                            <TableCell className="text-center">
                              <ScoreBadge score={row.zivScore ?? null} />
                            </TableCell>
                            <TableCell className="text-center">
                              <ZivHBadge data={zivHMapH2[row.id]} />
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-1">
                                {isEditingRow ? (
                                  <>
                                    <Button size="sm" className="h-6 text-xs px-2 bg-[#65A30D] hover:bg-[#17a87e] text-white" disabled={h2UpdateMut.isPending}
                                      onClick={() => h2UpdateMut.mutate({ id: row.id, ticker: h2EditTicker || row.ticker, units: parseFloat(h2EditUnits) || row.units, buyPriceUsd: parseFloat(h2EditBuyPrice) || row.buyPrice })}>
                                      שמור
                                    </Button>
                                    <Button size="sm" variant="outline" className="h-6 text-xs px-2" onClick={() => setH2EditId(null)}>ביטול</Button>
                                  </>
                                ) : (
                                  <>
                                    <Button size="sm" variant="outline" className="h-6 text-xs px-2"
                                      onClick={() => { setH2EditId(row.id); setH2EditUnits(String(row.units)); setH2EditBuyPrice(String(row.buyPrice)); setH2EditTicker(row.ticker); }}>
                                      ✏️
                                    </Button>
                                    <Button size="sm" variant="outline" className="h-6 text-xs px-2 text-[#FF6B6B] hover:text-red-700 hover:bg-red-50"
                                      onClick={() => h2RemoveMut.mutate({ id: row.id })}>
                                      🗑
                                    </Button>
                                  </>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                    {/* Summary row */}
                    {(h2Data ?? []).filter(r => r.units !== 0).length > 1 && (() => {
                      // Use live price from h2LivePriceMap (same SSOT as table rows above)
                      const totalValue = (h2Data ?? []).filter(r => r.units !== 0).reduce((s, r) => s + ((h2LivePriceMap[r.ticker]?.price ?? r.currentPrice ?? r.buyPrice) * Math.abs(r.units)), 0);
                      const totalCost = (h2Data ?? []).filter(r => r.units !== 0).reduce((s, r) => s + r.buyPrice * Math.abs(r.units), 0);
                      const totalPnl = totalValue - totalCost;
                      const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
                      return (
                        <tfoot>
                          <tr className="bg-sky-950/20 font-semibold border-t-2 border-sky-800/40">
                            <td colSpan={8} className="px-4 py-2 text-sm text-right">סה"כ תיק:</td>
                            <td className="px-4 py-2 text-sm text-right">${totalValue.toFixed(0)}</td>
                            <td colSpan={2} className={`px-4 py-2 text-sm text-right font-bold ${totalPnl >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                              {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(0)} ({totalPnlPct >= 0 ? '+' : ''}{totalPnlPct.toFixed(2)}%)
                            </td>
                          </tr>
                        </tfoot>
                      );
                    })()}
                    {/* ── Fast-add inline row ── */}
                    <tfoot>
                      <tr className="border-t border-sky-800/30 bg-sky-950/10">
                        {/* Ticker with autocomplete */}
                        <td className="px-2 py-2" colSpan={2}>
                          <div ref={h2AcRef} className="relative">
                            <Input
                              value={h2FastTicker}
                              onChange={e => { setH2FastTicker(e.target.value.toUpperCase()); setH2AcOpen(true); }}
                              onFocus={() => h2FastTicker.length >= 1 && setH2AcOpen(true)}
                              onKeyDown={e => {
                                if (e.key === "Enter" && h2FastTicker && h2FastUnits && h2FastPrice) {
                                  setH2AcOpen(false);
                                  h2AddMut.mutate({ ticker: h2FastTicker, company: h2FastCompany || undefined, buyPrice: parseFloat(h2FastPrice), units: parseFloat(h2FastUnits), notes: h2FastNotes || undefined });
                                }
                                if (e.key === "Escape") setH2AcOpen(false);
                              }}
                              placeholder="TICKER..."
                              className="h-7 text-xs font-mono uppercase w-full"
                              autoComplete="off"
                            />
                            {h2AcOpen && (h2TickerSearch.data?.results?.length ?? 0) > 0 && (
                              <div className="absolute bottom-8 left-0 z-50 w-72 bg-popover border border-border rounded-lg shadow-lg overflow-hidden">
                                {h2TickerSearch.data!.results.map(r => (
                                  <button key={r.symbol} type="button"
                                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors"
                                    onMouseDown={e => {
                                      e.preventDefault();
                                      setH2FastTicker(r.symbol);
                                      setH2FastCompany(r.name);
                                      setH2AcOpen(false);
                                    }}
                                  >
                                    <span className="font-mono text-xs font-bold text-foreground w-14 shrink-0">{r.symbol}</span>
                                    <span className="text-xs text-muted-foreground truncate flex-1">{r.name}</span>
                                    <span className="text-[10px] text-muted-foreground/60 shrink-0">{r.exchange}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </td>
                        {/* Units (before price) */}
                        <td className="px-2 py-2">
                          <Input
                            type="number"
                            value={h2FastUnits}
                            onChange={e => setH2FastUnits(e.target.value)}
                            placeholder="כמות"
                            className="h-7 text-xs text-right w-20"
                          />
                        </td>
                        {/* Buy Price */}
                        <td className="px-2 py-2">
                          <Input
                            type="number"
                            value={h2FastPrice}
                            onChange={e => setH2FastPrice(e.target.value)}
                            placeholder="מחיר"
                            className="h-7 text-xs text-right w-24"
                          />
                        </td>
                        {/* Notes */}
                        <td className="px-2 py-2" colSpan={4}>
                          <Input
                            value={h2FastNotes}
                            onChange={e => setH2FastNotes(e.target.value)}
                            placeholder="הערה..."
                            className="h-7 text-xs w-full"
                          />
                        </td>
                        {/* Add button */}
                        <td className="px-2 py-2" colSpan={2}>
                          <Button
                            size="sm"
                            className="h-7 text-xs bg-sky-600 hover:bg-sky-700 text-white gap-1 w-full"
                            disabled={h2AddMut.isPending || !h2FastTicker || !h2FastUnits || !h2FastPrice}
                            onClick={() => h2AddMut.mutate({ ticker: h2FastTicker, company: h2FastCompany || undefined, buyPrice: parseFloat(h2FastPrice), units: parseFloat(h2FastUnits), notes: h2FastNotes || undefined })}
                          >
                            {h2AddMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                            הוסף
                          </Button>
                        </td>
                      </tr>
                    </tfoot>
                  </Table>
                </div>
              )}
            </CardContent>
          )}
        </Card>


        {/* ── Analysis Section (buttons + results) ── */}
        <AnalysisSection
          holdingsWithLive={holdingsWithLive}
          cashBalance={cashBalance}
          displayNLV={displayNLV}
          displayPortfolioValue={displayPortfolioValue}
          onAnalysisComplete={refresh}
          setLastRefreshedAt={setLastRefreshedAt}
          setMinutesSinceRefresh={setMinutesSinceRefresh}
          onHoldingScoresUpdated={(scores: { id: number; positionSizePct: number | null; suggestedUnits: number | null }[]) => {
            const m: Record<number, { positionSizePct: number | null; suggestedUnits: number | null }> = {};
            scores.forEach((s: { id: number; positionSizePct: number | null; suggestedUnits: number | null }) => { m[s.id] = { positionSizePct: s.positionSizePct, suggestedUnits: s.suggestedUnits }; });
            setExternalHoldingScoreMap(m);
          }}
          onH2AnalyzeResults={setH2AnalyzeResults}
          onHoldingsScanned={setHoldingsLastScanned}
          analyzing={analyzing}
          setAnalyzing={setAnalyzing}
          analysis={analysis}
          setAnalysis={setAnalysis}
          chatMessages={chatMessages}
          setChatMessages={setChatMessages}
          chatInput={chatInput}
          setChatInput={setChatInput}
          chatBottomRef={chatBottomRef}
          portfolioChatMut={portfolioChatMut}
          handleChatSend={handleChatSend}
          prevSignalsRef={prevSignalsRef}
          utils={utils}
        />

        {/* ── Persistent AI Chat Panel (always visible) ── */}
        <div className="mt-6">
          <Card className="border border-indigo-200 shadow-md bg-white">
            <CardHeader className="pb-3 pt-4 px-5 bg-indigo-50">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Bot className="h-4 w-4 text-indigo-600" />
                AI Portfolio Chat
                <span className="text-xs font-normal text-muted-foreground">שוחח עם המנהל הפיננסי שלך בעברית</span>
                {chatMessages.length > 0 && (
                  <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => setChatMessages([])}>
                    נקה שיחה
                  </Button>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {/* Messages area */}
              <div className="h-80 overflow-y-auto px-4 py-3 space-y-3 bg-background">
                {chatMessages.length === 0 && (
                  <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
                    <Bot className="h-10 w-10 mb-3 text-indigo-200" />
                    <p className="text-sm font-semibold text-foreground">מנהל התיק האישי שלך</p>
                    <p className="text-xs text-muted-foreground mt-1 max-w-xs">שאל כל שאלה על התיק, המניות, הסיכונים או האסטרטגיה</p>
                    <div className="mt-3 flex flex-wrap gap-2 justify-center">
                      {["מה המצב הנוכחי של התיק?", "איזו מניה הייתה הכי חזקה השבוע?", "האם כדאי להוסיף עוד מניות?"].map(q => (
                        <button
                          key={q}
                          className="text-xs bg-indigo-50 hover:bg-indigo-900/40 text-indigo-300 border border-indigo-700/40 rounded-full px-3 py-1 transition-colors"
                          onClick={() => { setChatInput(q); }}
                        >{q}</button>
                      ))}
                    </div>
                  </div>
                )}
                {chatMessages.map((msg, i) => (
                  <div key={i} className={`flex gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    {msg.role === "assistant" && (
                      <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <Bot className="h-4 w-4 text-indigo-600" />
                      </div>
                    )}
                    <div className={`max-w-[80%] rounded-xl px-3 py-2 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "bg-indigo-600 text-white rounded-br-sm"
                        : "bg-muted text-foreground rounded-bl-sm"
                    }`}>
                      {msg.content}
                    </div>
                    {msg.role === "user" && (
                      <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <span className="text-[9px] text-gray-800 font-bold">You</span>
                      </div>
                    )}
                  </div>
                ))}
                {portfolioChatMut.isPending && (
                  <div className="flex gap-2 justify-start">
                    <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
                      <Bot className="h-4 w-4 text-indigo-600" />
                    </div>
                    <div className="bg-muted rounded-xl rounded-bl-sm px-3 py-2 flex items-center gap-1">
                      <span className="text-xs text-muted-foreground">חושב...</span>
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" />
                    </div>
                  </div>
                )}
                <div ref={chatBottomRef} />
              </div>
              {/* Input area */}
              <div className="border-t px-4 py-3 flex gap-2 bg-muted/20">
                <Input
                  placeholder="שאל שאלה על התיק שלך..."
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleChatSend(holdingsWithLive, cashBalance, displayNLV ?? undefined); } }}
                  className="flex-1 text-sm"
                  disabled={portfolioChatMut.isPending}
                />
                <Button
                  size="sm"
                  onClick={() => handleChatSend(holdingsWithLive, cashBalance, displayNLV ?? undefined)}
                  disabled={portfolioChatMut.isPending || !chatInput.trim()}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-4"
                >
                  {portfolioChatMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

      </div>

      {/* ── Dialogs ── */}
      <AddHoldingDialog open={showAdd} onClose={() => setShowAdd(false)} onAdded={refresh} cashBalance={cashBalance} />
      {capitalMode && (
        <CapitalDialog
          mode={capitalMode}
          open={!!capitalMode}
          onClose={() => setCapitalMode(null)}
          onDone={refresh}
        />
      )}

      {/* Buy from Catalogue */}
      {buyTarget && (
        <BuyFromCatalogueDialog
          ticker={buyTarget.ticker}
          company={buyTarget.company}
          score={buyTarget.score}
          open={!!buyTarget}
          onClose={() => setBuyTarget(null)}
          onBought={() => { refresh(); refetchCatalogue(); }}
          cashBalance={cashBalance}
        />
      )}

      {/* Edit Catalogue Asset */}
      <EditCatalogueDialog
        asset={editTarget}
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => refetchCatalogue()}
      />

      {/* IBKR Order Dialog */}
      {ibkrOrderTarget && ibkrAccountId && (
        <Suspense fallback={null}>
        <IBKROrderDialog
          open={!!ibkrOrderTarget}
          onClose={() => setIbkrOrderTarget(null)}
          ticker={ibkrOrderTarget.ticker}
          company={ibkrOrderTarget.company}
          currentPrice={ibkrOrderTarget.currentPrice}
          stopLoss={ibkrOrderTarget.stopLoss}
          takeProfit={ibkrOrderTarget.takeProfit}
          suggestedUnits={ibkrOrderTarget.suggestedUnits}
          side={ibkrOrderTarget.side}
          accountId={ibkrAccountId}
          gatewayUrl={ibkrGatewayUrl}
        />
        </Suspense>
      )}

      {/* IBKR Bracket Order Dialog (3-leg OCA via IBIND) */}
      {bracketOrderTarget && ibkrAccountId && (
        <Suspense fallback={null}>
        <IBKRBracketDialog
          open={!!bracketOrderTarget}
          onClose={() => setBracketOrderTarget(null)}
          ticker={bracketOrderTarget.ticker}
          company={bracketOrderTarget.company}
          currentPrice={bracketOrderTarget.currentPrice}
          stopLoss={bracketOrderTarget.stopLoss}
          takeProfit={bracketOrderTarget.takeProfit}
          suggestedUnits={bracketOrderTarget.suggestedUnits}
          side={bracketOrderTarget.side}
          accountId={ibkrAccountId}
          conid={bracketOrderTarget.conid}
        />
        </Suspense>
      )}

      {/* ── Debug Raw IBIND Orders Dialog ── */}
      <Dialog open={showDebugOrders} onOpenChange={(o) => { if (!o) { setShowDebugOrders(false); setDebugOrdersData(null); } }}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>
              Debug: Raw IBIND /orders Response
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2">
            {debugOrdersLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
                <span className="animate-spin inline-block w-5 h-5 border-2 border-gray-400 border-t-transparent rounded-full" />
                Loading...
              </div>
            ) : debugOrdersData ? (
              <div className="space-y-3">
                <div className="text-xs text-muted-foreground">
                  <strong>Top-level keys:</strong> {Object.keys(debugOrdersData).join(", ")}
                </div>
                {Array.isArray(debugOrdersData) ? (
                  <div className="text-xs text-orange-600 font-semibold">⚠ Response is an array (not an object). Length: {debugOrdersData.length}</div>
                ) : null}
                {debugOrdersData?.orders && (
                  <div className="text-xs text-green-600 font-semibold">✓ Found .orders array — length: {debugOrdersData.orders.length}</div>
                )}
                {debugOrdersData?.orders?.[0] && (
                  <div>
                    <div className="text-xs font-semibold mb-1">First order keys: {Object.keys(debugOrdersData.orders[0]).join(", ")}</div>
                    <pre className="text-xs bg-muted/40 rounded p-3 overflow-auto max-h-48">{JSON.stringify(debugOrdersData.orders[0], null, 2)}</pre>
                  </div>
                )}
                {Array.isArray(debugOrdersData) && debugOrdersData[0] && (
                  <div>
                    <div className="text-xs font-semibold mb-1">First item keys: {Object.keys(debugOrdersData[0]).join(", ")}</div>
                    <pre className="text-xs bg-muted/40 rounded p-3 overflow-auto max-h-48">{JSON.stringify(debugOrdersData[0], null, 2)}</pre>
                  </div>
                )}
                <details>
                  <summary className="text-xs cursor-pointer text-muted-foreground hover:text-foreground">Full raw response</summary>
                  <pre className="text-xs bg-muted/40 rounded p-3 overflow-auto max-h-64 mt-2">{JSON.stringify(debugOrdersData, null, 2)}</pre>
                </details>
              </div>
            ) : (
              <div className="text-muted-foreground text-sm py-4 text-center">No data yet. Click Debug to fetch.</div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Sell at Market Confirmation Dialog ── */}
      <Dialog open={!!sellMarketTarget} onOpenChange={(o) => { if (!o) setSellMarketTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-orange-700">
              <TrendingDown className="h-5 w-5" />
              מכור בשוק — {sellMarketTarget?.ticker}
            </DialogTitle>
          </DialogHeader>
          {sellMarketTarget && (
            <div className="space-y-4 py-2">
              <div className="grid grid-cols-2 gap-3 text-sm">
                {/* Editable quantity */}
                <div className="bg-card rounded-lg p-3 text-center border">
                  <p className="text-xs text-muted-foreground mb-1">כמות</p>
                  <div className="flex items-center justify-center gap-1">
                    <input
                      type="number"
                      min={1}
                      max={sellMarketTarget.units}
                      step={1}
                      value={sellMarketQty}
                      onChange={e => {
                        const v = e.target.value;
                        // Allow empty string while typing
                        if (v === "" || /^\d+$/.test(v)) setSellMarketQty(v);
                      }}
                      onBlur={e => {
                        // Clamp on blur
                        const n = parseInt(e.target.value, 10);
                        if (isNaN(n) || n < 1) setSellMarketQty("1");
                        else if (n > sellMarketTarget.units) setSellMarketQty(String(sellMarketTarget.units));
                      }}
                      className="w-20 text-center font-mono font-bold text-foreground bg-card border border-border rounded px-2 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-orange-400"
                    />
                    <span className="text-xs text-gray-500">/ {sellMarketTarget.units}</span>
                  </div>
                </div>
                <div className="bg-card rounded-lg p-3 text-center border">
                  <p className="text-xs text-muted-foreground mb-1">מחיר נוכחי</p>
                  <p className="font-mono font-bold text-foreground">${(sellMarketTarget.currentPrice ?? sellMarketTarget.buyPrice).toFixed(2)}</p>
                </div>
                {/* Estimated value — updates live as qty changes */}
                <div className="bg-orange-950/20 rounded-lg p-3 text-center border border-orange-800/40 col-span-2">
                  <p className="text-xs text-muted-foreground mb-1">שווי מוערך</p>
                  <p className="font-mono font-bold text-orange-400">
                    ${((sellMarketTarget.currentPrice ?? sellMarketTarget.buyPrice) * (parseInt(sellMarketQty, 10) || 0)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                </div>
              </div>
              {/* Slippage selector */}
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-gray-600">Slippage Buffer (%)</p>
                <div className="flex gap-1">
                  {["0.1", "0.5", "1.0", "2.0"].map(v => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setSellMarketSlippage(v)}
                      className={`flex-1 h-7 rounded text-xs font-mono border transition-colors ${
                        sellMarketSlippage === v
                          ? "bg-orange-600 text-white border-orange-600"
                          : "bg-card text-foreground border-border hover:bg-muted/30"
                      }`}
                    >{v}%</button>
                  ))}
                </div>
                <p className="text-[10px] text-gray-400">LMT בפענות שוק − {sellMarketSlippage}% (מונע מילוי חלקי)</p>
              </div>
              {!sellMarketTarget.conid && (
                <div className="text-xs text-orange-700 bg-orange-50 border border-orange-200 rounded p-2">
                  ⚠️ conid חסר — בצע Sync Now כדי לאפשר פקודות שוק
                </div>
              )}
              <div className="text-xs text-orange-700 bg-orange-50 border border-orange-200 rounded p-2">
                {parseInt(sellMarketQty, 10) < sellMarketTarget.units
                  ? `⚠️ מכירה חלקית — ${sellMarketQty} מתוך ${sellMarketTarget.units} מניות. אשר רק אם בטוח.`
                  : "⚠️ פקודה זו תמכור את כל הפוזיציה במחיר שוק מייד. אשר רק אם בטוח."
                }
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setSellMarketTarget(null)}>ביטול</Button>
            <Button
              className="bg-orange-600 hover:bg-orange-700 text-white gap-1.5"
              disabled={placeMarketMut.isPending || !sellMarketTarget?.conid || (sellMarketTarget?.conid ?? 0) <= 0 || (parseInt(sellMarketQty, 10) || 0) < 1}
              title={!sellMarketTarget?.conid ? "conid חסר — בצע Sync Now" : undefined}
              onClick={() => {
                if (!sellMarketTarget) return;
                if (!sellMarketTarget.conid || sellMarketTarget.conid <= 0) {
                  toast.error("conid חסר — בצע Sync Now כדי לאפשר פקודות שוק");
                  return;
                }
                const qty = parseInt(sellMarketQty, 10);
                if (!qty || qty < 1) { toast.error("כמות לא תקינה"); return; }
                placeMarketMut.mutate({
                  ticker: sellMarketTarget.ticker,
                  conid: sellMarketTarget.conid,
                  side: "SELL",
                  quantity: qty,
                  slippagePct: parseFloat(sellMarketSlippage),
                  currentPrice: sellMarketTarget.currentPrice ?? sellMarketTarget.buyPrice,
                });
              }}
            >
              {placeMarketMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <TrendingDown className="h-4 w-4" />}
              {placeMarketMut.isPending ? "שולח..." : `אשר מכירה בשוק`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Order Status Popup (Live Trading) */}
      {orderPopupOpen && orderPopupData && (
        <OrderStatusPopup
          open={orderPopupOpen}
          onClose={() => { setOrderPopupOpen(false); setOrderPopupData(null); }}
          ticker={orderPopupData.ticker}
          side={orderPopupData.side}
          quantity={orderPopupData.quantity}
          orderType="MKT"
          orderId={orderPopupData.orderId}
          immediateStatus={orderPopupData.immediateStatus}
          ibkrMessage={orderPopupData.ibkrMessage ?? undefined}
        />
      )}
    </div>
  );
}

