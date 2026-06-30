/**
 * liveZivHEnrichment.ts — ZIV H scores for open IBKR / livePositions rows
 * Used by liveEngine.getStatus (War Room Live).
 */
import { eq, and, inArray } from "drizzle-orm";
import { livePositions, userAssets } from "../drizzle/schema";
import type { getDb } from "./db";
import { fetchBarsBatch } from "./marketData";
import { calcZivHScore, type ZivHScoreResult } from "./zivEngine";

export interface LiveZivHFields {
  zivHScore: number | null;
  zivHTier: string | null;
  zivHPhase: string | null;
  zivHSuggestedAction: string | null;
  zivHSlDistance: number | null;
  zivHDetails: string | null;
  zivHEngineScore: number | null;
  zivH: ZivHScoreResult | null;
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { ts: number; byTicker: Map<string, LiveZivHFields> }>();

function emptyFields(engineScore: number | null = null): LiveZivHFields {
  return {
    zivHScore: null,
    zivHTier: null,
    zivHPhase: null,
    zivHSuggestedAction: null,
    zivHSlDistance: null,
    zivHDetails: null,
    zivHEngineScore: engineScore,
    zivH: null,
  };
}

function toFields(zivH: ZivHScoreResult, engineScore: number | null): LiveZivHFields {
  return {
    zivHScore: zivH.score,
    zivHTier: zivH.tier,
    zivHPhase: zivH.phase,
    zivHSuggestedAction: zivH.suggestedAction,
    zivHSlDistance: zivH.indicators.slDistance,
    zivHDetails: zivH.details,
    zivHEngineScore: engineScore,
    zivH,
  };
}

/**
 * Attach live ZIV H metrics to each open position in-place.
 */
export async function enrichLivePositionsWithZivH(
  positions: any[],
  opts: { userId: number; totalPortfolioValue: number; db: Db; catalogScores?: Map<string, number | null> },
): Promise<void> {
  if (positions.length === 0) return;

  const cacheKey = String(opts.userId);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    for (const pos of positions) {
      const tk = String(pos.ticker ?? "").toUpperCase();
      const hit = cached.byTicker.get(tk);
      if (hit) Object.assign(pos, hit);
      else {
        const eng = opts.catalogScores?.get(tk) ?? pos.zivScore ?? null;
        Object.assign(pos, emptyFields(eng));
      }
    }
    return;
  }

  const tickers = [...new Set(positions.map((p) => String(p.ticker ?? "").toUpperCase()).filter(Boolean))];
  const dbRows = await opts.db
    .select()
    .from(livePositions)
    .where(and(
      eq(livePositions.userId, opts.userId),
      eq(livePositions.status, "open"),
      inArray(livePositions.ticker, tickers),
    ));
  const dbMap = new Map(dbRows.map((r) => [r.ticker.toUpperCase(), r]));

  const assetRows = await opts.db
    .select({ ticker: userAssets.ticker, score: userAssets.score, tier: userAssets.tier })
    .from(userAssets)
    .where(eq(userAssets.userId, opts.userId));
  const assetByTicker = new Map(assetRows.map((a) => [a.ticker.toUpperCase(), a]));
  const highestWatchlistZivScore = assetRows.reduce((max, a) => {
    const s = a.score != null ? Number(a.score) : 0;
    return s > max ? s : max;
  }, 0);

  const barsMap = await fetchBarsBatch([...tickers, "SPY"], 120);
  const spyBars = barsMap.get("SPY") ?? [];
  const byTicker = new Map<string, LiveZivHFields>();

  for (const pos of positions) {
    const tk = String(pos.ticker ?? "").toUpperCase();
    const db = dbMap.get(tk);
    const asset = assetByTicker.get(tk);
    const engineScore = opts.catalogScores?.get(tk) ?? asset?.score ?? db?.zivScore ?? pos.zivScore ?? null;

    const entryPrice = Number(pos.entryPrice ?? db?.entryPrice ?? 0);
    const stopLoss = pos.currentSl != null ? Number(pos.currentSl) : (db?.currentSl ?? null);
    const takeProfit = pos.currentTp != null ? Number(pos.currentTp) : (db?.currentTp ?? null);
    const direction = (pos.direction ?? db?.direction ?? "long") as "long" | "short";
    const openedAt = pos.openedAt ?? db?.openedAt ?? null;
    const minutesInTrade = openedAt
      ? Math.floor((Date.now() - new Date(openedAt).getTime()) / 60_000)
      : 0;
    const daysHeld = openedAt
      ? Math.floor((Date.now() - new Date(openedAt).getTime()) / 86_400_000)
      : Math.floor(minutesInTrade / (60 * 24));

    const bars = barsMap.get(tk) ?? barsMap.get(pos.ticker) ?? [];
    const barClose = bars.length > 0 ? bars[bars.length - 1].close : null;
    const livePrice = Number(pos.currentPrice ?? barClose ?? entryPrice);
    const units = Number(pos.units ?? db?.units ?? 1);
    const positionValue = Number(pos.value ?? pos.allocatedCapital ?? livePrice * units);

    if (bars.length < 50 || entryPrice <= 0) {
      const fields = emptyFields(engineScore);
      byTicker.set(tk, fields);
      Object.assign(pos, fields);
      if (db && !pos.openedAt) pos.openedAt = db.openedAt;
      continue;
    }

    const zivH = calcZivHScore(bars, entryPrice, stopLoss, takeProfit, {
      totalPortfolioValue: opts.totalPortfolioValue,
      positionValue,
      daysHeld,
      spyBars,
      minutesInTrade,
      direction,
      ibkrUnrealizedPnl: pos.unrealizedPnl ?? db?.unrealizedPnl ?? null,
      buyScore: db?.zivScore ?? null,
      currentEngineScore: engineScore,
      highestWatchlistZivScore,
      entryTier: asset?.tier ?? null,
      peakPrice: db?.peakPrice ?? null,
      graceStartTime: null,
      spyDayStartPrice: null,
      spyCurrentPrice: null,
    });

    const fields = toFields(zivH, engineScore);
    byTicker.set(tk, fields);
    Object.assign(pos, fields);
    if (db && !pos.openedAt) pos.openedAt = db.openedAt;
  }

  cache.set(cacheKey, { ts: Date.now(), byTicker });
}

export function invalidateLiveZivHCache(userId: number): void {
  cache.delete(String(userId));
}
