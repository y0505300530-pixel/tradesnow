/**
 * liveSlTpEnforcement.ts — SL/TP Enforcement Engine (Live IBKR)
 *
 * Shared by:
 *   - War Room manual button (liveEngine.syncSlTp)
 *   - alertPoller CRON (every 5 min during market hours)
 *
 * Phase A — Pre-flight (market hours log, NaN guard per ticker)
 * Phase B — Cancel orphan SL/TP (no live position)
 * Phase C — Per position: dedupe, fix qty, place missing SL/TP from DB levels
 */

import { getDb } from "./db";
import { livePositions, ibkrConidCache } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { ibindRequest } from "./routers/ibkrProxy";
import { isLiveMarketOpen } from "./liveOrderExecutor";
import { log } from "./logger";

import { LIVE_ACCOUNT_ID } from "./liveOrderExecutor";

export type SlTpEnforcementTrigger = "MANUAL" | "CRON";

export interface SlTpEnforcementResult {
  ok: boolean;
  message: string;
  placed: number;
  qtyFixed: number;
  orphansCancelled: number;
  alreadyOk: number;
  skippedNaN: number;
  failed: number;
  marketOpen: boolean;
  details: string[];
}

function isWorkingStatus(status: string | undefined): boolean {
  return ["PreSubmitted", "Submitted", "Working"].includes(status ?? "");
}

function isProtectiveOrderType(orderType: string | undefined): boolean {
  const t = (orderType ?? "").toLowerCase();
  return t === "lmt" || t === "limit" || t === "stp" || t === "stop" || t === "trail";
}

function isSlOrderType(orderType: string | undefined): boolean {
  const t = (orderType ?? "").toLowerCase();
  return t === "stp" || t === "stop" || t === "trail";
}

function isTpOrderType(orderType: string | undefined): boolean {
  const t = (orderType ?? "").toLowerCase();
  return t === "lmt" || t === "limit";
}

/** Protective exit side: SELL for long, BUY for short cover */
export function isExitSide(side: string | undefined, isShort: boolean): boolean {
  const s = (side ?? "").toUpperCase();
  return isShort ? s.startsWith("B") : s.startsWith("S");
}

/** Bracket leg (entry / SL / TP) — must not be cancelled as orphan while pending fill */
export function isBracketLeg(o: { cOID?: string; coid?: string; local_order_id?: string; client_order_id?: string; parent_order_id?: string | number | null }): boolean {
  const coid = String(o.cOID ?? o.coid ?? o.local_order_id ?? o.client_order_id ?? "");
  if (coid.startsWith("BR-P-") || coid.startsWith("BR-SL-") || coid.startsWith("BR-TP-")) return true;
  const parentId = o.parent_order_id;
  return parentId != null && parentId !== "" && parentId !== 0;
}

/** True orphan: standalone SL/TP with no live position (not a pending bracket leg) */
export function isOrphanProtectiveOrder(o: any, liveTickers: Set<string>): boolean {
  const ticker = (o.description1 ?? o.ticker ?? "").toUpperCase().trim();
  if (!ticker) return false;
  if (liveTickers.has(ticker)) return false;
  if (isBracketLeg(o)) return false;
  if (!isProtectiveOrderType(o.orderType)) return false;
  return isSlOrderType(o.orderType) || isTpOrderType(o.orderType);
}

const CONFIRM_HEADERS = { "X-Confirm-Live-Order": "yes" };

function isAlreadyGoneCancel(body: unknown): boolean {
  const text = JSON.stringify(body ?? "").toLowerCase();
  return text.includes("inactive")
    || text.includes("cancel")
    || text.includes("not found")
    || text.includes("no order")
    || text.includes("already");
}

async function cancelOrder(orderId: string): Promise<{ ok: boolean; reason?: string }> {
  const paths = [
    `/api/proxy/iserver/account/${LIVE_ACCOUNT_ID}/order/${orderId}`,
    `/iserver/account/${LIVE_ACCOUNT_ID}/order/${orderId}`,
    `/order/${LIVE_ACCOUNT_ID}/${orderId}`,
  ];

  let lastReason = "unknown";
  for (const path of paths) {
    try {
      const r = await ibindRequest("DELETE", path, undefined, CONFIRM_HEADERS);
      if (r.ok) return { ok: true };
      if (r.status === 404 || isAlreadyGoneCancel(r.body)) {
        log.info("SL_TP_ENFORCEMENT", `Cancel ${orderId}: already gone (${path} HTTP ${r.status})`);
        return { ok: true };
      }
      lastReason = `HTTP ${r.status} @ ${path}`;
      log.warn("SL_TP_ENFORCEMENT", `Cancel ${orderId} failed: ${lastReason}`, {
        body: JSON.stringify(r.body).slice(0, 200),
      });
    } catch (e: any) {
      lastReason = e.message;
      log.warn("SL_TP_ENFORCEMENT", `Cancel ${orderId} exception @ ${path}: ${e.message}`);
    }
  }
  return { ok: false, reason: lastReason };
}

/**
 * Full SL/TP enforcement — same logic as War Room "סנכרן SL/TP" button.
 */
export async function runLiveSlTpEnforcement(
  userId: number,
  trigger: SlTpEnforcementTrigger = "CRON",
): Promise<SlTpEnforcementResult> {
  log.info("SL_TP_ENFORCEMENT", `Cycle started (Trigger: ${trigger})`);

  const db = await getDb();
  if (!db) {
    return {
      ok: false,
      message: "DB unavailable",
      placed: 0,
      qtyFixed: 0,
      orphansCancelled: 0,
      alreadyOk: 0,
      skippedNaN: 0,
      failed: 0,
      marketOpen: false,
      details: [],
    };
  }

  const marketOpen = isLiveMarketOpen();
  log.info("SL_TP_ENFORCEMENT", `Market open: ${marketOpen}`);

  let ibkrPositions: any[] = [];
  let allOrders: any[] = [];

  try {
    const [posRes, ordersRes] = await Promise.all([
      ibindRequest("GET", "/positions"),
      ibindRequest("GET", "/orders"),
    ]);

    if (posRes.ok) {
      const raw: any[] = (posRes.body as any)?.positions ?? [];
      ibkrPositions = raw.filter((p: any) => p.position !== 0 && Math.abs(p.mktValue ?? 0) > 50);
    }
    if (ordersRes.ok) {
      allOrders = (ordersRes.body as any)?.orders ?? [];
    }
  } catch (e: any) {
    log.warn("SL_TP_ENFORCEMENT", `IBKR fetch failed: ${e.message} — using DB fallback`);
  }

  if (ibkrPositions.length === 0) {
    const dbPos = await db.select().from(livePositions)
      .where(and(eq(livePositions.userId, userId), eq(livePositions.status, "open")));
    ibkrPositions = dbPos.map((p: any) => ({
      position: p.direction === "long" ? (p.units ?? 1) : -(p.units ?? 1),
      mktValue: p.allocatedCapital ?? 10000,
      contractDesc: p.ticker,
      ticker: p.ticker,
      avgCost: p.entryPrice,
      mktPrice: p.currentPrice ?? p.entryPrice,
      conid: p.ibkrConid ?? null,
      _fromDb: true,
      _dbRow: p,
    }));
    if (dbPos.length > 0) {
      log.warn("SL_TP_ENFORCEMENT", `IBKR returned 0 positions — using DB (${ibkrPositions.length} rows)`);
    }
  }

  const liveTickers = new Set(
    ibkrPositions.map((p: any) => (p.contractDesc ?? p.ticker ?? "").toUpperCase().trim()),
  );
  const workingOrders = allOrders.filter((o: any) => isWorkingStatus(o.status));

  let orphansCancelled = 0;
  let placedNew = 0;
  let qtyFixed = 0;
  let alreadyOk = 0;
  let skippedNaN = 0;
  let failed = 0;
  const details: string[] = [];

  // ── Phase B: Orphan mitigation ───────────────────────────────────────────
  // Only cancel standalone SL/TP left after a closed position — never bracket legs (BR-P-/SL/TP).
  const orphanOrders = workingOrders.filter((o: any) => isOrphanProtectiveOrder(o, liveTickers));

  for (const orphan of orphanOrders) {
    const ticker = (orphan.description1 ?? orphan.ticker ?? "?").toUpperCase();
    const orderId = orphan.orderId?.toString();
    if (!orderId) continue;
    log.warn("SL_TP_ENFORCEMENT",
      `Orphan order: ${ticker} orderId=${orderId} type=${orphan.orderType} → CANCEL`);
    const cancelResult = await cancelOrder(orderId);
    if (cancelResult.ok) {
      orphansCancelled++;
      details.push(`ORPHAN_CANCELLED:${ticker}:${orderId}`);
    } else {
      failed++;
      details.push(`ORPHAN_FAIL:${ticker}:${orderId}:${cancelResult.reason ?? "cancel_failed"}`);
      log.warn("SL_TP_ENFORCEMENT", `Orphan cancel FAILED ${ticker}/${orderId}: ${cancelResult.reason}`);
    }
    await new Promise(r => setTimeout(r, 150));
  }

  // ── Phase C: Per-position alignment ──────────────────────────────────────
  for (const pos of ibkrPositions) {
    const ticker = (pos.contractDesc ?? pos.ticker ?? "?").toUpperCase().trim();
    const units = Math.abs(pos.position ?? pos.units ?? 0);
    const isShort = (pos.position ?? 0) < 0;
    const mktPrice = pos.mktPrice ?? pos.currentPrice ?? pos.avgCost ?? pos.entryPrice ?? 0;

    if (!mktPrice || isNaN(mktPrice) || mktPrice <= 0) {
      skippedNaN++;
      details.push(`NAN_SKIP:${ticker}`);
      continue;
    }
    if (units <= 0) {
      details.push(`ZERO_UNITS_SKIP:${ticker}`);
      continue;
    }

    const dbRows = await db.select().from(livePositions)
      .where(and(
        eq(livePositions.userId, userId),
        eq(livePositions.status, "open"),
        eq(livePositions.ticker, ticker),
      )).limit(1);
    const dbRow = dbRows[0] as any;

    const slPrice = dbRow?.currentSl
      ? +Number(dbRow.currentSl).toFixed(2)
      : isShort ? +(mktPrice * 1.04).toFixed(2) : +(mktPrice * 0.96).toFixed(2);
    const tpPrice = dbRow?.currentTp
      ? +Number(dbRow.currentTp).toFixed(2)
      : isShort ? +(mktPrice * 0.92).toFixed(2) : +(mktPrice * 1.08).toFixed(2);

    const posOrders = workingOrders.filter((o: any) => {
      const t = (o.description1 ?? o.ticker ?? "").toUpperCase().trim();
      return t === ticker && isExitSide(o.side, isShort);
    });
    const existingSl = posOrders.filter((o: any) => isSlOrderType(o.orderType));
    const existingTp = posOrders.filter((o: any) => isTpOrderType(o.orderType));

    // Dedupe
    if (existingSl.length > 1) {
      for (const dup of existingSl.slice(1)) {
        if (dup.orderId && (await cancelOrder(String(dup.orderId))).ok) {
          orphansCancelled++;
        }
        await new Promise(r => setTimeout(r, 120));
      }
    }
    if (existingTp.length > 1) {
      for (const dup of existingTp.slice(1)) {
        if (dup.orderId && (await cancelOrder(String(dup.orderId))).ok) {
          orphansCancelled++;
        }
        await new Promise(r => setTimeout(r, 120));
      }
    }

    const slOrder = existingSl[0];
    const tpOrder = existingTp[0];
    const slQty = slOrder
      ? Math.abs(parseFloat(slOrder.remainingQuantity ?? slOrder.totalQuantity ?? "0"))
      : 0;
    const tpQty = tpOrder
      ? Math.abs(parseFloat(tpOrder.remainingQuantity ?? tpOrder.totalQuantity ?? "0"))
      : 0;
    const slOrdId = slOrder?.orderId?.toString();
    const tpOrdId = tpOrder?.orderId?.toString();

    const slQtyWrong = slOrder && Math.abs(slQty - units) > 0.5;
    const tpQtyWrong = tpOrder && Math.abs(tpQty - units) > 0.5;

    if (slQtyWrong && slOrdId) {
      log.info("SL_TP_ENFORCEMENT", `${ticker}: SL qty ${slQty} ≠ position ${units} → cancel & replace`);
      if ((await cancelOrder(slOrdId)).ok) qtyFixed++;
      await new Promise(r => setTimeout(r, 150));
    }
    if (tpQtyWrong && tpOrdId) {
      log.info("SL_TP_ENFORCEMENT", `${ticker}: TP qty ${tpQty} ≠ position ${units} → cancel & replace`);
      if ((await cancelOrder(tpOrdId)).ok) qtyFixed++;
      await new Promise(r => setTimeout(r, 150));
    }

    let needSl = !slOrder || slQtyWrong;
    const needTp = !tpOrder || tpQtyWrong;

    // ── OCA upgrade: if TP is missing but SL exists as a standalone order,
    // cancel the SL and re-issue both as an OCA-pair so IBKR won't reject the TP.
    if (needTp && !needSl && slOrder && slOrdId) {
      log.info("SL_TP_ENFORCEMENT", `${ticker}: TP missing with standalone SL → cancel SL ${slOrdId} and re-issue OCA-pair`);
      const cancelOk = (await cancelOrder(slOrdId)).ok;
      if (cancelOk) {
        needSl = true; // force OCA-pair path below
        qtyFixed++;
        await new Promise(r => setTimeout(r, 250));
      } else {
        log.warn("SL_TP_ENFORCEMENT", `${ticker}: failed to cancel SL ${slOrdId} for OCA upgrade`);
      }
    }

    if (!needSl && !needTp) {
      alreadyOk++;
      details.push(`OK:${ticker}`);
      continue;
    }

    if (!marketOpen) {
      details.push(`MARKET_CLOSED_SKIP:${ticker}`);
      continue;
    }

    let resolvedConid = pos.conid ?? pos._dbRow?.ibkrConid ?? null;
    if (!resolvedConid) {
      try {
        const conidRows = await db.select().from(ibkrConidCache)
          .where(eq(ibkrConidCache.symbol, ticker)).limit(1);
        resolvedConid = conidRows[0]?.conid ?? null;
      } catch { /* ignore */ }
    }

    if (!resolvedConid) {
      failed++;
      details.push(`NO_CONID:${ticker}`);
      continue;
    }

    const exitSide = isShort ? "BUY" : "SELL";

    // ── Strategy: if BOTH SL and TP are needed → use OCA-pair (single call, both
    // orders submitted atomically as an OCA group so IBKR never cancels either).
    // If only one is needed (e.g. SL exists but TP is missing) → individual call.
    if (needSl && needTp) {
      // ── OCA-pair path ──────────────────────────────────────────────────────
      const placeIndividual = async (): Promise<boolean> => {
        let slOk = false;
        let tpOk = false;
        if (needSl) {
          try {
            const slRes = await ibindRequest("POST", "/orders/stop-loss", {
              conid: resolvedConid,
              side: exitSide,
              quantity: units,
              stopPrice: slPrice,
              tif: "GTC",
              outsideRth: false,
            }, { "X-Confirm-Live-Order": "yes" });
            if (slRes.ok) {
              slOk = true;
              placedNew++;
              const slId = (slRes.body as any)?.result?.[0]?.order_id?.toString();
              if (slId && dbRow) {
                await db.update(livePositions)
                  .set({ ibkrSlOrderId: slId } as any)
                  .where(eq(livePositions.id, dbRow.id));
              }
              details.push(`SL_PLACED:${ticker}:${slId}`);
            } else {
              details.push(`SL_FAIL:${ticker}`);
            }
          } catch (e: any) {
            log.warn("SL_TP_ENFORCEMENT", `SL fallback error ${ticker}: ${e.message}`);
            details.push(`SL_FAIL:${ticker}`);
          }
          await new Promise(r => setTimeout(r, 250));
        }
        if (needTp) {
          try {
            const tpRes = await ibindRequest("POST", "/orders/take-profit", {
              conid: resolvedConid,
              side: exitSide,
              quantity: units,
              limitPrice: tpPrice,
              tif: "GTC",
              outsideRth: false,
            }, { "X-Confirm-Live-Order": "yes" });
            if (tpRes.ok) {
              tpOk = true;
              placedNew++;
              const tpId = (tpRes.body as any)?.result?.[0]?.order_id?.toString();
              if (tpId && dbRow) {
                await db.update(livePositions)
                  .set({ ibkrTpOrderId: tpId } as any)
                  .where(eq(livePositions.id, dbRow.id));
              }
              details.push(`TP_PLACED:${ticker}:${tpId}`);
            } else {
              details.push(`TP_FAIL:${ticker}`);
            }
          } catch (e: any) {
            log.warn("SL_TP_ENFORCEMENT", `TP fallback error ${ticker}: ${e.message}`);
            details.push(`TP_FAIL:${ticker}`);
          }
        }
        return slOk && tpOk;
      };

      try {
        const ocaRes = await ibindRequest("POST", "/orders/oca-pair", {
          conid: resolvedConid,
          side:  exitSide,
          quantity: units,
          tpPrice,
          slPrice,
          tif: "GTC",
        }, { "X-Confirm-Live-Order": "yes" });
        if (ocaRes.ok) {
          placedNew += 2;
          const ocaBody = ocaRes.body as any;
          // OCA-pair returns { success, result: [...] }
          const orders: any[] = ocaRes.ok ? (ocaBody?.result ?? []) : [];
          let slId: string | undefined = ocaBody?.sl_order_id?.toString();
          let tpId: string | undefined = ocaBody?.tp_order_id?.toString();
          for (const o of orders) {
            const oid = o?.order_id?.toString();
            const coid: string = o?.local_order_id ?? "";
            if (coid.startsWith("SL-") || coid.startsWith("OCA-SL")) slId = oid;
            else if (coid.startsWith("TP-") || coid.startsWith("OCA-TP")) tpId = oid;
          }
          // Fallback: assign by order position (SL first per oauth_server code)
          if (!slId && orders[0]) slId = orders[0]?.order_id?.toString();
          if (!tpId && orders[1]) tpId = orders[1]?.order_id?.toString();
          if (dbRow) {
            await db.update(livePositions)
              .set({ ibkrSlOrderId: slId ?? null, ibkrTpOrderId: tpId ?? null } as any)
              .where(eq(livePositions.id, dbRow.id));
          }
          details.push(`OCA_PLACED:${ticker}:SL=${slId}:TP=${tpId}`);
        } else {
          log.warn("SL_TP_ENFORCEMENT", `OCA-pair failed for ${ticker}, trying individual legs: ${JSON.stringify(ocaRes.body)}`);
          const ok = await placeIndividual();
          if (!ok) {
            failed++;
            details.push(`OCA_FAIL:${ticker}:${(ocaRes.body as any)?.error ?? "oca_fail"}`);
          } else {
            details.push(`INDIVIDUAL_OK:${ticker}`);
          }
        }
      } catch (e: any) {
        failed++;
        log.warn("SL_TP_ENFORCEMENT", `OCA-pair error ${ticker}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 300));

    } else {
      // ── Individual-order fallback (only one leg missing) ───────────────────
      if (needSl) {
        try {
          const slRes = await ibindRequest("POST", "/orders/stop-loss", {
            conid: resolvedConid,
            side: exitSide,
            quantity: units,
            stopPrice: slPrice,
            tif: "GTC",
            outsideRth: false,
          }, { "X-Confirm-Live-Order": "yes" });
          if (slRes.ok) {
            placedNew++;
            const slId = (slRes.body as any)?.result?.[0]?.order_id?.toString();
            if (slId && dbRow) {
              await db.update(livePositions)
                .set({ ibkrSlOrderId: slId } as any)
                .where(eq(livePositions.id, dbRow.id));
            }
            details.push(`SL_PLACED:${ticker}:${slId}`);
          } else {
            failed++;
            details.push(`SL_FAIL:${ticker}`);
          }
        } catch (e: any) {
          failed++;
          log.warn("SL_TP_ENFORCEMENT", `SL place error ${ticker}: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 200));
      }

      if (needTp) {
        try {
          const tpRes = await ibindRequest("POST", "/orders/take-profit", {
            conid: resolvedConid,
            side: exitSide,
            quantity: units,
            limitPrice: tpPrice,
            tif: "GTC",
            outsideRth: false,
          }, { "X-Confirm-Live-Order": "yes" });
          if (tpRes.ok) {
            placedNew++;
            const tpId = (tpRes.body as any)?.result?.[0]?.order_id?.toString();
            if (tpId && dbRow) {
              await db.update(livePositions)
                .set({ ibkrTpOrderId: tpId } as any)
                .where(eq(livePositions.id, dbRow.id));
            }
            details.push(`TP_PLACED:${ticker}:${tpId}`);
          } else {
            failed++;
            details.push(`TP_FAIL:${ticker}`);
          }
        } catch (e: any) {
          failed++;
          log.warn("SL_TP_ENFORCEMENT", `TP place error ${ticker}: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }

  const summary = `Cycle ended [${trigger}]. Enforced=${placedNew + qtyFixed}, Orphans=${orphansCancelled}, Failed=${failed}, OK=${alreadyOk}, NaN=${skippedNaN}`;
  log.info("SL_TP_ENFORCEMENT", summary);

  return {
    ok: failed === 0,
    message: summary,
    placed: placedNew,
    qtyFixed,
    orphansCancelled,
    alreadyOk,
    skippedNaN,
    failed,
    marketOpen,
    details,
  };
}
