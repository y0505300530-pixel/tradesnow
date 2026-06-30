/**
 * IBKRPanel — Interactive Brokers Client Portal Gateway integration (iBeam)
 *
 * Architecture: iBeam Docker container manages the IBKR gateway and headless login.
 * User's only manual action: approve one push notification per day from iBeam.
 *
 * Simplified Connect Flow (v12.34):
 *   1. Click "Resume iBeam" → POST /api/ibkr-proxy/resume (docker start)
 *   2. Wait 3s for gateway to initialise
 *   3. ONE push attempt: POST /iserver/auth/ssodh/init → await auth/status
 *   4. If authenticated=true → Connected ✅
 *   5. If not authenticated → Failed ❌ — "Click Resume to try again"
 *   ZERO auto-retries, ZERO polling loops, ZERO repeated pushes.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Loader2, Wifi, WifiOff, RefreshCw, AlertTriangle, CheckCircle2,
  X, Activity, ShieldAlert, Heart, Clock, Bell, Terminal,
  ChevronDown, ChevronUp, Copy, Check, Maximize2, Minimize2,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { ibkrClient, type IbkrAccount, type IbkrAccountSummary, type IbkrPosition } from "@/lib/ibkr";

// ── Types ─────────────────────────────────────────────────────────────────────

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "failed";

interface PendingOrder {
  ticker: string;
  side: "BUY" | "SELL";
  orderType: "MKT" | "LMT" | "STP";
  quantity: number;
  price?: number;
  auxPrice?: number;
  tif?: "DAY" | "GTC";
  outsideRTH?: boolean;
  conid: number;
}

interface IBKRPanelProps {
  /** Called when connection status changes — parent can show indicator */
  onStatusChange?: (status: ConnectionStatus, accountId?: string) => void;
  /** When false, hides the Positions and Open Orders tables (e.g. in Settings page) */
  showPositions?: boolean;
}

// ── Main Component ────────────────────────────────────────────────────────────

export function IBKRPanel({ onStatusChange, showPositions = true }: IBKRPanelProps) {
  const utils = trpc.useUtils();

  // Settings from DB
  const { data: settings, isLoading: settingsLoading } = trpc.ibkr.getSettings.useQuery();

  // Portfolio account — used to check last sync time (skip auto-sync if < 10 min ago)
  const { data: portfolioState } = trpc.portfolio.getState.useQuery(undefined, { refetchOnWindowFocus: false });
  const lastSyncAt = portfolioState?.account?.lastKnownNLVAt ? new Date(portfolioState.account.lastKnownNLVAt) : null;
  const SYNC_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
  const isRecentSync = lastSyncAt != null && (Date.now() - lastSyncAt.getTime()) < SYNC_COOLDOWN_MS;
  const saveSettingsMut = trpc.ibkr.saveSettings.useMutation({
    onSuccess: () => utils.ibkr.getSettings.invalidate(),
  });
  const markConnectedMut = trpc.ibkr.markConnected.useMutation({
    onSuccess: () => utils.ibkr.getSettings.invalidate(),
  });

  // Connection state
  const [gatewayUrl, setGatewayUrl] = useState("https://143.198.141.131:5000");
  const [accountType, setAccountType] = useState<"paper" | "live">("paper");
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [statusMsg, setStatusMsg] = useState("");
  const [accounts, setAccounts] = useState<IbkrAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [summary, setSummary] = useState<IbkrAccountSummary | null>(null);
  const [positions, setPositions] = useState<IbkrPosition[]>([]);
  const [openOrders, setOpenOrders] = useState<any[]>([]);
  const [loadingData, setLoadingData] = useState(false);

  // Health check state
  const [lastPingMs, setLastPingMs] = useState<number | null>(null);
  const [lastPingTime, setLastPingTime] = useState<Date | null>(null);
  const healthIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Order confirmation dialog
  const [pendingOrder, setPendingOrder] = useState<PendingOrder | null>(null);
  const [confirmingOrder, setConfirmingOrder] = useState(false);

  // Last connected timestamp
  const [lastConnectedAt, setLastConnectedAt] = useState<Date | null>(null);

  // Countdown timer for push approval (0 = not counting)
  const [countdownSec, setCountdownSec] = useState<number>(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Pre-auth check: is iBeam already authenticated from a previous session?
  const [preAuthReady, setPreAuthReady] = useState<boolean>(false);
  const [checkingPreAuth, setCheckingPreAuth] = useState<boolean>(true);
  // Credentials check: is /root/ibeam/.env present on the control server?
  const [credentialsMissing, setCredentialsMissing] = useState<boolean>(false);
  const [recreatingIbeam, setRecreatingIbeam] = useState<boolean>(false);
  // Container state: 'not_found' | 'stopped' | 'running' | 'unknown'
  const [containerState, setContainerState] = useState<"not_found" | "stopped" | "running" | "unknown">("unknown");
  // Push notification paused state (user intentionally stopped iBeam)
  const [pushPaused, setPushPaused] = useState<boolean>(false);

  const startCountdown = useCallback((totalSec: number) => {
    setCountdownSec(totalSec);
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setCountdownSec(prev => {
        if (prev <= 1) {
          clearInterval(countdownRef.current!);
          countdownRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const stopCountdown = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    setCountdownSec(0);
  }, []);

  // Cleanup countdown on unmount
  useEffect(() => {
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, []);

  // Connection log panel
  interface LogEntry { time: Date; message: string; type: "info" | "success" | "error" | "warn"; }
  const [connectionLog, setConnectionLog] = useState<LogEntry[]>([]);
  const [logExpanded, setLogExpanded] = useState(false);
  const [logFullscreen, setLogFullscreen] = useState(false);
  const [logCopied, setLogCopied] = useState(false);
  const [logHours, setLogHours] = useState(1); // how many hours to show

  // Load persisted log from DB (last N hours)
  const { data: dbLog, refetch: refetchDbLog } = trpc.ibkr.getConnectionLog.useQuery(
    { hours: logHours },
    { refetchOnWindowFocus: false }
  );
  // Merge DB log into local state on load (newest first)
  useEffect(() => {
    if (dbLog && dbLog.length > 0) {
      const dbEntries: LogEntry[] = dbLog
        .slice()
        .reverse()
        .map(e => ({ time: new Date(e.time), message: e.message, type: e.type }));
      setConnectionLog(prev => {
        // Merge: DB entries as base, local-only entries on top (avoid duplicates by message+time)
        const dbSet = new Set(dbEntries.map(e => e.message + e.time.getTime()));
        const localOnly = prev.filter(e => !dbSet.has(e.message + e.time.getTime()));
        return [...localOnly, ...dbEntries]
          .sort((a, b) => b.time.getTime() - a.time.getTime())
          .slice(0, 200);
      });
    }
  }, [dbLog]);

  // Mutation to persist a log entry to DB
  const addLogMut = trpc.ibkr.addConnectionLog.useMutation();

  const copyConnectionLog = useCallback(() => {
    if (connectionLog.length === 0) return;
    const text = connectionLog
      .slice()
      .reverse()
      .map(e => `[${e.time.toLocaleTimeString('en-US', { hour12: false })}] ${e.message}`)
      .join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setLogCopied(true);
      setTimeout(() => setLogCopied(false), 2000);
    });
  }, [connectionLog]);

  const addLog = useCallback((message: string, type: LogEntry["type"] = "info") => {
    const entry: LogEntry = { time: new Date(), message, type };
    setConnectionLog(prev => [entry, ...prev].slice(0, 200));
    // Persist to DB (fire and forget)
    addLogMut.mutate({ message, type });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync IBKR positions into DB after connect
  const syncFromIbkrMut = trpc.ibkr.syncFromIbkr.useMutation({
    onSuccess: (data) => {
      utils.portfolio.getState.invalidate();
      if (data.total > 0) {
        addLog(`✅ Holdings synced from IBKR: ${data.upserted} updated, ${data.inserted} added, ${data.removed} removed`, "success");
        toast.success(`Holdings synced from IBKR (${data.total} positions)`, { duration: 4000 });
      }
    },
    onError: (e) => {
      addLog(`Auto-sync failed: ${e.message}`, "warn");
    },
  });

  // Renew session notification mutation
  const renewNotifMut = trpc.ibkr.sendRenewNotification.useMutation({
    onSuccess: (data) => {
      if (data.sent) {
        toast.success("📱 Telegram notification sent — check your phone to approve the iBeam push");
        addLog("Telegram renewal notification sent successfully", "success");
      } else {
        toast.error("Failed to send Telegram notification");
        addLog("Failed to send Telegram renewal notification", "error");
      }
    },
    onError: () => {
      toast.error("Failed to send renewal notification");
      addLog("Error sending renewal notification", "error");
    },
  });

  // Sync settings from DB on load
  useEffect(() => {
    if (!settings) return;
    const url = settings.gatewayUrl ?? "https://143.198.141.131:5000";
    setGatewayUrl(url);
    setAccountType((settings.accountType as "paper" | "live") ?? "paper");
    if (settings.accountId) setSelectedAccountId(settings.accountId);
    if ((settings as any).lastConnectedAt) {
      setLastConnectedAt(new Date((settings as any).lastConnectedAt));
    }
    ibkrClient.setGatewayUrl(url);
  }, [settings]);

  const updateStatus = useCallback((s: ConnectionStatus, msg = "", accId?: string) => {
    setStatus(s);
    setStatusMsg(msg);
    onStatusChange?.(s, accId);
  }, [onStatusChange]);

  // ── Health Check (only runs while connected) ─────────────────────────────────

  const pingGateway = useCallback(async () => {
    const start = Date.now();
    try {
      const res = await ibkrClient.getAuthStatus();
      const elapsed = Date.now() - start;
      setLastPingMs(elapsed);
      setLastPingTime(new Date());
      if (!res.authenticated) {
        // Session dropped — mark as disconnected
        addLog("Health check: session dropped (authenticated=false)", "warn");
        updateStatus("disconnected", "Session expired — click Resume to reconnect.");
        stopHealthCheck();
      }
    } catch {
      setLastPingTime(new Date());
      setLastPingMs(null);
    }
  }, [addLog, updateStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const startHealthCheck = useCallback(() => {
    if (healthIntervalRef.current) clearInterval(healthIntervalRef.current);
    pingGateway();
    healthIntervalRef.current = setInterval(pingGateway, 30_000);
  }, [pingGateway]);

  const stopHealthCheck = useCallback(() => {
    if (healthIntervalRef.current) {
      clearInterval(healthIntervalRef.current);
      healthIntervalRef.current = null;
    }
  }, []);

  // ── Cleanup on unmount ────────────────────────────────────────────────────────
  // Note: tickle (keepalive) is handled globally by IbkrTickleProvider in main.tsx

  useEffect(() => {
    return () => {
      stopHealthCheck();
    };
  }, [stopHealthCheck]);

  // ── Pre-auth check on mount: is iBeam already authenticated? ─────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/ibkr-proxy/auth-status");
        const data = await res.json() as { authenticated?: boolean };
        if (!cancelled) {
          setPreAuthReady(data.authenticated === true);
          if (data.authenticated) {
            addLog("🟢 iBeam already authenticated — connecting automatically...", "success");
            // Auto-recover: fetch accounts to get accountId, then load account data
            try {
              const accts = await ibkrClient.getAccounts();
              if (accts.length > 0) {
                const accId = accts[0].accountId;
                setAccounts(accts);
                setSelectedAccountId(accId);
                addLog(`🎉 Connected to IBKR — account ${accId}`, "success");
                toast.success("✅ Connected to IBKR successfully");
                setStatus("connected");
                await loadAccountData(accId);
              } else {
                setStatus("connected");
                toast.success("✅ Connected to IBKR");
              }
            } catch (err: any) {
              addLog(`Auto-connect error: ${err.message}`, "warn");
              setStatus("connected");
              toast.success("✅ Connected to IBKR (account data unavailable)");
            }
          }
        }
      } catch {
        // Silently ignore — just show normal connect button
      } finally {
        if (!cancelled) setCheckingPreAuth(false);
      }
      // Also check credentials presence on the control server
      try {
        const credRes = await fetch("/api/ibkr-proxy/credentials-check");
        const credData = await credRes.json() as { credentialsPresent?: boolean | null };
        if (!cancelled && credData.credentialsPresent === false) {
          setCredentialsMissing(true);
          addLog("⚠️ Missing /root/ibeam/.env on control server — iBeam credentials not found!", "error");
        }
      } catch {
        // Silently ignore credentials check failure
      }
      // Check if push is currently paused on the server
      try {
        const pushRes = await fetch("/api/ibkr-proxy/push-status");
        const pushData = await pushRes.json() as { pushPaused?: boolean };
        if (!cancelled && pushData.pushPaused === true) {
          setPushPaused(true);
        }
      } catch {
        // Silently ignore
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Container state polling (every 30s) ─────────────────────────────────────
  const fetchContainerState = useCallback(async () => {
    try {
      const res = await fetch("/api/ibkr-proxy/ibeam-status");
      const data = await res.json() as { containerState?: string; authenticated?: boolean; connected?: boolean };
      const cs = (data.containerState as "not_found" | "stopped" | "running" | "unknown") ?? "unknown";
      setContainerState(cs);

      // Auto-recover: if iBeam is authenticated and we are in a failed/disconnected state,
      // update the main badge to Connected and clear the error alert.
      if (data.authenticated === true) {
        setStatus(prev => {
          if (prev === "failed" || prev === "disconnected") {
            addLog("🎉 Connection restored! Gateway ready for trading", "success");
            toast.success("✅ Connected to IBKR successfully");
            return "connected";
          }
          return prev;
        });
        setPreAuthReady(true);
      }
    } catch {
      setContainerState("unknown");
    }
  }, [addLog]);

  useEffect(() => {
    fetchContainerState();
    const interval = setInterval(fetchContainerState, 30_000);
    return () => clearInterval(interval);
  }, [fetchContainerState]);

  // ── Account Data ─────────────────────────────────────────────────────────────

  const loadAccountData = useCallback(async (accId?: string) => {
    const id = accId ?? selectedAccountId;
    if (!id) return;
    setLoadingData(true);
    try {
      const [acctSummary, acctPositions, orders] = await Promise.allSettled([
        ibkrClient.getAccountSummary(id),
        ibkrClient.getPositions(id),
        ibkrClient.getOpenOrders(),
      ]);
      if (acctSummary.status === "fulfilled") setSummary(acctSummary.value);
      if (acctPositions.status === "fulfilled") setPositions(acctPositions.value);
      if (orders.status === "fulfilled") setOpenOrders((orders.value as any)?.orders ?? orders.value ?? []);
    } catch (err: any) {
      toast.error("Failed to load account data: " + err.message);
    } finally {
      setLoadingData(false);
    }
  }, [selectedAccountId]);

  // ── Connect Flow (v12.39) ────────────────────────────────────────────────────
  //
  // Step 1: POST /api/ibkr-proxy/resume  (calls /ibeam/restart on control server)
  // Step 2: Wait 3s for gateway to initialise
  // Step 3: Save settings + ONE push attempt (ssodh/init)
  // Step 4: 180s countdown — poll GET /api/ibkr-proxy/auth-status every 5s (server-side proxy, no CORS)
  //         → authenticated=true  → Connected ✅
  //         → 180s elapsed        → POST /ibeam/stop, Failed ❌

  const handleConnect = useCallback(async () => {
    updateStatus("connecting", "Starting iBeam container...");
    ibkrClient.setGatewayUrl(gatewayUrl);
    addLog("▶️ Resume: restarting iBeam...", "info");

    // Step 1: Restart iBeam container (stop + 3s + start on control server)
    try {
      const resumeRes = await fetch("/api/ibkr-proxy/resume", { method: "POST" });
      const resumeData = await resumeRes.json() as { ok: boolean; message?: string; error?: string };
      if (resumeData.ok) {
        addLog("✅ iBeam restarted. Waiting 3s for gateway to initialise...", "success");
      } else {
        addLog(`⚠️ Restart warning: ${resumeData.error ?? resumeData.message ?? "unknown"} — continuing anyway`, "warn");
      }
    } catch (err: any) {
      addLog(`⚠️ Restart failed: ${err.message} — continuing anyway`, "warn");
    }

    // Step 2: Wait for gateway port to be ready (up to 20s, poll every 2s)
    // After docker start, iBeam takes 8-12s to bind port 5000.
    // Calling ssodh/init before port is ready returns "Session expired" (misleading).
    updateStatus("connecting", "Waiting for gateway to come online...");
    addLog("⏳ Polling gateway until port is ready (up to 20s)...", "info");
    {
      const PORT_READY_TIMEOUT = 20_000;
      const PORT_POLL_INTERVAL = 2_000;
      const portDeadline = Date.now() + PORT_READY_TIMEOUT;
      let portReady = false;
      while (Date.now() < portDeadline) {
        try {
          const r = await fetch("/api/ibkr-proxy/auth-status");
          const d = await r.json() as { authenticated?: boolean };
          // Any valid JSON response (even unauthenticated) means port is bound
          if (typeof d === "object" && d !== null) {
            portReady = true;
            addLog("✅ Gateway port is ready", "success");
            break;
          }
        } catch {
          // Port not yet bound — keep polling
        }
        await new Promise(r => setTimeout(r, PORT_POLL_INTERVAL));
        const remaining = Math.max(0, Math.round((portDeadline - Date.now()) / 1000));
        addLog(`⏳ Waiting for gateway... ${remaining}s remaining`, "info");
      }
      if (!portReady) {
        addLog("⚠️ Gateway port not ready after 20s — proceeding anyway", "warn");
      }
    }

    // Step 3: Save settings + ONE push attempt
    try {
      await saveSettingsMut.mutateAsync({ gatewayUrl, accountType, sessionCookie: null });
    } catch {
      // Non-fatal — continue
    }
    ibkrClient.setSessionCookie(null);

    updateStatus("connecting", "Sending push notification to your phone...");
    addLog("📱 Sending push notification (ssodh/init)...", "info");
    try {
      await ibkrClient.initBrokerageSession();
      addLog("Push sent — waiting for approval on your phone...", "info");
    } catch (err: any) {
      addLog(`Push init error: ${err.message} — will still poll for auth`, "warn");
    }

    // Step 4: 180s countdown — poll /api/ibkr-proxy/auth-status every 5s (server-side proxy)
    const TIMEOUT_SEC = 180;
    const POLL_INTERVAL_SEC = 5;
    startCountdown(TIMEOUT_SEC);
    updateStatus("connecting", `Waiting for push approval... ${Math.floor(TIMEOUT_SEC / 60)}:${String(TIMEOUT_SEC % 60).padStart(2, "0")}`);
    addLog(`Polling auth-status every ${POLL_INTERVAL_SEC}s for up to ${TIMEOUT_SEC}s...`, "info");

    let authenticated = false;
    const deadline = Date.now() + TIMEOUT_SEC * 1000;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_SEC * 1000));
      try {
        const statusRes = await fetch("/api/ibkr-proxy/auth-status");
        const statusData = await statusRes.json() as { authenticated?: boolean; connected?: boolean; [k: string]: any };
        const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        const mm = Math.floor(remaining / 60);
        const ss = String(remaining % 60).padStart(2, "0");
        addLog(`Poll: authenticated=${statusData.authenticated} — ${mm}:${ss} remaining`, statusData.authenticated ? "success" : "info");
        if (statusData.authenticated) {
          authenticated = true;
          break;
        }
      } catch (err: any) {
        addLog(`Poll error: ${err.message}`, "warn");
      }
    }

    stopCountdown();

    if (!authenticated) {
      // Timeout — stop iBeam
      addLog("⏱️ 180s timeout — stopping iBeam container...", "error");
      try {
        await fetch("http://143.198.141.131:6000/ibeam/stop", { method: "POST" });
        addLog("iBeam stopped.", "warn");
      } catch (e: any) {
        addLog(`Stop error: ${e.message}`, "warn");
      }
      updateStatus("failed", "Push not approved within 3 minutes — click Resume to try again.");
      toast.error("IBKR push timed out — click Resume to try again");
      return;
    }

    addLog("✅ Authenticated!", "success");

    // Step 7: Get accounts
    addLog("Fetching accounts...", "info");
    let accId = selectedAccountId;
    try {
      const accts = await ibkrClient.getAccounts();
      setAccounts(accts);
      accId = accts[0]?.accountId ?? selectedAccountId;
      if (accId) {
        setSelectedAccountId(accId);
        addLog(`Account: ${accId}`, "success");
      }
    } catch (err: any) {
      addLog(`Accounts fetch error: ${err.message} — using saved account ID`, "warn");
    }

    // Step 8: Mark connected in DB
    if (accId) {
      try {
        await markConnectedMut.mutateAsync({ accountId: accId, accountType });
      } catch {
        // Non-fatal
      }
    }

    const now = new Date();
    setLastConnectedAt(now);
    addLog(`✅ Connected to IBKR ${accountType} account ${accId}`, "success");
    updateStatus("connected", `Connected — ${accId}`, accId);
    toast.success(`✅ Connected to IBKR ${accountType === "paper" ? "Paper" : "Live"} account ${accId}`);

    // Step 9: Start health check (tickle is handled globally by IbkrTickleProvider)
    startHealthCheck();

    // Step 10: Load account data
    if (accId) await loadAccountData(accId);

    // Step 11: Auto-sync IBKR positions into Holdings DB (skip if synced < 10 min ago)
    if (isRecentSync && lastSyncAt) {
      const minsAgo = Math.round((Date.now() - lastSyncAt.getTime()) / 60000);
      addLog(`⏩ Skipping auto-sync — last sync was ${minsAgo}m ago (< 10 min cooldown)`, "info");
    } else {
    addLog("🔄 Auto-syncing Holdings from IBKR...", "info");
    try {
      const acctPositions = await ibkrClient.getPositions(accId);
      if (acctPositions.length > 0) {
        // Also fetch account summary to save grossPositionValue (שווי תיק) + today P&L to DB
        let nlv: number | undefined;
        let grossPositionValue: number | undefined;
        let todayPnl: number | undefined;
        let cashBal: number | undefined;
        try {
          const accId2 = accId ?? selectedAccountId;
          if (accId2) {
            const summ = await ibkrClient.getAccountSummary(accId2);
            nlv = summ?.netliquidation?.amount ?? undefined;
            grossPositionValue = summ?.grosspositionvalue?.amount ?? undefined;
            todayPnl = summ?.dailypnl?.amount ?? undefined;
            cashBal = summ?.totalcashvalue?.amount ?? undefined;
          }
        } catch { /* non-blocking */ }
        syncFromIbkrMut.mutate({
          positions: acctPositions.map((p: any) => ({
            ticker: (p.ticker ?? p.symbol ?? "").toUpperCase(),
            position: p.position ?? 0,
            avgCost: p.avgCost ?? 0,
            mktPrice: p.mktPrice ?? 0,
            mktValue: p.mktValue ?? 0,
            unrealizedPnl: p.unrealizedPnl ?? 0,
            currency: p.currency ?? "USD",
            assetClass: p.assetClass ?? "STK",
          })),
          cashBalance: cashBal,
          nlv,
          grossPositionValue,
          todayPnl,
        });
      } else {
        addLog("No positions returned from IBKR — skipping auto-sync", "warn");
      }
    } catch (err: any) {
      addLog(`Auto-sync positions fetch failed: ${err.message}`, "warn");
    }
    } // end else (not recent sync)

  }, [gatewayUrl, accountType, selectedAccountId, updateStatus, startHealthCheck, addLog, saveSettingsMut, markConnectedMut, loadAccountData, syncFromIbkrMut, startCountdown, stopCountdown, isRecentSync, lastSyncAt]);

  // ── Quick Connect (iBeam already authenticated) ─────────────────────────────────
  // Skips the push/restart flow — iBeam is already authenticated from a previous session.
  // Just loads accounts + account data and marks connected.

  const handleQuickConnect = useCallback(async () => {
    updateStatus("connecting", "Connecting (iBeam already authenticated)...");
    ibkrClient.setGatewayUrl(gatewayUrl);
    addLog("⚡ Quick Connect: iBeam already authenticated — skipping push flow", "info");

    // Save settings
    try {
      await saveSettingsMut.mutateAsync({ gatewayUrl, accountType, sessionCookie: null });
    } catch { /* non-fatal */ }
    ibkrClient.setSessionCookie(null);

    // Verify auth status once
    let authStatus: { authenticated: boolean; connected: boolean } | null = null;
    try {
      authStatus = await ibkrClient.getAuthStatus();
      addLog(`auth/status → authenticated=${authStatus?.authenticated}, connected=${authStatus?.connected}`, authStatus?.authenticated ? "success" : "warn");
    } catch (err: any) {
      addLog(`auth/status error: ${err.message}`, "error");
      updateStatus("failed", `Cannot reach gateway: ${err.message}`);
      setPreAuthReady(false);
      toast.error("IBKR connection failed — click Resume to try again");
      return;
    }

    if (!authStatus?.authenticated) {
      // Race condition: session died between pre-auth check and click.
      // Fall back gracefully to the normal push flow.
      addLog("⚠️ Session expired since pre-auth check — falling back to Resume iBeam flow", "warn");
      setPreAuthReady(false);
      updateStatus("disconnected", "");
      toast.warning("Session expired — starting Resume iBeam flow...", { duration: 3000 });
      // Small delay so the user sees the warning, then kick off the normal connect
      setTimeout(() => handleConnect(), 1500);
      return;
    }

    // Load accounts
    let accId = selectedAccountId;
    try {
      const accts = await ibkrClient.getAccounts();
      setAccounts(accts);
      accId = accts[0]?.accountId ?? selectedAccountId;
      if (accId) { setSelectedAccountId(accId); addLog(`Account: ${accId}`, "success"); }
    } catch (err: any) {
      addLog(`Accounts fetch error: ${err.message} — using saved account ID`, "warn");
    }

    // Mark connected in DB
    if (accId) {
      try { await markConnectedMut.mutateAsync({ accountId: accId, accountType }); } catch { /* non-fatal */ }
    }

    const now = new Date();
    setLastConnectedAt(now);
    addLog(`✅ Connected to IBKR ${accountType} account ${accId}`, "success");
    updateStatus("connected", `Connected — ${accId}`, accId);
    toast.success(`✅ Connected to IBKR ${accountType === "paper" ? "Paper" : "Live"} account ${accId}`);
    setPreAuthReady(false);

    startHealthCheck();
    if (accId) await loadAccountData(accId);

    // Auto-sync Holdings (skip if synced < 10 min ago)
    if (isRecentSync && lastSyncAt) {
      const minsAgo2 = Math.round((Date.now() - lastSyncAt.getTime()) / 60000);
      addLog(`⏩ Skipping auto-sync — last sync was ${minsAgo2}m ago (< 10 min cooldown)`, "info");
    } else {
    addLog("🔄 Auto-syncing Holdings from IBKR...", "info");
    try {
      const acctPositions = await ibkrClient.getPositions(accId);
      if (acctPositions.length > 0) {
        let nlv2: number | undefined;
        let grossPositionValue2: number | undefined;
        let todayPnl2: number | undefined;
        let cashBal2: number | undefined;
        try {
          const accId3 = accId ?? selectedAccountId;
          if (accId3) {
            const summ2 = await ibkrClient.getAccountSummary(accId3);
            nlv2 = summ2?.netliquidation?.amount ?? undefined;
            grossPositionValue2 = summ2?.grosspositionvalue?.amount ?? undefined;
            todayPnl2 = summ2?.dailypnl?.amount ?? undefined;
            cashBal2 = summ2?.totalcashvalue?.amount ?? undefined;
          }
        } catch { /* non-blocking */ }
        syncFromIbkrMut.mutate({
          positions: acctPositions.map((p: any) => ({
            ticker: (p.ticker ?? p.symbol ?? "").toUpperCase(),
            position: p.position ?? 0,
            avgCost: p.avgCost ?? 0,
            mktPrice: p.mktPrice ?? 0,
            mktValue: p.mktValue ?? 0,
            unrealizedPnl: p.unrealizedPnl ?? 0,
            currency: p.currency ?? "USD",
            assetClass: p.assetClass ?? "STK",
          })),
          cashBalance: cashBal2,
          nlv: nlv2,
          grossPositionValue: grossPositionValue2,
          todayPnl: todayPnl2,
        });
      }
    } catch (err: any) {
      addLog(`Auto-sync failed: ${err.message}`, "warn");
    }
    } // end else (not recent sync)
  }, [gatewayUrl, accountType, selectedAccountId, updateStatus, startHealthCheck, addLog, saveSettingsMut, markConnectedMut, loadAccountData, syncFromIbkrMut, handleConnect, isRecentSync, lastSyncAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Disconnect ────────────────────────────────────────────────────────────────

  const handleDisconnect = useCallback(async () => {
    addLog("⏸️ Disconnecting — stopping iBeam container...", "warn");
    stopHealthCheck();
    try {
      const res = await fetch("/api/ibkr-proxy/pause", { method: "POST" });
      const data = await res.json() as { ok: boolean; error?: string };
      if (data.ok) {
        addLog("iBeam container stopped.", "success");
        toast.success("⏸️ Disconnected from IBKR");
      } else {
        addLog(`docker stop warning: ${data.error ?? "unknown"}`, "warn");
      }
    } catch (err: any) {
      addLog(`Disconnect error: ${err.message}`, "error");
    }
    updateStatus("disconnected", "");
    setSummary(null);
    setPositions([]);
    setOpenOrders([]);
  }, [addLog, stopHealthCheck, updateStatus]);

  // ── Order Handling ────────────────────────────────────────────────────────────

  const requestOrderConfirmation = (order: PendingOrder) => {
    setPendingOrder(order);
  };

  const handleConfirmOrder = async () => {
    if (!pendingOrder || !selectedAccountId) return;
    setConfirmingOrder(true);
    try {
      const results = await ibkrClient.placeOrder(selectedAccountId, pendingOrder);
      for (const result of results) {
        if (result.id && result.message) {
          await ibkrClient.confirmOrder(result.id);
        }
      }
      toast.success(`Order placed: ${pendingOrder.side} ${pendingOrder.quantity} ${pendingOrder.ticker}`);
      setPendingOrder(null);
      await loadAccountData();
    } catch (err: any) {
      toast.error("Order failed: " + err.message);
    } finally {
      setConfirmingOrder(false);
    }
  };

  const handleCancelOrder = async (orderId: string) => {
    if (!selectedAccountId) return;
    try {
      await ibkrClient.cancelOrder(selectedAccountId, orderId);
      toast.success(`Order ${orderId} cancelled`);
      await loadAccountData();
    } catch (err: any) {
      toast.error("Cancel failed: " + err.message);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  const isConnected = status === "connected";
  const isConnecting = status === "connecting";
  const isFailed = status === "failed";

  const logTypeColor: Record<LogEntry["type"], string> = {
    info: "text-[#2563EB]",
    success: "text-[#65A30D]",
    error: "text-[#FF6B6B]",
    warn: "text-amber-400",
  };

  return (
    <div className="space-y-4">

      {/* ── Order Confirmation Dialog ── */}
      <Dialog open={!!pendingOrder} onOpenChange={open => { if (!open) setPendingOrder(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-amber-500" />
              Confirm Order
            </DialogTitle>
            <DialogDescription>
              Please review the order details before submitting.
            </DialogDescription>
          </DialogHeader>
          {pendingOrder && (
            <div className="rounded-lg border bg-muted/30 p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Ticker</span>
                <span className="font-mono font-bold">{pendingOrder.ticker}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Side</span>
                <Badge variant="outline" className={`text-xs font-semibold ${pendingOrder.side === "BUY" ? "bg-emerald-100 text-emerald-700 border-emerald-300" : "bg-red-100 text-red-700 border-red-300"}`}>
                  {pendingOrder.side}
                </Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Order Type</span>
                <span className="font-mono">{pendingOrder.orderType}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Quantity</span>
                <span className="font-mono font-semibold">{pendingOrder.quantity}</span>
              </div>
              {pendingOrder.price !== undefined && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Limit Price</span>
                  <span className="font-mono">${pendingOrder.price.toFixed(2)}</span>
                </div>
              )}
              {pendingOrder.auxPrice !== undefined && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Stop Price</span>
                  <span className="font-mono">${pendingOrder.auxPrice.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">TIF</span>
                <span className="font-mono">{pendingOrder.tif ?? "DAY"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Account</span>
                <span className="font-mono text-xs">{selectedAccountId}</span>
              </div>
              {accountType === "live" && (
                <div className="mt-2 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700 font-medium flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  This is a LIVE account. Real money will be used.
                </div>
              )}
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setPendingOrder(null)} disabled={confirmingOrder}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleConfirmOrder}
              disabled={confirmingOrder}
              className={pendingOrder?.side === "BUY" ? "bg-[#65A30D] hover:bg-[#17a87e]" : "bg-[#FF6B6B] hover:bg-[#e05555]"}
            >
              {confirmingOrder && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
              Confirm {pendingOrder?.side}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Connection Card ── */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-3 pt-4 px-5">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            {isConnected
              ? <CheckCircle2 className="h-4 w-4 text-[#65A30D]" />
              : isFailed
              ? <WifiOff className="h-4 w-4 text-[#FF6B6B]" />
              : isConnecting
              ? <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
              : <WifiOff className="h-4 w-4 text-muted-foreground" />
            }
            IBKR Gateway (iBeam)
            {/* Status badge */}
            <Badge variant="outline" className={`ml-auto text-xs font-semibold px-2.5 py-0.5 ${
              isConnected ? "bg-emerald-100 text-emerald-700 border-emerald-300" :
              isFailed ? "bg-red-100 text-red-700 border-red-300" :
              isConnecting ? "bg-amber-900/30 text-amber-400 border-amber-300" :
              "bg-muted text-muted-foreground border-border"
            }`}>
              {isConnected ? `✅ Connected · ${selectedAccountId}` :
               isFailed ? "❌ Failed" :
               isConnecting ? "⏳ Connecting..." :
               "⚪ Disconnected"}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-5 space-y-4">

          {/* ── Gateway URL + Account Type ── */}
          <div className="flex gap-2">
            <div className="flex-1">
              <Label className="text-xs mb-1 block font-medium">Gateway URL</Label>
              <Input
                value={gatewayUrl}
                onChange={e => setGatewayUrl(e.target.value)}
                placeholder="https://143.198.141.131:5000"
                className="h-8 text-xs font-mono"
                disabled={isConnecting}
              />
            </div>
            <div className="w-28">
              <Label className="text-xs mb-1 block font-medium">Account Type</Label>
              <Select value={accountType} onValueChange={v => setAccountType(v as "paper" | "live")} disabled={isConnecting}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="paper">Paper</SelectItem>
                  <SelectItem value="live">Live</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* ── Failed message ── */}
          {isFailed && statusMsg && (
            <div className="flex items-start gap-2 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-800">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{statusMsg}</span>
            </div>
          )}

          {/* ── Connecting progress message + countdown ── */}
          {isConnecting && (
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2.5 text-xs text-amber-800 space-y-1.5">
              <div className="flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                <span className="font-medium">{statusMsg}</span>
              </div>
              {countdownSec > 0 && (
                <div className="flex items-center gap-2 pl-5">
                  <Clock className="h-3 w-3 shrink-0 text-amber-600" />
                  <span className="font-mono text-base font-bold text-amber-900">
                    {Math.floor(countdownSec / 60)}:{String(countdownSec % 60).padStart(2, "0")}
                  </span>
                  <span className="text-amber-600">remaining — approve the push on your phone</span>
                </div>
              )}
            </div>
          )}

          {/* ── Pre-auth banner: iBeam already authenticated ── */}
          {!isConnected && !isConnecting && preAuthReady && (
            <div className="flex items-center gap-2 rounded-md bg-green-50 border border-green-200 px-3 py-2 text-xs text-green-800">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600" />
              <span className="font-medium">iBeam is already authenticated — click the button below to connect instantly.</span>
            </div>
          )}

          {/* ── Action Buttons ── */}
          <div className="flex gap-2 flex-wrap items-center">

            {/* Quick Connect button — shown when iBeam is already authenticated */}
            {!isConnected && !isConnecting && preAuthReady && (
              <Button
                onClick={handleQuickConnect}
                disabled={settingsLoading}
                className="h-9 text-sm font-semibold px-5 bg-green-600 hover:bg-green-700 text-white"
              >
                <CheckCircle2 className="h-4 w-4 mr-2" />
                Connect to IBKR ✅
              </Button>
            )}

            {/* Resume / Connect button — always visible when not connected */}
            {!isConnected && (
              <Button
                onClick={handleConnect}
                disabled={isConnecting || settingsLoading}
                className="h-9 text-sm font-semibold px-5"
                variant={preAuthReady ? "outline" : "default"}
              >
                {isConnecting
                  ? <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  : <Wifi className="h-4 w-4 mr-2" />
                }
                {isFailed ? "Resume iBeam" : isConnecting ? "Connecting..." : "Connect to IBKR"}
              </Button>
            )}

            {/* Recreate iBeam button — visible when not connected; forces docker run from scratch */}
            {!isConnected && (
              <Button
                size="sm"
                variant="outline"
                title="Use if container is missing or stuck"
                className="h-9 text-sm border-slate-400 text-slate-700 bg-slate-50 hover:bg-slate-100 hover:border-slate-500"
                disabled={recreatingIbeam || isConnecting}
                onClick={async () => {
                  setRecreatingIbeam(true);
                  addLog("🔄 Recreating iBeam container (docker run from scratch)...", "info");
                  try {
                    const res = await fetch("/api/ibkr-proxy/resume", { method: "POST" });
                    const data = await res.json() as { ok?: boolean; message?: string; error?: string };
                    if (data.ok !== false) {
                      addLog("✅ iBeam container recreated — push notification sent to phone", "success");
                      toast.success("iBeam recreated — approve the push on your phone");
                      setCredentialsMissing(false);
                      fetchContainerState();
                    } else {
                      addLog(`❌ Recreate failed: ${data.error ?? data.message ?? "unknown"}`, "error");
                      toast.error(`Recreate failed: ${data.error ?? "unknown"}`);
                    }
                  } catch (e: any) {
                    addLog(`Recreate error: ${e.message}`, "error");
                    toast.error("Could not recreate iBeam container");
                  } finally {
                    setRecreatingIbeam(false);
                  }
                }}
              >
                {recreatingIbeam ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                Recreate iBeam
              </Button>
            )}

            {/* Reconnect button — shown when connected */}
            {isConnected && (
              <Button
                onClick={handleConnect}
                disabled={isConnecting || settingsLoading}
                variant="outline"
                className="h-9 text-sm font-semibold px-5"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Reconnect
              </Button>
            )}

            {/* Disconnect button — only shown when connected */}
            {isConnected && (
              <Button
                variant="outline"
                className="h-9 text-sm font-semibold px-5 border-red-400 text-[#FF6B6B] bg-red-50 hover:bg-red-900/30 hover:border-red-500"
                onClick={handleDisconnect}
              >
                <WifiOff className="h-4 w-4 mr-2" />
                Disconnect
              </Button>
            )}

            {/* Renew Session — sends Telegram push reminder */}
            <Button
              size="sm"
              variant="outline"
              className="h-9 text-sm border-amber-300 text-amber-800 bg-amber-50 hover:bg-amber-900/30"
              onClick={() => renewNotifMut.mutate()}
              disabled={renewNotifMut.isPending}
              title="Send Telegram alert to approve iBeam daily push notification"
            >
              {renewNotifMut.isPending
                ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                : <Bell className="h-3.5 w-3.5 mr-1.5" />
              }
              Renew Session
            </Button>

            {isConnected && (
              <Button size="sm" variant="outline" onClick={() => loadAccountData()} disabled={loadingData} className="h-8 text-xs">
                {loadingData ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                Refresh Data
              </Button>
            )}

            {/* Stop Connecting — visible during 180s countdown */}
            {isConnecting && (
              <Button
                size="sm"
                variant="outline"
                className="h-9 text-sm border-red-400 text-[#FF6B6B] bg-red-50 hover:bg-red-900/30 hover:border-red-500"
                onClick={async () => {
                  stopCountdown();
                  addLog("🛑 Connecting cancelled by user — stopping iBeam...", "warn");
                  updateStatus("disconnected", "");
                  try {
                    await fetch("/api/ibkr-proxy/pause", { method: "POST" });
                    addLog("iBeam stopped.", "warn");
                  } catch (e: any) {
                    addLog(`Stop error: ${e.message}`, "error");
                  }
                }}
              >
                <X className="h-4 w-4 mr-2" />
                Stop Connecting
              </Button>
            )}

            {/* Stop iBeam Push / Resume Push */}
            {!isConnected && !pushPaused && (
              <Button
                size="sm"
                variant="outline"
                className="h-9 text-sm border-orange-400 text-orange-700 bg-orange-50 hover:bg-orange-100 hover:border-orange-500"
                onClick={async () => {
                  stopCountdown();
                  addLog("🔴 Stopping iBeam container (no more push notifications)...", "warn");
                  try {
                    const res = await fetch("/api/ibkr-proxy/pause", { method: "POST" });
                    const data = await res.json() as { ok?: boolean; pushPaused?: boolean; error?: string };
                    if (data.ok !== false) {
                      setPushPaused(true);
                      addLog("✅ iBeam stopped. Push notifications suppressed on server.", "warn");
                      toast.warning("🔴 iBeam stopped — push notifications disabled");
                    } else {
                      addLog(`Stop warning: ${data.error ?? "unknown"}`, "warn");
                    }
                  } catch (e: any) {
                    addLog(`Stop iBeam error: ${e.message}`, "error");
                    toast.error("Could not stop iBeam");
                  }
                  updateStatus("disconnected", "");
                }}
              >
                <WifiOff className="h-4 w-4 mr-2" />
                Stop iBeam Push
              </Button>
            )}
            {/* Push Paused badge + Resume button */}
            {pushPaused && (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-orange-700 bg-orange-100 border border-orange-300 rounded px-2 py-1">
                  <Bell className="h-3 w-3" />
                  Push Paused
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 text-sm border-emerald-400 text-[#65A30D] bg-emerald-50 hover:bg-emerald-900/30"
                  onClick={async () => {
                    addLog("🔄 Resuming iBeam and push notifications...", "info");
                    try {
                      const res = await fetch("/api/ibkr-proxy/resume", { method: "POST" });
                      const data = await res.json() as { ok?: boolean; pushPaused?: boolean; error?: string };
                      if (data.ok !== false) {
                        setPushPaused(false);
                        addLog("✅ iBeam restarted. Push notifications resumed.", "success");
                        toast.success("✅ iBeam restarted — push notifications resumed");
                      } else {
                        addLog(`Resume warning: ${data.error ?? "unknown"}`, "warn");
                        toast.error(`Could not resume iBeam: ${data.error ?? "unknown"}`);
                      }
                    } catch (e: any) {
                      addLog(`Resume iBeam error: ${e.message}`, "error");
                      toast.error("Could not resume iBeam");
                    }
                  }}
                >
                  <Wifi className="h-4 w-4 mr-2" />
                  Resume Push
                </Button>
              </div>
            )}

            {/* Check iBeam Status — always visible */}
            <Button
              size="sm"
              variant="outline"
              className="h-9 text-sm border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100"
              onClick={async () => {
                addLog("🔍 Checking iBeam status...", "info");
                try {
                  const res = await fetch("/api/ibkr-proxy/auth-status");
                  const data = await res.json() as { authenticated?: boolean; connected?: boolean; competing?: boolean; status?: string; stale?: boolean; stale_reason?: string };
                  const auth = data.authenticated ? "✅ authenticated" : "❌ not authenticated";
                  const conn = data.connected ? "connected" : "not connected";
                  const staleNote = data.stale ? ` [stale: ${data.stale_reason ?? "?"}]` : "";
                  addLog(`iBeam: ${data.status ?? "?"} · ${auth} · ${conn}${staleNote}`, data.authenticated ? "success" : "warn");
                  toast.info(`iBeam: ${auth} · ${conn}`);
                } catch (e: any) {
                  addLog(`Status check error: ${e.message}`, "error");
                  toast.error("Could not reach iBeam status endpoint");
                }
              }}
            >
              <Activity className="h-4 w-4 mr-2" />
              Check iBeam Status
            </Button>

            {/* Recreate iBeam Container — force docker run when container is missing */}
            <Button
              size="sm"
              variant="outline"
              className="h-9 text-sm border-purple-400 text-[#2563EB] bg-purple-50 hover:bg-[rgba(37,99,235,0.15)] hover:border-purple-500"
              disabled={recreatingIbeam}
              onClick={async () => {
                setRecreatingIbeam(true);
                addLog("🔄 Recreating iBeam container (docker run)...", "info");
                try {
                  const res = await fetch("/api/ibkr-proxy/resume", { method: "POST" });
                  const data = await res.json() as { ok?: boolean; message?: string; error?: string };
                  if (data.ok !== false) {
                    addLog("✅ iBeam container recreated — push notification sent to phone", "success");
                    toast.success("iBeam recreated — approve the push on your phone");
                    setCredentialsMissing(false);
                  } else {
                    addLog(`❌ Recreate failed: ${data.error ?? data.message ?? "unknown"}`, "error");
                    toast.error(`Recreate failed: ${data.error ?? "unknown"}`);
                  }
                } catch (e: any) {
                  addLog(`Recreate error: ${e.message}`, "error");
                  toast.error("Could not recreate iBeam container");
                } finally {
                  setRecreatingIbeam(false);
                }
              }}
            >
              {recreatingIbeam ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              Recreate iBeam Container
            </Button>

          </div>

          {/* Credentials missing alert */}
          {credentialsMissing && (
            <div className="flex items-start gap-2 p-3 rounded-md bg-red-50 border border-red-200 text-red-800 text-sm">
              <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0 text-[#FF6B6B]" />
              <div>
                <p className="font-semibold">Missing iBeam credentials on control server</p>
                <p className="text-xs text-[#FF6B6B] mt-0.5">
                  The file <code className="bg-red-100 px-1 rounded">/root/ibeam/.env</code> was not found on 143.198.141.131.
                  SSH into the server and create it with <code className="bg-red-100 px-1 rounded">IBEAM_ACCOUNT</code> and <code className="bg-red-100 px-1 rounded">IBEAM_PASSWORD</code>.
                  Then click <strong>Recreate iBeam Container</strong> above.
                </p>
              </div>
            </div>
          )}

          {/* Container state badge */}
          {containerState !== "unknown" && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Container:</span>
              {containerState === "not_found" && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-900/30 text-red-700 border border-red-200">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-500 inline-block" />
                  Missing — use Recreate iBeam
                </span>
              )}
              {containerState === "stopped" && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700 border border-yellow-200">
                  <span className="h-1.5 w-1.5 rounded-full bg-yellow-500 inline-block" />
                  Stopped — use Connect to IBKR
                </span>
              )}
              {containerState === "running" && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 border border-green-200">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500 inline-block" />
                  Running
                </span>
              )}
            </div>
          )}

          {/* ── Status bar: keepalive + last connected ── */}
          <div className="flex items-center gap-3 pt-2 border-t flex-wrap">
            {isConnected && (
              <div className="flex items-center gap-1.5">
                <Heart className="h-3.5 w-3.5 text-rose-500 animate-pulse" />
                <span className="text-xs font-medium text-rose-600">keepalive ♥ 55s (browser) + 50s (server, auto-restart)</span>
                {lastPingMs !== null && (
                  <span className="text-xs text-muted-foreground">({lastPingMs}ms)</span>
                )}
              </div>
            )}
            {isConnected && lastPingTime && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Activity className="h-3 w-3" />
                <span>Ping: {lastPingTime.toLocaleTimeString()}</span>
              </div>
            )}
            {lastConnectedAt && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground ml-auto">
                <Clock className="h-3 w-3" />
                <span>Last connected: {lastConnectedAt.toLocaleString()}</span>
              </div>
            )}
          </div>

          {/* Account selector if multiple accounts */}
          {isConnected && accounts.length > 1 && (
            <div>
              <Label className="text-xs mb-1 block">Active Account</Label>
              <Select value={selectedAccountId} onValueChange={id => { setSelectedAccountId(id); loadAccountData(id); }}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map(a => (
                    <SelectItem key={a.accountId} value={a.accountId}>
                      {a.accountId} — {a.accountTitle || a.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* ── Connection Log Panel ── */}
          <div className="border rounded-lg overflow-hidden">
            {/* Header row */}
            <div className="flex items-center bg-muted/30 border-b">
              <button
                className="flex-1 flex items-center gap-1.5 px-3 py-2 hover:bg-muted/50 transition-colors text-xs font-medium text-left"
                onClick={() => setLogExpanded(v => !v)}
              >
                <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
                Connection Log
                {connectionLog.length > 0 && (
                  <Badge variant="secondary" className="text-xs px-1.5 py-0 h-4">
                    {connectionLog.length}
                  </Badge>
                )}
                {logExpanded
                  ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground ml-auto" />
                  : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground ml-auto" />
                }
              </button>
              {/* Hours selector */}
              <div className="flex items-center gap-0.5 px-1 border-l border-r">
                {[1, 3, 6, 24].map(h => (
                  <button
                    key={h}
                    className={`px-1.5 py-1 text-[10px] font-mono rounded transition-colors ${
                      logHours === h
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-muted/60 text-muted-foreground hover:text-foreground'
                    }`}
                    onClick={(e) => { e.stopPropagation(); setLogHours(h); setLogExpanded(true); }}
                    title={`Show last ${h}h`}
                  >{h}h</button>
                ))}
              </div>
              {/* Refresh from DB */}
              <button
                className="px-2 py-2 hover:bg-muted/60 transition-colors text-muted-foreground hover:text-foreground"
                title="Refresh log from DB"
                onClick={(e) => { e.stopPropagation(); refetchDbLog(); setLogExpanded(true); }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              {/* Copy button */}
              <button
                className="px-2 py-2 hover:bg-muted/60 transition-colors text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="Copy all log entries to clipboard"
                disabled={connectionLog.length === 0}
                onClick={(e) => { e.stopPropagation(); copyConnectionLog(); }}
              >
                {logCopied
                  ? <Check className="h-3.5 w-3.5 text-[#65A30D]" />
                  : <Copy className="h-3.5 w-3.5" />}
              </button>
              {/* Expand/collapse height */}
              <button
                className="px-2 py-2 hover:bg-muted/60 transition-colors text-muted-foreground hover:text-foreground"
                title={logFullscreen ? "Collapse log" : "Expand log"}
                onClick={(e) => { e.stopPropagation(); setLogFullscreen(v => !v); setLogExpanded(true); }}
              >
                {logFullscreen
                  ? <Minimize2 className="h-3.5 w-3.5" />
                  : <Maximize2 className="h-3.5 w-3.5" />}
              </button>
            </div>
            {logExpanded && (
              <div className={`bg-white text-gray-700 font-mono text-xs p-3 overflow-y-auto space-y-0.5 ${logFullscreen ? 'max-h-[480px]' : 'max-h-48'}`}>
                {connectionLog.length === 0 ? (
                  <p className="text-zinc-500 italic">No log entries yet. Click Connect to start.</p>
                ) : (
                  connectionLog.map((entry, i) => (
                    <div key={i} className="flex gap-2 leading-relaxed select-text">
                      <span className="text-zinc-500 shrink-0">
                        {entry.time.toLocaleTimeString("en-US", { hour12: false })}
                      </span>
                      <span className={`${logTypeColor[entry.type]} break-all`}>{entry.message}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

        </CardContent>
      </Card>

      {/* ── Account Summary ── */}
      {isConnected && summary && (
        <Card className="border shadow-sm">
          <CardHeader className="pb-2 pt-4 px-5">
            <CardTitle className="text-sm font-semibold">Account Summary — {selectedAccountId}</CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {[
                { label: "Net Liquidation", value: summary.netliquidation?.amount, currency: summary.netliquidation?.currency },
                { label: "Buying Power", value: summary.buyingpower?.amount, currency: summary.buyingpower?.currency },
                { label: "Cash Balance", value: summary.totalcashvalue?.amount, currency: summary.totalcashvalue?.currency },
                { label: "Gross Position", value: summary.grosspositionvalue?.amount, currency: summary.grosspositionvalue?.currency },
                { label: "Unrealized P&L", value: summary.unrealizedpnl?.amount, currency: summary.unrealizedpnl?.currency, pnl: true },
                { label: "Realized P&L", value: summary.realizedpnl?.amount, currency: summary.realizedpnl?.currency, pnl: true },
              ].map((item, i) => (
                <div key={i} className="rounded-md bg-muted/30 px-3 py-2">
                  <p className="text-xs text-muted-foreground">{item.label}</p>
                  <p className={`text-sm font-semibold font-mono ${
                    item.pnl && item.value !== undefined
                      ? item.value >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"
                      : ""
                  }`}>
                    {item.value !== undefined
                      ? `${item.value >= 0 ? "" : "-"}$${Math.abs(item.value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                      : "—"
                    }
                    {item.currency && <span className="text-xs font-normal text-muted-foreground ml-1">{item.currency}</span>}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Open Orders (STP / LMT) ── */}
      {isConnected && openOrders.length > 0 && (
        <Card className="border shadow-sm">
          <CardHeader className="pb-2 pt-4 px-5">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold">Open Orders — STP / LMT ({openOrders.length})</CardTitle>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => loadAccountData(selectedAccountId)}>
                <RefreshCw className="h-3 w-3 mr-1" /> Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/20 border-b">
                    <th className="text-left px-4 py-2 font-semibold">Ticker</th>
                    <th className="text-left px-4 py-2 font-semibold">Type</th>
                    <th className="text-left px-4 py-2 font-semibold">Side</th>
                    <th className="text-right px-4 py-2 font-semibold">Qty</th>
                    <th className="text-right px-4 py-2 font-semibold">Trigger / Limit</th>
                    <th className="text-left px-4 py-2 font-semibold">Status</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {openOrders.map((o, i) => {
                    const isSTP = o.orderType === "STP" || o.orderType === "STOP";
                    const isLMT = o.orderType === "LMT" || o.orderType === "LIMIT";
                    return (
                      <tr key={i} className="border-b last:border-0 hover:bg-muted/10">
                        <td className="px-4 py-2 font-mono font-bold">{o.ticker}</td>
                        <td className="px-4 py-2">
                          <Badge variant="outline" className={`text-xs font-mono ${
                            isSTP ? "bg-red-50 text-red-700 border-red-200" :
                            isLMT ? "bg-emerald-50 text-[#65A30D] border-emerald-200" :
                            ""
                          }`}>
                            {isSTP ? "🛑 STP" : isLMT ? "🎯 LMT" : o.orderType}
                          </Badge>
                        </td>
                        <td className="px-4 py-2">
                          <Badge variant="outline" className={`text-xs ${o.side === "BUY" ? "bg-blue-50 text-blue-700" : "bg-orange-50 text-orange-700"}`}>
                            {o.side}
                          </Badge>
                        </td>
                        <td className="px-4 py-2 text-right font-mono">{o.remainingQuantity ?? o.totalSize}</td>
                        <td className="px-4 py-2 text-right font-mono font-semibold">
                          {o.price ? `$${Number(o.price).toFixed(2)}` : "—"}
                        </td>
                        <td className="px-4 py-2">
                          <Badge variant="outline" className="text-xs">{o.status}</Badge>
                        </td>
                        <td className="px-4 py-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0 text-[#FF6B6B] hover:text-red-700"
                            onClick={() => handleCancelOrder(o.orderId)}
                            title="Cancel order"
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── IBKR Positions ── */}
      {isConnected && positions.length > 0 && showPositions && (
        <Card className="border shadow-sm">
          <CardHeader className="pb-2 pt-4 px-5">
            <CardTitle className="text-sm font-semibold">IBKR Positions ({positions.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/20 border-b">
                    <th className="text-left px-4 py-2 font-semibold">Ticker</th>
                    <th className="text-right px-4 py-2 font-semibold">Qty</th>
                    <th className="text-right px-4 py-2 font-semibold">Avg Cost</th>
                    <th className="text-right px-4 py-2 font-semibold">Mkt Price</th>
                    <th className="text-right px-4 py-2 font-semibold">Mkt Value</th>
                    <th className="text-right px-4 py-2 font-semibold">Unrealized P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-muted/10">
                      <td className="px-4 py-2 font-mono font-bold">{p.ticker || p.contractDesc}</td>
                      <td className="px-4 py-2 text-right font-mono">{p.position}</td>
                      <td className="px-4 py-2 text-right font-mono">${p.avgCost?.toFixed(2)}</td>
                      <td className="px-4 py-2 text-right font-mono">${p.mktPrice?.toFixed(2)}</td>
                      <td className="px-4 py-2 text-right font-mono">${p.mktValue?.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td className={`px-4 py-2 text-right font-mono font-semibold ${p.unrealizedPnl >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"}`}>
                        {p.unrealizedPnl >= 0 ? "+" : ""}${p.unrealizedPnl?.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}



      {isConnected && positions.length === 0 && openOrders.length === 0 && !loadingData && showPositions && (
        <p className="text-xs text-muted-foreground text-center py-2">No open positions or orders in this account.</p>
      )}
    </div>
  );
}

// Export the requestOrderConfirmation pattern for parent components that place orders
export type { PendingOrder };
export { IBKRPanel as default };
