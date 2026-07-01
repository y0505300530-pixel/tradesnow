/**
 * ibkrSync.ts — IBKR Position Synchronization v2.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Iron Rule: SL and TP are IBKR-native orders (STP + LMT).
 * This module:
 *   1. Detects positions closed by IBKR SL/TP fills → marks DB as "closed"
 *   2. Detects manual closes in TWS → cancels orphan SL/TP via cancelBracketOrders()
 *   3. Updates unrealized PnL from live IBKR prices
 *   4. Runs every 60s during US or TASE RTH via alertPoller (or manually)
 */

import { ibindRequest } from "./routers/ibkrProxy";
import { getDb } from "./db";
import { liveTrades, livePositions } from "../drizzle/schema";
import { eq, and, inArray } from "drizzle-orm";
import { log } from "./logger";
import { sendTelegramMessage } from "./telegram";
import { fmtPrice, toPriceNumber } from "./utils/formatPrice";
import { cancelBracketOrders, backfillOpenPositionRiskMetrics } from "./liveOrderExecutor";
import { positionRealizedPnl, positionUnrealizedPnl } from "./services/PnlService";
import { markHtb } from "./htbBlocklist";
import {
  fetchOpenLivePositionsForSync,
  safeUpdateLivePosition,
} from "./livePositionsSyncCore";
import { isOpsNoiseClose } from "./tradeLedger";

import { LIVE_ACCOUNT_ID } from "./liveOrderExecutor";
let _ibkrSyncRunning = false;

// ── Prime IBKR iserver/accounts (required before order queries) ──────────────
async function primeIserverAccounts(): Promise<boolean> {
  try {
    const res = await ibindRequest("GET", "/iserver/accounts");
    return res.ok;
  } catch {
    return false;
  }
}

// ── Fetch live IBKR positions ────────────────────────────────────────────────
async function fetchIbkrPositions(): Promise<any[]> {
  try {
    const res = await ibindRequest("GET", `/positions`);
    if (!res.ok) return [];
    const body = res.body as any;
    return body?.positions ?? (Array.isArray(body) ? body : []);
  } catch {
    return [];
  }
}

// ── Fetch live IBKR orders (all active orders) ───────────────────────────────
async function fetchIbkrOrders(): Promise<any[]> {
  try {
    // Prime first (IBKR requires /iserver/accounts before /iserver/account/orders)
    await primeIserverAccounts();
    const res = await ibindRequest("GET", "/orders");
    if (!res.ok) return [];
    const body = res.body as any;
    return body?.orders ?? [];
  } catch {
    return [];
  }
}

// ── Main sync function ────────────────────────────────────────────────────────
export async function runIbkrSync(userId: number = 1): Promise<{
  synced: number;
  closedByFill: number;
  cancelledOrphans: number;
  priceUpdates: number;
  errors: string[];
}> {
  if (_ibkrSyncRunning) {
    log.info("IBKR_SYNC", "Sync already in progress — skipping tick");
    return { synced: 0, closedByFill: 0, cancelledOrphans: 0, priceUpdates: 0, errors: [] };
  }
  _ibkrSyncRunning = true;

  const result = { synced: 0, closedByFill: 0, cancelledOrphans: 0, priceUpdates: 0, errors: [] as string[], aborted: false, reason: '' };

  try {
  const db = await getDb();
  if (!db) { result.errors.push("DB unavailable"); return result; }

  // Fetch open positions — explicit column list (avoids slProtection schema drift)
  let dbPositions;
  try {
    dbPositions = await fetchOpenLivePositionsForSync(db, userId);
  } catch (err: any) {
    result.errors.push(`DB read failed: ${err.message}`);
    log.error("IBKR_SYNC", `Failed to load open positions: ${err.message}`);
    return result;
  }

  // Fetch live data from IBKR FIRST. The old `dbPositions.length===0` early-return ran BEFORE
  // this fetch and BEFORE the adoption block (~line 350), so a fully engine-blind book (DB
  // rows=0 — exactly the case adoption exists to fix) short-circuited and was NEVER adopted.
  // This was why MU/GOOG/TSM/NET stayed engine-blind (X dead, "Sync SL/TP" blind). (2026-06-25)
  const [ibkrPositions, ibkrOrders] = await Promise.all([
    fetchIbkrPositions(),
    fetchIbkrOrders(),
  ]);

  if (dbPositions.length === 0 && ibkrPositions.length === 0) {
    log.info("IBKR_SYNC", "No open positions to sync (DB and IBKR both empty)");
    return result;
  }

  log.info("IBKR_SYNC", `Syncing ${dbPositions.length} DB positions vs ${ibkrPositions.length} IBKR positions, ${ibkrOrders.length} orders`,
    { dbCount: dbPositions.length, ibkrPosCount: ibkrPositions.length, ibkrOrdCount: ibkrOrders.length }
  );

  // Build a map: ticker → IBKR position data
  const ibkrPosMap = new Map<string, any>();
  for (const p of ibkrPositions) {
    const sym = (p.ticker ?? p.contractDesc ?? p.symbol ?? "").toUpperCase().trim();
    if (sym) ibkrPosMap.set(sym, p);
  }

  // ── HEAL: zombie/pending_exit rows still open at IBKR ─────────────────────
  let healedCount = 0;
  try {
    const { isNull } = await import("drizzle-orm");
    const staleRows = await db.select({
      id: livePositions.id,
      ticker: livePositions.ticker,
      status: livePositions.status,
    }).from(livePositions).where(and(
      eq(livePositions.userId, userId),
      inArray(livePositions.status, ["zombie", "pending_exit"] as any),
      isNull(livePositions.closedAt),
    ));
    for (const row of staleRows) {
      const sym = row.ticker.toUpperCase();
      const ibkrPos = ibkrPosMap.get(sym);
      const ibkrQty = Math.abs(ibkrPos?.position ?? 0);
      if (ibkrPos && ibkrQty > 0) {
        await safeUpdateLivePosition(db, row.id, { status: "open", exitReason: null });
        healedCount++;
        log.warn("IBKR_SYNC", `[Heal] ${sym} ${row.status} → open (still ${ibkrQty}u at IBKR)`, { ticker: sym, posId: row.id });
      }
    }
    if (healedCount > 0) {
      dbPositions = await fetchOpenLivePositionsForSync(db, userId);
      log.info("IBKR_SYNC", `[Heal] Restored ${healedCount} zombie/pending_exit row(s) — re-fetched ${dbPositions.length} DB positions`);
    }
  } catch (healErr: any) {
    result.errors.push(`Heal pass failed: ${healErr.message}`);
    log.error("IBKR_SYNC", `Zombie heal pass failed: ${healErr.message}`);
  }

  // Build active order IDs set (to detect orphans)
  const activeOrderIds = new Set<string>(
    ibkrOrders
      .filter((o: any) => ["PreSubmitted","Submitted","Filled","PartiallyFilled"].includes(o.status))
      .map((o: any) => String(o.orderId))
  );

  // ── MASS DISAPPEARANCE GUARD ─────────────────────────────────────────────
  // Guard fires ONLY if IBKR returned an unexpectedly small total number of records
  // (gateway disconnect / session glitch). We do NOT guard against position=0 closures —
  // those are legitimate fills. We check if IBKR returned less than half of expected tickers
  // (including zero-position records which still appear in the positions list after close).
  const ibkrTickersWithAnyRecord = new Set(ibkrPositions.map((p: any) =>
    (p.ticker ?? p.contractDesc ?? p.symbol ?? "").toUpperCase().trim()
  ));
  const ibkrFoundCount = dbPositions.filter(p =>
    ibkrTickersWithAnyRecord.has(p.ticker.toUpperCase())
  ).length;
  // Also count positions that IBKR shows as non-zero (actively open)
  const ibkrActiveCount = dbPositions.filter(p =>
    ibkrPosMap.has(p.ticker.toUpperCase()) &&
    Math.abs(ibkrPosMap.get(p.ticker.toUpperCase())?.position ?? 0) > 0
  ).length;
  const missingCount = dbPositions.length - ibkrFoundCount;
  const missingPct   = dbPositions.length > 0 ? missingCount / dbPositions.length : 0;

  // Fire guard only if tickers are COMPLETELY absent from IBKR response (not just zero-position)
  // AND IBKR total positions list is suspiciously small
  if (dbPositions.length >= 3 && missingPct > 0.7 && ibkrPositions.length < 3) {
    const msg = `⚠️ <b>ibkrSync ABORTED — Mass Disappearance Guard</b>\n` +
      `DB has ${dbPositions.length} open positions, IBKR returned only ${ibkrFoundCount} matching tickers (${(missingPct*100).toFixed(0)}% missing).\n` +
      `IBKR total positions list: ${ibkrPositions.length} records. Possible gateway disconnect.\n` +
      `Sync aborted to prevent false-closes. Check IBKR session/gateway.`;
    log.warn("IBKR_SYNC", `Mass disappearance guard triggered: ${missingCount}/${dbPositions.length} missing tickers, IBKR returned ${ibkrPositions.length} total`, { missingPct });
    await sendTelegramMessage(msg).catch(() => {});
    return { ...result, aborted: true, reason: "mass_disappearance_guard" };
  }
  // Log if all positions are being closed (normal after full liquidation)
  if (ibkrActiveCount === 0 && dbPositions.length > 0) {
    log.info("IBKR_SYNC", `All ${dbPositions.length} DB positions appear closed in IBKR (position=0) — processing closures`, { ibkrFoundCount });
  }

  // ── Waiter R3/R4 reconcile hook (INERT at waiterEnabled=0) ─────────────────
  try {
    const brokerQtyByTicker = new Map<string, number>();
    for (const [sym, p] of ibkrPosMap) {
      brokerQtyByTicker.set(sym, Number(p.position ?? 0));
    }
    const { reconcileWaiterPositions } = await import("./waiterEngine");
    await reconcileWaiterPositions(userId, brokerQtyByTicker);
  } catch (e: any) {
    log.warn("IBKR_SYNC", `Waiter reconcile hook failed: ${e.message}`);
  }

  for (const pos of dbPositions) {
    try {
      const ticker = pos.ticker.toUpperCase();
      const ibkrPos = ibkrPosMap.get(ticker);
      const ibkrQtyAbs = Math.abs(ibkrPos?.position ?? 0);

      // ── CASE 0a: pending_entry filled at broker → promote to open ───────────
      if (pos.status === "pending_entry" && ibkrPos && ibkrQtyAbs > 0) {
        const ibkrAvg = Number((ibkrPos as any).avgPrice ?? (ibkrPos as any).avgCost ?? pos.entryPrice ?? 0);
        const entryPx = ibkrAvg > 0 ? ibkrAvg : pos.entryPrice;
        await safeUpdateLivePosition(db, pos.id, {
          status: "open",
          units: ibkrQtyAbs,
          filledQty: ibkrQtyAbs,
          fillStatus: "full",
          remainingQty: 0,
          entryPrice: +entryPx.toFixed(4),
          allocatedCapital: +(entryPx * ibkrQtyAbs).toFixed(2),
          ibkrUnits: ibkrQtyAbs,
          ibkrAvgCost: entryPx,
          currentPrice: entryPx,
        });
        log.info("IBKR_SYNC", `[FillDetect] ${ticker} pending_entry → open (${ibkrQtyAbs}u @ $${entryPx.toFixed(2)})`, { ticker, posId: pos.id });
        result.synced++;
        continue;
      }

      // ── CASE 1: Position no longer exists in IBKR → closed by SL or TP fill ──
      if (!ibkrPos || ibkrQtyAbs === 0) {
        const isPendingEntry = pos.status === "pending_entry";
        // Resting LMT bracket still working — do NOT kill the row while order is live.
        if (isPendingEntry) {
          const restingEntry = ibkrOrders.some((o: any) => {
            const sym = String(o.description1 ?? o.ticker ?? o.symbol ?? "").toUpperCase();
            if (!sym.includes(ticker)) return false;
            return ["PreSubmitted", "Submitted", "PendingSubmit"].includes(String(o.status ?? ""));
          });
          if (restingEntry) {
            log.info("IBKR_SYNC",
              `[FillDetect] ${ticker} pending_entry — bracket still resting at IBKR, keeping row`,
              { ticker, posId: pos.id },
            );
            continue;
          }
        }
        log.info("IBKR_SYNC",
          `[FillDetect] ${ticker} NOT found / position=0 in IBKR → marking CLOSED (${isPendingEntry ? "entry never filled" : "SL/TP fill or manual"})`,
          { ticker, posId: pos.id }
        );

        // Clean up priceAlerts for this ticker (SL/TP alerts are no longer needed)
        try {
          const { priceAlerts } = await import("../../drizzle/schema");
          const { inArray: inArr } = await import("drizzle-orm");
          await db.delete(priceAlerts).where(
            and(
              eq(priceAlerts.userId, userId),
              eq(priceAlerts.ticker, ticker),
              inArr(priceAlerts.alertType, ["sl", "tp"] as any)
            )
          );
          log.info("IBKR_SYNC", `[Cleanup] Deleted SL/TP priceAlerts for ${ticker}`);
        } catch { /* non-blocking */ }

        // Determine exit reason: check if SL or TP order was filled
        let exitReason = isPendingEntry ? "ENTRY_CANCELLED" : "CLOSED_IBKR";
        // entry placed but never filled → cooldown so we stop re-spamming the broker every cycle.
        // BUGFIX 2026-06-24: was short-only. A no-fill LONG (e.g. priced off stale EOD → IBKR rejects)
        // got NO cooldown → re-attempted every ~7min cycle → endless orphan brackets + IBKR cancel
        // notifications. Cooldown applies to BOTH directions now.
        if (isPendingEntry) markHtb(ticker);
        let exitPrice = toPriceNumber(pos.currentPrice, toPriceNumber(pos.entryPrice, 0));

        if (!isPendingEntry) {
          // Check filled orders to distinguish SL vs TP
          const filledOrders = ibkrOrders.filter((o: any) =>
            o.status === "Filled" &&
            (o.ticker ?? "").toUpperCase() === ticker
          );
          for (const fo of filledOrders) {
            const rawType = (fo.orderType ?? "").toLowerCase();
            const isStp  = rawType === "stp" || rawType === "stop";
            const isLmt  = rawType === "lmt" || rawType === "limit";
            const isSell = (fo.side ?? "").toUpperCase().startsWith("S");
            if (isSell && isStp) { exitReason = "SL_HIT_IBKR"; exitPrice = fo.price ?? exitPrice; break; }
            if (isSell && isLmt) { exitReason = "TP_HIT_IBKR"; exitPrice = fo.price ?? exitPrice; break; }
          }
          // Fallback: use avgCost from IBKR position if available
          if (ibkrPos?.avgPrice && ibkrPos.avgPrice > 0) exitPrice = ibkrPos.avgPrice;
        }
        // ── Ghost/Phoenix close P&L-UNKNOWN guard (spec §3.5): a filled protective order
        //    disappears from /orders → exitPrice can be left at the stale currentPrice.
        //    Before declaring CLOSED_IBKR_NO_PRICE, recover the real execution price from
        //    the gateway /trades (execution) feed. Applies to ALL closes (a ghosted/phoenix
        //    runner is a normal `open` row), so a ghosted/phoenix close is never lost. Only
        //    OVERRIDES when the order-derived price was missing/invalid — never replaces a
        //    good SL/TP fill price. Returns null on any uncertainty → existing behavior.
        if (!isPendingEntry && (!Number.isFinite(exitPrice) || exitPrice <= 0)) {
          try {
            const { fetchExitFillFromTrades } = await import("./liveMarketOrder");
            const tradePx = await fetchExitFillFromTrades(ticker, pos.direction === "short");
            if (tradePx && tradePx > 0) {
              exitPrice = tradePx;
              log.info("IBKR_SYNC", `[${ticker}] exit price recovered from /trades → $${fmtPrice(tradePx)} (avoided P&L-UNKNOWN)`, { ticker, posId: pos.id });
            }
          } catch { /* fall through to CLOSED_IBKR_NO_PRICE below */ }
        }
        if (!isPendingEntry && (!Number.isFinite(exitPrice) || exitPrice <= 0)) {
          // A1 FIX (2026-06-25): a close with NO exit price has UNKNOWN P&L — NOT a real $0 trade.
          // We must still mark CLOSED (so the zombie stops looping every sync) and the realizedPnl
          // column is NOT-NULL, so the stored value stays 0 — BUT this used to fail SILENTLY, so a
          // fabricated $0 looked like a real breakeven trade and the true loss/gain was lost (GLW/INTC).
          // Now: keep the auditable `CLOSED_IBKR_NO_PRICE` reason AND alert the owner. Downstream
          // realized-P&L sums and the trade journal (A5) MUST exclude this exitReason from totals/win-rate.
          log.warn("IBKR_SYNC", `[${ticker}] closed with NO valid exit price → P&L UNKNOWN (stored 0, reason CLOSED_IBKR_NO_PRICE) — needs manual reconcile`, { ticker, posId: pos.id });
          await safeUpdateLivePosition(db, pos.id, { status: "closed", realizedPnl: 0, exitReason: "CLOSED_IBKR_NO_PRICE", closedAt: new Date() });
          try {
            const { removePortfolioHoldingForTicker } = await import("./portfolioHoldingsSync");
            await removePortfolioHoldingForTicker(db, userId, ticker);
          } catch { /* best-effort holdings mirror */ }
          result.closedByFill++;
          result.synced++;
          continue;
        }

        const realizedPnl = isPendingEntry ? 0 : positionRealizedPnl(pos.direction, pos.entryPrice, exitPrice, pos.units);

        await safeUpdateLivePosition(db, pos.id, {
          status:       "closed",
          exitPrice:    toPriceNumber(exitPrice),
          realizedPnl:  +realizedPnl.toFixed(2),
          exitReason,
          closedAt:     new Date(),
        });

        await db.insert(liveTrades).values({
          userId,
          positionId: pos.id,
          ticker:  pos.ticker,
          side:    pos.direction === "long" ? "SELL" : "BUY",
          units:   pos.units,
          price:   toPriceNumber(exitPrice),
          reason:  exitReason,
          status:  "filled",
        }).catch(() => {});

        // ── Phoenix P-S0: eligibility write on a Wide-Lung-SL close (INERT at flag=0) ──
        // When phoenixProtocolEnabled=1 and this close was a true wide-lung stop on an
        // eligible breakout, arm a same-day 5m-reclaim re-entry. Never throws; returns a
        // no-op when the flag is off → byte-identical. Uses the just-recorded exitReason/
        // exitPrice/initialSl so P2/P3 see broker-truth.
        if (!isPendingEntry) {
          try {
            const { writePhoenixEligibility } = await import("./phoenixProtocol");
            const { getLiveConfig } = await import("./liveOrderExecutor");
            const _phxCfg = await getLiveConfig(userId);
            await writePhoenixEligibility(
              { id: pos.id, userId, ticker: pos.ticker, signal: (pos as any).signal,
                direction: pos.direction, exitReason, exitPrice: toPriceNumber(exitPrice),
                initialSl: (pos as any).initialSl },
              _phxCfg, { db },
            );
            // ── Phoenix P-S0b: if THIS close is a phoenix-CHILD stop-out, arm the cooldown
            // + flip the lineage row to 'stopped' (the anti-loop READS this; nothing wrote
            // it). INERT at flag=0. Best-effort; never blocks the sync.
            const { writePhoenixChildStopped } = await import("./phoenixProtocol");
            await writePhoenixChildStopped(
              { id: pos.id, userId, ticker: pos.ticker,
                phoenixGeneration: (pos as any).phoenixGeneration,
                originPosId: (pos as any).originPosId, exitReason },
              _phxCfg, { db },
            );
          } catch { /* eligibility is best-effort; never block the sync */ }
        }

        const emoji = realizedPnl >= 0 ? "✅" : "🔴";
        if (!isOpsNoiseClose(exitReason) && Math.abs(realizedPnl) >= 1) {
          await sendTelegramMessage(
            `${emoji} <b>IBKR SYNC — Position Closed</b>\n` +
            `<b>${ticker}</b> | Reason: ${exitReason}\n` +
            `Exit: $${fmtPrice(exitPrice)} | P&L: ${realizedPnl >= 0 ? "+" : ""}$${fmtPrice(realizedPnl)}`
          ).catch(() => {});
        }

        result.closedByFill++;
        result.synced++;
        try {
          const { removePortfolioHoldingForTicker } = await import("./portfolioHoldingsSync");
          await removePortfolioHoldingForTicker(db, userId, ticker);
        } catch { /* best-effort holdings mirror */ }
        continue;
      }

      // ── CASE 2: Position exists in IBKR but SL/TP orders are missing (orphan) ─
      // This happens after manual partial close or bracket order mismatch
      const ibkrQty = Math.abs(ibkrPos.position ?? 0);
      const dbQty   = Math.abs(pos.units);

      // Check if our SL order is still alive
      const slAlive = pos.ibkrSlOrderId ? activeOrderIds.has(pos.ibkrSlOrderId) : false;
      const tpAlive = pos.ibkrTpOrderId ? activeOrderIds.has(pos.ibkrTpOrderId) : false;

      // If position was manually closed (qty = 0 in IBKR) but orders remain → cancel
      if (ibkrQty === 0 && (slAlive || tpAlive)) {
        log.warn("IBKR_SYNC",
          `[OrphanCancel] ${ticker} qty=0 in IBKR but has live SL/TP orders → cancelling`,
          { ticker, ibkrSlOrderId: pos.ibkrSlOrderId, ibkrTpOrderId: pos.ibkrTpOrderId }
        );
        const cancelResult = await cancelBracketOrders({
          ticker,
          ibkrSlOrderId: pos.ibkrSlOrderId,
          ibkrTpOrderId: pos.ibkrTpOrderId,
        });
        result.cancelledOrphans += cancelResult.cancelled;
        result.errors.push(...cancelResult.errors);
      }

      // ── CASE 2b: Reconcile UNITS + cost basis FROM IBKR (broker is the source of truth) ──
      // Fixes DB↔broker unit drift (e.g. DB 91 vs IBKR 230) so exits, sizing, and P&L use the
      // real quantity. Direction-guarded: if the broker shows a flipped side, do NOT silently
      // change magnitude — log and skip for a human to inspect.
      const ibkrDir = (ibkrPos.position ?? 0) > 0 ? "long" : "short";
      if (ibkrQty > 0 && ibkrQty !== dbQty) {
        if (ibkrDir !== pos.direction) {
          log.warn("IBKR_SYNC", `[UnitsReconcile] ${ticker} DIRECTION MISMATCH db=${pos.direction} ibkr=${ibkrDir} — skipping unit update`, { ticker });
        } else {
          const ibkrAvg = Number((ibkrPos as any).avgPrice ?? (ibkrPos as any).avgCost ?? 0);
          const updates: Record<string, any> = { units: ibkrQty };
          if (ibkrAvg > 0) {
            updates.entryPrice = +ibkrAvg.toFixed(4);
            updates.allocatedCapital = +(ibkrAvg * ibkrQty).toFixed(2);
          }
          log.warn("IBKR_SYNC", `[UnitsReconcile] ${ticker}: DB units ${dbQty} → IBKR ${ibkrQty}${ibkrAvg > 0 ? ` (entry→$${ibkrAvg.toFixed(2)})` : ""}`, { ticker, dbQty, ibkrQty });
          await safeUpdateLivePosition(db, pos.id, updates);
          pos.units = ibkrQty; // so CASE 3 P&L below uses the corrected quantity
          if (ibkrAvg > 0) { pos.entryPrice = ibkrAvg; (pos as any).allocatedCapital = ibkrAvg * ibkrQty; }
          try {
            const { reconcileHoldingFromLivePosition } = await import("./portfolioHoldingsSync");
            await reconcileHoldingFromLivePosition(db, userId, ticker);
          } catch { /* best-effort H1 mirror (preserved from concurrent edit) */ }
        }
      }

      // ── CASE 2c: Backfill SL/TP order IDs from live working orders (fixes War Room ✗ badge) ──
      {
        const coverPrefix = pos.direction === "long" ? "S" : "B"; // long covered by SELL, short by BUY
        const cover = ibkrOrders.filter((o: any) =>
          (o.ticker ?? o.description1 ?? "").toUpperCase() === ticker &&
          String(o.side ?? "").toUpperCase().startsWith(coverPrefix) &&
          (o.status === "PreSubmitted" || o.status === "Submitted")
        );
        const slNow = cover.find((o: any) => { const t = String(o.orderType ?? "").toUpperCase(); return t.startsWith("STOP") || t === "STP" || t.startsWith("TRAIL"); });
        const tpNow = cover.find((o: any) => { const t = String(o.orderType ?? "").toUpperCase(); return t === "LMT" || t === "LIMIT"; });
        const slId = slNow ? String(slNow.orderId) : null;
        const tpId = tpNow ? String(tpNow.orderId) : null;
        const upd: Record<string, any> = {};
        if (slId && slId !== pos.ibkrSlOrderId) upd.ibkrSlOrderId = slId;
        if (tpId && tpId !== pos.ibkrTpOrderId) upd.ibkrTpOrderId = tpId;
        if (Object.keys(upd).length > 0) {
          await safeUpdateLivePosition(db, pos.id, upd);
          log.info("IBKR_SYNC", `[OrderIdBackfill] ${ticker} SL=${slId ?? "—"} TP=${tpId ?? "—"}`, { ticker });
        }
      }

      // ── CASE 3: Update live price + unrealized PnL ─────────────────────────
      const livePrice = ibkrPos.mktPrice ?? ibkrPos.markPrice ?? pos.currentPrice ?? pos.entryPrice;
      if (livePrice && livePrice > 0) {
        const pnl    = positionUnrealizedPnl(pos.direction, pos.entryPrice, livePrice, pos.units);
        const pnlPct = pos.allocatedCapital > 0 ? (pnl / pos.allocatedCapital) * 100 : 0;

        await safeUpdateLivePosition(db, pos.id, {
          currentPrice:     +livePrice.toFixed(4),
          unrealizedPnl:    +pnl.toFixed(2),
          unrealizedPnlPct: +pnlPct.toFixed(3),
        });

        result.priceUpdates++;

        const needsRisk =
          pos.atr14 == null || pos.rValue == null
          || !Number.isFinite(Number(pos.atr14)) || !Number.isFinite(Number(pos.rValue))
          || Number(pos.atr14) <= 0 || Number(pos.rValue) <= 0;
        if (needsRisk) {
          await backfillOpenPositionRiskMetrics(db, {
            id: pos.id,
            ticker: pos.ticker,
            direction: pos.direction,
            entryPrice: pos.entryPrice,
            currentSl: pos.currentSl,
            initialSl: pos.initialSl,
            rValue: pos.rValue,
            atr14: pos.atr14,
          });
        }
      }

      result.synced++;
    } catch (err: any) {
      result.errors.push(`${pos.ticker}: ${err.message}`);
      log.error("IBKR_SYNC", `Error syncing ${pos.ticker}: ${err.message}`, { ticker: pos.ticker });
    }
  }

  // ── ADOPT engine-blind positions: open at IBKR but missing from livePositions ──
  // (e.g. NET/NVMI — engine positions that fell out of tracking). Bring them under management
  // using the broker's units/avgCost and the EXISTING working SL/TP orders. openedAt=now() gives
  // them the engine's grace window so they are not force-closed instantly. Only adopt positions
  // that already have BOTH a live SL and TP at IBKR (so they stay protected and the NOT-NULL
  // currentSl/currentTp columns are real).
  try {
    // Skip any ticker that already has a NON-closed livePositions row (open OR zombie/pending). Such
    // rows need REACTIVATION (a human/separate path), not a duplicate insert — this also stops the
    // per-sync insert error loop for tickers like NET that carry a leftover 'zombie' row.
    const existingRows = await db.select({ ticker: livePositions.ticker }).from(livePositions)
      .where(and(eq(livePositions.userId, userId), inArray(livePositions.status, ["open", "zombie", "pending_entry", "pending_exit", "frozen", "pending_halt"] as any)));
    const trackedTickers = new Set(existingRows.map((r: any) => String(r.ticker).toUpperCase()));
    for (const ip of ibkrPositions) {
      const sym = String(ip.ticker ?? ip.contractDesc ?? ip.symbol ?? "").toUpperCase().trim();
      const signed = Number(ip.position ?? 0);
      if (!sym || Math.abs(signed) === 0 || trackedTickers.has(sym)) continue;
      const dir: "long" | "short" = signed > 0 ? "long" : "short";
      const qty = Math.abs(signed);
      const avg = Number(ip.avgPrice ?? ip.avgCost ?? 0);
      const mkt = Number(ip.mktPrice ?? ip.markPrice ?? avg);
      if (avg <= 0) { log.warn("IBKR_SYNC", `[Adopt] ${sym} skipped — no avg cost from IBKR`, { sym }); continue; }
      const coverPrefix = dir === "long" ? "S" : "B";
      const cover = ibkrOrders.filter((o: any) =>
        String(o.ticker ?? o.description1 ?? "").toUpperCase() === sym &&
        String(o.side ?? "").toUpperCase().startsWith(coverPrefix) &&
        (o.status === "PreSubmitted" || o.status === "Submitted"));
      const slO = cover.find((o: any) => { const t = String(o.orderType ?? "").toUpperCase(); return t.startsWith("STOP") || t === "STP" || t.startsWith("TRAIL"); });
      const tpO = cover.find((o: any) => { const t = String(o.orderType ?? "").toUpperCase(); return t === "LMT" || t === "LIMIT"; });
      let slPrice = slO ? Number(slO.auxPrice ?? slO.price ?? slO.lmtPrice ?? 0) : 0;
      let tpPrice = tpO ? Number(tpO.price ?? tpO.lmtPrice ?? 0) : 0;
      // KEYSTONE 2026-06-25: adopt DOWNSIDE-FIRST. The old rule required BOTH a live SL *and* TP,
      // so a position with only one leg (e.g. a TP that didn't land on the flaky gateway) stayed
      // engine-blind forever — which is exactly why MU/GOOG/TSM/NET showed DB rows=0 while open at
      // IBKR (X button dead, "Sync SL/TP" couldn't manage them). Now: adopt every open position with
      // a real avg cost; fill any missing leg with a mark-derived fallback so currentSl/currentTp
      // (NOT-NULL) are real, and liveSlTpEnforcement places the actual missing protective order.
      const refPx = mkt > 0 ? mkt : avg;
      if (slPrice <= 0) slPrice = dir === "long" ? +(refPx * 0.92).toFixed(2) : +(refPx * 1.08).toFixed(2);
      if (tpPrice <= 0) tpPrice = dir === "long" ? +(refPx * 1.12).toFixed(2) : +(refPx * 0.88).toFixed(2);
      await db.insert(livePositions).values({
        userId,
        accountId: LIVE_ACCOUNT_ID,
        ticker: sym,
        direction: dir,
        units: qty,
        entryPrice: +avg.toFixed(4),
        allocatedCapital: +(avg * qty).toFixed(2),
        currentPrice: +mkt.toFixed(4),
        currentSl: +slPrice.toFixed(2),
        currentTp: +tpPrice.toFixed(2),
        initialSl: +slPrice.toFixed(2),
        initialTp: +tpPrice.toFixed(2),
        ibkrSlOrderId: slO ? String(slO.orderId) : null,
        ibkrTpOrderId: tpO ? String(tpO.orderId) : null,
        status: "open",
        signal: "ADOPTED_IBKR",
        slProtection: "ibkr",
        openedAt: new Date(),
      } as any).catch((e: any) => { log.error("IBKR_SYNC", `[Adopt] ${sym} insert failed: ${e.message}`, { sym }); });
      log.warn("IBKR_SYNC", `[Adopt] ${sym} ${dir} ${qty}u adopted into engine management — entry $${avg.toFixed(2)}, SL $${slPrice.toFixed(2)}, TP $${tpPrice.toFixed(2)}`, { sym });
      result.synced++;
    }
  } catch (e: any) { log.error("IBKR_SYNC", `[Adopt] pass failed: ${e.message}`); }

  try {
    const { pruneStalePortfolioHoldings } = await import("./portfolioHoldingsSync");
    const pruned = await pruneStalePortfolioHoldings(db, userId);
    if (pruned.removed.length > 0) {
      log.info("IBKR_SYNC", `[HoldingsPrune] removed stale portfolioHoldings: ${pruned.removed.join(", ")}`, pruned);
    }
  } catch { /* best-effort */ }

  log.info("IBKR_SYNC",
    `Sync complete: ${result.synced} synced, ${result.closedByFill} closed by fill, ${result.cancelledOrphans} orphans cancelled, ${result.priceUpdates} price updates`,
    result
  );

  return result;
  } finally {
    _ibkrSyncRunning = false;
  }
}
