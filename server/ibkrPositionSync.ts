/**
 * ibkrPositionSync.ts
 * Polls IBKR every 60s. Detects OCA fills (SL/TP executed by IBKR).
 * If position missing from IBKR → mark DB as "closed".
 * Also syncs currentPrice + unrealizedPnl for all open positions.
 */

import { getDb } from "./db";
import { sendTelegramMessage } from "./telegram";
import { ibindRequest } from "./routers/ibkrProxy";
import { cancelBracketOrders } from "./liveOrderExecutor";
import { log } from "./logger";
import {
  fetchOpenLivePositionsForSync,
  safeUpdateLivePosition,
  safeCloseLivePosition,
} from "./livePositionsSyncCore";
import { isIbkrSyncMarketOpen } from "./utils/marketHours";

import { LIVE_ACCOUNT_ID } from "./liveOrderExecutor";
const SYNC_INTERVAL_MS = 60_000;
let _syncTimer: ReturnType<typeof setTimeout> | null = null;
let _syncRunning = false;

function isMarketHours(): boolean {
  return isIbkrSyncMarketOpen();
}

async function fetchIbkrPortfolioMap(): Promise<Map<string, { qty: number; isShort: boolean; mktPrice: number; unrealizedPnl: number; mktValue: number }>> {
  const result = new Map<string, { qty: number; isShort: boolean; mktPrice: number; unrealizedPnl: number; mktValue: number }>();
  try {
    const res = await ibindRequest("GET", `/positions`);
    if (!res.ok) return result;
    // /positions returns { positions: [...] } or [...]
    const raw = Array.isArray(res.body) ? res.body : (res.body as any)?.positions ?? [];
    for (const pos of raw) {
      const ticker = pos.ticker ?? pos.contractDesc?.split(' ')[0] ?? null;
      if (!ticker) continue;
      const rawQty = Number(pos.position ?? 0);
      if (rawQty === 0) continue; // skip watchlist entries with no position
      const qty = Math.abs(rawQty);
      const isShort = rawQty < 0;
      result.set(ticker.toUpperCase(), {
        qty,
        isShort,
        mktPrice:      Number(pos.baseMktPrice ?? pos.avgPrice ?? 0),
        mktValue:      Number(pos.baseMktValue ?? 0),
        unrealizedPnl: Number(pos.baseUnrealizedPnl ?? 0),
      });
    }
  } catch (err: any) {
    log.warn("IBKR", `[IbkrSync] Portfolio fetch failed: ${err.message}`);
  }
  return result;
}

export async function runIbkrPositionSync(userId: number): Promise<{ synced: number; closed: number; updated: number }> {
  if (_syncRunning) return { synced: 0, closed: 0, updated: 0 };
  _syncRunning = true;

  let closed = 0;
  let updated = 0;

  try {
    const db = await getDb();
    if (!db) return { synced: 0, closed: 0, updated: 0 };

    const openPos = await fetchOpenLivePositionsForSync(db, userId);

    if (openPos.length === 0) return { synced: 0, closed: 0, updated: 0 };

    const ibkrMap = await fetchIbkrPortfolioMap();
    if (ibkrMap.size === 0) {
      // IBKR fetch failed — skip rather than incorrectly closing positions
      log.warn("IBKR", "[IbkrSync] ⚠️ Empty portfolio response — skipping sync to avoid false closes");
      return { synced: openPos.length, closed: 0, updated: 0 };
    }

    for (const pos of openPos) {
      const ticker = pos.ticker.toUpperCase();
      const ibkr = ibkrMap.get(ticker);

      // ── Case 1: Position gone from IBKR → SL or TP was filled ───────────
      if (!ibkr || ibkr.qty === 0) {
        const isPendingEntry = pos.status === "pending_entry";
        const exitPrice = pos.currentPrice ?? pos.entryPrice;
        const d = pos.direction === "short" ? -1 : 1;
        const realizedPnl = isPendingEntry ? 0 : (exitPrice - pos.entryPrice) * pos.units * d;

        // Infer reason
        let exitReason = isPendingEntry ? "ENTRY_CANCELLED" : "IBKR_OCA_FILLED";
        if (!isPendingEntry) {
          const sl = pos.currentSl ?? pos.initialSl;
          const tp = pos.initialTp;
          if (sl && Math.abs(exitPrice - sl) / pos.entryPrice < 0.015) {
            exitReason = "SL_FILLED_IBKR";
          } else if (tp && Math.abs(exitPrice - tp) / pos.entryPrice < 0.015) {
            exitReason = "TP_FILLED_IBKR";
          }
        }

        const closeResult = await safeCloseLivePosition(db, pos.id, {
          status:      "closed",
          closedAt:    new Date(),
          exitPrice,
          realizedPnl: +realizedPnl.toFixed(2),
          exitReason,
        });
        if (closeResult === "purged") {
          log.info("IBKR", `[IbkrSync] 🗑️ ${ticker} pending zombie purged (prior closed row exists)`);
        }

        // ── AUTO-CANCEL orphaned bracket orders ────────────────────────────────
        // If closed by OCA (IBKR), the other leg is already cancelled by IBKR.
        // If closed MANUALLY, bracket legs become orphans — cancel them now.
        if (exitReason === "IBKR_OCA_FILLED" || exitReason === "MANUAL_CLOSE" || exitReason === "ENTRY_CANCELLED") {
          const bracketResult = await cancelBracketOrders({
            ticker,
            ibkrSlOrderId: (pos as any).ibkrSlOrderId,
            ibkrTpOrderId: pos.ibkrTpOrderId,
          });
          if (bracketResult.cancelled > 0) {
            log.info("IBKR", `[IbkrSync] 🗑️ ${ticker} — cancelled ${bracketResult.cancelled} bracket leg(s)`);
          }
        }

        closed++;
        log.info("IBKR",
          `[IbkrSync] 🔔 ${ticker} OCA closed (${exitReason}) | exit=$${typeof exitPrice === "number" ? exitPrice.toFixed(2) : "N/A"} | P&L: $${realizedPnl >= 0 ? "+" : ""}${typeof realizedPnl === "number" ? realizedPnl.toFixed(0) : "0"}`
        );
        continue;
      }

      // ── Case 2: Partial fill ──────────────────────────────────────────────
      if (ibkr.qty < pos.units) {
        const soldUnits = pos.units - ibkr.qty;
        log.info("IBKR",
          `[IbkrSync] 📉 Partial ${ticker}: ${pos.units}u → ${ibkr.qty}u (${soldUnits} filled)`
        );
        await safeUpdateLivePosition(db, pos.id, {
          units:           ibkr.qty,
          currentPrice:    ibkr.mktPrice > 0 ? +ibkr.mktPrice.toFixed(4) : pos.currentPrice,
          unrealizedPnl:   +ibkr.unrealizedPnl.toFixed(2),
          allocatedCapital: ibkr.mktValue > 0 ? +ibkr.mktValue.toFixed(2) : pos.allocatedCapital,
        });
        updated++;
        continue;
      }

      // ── Case 3: Normal — update price + unrealizedPnl ─────────────────────
      if (ibkr.mktPrice > 0) {
        // Use IBKR-side direction (negative qty = short) — more reliable than DB field
        const d = ibkr.isShort ? -1 : 1;
        // Also auto-correct direction in DB if mismatch detected
        const correctDir = ibkr.isShort ? "short" : "long";
        const newPnl = (ibkr.mktPrice - pos.entryPrice) * ibkr.qty * d;
        await safeUpdateLivePosition(db, pos.id, {
          currentPrice:    +ibkr.mktPrice.toFixed(4),
          direction:       correctDir,
          units:           ibkr.qty,
          unrealizedPnl:   +newPnl.toFixed(2),
          unrealizedPnlPct: pos.entryPrice > 0
            ? +((newPnl / (pos.entryPrice * ibkr.qty)) * 100).toFixed(2)
            : 0,
        });
        updated++;
      }
    }

    log.info("IBKR",
      `[IbkrSync] ✅ Sync done: ${openPos.length} checked | ${closed} OCA-closed | ${updated} updated`
    );
    return { synced: openPos.length, closed, updated };

  } catch (err: any) {
    log.error("IBKR", `[IbkrSync] ❌ Error: ${err.message}`);
    // Telegram alert on repeated DB/sync failures
    if (err.message?.includes("Failed query") || err.message?.includes("toFixed")) {
      sendTelegramMessage(1, `🚨 IBKR Sync Error: ${err.message?.slice(0, 120)}`).catch(() => {});
    }
    return { synced: 0, closed: 0, updated: 0 };
  } finally {
    _syncRunning = false;
  }
}

export function startIbkrSyncScheduler(userId: number): void {
  if (_syncTimer) return;
  const tick = async () => {
    if (isMarketHours()) {
      await runIbkrPositionSync(userId);
    }
    _syncTimer = setTimeout(tick, SYNC_INTERVAL_MS);
  };
  _syncTimer = setTimeout(tick, 10_000); // first run 10s after startup
  log.info("IBKR", "[IbkrSync] 🚀 Scheduler started — 60s polling during US market hours");
}

export function stopIbkrSyncScheduler(): void {
  if (_syncTimer) {
    clearTimeout(_syncTimer);
    _syncTimer = null;
    log.info("IBKR", "[IbkrSync] 🛑 Scheduler stopped");
  }
}

// ── Tickle structured log ─────────────────────────────────────────────────────
export function logTickleSuccess() {
  log.info("TICKLE", "Health check successful (200 OK). Live Session kept alive.");
}
export function logTickleFail(status: number, msg: string) {
  log.warn("TICKLE", `Health check FAILED (${status}). Session may be dropped. ${msg}`, { status, msg });
}
