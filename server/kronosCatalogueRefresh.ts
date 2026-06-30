/**
 * Background Kronos refresh for catalogue tickers (max N per cycle).
 * Does NOT block Elsa — only updates kronosBias fields on userAssets.
 */
import { and, eq } from "drizzle-orm";
import { getDb, updateUserAssetScore } from "./db";
import { userAssets } from "../drizzle/schema";
import {
  computeCompositeScore,
  isKronosEligible,
  isKronosStale,
  scoreWithKronos,
} from "./kronosEngine";

const MAX_PER_CYCLE = 2;
const MIN_ZIV_FOR_KRONOS = 6.5;

export async function refreshKronosCatalogueBatch(ownerUserId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  const rows = await db
    .select({
      ticker: userAssets.ticker,
      score: userAssets.score,
      kronosScannedAt: userAssets.kronosScannedAt,
      hotSignal: userAssets.hotSignal,
    })
    .from(userAssets)
    .where(and(eq(userAssets.userId, ownerUserId), eq(userAssets.archived, 0)));

  const candidates = rows
    .filter((r) => {
      const score = r.score ?? 0;
      if (score < MIN_ZIV_FOR_KRONOS) return false;
      if (!isKronosEligible(r.ticker)) return false;
      if (!isKronosStale(r.kronosScannedAt)) return false;
      return true;
    })
    .sort((a, b) => {
      const hotA = a.hotSignal === 1 ? 1 : 0;
      const hotB = b.hotSignal === 1 ? 1 : 0;
      if (hotB !== hotA) return hotB - hotA;
      return (b.score ?? 0) - (a.score ?? 0);
    })
    .slice(0, MAX_PER_CYCLE);

  if (candidates.length === 0) return 0;

  let updated = 0;
  for (const c of candidates) {
    const ziv = c.score ?? 0;
    try {
      const result = await scoreWithKronos(c.ticker, ziv);
      if (!result) continue;

      const composite = computeCompositeScore(ziv, result.bias);
      const now = new Date();

      // Update all users who hold this ticker in catalogue
      const holders = await db
        .select({ userId: userAssets.userId })
        .from(userAssets)
        .where(eq(userAssets.ticker, c.ticker.toUpperCase()));

      for (const h of holders) {
        await updateUserAssetScore(h.userId, c.ticker, ziv, undefined, {
          kronosBias: result.bias,
          kronosDirection: result.forecast.direction,
          kronosBandPct: result.forecast.bandWidthPct,
          kronosPredPct: result.forecast.pctChange,
          kronosScannedAt: now,
        });
      }

      console.log(
        `[KronosCatalogue] ${c.ticker}: Ziv ${ziv.toFixed(1)} → composite ${composite.toFixed(1)} ` +
        `(${result.forecast.direction}, bias ${result.bias >= 0 ? "+" : ""}${result.bias.toFixed(2)})`,
      );
      updated++;
    } catch (e: any) {
      console.warn(`[KronosCatalogue] ${c.ticker} failed:`, e.message);
    }
  }

  return updated;
}
