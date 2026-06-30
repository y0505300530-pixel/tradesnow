/**
 * Fix script: Send missing SL/TP orders and cancel orphans.
 * 
 * Based on diagnostic results:
 * - Missing SL: HLT, SPG, LLY, TSLA, HAL, XOM (6)
 * - Missing TP: HLT, SPG, LLY, TSLA, HAL, XOM, AAPL (7)
 * - Orphans: CF (1 SL + 1 TP), NSC (1 SL + 1 TP)
 * 
 * Uses DB currentSl/currentTp values for the orders.
 */
import { getDb } from "./server/db";
import { paperPositions, paperLedger } from "./drizzle/schema";
import { eq, and } from "drizzle-orm";
import { fetchPaperPositions, fetchPaperOrders, paperIbindRequest, cancelSingleOrder } from "./server/paperIbindClient";
import { resolveConid } from "./server/paperOrderExecutor";

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  FIX SL/TP — Send missing orders + Cancel orphans");
  console.log("═══════════════════════════════════════════════════════════\n");

  const db = await getDb();
  if (!db) { console.error("DB not available"); process.exit(1); }

  // Get ledger
  const ledger = await db.select().from(paperLedger).where(eq(paperLedger.userId, 1)).limit(1);
  if (!ledger.length) { console.error("No ledger found"); process.exit(1); }
  const sessionId = ledger[0].sessionId;

  // Get DB positions (for SL/TP values)
  const dbPositions = await db
    .select()
    .from(paperPositions)
    .where(and(eq(paperPositions.userId, 1), eq(paperPositions.status, "open"), eq(paperPositions.sessionId, sessionId)));

  console.log(`[DB] Open positions in DB: ${dbPositions.length}`);
  const dbByTicker = new Map(dbPositions.map((p: any) => [p.ticker.toUpperCase().trim(), p]));

  // Get IBKR positions
  const ibkrPositions = await fetchPaperPositions();
  console.log(`[IBKR] Open positions: ${ibkrPositions.length}`);
  const positionTickers = new Set(ibkrPositions.map(p => p.ticker.toUpperCase().trim()));

  // Get active orders
  let allOrders = await fetchPaperOrders("working");
  let activeOrders = allOrders.filter(o => {
    const s = (o.status ?? "").toLowerCase();
    return !s.includes("fill") && !s.includes("cancel");
  });
  if (allOrders.length === 0) {
    allOrders = await fetchPaperOrders();
    activeOrders = allOrders.filter(o => {
      const s = (o.status ?? "").toLowerCase();
      return !s.includes("fill") && !s.includes("cancel");
    });
  }

  // Build order map
  const ordersByTicker = new Map<string, { slOrderIds: string[]; tpOrderIds: string[] }>();
  for (const o of activeOrders) {
    const side = String(o.side ?? "").toUpperCase();
    if (side !== "SELL") continue;
    const ticker = String(o.ticker ?? "").trim().toUpperCase().replace(/\s+/g, "");
    const orderType = String(o.orderType ?? "").toUpperCase();
    if (!ordersByTicker.has(ticker)) ordersByTicker.set(ticker, { slOrderIds: [], tpOrderIds: [] });
    const entry = ordersByTicker.get(ticker)!;
    if (orderType === "STP") entry.slOrderIds.push(o.orderId);
    if (orderType === "LMT") entry.tpOrderIds.push(o.orderId);
  }

  // ═══ STEP 1: Send missing SL/TP ═══
  console.log("\n[STEP 1] Sending missing SL/TP orders...\n");
  let sentSl = 0, sentTp = 0, failedSl = 0, failedTp = 0;

  for (const ibkrPos of ibkrPositions) {
    const ticker = ibkrPos.ticker.toUpperCase().trim();
    const orders = ordersByTicker.get(ticker) ?? { slOrderIds: [], tpOrderIds: [] };
    const hasSl = orders.slOrderIds.length >= 1;
    const hasTp = orders.tpOrderIds.length >= 1;

    if (hasSl && hasTp) continue; // All good

    // Get SL/TP values from DB, or calculate defaults
    const dbPos = dbByTicker.get(ticker);
    let slPrice: number;
    let tpPrice: number;

    if (dbPos && dbPos.currentSl > 0) {
      slPrice = dbPos.currentSl;
    } else {
      // Default: 3% below entry (avgCost)
      slPrice = +(ibkrPos.avgCost * 0.97).toFixed(2);
    }

    if (dbPos && dbPos.currentTp > 0) {
      tpPrice = dbPos.currentTp;
    } else {
      // Default: R:R 2.5 based on SL distance
      const risk = ibkrPos.avgCost - slPrice;
      tpPrice = +(ibkrPos.avgCost + risk * 2.5).toFixed(2);
    }

    const qty = Math.abs(ibkrPos.units);

    // Resolve conid
    const conid = await resolveConid(ticker);
    if (!conid) {
      console.log(`  ⚠️ ${ticker}: cannot resolve conid — SKIPPING`);
      continue;
    }

    // Send SL if missing
    if (!hasSl) {
      try {
        const slBody = { conid, side: "SELL", quantity: qty, stopPrice: +slPrice.toFixed(2), tif: "GTC" };
        const res = await paperIbindRequest("POST", "/orders/stop-loss", slBody);
        if (res.ok) {
          console.log(`  ✅ ${ticker}: SL SENT @ $${slPrice.toFixed(2)} qty=${qty}`);
          sentSl++;
        } else {
          const resp = res.body as any;
          const errMsg = resp?.message ?? resp?.error ?? `HTTP ${res.status}`;
          console.log(`  ❌ ${ticker}: SL FAILED — ${errMsg}`);
          failedSl++;
        }
      } catch (err: any) {
        console.log(`  ❌ ${ticker}: SL EXCEPTION — ${err.message}`);
        failedSl++;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    // Send TP if missing
    if (!hasTp) {
      try {
        const tpBody = { conid, side: "SELL", quantity: qty, limitPrice: +tpPrice.toFixed(2), tif: "GTC" };
        const res = await paperIbindRequest("POST", "/orders/take-profit", tpBody);
        if (res.ok) {
          console.log(`  ✅ ${ticker}: TP SENT @ $${tpPrice.toFixed(2)} qty=${qty}`);
          sentTp++;
        } else {
          const resp = res.body as any;
          const errMsg = resp?.message ?? resp?.error ?? `HTTP ${res.status}`;
          console.log(`  ❌ ${ticker}: TP FAILED — ${errMsg}`);
          failedTp++;
        }
      } catch (err: any) {
        console.log(`  ❌ ${ticker}: TP EXCEPTION — ${err.message}`);
        failedTp++;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // ═══ STEP 2: Cancel orphan orders ═══
  console.log("\n[STEP 2] Cancelling orphan orders...\n");
  let cancelledOrphans = 0;

  for (const [ticker, orders] of Array.from(ordersByTicker)) {
    if (!positionTickers.has(ticker)) {
      for (const oid of [...orders.slOrderIds, ...orders.tpOrderIds]) {
        try {
          await cancelSingleOrder(oid);
          cancelledOrphans++;
          console.log(`  🗑️ ${ticker}: cancelled orphan order ${oid}`);
        } catch (e: any) {
          console.log(`  ⚠️ ${ticker}: failed to cancel ${oid} — ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  // ═══ SUMMARY ═══
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  SL sent: ${sentSl} (failed: ${failedSl})`);
  console.log(`  TP sent: ${sentTp} (failed: ${failedTp})`);
  console.log(`  Orphans cancelled: ${cancelledOrphans}`);
  console.log("═══════════════════════════════════════════════════════════");

  process.exit(0);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
