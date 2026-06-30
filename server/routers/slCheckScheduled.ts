/**
 * SL Check Scheduled Endpoint — POST /api/scheduled/sl-check
 *
 * Called every 15 minutes by an external Manus Scheduled Task during active trading hours.
 *
 * Smart Abort:
 *   - Both US and TASE closed → skip
 *   - Only one market open → check that market's tickers only
 *
 * Zero Noise Filter:
 *   PATH 1 — H1/H2 Holdings (alertType = "sl" | "tp"):
 *     → ALWAYS send Telegram. Risk management events are never muted.
 *     → zivScore stored as null (not applicable for SL/TP).
 *
 *   PATH 2 — Asset Catalogue (alertType = "custom"):
 *     → Always mark TRIGGERED + store zivScore in DB.
 *     → Ziv >= 8.0 → send Telegram (⚡ if Ziv == 10).
 *     → Ziv < 8.0 → silent trigger: DB updated, archived immediately, no Telegram.
 *
 * 48h Stale Cleanup:
 *   At the start of every run, any triggered alert with triggeredAt > 48h ago
 *   that is not yet archived gets moved to archive automatically.
 *
 * Anti-Duplicate:
 *   lastAlertSentAt is set on every trigger (even silent ones) so the 24h
 *   anti-spam dedup in alertPoller.ts prevents double-sending.
 */
import type { Express, Request, Response } from "express";
import { getDb, getUserByOpenId } from "../db";
import { priceAlerts, userSettings, userAssets } from "../../drizzle/schema";
import { eq, and, inArray, isNull, lt } from "drizzle-orm";
import { fetchLivePricesBatch } from "../marketData";
import { sendTelegramMessage, formatAlertMessage } from "../telegram";
import { isUsClosed, isTaseClosed, getExchange } from "../utils/marketHours";
import { sdk } from "../_core/sdk";
import { ENV } from "../_core/env";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ZIV_SCORE_THRESHOLD = 8.0;
const STALE_HOURS = 48;

type SlCheckStatus = "ok" | "skipped" | "no_alerts";

interface SlCheckResult {
  status: SlCheckStatus;
  reason?: string;
  checked?: number;
  triggered?: number;
  silenced?: number;
  archived?: number;
  usOpen?: boolean;
  taseOpen?: boolean;
}

/** Archive triggered alerts older than 48h that haven't been archived yet */
async function archiveStaleAlerts(db: Awaited<ReturnType<typeof getDb>>): Promise<number> {
  if (!db) return 0;
  const cutoff = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000);
  try {
    const result = await db.update(priceAlerts)
      .set({ archivedAt: new Date() })
      .where(and(
        eq(priceAlerts.triggered, 1),
        isNull(priceAlerts.archivedAt),
        lt(priceAlerts.triggeredAt, cutoff)
      ));
    return (result as any)[0]?.affectedRows ?? 0;
  } catch {
    return 0;
  }
}

async function runSlCheck(userId: number): Promise<SlCheckResult> {
  const now = new Date();
  const usClosed = isUsClosed(now);
  const taseClosed = isTaseClosed(now);

  if (usClosed && taseClosed) {
    return { status: "skipped", reason: "markets closed", usOpen: false, taseOpen: false };
  }

  const usOpen = !usClosed;
  const taseOpen = !taseClosed;

  const db = await getDb();
  if (!db) return { status: "skipped", reason: "DB unavailable" };

  // ── Step 1: Archive stale triggered alerts (>48h) ────────────────────────
  const archived = await archiveStaleAlerts(db);
  if (archived > 0) {
    console.log(`[SlCheck] Archived ${archived} stale alerts (>48h)`);
  }

  // ── Step 2: Load active (untriggered, undismissed, unarchived) alerts ────
  const activeAlerts = await db
    .select({
      id: priceAlerts.id,
      userId: priceAlerts.userId,
      ticker: priceAlerts.ticker,
      alertType: priceAlerts.alertType,
      targetPrice: priceAlerts.targetPrice,
      direction: priceAlerts.direction,
      label: priceAlerts.label,
      lastAlertSentAt: priceAlerts.lastAlertSentAt, // needed for 24h dedup
    })
    .from(priceAlerts)
    .where(and(
      eq(priceAlerts.triggered, 0),
      eq(priceAlerts.dismissed, 0),
      isNull(priceAlerts.archivedAt)
    ));

  if (activeAlerts.length === 0) {
    return { status: "no_alerts", usOpen, taseOpen, archived };
  }

  // Filter by open market
  const filteredAlerts = activeAlerts.filter((a: { ticker: string }) => {
    const exchange = getExchange(a.ticker);
    if (exchange === "TASE") return taseOpen;
    return usOpen;
  });

  if (filteredAlerts.length === 0) {
    return { status: "skipped", reason: "no alerts for open markets", usOpen, taseOpen, archived };
  }

  // ── Step 3: Batch-fetch live prices ──────────────────────────────────────
  const uniqueTickers = Array.from(new Set(filteredAlerts.map((a: { ticker: string }) => a.ticker)));
  const livePricesMap = await fetchLivePricesBatch(uniqueTickers);

  const priceMap = new Map<string, number>();
  const changePctMap = new Map<string, number | null>();
  for (const [ticker, lp] of Array.from(livePricesMap.entries())) {
    if (lp?.price != null) {
      priceMap.set(ticker.toUpperCase(), lp.price);
      changePctMap.set(ticker.toUpperCase(), lp.changePercent ?? null);
    }
  }

  // ── Step 4: Fetch Ziv Scores for Catalogue tickers ───────────────────────
  const catalogueTickers = Array.from(new Set(
    filteredAlerts
      .filter((a: { alertType: string }) => a.alertType === "custom")
      .map((a: { ticker: string }) => a.ticker.toUpperCase())
  ));

  const zivScoreMap = new Map<string, number | null>();
  if (catalogueTickers.length > 0) {
    try {
      const assetRows = await db
        .select({ ticker: userAssets.ticker, score: userAssets.score })
        .from(userAssets)
        .where(and(
          eq(userAssets.userId, userId),
          inArray(userAssets.ticker, catalogueTickers)
        ));
      for (const row of assetRows) {
        zivScoreMap.set(row.ticker.toUpperCase(), row.score ?? null);
      }
    } catch {
      // Non-fatal: default to muting catalogue alerts if scores unavailable
    }
  }

  // ── Step 5: Load Telegram settings ───────────────────────────────────────
  const userIds = Array.from(new Set(filteredAlerts.map((a: { userId: number }) => a.userId)));
  const settingsRows = await db
    .select({ userId: userSettings.userId, telegramChatId: userSettings.telegramChatId })
    .from(userSettings)
    .where(eq(userSettings.telegramEnabled, 1));

  const settingsMap = new Map<number, string | null>();
  for (const s of settingsRows) settingsMap.set(s.userId, s.telegramChatId);

  let triggered = 0;
  let silenced = 0;

  // ── Step 6: Check each alert ──────────────────────────────────────────────
  for (const alert of filteredAlerts) {
    const currentPrice = priceMap.get(alert.ticker.toUpperCase());
    if (currentPrice == null) continue;

    const target = Number(alert.targetPrice);
    const dir = alert.direction as "below" | "above";
    const hit = dir === "below" ? currentPrice <= target : currentPrice >= target;
    if (!hit) continue;
    const alertType = alert.alertType as "sl" | "tp" | "custom";
    const zivScore = alertType === "custom"
      ? (zivScoreMap.get(alert.ticker.toUpperCase()) ?? null)
      : null; // SL/TP don't need a Ziv score
    // ── 24h Anti-Spam Dedup ──────────────────────────────────────────────────────────────────────────────────────
    // ── UNIFIED SIGNAL: Custom (BUY) alerts no longer send Telegram here ──────────
    // BUY signals are now sent exclusively from HourlyAnalyze via hotSignal.
    // Custom alerts are silently archived. SL/TP personal alerts still fire below.
    if (alertType === "custom") {
      await db.update(priceAlerts)
        .set({
          triggered: 1,
          triggeredAt: new Date(),
          triggeredPrice: currentPrice,
          zivScore,
          archivedAt: new Date(),
        })
        .where(eq(priceAlerts.id, alert.id));
      silenced++;
      continue;
    }
    // ── SL/TP alerts: mark triggered and send Telegram ───────────────────────────
    await db.update(priceAlerts)
      .set({
        triggered: 1,
        triggeredAt: new Date(),
        triggeredPrice: currentPrice,
        zivScore,
        lastAlertSentAt: new Date(),
      })
      .where(eq(priceAlerts.id, alert.id));
    triggered++;
    const chatId = settingsMap.get(alert.userId) ?? (userIds.includes(alert.userId) ? OWNER_CHAT_ID : null);
    if (chatId && BOT_TOKEN) {
      const msg = formatAlertMessage({
        ticker: alert.ticker,
        alertType,
        targetPrice: target,
        currentPrice,
        changePercent: changePctMap.get(alert.ticker.toUpperCase()) ?? null,
        zivScore: zivScore ?? null,
      });
      await sendTelegramMessage(msg, chatId).catch(() => {});
      console.log(`[SlCheck] Sent ${alertType.toUpperCase()} alert for ${alert.ticker} @ $${currentPrice} Ziv=${zivScore ?? "N/A"}`);
    }
  }

  return { status: "ok", checked: filteredAlerts.length, triggered, silenced, archived, usOpen, taseOpen };
}

export function registerSlCheckRoute(app: Express): void {
  app.post("/api/scheduled/sl-check", async (req: Request, res: Response) => {
    let user = null;
    try { user = await sdk.authenticateRequest(req); } catch { /* fall through */ }
    if (!user) { res.status(401).json({ ok: false, error: "Unauthorized" }); return; }

    try {
      let targetUserId = user.id;
      if (ENV.ownerOpenId) {
        const ownerUser = await getUserByOpenId(ENV.ownerOpenId);
        if (ownerUser?.id) targetUserId = ownerUser.id;
      }
      const result = await runSlCheck(targetUserId);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[SlCheck] Error:", err);
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
}
