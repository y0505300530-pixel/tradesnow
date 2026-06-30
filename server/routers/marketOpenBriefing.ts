/**
 * Market Open Action Briefing — POST /api/scheduled/market-open-briefing
 *
 * Triggered 15 minutes after market open:
 *   - TASE (Israel): 10:15 AM Israel time (Sun–Thu)
 *   - US Market:     09:45 AM EST / 16:45 Israel time (Mon–Fri)
 *
 * Fetches H1 + H2 + Catalogue assets, live prices, then calls the LLM
 * for per-asset action recommendations: HOLD, ADD, EXIT, or REPLACE.
 * Sends the formatted briefing via the existing Telegram bot.
 *
 * Auth: requires a valid app_session_id cookie (user role is sufficient).
 */

import type { Express, Request, Response } from "express";
import { getDb, getUserByOpenId } from "../db";
import { portfolioHoldings, holding2, userAssets } from "../../drizzle/schema";
import { eq, and, gt } from "drizzle-orm";
import { fetchLivePricesBatch } from "../marketData";
import { sendTelegramMessage } from "../telegram";
import { invokeLLM } from "../_core/llm";
import { ENV } from "../_core/env";
import { sdk } from "../_core/sdk";

const OWNER_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/** Resolve the owner's DB userId */
async function getOwnerUserId(): Promise<number> {
  if (ENV.ownerOpenId) {
    const db = await getDb();
    if (db) {
      const ownerUser = await getUserByOpenId(ENV.ownerOpenId);
      if (ownerUser?.id) return ownerUser.id;
    }
  }
  return 1;
}

function fmtUsd(n: number): string {
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function fmtPct(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

type Session = "TASE" | "US";

interface AssetRow {
  ticker: string;
  source: "H1" | "H2" | "Catalogue";
  units?: number;
  buyPrice?: number;
  currentPrice: number;
  dailyChangePct: number;
  pnlPct?: number;
  stopLoss?: number | null;
  score?: number | null;
  sector?: string;
}

/** Determine which assets belong to the given session (TASE = Israeli, US = American) */
function isIsraeliTicker(ticker: string): boolean {
  // Israeli tickers on TASE end with .TA or are common Israeli names
  return ticker.toUpperCase().endsWith(".TA") || ticker.toUpperCase().endsWith("-L");
}

function filterBySession(assets: AssetRow[], session: Session): AssetRow[] {
  if (session === "TASE") {
    return assets.filter(a => isIsraeliTicker(a.ticker));
  } else {
    // US: everything that is NOT Israeli
    return assets.filter(a => !isIsraeliTicker(a.ticker));
  }
}

export async function runMarketOpenBriefing(session: Session): Promise<string> {
  const db = await getDb();
  if (!db) return "❌ DB unavailable";

  const chatId = OWNER_CHAT_ID;
  if (!chatId) return "❌ TELEGRAM_CHAT_ID not set";

  const ownerUserId = await getOwnerUserId();

  // ── Fetch holdings ────────────────────────────────────────────────────────
  const [h1Holdings, h2Holdings, catalogueAssets] = await Promise.all([
    db.select().from(portfolioHoldings).where(eq(portfolioHoldings.userId, ownerUserId)),
    db.select().from(holding2).where(and(eq(holding2.userId, ownerUserId), gt(holding2.units, 0))),
    db.select().from(userAssets).where(and(eq(userAssets.userId, ownerUserId), eq(userAssets.archived, 0))),
  ]);

  // ── Batch live prices ─────────────────────────────────────────────────────
  const allTickers = Array.from(new Set([
    ...h1Holdings.map((h: any) => h.ticker),
    ...h2Holdings.map((h: any) => h.ticker),
    ...catalogueAssets.map((a: any) => a.ticker),
  ]));

  const livePricesMap = await fetchLivePricesBatch(allTickers);

  // ── Build asset rows ──────────────────────────────────────────────────────
  const allAssets: AssetRow[] = [];

  for (const h of h1Holdings) {
    if (h.units <= 0) continue;
    const lp = livePricesMap.get(h.ticker.toUpperCase()) ?? livePricesMap.get(h.ticker);
    const price = lp?.price ?? h.currentPrice ?? h.buyPrice ?? 0;
    const dailyChangePct = lp?.changePercent ?? h.dailyChangePercent ?? 0;
    const pnlPct = h.buyPrice ? ((price - h.buyPrice) / h.buyPrice) * 100 : 0;
    allAssets.push({
      ticker: h.ticker,
      source: "H1",
      units: h.units,
      buyPrice: h.buyPrice ?? undefined,
      currentPrice: price,
      dailyChangePct,
      pnlPct,
      stopLoss: h.stopLoss,
      score: h.zivScore,
    });
  }

  for (const h of h2Holdings) {
    const lp = livePricesMap.get(h.ticker.toUpperCase()) ?? livePricesMap.get(h.ticker);
    const price = lp?.price ?? h.currentPrice ?? h.buyPrice ?? 0;
    const dailyChangePct = lp?.changePercent ?? h.dailyChangePercent ?? 0;
    const pnlPct = ((price - h.buyPrice) / h.buyPrice) * 100;
    allAssets.push({
      ticker: h.ticker,
      source: "H2",
      units: h.units,
      buyPrice: h.buyPrice,
      currentPrice: price,
      dailyChangePct,
      pnlPct,
      score: h.zivScore,
    });
  }

  for (const a of catalogueAssets) {
    const lp = livePricesMap.get(a.ticker.toUpperCase()) ?? livePricesMap.get(a.ticker);
    const price = lp?.price ?? a.cmp ?? 0;
    const dailyChangePct = lp?.changePercent ?? a.dailyChangePercent ?? 0;
    allAssets.push({
      ticker: a.ticker,
      source: "Catalogue",
      currentPrice: price,
      dailyChangePct,
      score: a.score,
      sector: a.sector,
    });
  }

  // ── Today P&L (H1+H2 combined) — computed from ALL holdings before session filter ──
  // Uses prevClose from live price data: todayPnl = (price - prevClose) * units
  let unifiedTodayPnl: number | null = null;
  let unifiedTodayPct: number | null = null;
  {
    let totalTodayPnl = 0;
    let totalPrevValue = 0;
    let hasAnyPrevClose = false;
    const allHoldings = [
      ...h1Holdings.filter((h: any) => h.units !== 0),
      ...h2Holdings,
    ];
    for (const h of allHoldings) {
      const lp = livePricesMap.get((h.ticker as string).toUpperCase()) ?? livePricesMap.get(h.ticker as string);
      if (!lp) continue;
      const price = lp.price ?? 0;
      const prevClose = lp.prevClose ?? (lp.price != null && lp.change != null ? lp.price - lp.change : null);
      if (prevClose == null || prevClose <= 0) continue;
      const units = (h.units as number) ?? 0;
      const dailyChange = price - prevClose;
      totalTodayPnl += dailyChange * units;
      totalPrevValue += prevClose * units;
      hasAnyPrevClose = true;
    }
    if (hasAnyPrevClose && totalPrevValue > 0) {
      unifiedTodayPnl = totalTodayPnl;
      unifiedTodayPct = (totalTodayPnl / totalPrevValue) * 100;
    }
  }

  // ── Filter by session ─────────────────────────────────────────────────────
  const sessionAssets = filterBySession(allAssets, session);

  const holdings = sessionAssets.filter(a => a.source === "H1" || a.source === "H2");
  const catalogue = sessionAssets.filter(a => a.source === "Catalogue");

  // If no relevant assets for this session, skip
  if (holdings.length === 0 && catalogue.length === 0) {
    return `no ${session} assets`;
  }

  // ── Build LLM prompt ──────────────────────────────────────────────────────
  const holdingsSummary = holdings.map(h =>
    `${h.ticker} [${h.source}]: price=$${h.currentPrice.toFixed(2)}, daily=${fmtPct(h.dailyChangePct)}, P&L=${h.pnlPct != null ? fmtPct(h.pnlPct) : "N/A"}, SL=${h.stopLoss ? "$" + h.stopLoss.toFixed(2) : "none"}, ZIV score=${h.score ?? "N/A"}`
  ).join("\n");

  const catalogueSummary = catalogue.slice(0, 15).map(a =>
    `${a.ticker} [Catalogue/${a.sector ?? ""}]: price=$${a.currentPrice.toFixed(2)}, daily=${fmtPct(a.dailyChangePct)}, ZIV score=${a.score ?? "N/A"}`
  ).join("\n");

  const sessionLabel = session === "TASE" ? "TASE (Israel)" : "US Market";
  const timeStr = new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit" });

  const systemPrompt = `You are a professional portfolio manager assistant for a momentum-based trading system.
The user follows a ZIV trading methodology: buy breakouts above EMA50, hold with trailing SL below EMA50, exit on close below EMA50.
ZIV score range: 0–10. Score ≥7 = strong, 5–7 = neutral, <5 = weak.

Your task: analyze the current holdings and catalogue assets for the ${sessionLabel} session and provide SPECIFIC action recommendations for each holding.

Actions:
- HOLD: maintain position, no action needed
- ADD (Strengthen): add to the position — only if ZIV score ≥7 and daily momentum is positive
- EXIT (Sell): close the position — if ZIV score <4, price approaching SL, or strong negative momentum
- REPLACE: exit a weak holding and replace with a top-scoring catalogue candidate

Be concise, direct, and professional. One sentence per asset. End with a 2-sentence overall portfolio assessment.`;

  const userPrompt = `${sessionLabel} Market Open Briefing — ${timeStr} Israel time

CURRENT HOLDINGS:
${holdingsSummary || "None"}

TOP CATALOGUE CANDIDATES (for REPLACE suggestions):
${catalogueSummary || "None"}

For each holding, provide: ACTION | one-line rationale
Then provide overall portfolio assessment (2 sentences).`;

  let aiAnalysis = "";
  try {
    const llmRes = await invokeLLM({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    aiAnalysis = (llmRes as any)?.choices?.[0]?.message?.content ?? "";
  } catch (err) {
    aiAnalysis = "⚠️ AI analysis unavailable — check holdings manually.";
  }

  // ── Format Telegram message ───────────────────────────────────────────────
  const sessionEmoji = session === "TASE" ? "🇮🇱" : "🇺🇸";
  const dateStr = new Date().toLocaleDateString("he-IL", {
    timeZone: "Asia/Jerusalem",
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  // Format Today P&L summary
  const todayPnlLine = unifiedTodayPnl != null
    ? `💰 <b>Today P&L (H1+H2):</b> ${unifiedTodayPnl >= 0 ? '+' : ''}${fmtUsd(unifiedTodayPnl)} (${unifiedTodayPct != null ? (unifiedTodayPct >= 0 ? '+' : '') + unifiedTodayPct.toFixed(2) + '%' : ''})`
    : null;

  const lines: string[] = [
    `${sessionEmoji} <b>trade-snow2.vip — Market Open Briefing</b>`,
    `<b>${sessionLabel}</b> · <i>${dateStr} · ${timeStr}</i>`,
    ``,
    ...(todayPnlLine ? [todayPnlLine, ``] : []),
  ];

  if (holdings.length > 0) {
    lines.push(`<b>📊 Holdings (${holdings.length} פוזיציות):</b>`);
    for (const h of holdings) {
      const emoji = h.dailyChangePct >= 0 ? "🟢" : "🔴";
      lines.push(`${emoji} <b>${h.ticker}</b> [${h.source}] ${fmtPct(h.dailyChangePct)} · P&L: ${h.pnlPct != null ? fmtPct(h.pnlPct) : "N/A"}`);
    }
    lines.push(``);
  }

  lines.push(`<b>🤖 AI Action Briefing:</b>`);
  // Escape HTML in AI response to avoid Telegram parse errors
  const safeAI = aiAnalysis
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Re-allow bold-like formatting by converting **text** to <b>text</b>
    .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
  lines.push(safeAI);

  lines.push(``);
  lines.push(`<a href="https://trade-snow2.vip">פתח Trade Manager →</a>`);

  const msg = lines.join("\n");

  // Telegram has a 4096 char limit per message — split if needed
  if (msg.length <= 4096) {
    await sendTelegramMessage(msg, chatId);
  } else {
    // Send in two parts
    const mid = Math.floor(msg.length / 2);
    const split = msg.lastIndexOf("\n", mid);
    await sendTelegramMessage(msg.slice(0, split), chatId);
    await sendTelegramMessage(msg.slice(split + 1), chatId);
  }

  return `sent ${session} briefing: ${holdings.length} holdings, ${catalogue.length} catalogue assets`;
}

export function registerMarketOpenBriefingRoute(app: Express): void {
  app.post("/api/scheduled/market-open-briefing", async (req: Request, res: Response) => {
    // Authenticate: require a valid session cookie (user role is sufficient)
    let user = null;
    try {
      user = await sdk.authenticateRequest(req);
    } catch {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    if (!user) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    // session param: "TASE" or "US" (defaults to "US")
    const session: Session = (req.body?.session === "TASE" ? "TASE" : "US") as Session;

    try {
      const result = await runMarketOpenBriefing(session);
      res.json({ ok: true, result });
    } catch (err) {
      console.error("[MarketOpenBriefing] Error:", err);
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
}
