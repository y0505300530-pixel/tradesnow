/**
 * usePriceStream
 *
 * Connects to GET /api/prices/stream?tickers=... via EventSource (SSE).
 * On every price event, it merges the new price into the React Query cache
 * for trpc.portfolio.getLivePrices so all consumers (useLivePrices, H1H2Dashboard,
 * etc.) receive the update without triggering a new HTTP request.
 *
 * The hook is a no-op when:
 *   - tickers array is empty
 *   - the browser tab is hidden (pauses SSE to save resources)
 *   - suppressSse is true (IBKR /quotes is actively delivering)
 *
 * The backend sends an adaptive interval:
 *   - 15 s during NYSE / TASE trading hours
 *   - 5 min outside trading hours
 */
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { trpc } from "@/lib/trpc";

/** Shape of each SSE data event from /api/prices/stream */
interface PriceEvent {
  ticker: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  isExtendedHours: boolean;
}

/** Shape stored in React Query cache by getLivePrices */
type LivePriceRow = {
  ticker: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  isExtendedHours: boolean;
};

export function usePriceStream(
  tickers: string[],
  suppressSse: boolean,
) {
  const queryClient = useQueryClient();
  // Stable string key so the effect only re-runs when the ticker set changes
  const tickersKey = tickers.slice().sort().join(",");
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // Don't open SSE when IBKR /quotes is actively supplying prices
    if (suppressSse) return;
    if (tickers.length === 0) return;

    const url = `/api/prices/stream?tickers=${encodeURIComponent(tickers.join(","))}`;

    let es: EventSource;
    let closed = false;

    const open = () => {
      if (closed) return;
      es = new EventSource(url, { withCredentials: true });
      esRef.current = es;

      es.onmessage = (evt) => {
        let payload: PriceEvent;
        try {
          payload = JSON.parse(evt.data) as PriceEvent;
        } catch {
          return;
        }

        // Build the exact tRPC query key for getLivePrices({ tickers })
        // tRPC v11 + @trpc/react-query: getQueryKey(router.procedure, input, "query")
        const qKey = getQueryKey(
          trpc.portfolio.getLivePrices,
          { tickers },
          "query"
        );

        // Merge the incoming price into the cached array
        queryClient.setQueryData<LivePriceRow[]>(qKey, (prev) => {
          if (!prev) {
            // Cache miss — seed with just this ticker
            return [payload];
          }
          const exists = prev.some(r => r.ticker === payload.ticker);
          if (exists) {
            return prev.map(r =>
              r.ticker === payload.ticker ? { ...r, ...payload } : r
            );
          }
          return [...prev, payload];
        });
      };

      es.onerror = () => {
        // EventSource will auto-retry after a back-off; just clean up the ref
        esRef.current = null;
      };
    };

    // Pause SSE when the tab is hidden to save resources
    const handleVisibility = () => {
      if (document.hidden) {
        esRef.current?.close();
        esRef.current = null;
      } else {
        open();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    open();

    return () => {
      closed = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      esRef.current?.close();
      esRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickersKey, suppressSse, queryClient]);
}
