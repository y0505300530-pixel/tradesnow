/**
 * useLivePrices
 *
 * Manages live price data for holdings.
 *
 * Architecture (Phase C):
 *   - usePriceStream opens a single SSE connection to /api/prices/stream
 *     and injects every incoming price directly into the React Query cache
 *     via queryClient.setQueryData — no HTTP re-fetch triggered.
 *   - The tRPC query below reads from that same cache entry, so the
 *     holdingLivePriceMap is always up-to-date without any polling loop.
 *   - During market hours (NYSE/TASE) the server pushes every ~15 s.
 *   - Outside market hours the server pushes every ~5 min.
 *   - When IBKR /quotes is actively delivering, SSE may stand down.
 *   - HTTP polling (10s) always runs as a safety net so prices never freeze.
 *
 * Public interface is identical to the previous polling version so all
 * UI components remain completely unaware of the architecture change.
 */
import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { usePriceStream } from "@/hooks/usePriceStream";

export interface LivePriceFeedOptions {
  /** IBKR /quotes returned at least one live price — safe to pause SSE */
  ibkrQuotesActive?: boolean;
}

function isAnyMarketSessionOpen(): boolean {
  const now = new Date();
  const day = now.getUTCDay();
  const month = now.getUTCMonth();
  const etOffsetHours = month >= 2 && month <= 10 ? 4 : 5;
  const etMinutes = (now.getUTCHours() - etOffsetHours) * 60 + now.getUTCMinutes();
  if (day >= 1 && day <= 5 && etMinutes >= 4 * 60 && etMinutes < 20 * 60) return true;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (day >= 1 && day <= 5 && utcMinutes >= 6 * 60 && utcMinutes < 14 * 60 + 30) return true;
  return false;
}

export function useLivePrices(
  holdings: { ticker: string }[],
  ibkrStatus: "disconnected" | "connecting" | "connected" | "error",
  options?: LivePriceFeedOptions,
) {
  // Stable ticker list — only recompute when the ticker set changes
  const holdingTickers = useMemo(
    () => holdings.map(h => h.ticker),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [holdings.map(h => h.ticker).join(",")]
  );

  // SSE only when IBKR is NOT actively delivering quotes (fixes frozen Overview when /quotes fails)
  const ibkrQuotesActive = options?.ibkrQuotesActive ?? false;
  const suppressSse = ibkrStatus === "connected" && ibkrQuotesActive;
  usePriceStream(holdingTickers, suppressSse);

  const pollIntervalMs = isAnyMarketSessionOpen() ? 10_000 : 60_000;

  const {
    data: holdingLivePrices,
    dataUpdatedAt: pricesUpdatedAt,
    refetch: refetchLivePrices,
  } = trpc.portfolio.getLivePrices.useQuery(
    { tickers: holdingTickers },
    {
      enabled: holdingTickers.length > 0,
      staleTime: 5_000,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
      refetchInterval: pollIntervalMs,
    }
  );

  // ── Build ticker → price map ─────────────────────────────────────────────
  const holdingLivePriceMap = useMemo(() => {
    const map: Record<string, {
      price: number | null;
      change: number | null;
      changePercent: number | null;
      prevClose: number | null;
      isExtendedHours?: boolean;
    }> = {};
    (holdingLivePrices ?? []).forEach(p => {
      map[p.ticker] = {
        price: p.price,
        change: (p as any).change ?? null,
        changePercent: p.changePercent,
        prevClose: (p as any).prevClose ?? null,
        isExtendedHours: (p as any).isExtendedHours ?? false,
      };
    });
    return map;
  }, [holdingLivePrices]);

  // ── Market hours helper (NYSE: Mon–Fri 09:30–16:00 ET) ───────────────────
  // Kept for UI indicators (e.g. "Market Open" badge) — no longer drives polling.
  const isMarketOpen = useMemo(() => {
    const now = new Date();
    const day = now.getUTCDay();
    if (day === 0 || day === 6) return false;
    const month = now.getUTCMonth();
    const etOffsetHours = month >= 2 && month <= 10 ? 4 : 5;
    const etHour = now.getUTCHours() - etOffsetHours;
    const etMin = now.getUTCMinutes();
    const etMinutes = etHour * 60 + etMin;
    return etMinutes >= 9 * 60 + 30 && etMinutes < 16 * 60;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Math.floor(Date.now() / 60_000)]);

  return {
    holdingLivePrices,
    holdingLivePriceMap,
    pricesUpdatedAt,
    refetchLivePrices,
    isMarketOpen,
  };
}
