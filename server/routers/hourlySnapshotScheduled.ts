/**
 * Hourly Snapshot Scheduled Endpoint — POST /api/scheduled/hourly-snapshot
 *
 * Called by the Manus scheduled task every hour during trading hours.
 * Reads lastKnownNetLiquidation (H1) from portfolioAccounts + computes H2 value
 * from holding2 table using cached prices, then saves to hourlySnapshots.
 *
 * Auth: requires a valid app_session_id cookie (user role is sufficient).
 */
import type { Express, Request, Response } from "express";
import { getDb, getUserByOpenId } from "../db";
import { portfolioAccounts, holding2, hourlySnapshots } from "../../drizzle/schema";
import { eq, and, gte } from "drizzle-orm";
import { fetchLivePricesBatch } from "../marketData";
import { sdk } from "../_core/sdk";
import { ENV } from "../_core/env";

async function runHourlySnapshot(userId: number): Promise<{ h1Value: number | null; h2Value: number; combinedValue: number; saved: boolean }> {
  const db = await getDb();
  if (!db) return { h1Value: null, h2Value: 0, combinedValue: 0, saved: false };

  // ── H1: use lastKnownNetLiquidation from portfolioAccounts ──────────────
  const [account] = await db
    .select()
    .from(portfolioAccounts)
    .where(eq(portfolioAccounts.userId, userId))
    .limit(1);

  const h1Value: number | null = account?.lastKnownNetLiquidation ?? account?.lastKnownNLV ?? null;

  // ── H2: compute from holding2 + live prices ─────────────────────────────
  const h2Holdings = await db
    .select()
    .from(holding2)
    .where(eq(holding2.userId, userId));

  let h2Value = 0;
  if (h2Holdings.length > 0) {
    const tickers = Array.from(new Set(h2Holdings.map((h: { ticker: string }) => h.ticker)));
    const livePricesMap = await fetchLivePricesBatch(tickers);
    for (const h of h2Holdings) {
      const lp = livePricesMap.get(h.ticker.toUpperCase()) ?? livePricesMap.get(h.ticker);
      const price = lp?.price ?? h.currentPrice ?? h.buyPrice ?? 0;
      h2Value += price * (h.units ?? 0);
    }
  }

  const combinedValue = (h1Value ?? 0) + h2Value;

  // ── Save snapshot (upsert by hour bucket) ──────────────────────────────
  const hourTs = Math.floor(Date.now() / (60 * 60 * 1000)) * (60 * 60 * 1000);
  await db.insert(hourlySnapshots).values({
    userId,
    snapshotTs: hourTs,
    h1Value: h1Value,
    h2Value: h2Value,
    combinedValue,
  }).onDuplicateKeyUpdate({
    set: {
      h1Value: h1Value,
      h2Value: h2Value,
      combinedValue,
    },
  });

  return { h1Value, h2Value, combinedValue, saved: true };
}

export function registerHourlySnapshotRoute(app: Express): void {
  app.post("/api/scheduled/hourly-snapshot", async (req: Request, res: Response) => {
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

      const result = await runHourlySnapshot(targetUserId);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[HourlySnapshot] Error:", err);
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
}
