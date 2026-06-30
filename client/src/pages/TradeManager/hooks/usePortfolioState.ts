/**
 * usePortfolioState
 * Manages the portfolio.getState tRPC query, ZIV H scores, auto-refresh interval,
 * and the "last refreshed" badge timer.
 *
 * v2 — IndexedDB persistence via idb-keyval:
 *   - On mount, immediately loads the last-known state from IndexedDB
 *     so the UI renders instantly without a loading spinner.
 *   - Every time fresh data arrives from the server, it is saved to IndexedDB.
 *   - ZIV H scores (H1 + H2) are also persisted separately.
 */
import { useState, useRef, useEffect, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import type { ZivHData } from "../types";
import { get as idbGet, set as idbSet } from "idb-keyval";

const IDB_KEY_STATE = "portfolio_state_v1";
const IDB_KEY_ZIVH = "portfolio_zivh_v1";
const IDB_KEY_ZIVH2 = "portfolio_zivh2_v1";

export function usePortfolioState() {
  // ── IndexedDB-seeded initial state ────────────────────────────────────────
  // Start with null; as soon as IDB resolves we set the cached value so the
  // component renders immediately while the network request is in-flight.
  const [cachedState, setCachedState] = useState<any>(null);
  const [cachedZivH, setCachedZivH] = useState<any[]>([]);
  const [cachedZivH2, setCachedZivH2] = useState<any[]>([]);
  const idbLoadedRef = useRef(false);

  useEffect(() => {
    if (idbLoadedRef.current) return;
    idbLoadedRef.current = true;
    // Load all three caches in parallel
    Promise.all([
      idbGet(IDB_KEY_STATE),
      idbGet(IDB_KEY_ZIVH),
      idbGet(IDB_KEY_ZIVH2),
    ]).then(([s, z, z2]) => {
      if (s) setCachedState(s);
      if (z) setCachedZivH(z);
      if (z2) setCachedZivH2(z2);
    }).catch(() => {/* silently ignore IDB errors */});
  }, []);

  // ── Auto-refresh interval (0 = off) ──────────────────────────────────────
  const [autoRefreshInterval, setAutoRefreshInterval] = useState<number>(0);
  const autoRefreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const utils = trpc.useUtils();

  // Auto-refresh effect: invalidate state on the selected interval
  useEffect(() => {
    if (autoRefreshIntervalRef.current) clearInterval(autoRefreshIntervalRef.current);
    if (autoRefreshInterval > 0) {
      autoRefreshIntervalRef.current = setInterval(() => {
        utils.portfolio.getState.invalidate();
      }, autoRefreshInterval);
    }
    return () => {
      if (autoRefreshIntervalRef.current) clearInterval(autoRefreshIntervalRef.current);
    };
  }, [autoRefreshInterval]);

  // ── Main portfolio state query ────────────────────────────────────────────
  const { data: liveState, isLoading: liveLoading, refetch: refetchState } = trpc.portfolio.getState.useQuery(
    undefined,
    {
      refetchInterval: 60000,
      refetchOnMount: true,
      // staleTime: show cached data instantly for up to 5 minutes before background refetch
      staleTime: 5 * 60_000,
      // Use cached data as placeholder so the UI is not blank while loading
      placeholderData: cachedState ?? undefined,
    }
  );

  // Persist fresh server data to IndexedDB whenever it arrives
  useEffect(() => {
    if (liveState) {
      idbSet(IDB_KEY_STATE, liveState).catch(() => {});
      // Update cached state so placeholderData stays fresh
      setCachedState(liveState);
    }
  }, [liveState]);

  // Merge: prefer live data, fall back to cached
  const state = liveState ?? cachedState;
  const isLoading = liveLoading && !cachedState;

   // ── ZIV H Health Scores (H1) ───────────────────────────────────────────
  const [isRefreshingZivH, setIsRefreshingZivH] = useState(false);
  const { data: liveZivH, refetch: refetchZivH } = trpc.portfolio.getZivHScores.useQuery(
    undefined,
    {
      staleTime: 5 * 60 * 1000,
      refetchOnMount: true,
      placeholderData: cachedZivH.length > 0 ? cachedZivH : undefined,
    }
  );
  useEffect(() => {
    if (liveZivH && liveZivH.length > 0) {
      idbSet(IDB_KEY_ZIVH, liveZivH).catch(() => {});
      setCachedZivH(liveZivH);
    }
  }, [liveZivH]);
  const zivHScores = liveZivH ?? cachedZivH;

  // Clears IDB cache and forces a fresh fetch from the server
  const refreshZivH = async () => {
    setIsRefreshingZivH(true);
    try {
      await Promise.all([
        idbSet(IDB_KEY_ZIVH, []).catch(() => {}),
        idbSet(IDB_KEY_ZIVH2, []).catch(() => {}),
      ]);
      setCachedZivH([]);
      setCachedZivH2([]);
      await refetchZivH();
    } finally {
      setIsRefreshingZivH(false);
    }
  };

  const zivHMap = useMemo(() => {
    const m: Record<number, ZivHData & object> = {};
    if (zivHScores) for (const s of zivHScores) m[s.id] = s;
    return m;
  }, [zivHScores]);

  // Ticker-keyed fallback — used when IBKR positions have negative/unknown DB ids
  const zivHByTicker = useMemo(() => {
    const m: Record<string, ZivHData & object> = {};
    if (zivHScores) for (const s of zivHScores) m[s.ticker.toUpperCase()] = s;
    return m;
  }, [zivHScores]);

  // ── ZIV H Health Scores (H2) ─────────────────────────────────────────────
  const { data: liveZivH2 } = trpc.portfolio.getZivHScoresH2.useQuery(
    undefined,
    {
      staleTime: 5 * 60 * 1000,
      refetchOnMount: true,
      placeholderData: cachedZivH2.length > 0 ? cachedZivH2 : undefined,
    }
  );
  useEffect(() => {
    if (liveZivH2 && liveZivH2.length > 0) {
      idbSet(IDB_KEY_ZIVH2, liveZivH2).catch(() => {});
      setCachedZivH2(liveZivH2);
    }
  }, [liveZivH2]);
  const zivHScoresH2 = liveZivH2 ?? cachedZivH2;

  const zivHMapH2 = useMemo(() => {
    const m: Record<number, ZivHData & object> = {};
    if (zivHScoresH2) for (const s of zivHScoresH2) m[s.id] = s;
    return m;
  }, [zivHScoresH2]);

  // ── Last refreshed badge ──────────────────────────────────────────────────
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [minutesSinceRefresh, setMinutesSinceRefresh] = useState<number>(0);

  useEffect(() => {
    const tick = () => {
      if (lastRefreshedAt) {
        setMinutesSinceRefresh(Math.floor((Date.now() - lastRefreshedAt.getTime()) / 60000));
      }
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, [lastRefreshedAt]);

  return {
    state,
    isLoading,
    refetchState,
    zivHMap,
    zivHByTicker,
    zivHMapH2,
    autoRefreshInterval,
    setAutoRefreshInterval,
    lastRefreshedAt,
    setLastRefreshedAt,
    minutesSinceRefresh,
    setMinutesSinceRefresh,
    refreshZivH,
    isRefreshingZivH,
  };
}
