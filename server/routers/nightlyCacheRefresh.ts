/**
 * Nightly Cache Refresh Scheduled Endpoint — POST /api/scheduled/refresh-cache
 *
 * Called by the Manus scheduled task every night at 2am Israel time.
 * Rebuilds stale price cache entries for all watchlist assets belonging to the owner.
 *
 * Auth: requires a valid app_session_id cookie (user role is sufficient).
 */
import type { Express, Request, Response } from "express";
import { getDb, getUserByOpenId } from "../db";
import { userAssets } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { fetchBarsForTicker } from "../marketData";
import { getCacheStatus, upsertPriceCache } from "../db";
import { sdk } from "../_core/sdk";
import { ENV } from "../_core/env";

interface RefreshResult {
  ticker: string;
  status: "ok" | "skipped" | "failed";
  rowCount: number;
  error?: string;
}

async function runNightlyCacheRefresh(userId: number): Promise<{
  total: number;
  fetched: number;
  skipped: number;
  failed: number;
  results: RefreshResult[];
}> {
  const db = await getDb();
  if (!db) return { total: 0, fetched: 0, skipped: 0, failed: 0, results: [] };

  // Get all unique tickers for this user
  const assets = await db
    .select({ ticker: userAssets.ticker })
    .from(userAssets)
    .where(eq(userAssets.userId, userId));

  const tickers = Array.from(new Set(assets.map((a: { ticker: string }) => a.ticker.toUpperCase())));
  const results: RefreshResult[] = [];
  let fetched = 0;
  let skipped = 0;
  let failed = 0;

  // Check which tickers are stale
  const statusMap = await getCacheStatus(tickers);

  for (const ticker of tickers) {
    const status = statusMap[ticker];

    // Skip if fresh (less than 20 hours old and has enough rows)
    if (status && !status.isStale && status.rowCount > 100) {
      results.push({ ticker, status: "skipped", rowCount: status.rowCount });
      skipped++;
      continue;
    }

    try {
      // Add small delay to avoid Yahoo Finance rate limits
      await new Promise(r => setTimeout(r, 300));

      const bars = await fetchBarsForTicker(ticker, 756); // ~3 years
      if (bars.length === 0) {
        results.push({ ticker, status: "failed", rowCount: 0, error: "No data returned from Yahoo Finance" });
        failed++;
        continue;
      }

      // Upsert all bars into DB cache — normalize volume to number
      // DB cache stores RAW Yahoo prices (ILA for TASE tickers).
      // fetchBarsForTicker already divided by 100 (ILA→ILS), so we must
      // multiply back by 100 to store ILA in cache (consistent with priceCache.ts).
      const isTase = ticker.toUpperCase().endsWith('.TA');
      const cacheBars = bars.map(b => ({
        ...b,
        open:  isTase ? b.open * 100 : b.open,
        high:  isTase ? b.high * 100 : b.high,
        low:   isTase ? b.low * 100 : b.low,
        close: isTase ? b.close * 100 : b.close,
        volume: b.volume ?? 0,
      }));
      await upsertPriceCache(ticker, cacheBars);
      results.push({ ticker, status: "ok", rowCount: bars.length });
      fetched++;
    } catch (err) {
      results.push({ ticker, status: "failed", rowCount: 0, error: String(err) });
      failed++;
    }
  }

  return { total: tickers.length, fetched, skipped, failed, results };
}

export function registerNightlyCacheRefreshRoute(app: Express): void {
  app.post("/api/scheduled/refresh-cache", async (req: Request, res: Response) => {
    // Authenticate: require a valid session cookie (user role is sufficient)
    let user = null;
    try {
      user = await sdk.authenticateRequest(req);
    } catch {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    if (!user) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    try {
      // Use owner userId if available (for scheduled task context), otherwise the authenticated user
      let targetUserId = user.id;
      if (ENV.ownerOpenId) {
        const ownerUser = await getUserByOpenId(ENV.ownerOpenId);
        if (ownerUser?.id) targetUserId = ownerUser.id;
      }

      console.log(`[NightlyCacheRefresh] Starting for userId=${targetUserId}`);
      const result = await runNightlyCacheRefresh(targetUserId);
      console.log(`[NightlyCacheRefresh] Done: ${result.fetched} fetched, ${result.skipped} skipped, ${result.failed} failed`);

      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[NightlyCacheRefresh] Error:", err);
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
}
