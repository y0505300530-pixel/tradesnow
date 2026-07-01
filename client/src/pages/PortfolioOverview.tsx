/**
 * PortfolioOverview — Mobile-first IBKR-style portfolio overview
 *
 * Rows:
 *   1. Holding 1  (H1 — IBKR main account)
 *   2. H2 TASE    (H2 tickers ending in .TA)
 *   3. H2 USA     (H2 tickers — US stocks, not crypto)
 *   4. H2 Crypto  (H2 tickers ending in -USD)
 *   5. Cash       (IBKR total cash)
 *
 * Columns: Name + count | Value / Cost | Today $ | Total % + $
 * Footer: Unrealized total (sum of all rows)
 */
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { usePortfolioMetrics, computeTodayPnl, type H2Holding, type LivePriceEntry } from "@/hooks/usePortfolioMetrics";
import { useLivePrices } from "@/pages/TradeManager/hooks/useLivePrices";
import { useIbkrMarketData } from "@/hooks/useIbkrMarketData";
import { useIbkrSync } from "@/pages/TradeManager/hooks/useIbkrSync";
import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { RefreshCw, WifiOff, ChevronRight, PlugZap, Loader2, Clock } from "lucide-react";
import { LastUpdateRefreshButton } from "@/components/LastUpdateRefreshButton";
import { useFullPortfolioRefresh } from "@/hooks/useFullPortfolioRefresh";
import { useTradingViewerContext } from "@/hooks/useTradingViewerContext";
import { cn } from "@/lib/utils";
import { useLocation } from "wouter";
import { isTaseClosedToday, isUsMarketClosedNow, isUsWeekendOrHoliday, getUsMarketState, type UsMarketState } from "@/lib/marketStatus";
import {
  positionCost,
  positionTotalPnl,
  positionValue,
  isPositionOpenedToday,
} from "@/lib/positionMath";
import { enrichTaTodayQuote } from "../../shared/taTodayQuote";
import {
  ShortLiabilitySummary,
  aggregateShortLiability,
} from "@/components/ShortLiabilityHint";

// ── Helpers ────────────────────────────────────────────────────────────────────
function isTase(ticker: string) { return ticker.toUpperCase().endsWith(".TA"); }
function isCrypto(ticker: string) { return ticker.toUpperCase().endsWith("-USD"); }

/** Market Status Badge — shows current US market state */
function MarketStatusBadge() {
  const state = getUsMarketState();
  const config: Record<UsMarketState, { emoji: string; label: string; color: string; bg: string }> = {
    closed:      { emoji: '🔴', label: 'US Closed',      color: '#EF4444', bg: 'rgba(239,68,68,0.08)' },
    pre_market:  { emoji: '🟡', label: 'Pre-Market',     color: '#D97706', bg: 'rgba(217,119,6,0.08)' },
    open:        { emoji: '🟢', label: 'US Open',        color: '#65A30D', bg: 'rgba(101,163,13,0.08)' },
    after_hours: { emoji: '🟠', label: 'After-Hours',    color: '#EA580C', bg: 'rgba(234,88,12,0.08)' },
  };
  const { emoji, label, color, bg } = config[state];
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
      style={{ color, backgroundColor: bg }}
    >
      {emoji} {label}
    </span>
  );
}

function fmtIls(v: number | null | undefined): string {
  if (v == null) return "—";
  const abs = Math.abs(v);
  const formatted = abs.toLocaleString("he-IL", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return v < 0 ? `₪-${formatted}` : `₪${formatted}`;
}

function fmtIlsChange(v: number | null | undefined): string {
  if (v == null) return "0";
  const sign = v >= 0 ? "+" : "-";
  return `${sign}₪${Math.round(Math.abs(v)).toLocaleString("he-IL")}`;
}

function fmtUsd(v: number | null | undefined): string {
  if (v == null) return "—";
  const abs = Math.abs(v);
  const formatted = abs.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return v < 0 ? `-$${formatted}` : `$${formatted}`;
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

// ── Row data type ──────────────────────────────────────────────────────────────
interface PortfolioRow {
  id: string;
  name: string;
  count: number;
  value: number;
  cost: number;
  todayDollar: number | null;
  todayPct: number | null;
  totalDollar: number;
  totalPct: number;
  shortCount?: number;
  shortLiability?: number;
}

/** Cash always visible; holding groups hidden when they have zero positions. */
function isVisiblePortfolioRow(row: PortfolioRow): boolean {
  return row.id === "cash" || row.count > 0;
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function PortfolioOverview() {
  const { user } = useAuth();
  const { refreshAll, refreshing, lastUpdated, setLastUpdated } = useFullPortfolioRefresh();
  const {
    isScopedViewer,
    primaryAccountSlug,
    primaryAccountLabel,
  } = useTradingViewerContext();

  // ── Data fetching ────────────────────────────────────────────────────────────
  // Admin Overview = CEO portfolio only (portfolioHoldings + IBKR :5000).
  // Dror book is NEVER merged here — admin sees Dror only in War Room switcher.
  const { data: stateData, isLoading: stateLoading, refetch: refetchH1 } = trpc.portfolio.getState.useQuery(undefined, {
    staleTime: 60_000,
    enabled: !isScopedViewer,
  });
  const { data: h2Raw, isLoading: h2Loading, refetch: refetchH2 } = trpc.holding2.list.useQuery(undefined, {
    staleTime: 60_000,
    enabled: !isScopedViewer,
  });
  const { data: scopedLiveStatus, isLoading: scopedLoading, refetch: refetchScoped } =
    trpc.liveEngine.getStatus.useQuery(
      { accountSlug: primaryAccountSlug ?? "dror" },
      {
        enabled: isScopedViewer && !!primaryAccountSlug,
        refetchInterval: 15_000,
        staleTime: 0,
      },
    );
  const holdingsRaw = stateData?.holdings;
  const account = stateData?.account;
  const isInitialLoading = isScopedViewer
    ? scopedLoading && !scopedLiveStatus
    : stateLoading && !stateData;

  const isAdmin = user?.role === "admin";

  // ── Auto-connect state ───────────────────────────────────────────────────────
  // Tracks the auto-connect phase independently from useIbkrSync's ibkrStatus
  const [autoConnectPhase, setAutoConnectPhase] = useState<
    "idle" | "checking" | "connecting" | "connected" | "error"
  >("idle");
  const autoConnectRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isConnectingRef = useRef(false);
  // ── Price sync progress tracking ─────────────────────────────────────────────
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [lastSyncDisplay, setLastSyncDisplay] = useState<string>("");
  const prevPricesUpdatedAt = useRef<number>(0);

  const h1Holdings = useMemo(() => {
    type RawH1 = {
      ticker: string;
      units: number;
      buyPrice: number;
      currentPrice?: number | null;
      dailyChangePercent?: number | null;
      priceUpdatedAt?: string | Date | null;
      dailyBasePrice?: number | null;
      dailyBaseTs?: number | null;
      transactionDate?: string | Date | null;
      createdAt?: string | Date | null;
      ibkrUnrealizedPnl?: number | null;
    };
    const active = (holdingsRaw ?? []).filter((h: { units: number }) => h.units !== 0) as RawH1[];
    const map = new Map<string, {
      ticker: string;
      units: number;
      buyPrice: number;
      currentPrice: number | null;
      dailyChangePercent: number | null;
      priceUpdatedAt: string | Date | null;
      dailyBasePrice: number | null;
      dailyBaseTs: number | null;
      transactionDate: string | Date | null;
      createdAt: string | Date | null;
      ibkrUnrealizedPnl: number | null;
    }>();
    for (const h of active) {
      const existing = map.get(h.ticker);
      if (existing) {
        const totalUnits = existing.units + h.units;
        const weightedBuy = (existing.buyPrice * existing.units + h.buyPrice * h.units) / totalUnits;
        const keepTodayMeta = isPositionOpenedToday(h.transactionDate, h.createdAt)
          ? { transactionDate: h.transactionDate ?? null, createdAt: h.createdAt ?? null }
          : { transactionDate: existing.transactionDate, createdAt: existing.createdAt };
        map.set(h.ticker, {
          ...existing,
          units: totalUnits,
          buyPrice: weightedBuy,
          ...keepTodayMeta,
          ibkrUnrealizedPnl: h.ibkrUnrealizedPnl ?? existing.ibkrUnrealizedPnl,
        });
      } else {
        map.set(h.ticker, {
          ticker: h.ticker,
          units: h.units,
          buyPrice: h.buyPrice,
          currentPrice: h.currentPrice ?? null,
          dailyChangePercent: h.dailyChangePercent ?? null,
          priceUpdatedAt: h.priceUpdatedAt ?? null,
          dailyBasePrice: h.dailyBasePrice ?? null,
          dailyBaseTs: h.dailyBaseTs ?? null,
          transactionDate: h.transactionDate ?? null,
          createdAt: h.createdAt ?? null,
          ibkrUnrealizedPnl: h.ibkrUnrealizedPnl ?? null,
        });
      }
    }
    return Array.from(map.values());
  }, [holdingsRaw]);

  const h2Holdings: H2Holding[] = useMemo(() =>
    (h2Raw ?? []).filter((h: { units: number }) => h.units !== 0).map((h: {
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

  // IBKR sync (for summary data)
  const {
    ibkrSummaryData,
    ibkrPnlData,
    ibkrPositionsData,
    ibkrStatus,
    setIbkrStatus,
    setIbkrAccountId,
    setIbindSessionActive,
  } = useIbkrSync(isAdmin, false);

  // isLive: IBKR is live-connected when either:
  //   1. ibkrStatus === "connected" (useIbkrSync polling confirmed active)
  //   2. autoConnectPhase === "connected" (tryConnect succeeded — UI shows "IBKR Live")
  // Both conditions must trigger ibkrPnlData usage so Today P&L comes from IBKR /pnl.
  const isLive = ibkrStatus === "connected" || autoConnectPhase === "connected";

  // IBKR positions overlay — same SSOT as Trade Manager (units/avgCost from broker)
  const h1HoldingsLive = useMemo(() => {
    if (!isLive || !ibkrPositionsData?.positions?.length) return h1Holdings;
    const dbByTicker = new Map(h1Holdings.map(h => [h.ticker.toUpperCase(), h]));
    return ibkrPositionsData.positions.map(p => {
      const db = dbByTicker.get(p.ticker.toUpperCase());
      return {
        ticker: p.ticker,
        units: p.position,
        buyPrice: p.avgCost ?? db?.buyPrice ?? 0,
        currentPrice: p.mktPrice ?? db?.currentPrice ?? null,
        dailyChangePercent: db?.dailyChangePercent ?? null,
        priceUpdatedAt: db?.priceUpdatedAt ?? null,
        dailyBasePrice: db?.dailyBasePrice ?? null,
        dailyBaseTs: db?.dailyBaseTs ?? null,
        transactionDate: db?.transactionDate ?? null,
        createdAt: db?.createdAt ?? null,
        ibkrUnrealizedPnl: p.unrealizedPnl ?? db?.ibkrUnrealizedPnl ?? null,
      };
    });
  }, [h1Holdings, isLive, ibkrPositionsData]);

  const scopedH1Holdings = useMemo(() => {
    if (!isScopedViewer || !scopedLiveStatus?.positions?.length) return null;
    return scopedLiveStatus.positions.map((p: {
      ticker: string;
      direction?: string;
      units: number;
      entryPrice?: number;
      currentPrice?: number | null;
      unrealizedPnl?: number | null;
      pnl?: number | null;
    }) => ({
      ticker: p.ticker,
      units: p.direction === "short" ? -Math.abs(p.units) : Math.abs(p.units),
      buyPrice: p.entryPrice ?? 0,
      currentPrice: p.currentPrice ?? null,
      dailyChangePercent: null,
      priceUpdatedAt: null,
      dailyBasePrice: null,
      dailyBaseTs: null,
      transactionDate: null,
      createdAt: null,
      ibkrUnrealizedPnl: p.unrealizedPnl ?? p.pnl ?? null,
    }));
  }, [isScopedViewer, scopedLiveStatus]);

  const h1HoldingsEffective = scopedH1Holdings ?? h1HoldingsLive;
  const h1Tickers = useMemo(
    () => Array.from(new Set(h1HoldingsEffective.map(h => h.ticker))),
    [h1HoldingsEffective],
  );
  const h2Tickers = useMemo(
    () => Array.from(new Set(h2Holdings.map(h => h.ticker))),
    [h2Holdings],
  );

  // Dedicated getPnl query for PortfolioOverview
  // useIbkrSync's ibkrPnlData is only enabled when ibkrStatus==="connected", missing the autoConnectPhase case.
  const { data: overviewPnlData, refetch: refetchPnl } = trpc.ibkr.getPnl.useQuery(undefined, {
    enabled: isLive,
    refetchInterval: isLive ? 10_000 : false,
    staleTime: 0,
  });

  // Monitor status: shows reconnect-in-progress (offline) and latency (live) indicators (improvements 6 & 7)
  const { data: monitorStatus } = trpc.ibkr.getMonitorStatus.useQuery(undefined, {
    enabled: isAdmin,
    refetchInterval: 10_000,
    staleTime: 8_000,
  });

  // ── Auto-connect on mount and visibility change ──────────────────────────────
  /**
   * tryConnect: checks IBIND health, if not active calls /session/start,
   * then polls every 1s until active (max 30s). On failure, schedules retry in 10s.
   */
  const tryConnect = useCallback(async () => {
    if (isConnectingRef.current) return;
    isConnectingRef.current = true;
    setAutoConnectPhase("checking");

    const scheduleRetry = () => {
      isConnectingRef.current = false;
      setAutoConnectPhase("error");
      if (autoConnectRetryRef.current) clearTimeout(autoConnectRetryRef.current);
      autoConnectRetryRef.current = setTimeout(() => tryConnect(), 10_000);
    };

    try {
      // 1. Check if session already active
      const ctrl1 = new AbortController();
      const t1 = setTimeout(() => ctrl1.abort(), 5000);
      const healthRes = await fetch("/api/ibind/health", { signal: ctrl1.signal }).catch(() => null);
      clearTimeout(t1);

      if (healthRes?.ok) {
        const d = await healthRes.json().catch(() => ({}));
        const active = (d.session_active === true || d.session_active === "true") && d.status === "ok";
        if (active) {
          if (d.account_id) setIbkrAccountId(d.account_id);
          setIbkrStatus("connected");
          setIbindSessionActive(true);
          setAutoConnectPhase("connected");
          isConnectingRef.current = false;
          return;
        }
      }

      // 2. Session not active — start it
      setAutoConnectPhase("connecting");
      const ctrl2 = new AbortController();
      const t2 = setTimeout(() => ctrl2.abort(), 8000);
      const startRes = await fetch("/api/ibind/session/start", {
        method: "POST",
        signal: ctrl2.signal,
      }).catch(() => null);
      clearTimeout(t2);

      if (!startRes?.ok) {
        scheduleRetry();
        return;
      }

      const startBody = await startRes.json().catch(() => ({}));
      if (startBody?.already_active || startBody?.session_active) {
        if (startBody?.account_id) setIbkrAccountId(startBody.account_id);
        setIbkrStatus("connected");
        setIbindSessionActive(true);
        setAutoConnectPhase("connected");
        isConnectingRef.current = false;
        return;
      }

      // 3. Poll every 1s until active (max 30s)
      let elapsed = 0;
      const poll = setInterval(async () => {
        elapsed += 1000;
        try {
          const ctrl3 = new AbortController();
          const t3 = setTimeout(() => ctrl3.abort(), 3000);
          const r = await fetch("/api/ibind/health", { signal: ctrl3.signal });
          clearTimeout(t3);
          const d = await r.json();
          const active = (d.session_active === true || d.session_active === "true") && d.status === "ok";
          if (active) {
            clearInterval(poll);
            if (d.account_id) setIbkrAccountId(d.account_id);
            setIbkrStatus("connected");
            setIbindSessionActive(true);
            setAutoConnectPhase("connected");
            isConnectingRef.current = false;
          } else if (elapsed >= 30_000) {
            clearInterval(poll);
            scheduleRetry();
          }
        } catch {
          if (elapsed >= 30_000) {
            clearInterval(poll);
            scheduleRetry();
          }
        }
      }, 1000);
    } catch {
      scheduleRetry();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setIbkrStatus, setIbkrAccountId, setIbindSessionActive]);

  // Auto-connect on mount
  useEffect(() => {
    tryConnect();
    return () => {
      if (autoConnectRetryRef.current) clearTimeout(autoConnectRetryRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-connect when app returns to foreground (tab/app switch)
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible" && ibkrStatus !== "connected") {
        tryConnect();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [ibkrStatus, tryConnect]);

  // Sync autoConnectPhase with ibkrStatus from useIbkrSync (external polling)
  useEffect(() => {
    if (ibkrStatus === "connected") setAutoConnectPhase("connected");
  }, [ibkrStatus]);

  // IBKR market data — must run before useLivePrices so we know if /quotes is live
  const ibkrMarketData = useIbkrMarketData({
    h1Tickers,
    h2Tickers,
    catalogueTickers: [],
    ibkrConnected: isLive,
  });
  const ibkrQuotesActive = ibkrMarketData.hasLiveQuotes;

  // Live price maps — SSE + 10s HTTP poll; SSE pauses only when IBKR quotes are live
  const h1LivePricesResult = useLivePrices(
    h1Holdings.map(h => ({ ticker: h.ticker })),
    ibkrStatus,
    { ibkrQuotesActive },
  );
  const h2LivePricesResult = useLivePrices(
    h2Holdings.map(h => ({ ticker: h.ticker })),
    ibkrStatus,
    { ibkrQuotesActive },
  );

  const h1LivePriceMapRaw = h1LivePricesResult.holdingLivePriceMap;
  const h2LivePriceMapRaw = h2LivePricesResult.holdingLivePriceMap;

  // Track last sync time from price updates
  const allTickers = useMemo(() => [
    ...h1Holdings.map(h => h.ticker),
    ...h2Holdings.map(h => h.ticker),
  ], [h1Holdings, h2Holdings]);


  // Update display string every minute
  useEffect(() => {
    function updateDisplay() {
      if (!lastSyncTime) { setLastSyncDisplay(""); return; }
      const diffMs = Date.now() - lastSyncTime.getTime();
      const diffMin = Math.floor(diffMs / 60_000);
      if (diffMin < 1) setLastSyncDisplay("עכשיו");
      else if (diffMin === 1) setLastSyncDisplay("לפני דקה");
      else if (diffMin < 60) setLastSyncDisplay(`לפני ${diffMin} דק'`);
      else setLastSyncDisplay(lastSyncTime.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }));
    }
    updateDisplay();
    const interval = setInterval(updateDisplay, 30_000);
    return () => clearInterval(interval);
  }, [lastSyncTime]);

  // Yahoo Finance backup layer for H2 (15s) — supplements useLivePrices polling
  const { data: h2YahooPrices } = trpc.portfolio.getLivePrices.useQuery(
    { tickers: h2Tickers },
    {
      enabled: h2Tickers.length > 0,
      staleTime: 0,
      refetchInterval: 15_000,
      refetchOnWindowFocus: true,
    },
  );
  const h2YahooPriceMap = useMemo(() => {
    const map: Record<string, { price: number | null; change: number | null; changePercent: number | null; prevClose: number | null; isExtendedHours?: boolean }> = {};
    (h2YahooPrices ?? []).forEach(p => {
      if (p.price != null) {
        map[p.ticker] = {
          price: p.price,
          change: p.change,
          changePercent: p.changePercent,
          prevClose: p.prevClose,
          isExtendedHours: p.isExtendedHours,
        };
      }
    });
    return map;
  }, [h2YahooPrices]);

  const { data: h1YahooPrices } = trpc.portfolio.getLivePrices.useQuery(
    { tickers: h1Tickers },
    {
      enabled: h1Tickers.length > 0 && !isLive,
      staleTime: 30_000,
      refetchInterval: 60_000,
      refetchOnWindowFocus: false,
    },
  );
  const h1YahooPriceMap = useMemo(() => {
    const map: Record<string, { price: number | null; change: number | null; changePercent: number | null; prevClose: number | null; isExtendedHours?: boolean }> = {};
    (h1YahooPrices ?? []).forEach(p => {
      if (p.price != null) {
        map[p.ticker] = {
          price: p.price,
          change: p.change,
          changePercent: p.changePercent,
          prevClose: p.prevClose,
          isExtendedHours: p.isExtendedHours,
        };
      }
    });
    return map;
  }, [h1YahooPrices]);

  const holdingDbPriceMap = useMemo(() => {
    const map = new Map<string, { hasDb: boolean; isCrypto: boolean }>();
    for (const h of h1Holdings) map.set(h.ticker, { hasDb: !!(h.currentPrice ?? h.buyPrice), isCrypto: false });
    for (const h of h2Holdings) map.set(h.ticker, { hasDb: !!(h.currentPrice ?? h.buyPrice), isCrypto: isCrypto(h.ticker) });
    return map;
  }, [h1Holdings, h2Holdings]);

  const loadedCount = useMemo(() => {
    let count = 0;
    for (const t of allTickers) {
      const meta = holdingDbPriceMap.get(t);
      const hasIbkrPrice = ibkrMarketData.h1PriceMap[t]?.price != null || ibkrMarketData.h2PriceMap[t]?.price != null;
      const hasSse = h1LivePriceMapRaw[t]?.price != null || h2LivePriceMapRaw[t]?.price != null;
      const hasYahoo = h2YahooPriceMap[t]?.price != null || h1YahooPriceMap[t]?.price != null;
      if (hasIbkrPrice || hasSse || hasYahoo || meta?.hasDb) count++;
    }
    return count;
  }, [allTickers, holdingDbPriceMap, h1LivePriceMapRaw, h2LivePriceMapRaw, ibkrMarketData.h1PriceMap, ibkrMarketData.h2PriceMap, h2YahooPriceMap, h1YahooPriceMap]);

  const syncProgress = allTickers.length > 0 ? Math.round((loadedCount / allTickers.length) * 100) : 0;
  // Stop showing "syncing" once IBKR has polled at least once, or all tickers have a baseline price.
  const isSyncing = allTickers.length > 0
    && !(isLive && ibkrMarketData.lastUpdated > 0)
    && loadedCount < allTickers.length;

  // Update last sync time when all prices are loaded (SSE path)
  useEffect(() => {
    if (!isSyncing && loadedCount > 0) {
      const now = new Date();
      setLastSyncTime(now);
    }
  }, [isSyncing, loadedCount]);
  // Update last sync time when IBKR auto-polls (every 30s)
  useEffect(() => {
    if (isLive && ibkrMarketData.lastUpdated > 0) {
      const d = new Date(ibkrMarketData.lastUpdated);
      setLastSyncTime(d);
      setLastUpdated(d);
    }
  }, [isLive, ibkrMarketData.lastUpdated, setLastUpdated]);
  useEffect(() => {
    if (h2LivePricesResult.pricesUpdatedAt > 0) {
      const d = new Date(h2LivePricesResult.pricesUpdatedAt);
      setLastSyncTime(d);
      setLastUpdated(d);
    }
  }, [h2LivePricesResult.pricesUpdatedAt, setLastUpdated]);

  // Merge IBKR + Yahoo into H1 price map (3-layer: Yahoo → IBKR)
  const h1LivePriceMap = useMemo((): Record<string, LivePriceEntry> => {
    const merged: Record<string, LivePriceEntry> = { ...h1LivePriceMapRaw };
    Object.entries(h1YahooPriceMap).forEach(([sym, p]) => {
      if (p.price != null) merged[sym] = { ...merged[sym], ...p };
    });
    for (const [ticker, data] of Object.entries(ibkrMarketData.h1PriceMap)) {
      if (data?.price != null) merged[ticker] = { ...merged[ticker], ...data };
    }
    return merged;
  }, [h1LivePriceMapRaw, h1YahooPriceMap, ibkrMarketData.h1PriceMap]);

  // H2 price map: 3-layer — DB baseline → Yahoo live → IBKR override (skip IBKR for crypto)
  const ibkrH2QuotesArrived = Object.keys(ibkrMarketData.h2PriceMap).length > 0;
  const h2LivePriceMap = useMemo((): Record<string, LivePriceEntry> => {
    const merged: Record<string, LivePriceEntry> = {};
    for (const h of h2Holdings) {
      const cp = h.currentPrice ?? null;
      const pc = h.prevClose ?? null;
      const chgPct = h.dailyChangePercent ?? null;
      const chg = (cp != null && pc != null && pc > 0) ? cp - pc
        : (cp != null && chgPct != null && chgPct !== 0) ? cp - (cp / (1 + chgPct / 100))
        : null;
      if (cp != null) {
        merged[h.ticker] = { price: cp, change: chg, changePercent: chgPct, prevClose: pc };
      }
    }
    Object.entries(h2YahooPriceMap).forEach(([sym, p]) => {
      if (p.price != null) merged[sym] = { ...merged[sym], ...p };
    });
    if (isLive) {
      Object.entries(ibkrMarketData.h2PriceMap).forEach(([sym, data]) => {
        if (isCrypto(sym)) return;
        if (data?.price != null) merged[sym] = { ...merged[sym], ...data };
      });
    }
    for (const [ticker, data] of Object.entries(h2LivePriceMapRaw)) {
      if (data?.price != null) merged[ticker] = { ...merged[ticker], ...data };
    }
    // IBKR after TASE close overwrites good DB/Yahoo quotes with change=0 — restore from baseline
    for (const h of h2Holdings) {
      if (merged[h.ticker]) {
        merged[h.ticker] = enrichTaTodayQuote(h.ticker, merged[h.ticker], h);
      }
    }
    return merged;
  }, [h2Holdings, h2YahooPriceMap, ibkrMarketData.h2PriceMap, h2LivePriceMapRaw, isLive]);

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

  // Cash balance
  const scopedCashBalance = useMemo(() => {
    const s = scopedLiveStatus?.summary as {
      availableFunds?: number | null;
      liveNlv?: number;
      totalHolding?: number;
      dailyPnlUsd?: number;
    } | null | undefined;
    if (!s) return 0;
    if (typeof s.availableFunds === "number" && Number.isFinite(s.availableFunds)) return s.availableFunds;
    const nlv = s.liveNlv ?? 0;
    const holding = s.totalHolding ?? 0;
    return Math.max(0, nlv - holding);
  }, [scopedLiveStatus]);

  const cashBalance = isScopedViewer
    ? scopedCashBalance
    : (ibkrSummaryData?.summary?.totalCash ?? (account?.lastKnownCash ?? account?.cashBalance ?? 0));

  // Portfolio metrics — base "isLive" on the SUMMARY DATA SOURCE (not the raw connection flag) so H1
  // Today P&L matches Trade Manager exactly and avoids header≠footer during the IBKR warm-up window.
  const summaryIsLive = isScopedViewer
    ? !!scopedLiveStatus?.positions
    : (ibkrSummaryData?.source === "ibeam" || ibkrSummaryData?.source === "ibind");
  const scopedDailyPnl = (scopedLiveStatus?.summary as { dailyPnlUsd?: number } | null | undefined)?.dailyPnlUsd ?? null;
  const metrics = usePortfolioMetrics({
    h1Holdings: h1HoldingsEffective,
    h2Holdings: isScopedViewer ? [] : h2Holdings,
    h1LivePriceMap,
    h2LivePriceMap: isScopedViewer ? {} : h2LivePriceMap,
    ibkr: {
      grossPositionValue: isScopedViewer
        ? ((scopedLiveStatus?.summary as { totalHolding?: number } | null)?.totalHolding ?? null)
        : (ibkrSummaryData?.summary?.grossPositionValue ?? null),
      netLiquidation: isScopedViewer
        ? ((scopedLiveStatus?.summary as { liveNlv?: number } | null)?.liveNlv ?? null)
        : (ibkrSummaryData?.summary?.netLiquidation ?? null),
      dailyPnl: isScopedViewer
        ? scopedDailyPnl
        : (overviewPnlData?.dailyPnl ?? ibkrPnlData?.dailyPnl ?? (ibkrSummaryData?.summary as any)?.dailyPnl ?? null),
      totalCash: cashBalance,
      isLive: summaryIsLive,
    },
    cashBalance,
  });

  // ── Split H2 into groups ─────────────────────────────────────────────────────
  const { h2Tase, h2Usa, h2Crypto } = useMemo(() => {
    const tase: H2Holding[] = [];
    const usa: H2Holding[] = [];
    const crypto: H2Holding[] = [];
    for (const h of h2Holdings) {
      if (isTase(h.ticker)) tase.push(h);
      else if (isCrypto(h.ticker)) crypto.push(h);
      else usa.push(h);
    }
    return { h2Tase: tase, h2Usa: usa, h2Crypto: crypto };
  }, [h2Holdings]);

  // ── Compute per-group metrics ────────────────────────────────────────────────
  function groupMetrics(group: H2Holding[]): Omit<PortfolioRow, "id" | "name" | "count"> {
    let value = 0, cost = 0, todayDollar = 0, hasTodayData = false;
    const taseClosedNow = isTaseClosedToday();
    const usClosedNow = isUsMarketClosedNow();
    for (const h of group) {
      const live = h2LivePriceMap[h.ticker];
      const price = live?.price ?? h.currentPrice ?? h.buyPrice;
      value += positionValue(price, h.units);
      cost  += positionCost(h.buyPrice, h.units);
      // Skip today change based on market state:
      // - .TA tickers: TASE is closed during US hours (trades Sun–Thu). DON'T blanket-skip:
      //   the session's real daily move still has a valid baseline (live.change / prior_close
      //   prevClose / dailyBasePrice snapshot). Only skip when NO daily baseline exists at all,
      //   otherwise the Today column wrongly shows "—"/"+0.00%" while a real move sits in prevClose.
      // - US tickers: skip when US market fully closed AND no live IBKR data
      //   (if IBKR returns valid change data from after-hours/futures, show it)
      // - Crypto (-USD): always compute (24/7)
      const isTaTicker = h.ticker.toUpperCase().endsWith('.TA');
      const isCryptoTicker = h.ticker.toUpperCase().endsWith('-USD');
      if (isTaTicker && taseClosedNow) {
        // Only skip a closed-TASE position when it has GENUINELY no daily baseline —
        // no live change, no prevClose, no DB change%, and no dailyBasePrice snapshot.
        // If any baseline exists, fall through to computeTodayPnl (which yields the real
        // daily change, or a legit 0.00% on a flat session).
        const hasDailyBaseline =
          live?.change != null
          || (live?.prevClose != null && live.prevClose > 0)
          || (live?.changePercent != null && live.changePercent !== 0)
          || (h.dailyBasePrice != null && h.dailyBasePrice > 0);
        if (!hasDailyBaseline) {
          continue;
        }
      }
      if (!isTaTicker && !isCryptoTicker && usClosedNow) {
        // Only skip if there's no live IBKR data for this ticker
        const hasLiveData = (live?.change != null && live.change !== 0)
          || (live?.changePercent != null && live.changePercent !== 0)
          || (live?.price != null && live.prevClose != null && live.prevClose > 0 && live.price !== live.prevClose);
        if (!hasLiveData) continue;
      }
      const todayPart = computeTodayPnl(
        h.units,
        h.buyPrice,
        h.currentPrice ?? null,
        live,
        h.dailyChangePercent,
        h.priceUpdatedAt,
        h.dailyBasePrice,
        h.dailyBaseTs,
        undefined,
        h.transactionDate,
        h.createdAt,
      );
      todayDollar += todayPart;
      if (
        todayPart !== 0
        || isPositionOpenedToday(h.transactionDate, h.createdAt)
        || (live?.change != null && live.change !== 0)
        || (live?.changePercent != null && live.changePercent !== 0)
        || (live?.price != null && live.prevClose != null && live.prevClose > 0)
        // A valid daily snapshot is also a baseline (e.g. closed-TASE flat session) —
        // mark today data present so the row renders a legit 0.00% instead of "—".
        || (h.dailyBasePrice != null && h.dailyBasePrice > 0)
      ) {
        hasTodayData = true;
      }
    }
    const totalDollar = group.reduce((s, h) => {
      const live = h2LivePriceMap[h.ticker];
      const price = live?.price ?? h.currentPrice ?? h.buyPrice;
      return s + positionTotalPnl(price, h.buyPrice, h.units);
    }, 0);
    const totalPct = cost > 0 ? (totalDollar / cost) * 100 : 0;
    const prevCloseValue = value - todayDollar;
    const todayPct = hasTodayData && Math.abs(prevCloseValue) > 0
      ? (todayDollar / Math.abs(prevCloseValue)) * 100
      : null;
    return {
      value,
      cost,
      todayDollar: hasTodayData ? todayDollar : null,
      todayPct,
      totalDollar,
      totalPct,
    };
  }

  // ── Build rows ───────────────────────────────────────────────────────────────
  const h1ShortLiability = useMemo(() => {
    const items = h1HoldingsEffective.map(h => {
      const live = h1LivePriceMap[h.ticker];
      const price = live?.price ?? h.currentPrice ?? h.buyPrice;
      return { units: h.units, value: positionValue(price, h.units) };
    });
    return aggregateShortLiability(items);
  }, [h1HoldingsEffective, h1LivePriceMap]);

  const rows: PortfolioRow[] = useMemo(() => {
    const h1Value = metrics.h1TotalValue;
    const h1Cost  = metrics.h1TotalCost;
    // Use pre-computed P&L that correctly handles SHORT positions
    const h1TotalDollar = metrics.h1TotalPnl;
    const h1TotalPct = metrics.h1TotalPnlPct;

    const taseM   = groupMetrics(h2Tase);
    const usaM    = groupMetrics(h2Usa);
    const cryptoM = groupMetrics(h2Crypto);

    const h1Count = h1HoldingsEffective.length;
    const h1RowName = isScopedViewer
      ? (primaryAccountLabel ? `Holding 1 — ${primaryAccountLabel}` : "Holding 1")
      : "Holding 1";
    const built: PortfolioRow[] = [];

    if (h1Count > 0) {
      built.push({
        id: "h1",
        name: h1RowName,
        count: h1Count,
        value: h1Value,
        cost: h1Cost,
        todayDollar: metrics.h1TodayPnl,
        todayPct: metrics.h1TodayPct,
        totalDollar: h1TotalDollar,
        totalPct: h1TotalPct,
        shortCount: h1ShortLiability.count,
        shortLiability: h1ShortLiability.total,
      });
    }
    if (!isScopedViewer && h2Tase.length > 0) {
      built.push({ id: "h2-tase", name: "H2 TASE", count: h2Tase.length, ...taseM });
    }
    if (!isScopedViewer && h2Usa.length > 0) {
      built.push({ id: "h2-usa", name: "H2 USA", count: h2Usa.length, ...usaM });
    }
    if (!isScopedViewer && h2Crypto.length > 0) {
      built.push({ id: "h2-crypto", name: "H2 Crypto", count: h2Crypto.length, ...cryptoM });
    }
    built.push({
      id: "cash",
      name: "Cash",
      count: 1,
      value: cashBalance,
      cost: cashBalance,
      todayDollar: 0,
      todayPct: 0,
      totalDollar: 0,
      totalPct: 0,
    });

    return built.filter(isVisiblePortfolioRow);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metrics, h2Tase, h2Usa, h2Crypto, cashBalance, h1HoldingsEffective.length, h1ShortLiability, isScopedViewer, primaryAccountLabel]);

  // ── Footer totals ─────────────────────────────────────────────────────────────
  const footer = useMemo(() => {
    const totalValue = rows.reduce((s, r) => s + r.value, 0);
    const totalCost  = rows.reduce((s, r) => s + r.cost, 0);
    const rowTotalToday = rows.reduce((s, r) => s + (r.todayDollar ?? 0), 0);
    const hasToday   = rows.some(r => r.todayDollar != null);
    const totalPnl   = rows.reduce((s, r) => s + r.totalDollar, 0);
    const totalPct   = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
    const footerPrevClose = totalValue - rowTotalToday;
    const rowTodayPct = hasToday && footerPrevClose > 0
      ? (rowTotalToday / footerPrevClose) * 100
      : null;
    const totalToday = metrics.unifiedTodayPnl ?? (hasToday ? rowTotalToday : null);
    const todayPct = metrics.unifiedTodayPct ?? rowTodayPct;
    // USD-only value for FX P&L: H1 + H2 USA + H2 Crypto (exclude H2 TASE — ILS-denominated)
    // Note: All values in rows are stored in USD (TASE was converted server-side ILA→ILS→USD).
    const totalUsdValue = rows
      .filter(r => r.id !== "h2-tase" && r.id !== "cash")
      .reduce((s, r) => s + r.value, 0);
    // TASE value in USD (already converted server-side, used to back-compute ILS value)
    const totalTaseUsd = rows.find(r => r.id === "h2-tase")?.value ?? 0;
    return { totalValue, totalCost, totalToday: hasToday || metrics.unifiedTodayPnl != null ? totalToday : null, todayPct, totalPnl, totalPct, totalUsdValue, totalTaseUsd };
  }, [rows, metrics.unifiedTodayPnl, metrics.unifiedTodayPct]);

  // ── Price sync mutations ───────────────────────────────────────────────────────────────────────
  const refreshH1PricesMut = trpc.portfolio.refreshPrices.useMutation();
  const refreshH2PricesMut = trpc.holding2.refreshPrices.useMutation();

  // Auto-refresh stale H2 prices on load (crypto prevClose / daily change)
  const h2AutoRefreshedRef = useRef(false);
  useEffect(() => {
    if (h2AutoRefreshedRef.current) return;
    if (!h2Raw || h2Raw.length === 0) return;
    if (refreshH2PricesMut.isPending) return;
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const now = Date.now();
    const needsRefresh = h2Raw.some((r: { units: number; priceUpdatedAt?: string | Date | null }) => {
      if (r.units <= 0) return false;
      if (!r.priceUpdatedAt) return true;
      return now - new Date(r.priceUpdatedAt).getTime() > ONE_HOUR_MS;
    });
    if (needsRefresh) {
      h2AutoRefreshedRef.current = true;
      refreshH2PricesMut.mutate();
    }
  }, [h2Raw, refreshH2PricesMut]);

  // ── Refresh (all portfolios: H1 + H2 TASE/USA/Crypto + IBKR quotes) ─────────
  async function handleRefresh() {
    if (isScopedViewer) {
      await refetchScoped({ bustCache: true });
      return;
    }
    if (autoConnectPhase !== "connected" && ibkrStatus !== "connected") {
      isConnectingRef.current = false;
      await tryConnect();
      await new Promise(r => setTimeout(r, 1200));
    }
    await refreshAll({
      ibkrRefetch: () => ibkrMarketData.refetch(),
      h1LiveRefetch: () => h1LivePricesResult.refetchLivePrices(),
      h2LiveRefetch: () => h2LivePricesResult.refetchLivePrices(),
      extra: [() => refetchPnl(), () => refetchH1(), () => refetchH2()],
    });
  }
  return (
    <div className="min-h-screen bg-[#F4F6F8] text-gray-800" dir="ltr">
      {/* ── Header ── */}
      <div className="sticky top-16 z-[100] bg-white border-b border-[#2563EB]/30 shadow-lg">
      <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex flex-col leading-none">
            <span className="text-[10px] font-semibold text-[#2563EB] tracking-widest uppercase">TradeSnow</span>
            <div className="flex items-center gap-2">
              <span className="font-bold text-lg tracking-tight text-gray-800">Overview</span>
              <MarketStatusBadge />
            </div>
          </div>
          {/* ── IBIND Connection Indicator ── */}
          {autoConnectPhase === "connected" || isLive ? (
            <div className="flex flex-col gap-0.5 ml-2">
              <span className="flex items-center gap-1 text-xs text-[#65A30D]">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#65A30D] opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-[#65A30D]" />
                </span>
                IBKR Live
                {/* (7) Connection quality indicator based on IBIND latency */}
                {monitorStatus?.ibindLatencyMs != null && (
                  <span
                    className="text-[9px] font-mono px-1 rounded"
                    style={{
                      color: monitorStatus.ibindLatencyMs < 500 ? '#65A30D'
                           : monitorStatus.ibindLatencyMs < 1500 ? '#D97706'
                           : '#EF4444',
                    }}
                    title={`IBIND latency: ${monitorStatus.ibindLatencyMs}ms`}
                  >
                    {monitorStatus.ibindLatencyMs < 500 ? '●' : monitorStatus.ibindLatencyMs < 1500 ? '●' : '●'}
                    {monitorStatus.ibindLatencyMs}ms
                  </span>
                )}
                {lastSyncDisplay && (
                  <span className="flex items-center gap-0.5 text-[10px] text-gray-800/40 ml-1">
                    <Clock className="w-2.5 h-2.5" />
                    {lastSyncDisplay}
                  </span>
                )}
              </span>
              {isSyncing && (
                <div className="flex items-center gap-1.5">
                  <div className="relative h-1 w-20 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="absolute left-0 top-0 h-full rounded-full transition-all duration-300"
                      style={{
                        width: `${syncProgress}%`,
                        background: `linear-gradient(90deg, #2563EB, #65A30D)`,
                      }}
                    />
                  </div>
                  <span className="text-[10px] text-gray-800/40">{loadedCount}/{allTickers.length}</span>
                </div>
              )}
            </div>
          ) : autoConnectPhase === "checking" || autoConnectPhase === "connecting" ? (
            <span className="flex items-center gap-1.5 text-xs text-amber-400 ml-2">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>{autoConnectPhase === "checking" ? "בודק חיבור..." : "מתחבר..."}</span>
            </span>
          ) : (
            <div className="flex flex-col gap-0.5 ml-2">
              <span className="flex items-center gap-1.5">
                <span className="flex items-center gap-1 text-xs text-gray-800/40">
                  {monitorStatus?.reconnectInProgress ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <WifiOff className="w-3 h-3" />
                  )}
                  {monitorStatus?.reconnectInProgress
                    ? "מתחבר מחדש..."
                    : autoConnectPhase === "error"
                    ? "נסיון חוזר..."
                    : monitorStatus?.consecutiveReconnectFails && monitorStatus.consecutiveReconnectFails > 0
                    ? `Offline (${monitorStatus.consecutiveReconnectFails} כישלונות)`
                    : "Offline"}
                </span>
                <button
                  onClick={() => tryConnect()}
                  className="flex items-center gap-0.5 text-[10px] font-semibold text-[#2563EB] border border-[#2563EB]/40 rounded px-1.5 py-0.5 hover:bg-[#2563EB]/10 transition-colors"
                  title="התחבר ל-IBKR"
                >
                  <PlugZap className="w-2.5 h-2.5" />
                  התחבר
                </button>
              </span>
              {isSyncing && (
                <div className="flex items-center gap-1.5">
                  <div className="relative h-1 w-20 bg-gray-200 rounded-full overflow-hidden">
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
        <LastUpdateRefreshButton
          onRefresh={handleRefresh}
          refreshing={refreshing}
          lastUpdated={lastUpdated ?? lastSyncTime}
        />
      </div>
      {/* ── Market indices bar ── */}
      <MarketBar />
      </div>

      {/* ── Main content wrapper ── */}
      <div className="max-w-4xl mx-auto">

      {/* ── Column headers ── */}
      <div className="grid grid-cols-[1fr_5.5rem_4.5rem_4.5rem] gap-x-1 px-3 py-2 text-xs font-semibold text-[#2563EB]/70 border-b border-gray-200 bg-white/5">
        <span>Name</span>
        <span className="text-right">Value/Cost</span>
        <span className="text-right">Today</span>
        <span className="text-right">Total</span>
      </div>

      {/* ── Rows ── */}
      <div className="divide-y divide-[#2563EB]/20">
        {isInitialLoading ? (
          // UX-2 (v20.48): Skeleton rows instead of $0 during initial load
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="grid grid-cols-[1fr_5.5rem_4.5rem_4.5rem] gap-x-1 px-3 py-3 items-center animate-pulse">
              <div className="flex flex-col gap-1.5">
                <div className="h-3.5 w-24 bg-gray-200 rounded" />
                <div className="h-2.5 w-16 bg-gray-100 rounded" />
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <div className="h-3.5 w-16 bg-gray-200 rounded" />
                <div className="h-2.5 w-12 bg-gray-100 rounded" />
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <div className="h-3.5 w-10 bg-gray-200 rounded" />
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <div className="h-3.5 w-10 bg-gray-200 rounded" />
              </div>
            </div>
          ))
        ) : (
          rows.filter(isVisiblePortfolioRow).map(row => (
            <PortfolioRowItem key={row.id} row={row} />
          ))
        )}
      </div>

      {/* ── Footer ── */}
      <div className="mt-2 mx-2 rounded-xl border border-[#2563EB]/40 bg-white shadow-md overflow-hidden">
        <div className="px-3 py-2">
          <div className="grid grid-cols-[1fr_5.5rem_4.5rem_4.5rem] gap-x-1 items-center">
            {/* Name */}
            <div className="flex items-center gap-2">
              <div className="font-bold text-base text-gray-800">All Accounts</div>
              <span className="bg-[#2563EB] text-white text-[10px] font-bold px-1.5 py-0.5 rounded">USD</span>
            </div>
            {/* Value */}
            <div className="text-right">
              <div className="font-bold text-base text-gray-800">{fmtUsd(footer.totalValue)}</div>
            </div>
            {/* Today */}
            <div className="text-right">
              <div className={cn("font-bold text-base",
                footer.totalToday == null ? "text-gray-800/40"
                : footer.totalToday >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"
              )}>
                {footer.totalToday != null ? fmtPct(footer.todayPct) : "—"}
              </div>
              <div className={cn("text-xs font-semibold",
                footer.totalToday == null ? "text-gray-800/40"
                : footer.totalToday >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"
              )}>
                {footer.totalToday != null ? fmtDollarChange(footer.totalToday) : "0"}
              </div>
            </div>
            {/* Total */}
            <div className="text-right">
              <div className={cn("font-semibold text-base", footer.totalPnl >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]")}>
                {fmtPct(footer.totalPct)}
              </div>
              <div className={cn("text-xs", footer.totalPnl >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]")}>
                {fmtDollarChange(footer.totalPnl)}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── ILS Box (שער דולר/שקל + Leverage) ── */}
      <PortfolioValueCard
        totalValue={footer.totalValue}
        totalUsdValue={footer.totalUsdValue}
        totalTaseUsd={footer.totalTaseUsd}
        totalToday={footer.totalToday}
        ibkrSummary={ibkrSummaryData?.summary}
        h1ShortLiability={h1ShortLiability}
      />

      <FearGreedWidget />
      <VixWidget />

      </div>{/* end max-w-4xl */}
      <div className="h-28" />
    </div>
  );
}

// ── Leverage Ratio (embedded in portfolio card) ───────────────────────────────
function LeverageRatioSection({ summary }: { summary?: { grossPositionValue?: number | null; netLiquidation?: number | null; maintenanceMargin?: number | null } | null }) {
  const gpv = summary?.grossPositionValue;
  const nlv = summary?.netLiquidation;
  if (gpv == null || nlv == null || nlv <= 0) return null;

  const lr = gpv / nlv;
  const color = lr <= 1.0 ? "#65A30D" : lr <= 1.2 ? "#F59E0B" : "#FF6B6B";
  const label = lr <= 1.0 ? "Conservative ✓" : lr <= 1.2 ? "Moderate ⚠" : "High Leverage 🔴";

  return (
    <div className="mt-2 pt-2 border-t border-gray-100">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: "rgba(37,99,235,0.65)" }}>Leverage Ratio</div>
          <div className="font-bold text-xl mt-0.5" style={{ color }}>{lr.toFixed(2)}x</div>
          <div className="text-xs mt-0.5" style={{ color }}>{label}</div>
        </div>
        <div className="text-right text-xs text-gray-500">
          <div>GPV: ${(gpv / 1000).toFixed(1)}k</div>
          <div>NLV: ${(nlv / 1000).toFixed(1)}k</div>
          {summary?.maintenanceMargin != null && (
            <div>Maint. Mgn: ${(summary.maintenanceMargin / 1000).toFixed(1)}k</div>
          )}
          <div className="mt-1 text-[10px] text-gray-400">Gross Position Value / Net Liquidation</div>
        </div>
      </div>
    </div>
  );
}

// ── Portfolio Value Card (ILS / USD tabs) ──────────────────────────────────────────────────────────
/**
 * Two-tab portfolio value card.
 *
 * All values in rows are stored in USD (server converts TASE ILA→ILS→USD).
 * Single source of truth: one `rate` from forex.getRate, used for all conversions.
 *
 * ILS tab:
 *   displayTotalILS = totalUsdValue × rate  +  totalTaseUsd × rate
 *                   = totalValue × rate   (since totalValue = totalUsdValue + totalTaseUsd + cash)
 *   Sub-breakdown:
 *     USD assets in ILS = totalUsdValue × rate
 *     TASE assets in ILS = totalTaseUsd × rate   (back-converted from USD→ILS)
 *
 * USD tab:
 *   displayTotalUSD = totalValue  (everything is already in USD)
 *   Sub-breakdown:
 *     USD assets = totalUsdValue
 *     TASE in USD = totalTaseUsd  (already converted server-side)
 *
 * FX P&L 24h:
 *   fxPnlIls = (currentRate - prevRate) × totalUsdValue
 *   (TASE excluded — its USD value already moved with the rate at conversion time)
 */
function PortfolioValueCard({
  totalValue,
  totalUsdValue,
  totalTaseUsd,
  totalToday,
  ibkrSummary,
  h1ShortLiability,
}: {
  totalValue: number;
  totalUsdValue: number;
  totalTaseUsd: number;
  totalToday?: number | null;
  ibkrSummary?: { grossPositionValue?: number | null; netLiquidation?: number | null; maintenanceMargin?: number | null } | null;
  h1ShortLiability?: { count: number; total: number };
}) {
  const [tab, setTab] = useState<"ils" | "usd">("ils");

  // ── Single source of truth for exchange rate ──────────────────────────────
  const { data: forexData } = trpc.forex.getRate.useQuery(undefined, {
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const { data: fxPnlData } = trpc.forex.getFxPnl24h.useQuery(undefined, {
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  // rate is the single source of truth — both tabs use this exact value
  const rate = forexData?.usdIls ?? 3.60;

  // ── ILS view ──────────────────────────────────────────────────────────────
  // displayTotalILS = Total_USD_Assets × rate + Total_ILS_Assets
  // Since TASE is stored in USD (already converted), Total_ILS_Assets = totalTaseUsd × rate
  // So: displayTotalILS = (totalUsdValue + totalTaseUsd) × rate = totalValue × rate
  // (cash is excluded from display breakdown but included in totalValue)
  const displayTotalILS = totalValue * rate;
  const ilsUsdPart = totalUsdValue * rate;       // H1 + H2 USA + Crypto in ILS
  const ilsTasePart = totalTaseUsd * rate;        // H2 TASE back-converted to ILS
  const ilsChange = totalToday != null ? totalToday * rate : null;
  const ilsChangePositive = ilsChange == null ? null : ilsChange >= 0;

  // ── USD view ──────────────────────────────────────────────────────────────
  // displayTotalUSD = totalValue (all rows already in USD)
  const displayTotalUSD = totalValue;
  const usdChange = totalToday;
  const usdChangePositive = usdChange == null ? null : usdChange >= 0;

  // ── FX P&L 24h (ILS tab only) ─────────────────────────────────────────────
  // Uses same rate source. Applies only to USD-exposed assets (TASE excluded).
  const fxPnlIls = (fxPnlData?.currentRate != null && fxPnlData?.prevRate != null)
    ? (fxPnlData.currentRate - fxPnlData.prevRate) * totalUsdValue
    : null;
  const fxPnlPositive = fxPnlIls == null ? null : fxPnlIls >= 0;
  const fxChangePct = fxPnlData?.changePct ?? null;

  return (
    <div className="mt-2 mx-2 rounded-xl border border-blue-500/30 bg-white shadow-md overflow-hidden">
      {/* Tab switcher */}
      <div className="flex border-b border-gray-100">
        <button
          onClick={() => setTab("ils")}
          className={cn(
            "flex-1 py-2 text-xs font-bold transition-colors",
            tab === "ils"
              ? "bg-blue-600 text-white"
              : "bg-white text-gray-400 hover:text-gray-600"
          )}
        >
          ₪ ILS
        </button>
        <button
          onClick={() => setTab("usd")}
          className={cn(
            "flex-1 py-2 text-xs font-bold transition-colors",
            tab === "usd"
              ? "bg-blue-600 text-white"
              : "bg-white text-gray-400 hover:text-gray-600"
          )}
        >
          $ USD
        </button>
      </div>

      <div className="px-3 py-3">
        {/* ── ILS Tab ── */}
        {tab === "ils" && (
          <>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-bold text-lg text-gray-800">שווי תיק</div>
                <div className="text-sm text-blue-400 mt-0.5">ILS ₪</div>
              </div>
              <div className="text-right">
                <div className="font-bold text-xl text-gray-800">{fmtIls(displayTotalILS)}</div>
                {ilsChange != null && (
                  <div className={cn("text-sm font-semibold mt-0.5",
                    ilsChangePositive === true ? "text-[#65A30D]" : ilsChangePositive === false ? "text-[#FF6B6B]" : "text-gray-400"
                  )}>
                    {fmtIlsChange(ilsChange)} שינוי מאתמול
                  </div>
                )}
              </div>
            </div>

            {/* Rate + breakdown */}
            <div className="mt-2 pt-2 border-t border-gray-200 space-y-1">
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>שער דולר/שקל</span>
                <span className="font-semibold text-blue-500">{rate.toFixed(3)}</span>
              </div>
              <div className="flex items-center justify-between text-xs text-gray-400">
                <span>USD assets (H1 + H2 USA + Crypto)</span>
                <span className="tabular-nums">{fmtIls(ilsUsdPart)}</span>
              </div>
              {ilsTasePart > 0 && (
                <div className="flex items-center justify-between text-xs text-gray-400">
                  <span>H2 TASE</span>
                  <span className="tabular-nums">{fmtIls(ilsTasePart)}</span>
                </div>
              )}
            </div>

            {/* FX P&L 24h */}
            {fxPnlIls != null && (
              <div className="mt-2 pt-2 border-t border-gray-100 flex items-center justify-between">
                <div>
                  <div className="text-xs text-gray-500 font-medium">רווח/הפסד מט&quot;ח 24ש</div>
                  <div className="text-[9px] text-gray-400 mt-0.5">
                    {fmtUsd(totalUsdValue)} × Δשער
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {fxChangePct != null && (
                    <span className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded-full",
                      fxPnlPositive ? "bg-green-50 text-green-600" : "bg-red-50 text-red-500"
                    )}>
                      {fxChangePct >= 0 ? "+" : ""}{fxChangePct.toFixed(3)}%
                    </span>
                  )}
                  <span className={cn("text-sm font-bold tabular-nums",
                    fxPnlPositive === true ? "text-[#65A30D]" : fxPnlPositive === false ? "text-[#FF6B6B]" : "text-gray-400"
                  )}>
                    {fmtIlsChange(fxPnlIls)}
                  </span>
                </div>
              </div>
            )}

            <LeverageRatioSection summary={ibkrSummary} />
            {h1ShortLiability && h1ShortLiability.count > 0 && (
              <div className="mt-2 pt-2 border-t border-rose-100">
                <ShortLiabilitySummary
                  count={h1ShortLiability.count}
                  total={h1ShortLiability.total}
                />
              </div>
            )}
          </>
        )}

        {/* ── USD Tab ── */}
        {tab === "usd" && (
          <>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-bold text-lg text-gray-800">שווי תיק</div>
                <div className="text-sm text-blue-400 mt-0.5">USD $</div>
              </div>
              <div className="text-right">
                <div className="font-bold text-xl text-gray-800">{fmtUsd(displayTotalUSD)}</div>
                {usdChange != null && (
                  <div className={cn("text-sm font-semibold mt-0.5",
                    usdChangePositive === true ? "text-[#65A30D]" : usdChangePositive === false ? "text-[#FF6B6B]" : "text-gray-400"
                  )}>
                    {usdChange >= 0 ? "+" : ""}{fmtUsd(usdChange)} שינוי מאתמול
                  </div>
                )}
              </div>
            </div>

            {/* Breakdown */}
            <div className="mt-2 pt-2 border-t border-gray-200 space-y-1">
              <div className="flex items-center justify-between text-xs text-gray-400">
                <span>USD assets (H1 + H2 USA + Crypto)</span>
                <span className="tabular-nums">{fmtUsd(totalUsdValue)}</span>
              </div>
              {totalTaseUsd > 0 && (
                <div className="flex items-center justify-between text-xs text-gray-400">
                  <span>H2 TASE (converted @ {rate.toFixed(3)})</span>
                  <span className="tabular-nums">{fmtUsd(totalTaseUsd)}</span>
                </div>
              )}
              <div className="flex items-center justify-between text-xs text-gray-500 pt-1 border-t border-gray-100">
                <span>שער המרה</span>
                <span className="font-semibold text-blue-500">{rate.toFixed(3)}</span>
              </div>
            </div>
            {h1ShortLiability && h1ShortLiability.count > 0 && (
              <div className="mt-2 pt-2 border-t border-rose-100">
                <ShortLiabilitySummary
                  count={h1ShortLiability.count}
                  total={h1ShortLiability.total}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Market Indices Bar ─────────────────────────────────────────────────────────
function MarketBar() {
  const { data, isLoading } = trpc.splash.getMarketData.useQuery(undefined, {
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  if (isLoading || !data) {
    return (
      <div className="border-t border-[#2563EB]/10 bg-white/80 px-4 py-1.5 flex gap-4">
        {[1,2,3].map(i => (
          <div key={i} className="h-4 w-20 bg-gray-200 rounded animate-pulse" />
        ))}
      </div>
    );
  }

  const indices = [
    { name: "TA-35",   d: data.ta35 },
    { name: "S&P 500", d: data.sp500 },
    { name: "NASDAQ",  d: data.nasdaq },
  ];

  return (
    <div className="border-t border-[#2563EB]/10 bg-white/90 px-4 py-1.5 flex items-center gap-5 overflow-x-auto">
      {indices.map(({ name, d }) => {
        if (!d) return null;
        // Prefer pre-market when market is closed
        const pct =
          d.marketState === "PRE" && d.preMarketChangePercent != null ? d.preMarketChangePercent :
          d.marketState === "POST" && d.postMarketChangePercent != null ? d.postMarketChangePercent :
          d.changePercent;
        const price =
          d.marketState === "PRE" && d.preMarketPrice != null ? d.preMarketPrice :
          d.marketState === "POST" && d.postMarketPrice != null ? d.postMarketPrice :
          d.price;
        const isPos = (pct ?? 0) >= 0;
        const color = isPos ? "#16a34a" : "#dc2626";
        const isPre = d.marketState === "PRE";
        const isPost = d.marketState === "POST";
        const isStale = !d.isToday && d.marketState === "CLOSED";
        return (
          <div key={name} className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10px] font-bold text-gray-800/50 uppercase tracking-wider">{name}</span>
            {isPre && <span className="text-[8px] font-bold px-1 py-0.5 rounded-full bg-blue-100 text-blue-600 uppercase">טרום</span>}
            {isPost && <span className="text-[8px] font-bold px-1 py-0.5 rounded-full bg-purple-100 text-purple-600 uppercase">אחרי</span>}
            {price != null && (
              <span className={`text-[11px] font-semibold tabular-nums ${isStale ? "text-gray-400" : "text-gray-700"}`}>
                {price.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </span>
            )}
            {pct != null && (
              <span className="text-[11px] font-bold tabular-nums" style={{ color: isStale ? "#9ca3af" : color }}>
                {isPos ? "+" : ""}{pct.toFixed(2)}%
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
// ── Fear & Greed Widget ────────────────────────────────────────────────────────

// ── VIX Gauge ─────────────────────────────────────────────────────────────────
function VixGauge({ value, week52Low, week52High }: { value: number; week52Low: number; week52High: number }) {
  const MIN_VIX = 10, MAX_VIX = 40;
  const clamp = (v: number) => Math.max(MIN_VIX, Math.min(MAX_VIX, v));
  const toPercent = (v: number) => ((clamp(v) - MIN_VIX) / (MAX_VIX - MIN_VIX)) * 100;
  const pct = toPercent(value);
  const zone1End = toPercent(20);
  const zone2End = toPercent(30);
  const zones = [
    { from: 0,        to: zone1End, baseColor: "#d1fae5", activeColor: "#22c55e" },
    { from: zone1End, to: zone2End, baseColor: "#fef3c7", activeColor: "#f59e0b" },
    { from: zone2End, to: 100,      baseColor: "#fee2e2", activeColor: "#ef4444" },
  ];
  const safeIdx = pct < zone1End ? 0 : pct < zone2End ? 1 : 2;
  const activeColor = zones[safeIdx].activeColor;
  const cx = 100, cy = 90;
  const rOuter = 76, rInner = 44;
  const GAP_DEG = 1.5;
  function valToRad(v: number) {
    return ((-180 + (v / 100) * 180) * Math.PI) / 180;
  }
  function donutArc(fromV: number, toV: number, ro: number, ri: number, gapDeg = 0) {
    const gapRad = (gapDeg * Math.PI) / 180;
    const a1 = valToRad(fromV) + gapRad;
    const a2 = valToRad(toV) - gapRad;
    const large = (toV - fromV) > 50 ? 1 : 0;
    const ox1 = cx + ro * Math.cos(a1), oy1 = cy + ro * Math.sin(a1);
    const ox2 = cx + ro * Math.cos(a2), oy2 = cy + ro * Math.sin(a2);
    const ix1 = cx + ri * Math.cos(a2), iy1 = cy + ri * Math.sin(a2);
    const ix2 = cx + ri * Math.cos(a1), iy2 = cy + ri * Math.sin(a1);
    return `M ${ox1} ${oy1} A ${ro} ${ro} 0 ${large} 1 ${ox2} ${oy2} L ${ix1} ${iy1} A ${ri} ${ri} 0 ${large} 0 ${ix2} ${iy2} Z`;
  }
  const needleRad = valToRad(pct);
  const needleLen = rOuter - 4;
  const nx = cx + needleLen * Math.cos(needleRad);
  const ny = cy + needleLen * Math.sin(needleRad);
  const tickVixValues = [10, 20, 30, 40];
  const vixLabel = value < 20 ? "נמוך (רגוע)" : value < 30 ? "בינוני (ממוצע)" : "גבוה (מתוח)";
  return (
    <div className="mt-0 mx-2 rounded-xl border border-[#2563EB]/30 bg-white shadow-md overflow-hidden">
      <div className="px-3 py-3 flex items-center gap-4">
        <div className="flex-shrink-0">
          <svg viewBox="0 0 200 100" width="120" height="60" style={{ overflow: "visible" }}>
            {zones.map((zone, i) => (
              <path key={zone.from} d={donutArc(zone.from, zone.to, rOuter, rInner, GAP_DEG)}
                fill={i === safeIdx ? zone.activeColor : zone.baseColor}
                opacity={i === safeIdx ? 1 : 0.6} />
            ))}
            {tickVixValues.map(v => {
              const p = toPercent(v);
              const a = valToRad(p);
              const tr = rOuter + 8;
              return (
                <text key={v} x={cx + tr * Math.cos(a)} y={cy + tr * Math.sin(a)}
                  textAnchor="middle" dominantBaseline="middle"
                  fontSize="9" fill="#6b7280" fontFamily="sans-serif" fontWeight="600">{v}</text>
              );
            })}
            <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#111" strokeWidth={2.5} strokeLinecap="round" />
            <circle cx={cx} cy={cy} r={6} fill="#333" />
            <circle cx={cx} cy={cy} r={3} fill="#111" />
            <text x={cx} y={cy + 14} textAnchor="middle" fontSize="20" fontWeight="900"
              fill={activeColor} fontFamily="sans-serif">{value.toFixed(2)}</text>
          </svg>
        </div>
        <div className="flex flex-col justify-center min-w-0">
          <div className="text-[10px] font-semibold text-gray-800/50 uppercase tracking-widest">מד &quot;מהירות הפחד&quot; — VIX</div>
          <div className="font-bold text-base mt-0.5" style={{ color: activeColor }}>{vixLabel}</div>
          <div className="text-[9px] text-gray-500 mt-0.5">
            טווח 52 שבועות: {week52Low.toFixed(2)} – {week52High.toFixed(2)}
          </div>
          <div className="flex gap-2 mt-1">
            <span className="flex items-center gap-0.5 text-[8px] text-gray-500">
              <span className="w-2 h-2 rounded-full inline-block" style={{ background: "#22c55e" }} />נמוך &lt;20
            </span>
            <span className="flex items-center gap-0.5 text-[8px] text-gray-500">
              <span className="w-2 h-2 rounded-full inline-block" style={{ background: "#f59e0b" }} />בינוני 20–30
            </span>
            <span className="flex items-center gap-0.5 text-[8px] text-gray-500">
              <span className="w-2 h-2 rounded-full inline-block" style={{ background: "#ef4444" }} />גבוה ≥30
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── VIX Widget (for PortfolioOverview) ────────────────────────────────────────
function VixWidget() {
  const { data, isLoading } = trpc.splash.getMarketData.useQuery(undefined, {
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const vix = data?.vix;
  if (isLoading || !vix) return null;
  return <VixGauge value={vix.value} week52Low={vix.week52Low} week52High={vix.week52High} />;
}

function FearGreedWidget() {
  const { data, isLoading } = trpc.splash.getMarketData.useQuery(undefined, {
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const fng = data?.fearAndGreed;

  function fngLabel(v: number): string {
    if (v <= 25) return "פחד קיצוני";
    if (v <= 45) return "פחד";
    if (v <= 55) return "ניטרלי";
    if (v <= 75) return "חמדנות";
    return "חמדנות קיצונית";
  }

  if (isLoading) return null;
  if (!fng) return null;

  const label = fngLabel(fng.value);
  const value = fng.value;

  // Mini CNN-style gauge SVG
  const zones = [
    { from: 0,  to: 25,  baseColor: "#d0d0d0", activeColor: "#e8a0a0" },
    { from: 25, to: 45,  baseColor: "#d0d0d0", activeColor: "#f0c060" },
    { from: 45, to: 55,  baseColor: "#d0d0d0", activeColor: "#c8c8c8" },
    { from: 55, to: 75,  baseColor: "#d0d0d0", activeColor: "#7dd4c8" },
    { from: 75, to: 100, baseColor: "#d0d0d0", activeColor: "#7dd4c8" },
  ];
  const activeZoneIdx = zones.findIndex(z => value >= z.from && value <= z.to);
  const cx = 100, cy = 90;
  const rOuter = 76, rInner = 44;
  const GAP_DEG = 1.5;

  function valToRad(v: number) {
    return ((-180 + (v / 100) * 180) * Math.PI) / 180;
  }
  function donutArc(fromV: number, toV: number, ro: number, ri: number, gapDeg = 0) {
    const gapRad = (gapDeg * Math.PI) / 180;
    const a1 = valToRad(fromV) + gapRad;
    const a2 = valToRad(toV) - gapRad;
    const large = (toV - fromV) > 50 ? 1 : 0;
    const ox1 = cx + ro * Math.cos(a1), oy1 = cy + ro * Math.sin(a1);
    const ox2 = cx + ro * Math.cos(a2), oy2 = cy + ro * Math.sin(a2);
    const ix1 = cx + ri * Math.cos(a2), iy1 = cy + ri * Math.sin(a2);
    const ix2 = cx + ri * Math.cos(a1), iy2 = cy + ri * Math.sin(a1);
    return `M ${ox1} ${oy1} A ${ro} ${ro} 0 ${large} 1 ${ox2} ${oy2} L ${ix1} ${iy1} A ${ri} ${ri} 0 ${large} 0 ${ix2} ${iy2} Z`;
  }
  const needleRad = valToRad(value);
  const needleLen = rOuter - 4;
  const nx = cx + needleLen * Math.cos(needleRad);
  const ny = cy + needleLen * Math.sin(needleRad);

  return (
    <div className="mt-2 mx-2 rounded-xl border border-[#2563EB]/30 bg-white shadow-md overflow-hidden">
      <div className="px-3 py-3 flex items-center gap-4">
        {/* Mini gauge SVG */}
        <div className="flex-shrink-0">
          <svg viewBox="0 0 200 100" width="120" height="60" style={{ overflow: "visible" }}>
            {zones.map((zone, i) => (
              <path
                key={zone.from}
                d={donutArc(zone.from, zone.to, rOuter, rInner, GAP_DEG)}
                fill={i === activeZoneIdx ? zone.activeColor : zone.baseColor}
                opacity={i === activeZoneIdx ? 1 : 0.5}
              />
            ))}
            <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#111" strokeWidth={2.5} strokeLinecap="round" />
            <circle cx={cx} cy={cy} r={6} fill="#333" />
            <circle cx={cx} cy={cy} r={3} fill="#111" />
            <text x={cx} y={cy + 14} textAnchor="middle" fontSize="20" fontWeight="900"
              fill="#222" fontFamily="sans-serif">{value}</text>
          </svg>
        </div>
        {/* Text info */}
        <div className="flex flex-col justify-center min-w-0">
          <div className="text-[10px] font-semibold text-gray-800/50 uppercase tracking-widest">Fear &amp; Greed Index</div>
          <div className="font-bold text-base mt-0.5 text-gray-700">{label}</div>
          {fng.lastUpdated && (
            <div className="text-[9px] text-gray-400 mt-0.5">Last updated {fng.lastUpdated}</div>
          )}
          <div className="text-[9px] text-gray-800/30 mt-0.5">מקור: CNN Business</div>
        </div>
      </div>
    </div>
  );
}


// ── Portfolio Row Item ─────────────────────────────────────────────────────────
function PortfolioRowItem({ row }: { row: PortfolioRow }) {
  if (!isVisiblePortfolioRow(row)) return null;

  const todayPositive = row.todayDollar == null ? null : row.todayDollar >= 0;
  const totalPositive = row.totalDollar >= 0;
  const [, navigate] = useLocation();

  // Only H1, H2 TASE, H2 USA, H2 Crypto are navigable (not Cash)
  const isNavigable = row.id !== "cash";

  function handleClick() {
    if (isNavigable) navigate(`/portfolio/${row.id}`);
  }

  return (
    <div
      className={cn(
        "grid grid-cols-[1fr_5.5rem_4.5rem_4.5rem] gap-x-1 px-3 py-3 items-start transition-colors",
        isNavigable ? "cursor-pointer hover:bg-[#2563EB]/10 active:bg-[#2563EB]/20" : "hover:bg-white/5"
      )}
      onClick={handleClick}
    >
      {/* Name + count */}
      <div className="flex items-center gap-1">
        <div>
          <div className="font-bold text-lg text-gray-800 leading-tight">{row.name}</div>
          <div className="text-sm text-gray-800/40 mt-0.5">
            {row.count} {row.count === 1 ? "position" : "positions"}
          </div>
        </div>
        {isNavigable && <ChevronRight className="w-4 h-4 text-[#2563EB]/50 flex-shrink-0 ml-auto" />}
      </div>

      {/* Value / Cost */}
      <div className="text-right">
        <div className="font-semibold text-lg text-gray-800">{fmtUsd(row.value)}</div>
        <div className="text-sm text-gray-800/40">{fmtUsd(row.cost)}</div>
      </div>

      {/* Today */}
      <div className="text-right">
        {row.id === "cash" ? (
          <>
            <div className="font-bold text-xl text-gray-800/40">&mdash;</div>
            <div className="text-sm font-semibold text-gray-800/40">+0</div>
          </>
        ) : (
          <>
            <div className={cn(
              "font-bold text-xl",
              row.todayDollar == null ? "text-gray-800/40"
              : todayPositive ? "text-[#65A30D]" : "text-[#FF6B6B]"
            )}>
              {row.todayDollar == null ? "\u2014" : fmtPct(row.todayPct)}
            </div>
            <div className={cn(
              "text-sm font-semibold",
              row.todayDollar == null ? "text-gray-800/40"
              : todayPositive ? "text-[#65A30D]" : "text-[#FF6B6B]"
            )}>
              {row.todayDollar == null ? "0" : fmtDollarChange(row.todayDollar)}
            </div>
          </>
        )}
      </div>

      {/* Total */}
      <div className="text-right">
        {row.id === "cash" ? (
          <>
            <div className="font-semibold text-lg text-gray-800/40">&mdash;</div>
            <div className="text-sm text-gray-800/40">+0</div>
          </>
        ) : (
          <>
            <div className={cn("font-semibold text-lg", totalPositive ? "text-[#65A30D]" : "text-[#FF6B6B]")}>
              {fmtPct(row.totalPct)}
            </div>
            <div className={cn("text-sm", totalPositive ? "text-[#65A30D]" : "text-[#FF6B6B]")}>
              {fmtDollarChange(row.totalDollar)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

