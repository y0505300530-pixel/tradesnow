/**
 * Price Alerts Router — SL/TP/Custom price alert management
 * Allows users to set price alerts for their holdings and watch-list assets.
 * The checkAlerts procedure compares current prices against alert targets.
 */
import { z } from "zod";
import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import {
  createPriceAlert,
  updatePriceAlert,
  getPriceAlerts,
  getActiveAlerts,
  getArchivedAlerts,
  getTriggeredUndismissedAlerts,
  triggerPriceAlert,
  dismissPriceAlert,
  deletePriceAlert,
  deletePriceAlertsForTicker,
  getUserSettings,
  upsertUserSettings,
  recycleArchivedAlert,
  recycleAllArchivedAlerts,
  getUserAssets,
  getDb,
} from "../db";
import { sendTelegramMessage } from "../telegram";
import { fetchLivePrice, fetchLivePricesBatch, fetchIbkrLivePricesBatch, fetchBarsBatch, getUsdIlsRate, normalizeBarsForTicker, type LivePrice } from "../marketData";
import { calcZivEngineScore, type Bar } from "../zivEngine";
import { calcSlTp, calcCatalogueAlertTarget } from "../slCalculator";
import { swrGet, swrInvalidate } from "../swrCache";
import { userAssets, portfolioHoldings, holding2, priceAlerts, breakoutScans } from "../../drizzle/schema";
import { eq, and, gte, isNull, inArray, isNotNull, desc } from "drizzle-orm";

export const priceAlertsRouter = router({
  // ── FAST: Get all alerts from DB only — no live prices, instant response (<100ms) ──
  // Live prices are fetched separately via getLivePrices.
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    return swrGet(
      `alerts:all:${userId}`,
      20_000, // TTL 20s — Price Alerts (near-live)
      async () => {
    const db = await getDb();

    // ── Auto-cleanup: delete SL/TP alerts for tickers no longer in H1/H2 ────
    let cleanedCount = 0;
    if (db) {
      try {
        const [h1Holdings, h2Holdings] = await Promise.all([
          db.select({ ticker: portfolioHoldings.ticker, units: portfolioHoldings.units })
            .from(portfolioHoldings).where(eq(portfolioHoldings.userId, userId)),
          db.select({ ticker: holding2.ticker, units: holding2.units })
            .from(holding2).where(eq(holding2.userId, userId)),
        ]);
        const activeTickers = new Set([
          ...h1Holdings.filter((h: any) => (h.units ?? 0) > 0).map((h: any) => h.ticker.toUpperCase()),
          ...h2Holdings.filter((h: any) => (h.units ?? 0) > 0).map((h: any) => h.ticker.toUpperCase()),
        ]);
        const allSlTpAlerts = await db.select({ id: priceAlerts.id, ticker: priceAlerts.ticker, alertType: priceAlerts.alertType })
          .from(priceAlerts)
          .where(eq(priceAlerts.userId, userId));
        const staleIds = allSlTpAlerts
          .filter((a: any) => (a.alertType === "sl" || a.alertType === "tp") && !activeTickers.has(a.ticker.toUpperCase()))
          .map((a: any) => a.id);
        if (staleIds.length > 0) {
          await db.delete(priceAlerts).where(inArray(priceAlerts.id, staleIds));
          cleanedCount = staleIds.length;
        }
      } catch { /* non-fatal */ }
    }

    const alerts = await getPriceAlerts(userId);

    // Enrich with ZIV scores from catalogue (DB-only, fast)
    const catalogueScoreMap = new Map<string, number | null>();
    if (db && alerts.length > 0) {
      try {
        const assetRows = await db
          .select({ ticker: userAssets.ticker, score: userAssets.score })
          .from(userAssets)
          .where(eq(userAssets.userId, userId));
        for (const row of assetRows) {
          catalogueScoreMap.set(row.ticker.toUpperCase(), row.score ?? null);
        }
      } catch { /* non-fatal */ }
    }

    const enriched = alerts.map(a => ({
      ...a,
      currentPrice: null as number | null,  // populated separately by getLivePrices
      zivScore: catalogueScoreMap.get(a.ticker.toUpperCase()) ?? a.zivScore ?? null,
    }));
    return { alerts: enriched, cleanedCount };
      }, // end swrGet fetcher
    );
  }),

  // ── LIVE PRICES: fetch current prices for a list of tickers ──────────────
  // Called separately after getAll renders — uses IBKR cache first, Yahoo fallback.
  // Returns a map of ticker → price (only tickers with a valid price are included).
  getLivePrices: protectedProcedure
    .input(z.object({ tickers: z.array(z.string()) }))
    .query(async ({ input }) => {
      const tickers = Array.from(new Set(input.tickers.filter(t => t.length > 0)));
      if (tickers.length === 0) return { prices: {} };

      const priceMap: Record<string, number> = {};

      // Step 1: Try IBKR in-memory cache first (instant, 15s TTL)
      const ibkrResults = await fetchIbkrLivePricesBatch(tickers).catch(() => new Map<string, LivePrice | null>());
      const yahooNeeded: string[] = [];
      for (const ticker of tickers) {
        const ibkrData = ibkrResults.get(ticker);
        if (ibkrData?.price) {
          priceMap[ticker] = ibkrData.price;
        } else {
          yahooNeeded.push(ticker);
        }
      }

      // Step 2: Yahoo Finance only for tickers not in IBKR cache
      // Run ALL Yahoo fetches in parallel (Promise.all) — no sequential delays
      if (yahooNeeded.length > 0) {
        try {
          const yahooPromises = yahooNeeded.map(ticker =>
            fetchLivePrice(ticker).then(data => ({ ticker, data })).catch(() => ({ ticker, data: null }))
          );
          const yahooResults = await Promise.all(yahooPromises);
          for (const { ticker, data } of yahooResults) {
            if (data?.price) priceMap[ticker] = data.price;
          }
        } catch { /* non-fatal */ }
      }

      return { prices: priceMap };
    }),

  // Get only triggered but not yet dismissed alerts (for notification badge)
  // Also enriches each alert with catalogueZivScore from userAssets (current Ziv score)
  getTriggered: protectedProcedure.query(async ({ ctx }) => {
    const alerts = await getTriggeredUndismissedAlerts(ctx.user.id);
    if (!alerts.length) return alerts;
    const db = await getDb();
    if (!db) return alerts;
    // Fetch current Ziv scores from catalogue for all unique tickers
    const assetRows = await db
      .select({ ticker: userAssets.ticker, score: userAssets.score })
      .from(userAssets)
      .where(eq(userAssets.userId, ctx.user.id));
    const catalogueScoreMap = new Map<string, number | null>();
    for (const row of assetRows) {
      catalogueScoreMap.set(row.ticker.toUpperCase(), row.score ?? null);
    }
    return alerts.map(a => ({
      ...a,
      catalogueZivScore: catalogueScoreMap.get(a.ticker.toUpperCase()) ?? null,
    }));
  }),

  // Get archived alerts (triggered >48h ago or Ziv < 8)
  getArchived: protectedProcedure.query(async ({ ctx }) => {
    return getArchivedAlerts(ctx.user.id);
  }),

  // Create a new price alert
  create: protectedProcedure
    .input(z.object({
      ticker: z.string().min(1).max(16).toUpperCase(),
      alertType: z.enum(["sl", "tp", "custom"]),
      targetPrice: z.number().positive(),
      direction: z.enum(["below", "above"]),
      label: z.string().max(64).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Duplicate prevention: for sl/tp alerts, check if active alert already exists for this ticker+type
      if (input.alertType === "sl" || input.alertType === "tp") {
        const existing = await getPriceAlerts(ctx.user.id);
        const dupe = existing.find(a =>
          a.ticker === input.ticker &&
          a.alertType === input.alertType &&
          !a.triggered && !a.dismissed
        );
        if (dupe) {
          // Update existing instead of creating duplicate
          await updatePriceAlert(dupe.id, ctx.user.id, { targetPrice: input.targetPrice, direction: input.direction });
          swrInvalidate(`alerts:all:${ctx.user.id}`);
          return { id: dupe.id, updated: true };
        }
      }
      const id = await createPriceAlert({
        userId: ctx.user.id,
        ticker: input.ticker,
        alertType: input.alertType,
        targetPrice: input.targetPrice,
        direction: input.direction,
        label: input.label ?? (input.alertType === "sl" ? "Stop Loss" : input.alertType === "tp" ? "Take Profit" : "Custom Alert"),
      });
      swrInvalidate(`alerts:all:${ctx.user.id}`);
      return { id };
    }),

  // Update an existing alert (edit targetPrice, direction, label)
  update: protectedProcedure
    .input(z.object({
      id: z.number(),
      targetPrice: z.number().positive().optional(),
      direction: z.enum(["below", "above"]).optional(),
      label: z.string().max(64).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      await updatePriceAlert(id, ctx.user.id, data);
      swrInvalidate(`alerts:all:${ctx.user.id}`);
      return { success: true };
    }),

  // Dismiss a triggered alert (removes from notification list)
  dismiss: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await dismissPriceAlert(input.id, ctx.user.id);
      swrInvalidate(`alerts:all:${ctx.user.id}`);
      return { success: true };
    }),

  // Delete an alert entirely
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await deletePriceAlert(input.id, ctx.user.id);
      swrInvalidate(`alerts:all:${ctx.user.id}`);
      return { success: true };
    }),

  // Delete all alerts for a specific ticker
  deleteForTicker: protectedProcedure
    .input(z.object({ ticker: z.string().min(1).max(16) }))
    .mutation(async ({ ctx, input }) => {
      await deletePriceAlertsForTicker(ctx.user.id, input.ticker.toUpperCase());
      swrInvalidate(`alerts:all:${ctx.user.id}`);
      return { success: true };
    }),

  // Get Telegram settings for the current user
  getTelegramSettings: protectedProcedure.query(async ({ ctx }) => {
    const settings = await getUserSettings(ctx.user.id);
    return {
      enabled: settings?.telegramEnabled === 1,
      chatId: settings?.telegramChatId ?? null,
      botConfigured: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    };
  }),

  // Update Telegram settings
  updateTelegramSettings: protectedProcedure
    .input(z.object({
      enabled: z.boolean(),
      chatId: z.string().max(64).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await upsertUserSettings(ctx.user.id, {
        telegramEnabled: input.enabled ? 1 : 0,
        telegramChatId: input.chatId ?? null,
      });
      return { success: true };
    }),

  // Send a test Telegram message
  sendTestTelegram: protectedProcedure.mutation(async ({ ctx }) => {
    const settings = await getUserSettings(ctx.user.id);
    const chatId = settings?.telegramChatId ?? process.env.TELEGRAM_CHAT_ID;
    if (!chatId || !process.env.TELEGRAM_BOT_TOKEN) {
      return { success: false, error: "Telegram not configured" };
    }
    const ok = await sendTelegramMessage(
      "🔔 <b>trade-snow2.vip — Test Alert</b>\n\nTelegram notifications are working! You will receive SL/TP alerts here.",
      chatId
    );
    return { success: ok };
  }),

  // Admin: send test Telegram to a specific chatId (for testing user Telegram setup)
  adminSendTestToUser: adminProcedure
    .input(z.object({ chatId: z.string() }))
    .mutation(async ({ input }) => {
      if (!process.env.TELEGRAM_BOT_TOKEN) {
        return { success: false, error: "Telegram bot not configured" };
      }
      const ok = await sendTelegramMessage(
        "\uD83D\uDD14 <b>trade-snow2.vip \u2014 Test Alert</b>\n\nTelegram notifications are working! You will receive SL/TP alerts here.",
        input.chatId
      );
      return { success: ok };
    }),

  // ── Recycle Bin ──────────────────────────────────────────────────────────

  /**
   * Re-arm a single archived alert.
   * Fetches the latest Ziv Engine parameters and resets the alert to pending.
   * For SL/TP alerts: re-computes SL/TP from holdings buyPrice + EMA-50.
   * For custom (catalogue) alerts: refreshes zivScore from userAssets.
   */
  recycleAlert: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Fetch the archived alert
      const [alert] = await db.select().from(priceAlerts).where(
        and(eq(priceAlerts.id, input.id), eq(priceAlerts.userId, userId))
      ).limit(1);
      if (!alert) throw new Error("Alert not found");

      let newTargetPrice: number | undefined;
      let newZivScore: number | null = null;

      try {
        const ticker = alert.ticker.toUpperCase();

        if (alert.alertType === "custom") {
          // Catalogue alert: refresh zivScore from userAssets + use recommendedBuyPrice as target
          const [assetRow] = await db.select({ score: userAssets.score, recommendedBuyPrice: userAssets.recommendedBuyPrice, cmp: userAssets.cmp })
            .from(userAssets)
            .where(and(eq(userAssets.userId, userId), eq(userAssets.ticker, ticker)))
            .limit(1);
          newZivScore = assetRow?.score ?? null;
          const bp = (assetRow?.recommendedBuyPrice ?? assetRow?.cmp) as number | null | undefined;
          if (bp != null) {
            newTargetPrice = calcCatalogueAlertTarget(bp);
          }
        } else {
          // SL/TP alert: re-compute from holding buyPrice + EMA-50
          // Try H1 first, then H2
          const [h1] = await db.select({ buyPrice: portfolioHoldings.buyPrice })
            .from(portfolioHoldings)
            .where(and(eq(portfolioHoldings.userId, userId), eq(portfolioHoldings.ticker, ticker)))
            .limit(1);
          const [h2] = await db.select({ buyPrice: holding2.buyPrice })
            .from(holding2)
            .where(and(eq(holding2.userId, userId), eq(holding2.ticker, ticker)))
            .limit(1);
          const buyPrice = (h1?.buyPrice ?? h2?.buyPrice) as number | undefined;
          if (buyPrice != null) {
            const barsMap = await fetchBarsBatch([ticker]);
            const rawBarsPA = (barsMap.get(ticker) ?? []) as Bar[];
            const bars = normalizeBarsForTicker(ticker, rawBarsPA);
            if (bars.length >= 50) {
              const ziv = calcZivEngineScore(bars);
              const { stopLoss, takeProfit } = calcSlTp(buyPrice, ziv.ema50);
              newTargetPrice = alert.alertType === "sl" ? stopLoss : takeProfit;
            }
          }
        }
      } catch {
        // Non-fatal: recycle without updating prices
      }

      await recycleArchivedAlert(input.id, userId, {
        targetPrice: newTargetPrice,
        zivScore: newZivScore,
      });
      return { success: true, newTargetPrice, newZivScore };
    }),

  /**
   * Recycle ALL archived alerts for the user.
   * Fetches fresh Ziv scores for all custom alerts in bulk.
   * For SL/TP alerts, re-computes from holdings.
   */
  recycleAllAlerts: adminProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.user.id;
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // Get all archived alerts
    const archived = await getArchivedAlerts(userId);
    if (!archived.length) return { recycled: 0 };

    // Separate by type
    const customAlerts = archived.filter(a => a.alertType === "custom");
    const holdingAlerts = archived.filter(a => a.alertType === "sl" || a.alertType === "tp");

    // ── Bulk-fetch Ziv scores for custom alerts ───────────────────────────────
    const customTickers = Array.from(new Set(customAlerts.map(a => a.ticker.toUpperCase())));
    const zivScoreMap = new Map<string, number | null>();
    const buyPriceMap = new Map<string, number>();
    if (customTickers.length > 0) {
      try {
        const assetRows = await db.select({ ticker: userAssets.ticker, score: userAssets.score, recommendedBuyPrice: userAssets.recommendedBuyPrice, cmp: userAssets.cmp })
          .from(userAssets)
          .where(eq(userAssets.userId, userId));
        for (const row of assetRows) {
          zivScoreMap.set(row.ticker.toUpperCase(), row.score ?? null);
          const bp = (row.recommendedBuyPrice ?? row.cmp) as number | null | undefined;
          if (bp != null) buyPriceMap.set(row.ticker.toUpperCase(), bp);
        }
      } catch { /* non-fatal */ }
    }

    // ── Bulk-fetch bars for holding alerts ────────────────────────────────────
    const holdingTickers = Array.from(new Set(holdingAlerts.map(a => a.ticker.toUpperCase())));
    let barsMap = new Map<string, Bar[]>();
    const holdingBuyPriceMap = new Map<string, number>();
    if (holdingTickers.length > 0) {
      try {
        const [h1Rows, h2Rows] = await Promise.all([
          db.select({ ticker: portfolioHoldings.ticker, buyPrice: portfolioHoldings.buyPrice })
            .from(portfolioHoldings).where(eq(portfolioHoldings.userId, userId)),
          db.select({ ticker: holding2.ticker, buyPrice: holding2.buyPrice })
            .from(holding2).where(eq(holding2.userId, userId)),
        ]);
        for (const r of [...h1Rows, ...h2Rows]) {
          if (r.buyPrice != null) holdingBuyPriceMap.set(r.ticker.toUpperCase(), r.buyPrice as number);
        }
        const rawBarsMap = await fetchBarsBatch(holdingTickers);
        for (const [t, rawBars] of Array.from(rawBarsMap.entries())) {
          barsMap.set(t.toUpperCase(), normalizeBarsForTicker(t, rawBars as Bar[]));
        }
      } catch { /* non-fatal */ }
    }

    // ── Apply recycle for each alert ─────────────────────────────────────────
    let recycled = 0;
    for (const alert of archived) {
      const ticker = alert.ticker.toUpperCase();
      let newTargetPrice: number | undefined;
      let newZivScore: number | null = null;

      try {
        if (alert.alertType === "custom") {
          newZivScore = zivScoreMap.get(ticker) ?? null;
          const bp = buyPriceMap.get(ticker);
          if (bp != null) newTargetPrice = calcCatalogueAlertTarget(bp);
        } else {
          const buyPrice = holdingBuyPriceMap.get(ticker);
          const bars = barsMap.get(ticker) ?? [];
          if (buyPrice != null && bars.length >= 50) {
            const ziv = calcZivEngineScore(bars);
            const { stopLoss, takeProfit } = calcSlTp(buyPrice, ziv.ema50);
            newTargetPrice = alert.alertType === "sl" ? stopLoss : takeProfit;
          }
        }
        await recycleArchivedAlert(alert.id, userId, { targetPrice: newTargetPrice, zivScore: newZivScore });
        recycled++;
      } catch { /* skip individual failures */ }
    }

    return { recycled };
  }),

  /**
   * Load BUY alerts from catalogue — creates a "custom" BUY alert for every
   * catalogue asset with ZIV score >= 8 that doesn't already have an active BUY alert.
   * Target price = recommendedBuyPrice (EMA-50 pullback level) or cmp as fallback.
   * These alerts feed into Price Alerts → Buy Opportunities section.
   */
  loadAlertsFromCatalogue: adminProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.user.id;
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // 1. Get catalogue assets with ZIV score >= 8 only — no low-quality signals at the source
    const assets = await getUserAssets(userId);
    const eligibleAssets = assets.filter(a =>
      a.ticker && a.ticker.length > 0 &&
      (a as any).score != null && (a as any).score >= 8
    );
    if (!eligibleAssets.length) return { created: 0, skipped: 0, tickers: [] };

    // 2. Get all existing active (non-triggered, non-dismissed) custom alerts for this user
    const existingAlerts = await db
      .select({ ticker: priceAlerts.ticker, label: priceAlerts.label })
      .from(priceAlerts)
      .where(and(
        eq(priceAlerts.userId, userId),
        eq(priceAlerts.alertType, "custom"),
        eq(priceAlerts.triggered, 0),
        eq(priceAlerts.dismissed, 0),
        isNull(priceAlerts.archivedAt),
      ));
    // Track existing alerts by ticker+type to avoid duplicates
    // Rule 1: Gold Breakout — 🔥 label
    // Rule 2: Gold Retest — 🔄 label (unified: covers EMA-50 pullback + prior breakout level retest)
    // Rule 3: Near Entry Watch — 📍 label (ZIV 6-7.9, warning only)
    const existingBreakoutAlerts = new Set(existingAlerts.filter(a => a.label?.startsWith('🔥')).map(a => a.ticker.toUpperCase()));
    const existingRetestAlerts = new Set(existingAlerts.filter(a => a.label?.startsWith('🔄') || a.label?.startsWith('EMA-50') || a.label?.startsWith('📍')).map(a => a.ticker.toUpperCase()));

    // 2b. Fetch latest breakout scan data per ticker for BREAKOUT/RETEST alerts
    const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const allBreakoutScans = await db
      .select({
        ticker: breakoutScans.ticker,
        signalType: breakoutScans.signalType,
        donchian20High: breakoutScans.donchian20High,
        retestLevel: breakoutScans.retestLevel,
        price: breakoutScans.price,
        zivScore: breakoutScans.zivScore,
        scannedAt: breakoutScans.scannedAt,
      })
      .from(breakoutScans)
      .where(and(
        eq(breakoutScans.userId, userId),
        gte(breakoutScans.scannedAt, cutoff30d),
      ))
      .orderBy(desc(breakoutScans.scannedAt));

    // Build maps: ticker → latest BREAKOUT scan, ticker → latest RETEST scan
    const latestBreakout = new Map<string, typeof allBreakoutScans[0]>();
    const latestRetest = new Map<string, typeof allBreakoutScans[0]>();
    for (const scan of allBreakoutScans) {
      const t = scan.ticker.toUpperCase();
      if (scan.signalType === 'BREAKOUT' && !latestBreakout.has(t)) latestBreakout.set(t, scan);
      if (scan.signalType === 'RETEST' && !latestRetest.has(t)) latestRetest.set(t, scan);
    }

    // 3. Create alerts for eligible assets that don't already have one
    let created = 0;
    let skipped = 0;
    const createdTickers: string[] = [];

    // Pre-fetch USD/ILS rate once for .TA tickers
    let ilsRate = 3.60;
    const hasTaAssets = eligibleAssets.some(a => a.ticker.toUpperCase().endsWith('.TA'));
    if (hasTaAssets) {
      try { ilsRate = await getUsdIlsRate(); } catch { /* use fallback */ }
    }

    // NOTE: TASE target unit is ambiguous (agorot vs ILS) — original magnitude heuristic
    // preserved intentionally during Phase 3 consolidation; correction deferred to a verified pass.
    for (const asset of eligibleAssets) {
      const ticker = asset.ticker.toUpperCase();
      const isIsraeliStock = ticker.endsWith('.TA');
      const currencySymbol = isIsraeliStock ? '₪' : '$';
      const zivScore = (asset as any).score ?? null;
      const zivLabel = zivScore != null ? ` | ZIV ${zivScore.toFixed(1)}` : '';

      // ── Rule 2: Gold Retest alert — unified: EMA-50 pullback OR prior breakout level retest ──
      // Covers old "Pullback Setup" (EMA-50) and old "Gold Retest" (prior breakout level)
      // Priority: use prior breakout level if available, otherwise fall back to EMA-50
      if (!existingRetestAlerts.has(ticker)) {
        const rScan = latestRetest.get(ticker);
        const bScan2 = latestBreakout.get(ticker);
        // Try prior breakout level first (more precise retest target)
        const rawRetestFromScan = rScan?.retestLevel ?? rScan?.price ?? bScan2?.donchian20High ?? null;
        // Fallback: EMA-50 (recommendedBuyPrice)
        const rawEma50 = (asset as any).recommendedBuyPrice ?? (asset as any).cmp ?? null;
        const rawRetestLevel = rawRetestFromScan ?? rawEma50;
        const retestSource = rawRetestFromScan ? 'breakout' : 'ema50';

        if (rawRetestLevel && rawRetestLevel > 0) {
          let retestTarget = rawRetestLevel;
          if (isIsraeliStock && retestTarget > 500) retestTarget = retestTarget / 100 / ilsRate;
          else if (isIsraeliStock && retestTarget > 5) retestTarget = retestTarget / ilsRate;
          retestTarget = parseFloat(retestTarget.toFixed(2));
          const retestLabel = retestSource === 'breakout'
            ? `🔄 Retest @ ${currencySymbol}${retestTarget.toFixed(2)}${zivLabel}`.slice(0, 64)
            : `🔄 EMA-50 Pullback @ ${currencySymbol}${retestTarget.toFixed(2)}${zivLabel}`.slice(0, 64);
          try {
            await createPriceAlert({
              userId,
              ticker,
              alertType: 'custom',
              targetPrice: retestTarget,
              direction: 'below',
              label: retestLabel,
            });
            created++;
            createdTickers.push(`${ticker}(RET)`);
          } catch { skipped++; }
        } else {
          skipped++;
        }
      } else {
        skipped++;
      }

      // ── Rule 1: Gold Breakout — trigger when price breaks above Donchian 20-day high ──
      if (!existingBreakoutAlerts.has(ticker)) {
        const bScan = latestBreakout.get(ticker);
        if (bScan && bScan.donchian20High && bScan.donchian20High > 0) {
          let breakoutTarget = bScan.donchian20High;
          if (isIsraeliStock && breakoutTarget > 500) breakoutTarget = breakoutTarget / 100 / ilsRate;
          else if (isIsraeliStock && breakoutTarget > 5) breakoutTarget = breakoutTarget / ilsRate;
          breakoutTarget = parseFloat(breakoutTarget.toFixed(2));
          try {
            await createPriceAlert({
              userId,
              ticker,
              alertType: 'custom',
              targetPrice: breakoutTarget,
              direction: 'above',
              label: `🔥 Gold Breakout @ ${currencySymbol}${breakoutTarget.toFixed(2)}${zivLabel}`.slice(0, 64),
            });
            created++;
            createdTickers.push(`${ticker}(BRK)`);
          } catch { skipped++; }
        }
      }

      // ── Rule 3: Near Entry Watch — ZIV 6-7.9 only, warning alert ──
      // Only created for assets with ZIV < 8 (borderline quality)
      // Uses EMA-50 as target — alerts user to watch but not necessarily enter
      if (zivScore != null && zivScore >= 6 && zivScore < 8 && !existingRetestAlerts.has(ticker)) {
        const rawEma50Watch = (asset as any).recommendedBuyPrice ?? (asset as any).cmp ?? null;
        if (rawEma50Watch && rawEma50Watch > 0) {
          let watchTarget = rawEma50Watch;
          if (isIsraeliStock && watchTarget > 500) watchTarget = watchTarget / 100 / ilsRate;
          else if (isIsraeliStock && watchTarget > 5) watchTarget = watchTarget / ilsRate;
          watchTarget = parseFloat(watchTarget.toFixed(2));
          try {
            await createPriceAlert({
              userId,
              ticker,
              alertType: 'custom',
              targetPrice: watchTarget,
              direction: 'below',
              label: `📍 Near Entry Watch @ ${currencySymbol}${watchTarget.toFixed(2)}${zivLabel}`.slice(0, 64),
            });
            created++;
            createdTickers.push(`${ticker}(WATCH)`);
          } catch { skipped++; }
        }
      }
    }

    return { created, skipped, tickers: createdTickers };
  }),

  // Archive all triggered alerts with ZIV score < 8 (low quality signals)
  archiveLowQuality: adminProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    // Filter in JS since zivScore may be null (treat null as low quality)
    const allTriggered = await db.select()
      .from(priceAlerts)
      .where(and(
        eq(priceAlerts.userId, ctx.user.id),
        eq(priceAlerts.triggered, 1),
        eq(priceAlerts.dismissed, 0),
        isNull(priceAlerts.archivedAt),
      ));
    const toArchive = allTriggered.filter(a => a.zivScore == null || a.zivScore < 8);
    if (toArchive.length === 0) return { archived: 0 };
    const ids = toArchive.map(a => a.id);
    await db.update(priceAlerts)
      .set({ archivedAt: new Date() })
      .where(and(eq(priceAlerts.userId, ctx.user.id), inArray(priceAlerts.id, ids)));
    return { archived: toArchive.length };
  }),

  // Check all active alerts against current prices — call this on page load / refresh
  checkAlerts: adminProcedure.mutation(async ({ ctx }) => {
    const activeAlerts = await getActiveAlerts(ctx.user.id);
    if (activeAlerts.length === 0) return { triggered: [] };

    // Get unique tickers
    const tickerSet = new Set<string>();
    for (const a of activeAlerts) tickerSet.add(a.ticker);
    const tickers = Array.from(tickerSet);

    // Fetch live prices
    let priceMap = new Map<string, number>();
    try {
      const prices = await fetchLivePricesBatch(tickers);
      prices.forEach((lp, t) => {
        if (lp) priceMap.set(t, lp.price);
      });
    } catch {
      return { triggered: [] };
    }

    const triggered: Array<{ id: number; ticker: string; label: string; targetPrice: number; currentPrice: number; direction: string }> = [];

    for (const alert of activeAlerts) {
      const currentPrice = priceMap.get(alert.ticker);
      if (!currentPrice) continue;

      const shouldTrigger =
        (alert.direction === "below" && currentPrice <= alert.targetPrice) ||
        (alert.direction === "above" && currentPrice >= alert.targetPrice);

      if (shouldTrigger) {
        await triggerPriceAlert(alert.id, currentPrice);
        triggered.push({
          id: alert.id,
          ticker: alert.ticker,
          label: alert.label ?? alert.alertType,
          targetPrice: alert.targetPrice,
          currentPrice,
          direction: alert.direction,
        });
      }
    }

    return { triggered };
  }),
});
