/**
 * Hourly Snapshots Router — saves and retrieves hourly NLV snapshots for intraday chart (1D view)
 */
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { hourlySnapshots } from "../../drizzle/schema";
import { eq, and, gte } from "drizzle-orm";

export const hourlySnapshotsRouter = router({
  // Save an hourly snapshot (called from frontend every hour or on demand)
  save: protectedProcedure
    .input(z.object({
      h1Value: z.number().nullable().optional(),
      h2Value: z.number().nullable().optional(),
      combinedValue: z.number(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { saved: false, reason: "No DB" };

      // Round to nearest hour so we don't get duplicate entries
      const hourTs = Math.floor(Date.now() / (60 * 60 * 1000)) * (60 * 60 * 1000);

      await db.insert(hourlySnapshots).values({
        userId: ctx.user.id,
        snapshotTs: hourTs,
        h1Value: input.h1Value ?? null,
        h2Value: input.h2Value ?? null,
        combinedValue: input.combinedValue,
      }).onDuplicateKeyUpdate({
        set: {
          h1Value: input.h1Value ?? null,
          h2Value: input.h2Value ?? null,
          combinedValue: input.combinedValue,
        },
      });

      return { saved: true, snapshotTs: hourTs };
    }),

  // Get today's hourly snapshots for the 1D chart
  getToday: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startTs = startOfDay.getTime();

    const rows = await db
      .select()
      .from(hourlySnapshots)
      .where(
        and(
          eq(hourlySnapshots.userId, ctx.user.id),
          gte(hourlySnapshots.snapshotTs, startTs)
        )
      )
      .orderBy(hourlySnapshots.snapshotTs);

    return rows.map(r => ({
      ts: Number(r.snapshotTs),
      h1Value: r.h1Value,
      h2Value: r.h2Value,
      combinedValue: r.combinedValue,
    }));
  }),

  // Get last N days of hourly snapshots (for multi-day views)
  getRange: protectedProcedure
    .input(z.object({ days: z.number().min(1).max(30).default(7) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];

      const cutoffTs = Date.now() - input.days * 24 * 60 * 60 * 1000;

      const rows = await db
        .select()
        .from(hourlySnapshots)
        .where(
          and(
            eq(hourlySnapshots.userId, ctx.user.id),
            gte(hourlySnapshots.snapshotTs, cutoffTs)
          )
        )
        .orderBy(hourlySnapshots.snapshotTs);

      return rows.map(r => ({
        ts: Number(r.snapshotTs),
        h1Value: r.h1Value,
        h2Value: r.h2Value,
        combinedValue: r.combinedValue,
      }));
    }),
});
