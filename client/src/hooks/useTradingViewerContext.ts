import { trpc } from "@/lib/trpc";

/** Nav + overview capabilities for scoped trading-book viewers (e.g. Dror). */
export function useTradingViewerContext() {
  const q = trpc.tradingAccounts.viewerContext.useQuery(undefined, {
    staleTime: 60_000,
  });
  const nav = q.data?.nav;
  return {
    ...q,
    isScopedViewer: q.data?.isScopedViewer ?? false,
    primaryAccountSlug: q.data?.primaryAccountSlug ?? null,
    primaryAccountLabel: q.data?.primaryAccountLabel ?? null,
    warRoomPath: q.data?.warRoomPath ?? "/war-room-live",
    overviewAccountSlug: q.data?.overviewAccountSlug ?? "ceo",
    warRoomAccountSwitcher: q.data?.warRoomAccountSwitcher ?? false,
    nav: {
      showH1H2: nav?.showH1H2 ?? true,
      showTransfers: nav?.showTransfers ?? true,
      showKnowledge: nav?.showKnowledge ?? true,
      showSettings: nav?.showSettings ?? true,
      showSystemLogs: nav?.showSystemLogs ?? false,
      showWarReport: nav?.showWarReport ?? false,
      overviewOnlyHolding1: nav?.overviewOnlyHolding1 ?? false,
      mergeTradingBooksInOverview: nav?.mergeTradingBooksInOverview ?? false,
    },
  };
}
