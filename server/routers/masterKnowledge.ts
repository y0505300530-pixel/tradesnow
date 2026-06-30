import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { invokeLLM } from "../_core/llm";
import { getAllCompletedAnalysesByUser, getMasterKnowledgeByUser, getProficiencyMatrixByUser, upsertMasterKnowledge } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb, getUserByOpenId } from "../db";
import { eq, and, isNotNull } from "drizzle-orm";
import { tvWebhookSettings, userSettings } from "../../drizzle/schema";
import { sendTelegramMessage } from "../telegram";
import { createPriceAlert } from "../db";
import { ENV } from "../_core/env";
// Topics are now dynamic — extracted from video content, no fixed list

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TechnicalRule {
  topic: string;
  rule: string;       // ONE clear rule, e.g. "RSI > 70 = Overbought, consider exit"
  example: string;    // Concrete example from the videos
  level: number;      // 1-10 proficiency
  // Deep Research enrichment fields (populated by Boost to 10/10 feature)
  enrichedRule?: string;        // Institutional-grade rule from global research
  enrichedExample?: string;     // Professional example from whitepapers/institutions
  mentorAlignment?: {
    globalStandard: string;     // What the global/institutional standard says
    mentorTeaching: string;     // What Ziv/Micha teach
    isAligned: boolean;         // true = aligned, false = contradiction
    contradiction?: string;     // Description of the contradiction if any
  };
  isEnriched?: boolean;         // true after deep research has been applied
  enrichedAt?: string;          // ISO timestamp of last enrichment
}

export interface ActiveSignal {
  ticker: string;
  company: string;
  entry: string;      // e.g. "$185–$190"
  stopLoss: string;   // e.g. "$178"
  takeProfit: string; // e.g. "$205"
  catalyst: string;   // e.g. "Earnings beat + sector rotation"
  status: "watch" | "active" | "closed";
  source: string;     // video title
  signalDate?: string; // ISO date string of the video publish date / analysis date
}

export interface LearningStatus {
  topic: string;
  level: number;      // 1-10
  lastInsight: string;
}

export interface MasterKnowledgeData {
  Technical_Rules: TechnicalRule[];
  Active_Signals: ActiveSignal[];
  Learning_Status: LearningStatus[];
  generated_at: string;
  based_on_videos: number;
}

// ─── AI Prompt ────────────────────────────────────────────────────────────────

const MASTER_SYSTEM_PROMPT = `You are a professional trading analyst AI. You will receive trading data extracted from YouTube trading videos.
Your job is to produce a MASTER KNOWLEDGE JSON — the single source of truth for this trader.

The JSON must have EXACTLY these 3 objects:

1. Technical_Rules: For each of the 15 topics below, define ONE clear, actionable rule based on what was discussed in the videos.
   Topics: Extract topics dynamically from the video content and proficiency matrix provided
   Format: { "topic": "RSI", "rule": "RSI > 70 = Overbought — look for bearish divergence before shorting", "example": "NVDA RSI hit 78 before the $20 pullback discussed in video 3", "level": 7 }

2. Active_Signals: A clean list of every stock ticker mentioned with a clear trade setup.
   Format: { "ticker": "TSM", "company": "Taiwan Semiconductor", "entry": "$185–$190", "stopLoss": "$178", "takeProfit": "$205", "catalyst": "AI chip demand surge", "status": "watch", "source": "video title" }
   Status must be one of: "watch", "active", "closed"

3. Learning_Status: The proficiency level (1-10) for each topic in the provided proficiency matrix, with the key insight learned.
   Format: { "topic": "Gann Cycle Timing", "level": 6, "lastInsight": "90-day cycles used to predict reversal windows" }

Rules:
- Do NOT write general text. Every field must be specific and actionable.
- For Technical_Rules, only include topics that actually appear in the proficiency matrix or were discussed in the videos.
- For Active_Signals, only include tickers with at least an entry zone OR stop-loss mentioned.
- Return ONLY valid JSON. No markdown fences, no explanations outside the JSON.`;

// ─── Router ───────────────────────────────────────────────────────────────────

export const masterKnowledgeRouter = router({
  /** Get the current Master Knowledge JSON for the user */
  get: protectedProcedure.query(async ({ ctx }) => {
    const mk = await getMasterKnowledgeByUser(ctx.user.id);
    if (!mk) return null;
    try {
      return {
        Technical_Rules: mk.technicalRules ? (JSON.parse(mk.technicalRules) as TechnicalRule[]) : [],
        Active_Signals: mk.activeSignals ? (JSON.parse(mk.activeSignals) as ActiveSignal[]) : [],
        Learning_Status: mk.learningStatus ? (JSON.parse(mk.learningStatus) as LearningStatus[]) : [],
        updatedAt: mk.updatedAt,
      };
    } catch {
      return null;
    }
  }),

  /** Generate (or regenerate) the full Master Knowledge JSON from all completed analyses */
  generate: protectedProcedure.mutation(async ({ ctx }) => {
    const completedAnalyses = await getAllCompletedAnalysesByUser(ctx.user.id);
    if (completedAnalyses.length === 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "No completed analyses found. Analyze some YouTube videos first.",
      });
    }

    // Get current proficiency levels to seed Learning_Status
    const proficiencyRows = await getProficiencyMatrixByUser(ctx.user.id);
    const proficiencyMap = new Map(proficiencyRows.map((r) => [r.topic, r]));

    // Build analysis summaries
    const summaries = completedAnalyses
      .filter((a) => a.analysisResult)
      .map((a) => {
        try {
          const parsed = JSON.parse(a.analysisResult!);
          const rows = Array.isArray(parsed) ? parsed : (parsed.rows ?? []);
          if (rows.length === 0) return null;
          return {
            videoTitle: a.videoTitle ?? "Unknown Video",
            channelName: a.channelName ?? "Unknown Channel",
            date: a.createdAt.toISOString().split("T")[0],
            tickers: rows,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (summaries.length === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "No valid trading data found in your analyses." });
    }

    // Build proficiency context from all dynamic topics in DB
    const proficiencyContext = proficiencyRows.map((row) => {
      const log = row.updateLog ? JSON.parse(row.updateLog) as Array<{ insight: string }> : [];
      const lastInsight = log.length > 0 ? log[log.length - 1].insight : "Not yet covered";
      return { topic: row.topic, level: row.level, lastInsight };
    });

    const userContent = `Here are ${summaries.length} trading video analyses:\n\n${JSON.stringify(summaries, null, 2)}\n\nCurrent proficiency levels:\n${JSON.stringify(proficiencyContext, null, 2)}\n\nGenerate the Master Knowledge JSON. Set based_on_videos to ${summaries.length} and generated_at to "${new Date().toISOString()}".`;

    const response = await invokeLLM({
      messages: [
        { role: "system", content: MASTER_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    });

    const rawContent = response.choices?.[0]?.message?.content;
    const content = typeof rawContent === "string" ? rawContent.trim() : null;
    if (!content) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "AI returned empty response" });

    // Extract JSON from response (handles markdown fences)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "AI did not return valid JSON" });

    const data = JSON.parse(jsonMatch[0]) as MasterKnowledgeData;

    await upsertMasterKnowledge(ctx.user.id, {
      technicalRules: JSON.stringify(data.Technical_Rules ?? []),
      activeSignals: JSON.stringify(data.Active_Signals ?? []),
      learningStatus: JSON.stringify(data.Learning_Status ?? []),
    });

    return {
      Technical_Rules: data.Technical_Rules ?? [],
      Active_Signals: data.Active_Signals ?? [],
      Learning_Status: data.Learning_Status ?? [],
      updatedAt: new Date(),
    };
  }),

  /** Add or overwrite a single active signal (e.g. from Dip Analysis) */
  addSignal: protectedProcedure
    .input(z.object({
      ticker: z.string().min(1).max(16),
      company: z.string().optional(),
      entry: z.string(),
      stopLoss: z.string(),
      takeProfit: z.string(),
      catalyst: z.string().optional(),
      status: z.enum(["watch", "active", "closed"]).optional(),
      source: z.string().optional(),
      signalDate: z.string().optional(),
      zivScore: z.number().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const mk = await getMasterKnowledgeByUser(ctx.user.id);
      const signals: ActiveSignal[] = mk?.activeSignals ? JSON.parse(mk.activeSignals) : [];
      const ticker = input.ticker.toUpperCase();
      const idx = signals.findIndex((s) => s.ticker.toUpperCase() === ticker);
      const newSignal: ActiveSignal = {
        ticker,
        company: input.company ?? "",
        entry: input.entry,
        stopLoss: input.stopLoss,
        takeProfit: input.takeProfit,
        catalyst: input.catalyst ?? "Dip Analysis — Ziv Methodology",
        status: input.status ?? "watch",
        source: input.source ?? "Dip Analysis",
        signalDate: input.signalDate ?? new Date().toISOString().split("T")[0],
      };
      if (idx >= 0) {
        signals[idx] = newSignal;
      } else {
        signals.push(newSignal);
      }
      await upsertMasterKnowledge(ctx.user.id, { activeSignals: JSON.stringify(signals) });

      // ── Create Price Alert automatically ─────────────────────────────────
      let priceAlertId: number | null = null;
      try {
        // Parse entry price from string like "$110.05" or "$185-$190" (take lower bound)
        const entryStr = input.entry.replace(/[$,]/g, "");
        const entryMatch = entryStr.match(/([\d.]+)/);
        const entryPrice = entryMatch ? parseFloat(entryMatch[1]) : null;
        if (entryPrice && entryPrice > 0) {
          priceAlertId = await createPriceAlert({
            userId: ctx.user.id,
            ticker,
            alertType: "custom",
            targetPrice: entryPrice,
            direction: "below",
            label: `איתות כניסה — ${ticker}`,
          });
        }
      } catch (e) {
        console.warn("[addSignal] Price alert creation failed (non-fatal):", e);
      }

      // ── Fire Telegram notification (best-effort) ──────────────────────────
      let telegramSent = false;
      try {
        const action = idx >= 0 ? "עודכן" : "חדש";
        const scoreStr = input.zivScore !== undefined && input.zivScore !== null
          ? `⭐ <b>Ziv Score:</b> ${input.zivScore.toFixed(1)}/10`
          : "";
        const msg = [
          `🚀 <b>איתות קנייה ${action} — ${ticker}</b>`,
          `<b>כניסה:</b> ${input.entry}`,
          `🔴 <b>SL:</b> ${input.stopLoss}`,
          input.takeProfit ? `🟢 <b>TP:</b> ${input.takeProfit}` : "",
          scoreStr,
          input.catalyst ? `\n<i>${input.catalyst.slice(0, 200)}</i>` : "",
        ].filter(Boolean).join("\n");
        telegramSent = await sendTelegramMessage(msg);

        // Broadcast to all other Telegram-enabled users
        try {
          const dbInst = await getDb();
          if (dbInst) {
            let ownerUserId: number | null = null;
            if (ENV.ownerOpenId) {
              const ownerUser = await getUserByOpenId(ENV.ownerOpenId);
              ownerUserId = ownerUser?.id ?? null;
            }
            if (ownerUserId == null) ownerUserId = ctx.user.id;
            const allSettings = await dbInst
              .select({ userId: userSettings.userId, telegramChatId: userSettings.telegramChatId })
              .from(userSettings)
              .where(and(eq(userSettings.telegramEnabled, 1), isNotNull(userSettings.telegramChatId)));
            const bcChatIds = allSettings
              .filter(s => s.userId !== ownerUserId && s.telegramChatId)
              .map(s => s.telegramChatId!);
            for (const bcChatId of bcChatIds) {
              await sendTelegramMessage(msg, bcChatId);
            }
            if (bcChatIds.length > 0) {
              console.log(`[addSignal] 📢 Broadcast to ${bcChatIds.length} user(s)`);
            }
          }
        } catch (bcErr) {
          console.warn("[addSignal] Broadcast failed (non-fatal):", bcErr);
        }
      } catch (e) {
        console.warn("[addSignal] Telegram failed (non-fatal):", e);
      }

      // ── Fire TradingView webhook (best-effort) ────────────────────────────
      let tvSent = false;
      try {
        const db = await getDb();
        if (!db) throw new Error("DB unavailable");
        const [tvSettings] = await db
          .select()
          .from(tvWebhookSettings)
          .where(eq(tvWebhookSettings.userId, ctx.user.id))
          .limit(1);
        if (tvSettings?.webhookSecret) {
          const baseUrl = "https://trade-snow2.vip";
          const webhookUrl = `${baseUrl}/api/tradingview/webhook?secret=${tvSettings.webhookSecret}`;
          const payload = {
            ticker,
            action: "BUY_SIGNAL",
            entry: input.entry,
            stopLoss: input.stopLoss,
            takeProfit: input.takeProfit,
            source: input.source ?? "Deep Analysis",
            catalyst: input.catalyst ?? "",
            timestamp: new Date().toISOString(),
          };
          const res = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          tvSent = res.ok;
        }
      } catch (e) {
        console.warn("[addSignal] TV webhook failed (non-fatal):", e);
      }

      return { success: true, isUpdate: idx >= 0, tvSent, telegramSent, priceAlertId };
    }),

  updateSignal: protectedProcedure
    .input(z.object({
      ticker: z.string(),
      entry: z.string().optional(),
      stopLoss: z.string().optional(),
      takeProfit: z.string().optional(),
      catalyst: z.string().optional(),
      status: z.enum(["watch", "active", "closed"]).optional(),
      signalDate: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const mk = await getMasterKnowledgeByUser(ctx.user.id);
      const signals: ActiveSignal[] = mk?.activeSignals ? JSON.parse(mk.activeSignals) : [];
      const idx = signals.findIndex((s) => s.ticker.toUpperCase() === input.ticker.toUpperCase());
      if (idx === -1) throw new TRPCError({ code: "NOT_FOUND", message: "Signal not found" });
      signals[idx] = { ...signals[idx], ...input };
      await upsertMasterKnowledge(ctx.user.id, { activeSignals: JSON.stringify(signals) });
      return { success: true };
    }),

  /** Delete a single active signal by ticker */
  deleteSignal: protectedProcedure
    .input(z.object({ ticker: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const mk = await getMasterKnowledgeByUser(ctx.user.id);
      const signals: ActiveSignal[] = mk?.activeSignals ? JSON.parse(mk.activeSignals) : [];
      const filtered = signals.filter((s) => s.ticker.toUpperCase() !== input.ticker.toUpperCase());
      await upsertMasterKnowledge(ctx.user.id, { activeSignals: JSON.stringify(filtered) });
      return { deleted: signals.length - filtered.length };
    }),

  /** Send a signal to Trade Manager — runs a full scan and saves to tradePositions */
  sendToTradeManager: protectedProcedure
    .input(z.object({ ticker: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { scanAndSaveTrade } = await import("./tradeManager");
      const result = await scanAndSaveTrade(ctx.user.id, input.ticker);
      return result;
    }),

  /** Merge new signals from a single analysis into the existing Master JSON */
  mergeFromAnalysis: protectedProcedure
    .input(z.object({ analysisId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const { getAnalysisById } = await import("../db");
      const analysis = await getAnalysisById(input.analysisId);
      if (!analysis || !analysis.analysisResult) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Analysis not found" });
      }

      let newRows: Array<Record<string, string>> = [];
      try {
        const parsed = JSON.parse(analysis.analysisResult);
        newRows = Array.isArray(parsed) ? parsed : (parsed.rows ?? []);
      } catch {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to parse analysis result" });
      }

      // Get existing master knowledge
      const mk = await getMasterKnowledgeByUser(ctx.user.id);
      const existingSignals: ActiveSignal[] = mk?.activeSignals ? JSON.parse(mk.activeSignals) : [];

      // Merge new signals — update existing tickers, add new ones
      const signalMap = new Map(existingSignals.map((s) => [s.ticker.toUpperCase(), s]));

      for (const row of newRows) {
        const ticker = (row.ticker ?? "").toUpperCase();
        if (!ticker || ticker === "N/A" || ticker === "-") continue;

        const newSignal: ActiveSignal = {
          ticker,
          company: row.company ?? "",
          entry: row.entry_zone ?? row.entry ?? "—",
          stopLoss: row.stop_loss ?? row.stopLoss ?? "—",
          takeProfit: row.take_profit ?? row.takeProfit ?? "—",
          catalyst: row.catalyst ?? "—",
          status: "watch",
          source: analysis.videoTitle ?? "Unknown Video",
        };

        signalMap.set(ticker, newSignal);
      }

      const mergedSignals = Array.from(signalMap.values());

      await upsertMasterKnowledge(ctx.user.id, {
        activeSignals: JSON.stringify(mergedSignals),
      });

      return { mergedCount: newRows.length, totalSignals: mergedSignals.length };
    }),

  /**
   * Deep Research: Boost every Technical Rule to 10/10 proficiency.
   * Uses AI to research institutional-grade knowledge for each topic,
   * compares with mentor teachings, and flags contradictions.
   */
  deepResearch: protectedProcedure.mutation(async ({ ctx }) => {
    const mk = await getMasterKnowledgeByUser(ctx.user.id);
    if (!mk?.technicalRules) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "No Technical Rules found. Generate Master JSON first." });
    }

    const rules: TechnicalRule[] = JSON.parse(mk.technicalRules);
    if (rules.length === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Technical Rules list is empty." });
    }

    // Get mentor context from existing rules to use in alignment comparison
    const mentorContext = rules.map(r => `${r.topic}: ${r.rule} (example: ${r.example})`).join("\n");

    const DEEP_RESEARCH_PROMPT = `You are an elite institutional trading analyst with access to W.D. Gann's original manuscripts, CMT (Chartered Market Technician) curriculum, CFA Institute research, and professional trading whitepapers.

You will receive a list of trading topics. For EACH topic, you must:
1. Research the GLOBAL INSTITUTIONAL STANDARD for this topic (not just what retail traders know)
2. Provide an enriched, professional-grade rule at the level of a hedge fund analyst
3. Provide a concrete example from institutional/professional practice (NOT from the mentor videos)
4. Compare with what the mentors teach and identify any contradictions

For the mentorAlignment field:
- globalStandard: What the institutional/professional world says about this topic
- mentorTeaching: What the mentor videos teach about this topic
- isAligned: true if they agree, false if there is a meaningful contradiction
- contradiction: Only if isAligned=false, describe the specific difference

Return ONLY a valid JSON array. No markdown fences.

Format:
[
  {
    "topic": "RSI",
    "enrichedRule": "RSI divergence is more reliable than absolute overbought/oversold levels. Bearish divergence (price makes higher high, RSI makes lower high) signals institutional distribution. The 50-level acts as a trend filter — RSI above 50 = bull regime, below 50 = bear regime.",
    "enrichedExample": "J.Welles Wilder's original RSI research (1978) showed that 14-period RSI with divergence signals had a 68% win rate in trending markets. CMT Level 2 curriculum uses RSI 50 as the primary trend filter, not 70/30.",
    "mentorAlignment": {
      "globalStandard": "RSI 50 as trend filter; divergence as primary signal; 14-period standard",
      "mentorTeaching": "RSI 70/30 overbought/oversold levels for entry/exit signals",
      "isAligned": false,
      "contradiction": "Mentors use RSI 70/30 as primary signals, but institutional standard treats 70/30 as noise in strong trends. CMT curriculum emphasizes divergence and the 50-level as the true signal."
    }
  }
]`;

    const userContent = `Here are the trading topics to research at institutional level:\n\nCurrent mentor teachings for context:\n${mentorContext}\n\nTopics to enrich: ${rules.map(r => r.topic).join(", ")}\n\nProvide institutional-grade enrichment for ALL ${rules.length} topics.`;

    const response = await invokeLLM({
      messages: [
        { role: "system", content: DEEP_RESEARCH_PROMPT },
        { role: "user", content: userContent },
      ],
    });

    const rawContent = response.choices?.[0]?.message?.content;
    const content = typeof rawContent === "string" ? rawContent.trim() : null;
    if (!content) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "AI returned empty response" });

    // Extract JSON array from response
    const jsonMatch = content.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (!jsonMatch) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "AI did not return valid JSON array" });

    const enrichedData = JSON.parse(jsonMatch[0]) as Array<{
      topic: string;
      enrichedRule: string;
      enrichedExample: string;
      mentorAlignment: TechnicalRule["mentorAlignment"];
    }>;

    // Merge enrichment data into existing rules
    const enrichedAt = new Date().toISOString();
    const enrichedRules: TechnicalRule[] = rules.map(rule => {
      const enrichment = enrichedData.find(
        e => e.topic.toLowerCase().includes(rule.topic.toLowerCase()) ||
             rule.topic.toLowerCase().includes(e.topic.toLowerCase())
      );
      if (!enrichment) return rule;
      return {
        ...rule,
        level: 10, // Boost to 10/10
        enrichedRule: enrichment.enrichedRule,
        enrichedExample: enrichment.enrichedExample,
        mentorAlignment: enrichment.mentorAlignment,
        isEnriched: true,
        enrichedAt,
      };
    });

    // Save enriched rules back to DB
    await upsertMasterKnowledge(ctx.user.id, {
      technicalRules: JSON.stringify(enrichedRules),
    });

    // Also update proficiency matrix to 10 for all enriched topics
    const { bulkUpsertProficiency } = await import("../db");
    const proficiencyUpdates = enrichedRules
      .filter(r => r.isEnriched)
      .map(r => ({
        topic: r.topic,
        newLevel: 10,
        logEntry: {
          videoTitle: "[Institutional Deep Research]",
          insight: `${r.enrichedRule?.slice(0, 200) ?? r.rule}`,
          levelBefore: r.level < 10 ? r.level : 9,
          levelAfter: 10,
          date: enrichedAt,
        },
      }));
    if (proficiencyUpdates.length > 0) {
      await bulkUpsertProficiency(ctx.user.id, proficiencyUpdates);
    }

    const enrichedCount = enrichedRules.filter(r => r.isEnriched).length;
    const contradictions = enrichedRules.filter(r => r.mentorAlignment && !r.mentorAlignment.isAligned).length;

    return {
      enrichedCount,
      totalRules: rules.length,
      contradictions,
      rules: enrichedRules,
    };
  }),
});

// ─── Auto-regenerate helper (called from analyze.ts after each analysis) ────────

/**
 * Fully regenerates the Master Knowledge JSON from all completed analyses.
 * Runs in the background — non-blocking. Silently skips if no analyses exist.
 */
export async function autoRegenerateMasterKnowledge(userId: number): Promise<void> {
  try {
    const completedAnalyses = await getAllCompletedAnalysesByUser(userId);
    if (completedAnalyses.length === 0) return;

    const proficiencyRows = await getProficiencyMatrixByUser(userId);

    const summaries = completedAnalyses
      .filter((a) => a.analysisResult)
      .map((a) => {
        try {
          const parsed = JSON.parse(a.analysisResult!);
          const rows = Array.isArray(parsed) ? parsed : (parsed.rows ?? []);
          if (rows.length === 0) return null;
          return {
            videoTitle: a.videoTitle ?? "Unknown Video",
            channelName: a.channelName ?? "Unknown Channel",
            date: a.createdAt.toISOString().split("T")[0],
            tickers: rows,
          };
        } catch { return null; }
      })
      .filter(Boolean);

    if (summaries.length === 0) return;

    const proficiencyContext = proficiencyRows.map((row) => {
      const log = row.updateLog ? JSON.parse(row.updateLog) as Array<{ insight: string }> : [];
      const lastInsight = log.length > 0 ? log[log.length - 1].insight : "Not yet covered";
      return { topic: row.topic, level: row.level, lastInsight };
    });

    const userContent = `Here are ${summaries.length} trading video analyses:\n\n${JSON.stringify(summaries, null, 2)}\n\nCurrent proficiency levels:\n${JSON.stringify(proficiencyContext, null, 2)}\n\nGenerate the Master Knowledge JSON. Set based_on_videos to ${summaries.length} and generated_at to "${new Date().toISOString()}".`;

    const response = await invokeLLM({
      messages: [
        { role: "system", content: MASTER_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    });

    const rawContent = response.choices?.[0]?.message?.content;
    const content = typeof rawContent === "string" ? rawContent.trim() : null;
    if (!content) return;

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const data = JSON.parse(jsonMatch[0]) as MasterKnowledgeData;

    // Preserve signalDate from existing signals when regenerating
    const existingMk = await getMasterKnowledgeByUser(userId);
    const existingSignals: ActiveSignal[] = existingMk?.activeSignals ? JSON.parse(existingMk.activeSignals) : [];
    const existingDateMap = new Map(existingSignals.map((s) => [s.ticker.toUpperCase(), s.signalDate]));

    const newSignals = (data.Active_Signals ?? []).map((s) => ({
      ...s,
      signalDate: existingDateMap.get(s.ticker.toUpperCase()) ?? new Date().toISOString().split("T")[0],
    }));

    await upsertMasterKnowledge(userId, {
      technicalRules: JSON.stringify(data.Technical_Rules ?? []),
      activeSignals: JSON.stringify(newSignals),
      learningStatus: JSON.stringify(data.Learning_Status ?? []),
    });
    console.log(`[MasterKnowledge] Auto-regenerated for user ${userId} from ${summaries.length} analyses`);
  } catch (err) {
    console.error("[MasterKnowledge] Auto-regenerate failed:", err);
  }
}
