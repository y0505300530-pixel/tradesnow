/**
 * IbkrTickleContext — IBIND only
 *
 * Checks IBIND session health every 30 seconds.
 * Exposes:
 *   - ibindConnected: boolean         — whether IBIND session is active
 *   - isAnyBrokerConnected: boolean   — alias for ibindConnected
 *   - activeBroker: "ibind" | null    — which broker is active
 *   - refreshConnection: () => void   — force an immediate re-check
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useAuth } from "@/_core/hooks/useAuth";

const IBIND_CHECK_INTERVAL_CONNECTED_MS = 30_000;   // 30s when connected
const IBIND_CHECK_INTERVAL_DISCONNECTED_MS = 120_000; // 120s when disconnected (perf fix)

interface IbkrTickleContextValue {
  ibkrConnected: boolean;        // always false — iBeam removed
  ibindConnected: boolean;
  isAnyBrokerConnected: boolean;
  activeBroker: "ibind" | null;
  refreshConnection: () => void;
}

const IbkrTickleContext = createContext<IbkrTickleContextValue>({
  ibkrConnected: false,
  ibindConnected: false,
  isAnyBrokerConnected: false,
  activeBroker: null,
  refreshConnection: () => {},
});

export function IbkrTickleProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [ibindConnected, setIbindConnected] = useState(false);
  const ibindCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ibindConnectedRef = useRef(false); // stable ref for interval callback

  const scheduleNextCheck = useCallback((isConnected: boolean) => {
    if (ibindCheckRef.current) clearInterval(ibindCheckRef.current);
    const interval = isConnected
      ? IBIND_CHECK_INTERVAL_CONNECTED_MS
      : IBIND_CHECK_INTERVAL_DISCONNECTED_MS;
    ibindCheckRef.current = setInterval(() => checkIbindRef.current?.(), interval);
  }, []);

  const checkIbindRef = useRef<(() => Promise<void>) | null>(null);

  const checkIbind = useCallback(async () => {
    try {
      const res = await fetch("/api/ibind/health", { signal: AbortSignal.timeout(3500) });
      if (!res.ok) {
        const wasConnected = ibindConnectedRef.current;
        setIbindConnected(false);
        ibindConnectedRef.current = false;
        if (wasConnected) scheduleNextCheck(false); // slow down
        return;
      }
      const data = await res.json() as { session_active?: boolean | string; status?: string };
      const nowConnected = (data.session_active === true || data.session_active === "true") && data.status === "ok";
      const wasConnected = ibindConnectedRef.current;
      setIbindConnected(nowConnected);
      ibindConnectedRef.current = nowConnected;
      // Reschedule only when connection state changes (avoid redundant clearInterval)
      if (nowConnected !== wasConnected) scheduleNextCheck(nowConnected);
    } catch {
      const wasConnected = ibindConnectedRef.current;
      setIbindConnected(false);
      ibindConnectedRef.current = false;
      if (wasConnected) scheduleNextCheck(false); // slow down
    }
  }, [scheduleNextCheck]);

  // Keep ref in sync so interval callback always calls latest version
  checkIbindRef.current = checkIbind;

  const refreshConnection = useCallback(() => {
    checkIbind();
  }, [checkIbind]);

  useEffect(() => {
    // Only admin users should poll IBIND health — non-admin users have no IBKR access
    const isAdmin = user?.role === "admin";
    if (!user || !isAdmin) {
      if (ibindCheckRef.current) clearInterval(ibindCheckRef.current);
      ibindCheckRef.current = null;
      setIbindConnected(false);
      ibindConnectedRef.current = false;
      return;
    }

    // Start with disconnected interval; will speed up once connected
    checkIbind();
    scheduleNextCheck(false);

    return () => {
      if (ibindCheckRef.current) clearInterval(ibindCheckRef.current);
    };
  }, [user, checkIbind, scheduleNextCheck]);

  const activeBroker: "ibind" | null = ibindConnected ? "ibind" : null;

  return (
    <IbkrTickleContext.Provider value={{
      ibkrConnected: false,
      ibindConnected,
      isAnyBrokerConnected: ibindConnected,
      activeBroker,
      refreshConnection,
    }}>
      {children}
    </IbkrTickleContext.Provider>
  );
}

export function useIbkrTickle() {
  return useContext(IbkrTickleContext);
}
