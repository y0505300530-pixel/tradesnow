import { z } from "zod";
import { router, protectedProcedure, adminProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { agentInsights, mentorPatterns, analyses, channelVideos } from "../../drizzle/schema";
import { eq, desc, and, gte } from "drizzle-orm";
import { sql } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
//  Insights Router — Daily briefing, approval queue, mentor pattern library
// ─────────────────────────────────────────────────────────────────────────────

export const insightsRouter = router({

  /** List insights (pending by default, with optional date filter) */
  list: protectedProcedure
    .input(z.object({
      status: z.enum(["pending","approved","rejected","applied","all"]).default("pending"),
      days:   z.number().min(1).max(90).default(7),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { insights: [] };
      const cutoff = new Date(Date.now() - input.days * 86_400_000);
      const rows = await db
        .select()
        .from(agentInsights)
        .where(and(
          eq(agentInsights.userId, ctx.user.id),
          gte(agentInsights.createdAt, cutoff),
          ...(input.status !== "all" ? [eq(agentInsights.status, input.status)] : []),
        ))
        .orderBy(desc(agentInsights.createdAt))
        .limit(100);
      return { insights: rows };
    }),

  /** Approve an insight (optionally triggers code apply) */
  approve: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      await db.update(agentInsights)
        .set({ status: "approved", approvedAt: new Date() })
        .where(and(eq(agentInsights.id, input.id), eq(agentInsights.userId, ctx.user.id)));
      return { ok: true };
    }),

  /** Reject an insight */
  reject: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      await db.update(agentInsights)
        .set({ status: "rejected" })
        .where(and(eq(agentInsights.id, input.id), eq(agentInsights.userId, ctx.user.id)));
      return { ok: true };
    }),

  /** List learned patterns from mentor videos */
  listPatterns: protectedProcedure
    .input(z.object({
      mentor: z.enum(["cycles_trading","micha_stocks","both","all"]).default("all"),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { patterns: [] };
      const rows = await db
        .select()
        .from(mentorPatterns)
        .where(and(
          eq(mentorPatterns.userId, ctx.user.id),
          ...(input.mentor !== "all" ? [eq(mentorPatterns.mentor, input.mentor as "cycles_trading"|"micha_stocks"|"both")] : []),
        ))
        .orderBy(desc(mentorPatterns.occurrences))
        .limit(50);
      return { patterns: rows };
    }),

  /** Get summary stats for the insights dashboard */
  getSummaryStats: protectedProcedure
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) return { pending: 0, approved: 0, patterns: 0, lastRun: null };

      const [pending, approved, patterns, lastInsight] = await Promise.all([
        db.execute(sql`SELECT COUNT(*) as n FROM agentInsights WHERE userId=${ctx.user.id} AND status='pending'`),
        db.execute(sql`SELECT COUNT(*) as n FROM agentInsights WHERE userId=${ctx.user.id} AND status IN ('approved','applied') AND createdAt >= DATE_SUB(NOW(), INTERVAL 7 DAY)`),
        db.execute(sql`SELECT COUNT(*) as n FROM mentorPatterns WHERE userId=${ctx.user.id}`),
        db.select({ createdAt: agentInsights.createdAt })
          .from(agentInsights)
          .where(eq(agentInsights.userId, ctx.user.id))
          .orderBy(desc(agentInsights.createdAt))
          .limit(1),
      ]);

      return {
        pending:  Number((pending  as unknown as Array<{n:number}>)[0]?.n ?? 0),
        approved: Number((approved as unknown as Array<{n:number}>)[0]?.n ?? 0),
        patterns: Number((patterns as unknown as Array<{n:number}>)[0]?.n ?? 0),
        lastRun:  lastInsight[0]?.createdAt ?? null,
      };
    }),

  /** Trigger war engine cycle manually (admin-only; scan-only — no live orders) */
  runWarEngine: adminProcedure
    .mutation(async ({ ctx }) => {
      const { runWarEngineCycle } = await import("../warEngine");
      // scanOnly mirrors liveEngine.ts — manual trigger must NOT place live orders.
      const result = await runWarEngineCycle(ctx.user.id, { manual: true, scanOnly: true });
      return result;
    }),

  /** Get war engine status */
  getWarStatus: protectedProcedure
    .query(async () => {
      const { getWarEngineStatus } = await import("../warEngine");
      const baseStatus = getWarEngineStatus();
      // elzaRealizedPnl from liveTrades — elza source, closed trades
      try {
        const db2 = await getDb();
        if (db2) {
          const rows = await db2.execute(
            sql`SELECT COALESCE(SUM(pnl),0) as totalPnl FROM liveTrades WHERE source='elza' AND status='closed'`
          );
          const pnl = Number((rows as any)[0]?.totalPnl ?? 0);
          return { ...baseStatus, elzaRealizedPnl: pnl };
        }
      } catch {}
      return baseStatus;
    }),

  /** War Engine analysis for a single ticker — used in DeepAnalysisModal */
  getWarTickerAnalysis: protectedProcedure
    .input(z.object({ ticker: z.string().min(1).max(20) }))
    .query(async ({ ctx, input }) => {
      const { fetchBarsForTicker } = await import("../marketData");
      const { calcZivEngineScore } = await import("../zivEngine");
      const { calcBearScore } = await import("../shortEngine");
      const { calcMentorBoost } = await import("../mentorScoreBoost");
      const { getMarketRegime, getTickerIntelligence } = await import("../runtimeIntelligence");

      const ticker = input.ticker.toUpperCase();
      const isTase = ticker.endsWith(".TA");

      let ilsRate = 3.60;
      if (isTase) {
        try { const { getUsdIlsRate } = await import("../marketData"); ilsRate = await getUsdIlsRate(); } catch {}
      }

      const rawBars = await fetchBarsForTicker(ticker, 420);
      if (rawBars.length < 50) {
        return { ticker, finalScore: 0, baseScore: 0, mentorBonus: 0, regime: "NEUTRAL",
                 action: "SKIP" as const, reason: "Insufficient data", mentorReasons: [], confluence: 0, liquidity: 0, tier: null };
      }

      const { normalizeBarsForTicker } = await import("../services/PriceService");
      const bars = normalizeBarsForTicker(rawBars, ticker, ilsRate);

      const [ziv, bear, regime, intel] = await Promise.all([
        Promise.resolve(calcZivEngineScore(bars)),
        Promise.resolve(calcBearScore(bars)),
        getMarketRegime(),
        getTickerIntelligence(ticker, bars),
      ]);

      // Choose direction with higher score
      const isLong  = ziv.score >= bear.score;
      const baseScore = isLong ? ziv.score : bear.score;
      const signal    = isLong ? ziv.tier  : `BEAR_${bear.tier.toUpperCase().replace(/\s/g,"_")}`;

      const boost = await calcMentorBoost(ctx.user.id, ticker, signal, undefined);
      const finalScore = Math.min(10, baseScore + boost.bonus);

      // Determine action
      let action: "ENTER"|"ADD"|"HOLD"|"WATCH"|"EXIT"|"REDUCE"|"SKIP";
      let reason: string;

      if (finalScore >= 8.5 && intel.confluenceScore >= 5) {
        action = "ENTER"; reason = `ציון מצוין ${finalScore.toFixed(1)} + confluence ${intel.confluenceScore.toFixed(1)}`;
      } else if (finalScore >= 7 && regime.longOk && isLong) {
        action = isLong ? "ENTER" : "HOLD"; reason = `ציון ${finalScore.toFixed(1)}, regime ${regime.regime}`;
      } else if (finalScore >= 7 && !isLong && regime.shortOk) {
        action = "ENTER"; reason = `Bear score ${finalScore.toFixed(1)}, regime bearish`;
      } else if (finalScore >= 6) {
        action = "WATCH"; reason = `ציון ${finalScore.toFixed(1)} — ממתין לאישור`;
      } else if (finalScore < 4) {
        action = "EXIT"; reason = `ציון נמוך ${finalScore.toFixed(1)} — שקול יציאה`;
      } else {
        action = "SKIP"; reason = `ציון ${finalScore.toFixed(1)} — ניטרלי`;
      }

      return {
        ticker, finalScore, baseScore,
        mentorBonus: boost.bonus,
        mentorReasons: boost.reasons,
        regime: regime.regime,
        regimeReason: regime.regimeReason,
        action, reason,
        confluence: intel.confluenceScore,
        liquidity: intel.liquidityScore,
        tier: isLong ? ziv.tier : bear.tier,
        weeklyAligned: intel.weeklyAligned,
        isLong,
      };
    }),
});
