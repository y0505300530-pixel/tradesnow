/**
 * Nightly SL Re-sync — POST /api/scheduled/nightly-sl-resync
 *
 * Runs daily at 06:00 UTC (09:00 Israel time) via Manus Scheduled Task.
 * Re-computes SL/TP for every active H1 and H2 holding using the Ziv Engine
 * (EMA-50 guard + 8% floor), then writes the updated values back to:
 *   - portfolioHoldings.stopLoss / takeProfit
 *   - holding2.stopLoss / takeProfit  (if columns exist)
 *   - priceAlerts (upsert — resets triggered=0 only if SL changed by >0.5%)
 *
 * Auth: requires a valid app_session_id cookie (user role is sufficient).
 */
import type { Express, Request, Response } from "express";
import { getDb, getUserByOpenId, upsertHoldingAlert } from "../db";
import { portfolioHoldings, holding2, priceAlerts } from "../../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { fetchBarsBatch, normalizeBarsForTicker } from "../marketData";
import { calcZivEngineScore, type Bar } from "../zivEngine";
import { calcSlTp, calcHoldingSlTp } from "../slCalculator";
import { sendTelegramMessage } from "../telegram";
import { sdk } from "../_core/sdk";
import { ENV } from "../_core/env";
import { swrInvalidate } from "../swrCache";

const CHANGE_THRESHOLD_PCT = 0.005; // only re-arm if SL changed by > 0.5%

interface ResyncResult {
  updated: number;
  skipped: number;
  errors: string[];
  changes: Array<{ ticker: string; portfolio: "H1" | "H2"; oldSl: number | null; newSl: number; slSource: string }>;
}

async function runNightlySlResync(userId: number): Promise<ResyncResult> {
  const db = await getDb();
  if (!db) return { updated: 0, skipped: 0, errors: ["DB unavailable"], changes: [] };

  // ── Load H1 holdings ──────────────────────────────────────────────────────
  const h1Holdings = await db
    .select()
    .from(portfolioHoldings)
    .where(eq(portfolioHoldings.userId, userId));

  // ── Load H2 holdings ──────────────────────────────────────────────────────
  const h2Holdings = await db
    .select()
    .from(holding2)
    .where(eq(holding2.userId, userId));

  const activeH1 = h1Holdings.filter((h: any) => (h.units ?? 0) !== 0);
  const activeH2 = h2Holdings.filter((h: any) => (h.units ?? 0) !== 0);

  if (activeH1.length === 0 && activeH2.length === 0) {
    return { updated: 0, skipped: 0, errors: [], changes: [] };
  }

  // ── Batch-fetch bars for all tickers (parallel, 15-min cache) ─────────────
  const allTickers = Array.from(new Set([
    ...activeH1.map((h: any) => h.ticker),
    ...activeH2.map((h: any) => h.ticker),
  ]));
  const barsMap = await fetchBarsBatch(allTickers);

  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];
  const changes: ResyncResult["changes"] = [];

  // ── Process H1 ────────────────────────────────────────────────────────────
  for (const h of activeH1) {
    try {
      const rawBars = (barsMap.get(h.ticker) ?? []) as Bar[];
      const bars = normalizeBarsForTicker(h.ticker, rawBars);
      if (bars.length < 50) { skipped++; continue; }

      const ziv = calcZivEngineScore(bars);
      const units = Number(h.units ?? 0);
      const { stopLoss, takeProfit, slSource } = calcHoldingSlTp(h.buyPrice as number, ziv.ema50, units, bars);

      // Change-detection guard
      const existingSl = (h.stopLoss ?? 0) as number;
      const changePct = existingSl > 0
        ? Math.abs(stopLoss - existingSl) / existingSl
        : 1;

      if (changePct < CHANGE_THRESHOLD_PCT) { skipped++; continue; }

      // Update portfolioHoldings row
      await db.update(portfolioHoldings)
        .set({ stopLoss, takeProfit } as any)
        .where(eq(portfolioHoldings.id, h.id));

      // Upsert SL + TP alerts (resets triggered=0)
      await upsertHoldingAlert(userId, h.ticker, "sl", stopLoss);
      await upsertHoldingAlert(userId, h.ticker, "tp", takeProfit);

      changes.push({ ticker: h.ticker, portfolio: "H1", oldSl: existingSl || null, newSl: stopLoss, slSource });
      updated++;
    } catch (err) {
      errors.push(`H1/${h.ticker}: ${String(err)}`);
    }
  }

  // ── Process H2 ────────────────────────────────────────────────────────────
  for (const h of activeH2) {
    try {
      const rawBars2 = (barsMap.get(h.ticker) ?? []) as Bar[];
      const bars = normalizeBarsForTicker(h.ticker, rawBars2);
      if (bars.length < 50) { skipped++; continue; }

      const ziv = calcZivEngineScore(bars);
      const units = Number(h.units ?? 0);
      const { stopLoss, takeProfit, slSource } = calcHoldingSlTp(h.buyPrice as number, ziv.ema50, units, bars);

      // holding2 has no stopLoss column — compare against existing alert target
      const existingAlerts = await db
        .select({ targetPrice: priceAlerts.targetPrice })
        .from(priceAlerts)
        .where(and(eq(priceAlerts.userId, userId), eq(priceAlerts.ticker, h.ticker), eq(priceAlerts.alertType, "sl"), eq(priceAlerts.dismissed, 0)))
        .limit(1);
      const existingSl = existingAlerts[0] ? Number(existingAlerts[0].targetPrice) : 0;
      const changePct = existingSl > 0
        ? Math.abs(stopLoss - existingSl) / existingSl
        : 1;

      if (changePct < CHANGE_THRESHOLD_PCT) { skipped++; continue; }

      // Upsert SL + TP alerts (resets triggered=0)
      await upsertHoldingAlert(userId, h.ticker, "sl", stopLoss);
      await upsertHoldingAlert(userId, h.ticker, "tp", takeProfit);

      changes.push({ ticker: h.ticker, portfolio: "H2", oldSl: existingSl || null, newSl: stopLoss, slSource });
      updated++;
    } catch (err) {
      errors.push(`H2/${h.ticker}: ${String(err)}`);
    }
  }

  // ── Telegram summary ──────────────────────────────────────────────────────
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (chatId && updated > 0) {
    const changeLines = changes.map(c =>
      `  • <b>${c.ticker}</b> (${c.portfolio}): SL ${c.oldSl != null ? `$${Number(c.oldSl).toFixed(2)} → ` : ""}$${Number(c.newSl).toFixed(2)} <i>[${c.slSource}]</i>`
    ).join("\n");

    const msg = [
      `🔄 <b>trade-snow2.vip — Nightly SL Re-sync</b>`,
      ``,
      `✅ Updated: <b>${updated}</b> holdings`,
      `⏭ Skipped (no change): <b>${skipped}</b>`,
      errors.length > 0 ? `⚠️ Errors: ${errors.join(", ")}` : null,
      ``,
      `<b>Changes:</b>`,
      changeLines,
    ].filter(l => l !== null).join("\n");

    await sendTelegramMessage(msg, chatId).catch(() => {});
  }

  return { updated, skipped, errors, changes };
}

export function registerNightlySlResyncRoute(app: Express): void {
  app.post("/api/scheduled/nightly-sl-resync", async (req: Request, res: Response) => {
    let user = null;
    try { user = await sdk.authenticateRequest(req); } catch { /* fall through */ }
    if (!user) { res.status(401).json({ ok: false, error: "Unauthorized" }); return; }

    try {
      let targetUserId = user.id;
      if (ENV.ownerOpenId) {
        const ownerUser = await getUserByOpenId(ENV.ownerOpenId);
        if (ownerUser?.id) targetUserId = ownerUser.id;
      }
      const result = await runNightlySlResync(targetUserId);
      // Invalidate the portfolio state SWR cache so the next getState call returns fresh SL/TP
      swrInvalidate(`portfolio:state:${targetUserId}`);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[NightlySlResync] Error:", err);
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
}

// Export for one-time restoration migration
export { runNightlySlResync };
