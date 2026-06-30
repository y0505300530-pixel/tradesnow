/**
 * IbkrRefreshContext — Global IBKR Refresh State
 *
 * Provides a single source of truth for:
 *  - lastUpdated: timestamp of the last successful IBKR price fetch
 *  - isRefreshing: true while a manual refresh is in progress
 *  - triggerRefresh: function that invalidates all IBKR quote queries simultaneously
 *
 * Any component that calls useIbkrRefresh() will re-render when these values change,
 * ensuring every screen shows the same "Last Updated: HH:MM:SS" timestamp.
 */

import React, { createContext, useContext, useState, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { trpc } from "@/lib/trpc";

interface IbkrRefreshState {
  lastUpdated: number | null;   // Unix ms timestamp of last successful IBKR fetch
  isRefreshing: boolean;
  /** Call this to force-refresh all IBKR quote queries at once */
  triggerRefresh: () => Promise<void>;
  /** Called by useIbkrMarketData when a fetch succeeds — updates lastUpdated */
  notifyUpdated: (ts: number) => void;
}

const IbkrRefreshContext = createContext<IbkrRefreshState>({
  lastUpdated: null,
  isRefreshing: false,
  triggerRefresh: async () => {},
  notifyUpdated: () => {},
});

export function IbkrRefreshProvider({ children }: { children: React.ReactNode }) {
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const queryClient = useQueryClient();
  const refreshingRef = useRef(false);

  const notifyUpdated = useCallback((ts: number) => {
    setLastUpdated(ts);
  }, []);

  const triggerRefresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    try {
      // Invalidate ALL getIbkrQuotes queries (H1, H2, Catalogue share the same procedure)
      // tRPC query keys follow the pattern: [['ibkr', 'getIbkrQuotes'], { type: 'query', ... }]
      await queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey as unknown[];
          if (!Array.isArray(key) || key.length < 1) return false;
          const path = key[0];
          if (!Array.isArray(path)) return false;
          const r = path[0] as string;
          const p = path[1] as string;
          if (r === "ibkr") {
            return ["getIbkrQuotes", "getMarketSnapshot", "getPnl", "getAccountSummary", "getPositions"].includes(p);
          }
          if (r === "portfolio") return ["getLivePrices", "getState"].includes(p);
          if (r === "holding2") return p === "list";
          if (r === "liveEngine") {
            return ["getStatus", "getElzaTrades", "getAllLiveOrders"].includes(p);
          }
          return false;
        },
      });
      await queryClient.refetchQueries({ type: "active" });
      setLastUpdated(Date.now());
    } finally {
      setIsRefreshing(false);
      refreshingRef.current = false;
    }
  }, [queryClient]);

  return (
    <IbkrRefreshContext.Provider value={{ lastUpdated, isRefreshing, triggerRefresh, notifyUpdated }}>
      {children}
    </IbkrRefreshContext.Provider>
  );
}

export function useIbkrRefresh() {
  return useContext(IbkrRefreshContext);
}
