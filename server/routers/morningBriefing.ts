/**
 * Morning Briefing — POST /api/scheduled/morning-briefing
 *
 * Called by the Manus scheduled task every morning at 08:00 Israel time.
 * Fetches H1 + H2 holdings for the owner, live prices, ZIV H scores,
 * and SL proximity, then sends a rich Telegram message.
 *
 * Auth: requires a valid app_session_id cookie (user role is sufficient).
 */

import type { Express, Request, Response } from "express";
import { getDb, getUserByOpenId } from "../db";
import { portfolioHoldings, holding2 } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { fetchLivePricesBatch } from "../marketData";
import { sendTelegramMessage } from "../telegram";
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
  return 1; // fallback
}

/** Format a number as $X,XXX */
function fmtUsd(n: number): string {
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** Format P&L with sign */
function fmtPct(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

async function runMorningBriefing(): Promise<string> {
  const db = await getDb();
  if (!db) return "❌ DB unavailable";

  const ownerUserId = await getOwnerUserId();
  const chatId = OWNER_CHAT_ID;
  if (!chatId) return "❌ TELEGRAM_CHAT_ID not set";

  // ── Fetch H1 holdings ────────────────────────────────────────────────────
  const h1Holdings = await db
    .select()
    .from(portfolioHoldings)
    .where(eq(portfolioHoldings.userId, ownerUserId));

  // ── Fetch H2 holdings ────────────────────────────────────────────────────
  const h2Holdings = await db
    .select()
    .from(holding2)
    .where(eq(holding2.userId, ownerUserId));

  if (h1Holdings.length === 0 && h2Holdings.length === 0) {
    await sendTelegramMessage("📭 <b>Morning Briefing</b>\nאין פוזיציות פתוחות כרגע.", chatId);
    return "sent: no holdings";
  }

  // ── Batch-fetch live prices ───────────────────────────────────────────────
  const allTickers = Array.from(new Set([
    ...h1Holdings.map((h: { ticker: string }) => h.ticker),
    ...h2Holdings.map((h: { ticker: string }) => h.ticker),
  ]));
  const livePricesMap = await fetchLivePricesBatch(allTickers);

  // ── Build H1 rows ─────────────────────────────────────────────────────────
  let h1Value = 0, h1Cost = 0;
  const h1Rows: string[] = [];
  const slWarnings: string[] = [];

  for (const h of h1Holdings) {
    const lp = livePricesMap.get(h.ticker.toUpperCase()) ?? livePricesMap.get(h.ticker);
    const price = lp?.price ?? h.currentPrice ?? h.buyPrice;
    const dailyPct = lp?.changePercent ?? h.dailyChangePercent ?? 0;
    const value = price * h.units;
    const cost = (h.buyPrice ?? price) * h.units;
    const pnlPct = h.buyPrice ? ((price - h.buyPrice) / h.buyPrice) * 100 : 0;
    const pnlUsd = value - cost;

    h1Value += value;
    h1Cost += cost;

    const dailyEmoji = dailyPct >= 0 ? "🟢" : "🔴";
    const pnlEmoji = pnlPct >= 0 ? "✅" : "⚠️";

    let row = `${dailyEmoji} <b>${h.ticker}</b> ${fmtPct(dailyPct)} today`;
    row += `\n   ${pnlEmoji} P&L: ${fmtPct(pnlPct)} (${fmtUsd(pnlUsd)}) · Val: ${fmtUsd(value)}`;

    // SL proximity warning
    if (h.stopLoss && h.stopLoss > 0) {
      const slDistPct = ((price - h.stopLoss) / price) * 100;
      if (slDistPct < 5) {
        const slEmoji = slDistPct < 2 ? "🚨" : "⚠️";
        row += `\n   ${slEmoji} SL: $${h.stopLoss.toFixed(2)} — ${slDistPct.toFixed(1)}% away`;
        slWarnings.push(`${slEmoji} <b>${h.ticker}</b> (H1) — SL $${h.stopLoss.toFixed(2)}, רק ${slDistPct.toFixed(1)}% מהמחיר`);
      }
    }

    h1Rows.push(row);
  }

  // ── Build H2 rows ─────────────────────────────────────────────────────────
  let h2Value = 0, h2Cost = 0;
  const h2Rows: string[] = [];

  for (const h of h2Holdings) {
    const lp = livePricesMap.get(h.ticker.toUpperCase()) ?? livePricesMap.get(h.ticker);
    const price = lp?.price ?? h.currentPrice ?? h.buyPrice;
    const dailyPct = lp?.changePercent ?? 0;
    const value = price * h.units;
    const cost = h.buyPrice * h.units;
    const pnlPct = ((price - h.buyPrice) / h.buyPrice) * 100;
    const pnlUsd = value - cost;

    h2Value += value;
    h2Cost += cost;

    const dailyEmoji = dailyPct >= 0 ? "🟢" : "🔴";
    const pnlEmoji = pnlPct >= 0 ? "✅" : "⚠️";

    const row = `${dailyEmoji} <b>${h.ticker}</b> ${fmtPct(dailyPct)} today`
      + `\n   ${pnlEmoji} P&L: ${fmtPct(pnlPct)} (${fmtUsd(pnlUsd)}) · Val: ${fmtUsd(value)}`;
    h2Rows.push(row);
  }

  // ── Combined totals ───────────────────────────────────────────────────────
  const totalValue = h1Value + h2Value;
  const totalCost = h1Cost + h2Cost;
  const totalPnlPct = totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0;
  const totalPnlUsd = totalValue - totalCost;

  const h1PnlPct = h1Cost > 0 ? ((h1Value - h1Cost) / h1Cost) * 100 : 0;
  const h2PnlPct = h2Cost > 0 ? ((h2Value - h2Cost) / h2Cost) * 100 : 0;

  const dateStr = new Date().toLocaleDateString("he-IL", {
    timeZone: "Asia/Jerusalem",
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  // ── Compose message ───────────────────────────────────────────────────────
  const lines: string[] = [
    `☀️ <b>trade-snow2.vip — Morning Briefing</b>`,
    `<i>${dateStr}</i>`,
    ``,
  ];

  if (h1Rows.length > 0) {
    lines.push(`<b>── H1 Portfolio (${h1Holdings.length} פוזיציות) ──</b>`);
    lines.push(h1Rows.join("\n\n"));
    lines.push(`<i>H1 Total: ${fmtUsd(h1Value)} · P&L: ${fmtPct(h1PnlPct)}</i>`);
    lines.push(``);
  }

  if (h2Rows.length > 0) {
    lines.push(`<b>── H2 Portfolio (${h2Holdings.length} פוזיציות) ──</b>`);
    lines.push(h2Rows.join("\n\n"));
    lines.push(`<i>H2 Total: ${fmtUsd(h2Value)} · P&L: ${fmtPct(h2PnlPct)}</i>`);
    lines.push(``);
  }

  lines.push(`━━━━━━━━━━━━━━━━━━`);
  lines.push(`💼 <b>שווי כולל H1+H2:</b> ${fmtUsd(totalValue)}`);
  lines.push(`💰 <b>P&L כולל:</b> ${fmtPct(totalPnlPct)} (${fmtUsd(totalPnlUsd)})`);

  if (slWarnings.length > 0) {
    lines.push(``);
    lines.push(`🚨 <b>אזהרות SL:</b>`);
    lines.push(slWarnings.join("\n"));
  }

  lines.push(``);
  lines.push(`<a href="https://trade-snow2.vip">פתח Trade Manager →</a>`);

  const msg = lines.join("\n");
  await sendTelegramMessage(msg, chatId);
  return `sent: ${h1Holdings.length} H1 + ${h2Holdings.length} H2 holdings`;
}

export function registerMorningBriefingRoute(app: Express): void {
  app.post("/api/scheduled/morning-briefing", async (req: Request, res: Response) => {
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

    try {
      const result = await runMorningBriefing();
      res.json({ ok: true, result });
    } catch (err) {
      console.error("[MorningBriefing] Error:", err);
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
}
