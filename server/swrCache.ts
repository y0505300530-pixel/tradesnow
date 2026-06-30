/**
 * swrCache.ts — Stale-While-Revalidate in-memory cache
 *
 * Usage:
 *   const result = await swrGet("key", ttlMs, () => expensiveFetch());
 *
 * Behaviour:
 *   - First call: fetches synchronously, stores result, returns it.
 *   - Subsequent calls within TTL: returns cached value immediately (TTFB ≈ 0).
 *   - After TTL expires: returns stale value immediately AND triggers a background
 *     revalidation so the next call gets a fresh value.
 *   - If the background fetch is already in-flight, no duplicate fetch is started.
 *   - Cache is per-key, per-process (Node.js in-memory Map).
 *
 * Performance contract:
 *   TTFB for cached endpoints: < 5ms (Map lookup + serialisation overhead)
 *   Background revalidation: runs asynchronously, never blocks the response.
 */

interface CacheEntry<T> {
  value: T;
  fetchedAt: number;   // unix ms
  ttlMs: number;
  revalidating: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const store = new Map<string, CacheEntry<any>>();

/**
 * Get a value from the SWR cache.
 *
 * @param key       Unique cache key (e.g. "paperLab:stats:userId:3")
 * @param ttlMs     How long the value is considered "fresh" (milliseconds)
 * @param fetcher   Async function that produces the value when cache is cold/stale
 */
export async function swrGet<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const entry = store.get(key) as CacheEntry<T> | undefined;

  if (!entry) {
    // Cold cache — must fetch synchronously
    const value = await fetcher();
    store.set(key, { value, fetchedAt: now, ttlMs, revalidating: false });
    return value;
  }

  const age = now - entry.fetchedAt;

  if (age < entry.ttlMs) {
    // Fresh — return immediately
    return entry.value;
  }

  // Stale — return immediately AND revalidate in background
  if (!entry.revalidating) {
    entry.revalidating = true;
    fetcher()
      .then((fresh) => {
        store.set(key, { value: fresh, fetchedAt: Date.now(), ttlMs, revalidating: false });
      })
      .catch((err) => {
        // Revalidation failed — keep stale value, allow retry next call
        console.warn(`[swrCache] Revalidation failed for key "${key}":`, err?.message ?? err);
        entry.revalidating = false;
      });
  }

  return entry.value; // return stale immediately
}

/**
 * Explicitly invalidate a cache entry (e.g. after a mutation).
 * Next call to swrGet with this key will fetch synchronously.
 */
export function swrInvalidate(key: string): void {
  store.delete(key);
}

/**
 * Invalidate all keys that start with a given prefix.
 * Useful for user-scoped invalidation: swrInvalidatePrefix("paperLab:3:")
 */
export function swrInvalidatePrefix(prefix: string): void {
  for (const key of Array.from(store.keys())) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/** Current cache size (for diagnostics) */
export function swrCacheSize(): number {
  return store.size;
}
