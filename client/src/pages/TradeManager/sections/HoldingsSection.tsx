/**
 * HoldingsSection — Holdings table, alert banners, and SL/TP monitor
 *
 * Extracted from TradeManager.tsx (Phase A, Step 3.1).
 *
 * Key optimizations:
 * - All callbacks passed to HoldingRow are stabilized with useCallback so
 *   React.memo on HoldingRow actually prevents re-renders on price ticks.
 * - The SL/TP monitor table is self-contained here.
 * - Alert banners (EXIT / WATCH) are co-located with the Holdings card.
 */
import { useState, useCallback } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Loader2, Plus, RefreshCw, Wallet, AlertTriangle,
  Wifi, ChevronUp, ChevronDown, ChevronsUpDown, ShieldAlert,
} from "lucide-react";
import type { Holding, ZivHData } from "../types";
import { HoldingRow } from "../components/HoldingRow";
import { pnlColor } from "../helpers";
import { computeTodayPnl } from "@/hooks/usePortfolioMetrics";


// ─── ScanStatsBar ─────────────────────────────────────────────────────────────
function ScanStatsBar() {
  const { data, isLoading } = trpc.liveEngine.getLastScanStats.useQuery(undefined, {
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const regimeColor: Record<string, string> = {
    BULL:    "text-emerald-600 bg-emerald-50 border-emerald-200",
    NEUTRAL: "text-amber-600 bg-amber-50 border-amber-200",
    BEAR:    "text-rose-600 bg-rose-50 border-rose-200",
    MIXED:   "text-blue-600 bg-blue-50 border-blue-200",
  };
  const passedColor = (n: number) =>
    n === 0 ? "text-muted-foreground" : n < 3 ? "text-amber-600" : "text-emerald-600";

  if (isLoading) return (
    <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border bg-muted/30 text-xs text-muted-foreground animate-pulse">
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-pulse" />
      טוען נתוני סריקה...
    </div>
  );

  if (!data) return null;

  const passed = data.entered;
  const regime = data.regime ?? "NEUTRAL";
  const regCls = regimeColor[regime] ?? regimeColor.NEUTRAL;
  const timeStr = data.at
    ? new Date(data.at).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })
    : "—";

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 rounded-xl border bg-muted/20 text-xs">
      {/* Icon + label */}
      <div className="flex items-center gap-1.5 text-muted-foreground font-medium">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
        סריקה אחרונה
      </div>
      {/* Scanned count */}
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground">נסרקו</span>
        <span className="font-bold font-mono text-foreground">{data.scanned}</span>
        <span className="text-muted-foreground">מניות</span>
      </div>
      {/* Separator */}
      <span className="text-muted-foreground/30">·</span>
      {/* Passed ≥8.0 */}
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground">עברו ≥8.0</span>
        <span className={`font-bold font-mono ${passedColor(passed)}`}>{passed}</span>
      </div>
      {/* Separator */}
      <span className="text-muted-foreground/30">·</span>
      {/* Regime */}
      <span className={`px-2 py-0.5 rounded-full border font-semibold text-[10px] ${regCls}`}>
        {regime}
      </span>
      {/* Time */}
      <span className="text-muted-foreground ml-auto">{timeStr}</span>
    </div>
  );
}

// ─── QuickAddRow (local copy to avoid import cycle) ──────────────────────────
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
      toast.warning(
        `Insufficient cash — need $${cost.toLocaleString(undefined, { maximumFractionDigits: 0 })} but have $${cashBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })}. Adding anyway (overdraft).`,
        { duration: 5000 }
      );
    }
    addMut.mutate({ ticker: ticker.toUpperCase(), buyPrice: parseFloat(buyPrice), units: parseFloat(units) });
  };

  if (!active) {
    return (
      <TableRow
        className="border-dashed border-t cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => setActive(true)}
      >
        <td colSpan={10} className="py-2.5 px-4">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Plus className="h-4 w-4" />
            <span>Quick add holding…</span>
          </div>
        </td>
      </TableRow>
    );
  }
  return (
    <TableRow className="bg-muted/20 border-t-2 border-blue-200">
      <td className="text-xs text-muted-foreground text-center px-2">—</td>
      <td className="py-2 px-2">
        <input
          className="w-20 border rounded px-2 py-1 text-xs font-mono uppercase"
          placeholder="TICKER"
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && handleQuickAdd()}
          autoFocus
        />
      </td>
      <td className="py-2 px-2 text-right">
        <input
          className="w-16 border rounded px-2 py-1 text-xs text-right"
          placeholder="Units"
          type="number"
          value={units}
          onChange={(e) => setUnits(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleQuickAdd()}
        />
      </td>
      <td className="py-2 px-2 text-right">
        <input
          className="w-20 border rounded px-2 py-1 text-xs text-right"
          placeholder="Buy $"
          type="number"
          value={buyPrice}
          onChange={(e) => setBuyPrice(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleQuickAdd()}
        />
      </td>
      <td colSpan={6} className="py-2 px-2">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-[#65A30D]" onClick={handleQuickAdd} disabled={addMut.isPending}>
            {addMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add"}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-muted-foreground" onClick={() => setActive(false)}>
            Cancel
          </Button>
        </div>
      </td>
    </TableRow>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface HoldingsSectionProps {
  holdingsWithLive: Holding[];
  holdings: Holding[];
  holdingLivePriceMap: Record<string, {
    price: number | null;
    change: number | null;
    changePercent: number | null;
    isExtendedHours?: boolean;
    isClosingPrice?: boolean;
    prevClose?: number | null;
  }>;
  todayPnlIbkr?: number | null;
  zivHMap: Record<number, ZivHData>;
  zivHByTicker: Record<string, ZivHData>;
  ibkrStatus: string;
  isMarketOpen: boolean;
  holdingsLastScanned: Date | null;
  lastRefreshedAt: Date | null;
  isLoading: boolean;
  cashBalance: number;
  totalValue: number;
  totalCost: number;
  totalPnl: number;
  totalPnlPct: number;
  deepNavList: string[];
  ibkrPositionMap: Record<string, { conid?: number | null | undefined; [key: string]: any }>;
  ibkrPositionsData: { positions?: Array<{ ticker: string; conid?: number }> } | null | undefined;
  syncFromIbkrMut: { isPending: boolean };
  refreshMut: { isPending: boolean; mutate: () => void };
  backfillBuyScoreMut: { isPending: boolean; mutate: () => void };
  cancelOrderMut: { isPending: boolean; mutate: (args: { orderId: string; holdingId: number; field: "sl" | "tp" }) => void };
  syncSlTpMut: { isPending: boolean; mutate: (args: any, opts?: any) => void };
  onRefresh: () => void;
  onSyncFromIbkr: () => void;
  onSetSellMarketTarget: (h: Holding) => void;
  onSetSellMarketSlippage: (v: string) => void;
  onSetSellMarketQty: (v: string) => void;
  onSetShowAdd: (v: boolean) => void;
  onSetSltpDeepTicker: (t: string | null) => void;
  onSetH2DeepTicker: (t: string | null) => void;
  onSetH2DeepHoldingCtx: (ctx: any) => void;
  getDeepNavContext: (t: string) => any;
  holdingsSortCol: string | null;
  holdingsSortDir: "asc" | "desc" | null;
  onHoldingsSort: (col: string) => void;
  sltpDeepTicker: string | null;
  refetchState: () => void;
  refetchIbkrPositions: () => void;
  utils: any;
  onRefreshZivH?: () => void;
  isRefreshingZivH?: boolean;
  /** SSOT: centralized metrics from usePortfolioMetrics. When provided, overrides local calculations. */
  portfolioMetrics?: import("@/hooks/usePortfolioMetrics").PortfolioMetrics;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function HoldingsSection({
  holdingsWithLive,
  holdings,
  holdingLivePriceMap,
  zivHMap,
  zivHByTicker,
  ibkrStatus,
  isMarketOpen,
  holdingsLastScanned,
  lastRefreshedAt,
  isLoading,
  cashBalance,
  totalValue,
  totalCost,
  totalPnl,
  totalPnlPct,
  deepNavList,
  ibkrPositionMap,
  ibkrPositionsData,
  syncFromIbkrMut,
  refreshMut,
  backfillBuyScoreMut,
  cancelOrderMut,
  syncSlTpMut,
  onRefresh,
  onSyncFromIbkr,
  onSetSellMarketTarget,
  onSetSellMarketSlippage,
  onSetSellMarketQty,
  onSetShowAdd,
  onSetSltpDeepTicker,
  onSetH2DeepTicker,
  onSetH2DeepHoldingCtx,
  getDeepNavContext,
  holdingsSortCol,
  holdingsSortDir,
  onHoldingsSort,
  sltpDeepTicker,
  refetchState,
  refetchIbkrPositions,
  utils,
  onRefreshZivH,
  isRefreshingZivH,
  todayPnlIbkr,
  portfolioMetrics,
}: HoldingsSectionProps) {
  const [, navigate] = useLocation();

  // Debug orders state (local to this section)
  const [showDebugOrders, setShowDebugOrders] = useState(false);
  const [debugOrdersData, setDebugOrdersData] = useState<any>(null);
  const [debugOrdersLoading, setDebugOrdersLoading] = useState(false);

  // ── Stabilized callbacks for HoldingRow (prevents React.memo bypass) ────────

  const handleUpdate = useCallback(() => {
    onRefresh();
  }, [onRefresh]);

  const handleSellMarket = useCallback((holding: Holding) => {
    onSetSellMarketSlippage("0.5");
    onSetSellMarketQty(String(holding.units));
    const liveConid = ibkrPositionMap[holding.ticker.toUpperCase()]?.conid;
    const enriched = (!holding.conid && liveConid)
      ? { ...holding, conid: liveConid }
      : holding;
    onSetSellMarketTarget(enriched);
  }, [ibkrPositionMap, onSetSellMarketTarget, onSetSellMarketSlippage, onSetSellMarketQty]);

  const handleNavigate = useCallback((t: string) => {
    const nav = getDeepNavContext(t);
    if (!nav) return;
    if (nav.source === "h2") {
      onSetH2DeepTicker(t);
      onSetH2DeepHoldingCtx(nav.ctx);
    } else {
      onSetSltpDeepTicker(t);
    }
  }, [getDeepNavContext, onSetH2DeepTicker, onSetH2DeepHoldingCtx, onSetSltpDeepTicker]);

  // ── Sync SL/TP handler ───────────────────────────────────────────────────────
  const handleSyncSlTp = useCallback(async () => {
    let activeOrderIds: string[] = [];
    let activeOrders: Array<{ orderId: string; ticker?: string; symbol?: string; orderType?: string; side?: string; status?: string }> = [];
    try {
      const ibindRes = await fetch("/api/ibind/orders").then(r => r.json()).catch(() => null);
      if (ibindRes?.orders) {
        const allOrders = ibindRes.orders as any[];
        const ACTIVE_STATUSES = new Set(["presubmitted", "pendingsubmit", "submitted", "presubmit"]);
        const activeOnly = allOrders.filter((o: any) => {
          const st = (o.status ?? o.orderStatus ?? "").toLowerCase();
          return ACTIVE_STATUSES.has(st) || st === "";
        });
        activeOrderIds = activeOnly.map((o: any) =>
          String(o.orderId ?? o.order_id ?? o.ibkrOrderId ?? "")
        ).filter(Boolean);
        activeOrders = activeOnly.map((o: any) => ({
          orderId: String(o.orderId ?? o.order_id ?? o.ibkrOrderId ?? ""),
          ticker: o.ticker ?? o.symbol ?? o.description ?? undefined,
          symbol: o.symbol ?? o.ticker ?? undefined,
          orderType: o.orderType ?? o.order_type ?? o.type ?? undefined,
          side: o.side ?? o.action ?? undefined,
          status: o.status ?? o.orderStatus ?? undefined,
        })).filter((o: any) => o.orderId);
      }
    } catch {}
    syncSlTpMut.mutate({ activeOrderIds, activeOrders }, {
      onSuccess: () => {
        utils.portfolio.getState.invalidate();
        refetchState();
        refetchIbkrPositions();
      }
    });
  }, [syncSlTpMut, utils, refetchState, refetchIbkrPositions]);

  // ── Derived values ────────────────────────────────────────────────────────────
  const slTpHoldings = holdingsWithLive.filter(h => h.units !== 0 && (h.stopLoss != null || h.takeProfit != null));

  const SORT_COLUMNS = [
    { key: "ticker", label: "Ticker", align: "left" },
    { key: "units", label: "Units", align: "right" },
    { key: "buyPrice", label: "Buy Price", align: "right" },
    { key: "currentPrice", label: "Current Price", align: "right" },
    { key: "dailyChangePercent", label: "Today %", align: "right" },
    { key: "todayPnl", label: "Today $", align: "right" },
    { key: "value", label: "Value", align: "right" },
    { key: "pnlPct", label: "Yield / P&L", align: "right" },
    { key: "stopLoss", label: "Stop Loss", align: "right" },
    { key: "takeProfit", label: "Take Profit", align: "right" },
    { key: "zivScore", label: "Score", align: "center" },
    { key: "zivHScore", label: "H Health", align: "center" },
  ] as const;

  // ── Footer stats ─────────────────────────────────────────────────────────────
  // SSOT: portfolioMetrics.h1TodayPnl = IBKR /pnl when live (matches IBKR mobile Today).
  const ssotTodayPnl: number | null = portfolioMetrics?.h1TodayPnl ?? null;
  const ssotTodayPct: number | null = portfolioMetrics?.h1TodayPct ?? null;
  const displayPortfolioValue: number = portfolioMetrics?.h1NLV ?? totalValue;

  const scoredHoldings = holdingsWithLive.filter(h => h.zivScore != null);
  const avgScore = scoredHoldings.length > 0
    ? scoredHoldings.reduce((s, h) => s + (h.zivScore ?? 0), 0) / scoredHoldings.length
    : null;
  const avgScoreColor = avgScore == null ? "text-muted-foreground"
    : avgScore >= 7 ? "text-[#65A30D]"
    : avgScore >= 5 ? "text-[#C9A84C]"
    : "text-amber-600";

  return (
    <>
      {/* ── EXIT / WATCH Alert Banners ── */}
      {holdingsWithLive.some(h => h.zivScore !== null && h.zivScore <= 2) && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-3 shadow-sm">
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-red-100 flex items-center justify-center">
            <AlertTriangle className="h-4 w-4 text-[#FF6B6B]" />
          </div>
          <div>
            <p className="text-sm font-bold text-red-700 dark:text-[#FF6B6B]">⚠️ EXIT Signal — Ziv Score ≤ 2</p>
            <p className="text-xs text-[#FF6B6B]/80 dark:text-[#FF6B6B]/80 mt-0.5">
              {holdingsWithLive.filter(h => h.zivScore !== null && h.zivScore <= 2).map(h => `${h.ticker} (${h.zivScore}/10)`).join(" · ")} — לפי מודל זיו: מכור מיד
            </p>
          </div>
        </div>
      )}
      {holdingsWithLive.some(h => h.zivScore !== null && h.buyScore !== null && (h.zivScore - h.buyScore) <= -3 && h.zivScore > 2) && (
        <div className="flex items-start gap-3 bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 shadow-sm">
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-orange-100 flex items-center justify-center">
            <AlertTriangle className="h-4 w-4 text-orange-600" />
          </div>
          <div>
            <p className="text-sm font-bold text-orange-700 dark:text-orange-400">⚡ WATCH — Score Drop ≥ 3 Points</p>
            <p className="text-xs text-orange-600/80 dark:text-orange-400/80 mt-0.5">
              {holdingsWithLive
                .filter(h => h.zivScore !== null && h.buyScore !== null && (h.zivScore - h.buyScore) <= -3 && h.zivScore > 2)
                .map(h => `${h.ticker} (${h.buyScore?.toFixed(0)}→${h.zivScore?.toFixed(0)})`).join(" · ")} — ירידה משמעותית בציון מאז הקנייה
            </p>
          </div>
        </div>
      )}

      {/* ── Holdings Table ── */}
      <Card className="border border-border/60 shadow-md rounded-2xl overflow-hidden">
        <CardHeader className="pb-3 pt-4 px-4 sm:px-5 bg-white/80 border-b border-border/40">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <CardTitle className="text-base font-bold flex flex-wrap items-center gap-2">
              <Wallet className="h-4 w-4 text-[#C9A84C]" /> Holdings
              {ibkrStatus === "connected" && isMarketOpen && (
                <span className="flex items-center gap-1 text-[10px] font-semibold text-[#65A30D] bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  LIVE · IBKR
                </span>
              )}
              {ibkrStatus !== "connected" && isMarketOpen && holdings.length > 0 && (
                <span className="flex items-center gap-1 text-[10px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-full px-2 py-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#2563EB] animate-pulse" />
                  LIVE · 30s
                </span>
              )}
              {holdingsLastScanned && (
                <span className="text-[10px] font-normal text-[#2563EB] bg-blue-50 border border-blue-200 rounded-full px-2 py-0.5">
                  Scored: {holdingsLastScanned.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              {lastRefreshedAt && (
                <span className="hidden sm:flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-[#65A30D] border border-emerald-200">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  עדכון אחרון: {lastRefreshedAt.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
              )}
              {ibkrStatus === "connected" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-xs gap-1 text-blue-600 border-blue-300 hover:bg-blue-50"
                  onClick={onSyncFromIbkr}
                  disabled={syncFromIbkrMut.isPending || !ibkrPositionsData?.positions?.length}
                  title="Sync IBKR live positions into Holdings (saves to DB for offline use)"
                >
                  {syncFromIbkrMut.isPending
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Wifi className="h-3.5 w-3.5" />}
                  Refresh from IBKR
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-xs gap-1"
                onClick={() => refreshMut.mutate()}
                disabled={refreshMut.isPending}
                title="Refresh current prices and recalculate P&L"
              >
                {refreshMut.isPending
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <RefreshCw className="h-3.5 w-3.5" />}
                Refresh Prices
              </Button>
              {onRefreshZivH && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-xs gap-1 text-amber-700 border-amber-300 hover:bg-amber-50"
                  onClick={onRefreshZivH}
                  disabled={isRefreshingZivH}
                  title="Recalculate H HEALTH scores from server (clears cache)"
                >
                  {isRefreshingZivH
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <ShieldAlert className="h-3.5 w-3.5" />}
                  Refresh H Health
                </Button>
              )}
            </div>
          </div>
          {/* ── Summary stats bar (shown when holdings exist) ── */}
          {!isLoading && holdings.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mt-2 pt-2 border-t border-border/30 text-sm">
              <span className="font-semibold text-foreground">{holdings.length} פוזיציות</span>
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground text-xs">שווי תיק</span>
                <span className="font-mono font-bold text-foreground">${displayPortfolioValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground text-xs">שינוי יומי</span>
                {ssotTodayPct != null ? (
                  <>
                    <span className={`font-mono font-bold ${ssotTodayPct > 0 ? "text-[#65A30D]" : ssotTodayPct < 0 ? "text-[#FF6B6B]" : "text-muted-foreground"}`}>
                      {ssotTodayPct >= 0 ? "+" : ""}{ssotTodayPct.toFixed(2)}%
                    </span>
                    <span className={`text-xs font-mono ${ssotTodayPct > 0 ? "text-[#65A30D]" : ssotTodayPct < 0 ? "text-[#FF6B6B]" : "text-muted-foreground"}`}>
                      ({ssotTodayPnl != null
                        ? `${ssotTodayPnl >= 0 ? "+" : ""}$${Math.abs(ssotTodayPnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                        : "—"})
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground text-xs">P&L כולל</span>
                <span className={`font-mono font-bold ${pnlColor(totalPnl)}`}>
                  {totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
                <span className={`text-xs font-mono ${pnlColor(totalPnlPct)}`}>
                  ({totalPnlPct >= 0 ? "+" : ""}{totalPnlPct.toFixed(2)}%)
                </span>
              </div>
            </div>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {/* ── H1 Summary Cards — identical to H2 layout —── */}
          {!isLoading && holdings.length > 0 && (() => {
            const activeHoldings = holdingsWithLive.filter(h => h.units !== 0);
            // SSOT: portfolioMetrics.h1TodayPnl = sum of (mktPrice - prevClose) × units across all rows
            // Never uses /pnl endpoint — card always equals sum of per-row $ TODAY column
            const displayTodayPnl: number | null = ssotTodayPnl;
            const todaySource = 'IBKR live';
            return (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 pb-2">
                <div className="bg-white border rounded-xl p-3 shadow-sm">
                  <p className="text-xs text-muted-foreground mb-1">שווי תיק</p>
                  <p className="text-lg font-bold text-blue-700">${displayPortfolioValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}</p>

                </div>
                <div className="bg-white border rounded-xl p-3 shadow-sm">
                  <p className="text-xs text-muted-foreground mb-1">P&L כולל</p>
                  <p className={`text-lg font-bold ${totalPnl >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                    {totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                  </p>
                  <p className={`text-xs font-medium ${totalPnlPct >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                    {totalPnlPct >= 0 ? '+' : ''}{totalPnlPct.toFixed(2)}%
                  </p>
                </div>
                <div className="bg-white border rounded-xl p-3 shadow-sm">
                  <p className="text-xs text-muted-foreground mb-1">TODAY P&L</p>
                  {displayTodayPnl != null ? (
                    <>
                      <p className={`text-lg font-bold ${displayTodayPnl >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                        {displayTodayPnl >= 0 ? '+' : ''}${displayTodayPnl.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                      </p>
                      <p className="text-xs text-muted-foreground">{todaySource}</p>
                    </>
                  ) : (
                    <p className="text-lg font-bold text-muted-foreground">—</p>
                  )}
                </div>
                <div className="bg-white border rounded-xl p-3 shadow-sm">
                  <p className="text-xs text-muted-foreground mb-1">מניות</p>
                  <p className="text-lg font-bold text-blue-700">{activeHoldings.length}</p>
                  <p className="text-xs text-muted-foreground">מניות פעילות</p>
                </div>
              </div>
            );
          })()}
          {isLoading ? (
            <div className="space-y-0">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-border/40">
                  <Skeleton className="h-4 w-4 rounded" />
                  <Skeleton className="h-4 w-14" />
                  <Skeleton className="h-3 w-24 ml-1" />
                  <div className="flex-1" />
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 w-14" />
                  <Skeleton className="h-4 w-14" />
                  <Skeleton className="h-4 w-12" />
                </div>
              ))}
            </div>
          ) : holdings.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Wallet className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No holdings yet</p>
              <p className="text-sm mt-1">Click "Add Holding" to start tracking your portfolio</p>
              <Button className="mt-4" onClick={() => onSetShowAdd(true)}>
                <Plus className="h-4 w-4 mr-2" /> Add First Holding
              </Button>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table className="min-w-[900px]">
                  <TableHeader>
                    <TableRow className="bg-slate-50/80 border-b border-border/50">
                      <TableHead className="font-semibold text-xs uppercase tracking-wide w-8 text-center">#</TableHead>
                      {SORT_COLUMNS.map(({ key, label, align }) => (
                        <TableHead
                          key={key}
                          className={`font-semibold text-xs uppercase tracking-wide cursor-pointer select-none hover:bg-muted/50 whitespace-nowrap ${align === "center" ? "text-center w-16" : align === "right" ? "text-right" : ""}`}
                          onClick={() => onHoldingsSort(key)}
                        >
                          {label}
                          {holdingsSortCol === key
                            ? holdingsSortDir === "asc"
                              ? <ChevronUp className="h-3 w-3 ml-1 text-[#C9A84C] inline" />
                              : holdingsSortDir === "desc"
                                ? <ChevronDown className="h-3 w-3 ml-1 text-[#C9A84C] inline" />
                                : <ChevronsUpDown className="h-3 w-3 ml-1 text-muted-foreground opacity-50 inline" />
                            : <ChevronsUpDown className="h-3 w-3 ml-1 text-muted-foreground opacity-50 inline" />
                          }
                        </TableHead>
                      ))}
                      <TableHead className="text-right font-semibold text-xs uppercase tracking-wide w-20">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {holdingsWithLive.filter(h => h.units !== 0).map((h, idx) => (
                      <HoldingRow
                        key={h.id}
                        holding={h}
                        rowNum={idx + 1}
                        onUpdate={handleUpdate}
                        onSellMarket={ibkrStatus === "connected" ? handleSellMarket : undefined}
                        isExtendedHours={holdingLivePriceMap[h.ticker]?.isClosingPrice ?? holdingLivePriceMap[h.ticker]?.isExtendedHours ?? false}
                        livePrice={holdingLivePriceMap[h.ticker]?.price ?? null}
                        todayPnl={computeTodayPnl(
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
                        )}
                        prevClose={holdingLivePriceMap[h.ticker]?.prevClose ?? null}
                        navList={deepNavList}
                        zivHData={zivHMap[h.id] ?? zivHByTicker[h.ticker?.toUpperCase()]}
                        onNavigate={handleNavigate}
                      />
                    ))}
                    <QuickAddRow onAdded={handleUpdate} cashBalance={cashBalance} />
                  </TableBody>
                </Table>
              </div>
              {/* Portfolio Summary Footer */}
              <div className="border-t border-border/40 bg-gray-50/60 px-5 py-3">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-sm">
                  <span className="font-semibold text-foreground">{holdings.length} position{holdings.length !== 1 ? "s" : ""}</span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground text-xs">שווי תיק</span>
                    <span className="font-mono font-bold text-foreground">${displayPortfolioValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground text-xs">שינוי יומי</span>
                    {ssotTodayPct != null ? (
                      <>
                        <span className={`font-mono font-bold text-sm ${ssotTodayPct > 0 ? "text-[#65A30D]" : ssotTodayPct < 0 ? "text-[#FF6B6B]" : "text-muted-foreground"}`}>
                          {ssotTodayPct >= 0 ? "+" : ""}{ssotTodayPct.toFixed(2)}%
                        </span>
                        <span className={`text-xs font-mono ${ssotTodayPct > 0 ? "text-[#65A30D]" : ssotTodayPct < 0 ? "text-[#FF6B6B]" : "text-muted-foreground"}`}>
                          ({ssotTodayPnl != null
                            ? `${ssotTodayPnl >= 0 ? "+" : ""}$${Math.abs(ssotTodayPnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                            : "—"})
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground text-xs">P&L כולל</span>
                    <span className={`font-mono font-bold text-sm ${pnlColor(totalPnl)}`}>
                      {totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                    <span className={`text-xs font-mono ${pnlColor(totalPnlPct)}`}>
                      ({totalPnlPct >= 0 ? "+" : ""}{totalPnlPct.toFixed(2)}%)
                    </span>
                  </div>
                  {avgScore != null && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground text-xs">ציון ממוצע</span>
                      <span className={`font-mono font-bold text-sm ${avgScoreColor}`}>{avgScore.toFixed(2)}</span>
                      <span className="text-muted-foreground text-xs">/ 10</span>
                    </div>
                  )}

                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>


      {/* ── Elsa Scan Counter ── */}
      <ScanStatsBar />

      {/* ── SL / TP Monitor ── */}
      {slTpHoldings.length > 0 && (
        <Card className="border border-orange-200/80 dark:border-orange-900/40 shadow-md rounded-2xl overflow-hidden">
          <CardHeader className="pb-2 pt-5 px-5 bg-gradient-to-r from-orange-50/60 to-amber-50/30  border-b border-orange-100/60">
            <CardTitle className="text-base font-bold flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-orange-500" />
              <span>Stop Loss / Take Profit Monitor</span>
              <span className="text-xs font-normal text-muted-foreground">({slTpHoldings.length} positions)</span>
              {slTpHoldings.some(h => h.buyScore == null) && (
                <button
                  className="text-xs px-2 py-1 rounded border border-blue-300 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-50 disabled:opacity-50 flex items-center gap-1"
                  onClick={() => backfillBuyScoreMut.mutate()}
                  disabled={backfillBuyScoreMut.isPending}
                  title="מלא ציוני קניה חסרים מהציון הנוכחי"
                >
                  {backfillBuyScoreMut.isPending
                    ? <span className="animate-spin inline-block w-3 h-3 border border-[#C9A84C] border-t-transparent rounded-full" />
                    : <span>★</span>}
                  מלא ציוני קניה
                </button>
              )}
              <button
                className="ml-auto text-xs px-2 py-1 rounded border border-orange-300 text-orange-600 hover:bg-orange-50 dark:hover:bg-orange-50 disabled:opacity-50 flex items-center gap-1"
                onClick={handleSyncSlTp}
                disabled={syncSlTpMut.isPending}
                title="Sync SL/TP order status with IBKR"
              >
                {syncSlTpMut.isPending
                  ? <span className="animate-spin inline-block w-3 h-3 border border-orange-400 border-t-transparent rounded-full" />
                  : <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>}
                Sync
              </button>
              {/* Debug button */}
              <button
                className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 flex items-center gap-1"
                onClick={async () => {
                  setDebugOrdersLoading(true);
                  setShowDebugOrders(true);
                  try {
                    const res = await fetch("/api/ibind/orders").then(r => r.json()).catch((e: any) => ({ error: e.message }));
                    setDebugOrdersData(res);
                  } catch (e: any) {
                    setDebugOrdersData({ error: e.message });
                  } finally {
                    setDebugOrdersLoading(false);
                  }
                }}
                disabled={debugOrdersLoading}
                title="Debug: show raw IBIND /orders response"
              >
                {debugOrdersLoading
                  ? <span className="animate-spin inline-block w-3 h-3 border border-gray-400 border-t-transparent rounded-full" />
                  : <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>}
                Debug
              </button>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50/80 border-b border-border/50">
                    <th className="text-left px-4 py-2 font-semibold">Ticker</th>
                    <th className="text-right px-3 py-2 font-semibold text-[#C9A84C]" title="ציון זיו בזמן הקניה">ציון קניה</th>
                    <th className="text-right px-4 py-2 font-semibold text-[#C9A84C]">Value</th>
                    <th className="text-right px-4 py-2 font-semibold">Current</th>
                    <th className="text-right px-4 py-2 font-semibold text-[#FF6B6B]">Stop Loss</th>
                    <th className="text-center px-2 py-2 font-semibold text-[#FF6B6B]" title="IBKR SL order active">SL Order</th>
                    <th className="text-right px-4 py-2 font-semibold text-[#FF6B6B]">SL Distance</th>
                    <th className="text-right px-4 py-2 font-semibold text-[#65A30D]">Take Profit</th>
                    <th className="text-center px-2 py-2 font-semibold text-[#65A30D]" title="IBKR TP order active">TP Order</th>
                    <th className="text-right px-4 py-2 font-semibold text-[#65A30D]">TP Distance</th>
                    <th className="text-left px-4 py-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {slTpHoldings.map(h => {
                    const cmp = h.currentPrice ?? h.buyPrice;
                    const isShort = h.units < 0;
                    const sl = h.stopLoss != null ? parseFloat(String(h.stopLoss)) : null;
                    const tp = h.takeProfit != null ? parseFloat(String(h.takeProfit)) : null;
                    // Direction-aware: dist positive = safe side / not yet reached
                    const slDist = sl && cmp > 0 ? ((isShort ? sl - cmp : cmp - sl) / cmp) * 100 : null;
                    const tpDist = tp && cmp > 0 ? ((isShort ? cmp - tp : tp - cmp) / cmp) * 100 : null;
                    const isBelowSL = sl != null && (isShort ? cmp >= sl : cmp <= sl);
                    const isAboveTP = tp != null && (isShort ? cmp <= tp : cmp >= tp);
                    const isNearSL = sl != null && slDist != null && slDist < 3 && !isBelowSL;
                    const isNearTP = tp != null && tpDist != null && tpDist < 3 && !isAboveTP;
                    let statusBadge;
                    if (isBelowSL) statusBadge = <Badge className="bg-[#FF6B6B] text-white text-xs">🚨 {isShort ? "ABOVE SL" : "BELOW SL"}</Badge>;
                    else if (isAboveTP) statusBadge = <Badge className="bg-[#65A30D] text-white text-xs">🎯 HIT TP</Badge>;
                    else if (isNearSL) statusBadge = <Badge className="bg-orange-500 text-white text-xs">⚠ NEAR SL</Badge>;
                    else if (isNearTP) statusBadge = <Badge className="bg-[#2563EB] text-white text-xs">📈 NEAR TP</Badge>;
                    else statusBadge = <Badge variant="outline" className="text-xs text-muted-foreground">Active</Badge>;
                    return (
                      <tr key={h.id} className={`border-b last:border-0 ${isBelowSL ? "bg-red-50" : isAboveTP ? "bg-emerald-50" : isNearSL ? "bg-orange-50" : "hover:bg-muted/10"}`}>
                        <td className="px-4 py-2.5 font-mono font-bold">
                          <div className="flex items-center gap-1.5">
                            <button
                              className="font-mono font-bold text-[#C9A84C] hover:text-blue-800 hover:underline cursor-pointer transition-colors"
              onClick={() => navigate(`/deep-analysis/${encodeURIComponent(h.ticker)}`)}
              title={`Deep Analysis: ${h.ticker}`}
                            >
                              {h.ticker}
                            </button>
                            {h.units < 0 ? (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-600 text-white leading-none">▼ SHORT</span>
                            ) : (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-600 text-white leading-none">▲ LONG</span>
                            )}
                            {h.ticker.toUpperCase().endsWith(".TA") && (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide bg-blue-100 text-blue-700 border border-blue-200 leading-none" title="Tel Aviv Stock Exchange">
                                TASE
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono">
                          {h.buyScore != null
                            ? <span className={`font-semibold ${h.buyScore >= 7 ? "text-[#65A30D]" : h.buyScore >= 5 ? "text-amber-600" : "text-[#FF6B6B]"}`}>{h.buyScore.toFixed(1)}</span>
                            : <span className="text-muted-foreground/40">—</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-blue-700 font-semibold">
                          ${(cmp * h.units).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono">${cmp.toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-right font-mono">
                          {sl != null
                            ? <span className={`font-semibold ${isBelowSL ? "text-[#FF6B6B]" : "text-[#FF6B6B]"}`}>${sl.toFixed(2)}</span>
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          {h.ibkrSlOrderId ? (
                            <span className="inline-flex items-center gap-1">
                              <span title={`IBKR SL Order #${h.ibkrSlOrderId}`} className="text-amber-500 font-bold text-sm cursor-help">✓</span>
                              <button
                                title="Cancel SL order on IBKR"
                                className="text-[#FF6B6B] hover:text-[#FF6B6B] transition-colors disabled:opacity-40"
                                disabled={cancelOrderMut.isPending}
                                onClick={() => {
                                  if (confirm(`Cancel SL order #${h.ibkrSlOrderId} for ${h.ticker}?`)) {
                                    cancelOrderMut.mutate({ orderId: h.ibkrSlOrderId!, holdingId: h.id, field: "sl" });
                                  }
                                }}
                              >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                            </span>
                          ) : <span className="text-muted-foreground/30 text-sm">—</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono">
                          {slDist != null
                            ? <span className={`font-semibold ${isBelowSL ? "text-[#FF6B6B]" : isNearSL ? "text-orange-500" : "text-muted-foreground"}`}>{slDist.toFixed(1)}%</span>
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono">
                          {tp != null
                            ? <span className={`font-semibold ${isAboveTP ? "text-[#65A30D]" : "text-[#65A30D]"}`}>${tp.toFixed(2)}</span>
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          {h.ibkrTpOrderId ? (
                            <span className="inline-flex items-center gap-1">
                              <span title={`IBKR TP Order #${h.ibkrTpOrderId}`} className="text-amber-500 font-bold text-sm cursor-help">✓</span>
                              <button
                                title="Cancel TP order on IBKR"
                                className="text-[#FF6B6B] hover:text-[#FF6B6B] transition-colors disabled:opacity-40"
                                disabled={cancelOrderMut.isPending}
                                onClick={() => {
                                  if (confirm(`Cancel TP order #${h.ibkrTpOrderId} for ${h.ticker}?`)) {
                                    cancelOrderMut.mutate({ orderId: h.ibkrTpOrderId!, holdingId: h.id, field: "tp" });
                                  }
                                }}
                              >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                            </span>
                          ) : <span className="text-muted-foreground/30 text-sm">—</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono">
                          {tpDist != null
                            ? <span className={`font-semibold ${isAboveTP ? "text-[#65A30D]" : isNearTP ? "text-[#C9A84C]" : "text-muted-foreground"}`}>+{tpDist.toFixed(1)}%</span>
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-2.5">{statusBadge}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Debug orders modal */}
      {showDebugOrders && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40" onClick={() => setShowDebugOrders(false)}>
          <div className="bg-background rounded-xl shadow-2xl p-6 max-w-2xl w-full max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-sm">Debug: Raw IBIND /orders Response</h3>
              <button onClick={() => setShowDebugOrders(false)} className="text-muted-foreground hover:text-foreground">✕</button>
            </div>
            <pre className="text-xs bg-muted rounded p-3 overflow-auto max-h-96">
              {debugOrdersLoading ? "Loading..." : JSON.stringify(debugOrdersData, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {/* SL/TP Deep Analysis Modal */}

    </>
  );
}
