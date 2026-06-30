/**
 * useIbkrMarketData — Unified 10-second IBKR Market Pulse
 *
 * Single hook that fetches live prices for ALL watched assets (H1, H2, Catalogue)
 * exclusively from IBKR via the IBIND /quotes endpoint.
 *
 * Design:
 *  - H1 tickers: use getIbkrQuotes (same endpoint, but H1 positions are already
 *    in /positions so we get mktPrice there; we also need changePercent per ticker)
 *  - H2 + Catalogue: use getIbkrQuotes (IBIND /quotes with conid resolution)
 *  - .TA symbols: automatically handled by getIbkrQuotes (TASE exchange_hint + agorot÷100÷ILS)
 *  - Polling: refetchInterval = 3_000ms during any trading session (incl. pre-market/after-hours), 5min outside
 *  - When IBKR not connected: returns empty maps (caller falls back to Yahoo/DB)
 *
 * Returns:
 *  - h1PriceMap   : ticker → { price, change, changePercent, prevClose }
 *  - h2PriceMap   : ticker → { price, change, changePercent, prevClose }
 *  - catPriceMap  : ticker → changePercent (for catalogue badge)
 *  - lastUpdated  : timestamp of last successful fetch
 *  - isLoading    : true on first fetch
 *  - error        : error string if fetch failed
 *  - refetch      : force-refetch function (used by manual refresh button)
 */

import { useMemo, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { useIbkrRefresh } from "@/contexts/IbkrRefreshContext";

export interface IbkrPriceEntry {
  price: number | null;
  change: number | null;
  changePercent: number | null;
  prevClose: number | null;
  /** true when IBKR snapshot returned 'C' prefix (market closed, price = prior close) */
  isClosingPrice?: boolean;
  /** true when price comes from extended-hours (pre/post market) */
  isExtendedHours?: boolean;
}

export interface IbkrMarketData {
  h1PriceMap: Record<string, IbkrPriceEntry>;
  h2PriceMap: Record<string, IbkrPriceEntry>;
  catPriceMap: Record<string, number | null>;
  lastUpdated: number;
  isLoading: boolean;
  error: string | null;
  /** True when at least one ticker returned a live price from /quotes */
  hasLiveQuotes: boolean;
  refetch: () => void;
}

function lookupQuote(
  ticker: string,
  masterMap: Record<string, IbkrPriceEntry>,
): IbkrPriceEntry | undefined {
  const u = ticker.toUpperCase();
  if (masterMap[u]) return masterMap[u];
  const bare = u.replace(/\.TA$/i, "");
  return masterMap[bare] ?? masterMap[`${bare}.TA`];
}

/**
 * Determines if any market is currently in a trading session (including extended hours).
 * Returns true during:
 *   - US Pre-Market:   04:00–09:30 ET (Mon–Fri)
 *   - US RTH:          09:30–16:00 ET (Mon–Fri)
 *   - US After-Hours:  16:00–20:00 ET (Mon–Fri)
 *   - TASE:            06:00–14:30 UTC (Mon–Fri, = 09:00–17:30 Israel)
 *
 * When true → poll every 10 seconds for live data.
 * When false → poll every 5 minutes (weekend/overnight).
 */
function isMarketOpen(): boolean {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 6=Sat

  // ── US extended hours: 04:00–20:00 ET on weekdays ──
  const month = now.getUTCMonth();
  const etOffsetHours = month >= 2 && month <= 10 ? 4 : 5; // DST offset
  const etMs = now.getTime() - etOffsetHours * 3600 * 1000;
  const etDate = new Date(etMs);
  const etDay = etDate.getUTCDay();
  const etMinutes = etDate.getUTCHours() * 60 + etDate.getUTCMinutes();

  // US weekday (Mon-Fri) and within extended hours window (04:00–20:00 ET)
  if (etDay >= 1 && etDay <= 5 && etMinutes >= 4 * 60 && etMinutes < 20 * 60) {
    return true;
  }

  // ── TASE: 06:00–14:30 UTC on Mon–Fri ──
  // Israel time = UTC+3, TASE hours = 09:00–17:30 Israel = 06:00–14:30 UTC
  // TASE switched from Sun–Thu to Mon–Fri in October 2023
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  // TASE days: Mon(1)–Fri(5)
  if (day >= 1 && day <= 5 && utcMinutes >= 6 * 60 && utcMinutes < 14 * 60 + 30) {
    return true;
  }

  return false;
}

const MARKET_POLL_MS = 3_000;        // 3 seconds during market hours (incl. pre-market)
const OFFHOURS_POLL_MS = 5 * 60_000; // 5 minutes outside market hours

interface UseIbkrMarketDataInput {
  h1Tickers: string[];
  h2Tickers: string[];
  catalogueTickers: string[];
  ibkrConnected: boolean;
}

export function useIbkrMarketData({
  h1Tickers,
  h2Tickers,
  catalogueTickers,
  ibkrConnected,
}: UseIbkrMarketDataInput): IbkrMarketData {
  const { notifyUpdated } = useIbkrRefresh();

  // Deduplicate: combine all unique tickers into one batch call to IBKR
  // This avoids 3 separate /quotes calls and reduces IBKR API load
  const allTickers = useMemo(() => {
    const set = new Set([...h1Tickers, ...h2Tickers, ...catalogueTickers]);
    return Array.from(set).filter(Boolean);
  }, [
    h1Tickers.join(','),
    h2Tickers.join(','),
    catalogueTickers.join(','),
  ]);

  const pollInterval = isMarketOpen() ? MARKET_POLL_MS : OFFHOURS_POLL_MS;

  // Single unified IBKR quotes query for ALL tickers
  const {
    data: quotesData,
    dataUpdatedAt,
    isLoading,
    error,
    refetch: refetchIbkrQuotes,
  } = trpc.ibkr.getIbkrQuotes.useQuery(
    { symbols: allTickers },
    {
      enabled: ibkrConnected && allTickers.length > 0,
      staleTime: 0,
      refetchOnMount: 'always',
      refetchOnWindowFocus: false,
      refetchInterval: ibkrConnected ? pollInterval : false,
    }
  );

  // Build a master lookup: symbol → IbkrPriceEntry
  const masterMap = useMemo(() => {
    const map: Record<string, IbkrPriceEntry> = {};
    if (!quotesData?.quotes) return map;
    for (const q of quotesData.quotes) {
      if (q.symbol && !q.error) {
        const isClosing = (q as any).isClosingPrice === true;
        const hasPreMarket = (q as any).preMarketPrice != null;
        const entry: IbkrPriceEntry = {
          price: q.price ?? null,
          change: q.change ?? null,
          changePercent: q.changePercent ?? null,
          prevClose: q.prevClose ?? null,
          isClosingPrice: isClosing,
          isExtendedHours: hasPreMarket,
        };
        const sym = q.symbol.toUpperCase();
        map[sym] = entry;
        const bare = sym.replace(/\.TA$/i, "");
        map[bare] = entry;
        map[`${bare}.TA`] = entry;
      }
    }
    return map;
  }, [quotesData]);

  // Slice into per-section maps
  const h1PriceMap = useMemo(() => {
    const map: Record<string, IbkrPriceEntry> = {};
    for (const t of h1Tickers) {
      const q = lookupQuote(t, masterMap);
      if (q) map[t] = q;
    }
    return map;
  }, [masterMap, h1Tickers.join(',')]);

  const h2PriceMap = useMemo(() => {
    const map: Record<string, IbkrPriceEntry> = {};
    for (const t of h2Tickers) {
      const q = lookupQuote(t, masterMap);
      if (q) map[t] = q;
    }
    return map;
  }, [masterMap, h2Tickers.join(',')]);

  const hasLiveQuotes = useMemo(
    () => Object.values(masterMap).some(e => e.price != null && e.price > 0),
    [masterMap],
  );

  useEffect(() => {
    if (dataUpdatedAt > 0 && hasLiveQuotes) notifyUpdated(dataUpdatedAt);
  }, [dataUpdatedAt, hasLiveQuotes, notifyUpdated]);

  const catPriceMap = useMemo(() => {
    const map: Record<string, number | null> = {};
    for (const t of catalogueTickers) {
      map[t] = masterMap[t]?.changePercent ?? null;
    }
    return map;
  }, [masterMap, catalogueTickers.join(',')]);

  return {
    h1PriceMap,
    h2PriceMap,
    catPriceMap,
    lastUpdated: dataUpdatedAt,
    isLoading,
    error: error ? String(error) : (quotesData?.error ?? null),
    hasLiveQuotes,
    refetch: refetchIbkrQuotes,
  };
}
