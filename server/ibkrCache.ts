/**
 * IBKR Server-Side Cache + Heartbeat + Retry Queue
 *
 * (1) In-memory cache for /positions, /pnl, /account/summary (TTL: 15s)
 *     Prevents rate-limit errors from multiple concurrent frontend requests.
 *
 * (9) Heartbeat: GET /health every 5 minutes to verify IBKR session is alive.
 *     Prevents session expiry during quiet periods.
 *
 * (10) Retry queue with exponential backoff for failed IBIND requests.
 *      Failed GET requests are retried up to 3 times: 1s, 2s, 4s delays.
 */

import { ibindRequest, isIbindManuallyDisconnected } from "./routers/ibkrProxy";
import { log } from "./logger";

// ── (1) In-memory cache ───────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000; // 30 seconds — reduces duplicate IBKR calls when multiple pages load simultaneously (PERF-1 v20.48)

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

// ── (7) Latency tracking ─────────────────────────────────────────────────────
let lastIbindLatencyMs: number | null = null;
let lastIbindRequestAt: number | null = null;

export function getIbindLatency() {
  return { latencyMs: lastIbindLatencyMs, lastRequestAt: lastIbindRequestAt };
}

/**
 * Get a cached IBKR response or fetch fresh data.
 * Only caches GET requests. POST/PUT/DELETE bypass the cache.
 */
export async function ibindCached(
  method: string,
  path: string,
  body?: unknown,
  ttlMs: number = CACHE_TTL_MS
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const isGet = method.toUpperCase() === "GET";
  const cacheKey = `${method.toUpperCase()}:${path}`;

  if (isGet) {
    const entry = cache.get(cacheKey);
    if (entry && Date.now() < entry.expiresAt) {
      log.debug("IBKR", `[Cache] HIT: ${path}`);
      return entry.data as { ok: boolean; status: number; body: unknown };
    }
  }

  const result = await ibindRequestWithRetry(method, path, body);

  if (isGet && result.ok) {
    cache.set(cacheKey, {
      data: result,
      expiresAt: Date.now() + ttlMs,
    });
    log.debug("IBKR", `[Cache] SET: ${path} (TTL: ${ttlMs}ms)`);
  }

  return result;
}

/**
 * Invalidate a specific cache entry (e.g., after a write operation).
 */
export function invalidateIbkrCache(path?: string) {
  if (path) {
    cache.delete(`GET:${path}`);
    log.debug("IBKR", `[Cache] INVALIDATED: ${path}`);
  } else {
    cache.clear();
    log.debug("IBKR", "[Cache] CLEARED all entries");
  }
}

/**
 * Get cache stats for debugging.
 */
export function getIbkrCacheStats() {
  const now = Date.now();
  const entries = Array.from(cache.entries()).map(([key, entry]) => ({
    key,
    ttlRemaining: Math.max(0, entry.expiresAt - now),
    expired: now >= entry.expiresAt,
  }));
  return { size: cache.size, entries };
}

// ── (10) Retry queue with exponential backoff ─────────────────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000; // 1s, 2s, 4s

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps ibindRequest with exponential backoff retry logic.
 * Retries on network errors and "Rate exceeded" responses.
 * Does NOT retry on 4xx auth errors (401, 403).
 */
export async function ibindRequestWithRetry(
  method: string,
  path: string,
  body?: unknown,
  maxRetries: number = MAX_RETRIES
): Promise<{ ok: boolean; status: number; body: unknown }> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
     try {
      const t0 = Date.now();
      const result = await ibindRequest(method, path, body);
      const elapsed = Date.now() - t0;
      lastIbindLatencyMs = elapsed;
      lastIbindRequestAt = Date.now();
      // Check for rate limit response
      const bodyStr = typeof result.body === "string"
        ? result.body
        : JSON.stringify(result.body ?? "");

      if (bodyStr.includes("Rate exceeded") || bodyStr.includes("rate exceeded")) {
        if (attempt < maxRetries) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          log.warn("IBKR", `[Retry] Rate exceeded on ${path} — retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
          await sleep(delay);
          continue;
        }
        log.warn("IBKR", `[Retry] Rate exceeded on ${path} — max retries exhausted`);
        return result;
      }

      // Don't retry on auth errors
      if (result.status === 401 || result.status === 403) {
        return result;
      }

      return result;
    } catch (err: any) {
      lastError = err;

      // Do NOT retry on connection errors (ECONNREFUSED, timeout) — IBKR is offline,
      // retrying wastes 1s+2s+4s = 7 extra seconds per request.
      const isConnectionError = err?.message?.includes('timed out') ||
        err?.code === 'ECONNREFUSED' || err?.code === 'ECONNRESET' ||
        err?.code === 'ENOTFOUND' || err?.type === 'system';
      if (isConnectionError) {
        log.debug("IBKR", `[Retry] Connection error on ${path} — not retrying (IBKR offline)`, { error: err?.message });
        break; // exit retry loop immediately
      }

      if (attempt < maxRetries) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        log.warn("IBKR", `[Retry] Request error on ${path} — retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`, {
          error: err?.message,
        });
        await sleep(delay);
      }
    }
  }

  throw lastError ?? new Error(`[Retry] Failed after ${maxRetries} attempts: ${path}`);
}

// ── (9) Heartbeat ─────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 5 * 60_000; // every 5 minutes
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

async function sendHeartbeat() {
  if (isIbindManuallyDisconnected()) {
    log.debug("IBKR", "[Heartbeat] Skipped — IBIND manually disconnected");
    return;
  }
  // v14.03: Only tickle during US extended hours (pre-market 04:00 through after-hours 20:00 ET)
  // Outside these hours, the Live IBKR gateway is not needed and tickle just generates noise.
  const { isPreMarketUs, isUsOpen, isAfterHoursUs } = await import("./utils/marketHours");
  const now = new Date();
  if (!isPreMarketUs(now) && !isUsOpen(now) && !isAfterHoursUs(now)) {
    log.debug("IBKR", "[Heartbeat] Skipped — outside US trading hours");
    return;
  }
  try {
    const result = await ibindRequest("GET", "/health");
    const body = result.body as Record<string, any>;
    if (result.ok) {
      log.debug("IBKR", "[Heartbeat] Health OK — session alive", {
        session_active: body?.session_active ?? "unknown",
      });
    } else {
      log.warn("IBKR", "[Heartbeat] Health check failed", { status: result.status, body: JSON.stringify(body).slice(0, 100) });
    }
  } catch (err: any) {
    log.warn("IBKR", "[Heartbeat] Health check error", { error: err?.message });
  }
}

export function startIbkrHeartbeat() {
  if (heartbeatTimer) return;
  log.info("IBKR", `[Heartbeat] Starting IBKR heartbeat (every ${HEARTBEAT_INTERVAL_MS / 60000} min)`);
  // Send first heartbeat after 2 minutes (give session time to establish)
  setTimeout(sendHeartbeat, 2 * 60_000);
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

export function stopIbkrHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    log.info("IBKR", "[Heartbeat] Stopped");
  }
}
