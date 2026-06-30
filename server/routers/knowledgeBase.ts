import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { invokeLLM } from "../_core/llm";
import {
  bulkUpsertProficiency,
  getAllCompletedAnalysesByUser,
  getKnowledgeBaseByUser,
  getProficiencyMatrixByUser,
  upsertKnowledgeBase,
} from "../db";
import { protectedProcedure, router } from "../_core/trpc";

// ─── Constants ────────────────────────────────────────────────────────────────

// Dynamic topics — no longer hardcoded. Topics are extracted from video content.
export type Topic = string;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TradingRow {
  ticker: string;
  company: string;
  strategy: string;
  entry_zone: string;
  stop_loss: string;
  catalyst: string;
  tradingview_alert: string;
  watchlist: string;
}

export interface ProficiencyUpdate {
  topic: string;           // dynamic topic title extracted from the video
  currentLevel: number;    // level BEFORE this video
  newLevel: number;        // level AFTER this video (1-10)
  insight: string;         // what was learned from this video about this topic
  knowledgeSummary: string; // 1-sentence summary of what this topic means in context of this methodology
}

export interface KnowledgeResult {
  trading_style: string;
  preferred_strategies: Array<{ name: string; description: string; frequency: string }>;
  top_tickers: Array<{ ticker: string; company: string; mentions: number; context: string }>;
  entry_patterns: string[];
  exit_and_risk_rules: string[];
  market_themes: Array<{ theme: string; description: string }>;
  key_levels_approach: string;
  overall_philosophy: string;
  generated_at: string;
  based_on_videos: number;
}

// ─── Proficiency AI Prompt ────────────────────────────────────────────────────

function buildProficiencyPrompt(currentMatrix: Record<string, number>): string {
  const existingTopics = Object.entries(currentMatrix)
    .map(([t, l]) => `  "${t}": ${l}/10`)
    .join("\n") || "  (none yet — this is the first video analyzed)";

  return `You are an AI trading analyst that builds a dynamic knowledge proficiency matrix from YouTube trading videos.

Your job is to EXTRACT real topics from the video content — do NOT use a fixed list. Topics should reflect the actual methodology, strategies, and concepts discussed in THIS specific video.

CURRENT KNOWLEDGE MATRIX (topics learned so far):
${existingTopics}

Instructions:
1. Read the video content carefully
2. Identify EVERY distinct trading concept, strategy, or methodology discussed
3. For each concept found:
   - Create a clear, specific topic title (e.g. "Gann Cycle Timing", "Kiss & Go Entry Pattern", "Weekly Low Stop-Loss Rule", "RSI Divergence on 15m")
   - If this topic already exists in the current matrix, UPDATE its level
   - If this is a NEW topic not in the matrix, ADD it with a starting level based on how deeply it was covered
   - Write a knowledgeSummary: a 1-sentence definition of this concept as taught in this methodology
   - Write an insight: what specifically was learned from THIS video about this topic

Rules:
- Levels range from 1 (novice) to 10 (expert)
- New topics start at level 2-4 depending on depth of coverage in the video
- Maximum increase per video for existing topics is +2
- Be SPECIFIC: "RSI" is too vague — use "RSI Overbought/Oversold Signals" or "RSI Divergence Detection"
- Topics must come from the actual video content — never invent topics not discussed
- At level 7+, insights must use advanced terminology specific to this analyst's methodology

Return a JSON object:
{
  "updates": [
    {
      "topic": "Gann Cycle Timing",
      "currentLevel": 0,
      "newLevel": 3,
      "knowledgeSummary": "A time-based cycle theory where market turns are predicted at specific intervals (e.g. 90, 180, 360 days) derived from W.D. Gann's work.",
      "insight": "The analyst uses 90-day Gann cycles to predict reversal windows, combining them with price action confirmation before entering."
    }
  ]
}

Only include topics actually discussed in the video. Use currentLevel: 0 for brand new topics.`;
}

// ─── Knowledge Base AI Prompt ─────────────────────────────────────────────────

const KNOWLEDGE_SYSTEM_PROMPT = `You are an expert trading analyst. You will be given a collection of trading analyses extracted from multiple YouTube videos. 
Your task is to synthesize all this information into a comprehensive trading knowledge base that describes the trading methodology, patterns, and philosophy observed across all videos.

Analyze the data and return a JSON object with the following structure:
{
  "trading_style": "A concise 2-3 sentence description of the overall trading style",
  "preferred_strategies": [
    {
      "name": "Strategy name",
      "description": "How this strategy is applied based on the videos",
      "frequency": "How often this strategy appears (Very Common / Common / Occasional)"
    }
  ],
  "top_tickers": [
    {
      "ticker": "TICKER",
      "company": "Company name",
      "mentions": 3,
      "context": "Why this ticker keeps appearing and what the general view on it is"
    }
  ],
  "entry_patterns": ["Specific entry pattern observed", "..."],
  "exit_and_risk_rules": ["Specific exit or risk management rule", "..."],
  "market_themes": [
    {
      "theme": "Theme name",
      "description": "Why this theme is relevant and how it is being played"
    }
  ],
  "key_levels_approach": "A paragraph describing how key price levels are identified and used",
  "overall_philosophy": "A 3-5 sentence summary of the overall trading philosophy",
  "generated_at": "ISO timestamp",
  "based_on_videos": 0
}

Be specific and concrete. Use actual tickers, price levels, and strategies mentioned in the data.`;

// ─── Router ───────────────────────────────────────────────────────────────────

export const knowledgeBaseRouter = router({
  /** Get the cached knowledge base for the current user */
  get: protectedProcedure.query(async ({ ctx }) => {
    const kb = await getKnowledgeBaseByUser(ctx.user.id);
    if (!kb || !kb.result) return null;
    return {
      result: JSON.parse(kb.result) as KnowledgeResult,
      analysisCount: kb.analysisCount,
      updatedAt: kb.updatedAt,
    };
  }),

  /** Generate (or regenerate) the knowledge base from all completed analyses */
  generate: protectedProcedure.mutation(async ({ ctx }) => {
    const completedAnalyses = await getAllCompletedAnalysesByUser(ctx.user.id);

    if (completedAnalyses.length === 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "No completed analyses found. Analyze some YouTube videos first.",
      });
    }

    const analysisSummaries = completedAnalyses
      .filter((a) => a.analysisResult)
      .map((a) => {
        let rows: TradingRow[] = [];
        try {
          const parsed = JSON.parse(a.analysisResult!);
          rows = Array.isArray(parsed) ? parsed : (parsed.rows ?? []);
        } catch {
          return null;
        }
        if (rows.length === 0) return null;
        return {
          videoTitle: a.videoTitle ?? "Unknown Video",
          channelName: a.channelName ?? "Unknown Channel",
          date: a.createdAt.toISOString().split("T")[0],
          tickers: rows,
        };
      })
      .filter(Boolean);

    if (analysisSummaries.length === 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "No valid trading data found in your analyses.",
      });
    }

    const userContent = `Here are the trading analyses from ${analysisSummaries.length} YouTube video(s):\n\n${JSON.stringify(analysisSummaries, null, 2)}\n\nSynthesize this into a comprehensive trading knowledge base. Set "based_on_videos" to ${analysisSummaries.length} and "generated_at" to "${new Date().toISOString()}".`;

    const response = await invokeLLM({
      messages: [
        { role: "system", content: KNOWLEDGE_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "knowledge_base",
          strict: true,
          schema: {
            type: "object",
            properties: {
              trading_style: { type: "string" },
              preferred_strategies: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                    frequency: { type: "string" },
                  },
                  required: ["name", "description", "frequency"],
                  additionalProperties: false,
                },
              },
              top_tickers: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    ticker: { type: "string" },
                    company: { type: "string" },
                    mentions: { type: "integer" },
                    context: { type: "string" },
                  },
                  required: ["ticker", "company", "mentions", "context"],
                  additionalProperties: false,
                },
              },
              entry_patterns: { type: "array", items: { type: "string" } },
              exit_and_risk_rules: { type: "array", items: { type: "string" } },
              market_themes: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    theme: { type: "string" },
                    description: { type: "string" },
                  },
                  required: ["theme", "description"],
                  additionalProperties: false,
                },
              },
              key_levels_approach: { type: "string" },
              overall_philosophy: { type: "string" },
              generated_at: { type: "string" },
              based_on_videos: { type: "integer" },
            },
            required: [
              "trading_style",
              "preferred_strategies",
              "top_tickers",
              "entry_patterns",
              "exit_and_risk_rules",
              "market_themes",
              "key_levels_approach",
              "overall_philosophy",
              "generated_at",
              "based_on_videos",
            ],
            additionalProperties: false,
          },
        },
      },
    });

    const rawContent = response.choices?.[0]?.message?.content;
    const content = typeof rawContent === "string" ? rawContent : null;
    if (!content) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "AI returned empty response" });

    const result = JSON.parse(content) as KnowledgeResult;
    await upsertKnowledgeBase(ctx.user.id, JSON.stringify(result), analysisSummaries.length);

    return {
      result,
      analysisCount: analysisSummaries.length,
      updatedAt: new Date(),
    };
  }),
});

// ─── Auto-regenerate helper (called from analyze.ts after each analysis) ────────

/**
 * Regenerates the Knowledge Base from all completed analyses.
 * Runs in the background — non-blocking. Silently skips if no analyses exist.
 */
export async function autoRegenerateKnowledgeBase(userId: number): Promise<void> {
  try {
    const completedAnalyses = await getAllCompletedAnalysesByUser(userId);
    if (completedAnalyses.length === 0) return;

    const analysisSummaries = completedAnalyses
      .filter((a) => a.analysisResult)
      .map((a) => {
        let rows: TradingRow[] = [];
        try {
          const parsed = JSON.parse(a.analysisResult!);
          rows = Array.isArray(parsed) ? parsed : (parsed.rows ?? []);
        } catch { return null; }
        if (rows.length === 0) return null;
        return {
          videoTitle: a.videoTitle ?? "Unknown Video",
          channelName: a.channelName ?? "Unknown Channel",
          date: a.createdAt.toISOString().split("T")[0],
          tickers: rows,
        };
      })
      .filter(Boolean);

    if (analysisSummaries.length === 0) return;

    const userContent = `Here are the trading analyses from ${analysisSummaries.length} YouTube video(s):\n\n${JSON.stringify(analysisSummaries, null, 2)}\n\nSynthesize this into a comprehensive trading knowledge base. Set "based_on_videos" to ${analysisSummaries.length} and "generated_at" to "${new Date().toISOString()}".`;

    const response = await invokeLLM({
      messages: [
        { role: "system", content: KNOWLEDGE_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "knowledge_base",
          strict: true,
          schema: {
            type: "object",
            properties: {
              trading_style: { type: "string" },
              preferred_strategies: { type: "array", items: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, frequency: { type: "string" } }, required: ["name", "description", "frequency"], additionalProperties: false } },
              top_tickers: { type: "array", items: { type: "object", properties: { ticker: { type: "string" }, company: { type: "string" }, mentions: { type: "integer" }, context: { type: "string" } }, required: ["ticker", "company", "mentions", "context"], additionalProperties: false } },
              entry_patterns: { type: "array", items: { type: "string" } },
              exit_and_risk_rules: { type: "array", items: { type: "string" } },
              market_themes: { type: "array", items: { type: "object", properties: { theme: { type: "string" }, description: { type: "string" } }, required: ["theme", "description"], additionalProperties: false } },
              key_levels_approach: { type: "string" },
              overall_philosophy: { type: "string" },
              generated_at: { type: "string" },
              based_on_videos: { type: "integer" },
            },
            required: ["trading_style", "preferred_strategies", "top_tickers", "entry_patterns", "exit_and_risk_rules", "market_themes", "key_levels_approach", "overall_philosophy", "generated_at", "based_on_videos"],
            additionalProperties: false,
          },
        },
      },
    });

    const rawContent = response.choices?.[0]?.message?.content;
    const content = typeof rawContent === "string" ? rawContent : null;
    if (!content) return;

    const result = JSON.parse(content) as KnowledgeResult;
    await upsertKnowledgeBase(userId, JSON.stringify(result), analysisSummaries.length);
    console.log(`[KnowledgeBase] Auto-regenerated for user ${userId} from ${analysisSummaries.length} analyses`);
  } catch (err) {
    console.error("[KnowledgeBase] Auto-regenerate failed:", err);
  }
}

// ─── Proficiency Router ───────────────────────────────────────────────────────

export const proficiencyRouter = router({
  /** Get the full 15-topic proficiency matrix for the current user */
  get: protectedProcedure.query(async ({ ctx }) => {
    const rows = await getProficiencyMatrixByUser(ctx.user.id);

    // Return all dynamic topics from DB, sorted by level descending
    return rows
      .sort((a, b) => b.level - a.level)
      .map((row) => ({
        topic: row.topic,
        isBig5: false, // no longer used — all topics are equal
        level: row.level,
        updateLog: row.updateLog ? (JSON.parse(row.updateLog) as Array<{
          videoTitle: string;
          insight: string;
          knowledgeSummary?: string;
          levelBefore: number;
          levelAfter: number;
          date: string;
        }>) : [],
        updatedAt: row.updatedAt ?? null,
      }));
  }),

  /** Update proficiency matrix based on a specific analysis */
  updateFromAnalysis: protectedProcedure
    .input(z.object({ analysisId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      // Get current proficiency levels (all dynamic topics)
      const currentRows = await getProficiencyMatrixByUser(ctx.user.id);
      const currentMatrix: Record<string, number> = {};
      for (const row of currentRows) {
        currentMatrix[row.topic] = row.level;
      }

      // Get the analysis
      const { getAnalysisById } = await import("../db");
      const analysis = await getAnalysisById(input.analysisId);
      if (!analysis || !analysis.analysisResult) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Analysis not found" });
      }

      let tradingRows: TradingRow[] = [];
      try {
        const parsed = JSON.parse(analysis.analysisResult);
        tradingRows = Array.isArray(parsed) ? parsed : (parsed.rows ?? []);
      } catch {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to parse analysis result" });
      }

      const videoTitle = analysis.videoTitle ?? "Unknown Video";

      // Ask AI to update proficiency based on this video
      const systemPrompt = buildProficiencyPrompt(currentMatrix);
      const userContent = `Video: "${videoTitle}"\n\nTrading signals extracted from this video:\n${JSON.stringify(tradingRows, null, 2)}\n\nAlso consider the transcript context if available:\n${(analysis.transcript ?? "").slice(0, 3000)}`;

      const response = await invokeLLM({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "proficiency_update",
            strict: true,
            schema: {
              type: "object",
              properties: {
                updates: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      topic: { type: "string" },
                      currentLevel: { type: "integer" },
                      newLevel: { type: "integer" },
                      insight: { type: "string" },
                      knowledgeSummary: { type: "string" },
                    },
                    required: ["topic", "currentLevel", "newLevel", "insight", "knowledgeSummary"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["updates"],
              additionalProperties: false,
            },
          },
        },
      });

      const rawContent = response.choices?.[0]?.message?.content;
      const content = typeof rawContent === "string" ? rawContent : null;
      if (!content) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "AI returned empty response" });

      const { updates } = JSON.parse(content) as { updates: ProficiencyUpdate[] };

      // Validate and persist updates — accept any topic string (dynamic)
      const validUpdates = updates.filter((u) =>
        typeof u.topic === "string" && u.topic.trim().length > 0 &&
        u.newLevel >= 1 && u.newLevel <= 10
      );

      await bulkUpsertProficiency(
        ctx.user.id,
        validUpdates.map((u) => ({
          topic: u.topic.trim(),
          newLevel: Math.min(10, Math.max(1, u.newLevel)),
          logEntry: {
            videoTitle,
            insight: u.insight,
            knowledgeSummary: u.knowledgeSummary ?? "",
            levelBefore: currentMatrix[u.topic] ?? 0,
            levelAfter: Math.min(10, Math.max(1, u.newLevel)),
            date: new Date().toISOString(),
          },
        }))
      );

      return { updatedTopics: validUpdates.length, updates: validUpdates };
    }),
});
