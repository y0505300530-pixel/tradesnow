import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { invokeLLM } from "../_core/llm";
import {
  getAllCompletedAnalysesByUser,
  getKnowledgeBaseByUser,
  getMasterKnowledgeByUser,
  getProficiencyMatrixByUser,
} from "../db";
import { protectedProcedure, adminProcedure, router } from "../_core/trpc";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TradePlan {
  ticker: string;
  entryZone: string;       // e.g. "$185–$190"
  stopLoss: string;        // e.g. "$178 (8% below entry)"
  takeProfit: string;      // e.g. "$205 / $215 (R1 / R2)"
  logicBadge: string;      // e.g. "Gann Cycle" | "RSI Divergence" | "Demand Zone" | "Kiss & Go"
  logicDetail: string;     // 1-sentence explanation
  confidence: "high" | "medium" | "low";
  dataSource: "knowledge_base" | "analysis_history" | "ai_inference";
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const TRADE_SYSTEM_PROMPT = `You are a professional trading analyst AI trained on Cycles Trading methodology (Gann cycles, Kiss & Go patterns, RSI divergence, demand/supply zones, moving averages).

You will receive:
1. A list of stock tickers the user wants to trade
2. The user's accumulated knowledge base from analyzed YouTube trading videos
3. Historical analysis data showing previously identified setups for these tickers

Your task: For EACH ticker, generate a precise trade execution plan with these exact fields:
- entryZone: The exact price range to buy (e.g. "$185–$190"). If no specific data exists, use AI inference based on typical setups.
- stopLoss: The invalidation price with rule reference (e.g. "$178 — 8% below entry per risk rule" or "$175 — below weekly low").
- takeProfit: Target prices at resistance levels (e.g. "$205 / $220 — R1 weekly / R2 monthly").
- logicBadge: ONE of these exact tags: "Gann Cycle" | "Kiss & Go" | "RSI Divergence" | "Demand Zone" | "MA Support" | "Supply Zone" | "Fibonacci" | "AI Inference"
- logicDetail: ONE sentence explaining why this setup is valid right now.
- confidence: "high" (ticker appeared in analyzed videos with specific levels) | "medium" (ticker in knowledge base, levels inferred) | "low" (AI inference only, no direct data)
- dataSource: "knowledge_base" | "analysis_history" | "ai_inference"

Rules:
- NEVER say "I don't have data". Always provide a trade plan — use "AI Inference" badge when no direct data exists.
- Stop loss must always be based on a rule: 8-12% below entry, OR below the weekly low, OR below a key support level.
- Take profit must reference at least one resistance level or price target.
- Return ONLY valid JSON array. No markdown, no explanation outside the JSON.
- Format: [{ "ticker": "NVDA", "entryZone": "...", "stopLoss": "...", "takeProfit": "...", "logicBadge": "...", "logicDetail": "...", "confidence": "high", "dataSource": "analysis_history" }, ...]`;

// ─── Router ───────────────────────────────────────────────────────────────────

export const tradeRouter = router({
  /**
   * Scan one or more tickers against the accumulated knowledge base
   * and return a precise trade execution plan for each.
   */
  scan: adminProcedure
    .input(
      z.object({
        tickers: z
          .array(z.string().min(1).max(10).toUpperCase())
          .min(1)
          .max(10),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const tickers = Array.from(new Set(input.tickers.map((t) => t.trim().toUpperCase())));
      console.log(`[trade.scan] User ${userId} scanning tickers: ${tickers.join(", ")}`);

      // Gather all knowledge sources in parallel
      const [completedAnalyses, knowledgeBase, masterKnowledge, proficiency] =
        await Promise.all([
          getAllCompletedAnalysesByUser(userId),
          getKnowledgeBaseByUser(userId),
          getMasterKnowledgeByUser(userId),
          getProficiencyMatrixByUser(userId),
        ]);

      // Extract relevant analysis data for the requested tickers
      const tickerMentions: Record<string, Array<{ videoTitle: string; setup: Record<string, string> }>> = {};
      for (const ticker of tickers) tickerMentions[ticker] = [];

      for (const analysis of completedAnalyses) {
        if (!analysis.analysisResult) continue;
        try {
          const parsed = JSON.parse(analysis.analysisResult);
          const rows: Array<Record<string, string>> = Array.isArray(parsed)
            ? parsed
            : (parsed.rows ?? []);
          for (const row of rows) {
            const t = (row.ticker ?? "").toUpperCase().trim();
            if (tickers.includes(t)) {
              tickerMentions[t].push({
                videoTitle: analysis.videoTitle ?? "Unknown Video",
                setup: row,
              });
            }
          }
        } catch {
          // skip malformed
        }
      }

      // Extract active signals from Master Knowledge for these tickers
      let masterSignals: Array<Record<string, string>> = [];
      if (masterKnowledge?.activeSignals) {
        try {
          const all = JSON.parse(masterKnowledge.activeSignals) as Array<Record<string, string>>;
          masterSignals = all.filter((s) =>
            tickers.includes((s.ticker ?? "").toUpperCase())
          );
        } catch {
          // skip
        }
      }

      // Build knowledge context
      const knowledgeContext = knowledgeBase?.result
        ? (() => {
            try {
              const kb = JSON.parse(knowledgeBase.result);
              return kb;
            } catch {
              return knowledgeBase.result;
            }
          })()
        : null;

      const technicalRules = masterKnowledge?.technicalRules
        ? (() => {
            try {
              return JSON.parse(masterKnowledge.technicalRules);
            } catch {
              return null;
            }
          })()
        : null;

      // Build the user prompt
      const userContent = `
Tickers to analyze: ${tickers.join(", ")}

=== HISTORICAL ANALYSIS DATA (from analyzed videos) ===
${JSON.stringify(tickerMentions, null, 2)}

=== ACTIVE SIGNALS FROM MASTER KNOWLEDGE ===
${JSON.stringify(masterSignals, null, 2)}

=== TECHNICAL RULES (from your knowledge base) ===
${JSON.stringify(technicalRules ?? "Not yet generated — use methodology defaults", null, 2)}

=== KNOWLEDGE BASE SUMMARY ===
${knowledgeContext ? JSON.stringify(knowledgeContext).slice(0, 2000) : "Not yet generated"}

=== PROFICIENCY LEVELS ===
${proficiency.map((p) => `${p.topic}: ${p.level}/10`).join(", ")}

Generate a trade execution plan for each ticker. Return ONLY the JSON array.`;

      const response = await invokeLLM({
        messages: [
          { role: "system", content: TRADE_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      });

      const rawContent = response.choices?.[0]?.message?.content;
      const content =
        typeof rawContent === "string" ? rawContent.trim() : null;

      if (!content) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "AI returned empty response",
        });
      }

      // Guard against HTML error pages
      if (content.startsWith("<!") || content.startsWith("<html")) {
        console.error(`[trade.scan] LLM returned HTML error page, first 200 chars: ${content.substring(0, 200)}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "AI service returned an error page. Please try again in a moment.",
        });
      }

      // Strip markdown code fences if present (```json ... ``` or ``` ... ```)
      const stripped = content
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();

      // Extract JSON array from response (handles leading text before the array)
      const jsonMatch = stripped.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.error(`[trade.scan] No JSON array found in LLM response. Content: ${stripped.substring(0, 300)}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "AI did not return a valid trade plan. Please try again.",
        });
      }

      let plans: TradePlan[];
      try {
        plans = JSON.parse(jsonMatch[0]) as TradePlan[];
      } catch (parseErr) {
        console.error(`[trade.scan] JSON.parse failed: ${parseErr}. Raw: ${jsonMatch[0].substring(0, 300)}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "AI returned malformed JSON. Please try again.",
        });
      }

      // Ensure every requested ticker has a plan (fill missing ones)
      const planMap = new Map(plans.map((p) => [p.ticker.toUpperCase(), p]));
      for (const ticker of tickers) {
        if (!planMap.has(ticker)) {
          planMap.set(ticker, {
            ticker,
            entryZone: "—",
            stopLoss: "—",
            takeProfit: "—",
            logicBadge: "AI Inference",
            logicDetail: "No direct data found. Provide more video analyses for this ticker.",
            confidence: "low",
            dataSource: "ai_inference",
          });
        }
      }

      // Return in the same order as input
      return tickers.map((t) => planMap.get(t)!);
    }),

  /**
   * Fetch live market prices for a list of tickers via Yahoo Finance
   */
  livePrices: adminProcedure
    .input(z.object({ tickers: z.array(z.string().min(1).max(10)).min(1).max(10) }))
    .query(async ({ input }) => {
      const results: Record<string, { price: number | null; change: number | null; changePercent: number | null; currency: string }> = {};

      await Promise.allSettled(
        input.tickers.map(async (ticker) => {
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
            const res = await fetch(url, {
              signal: controller.signal,
              headers: { "User-Agent": "Mozilla/5.0 (compatible; TradingAnalyzer/1.0)" },
            });
            clearTimeout(timer);
            if (res.status === 429) throw new Error("rate_limit");
            const rawText = await res.text();
            if (!rawText.startsWith("{") && !rawText.startsWith("[")) throw new Error("rate_limit");
            const data = JSON.parse(rawText) as Record<string, unknown>;
            const meta = (data as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; chartPreviousClose?: number; currency?: string } }> } }).chart?.result?.[0]?.meta;
            if (meta?.regularMarketPrice) {
              const prev = meta.chartPreviousClose ?? meta.regularMarketPrice;
              const change = meta.regularMarketPrice - prev;
              results[ticker.toUpperCase()] = {
                price: meta.regularMarketPrice,
                change: Math.round(change * 100) / 100,
                changePercent: Math.round((change / prev) * 10000) / 100,
                currency: meta.currency ?? "USD",
              };
            } else {
              results[ticker.toUpperCase()] = { price: null, change: null, changePercent: null, currency: "USD" };
            }
          } catch {
            results[ticker.toUpperCase()] = { price: null, change: null, changePercent: null, currency: "USD" };
          }
        })
      );

      return results;
    }),

  /**
   * Fetch 1-year historical OHLCV data for a single ticker (for charting)
   */
  historicalData: adminProcedure
    .input(z.object({ ticker: z.string().min(1).max(10) }))
    .query(async ({ input }) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(input.ticker)}?interval=1d&range=1y`;
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; TradingAnalyzer/1.0)" },
        });
        clearTimeout(timer);
        if (res.status === 429) return null;
        const rawText2 = await res.text();
        if (!rawText2.startsWith("{") && !rawText2.startsWith("[")) return null;
        const data = JSON.parse(rawText2) as Record<string, unknown>;
        type YahooResult = {
          meta?: { regularMarketPrice?: number; currency?: string };
          timestamp?: number[];
          indicators?: { quote?: Array<{ open?: number[]; high?: number[]; low?: number[]; close?: number[]; volume?: number[] }> };
        };
        const result = (data as { chart?: { result?: YahooResult[] } }).chart?.result?.[0];
        if (!result?.timestamp || !result.indicators?.quote?.[0]) return null;
        const { timestamp, indicators } = result;
        const q = indicators.quote?.[0];
        if (!q) return null;
        const candles = timestamp.map((t, i) => ({
          time: t,
          open: q.open?.[i] ?? null,
          high: q.high?.[i] ?? null,
          low: q.low?.[i] ?? null,
          close: q.close?.[i] ?? null,
          volume: q.volume?.[i] ?? null,
        })).filter((c) => c.close !== null);
        return {
          ticker: input.ticker.toUpperCase(),
          currency: result.meta?.currency ?? "USD",
          currentPrice: result.meta?.regularMarketPrice ?? null,
          candles,
        };
      } catch {
        return null;
      }
    }),
});
