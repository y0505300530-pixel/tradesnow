/**
 * sectorConfig router — sector heatmap + sector metadata
 *
 * Manages sector metadata and LMT slippage per position.
 * Paper-lab procedures (getSectorPerformance, toggle, addTicker) removed in Phase 2.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { sectorConfig, userAssets, paperPositions } from "../../drizzle/schema";
import { eq, and } from "drizzle-orm";

export const sectorConfigRouter = {
  /** Get all sectors for the current user */
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
    const sectors = await db
      .select()
      .from(sectorConfig)
      .where(eq(sectorConfig.userId, ctx.user.id))
      .orderBy(sectorConfig.displayOrder);
    return sectors;
  }),

  /** Update LMT slippage percentage for a specific position */
  updateLmtSlippage: protectedProcedure
    .input(z.object({
      positionId: z.number(),
      lmtSlippagePct: z.number().min(0.5).max(20),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await db
        .update(paperPositions)
        .set({ lmtSlippagePct: input.lmtSlippagePct })
        .where(and(
          eq(paperPositions.id, input.positionId),
          eq(paperPositions.userId, ctx.user.id)
        ));
      return { success: true };
    }),

  /** Sector heatmap for Overview page — H1, H2 USA, H2 TASE */
  getHoldingSectorHeatmap: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
    const { portfolioHoldings, holding2: holding2Table } = await import("../../drizzle/schema");

    // Fetch all holdings
    const [h1Rows, h2Rows, assetRows] = await Promise.all([
      db.select({
        ticker: portfolioHoldings.ticker,
        units: portfolioHoldings.units,
        buyPrice: portfolioHoldings.buyPrice,
        currentPrice: portfolioHoldings.currentPrice,
        dailyChangePercent: portfolioHoldings.dailyChangePercent,
      }).from(portfolioHoldings).where(eq(portfolioHoldings.userId, ctx.user.id)),
      db.select({
        ticker: holding2Table.ticker,
        units: holding2Table.units,
        buyPrice: holding2Table.buyPrice,
        currentPrice: holding2Table.currentPrice,
        dailyChangePercent: holding2Table.dailyChangePercent,
      }).from(holding2Table).where(eq(holding2Table.userId, ctx.user.id)),
      db.select({
        ticker: userAssets.ticker,
        sector: userAssets.sector,
      }).from(userAssets).where(eq(userAssets.userId, ctx.user.id)),
    ]);

    // Build ticker → sector map from userAssets catalogue
    const tickerSectorMap = new Map<string, string>();
    for (const a of assetRows) {
      tickerSectorMap.set(a.ticker.toUpperCase(), a.sector);
    }

    // Helper: compute sector metrics for a group of holdings
    function computeSectorMetrics(holdings: Array<{ ticker: string; units: number; buyPrice: number; currentPrice: number | null; dailyChangePercent: number | null }>) {
      const sectorData = new Map<string, { totalPnl: number; totalValue: number; dailyPnlSum: number; count: number }>();
      for (const h of holdings) {
        if (h.units === 0) continue;
        const ticker = h.ticker.toUpperCase();
        // TASE tickers always get "TASE" sector
        const sector = ticker.endsWith(".TA") ? "TASE" : (tickerSectorMap.get(ticker) ?? "Other");
        const price = h.currentPrice ?? h.buyPrice;
        const value = price * h.units;
        const cost = h.buyPrice * h.units;
        const pnl = value - cost;
        const dailyPct = h.dailyChangePercent ?? 0;

        const existing = sectorData.get(sector) ?? { totalPnl: 0, totalValue: 0, dailyPnlSum: 0, count: 0 };
        existing.totalPnl += pnl;
        existing.totalValue += value;
        existing.dailyPnlSum += dailyPct;
        existing.count += 1;
        sectorData.set(sector, existing);
      }

      return Array.from(sectorData.entries())
        .map(([sector, data]) => ({
          sector,
          totalPnl: Math.round(data.totalPnl * 100) / 100,
          totalValue: Math.round(data.totalValue * 100) / 100,
          avgDailyPct: data.count > 0 ? Math.round((data.dailyPnlSum / data.count) * 100) / 100 : 0,
          positionCount: data.count,
        }))
        .sort((a, b) => b.totalValue - a.totalValue);
    }

    // Split H2 into USA and TASE
    const h2Usa = h2Rows.filter(h => !h.ticker.toUpperCase().endsWith(".TA"));
    const h2Tase = h2Rows.filter(h => h.ticker.toUpperCase().endsWith(".TA"));

    // Filter out zero-unit holdings
    const h1Active = h1Rows.filter(h => h.units !== 0);

    return {
      h1: computeSectorMetrics(h1Active),
      h2Usa: computeSectorMetrics(h2Usa),
      h2Tase: computeSectorMetrics(h2Tase),
    };
  }),
};
