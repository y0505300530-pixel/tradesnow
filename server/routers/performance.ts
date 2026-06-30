/**
 * Performance Router — Portfolio P&L snapshots and performance chart data
 * Saves daily portfolio snapshots and returns historical performance data.
 */
import { z } from "zod";
import { positionValue } from "../services/PortfolioValueService";
import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import {
  upsertPortfolioSnapshot,
  getPortfolioSnapshots,
  getPortfolioHoldings,
  getPortfolioAccount,
} from "../db";

export const performanceRouter = router({
  // Get historical snapshots for the performance chart
  getSnapshots: protectedProcedure
    .input(z.object({ days: z.number().min(7).max(365).default(90) }))
    .query(async ({ ctx, input }) => {
      return getPortfolioSnapshots(ctx.user.id, input.days);
    }),

  // Save today's portfolio snapshot (called after refreshing prices)
  saveSnapshot: adminProcedure.mutation(async ({ ctx }) => {
    const holdings = await getPortfolioHoldings(ctx.user.id);
    const account = await getPortfolioAccount(ctx.user.id);

    if (holdings.length === 0) return { saved: false, reason: "No holdings" };

    // Calculate portfolio metrics
    let investedValue = 0;
    let totalCost = 0;
    const holdingsData: Array<{
      ticker: string;
      buyPrice: number;
      units: number;
      currentPrice: number | null;
      pnlUsd: number;
      pnlPct: number;
    }> = [];

    for (const h of holdings) {
      const currentPrice = h.currentPrice ?? h.buyPrice;
      const cost = h.buyPrice * h.units;
      const value = positionValue(currentPrice, h.units);
      const pnlUsd = value - cost;
      const pnlPct = cost > 0 ? (pnlUsd / cost) * 100 : 0;

      investedValue += value;
      totalCost += cost;
      holdingsData.push({
        ticker: h.ticker,
        buyPrice: h.buyPrice,
        units: h.units,
        currentPrice,
        pnlUsd,
        pnlPct,
      });
    }

    const cashBalance = account?.cashBalance ?? 0;
    const totalValue = investedValue + cashBalance;
    const pnlUsd = totalValue - totalCost - cashBalance; // only invested P&L
    const pnlPct = totalCost > 0 ? (pnlUsd / totalCost) * 100 : 0;

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    await upsertPortfolioSnapshot({
      userId: ctx.user.id,
      snapshotDate: today,
      totalValue,
      investedValue,
      cashBalance,
      totalCost,
      pnlUsd,
      pnlPct,
      holdingsSnapshot: JSON.stringify(holdingsData),
    });

    return { saved: true, date: today, totalValue, pnlUsd, pnlPct };
  }),

  // Get per-holding P&L data for individual position charts
  getHoldingPerformance: adminProcedure.query(async ({ ctx }) => {
    const holdings = await getPortfolioHoldings(ctx.user.id);

    return holdings.map(h => {
      const currentPrice = h.currentPrice ?? h.buyPrice;
      const cost = h.buyPrice * h.units;
      const value = positionValue(currentPrice, h.units);
      const pnlUsd = value - cost;
      const pnlPct = cost > 0 ? (pnlUsd / cost) * 100 : 0;
      const daysHeld = h.createdAt
        ? Math.floor((Date.now() - new Date(h.createdAt).getTime()) / (1000 * 60 * 60 * 24))
        : 0;

      return {
        ticker: h.ticker,
        company: h.company,
        buyPrice: h.buyPrice,
        currentPrice,
        units: h.units,
        cost,
        value,
        pnlUsd,
        pnlPct,
        daysHeld,
        stopLoss: h.stopLoss,
        takeProfit: h.takeProfit,
        zivScore: h.zivScore,
        createdAt: h.createdAt,
      };
    }).sort((a, b) => b.pnlPct - a.pnlPct); // best performers first
  }),
});
