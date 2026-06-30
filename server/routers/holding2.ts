/**
 * holding2 router — second manual portfolio (no IBKR sync).
 * User manages tickers, units, and buy price manually.
 * Live prices are fetched from Yahoo Finance on demand.
 *
 * IMPORTANT: All prices stored in DB are in USD.
 * Israeli stocks (.TA suffix) are quoted in ILA (Agorot) by Yahoo Finance.
 * We convert: ILA → ILS (÷100) → USD (÷ USD/ILS rate) before storing.
 * The buyPrice entered by the user for .TA stocks is also in Agorot — same conversion applied.
 */
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb, upsertHoldingAlert, deleteAllAlertsForTicker } from "../db";
import { holding2 } from "../../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { fetchLivePrice, fetchIbkrLivePricesBatch, fetchBarsForTicker, getUsdIlsRate } from "../marketData";
import { calcZivEngineScore } from "../zivEngine";
import { calcSlTp } from "../slCalculator";

/** Returns true if the ticker is an Israeli stock (TASE). */
function isIsraeliTicker(ticker: string): boolean {
  return ticker.toUpperCase().endsWith(".TA");
}

/**
 * Convert a user-entered buy price to USD.
 * For Israeli stocks the user enters in Agorot (same unit as Yahoo Finance).
 * For all others, assume USD.
 */
async function buyPriceToUsd(ticker: string, price: number): Promise<number> {
  if (isIsraeliTicker(ticker)) {
    const rate = await getUsdIlsRate();
    return (price / 100) / rate;
  }
  return price;
}

export const holding2Router = router({
  // ── List all holdings for the current user ──────────────────────────────
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const rows = await db
      .select()
      .from(holding2)
      .where(eq(holding2.userId, ctx.user.id));
    return rows;
  }),

  // ── Add a new holding ────────────────────────────────────────────────────
  add: protectedProcedure
    .input(z.object({
      ticker: z.string().min(1).max(16).toUpperCase(),
      company: z.string().optional(),
      buyPrice: z.number().positive().optional(),   // user enters in native currency (Agorot for .TA)
      buyPriceUsd: z.number().positive().optional(), // already-converted USD — skip conversion
      units: z.number().positive(),
      notes: z.string().optional(),
    }).refine(d => d.buyPrice != null || d.buyPriceUsd != null, { message: "buyPrice or buyPriceUsd required" }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      // Convert buy price to USD before storing
      const buyPriceUsd = input.buyPriceUsd ?? await buyPriceToUsd(input.ticker, input.buyPrice!);

      // Fetch live price immediately (fetchLivePrice already returns USD)
      let currentPrice: number | null = null;
      let prevClose: number | null = null;
      let dailyChangePercent: number | null = null;
      try {
        const live = await fetchLivePrice(input.ticker);
        if (live) {
          currentPrice = live.price;
          dailyChangePercent = live.changePercent ?? null;
          const pc = live.price - (live.change ?? 0);
          prevClose = pc > 0 ? pc : null;
        }
      } catch { /* ignore */ }

      const [result] = await db.insert(holding2).values({
        userId: ctx.user.id,
        ticker: input.ticker,
        company: input.company ?? null,
        buyPrice: buyPriceUsd,
        units: input.units,
        notes: input.notes ?? null,
        currentPrice,
        prevClose,
        dailyChangePercent,
        priceUpdatedAt: currentPrice ? new Date() : null,
      });
      const insertedId = (result as any).insertId;

      // Auto-create SL/TP alerts from Ziv Engine (non-blocking)
      try {
        const bars = await fetchBarsForTicker(input.ticker);
        if (bars.length >= 50) {
          const ziv = calcZivEngineScore(bars);
          const { stopLoss, takeProfit } = calcSlTp(buyPriceUsd, ziv.ema50);
          await upsertHoldingAlert(ctx.user.id, input.ticker, "sl", stopLoss);
          await upsertHoldingAlert(ctx.user.id, input.ticker, "tp", takeProfit);
          // Also persist SL/TP back to the holding row
          await db.update(holding2)
            .set({ stopLoss, takeProfit } as any)
            .where(eq(holding2.id, insertedId));
        }
      } catch { /* non-blocking */ }

      return { id: insertedId };
    }),

  // ── Update a holding (units, buyPrice, notes) ────────────────────────────
  update: protectedProcedure
    .input(z.object({
      id: z.number(),
      ticker: z.string().min(1).max(16).toUpperCase().optional(), // allow ticker rename
      buyPrice: z.number().positive().optional(),   // native currency (Agorot for .TA)
      buyPriceUsd: z.number().positive().optional(), // already-converted USD value (skip conversion)
      units: z.number().positive().optional(),
      company: z.string().optional(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      const { id, buyPrice, buyPriceUsd: buyPriceUsdDirect, ticker: newTicker, ...rest } = input;
      let buyPriceUsd: number | undefined;

      if (buyPriceUsdDirect != null) {
        // Client already has USD value (e.g. editing existing row) — use directly
        buyPriceUsd = buyPriceUsdDirect;
      } else if (buyPrice != null) {
        // Look up the ticker so we know whether to convert
        const [existing] = await db
          .select({ ticker: holding2.ticker })
          .from(holding2)
          .where(and(eq(holding2.id, input.id), eq(holding2.userId, ctx.user.id)));
        if (existing) {
          buyPriceUsd = await buyPriceToUsd(existing.ticker, buyPrice);
        }
      }

      await db
        .update(holding2)
        .set({ 
          ...rest, 
          ...(newTicker != null ? { ticker: newTicker } : {}),
          ...(buyPriceUsd != null ? { buyPrice: buyPriceUsd } : {}),
        })
        .where(and(eq(holding2.id, id), eq(holding2.userId, ctx.user.id)));
      return { ok: true };
    }),

  // ── Remove a holding ─────────────────────────────────────────────────────
  remove: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      // Fetch ticker before deleting so we can clean up alerts
      const [row] = await db
        .select({ ticker: holding2.ticker })
        .from(holding2)
        .where(and(eq(holding2.id, input.id), eq(holding2.userId, ctx.user.id)))
        .limit(1);
      await db
        .delete(holding2)
        .where(and(eq(holding2.id, input.id), eq(holding2.userId, ctx.user.id)));
      // Delete all active alerts for this ticker (non-blocking)
      if (row?.ticker) {
        await deleteAllAlertsForTicker(ctx.user.id, row.ticker).catch(() => {});
      }
      return { ok: true };
    }),

  // ── Refresh live prices for all holdings ─────────────────────────────────
  refreshPrices: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { updated: [] };

    const rows = await db
      .select()
      .from(holding2)
      .where(eq(holding2.userId, ctx.user.id));

    if (rows.length === 0) return { updated: [] };

    // Use IBKR batch fetch — same source as getLivePrices and refreshPrices in portfolio.ts
    const tickers = rows.map(r => r.ticker);
    const priceMap = await fetchIbkrLivePricesBatch(tickers);

    const updated: string[] = [];
    for (const row of rows) {
      try {
        const live = priceMap.get(row.ticker) ?? priceMap.get(row.ticker.toUpperCase());
        if (!live) continue;
        const prevClose = live.prevClose ?? (live.price - (live.change ?? 0));
        await db
          .update(holding2)
          .set({
            currentPrice: live.price,
            prevClose: prevClose > 0 ? prevClose : null,
            dailyChangePercent: live.changePercent ?? null,
            priceUpdatedAt: new Date(),
          })
          .where(eq(holding2.id, row.id));
        updated.push(row.ticker);
      } catch { /* skip */ }
    }
    return { updated };
  }),

  // ── Persist IBKR live prices from frontend to DB ──────────────────────────
  // Called by usePortfolioAnalytics when IBKR returns fresh quotes.
  // This ensures H2 prices survive IBKR session drops / page reloads.
  updateCurrentPrices: protectedProcedure
    .input(z.object({
      prices: z.array(z.object({
        ticker: z.string(),
        price: z.number(),
        prevClose: z.number().nullable(),
        changePercent: z.number().nullable(),
      })),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { updated: [] };
      const updated: string[] = [];
      for (const p of input.prices) {
        try {
          const result = await db
            .update(holding2)
            .set({
              currentPrice: p.price,
              prevClose: p.prevClose,
              dailyChangePercent: p.changePercent,
              priceUpdatedAt: new Date(),
            })
            .where(
              and(
                eq(holding2.userId, ctx.user.id),
                eq(holding2.ticker, p.ticker)
              )
            );
          if ((result as any)?.[0]?.affectedRows > 0 || (result as any)?.rowsAffected > 0) {
            updated.push(p.ticker);
          }
        } catch { /* skip individual failures */ }
      }
      return { updated };
    }),

  // ── Fix existing .TA rows that have agorot stored as buyPrice/currentPrice ──
  fixIsraeliPrices: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { fixed: [] };

    const rows = await db
      .select()
      .from(holding2)
      .where(eq(holding2.userId, ctx.user.id));

    const rate = await getUsdIlsRate();
    const fixed: string[] = [];

    for (const row of rows) {
      if (!isIsraeliTicker(row.ticker)) continue;
      // Heuristic: if buyPrice > 50 it's almost certainly still in Agorot (USD price would be tiny)
      if (row.buyPrice > 50) {
        const newBuyPrice = (row.buyPrice / 100) / rate;
        const newCurrentPrice = row.currentPrice != null && row.currentPrice > 50
          ? (row.currentPrice / 100) / rate
          : row.currentPrice;
        await db
          .update(holding2)
          .set({ buyPrice: newBuyPrice, currentPrice: newCurrentPrice })
          .where(eq(holding2.id, row.id));
        fixed.push(row.ticker);
      }
    }
    return { fixed };
  }),
});
