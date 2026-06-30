/**
 * IBINDPanel
 *
 * IBIND connection panel — OAuth 1.0a bridge to IBKR via voyz/ibind.
 * Completely separate from IBEAM. No shared state, no shared code.
 *
 * Always visible — no toggle required.
 * Flow:
 *   1. Panel loads → auto-checks /api/ibind/health
 *   2. User clicks "התחבר ל-IBIND" → POST /api/ibind/session/start (up to 30s)
 *   3. On success → green badge "מחובר"
 *   4. Background polling every 30s → GET /api/ibind/health → updates status
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  Wifi,
  Zap,
  ChevronDown,
  ChevronUp,
  Clock,
  Square,
  Play,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

const POLL_INTERVAL_MS = 30_000;

interface IbindHealth {
  status: string;
  session_active: boolean | string;
  consumer_key?: string;
  server_ip?: string;
  timestamp?: string;
  error?: string;
}

interface LogEntry {
  time: Date;
  message: string;
  type: "info" | "success" | "error";
}

export function IBINDPanel() {
  const [health, setHealth] = useState<IbindHealth | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const addLog = useCallback((message: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => [{ time: new Date(), message, type }, ...prev].slice(0, 20));
  }, []);

  // ── Health check ───────────────────────────────────────────────────────────
  const checkHealth = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await fetch("/api/ibind/health");
      const data = await res.json() as IbindHealth;
      setHealth(data);
      setLastChecked(new Date());
      if (!silent) {
        addLog(`Health check: session_active=${data.session_active}, status=${data.status}`, data.session_active ? "success" : "info");
      }
    } catch (err: any) {
      const errData: IbindHealth = { status: "error", session_active: false, error: err.message };
      setHealth(errData);
      setLastChecked(new Date());
      if (!silent) addLog(`Health check failed: ${err.message}`, "error");
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, [addLog]);

  // ── Auto-poll on mount ─────────────────────────────────────────────────────
  useEffect(() => {
    checkHealth();
    pollRef.current = setInterval(() => checkHealth(true), POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [checkHealth]);

  // ── Connect (session/start) ────────────────────────────────────────────────
  const handleConnect = useCallback(async () => {
    setConnecting(true);
    addLog("Sending POST /session/start...", "info");
    toast.info("מתחבר ל-IBIND... (עד 30 שניות)", { duration: 30_000, id: "ibind-connect" });
    try {
      const res = await fetch("/api/ibind/session/start", { method: "POST" });
      const data = await res.json() as { success?: boolean; session_active?: boolean; message?: string };
      toast.dismiss("ibind-connect");
      if (data.success || data.session_active) {
        toast.success("✅ IBIND מחובר בהצלחה");
        addLog(`Session started: ${data.message ?? "success"}`, "success");
        await checkHealth();
      } else {
        toast.error(`❌ IBIND: ${data.message ?? "חיבור נכשל"}`);
        addLog(`Session start failed: ${data.message ?? "unknown error"}`, "error");
        setHealth({ status: "error", session_active: false, error: data.message });
      }
    } catch (err: any) {
      toast.dismiss("ibind-connect");
      toast.error(`❌ IBIND שגיאה: ${err.message}`);
      addLog(`Exception: ${err.message}`, "error");
      setHealth({ status: "error", session_active: false, error: err.message });
    } finally {
      setConnecting(false);
    }
  }, [checkHealth, addLog]);

  // ── IBIND Manual Disconnect/Reconnect ──────────────────────────────────────
  const disconnectStatus = trpc.ibkr.getIbindDisconnectStatus.useQuery(undefined, {
    refetchInterval: 30_000,
  });
  const disconnectMut = trpc.ibkr.ibindManualDisconnect.useMutation({
    onSuccess: () => {
      toast.success("⏹ IBIND נותק בהצלחה");
      disconnectStatus.refetch();
      addLog("IBIND manually disconnected", "info");
    },
    onError: (err) => toast.error(`שגיאה: ${err.message}`),
  });
  const reconnectMut = trpc.ibkr.ibindManualReconnect.useMutation({
    onSuccess: () => {
      toast.success("▶️ IBIND חובר מחדש");
      disconnectStatus.refetch();
      checkHealth();
      addLog("IBIND manually reconnected", "success");
    },
    onError: (err) => toast.error(`שגיאה: ${err.message}`),
  });
  const isManuallyDisconnected = disconnectStatus.data?.disconnected === true;
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

  // ── Derived state ──────────────────────────────────────────────────────────
  const isConnected = (health?.session_active === true || health?.session_active === "true") && health?.status === "ok";
  const isError = health !== null && !health.session_active;
  const isLoading = health === null;

  return (
    <div className="rounded-xl border border-border bg-card/50 overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0">
            <Zap className="w-4 h-4 text-[#2563EB]" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-foreground">חיבור IBIND</span>
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono text-[#2563EB] border-violet-400">OAuth 1.0a</Badge>
              {/* Status badge */}
              {isLoading && (
                <Badge variant="secondary" className="text-xs gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" />בודק...
                </Badge>
              )}
              {!isLoading && isConnected && (
                <Badge className="text-xs gap-1 bg-emerald-500/15 text-[#65A30D] border border-emerald-400">
                  <CheckCircle2 className="w-3 h-3" />מחובר
                </Badge>
              )}
              {!isLoading && isError && (
                <Badge className="text-xs gap-1 bg-red-500/15 text-[#FF6B6B] border border-red-400">
                  <XCircle className="w-3 h-3" />לא מחובר
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">גשר ישיר ל-IBKR דרך voyz/ibind — ללא iBeam</p>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="outline"
            onClick={() => checkHealth()}
            disabled={refreshing || connecting}
            className="gap-1.5 h-8 px-2.5"
          >
            {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            <span className="text-xs">רענן</span>
          </Button>
          <Button
            size="sm"
            onClick={handleConnect}
            disabled={connecting || refreshing}
            className="gap-1.5 h-8 px-3 bg-violet-600 hover:bg-violet-700 text-white"
          >
            {connecting ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span className="text-xs">מתחבר...</span></>
            ) : (
              <><Wifi className="w-3.5 h-3.5" /><span className="text-xs">התחבר ל-IBIND</span></>
            )}
          </Button>
        </div>
      </div>

      {/* ── Info grid ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border/30">
        {[
          { label: "שרת", value: "143.198.141.131:80" },
          { label: "Consumer Key", value: health?.consumer_key ?? "—" },
          {
            label: "Session Active",
            value: isLoading ? "בודק..." : isConnected ? "✓ פעיל" : "✗ לא פעיל",
            color: isLoading ? "" : isConnected ? "text-[#65A30D]" : "text-[#FF6B6B]",
          },
          {
            label: "עדכון אחרון",
            value: lastChecked ? lastChecked.toLocaleTimeString("he-IL") : "—",
          },
        ].map((item) => (
          <div key={item.label} className="bg-muted/20 px-3 py-2.5 space-y-0.5">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{item.label}</p>
            <p className={`text-xs font-mono font-medium ${item.color ?? "text-foreground"}`}>{item.value}</p>
          </div>
        ))}
      </div>

      {/* ── Error message ── */}
      {health?.error && (
        <div className="mx-4 mt-3 rounded-lg bg-red-500/10 border border-red-400/30 px-3 py-2 text-xs text-[#FF6B6B]">
          <span className="font-medium">שגיאה: </span>{health.error}
        </div>
      )}

      {/* ── Manual Disconnect/Reconnect Control ── */}
      <div className="mx-4 mt-3 rounded-lg border border-border/50 bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className={`w-2.5 h-2.5 rounded-full ${isManuallyDisconnected ? "bg-red-500 animate-pulse" : "bg-emerald-500"}`} />
            <span className="text-xs font-medium text-foreground">
              {isManuallyDisconnected ? "נותק ידנית" : "מחובר"}
            </span>
            {isManuallyDisconnected && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-red-400 border-red-400">
                כל הקריאות חסומות
              </Badge>
            )}
          </div>
          {isManuallyDisconnected ? (
            <Button
              size="sm"
              onClick={() => reconnectMut.mutate()}
              disabled={reconnectMut.isPending}
              className="gap-1.5 h-7 px-3 bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
            >
              {reconnectMut.isPending ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Play className="w-3 h-3" />
              )}
              התחבר שוב
            </Button>
          ) : showDisconnectConfirm ? (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-red-400">בטוח?</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowDisconnectConfirm(false)}
                className="h-6 px-2 text-[10px]"
              >
                ביטול
              </Button>
              <Button
                size="sm"
                onClick={() => { disconnectMut.mutate(); setShowDisconnectConfirm(false); }}
                disabled={disconnectMut.isPending}
                className="h-6 px-2 text-[10px] bg-red-600 hover:bg-red-700 text-white"
              >
                {disconnectMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "נתק"}
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowDisconnectConfirm(true)}
              disabled={disconnectMut.isPending}
              className="gap-1.5 h-7 px-3 border-red-400 text-red-400 hover:bg-red-500/10 text-xs"
            >
              <Square className="w-3 h-3" />
              עצור IBIND
            </Button>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground mt-1.5">
          ינתק את IBIND מ-IBKR. האתר לא יתחבר עד שתלחץ "התחבר שוב".
        </p>
      </div>

      {/* ── Connection Log toggle ── */}
      <div className="px-4 pb-3 pt-3">
        <button
          onClick={() => setShowLogs((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Clock className="w-3.5 h-3.5" />
          Connection Log
          {showLogs ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {logs.length > 0 && (
            <span className="ml-1 text-[10px] bg-muted rounded-full px-1.5 py-0.5">{logs.length}</span>
          )}
        </button>

        {showLogs && (
          <div className="mt-2 rounded-lg bg-muted/30 border border-border/50 p-2 space-y-1 max-h-40 overflow-y-auto font-mono text-[11px]">
            {logs.length === 0 ? (
              <p className="text-muted-foreground text-center py-2">אין לוגים עדיין</p>
            ) : (
              logs.map((entry, i) => (
                <div key={i} className={`flex gap-2 ${
                  entry.type === "success" ? "text-[#65A30D]" :
                  entry.type === "error" ? "text-[#FF6B6B]" :
                  "text-muted-foreground"
                }`}>
                  <span className="shrink-0 opacity-60">{entry.time.toLocaleTimeString("he-IL")}</span>
                  <span>{entry.message}</span>
                </div>
              ))
            )}
          </div>
        )}

        <p className="text-[10px] text-muted-foreground mt-2">
          בדיקת סטטוס אוטומטית כל 30 שניות • אין צורך ב-2FA
        </p>
      </div>
    </div>
  );
}
