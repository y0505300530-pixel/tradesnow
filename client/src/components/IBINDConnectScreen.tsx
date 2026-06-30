/**
 * IBINDConnectScreen — shown when IBIND session is inactive.
 * Displays the reason the session was closed and a Connect button.
 * On connect: calls POST /session/start, then polls every 1s until active.
 */
import { useState, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Clock, Calendar, LogOut, WifiOff, Wifi, Loader2, AlertCircle } from "lucide-react";

interface IBINDConnectScreenProps {
  closedReason: "manual" | "inactivity" | "daily" | null;
  closedAt: string | null;
  onConnected: (accountId: string | null) => void;
}

function reasonInfo(reason: "manual" | "inactivity" | "daily" | null) {
  switch (reason) {
    case "inactivity":
      return {
        Icon: Clock,
        iconClass: "text-amber-500",
        title: "Session נסגרה — חוסר פעילות",
        desc: "החיבור ל-IBKR נסגר אוטומטית לאחר 30 דקות ללא פעילות.",
      };
    case "daily":
      return {
        Icon: Calendar,
        iconClass: "text-[#2563EB]",
        title: "Session נסגרה — סגירה יומית",
        desc: "החיבור ל-IBKR נסגר אוטומטית בחצות (00:00 GMT+3).",
      };
    case "manual":
      return {
        Icon: LogOut,
        iconClass: "text-slate-400",
        title: "Session נסגרה ידנית",
        desc: "החיבור ל-IBKR נותק ידנית.",
      };
    default:
      return {
        Icon: WifiOff,
        iconClass: "text-[#FF6B6B]",
        title: "לא מחובר ל-IBKR",
        desc: "אין חיבור פעיל ל-IBKR דרך IBIND.",
      };
  }
}

export function IBINDConnectScreen({ closedReason, closedAt, onConnected }: IBINDConnectScreenProps) {
  const [phase, setPhase] = useState<"idle" | "starting" | "polling" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startSession = trpc.ibkr.startSession.useMutation();
  const utils = trpc.useUtils();

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  };

  useEffect(() => () => stopPolling(), []);

  const handleConnect = async () => {
    setPhase("starting");
    setErrorMsg(null);
    try {
      const result = await startSession.mutateAsync();
      if (result.alreadyActive || result.sessionActive) {
        stopPolling();
        onConnected(result.accountId);
        return;
      }
      // Poll every 1s until session_active = true
      setPhase("polling");
      pollRef.current = setInterval(async () => {
        try {
          const status = await utils.ibkr.getSessionStatus.fetch();
          if (status.sessionActive) {
            stopPolling();
            onConnected(status.accountId);
          }
        } catch {
          // keep polling
        }
      }, 1000);
      // Timeout after 30s
      timeoutRef.current = setTimeout(() => {
        stopPolling();
        setPhase("error");
        setErrorMsg("Connection timed out after 30s — check IBKR credentials on the server");
      }, 30_000);
    } catch (err: unknown) {
      stopPolling();
      setPhase("error");
      const msg = err instanceof Error ? err.message : "Unknown error";
      setErrorMsg(msg);
    }
  };

  const { Icon, iconClass, title, desc } = reasonInfo(closedReason);
  const isConnecting = phase === "starting" || phase === "polling";

  const closedAtFormatted = closedAt
    ? new Date(closedAt).toLocaleString("he-IL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 p-8">
      {/* Status card */}
      <div className="bg-card border border-border rounded-2xl p-8 max-w-md w-full text-center shadow-lg">
        <div className="flex justify-center mb-4">
          <div className="rounded-full bg-muted p-4">
            <Icon className={`h-10 w-10 ${iconClass}`} />
          </div>
        </div>

        <h2 className="text-xl font-bold text-foreground mb-2">{title}</h2>
        <p className="text-muted-foreground text-sm mb-1">{desc}</p>

        {closedAtFormatted && (
          <p className="text-xs text-muted-foreground mt-1">
            נסגר ב-{closedAtFormatted}
          </p>
        )}

        {phase === "error" && errorMsg && (
          <div className="mt-4 flex items-start gap-2 bg-destructive/10 text-destructive rounded-lg p-3 text-sm text-right">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {phase === "polling" && (
          <div className="mt-4 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>מתחבר ל-IBKR... (3-8 שניות)</span>
          </div>
        )}

        <Button
          className="mt-6 w-full gap-2"
          size="lg"
          onClick={handleConnect}
          disabled={isConnecting}
        >
          {isConnecting ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> מתחבר...</>
          ) : (
            <><Wifi className="h-4 w-4" /> התחבר ל-IBKR</>
          )}
        </Button>
      </div>
    </div>
  );
}
