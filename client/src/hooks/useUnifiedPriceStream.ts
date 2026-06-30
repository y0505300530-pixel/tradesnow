/**
 * useUnifiedPriceStream
 *
 * Manages a SINGLE SSE connection to /api/prices/stream that covers ALL
 * watched assets: H1 holdings, H2 holdings, and Asset Catalogue tickers.
 *
 * Design principles:
 *  - One EventSource per browser tab (deduplication via a module-level ref)
 *  - Reconnects automatically on error (native EventSource retry)
 *  - Pauses when the tab is hidden to save resources
 *  - When IBKR is connected, the stream is still kept alive for H2 + Catalogue
 *    (only H1 prices are overridden by IBKR data)
 *
 * Interval tiers (set server-side in priceStream.ts):
 *   15 s  — NYSE or TASE regular trading hours
 *   60 s  — NYSE pre-market / after-hours
 *   5 min — market fully closed
 */
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { trpc } from "@/lib/trpc";

interface PriceEvent {
  ticker: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  prevClose: number | null;
  isExtendedHours: boolean;
}

type LivePriceRow = {
  ticker: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  prevClose: number | null;
  isExtendedHours: boolean;
};

/**
 * Merge an incoming SSE price event into the React Query cache for
 * trpc.portfolio.getLivePrices({ tickers }).
 */
function mergePriceIntoCache(
  queryClient: ReturnType<typeof useQueryClient>,
  tickers: string[],
  payload: PriceEvent
) {
  const qKey = getQueryKey(trpc.portfolio.getLivePrices, { tickers }, "query");
  queryClient.setQueryData<LivePriceRow[]>(qKey, (prev) => {
    if (!prev) return [payload];
    const exists = prev.some((r) => r.ticker === payload.ticker);
    if (exists) {
      return prev.map((r) =>
        r.ticker === payload.ticker ? { ...r, ...payload } : r
      );
    }
    return [...prev, payload];
  });
}

export function useUnifiedPriceStream(options: {
  h1Tickers: string[];
  h2Tickers: string[];
  catalogueTickers: string[];
  ibkrStatus: "disconnected" | "connecting" | "connected" | "error";
}) {
  const { h1Tickers, h2Tickers, catalogueTickers, ibkrStatus } = options;
  const queryClient = useQueryClient();

  // Stable keys to avoid unnecessary reconnects
  const h1Key = h1Tickers.slice().sort().join(",");
  const h2Key = h2Tickers.slice().sort().join(",");
  const catKey = catalogueTickers.slice().sort().join(",");

  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // Combine all unique tickers into one stream
    const allTickers = Array.from(
      new Set([...h1Tickers, ...h2Tickers, ...catalogueTickers])
    );

    if (allTickers.length === 0) return;

    let closed = false;

    const open = () => {
      if (closed) return;
      const url = `/api/prices/stream?tickers=${encodeURIComponent(
        allTickers.join(",")
      )}`;
      const es = new EventSource(url, { withCredentials: true });
      esRef.current = es;

      es.onmessage = (evt) => {
        let payload: PriceEvent;
        try {
          payload = JSON.parse(evt.data) as PriceEvent;
        } catch {
          return;
        }

        // Update the React Query cache for each query key that contains this ticker
        // H1 query key
        if (h1Tickers.includes(payload.ticker)) {
          mergePriceIntoCache(queryClient, h1Tickers, payload);
        }
        // H2 query key
        if (h2Tickers.includes(payload.ticker)) {
          mergePriceIntoCache(queryClient, h2Tickers, payload);
        }
        // Catalogue query key
        if (catalogueTickers.includes(payload.ticker)) {
          mergePriceIntoCache(queryClient, catalogueTickers, payload);
        }
      };

      es.onerror = () => {
        esRef.current = null;
        // EventSource will auto-retry; nothing to do here
      };
    };

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
  }, [h1Key, h2Key, catKey, queryClient]);
  // Note: ibkrStatus intentionally NOT in deps — we keep the stream alive even
  // when IBKR is connected so H2 and Catalogue continue to receive updates.
}
