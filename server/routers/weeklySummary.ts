/**
 * Weekly Summary — POST /api/scheduled/weekly-summary
 *
 * Triggered every Friday at 23:15 Israel time (20:15 UTC).
 * Sends a Telegram message with:
 *   1. Weekly P&L — derived from DB snapshots (Friday close vs last Friday close)
 *   2. Today (Friday) P&L from live prices
 *   3. Top weekly performers: gainers & losers (from holdingsSnapshot diff)
 *   4. Portfolio health: ZIV alerts, SL proximity
 *   5. LLM next-week recommendations for each holding
 *
 * Auth: requires a valid app_session_id cookie (user role is sufficient).
 */

import type { Express, Request, Response } from "express";
import { getDb, getUserByOpenId } from "../db";
import { portfolioHoldings, holding2, portfolioSnapshots } from "../../drizzle/schema";
import { eq, and, gt, gte, lte, desc } from "drizzle-orm";
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

/** Get YYYY-MM-DD string for N days ago */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function runWeeklySummary(): Promise<string> {
  const db = await getDb();
  if (!db) return "❌ DB unavailable";

  const chatId = OWNER_CHAT_ID;
  if (!chatId) return "❌ TELEGRAM_CHAT_ID not set";

  const ownerUserId = await getOwnerUserId();

  // ── Fetch all active holdings ─────────────────────────────────────────────
  const [h1Holdings, h2Holdings] = await Promise.all([
    db.select().from(portfolioHoldings).where(eq(portfolioHoldings.userId, ownerUserId)),
    db.select().from(holding2).where(and(eq(holding2.userId, ownerUserId), gt(holding2.units, 0))),
  ]);

  const activeH1 = h1Holdings.filter((h: any) => h.units !== 0);

  // ── Batch live prices ─────────────────────────────────────────────────────
  const allTickers = Array.from(new Set([
    ...activeH1.map((h: any) => h.ticker as string),
    ...h2Holdings.map((h: any) => h.ticker as string),
  ]));

  const livePricesMap = await fetchLivePricesBatch(allTickers);

  // ── Weekly P&L from DB snapshots ──────────────────────────────────────────
  // Get today's snapshot and the snapshot from ~7 days ago
  const todayStr = new Date().toISOString().slice(0, 10);
  const weekAgoStr = daysAgo(7);

  const snapshots = await db.select()
    .from(portfolioSnapshots)
    .where(and(
      eq(portfolioSnapshots.userId, ownerUserId),
      gte(portfolioSnapshots.snapshotDate, weekAgoStr),
      lte(portfolioSnapshots.snapshotDate, todayStr)
    ))
    .orderBy(desc(portfolioSnapshots.snapshotDate));

  // Most recent snapshot = this week's end value
  const latestSnap = snapshots[0] ?? null;
  // Oldest snapshot in the 7-day window = last week's end value
  const oldestSnap = snapshots[snapshots.length - 1] ?? null;

  let weeklyPnlUsd: number | null = null;
  let weeklyPnlPct: number | null = null;
  let weekStartValue: number | null = null;
  let weekEndValue: number | null = null;

  if (latestSnap && oldestSnap && latestSnap.snapshotDate !== oldestSnap.snapshotDate) {
    // Use totalEquity (IBKR Net Liq) if available, else totalValue
    weekEndValue = latestSnap.totalEquity ?? latestSnap.totalValue;
    weekStartValue = oldestSnap.totalEquity ?? oldestSnap.totalValue;
    weeklyPnlUsd = weekEndValue - weekStartValue;
    weeklyPnlPct = weekStartValue > 0 ? (weeklyPnlUsd / weekStartValue) * 100 : null;
  }

  // ── Today P&L from live prices ────────────────────────────────────────────
  let todayPnlUsd: number | null = null;
  let todayPnlPct: number | null = null;
  {
    let totalToday = 0;
    let totalPrev = 0;
    let hasData = false;
    for (const h of [...activeH1, ...h2Holdings]) {
      const lp = livePricesMap.get((h.ticker as string).toUpperCase()) ?? livePricesMap.get(h.ticker as string);
      if (!lp?.price) continue;
      const prevClose = lp.prevClose ?? (lp.change != null ? lp.price - lp.change : null);
      if (prevClose == null || prevClose <= 0) continue;
      const units = (h as any).units as number;
      totalToday += (lp.price - prevClose) * units;
      totalPrev += prevClose * units;
      hasData = true;
    }
    if (hasData && totalPrev > 0) {
      todayPnlUsd = totalToday;
      todayPnlPct = (totalToday / totalPrev) * 100;
    }
  }

  // ── Per-holding weekly performance (from holdingsSnapshot diff) ───────────
  interface HoldingPerf {
    ticker: string;
    source: "H1" | "H2";
    units: number;
    currentPrice: number;
    weeklyChangePct: number | null;
    weeklyChangeDollar: number | null;
    pnlPct: number;
    stopLoss: number | null;
    zivScore: number | null;
    distToSL: number | null;
  }

  // Build a map of ticker → price from the oldest snapshot's holdingsSnapshot JSON
  const oldPriceMap: Record<string, number> = {};
  if (oldestSnap?.holdingsSnapshot) {
    try {
      const snapshotHoldings = JSON.parse(oldestSnap.holdingsSnapshot) as Array<{ ticker: string; currentPrice: number }>;
      for (const sh of snapshotHoldings) {
        if (sh.ticker && sh.currentPrice) {
          oldPriceMap[sh.ticker.toUpperCase()] = sh.currentPrice;
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  const holdingPerfs: HoldingPerf[] = [];

  for (const h of activeH1) {
    const lp = livePricesMap.get((h.ticker as string).toUpperCase()) ?? livePricesMap.get(h.ticker as string);
    const price = lp?.price ?? (h as any).currentPrice ?? 0;
    const oldPrice = oldPriceMap[(h.ticker as string).toUpperCase()] ?? null;
    const weeklyChangePct = oldPrice && oldPrice > 0 ? ((price - oldPrice) / oldPrice) * 100 : null;
    const weeklyChangeDollar = oldPrice != null ? (price - oldPrice) * (h as any).units : null;
    const pnlPct = (h as any).buyPrice ? ((price - (h as any).buyPrice) / (h as any).buyPrice) * 100 : 0;
    const sl = (h as any).stopLoss ?? null;
    const distToSL = sl != null && price > 0 ? ((price - sl) / price) * 100 : null;
    holdingPerfs.push({
      ticker: h.ticker as string,
      source: "H1",
      units: (h as any).units,
      currentPrice: price,
      weeklyChangePct,
      weeklyChangeDollar,
      pnlPct,
      stopLoss: sl,
      zivScore: (h as any).zivScore ?? null,
      distToSL,
    });
  }

  for (const h of h2Holdings) {
    const lp = livePricesMap.get((h.ticker as string).toUpperCase()) ?? livePricesMap.get(h.ticker as string);
    const price = lp?.price ?? (h as any).currentPrice ?? 0;
    const oldPrice = oldPriceMap[(h.ticker as string).toUpperCase()] ?? null;
    const weeklyChangePct = oldPrice && oldPrice > 0 ? ((price - oldPrice) / oldPrice) * 100 : null;
    const weeklyChangeDollar = oldPrice != null ? (price - oldPrice) * (h as any).units : null;
    const pnlPct = (h as any).buyPrice ? ((price - (h as any).buyPrice) / (h as any).buyPrice) * 100 : 0;
    holdingPerfs.push({
      ticker: h.ticker as string,
      source: "H2",
      units: (h as any).units,
      currentPrice: price,
      weeklyChangePct,
      weeklyChangeDollar,
      pnlPct,
      stopLoss: null,
      zivScore: (h as any).zivScore ?? null,
      distToSL: null,
    });
  }

  // ── Top weekly gainers / losers ───────────────────────────────────────────
  const withWeekly = holdingPerfs.filter(h => h.weeklyChangeDollar != null) as (HoldingPerf & { weeklyChangeDollar: number })[];
  withWeekly.sort((a, b) => b.weeklyChangeDollar - a.weeklyChangeDollar);
  const topWeeklyGainers = withWeekly.slice(0, 3);
  const topWeeklyLosers = withWeekly.slice(-3).reverse();

  // ── ZIV alerts ────────────────────────────────────────────────────────────
  const zivAlerts = holdingPerfs.filter(h =>
    (h.zivScore != null && h.zivScore <= 3) ||
    (h.distToSL != null && h.distToSL >= 0 && h.distToSL <= 5)
  );

  // ── LLM next-week recommendations ────────────────────────────────────────
  const holdingsSummary = holdingPerfs.map(h =>
    `${h.ticker} [${h.source}]: price=$${h.currentPrice.toFixed(2)}, weekly=${h.weeklyChangePct != null ? fmtPct(h.weeklyChangePct) : "N/A"}, P&L=${fmtPct(h.pnlPct)}, ZIV=${h.zivScore ?? "N/A"}, SL=${h.stopLoss ? "$" + h.stopLoss.toFixed(2) : "none"}`
  ).join("\n");

  const weeklyPnlSummary = weeklyPnlUsd != null
    ? `Weekly P&L: ${fmtUsd(weeklyPnlUsd)} (${fmtPct(weeklyPnlPct ?? 0)})`
    : "Weekly P&L: N/A (no snapshots)";

  const llmPrompt = `You are ZIV, an expert trading analyst. The US market week has just closed (Friday).

Portfolio holdings:
${holdingsSummary}

${weeklyPnlSummary}
Today (Friday) P&L: ${todayPnlUsd != null ? fmtUsd(todayPnlUsd) + " (" + fmtPct(todayPnlPct ?? 0) + ")" : "N/A"}

Provide a concise weekly assessment and next-week plan (max 250 words):
1. Weekly verdict (strong/weak/mixed) and key drivers
2. Positions to strengthen next week (add to winners)
3. Positions to reduce or exit next week (cut losers)
4. Key levels to watch for each major holding

Be direct and actionable. Use **bold** for ticker names and action words (BUY/SELL/HOLD/WATCH).`;

  let aiAnalysis = "";
  try {
    const aiResp = await invokeLLM({
      messages: [
        { role: "system", content: "You are ZIV, a professional trading analyst. Be concise and actionable." },
        { role: "user", content: llmPrompt },
      ],
    });
    aiAnalysis = (aiResp?.choices?.[0]?.message?.content as string) ?? "";
  } catch {
    aiAnalysis = "AI analysis unavailable.";
  }

  // ── Build Telegram message ────────────────────────────────────────────────
  const dateStr = new Date().toLocaleDateString("he-IL", {
    timeZone: "Asia/Jerusalem",
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  const lines: string[] = [
    `📅 <b>trade-snow2.vip — Weekly Summary</b>`,
    `<i>${dateStr}</i>`,
    ``,
  ];

  // Weekly P&L
  if (weeklyPnlUsd != null) {
    const emoji = weeklyPnlUsd >= 0 ? "📈" : "📉";
    lines.push(`${emoji} <b>Weekly P&L:</b> ${fmtUsd(weeklyPnlUsd)} (${fmtPct(weeklyPnlPct ?? 0)})`);
    if (weekStartValue != null && weekEndValue != null) {
      lines.push(`   Portfolio: ${fmtUsd(weekStartValue).replace("+", "")} → $${Math.round(weekEndValue).toLocaleString("en-US")}`);
    }
  } else {
    lines.push(`📊 <b>Weekly P&L:</b> N/A (no snapshot data)`);
  }

  // Today P&L
  if (todayPnlUsd != null) {
    const emoji = todayPnlUsd >= 0 ? "🟢" : "🔴";
    lines.push(`${emoji} <b>Today (Friday):</b> ${fmtUsd(todayPnlUsd)} (${fmtPct(todayPnlPct ?? 0)})`);
  }
  lines.push(``);

  // Top weekly gainers
  if (topWeeklyGainers.length > 0) {
    lines.push(`<b>🏆 Top Weekly Gainers:</b>`);
    for (const g of topWeeklyGainers) {
      lines.push(`🟢 <b>${g.ticker}</b> [${g.source}] ${g.weeklyChangePct != null ? fmtPct(g.weeklyChangePct) : ""} · ${fmtUsd(g.weeklyChangeDollar)}`);
    }
    lines.push(``);
  }

  // Top weekly losers
  if (topWeeklyLosers.length > 0) {
    lines.push(`<b>⚠️ Top Weekly Losers:</b>`);
    for (const l of topWeeklyLosers) {
      lines.push(`🔴 <b>${l.ticker}</b> [${l.source}] ${l.weeklyChangePct != null ? fmtPct(l.weeklyChangePct) : ""} · ${fmtUsd(l.weeklyChangeDollar)}`);
    }
    lines.push(``);
  }

  // ZIV alerts
  if (zivAlerts.length > 0) {
    lines.push(`<b>🚨 ZIV Alerts Going Into Next Week:</b>`);
    for (const a of zivAlerts) {
      const reasons: string[] = [];
      if (a.zivScore != null && a.zivScore <= 3) reasons.push(`ZIV score: ${a.zivScore}`);
      if (a.distToSL != null && a.distToSL >= 0 && a.distToSL <= 5) reasons.push(`${a.distToSL.toFixed(1)}% from SL`);
      lines.push(`⚡ <b>${a.ticker}</b> [${a.source}] — ${reasons.join(", ")}`);
    }
    lines.push(``);
  }

  // AI analysis
  lines.push(`<b>🤖 ZIV Next-Week Plan:</b>`);
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

  return `sent weekly summary: ${holdingPerfs.length} holdings, ${zivAlerts.length} ZIV alerts, weekly P&L: ${weeklyPnlUsd != null ? fmtUsd(weeklyPnlUsd) : "N/A"}`;
}

export function registerWeeklySummaryRoute(app: Express): void {
  app.post("/api/scheduled/weekly-summary", async (req: Request, res: Response) => {
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
      const result = await runWeeklySummary();
      res.json({ ok: true, result });
    } catch (err) {
      console.error("[WeeklySummary] Error:", err);
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
}
