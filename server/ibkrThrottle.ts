/**
 * ibkrThrottle.ts — Token Bucket Rate Limiter for IBKR API (V2.00)
 *
 * IBKR enforces a hard limit of ~50 req/s per session.
 * This module wraps every ibindRequest call through a token bucket
 * that enforces a maximum sustained rate and adds micro-delays
 * between cancel/modify orders to avoid Compliance triggers.
 *
 * Usage:
 *   import { throttledIbind } from "./ibkrThrottle";
 *   const res = await throttledIbind("GET", "/positions");
 */

import { ibindRequest } from "./routers/ibkrProxy";
import { log } from "./logger";

// ─── Token Bucket Config ─────────────────────────────────────────────────────
const MAX_TOKENS        = 40;          // burst capacity (below IBKR's 50 hard limit)
const REFILL_RATE_MS    = 1000;        // refill MAX_TOKENS every 1 second
const MODIFY_DELAY_MS   = 30;          // micro-delay between cancel/modify commands
const MAX_QUEUE_SIZE    = 200;         // drop requests beyond this (safety valve)

let _tokens = MAX_TOKENS;
let _lastRefill = Date.now();
let _queueSize  = 0;

function refillTokens(): void {
  const now = Date.now();
  const elapsed = now - _lastRefill;
  if (elapsed >= REFILL_RATE_MS) {
    const refillCount = Math.floor(elapsed / REFILL_RATE_MS) * MAX_TOKENS;
    _tokens = Math.min(MAX_TOKENS, _tokens + refillCount);
    _lastRefill = now;
  }
}

function waitForToken(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (_queueSize >= MAX_QUEUE_SIZE) {
      reject(new Error("[IBKR Throttle] Queue full — request dropped"));
      return;
    }
    _queueSize++;

    function attempt() {
      refillTokens();
      if (_tokens > 0) {
        _tokens--;
        _queueSize--;
        resolve();
        return;
      }
      // No token available — wait until next refill window
      const waitMs = REFILL_RATE_MS - (Date.now() - _lastRefill) + 10;
      setTimeout(attempt, Math.max(waitMs, 50));
    }
    attempt();
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * throttledIbind — drop-in replacement for ibindRequest with rate limiting.
 */
export async function throttledIbind(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<{ ok: boolean; status: number; body: unknown }> {
  await waitForToken();
  return ibindRequest(method, path, body, extraHeaders);
}

/**
 * throttledModify — for cancel/modify orders: adds fixed micro-delay
 * on top of token bucket to prevent Compliance bursts.
 */
export async function throttledModify(
  method: string,
  path: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; body: unknown }> {
  await waitForToken();
  await new Promise(r => setTimeout(r, MODIFY_DELAY_MS));
  return ibindRequest(method, path, body);
}

/**
 * batchMarketDataSnapshot — fetch prices for multiple tickers in one call.
 * IBKR supports comma-separated symbols in the snapshot endpoint.
 * Returns a map: ticker → price
 */
export async function batchMarketDataSnapshot(
  tickers: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (tickers.length === 0) return result;

  // IBKR snapshot supports batches of up to 50 symbols
  const BATCH_SIZE = 50;
  const chunks: string[][] = [];
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    chunks.push(tickers.slice(i, i + BATCH_SIZE));
  }

  for (const chunk of chunks) {
    try {
      await waitForToken();
      const symbols = chunk.join(",");
      const res = await ibindRequest(
        "GET",
        `/iserver/marketdata/snapshot?conids=&fields=31,84,86&symbols=${symbols}`
      );
      if (res.ok) {
        const snaps = res.body as any[];
        for (const snap of (Array.isArray(snaps) ? snaps : [])) {
          const sym = (snap?.symbol ?? snap?.ticker ?? "").toUpperCase();
          const price = parseFloat(snap?.["31"] ?? snap?.["84"] ?? snap?.["86"] ?? "0");
          if (sym && price > 0) result.set(sym, price);
        }
      }
    } catch (e: any) {
      log.warn("THROTTLE", `[BatchSnapshot] chunk failed: ${e.message}`);
    }
  }
  return result;
}

export function getThrottleStats() {
  return { tokens: _tokens, queueSize: _queueSize, maxTokens: MAX_TOKENS };
}
