/**
 * IbkrSessionGuard
 *
 * Wraps the app's protected routes. Tracks user inactivity.
 * After 60 minutes of no activity:
 *   1. Sets a "session expired" flag in sessionStorage
 *   2. Redirects to /settings so the user can reconnect via IBIND Session Gate
 */


import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { useInactivityTimeout } from "@/hooks/useInactivityTimeout";
import { useAuth } from "@/_core/hooks/useAuth";

export const IBKR_INACTIVITY_KEY = "ibkr_session_expired_inactivity";

export function IbkrSessionGuard({ children }: { children: React.ReactNode }) {
  const [, navigate] = useLocation();
  const { user } = useAuth();

  const handleTimeout = useCallback(async () => {
    // Set flag so Settings page can show the expiry banner
    sessionStorage.setItem(IBKR_INACTIVITY_KEY, "1");

    // Show toast and redirect to Settings
    toast.warning("Session expired due to inactivity — reconnect via Session Gate.", {
      duration: 8000,
    });

    navigate("/settings");
  }, [navigate]);

  // Only run when a user is logged in
  useInactivityTimeout({
    timeoutMs: 60 * 60 * 1000, // 60 minutes
    onTimeout: handleTimeout,
    enabled: !!user,
  });

  return <>{children}</>;
}

/**
 * Hook used by the Settings page to check if the session expired due to inactivity.
 * Returns the flag and a function to clear it.
 */
export function useIbkrInactivityExpired() {
  const [expired, setExpired] = useState(() =>
    sessionStorage.getItem(IBKR_INACTIVITY_KEY) === "1"
  );

  const clearExpired = useCallback(() => {
    sessionStorage.removeItem(IBKR_INACTIVITY_KEY);
    setExpired(false);
  }, []);

  // Also clear when component unmounts (user navigated away)
  useEffect(() => {
    return () => {
      sessionStorage.removeItem(IBKR_INACTIVITY_KEY);
    };
  }, []);

  return { expired, clearExpired };
}
