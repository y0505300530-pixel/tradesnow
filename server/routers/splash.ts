import { publicProcedure, router } from "../_core/trpc";
import { isNyseHoliday, isUsHalfDay, isTaseHoliday } from "../utils/marketHours";

export interface IndexData {
  price: number;
  prevClose: number;
  change: number;
  changePercent: number;
  /** ISO date string of the last trading session (YYYY-MM-DD) */
  sessionDate: string;
  /** true if sessionDate is today (UTC) */
  isToday: boolean;
  /** PRE | POST | REGULAR | CLOSED */
  marketState: "PRE" | "POST" | "REGULAR" | "CLOSED";
  /** pre-market price when marketState === "PRE" */
  preMarketPrice: number | null;
  preMarketChange: number | null;
  preMarketChangePercent: number | null;
  /** post-market price when marketState === "POST" */
  postMarketPrice: number | null;
  postMarketChange: number | null;
  postMarketChangePercent: number | null;
}

// ── 60-second server-side cache ───────────────────────────────────────────────
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes — reduces Yahoo Finance cold-start latency
const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
  return entry.data;
}

function setCached<T>(key: string, data: T): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Returns today's date as YYYY-MM-DD in UTC */
function todayUtc(): string {
  return new Date().toISOString().split("T")[0];
}

async function fetchYahooIndex(symbol: string): Promise<IndexData | null> {
  const cacheKey = `yahoo:${symbol}`;
  const cached = getCached<IndexData>(cacheKey);
  if (cached) return cached;

  try {
    // Use 5d range so we always get the last few trading sessions
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d&includePrePost=true`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://finance.yahoo.com/",
        "Origin": "https://finance.yahoo.com",
      },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const rawBody = await res.text();
    if (!rawBody.startsWith("{")) return null;

    const data = JSON.parse(rawBody) as {
      chart?: {
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            chartPreviousClose?: number;
            regularMarketChange?: number;
            regularMarketChangePercent?: number;
            regularMarketTime?: number;
            marketState?: string;
            preMarketPrice?: number;
            preMarketChange?: number;
            preMarketChangePercent?: number;
            postMarketPrice?: number;
            postMarketChange?: number;
            postMarketChangePercent?: number;
          };
          timestamp?: number[];
          indicators?: {
            quote?: Array<{ close?: (number | null)[] }>;
          };
        }>;
      };
    };

    const meta = data?.chart?.result?.[0]?.meta;
    const rawCloses = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
    if (!meta?.regularMarketPrice) return null;

    const price = meta.regularMarketPrice;
    // Use second-to-last historical close as prevClose.
    // Yahoo's chartPreviousClose is unreliable — it can point to a date weeks ago.
    // The historical closes array contains the actual daily closes in order.
    const validCloses = rawCloses.filter((c): c is number => c != null && c > 0);
    const prevClose = validCloses.length >= 2
      ? validCloses[validCloses.length - 2]
      : (meta.chartPreviousClose ?? price);
    const change = price - prevClose;
    const changePercent = prevClose !== 0 ? ((price - prevClose) / prevClose) * 100 : 0;

    // Determine session date from regularMarketTime
    const sessionDate = meta.regularMarketTime
      ? new Date(meta.regularMarketTime * 1000).toISOString().split("T")[0]
      : todayUtc();
    const isToday = sessionDate === todayUtc();

    // Determine market state
    const rawState = (meta.marketState ?? "").toUpperCase();
    let marketState: IndexData["marketState"] = "CLOSED";
    if (rawState === "PRE" || rawState === "PREPRE") marketState = "PRE";
    else if (rawState === "POST" || rawState === "POSTPOST") marketState = "POST";
    else if (rawState === "REGULAR") marketState = "REGULAR";
    else if (!isToday) marketState = "CLOSED";

    // Pre-market data
    const preMarketPrice = meta.preMarketPrice ?? null;
    const preMarketChange = preMarketPrice != null ? preMarketPrice - price : null;
    const preMarketChangePercent = preMarketChange != null && price > 0
      ? (preMarketChange / price) * 100
      : null;

    // Post-market data
    const postMarketPrice = meta.postMarketPrice ?? null;
    const postMarketChange = postMarketPrice != null ? postMarketPrice - price : null;
    const postMarketChangePercent = postMarketChange != null && price > 0
      ? (postMarketChange / price) * 100
      : null;

    const result: IndexData = {
      price,
      prevClose,
      change,
      changePercent,
      sessionDate,
      isToday,
      marketState,
      preMarketPrice,
      preMarketChange,
      preMarketChangePercent,
      postMarketPrice,
      postMarketChange,
      postMarketChangePercent,
    };
    setCached(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}

async function fetchFearAndGreed(): Promise<{ value: number; classification: string; lastUpdated: string | null } | null> {
  const cacheKey = "fng";
  const cached = getCached<{ value: number; classification: string; lastUpdated: string | null }>(cacheKey);
  if (cached) return cached;

  try {
    // Use CNN Fear & Greed API — same source as edition.cnn.com/markets/fear-and-greed
    const res = await fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://edition.cnn.com",
        "Referer": "https://edition.cnn.com/markets/fear-and-greed",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "cross-site",
      },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      fear_and_greed?: { score: number; rating: string; timestamp: string };
    };
    const fg = data?.fear_and_greed;
    if (!fg) return null;
    const ratingMap: Record<string, string> = {
      "extreme fear": "Extreme Fear",
      "fear": "Fear",
      "neutral": "Neutral",
      "greed": "Greed",
      "extreme greed": "Extreme Greed",
    };
    // Format lastUpdated like CNN: "May 11 at 5:15 AM ET"
    let lastUpdated: string | null = null;
    if (fg.timestamp) {
      try {
        const d = new Date(fg.timestamp);
        lastUpdated = d.toLocaleString("en-US", {
          timeZone: "America/New_York",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        }) + " ET";
      } catch { lastUpdated = null; }
    }
    const result = {
      value: Math.round(fg.score),
      classification: ratingMap[fg.rating.toLowerCase()] ?? fg.rating,
      lastUpdated,
    };
    setCached(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}


async function fetchVix(): Promise<{ value: number; week52Low: number; week52High: number } | null> {
  const cacheKey = "vix";
  const cached = getCached<{ value: number; week52Low: number; week52High: number }>(cacheKey);
  if (cached) return cached;
  try {
    // ^VIX = CBOE Volatility Index. Use 1y range to get 52-week high/low.
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1y";
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://finance.yahoo.com/",
        "Origin": "https://finance.yahoo.com",
      },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const rawBody = await res.text();
    if (!rawBody.startsWith("{")) return null;
    const data = JSON.parse(rawBody) as {
      chart?: {
        result?: Array<{
          meta?: { regularMarketPrice?: number };
          indicators?: { quote?: Array<{ close?: (number | null)[] }> };
        }>;
      };
    };
    const meta = data?.chart?.result?.[0]?.meta;
    const closes = (data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [])
      .filter((c): c is number => c != null && c > 0);
    if (!meta?.regularMarketPrice || closes.length === 0) return null;
    const result = {
      value: Math.round(meta.regularMarketPrice * 100) / 100,
      week52Low: Math.round(Math.min(...closes) * 100) / 100,
      week52High: Math.round(Math.max(...closes) * 100) / 100,
    };
    setCached(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}
export const splashRouter = router({
  getMarketData: publicProcedure.query(async () => {
    // Fetch all data in parallel (results are cached for 60s server-side)
    const [fng, ta35, sp500, nasdaq, qqq, vix] = await Promise.all([
      fetchFearAndGreed(),
      fetchYahooIndex("TA35.TA"),
      fetchYahooIndex("^GSPC"),   // S&P 500
      fetchYahooIndex("^IXIC"),   // NASDAQ Composite
      fetchYahooIndex("QQQ"),     // NASDAQ-100 ETF
      fetchVix(),                 // CBOE VIX
    ]);

    const now = new Date();
    return {
      fearAndGreed: fng,
      ta35,
      sp500,
      nasdaq,
      qqq,
      vix,
      marketFlags: {
        usIsHoliday: isNyseHoliday(now),
        usIsHalfDay: isUsHalfDay(now),
        taseIsHoliday: isTaseHoliday(now),
      },
    };
  }),
});
