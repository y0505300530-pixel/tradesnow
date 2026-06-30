/**
 * IBKR Client Portal API Router
 *
 * Architecture: The IBKR Client Portal Gateway runs on the USER's local machine.
 * All direct Gateway calls (auth status, place order, etc.) are made from the
 * FRONTEND browser directly to https://localhost:5000 (or user-configured URL).
 *
 * This router handles:
 * 1. Persisting user's Gateway URL and account ID settings to DB
 * 2. Storing IBKR account snapshots (balance, positions) synced by the frontend
 * 3. Logging orders placed via the frontend for audit trail
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, adminProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { ibkrSettings, portfolioHoldings, portfolioAccounts, engineChatHistory, ibkrConnectionLog, orderAuditLog, ibkrConidCache, userAssets } from "../../drizzle/schema";
import { upsertPortfolioAccount, getPortfolioAccount, logJournalEvent, getSystemSetting, setSystemSetting, upsertDailyPositionChange } from "../db";
import { eq, and, isNull } from "drizzle-orm";
import { getUsdIlsRate } from "../marketData";
import { sendTelegramMessage } from "../telegram";
import { log } from "../logger";
import { ENV } from "../_core/env";
import { ibindRequest, primeAccountsIfNeeded, setIbindDisconnectedFlag, refreshIbindDisconnectFlag } from "./ibkrProxy";
import { ibindCached, stopIbkrHeartbeat, startIbkrHeartbeat } from "../ibkrCache";
import { resolveIbkrSymbol, getKnownConid, getAliasReason, EXCHANGE_VARIANTS } from "../tickerAliases";
import { normalizeIbindBatch, fetchInBatches, type IbindRawQuote } from "../services/PriceService";
import { getMonitorState } from "../ibkrSessionMonitor";

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getIbkrSettings(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(ibkrSettings).where(eq(ibkrSettings.userId, userId)).limit(1);
  return rows[0] ?? null;
}

async function upsertIbkrSettings(userId: number, data: {
  gatewayUrl?: string;
  accountId?: string;
  accountType?: "paper" | "live";
  sessionCookie?: string | null;
  lastConnectedAt?: Date;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const existing = await getIbkrSettings(userId);
  if (existing) {
    await db.update(ibkrSettings).set(data).where(eq(ibkrSettings.userId, userId));
  } else {
    await db.insert(ibkrSettings).values({ userId, gatewayUrl: "http://143.198.141.131:5000", ...data });
  }
  return getIbkrSettings(userId);
}

// ── Router ────────────────────────────────────────────────────────────────────

export const ibkrRouter = {

  // Get saved IBKR settings for the current user
  getSettings: adminProcedure.query(async ({ ctx }) => {
    const settings = await getIbkrSettings(ctx.user.id);
    return settings ?? {
      gatewayUrl: "http://143.198.141.131:5000",
      accountId: null,
      accountType: "paper" as const,
      sessionCookie: null,
      lastConnectedAt: null,
    };
  }),

  // Save Gateway URL, account type, and optional session cookie
  saveSettings: adminProcedure
    .input(z.object({
      gatewayUrl: z.string().url().max(255),
      accountType: z.enum(["paper", "live"]).default("paper"),
      sessionCookie: z.string().optional().nullable(),
    }))
    .mutation(async ({ ctx, input }) => {
      const settings = await upsertIbkrSettings(ctx.user.id, {
        gatewayUrl: input.gatewayUrl,
        accountType: input.accountType,
        ...(input.sessionCookie !== undefined && { sessionCookie: input.sessionCookie }),
      });
      return settings;
    }),

  // Called by frontend after successful Gateway connection — saves account ID and marks connected
  markConnected: adminProcedure
    .input(z.object({
      accountId: z.string().max(32),
      accountType: z.enum(["paper", "live"]).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const accountType = input.accountType ?? (input.accountId.startsWith("DU") ? "paper" : "live");
      await upsertIbkrSettings(ctx.user.id, {
        accountId: input.accountId,
        accountType,
        lastConnectedAt: new Date(),
      });
      return { success: true, accountId: input.accountId, accountType };
    }),

  // Send a Telegram notification asking user to renew their IBKR session
  sendRenewNotification: adminProcedure.mutation(async () => {
    const msg = [
      `🔑 <b>IBKR Session Expired</b>`,
      ``,
      `Your IBKR session has expired and needs to be renewed.`,
      ``,
      `<b>Steps to reconnect:</b>`,
      `1. Open <a href="https://gateway.leeds-crm.com">gateway.leeds-crm.com</a>`,
      `2. Log in with your IBKR credentials`,
      `3. Approve the push notification on your phone`,
      `4. Click the bookmarklet in your browser`,
      `5. Return to <a href="https://trade-snow2.vip/settings">trade-snow2.vip/settings</a> → Connect to IBKR`,
    ].join("\n");
    const sent = await sendTelegramMessage(msg);
    return { sent };
  }),

  // Fetch live positions from IBKR via IBIND (OAuth 1.0a bridge)
  getPositions: adminProcedure.query(async () => {
    try {
      const res = await ibindCached("GET", "/positions");
      if (!res.ok) {
        return { positions: [], accountId: null, error: `IBIND returned HTTP ${res.status}` };
      }
      const body = res.body as any;
      // IBIND may return { positions: [...] } or a direct array
      const raw: any[] = Array.isArray(body) ? body
        : Array.isArray(body?.positions) ? body.positions
        : [];

      if (raw.length === 0) {
        return { positions: [], accountId: body?.account_id ?? null, error: null };
      }

      // Normalize to a clean shape, filter out zero-quantity positions
      const normalized = raw
        .filter((p: any) => (p.position ?? p.quantity ?? p.pos ?? p.size ?? 0) !== 0)
        .map((p: any) => ({
          // IBIND may use: ticker, symbol, localSymbol, contractDesc, contract.symbol, name
          ticker: (
            p.ticker ?? p.symbol ?? p.localSymbol ?? p.local_symbol ??
            p.contractDesc ?? p.contract_desc ?? p.contract?.symbol ??
            p.name ?? p.description ?? ""
          ).toUpperCase().replace(/\s+.*$/, ""), // strip exchange suffix if any
          conid: p.conid ?? p.contract?.conid ?? null,
          position: p.position ?? p.quantity ?? p.pos ?? p.size ?? 0,
          mktPrice: p.mktPrice ?? p.market_price ?? p.last_price ?? p.price ?? 0,
          mktValue: p.mktValue ?? p.market_value ?? p.value ?? 0,
          avgCost: p.avgCost ?? p.avg_cost ?? p.average_cost ?? p.cost ?? 0,
          unrealizedPnl: p.unrealizedPnl ?? p.unrealized_pnl ?? p.pnl ?? 0,
          realizedPnl: p.realizedPnl ?? p.realized_pnl ?? 0,
          currency: p.currency ?? "USD",
          assetClass: p.assetClass ?? p.asset_class ?? "STK",
        }));

      // v2.1: If IBKR returns 0 positions (market closed / session idle), fall back to DB
      if (normalized.length === 0) {
        try {
          const { getPortfolioHoldings, getUserByOpenId } = await import("../db");
          const { ENV } = await import("../_core/env");
          let ownerUserId = 1;
          if (ENV.ownerOpenId) {
            const ownerUser = await getUserByOpenId(ENV.ownerOpenId);
            ownerUserId = ownerUser?.id ?? 1;
          }
          const dbHoldings = await getPortfolioHoldings(ownerUserId);
          const dbNorm = dbHoldings
            .filter((h: any) => (h.units ?? 0) !== 0)
            .map((h: any) => ({
              ticker: h.ticker,
              position: h.units ?? 0,
              mktPrice: h.currentPrice ?? h.buyPrice ?? 0,
              mktValue: (h.units ?? 0) * (h.currentPrice ?? h.buyPrice ?? 0),
              avgCost: h.buyPrice ?? 0,
              unrealizedPnl: h.ibkrUnrealizedPnl ?? ((h.currentPrice ?? h.buyPrice ?? 0) - (h.buyPrice ?? 0)) * (h.units ?? 0),
              unrealizedPnlPercent: h.buyPrice ? ((h.currentPrice ?? h.buyPrice) - h.buyPrice) / h.buyPrice * 100 : 0,
              currency: "USD",
              conid: h.conid ?? null,
              exchange: "US",
              source: "db_fallback",
            }));
          return { positions: dbNorm, accountId: body?.account_id ?? null, error: dbNorm.length > 0 ? "IBKR offline — showing DB positions" : null };
        } catch { /* ignore fallback error */ }
      }
      return { positions: normalized, accountId: body?.account_id ?? null, error: null };
    } catch (err: any) {
      return { positions: [], accountId: null, error: err.message };
    }
  }),

  // Fetch account summary (net liquidation, buying power, cash)
  // Auto-saves to DB whenever live data is returned, so values persist across sessions.
  getAccountSummary: adminProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;

    /** Persist summary values to DB (fire-and-forget, never blocks response) */
    const persistSummary = async (s: {
      netLiquidation: number | null;
      grossPositionValue: number | null;
      totalCash: number | null;
      dailyPnl: number | null;
    }) => {
      try {
        const update: Record<string, any> = {};
        // v19.02: Use netLiquidation as fallback for grossPositionValue (IBIND sometimes returns null for gpv)
        // v2.1: always prefer netLiquidation for NLV (GPV often returns 0 when outside RTH)
        const portfolioValue = s.netLiquidation ?? s.grossPositionValue;
        if (portfolioValue != null) { update.lastKnownNLV = portfolioValue; update.lastKnownNLVAt = new Date(); }
        if (s.netLiquidation != null) update.lastKnownNetLiquidation = s.netLiquidation;
        if (s.totalCash != null) { update.lastKnownCash = s.totalCash; update.cashBalance = s.totalCash; }
        if (s.dailyPnl != null) update.lastKnownTodayPnl = s.dailyPnl;
        if (Object.keys(update).length > 0) await upsertPortfolioAccount(userId, update);
      } catch { /* best-effort */ }
    };

    // ── IBIND account summary (primary — iBeam removed) ──
    try {
      const [ibindRes, pnlRes] = await Promise.all([
        ibindCached("GET", "/account/summary"),
        ibindCached("GET", "/pnl"),
      ]);

      // Parse /pnl partitioned response for accurate dpl/upl
      // Shape: { upnl: { "<accountId>.Core": { dpl, upl, nl, mv, el } } }
      let pnlDpl: number | null = null;
      let pnlUpl: number | null = null;
      if (pnlRes.ok && pnlRes.body) {
        const pnlRaw = pnlRes.body as Record<string, any>;
        const pnlPartitions: Record<string, any> = pnlRaw.upnl ?? {};
        let dplSum = 0, uplSum = 0, hasData = false;
        for (const key of Object.keys(pnlPartitions)) {
          const p = pnlPartitions[key];
          if (typeof p.dpl === "number") { dplSum += p.dpl; hasData = true; }
          if (typeof p.upl === "number") { uplSum += p.upl; }
        }
        if (hasData) { pnlDpl = dplSum; pnlUpl = uplSum; }
        log.info("IBKR", "getAccountSummary /pnl parsed", { pnlDpl, pnlUpl });
      }

      if (ibindRes.ok && ibindRes.body) {
        const s = ibindRes.body as Record<string, any>;
        const data = s.summary ?? s;
        const nlv = data.net_liquidation ?? data.netliquidation ?? data.netLiquidation ?? null;
        const gpv = data.gross_position_value ?? data.grosspositionvalue ?? data.grossPositionValue ?? null;
        const cash = data.total_cash ?? data.totalcashvalue ?? data.totalCash ?? null;
        const bp = data.buying_power ?? data.buyingpower ?? data.buyingPower ?? null;
        const maintMgn = data.fullmaintmarginreq ?? data['fullmaintmarginreq-s'] ?? data.maintmarginreq ?? data['maintmarginreq-s'] ?? null;
        const accountId = data.account_id ?? data.accountId ?? null;
        const summaryObj = {
          netLiquidation: typeof nlv === "number" ? nlv : (nlv?.amount ?? null),
          grossPositionValue: typeof gpv === "number" ? gpv : (gpv?.amount ?? null),
          totalCash: typeof cash === "number" ? cash : (cash?.amount ?? null),
          buyingPower: typeof bp === "number" ? bp : (bp?.amount ?? null),
          maintenanceMargin: typeof maintMgn === "number" ? maintMgn : (maintMgn?.amount ?? null),
          excessLiquidity: null,
          // Prefer /pnl partitioned dpl (accurate) over /account/summary daily_pnl (often stale/wrong)
          dailyPnl: pnlDpl,
          unrealizedPnl: pnlUpl,
          currency: "USD",
        };
        // Auto-persist to DB
        persistSummary(summaryObj);
        return { accountId, summary: summaryObj, error: null, source: "ibind" };
      }
    } catch (ibindErr: any) {
      return { summary: null, accountId: null, error: `IBIND unavailable: ${ibindErr.message}`, source: "none" };
    }

    // ── Fallback: return DB-cached values so UI shows last-known data instantly ──
    try {
      const dbAccount = await getPortfolioAccount(userId);
      if (dbAccount) {
        // If the cached data is from a previous calendar day, dailyPnl is stale — return null
        // so the UI shows "—" instead of yesterday's (or last Friday's) P&L.
        const cachedAt = dbAccount.lastKnownNLVAt;
        const isStaleDay = cachedAt
          ? new Date(cachedAt).toDateString() !== new Date().toDateString()
          : true;
        return {
          accountId: null,
          summary: {
            netLiquidation: dbAccount.lastKnownNetLiquidation ?? null,
            grossPositionValue: dbAccount.lastKnownNLV ?? null,
            totalCash: dbAccount.lastKnownCash ?? dbAccount.cashBalance ?? null,
            buyingPower: null,
            maintenanceMargin: null,
            excessLiquidity: null,
            dailyPnl: isStaleDay ? null : (dbAccount.lastKnownTodayPnl ?? null),
            unrealizedPnl: null,
            currency: "USD",
          },
          error: "Broker offline — showing last-known values",
          source: "db_cache",
          cachedAt: dbAccount.lastKnownNLVAt ?? null,
        };
      }
    } catch { /* ignore */ }

    return { summary: null, accountId: null, error: "No broker connection available", source: "none" };
  }),

  // ── GET /pnl — Today's P&L from IBKR (partitioned PnL endpoint) ──────────────
  // Returns daily_pnl (Today's P&L), unrealized_pnl, net_liquidation, market_value, excess_liquidity.
  // Also persists daily_pnl + net_liquidation to DB for offline fallback.
  getPnl: adminProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    try {
      // Fetch /pnl first, then /positions sequentially (IBIND rate-limits parallel requests).
      // IBIND returns /pnl as a flat shape: { daily_pnl, unrealized_pnl, net_liquidation, market_value, excess_liquidity, account_id }
      // /positions returns per-position unrealizedPnl which matches what IBKR app shows (P&L since buy price).
      const pnlRes = await ibindCached("GET", "/pnl");
      // Small delay to avoid IBIND rate limit (cache may serve both instantly)
      await new Promise(r => setTimeout(r, 100));
      const posRes = await ibindCached("GET", "/positions");
      if (pnlRes.ok && pnlRes.body) {
        const raw = pnlRes.body as Record<string, any>;
        // IBIND proxy returns flat shape: { daily_pnl, unrealized_pnl, net_liquidation, ... }
        // Also handle nested upnl shape as fallback.
        const partitions: Record<string, any> = raw.upnl ?? {};
        const keys = Object.keys(partitions);
        let dplSum = 0, uplSum = 0, nlSum = 0, mvSum = 0, elSum = 0;
        let accountId: string | null = null;
        for (const key of keys) {
          const p = partitions[key];
          if (typeof p.dpl === "number") dplSum += p.dpl;
          if (typeof p.upl === "number") uplSum += p.upl;
          if (typeof p.nl  === "number") nlSum  += p.nl;
          if (typeof p.mv  === "number") mvSum  += p.mv;
          if (typeof p.el  === "number") elSum  += p.el;
          if (!accountId) accountId = key.split(".")[0];
        }
        // Accept flat shape from IBIND proxy
        const dailyPnl: number | null = keys.length > 0 ? dplSum : (typeof raw.daily_pnl === "number" ? raw.daily_pnl : null);
        const netLiquidation: number | null = keys.length > 0 ? nlSum : (typeof raw.net_liquidation === "number" ? raw.net_liquidation : null);
        const marketValue: number | null = keys.length > 0 ? mvSum : (typeof raw.market_value === "number" ? raw.market_value : null);
        const excessLiquidity: number | null = keys.length > 0 ? elSum : (typeof raw.excess_liquidity === "number" ? raw.excess_liquidity : null);
        if (!accountId) accountId = typeof raw.account_id === "string" ? raw.account_id : null;

        // Sum unrealizedPnl from /positions — this is what IBKR app shows as "Today" per position
        // (P&L since buy price, not since market open). This correctly handles intraday buys.
        let unrealizedPnlSum: number | null = null;
        if (posRes.ok && posRes.body) {
          const posRaw = posRes.body as Record<string, any>;
          const positions: any[] = posRaw.positions ?? (Array.isArray(posRaw) ? posRaw : []);
          let sum = 0;
          let hasAny = false;
          for (const p of positions) {
            if (typeof p.unrealizedPnl === "number" && p.mktValue > 0) {
              sum += p.unrealizedPnl;
              hasAny = true;
            }
          }
          if (hasAny) unrealizedPnlSum = sum;
        }
        // Fall back to /pnl unrealized_pnl if /positions didn't return data
        const unrealizedPnl: number | null = unrealizedPnlSum ?? (keys.length > 0 ? uplSum : (typeof raw.unrealized_pnl === "number" ? raw.unrealized_pnl : null));

        log.info("IBKR", "getPnl parsed", { dailyPnl, unrealizedPnl, unrealizedPnlSum, netLiquidation, accountId });
        // Persist to DB (fire-and-forget)
        // IMPORTANT: persist dailyPnl (dpl = today's change since market open), NOT unrealizedPnl (total return since buy)
        try {
          const update: Record<string, any> = {};
          if (dailyPnl != null) update.lastKnownTodayPnl = dailyPnl;
          if (netLiquidation != null) { update.lastKnownNetLiquidation = netLiquidation; update.lastKnownNLVAt = new Date(); }
          if (Object.keys(update).length > 0) await upsertPortfolioAccount(userId, update);
        } catch { /* best-effort */ }
        return {
          dailyPnl: dailyPnl,  // "Today" = dpl from /pnl partitioned (daily change since market open, NOT total return)
          unrealizedPnl,
          netLiquidation,
          marketValue,
          excessLiquidity,
          accountId,
          error: null,
          source: "ibind" as const,
        };
      }
      // IBIND returned non-ok
      const errBody = pnlRes.body as Record<string, any> | null;
      const errMsg = errBody?.error ?? `HTTP ${pnlRes.status}`;
      // Fallback to DB cache
      const dbAccount = await getPortfolioAccount(userId);
      if (dbAccount) {
        const cachedAt = dbAccount.lastKnownNLVAt;
        const isStaleDay = cachedAt
          ? new Date(cachedAt).toDateString() !== new Date().toDateString()
          : true;
        return {
          dailyPnl: isStaleDay ? null : (dbAccount.lastKnownTodayPnl ?? null),
          unrealizedPnl: null,
          netLiquidation: dbAccount.lastKnownNetLiquidation ?? null,
          marketValue: null,
          excessLiquidity: null,
          accountId: null,
          error: errMsg,
          source: "db_cache" as const,
        };
      }
      return { dailyPnl: null, unrealizedPnl: null, netLiquidation: null, marketValue: null, excessLiquidity: null, accountId: null, error: errMsg, source: "none" as const };
    } catch (err: any) {
      log.error("IBKR", "getPnl failed", { error: err.message });
      return { dailyPnl: null, unrealizedPnl: null, netLiquidation: null, marketValue: null, excessLiquidity: null, accountId: null, error: err.message, source: "none" as const };
    }
  }),

  // Sync IBKR live positions into portfolioHoldings DB (offline persistence)
  // Upserts by ticker: updates units+buyPrice+currentPrice for existing rows, inserts new ones.
  // Preserves: stopLoss, takeProfit, zivScore, notes, diary entries (never overwritten).
  // Removes: holdings that are no longer in IBKR (closed positions).
  syncFromIbkr: adminProcedure
    .input(z.object({
      positions: z.array(z.object({
        ticker: z.string().max(16),
        position: z.number(),      // quantity (shares)
        avgCost: z.number(),       // average cost basis per share
        mktPrice: z.number(),      // current market price
        mktValue: z.number(),      // total market value
        unrealizedPnl: z.number(),
        conid: z.number().int().optional(),        // IBKR Contract ID
        currency: z.string().max(8).optional(),
        assetClass: z.string().max(16).optional(),
      })),
      cashBalance: z.number().optional(),       // totalcashvalue from IBKR
      nlv: z.number().optional(),               // Net Liquidation Value from IBKR (netLiquidation)
      grossPositionValue: z.number().optional(), // Gross position value = שווי תיק (grosspositionvalue)
      todayPnl: z.number().optional(),          // dailypnl from IBKR
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const userId = ctx.user.id;
      const ibkrTickers = new Set(input.positions.map(p => p.ticker.toUpperCase()));

      const { fetchOpenLivePositionsByTicker, mergeIbkrHoldingWithLive } = await import("../portfolioHoldingsSync");
      const liveByTicker = await fetchOpenLivePositionsByTicker(db, userId);

      // Load existing DB holdings for this user
      const existing = await db.select().from(portfolioHoldings).where(eq(portfolioHoldings.userId, userId));
      const existingByTicker: Record<string, typeof existing[0]> = {};
      existing.forEach(h => { existingByTicker[h.ticker.toUpperCase()] = h; });

      let upserted = 0;
      let inserted = 0;
      let removed = 0;

      // ── Daily Position Change Detection ─────────────────────────────────────
      // Get today's date in Israel time (UTC+3) for grouping changes by day
      const nowMs = Date.now();
      const ilMs = nowMs + 3 * 3600 * 1000;
      const todayIL = new Date(ilMs).toISOString().slice(0, 10); // YYYY-MM-DD

      // Helper: cancel an IBKR order and clear orderId from DB
      const cancelIbkrOrder = async (orderId: string, holdingId: number, field: 'sl' | 'tp', ticker: string) => {
        try {
          // Get accountId from settings
          const settings = await db.select().from(ibkrSettings).where(eq(ibkrSettings.userId, userId)).limit(1);
          const accountId = settings[0]?.accountId;
          if (accountId) {
            await ibindRequest("DELETE", `/api/proxy/iserver/account/${accountId}/order/${orderId}`);
            log.info("ORDER", `Auto-cancelled ${field.toUpperCase()} order (units mismatch)`, { ticker, orderId });
          }
        } catch (e: any) {
          log.warn("ORDER", `Auto-cancel ${field.toUpperCase()} order failed (may already be gone)`, { ticker, orderId, error: e.message });
        }
        // Clear orderId from DB regardless
        const clearSet = field === 'sl'
          ? { ibkrSlOrderId: null as any, ibkrSlOrderQty: null as any }
          : { ibkrTpOrderId: null as any, ibkrTpOrderQty: null as any };
        await db.update(portfolioHoldings).set(clearSet).where(eq(portfolioHoldings.id, holdingId));
      };

      // Upsert each IBKR position into DB
      for (const pos of input.positions) {
        const ticker = pos.ticker.toUpperCase();
        const existingRow = existingByTicker[ticker];
        const merged = mergeIbkrHoldingWithLive(ticker, {
          position: pos.position,
          avgCost: pos.avgCost,
          mktPrice: pos.mktPrice,
        }, liveByTicker);

        if (existingRow) {
          // Check if quantity changed — if so, cancel any open SL/TP orders
          const qtyChanged = Math.abs((existingRow.units ?? 0) - merged.units) > 0.001;
          if (qtyChanged) {
            if (existingRow.ibkrSlOrderId) {
              log.warn("ORDER", `Units changed for ${ticker} (${existingRow.units} → ${pos.position}), auto-cancelling SL order`, { orderId: existingRow.ibkrSlOrderId });
              await cancelIbkrOrder(existingRow.ibkrSlOrderId, existingRow.id, 'sl', ticker);
            }
            if (existingRow.ibkrTpOrderId) {
              log.warn("ORDER", `Units changed for ${ticker} (${existingRow.units} → ${pos.position}), auto-cancelling TP order`, { orderId: existingRow.ibkrTpOrderId });
              await cancelIbkrOrder(existingRow.ibkrTpOrderId, existingRow.id, 'tp', ticker);
            }
          }
          // Update: units, buyPrice, currentPrice — livePositions.entryPrice wins for Elza
          const updateSet: Record<string, any> = {
            units: merged.units,
            buyPrice: merged.buyPrice,
            currentPrice: pos.mktPrice,
            ibkrUnrealizedPnl: pos.unrealizedPnl,
            priceUpdatedAt: new Date(),
          };
          if (merged.stopLoss != null) updateSet.stopLoss = merged.stopLoss;
          if (merged.takeProfit != null) updateSet.takeProfit = merged.takeProfit;
          if (merged.source) updateSet.source = merged.source;
          if (pos.conid && pos.conid > 0) updateSet.conid = pos.conid;
          await db.update(portfolioHoldings)
            .set(updateSet)
            .where(and(eq(portfolioHoldings.id, existingRow.id), eq(portfolioHoldings.userId, userId)));
          // ── Detect quantity change (increased / reduced) ──────────────────
          if (qtyChanged) {
            const unitsBefore = existingRow.units ?? 0;
            const unitsAfter = merged.units;
            const delta = unitsAfter - unitsBefore;
            const changeType = delta > 0 ? "increased" as const : "reduced" as const;
            // Estimate realized P&L for reduced positions: (mktPrice - avgCost) * units_sold
            const realizedPnl = delta < 0 ? (pos.mktPrice - (existingRow.buyPrice ?? pos.avgCost)) * Math.abs(delta) : null;
            await upsertDailyPositionChange({
              userId,
              ticker,
              date: todayIL,
              changeType,
              unitsBefore,
              unitsAfter,
              unitsDelta: delta,
              avgPriceBefore: existingRow.buyPrice ?? null,
              avgPriceAfter: pos.avgCost,
              marketPriceAtChange: pos.mktPrice,
              realizedPnl,
            });
          }
          upserted++;
        } else {
          // Insert new holding from IBKR — this is a newly OPENED position
          await upsertDailyPositionChange({
            userId,
            ticker: pos.ticker.toUpperCase(),
            date: todayIL,
            changeType: "opened",
            unitsBefore: 0,
            unitsAfter: merged.units,
            unitsDelta: merged.units,
            avgPriceBefore: null,
            avgPriceAfter: merged.buyPrice,
            marketPriceAtChange: pos.mktPrice,
            realizedPnl: null,
          });
          await db.insert(portfolioHoldings).values({
            userId,
            ticker,
            company: ticker,  // placeholder — user can edit
            buyPrice: merged.buyPrice,
            units: merged.units,
            currentPrice: pos.mktPrice,
            ibkrUnrealizedPnl: pos.unrealizedPnl,
            priceUpdatedAt: new Date(),
            source: merged.source ?? "ibkr",
            ...(merged.stopLoss != null ? { stopLoss: merged.stopLoss } : {}),
            ...(merged.takeProfit != null ? { takeProfit: merged.takeProfit } : {}),
            ...(pos.conid && pos.conid > 0 ? { conid: pos.conid } : {}),
          });
          inserted++;
        }
      }

      // Remove holdings that are no longer in IBKR (closed positions)
      // Only remove holdings that were synced from IBKR (source='ibkr'), NOT manual holdings
      for (const h of existing) {
        if (!ibkrTickers.has(h.ticker.toUpperCase()) && (h as any).source === 'ibkr') {
          // ── Record CLOSED position change ──────────────────────────────────
          const closedUnits = h.units ?? 0;
          const realizedPnl = closedUnits > 0 && h.buyPrice
            ? ((h.currentPrice ?? h.buyPrice) - h.buyPrice) * closedUnits
            : null;
          await upsertDailyPositionChange({
            userId,
            ticker: h.ticker.toUpperCase(),
            date: todayIL,
            changeType: "closed",
            unitsBefore: closedUnits,
            unitsAfter: 0,
            unitsDelta: -closedUnits,
            avgPriceBefore: h.buyPrice ?? null,
            avgPriceAfter: null,
            marketPriceAtChange: h.currentPrice ?? null,
            realizedPnl,
          });
          await db.delete(portfolioHoldings)
            .where(and(eq(portfolioHoldings.id, h.id), eq(portfolioHoldings.userId, userId)));
          removed++;
        }
      }

      // Save IBKR account data to DB (persists across offline periods)
      const accountUpdate: Record<string, any> = {};
      if (input.cashBalance != null) accountUpdate.cashBalance = input.cashBalance;
      // lastKnownNLV = grossPositionValue (שווי תיק = Portfolio Value shown in IBKR)
      // lastKnownNetLiquidation = nlv (Real Balance = net value after margin/loans)
      const portfolioValue = input.grossPositionValue ?? input.nlv;
      if (portfolioValue != null) {
        accountUpdate.lastKnownNLV = portfolioValue;
        accountUpdate.lastKnownNLVAt = new Date();
      }
      if (input.nlv != null) {
        accountUpdate.lastKnownNetLiquidation = input.nlv;
        if (portfolioValue == null) accountUpdate.lastKnownNLVAt = new Date();
      }
      if (input.cashBalance != null) accountUpdate.lastKnownCash = input.cashBalance;
      if (input.todayPnl != null) accountUpdate.lastKnownTodayPnl = input.todayPnl;
      if (Object.keys(accountUpdate).length > 0) {
        await upsertPortfolioAccount(userId, accountUpdate);
      }

      return { success: true, upserted, inserted, removed, total: input.positions.length };
    }),

  // Place a Stop Loss (STP) order via IBKR
  placeSTPOrder: adminProcedure
    .input(z.object({
      ticker: z.string().max(16),
      conid: z.number().int(),
      quantity: z.number().positive(),
      stopPrice: z.number().positive(),
      accountId: z.string().max(32),
    }))
    .mutation(async ({ ctx, input }) => {
      log.info("ORDER", `placeSTPOrder START`, { ticker: input.ticker, stopPrice: input.stopPrice, quantity: input.quantity, account: input.accountId, userId: ctx.user.id });
      try {
        // Step 0: Try IBIND first (primary path — iBeam is unreliable)
        // Use /orders/stop-loss endpoint directly (same as placeStopLossIbind).
        // conid is passed in from the frontend (already resolved by the UI).
        try {
          if (!input.conid || input.conid <= 0) {
            throw new Error(`conid is required for IBIND order placement (got ${input.conid}). Please ensure the holding has a valid conid.`);
          }
          const ibindBody = {
            conid: input.conid,
            side: "SELL" as const,
            quantity: input.quantity,
            stopPrice: input.stopPrice,
            tif: "GTC",
            outsideRth: false,
          };
          log.info("ORDER", `[IBIND] placeSTPOrder via /orders/stop-loss`, { ticker: input.ticker, conid: input.conid, stopPrice: input.stopPrice });
          const { ok: ibindOk, status: ibindStatus, body: ibindRespBody } = await ibindRequest(
            "POST",
            "/orders/stop-loss",
            ibindBody,
            { "X-Confirm-Live-Order": "yes" }
          );
          const ibindResp = ibindRespBody as Record<string, any>;
          if (!ibindOk) {
            const errMsg = ibindResp?.error ?? ibindResp?.message ?? `IBIND HTTP ${ibindStatus}`;
            log.error("ORDER", `[IBIND] /orders/stop-loss FAILED`, { status: ibindStatus, error: errMsg, ticker: input.ticker });
            throw new Error(errMsg);
          }
          const ibindOrderId = ibindResp?.result?.order_id ?? ibindResp?.result?.coid ?? null;
          log.info("ORDER", `placeSTPOrder via IBIND /orders/stop-loss SUCCESS`, { ticker: input.ticker, stopPrice: input.stopPrice, orderId: ibindOrderId });
          // Save orderId to DB
          if (ibindOrderId) {
            try {
              const db = await getDb();
              if (db) {
                await db.update(portfolioHoldings)
                  .set({ ibkrSlOrderId: String(ibindOrderId), ibkrSlOrderQty: input.quantity, stopLoss: input.stopPrice })
                  .where(and(eq(portfolioHoldings.userId, ctx.user.id), eq(portfolioHoldings.ticker, input.ticker.toUpperCase())));
              }
            } catch (dbErr: any) { log.warn("ORDER", `STP IBIND orderId DB save failed`, { error: dbErr.message }); }
          }
          // Telegram notification
          const ibindMsg = [`🛑 <b>Stop Loss Order Placed (IBIND)</b>`, ``, `Ticker: <b>${input.ticker}</b>`, `Stop Price: <b>$${input.stopPrice.toFixed(2)}</b>`, `Quantity: <b>${input.quantity}</b>`, `Order ID: <code>${ibindOrderId ?? "pending"}</code>`].join("\n");
          await sendTelegramMessage(ibindMsg).catch(() => {});
          return { ticker: input.ticker, stopPrice: input.stopPrice, quantity: input.quantity, orderId: ibindOrderId ? String(ibindOrderId) : null, replyMessages: [`STP placed via IBIND /orders/stop-loss`] };
        } catch (ibindErr: any) {
          log.error("ORDER", `placeSTPOrder IBIND FAILED`, { ticker: input.ticker, error: ibindErr.message });
          throw new TRPCError({ code: "BAD_REQUEST", message: `IBIND /orders/stop-loss failed: ${ibindErr.message}` });
        }
      } catch (err: any) {
        log.error("ORDER", `placeSTPOrder FAILED`, { ticker: input.ticker, stopPrice: input.stopPrice, error: err.message });
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err.message ?? "Failed to place STP order" });
      }
    }),

  // Place a Take Profit (LMT) order via IBKR
  placeLMTOrder: adminProcedure
    .input(z.object({
      ticker: z.string().max(16),
      conid: z.number().int(),
      quantity: z.number().positive(),
      limitPrice: z.number().positive(),
      accountId: z.string().max(32),
    }))
    .mutation(async ({ ctx, input }) => {
      log.info("ORDER", `placeLMTOrder START`, { ticker: input.ticker, limitPrice: input.limitPrice, quantity: input.quantity, account: input.accountId, userId: ctx.user.id });
      try {
        // Step 0: Try IBIND first (primary path — iBeam is unreliable)
        // Use /orders/take-profit endpoint directly (same as placeTakeProfitIbind).
        try {
          if (!input.conid || input.conid <= 0) {
            throw new Error(`conid is required for IBIND order placement (got ${input.conid}). Please ensure the holding has a valid conid.`);
          }
          const ibindLmtBody = {
            conid: input.conid,
            side: "SELL" as const,
            quantity: input.quantity,
            limitPrice: input.limitPrice,
            tif: "GTC",
            outsideRth: false,
          };
          log.info("ORDER", `[IBIND] placeLMTOrder via /orders/take-profit`, { ticker: input.ticker, conid: input.conid, limitPrice: input.limitPrice });
          const { ok: lmtOk, status: lmtStatus, body: lmtRespBody } = await ibindRequest(
            "POST",
            "/orders/take-profit",
            ibindLmtBody,
            { "X-Confirm-Live-Order": "yes" }
          );
          const lmtResp = lmtRespBody as Record<string, any>;
          if (!lmtOk) {
            const errMsg = lmtResp?.error ?? lmtResp?.message ?? `IBIND HTTP ${lmtStatus}`;
            log.error("ORDER", `[IBIND] /orders/take-profit FAILED`, { status: lmtStatus, error: errMsg, ticker: input.ticker });
            throw new Error(errMsg);
          }
          const lmtOrderId = lmtResp?.result?.order_id ?? lmtResp?.result?.coid ?? null;
          log.info("ORDER", `placeLMTOrder via IBIND /orders/take-profit SUCCESS`, { ticker: input.ticker, limitPrice: input.limitPrice, orderId: lmtOrderId });
          // Save orderId to DB
          if (lmtOrderId) {
            try {
              const db = await getDb();
              if (db) {
                await db.update(portfolioHoldings)
                  .set({ ibkrTpOrderId: String(lmtOrderId), ibkrTpOrderQty: input.quantity })
                  .where(and(eq(portfolioHoldings.userId, ctx.user.id), eq(portfolioHoldings.ticker, input.ticker.toUpperCase())));
              }
            } catch (dbErr: any) { log.warn("ORDER", `LMT IBIND orderId DB save failed`, { error: dbErr.message }); }
          }
          const lmtMsg = [`🎯 <b>Take Profit Order Placed (IBIND)</b>`, ``, `Ticker: <b>${input.ticker}</b>`, `Limit Price: <b>$${input.limitPrice.toFixed(2)}</b>`, `Quantity: <b>${input.quantity}</b>`, `Order ID: <code>${lmtOrderId ?? "pending"}</code>`].join("\n");
          await sendTelegramMessage(lmtMsg).catch(() => {});
          return { ticker: input.ticker, limitPrice: input.limitPrice, quantity: input.quantity, orderId: lmtOrderId ? String(lmtOrderId) : null, replyMessages: [`LMT placed via IBIND /orders/take-profit`] };
        } catch (ibindErr: any) {
          log.error("ORDER", `placeLMTOrder IBIND FAILED`, { ticker: input.ticker, error: ibindErr.message });
          throw new TRPCError({ code: "BAD_REQUEST", message: `IBIND /orders/take-profit failed: ${ibindErr.message}` });
        }
      } catch (err: any) {
        log.error("ORDER", `placeLMTOrder FAILED`, { ticker: input.ticker, limitPrice: input.limitPrice, error: err.message });
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err.message ?? "Failed to place LMT order" });
      }
    }),

  // AI Trading Chat — opinionated engine advisor with full Ziv methodology
  tradingChat: adminProcedure
    .input(z.object({
      ticker: z.string().max(16),
      userMessage: z.string().max(2000),
      chatHistory: z.array(z.object({
        role: z.enum(["engine", "user"]),
        text: z.string().max(2000),
      })).max(20),
      // Full analysis context
      analysisContext: z.object({
        score: z.number(),
        tier: z.string(),
        price: z.number(),
        ema50: z.number(),
        ema200: z.number(),
        rsi: z.number(),
        atr14: z.number(),
        weeklyEma50Slope: z.number(),
        stopLoss: z.number(),
        atrStopLoss: z.number(),
        emaStopLoss: z.number(),
        stopLossPct: z.number(),
        recommendedBuyPrice: z.number(),
        priceAction: z.string().nullable(),
        zivReason: z.string(),
        aiRisks: z.string(),
        aiEntryRationale: z.string(),
        passCount: z.number(),
        totalConditions: z.number(),
        positionSizeUsd: z.number().nullable(),
        positionSizePct: z.number().nullable(),
        tierLabel: z.string(),
        tierCapFraction: z.number(),
        totalPortfolioValue: z.number().nullable(),
      }),
      // Current holding (if user owns this stock)
      holdingContext: z.object({
        buyPrice: z.number(),
        units: z.number(),
        currentPrice: z.number(),
        pnlPct: z.number(),
        stopLoss: z.number().nullable().optional(),
        takeProfit: z.number().nullable().optional(),
      }).optional(),
      // User's edited SL/TP (may differ from engine recommendation)
      editedSL: z.number().optional(),
      editedTP: z.number().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { ticker, userMessage, chatHistory, analysisContext: a, holdingContext: hc, editedSL, editedTP } = input;

      // ── Full Ziv Engine System Prompt ──────────────────────────────────────────
      const SYSTEM_PROMPT = `You are the Ziv Trading Engine AI — a professional, opinionated trading advisor.
You are NOT a generic assistant. You are the embodiment of a specific, battle-tested trading system built by the user.
You have two responsibilities:
1. KNOW the user's methodology and risk rules deeply — never contradict them without strong evidence.
2. STAND YOUR GROUND — if the user proposes something that violates the engine's rules, push back clearly and explain why.

═══════════════════════════════════════════
🏗️ THE ZIV ENGINE — CORE METHODOLOGY
═══════════════════════════════════════════

📊 SCORING SYSTEM (0–10):
• 9–10 = 🔥 Gold Breakout (Donchian 20-day high + volume surge) → Enter at market, Winner's Leash 25% trailing stop
• 7–8  = ⭐ Gold Retest (EMA-50 bounce in bull trend) → Enter at EMA-50 zone with bullish price action confirmation
• 5–6  = ⚪ Near Entry Watch → WAIT. No entry until price returns to EMA-50 zone
• 1–4  = ❌ No Signal → DO NOT ENTER. Price below EMA-200 or negative weekly slope

📐 ENTRY CONDITIONS (all must pass for ideal entry):
1. Price > EMA-200 (primary trend is bullish)
2. Weekly EMA-50 slope > 0 (medium-term momentum is rising)
3. RSI 40–70 (healthy momentum — not overbought, not oversold)
4. Volume ratio 5d/20d ≥ 1.0 (volume confirmation)
5. Price within 3% of EMA-50 OR at Donchian breakout
6. Bullish price action (Hammer, Inside Bar, Engulfing)

🛑 STOP LOSS RULES:
• Primary: ATR-14 × 1.5 below entry (volatility-adjusted)
• Structural floor: EMA-50 × 0.97 (3% below EMA-50)
• Use the LOWER of the two (more room for the trade)
• Minimum: 0.5% below entry (never place SL above or at entry)
• NEVER widen SL beyond 10% from entry — if you need more room, the setup is wrong
• For Gold Breakout (score 9–10): use Winner's Leash 25% trailing stop instead of fixed SL

🎯 TAKE PROFIT RULES:
• Default: Entry + 2.5× risk (Risk/Reward = 2.5:1)
• For Gold Breakout: let the winner run with trailing stop — no fixed TP
• For Gold Retest: TP = Donchian 20-day high or +15% from entry (whichever is closer)
• NEVER set TP below 1.5× risk — that's a bad trade

💰 POSITION SIZING (1% Risk Rule):
• Risk per trade = 1% of total portfolio
• Shares = (Portfolio × 1%) ÷ (Entry − SL)
• Tier caps: 🔥 Gold Breakout (9–10) ≤ 20% | ⭐ Gold Retest (7–8) ≤ 10% | ⚪ Near Entry Watch (5–6) ≤ 5% | ❌ No Signal (≤4) skip
• If position size from risk rule exceeds tier cap → use tier cap
• NEVER risk more than 1% on a single trade
• NEVER allocate more than tier cap % to a single position

🚪 EXIT PROTOCOLS:
• ZIM Protocol: 7 consecutive closes below EMA-50 → structural death → EXIT FULL
• Diamond Hands: 5 consecutive closes below EMA-20 → structural weakness → EXIT or REDUCE
• No Signal: score drops to 1–4 → EXIT immediately
• Winner's Leash: for Gold Breakout stocks, only exit if price drops 25% from peak
• Weekly EMA-10 rule: for core holdings (high/medium sentiment), exit ONLY on weekly close below EMA-10
• Max 2 trades per ticker — if stopped out twice, do NOT re-enter

🧠 TRADING PHILOSOPHY:
• Trend following is king — never fight the trend
• EMA-200 is the line between bull and bear market for a stock
• Volume confirms everything — no volume = no conviction
• RSI is a filter, not a signal — use it to avoid overbought entries
• ATR-based stops respect volatility — fixed % stops are amateur
• Position sizing IS risk management — size down when uncertain
• Cash is a position — it's OK to wait for the right setup
• Momentum stocks (score 9–10) get more capital — ride the winners
• Cut losers fast, let winners run
• Never average down on a losing position

═══════════════════════════════════════════
📋 CURRENT ANALYSIS: ${ticker}
═══════════════════════════════════════════
Score: ${a.score}/10 (${a.tier})
Price: $${a.price.toFixed(2)}
EMA-50: $${a.ema50.toFixed(2)} | EMA-200: $${a.ema200.toFixed(2)}
Weekly EMA-50 Slope: ${a.weeklyEma50Slope.toFixed(3)} (${a.weeklyEma50Slope > 0 ? "RISING ✅" : "FALLING ❌"})
RSI-14: ${a.rsi.toFixed(1)} ${a.rsi >= 40 && a.rsi <= 70 ? "✅" : a.rsi > 70 ? "⚠️ OVERBOUGHT" : "⚠️ OVERSOLD"}
ATR-14: $${a.atr14.toFixed(2)}
Price Action: ${a.priceAction ?? "None detected"}
Entry Conditions: ${a.passCount}/${a.totalConditions} passed

Engine SL: $${a.stopLoss.toFixed(2)} (${a.stopLossPct.toFixed(1)}% risk)
  • ATR-based: $${a.atrStopLoss.toFixed(2)}
  • EMA-50 structural: $${a.emaStopLoss.toFixed(2)}
Engine TP: $${(a.recommendedBuyPrice * 1.15).toFixed(2)} (+15% from entry)
Recommended Entry: $${a.recommendedBuyPrice.toFixed(2)}
${a.positionSizeUsd != null ? `Position Size: $${a.positionSizeUsd.toLocaleString()} (${a.positionSizePct}% of portfolio) — ${a.tierLabel}` : "Position Size: N/A (no portfolio data)"}
${editedSL != null ? `\nUSER'S EDITED SL: $${editedSL.toFixed(2)} ${editedSL < a.stopLoss * 0.95 ? "⚠️ MUCH LOWER than engine rec" : editedSL > a.recommendedBuyPrice * 0.99 ? "🚨 TOO CLOSE to entry!" : "✅ reasonable"}` : ""}
${editedTP != null ? `USER'S EDITED TP: $${editedTP.toFixed(2)} ${editedTP < a.recommendedBuyPrice * 1.015 ? "🚨 TOO CLOSE to entry!" : editedTP < a.recommendedBuyPrice * 1.05 ? "⚠️ Very tight TP" : "✅ reasonable"}` : ""}
${hc ? `\nUSER HOLDS ${ticker}:\n• ${hc.units} shares @ $${hc.buyPrice.toFixed(2)} avg cost\n• P&L: ${hc.pnlPct >= 0 ? "+" : ""}${hc.pnlPct.toFixed(2)}%\n${hc.stopLoss ? `• Current SL in DB: $${hc.stopLoss.toFixed(2)}` : ""}\n${hc.takeProfit ? `• Current TP in DB: $${hc.takeProfit.toFixed(2)}` : ""}` : ""}

Ziv Engine Reason: ${a.zivReason}
Key Risks: ${a.aiRisks}

═══════════════════════════════════════════
🎯 YOUR ROLE IN THIS CONVERSATION
═══════════════════════════════════════════
You are the engine speaking to its creator/user. The user built you and trusts you.

RULES FOR THE CONVERSATION:
1. RESPOND IN HEBREW — always. The user speaks Hebrew.
2. Be DIRECT and OPINIONATED — say what you think, not what the user wants to hear.
3. If the user proposes a SL that is too wide (>10% from entry) or too tight (<0.5%), PUSH BACK.
4. If the user wants to ignore the ZIM Protocol or Diamond Hands signal, WARN THEM.
5. If the user proposes a TP that gives less than 1.5:1 R/R, REJECT IT with explanation.
6. ACKNOWLEDGE the user's logic if it has merit — don't be a robot.
7. Keep responses CONCISE — 2–4 sentences max. No essays.
8. End with a CLEAR RECOMMENDATION: what SL/TP you recommend and why.
9. If the user is right and the engine was too conservative, ADMIT IT and update your view.
10. NEVER say "it depends" without giving a concrete answer after.`;

      // Build conversation history for LLM
      const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
        { role: "system", content: SYSTEM_PROMPT },
      ];

      // Add chat history (last 10 messages max)
      const recentHistory = chatHistory.slice(-10);
      for (const msg of recentHistory) {
        messages.push({
          role: msg.role === "user" ? "user" : "assistant",
          content: msg.text,
        });
      }

      // Add current user message
      messages.push({ role: "user", content: userMessage });

      log.info("IBKR", `tradingChat request`, { ticker, userId: ctx.user.id, msgLen: userMessage.length, historyLen: chatHistory.length });
      const { invokeLLM } = await import("../_core/llm");
      const response = await invokeLLM({ messages, max_tokens: 400 } as any);
      const reply = response?.choices?.[0]?.message?.content ?? "לא הצלחתי לעבד את הבקשה. נסה שוב.";
      const replyText = typeof reply === "string" ? reply : JSON.stringify(reply);

      // ── Detect SL/TP updates in the engine reply ──────────────────────────────
      // Catches: "SL: $91.50", "Stop Loss: $91.50", "סטופ לוס: $145", "עדכן ל-$145", "SL ל-$145", "$145" after SL context
      let detectedSL: string | undefined;
      let detectedTP: string | undefined;
      const slMatch = replyText.match(
        /(?:SL|Stop[\s-]?Loss|\u05e1\u05d8\u05d5\u05e4 \u05dc\u05d5\u05e1|\u05e1\u05d8\u05d5\u05e4-\u05dc\u05d5\u05e1|stop loss|\u05e2\u05d3\u05db\u05df \u05dc-\$|\u05e1\u05dc)[:\s\u05dc\-]+\$?([\d]+(?:\.[\d]{1,4})?)/i
      );
      const tpMatch = replyText.match(
        /(?:TP|Take[\s-]?Profit|\u05d8\u05d9\u05d9\u05e7 \u05e4\u05e8\u05d5\u05e4\u05d9\u05d8|take profit|\u05d8\u05e4)[:\s\u05dc\-]+\$?([\d]+(?:\.[\d]{1,4})?)/i
      );
      // Also catch "עודכן ל-$145" or "ל-$145" near SL/TP context
      if (!slMatch) {
        const hebrewSL = replyText.match(/(?:\u05e1\u05dc|\u05e1\u05d8\u05d5\u05e4 \u05dc\u05d5\u05e1)[^\n]*?\$([\d]+(?:\.[\d]{1,4})?)/i);
        if (hebrewSL) detectedSL = hebrewSL[1];
      } else {
        detectedSL = slMatch[1];
      }
      if (!tpMatch) {
        const hebrewTP = replyText.match(/(?:\u05d8\u05e4|\u05d8\u05d9\u05d9\u05e7 \u05e4\u05e8\u05d5\u05e4\u05d9\u05d8)[^\n]*?\$([\d]+(?:\.[\d]{1,4})?)/i);
        if (hebrewTP) detectedTP = hebrewTP[1];
      } else {
        detectedTP = tpMatch[1];
      }

      log.debug("IBKR", `tradingChat response`, { ticker, replyLen: replyText.length, detectedSL, detectedTP });

      // ── Phase 7: Validate detected SL/TP geometry before persisting ─────────
      const direction: "long" | "short" = a.price > (a.ema200 ?? 0) ? "long" : "short";
      const levelCheck = (detectedSL || detectedTP) ? (await import("../tradeOutputValidator")).validateDetectedTradeLevels({
        ticker,
        entry: a.price,
        direction,
        sl: detectedSL,
        tp: detectedTP,
      }) : { valid: true, errors: [] as string[] };
      const safeSL = levelCheck.valid ? detectedSL : undefined;
      const safeTP = levelCheck.valid ? detectedTP : undefined;
      if (!levelCheck.valid && levelCheck.errors.length) {
        log.warn("IBKR", `tradingChat rejected invalid SL/TP from LLM`, { ticker, errors: levelCheck.errors });
      }

      // ── Persist both messages to DB ───────────────────────────────────────────
      const db = await getDb();
      if (db) await db.insert(engineChatHistory).values([
        { userId: ctx.user.id, ticker, role: "user", text: userMessage },
        { userId: ctx.user.id, ticker, role: "engine", text: replyText, updatedSL: safeSL, updatedTP: safeTP },
      ]);

      return { reply: replyText, detectedSL: safeSL, detectedTP: safeTP, validationErrors: levelCheck.valid ? undefined : levelCheck.errors };
    }),

  // Load chat history for a ticker
  getChatHistory: adminProcedure
    .input(z.object({ ticker: z.string().max(16) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const rows = await db
        .select()
        .from(engineChatHistory)
        .where(and(eq(engineChatHistory.userId, ctx.user.id), eq(engineChatHistory.ticker, input.ticker)))
        .orderBy(engineChatHistory.createdAt)
        .limit(100);
      return rows.map(r => ({ role: r.role as "engine" | "user", text: r.text, updatedSL: r.updatedSL, updatedTP: r.updatedTP }));
    }),

  // Clear chat history for a ticker
  clearChatHistory: adminProcedure
    .input(z.object({ ticker: z.string().max(16) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { success: false };
      const { eq: eqFn, and: andFn } = await import("drizzle-orm");
      await db.delete(engineChatHistory).where(andFn(eqFn(engineChatHistory.userId, ctx.user.id), eqFn(engineChatHistory.ticker, input.ticker)));
      return { success: true };
    }),

  // ── Market Order (BUY or SELL at market price via IBIND) ──────────────────────────────────────────
  placeMarketOrder: adminProcedure
    .input(z.object({
      ticker: z.string().max(16),
      conid: z.number().int().positive(),
      side: z.enum(["BUY", "SELL"]),
      quantity: z.number().positive(),
      slippagePct: z.number().min(0).max(2.0).optional(),
      outsideRth: z.boolean().optional().default(false),
      currentPrice: z.number().positive().optional(), // for chunking estimation
    }))
    .mutation(async ({ ctx, input }) => {
      log.info("ORDER", `placeMarketOrder START via /orders/market`, { ticker: input.ticker, side: input.side, quantity: input.quantity, slippagePct: input.slippagePct ?? "NONE (true MKT)", userId: ctx.user.id });
      // Prime /iserver/accounts before placing order (IBKR requires this once per session)
      await primeAccountsIfNeeded();
      try {
        // ── SELL: cap quantity to actual IBKR position to prevent margin rejection ──
        // If UI sends more shares than IBKR holds, IBKR interprets it as a SHORT attempt
        let safeQuantity = input.quantity;
        if (input.side === "SELL") {
          try {
            const posRes = await ibindCached("GET", "/positions");
            if (posRes.ok) {
              const ibkrPos = ((posRes.body as any)?.positions ?? [])
                .find((p: any) => p.conid === input.conid || (p.contractDesc ?? "").toUpperCase() === input.ticker.toUpperCase());
              if (ibkrPos) {
                const ibkrQty = Math.abs(ibkrPos.position ?? 0);
                if (ibkrQty > 0 && input.quantity > ibkrQty) {
                  log.warn("ORDER", `[SELL_CAP] ${input.ticker}: requested qty ${input.quantity} > IBKR qty ${ibkrQty} — capping to avoid margin reject`);
                  safeQuantity = ibkrQty;
                }
              }
            }
          } catch(_capErr) { /* non-critical — proceed with original qty */ }
        }

        // ── Chunked order: IBIND Gateway enforces per-order value cap ($100K).
        // If SELL value exceeds cap, split into multiple sequential orders.
        const MAX_ORDER_VALUE = 100_000;
        const estimatedPrice = input.currentPrice ?? 0;
        const estimatedValue = safeQuantity * estimatedPrice;
        let chunks: number[] = [];
        if (input.side === "SELL" && estimatedPrice > 0 && estimatedValue > MAX_ORDER_VALUE) {
          const maxQtyPerChunk = Math.floor(MAX_ORDER_VALUE / estimatedPrice);
          let remaining = safeQuantity;
          while (remaining > 0) {
            const chunkQty = Math.min(remaining, maxQtyPerChunk);
            chunks.push(chunkQty);
            remaining -= chunkQty;
          }
          log.info("ORDER", `[SELL_CHUNK] ${input.ticker}: total qty ${safeQuantity} (est. value $${estimatedValue.toFixed(0)}) → ${chunks.length} chunks of max ${maxQtyPerChunk} (cap $${MAX_ORDER_VALUE})`);
        } else {
          chunks = [safeQuantity];
        }

        // Helper: attempt a single order with retry for snapshot_unavailable
        const attemptOrder = async (qty: number, attempt: number): Promise<{ ok: boolean; status: number; body: unknown }> => {
          const orderBody: Record<string, any> = {
            conid: input.conid,
            side: input.side,
            quantity: qty,
            tif: "DAY",
            outsideRth: input.outsideRth,
            confirm_orders: true,
          };
          if (input.slippagePct != null && input.slippagePct > 0) {
            orderBody.slippage_pct = input.slippagePct;
          }
          const result = await ibindRequest("POST", "/orders/market", orderBody, { "X-Confirm-Live-Order": "yes" });
          const p = result.body as any;
          // Retry on snapshot_unavailable (market data not yet loaded)
          if (!result.ok && p?.error === "snapshot_unavailable" && attempt < 3) {
            log.warn("ORDER", `placeMarketOrder snapshot_unavailable — retry ${attempt}/3 in 2s`, { ticker: input.ticker });
            await new Promise(r => setTimeout(r, 2000));
            return attemptOrder(qty, attempt + 1);
          }
          return result;
        };

        let lastOrderId: string | null = null;
        let lastMarketPrice: number | null = null;
        let lastLimitPrice: number | null = null;

        for (let i = 0; i < chunks.length; i++) {
          const chunkQty = chunks[i];
          log.info("ORDER", `placeMarketOrder ${input.side} ${input.ticker} [chunk ${i + 1}/${chunks.length}] qty=${chunkQty}`);

          const { ok, status, body: resp } = await attemptOrder(chunkQty, 1);
          const parsed = resp as any;

          if (!ok) {
            const errCode = parsed?.error ?? parsed?.message ?? `IBKR returned HTTP ${status}`;
            log.error("ORDER", `placeMarketOrder FAILED chunk ${i + 1}/${chunks.length}`, { ticker: input.ticker, error: errCode, status, fullResp: JSON.stringify(parsed).slice(0, 400) });

            // If first chunk fails, try all the original error handling paths
            if (i === 0) {
              if (status === 403 && errCode === "live_order_confirm_missing") {
                throw new TRPCError({ code: "FORBIDDEN", message: "IBKR דורש אישור לפקודה בחשבון Live — נסה שוב" });
              }
              if (status === 401 || status === 503) {
                log.warn("ORDER", `placeMarketOrder session issue — attempting session/start and retry`, { ticker: input.ticker, status });
                await ibindRequest("POST", "/session/start");
                await new Promise(r => setTimeout(r, 1000));
                const retryBody: Record<string, any> = {
                  conid: input.conid, side: input.side, quantity: chunkQty,
                  tif: "DAY", outsideRth: input.outsideRth, confirm_orders: true,
                };
                if (input.slippagePct != null && input.slippagePct > 0) retryBody.slippage_pct = input.slippagePct;
                const retry = await ibindRequest("POST", "/orders/market", retryBody, { "X-Confirm-Live-Order": "yes" });
                if (retry.ok) {
                  const rp = retry.body as any;
                  lastOrderId = rp?.result?.order_id ?? rp?.order_id ?? null;
                  lastMarketPrice = rp?.market_price_used ?? null;
                  lastLimitPrice = rp?.limit_price_used ?? null;
                  log.info("ORDER", `placeMarketOrder chunk ${i + 1} SUCCESS (after session retry)`, { ticker: input.ticker, orderId: lastOrderId });
                  // Continue to next chunk
                  if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
                  continue;
                }
                throw new TRPCError({ code: "UNAUTHORIZED", message: "IBKR session לא פעיל — התחבר מחדש" });
              }
              if (status === 502 && errCode === "ibkr_place_order_error") {
                log.warn("ORDER", `placeMarketOrder /orders/market rejected — fallback to /order endpoint`, { ticker: input.ticker });
                const settings = await getIbkrSettings(ctx.user.id);
                const accountId = settings?.accountId;
                if (accountId) {
                  const fallbackBody = {
                    account_id: accountId, ticker: input.ticker,
                    side: input.side, order_type: "MKT", quantity: chunkQty,
                  };
                  const fallback = await ibindRequest("POST", "/order", fallbackBody);
                  const fp = fallback.body as any;
                  if (fallback.ok) {
                    lastOrderId = fp?.result?.order_id ?? fp?.order_id ?? null;
                    lastMarketPrice = fp?.market_price_used ?? fp?.fill_price ?? null;
                    log.info("ORDER", `placeMarketOrder chunk ${i + 1} SUCCESS (via /order fallback)`, { ticker: input.ticker, orderId: lastOrderId });
                    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
                    continue;
                  }
                  log.error("ORDER", `placeMarketOrder /order fallback also FAILED`, { ticker: input.ticker, status: fallback.status });
                }
              }
              throw new TRPCError({ code: "BAD_REQUEST", message: `IBKR דחה את ההוראה: ${errCode}` });
            }
            // Later chunk failed — partial success, log warning and break
            log.warn("ORDER", `placeMarketOrder ${input.ticker} partial: ${i}/${chunks.length} chunks succeeded, chunk ${i + 1} failed: ${errCode}`);
            break;
          }

          // Chunk succeeded
          lastOrderId = parsed?.result?.order_id ?? parsed?.order_id ?? null;
          lastMarketPrice = parsed?.market_price_used ?? null;
          lastLimitPrice = parsed?.limit_price_used ?? null;
          log.info("ORDER", `placeMarketOrder chunk ${i + 1}/${chunks.length} SUCCESS`, { ticker: input.ticker, side: input.side, orderId: lastOrderId });

          // Small delay between chunks
          if (i < chunks.length - 1) {
            await new Promise(r => setTimeout(r, 500));
          }
        }

        log.info("ORDER", `placeMarketOrder COMPLETE`, { ticker: input.ticker, side: input.side, chunks: chunks.length, lastOrderId });
        return {
          ticker: input.ticker,
          side: input.side,
          quantity: input.quantity,
          orderId: lastOrderId ? String(lastOrderId) : null,
          marketPrice: lastMarketPrice,
          limitPrice: lastLimitPrice,
          slippagePct: input.slippagePct ?? null,
        };
      } catch (err: any) {
        if (err instanceof TRPCError) throw err;
        log.error("ORDER", `placeMarketOrder FAILED`, { ticker: input.ticker, error: err.message });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err.message });
      }
    }),

  // Log an order placed via the Gateway (audit trail)
  logOrder: protectedProcedure
    .input(z.object({
      ticker: z.string().max(16),
      conid: z.number().int(),
      side: z.enum(["BUY", "SELL"]),
      orderType: z.enum(["MKT", "LMT", "STP"]),
      quantity: z.number().positive(),
      price: z.number().optional(),        // limit price
      stopPrice: z.number().optional(),    // stop price
      ibkrOrderId: z.string().optional(),  // returned by Gateway
      status: z.string().optional(),       // e.g. "PreSubmitted", "Submitted"
      accountId: z.string().max(32),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      // Extract real IP (behind Manus reverse proxy)
      const ip = (ctx.req?.headers?.["x-forwarded-for"] as string)?.split(",")[0]?.trim()
        ?? ctx.req?.socket?.remoteAddress
        ?? "unknown";
      const ua = (ctx.req?.headers?.["user-agent"] as string | undefined)?.slice(0, 512);
      if (db) {
        try {
          await db.insert(orderAuditLog).values({
            userId: ctx.user.id,
            userEmail: ctx.user.email ?? undefined,
            ipAddress: ip,
            userAgent: ua,
            ticker: input.ticker,
            side: input.side,
            orderType: input.orderType,
            quantity: String(input.quantity),
            price: input.price != null ? String(input.price) : undefined,
            stopPrice: input.stopPrice != null ? String(input.stopPrice) : undefined,
            ibkrOrderId: input.ibkrOrderId ?? undefined,
            status: input.status ?? undefined,
            accountId: input.accountId,
            createdAt: Date.now(),
          });
        } catch (auditErr) {
          // Never let audit failure block the order response
          log.warn("ORDER", "Audit log insert failed", { error: String(auditErr) });
        }
      }
      log.info("ORDER", "Order logged", {
        userId: ctx.user.id, ip, ticker: input.ticker,
        side: input.side, orderType: input.orderType, qty: input.quantity,
      });
      return {
        success: true,
        logged: {
          userId: ctx.user.id,
          ip,
          ...input,
          loggedAt: new Date().toISOString(),
        },
      };
    }),

  // Persist a connection log entry to DB
  addConnectionLog: adminProcedure
    .input(z.object({
      message: z.string().max(1000),
      type: z.enum(["info", "success", "error", "warn"]).default("info"),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { ok: false };
      const userId = ctx.user.id;
      // Insert new entry
      await db.insert(ibkrConnectionLog).values({ userId, message: input.message, type: input.type });
      // Keep only last 200 entries per user — delete older ones
      const entries = await db.select({ id: ibkrConnectionLog.id })
        .from(ibkrConnectionLog)
        .where(eq(ibkrConnectionLog.userId, userId))
        .orderBy(ibkrConnectionLog.createdAt);
      if (entries.length > 200) {
        const toDelete = entries.slice(0, entries.length - 200).map(e => e.id);
        for (const id of toDelete) {
          await db.delete(ibkrConnectionLog).where(eq(ibkrConnectionLog.id, id));
        }
      }
      return { ok: true };
    }),

  // Get connection log entries for last N hours
  getConnectionLog: adminProcedure
    .input(z.object({ hours: z.number().int().min(1).max(24).default(1) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const since = new Date(Date.now() - input.hours * 60 * 60 * 1000);
      const { gte } = await import("drizzle-orm");
      const entries = await db.select()
        .from(ibkrConnectionLog)
        .where(and(eq(ibkrConnectionLog.userId, ctx.user.id), gte(ibkrConnectionLog.createdAt, since)))
        .orderBy(ibkrConnectionLog.createdAt);
      return entries.map(e => ({ id: e.id, message: e.message, type: e.type as "info"|"success"|"error"|"warn", time: e.createdAt }));
    }),

  /**
   * Sync SL/TP order status from IBKR live orders.
   *
   * The frontend passes the current list of open orders from the IBKR Gateway.
   * We compare each holding's ibkrSlOrderId / ibkrTpOrderId against that list.
   * Any order ID that is NOT in the live list (filled, cancelled, expired) gets
   * cleared from the DB so the ✓ checkmark disappears.
   *
   * Returns: { cleared: number, details: { ticker, field, orderId }[] }
   */
  syncSlTpOrderStatus: adminProcedure
    .input(z.object({
      // Array of order IDs currently open/active in IBKR (orderId as string)
      activeOrderIds: z.array(z.string()),
      // Full order objects from IBKR (optional) — used to match ticker → orderId for missing DB entries
      activeOrders: z.array(z.object({
        orderId: z.string(),
        ticker: z.string().optional(),
        symbol: z.string().optional(),
        orderType: z.string().optional(), // STP, LMT, MKT, etc.
        side: z.string().optional(),      // BUY or SELL
        status: z.string().optional(),    // PreSubmitted, Submitted, Filled, etc.
      })).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { cleared: 0, populated: 0, details: [] };
      const userId = ctx.user.id;

      // Fetch ALL holdings for this user
      const holdings = await db.select({
        id: portfolioHoldings.id,
        ticker: portfolioHoldings.ticker,
        ibkrSlOrderId: portfolioHoldings.ibkrSlOrderId,
        ibkrTpOrderId: portfolioHoldings.ibkrTpOrderId,
        stopLoss: portfolioHoldings.stopLoss,
        takeProfit: portfolioHoldings.takeProfit,
        units: portfolioHoldings.units,
      })
        .from(portfolioHoldings)
        .where(eq(portfolioHoldings.userId, userId));

      const activeSet = new Set(input.activeOrderIds.map(id => String(id)));
      const cleared: { ticker: string; field: 'sl' | 'tp'; orderId: string }[] = [];
      let populated = 0;

      // ── Step 1: Clear stale order IDs ────────────────────────────────────────
      for (const h of holdings) {
        if (h.ibkrSlOrderId && !activeSet.has(String(h.ibkrSlOrderId))) {
          await db.update(portfolioHoldings)
            .set({ ibkrSlOrderId: null as any, ibkrSlOrderQty: null as any })
            .where(and(eq(portfolioHoldings.id, h.id), eq(portfolioHoldings.userId, userId)));
          cleared.push({ ticker: h.ticker, field: 'sl', orderId: h.ibkrSlOrderId });
          log.info("ORDER", `Cleared stale SL order ID from DB`, { ticker: h.ticker, orderId: h.ibkrSlOrderId });
        }
        if (h.ibkrTpOrderId && !activeSet.has(String(h.ibkrTpOrderId))) {
          await db.update(portfolioHoldings)
            .set({ ibkrTpOrderId: null as any, ibkrTpOrderQty: null as any })
            .where(and(eq(portfolioHoldings.id, h.id), eq(portfolioHoldings.userId, userId)));
          cleared.push({ ticker: h.ticker, field: 'tp', orderId: h.ibkrTpOrderId });
          log.info("ORDER", `Cleared stale TP order ID from DB`, { ticker: h.ticker, orderId: h.ibkrTpOrderId });
        }
      }

      // ── Step 2: Populate missing order IDs from live IBKR orders ─────────────
      // Match live IBKR orders to holdings by ticker/symbol.
      // STP (side=SELL) → ibkrSlOrderId; LMT (side=SELL) → ibkrTpOrderId
      log.info("ORDER", `syncSlTpOrderStatus step2: received ${input.activeOrders?.length ?? 0} activeOrders`, {
        sample: input.activeOrders?.slice(0, 3),
      });
      if (input.activeOrders && input.activeOrders.length > 0) {
        // Re-fetch holdings after step 1 clears (so we see fresh state)
        const freshHoldings = await db.select({
          id: portfolioHoldings.id,
          ticker: portfolioHoldings.ticker,
          ibkrSlOrderId: portfolioHoldings.ibkrSlOrderId,
          ibkrTpOrderId: portfolioHoldings.ibkrTpOrderId,
          units: portfolioHoldings.units,
        })
          .from(portfolioHoldings)
          .where(and(eq(portfolioHoldings.userId, userId)));

        const holdingByTicker = new Map(freshHoldings.map(h => [h.ticker.toUpperCase(), h]));

        for (const order of input.activeOrders) {
          // IBIND returns 'symbol' field (not 'ticker') — support both
          const orderTicker = (order.ticker ?? order.symbol ?? "").toUpperCase().trim();
          if (!orderTicker) {
            log.info("ORDER", `syncSlTpOrderStatus: order has no ticker/symbol`, { order });
            continue;
          }
          const holding = holdingByTicker.get(orderTicker);
          if (!holding) {
            log.info("ORDER", `syncSlTpOrderStatus: no holding found for ticker ${orderTicker}`);
            continue;
          }
          if (holding.units <= 0) continue;

          const ordType = (order.orderType ?? "").toUpperCase().trim();
          const ordSide = (order.side ?? "").toUpperCase().trim();
          const ordId = String(order.orderId);

          log.info("ORDER", `syncSlTpOrderStatus: checking order`, { ticker: orderTicker, ordType, ordSide, ordId, hasSl: !!holding.ibkrSlOrderId, hasTp: !!holding.ibkrTpOrderId });

          // IBKR returns orderType as "Stop" (capitalized) — after toUpperCase() it becomes "STOP".
          // Also support "STP", "STOP_LIMIT", etc.
          const isStp = ordType === "STOP" || ordType === "STP" || ordType === "STOP_LIMIT"
            || ordType.startsWith("STOP") || ordType.startsWith("STP");
          // IBKR returns orderType as "Limit" — after toUpperCase() it becomes "LIMIT".
          // Also support "LMT".
          const isLmt = ordType === "LIMIT" || ordType === "LMT" || ordType.startsWith("LIMIT");

          log.info("ORDER", `syncSlTpOrderStatus: matching order`, {
            ticker: orderTicker, ordType, ordSide, ordId,
            isStp, isLmt,
            hasSl: !!holding.ibkrSlOrderId, hasTp: !!holding.ibkrTpOrderId
          });

          // STP SELL → Stop Loss order
          if (isStp && ordSide === "SELL" && !holding.ibkrSlOrderId) {
            await db.update(portfolioHoldings)
              .set({ ibkrSlOrderId: ordId })
              .where(and(eq(portfolioHoldings.id, holding.id), eq(portfolioHoldings.userId, userId)));
            log.info("ORDER", `Populated missing SL orderId from live IBKR orders`, { ticker: orderTicker, orderId: ordId, ordType });
            populated++;
          }
          // LMT/LIMIT SELL → Take Profit order
          else if (isLmt && ordSide === "SELL" && !holding.ibkrTpOrderId) {
            await db.update(portfolioHoldings)
              .set({ ibkrTpOrderId: ordId })
              .where(and(eq(portfolioHoldings.id, holding.id), eq(portfolioHoldings.userId, userId)));
            log.info("ORDER", `Populated missing TP orderId from live IBKR orders`, { ticker: orderTicker, orderId: ordId, ordType });
            populated++;
          }
        }
        if (populated > 0) log.info("ORDER", `syncSlTpOrderStatus: populated ${populated} missing order IDs from IBKR`);
      }

      // ── Step 3: Telegram alerts for cleared orders (market days only) ──────────
      // The SL/TP enforcement constantly REPLACES orders (trail / break-even /
      // re-sync = cancel-old + place-new). A cleared orderId therefore does NOT
      // mean "unprotected" — the position is usually freshly protected by the
      // replacement. So we only alert on a SL clear that leaves a genuinely
      // NAKED position (open + no resting stop at the broker). TP clears never
      // mean unprotected downside (filled = closing, or replaced) → no Telegram.

      // Resting-stop lookup from the SAME live broker orders we already fetched:
      // a STP SELL for a ticker means there is a stop protecting that position.
      const restingStopTickers = new Set<string>();
      if (input.activeOrders && input.activeOrders.length > 0) {
        for (const order of input.activeOrders) {
          const orderTicker = (order.ticker ?? order.symbol ?? "").toUpperCase().trim();
          if (!orderTicker) continue;
          const ordType = (order.orderType ?? "").toUpperCase().trim();
          const ordSide = (order.side ?? "").toUpperCase().trim();
          const isStp = ordType === "STOP" || ordType === "STP" || ordType === "STOP_LIMIT"
            || ordType.startsWith("STOP") || ordType.startsWith("STP");
          if (isStp && ordSide === "SELL") restingStopTickers.add(orderTicker);
        }
      }

      // Fresh post-sync holdings: tells us if the position is still open and
      // whether Step 2 re-populated a replacement ibkrSlOrderId.
      const postSyncHoldings = await db.select({
        ticker: portfolioHoldings.ticker,
        ibkrSlOrderId: portfolioHoldings.ibkrSlOrderId,
        units: portfolioHoldings.units,
      })
        .from(portfolioHoldings)
        .where(eq(portfolioHoldings.userId, userId));
      const postSyncByTicker = new Map(postSyncHoldings.map(h => [h.ticker.toUpperCase(), h]));

      const isWeekend = (() => { const d = new Date().getDay(); return d === 0 || d === 6; })();
      if (!isWeekend) {
        for (const item of cleared) {
          // TP clears are never an "unprotected" signal — suppress Telegram.
          if (item.field === 'tp') continue;

          const tickerKey = item.ticker.toUpperCase();
          const holding = postSyncByTicker.get(tickerKey);

          // Position closed / zero units → nothing to protect → suppress.
          if (!holding || holding.units <= 0) continue;

          // A replacement stop exists (Step 2 re-populated the SL orderId, or a
          // resting STP SELL for this ticker is live at the broker) → protected → suppress.
          if (holding.ibkrSlOrderId || restingStopTickers.has(tickerKey)) continue;

          // Naked detection: sync/Step-2 still re-arms SL; Telegram alert disabled (user request).
        }
      } // end !isWeekend

      return { cleared: cleared.length, populated, details: cleared };
    }),

  // ── NEW IBIND ORDER ENDPOINTS (deployed 2026-04-23) ──────────────────────────
  // These use the new Flask endpoints on the IBIND server.
  // All require: HMAC + Bearer + X-Confirm-Live-Order: yes header.
  // Account U16881054 is a LIVE account (~$102K real money).

  /**
   * Place a Stop-Loss (STP) order via new IBIND /orders/stop-loss endpoint.
   * POST /orders/stop-loss { conid, side, quantity, stopPrice, tif?, outsideRth? }
   */
  placeStopLossIbind: adminProcedure
    .input(z.object({
      conid: z.number().int().positive(),
      side: z.enum(["BUY", "SELL"]),
      quantity: z.number().positive(),
      stopPrice: z.number().positive(),
      tif: z.enum(["GTC", "DAY"]).default("GTC"),
      outsideRth: z.boolean().default(false),
      ticker: z.string().max(16).optional(), // for logging/Telegram only
    }))
    .mutation(async ({ ctx, input }) => {
      // Round stopPrice to nearest tick (default 0.01; DNN and sub-penny stocks use 0.0001)
      // IBKR rejects 'Invalid order price fields' if price is not on the tick grid
      const roundToTick = (price: number, tick: number) => {
        const factor = 1 / tick;
        return Math.round(price * factor) / factor;
      };
      const roundedStop = roundToTick(input.stopPrice, 0.0001); // 0.0001 covers all US stocks
      log.info("ORDER", "placeStopLossIbind START", { conid: input.conid, side: input.side, stopPrice: input.stopPrice, roundedStop, qty: input.quantity, userId: ctx.user.id });
      // Prime /iserver/accounts before placing order (IBKR requires this once per session)
      await primeAccountsIfNeeded();
      const body = {
        conid: input.conid,
        side: input.side,
        quantity: input.quantity,
        stopPrice: roundedStop,
        tif: input.tif,
        outsideRth: input.outsideRth,
      };
      const { ok, status, body: resp } = await ibindRequest(
        "POST",
        "/orders/stop-loss",
        body,
        { "X-Confirm-Live-Order": "yes" }
      );
      const r = resp as Record<string, any>;
      if (!ok) {
        const errCode = r?.error ?? r?.message ?? `HTTP ${status}`;
        // Log full IBKR response for diagnosis
        log.error("ORDER", "placeStopLossIbind FAILED", { status, error: errCode, fullResp: JSON.stringify(r).slice(0, 800) });
        if (status === 403 && errCode === "live_order_confirm_missing") throw new TRPCError({ code: "FORBIDDEN", message: "Missing X-Confirm-Live-Order header" });
        if (status === 400) throw new TRPCError({ code: "BAD_REQUEST", message: `${errCode} (stopPrice sent: ${roundedStop})` });
        if (status === 401 || status === 503) throw new TRPCError({ code: "UNAUTHORIZED", message: "IBKR session not active" });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: r?.message ?? errCode });
      }
      // IBIND may return orderId at different paths depending on version:
      // { result: { order_id: ... } } or { orderId: ... } or { order_id: ... } or { result: { coid: ... } }
      const orderId = r?.result?.order_id ?? r?.result?.orderId ?? r?.result?.coid
        ?? r?.orderId ?? r?.order_id ?? r?.coid ?? undefined;
      log.info("ORDER", "placeStopLossIbind SUCCESS", { orderId, ticker: input.ticker, rawResp: JSON.stringify(r).slice(0, 400) });
      // Save orderId to DB so SL/TP Monitor shows ✓
      if (orderId) {
        try {
          const dbConn = await getDb();
          if (dbConn) {
            // Match by ticker (required for DB update — conid not stored in portfolioHoldings)
            if (input.ticker) {
              await dbConn.update(portfolioHoldings)
                .set({ ibkrSlOrderId: String(orderId), ibkrSlOrderQty: input.quantity, stopLoss: input.stopPrice })
                .where(and(eq(portfolioHoldings.userId, ctx.user.id), eq(portfolioHoldings.ticker, input.ticker.toUpperCase())));
            }
            log.info("ORDER", "placeStopLossIbind: saved orderId to DB", { orderId, ticker: input.ticker, conid: input.conid });
          }
        } catch (dbErr: any) { log.warn("ORDER", "placeStopLossIbind: DB save failed", { error: dbErr.message }); }
      }
      // Telegram notification
      await sendTelegramMessage([
        `🛑 <b>Stop Loss (IBIND)</b>`,
        `Ticker: <b>${input.ticker ?? input.conid}</b>`,
        `Stop Price: <b>$${input.stopPrice.toFixed(2)}</b>  |  Qty: <b>${input.quantity}</b>  |  Side: ${input.side}`,
        `Order ID: <code>${orderId ?? "pending"}</code>`,
      ].join("\n")).catch(() => {});
      // Log journal event
      await logJournalEvent({
        userId: ctx.user.id,
        eventType: "sl_order",
        ticker: input.ticker ?? null,
        units: input.quantity,
        stopLoss: input.stopPrice,
        orderId: orderId ?? null,
        notes: `Stop Loss בוצע דרך IBIND | Stop: $${input.stopPrice.toFixed(2)} | Qty: ${input.quantity}`,
      }).catch(() => {});
      return { success: true, type: "stop-loss" as const, orderId, result: r?.result };
    }),

  /**
   * Place a Take-Profit (LMT) order via new IBIND /orders/take-profit endpoint.
   * POST /orders/take-profit { conid, side, quantity, limitPrice, tif?, outsideRth? }
   */
  placeTakeProfitIbind: adminProcedure
    .input(z.object({
      conid: z.number().int().positive(),
      side: z.enum(["BUY", "SELL"]),
      quantity: z.number().positive(),
      limitPrice: z.number().positive(),
      tif: z.enum(["GTC", "DAY"]).default("GTC"),
      outsideRth: z.boolean().default(false),
      ticker: z.string().max(16).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const roundToTick = (price: number, tick: number) => Math.round(price * (1 / tick)) / (1 / tick);
      const roundedLimit = roundToTick(input.limitPrice, 0.0001);
      log.info("ORDER", "placeTakeProfitIbind START", { conid: input.conid, side: input.side, limitPrice: input.limitPrice, roundedLimit, qty: input.quantity, userId: ctx.user.id });
      // Prime /iserver/accounts before placing order (IBKR requires this once per session)
      await primeAccountsIfNeeded();
      const body = {
        conid: input.conid,
        side: input.side,
        quantity: input.quantity,
        limitPrice: roundedLimit,
        tif: input.tif,
        outsideRth: input.outsideRth,
      };
      const { ok, status, body: resp } = await ibindRequest(
        "POST",
        "/orders/take-profit",
        body,
        { "X-Confirm-Live-Order": "yes" }
      );
      const r = resp as Record<string, any>;
      if (!ok) {
        const errCode = r?.error ?? r?.message ?? `HTTP ${status}`;
        log.error("ORDER", "placeTakeProfitIbind FAILED", { status, error: errCode, fullResp: JSON.stringify(r).slice(0, 800) });
        if (status === 403) throw new TRPCError({ code: "FORBIDDEN", message: "Missing X-Confirm-Live-Order header" });
        if (status === 400) throw new TRPCError({ code: "BAD_REQUEST", message: `${errCode} (limitPrice sent: ${roundedLimit})` });
        if (status === 401 || status === 503) throw new TRPCError({ code: "UNAUTHORIZED", message: "IBKR session not active" });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: r?.message ?? errCode });
      }
      // IBIND may return orderId at different paths depending on version:
      // { result: { order_id: ... } } or { orderId: ... } or { order_id: ... } or { result: { coid: ... } }
      const orderId = r?.result?.order_id ?? r?.result?.orderId ?? r?.result?.coid
        ?? r?.orderId ?? r?.order_id ?? r?.coid ?? undefined;
      log.info("ORDER", "placeTakeProfitIbind SUCCESS", { orderId, ticker: input.ticker, rawResp: JSON.stringify(r).slice(0, 400) });
      // Save orderId to DB so SL/TP Monitor shows ✓
      if (orderId) {
        try {
          const dbConn = await getDb();
          if (dbConn) {
            if (input.ticker) {
              await dbConn.update(portfolioHoldings)
                .set({ ibkrTpOrderId: String(orderId), ibkrTpOrderQty: input.quantity, takeProfit: input.limitPrice })
                .where(and(eq(portfolioHoldings.userId, ctx.user.id), eq(portfolioHoldings.ticker, input.ticker.toUpperCase())));
            }
            log.info("ORDER", "placeTakeProfitIbind: saved orderId to DB", { orderId, ticker: input.ticker, conid: input.conid });
          }
        } catch (dbErr: any) { log.warn("ORDER", "placeTakeProfitIbind: DB save failed", { error: dbErr.message }); }
      }
      await sendTelegramMessage([
        `🎯 <b>Take Profit (IBIND)</b>`,
        `Ticker: <b>${input.ticker ?? input.conid}</b>`,
        `Limit Price: <b>$${input.limitPrice.toFixed(2)}</b>  |  Qty: <b>${input.quantity}</b>  |  Side: ${input.side}`,
        `Order ID: <code>${orderId ?? "pending"}</code>`,
      ].join("\n")).catch(() => {});
      // Log journal event
      await logJournalEvent({
        userId: ctx.user.id,
        eventType: "tp_order",
        ticker: input.ticker ?? null,
        units: input.quantity,
        takeProfit: input.limitPrice,
        orderId: orderId ?? null,
        notes: `Take Profit בוצע דרך IBIND | TP: $${input.limitPrice.toFixed(2)} | Qty: ${input.quantity}`,
      }).catch(() => {});
      return { success: true, type: "take-profit" as const, orderId, result: r?.result };
    }),

  /**
   * Place a Bracket order (3-leg OCA) via new IBIND /orders/bracket endpoint.
   * POST /orders/bracket { conid, side, quantity, entryPrice, stopLoss, takeProfit, tif?, outsideRth? }
   * Guardrails enforced server-side:
   *   BUY:  stopLoss < entryPrice < takeProfit
   *   SELL: takeProfit < entryPrice < stopLoss
   */
  placeBracketIbind: adminProcedure
    .input(z.object({
      conid: z.number().int().positive(),
      side: z.enum(["BUY", "SELL"]),
      quantity: z.number().positive(),
      entryPrice: z.number().positive(),
      stopLoss: z.number().positive(),
      takeProfit: z.number().positive(),
      tif: z.enum(["GTC", "DAY"]).default("GTC"),
      outsideRth: z.boolean().default(false),
      ticker: z.string().max(16).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      log.info("ORDER", "placeBracketIbind START", { conid: input.conid, side: input.side, entry: input.entryPrice, sl: input.stopLoss, tp: input.takeProfit, qty: input.quantity, userId: ctx.user.id });
      // Prime /iserver/accounts before placing order (IBKR requires this once per session)
      await primeAccountsIfNeeded();
      // Client-side price ordering validation (server also validates, but fail fast)
      if (input.side === "BUY") {
        if (!(input.stopLoss < input.entryPrice && input.entryPrice < input.takeProfit)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "BUY bracket: stopLoss < entryPrice < takeProfit נדרש" });
        }
      } else {
        if (!(input.takeProfit < input.entryPrice && input.entryPrice < input.stopLoss)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "SELL bracket: takeProfit < entryPrice < stopLoss נדרש" });
        }
      }
      const body = {
        conid: input.conid,
        side: input.side,
        quantity: input.quantity,
        entryPrice: input.entryPrice,
        stopLoss: input.stopLoss,
        takeProfit: input.takeProfit,
        tif: input.tif,
        outsideRth: input.outsideRth,
      };
      const { ok, status, body: resp } = await ibindRequest(
        "POST",
        "/orders/bracket",
        body,
        { "X-Confirm-Live-Order": "yes" }
      );
      const r = resp as Record<string, any>;
      if (!ok) {
        const errCode = r?.error ?? r?.message ?? `HTTP ${status}`;
        log.error("ORDER", "placeBracketIbind FAILED", { status, error: errCode });
        if (status === 403) throw new TRPCError({ code: "FORBIDDEN", message: "Missing X-Confirm-Live-Order header" });
        if (status === 400) throw new TRPCError({ code: "BAD_REQUEST", message: errCode });
        if (status === 401 || status === 503) throw new TRPCError({ code: "UNAUTHORIZED", message: "IBKR session not active" });
        if (status === 502) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: r?.message ?? "IBKR rejected the bracket order" });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: r?.message ?? errCode });
      }
      const result = r?.result ?? {};
      log.info("ORDER", "placeBracketIbind SUCCESS", { ticker: input.ticker, result: JSON.stringify(result).slice(0, 200) });
      await sendTelegramMessage([
        `📦 <b>Bracket Order (IBIND)</b>`,
        `Ticker: <b>${input.ticker ?? input.conid}</b>  |  Side: ${input.side}  |  Qty: <b>${input.quantity}</b>`,
        `Entry: <b>$${input.entryPrice.toFixed(2)}</b>  |  SL: <b>$${input.stopLoss.toFixed(2)}</b>  |  TP: <b>$${input.takeProfit.toFixed(2)}</b>`,
        `IDs: <code>${JSON.stringify(result).slice(0, 200)}</code>`,
      ].join("\n")).catch(() => {});
      // Log journal event for bracket order
      await logJournalEvent({
        userId: ctx.user.id,
        eventType: "bracket_order",
        ticker: input.ticker ?? null,
        units: input.quantity,
        price: input.entryPrice,
        stopLoss: input.stopLoss,
        takeProfit: input.takeProfit,
        notes: `Bracket Order בוצע דרך IBIND | Entry: $${input.entryPrice.toFixed(2)} | SL: $${input.stopLoss.toFixed(2)} | TP: $${input.takeProfit.toFixed(2)} | Qty: ${input.quantity}`,
        metadata: JSON.stringify(result).slice(0, 500),
      }).catch(() => {});
      return { success: true, type: "bracket" as const, result };
    }),

  // ── IBIND Session Management ─────────────────────────────────────────────────

  /**
   * GET /session/status — enriched session status.
   * Safe to poll: does NOT reset the 30-min idle timer.
   */
  getSessionStatus: adminProcedure.query(async () => {
    try {
      const res = await ibindRequest("GET", "/session/status");
      const body = res.body as Record<string, any>;
      return {
        ok: res.ok,
        sessionActive: body?.session_active === true || body?.session_active === "true",
        hasClient: body?.has_client ?? null,
        accountId: body?.account_id ?? null,
        lastActivityAt: body?.last_activity_at ?? null,
        closedAt: body?.closed_at ?? null,
        closedReason: (body?.closed_reason ?? null) as "manual" | "inactivity" | "daily" | null,
        inactivityTimeoutSec: body?.inactivity_timeout_sec ?? 1800,
        dailyCloseHourGmt3: body?.daily_close_hour_gmt3 ?? 0,
        error: res.ok ? null : (body?.error ?? `HTTP ${res.status}`),
      };
    } catch (err: any) {
      return {
        ok: false, sessionActive: false, hasClient: null, accountId: null,
        lastActivityAt: null, closedAt: null, closedReason: null,
        inactivityTimeoutSec: 1800, dailyCloseHourGmt3: 0,
        error: err.message,
      };
    }
  }),

  /**
   * POST /session/start — open IBKR OAuth session (idempotent).
   * If already active returns { alreadyActive: true }.
   * If closed, establishes a new session (takes 3-8s for OAuth handshake).
   */
  startSession: adminProcedure.mutation(async () => {
    try {
      const res = await ibindRequest("POST", "/session/start");
      const body = res.body as Record<string, any>;
      if (!res.ok) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: body?.message ?? body?.error ?? `IBIND returned HTTP ${res.status}`,
        });
      }
      return {
        success: body?.success === true,
        alreadyActive: body?.already_active === true,
        sessionActive: body?.session_active === true || body?.session_active === "true",
        accountId: body?.account_id ?? null,
      };
    } catch (err: any) {
      if (err instanceof TRPCError) throw err;
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err.message });
    }
  }),

  /**
   * POST /session/stop — manually close the IBKR session (idempotent).
   * Returns { wasActive: bool }.
   */
  // Cancel an IBKR order (SL or TP) and clear the orderId from DB
  cancelOrder: adminProcedure
    .input(z.object({
      orderId: z.string(),
      holdingId: z.number().int(),
      field: z.enum(["sl", "tp"]),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      // Get accountId from settings
      const settings = await getIbkrSettings(userId);
      const accountId = settings?.accountId;

      // Try to cancel on IBKR side
      if (accountId && input.orderId) {
        try {
          const { ok, status, body } = await ibindRequest(
            "DELETE",
            `/api/proxy/iserver/account/${accountId}/order/${input.orderId}`
          );
          log.info("ORDER", `cancelOrder ${input.field.toUpperCase()} via IBIND`, { orderId: input.orderId, status, ok });
          if (!ok && status !== 404) {
            // 404 = already gone, that's fine. Other errors we warn but still clear DB.
            log.warn("ORDER", `cancelOrder IBKR returned non-OK`, { status, body: JSON.stringify(body).slice(0, 200) });
          }
        } catch (e: any) {
          log.warn("ORDER", `cancelOrder IBKR call failed (clearing DB anyway)`, { orderId: input.orderId, error: e.message });
        }
      }

      // Clear orderId from DB regardless of IBKR response
      const clearSet = input.field === "sl"
        ? { ibkrSlOrderId: null as any, ibkrSlOrderQty: null as any }
        : { ibkrTpOrderId: null as any, ibkrTpOrderQty: null as any };
      await db.update(portfolioHoldings)
        .set(clearSet)
        .where(and(eq(portfolioHoldings.id, input.holdingId), eq(portfolioHoldings.userId, userId)));

      log.info("ORDER", `cancelOrder cleared ${input.field.toUpperCase()} from DB`, { holdingId: input.holdingId, orderId: input.orderId });
      return { success: true };
    }),

  /**
   * Debug: returns raw IBIND /orders response so we can inspect field names.
   * Auto-primes /iserver/accounts if needed.
   */
  debugRawOrders: adminProcedure.query(async () => {
    try {
      let { ok, status, body } = await ibindRequest("GET", "/orders");
      // Detect "Please query /accounts first" anywhere in the error body
      const errStr = JSON.stringify(body ?? "");
      if (!ok && errStr.includes("Please query /accounts first")) {
        log.info("ORDER", "debugRawOrders: session context lost — re-priming via primeAccountsIfNeeded");
        await primeAccountsIfNeeded();
        await new Promise(r => setTimeout(r, 800));
        const retry = await ibindRequest("GET", "/orders");
        ok = retry.ok; status = retry.status; body = retry.body;
      }
      log.info("ORDER", "debugRawOrders raw response", { ok, status, body: JSON.stringify(body).slice(0, 2000) });
      return { ok, status, body };
    } catch (err: any) {
      return { ok: false, status: 500, body: null, error: err.message };
    }
  }),

  /**
   * Fetch live prices for all holdings from IBKR via IBIND /positions.
   * Returns { ticker, price }[] — lightweight, designed for frequent polling.
   */
  getLivePrices: adminProcedure.query(async () => {
    try {
      const res = await ibindRequest("GET", "/positions");
      if (!res.ok) return { prices: [], error: `IBIND HTTP ${res.status}` };
      const body = res.body as any;
      const raw: any[] = Array.isArray(body) ? body
        : Array.isArray(body?.positions) ? body.positions
        : [];
      const prices = raw
        .filter((p: any) => (p.position ?? p.quantity ?? p.pos ?? p.size ?? 0) !== 0)
        .map((p: any) => ({
          ticker: (
            p.ticker ?? p.symbol ?? p.localSymbol ?? p.local_symbol ??
            p.contractDesc ?? p.contract_desc ?? p.contract?.symbol ??
            p.name ?? p.description ?? ""
          ).toUpperCase().replace(/\s+.*$/, ""),
          price: p.mktPrice ?? p.market_price ?? p.last_price ?? p.price ?? 0,
          mktValue: p.mktValue ?? p.market_value ?? p.value ?? 0,
          unrealizedPnl: p.unrealizedPnl ?? p.unrealized_pnl ?? p.pnl ?? 0,
        }))
        .filter((p: any) => p.ticker && p.price > 0);
      return { prices, error: null };
    } catch (err: any) {
      return { prices: [], error: err.message };
    }
  }),

  stopSession: adminProcedure.mutation(async () => {
    try {
      const res = await ibindRequest("POST", "/session/stop");
      const body = res.body as Record<string, any>;
      return {
        success: body?.success === true,
        wasActive: body?.was_active === true,
        sessionActive: body?.session_active === false,
      };
    } catch (err: any) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err.message });
    }
  }),

  // ── Get live market snapshot from IBKR for arbitrary symbols ─────────────────
  // Replaces Yahoo Finance getLivePrices when IBKR is connected.
  // Flow: (1) resolve symbol→conid via /trsrv/stocks (cached in DB forever),
  //       (2) pre-flight call to /iserver/marketdata/snapshot (first call returns empty),
  //       (3) wait 800ms, (4) actual snapshot call → returns price/change/changePercent/prevClose.
  // Fields: 31=lastPrice, 82=changePrice, 83=changePercent, 7741=priorClose
  getMarketSnapshot: protectedProcedure
    .input(z.object({ symbols: z.array(z.string().min(1)).min(1).max(100) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'DB unavailable' });
      const symbols = input.symbols.map(s => s.toUpperCase());

      // ── Step 1: Resolve symbols → conids (use cache, fetch missing) ──────────
      const cachedRows = await db.select().from(ibkrConidCache);
      const cacheMap: Record<string, number> = {};
      for (const row of cachedRows) {
        cacheMap[row.symbol.toUpperCase()] = row.conid;
      }

      const missing = symbols.filter(s => !cacheMap[s]);
      if (missing.length > 0) {
        // Resolve missing symbols in batches of 50 via /trsrv/stocks
        const batchSize = 50;
        for (let i = 0; i < missing.length; i += batchSize) {
          const batch = missing.slice(i, i + batchSize);
          try {
            const res = await ibindRequest("GET", `/trsrv/stocks?symbols=${batch.join(',')}`);
            if (res.ok && res.body) {
              const data = res.body as Record<string, any[]>;
              for (const sym of batch) {
                const entries: any[] = data[sym] ?? data[sym.replace('.TA', '')] ?? [];
                // Pick first STK contract, prefer primary exchange
                const contract = entries.find((e: any) => e.assetClass === 'STK') ?? entries[0];
                if (contract?.conid) {
                  const conid = Number(contract.conid);
                  cacheMap[sym] = conid;
                  await db.insert(ibkrConidCache).values({
                    symbol: sym,
                    conid,
                    exchange: contract.primaryExch ?? contract.listingExchange ?? null,
                    currency: contract.currency ?? null,
                    assetClass: contract.assetClass ?? 'STK',
                    resolvedAt: Date.now(),
                  }).onDuplicateKeyUpdate({ set: { conid, resolvedAt: Date.now() } });
                  log.info('IBKR', `Resolved ${sym} → conid ${conid}`);
                } else {
                  log.warn('IBKR', `Could not resolve conid for ${sym}`);
                }
              }
            }
          } catch (err: any) {
            log.warn('IBKR', `conid resolution error for batch ${batch.join(',')}`, { err: err.message });
          }
        }
      }

      // ── Step 2: Build conid list for symbols we resolved ────────────────────
      const conids = symbols.map(s => cacheMap[s]).filter(Boolean) as number[];
      if (conids.length === 0) {
        return { quotes: [], error: 'No conids resolved' };
      }

      const parseNum = (v: unknown): number | null => {
        if (v == null) return null;
        const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
        return isNaN(n) ? null : n;
      };

      // Fields: 31=last, 82=change, 83=changePct, 84=bid, 86=ask, 7741=priorClose
      // bid+ask are updated in pre/post-market even when last_price hasn't traded yet
      const fields = '31,82,83,84,86,7741';
      const conidStr = conids.join(',');

      // ── Step 3: Pre-flight call (first call per session opens the stream) ────
      try {
        await ibindRequest('GET', `/iserver/marketdata/snapshot?conids=${conidStr}&fields=${fields}`);
      } catch { /* ignore pre-flight errors */ }

      // ── Step 4: Wait 800ms then fetch actual data ────────────────────────────────────
      await new Promise(r => setTimeout(r, 800));

      let snapData: any[] = [];
      try {
        const snapRes = await ibindRequest('GET', `/iserver/marketdata/snapshot?conids=${conidStr}&fields=${fields}`);
        if (snapRes.ok && Array.isArray(snapRes.body)) {
          snapData = snapRes.body as any[];
        }
      } catch (err: any) {
        log.warn('IBKR', 'marketdata/snapshot error', { err: err.message });
        return { quotes: [], error: err.message };
      }

      // ── Step 5: Map back to symbols ────────────────────────────────────────────────────────────
      const snapByConid: Record<number, any> = {};
      for (const row of snapData) {
        if (row?.conid) snapByConid[Number(row.conid)] = row;
      }

      const quotes = symbols.map(sym => {
        const conid = cacheMap[sym];
        const snap = conid ? snapByConid[conid] : null;
        const lastPrice = parseNum(snap?.['31']);
        const bid = parseNum(snap?.['84']);
        const ask = parseNum(snap?.['86']);
        const prevClose = parseNum(snap?.['7741']);
        // effectivePrice: use last_price if it differs from prior_close (i.e. a trade occurred),
        // otherwise fall back to mid-price (bid+ask)/2 which updates in pre/post-market
        const midPrice = bid != null && ask != null ? (bid + ask) / 2 : null;
        const lastDiffersFromClose = lastPrice != null && prevClose != null
          ? Math.abs(lastPrice - prevClose) > 0.001
          : lastPrice != null;
        const price = lastDiffersFromClose ? lastPrice : (midPrice ?? lastPrice);
        // ── Gateway-aligned change math: derive from price - prevClose (never use stale fields 82/83) ──
        const change = (price != null && prevClose != null) ? +(price - prevClose).toFixed(4) : null;
        const changePercent = (change != null && prevClose != null && prevClose !== 0)
          ? +((change / prevClose) * 100).toFixed(4)
          : null;
        return { symbol: sym, price, change, changePercent, prevClose, bid, ask, conid: conid ?? null };
      });

      log.info('IBKR', 'getMarketSnapshot', { symbols: symbols.length, resolved: conids.length, snaps: snapData.length });
      return { quotes, error: null };
    }),

  // ── Get live quotes via IBIND /quotes endpoint (symbol→conid on the IBIND server) ──
  // This is the preferred method for H2 (non-held tickers) — delegates conid resolution
  // and pre-flight retry to the IBIND server's _resolve_symbol_to_conid + live_marketdata_snapshot.
  // Returns: { quotes: [{symbol, conid, last_price, change, change_percent, prior_close, delayed}], unresolved, error }
  getIbkrQuotes: protectedProcedure
    .input(z.object({
      symbols: z.array(z.string().min(1)).min(1).max(500), // increased limit — batching handles chunking
      exchangeHint: z.string().optional(),
    }))
    .query(async ({ input }) => {
      try {
        // Split symbols by exchange: .TA → TASE (prices in agorot), rest → SMART
        const taSymbols = input.symbols.filter(s => s.toUpperCase().endsWith('.TA'));
        const usSymbols = input.symbols.filter(s => !s.toUpperCase().endsWith('.TA'));

        // Helper: call /quotes for a single batch (max 50 symbols) and return raw quotes array
        // IBIND rate limit: 5 calls/sec → fetchInBatches adds 200ms delay between chunks
        const fetchOneBatch = async (syms: string[], exchange_hint: string): Promise<{ quotes: any[]; unresolved: string[] }> => {
          if (syms.length === 0) return { quotes: [], unresolved: [] };
          // Strip .TA suffix for IBKR lookup (IBKR uses "QLTU" not "QLTU.TA")
          const stripped = syms.map(s => s.replace(/\.TA$/i, '').toUpperCase());
          const res = await ibindRequest('POST', '/quotes', { symbols: stripped, exchange_hint });
          if (!res.ok) return { quotes: [], unresolved: syms };
          const d = res.body as { success: boolean; quotes: any[]; unresolved?: string[] };
          const origByBare = new Map<string, string>();
          for (const sym of syms) {
            origByBare.set(sym.replace(/\.TA$/i, '').toUpperCase(), sym);
          }
          const quotes = (d.quotes ?? []).map((q: any) => {
            const qBare = String(q.symbol ?? q.ticker ?? '').toUpperCase().replace(/\.TA$/i, '');
            const symbol = origByBare.get(qBare) ?? q.symbol ?? q.ticker;
            return { ...q, symbol };
          });
          return { quotes, unresolved: d.unresolved ?? [] };
        };

        // Fan-out with 50-ticker batching (IBIND max conids per request)
        // TA and US batches run sequentially to respect rate limit
        const taAllQuotes: any[] = [];
        const taAllUnresolved: string[] = [];
        const usAllQuotes: any[] = [];
        const usAllUnresolved: string[] = [];

        await fetchInBatches(taSymbols, async (batch) => {
          const r = await fetchOneBatch(batch, 'TASE');
          taAllQuotes.push(...r.quotes);
          taAllUnresolved.push(...r.unresolved);
          return r.quotes;
        }, 50, 200);

        await fetchInBatches(usSymbols, async (batch) => {
          const r = await fetchOneBatch(batch, input.exchangeHint ?? 'SMART');
          usAllQuotes.push(...r.quotes);
          usAllUnresolved.push(...r.unresolved);
          return r.quotes;
        }, 50, 200);

        // Get ILS→USD rate once if needed (TASE prices from Gateway are already in ILS, divide by rate for USD)
        const ilsRate = taSymbols.length > 0 ? await getUsdIlsRate() : 1;

        // ── New IBIND Gateway contract ──
        // Gateway already computed: current_price, prior_close, change, change_percent
        // Node.js is a pure pass-through — ZERO local recalculation.
        const allRaw = [...taAllQuotes, ...usAllQuotes];

        // TEMP DEBUG: log first US quote to see all available fields
        const debugQuote = allRaw.find((q: any) => q.symbol === 'LUNR' || q.symbol === 'AAPL');
        if (debugQuote) log.info('IBKR', `DEBUG_RAW_FIELDS ${JSON.stringify(debugQuote)}`);

        const quotes = allRaw.map((q: any) => {
          if (q.error) return {
            symbol: q.symbol ?? q.ticker, conid: q.conid ?? null, price: null, change: null,
            changePercent: null, prevClose: null, isClosingPrice: false,
            preMarketPrice: null, delayed: false, error: q.error,
            currency: 'USD', exchange: null, marketLabel: 'CLOSED' as const,
          };

          // Detect new contract shape: has 'current_price' field
          const isNewContract = q.current_price !== undefined;

          if (isNewContract) {
            // New Gateway contract
            const isTase = (q.exchange ?? '').toUpperCase() === 'TASE';
            // TASE live quotes from IBKR are in ILS (not agorot); divide by rate to get USD
            const quoteDiv = isTase && ilsRate > 0 ? ilsRate : 1;
            const price = q.current_price / quoteDiv;
            const prevClose = q.prior_close / quoteDiv;
            const change = (price != null && prevClose != null) ? +(price - prevClose).toFixed(4) : (q.change / quoteDiv);
            // Always compute changePercent from price/prevClose — Gateway's change_percent uses
            // a different baseline during premarket/after-hours that doesn't match IBKR app's CHG%.
            // prior_close = yesterday's RTH close = the baseline IBKR app uses for CHG%.
            const changePct = (price != null && prevClose != null && prevClose !== 0)
              ? +((price - prevClose) / prevClose * 100).toFixed(4)
              : null;
            const isOpen = q.is_market_open === true;
            // extended_hours_used: true means IBIND returned a pre/after-market price
            // In this case, current_price != prior_close and data is live (not stale closing)
            const extendedHoursUsed = q.extended_hours_used === true;
            // isClosingPrice should be false when we have live extended-hours data
            const isClosingPrice = !isOpen && !extendedHoursUsed;
            return {
              symbol: q.symbol ?? q.ticker,
              conid: q.conid ?? null,
              price,
              change,
              changePercent: changePct,
              prevClose,
              isClosingPrice,
              preMarketPrice: (!isOpen && extendedHoursUsed) ? price : null,
              delayed: q.is_delayed === true,
              error: null,
              currency: isTase ? 'ILS' : 'USD',
              exchange: q.exchange ?? 'US',
              marketLabel: isOpen ? 'OPEN' as const : (extendedHoursUsed ? 'PRE_MARKET' as const : 'CLOSED' as const),
            };
          }

          // Legacy contract fallback (pre-Gateway upgrade) — use PriceService normalizer
          const legacyRaw: IbindRawQuote = q;
          const n = normalizeIbindBatch([legacyRaw], ilsRate)[q.symbol];
          if (!n) return {
            symbol: q.symbol, conid: q.conid ?? null, price: null, change: null,
            changePercent: null, prevClose: null, isClosingPrice: false,
            preMarketPrice: null, delayed: false, error: 'normalize_failed',
            currency: 'USD', exchange: null, marketLabel: 'CLOSED' as const,
          };
          return {
            symbol: n.symbol, conid: n.conid, price: n.price, change: n.change,
            changePercent: n.changePct, prevClose: n.prevClose,
            isClosingPrice: n.marketLabel === 'CLOSED',
            preMarketPrice: (n.marketLabel === 'PRE_MARKET' || n.marketLabel === 'AFTER_HOURS') ? n.price : null,
            delayed: !n.isLive, error: n.error,
            currency: n.currency, exchange: n.exchange, marketLabel: n.marketLabel,
          };
        });
        const unresolved = [...taAllUnresolved, ...usAllUnresolved];

        log.info('IBKR', 'getIbkrQuotes', {
          total: input.symbols.length,
          ta: taSymbols.length,
          us: usSymbols.length,
          resolved: quotes.filter(q => !q.error).length,
          ilsRate,
          batches: Math.ceil(taSymbols.length / 50) + Math.ceil(usSymbols.length / 50),
        });
        return { quotes, unresolved, error: null };
      } catch (err: any) {
        log.warn('IBKR', 'getIbkrQuotes failed', { err: err.message });
        return { quotes: [], unresolved: input.symbols, error: err.message };
      }
    }),

  /**
   * Resolve a single ticker symbol to its IBKR conid.
   * First checks the DB cache (ibkrConidCache), then calls IBIND /trsrv/stocks.
   * This allows placing orders for stocks not currently held in IBKR positions.
   */
  resolveConid: protectedProcedure
    .input(z.object({ symbol: z.string().min(1).max(20) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database not available' });
      const sym = input.symbol.toUpperCase();

      // 0. Check for known hardcoded conid (alias map)
      const knownConid = getKnownConid(sym);
      if (knownConid) {
        log.info('IBKR', `resolveConid: alias map hit for ${sym} -> conid ${knownConid}`);
        await db.insert(ibkrConidCache).values({
          symbol: sym, conid: knownConid, exchange: 'ALIAS', currency: 'USD',
          assetClass: 'STK', resolvedAt: Date.now(),
        }).onDuplicateKeyUpdate({ set: { conid: knownConid, resolvedAt: Date.now() } });
        return { conid: knownConid, source: 'alias' as const, aliasReason: getAliasReason(sym) };
      }

      // 1. Check DB cache first
      const cached = await db.select().from(ibkrConidCache).where(eq(ibkrConidCache.symbol, sym)).limit(1);
      if (cached.length > 0 && cached[0].conid) {
        log.info('IBKR', `resolveConid: cache hit for ${sym} -> ${cached[0].conid}`);
        return { conid: cached[0].conid, source: 'cache' as const };
      }

      // 2. Try IBIND /trsrv/stocks — first with original symbol, then with alias
      const ibkrSym = resolveIbkrSymbol(sym);
      const symbolsToTry = ibkrSym && ibkrSym !== sym ? [sym, ibkrSym] : [sym];

      for (const trySymbol of symbolsToTry) {
        try {
          const res = await ibindRequest('GET', `/trsrv/stocks?symbols=${encodeURIComponent(trySymbol)}`);
          if (!res.ok) {
            log.warn('IBKR', `resolveConid: /trsrv/stocks returned ${res.status} for ${trySymbol}`);
            continue;
          }
          const data = res.body as Record<string, any[]>;
          const entries: any[] = data[trySymbol] ?? data[trySymbol.replace('.TA', '')] ?? [];
          const contract = entries.find((e: any) => e.assetClass === 'STK') ?? entries[0];
          if (!contract?.conid) {
            log.warn('IBKR', `resolveConid: no STK contract found for ${trySymbol}`);
            continue;
          }
          const conid = Number(contract.conid);
          await db.insert(ibkrConidCache).values({
            symbol: sym, conid,
            exchange: contract.primaryExch ?? contract.listingExchange ?? null,
            currency: contract.currency ?? null,
            assetClass: contract.assetClass ?? 'STK',
            resolvedAt: Date.now(),
          }).onDuplicateKeyUpdate({ set: { conid, resolvedAt: Date.now() } });
          log.info('IBKR', `resolveConid: resolved ${sym} -> conid ${conid} via ${trySymbol} (exchange: ${contract.primaryExch ?? 'unknown'})`);
          return { conid, source: 'ibkr' as const };
        } catch (err: any) {
          log.warn('IBKR', `resolveConid: error for ${trySymbol}`, { err: err.message });
        }
      }

      // 3. Graceful fallback — return unavailable instead of throwing
      const aliasReason = getAliasReason(sym);
      log.warn('IBKR', `resolveConid: ${sym} not available on IBKR — returning unavailable`, { aliasReason });
      return {
        conid: null,
        source: 'unavailable' as const,
        unavailable: true,
        reason: aliasReason ?? `${sym} could not be found on IBKR. It may be delisted, recently relisted, or restricted. You can enter the conid manually.`,
      };
    }),

  /**
   * Manually set a conid for a ticker that IBKR cannot auto-resolve.
   * Useful for recently relisted stocks (e.g. SNDK) or restricted instruments.
   */
  setManualConid: protectedProcedure
    .input(z.object({
      symbol: z.string().min(1).max(20),
      conid: z.number().int().positive(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database not available' });
      const sym = input.symbol.toUpperCase();
      await db.insert(ibkrConidCache).values({
        symbol: sym,
        conid: input.conid,
        exchange: 'MANUAL',
        currency: 'USD',
        assetClass: 'STK',
        resolvedAt: Date.now(),
      }).onDuplicateKeyUpdate({ set: { conid: input.conid, exchange: 'MANUAL', resolvedAt: Date.now() } });
      log.info('IBKR', `setManualConid: ${sym} -> conid ${input.conid} (manual override)`);
      return { success: true, symbol: sym, conid: input.conid };
    }),

  /** Returns IBKR session monitor state — reconnect status, fail count, etc. */
  getMonitorStatus: adminProcedure.query(() => {
    return getMonitorState();
  }),

  /**
   * Bulk-fill missing conids for all active catalogue tickers.
   * Queries userAssets for distinct tickers not yet in ibkrConidCache,
   * then resolves them via IBKR /trsrv/stocks in batches of 50.
   * TASE tickers (.TA) are stripped of the suffix before lookup.
   * Returns a summary: resolved, skipped (already cached), failed.
   */
  bulkFillConids: adminProcedure.mutation(async () => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'DB unavailable' });

    // 1. Get all distinct active catalogue tickers
    const rows = await db
      .selectDistinct({ ticker: userAssets.ticker })
      .from(userAssets)
      .where(eq(userAssets.archived, 0));
    const allTickers = rows.map(r => r.ticker.toUpperCase());

    // 2. Get already-cached symbols
    const cachedRows = await db.select({ symbol: ibkrConidCache.symbol }).from(ibkrConidCache);
    const cachedSet = new Set(cachedRows.map(r => r.symbol.toUpperCase()));

    // 3. Find missing tickers
    const missing = allTickers.filter(t => !cachedSet.has(t));
    const skipped = allTickers.length - missing.length;

    log.info('IBKR', `bulkFillConids: ${allTickers.length} tickers total, ${skipped} already cached, ${missing.length} to resolve`);

    let resolved = 0;
    let failed = 0;
    const failedList: string[] = [];

    const BATCH = 20; // POST /quotes handles batches well
    const sleepMs = (ms: number) => new Promise(r => setTimeout(r, ms));

    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      // Strip .TA suffix for IBKR lookup (/quotes doesn't recognize .TA)
      const ibkrBatch = batch.map(s => s.replace(/\.TA$/i, ''));
      const isTase = batch.map(s => s.endsWith('.TA'));

      try {
        const res = await ibindRequest('POST', '/quotes', { symbols: ibkrBatch });
        if (!res.ok) {
          log.warn('IBKR', `bulkFillConids: POST /quotes HTTP ${res.status} for batch starting at ${ibkrBatch[0]}`);
          failed += batch.length;
          failedList.push(...batch);
          continue;
        }

        const data = res.body as { quotes?: any[]; unresolved?: string[] };
        const quotes = data.quotes ?? [];
        const unresolvedSet = new Set((data.unresolved ?? []).map((s: string) => s.toUpperCase()));

        for (let j = 0; j < batch.length; j++) {
          const origSym = batch[j];     // e.g. "QLTU.TA"
          const ibkrSym = ibkrBatch[j]; // e.g. "QLTU"

          if (unresolvedSet.has(ibkrSym.toUpperCase())) {
            log.warn('IBKR', `bulkFillConids: unresolved ${origSym}`);
            failed++;
            failedList.push(origSym);
            continue;
          }

          // Find matching quote — for TASE tickers, prefer exchange=TASE
          const matchingQuotes = quotes.filter((q: any) => q.ticker?.toUpperCase() === ibkrSym.toUpperCase());
          let contract: any = null;

          if (isTase[j]) {
            contract = matchingQuotes.find((q: any) => q.exchange_raw === 'TASE' || q.exchange === 'IL');
            if (!contract) contract = matchingQuotes[0]; // fallback
          } else {
            contract = matchingQuotes[0];
          }

          if (contract?.conid) {
            const conid = Number(contract.conid);
            await db.insert(ibkrConidCache).values({
              symbol: origSym,
              conid,
              exchange: contract.exchange_raw ?? contract.exchange ?? null,
              currency: contract.currency ?? 'USD',
              assetClass: 'STK',
              resolvedAt: Date.now(),
            }).onDuplicateKeyUpdate({ set: { conid, resolvedAt: Date.now() } });
            log.info('IBKR', `bulkFillConids: ${origSym} \u2192 conid ${conid} (${contract.exchange_raw})`);
            resolved++;
          } else {
            log.warn('IBKR', `bulkFillConids: no conid found for ${origSym}`);
            failed++;
            failedList.push(origSym);
          }
        }
      } catch (err: any) {
        log.warn('IBKR', `bulkFillConids: batch error: ${err.message}`);
        failed += batch.length;
        failedList.push(...batch);
      }

      // Delay between batches to avoid rate-limiting
      if (i + BATCH < missing.length) await sleepMs(500);
    }

    log.info('IBKR', `bulkFillConids complete: resolved=${resolved}, skipped=${skipped}, failed=${failed}`);
    return { total: allTickers.length, skipped, resolved, failed, failedList };
  }),

  // ── IBIND Manual Disconnect/Reconnect ─────────────────────────────────────

  /** Get current IBIND manual disconnect status */
  getIbindDisconnectStatus: adminProcedure.query(async () => {
    const val = await getSystemSetting("isIbindManuallyDisconnected");
    return { disconnected: val === "true" };
  }),

  /** Manually disconnect IBIND — stops heartbeat and blocks all IBIND calls */
  ibindManualDisconnect: adminProcedure.mutation(async () => {
    await setSystemSetting("isIbindManuallyDisconnected", "true");
    await setSystemSetting("isEnginePausedByAdmin", "true");
    setIbindDisconnectedFlag(true);
    stopIbkrHeartbeat();
    log.info("IBKR", "[IBIND] Manual disconnect activated — heartbeat stopped, all calls blocked");
    // Telegram disabled (too noisy)
    // await sendTelegramMessage(
    //   `⏹ <b>[IBIND] Manual Disconnect</b>\nIBIND disconnected manually. All IBKR calls blocked until reconnect.`
    // ).catch(() => {});
    return { ok: true, status: "disconnected" };
  }),

  /** Manually reconnect IBIND — resumes heartbeat and unblocks all IBIND calls */
  // ── Order Status & Management (Real IBKR) ──────────────────────────────────

  /**
   * Get status of a specific order by ID.
   * Polls /orders and finds the matching order.
   */
  getOrderStatus: adminProcedure
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input }) => {
      try {
        await primeAccountsIfNeeded();
        const { ok, body } = await ibindRequest("GET", "/orders");
        if (!ok) return { found: false, status: "unknown", order: null };
        const raw = body as any;
        const orders: any[] = raw?.orders ?? raw?.live_orders ?? (Array.isArray(raw) ? raw : []);
        const match = orders.find((o: any) => {
          const oid = String(o.orderId ?? o.order_id ?? o.coid ?? "");
          return oid === input.orderId;
        });
        if (!match) {
          // Order not in live list = likely filled, cancelled, or expired
          return { found: false, status: "filled_or_cancelled", order: null };
        }
        const statusRaw = (match.status ?? match.orderStatus ?? "").toLowerCase();
        let status = "pending";
        if (statusRaw.includes("fill")) status = "filled";
        else if (statusRaw.includes("cancel")) status = "cancelled";
        else if (statusRaw.includes("reject")) status = "rejected";
        else if (statusRaw.includes("submit") || statusRaw.includes("pre")) status = "pending";
        else if (statusRaw.includes("inactive")) status = "inactive";
        return {
          found: true,
          status,
          order: {
            orderId: String(match.orderId ?? match.order_id ?? match.coid ?? ""),
            ticker: (match.ticker ?? match.symbol ?? match.description ?? "") as string,
            side: (match.side ?? match.orderSide ?? "") as string,
            orderType: (match.orderType ?? match.order_type ?? "") as string,
            quantity: (match.totalSize ?? match.quantity ?? match.remainingQuantity ?? 0) as number,
            filledQty: (match.filledQuantity ?? match.filled_qty ?? 0) as number,
            avgPrice: (match.avgPrice ?? match.filled_price ?? match.avgFillPrice ?? null) as number | null,
            limitPrice: (match.limitPrice ?? match.limit_price ?? match.lmtPrice ?? null) as number | null,
            stopPrice: (match.stopPrice ?? match.stop_price ?? match.auxPrice ?? null) as number | null,
            statusRaw: (match.status ?? match.orderStatus ?? "") as string,
          },
        };
      } catch (err: any) {
        log.error("ORDER", `getOrderStatus failed`, { orderId: input.orderId, error: err.message });
        return { found: false, status: "error", order: null, error: err.message };
      }
    }),

  /**
   * Modify the price of a pending order (change limit or stop price).
   */
  modifyOrderPrice: adminProcedure
    .input(z.object({
      orderId: z.string(),
      newPrice: z.number().positive(),
      orderType: z.enum(["LMT", "STP"]),
      // For cancel+replace we need the original order details
      conid: z.number().optional(),
      side: z.string().optional(),
      quantity: z.number().optional(),
      tif: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      try {
        await primeAccountsIfNeeded();
        // IBKR does NOT support modifying bracket/OCA orders via API.
        // Correct approach: cancel the old order → place a new standalone order.
        log.info("ORDER", `modifyOrderPrice: cancel+replace orderId=${input.orderId} newPrice=${input.newPrice}`);

        // Step 1: Cancel old order
        const cancelRes = await ibindRequest(
          "DELETE",
          `/iserver/account/${LIVE_ACCOUNT_ID}/order/${input.orderId}`
        );
        if (!cancelRes.ok) {
          const errMsg = (cancelRes.body as any)?.error ?? `HTTP ${cancelRes.status}`;
          log.warn("ORDER", `modifyOrderPrice: cancel failed (continuing) — ${errMsg}`);
          // Don't throw — order may already be filled/cancelled
        }

        // Brief pause to let IBKR process the cancel
        await new Promise(r => setTimeout(r, 800));

        // Step 2: Place new order
        if (!input.conid || !input.side || !input.quantity) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "conid/side/quantity required for cancel+replace" });
        }

        const placeEndpoint = input.orderType === "STP" ? "/orders/stop-loss" : "/orders/take-profit";
        const placeBody: Record<string, any> = {
          conid: input.conid,
          side: input.side,
          quantity: input.quantity,
          tif: input.tif ?? "GTC",
          outsideRth: false,
        };
        if (input.orderType === "STP") {
          placeBody.stopPrice = input.newPrice;
        } else {
          placeBody.limitPrice = input.newPrice;
        }

        const placeRes = await ibindRequest("POST", placeEndpoint, placeBody, {
          "X-Confirm-Live-Order": "yes",
        });

        if (!placeRes.ok) {
          const errMsg = (placeRes.body as any)?.error ?? `HTTP ${placeRes.status}`;
          log.error("ORDER", `modifyOrderPrice: place failed`, { error: errMsg });
          throw new TRPCError({ code: "BAD_REQUEST", message: `הנחת order חדש נכשלה: ${errMsg}` });
        }

        const newOrderId =
          (placeRes.body as any)?.result?.order_id ??
          (placeRes.body as any)?.order_id ??
          null;

        log.info("ORDER", `modifyOrderPrice SUCCESS`, {
          oldOrderId: input.orderId, newOrderId, newPrice: input.newPrice,
        });
        return { success: true, oldOrderId: input.orderId, newOrderId, newPrice: input.newPrice };
      } catch (err: any) {
        if (err instanceof TRPCError) throw err;
        log.error("ORDER", `modifyOrderPrice EXCEPTION`, { orderId: input.orderId, error: err.message });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err.message });
      }
    }),

  /**
   * Cancel any order by ID (generic — not tied to SL/TP DB fields).
   */
  cancelGenericOrder: adminProcedure
    .input(z.object({ orderId: z.string() }))
    .mutation(async ({ input }) => {
      try {
        await primeAccountsIfNeeded();
        // Try DELETE /orders/{orderId}
        const { ok, status, body } = await ibindRequest(
          "DELETE",
          `/orders/${input.orderId}`
        );
        if (!ok && status !== 404) {
          const errMsg = (body as any)?.error ?? (body as any)?.message ?? `HTTP ${status}`;
          log.warn("ORDER", `cancelGenericOrder non-OK`, { orderId: input.orderId, status, error: errMsg });
          // Try legacy pattern
          const retry = await ibindRequest("DELETE", `/orders/cancel/${input.orderId}`);
          if (!retry.ok && retry.status !== 404) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `ביטול נכשל: ${errMsg}` });
          }
        }
        log.info("ORDER", `cancelGenericOrder SUCCESS`, { orderId: input.orderId });
        return { success: true, orderId: input.orderId };
      } catch (err: any) {
        if (err instanceof TRPCError) throw err;
        log.error("ORDER", `cancelGenericOrder EXCEPTION`, { orderId: input.orderId, error: err.message });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err.message });
      }
    }),

  ibindManualReconnect: adminProcedure.mutation(async () => {
    await setSystemSetting("isIbindManuallyDisconnected", "false");
    await setSystemSetting("isEnginePausedByAdmin", "false");
    setIbindDisconnectedFlag(false);
    startIbkrHeartbeat();
    log.info("IBKR", "[IBIND] Manual reconnect — heartbeat resumed, calls unblocked");
    // Telegram disabled (too noisy)
    // await sendTelegramMessage(
    //   `▶️ <b>[IBIND] Manual Reconnect</b>\nIBIND reconnected. All IBKR calls resumed.`
    // ).catch(() => {});
    // ── RECONNECT GAP FIX ──────────────────────────────────────────────────
    // Clearing the flag + heartbeat (GET /health) is NOT enough: the OAuth
    // session can stay DOWN (the session monitor sits behind its 5-min cooldown),
    // so order POSTs + NLV/positions reads keep failing (405/empty → CB
    // fail-closed + Mass-Disappearance) for up to a minute after "reconnect".
    // Proactively re-establish the session here (idempotent; already_active no-op).
    let sessionActive = false;
    try {
      const { ok, body } = await ibindRequest("POST", "/session/start");
      const data = body as Record<string, any>;
      sessionActive = ok && (data?.session_active === true || data?.session_active === "true" || data?.already_active === true);
      log.info("IBKR", "[IBIND] Manual reconnect — session/start", { ok, sessionActive });
    } catch (err: any) {
      log.warn("IBKR", "[IBIND] Manual reconnect — session/start failed (monitor will retry)", { error: err?.message });
    }
    return { ok: true, status: "connected", sessionActive };
  }),
};
