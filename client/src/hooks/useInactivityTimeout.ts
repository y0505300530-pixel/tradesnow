/**
 * useInactivityTimeout
 *
 * Tracks user activity (mousemove, keydown, click, touchstart, scroll).
 * If no activity for `timeoutMs` milliseconds, calls the provided onTimeout callback.
 *
 * The timer resets on every user interaction event.
 */

import { useEffect, useRef, useCallback } from "react";

const ACTIVITY_EVENTS = [
  "mousemove",
  "mousedown",
  "keydown",
  "touchstart",
  "scroll",
  "click",
] as const;

interface UseInactivityTimeoutOptions {
  /** Inactivity duration in ms before triggering timeout. Default: 60 minutes */
  timeoutMs?: number;
  /** Called when inactivity timeout fires */
  onTimeout: () => void;
  /** Set to false to disable the hook (e.g. when user is not logged in) */
  enabled?: boolean;
}

export function useInactivityTimeout({
  timeoutMs = 60 * 60 * 1000, // 60 minutes
  onTimeout,
  enabled = true,
}: UseInactivityTimeoutOptions) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTimeoutRef = useRef(onTimeout);

  // Keep ref in sync so we don't need onTimeout in the dependency array
  useEffect(() => {
    onTimeoutRef.current = onTimeout;
  }, [onTimeout]);

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onTimeoutRef.current();
    }, timeoutMs);
  }, [timeoutMs]);

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }

    // Start the timer immediately
    resetTimer();

    // Attach activity listeners
    const handler = () => resetTimer();
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, handler, { passive: true });
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, handler);
      }
    };
  }, [enabled, resetTimer]);
}
