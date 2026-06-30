/**
 * End-of-Day Summary — POST /api/scheduled/end-of-day-summary
 *
 * Triggered at 23:15 Israel time (Mon–Fri) — after US market close.
 * Sends a Telegram message with:
 *   1. Today P&L final (H1+H2 combined, $ and %)
 *   2. Top 3 gainers and top 3 losers across all holdings
 *   3. ZIV alerts: holdings with score ≤ 3 or close to Stop Loss (within 5%)
 *
 * Auth: requires a valid app_session_id cookie (user role is sufficient).
 */

import type { Express, Request, Response } from "express";
import { getDb, getUserByOpenId } from "../db";
import { portfolioHoldings, holding2 } from "../../drizzle/schema";
import { eq, and, gt } from "drizzle-orm";
import { fetchLivePricesBatch } from "../marketData";
import { sendTelegramMessage } from "../telegram";
import { invokeLLM } from "../_core/llm";
import { ENV } from "../_core/env";
import { sdk } from "../_core/sdk";

const OWNER_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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
  return (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function fmtPct(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

export async function runEndOfDaySummary(): Promise<string> {
  const db = await getDb();
  if (!db) return "❌ DB unavailable";

  const chatId = OWNER_CHAT_ID;
  if (!chatId) return "❌ TELEGRAM_CHAT_ID not set";

  const ownerUserId = await getOwnerUserId();

  // ── Fetch all holdings ────────────────────────────────────────────────────
  const [h1Holdings, h2Holdings] = await Promise.all([
    db.select().from(portfolioHoldings).where(eq(portfolioHoldings.userId, ownerUserId)),
    db.select().from(holding2).where(eq(holding2.userId, ownerUserId)),
  ]);

  const activeH1 = h1Holdings.filter((h: any) => h.units !== 0);

  // ── Batch live prices ─────────────────────────────────────────────────────
  const allTickers = Array.from(new Set([
    ...activeH1.map((h: any) => h.ticker),
    ...h2Holdings.map((h: any) => h.ticker),
  ]));

  const livePricesMap = await fetchLivePricesBatch(allTickers);

  // ── Compute per-holding stats ─────────────────────────────────────────────
  interface HoldingStats {
    ticker: string;
    source: "H1" | "H2";
    units: number;
    price: number;
    prevClose: number | null;
    buyPrice: number;
    dailyChangePct: number;
    dailyChangeDollar: number | null;
    pnlPct: number;
    stopLoss: number | null;
    zivScore: number | null;
    distToSL: number | null; // % distance from current price to stop loss (negative = breached)
  }

  const stats: HoldingStats[] = [];

  for (const h of activeH1) {
    const lp = livePricesMap.get((h.ticker as string).toUpperCase()) ?? livePricesMap.get(h.ticker as string);
    const price = lp?.price ?? (h as any).currentPrice ?? (h as any).buyPrice ?? 0;
    const prevClose = lp?.prevClose ?? (lp?.price != null && lp?.change != null ? lp.price - lp.change : null);
    const dailyChangePct = lp?.changePercent ?? (h as any).dailyChangePercent ?? 0;
    const dailyChangeDollar = prevClose != null ? (price - prevClose) * (h as any).units : null;
    const pnlPct = (h as any).buyPrice ? ((price - (h as any).buyPrice) / (h as any).buyPrice) * 100 : 0;
    const sl = (h as any).stopLoss ?? null;
    const distToSL = sl != null && price > 0 ? ((price - sl) / price) * 100 : null;
    stats.push({
      ticker: h.ticker as string,
      source: "H1",
      units: (h as any).units,
      price,
      prevClose,
      buyPrice: (h as any).buyPrice ?? 0,
      dailyChangePct,
      dailyChangeDollar,
      pnlPct,
      stopLoss: sl,
      zivScore: (h as any).zivScore ?? null,
      distToSL,
    });
  }

  for (const h of h2Holdings) {
    const lp = livePricesMap.get((h.ticker as string).toUpperCase()) ?? livePricesMap.get(h.ticker as string);
    const price = lp?.price ?? (h as any).currentPrice ?? (h as any).buyPrice ?? 0;
    const prevClose = lp?.prevClose ?? (lp?.price != null && lp?.change != null ? lp.price - lp.change : null);
    const dailyChangePct = lp?.changePercent ?? (h as any).dailyChangePercent ?? 0;
    const dailyChangeDollar = prevClose != null ? (price - prevClose) * (h as any).units : null;
    const pnlPct = (h as any).buyPrice ? ((price - (h as any).buyPrice) / (h as any).buyPrice) * 100 : 0;
    stats.push({
      ticker: h.ticker as string,
      source: "H2",
      units: (h as any).units,
      price,
      prevClose,
      buyPrice: (h as any).buyPrice ?? 0,
      dailyChangePct,
      dailyChangeDollar,
      pnlPct,
      stopLoss: null,
      zivScore: (h as any).zivScore ?? null,
      distToSL: null,
    });
  }

  // ── Today P&L (H1+H2 combined) ────────────────────────────────────────────
  let totalTodayPnl = 0;
  let totalPrevValue = 0;
  let hasAnyPrevClose = false;
  for (const s of stats) {
    if (s.prevClose != null && s.prevClose > 0) {
      totalTodayPnl += (s.price - s.prevClose) * s.units;
      totalPrevValue += s.prevClose * s.units;
      hasAnyPrevClose = true;
    }
  }
  const unifiedTodayPnl = hasAnyPrevClose ? totalTodayPnl : null;
  const unifiedTodayPct = hasAnyPrevClose && totalPrevValue > 0 ? (totalTodayPnl / totalPrevValue) * 100 : null;

  // ── Top gainers / losers by daily $ ──────────────────────────────────────
  const withDollar = stats.filter(s => s.dailyChangeDollar != null) as (HoldingStats & { dailyChangeDollar: number })[];
  withDollar.sort((a, b) => b.dailyChangeDollar - a.dailyChangeDollar);
  const topGainers = withDollar.slice(0, 3);
  const topLosers = withDollar.slice(-3).reverse();

  // ── ZIV alerts ────────────────────────────────────────────────────────────
  const zivAlerts = stats.filter(s =>
    (s.zivScore != null && s.zivScore <= 3) ||
    (s.distToSL != null && s.distToSL >= 0 && s.distToSL <= 5)
  );

  // ── LLM End-of-Day Analysis ───────────────────────────────────────────────
  const statsSummary = stats.map(s =>
    `${s.ticker} [${s.source}]: price=$${s.price.toFixed(2)}, daily=${fmtPct(s.dailyChangePct)}, P&L=${fmtPct(s.pnlPct)}, ZIV=${s.zivScore ?? "N/A"}, SL=${s.stopLoss ? "$" + s.stopLoss.toFixed(2) : "none"}`
  ).join("\n");

  const llmPrompt = `You are ZIV, an expert trading analyst. Today's US market session has closed.

Portfolio holdings:
${statsSummary}

Today P&L: ${unifiedTodayPnl != null ? fmtUsd(unifiedTodayPnl) + " (" + fmtPct(unifiedTodayPct ?? 0) + ")" : "N/A"}

Provide a concise end-of-day assessment (max 200 words):
1. Overall session verdict (bullish/bearish/mixed)
2. Key risk positions to monitor tomorrow
3. Any immediate action items (e.g., adjust SL, reduce exposure)

Be direct and actionable. Use **bold** for ticker names.`;

  let aiAnalysis = "";
  try {
    const aiResp = await invokeLLM({
      messages: [
        { role: "system", content: "You are ZIV, a professional trading analyst. Be concise and actionable." },
        { role: "user", content: llmPrompt },
      ],
    });
    aiAnalysis = (aiResp?.choices?.[0]?.message?.content as string) ?? "";
  } catch (e) {
    aiAnalysis = "AI analysis unavailable.";
  }

  // ── Build Telegram message ────────────────────────────────────────────────
  const dateStr = new Date().toLocaleDateString("he-IL", {
    timeZone: "Asia/Jerusalem",
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const timeStr = new Date().toLocaleTimeString("he-IL", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
  });

  const lines: string[] = [
    `🌙 <b>trade-snow2.vip — End-of-Day Summary</b>`,
    `<i>${dateStr} · ${timeStr}</i>`,
    ``,
  ];

  // Today P&L
  if (unifiedTodayPnl != null) {
    const pnlEmoji = unifiedTodayPnl >= 0 ? "📈" : "📉";
    lines.push(`${pnlEmoji} <b>Today P&L (H1+H2):</b> ${fmtUsd(unifiedTodayPnl)} (${fmtPct(unifiedTodayPct ?? 0)})`);
    lines.push(``);
  }

  // Top gainers
  if (topGainers.length > 0) {
    lines.push(`<b>🏆 Top Gainers:</b>`);
    for (const g of topGainers) {
      lines.push(`🟢 <b>${g.ticker}</b> [${g.source}] ${fmtPct(g.dailyChangePct)} · ${fmtUsd(g.dailyChangeDollar)}`);
    }
    lines.push(``);
  }

  // Top losers
  if (topLosers.length > 0) {
    lines.push(`<b>⚠️ Top Losers:</b>`);
    for (const l of topLosers) {
      lines.push(`🔴 <b>${l.ticker}</b> [${l.source}] ${fmtPct(l.dailyChangePct)} · ${fmtUsd(l.dailyChangeDollar)}`);
    }
    lines.push(``);
  }

  // ZIV alerts
  if (zivAlerts.length > 0) {
    lines.push(`<b>🚨 ZIV Alerts:</b>`);
    for (const a of zivAlerts) {
      const reasons: string[] = [];
      if (a.zivScore != null && a.zivScore <= 3) reasons.push(`ZIV score: ${a.zivScore}`);
      if (a.distToSL != null && a.distToSL >= 0 && a.distToSL <= 5) reasons.push(`${a.distToSL.toFixed(1)}% from SL`);
      lines.push(`⚡ <b>${a.ticker}</b> [${a.source}] — ${reasons.join(", ")}`);
    }
    lines.push(``);
  }

  // AI analysis
  lines.push(`<b>🤖 ZIV End-of-Day Analysis:</b>`);
  const safeAI = aiAnalysis
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
  lines.push(safeAI);

  lines.push(``);
  lines.push(`<a href="https://trade-snow2.vip">פתח Trade Manager →</a>`);

  const msg = lines.join("\n");

  // Telegram 4096 char limit — split if needed
  if (msg.length <= 4096) {
    await sendTelegramMessage(msg, chatId);
  } else {
    const mid = Math.floor(msg.length / 2);
    const split = msg.lastIndexOf("\n", mid);
    await sendTelegramMessage(msg.slice(0, split), chatId);
    await sendTelegramMessage(msg.slice(split + 1), chatId);
  }

  return `sent EOD summary: ${stats.length} holdings, ${zivAlerts.length} ZIV alerts`;
}

export function registerEndOfDaySummaryRoute(app: Express): void {
  app.post("/api/scheduled/end-of-day-summary", async (req: Request, res: Response) => {
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

    try {
      const result = await runEndOfDaySummary();
      res.json({ ok: true, result });
    } catch (err) {
      console.error("[EndOfDaySummary] Error:", err);
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
}
