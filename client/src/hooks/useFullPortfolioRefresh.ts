/**
 * useFullPortfolioRefresh — one-click refresh for all portfolio + war-room price data
 */
import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { useIbkrRefresh } from "@/contexts/IbkrRefreshContext";
import { toast } from "sonner";

function shouldRefetchTrpcQuery(path: unknown): boolean {
  if (!Array.isArray(path) || path.length < 2) return false;
  const [router, procedure] = path as [string, string];
  if (router === "ibkr") {
    return ["getIbkrQuotes", "getPnl", "getAccountSummary", "getPositions", "getMonitorStatus"].includes(procedure);
  }
  if (router === "portfolio") {
    return ["getLivePrices", "getState"].includes(procedure);
  }
  if (router === "holding2") return procedure === "list";
  if (router === "liveEngine") {
    return ["getStatus", "getElzaTrades", "getAllLiveOrders", "getLiveCircuitBreaker"].includes(procedure);
  }
  return false;
}

export function useFullPortfolioRefresh() {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const { notifyUpdated, lastUpdated: ctxTs } = useIbkrRefresh();
  const [refreshing, setRefreshing] = useState(false);
  const [lastManual, setLastManual] = useState<Date | null>(null);
  const busy = useRef(false);

  const refreshAll = useCallback(async (opts?: {
    ibkrRefetch?: () => void;
    h1LiveRefetch?: () => void | Promise<unknown>;
    h2LiveRefetch?: () => void | Promise<unknown>;
    extra?: Array<() => void | Promise<unknown>>;
    silent?: boolean;
    warRoom?: boolean;
  }) => {
    if (busy.current) return;
    busy.current = true;
    setRefreshing(true);
    try {
      const tasks: Array<Promise<unknown>> = [
        utils.client.portfolio.refreshPrices.mutate().catch(() => null),
        utils.client.holding2.refreshPrices.mutate().catch(() => null),
      ];
      if (opts?.warRoom) {
        tasks.push(utils.client.liveEngine.runSlMonitor.mutate().catch(() => null));
      }
      if (opts?.ibkrRefetch) tasks.push(Promise.resolve(opts.ibkrRefetch()));
      if (opts?.h1LiveRefetch) tasks.push(Promise.resolve(opts.h1LiveRefetch()));
      if (opts?.h2LiveRefetch) tasks.push(Promise.resolve(opts.h2LiveRefetch()));
      for (const fn of opts?.extra ?? []) tasks.push(Promise.resolve(fn()));

      await Promise.allSettled(tasks);

      await queryClient.invalidateQueries({
        predicate: (q) => shouldRefetchTrpcQuery((q.queryKey as unknown[])?.[0]),
      });
      await queryClient.refetchQueries({ type: "active" });

      const now = new Date();
      setLastManual(now);
      notifyUpdated(now.getTime());
      if (!opts?.silent) toast.success("מחירים עודכנו");
    } catch {
      if (!opts?.silent) toast.error("רענון נכשל");
    } finally {
      setRefreshing(false);
      busy.current = false;
    }
  }, [utils, queryClient, notifyUpdated]);

  const lastUpdated =
    lastManual ?? (ctxTs != null ? new Date(ctxTs) : null);

  return { refreshAll, refreshing, lastUpdated, setLastUpdated: setLastManual };
}
