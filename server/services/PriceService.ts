/**
 * PriceService.ts — Universal Price Pass-Through
 *
 * Architecture (new IBIND Gateway contract):
 *   IBIND Gateway handles ALL market-hours logic, weekend math, 'C' prefix,
 *   prior_close resolution, and daily change calculation server-side.
 *
 *   Node.js responsibility:
 *     1. Chunk tickers into batches of ≤50 (IBIND rate limit: 5 calls/sec)
 *     2. Fan-out requests with ≤200ms delay between batches
 *     3. Merge results into a flat map: symbol → NormalizedPrice
 *     4. Pass through to frontend — ZERO local change math
 *
 * New IBIND Gateway contract per ticker:
 * {
 *   ticker: string,
 *   current_price: number,
 *   prior_close: number,
 *   change: number,          // current_price - prior_close (computed by Gateway)
 *   change_percent: number,  // change / prior_close × 100 (computed by Gateway)
 *   exchange: string,        // "NASDAQ" | "TASE" | etc.
 *   is_market_open: boolean,
 *   is_delayed: boolean
 * }
 *
 * Legacy IBIND contract (current, until Gateway upgrade):
 * {
 *   symbol: string,
 *   last_price: number | null,
 *   prior_close: number | null,
 *   change: number | null,
 *   change_percent: number | null,
 *   is_closing_price: boolean,
 *   pre_market_price: number | null,
 *   pre_market_change: number | null,
 *   pre_market_change_percent: number | null,
 *   currency: string,
 *   exchange: string | null,
 *   delayed: boolean
 * }
 */

import { getMarketState, getExchange } from '../utils/marketHours.js';

// ── USD/ILS exchange rate cache (5min TTL) ────────────────────────────────────
let _usdIlsRate: number | null = null;
let _usdIlsTs = 0;
const USD_ILS_TTL_MS = 5 * 60 * 1000;

/** Safe JSON parse — returns null if the body is not valid JSON. */
async function safeJson(res: Response): Promise<any | null> {
  try {
    const text = await res.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Fetch the current USD/ILS exchange rate.
 * Priority: (1) FX Rates API → (2) Bank of Israel API → (3) cached/fallback.
 * Cached for 5 minutes.
 */
export async function getUsdIlsRate(): Promise<number> {
  if (_usdIlsRate && Date.now() - _usdIlsTs < USD_ILS_TTL_MS) return _usdIlsRate;

  // ── Source 1: FX Rates API (free, real-time, updates every minute) ─────────
  try {
    const fxRes = await fetch(
      "https://api.fxratesapi.com/latest?base=USD&currencies=ILS",
      { signal: AbortSignal.timeout(4000) }
    );
    if (fxRes.ok) {
      const fxData = await safeJson(fxRes);
      const fxRate = fxData?.rates?.ILS;
      if (fxRate && fxRate > 1 && fxRate < 10) {
        _usdIlsRate = fxRate;
        _usdIlsTs = Date.now();
        return fxRate;
      }
    }
  } catch { /* fall through to BOI */ }

  // ── Source 2: Bank of Israel API (official representative rate) ────────────
  try {
    const boiRes = await fetch(
      "https://www.boi.org.il/PublicApi/GetExchangeRates",
      {
        signal: AbortSignal.timeout(4000),
        headers: { "Accept": "application/json" },
      }
    );
    if (boiRes.ok) {
      const boiData = await safeJson(boiRes);
      const rates = boiData?.exchangeRates ?? boiData?.ExchangeRates ?? [];
      const usdEntry = rates.find((r: any) => (r.key ?? r.Key) === "USD");
      const boiRate = usdEntry?.currentExchangeRate ?? usdEntry?.CurrentExchangeRate;
      if (boiRate && boiRate > 1 && boiRate < 10) {
        _usdIlsRate = boiRate;
        _usdIlsTs = Date.now();
        return boiRate;
      }
    }
  } catch { /* fall through to fallback */ }

  // ── Source 3: Return cached value or static fallback ──────────────────────
  if (_usdIlsRate && _usdIlsRate > 1) return _usdIlsRate;
  return 3.60; // safe fallback (updated June 2026)
}

// ── TASE bar normalizer ────────────────────────────────────────────────────────

export type OhlcBar = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  [key: string]: any;
};

/**
 * Normalize OHLC bars for a given ticker.
 *
 * TASE canonical rule (matches normalizeIbindQuote):
 *   IBKR returns TASE (.TA) prices in agorot → USD = agorot ÷ 100 ÷ ilsRate
 *   US tickers: passthrough (no division).
 *
 * @param bars     Array of OHLC bars
 * @param ticker   Ticker symbol (e.g. "POLI.TA" or "AAPL")
 * @param ilsRate  Current USD/ILS rate (guard: if <= 0, divisor = 1)
 */
export function normalizeBarsForTicker<T extends OhlcBar>(
  bars: T[],
  ticker: string,
  ilsRate: number,
): T[] {
  if (!ticker.toUpperCase().endsWith('.TA')) return bars;
  const divisor = ilsRate > 0 ? 100 * ilsRate : 1;
  return bars.map(bar => ({
    ...bar,
    open: bar.open / divisor,
    high: bar.high / divisor,
    low: bar.low / divisor,
    close: bar.close / divisor,
    // volume is left unchanged
  }));
}

// ── Output contract (what Node.js returns to frontend) ─────────────────────

export interface NormalizedPrice {
  symbol: string;
  price: number | null;          // current effective price in USD
  change: number | null;         // daily change in USD (from Gateway or computed)
  changePct: number | null;      // daily change % (from Gateway or computed)
  prevClose: number | null;      // prior session close in USD
  isLive: boolean;               // true = real-time, false = delayed/cached
  exchange: string;
  marketLabel: 'OPEN' | 'PRE_MARKET' | 'AFTER_HOURS' | 'CLOSED' | 'HOLIDAY' | 'HALF_DAY';
  currency: string;
  conid: number | null;
  error: string | null;
}

// ── New IBIND Gateway contract (post-upgrade) ──────────────────────────────

export interface IbindNewContractQuote {
  ticker: string;
  current_price: number;
  prior_close: number;
  change: number;
  change_percent: number;
  exchange: string;
  is_market_open: boolean;
  is_delayed: boolean;
  conid?: number | null;
  error?: string | null;
}

// ── Legacy IBIND contract (current, until Gateway upgrade) ─────────────────

export interface IbindRawQuote {
  symbol: string;
  conid?: number | null;
  last_price: number | null;
  prior_close: number | null;
  change: number | null;
  change_percent: number | null;
  is_closing_price: boolean;
  pre_market_price: number | null;
  pre_market_change: number | null;
  pre_market_change_percent: number | null;
  currency?: string;
  exchange?: string | null;
  delayed?: boolean;
  error?: string | null;
}

// ── Chunking utility ───────────────────────────────────────────────────────

/**
 * Split an array into chunks of at most `size` elements.
 * IBIND accepts max 100 conids per request; we use 50 for safety.
 */
export function chunkArray<T>(arr: T[], size: number = 50): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Execute batched IBIND /quotes requests with rate-limit delay.
 * @param tickers  Full list of ticker symbols
 * @param fetchFn  Function that fetches a single batch → raw quotes array
 * @param batchSize  Max tickers per request (default 50)
 * @param delayMs  Delay between batches in ms (default 200ms = 5 calls/sec)
 */
export async function fetchInBatches<T>(
  tickers: string[],
  fetchFn: (batch: string[]) => Promise<T[]>,
  batchSize: number = 50,
  delayMs: number = 200,
): Promise<T[]> {
  const chunks = chunkArray(tickers, batchSize);
  const results: T[] = [];

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0 && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    const batchResults = await fetchFn(chunks[i]);
    results.push(...batchResults);
  }

  return results;
}

// ── New contract normalizer (post-Gateway upgrade) ─────────────────────────

/**
 * Normalize a single new-contract IBIND quote.
 * Gateway already computed change and change_percent — pure pass-through.
 */
export function normalizeNewContractQuote(
  q: IbindNewContractQuote,
  ilsRate: number = 1,
  now: Date = new Date(),
): NormalizedPrice {
  const symbol = q.ticker ?? '';
  const currency = q.exchange === 'TASE' ? 'ILS' : 'USD';
  const divisor = currency === 'ILS' && ilsRate > 0 ? ilsRate : 1;

  if (q.error) {
    return {
      symbol, price: null, change: null, changePct: null, prevClose: null,
      isLive: false, exchange: q.exchange ?? '', marketLabel: 'CLOSED',
      currency, conid: q.conid ?? null, error: q.error,
    };
  }

  const state = getMarketState(symbol, currency, now);

  return {
    symbol,
    price: q.current_price / divisor,
    change: q.change / divisor,
    changePct: q.change_percent,
    prevClose: q.prior_close / divisor,
    isLive: !q.is_delayed,
    exchange: q.exchange ?? state.exchange,
    marketLabel: q.is_market_open ? 'OPEN' : state.label,
    currency,
    conid: q.conid ?? null,
    error: null,
  };
}

// ── Legacy contract normalizer (current, until Gateway upgrade) ────────────

/**
 * Normalize a single legacy IBIND raw quote.
 *
 * Daily change rules (matching IBKR App):
 *   OPEN:       change = last_price - prior_close  (NEVER use IBIND's pre_market_change)
 *   PRE/AFTER:  change = pre_market_price - prior_close
 *   CLOSED:     change = 0 (weekend/holiday)
 */
export function normalizeIbindQuote(
  raw: IbindRawQuote,
  ilsRate: number,
  now: Date = new Date(),
): NormalizedPrice {
  const symbol = raw.symbol ?? '';
  const currency = (raw.currency ?? (raw.exchange === 'TASE' ? 'ILS' : 'USD')).toUpperCase();
  const isIls = currency === 'ILS';
  const divisor = isIls && ilsRate > 0 ? ilsRate : 1;

  const state = getMarketState(symbol, currency, now);

  const lastPriceUsd = raw.last_price != null ? raw.last_price / divisor : null;
  const priorCloseUsd = raw.prior_close != null ? raw.prior_close / divisor : null;
  const preMarketPriceUsd = raw.pre_market_price != null ? raw.pre_market_price / divisor : null;

  if (raw.error) {
    return {
      symbol, price: null, change: null, changePct: null, prevClose: null,
      isLive: false, exchange: state.exchange, marketLabel: state.label,
      currency, conid: raw.conid ?? null, error: raw.error,
    };
  }

  let price: number | null;
  let change: number | null;
  let changePct: number | null;

  if (state.isOpen) {
    // Regular session: last_price is live, compute change vs prior_close
    price = lastPriceUsd;
    if (price != null && priorCloseUsd != null && priorCloseUsd > 0) {
      change = price - priorCloseUsd;
      changePct = (change / priorCloseUsd) * 100;
    } else {
      change = null;
      changePct = null;
    }
  } else if (state.isPreMarket || state.isAfterHours) {
    // Extended hours: use pre_market_price if available
    // CRITICAL: NEVER use raw.pre_market_change — it's bar-relative, not daily
    price = preMarketPriceUsd ?? lastPriceUsd;
    if (price != null && priorCloseUsd != null && priorCloseUsd > 0) {
      change = price - priorCloseUsd;
      changePct = (change / priorCloseUsd) * 100;
    } else {
      change = null;
      changePct = null;
    }
  } else {
    // Closed (weekend/holiday): price = last close, change = 0
    price = lastPriceUsd;
    change = 0;
    changePct = 0;
  }

  return {
    symbol,
    price,
    change,
    changePct,
    prevClose: priorCloseUsd,
    isLive: !(raw.delayed ?? false),
    exchange: raw.exchange ?? state.exchange,
    marketLabel: state.label,
    currency,
    conid: raw.conid ?? null,
    error: null,
  };
}

/**
 * Normalize a batch of legacy IBIND raw quotes.
 * Returns a map: symbol → NormalizedPrice
 */
export function normalizeIbindBatch(
  rawQuotes: IbindRawQuote[],
  ilsRate: number,
  now: Date = new Date(),
): Record<string, NormalizedPrice> {
  const result: Record<string, NormalizedPrice> = {};
  for (const raw of rawQuotes) {
    if (raw.symbol) {
      result[raw.symbol] = normalizeIbindQuote(raw, ilsRate, now);
    }
  }
  return result;
}

/**
 * Normalize a batch of new-contract IBIND quotes.
 * Returns a map: ticker → NormalizedPrice
 */
export function normalizeNewContractBatch(
  quotes: IbindNewContractQuote[],
  ilsRate: number = 1,
  now: Date = new Date(),
): Record<string, NormalizedPrice> {
  const result: Record<string, NormalizedPrice> = {};
  for (const q of quotes) {
    if (q.ticker) {
      result[q.ticker] = normalizeNewContractQuote(q, ilsRate, now);
    }
  }
  return result;
}
