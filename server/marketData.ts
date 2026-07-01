/**
 * Shared market data helpers.
 * Single source of truth used by portfolio.ts, tradeManager.ts, and any future routers.
 *
 * PRICE SOURCE POLICY:
 *   - Holding 1, Holding 2, Overview, Fast Overview → IBKR/IBIND ONLY (fetchIbkrLivePricesBatch)
 *   - Paper Lab Engine → Paper IBKR ONLY (fetchPaperIbkrLivePricesBatch)
 *   - Ziv Engine, Deep Analysis, Asset Catalogue → Yahoo Finance allowed (fetchLivePrice / fetchBarsForTicker)
 *   - VIX → Yahoo Finance (index, not available on IBKR paper)
 */
import type { Bar } from "./zivEngine";
export type { Bar };
import { ibindRequest } from "./routers/ibkrProxy";
import { callDataApi } from "./_core/dataApi";
// paperIbindRequest removed — live paths use ibindRequest from ./routers/ibkrProxy
import { getCacheStatus, getCachedPrices, upsertPriceCache as upsertDbPriceCache } from "./db";
import { isUsOpen, isTaseOpen, isTaseHoliday, isNyseHoliday } from "./utils/marketHours";
import { getUsdIlsRate } from "./services/PriceService.js";

export interface LivePrice {
  price: number;
  company: string;
  change: number;
  changePercent: number;
  prevClose: number | null;   // previous regular session close (for accurate Today P&L)
  isExtendedHours?: boolean;  // true when price is from pre-market or after-hours session
  // QA fix #1 (2026-06-25): provenance of `price`. Live-ORDER/exit/SL pricing sites MUST accept
  // a price ONLY when source === 'ibkr' (real-time IBKR broker truth). 'yahoo' (possibly a
  // 5–15% delayed print) and 'db-cache' (up to 24h-old daily close) are display-only — pricing
  // a live order off them is the WRONG-order-at-the-open path QA blocked on. Default/uncertain
  // must NOT be 'ibkr'.
  source: 'ibkr' | 'yahoo' | 'db-cache';
}

/**
 * Israeli and other known ticker aliases — maps user-facing symbols to Yahoo Finance symbols.
 * Add entries here whenever a ticker fails Analyze due to Yahoo Finance symbol mismatch.
 */
export const TICKER_ALIAS_MAP: Record<string, string> = {
  // Israeli stocks — common mismatches
  "PHINERGY.TA": "PNRG.TA",
  "ENERGEAN.TA": "ENRG.TA",
  "TABANKS.TA": "TBNK.TA",
  "TAINS.TA": "TINS.TA",
  "TAREAL.TA": "TREAL.TA",
  "LR.TA": "LEVI.TA",
  "RBN.TA": "RBNO.TA",
  "OPC.TA": "OPCE.TA",    // OPC Energy — Yahoo Finance uses OPCE.TA
  "MDTR": "MDTR.TA",      // Mediterranean Towers — TASE
  // US stocks — common mismatches
  "NIKE": "NKE",
};

/**
 * Normalize a ticker symbol using the alias map.
 * Returns the canonical Yahoo Finance symbol for the given ticker.
 */
export function normalizeTickerSymbol(ticker: string): string {
  return TICKER_ALIAS_MAP[ticker] ?? TICKER_ALIAS_MAP[ticker.toUpperCase()] ?? ticker;
}

/** Safe JSON parse — returns null if the body is not valid JSON (e.g. rate-limit text). */
async function safeJson(res: Response): Promise<any | null> {
  // Always read as text first — Yahoo Finance sometimes returns "Rate exceeded."
  // as text/plain or text/html with HTTP 200, which breaks res.json().
  let text: string;
  try { text = await res.text(); } catch { return null; }
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    // Not JSON — likely a rate-limit or error message
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Sleep helper for retry backoff. */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── In-memory caches to avoid redundant Yahoo Finance fetches ──────────────────────
const BARS_CACHE_TTL_MS = 15 * 60 * 1000;  // 15 minutes
const LIVE_CACHE_TTL_MS = 30 * 1000;        // 30 seconds

const _barsCache = new Map<string, { data: Bar[]; ts: number }>();
const _liveCache = new Map<string, { data: LivePrice; ts: number }>();

function getBarsFromCache(ticker: string): Bar[] | null {
  const entry = _barsCache.get(ticker);
  if (!entry) return null;
  if (Date.now() - entry.ts > BARS_CACHE_TTL_MS) { _barsCache.delete(ticker); return null; }
  return entry.data;
}
function setBarsCache(ticker: string, data: Bar[]) {
  _barsCache.set(ticker, { data, ts: Date.now() });
}
function getLiveFromCache(ticker: string): LivePrice | null {
  const entry = _liveCache.get(ticker);
  if (!entry) return null;
  if (Date.now() - entry.ts > LIVE_CACHE_TTL_MS) { _liveCache.delete(ticker); return null; }
  return entry.data;
}
function setLiveCache(ticker: string, data: LivePrice) {
  _liveCache.set(ticker, { data, ts: Date.now() });
}

/** Clear all live price cache entries (call when market state changes). */
export function clearLiveCache() {
  _liveCache.clear();
}

/**
 * Fetch the latest live price + metadata for a single ticker from Yahoo Finance.
 * Returns null on network error, rate-limit, or missing data.
 */
export async function fetchLivePrice(ticker: string): Promise<LivePrice | null> {
  ticker = normalizeTickerSymbol(ticker);
  const cached = getLiveFromCache(ticker);
  if (cached) return cached;

  // v20.55: DB cache-first — try to build LivePrice from the last 2 rows of priceCache
  // This avoids a Yahoo Finance call entirely when cache is < 30 minutes old.
  let staleLivePrice: LivePrice | null = null;
  try {
    const statusMap = await getCacheStatus([ticker]);
    const status = statusMap[ticker.toUpperCase()];
    if (status && status.rowCount > 0 && status.lastFetchedAt) {
      const ageMin = (Date.now() - status.lastFetchedAt.getTime()) / 60_000;
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
      const rows = await getCachedPrices(
        ticker,
        startDate.toISOString().slice(0, 10),
        endDate.toISOString().slice(0, 10)
      );
      if (rows.length > 0) {
        const last = rows[rows.length - 1];
        const prev = rows.length > 1 ? rows[rows.length - 2] : null;
        const chgPct = prev && prev.close > 0
          ? ((last.close - prev.close) / prev.close) * 100
          : 0;
        const liveFromCache: LivePrice = {
          price: last.close,
          change: last.close - (prev?.close ?? last.close),
          changePercent: chgPct,
          prevClose: prev?.close ?? last.close,
          company: ticker,
          isExtendedHours: false,
          source: 'db-cache',   // stale daily close — display-only, never price a live order off this
        };
        // Use DB cache only when market is closed OR cache is very fresh (< 5 min)
        // During market hours, always fetch from Yahoo Finance for live intraday prices
        const marketCurrentlyOpen = isUsOpen(new Date()) || isTaseOpen(new Date());
        const freshEnough = marketCurrentlyOpen ? ageMin < 5 : ageMin < 1440;
        if (freshEnough) {
          setLiveCache(ticker, liveFromCache);
          return liveFromCache;
        }
        // Stale but usable as fallback on 429
        staleLivePrice = liveFromCache;
      }
    }
  } catch { /* DB unavailable — fall through to Yahoo */ }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000); // 2s max per Yahoo request (intraday)

      // Step 1: Fetch daily bars (5d) to get the last regular-session close
      // and the previous session close (for daily % change calculation)
      const dailyRes = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d&includePrePost=false`,
        { signal: controller.signal }
      );
      clearTimeout(timer);

      if (dailyRes.status === 429) {
        if (attempt === 0) { await sleep(1500); continue; }
        // Rate limited — use stale DB cache if available
        return staleLivePrice;
      }
      if (!dailyRes.ok) return staleLivePrice ?? null;
      const dailyData = await safeJson(dailyRes);
      if (!dailyData) {
        if (attempt === 0) { await sleep(1500); continue; }
        return staleLivePrice ?? null;
      }

      const dailyResult = dailyData?.chart?.result?.[0];
      const meta = dailyResult?.meta;
      if (!meta?.regularMarketPrice) return null;

      const currency: string | undefined = meta.currency; // e.g. "ILA", "ILS", "USD"
      const rawRegularClose: number = meta.regularMarketPrice; // last official session close
      const company: string = meta.longName || meta.shortName || ticker;

      // Normalize ILA (Israeli Agorot) and ILS (Israeli Shekel) to USD
      const toUsd = async (v: number) => {
        if (currency === "ILA") { const r = await getUsdIlsRate(); return (v / 100) / r; }
        if (currency === "ILS") { const r = await getUsdIlsRate(); return v / r; }
        return v;
      };
      const regularClose = await toUsd(rawRegularClose);

      // Deduplicate daily bars by date to get the two most recent unique session closes
      const dailyCloses: number[] = dailyResult?.indicators?.quote?.[0]?.close ?? [];
      const dailyTimestamps: number[] = dailyResult?.timestamp ?? [];
      const seenDates = new Set<string>();
      const uniqueCloses: number[] = [];
      for (let i = 0; i < dailyTimestamps.length; i++) {
        const dateKey = new Date(dailyTimestamps[i] * 1000).toISOString().slice(0, 10);
        if (!seenDates.has(dateKey) && dailyCloses[i] != null && dailyCloses[i] > 0) {
          seenDates.add(dateKey);
          uniqueCloses.push(dailyCloses[i]);
        }
      }
      const prevSessionCloseRaw = uniqueCloses.length >= 2 ? uniqueCloses[uniqueCloses.length - 2] : null;
      const prevSessionClose = prevSessionCloseRaw != null ? await toUsd(prevSessionCloseRaw) : null;

      // Step 2: Try to get pre-market / after-hours price via intraday bars
      // Use 60m interval with includePrePost=true — the last bar will be the most recent
      // extended-hours price if the market is currently in pre/post session.
      let extendedPrice: number | null = null;
      try {
        const controller2 = new AbortController();
        const timer2 = setTimeout(() => controller2.abort(), 3000); // 3s for extended hours
        const intradayRes = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=60m&range=1d&includePrePost=true`,
          { signal: controller2.signal }
        );
        clearTimeout(timer2);
        if (intradayRes.ok) {
          const intradayData = await safeJson(intradayRes);
          if (intradayData) {
            const intradayResult = intradayData?.chart?.result?.[0];
            const intradayCloses: number[] = intradayResult?.indicators?.quote?.[0]?.close ?? [];
            const intradayTimestamps: number[] = intradayResult?.timestamp ?? [];
            // Find the most recent non-null close from intraday bars
            for (let i = intradayCloses.length - 1; i >= 0; i--) {
              if (intradayCloses[i] != null && intradayCloses[i] > 0) {
                const barTime = new Date(intradayTimestamps[i] * 1000);
                const now = new Date();
                // Only use intraday bar if it's from today (within last 24h)
                if (now.getTime() - barTime.getTime() < 24 * 60 * 60 * 1000) {
                  extendedPrice = await toUsd(intradayCloses[i]);
                }
                break;
              }
            }
          }
        }
      } catch {
        // Extended hours fetch failed — fall back to regular close
      }

      // Use extended price if available and different from regular close (pre/after market active)
      // Note: both extendedPrice and regularClose are already normalized to USD at this point
      const price = (extendedPrice != null && Math.abs(extendedPrice - regularClose) > 0.001)
        ? extendedPrice
        : regularClose;

      // Daily change calculation:
      // - During regular market hours: use official Yahoo change (vs yesterday's close)
      // - During pre/after-hours: use (extended price - last regular close) / last regular close
      // - On weekends / market closed with no extended hours: show 0 (no trading today)
      let change: number;
      let changePercent: number;

      const isExtendedHours = extendedPrice != null && Math.abs(extendedPrice - regularClose) > 0.01;

      // Detect whether today is a trading day for this ticker.
      // Yahoo's marketState field: "REGULAR" | "PRE" | "POST" | "PREPRE" | "POSTPOST" | "CLOSED"
      const marketState: string = meta.marketState ?? "CLOSED";
      const isTaseTicker = ticker.toUpperCase().endsWith('.TA');
      const isWeekend = (() => {
        if (isTaseTicker) {
          // TASE trades Monday–Friday (Israel time). Weekend = Saturday + Sunday.
          const ilDay = new Date().toLocaleDateString("en-US", { timeZone: "Asia/Jerusalem", weekday: "short" });
          return ilDay === "Sat" || ilDay === "Sun";
        }
        // US/other exchanges: weekend = Saturday + Sunday (NYSE timezone)
        const nyDay = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" });
        return nyDay === "Sat" || nyDay === "Sun";
      })();
      // Also treat exchange holidays as non-trading days (same as weekends)
      const isHoliday = isTaseTicker ? isTaseHoliday() : isNyseHoliday();

      // If market is fully closed (no regular, pre, or post session) and it's a weekend,
      // return change = 0 so TODAY P&L shows $0 instead of stale prior-session data.
      const isTradingToday = marketState === "REGULAR" || marketState === "PRE" || marketState === "POST"
        || marketState === "PREPRE" || marketState === "POSTPOST" || isExtendedHours;

      if (!isTradingToday && (isWeekend || isHoliday)) {
        // Weekend or holiday — no trading today, show zero change
        change = 0;
        changePercent = 0;
      } else if (!isExtendedHours && meta.regularMarketChange != null && meta.regularMarketChangePercent != null
        && currency !== "ILA" && currency !== "ILS") {
        // Regular market hours — use official Yahoo daily change (USD stocks only)
        // For ILA/ILS stocks we NEVER trust meta.regularMarketChangePercent because Yahoo
        // computes it against the intraday open (not the previous session close), giving
        // wrong signs and wrong magnitudes after currency conversion.
        change = meta.regularMarketChange;
        changePercent = meta.regularMarketChangePercent;
      } else if (!isExtendedHours && prevSessionClose != null && prevSessionClose > 0) {
        // ILA/ILS stocks AND any exchange where Yahoo doesn't return regularMarketChange:
        // Always use bars-based calculation: (currentPrice - prevSessionClose) / prevSessionClose
        // Both price and prevSessionClose are already normalised to USD at this point.
        change = price - prevSessionClose;
        changePercent = (change / prevSessionClose) * 100;
      } else if (isExtendedHours) {
        // Pre-market or after-hours: change vs the last regular session close
        // e.g. RKLB closed at $69.48, pre-market at $71.09 → +2.32%
        change = price - regularClose;
        changePercent = regularClose !== 0 ? (change / regularClose) * 100 : 0;
      } else if (prevSessionClose != null && prevSessionClose !== 0 && !isWeekend && !isHoliday) {
        // Market closed on a weekday (not a holiday) — show change vs previous session
        change = price - prevSessionClose;
        changePercent = (change / prevSessionClose) * 100;
      } else {
        // Closed on weekend or no data — show zero
        change = 0;
        changePercent = 0;
      }

      // prevClose = the last regular session close before today.
      // For US stocks during pre/post market: regularClose IS today's official close, prevSessionClose is yesterday's.
      // For TASE (.TA) stocks: regularMarketPrice = live intraday price (Yahoo updates it in real-time).
      //   prevSessionClose = yesterday's close → correct baseline for Today P&L.
      const prevClose: number | null = prevSessionClose ?? null;
      const result: LivePrice = { price, company, change, changePercent, prevClose, isExtendedHours, source: 'yahoo' };
      setLiveCache(ticker, result);
      return result;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Fetch daily OHLCV bars for a ticker.
 * @param days  Maximum number of bars to return (default 420 ≈ 1.5 years)
 */
export async function fetchBarsForTicker(ticker: string, days = 420): Promise<Bar[]> {
  ticker = normalizeTickerSymbol(ticker);
  // Only cache the default 420-day request (most common usage)
  if (days === 420) {
    const cached = getBarsFromCache(ticker);
    if (cached) return cached;
  }
  // v20.54: Check DB price cache first.
  // For Deep Analysis / ZivH (historical data only), accept cache up to 48h old.
  // On Yahoo 429, fall back to stale cache rather than returning empty.
  let staleCacheFallback: Bar[] | null = null;
  if (days <= 420) {
    try {
      const statusMap = await getCacheStatus([ticker]);
      const status = statusMap[ticker.toUpperCase()];
      if (status && status.rowCount > 100) {
        const endDate = new Date();
        const startDate = new Date(endDate.getTime() - (days + 10) * 24 * 60 * 60 * 1000);
        const cached = await getCachedPrices(
          ticker,
          startDate.toISOString().slice(0, 10),
          endDate.toISOString().slice(0, 10)
        );
        if (cached.length > 50) {
          const bars = cached.slice(-days) as Bar[];
          // Fresh cache (< 48h): return immediately — no Yahoo call needed
          const ageHours = status.lastFetchedAt
            ? (Date.now() - status.lastFetchedAt.getTime()) / 3_600_000
            : 999;
          if (ageHours < 168) { // v2.1: accept up to 7-day old cache (Yahoo not always accessible from server)
            if (days === 420) setBarsCache(ticker, bars);
            return bars;
          }
          // Stale cache (>= 48h): keep as fallback in case Yahoo rate-limits
          staleCacheFallback = bars;
        }
      }
    } catch { /* DB cache miss — fall through to Yahoo Finance */ }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000); // 2s max per Yahoo request (intraday)
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2y`,
        { signal: controller.signal }
      );
      clearTimeout(timer);
      if (res.status === 429) {
        if (attempt === 0) { await sleep(1500); continue; }
        // Rate limited — use stale DB cache if available rather than returning empty
        if (staleCacheFallback) return staleCacheFallback;
        return [];
      }
      if (!res.ok) {
        if (staleCacheFallback) return staleCacheFallback;
        return [];
      }
      const data = await safeJson(res);
      if (!data) {
        if (attempt === 0) { await sleep(1500); continue; }
        if (staleCacheFallback) return staleCacheFallback;
        return [];
      }
      const result = data?.chart?.result?.[0];
      if (!result) return [];
      const timestamps: number[] = result.timestamp ?? [];
      const q = result.indicators?.quote?.[0] ?? {};
      const closes: number[] = q.close ?? [];
      const volumes: number[] = q.volume ?? [];
      const highs: number[] = q.high ?? [];
      const lows: number[] = q.low ?? [];
      const opens: number[] = q.open ?? [];
      let bars = timestamps
        .map((t, i) => ({
          date: new Date(t * 1000).toISOString().slice(0, 10),
          close: closes[i] ?? 0,
          high: highs[i] ?? closes[i] ?? 0,
          low: lows[i] ?? closes[i] ?? 0,
          open: opens[i] ?? closes[i] ?? 0,
          volume: volumes[i] ?? 0,
        }))
        .filter(b => b.close > 0)
        .slice(-days);
      // HOTFIX 1: Yahoo Finance returns .TA (TASE) tickers in Agorot (pennies).
      // Normalize to ILS by dividing by 100 BEFORE any indicator calculations.
      if (ticker.endsWith('.TA')) {
        bars = bars.map(bar => ({
          ...bar,
          open: bar.open / 100,
          high: bar.high / 100,
          low: bar.low / 100,
          close: bar.close / 100,
        }));
      }
      if (days === 420) setBarsCache(ticker, bars);
      return bars;
    } catch {
      if (staleCacheFallback) return staleCacheFallback;
      return [];
    }
  }
  // All attempts exhausted — use stale cache if available
  return staleCacheFallback ?? [];
}

/**
 * Fetch live prices for multiple tickers — sequential with small delay to avoid rate limits.
 * Returns a Map<ticker, LivePrice | null>.
 * NOTE: Uses Yahoo Finance. For Holding 1/2/Overview use fetchIbkrLivePricesBatch instead.
 */
export async function fetchLivePricesBatch(
  tickers: string[]
): Promise<Map<string, LivePrice | null>> {
  const map = new Map<string, LivePrice | null>();
  // Parallel fetch in chunks of 5 to avoid Yahoo Finance rate limiting
  const CHUNK = 5;
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const chunk = tickers.slice(i, i + CHUNK);
    const results = await Promise.all(chunk.map(t => fetchLivePrice(t).then(p => ({ t, p }))));
    for (const { t, p } of results) map.set(t, p);
    if (i + CHUNK < tickers.length) await sleep(200); // small delay between chunks
  }
  return map;
}

// ── IBKR-only live price fetcher (Holding 1, Holding 2, Overview, Fast Overview) ──────────────
// In-memory IBKR price cache (15s TTL — IBKR updates every ~15s during market hours)
const IBKR_LIVE_CACHE_TTL_MS = 15_000;
const _ibkrLiveCache = new Map<string, { data: LivePrice; ts: number }>();

function getIbkrLiveFromCache(ticker: string, maxAgeMs?: number): LivePrice | null {
  const entry = _ibkrLiveCache.get(ticker);
  if (!entry) return null;
  const ttl = maxAgeMs ?? IBKR_LIVE_CACHE_TTL_MS;
  if (Date.now() - entry.ts > ttl) { _ibkrLiveCache.delete(ticker); return null; }
  return entry.data;
}
function setIbkrLiveCache(ticker: string, data: LivePrice) {
  _ibkrLiveCache.set(ticker, { data, ts: Date.now() });
}

/** IBKR /positions mktPrice — works when /quotes is in grace or slow; SSOT for held tickers. */
async function fetchIbkrPositionsMktPriceMap(
  tickers: string[],
): Promise<Map<string, LivePrice>> {
  const out = new Map<string, LivePrice>();
  const want = new Set(tickers.map(t => t.toUpperCase()));
  if (want.size === 0) return out;
  try {
    const res = await ibindRequest("GET", "/positions");
    if (!res.ok) return out;
    for (const p of (res.body as { positions?: any[] })?.positions ?? []) {
      if ((p.position ?? 0) === 0) continue;
      const ticker = String(p.contractDesc ?? p.ticker ?? "").toUpperCase();
      if (!ticker || !want.has(ticker)) continue;
      const mktPrice = p.mktPrice ?? 0;
      if (!(mktPrice > 0)) continue;
      out.set(ticker, {
        price: mktPrice,
        company: ticker,
        change: 0,
        changePercent: 0,
        prevClose: null,
        source: "ibkr",
      });
    }
  } catch { /* non-blocking */ }
  return out;
}

/**
 * Fetch live prices for a batch of tickers via IBKR/IBIND.
 * This is the ONLY function that should be used for Holding 1, Holding 2, Overview, Fast Overview.
 * Returns null for any ticker IBKR cannot price — never falls back to Yahoo Finance.
 * Returns a Map<ticker, LivePrice | null>.
 */
export async function fetchIbkrLivePricesBatch(
  tickers: string[],
  opts?: { skipCache?: boolean; maxCacheAgeMs?: number },
): Promise<Map<string, LivePrice | null>> {
  const map = new Map<string, LivePrice | null>();
  if (tickers.length === 0) return map;

  // Serve from cache first (unless skipCache — War Room live refresh)
  const uncached: string[] = [];
  for (const t of tickers) {
    if (!opts?.skipCache) {
      const cached = getIbkrLiveFromCache(t, opts?.maxCacheAgeMs);
      if (cached) {
        map.set(t, cached);
        continue;
      }
    }
    uncached.push(t);
  }
  if (uncached.length === 0) return map;

  // Split: .TA tickers go to TASE, crypto (-USD) go directly to CoinGecko, rest to SMART
  const taSymbols = uncached.filter(s => s.toUpperCase().endsWith('.TA'));
  const cryptoSymbols = uncached.filter(s => isCryptoTicker(s));
  const usSymbols = uncached.filter(s => !s.toUpperCase().endsWith('.TA') && !isCryptoTicker(s));

  // Route crypto tickers directly to CoinGecko (never send to IBKR — avoids ticker confusion)
  if (cryptoSymbols.length > 0) {
    const cryptoPrices = await fetchCryptoPricesFallback(cryptoSymbols);
    cryptoPrices.forEach((lp, ticker) => {
      setIbkrLiveCache(ticker, lp);
      map.set(ticker, lp);
    });
    for (const t of cryptoSymbols) {
      if (!map.has(t)) map.set(t, null);
    }
  }

  // Helper: call IBIND /quotes for one batch
  const fetchBatch = async (syms: string[], exchange_hint: string): Promise<any[]> => {
    if (syms.length === 0) return [];
    try {
      // Strip .TA suffix for IBKR lookup
      const stripped = syms.map(s => s.replace(/\.TA$/i, '').toUpperCase());
      // Build reverse map: stripped symbol → original symbol (with .TA suffix)
      const reverseMap = new Map<string, string>();
      for (let i = 0; i < stripped.length; i++) {
        reverseMap.set(stripped[i], syms[i]);
      }
      const res = await ibindRequest('POST', '/quotes', { symbols: stripped, exchange_hint });
      if (!res.ok) return [];
      const d = res.body as { success: boolean; quotes: any[]; unresolved?: string[] };
      // Map quotes back using symbol from response (not index) for correct matching
      return (d.quotes ?? []).map((q: any) => {
        const qSym = (q.symbol ?? q.ticker ?? '').toUpperCase();
        const originalSym = reverseMap.get(qSym) ?? qSym;
        return { ...q, symbol: originalSym };
      });
    } catch {
      return [];
    }
  };

  // Get ILS/USD rate for TASE conversion
  let ilsRate = 3.60;
  if (taSymbols.length > 0) {
    try { ilsRate = await getUsdIlsRate(); } catch { /* use fallback */ }
  }

  // Fetch both batches (max 50 per call)
  const BATCH_SIZE = 50;
  const allQuotes: any[] = [];
  for (let i = 0; i < taSymbols.length; i += BATCH_SIZE) {
    allQuotes.push(...await fetchBatch(taSymbols.slice(i, i + BATCH_SIZE), 'TASE'));
    if (i + BATCH_SIZE < taSymbols.length) await sleep(200);
  }
  for (let i = 0; i < usSymbols.length; i += BATCH_SIZE) {
    allQuotes.push(...await fetchBatch(usSymbols.slice(i, i + BATCH_SIZE), 'SMART'));
    if (i + BATCH_SIZE < usSymbols.length) await sleep(200);
  }

  // If IBKR /quotes returned nothing → use /positions mktPrice (grace-safe).
  // GATEWAY-DOWN TASE FIX: .TA tickers with no position fall back to Yahoo (display-only)
  // so Holding2/TASE prices don't freeze during a gateway outage. source:'yahoo' → live-
  // order pricing (gated on source==='ibkr') still refuses it; Elza does not trade .TA.
  if (allQuotes.length === 0) {
    const posMap = await fetchIbkrPositionsMktPriceMap(uncached);
    const taseNeedYahoo: string[] = [];
    for (const t of uncached) {
      const fromPos = posMap.get(t.toUpperCase());
      if (fromPos) {
        setIbkrLiveCache(t, fromPos);
        map.set(t, fromPos);
      } else if (t.toUpperCase().endsWith('.TA')) {
        taseNeedYahoo.push(t);
      } else {
        map.set(t, null);
      }
    }
    if (taseNeedYahoo.length > 0) {
      try {
        const yr = await Promise.all(taseNeedYahoo.map(t => fetchLivePrice(t).then(p => ({ t, p }))));
        for (const { t, p } of yr) map.set(t, p ?? null);
      } catch { for (const t of taseNeedYahoo) if (!map.has(t)) map.set(t, null); }
    }
    return map;
  }

  // Normalize IBKR quotes to LivePrice shape
  for (const q of allQuotes) {
    if (!q || q.error) continue;
    const sym: string = q.symbol ?? q.ticker ?? '';
    if (!sym) continue;

    const isTase = (q.exchange ?? '').toUpperCase() === 'TASE' || sym.toUpperCase().endsWith('.TA');
    // TASE live quotes from IBKR are in ILS (not agorot); divide by rate to get USD
    const quoteDiv = isTase && ilsRate > 0 ? ilsRate : 1;

    // New IBIND Gateway contract: current_price, prior_close, change, change_percent
    const isNewContract = q.current_price !== undefined;
    let price: number | null = null;
    let prevClose: number | null = null;
    let change: number | null = null;
    let changePercent: number | null = null;
    let isExtendedHours = false;

    if (isNewContract) {
      price = q.current_price / quoteDiv;
      prevClose = q.prior_close != null ? q.prior_close / quoteDiv : null;
      change = q.change != null ? q.change / quoteDiv : null;
      changePercent = q.change_percent ?? null; // already a percentage
      isExtendedHours = q.is_market_open === false;
    } else {
      // Legacy contract: last_price, prior_close, change, change_percent
      price = (q.last_price ?? q.price ?? null);
      if (price != null) price = price / quoteDiv;
      prevClose = q.prior_close != null ? q.prior_close / quoteDiv : null;
      change = q.change != null ? q.change / quoteDiv : null;
      changePercent = q.change_percent ?? null;
    }

    if (price == null || price <= 0) continue;

    const livePrice: LivePrice = {
      price,
      company: q.company_name ?? q.company ?? sym,
      change: change ?? 0,
      changePercent: changePercent ?? 0,
      prevClose,
      isExtendedHours,
      source: 'ibkr',   // real-time IBKR broker truth — the ONLY source live-order pricing may use
    };
    setIbkrLiveCache(sym, livePrice);
    map.set(sym, livePrice);
  }

  // For any tickers that IBKR didn't return, try CoinGecko for crypto tickers
  const missing = uncached.filter(t => !map.has(t));
  const missingCrypto = missing.filter(t => isCryptoTicker(t));
  const missingNonCrypto = missing.filter(t => !isCryptoTicker(t));

  // CoinGecko fallback for crypto
  if (missingCrypto.length > 0) {
    const cryptoPrices = await fetchCryptoPricesFallback(missingCrypto);
    cryptoPrices.forEach((lp, ticker) => {
      setIbkrLiveCache(ticker, lp);
      map.set(ticker, lp);
    });
    // Set null for crypto tickers that CoinGecko also couldn't resolve
    for (const t of missingCrypto) {
      if (!map.has(t)) map.set(t, null);
    }
  }

  // Non-crypto missing tickers → try /positions mktPrice; .TA → Yahoo display fallback; else null
  if (missingNonCrypto.length > 0) {
    const posMap = await fetchIbkrPositionsMktPriceMap(missingNonCrypto);
    const taseNeedYahoo: string[] = [];
    for (const t of missingNonCrypto) {
      const fromPos = posMap.get(t.toUpperCase());
      if (fromPos) {
        setIbkrLiveCache(t, fromPos);
        map.set(t, fromPos);
      } else if (t.toUpperCase().endsWith('.TA')) {
        taseNeedYahoo.push(t);
      } else {
        map.set(t, null);
      }
    }
    if (taseNeedYahoo.length > 0) {
      try {
        const yr = await Promise.all(taseNeedYahoo.map(t => fetchLivePrice(t).then(p => ({ t, p }))));
        for (const { t, p } of yr) map.set(t, p ?? null);
      } catch { for (const t of taseNeedYahoo) if (!map.has(t)) map.set(t, null); }
    }
  }

  return map;
}

// ── CoinGecko Crypto Fallback ─────────────────────────────────────────────────
// Maps ticker symbols (e.g. ETH-USD) to CoinGecko IDs
const CRYPTO_COINGECKO_MAP: Record<string, string> = {
  'BTC-USD': 'bitcoin',
  'ETH-USD': 'ethereum',
  'XRP-USD': 'ripple',
  'SOL-USD': 'solana',
  'ADA-USD': 'cardano',
  'DOGE-USD': 'dogecoin',
  'DOT-USD': 'polkadot',
  'AVAX-USD': 'avalanche-2',
  'MATIC-USD': 'matic-network',
  'LINK-USD': 'chainlink',
};

/** Returns true if ticker looks like a crypto pair (e.g. BTC-USD, ETH-USD) */
export function isCryptoTicker(ticker: string): boolean {
  return /^[A-Z]{2,10}-USD$/i.test(ticker);
}

// Binance ticker mapping (ticker → Binance symbol)
const CRYPTO_BINANCE_MAP: Record<string, string> = {
  'BTC-USD': 'BTCUSDT',
  'ETH-USD': 'ETHUSDT',
  'XRP-USD': 'XRPUSDT',
  'SOL-USD': 'SOLUSDT',
  'ADA-USD': 'ADAUSDT',
  'DOGE-USD': 'DOGEUSDT',
  'DOT-USD': 'DOTUSDT',
  'AVAX-USD': 'AVAXUSDT',
  'MATIC-USD': 'MATICUSDT',
  'LINK-USD': 'LINKUSDT',
};

/**
 * Fetch crypto prices — Binance primary (fast, reliable), CoinGecko fallback.
 * Returns a Map<ticker, LivePrice> for resolved tickers.
 */
export async function fetchCryptoPricesFallback(
  tickers: string[]
): Promise<Map<string, LivePrice>> {
  const map = new Map<string, LivePrice>();
  if (tickers.length === 0) return map;

  // ── Try Binance first (fast, no rate limits for public endpoints) ──
  try {
    const binanceSymbols = tickers
      .map(t => ({ ticker: t.toUpperCase(), symbol: CRYPTO_BINANCE_MAP[t.toUpperCase()] }))
      .filter(x => x.symbol);

    if (binanceSymbols.length > 0) {
      const symbols = binanceSymbols.map(x => x.symbol);
      const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${JSON.stringify(symbols)}`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = await res.json() as Array<{
          symbol: string;
          lastPrice: string;
          priceChangePercent: string;
          prevClosePrice: string;
        }>;
        for (const item of data) {
          const match = binanceSymbols.find(x => x.symbol === item.symbol);
          if (!match) continue;
          const price = parseFloat(item.lastPrice);
          const changePercent = parseFloat(item.priceChangePercent);
          const prevClose = parseFloat(item.prevClosePrice);
          const change = price - prevClose;
          if (price > 0) {
            map.set(match.ticker, {
              price,
              company: match.ticker.replace('-USD', ''),
              change,
              changePercent,
              prevClose,
              isExtendedHours: false,
              source: 'yahoo',   // Binance/CoinGecko external feed — not IBKR; not for live-order pricing
            });
          }
        }
        if (map.size > 0) {
          console.log(`[Binance] Fetched ${map.size} crypto prices successfully`);
          return map;
        }
      }
    }
  } catch (e) {
    console.log(`[Binance] Failed: ${(e as Error).message}, falling back to CoinGecko`);
  }

  // ── CoinGecko fallback ──
  const tickerToId: [string, string][] = [];
  for (const t of tickers) {
    const id = CRYPTO_COINGECKO_MAP[t.toUpperCase()];
    if (id) tickerToId.push([t.toUpperCase(), id]);
  }
  if (tickerToId.length === 0) return map;

  const ids = tickerToId.map(([, id]) => id).join(',');
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return map;
    const data = await res.json() as Record<string, { usd?: number; usd_24h_change?: number }>;

    for (const [ticker, coinId] of tickerToId) {
      const coin = data[coinId];
      if (!coin?.usd) continue;
      const price = coin.usd;
      const changePercent = coin.usd_24h_change ?? 0;
      const prevClose = price / (1 + changePercent / 100);
      const change = price - prevClose;
      map.set(ticker, {
        price,
        company: ticker.replace('-USD', ''),
        change,
        changePercent,
        prevClose,
        isExtendedHours: false,
        source: 'yahoo',   // CoinGecko external feed — not IBKR; not for live-order pricing
      });
    }
  } catch (e) {
    console.log(`[CoinGecko] Fallback also failed: ${(e as Error).message}`);
  }
  return map;
}

// ── USD/ILS rate — now owned by PriceService; re-exported for backward compat ─
export { getUsdIlsRate } from "./services/PriceService.js";

/**
 * Convert a price returned by Yahoo Finance to USD.
 * - ILA (Israeli Agorot) → divide by 100 to get ILS → divide by USD/ILS rate
 * - ILS (Israeli Shekel)  → divide by USD/ILS rate
 * - USD / unknown         → return as-is
 */
export async function normalizePriceToUsd(
  price: number,
  currency: string | undefined
): Promise<number> {
  if (currency === "ILA") {
    const rate = await getUsdIlsRate();
    return (price / 100) / rate;
  }
  if (currency === "ILS") {
    const rate = await getUsdIlsRate();
    return price / rate;
  }
  return price;
}

/**
 * Fetch OHLCV bars for multiple tickers — sequential with small delay to avoid rate limits.
 * Returns a Map<ticker, Bar[]>.
 */
export async function fetchBarsBatch(
  tickers: string[],
  days = 420
): Promise<Map<string, Bar[]>> {
  const map = new Map<string, Bar[]>();
  if (tickers.length === 0) return map;

  // Parallel fetch with concurrency limit of 5 to avoid Yahoo rate limits
  // Tickers already cached in memory will resolve instantly without network calls
  const CONCURRENCY = 5;
  const chunks: string[][] = [];
  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    chunks.push(tickers.slice(i, i + CONCURRENCY));
  }
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const results = await Promise.all(chunk.map(t => fetchBarsForTicker(t, days)));
    chunk.forEach((t, i) => map.set(t, results[i]));
    // Small delay between chunks to avoid rate limiting (skip for last chunk)
    if (ci < chunks.length - 1) await sleep(200);
  }
  return map;
}

/**
 * Normalize bars for a .TA ticker from ILA (Agorot) to ILS (Shekel).
 * Yahoo Finance returns TASE bars in ILA (1/100 ILS).
 * Call this before passing bars to calcZivEngineScore / calcSlTp for .TA stocks.
 *
 * NOTE: Returns ILS prices (not USD). SL/TP calculator and Ziv Engine work in
 * the same unit as buyPrice — so as long as buyPrice is also in ILS, this is consistent.
 * For USD conversion, also divide by ilsRate after calling this function.
 */
export function normalizeBarsForTicker(ticker: string, bars: Bar[]): Bar[] {
  if (!ticker.toUpperCase().endsWith('.TA')) return bars;
  return bars.map(b => ({
    ...b,
    open:  b.open  / 100,
    high:  b.high  / 100,
    low:   b.low   / 100,
    close: b.close / 100,
  }));
}

// ── Paper IBKR live price fetcher (Paper Lab Engine ONLY) ───────────────────────
// Separate cache from live IBKR — never mixes with live account data.
const PAPER_IBKR_LIVE_CACHE_TTL_MS = 15_000;
const _paperIbkrLiveCache = new Map<string, { data: LivePrice; ts: number }>();

function getPaperIbkrLiveFromCache(ticker: string): LivePrice | null {
  const entry = _paperIbkrLiveCache.get(ticker);
  if (!entry) return null;
  if (Date.now() - entry.ts > PAPER_IBKR_LIVE_CACHE_TTL_MS) { _paperIbkrLiveCache.delete(ticker); return null; }
  return entry.data;
}
function setPaperIbkrLiveCache(ticker: string, data: LivePrice) {
  _paperIbkrLiveCache.set(ticker, { data, ts: Date.now() });
}

/**
 * Fetch live prices for a batch of tickers via Paper IBKR endpoint.
 * This is the ONLY function that should be used by Paper Lab Engine for live prices.
 * Returns null for any ticker Paper IBKR cannot price — never falls back to Yahoo Finance.
 * Returns a Map<ticker, LivePrice | null>.
 *
 * Uses paperIbindRequest (HTTPS + Bearer only, no HMAC) to paper.tradesnow.vip.
 * Air-Gap: never touches live IBKR credentials.
 */
export async function fetchPaperIbkrLivePricesBatch(
  tickers: string[]
): Promise<Map<string, LivePrice | null>> {
  const map = new Map<string, LivePrice | null>();
  if (tickers.length === 0) return map;

  // Serve from cache first
  const uncached: string[] = [];
  for (const t of tickers) {
    const cached = getPaperIbkrLiveFromCache(t);
    if (cached) map.set(t, cached);
    else uncached.push(t);
  }
  if (uncached.length === 0) return map;

  // Split: .TA tickers go to TASE, rest to SMART
  const taSymbols = uncached.filter(s => s.toUpperCase().endsWith('.TA'));
  const usSymbols = uncached.filter(s => !s.toUpperCase().endsWith('.TA'));

  // Helper: call Paper IBKR /quotes for one batch
  const fetchBatch = async (syms: string[], exchange_hint: string): Promise<any[]> => {
    if (syms.length === 0) return [];
    try {
      // Strip .TA suffix for IBKR lookup
      const stripped = syms.map(s => s.replace(/\.TA$/i, '').toUpperCase());
      const res = await ibindRequest('POST', '/quotes', { symbols: stripped, exchange_hint });
      if (!res.ok) return [];
      const d = res.body as { success: boolean; quotes: any[]; unresolved?: string[] };
      // Re-attach original symbol (with .TA suffix) so we can match back
      return (d.quotes ?? []).map((q: any, i: number) => ({ ...q, symbol: syms[i] ?? q.symbol }));
    } catch {
      return [];
    }
  };

  // Get ILS/USD rate for TASE conversion
  let ilsRate = 3.60;
  if (taSymbols.length > 0) {
    try { ilsRate = await getUsdIlsRate(); } catch { /* use fallback */ }
  }

  // Fetch both batches (max 50 per call — under IBKR's 100-item limit)
  const BATCH_SIZE = 50;
  const allQuotes: any[] = [];
  for (let i = 0; i < taSymbols.length; i += BATCH_SIZE) {
    allQuotes.push(...await fetchBatch(taSymbols.slice(i, i + BATCH_SIZE), 'TASE'));
    if (i + BATCH_SIZE < taSymbols.length) await sleep(200);
  }
  for (let i = 0; i < usSymbols.length; i += BATCH_SIZE) {
    allQuotes.push(...await fetchBatch(usSymbols.slice(i, i + BATCH_SIZE), 'SMART'));
    if (i + BATCH_SIZE < usSymbols.length) await sleep(200);
  }

  // If Paper IBKR returned nothing (session offline), return null for all — never fall back to Yahoo
  if (allQuotes.length === 0) {
    for (const t of uncached) map.set(t, null);
    return map;
  }

  // Normalize Paper IBKR quotes to LivePrice shape (identical logic to live IBKR)
  for (const q of allQuotes) {
    if (!q || q.error) continue;
    const sym: string = q.symbol ?? q.ticker ?? '';
    if (!sym) continue;

    const isTase = (q.exchange ?? '').toUpperCase() === 'TASE' || sym.toUpperCase().endsWith('.TA');
    // TASE live quotes from IBKR are in ILS (not agorot); divide by rate to get USD
    const quoteDiv = isTase && ilsRate > 0 ? ilsRate : 1;

    // New IBIND Gateway contract: current_price, prior_close, change, change_percent
    const isNewContract = q.current_price !== undefined;
    let price: number | null = null;
    let prevClose: number | null = null;
    let change: number | null = null;
    let changePercent: number | null = null;
    let isExtendedHours = false;

    if (isNewContract) {
      price = q.current_price / quoteDiv;
      prevClose = q.prior_close != null ? q.prior_close / quoteDiv : null;
      change = q.change != null ? q.change / quoteDiv : null;
      changePercent = q.change_percent ?? null;
      isExtendedHours = q.is_market_open === false;
    } else {
      // Legacy contract: last_price, prior_close, change, change_percent
      price = (q.last_price ?? q.price ?? null);
      if (price != null) price = price / quoteDiv;
      prevClose = q.prior_close != null ? q.prior_close / quoteDiv : null;
      change = q.change != null ? q.change / quoteDiv : null;
      changePercent = q.change_percent ?? null;
    }

    if (price == null || price <= 0) continue;

    const livePrice: LivePrice = {
      price,
      company: q.company_name ?? q.company ?? sym,
      change: change ?? 0,
      changePercent: changePercent ?? 0,
      prevClose,
      isExtendedHours,
      source: 'ibkr',   // real-time Paper IBKR quote (air-gapped from live by function selection)
    };
    setPaperIbkrLiveCache(sym, livePrice);
    map.set(sym, livePrice);
  }

  // For any tickers that Paper IBKR didn't return, set null — never fall back to Yahoo
  const missing = uncached.filter(t => !map.has(t));
  for (const t of missing) map.set(t, null);

  return map;
}
