/**
 * Favorites Router — v15.07
 * Provides the "Hunter Dashboard" with live IBKR quotes and native watchlist sync.
 *
 * Procedures:
 *   - list: returns all catalog assets (reuses getCatalogueWithScores SWR cache)
 *   - refreshQuotes: fetches live IBKR prices for all catalog tickers
 *   - syncToIbkr: pushes catalog tickers to 2 native IBKR watchlists (USA + ISR)
 */
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getUserAssets } from "../db";
import { fetchIbkrLivePricesBatch } from "../marketData";
import { ibindRequest } from "./ibkrProxy";
import { log } from "../logger";
import { swrInvalidate } from "../swrCache";
import { getDb } from "../db";
import { ibkrConidCache, userAssets } from "../../drizzle/schema";
import { eq, and } from "drizzle-orm";

// ── Helper: rebuild a single IBKR watchlist ─────────────────────────────────
// Generate a random numeric ID (IBKR requires digits only, must be unique)
function generateWatchlistId(): string {
  return String(Math.floor(Math.random() * 900000) + 100000); // 6-digit random
}

async function rebuildIbkrWatchlist(
  name: string,
  conids: number[]
): Promise<{ success: boolean; error?: string }> {
  if (conids.length === 0) {
    return { success: true }; // Nothing to sync
  }

  try {
    // 1. Get all existing watchlists
    const listRes = await ibindRequest("GET", "/api/proxy/iserver/watchlists?SC=USER_WATCHLIST");
    if (!listRes.ok) {
      log.warn("IBKR", `[Favorites] Failed to fetch watchlists: ${listRes.status}`, { body: listRes.body });
      return { success: false, error: `Failed to fetch watchlists (${listRes.status})` };
    }

    // 2. Find existing watchlist with this name
    const responseBody = listRes.body as any;
    const userLists: any[] = responseBody?.data?.user_lists ?? responseBody?.user_lists ?? [];
    let existingId: string | null = null;

    if (Array.isArray(userLists)) {
      const existing = userLists.find((w: any) => w.name === name);
      if (existing) {
        existingId = String(existing.id);
      }
    }

    // 3. Delete existing if found
    if (existingId) {
      const delRes = await ibindRequest("DELETE", `/api/proxy/iserver/watchlist?id=${existingId}`);
      log.info("IBKR", `[Favorites] Deleted existing watchlist "${name}" (id=${existingId})`, {
        ok: delRes.ok, status: delRes.status, body: delRes.body,
      });
      // Small delay after delete to let IBKR process
      await new Promise(r => setTimeout(r, 1000));
    }

    // 4. Create new watchlist with all conids
    // Per IBKR API: {"id": "numeric_string", "name": "...", "rows": [{"C": conid, "ST": "STK"}, ...]}
    const newId = generateWatchlistId();
    const rows = conids.map(c => ({ C: c, ST: "STK" }));
    const createBody = {
      id: newId,
      name,
      rows,
    };

    log.info("IBKR", `[Favorites] Creating watchlist "${name}" id=${newId} with ${conids.length} conids`, {
      sampleConids: conids.slice(0, 5),
      bodySize: JSON.stringify(createBody).length,
    });

    const createRes = await ibindRequest("POST", "/api/proxy/iserver/watchlist", createBody);
    if (!createRes.ok) {
      log.warn("IBKR", `[Favorites] Failed to create watchlist "${name}": ${createRes.status}`, {
        body: createRes.body,
        conidCount: conids.length,
        id: newId,
      });
      return { success: false, error: `Failed to create watchlist (${createRes.status}): ${JSON.stringify(createRes.body)}` };
    }

    log.info("IBKR", `[Favorites] Created watchlist "${name}" with ${conids.length} tickers (id=${newId})`);
    return { success: true };
  } catch (err: any) {
    log.error("IBKR", `[Favorites] Error syncing watchlist "${name}"`, { error: err.message });
    return { success: false, error: err.message };
  }
}

// ── Exported helper for auto-sync from addUserAsset ─────────────────────────
export async function autoSyncWatchlists(userId: number): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;

    // Get all active catalog tickers
    const assets = await db
      .select({ ticker: userAssets.ticker })
      .from(userAssets)
      .where(and(eq(userAssets.userId, userId), eq(userAssets.archived, 0)));

    const allTickers = assets.map(a => a.ticker.toUpperCase());
    const usaTickers = allTickers.filter(t => !t.endsWith(".TA"));
    const taseTickers = allTickers.filter(t => t.endsWith(".TA"));

    // Get conids from cache
    const conidRows = await db.select().from(ibkrConidCache);
    const conidMap = new Map(conidRows.map(r => [r.symbol.toUpperCase(), r.conid]));

    // Build conid arrays
    const usaConids = usaTickers
      .map(t => conidMap.get(t))
      .filter((c): c is number => c != null);

    const taseConids = taseTickers
      .map(t => conidMap.get(t))
      .filter((c): c is number => c != null);

    // Rebuild both watchlists
    await Promise.allSettled([
      rebuildIbkrWatchlist("Algo Master USA", usaConids),
      rebuildIbkrWatchlist("Algo Master ISR", taseConids),
    ]);
  } catch (err: any) {
    log.warn("IBKR", "[Favorites] autoSyncWatchlists failed (non-blocking)", { error: err.message });
  }
}

// ── Router ──────────────────────────────────────────────────────────────────
export const favoritesRouter = router({
  /**
   * list — returns all catalog assets with scores, prices, sectors.
   * Reuses the same data as getCatalogueWithScores (SWR cached).
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    const assets = await getUserAssets(userId);
    return assets.map((a: any) => ({
      id: a.id,
      ticker: a.ticker,
      company: a.companyName ?? "",
      sector: a.sector ?? "",
      score: a.score != null ? Number(a.score) : null,
      tier: a.tier ?? null,
      cmp: a.cmp != null ? Number(a.cmp) : null,
      dailyChangePercent: a.dailyChangePercent != null ? Number(a.dailyChangePercent) : null,
      recommendedBuyPrice: a.recommendedBuyPrice != null ? Number(a.recommendedBuyPrice) : null,
      recommendedStopLoss: a.recommendedStopLoss != null ? Number(a.recommendedStopLoss) : null,
      hotSignal: a.hotSignal === 1 || a.hotSignal === true,
      scannedAt: a.scannedAt ?? null,
    }));
  }),

  /**
   * refreshQuotes — fetches live IBKR prices for all catalog tickers.
   * Updates cmp + dailyChangePercent in userAssets table.
   */
  refreshQuotes: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.user.id;
    const assets = await getUserAssets(userId);
    const tickers = assets.map((a: any) => a.ticker as string);
    if (tickers.length === 0) return { updated: 0, refreshedAt: new Date().toISOString() };

    const priceMap = await fetchIbkrLivePricesBatch(tickers);
    let updated = 0;

    // Log how many prices came back
    const received = Array.from(priceMap.values()).filter(v => v != null).length;
    const missing = tickers.filter(t => !priceMap.has(t) || priceMap.get(t) == null);
    log.info("IBKR", `[Favorites] refreshQuotes: ${received}/${tickers.length} prices received`, {
      missing: missing.length > 0 ? missing.slice(0, 10).join(", ") : "none",
    });

    const db = await getDb();
    if (!db) return { updated: 0, refreshedAt: new Date().toISOString() };

    await Promise.all(
      tickers.map(async (ticker: string) => {
        const live = priceMap.get(ticker);
        if (!live) return;
        await db.update(userAssets)
          .set({
            cmp: live.price,
            dailyChangePercent: live.changePercent,
            scannedAt: new Date(),
          } as any)
          .where(and(eq(userAssets.userId, userId), eq(userAssets.ticker, ticker.toUpperCase())));
        updated++;
      })
    );

    // Invalidate SWR cache so getCatalogueWithScores returns fresh data
    swrInvalidate(`portfolio:catalogue:${userId}`);

    return { updated, total: tickers.length, missing: missing.length, refreshedAt: new Date().toISOString() };
  }),

  /**
   * syncToIbkr — pushes catalog tickers to 2 native IBKR watchlists.
   * Full rebuild: delete existing + create new (guarantees consistency).
   */
  syncToIbkr: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.user.id;
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

    // Get all active catalog tickers
    const assets = await getUserAssets(userId);
    const allTickers = assets.map((a: any) => (a.ticker as string).toUpperCase());
    const usaTickers = allTickers.filter(t => !t.endsWith(".TA"));
    const taseTickers = allTickers.filter(t => t.endsWith(".TA"));

    // Get conids from cache
    const conidRows = await db.select().from(ibkrConidCache);
    const conidMap = new Map(conidRows.map(r => [r.symbol.toUpperCase(), r.conid]));

    // Build conid arrays (skip tickers without cached conid)
    const usaConids = usaTickers
      .map(t => conidMap.get(t))
      .filter((c): c is number => c != null);
    const taseConids = taseTickers
      .map(t => conidMap.get(t))
      .filter((c): c is number => c != null);

    const missingUsa = usaTickers.filter(t => !conidMap.has(t));
    const missingTase = taseTickers.filter(t => !conidMap.has(t));

    // Rebuild both watchlists
    const [usaResult, taseResult] = await Promise.all([
      rebuildIbkrWatchlist("Algo Master USA", usaConids),
      rebuildIbkrWatchlist("Algo Master ISR", taseConids),
    ]);

    return {
      usa: {
        synced: usaConids.length,
        total: usaTickers.length,
        missing: missingUsa,
        success: usaResult.success,
        error: usaResult.error,
      },
      tase: {
        synced: taseConids.length,
        total: taseTickers.length,
        missing: missingTase,
        success: taseResult.success,
        error: taseResult.error,
      },
    };
  }),
});
