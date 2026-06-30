/**
 * analyzePosition.ts — Analyze Position Endpoint for War Room
 *
 * GET /api/paper/analyze-position/:id
 * Returns a split-panel comparison:
 *   Left:  Frozen Point-in-Time Entry Snapshot (from DB)
 *   Right: Live indicator snapshot (computed on the fly)
 *
 * Admin-only. Used by the War Room "Analyze" button next to each active position.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { paperPositions } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { fetchBarsForTicker, fetchLivePrice, getUsdIlsRate } from "../marketData";
import { normalizeBarsForTicker } from "../services/PriceService";
import { computeIndicatorSnapshot } from "../utils/indicatorSnapshot";
import { calcZivEngineScore, calcZivHScore } from "../zivEngine";

export const analyzePositionRouter = {
  /**
   * Analyze a single open position — returns entry snapshot + live indicators.
   */
  analyzePosition: protectedProcedure
    .input(z.object({ positionId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      // 1. Load position from DB
      const [pos] = await db
        .select()
        .from(paperPositions)
        .where(eq(paperPositions.id, input.positionId))
        .limit(1);

      if (!pos) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Position ${input.positionId} not found` });
      }

      // 2. Build entry snapshot from stored DB fields
      const entrySnapshot = {
        ticker: pos.ticker,
        signal: pos.signal,
        entryPrice: pos.entryPrice,
        openedAt: pos.openedAt?.toISOString() ?? null,
        zivScore: pos.zivScore,
        initialSl: pos.initialSl,
        initialTp: pos.initialTp,
        currentSl: pos.currentSl,
        currentTp: pos.currentTp,
        allocatedCapital: pos.allocatedCapital,
        units: pos.units,
        // Point-in-Time indicators (frozen at entry)
        rsiAtEntry: (pos as any).rsiAtEntry ?? null,
        atr14AtEntry: (pos as any).atr14AtEntry ?? null,
        ema50AtEntry: (pos as any).ema50AtEntry ?? null,
        distFromEma20AtEntryPct: (pos as any).distFromEma20AtEntryPct ?? null,
        relativeVolumeAtEntry: (pos as any).relativeVolumeAtEntry ?? null,
        ema50SlopeAtEntry: (pos as any).ema50SlopeAtEntry ?? null,
        equityAtEntry: (pos as any).equityAtEntry ?? null,
      };

      // 3. Compute live snapshot
      let liveSnapshot: {
        currentPrice: number;
        rsi14: number;
        atr14: number | null;
        ema20: number | null;
        ema50: number | null;
        ema50Slope: number | null;
        distFromEma20Pct: number | null;
        relativeVolume: number | null;
        zivScore: number | null;
        zivTier: string | null;
        zivHScore: number | null;
        zivHTier: string | null;
        zivHAction: string | null;
        unrealizedPnl: number;
        unrealizedPnlPct: number;
      } | null = null;

      try {
        const isTase = pos.ticker.toUpperCase().endsWith(".TA");
        let bars = await fetchBarsForTicker(pos.ticker, 120);

        // Normalize .TA bars from agorot to USD via PriceService canonical rule
        if (isTase && bars.length > 0) {
          const ilsRate = await getUsdIlsRate().catch(() => 3.6);
          bars = normalizeBarsForTicker(bars, pos.ticker, ilsRate);
        }

        // Live price — fetchLivePrice already returns USD for all tickers
        // (handles ILA→ILS→USD conversion internally). No additional conversion needed.
        const livePrice = await fetchLivePrice(pos.ticker).catch(() => null);
        const currentPrice = livePrice?.price ?? bars[bars.length - 1]?.close ?? pos.currentPrice ?? pos.entryPrice;

        // Indicator snapshot
        const indicators = computeIndicatorSnapshot(bars, currentPrice);

        // Ziv Engine Score (entry-quality)
        let zivScore: number | null = null;
        let zivTier: string | null = null;
        if (bars.length >= 50) {
          const ziv = calcZivEngineScore(bars);
          zivScore = ziv.score;
          zivTier = ziv.tier;
        }

        // Ziv Health Score (holding-quality)
        let zivHScore: number | null = null;
        let zivHTier: string | null = null;
        let zivHAction: string | null = null;
        if (bars.length >= 50) {
          const minutesInTrade = pos.openedAt
            ? Math.floor((Date.now() - new Date(pos.openedAt).getTime()) / 60000)
            : 999;
          const zivH = calcZivHScore(bars, pos.entryPrice, pos.currentSl, pos.currentTp, {
            minutesInTrade,
            graceStartTime: null,
            spyDayStartPrice: null,
            spyCurrentPrice: null,
          });
          zivHScore = zivH.score;
          zivHTier = zivH.tier;
          zivHAction = zivH.suggestedAction;
        }

        const unrealizedPnl = (currentPrice - pos.entryPrice) * pos.units;
        const unrealizedPnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

        liveSnapshot = {
          currentPrice,
          rsi14: indicators.rsi14,
          atr14: indicators.atr14,
          ema20: indicators.ema20,
          ema50: indicators.ema50,
          ema50Slope: indicators.ema50Slope,
          distFromEma20Pct: indicators.distFromEma20Pct,
          relativeVolume: indicators.relativeVolume,
          zivScore,
          zivTier,
          zivHScore,
          zivHTier,
          zivHAction,
          unrealizedPnl,
          unrealizedPnlPct,
        };
      } catch (err: any) {
        console.warn(`[AnalyzePosition] Failed to compute live snapshot for ${pos.ticker}:`, err.message);
      }

      return {
        positionId: pos.id,
        ticker: pos.ticker,
        status: pos.status,
        entrySnapshot,
        liveSnapshot,
      };
    }),
};
