/**
 * PortfolioDetail — IBKR-style holdings table for a single portfolio group
 *
 * Routes:
 *   /portfolio/h1        → Holding 1 (IBKR)
 *   /portfolio/h2-tase   → H2 TASE (.TA tickers)
 *   /portfolio/h2-usa    → H2 USA (non-crypto, non-TASE)
 *   /portfolio/h2-crypto → H2 Crypto (-USD tickers)
 *
 * Columns: Ticker | Value/Cost | Today | Total
 * Footer: Unrealized total + All-Time P&L + Currency badge
 */
import { trpc } from "@/lib/trpc";
import { PortfolioPerformanceChart } from "@/components/PortfolioPerformanceChart";
import { DailyPositionChangesSection } from "@/components/DailyPositionChanges";
import { TickerLink } from "@/components/TickerLink";
import { usePortfolioMetrics, computeTodayPnl, type H2Holding, type LivePriceEntry } from "@/hooks/usePortfolioMetrics";
import { useLivePrices } from "@/pages/TradeManager/hooks/useLivePrices";
import { useIbkrMarketData } from "@/hooks/useIbkrMarketData";
import { useIbkrSync } from "@/pages/TradeManager/hooks/useIbkrSync";
import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, RefreshCw, Wifi, WifiOff, Clock, ChevronUp, ChevronDown, ChevronsUpDown, Activity } from "lucide-react";
import { LastUpdateRefreshButton } from "@/components/LastUpdateRefreshButton";
import { useFullPortfolioRefresh } from "@/hooks/useFullPortfolioRefresh";
import { cn } from "@/lib/utils";
import { useLocation } from "wouter";
import { isTaseClosedToday, isUsMarketClosedNow, isUsWeekendOrHoliday } from "@/lib/marketStatus";
import {
  positionCost,
  positionTodayPct,
  positionTotalPnl,
  positionTotalPct,
  positionValue,
  isPositionOpenedToday,
} from "@/lib/positionMath";
import {
  ShortLiabilityHint,
  ShortLiabilitySummary,
  aggregateShortLiability,
} from "@/components/ShortLiabilityHint";

// ── Helpers ────────────────────────────────────────────────────────────────────
function isTase(ticker: string) { return ticker.toUpperCase().endsWith(".TA"); }
function isCrypto(ticker: string) { return ticker.toUpperCase().endsWith("-USD"); }

function fmtUsd(v: number | null | undefined): string {
  if (v == null) return "—";
  const abs = Math.abs(v);
  const formatted = abs.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return v < 0 ? `-$${formatted}` : `$${formatted}`;
}

function fmtPrice(v: number | null | undefined): string {
  if (v == null) return "—";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function fmtDollarChange(v: number | null | undefined): string {
  if (v == null) return "0";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${Math.round(v).toLocaleString("en-US")}`;
}

// ── Row data ──────────────────────────────────────────────────────────────────
interface HoldingDetailRow {
  id: number;          // DB row id — unique even for same-ticker positions
  ticker: string;
  units: number;
  price: number;
  value: number;
  cost: number;
  todayDollar: number | null;
  todayPct: number | null;
  totalDollar: number;
  totalPct: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

// ── Portfolio type config ─────────────────────────────────────────────────────
type PortfolioType = "h1" | "h2-tase" | "h2-usa" | "h2-crypto";

const PORTFOLIO_LABELS: Record<PortfolioType, string> = {
  "h1":        "Holding 1",
  "h2-tase":   "H2 TASE",
  "h2-usa":    "H2 USA",
  "h2-crypto": "H2 Crypto",
};

const PORTFOLIO_ORDER: PortfolioType[] = ["h1", "h2-tase", "h2-usa", "h2-crypto"];

// ── Main component ─────────────────────────────────────────────────────────────
interface PortfolioDetailProps {
  type: PortfolioType;
}

export default function PortfolioDetail({ type }: PortfolioDetailProps) {
  const [, navigate] = useLocation();
  const { refreshAll, refreshing, lastUpdated, setLastUpdated } = useFullPortfolioRefresh();
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  // ── Swipe navigation ─────────────────────────────────────────────────────────
  const currentIdx = PORTFOLIO_ORDER.indexOf(type);
  const prevType = currentIdx > 0 ? PORTFOLIO_ORDER[currentIdx - 1] : null;
  const nextType = currentIdx < PORTFOLIO_ORDER.length - 1 ? PORTFOLIO_ORDER[currentIdx + 1] : null;

  const touchStartX = useRef<number | null>(null);
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  }, []);
  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (touchStartX.current == null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < 60) return; // ignore small swipes
    if (dx < 0 && nextType) navigate(`/portfolio/${nextType}`);
    if (dx > 0 && prevType) navigate(`/portfolio/${prevType}`);
  }, [nextType, prevType, navigate]);

  // ── Pull-to-refresh ───────────────────────────────────────────────────────────
  const [pullY, setPullY] = useState(0);
  const [isPulling, setIsPulling] = useState(false);
  const pullStartY = useRef<number | null>(null);
  const PULL_THRESHOLD = 72;

  const handlePullStart = useCallback((e: React.TouchEvent) => {
    if (window.scrollY === 0) pullStartY.current = e.touches[0].clientY;
  }, []);
  const handlePullMove = useCallback((e: React.TouchEvent) => {
    if (pullStartY.current == null) return;
    const dy = e.touches[0].clientY - pullStartY.current;
    if (dy > 0) { setPullY(Math.min(dy, PULL_THRESHOLD + 20)); setIsPulling(true); }
  }, []);
  const handlePullEnd = useCallback(async () => {
    if (!isPulling) return;
    if (pullY >= PULL_THRESHOLD) { await handleRefresh(); }
    setPullY(0); setIsPulling(false); pullStartY.current = null;
  }, [isPulling, pullY]);


  // ── Data fetching ────────────────────────────────────────────────────────────
  const { data: stateData, refetch: refetchH1 } = trpc.portfolio.getState.useQuery(undefined, { staleTime: 60_000 });
  const { data: h2Raw, refetch: refetchH2 } = trpc.holding2.list.useQuery(undefined, { staleTime: 60_000 });
  const holdingsRaw = stateData?.holdings;
  const account = stateData?.account;

  const h1Holdings = useMemo(() =>
    (holdingsRaw ?? []).filter((h: { units: number }) => h.units !== 0).map((h: {
      id?: number;
      ticker: string;
      units: number;
      buyPrice: number;
      currentPrice?: number | null;
      dailyChangePercent?: number | null;
      priceUpdatedAt?: string | Date | null;
      ibkrUnrealizedPnl?: number | null;
      dailyBasePrice?: number | null;
      dailyBaseTs?: number | null;
      transactionDate?: Date | string | null;
      createdAt?: Date | string | null;
      stopLoss?: number | null;
      takeProfit?: number | null;
    }) => ({
      id: h.id ?? 0,
      ticker: h.ticker,
      units: h.units,
      buyPrice: h.buyPrice,
      currentPrice: h.currentPrice ?? null,
      dailyChangePercent: h.dailyChangePercent ?? null,
      priceUpdatedAt: h.priceUpdatedAt ?? null,
      ibkrUnrealizedPnl: h.ibkrUnrealizedPnl ?? null,
      dailyBasePrice: h.dailyBasePrice ?? null,
      dailyBaseTs: h.dailyBaseTs ?? null,
      transactionDate: h.transactionDate ?? null,
      createdAt: h.createdAt ?? null,
      stopLoss: h.stopLoss ?? null,
      takeProfit: h.takeProfit ?? null,
    })), [holdingsRaw]);

  const h2Holdings: H2Holding[] = useMemo(() =>
    (h2Raw ?? []).filter((h: { units: number }) => h.units !== 0).map((h: {
      id?: number;
      ticker: string;
      units: number;
      buyPrice: number;
      currentPrice?: number | null;
      prevClose?: number | null;
      dailyChangePercent?: number | null;
      priceUpdatedAt?: string | Date | null;
      dailyBasePrice?: number | null;
      dailyBaseTs?: number | null;
      createdAt?: string | Date | null;
    }) => ({
      id: h.id ?? 0,
      ticker: h.ticker,
      units: h.units,
      buyPrice: h.buyPrice,
      currentPrice: h.currentPrice ?? null,
      prevClose: h.prevClose ?? null,
      dailyChangePercent: h.dailyChangePercent ?? null,
      priceUpdatedAt: h.priceUpdatedAt ?? null,
      dailyBasePrice: h.dailyBasePrice ?? null,
      dailyBaseTs: h.dailyBaseTs ?? null,
      createdAt: h.createdAt ?? null,
    })), [h2Raw]);

  // IBKR sync
  const { ibkrSummaryData, ibkrPnlData, ibkrStatus } = useIbkrSync(true, false);
  // isLive for price fetching: ibkrStatus === "connected" is sufficient.
  // Previously required ibkrSummaryData?.summary != null which caused a race condition
  // during premarket: IBKR session active but summary not yet fetched → isLive=false
  // → both SSE (suppressed by ibkrStatus=connected) and useIbkrMarketData (disabled by isLive=false) blocked.
  const isLive = ibkrStatus === "connected";

  const ibkrMarketData = useIbkrMarketData({
    h1Tickers: h1Holdings.map(h => h.ticker),
    h2Tickers: h2Holdings.map(h => h.ticker),
    catalogueTickers: [],
    ibkrConnected: isLive,
  });

  const h1LivePricesResult = useLivePrices(
    h1Holdings.map(h => ({ ticker: h.ticker })),
    ibkrStatus,
    { ibkrQuotesActive: ibkrMarketData.hasLiveQuotes },
  );
  const h2LivePricesResult = useLivePrices(
    h2Holdings.map(h => ({ ticker: h.ticker })),
    ibkrStatus,
    { ibkrQuotesActive: ibkrMarketData.hasLiveQuotes },
  );

  const h1LivePriceMapRaw = h1LivePricesResult.holdingLivePriceMap;
  const h2LivePriceMapRaw = h2LivePricesResult.holdingLivePriceMap;

  // Merged H1 live price map
  const h1LivePriceMap = useMemo((): Record<string, LivePriceEntry> => {
    const merged: Record<string, LivePriceEntry> = { ...h1LivePriceMapRaw };
    for (const [ticker, data] of Object.entries(ibkrMarketData.h1PriceMap)) {
      if (data?.price != null) merged[ticker] = { ...merged[ticker], ...data };
    }
    return merged;
  }, [h1LivePriceMapRaw, ibkrMarketData.h1PriceMap]);

  // Merged H2 live price map (seed from DB, override with live)
  // Always seed prevClose/changePercent from DB — these are valid (yesterday's close) and needed
  // for Today% computation even before IBKR quotes arrive. Only gate the current price.
  const ibkrH2QuotesArrived = Object.keys(ibkrMarketData.h2PriceMap).length > 0;
  const h2LivePriceMap = useMemo((): Record<string, LivePriceEntry> => {
    const merged: Record<string, LivePriceEntry> = {};
    for (const h of h2Holdings) {
      // Only gate the current price — prevClose and changePercent are always valid from DB
      const useDbPrice = !isLive || ibkrH2QuotesArrived;
      const seedPrice = useDbPrice ? h.currentPrice : h.buyPrice;
      merged[h.ticker] = {
        price: seedPrice,
        prevClose: h.prevClose ?? null,
        changePercent: h.dailyChangePercent ?? null,
        change: h.prevClose != null && h.currentPrice != null
          ? h.currentPrice - h.prevClose
          : null,
      };
    }
    for (const [ticker, data] of Object.entries(h2LivePriceMapRaw)) {
      if (data?.price != null) merged[ticker] = { ...merged[ticker], ...data };
    }
    for (const [ticker, data] of Object.entries(ibkrMarketData.h2PriceMap)) {
      if (data?.price != null) merged[ticker] = { ...merged[ticker], ...data };
    }
    return merged;
  }, [h2Holdings, h2LivePriceMapRaw, ibkrMarketData.h2PriceMap, isLive, ibkrH2QuotesArrived]);

  // ── Persist IBKR H2 prices to DB so next page load shows fresh values ──────
  const h2PersistMut = trpc.holding2.updateCurrentPrices.useMutation();
  const h2PersistRef = useRef<string>("");
  useEffect(() => {
    if (!isLive || !ibkrH2QuotesArrived) return;
    const entries = Object.entries(ibkrMarketData.h2PriceMap);
    if (entries.length === 0) return;
    const fp = entries.map(([s, q]) => `${s}:${q?.price}`).join(',');
    if (fp === h2PersistRef.current) return;
    h2PersistRef.current = fp;
    const prices = entries
      .filter(([, q]) => q?.price != null && q.price > 0)
      .map(([sym, q]) => ({
        ticker: sym,
        price: q!.price as number,
        prevClose: q!.prevClose as number | null,
        changePercent: q!.changePercent as number | null,
      }));
    if (prices.length > 0) h2PersistMut.mutate({ prices });
  }, [isLive, ibkrH2QuotesArrived, ibkrMarketData.h2PriceMap]);

  // ── Persist IBKR H1 prices to DB so pre-market shows last session's Today% ──
  const h1PersistMut = trpc.portfolio.updateH1Prices.useMutation();
  const h1PersistRef = useRef<string>("");
  const h1PersistTsRef = useRef<number>(0);
  useEffect(() => {
    if (!isLive) return;
    const entries = Object.entries(ibkrMarketData.h1PriceMap);
    if (entries.length === 0) return;
    // Only persist when at least one ticker has non-zero changePercent
    const hasNonZero = entries.some(([, q]) => q?.changePercent != null && q.changePercent !== 0);
    if (!hasNonZero) return;
    // Fingerprint dedup
    const fp = entries.map(([s, q]) => `${s}:${q?.price}:${q?.changePercent}`).join(',');
    if (fp === h1PersistRef.current) return;
    // Throttle: max once per 5 minutes
    const now = Date.now();
    if (now - h1PersistTsRef.current < 5 * 60 * 1000) return;
    h1PersistRef.current = fp;
    h1PersistTsRef.current = now;
    const prices = entries
      .filter(([, q]) => q?.price != null && q.price > 0 && q?.changePercent != null && q.changePercent !== 0)
      .map(([sym, q]) => ({
        ticker: sym,
        price: q!.price as number,
        changePercent: q!.changePercent as number | null,
      }));
    if (prices.length > 0) h1PersistMut.mutate({ prices });
  }, [isLive, ibkrMarketData.h1PriceMap]);

  const cashBalance = ibkrSummaryData?.summary?.totalCash ?? (account?.lastKnownCash ?? account?.cashBalance ?? 0);
  const metrics = usePortfolioMetrics({
    h1Holdings, h2Holdings, h1LivePriceMap, h2LivePriceMap,
    ibkr: {
      grossPositionValue: ibkrSummaryData?.summary?.grossPositionValue ?? null,
      netLiquidation: ibkrSummaryData?.summary?.netLiquidation ?? null,
      dailyPnl: ibkrPnlData?.dailyPnl ?? (ibkrSummaryData?.summary as any)?.dailyPnl ?? null,
      totalCash: cashBalance,
      isLive,
    },
    cashBalance,
  });

  // ── Filter holdings for this portfolio type ──────────────────────────────────
  const { activeHoldings, liveMap, isH1 } = useMemo(() => {
    if (type === "h1") {
      return { activeHoldings: h1Holdings, liveMap: h1LivePriceMap, isH1: true };
    }
    const filtered = h2Holdings.filter(h => {
      if (type === "h2-tase") return isTase(h.ticker);
      if (type === "h2-crypto") return isCrypto(h.ticker);
      if (type === "h2-usa") return !isTase(h.ticker) && !isCrypto(h.ticker);
      return false;
    });
    return { activeHoldings: filtered, liveMap: h2LivePriceMap, isH1: false };
  }, [type, h1Holdings, h2Holdings, h1LivePriceMap, h2LivePriceMap]);

  // ── Build per-holding rows ───────────────────────────────────────────────────
  const rows: HoldingDetailRow[] = useMemo(() => {
    const usClosedNow = isUsMarketClosedNow();
    return activeHoldings.map(h => {
      const live = liveMap[h.ticker];
      const price = live?.price ?? h.currentPrice ?? h.buyPrice;
      const value = positionValue(price, h.units);
      const cost  = positionCost(h.buyPrice, h.units);
      const ibkrPnlDirect = (h as { ibkrUnrealizedPnl?: number | null }).ibkrUnrealizedPnl ?? null;
      const totalDollar = ibkrPnlDirect != null ? ibkrPnlDirect : positionTotalPnl(price, h.buyPrice, h.units);
      const totalPct = cost !== 0 ? (totalDollar / Math.abs(cost)) * 100 : positionTotalPct(price, h.buyPrice, h.units);

      const isTaTicker = isTase(h.ticker);
      const isCryptoTicker = isCrypto(h.ticker);
      const hasLiveData = (live?.change != null && live.change !== 0)
        || (live?.changePercent != null && live.changePercent !== 0)
        || (live?.price != null && live.prevClose != null && live.prevClose > 0 && live.price !== live.prevClose);

      let todayDollar: number | null = null;
      let todayPct: number | null = null;

      if (isTaTicker && isTaseClosedToday()) {
        todayDollar = 0;
        todayPct = 0;
      } else if (!isTaTicker && !isCryptoTicker && usClosedNow && !hasLiveData) {
        todayDollar = 0;
        todayPct = 0;
      } else {
        const holding = h as {
          transactionDate?: string | Date | null;
          createdAt?: string | Date | null;
          priceUpdatedAt?: string | Date | null;
          dailyBasePrice?: number | null;
          dailyBaseTs?: number | null;
          ibkrUnrealizedPnl?: number | null;
        };
        todayDollar = computeTodayPnl(
          h.units,
          h.buyPrice,
          h.currentPrice ?? null,
          live,
          h.dailyChangePercent,
          holding.priceUpdatedAt,
          holding.dailyBasePrice,
          holding.dailyBaseTs,
          holding.ibkrUnrealizedPnl,
          holding.transactionDate,
          holding.createdAt,
        );

        const openedToday = isPositionOpenedToday(holding.transactionDate, holding.createdAt);
        const prevForPct = openedToday
          ? h.buyPrice
          : live?.prevClose
            ?? (live?.changePercent != null && live.changePercent !== 0 && price > 0
              ? price / (1 + live.changePercent / 100)
              : null)
            ?? (holding.dailyBasePrice != null && holding.dailyBasePrice > 0
              ? holding.dailyBasePrice
              : null)
            ?? (h.dailyChangePercent != null && price > 0
              ? price / (1 + h.dailyChangePercent / 100)
              : null);

        if (prevForPct != null && prevForPct > 0) {
          todayPct = positionTodayPct(todayDollar, prevForPct, h.units);
        }
      }

      return {
        id: (h as { id?: number }).id ?? 0,
        ticker: h.ticker,
        units: h.units,
        price,
        value,
        cost,
        todayDollar,
        todayPct,
        totalDollar,
        totalPct,
        stopLoss: (h as { stopLoss?: number | null }).stopLoss ?? null,
        takeProfit: (h as { takeProfit?: number | null }).takeProfit ?? null,
      };
    }).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  }, [activeHoldings, liveMap]);

  // ── Per-ticker Today: each row shows raw change × units (no proportional scaling) ──────
  // todayPct = stock's daily change percent (matches IBKR CHG% column exactly).
  // todayDollar = raw change × units per row (true per-position daily P&L).
  // Previously this was scaled to match IBKR dailyPnl, but that inflated individual rows
  // because IBKR dailyPnl includes realized P&L from closed positions.
  const scaledRows = rows;

  // ── Footer totals ──────────────────────────────────────────────────
  const footer = useMemo(() => {
    const totalValue = scaledRows.reduce((s, r) => s + r.value, 0);
    const totalCost  = scaledRows.reduce((s, r) => s + r.cost, 0);
    const totalPnl   = scaledRows.reduce((s, r) => s + r.totalDollar, 0);
    const totalPct   = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

    const sumToday = scaledRows.reduce((s, r) => s + (r.todayDollar ?? 0), 0);
    const hasToday = scaledRows.some(r => r.todayDollar != null);

    // H1: row sum via computeTodayPnl (matches usePortfolioMetrics); fallback to hook aggregate
    let totalToday: number | null = null;
    let todayPct: number | null = null;
    if (hasToday || (isH1 && metrics.h1TodayPnl != null)) {
      totalToday = isH1
        ? (hasToday ? sumToday : metrics.h1TodayPnl)
        : sumToday;
      todayPct = isH1 && metrics.h1TodayPct != null && !hasToday
        ? metrics.h1TodayPct
        : (() => {
            const prevEquity = totalValue - (totalToday ?? 0);
            return totalToday != null && Math.abs(prevEquity) > 0
              ? (totalToday / Math.abs(prevEquity)) * 100
              : null;
          })();
    }

    const shortLiability = aggregateShortLiability(scaledRows);
    return { totalValue, totalCost, totalToday, todayPct, totalPnl, totalPct, shortLiability };
  }, [scaledRows, isH1, metrics.h1TodayPnl, metrics.h1TodayPct]);

  // ── Refresh mutations ────────────────────────────────────────────────────────
  const refreshH1Prices = trpc.portfolio.refreshPrices.useMutation({
    onSuccess: (data) => {
      toast.success(`H1: עודכנו ${data.updated} מחירים`);
      refetchH1();
    },
    onError: (e) => {
      const msg = e.message.includes("Rate") || e.message.includes("Unexpected token")
        ? "Yahoo Finance: חריגת קצב — נסה שוב בעוד 30 שניות"
        : `שגיאה: ${e.message}`;
      toast.error(msg);
    },
  });
  const refreshH2Prices = trpc.holding2.refreshPrices.useMutation({
    onSuccess: (data) => {
      toast.success(`H2: עודכנו ${data.updated.length} מחירים`);
      refetchH2();
    },    onError: (e) => {
      const msg = e.message.includes("Rate") || e.message.includes("Unexpected token")
        ? "Yahoo Finance: חריגת קצב — נסה שוב בעוד 30 שניות"
        : `שגיאה: ${e.message}`;
      toast.error(msg);
    },
  });

   // ── Refresh ───────────────────────────────────────────────────────────────────
  async function handleRefresh() {
    await refreshAll({
      ibkrRefetch: () => ibkrMarketData.refetch(),
      h1LiveRefetch: () => h1LivePricesResult.refetchLivePrices(),
      h2LiveRefetch: () => h2LivePricesResult.refetchLivePrices(),
      extra: [() => refetchH1(), () => refetchH2()],
    });
    setLastRefreshed(new Date());
  }

  // ── Price sync progress tracking ───────────────────────────────────────────────────
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [lastSyncDisplay, setLastSyncDisplay] = useState<string>("");

  const allTickers = useMemo(() => activeHoldings.map(h => h.ticker), [activeHoldings]);
  const loadedCount = useMemo(() => {
    let count = 0;
    for (const h of activeHoldings) {
      if (liveMap[h.ticker]?.price != null || h.currentPrice != null) count++;
    }
    return count;
  }, [activeHoldings, liveMap]);
  const syncProgress = allTickers.length > 0 ? Math.round((loadedCount / allTickers.length) * 100) : 0;
  const isSyncing = loadedCount < allTickers.length && allTickers.length > 0;

  useEffect(() => {
    if (!isSyncing && loadedCount > 0) {
      const d = new Date();
      setLastSyncTime(d);
      setLastUpdated(d);
    }
  }, [isSyncing, loadedCount, setLastUpdated]);

  useEffect(() => {
    if (ibkrMarketData.lastUpdated > 0) {
      const d = new Date(ibkrMarketData.lastUpdated);
      setLastSyncTime(d);
      setLastUpdated(d);
    }
  }, [ibkrMarketData.lastUpdated, setLastUpdated]);

  useEffect(() => {
    function updateDisplay() {
      if (!lastSyncTime) { setLastSyncDisplay(""); return; }
      const diffMin = Math.floor((Date.now() - lastSyncTime.getTime()) / 60_000);
      if (diffMin < 1) setLastSyncDisplay("עכשיו");
      else if (diffMin === 1) setLastSyncDisplay("לפני דקה");
      else if (diffMin < 60) setLastSyncDisplay(`לפני ${diffMin} דק'`);
      else setLastSyncDisplay(lastSyncTime.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }));
    }
    updateDisplay();
    const interval = setInterval(updateDisplay, 30_000);
    return () => clearInterval(interval);
  }, [lastSyncTime]);

  // ── Auto-refresh H2 prevClose on mount (throttled: once per 10 min) ──────────────
  const autoRefreshDoneRef = useRef(false);
  useEffect(() => {
    if (type === "h1") return; // H1 gets prices from IBKR SSE stream — no need
    if (autoRefreshDoneRef.current) return;
    autoRefreshDoneRef.current = true;
    // Throttle: skip if h2Raw was fetched recently (staleTime=60s covers this)
    // but prevClose in DB may be from yesterday — always refresh once on mount
    const timer = setTimeout(() => {
      refreshH2Prices.mutate(undefined, {
        onSuccess: (data) => { if (data.updated.length > 0) refetchH2(); },
        onError: () => {}, // silent — user can always press refresh manually
      });
    }, 1500); // small delay to let the page render first
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  // ── ILS rate ───────────────────────────────────────────────────────────────────
  const { data: forexData } = trpc.forex.getRate.useQuery(undefined, {
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const ilsRate = forexData?.usdIls ?? 3.65;

  // ── Sort state ───────────────────────────────────────────────────────────────────
  type SortCol = "ticker" | "value" | "today" | "total" | "sl" | "tp";
  type SortDir = "asc" | "desc";
  const [sortCol, setSortCol] = useState<SortCol>("value");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function handleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir(d => d === "desc" ? "asc" : "desc");
    } else {
      setSortCol(col);
      setSortDir(col === "ticker" ? "asc" : "desc");
    }
  }

  const sortedRows = useMemo(() => {
    return [...scaledRows].sort((a, b) => {
      let cmp = 0;
      if (sortCol === "ticker") cmp = a.ticker.localeCompare(b.ticker);
      else if (sortCol === "value") cmp = a.value - b.value;
      else if (sortCol === "today") cmp = (a.todayPct ?? -Infinity) - (b.todayPct ?? -Infinity);
      else if (sortCol === "total") cmp = a.totalPct - b.totalPct;
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [scaledRows, sortCol, sortDir]);

  const label = PORTFOLIO_LABELS[type] ?? "Portfolio";
  const isLoading = !stateData && !h2Raw;

  return (
    <div
      className="min-h-screen bg-[#F4F6F8] text-gray-800"
      dir="ltr"
      onTouchStart={(e) => { handleTouchStart(e); handlePullStart(e); }}
      onTouchMove={handlePullMove}
      onTouchEnd={(e) => { handleTouchEnd(e); handlePullEnd(); }}
    >
      {/* Pull-to-refresh indicator */}
      {isPulling && (
        <div
          className="fixed top-0 left-0 right-0 z-[200] flex items-center justify-center bg-[#2563EB]/10 transition-all"
          style={{ height: `${Math.min(pullY, PULL_THRESHOLD + 20)}px` }}
        >
          <RefreshCw
            className={cn("w-5 h-5 text-[#2563EB]", pullY >= PULL_THRESHOLD && "animate-spin")}
            style={{ opacity: Math.min(pullY / PULL_THRESHOLD, 1) }}
          />
        </div>
      )}
      {/* ── Header ── */}
      <div className="sticky top-16 z-[100] bg-white border-b border-[#2563EB]/30 shadow-lg">
      <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/overview")}
            className="p-1.5 rounded-full hover:bg-[#2563EB]/20 transition-colors text-[#2563EB]"
            aria-label="Back to Overview"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex flex-col">
            <span className="text-[10px] font-semibold text-[#2563EB] tracking-widest uppercase">TradeSnow</span>
            <span className="font-bold text-lg tracking-tight text-gray-800">{label}</span>
          </div>
          {isLive ? (
            <div className="flex flex-col gap-0.5 ml-1">
              <span className="flex items-center gap-1 text-xs text-[#65A30D]">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#65A30D] opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-[#65A30D]" />
                </span>
                Live
                {lastSyncDisplay && (
                  <span className="flex items-center gap-0.5 text-[10px] text-gray-800/40 ml-1">
                    <Clock className="w-2.5 h-2.5" />
                    {lastSyncDisplay}
                  </span>
                )}
              </span>
              {isSyncing && (
                <div className="flex items-center gap-1.5">
                  <div className="relative h-1 w-16 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="absolute left-0 top-0 h-full rounded-full transition-all duration-300"
                      style={{ width: `${syncProgress}%`, background: `linear-gradient(90deg, #2563EB, #65A30D)` }}
                    />
                  </div>
                  <span className="text-[10px] text-gray-800/40">{loadedCount}/{allTickers.length}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5 ml-1">
              <span className="flex items-center gap-1 text-xs text-gray-800/40"><WifiOff className="w-3 h-3" /> Offline</span>
              {isSyncing && (
                <div className="flex items-center gap-1.5">
                  <div className="relative h-1 w-16 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="absolute left-0 top-0 h-full rounded-full transition-all duration-300"
                      style={{ width: `${syncProgress}%`, background: `linear-gradient(90deg, #2563EB, #65A30D)` }}
                    />
                  </div>
                  <span className="text-[10px] text-gray-800/40">{loadedCount}/{allTickers.length}</span>
                </div>
              )}
              {!isSyncing && lastSyncDisplay && (
                <span className="flex items-center gap-0.5 text-[10px] text-gray-800/30">
                  <Clock className="w-2.5 h-2.5" />
                  {lastSyncDisplay}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          {prevType && (
            <button
              onClick={() => navigate(`/portfolio/${prevType}`)}
              className="p-1.5 rounded-full hover:bg-[#2563EB]/20 transition-colors text-[#2563EB]/60"
              aria-label={`Go to ${PORTFOLIO_LABELS[prevType]}`}
              title={PORTFOLIO_LABELS[prevType]}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          {nextType && (
            <button
              onClick={() => navigate(`/portfolio/${nextType}`)}
              className="p-1.5 rounded-full hover:bg-[#2563EB]/20 transition-colors text-[#2563EB]/60"
              aria-label={`Go to ${PORTFOLIO_LABELS[nextType]}`}
              title={PORTFOLIO_LABELS[nextType]}
            >
              <ArrowRight className="w-4 h-4" />
            </button>
          )}
          <LastUpdateRefreshButton
            onRefresh={handleRefresh}
            refreshing={refreshing}
            lastUpdated={lastUpdated ?? lastRefreshed ?? lastSyncTime}
          />
        </div>
      </div>
      </div>

      {/* ── Main content wrapper ── */}
      <div className="max-w-4xl mx-auto">

            {/* ── Portfolio Value Summary Card ── */}
      {!isLoading && footer.totalValue > 0 && (
        <div className="mx-2 mt-3 mb-2 rounded-xl border border-[#2563EB]/20 bg-white shadow-sm px-4 py-3">
          <div className="flex items-center justify-between">
            {/* Left: $ value */}
            <div>
              <div className="text-xs text-[#2563EB]/60 font-semibold uppercase tracking-wide">{label}</div>
              <div className="font-bold text-2xl text-gray-800 mt-0.5">{fmtUsd(footer.totalValue)}</div>
            </div>
            {/* Center: ILS */}
            {ilsRate && (
              <div className="text-center">
                <div className="font-bold text-xl text-gray-800">₪{Math.round(footer.totalValue * ilsRate).toLocaleString("he-IL")}</div>
                {(() => {
                  const headerToday = isH1
                    ? (footer.totalToday ?? metrics.h1TodayPnl)
                    : footer.totalToday;
                  return headerToday != null ? (
                    <div className={cn("text-xs font-semibold mt-0.5",
                      headerToday >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"
                    )}>
                      {headerToday >= 0 ? "+" : ""}{Math.round(headerToday * ilsRate).toLocaleString("he-IL")} היום
                    </div>
                  ) : null;
                })()}
              </div>
            )}
            {/* Right: Today — sum of per-row computeTodayPnl (H1) or row sum (H2) */}
            <div className="text-right">
              {(() => {
                const headerToday = isH1
                  ? (footer.totalToday ?? metrics.h1TodayPnl)
                  : footer.totalToday;
                const headerTodayPct = footer.todayPct ?? (isH1 ? metrics.h1TodayPct : null);
                return (
                  <div className={cn("font-bold text-xl",
                    headerToday == null ? "text-gray-800/40"
                    : headerToday >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"
                  )}>
                    {headerToday != null ? fmtPct(headerTodayPct) : "—"}
                    <span className="text-sm ml-1">{headerToday != null ? fmtDollarChange(headerToday) : ""}</span>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ── Column headers (sortable) ── */}
      <div className="grid grid-cols-[1fr_5.5rem_4.5rem_4.5rem_4.5rem_4.5rem] gap-x-1 px-3 py-1.5 border-b border-gray-200 bg-white/5">
        {(["ticker", "value", "today", "total", "sl", "tp"] as const).map((col, i) => {
          const labels: Record<string, string> = { ticker: "Ticker", value: "Value/Cost", today: "Today", total: "Total", sl: "SL", tp: "TP" };
          const active = sortCol === col;
          return (
            <button
              key={col}
              onClick={() => handleSort(col)}
              onTouchEnd={e => e.stopPropagation()}
              className={cn(
                "flex items-center gap-0.5 text-xs font-semibold transition-colors select-none min-h-[44px] px-1",
                i === 0 ? "justify-start" : "justify-end",
                active ? "text-[#2563EB]" : "text-[#2563EB]/50 hover:text-[#2563EB]/80"
              )}
              style={{ touchAction: 'manipulation' }}
            >
              {i > 0 && (
                active
                  ? sortDir === "desc" ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />
                  : <ChevronsUpDown className="w-3 h-3 opacity-40" />
              )}
              <span>{labels[col]}</span>
              {i === 0 && (
                active
                  ? sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
                  : <ChevronsUpDown className="w-3 h-3 opacity-40" />
              )}
            </button>
          );
        })}
      </div>

      {/* ── Rows ── */}
      {isLoading ? (
        // Skeleton loading
        <div className="divide-y divide-[#2563EB]/20">
          {[1,2,3,4,5].map(i => (
            <div key={i} className="grid grid-cols-[1fr_5.5rem_4.5rem_4.5rem_4.5rem_4.5rem] gap-x-1 px-3 py-3 items-start">
              <div>
                <div className="h-5 w-16 bg-white/10 rounded animate-pulse mb-1" />
                <div className="h-3.5 w-12 bg-white/5 rounded animate-pulse" />
              </div>
              <div className="flex flex-col items-end gap-1">
                <div className="h-5 w-14 bg-white/10 rounded animate-pulse" />
                <div className="h-3.5 w-10 bg-white/5 rounded animate-pulse" />
              </div>
              <div className="flex flex-col items-end gap-1">
                <div className="h-5 w-12 bg-white/10 rounded animate-pulse" />
                <div className="h-3.5 w-8 bg-white/5 rounded animate-pulse" />
              </div>
              <div className="flex flex-col items-end gap-1">
                <div className="h-5 w-12 bg-white/10 rounded animate-pulse" />
                <div className="h-3.5 w-8 bg-white/5 rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : scaledRows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-gray-800/30">
          <span className="text-4xl mb-3">📭</span>
          <span className="text-sm">No positions in this portfolio</span>
        </div>
      ) : (
        <div className="divide-y divide-[#2563EB]/20">
          {sortedRows.map(row => (
            <HoldingDetailRowItem key={row.id} row={row} />
          ))}
        </div>
      )}

      {/* ── Footer ── */}
      <div className="mt-2 mx-2 rounded-xl border border-[#2563EB]/40 bg-white shadow-md overflow-hidden">
        <div className="px-3 py-3">
          <div className="grid grid-cols-[1fr_5.5rem_4.5rem_4.5rem_4.5rem_4.5rem] gap-x-1 items-start">
            {/* Name */}
            <div>
              <div className="font-bold text-lg text-gray-800">{label}</div>
              <div className="text-sm text-[#2563EB] mt-0.5">
                {scaledRows.length} {scaledRows.length === 1 ? "position" : "positions"}
              </div>
            </div>
            {/* Value / Cost */}
            <div className="text-right">
              <div className="font-bold text-lg text-gray-800">{fmtUsd(footer.totalValue)}</div>
              <div className="text-sm text-gray-800/50">{fmtUsd(footer.totalCost)}</div>
            </div>
            {/* Today */}
            <div className="text-right">
              <div className={cn("font-semibold text-lg",
                footer.totalToday == null ? "text-gray-800/40"
                : footer.totalToday >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"
              )}>
                {footer.totalToday != null ? fmtPct(footer.todayPct) : "—"}
              </div>
              <div className={cn("text-sm",
                footer.totalToday == null ? "text-gray-800/40"
                : footer.totalToday >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"
              )}>
                {footer.totalToday != null ? fmtDollarChange(footer.totalToday) : "0"}
              </div>
            </div>
            {/* Total */}
            <div className="text-right">
              <div className={cn("font-semibold text-lg", footer.totalPnl >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]")}>
                {fmtPct(footer.totalPct)}
              </div>
              <div className={cn("text-sm", footer.totalPnl >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]")}>
                {fmtDollarChange(footer.totalPnl)}
              </div>
            </div>
          </div>

          {footer.shortLiability.count > 0 && (
            <div className="mt-2 pt-2 border-t border-rose-100 flex justify-end">
              <ShortLiabilitySummary
                count={footer.shortLiability.count}
                total={footer.shortLiability.total}
                prefix={`שורטים: ${footer.shortLiability.count} התחייבות לברוקר`}
              />
            </div>
          )}

          <div className="mt-1 flex justify-end">
            <span className="bg-[#2563EB] text-white text-xs font-bold px-2 py-0.5 rounded">USD</span>
          </div>
        </div>
      </div>

      {/* ── Daily Position Changes (H1 only) ── */}
      {type === "h1" && <DailyPositionChangesSection />}

      {/* ── Equity Curve Chart ── */}
      <div className="mx-2 mt-4">
        <PortfolioPerformanceChart
          currentEquityValue={footer.totalValue > 0 ? footer.totalValue : undefined}
          cashBalance={0}
          portfolioType={type}
        />
      </div>

      </div>{/* end max-w-4xl */}
      <div className="h-28" />
    </div>
  );
}

// ── Holding Detail Row Item ────────────────────────────────────────────────────
function HoldingDetailRowItem({ row }: { row: HoldingDetailRow }) {
  const todayPositive = row.todayDollar == null ? null : row.todayDollar >= 0;
  const totalPositive = row.totalDollar >= 0;

  return (
    <div className="grid grid-cols-[1fr_5.5rem_4.5rem_4.5rem_4.5rem_4.5rem] gap-x-1 px-3 py-3 items-start hover:bg-[#2563EB]/10 transition-colors">
      {/* Ticker + price */}
      <div>
        <div className="flex items-center gap-1.5">
          <TickerLink
            ticker={row.ticker}
            variant="plain"
            className="font-bold text-lg text-gray-800 leading-tight hover:text-[#2563EB]"
          />
          {row.units < 0 ? (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-600 text-white leading-none">▼ SHORT</span>
          ) : (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-600 text-white leading-none">▲ LONG</span>
          )}
        </div>
        <div className="text-sm text-gray-800/40 mt-0.5">{fmtPrice(row.price)}</div>
      </div>

      {/* Value / Cost */}
      <div className="text-right">
        <div className={cn("font-semibold text-lg", row.units < 0 ? "text-rose-600" : "text-gray-800")}>
          {fmtUsd(row.value)}
        </div>
        <ShortLiabilityHint
          units={row.units}
          value={row.value}
          compact
          showValueLabel={row.units < 0}
        />
        <div className="text-sm text-gray-800/40">{fmtUsd(row.cost)}</div>
      </div>

      {/* Today */}
      <div className="text-right">
        <div className={cn(
          "font-semibold text-lg",
          row.todayDollar == null ? "text-gray-800/40"
          : todayPositive ? "text-[#65A30D]" : "text-[#FF6B6B]"
        )}>
          {row.todayDollar == null ? "—" : fmtPct(row.todayPct)}
        </div>
        <div className={cn(
          "text-sm",
          row.todayDollar == null ? "text-gray-800/40"
          : todayPositive ? "text-[#65A30D]" : "text-[#FF6B6B]"
        )}>
          {row.todayDollar == null ? "0" : fmtDollarChange(row.todayDollar)}
        </div>
      </div>

      {/* Total */}
      <div className="text-right">
        <div className={cn("font-semibold text-lg", totalPositive ? "text-[#65A30D]" : "text-[#FF6B6B]")}>
          {fmtPct(row.totalPct)}
        </div>
        <div className={cn("text-sm", totalPositive ? "text-[#65A30D]" : "text-[#FF6B6B]")}>
          {fmtDollarChange(row.totalDollar)}
        </div>
      </div>
      {/* SL */}
      <div className="text-right">
        {row.stopLoss != null ? (
          <>
            <div className="text-xs font-semibold text-[#FF6B6B]">SL</div>
            <div className="text-sm text-gray-700">{fmtPrice(row.stopLoss)}</div>
          </>
        ) : <div className="text-xs text-gray-400">—</div>}
      </div>
      {/* TP */}
      <div className="text-right">
        {row.takeProfit != null ? (
          <>
            <div className="text-xs font-semibold text-[#65A30D]">TP</div>
            <div className="text-sm text-gray-700">{fmtPrice(row.takeProfit)}</div>
          </>
        ) : <div className="text-xs text-gray-400">—</div>}
      </div>
    </div>
  );
}
