/**
 * Snooze Router — 12-hour Snooze/Ignore for War Room candidates (BUG #2).
 *
 * A snooze suppresses a ticker from ENTRY scoring and from War Room candidate VISIBILITY
 * until `snoozedUntil` (unix-epoch ms) passes. It does NOT touch a held position: if a
 * snoozed ticker is currently held, the engine still fully manages its exit (SL/TP/Golden/
 * never-naked). See getActiveSnoozedTickerSet — the single source of truth used by the engine.
 */
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { snoozedTickers } from "../../drizzle/schema";
import { and, eq, gt } from "drizzle-orm";

const DEFAULT_SNOOZE_HOURS = 12;

/**
 * SSOT — the set of UPPER-CASE tickers a user has an ACTIVE snooze on (snoozedUntil > now).
 * Reused by warEngine (entry gating) and liveEngine (candidate payload) so the "active snooze"
 * predicate lives in exactly one place. Returns an empty set on any DB failure (fail-open for
 * VISIBILITY only — never blocks exit management, which never consults this).
 */
export async function getActiveSnoozedTickerSet(userId: number, now: number = Date.now()): Promise<Set<string>> {
  try {
    const db = await getDb();
    if (!db) return new Set();
    const rows = await db
      .select({ ticker: snoozedTickers.ticker })
      .from(snoozedTickers)
      .where(and(eq(snoozedTickers.userId, userId), gt(snoozedTickers.snoozedUntil, now)));
    return new Set(rows.map((r) => r.ticker.toUpperCase()));
  } catch {
    return new Set();
  }
}

export const snoozeRouter = router({
  // Snooze a ticker for `hours` (default 12). Upserts snoozedUntil = now + hours*3600_000.
  snooze: protectedProcedure
    .input(z.object({
      ticker: z.string().min(1).max(16),
      hours: z.number().positive().max(720).default(DEFAULT_SNOOZE_HOURS),
      reason: z.string().max(255).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const userId = ctx.user.id;
      const ticker = input.ticker.toUpperCase();
      const snoozedUntil = Date.now() + input.hours * 3_600_000;
      await db.insert(snoozedTickers)
        .values({ userId, ticker, snoozedUntil, reason: input.reason ?? null })
        .onDuplicateKeyUpdate({ set: { snoozedUntil, reason: input.reason ?? null } });
      return { ticker, snoozedUntil, hours: input.hours };
    }),

  // List ACTIVE snoozes (snoozedUntil > now) for the current user.
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const now = Date.now();
    const rows = await db
      .select()
      .from(snoozedTickers)
      .where(and(eq(snoozedTickers.userId, ctx.user.id), gt(snoozedTickers.snoozedUntil, now)));
    return rows.map((r) => ({
      ticker: r.ticker,
      snoozedUntil: r.snoozedUntil,
      reason: r.reason,
      createdAt: r.createdAt,
    }));
  }),

  // Remove a snooze immediately (the ticker becomes scoreable/visible again next cycle).
  unsnooze: protectedProcedure
    .input(z.object({ ticker: z.string().min(1).max(16) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const ticker = input.ticker.toUpperCase();
      await db.delete(snoozedTickers)
        .where(and(eq(snoozedTickers.userId, ctx.user.id), eq(snoozedTickers.ticker, ticker)));
      return { ticker, unsnoozed: true };
    }),
});
