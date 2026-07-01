/**
 * usePortfolioAnalytics — Application-wide Portfolio SSOT
 *
 * v16.25 — This hook is the single source of truth for ALL portfolio data and math.
 *
 * It combines:
 *   1. usePortfolioState   — H1 holdings + ZIV H scores (IndexedDB-cached)
 *   2. H2 holdings query   — trpc.holding2.list
 *   3. IBKR connection     — /api/ibind/health (30s polling, same as TradeManager)
 *   4. IBKR account data   — trpc.ibkr.getAccountSummary + trpc.ibkr.getPnl
 *   5. useIbkrMarketData   — 60s IBKR price pulse for H1 + H2 (same as TradeManager)
 *   6. usePortfolioMetrics — all math (H1/H2/Unified value, P&L, Today P&L)
 *
 * Both TradeManager and H1H2Dashboard MUST consume this hook.
 * Any change to the math propagates to both pages instantly.
 *
 * Definitions (locked):
 *   H1 Value      = Σ(livePrice × units) — grossPositionValue NOT used (includes margin debt)
 *   H1 NLV        = IBKR netLiquidation when live, else H1 Value + Cash
 *   H2 Value      = Σ(ibkrLivePrice ?? dbCurrentPrice ?? buyPrice × units)
 *   Unified Value = H1 NLV + H2 Value   ← identical everywhere
 *   Today P&L     = IBKR /pnl dailyPnl (H1) + prevClose-based calc (H2)
 *   Total P&L     = currentValue − costBasis
 */

import { useState, useEffect, useMemo, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { usePortfolioState } from "@/pages/TradeManager/hooks/usePortfolioState";
import { useIbkrMarketData, type IbkrPriceEntry } from "@/hooks/useIbkrMarketData";
import { usePortfolioMetrics, computeTodayPnl, type PortfolioMetrics } from "@/hooks/usePortfolioMetrics";
import { useIbkrRefresh } from "@/contexts/IbkrRefreshContext";
import { useIbkrTickle } from "@/contexts/IbkrTickleContext";
import { useAuth } from "@/_core/hooks/useAuth";
import { isTaseClosedToday, isUsMarketClosedNow } from "@/lib/marketStatus";
import {
  positionCost,
  positionTotalPnl,
  positionValue,
} from "@/lib/positionMath";
import type { ZivHData } from "@/pages/TradeManager/types";

// ── Re-export for consumers ────────────────────────────────────────────────────
export type { PortfolioMetrics };

// ── Per-holding enriched row (for table rendering) ────────────────────────────
export interface H1Row {
  ticker: string;
  company: string | null;
  buyPrice: number;
  units: number;
  livePrice: number | null;
  change: number | null;
  changePercent: number | null;
  prevClose: number | null;
  value: number;
  cost: number;
  pnl: number;
  pnlPct: number;
  todayPnl: number;
  weight: number; // % of unified value
  zivScore: number | null;
  // Pass-through DB fields needed by TradeManager
  id: number;
  stopLoss: number | null;
  takeProfit: number | null;
  notes: string | null;
  conid: number | null;
  ibkrSlOrderId: string | null;
  ibkrTpOrderId: string | null;
  dailyChangePercent: number | null;
  currentPrice: number | null;
}

export interface H2Row {
  ticker: string;
  company: string | null;
  buyPrice: number;
  units: number;
  livePrice: number | null;
  change: number | null;
  changePercent: number | null;
  prevClose: number | null;
  value: number;
  cost: number;
  pnl: number;
  pnlPct: number;
  todayPnl: number;
  weight: number; // % of unified value
  zivScore: number | null;
  // Pass-through DB fields
  id: number;
  currentPrice: number | null;
  dailyChangePercent: number | null;
}

export interface PortfolioAnalyticsResult {
  // ── Raw data ──────────────────────────────────────────────────────────────
  /** H1 holdings with live prices merged in */
  h1Rows: H1Row[];
  /** H2 holdings (units > 0) with live prices merged in */
  h2Rows: H2Row[];

  // ── SSOT metrics (identical to TradeManager) ──────────────────────────────
  metrics: PortfolioMetrics;

  // ── IBKR state ────────────────────────────────────────────────────────────
  ibkrConnected: boolean;
  /** IBKR gross position value (H1 equity) */
  displayPortfolioValue: number | null;
  /** IBKR net liquidation (H1 NLV) */
  displayNLV: number | null;
  /** Today P&L from IBKR /pnl endpoint */
  ibkrTodayPnl: number | null;
  /** Cash balance */
  cashBalance: number;
  /** Whether account summary data is live (not cached) */
  summaryIsLive: boolean;

  // ── ZIV H scores ──────────────────────────────────────────────────────────
  zivHMap: Record<number, ZivHData & object>;
  zivHByTicker: Record<string, ZivHData & object>;
  zivHMapH2: Record<number, ZivHData & object>;

  // ── Price maps (for components that need raw prices) ──────────────────────
  h1PriceMap: Record<string, IbkrPriceEntry>;
  h2PriceMap: Record<string, IbkrPriceEntry>;

  // ── Loading state ─────────────────────────────────────────────────────────
  isLoading: boolean;
  /** Timestamp of last IBKR price update */
  lastUpdated: number;
}

// ── Today P&L for a single position — consolidated: uses the single owner `computeTodayPnl`
// (from usePortfolioMetrics) which includes the intraday-entry override + staleness guard.
// The old local `todayPnlForRow` was removed to prevent the two copies from diverging.

// ── Main hook ─────────────────────────────────────────────────────────────────
export function usePortfolioAnalytics(): PortfolioAnalyticsResult {
  const { notifyUpdated } = useIbkrRefresh();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  // ── 1. Portfolio state (H1 holdings + ZIV H) ──────────────────────────────
  const {
    state,
    isLoading: stateLoading,
    zivHMap,
    zivHByTicker,
    zivHMapH2,
  } = usePortfolioState();

  // ── 2. H2 holdings ────────────────────────────────────────────────────────
  const { data: h2Data, isLoading: h2Loading } = trpc.holding2.list.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnMount: "always",
  });

  // ── 3. IBKR connection — reuse IbkrTickleContext instead of polling again ────
  const { ibindConnected: ibkrConnected } = useIbkrTickle();

  // ── 4. IBKR account data ──────────────────────────────────────────────────
  const ibkrRefetchInterval = ibkrConnected ? 30_000 : (false as const);

  const { data: ibkrSummaryData } = trpc.ibkr.getAccountSummary.useQuery(undefined, {
    enabled: ibkrConnected,
    staleTime: 25_000,
    refetchOnMount: "always",
    refetchInterval: ibkrRefetchInterval,
  });

  const { data: ibkrPnlData } = trpc.ibkr.getPnl.useQuery(undefined, {
    enabled: ibkrConnected,
    staleTime: 25_000,
    refetchOnMount: "always",
    refetchInterval: ibkrRefetchInterval,
  });
  const { data: ibkrPositionsData } = trpc.ibkr.getPositions.useQuery(undefined, {
    enabled: isAdmin && ibkrConnected,
    staleTime: 8_000,
    refetchInterval: ibkrRefetchInterval,
  });

  // ── 5. Tickers ────────────────────────────────────────────────────────────
  const dbH1Holdings = useMemo(() => (state?.holdings ?? []) as any[], [state?.holdings]);
  const h1Holdings = useMemo(() => {
    if (!isAdmin || !ibkrConnected || !ibkrPositionsData?.positions?.length) {
      return dbH1Holdings;
    }
    const dbByTicker: Record<string, any> = {};
    dbH1Holdings.forEach((h: any) => {
      dbByTicker[String(h.ticker ?? "").toUpperCase()] = h;
    });
    return ibkrPositionsData.positions.map((p: any, idx: number) => {
      const db = dbByTicker[String(p.ticker ?? "").toUpperCase()] ?? null;
      const avgCost = p.avgCost ?? 0;
      const mktPrice = p.mktPrice ?? null;
      return {
        ...db,
        id: db?.id ?? -(idx + 1),
        ticker: p.ticker,
        company: db?.company ?? null,
        buyPrice: avgCost,
        units: p.position ?? 0,
        currentPrice: mktPrice ?? db?.currentPrice ?? null,
        dailyChangePercent: db?.dailyChangePercent ?? null,
        stopLoss: db?.stopLoss ?? null,
        takeProfit: db?.takeProfit ?? null,
        notes: db?.notes ?? null,
        conid: p.conid ?? db?.conid ?? null,
        ibkrSlOrderId: db?.ibkrSlOrderId ?? null,
        ibkrTpOrderId: db?.ibkrTpOrderId ?? null,
        priceUpdatedAt: new Date().toISOString(),
        transactionDate: db?.transactionDate ?? null,
        createdAt: db?.createdAt ?? new Date(),
        dailyBasePrice: db?.dailyBasePrice ?? null,
        dailyBaseTs: db?.dailyBaseTs ?? null,
        _ibkrUnrealizedPnl: p.unrealizedPnl ?? null,
      };
    });
  }, [dbH1Holdings, ibkrConnected, ibkrPositionsData, isAdmin]);
  const h1Tickers = useMemo(
    () => h1Holdings.map((h: any) => h.ticker),
    [h1Holdings.map((h: any) => h.ticker).join(',')]
  );
  const h2Active = useMemo(
    () => (h2Data ?? []).filter((h: any) => h.units !== 0),
    [(h2Data ?? []).filter((h: any) => h.units !== 0).map((h: any) => h.ticker).join(',')]
  );
  const h2Tickers = useMemo(
    () => h2Active.map((h: any) => h.ticker),
    [h2Active.map((h: any) => h.ticker).join(',')]
  );

  // ── 6. IBKR Market Data (60s pulse — identical to TradeManager) ───────────
  const {
    h1PriceMap: ibkrH1Map,
    h2PriceMap: ibkrH2Map,
    lastUpdated,
  } = useIbkrMarketData({
    h1Tickers,
    h2Tickers,
    catalogueTickers: [],
    ibkrConnected,
  });

  // Notify global refresh context
  useEffect(() => { if (lastUpdated) notifyUpdated(lastUpdated); }, [lastUpdated]);

  // ── 6b. Auto-refresh H2 prices on mount (same pattern as TradeManager) ──
  const h2RefreshMut = trpc.holding2.refreshPrices.useMutation();
  const h2AutoRefreshedRef = useRef(false);
  useEffect(() => {
    if (h2AutoRefreshedRef.current) return;
    if (!h2Data || h2Data.length === 0) return;
    if (h2RefreshMut.isPending) return;
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const now = Date.now();
    const needsRefresh = h2Data.some((r: any) => {
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

  // ── 6c. Persist IBKR live prices to DB when received ──────────────────────
  // When IBKR returns fresh prices, save them to DB so that next page load
  // (even without IBKR) shows recent values instead of stale/zero prices.
  const h2PersistMut = trpc.holding2.updateCurrentPrices.useMutation();
  const h2PersistRef = useRef<string>("");
  useEffect(() => {
    if (!ibkrConnected) return;
    const entries = Object.entries(ibkrH2Map);
    if (entries.length === 0) return;
    // Build a fingerprint to avoid re-persisting same data
    const fp = entries.map(([s, q]) => `${s}:${(q as any)?.price}`).join(',');
    if (fp === h2PersistRef.current) return;
    h2PersistRef.current = fp;
    // Send prices to DB
    const prices = entries
      .filter(([, q]) => (q as any)?.price != null && (q as any).price > 0)
      .map(([sym, q]) => ({
        ticker: sym,
        price: (q as any).price as number,
        prevClose: (q as any).prevClose as number | null,
        changePercent: (q as any).changePercent as number | null,
      }));
    if (prices.length > 0) {
      h2PersistMut.mutate({ prices });
    }
  }, [ibkrConnected, ibkrH2Map]);

  // ── 7. Price maps (IBKR when connected, empty otherwise) ─────────────────
  const h1PriceMap = useMemo((): Record<string, IbkrPriceEntry> => {
    if (!ibkrConnected) return {};
    const map: Record<string, IbkrPriceEntry> = {};
    Object.entries(ibkrH1Map).forEach(([sym, q]) => { map[sym] = q as IbkrPriceEntry; });
    return map;
  }, [ibkrConnected, ibkrH1Map]);

  const h2PriceMap = useMemo((): Record<string, IbkrPriceEntry> => {
    if (!ibkrConnected) return {};
    const map: Record<string, IbkrPriceEntry> = {};
    Object.entries(ibkrH2Map).forEach(([sym, q]) => { map[sym] = q as IbkrPriceEntry; });
    return map;
  }, [ibkrConnected, ibkrH2Map]);

  // ── 8. IBKR account derived values (same formulas as TradeManager) ────────
  const summarySource = (ibkrSummaryData as any)?.source as string | undefined;
  const summaryIsLive = summarySource === "ibeam" || summarySource === "ibind";

  const account = state?.account as any;
  const displayPortfolioValue: number | null =
    ibkrSummaryData?.summary?.grossPositionValue ?? (account?.lastKnownNLV ?? null);
  const displayNLV: number | null =
    ibkrSummaryData?.summary?.netLiquidation ?? (account?.lastKnownNetLiquidation ?? null);

  const cachedPnlDate = account?.lastKnownNLVAt ? new Date(account.lastKnownNLVAt) : null;
  const cachedPnlIsToday = cachedPnlDate
    ? cachedPnlDate.toDateString() === new Date().toDateString()
    : false;
  const ibkrTodayPnl: number | null =
    ibkrPnlData?.dailyPnl ??
    ibkrSummaryData?.summary?.dailyPnl ??
    (cachedPnlIsToday ? (account?.lastKnownTodayPnl ?? null) : null);

  const cashBalance: number =
    ibkrSummaryData?.summary?.totalCash ?? (account?.lastKnownCash ?? account?.cashBalance ?? 0);

  // ── 9. usePortfolioMetrics — THE math SSOT ────────────────────────────────
  const metrics = usePortfolioMetrics({
    h1Holdings: h1Holdings.map((h: any) => ({
      ticker: h.ticker,
      units: h.units,
      buyPrice: h.buyPrice,
      currentPrice: h.currentPrice ?? null,
      dailyChangePercent: h.dailyChangePercent ?? null,
      dailyBasePrice: h.dailyBasePrice ?? null,
      dailyBaseTs: h.dailyBaseTs ?? null,
      priceUpdatedAt: h.priceUpdatedAt ?? null,
      ibkrUnrealizedPnl: h._ibkrUnrealizedPnl ?? null,
      transactionDate: h.transactionDate ?? null,
      createdAt: h.createdAt ?? null,
    })),
    h2Holdings: h2Active.map((h: any) => ({
      ticker: h.ticker,
      units: h.units,
      buyPrice: h.buyPrice,
      currentPrice: h.currentPrice ?? null,
      prevClose: h.prevClose ?? null,
      dailyChangePercent: h.dailyChangePercent ?? null,
      dailyBasePrice: h.dailyBasePrice ?? null,
      dailyBaseTs: h.dailyBaseTs ?? null,
      priceUpdatedAt: h.priceUpdatedAt ?? null,
    })),
    h1LivePriceMap: h1PriceMap,
    h2LivePriceMap: h2PriceMap,
    ibkr: {
      grossPositionValue: displayPortfolioValue,
      netLiquidation: displayNLV,
      dailyPnl: ibkrTodayPnl,
      totalCash: cashBalance,
      isLive: summaryIsLive,
    },
    cashBalance,
  });

  // ── 10. Build enriched H1 rows ────────────────────────────────────────────
  const unifiedValue = metrics.unifiedValue || 1;

  const h1Rows = useMemo((): H1Row[] => {
    const usClosedNow = isUsMarketClosedNow();
    return h1Holdings
      .filter((h: any) => h.units !== 0)
      .map((h: any) => {
        const live = h1PriceMap[h.ticker] as IbkrPriceEntry | undefined;
        const livePrice = live?.price ?? h.currentPrice ?? h.buyPrice;
        const cost = positionCost(h.buyPrice, h.units);
        const value = positionValue(livePrice, h.units);
        const pnl = positionTotalPnl(livePrice, h.buyPrice, h.units);
        const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
        // H1 is all US stocks — force 0 when US market fully closed
        const todayPnl = usClosedNow ? 0 : computeTodayPnl(h.units, h.buyPrice, h.currentPrice, live, h.dailyChangePercent, h.priceUpdatedAt, h.dailyBasePrice, h.dailyBaseTs, undefined, h.transactionDate, h.createdAt);
        const zivEntry = zivHMap[h.id] ?? zivHByTicker[h.ticker?.toUpperCase()];
        return {
          ticker: h.ticker,
          company: h.company ?? null,
          buyPrice: h.buyPrice,
          units: h.units,
          livePrice: live?.price ?? null,
          change: live?.change ?? null,
          changePercent: live?.changePercent ?? null,
          prevClose: live?.prevClose ?? null,
          value,
          cost,
          pnl,
          pnlPct,
          todayPnl,
          weight: (value / unifiedValue) * 100,
          zivScore: (zivEntry as any)?.score ?? null,
          // DB pass-through
          id: h.id,
          stopLoss: h.stopLoss ?? null,
          takeProfit: h.takeProfit ?? null,
          notes: h.notes ?? null,
          conid: (h as any).conid ?? null,
          ibkrSlOrderId: h.ibkrSlOrderId ?? null,
          ibkrTpOrderId: h.ibkrTpOrderId ?? null,
          dailyChangePercent: live?.changePercent ?? h.dailyChangePercent ?? null,
          currentPrice: live?.price ?? h.currentPrice ?? null,
        };
      });
  }, [h1Holdings, h1PriceMap, zivHMap, zivHByTicker, unifiedValue]);

  // ── 11. Build enriched H2 rows ────────────────────────────────────────────
  const h2Rows = useMemo((): H2Row[] => {
    const usClosedNow = isUsMarketClosedNow();
    const taseClosedNow = isTaseClosedToday();
    return h2Active.map((h: any) => {
      const live = h2PriceMap[h.ticker] as IbkrPriceEntry | undefined;
      const livePrice = live?.price ?? h.currentPrice ?? h.buyPrice;
      const cost = positionCost(h.buyPrice, h.units);
      const value = positionValue(livePrice, h.units);
      const pnl = positionTotalPnl(livePrice, h.buyPrice, h.units);
      const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
      // Market-state-aware Today PnL:
      // - .TA tickers: 0 when TASE closed
      // - US tickers: 0 when US market fully closed
      // - Crypto (-USD): always compute (24/7)
      const isTaTicker = h.ticker?.toUpperCase().endsWith('.TA');
      const isCryptoTicker = h.ticker?.toUpperCase().endsWith('-USD');
      let todayPnl = 0;
      if (isTaTicker && taseClosedNow) {
        const hasDailyBaseline =
          live?.change != null
          || (live?.prevClose != null && live.prevClose > 0)
          || (live?.changePercent != null && live.changePercent !== 0)
          || (h.dailyBasePrice != null && h.dailyBasePrice > 0);
        todayPnl = hasDailyBaseline
          ? computeTodayPnl(h.units, h.buyPrice, h.currentPrice, live, h.dailyChangePercent, h.priceUpdatedAt, h.dailyBasePrice, h.dailyBaseTs, undefined, h.transactionDate, h.createdAt)
          : 0;
      } else if (!isTaTicker && !isCryptoTicker && usClosedNow) {
        todayPnl = 0;
      } else {
        todayPnl = computeTodayPnl(h.units, h.buyPrice, h.currentPrice, live, h.dailyChangePercent, h.priceUpdatedAt, h.dailyBasePrice, h.dailyBaseTs, undefined, h.transactionDate, h.createdAt);
      }
      const zivEntry = zivHMapH2[h.id];
      return {
        ticker: h.ticker,
        company: h.company ?? null,
        buyPrice: h.buyPrice,
        units: h.units,
        livePrice: live?.price ?? null,
        change: live?.change ?? null,
        changePercent: live?.changePercent ?? null,
        prevClose: live?.prevClose ?? null,
        value,
        cost,
        pnl,
        pnlPct,
        todayPnl,
        weight: (value / unifiedValue) * 100,
        zivScore: (zivEntry as any)?.score ?? null,
        id: h.id,
        currentPrice: live?.price ?? h.currentPrice ?? null,
        dailyChangePercent: live?.changePercent ?? h.dailyChangePercent ?? null,
      };
    });
  }, [h2Active, h2PriceMap, zivHMapH2, unifiedValue]);

  return {
    h1Rows,
    h2Rows,
    metrics,
    ibkrConnected,
    displayPortfolioValue,
    displayNLV,
    ibkrTodayPnl,
    cashBalance,
    summaryIsLive,
    zivHMap,
    zivHByTicker,
    zivHMapH2,
    h1PriceMap,
    h2PriceMap,
    isLoading: stateLoading || h2Loading,
    lastUpdated,
  };
}
