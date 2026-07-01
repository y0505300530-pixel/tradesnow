/**
 * partialFillMonitor.ts — Partial Fill Lifecycle + LULD Halt Handler (V2.00)
 *
 * Feature 3: Partial Fills
 *   - Polls IBKR order status for open positions with fillStatus='partial'
 *   - Dynamically adjusts SL/TP to match actual filledQty
 *   - Updates requestedQty, filledQty, remainingQty in DB
 *
 * Feature 4: LULD Halt Recovery
 *   - Detects positions in status='pending_halt'
 *   - Polls IBKR trading status for the ticker
 *   - When halt lifts: re-sends exit order as Marketable LMT (1.5% offset, aggressive)
 */

import { getDb }               from "./db";
import { livePositions }       from "../drizzle/schema";
import { eq, and, inArray }    from "drizzle-orm";
import { ibindRequest }        from "./routers/ibkrProxy";
import { throttledIbind, throttledModify } from "./ibkrThrottle";
import { fetchIbkrLivePricesBatch } from "./marketData";
import { sendTelegramMessage } from "./telegram";
import { log }                 from "./logger";

import { LIVE_ACCOUNT_ID } from "./liveOrderExecutor";
const MAX_HALT_RETRIES = 12;         // 12 × 5min = 1 hour max wait after halt lifts
const HALT_EXIT_OFFSET_PCT = 0.015; // 1.5% aggressive offset on halt recovery

// ─── Feature 3: Partial Fill Monitor ────────────────────────────────────────

export async function runPartialFillMonitor(userId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // Find all open positions with partial fills
  const partials = await db
    .select()
    .from(livePositions)
    .where(and(
      eq(livePositions.userId, userId),
      eq(livePositions.status, "open"),
    ))
    .then(rows => rows.filter(r => (r as any).fillStatus === "partial"));
  // Note: fillStatus filtered in-memory to avoid drizzle column reference issue

  if (partials.length === 0) return;

  // Fetch current IBKR orders once (batch)
  let ibkrOrders: any[] = [];
  try {
    const ordRes = await throttledIbind("GET", "/orders");
    ibkrOrders = ordRes.ok ? ((ordRes.body as any)?.orders ?? []) : [];
  } catch {}

  for (const pos of partials) {
    if (!pos.ibkrEntryOrderId) continue;
    const entryOrder = ibkrOrders.find(
      (o: any) => String(o.orderId ?? o.order_id) === String(pos.ibkrEntryOrderId)
    );
    if (!entryOrder) continue;

    const rawStatus = (entryOrder.status ?? "").toLowerCase();
    const newFilledQty = parseInt(entryOrder.filledQuantity ?? entryOrder.filled ?? "0", 10);
    const reqQty       = pos.requestedQty ?? pos.units ?? newFilledQty;
    const newRemaining = Math.max(0, reqQty - newFilledQty);

    if (newFilledQty <= 0) continue;

    const isFull = rawStatus === "filled" || newRemaining === 0;

    // Recalculate SL/TP based on actual filled qty
    const entryPx  = pos.entryPrice ?? 0;
    const isShort  = pos.direction === "short";
    const slPct    = 0.03;
    const tpPct    = 0.06;
    const newSl    = isShort ? entryPx * (1 + slPct) : entryPx * (1 - slPct);
    const newTp    = isShort ? entryPx * (1 - tpPct) : entryPx * (1 + tpPct);

    log.info("PARTIAL_FILL",
      `[PartialFill] ${pos.ticker}: filled=${newFilledQty}/${reqQty} ` +
      `(${isFull ? "COMPLETE" : "PARTIAL"}) — adjusting SL/TP`
    );

    await db.update(livePositions).set({
      filledQty:    newFilledQty,
      remainingQty: newRemaining,
      units:        newFilledQty,      // units = what's actually in the account
      fillStatus:   isFull ? "full" : "partial",
      currentSl:    +newSl.toFixed(2),
      currentTp:    +newTp.toFixed(2),
    }).where(eq(livePositions.id, pos.id));

    if (isFull) {
      log.info("PARTIAL_FILL", `[PartialFill] ${pos.ticker}: position fully filled — SL/TP finalized`);
    }
  }
}

/**
 * Registers a new position as having a partial fill scenario.
 * Called from tryLiveEntry when IBKR returns a filled qty < requested.
 */
export async function registerPartialFill(
  positionId: number,
  requestedQty: number,
  filledQty: number
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const remaining = Math.max(0, requestedQty - filledQty);
  await db.update(livePositions).set({
    requestedQty,
    filledQty,
    remainingQty: remaining,
    fillStatus: remaining > 0 ? "partial" : "full",
    units: filledQty,
  }).where(eq(livePositions.id, positionId));
  log.info("PARTIAL_FILL",
    `[RegisterPartialFill] posId=${positionId} req=${requestedQty} filled=${filledQty} remaining=${remaining}`
  );
}

// ─── Feature 4: LULD Halt Recovery ──────────────────────────────────────────

/**
 * Marks a position as pending_halt when an exit order is rejected due to a trading halt.
 */
export async function markPositionPendingHalt(
  positionId: number,
  exitSide: "BUY" | "SELL"
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(livePositions).set({
    status: "pending_halt" as any,
    pendingHalt: 1,
    haltPendingExitSide: exitSide,
  }).where(eq(livePositions.id, positionId));
  log.warn("HALT", `[PendingHalt] posId=${positionId} side=${exitSide} — waiting for halt lift`);
}

/**
 * runHaltRecoveryMonitor — runs every 5min to check for halt-lifted tickers.
 * When a halt lifts, re-sends the exit order with an aggressive 1.5% offset LMT.
 */
export async function runHaltRecoveryMonitor(userId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const haltedPositions = await db
    .select()
    .from(livePositions)
    .where(and(
      eq(livePositions.userId, userId),
      eq(livePositions.status, "pending_halt" as any),
    ));

  if (haltedPositions.length === 0) return;

  // Fetch live prices for halted tickers (check if trading resumed)
  const tickers = [...new Set(haltedPositions.map(p => p.ticker))];

  // REPOINT 2026-06-25: /iserver/marketdata/snapshot 404s on the OAuth gateway, so the
  // field-6457 trading-status read is gone. Use the working POST /quotes pipeline instead:
  // a HALTED instrument returns no live price (price 0/null), whereas a RESUMED one returns
  // a real price. So `price > 0` is our halt-lifted signal and `price <= 0` means still
  // halted — which maps exactly onto the existing { price, halted } consumer below.
  // (We never price the recovery exit off stale EOD: 0/null price → treated as still halted.)
  let snapMap = new Map<string, { price: number; halted: boolean }>();
  try {
    const priceMap = await fetchIbkrLivePricesBatch(tickers, { skipCache: true });
    for (const t of tickers) {
      const lp    = priceMap.get(t) ?? null;
      // QA fix #2: a halt-recovery exit may be priced ONLY off real-time IBKR truth. A silent Yahoo/
      // DB-cache fallback (source!=='ibkr') is treated as no live price → still-halted (price 0) →
      // we never re-send the recovery exit off a delayed/stale print.
      const price = lp?.source === 'ibkr' ? Number(lp.price ?? 0) : 0;
      const isHalted = !(price > 0); // no live price ⇒ still halted (or quote unavailable)
      snapMap.set(t.toUpperCase(), { price, halted: isHalted });
    }
  } catch (e: any) {
    log.warn("HALT", `[HaltRecovery] Live-quote fetch error: ${e.message}`);
    return;
  }

  for (const pos of haltedPositions) {
    const snap = snapMap.get(pos.ticker.toUpperCase());
    if (!snap) continue;

    if (snap.halted) {
      // Still halted — check retry limit
      const retries = (pos.haltRetryCount ?? 0) + 1;
      await db.update(livePositions).set({ haltRetryCount: retries })
        .where(eq(livePositions.id, pos.id));

      if (retries >= MAX_HALT_RETRIES) {
        log.error("HALT",
          `[HaltRecovery] ${pos.ticker} still halted after ${retries} retries — escalating to manual`
        );
        try {
          await sendTelegramMessage(
            `🔴 *HALT ESCALATION — MANUAL ACTION REQUIRED*\n` +
            `${pos.ticker} has been halted for >1 hour.\n` +
            `Position is still open — please close manually in TWS.`
          );
        } catch {}
      }
      continue;
    }

    // ── Halt lifted — send aggressive exit order ─────────────────────────
    const livePrice = snap.price;
    if (!livePrice || livePrice <= 0) continue;

    const exitSide = pos.haltPendingExitSide ?? (pos.direction === "long" ? "SELL" : "BUY");
    // 1.5% aggressive offset to guarantee fill
    const lmtPrice = exitSide === "SELL"
      ? +(livePrice * (1 - HALT_EXIT_OFFSET_PCT)).toFixed(2)
      : +(livePrice * (1 + HALT_EXIT_OFFSET_PCT)).toFixed(2);

    log.warn("HALT",
      `[HaltRecovery] ${pos.ticker} halt LIFTED — sending ${exitSide} @ $${lmtPrice} (live=$${livePrice})`,
      { ticker: pos.ticker, exitSide, lmtPrice, livePrice }
    );

    try {
      const orderBody = {
        orders: [{
          acctId:    LIVE_ACCOUNT_ID,
          conid:     0,
          secType:   "0:STK",
          orderType: "LMT",
          price:     lmtPrice,
          side:      exitSide,
          quantity:  Math.abs(pos.units ?? 1),
          tif:       "DAY",
          outsideRth: false,
        }]
      };
      const res = await throttledModify("POST", `/iserver/account/${LIVE_ACCOUNT_ID}/orders`, orderBody);

      if (res.ok) {
        log.info("HALT", `[HaltRecovery] ${pos.ticker} exit order sent — restoring to pending_exit`);
        await db.update(livePositions).set({
          status: "pending_exit",
          pendingHalt: 0,
          haltRetryCount: 0,
          haltPendingExitSide: null,
        }).where(eq(livePositions.id, pos.id));

        try {
          await sendTelegramMessage(
            `🟢 *HALT RECOVERY — Exit order sent*\n` +
            `${pos.ticker} halt lifted — ${exitSide} @ $${lmtPrice}\n` +
            `(Live price: $${livePrice})`
          );
        } catch {}
      } else {
        log.error("HALT",
          `[HaltRecovery] ${pos.ticker} exit order FAILED: ${JSON.stringify(res.body).slice(0, 120)}`
        );
      }
    } catch (e: any) {
      log.error("HALT", `[HaltRecovery] ${pos.ticker} exception: ${e.message}`);
    }
  }
}
