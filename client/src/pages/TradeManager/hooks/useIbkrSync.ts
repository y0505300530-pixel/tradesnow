/**
 * useIbkrSync
 * Manages IBKR connection state, IBIND session polling,
 * live positions query, account summary, and sync-to-DB mutations.
 */
import { useState, useRef, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

export function useIbkrSync(isAdmin: boolean, authLoading: boolean) {
  const utils = trpc.useUtils();

  // ── IBKR connection state ─────────────────────────────────────────────────
  const [ibkrStatus, setIbkrStatus] = useState<"disconnected" | "connecting" | "connected" | "error">("disconnected");
  const [ibkrAccountId, setIbkrAccountId] = useState<string | undefined>(undefined);

  // ── IBIND session gate state ──────────────────────────────────────────────
  const [ibindSessionChecked, setIbindSessionChecked] = useState(false);
  const [ibindSessionActive, setIbindSessionActive] = useState(false);
  const [ibindClosedReason, setIbindClosedReason] = useState<"manual" | "inactivity" | "daily" | null>(null);
  const [ibindClosedAt, setIbindClosedAt] = useState<string | null>(null);

  // ── IBKR settings ─────────────────────────────────────────────────────────
  const { data: ibkrSettings } = trpc.ibkr.getSettings.useQuery(undefined, { enabled: isAdmin });
  const ibkrGatewayUrl = ibkrSettings?.gatewayUrl ?? "https://localhost:5000";

  const stopSessionMutation = trpc.ibkr.stopSession.useMutation();

  // Poll IBIND session health every 30s
  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin) {
      setIbindSessionChecked(true);
      return;
    }
    const checkSession = async () => {
      // Timeout after 5 seconds — if IBIND/Gateway is down the fetch must not hang forever
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const r = await fetch("/api/ibind/health", { signal: controller.signal });
        clearTimeout(timer);
        const d = await r.json();
        // session_active can be boolean true OR string "true" depending on IBIND server version
        const active = (d.session_active === true || d.session_active === "true") && d.status === "ok";
        if (active && d.account_id) setIbkrAccountId(d.account_id);
        setIbkrStatus(active ? "connected" : "disconnected");
        setIbindSessionActive(active);
        if (!active && d.closed_reason) setIbindClosedReason(d.closed_reason);
        if (!active && d.closed_at) setIbindClosedAt(d.closed_at);
      } catch {
        clearTimeout(timer);
        // Network error or timeout — treat as disconnected, never block the UI
        setIbkrStatus("disconnected");
        setIbindSessionActive(false);
      } finally {
        setIbindSessionChecked(true);
      }
    };
    checkSession();
    const interval = setInterval(checkSession, 10_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, isAdmin]);

  // ── IBKR refetch interval (market-aware) ─────────────────────────────────
  const ibkrRefetchInterval = useMemo(() => {
    if (ibkrStatus !== "connected") return false as const;
    const now = new Date();
    const day = now.getUTCDay();
    if (day === 0 || day === 6) return 10 * 60_000;
    const month = now.getUTCMonth();
    const etOffsetHours = month >= 2 && month <= 10 ? 4 : 5;
    const etHour = now.getUTCHours() - etOffsetHours;
    const etMin = now.getUTCMinutes();
    const etMinutes = etHour * 60 + etMin;
    const isOpen = etMinutes >= 9 * 60 + 30 && etMinutes < 16 * 60;
    return isOpen ? 10_000 : 5 * 60_000;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ibkrStatus, Math.floor(Date.now() / 60_000)]);

  // ── IBKR live positions ───────────────────────────────────────────────────
  const { data: ibkrPositionsData, refetch: refetchIbkrPositions } = trpc.ibkr.getPositions.useQuery(
    undefined,
    {
      enabled: isAdmin && ibkrStatus === "connected",
      refetchInterval: ibkrRefetchInterval,
      staleTime: 8_000,
    }
  );

  // ── IBKR account summary ──────────────────────────────────────────
  const { data: ibkrSummaryData } = trpc.ibkr.getAccountSummary.useQuery(
    undefined,
    {
      enabled: isAdmin,
      refetchInterval: ibkrStatus === "connected" ? ibkrRefetchInterval : false,
      staleTime: ibkrStatus === "connected" ? 8_000 : 60_000,
    }
  );

  // ── IBKR /pnl — Today's P&L (dedicated endpoint, 30s polling when connected) ──
  // Returns: daily_pnl (Today P&L), unrealized_pnl, net_liquidation, market_value, excess_liquidity
  const { data: ibkrPnlData } = trpc.ibkr.getPnl.useQuery(
    undefined,
    {
      enabled: isAdmin && ibkrStatus === "connected",
      refetchInterval: ibkrStatus === "connected" ? 10_000 : false,
      staleTime: 8_000,
    }
  );

  // Build ticker → IBKR position map
  const ibkrPositionMap = useMemo(() => {
    const map: Record<string, {
      position: number; mktPrice: number; mktValue: number;
      avgCost: number; unrealizedPnl: number; conid?: number | null;
    }> = {};
    (ibkrPositionsData?.positions ?? []).forEach(p => { map[p.ticker] = p; });
    return map;
  }, [ibkrPositionsData]);

  // ── Journal event mutation ────────────────────────────────────────────────────────────────────────────
  const logJournalMut = trpc.portfolio.logJournalEvent.useMutation();
  // Daily snapshot is now handled in TradeManager.tsx (h2SnapshotMut) which includes h2Value.

  // ── Sync from IBKR mutation ────────────────────────────────────────────────────────────────────────────────────
  const syncFromIbkrMut = trpc.ibkr.syncFromIbkr.useMutation({
    onSuccess: (data) => {
      utils.portfolio.getState.invalidate();
      refetchIbkrPositions();
      // toast removed — no popup on sync
      logJournalMut.mutate({
        eventType: "sync",
        notes: `סנכרון מ-IBKR: ${data.upserted} עודכנו, ${data.inserted} נוספו, ${data.removed} הוסרו`,
      });
    },
    onError: () => {},
  });

  const handleSyncFromIbkr = () => {
    if (!ibkrPositionsData?.positions || ibkrPositionsData.positions.length === 0) {
      return;
    }
    syncFromIbkrMut.mutate({
      positions: ibkrPositionsData.positions,
      cashBalance: ibkrSummaryData?.summary?.totalCash ?? undefined,
    });
  };

  // ── Auto-sync on connect AND on every positions refresh ─────────────────
  // Syncs positions to DB whenever IBKR positions data changes (every 60s during market hours).
  // This ensures buy/sell trades during the session are reflected immediately without any manual action.
  const lastAutoSyncRef = useRef<number>(0);
  const prevIbkrStatusRef = useRef<string>("disconnected");
  // Sync on connect (first time)
  useEffect(() => {
    if (ibkrStatus === "connected" && prevIbkrStatusRef.current !== "connected") {
      const now = Date.now();
      if (now - lastAutoSyncRef.current > 10 * 60 * 1000) {
        lastAutoSyncRef.current = now;
        setTimeout(() => {
          refetchIbkrPositions().then((result) => {
            const positions = result.data?.positions;
            if (positions && positions.length > 0) {
              syncFromIbkrMut.mutate(
                { positions, cashBalance: ibkrSummaryData?.summary?.totalCash ?? undefined },
                {
                  onSuccess: () => {},
                  onError: () => {},
                }
              );
            }
          }).catch(() => {});
        }, 3000);
      }
    }
    prevIbkrStatusRef.current = ibkrStatus;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ibkrStatus]);
  // Sync on every positions refresh (every 60s during market hours)
  // This catches intra-session trades (buys/sells) automatically
  const prevPositionsSigRef = useRef<string>("");
  useEffect(() => {
    if (ibkrStatus !== "connected") return;
    const positions = ibkrPositionsData?.positions;
    if (!positions || positions.length === 0) return;
    // Build a signature: sorted tickers + quantities to detect real changes
    const sig = positions
      .map(p => `${p.ticker}:${p.position}`)
      .sort()
      .join(",");
    if (sig === prevPositionsSigRef.current) return; // no change — skip
    prevPositionsSigRef.current = sig;
    const now = Date.now();
    // Throttle: max once per 55s (positions refresh every 60s)
    if (now - lastAutoSyncRef.current < 55_000) return;
    lastAutoSyncRef.current = now;
    syncFromIbkrMut.mutate(
      { positions, cashBalance: ibkrSummaryData?.summary?.totalCash ?? undefined },
      { onSuccess: () => {}, onError: () => {} }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ibkrPositionsData]);

  // ── SL/TP sync mutation ───────────────────────────────────────────────────
  const syncSlTpMut = trpc.ibkr.syncSlTpOrderStatus.useMutation({
    onSuccess: (data) => {
      const anyChange = data.cleared > 0 || (data as any).populated > 0;
      if (anyChange) utils.portfolio.getState.invalidate();
      if (data.cleared > 0) {
        const tickers = data.details.map(d => `${d.ticker} (${d.field.toUpperCase()})`).join(", ");
        // toast removed — silent background sync
      }
      // toast removed — silent background sync
    },
  });

  // Run SL/TP sync once on IBKR connect, then every 5 minutes
  const lastSlTpSyncRef = useRef<number>(0);
  useEffect(() => {
    if (ibkrStatus !== "connected") return;
    const doSync = async () => {
      const now = Date.now();
      if (now - lastSlTpSyncRef.current < 5 * 60 * 1000) return;
      lastSlTpSyncRef.current = now;
      try {
        let activeOrderIds: string[] = [];
        let activeOrders: Array<{
          orderId: string; ticker?: string; symbol?: string;
          orderType?: string; side?: string; status?: string;
        }> = [];
        const ibindRes = await fetch("/api/ibind/orders").then(r => r.json()).catch(() => null);
        if (ibindRes?.orders) {
          const allOrders = ibindRes.orders as any[];
          const ACTIVE_STATUSES_AUTO = new Set(["presubmitted", "pendingsubmit", "submitted", "presubmit"]);
          const activeOnly = allOrders.filter((o: any) => {
            const st = (o.status ?? o.orderStatus ?? "").toLowerCase();
            return ACTIVE_STATUSES_AUTO.has(st) || st === "";
          });
          activeOrderIds = activeOnly
            .map((o: any) => String(o.orderId ?? o.order_id ?? o.ibkrOrderId ?? ""))
            .filter(Boolean);
          activeOrders = activeOnly.map((o: any) => ({
            orderId: String(o.orderId ?? o.order_id ?? o.ibkrOrderId ?? ""),
            ticker: o.ticker ?? o.symbol ?? o.description ?? undefined,
            symbol: o.symbol ?? o.ticker ?? undefined,
            orderType: o.orderType ?? o.order_type ?? o.type ?? undefined,
            side: o.side ?? o.action ?? undefined,
            status: o.status ?? o.orderStatus ?? undefined,
          })).filter((o: any) => o.orderId);
        }
        syncSlTpMut.mutate({ activeOrderIds, activeOrders });
      } catch {
        // silently ignore — sync is best-effort
      }
    };
    doSync();
    const interval = setInterval(doSync, 5 * 60 * 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ibkrStatus, ibkrSettings?.gatewayUrl, ibkrSettings?.accountId]);

  return {
    // Connection state
    ibkrStatus,
    setIbkrStatus,
    ibkrAccountId,
    setIbkrAccountId,
    // IBIND session gate
    ibindSessionChecked,
    ibindSessionActive,
    setIbindSessionActive,
    ibindClosedReason,
    ibindClosedAt,
    // Settings
    ibkrSettings,
    ibkrGatewayUrl,
    stopSessionMutation,
    // Data
    ibkrPositionsData,
    ibkrSummaryData,
    ibkrPnlData,
    ibkrPositionMap,
    refetchIbkrPositions,
    // Mutations
    syncFromIbkrMut,
    handleSyncFromIbkr,
    syncSlTpMut,
    logJournalMut,
  };
}
