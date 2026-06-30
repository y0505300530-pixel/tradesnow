/**
 * Trade Manager Router
 * Handles the persistent CRUD trade position table with live-price-based AI suggestions.
 * All AI suggestions use Current Market Price (CMP) — never transcript prices.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import {
  deleteTradePosition,
  getAllCompletedAnalysesByUser,
  getKnowledgeBaseByUser,
  getMasterKnowledgeByUser,
  getProficiencyMatrixByUser,
  getTradePositionsByUser,
  updateTradePositionById,
  upsertTradePosition,
} from "../db";
import { invokeLLM } from "../_core/llm";
import { fetchLivePrice } from "../marketData";
import { detectZones } from "../zonesEngine";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// fetchLivePrice imported from shared marketData.ts


// ─── Chart Data & Technical Calculations ────────────────────────────────────

interface OHLCVBar { time: number; open: number; high: number; low: number; close: number; volume: number; }
interface ChartLevels {
  cmp: number;
  ema20: number;
  ema50: number;
  ema200: number;
  swingHighs: number[];   // last 3 significant swing highs
  swingLows: number[];    // last 3 significant swing lows
  demandZones: Array<{ low: number; high: number }>; // price consolidation areas
  resistanceZones: Array<{ low: number; high: number }>;
  weeklyLow: number;      // lowest close in last 5 trading days
  monthlyLow: number;     // lowest close in last 22 trading days
  atr14: number;          // 14-period ATR for stop-loss sizing
}

/** EMA calculation */
const calcEma = (data: number[], period: number): number => {
  if (data.length < period) return data[data.length - 1];
  const k = 2 / (period + 1);
  let e = data.slice(0, period).reduce((a: number, b: number) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) e = data[i] * k + e * (1 - k);
  return parseFloat(e.toFixed(2));
};

/** ATR14 */
const calcAtr14 = (bars: OHLCVBar[]): number => {
  const trs = bars.slice(1).map((b, i) => {
    const prev = bars[i].close;
    return Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  });
  return parseFloat((trs.slice(-14).reduce((a: number, b: number) => a + b, 0) / 14).toFixed(2));
};

/** Swing highs/lows (pivot points with lookback 5) */
const calcSwingPoints = (arr: number[], type: 'high' | 'low', n = 3): number[] => {
  const points: number[] = [];
  const lb = 5;
  for (let i = lb; i < arr.length - lb; i++) {
    const window = arr.slice(i - lb, i + lb + 1);
    const val = arr[i];
    if (type === 'high' && val === Math.max(...window)) points.push(val);
    if (type === 'low' && val === Math.min(...window)) points.push(val);
  }
  return points.slice(-n).map((v: number) => parseFloat(v.toFixed(2)));
};

/** Find demand/resistance zones: price consolidation areas before a big move */
// SSOT: zone geometry lives in zonesEngine (the only zone owner). This UI adapter maps
// the local OHLCVBar shape and preserves the legacy display behavior — minTouches:0 keeps
// ALL consolidation→impulse zones (not the engine's ≥2-touch validity filter), re-sorted
// by distance to the current price, nearest 3. Output shape {low,high}[] is unchanged.
const calcZones = (bars: OHLCVBar[], type: 'demand' | 'resistance', cmp: number): Array<{ low: number; high: number }> => {
  const mapped = bars.map(b => ({ date: String(b.time), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
  return detectZones(mapped, { trend: type === 'demand' ? 'up' : 'down', minTouches: 0 })
    .map(z => ({ low: parseFloat(z.low.toFixed(2)), high: parseFloat(z.high.toFixed(2)) }))
    .filter((z, i, arr) => arr.findIndex(z2 => Math.abs(z2.low - z.low) < cmp * 0.01) === i)
    .sort((a, b) => Math.abs((a.low + a.high) / 2 - cmp) - Math.abs((b.low + b.high) / 2 - cmp))
    .slice(0, 3);
};

/** Fetch 6-month daily OHLCV from Yahoo Finance and calculate key technical levels */
async function fetchChartData(ticker: string): Promise<ChartLevels | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=6mo`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const rawText = await res.text();
    if (!rawText.trimStart().startsWith("{") && !rawText.trimStart().startsWith("[")) return null;
    const data = JSON.parse(rawText) as any;
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const timestamps: number[] = result.timestamp || [];
    const q = result.indicators?.quote?.[0];
    if (!q || timestamps.length < 30) return null;

    const bars: OHLCVBar[] = timestamps.map((t: number, i: number) => ({
      time: t,
      open: q.open[i] ?? 0,
      high: q.high[i] ?? 0,
      low: q.low[i] ?? 0,
      close: q.close[i] ?? 0,
      volume: q.volume[i] ?? 0,
    })).filter((b: OHLCVBar) => b.close > 0);

    const closes = bars.map((b: OHLCVBar) => b.close);
    const highs = bars.map((b: OHLCVBar) => b.high);
    const lows = bars.map((b: OHLCVBar) => b.low);
    const cmp = closes[closes.length - 1];

    // Use module-level helpers: calcEma, calcAtr14, calcSwingPoints, calcZones

    return {
      cmp,
      ema20: calcEma(closes, 20),
      ema50: calcEma(closes, 50),
      ema200: calcEma(closes, Math.min(200, closes.length)),
      swingHighs: calcSwingPoints(highs, 'high'),
      swingLows: calcSwingPoints(lows, 'low'),
      demandZones: calcZones(bars, 'demand', cmp),
      resistanceZones: calcZones(bars, 'resistance', cmp),
      weeklyLow: parseFloat(Math.min(...lows.slice(-5)).toFixed(2)),
      monthlyLow: parseFloat(Math.min(...lows.slice(-22)).toFixed(2)),
      atr14: calcAtr14(bars),
    };
  } catch {
    return null;
  }
}

/** Strip markdown fences and extract JSON array from LLM response */
function extractJsonArray(content: string): any[] {
  const stripped = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const match = stripped.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]);
  } catch {
    return [];
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const tradeManagerRouter = router({
  /** List all saved trade positions for the current user */
  list: adminProcedure.query(async ({ ctx }) => {
    return getTradePositionsByUser(ctx.user.id);
  }),

  /**
   * Scan tickers using LIVE price + accumulated knowledge.
   * Returns AI suggestions based on CMP — never transcript prices.
   * Saves results to the tradePositions table.
   */
  scanAndSave: protectedProcedure
    .input(
      z.object({
        tickers: z.array(z.string().min(1).max(10)).min(1).max(10),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const tickers = Array.from(new Set(input.tickers.map((t) => t.trim().toUpperCase())));
      console.log(`[tradeManager.scanAndSave] User ${userId} scanning: ${tickers.join(", ")}`);

      // 1. Fetch live prices AND chart data for all tickers in parallel
      const [livePrices, chartDataMap] = await Promise.all([
        Promise.all(tickers.map(async (ticker) => ({ ticker, live: await fetchLivePrice(ticker) }))),
        Promise.all(tickers.map(async (ticker) => ({ ticker, chart: await fetchChartData(ticker) }))),
      ]);
      const chartByTicker = Object.fromEntries(chartDataMap.map(({ ticker, chart }) => [ticker, chart]));

      // 2. Gather knowledge context
      const [, knowledgeBase, masterKnowledge, proficiency] = await Promise.all([
        getAllCompletedAnalysesByUser(userId).catch(() => []),
        getKnowledgeBaseByUser(userId).catch(() => null),
        getMasterKnowledgeByUser(userId).catch(() => null),
        getProficiencyMatrixByUser(userId).catch(() => []),
      ]);

      // Build knowledge context string
      const knowledgeContext = [
        knowledgeBase?.result ? `Knowledge Base:\n${knowledgeBase.result.substring(0, 1500)}` : "",
        masterKnowledge?.technicalRules
          ? `Technical Rules:\n${masterKnowledge.technicalRules.substring(0, 1000)}`
          : "",
        proficiency.length > 0
          ? `Proficiency Topics: ${proficiency.map((p: any) => `${p.topic}(${p.level}/10)`).join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      // Build ticker context with live prices AND real chart levels
      const tickerContext = livePrices
        .map(({ ticker, live }) => {
          const chart = chartByTicker[ticker];
          const base = live
            ? `${ticker}: CMP=$${live.price.toFixed(2)}, Company="${live.company}", Change=${live.changePercent.toFixed(2)}%`
            : `${ticker}: CMP=unavailable`;
          if (!chart) return base;
          const demandStr = chart.demandZones.length
            ? chart.demandZones.map((z: { low: number; high: number }) => `$${z.low}-$${z.high}`).join(", ")
            : "none identified";
          const resistStr = chart.resistanceZones.length
            ? chart.resistanceZones.map((z: { low: number; high: number }) => `$${z.low}-$${z.high}`).join(", ")
            : "none identified";
          return `${base}
  EMA20=$${chart.ema20} | EMA50=$${chart.ema50} | EMA200=$${chart.ema200}
  Swing Highs: ${chart.swingHighs.map((h: number) => `$${h}`).join(", ") || "N/A"}
  Swing Lows: ${chart.swingLows.map((l: number) => `$${l}`).join(", ") || "N/A"}
  Demand Zones: ${demandStr}
  Resistance Zones: ${resistStr}
  Weekly Low=$${chart.weeklyLow} | Monthly Low=$${chart.monthlyLow} | ATR14=$${chart.atr14}`;
        })
        .join("\n\n");

      // 3. Ask LLM for trade plans based on REAL chart data
      const systemPrompt = `You are an expert trading analyst. You have learned these strategies from video analysis:
${knowledgeContext || "General technical analysis: RSI, Moving Averages, Support/Resistance, Gann Cycles, Kiss & Go patterns."}

CRITICAL RULES:
- You are given REAL calculated technical levels from 6 months of daily chart data. USE THEM.
- Entry Zone: must be a specific price range based on the demand zones, EMA levels, or swing lows provided.
- Stop Loss: must be a specific price based on the weekly low, ATR14 (8-12% below entry), or swing low.
- Take Profit: must be a specific price based on the resistance zones or swing highs provided.
- NEVER say "we need more data" or give vague answers. You have the data — use the numbers.
- If CMP is above all demand zones, set status="watching" and entry = nearest demand zone or EMA support.
- If CMP is at or near a demand zone/EMA support, set status="active".
- Return ONLY a valid JSON array. No markdown, no explanation.`;

      const userPrompt = `Chart Data (6-month calculated levels):
${tickerContext}

For each ticker, generate a precise trade plan using the EXACT price levels above. Apply the learned Bible Rules.
Return a JSON array with exactly this structure:
[
  {
    "ticker": "NVDA",
    "company": "NVIDIA Corporation",
    "aiEntry": "$487-$495 (demand zone + EMA50 confluence)",
    "aiStopLoss": "$462 (weekly low, 5.7% below entry)",
    "aiTakeProfit": "$548 (resistance zone, 1:3 R:R)",
    "aiLogic": "Demand Zone + EMA50",
    "aiLogicDetail": "CMP $540 is above entry zone. Waiting for pullback to $487-$495 demand zone where EMA50 converges. Stop at weekly low $462. Target $548 resistance.",
    "aiConfidence": "high",
    "status": "watching"
  }
]
Status must be one of: "watching" (waiting for entry), "active" (CMP is at entry zone now), "closed".`;

      const llmResponse = await invokeLLM({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });

      const rawContent = llmResponse?.choices?.[0]?.message?.content ?? "";
      const content = typeof rawContent === "string" ? rawContent : "";
      if (!content || content.startsWith("<!")) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "AI service error. Please try again.",
        });
      }

      const plans = extractJsonArray(content);
      if (plans.length === 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "AI did not return valid trade plans. Please try again.",
        });
      }

      // 4. Save to DB and return merged result
      const results = [];
      for (const plan of plans) {
        const ticker = (plan.ticker || "").toUpperCase();
        if (!ticker) continue;
        const liveData = livePrices.find((lp) => lp.ticker === ticker)?.live;
        const id = await upsertTradePosition(userId, ticker, {
          company: plan.company || liveData?.company || ticker,
          aiEntry: plan.aiEntry,
          aiStopLoss: plan.aiStopLoss,
          aiTakeProfit: plan.aiTakeProfit,
          aiLogic: plan.aiLogic,
          aiLogicDetail: plan.aiLogicDetail,
          aiConfidence: plan.aiConfidence,
          status: plan.status || "watching",
        });
        results.push({
          id,
          ticker,
          company: plan.company || liveData?.company || ticker,
          livePrice: liveData?.price ?? null,
          liveChange: liveData?.changePercent ?? null,
          aiEntry: plan.aiEntry,
          aiStopLoss: plan.aiStopLoss,
          aiTakeProfit: plan.aiTakeProfit,
          aiLogic: plan.aiLogic,
          aiLogicDetail: plan.aiLogicDetail,
          aiConfidence: plan.aiConfidence,
          status: plan.status || "watching",
        });
      }
      return results;
    }),

  /** Update user override fields for a position */
  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        userEntry: z.string().optional(),
        userStopLoss: z.string().optional(),
        userTakeProfit: z.string().optional(),
        userNotes: z.string().optional(),
        status: z.enum(["watching", "active", "closed"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      await updateTradePositionById(id, data);
      return { success: true };
    }),

  /** Delete a trade position */
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await deleteTradePosition(input.id);
      return { success: true };
    }),

  /**
   * Risk rating — checks user's manual Entry/SL/TP against Bible Rules.
   * Returns a rating: "Safe", "Moderate Risk", or "High Risk" with explanation.
   */
  rateRisk: protectedProcedure
    .input(
      z.object({
        ticker: z.string().min(1).max(10),
        entry: z.string(),
        stopLoss: z.string(),
        takeProfit: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;

      // Fetch live price for context
      const live = await fetchLivePrice(input.ticker.toUpperCase());

      // Get knowledge context
      const [knowledgeBase, masterKnowledge] = await Promise.all([
        getKnowledgeBaseByUser(userId).catch(() => null),
        getMasterKnowledgeByUser(userId).catch(() => null),
      ]);

      const knowledgeContext = [
        knowledgeBase?.result ? knowledgeBase.result.substring(0, 1500) : "",
        masterKnowledge?.technicalRules ? masterKnowledge.technicalRules.substring(0, 1000) : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      const prompt = `You are a trading risk analyst. Evaluate this trade setup against the learned Bible Rules.

Ticker: ${input.ticker.toUpperCase()}
Current Market Price: ${live ? `$${live.price.toFixed(2)}` : "unavailable"}
User Entry: ${input.entry}
User Stop Loss: ${input.stopLoss}
User Take Profit: ${input.takeProfit}

Learned Rules:
${knowledgeContext || "Standard rules: Stop loss should be 8-12% below entry. Risk:Reward ratio should be at least 1:2. Entry should be at support levels."}

Analyze this trade setup and return ONLY a JSON object (no markdown):
{
  "rating": "Safe" | "Moderate Risk" | "High Risk",
  "riskReward": "1:3.2",
  "issues": ["Stop loss is too tight at 3% — should be 8-12%"],
  "positives": ["Entry aligns with demand zone"],
  "verdict": "One sentence summary of the trade quality"
}`;

      const llmResponse = await invokeLLM({
        messages: [
          { role: "system", content: "You are a trading risk analyst. Return ONLY valid JSON. No markdown." },
          { role: "user", content: prompt },
        ],
      });

      const rawContent = llmResponse?.choices?.[0]?.message?.content ?? "";
      const content = typeof rawContent === "string" ? rawContent : "";
      if (!content || content.startsWith("<!")) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "AI service error." });
      }

      const stripped = content
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();
      const jsonMatch = stripped.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return {
          rating: "Moderate Risk",
          riskReward: "N/A",
          issues: ["Could not parse AI response"],
          positives: [],
          verdict: "Manual review recommended.",
        };
      }
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return {
          rating: "Moderate Risk",
          riskReward: "N/A",
          issues: ["Could not parse AI response"],
          positives: [],
          verdict: "Manual review recommended.",
        };
      }
    }),

  /** Fetch live prices for a list of tickers */
  livePrices: protectedProcedure
    .input(z.object({ tickers: z.array(z.string()).min(1).max(20) }))
    .query(async ({ input }) => {
      const results = await Promise.all(
        input.tickers.map(async (ticker) => ({
          ticker: ticker.toUpperCase(),
          ...(await fetchLivePrice(ticker.toUpperCase())),
        }))
      );
      return results;
    }),
});

// ─── Exported helper for cross-router use ────────────────────────────────────

/**
 * Runs a full trade scan for a single ticker and saves/updates the position.
 * Called from masterKnowledge.sendToTradeManager.
 */
export async function scanAndSaveTrade(userId: number, ticker: string): Promise<{
  id: number; ticker: string; company: string;
  livePrice: number | null; liveChange: number | null;
  aiEntry: string; aiStopLoss: string; aiTakeProfit: string;
  aiLogic: string; aiLogicDetail: string; aiConfidence: string; status: string;
}> {
  const t = ticker.trim().toUpperCase();

  const [liveData, chartData] = await Promise.all([
    fetchLivePrice(t),
    fetchChartData(t),
  ]);

  const [knowledgeBase, masterKnowledge, proficiency] = await Promise.all([
    getKnowledgeBaseByUser(userId).catch(() => null),
    getMasterKnowledgeByUser(userId).catch(() => null),
    getProficiencyMatrixByUser(userId).catch(() => []),
  ]);

  const knowledgeContext = [
    knowledgeBase?.result ? `Knowledge Base:\n${knowledgeBase.result.substring(0, 1500)}` : "",
    masterKnowledge?.technicalRules ? `Technical Rules:\n${masterKnowledge.technicalRules.substring(0, 1000)}` : "",
    proficiency.length > 0
      ? `Proficiency Topics: ${proficiency.map((p: any) => `${p.topic}(${p.level}/10)`).join(", ")}`
      : "",
  ].filter(Boolean).join("\n\n");

  let tickerContext = liveData
    ? `${t}: CMP=$${liveData.price.toFixed(2)}, Company="${liveData.company}", Change=${liveData.changePercent.toFixed(2)}%`
    : `${t}: CMP=unavailable`;

  if (chartData) {
    const demandStr = chartData.demandZones.length
      ? chartData.demandZones.map((z: { low: number; high: number }) => `$${z.low}-$${z.high}`).join(", ")
      : "none identified";
    const resistStr = chartData.resistanceZones.length
      ? chartData.resistanceZones.map((z: { low: number; high: number }) => `$${z.low}-$${z.high}`).join(", ")
      : "none identified";
    tickerContext += `\n  EMA20=$${chartData.ema20} | EMA50=$${chartData.ema50} | EMA200=$${chartData.ema200}\n  Swing Highs: ${chartData.swingHighs.map((h: number) => `$${h}`).join(", ") || "N/A"}\n  Swing Lows: ${chartData.swingLows.map((l: number) => `$${l}`).join(", ") || "N/A"}\n  Demand Zones: ${demandStr}\n  Resistance Zones: ${resistStr}\n  Weekly Low=$${chartData.weeklyLow} | Monthly Low=$${chartData.monthlyLow} | ATR14=$${chartData.atr14}`;
  }

  const systemPrompt = `You are an expert trading analyst. You have learned these strategies from video analysis:\n${knowledgeContext || "General technical analysis: RSI, Moving Averages, Support/Resistance, Gann Cycles, Kiss & Go patterns."}\n\nCRITICAL RULES:\n- Use the REAL calculated technical levels provided.\n- Entry Zone: specific price range based on demand zones, EMA levels, or swing lows.\n- Stop Loss: specific price based on weekly low, ATR14, or swing low.\n- Take Profit: specific price based on resistance zones or swing highs.\n- Return ONLY a valid JSON array. No markdown, no explanation.`;

  const userPrompt = `Chart Data:\n${tickerContext}\n\nGenerate a precise trade plan. Return a JSON array with exactly one object:\n[{"ticker":"${t}","company":"...","aiEntry":"...","aiStopLoss":"...","aiTakeProfit":"...","aiLogic":"...","aiLogicDetail":"...","aiConfidence":"high|medium|low","status":"watching|active"}]`;

  const llmResponse = await invokeLLM({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const rawContent = llmResponse?.choices?.[0]?.message?.content ?? "";
  const content = typeof rawContent === "string" ? rawContent : "";
  if (!content || content.startsWith("<!")) {
    throw new Error("AI service error during scan");
  }

  const plans = extractJsonArray(content);
  if (plans.length === 0) throw new Error("AI did not return a valid trade plan");

  const plan = plans[0];
  const id = await upsertTradePosition(userId, t, {
    company: plan.company || liveData?.company || t,
    aiEntry: plan.aiEntry,
    aiStopLoss: plan.aiStopLoss,
    aiTakeProfit: plan.aiTakeProfit,
    aiLogic: plan.aiLogic,
    aiLogicDetail: plan.aiLogicDetail,
    aiConfidence: plan.aiConfidence,
    status: plan.status || "watching",
  });

  return {
    id,
    ticker: t,
    company: plan.company || liveData?.company || t,
    livePrice: liveData?.price ?? null,
    liveChange: liveData?.changePercent ?? null,
    aiEntry: plan.aiEntry,
    aiStopLoss: plan.aiStopLoss,
    aiTakeProfit: plan.aiTakeProfit,
    aiLogic: plan.aiLogic,
    aiLogicDetail: plan.aiLogicDetail,
    aiConfidence: plan.aiConfidence,
    status: plan.status || "watching",
  };
}
