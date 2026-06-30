/**
 * One-time script: manually trigger enforceSlTpOrders() to clean up duplicates and orphans NOW.
 * Run with: npx tsx run-sltpfix.ts
 * 
 * Since enforceSlTpOrders is not exported, we'll replicate the core cleanup logic here
 * using the same imports the engine uses.
 */
import { getDb } from "./server/db";
import { paperPositions, paperLedger } from "./drizzle/schema";
import { eq, and } from "drizzle-orm";
import { fetchPaperOrders, cancelSingleOrder } from "./server/paperIbindClient";

async function main() {
  console.log("[Manual SL/TP Cleanup] Starting...");
  
  const db = await getDb();
  if (!db) { console.error("DB not available"); process.exit(1); }

  // Get userId=1 ledger
  const ledger = await db.select().from(paperLedger).where(eq(paperLedger.userId, 1)).limit(1);
  if (!ledger.length) { console.error("No ledger found"); process.exit(1); }
  const sessionId = ledger[0].sessionId;

  // Get open positions
  const openPos = await db
    .select({ id: paperPositions.id, ticker: paperPositions.ticker, units: paperPositions.units, currentSl: paperPositions.currentSl, currentTp: paperPositions.currentTp })
    .from(paperPositions)
    .where(and(eq(paperPositions.userId, 1), eq(paperPositions.status, "open"), eq(paperPositions.sessionId, sessionId)));

  console.log(`[Manual SL/TP Cleanup] Open positions: ${openPos.length}`);
  for (const p of openPos) {
    console.log(`  ${p.ticker} — SL: ${p.currentSl ?? 'null'}, TP: ${p.currentTp ?? 'null'}`);
  }

  // Fetch orders from IBKR
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

  console.log(`[Manual SL/TP Cleanup] Orders from IBKR: total=${allOrders.length} active=${activeOrders.length}`);

  // Build map: ticker → SL/TP counts + order IDs
  const activeOrdersByTicker = new Map<string, { slCount: number; tpCount: number; slOrderIds: string[]; tpOrderIds: string[] }>();
  for (const o of activeOrders) {
    const side = String(o.side ?? "").toUpperCase();
    if (side !== "SELL") continue;
    const rawTicker = String(o.ticker ?? "").trim().toUpperCase().replace(/\s+/g, "");
    const orderType = String(o.orderType ?? "").toUpperCase();

    if (!activeOrdersByTicker.has(rawTicker)) {
      activeOrdersByTicker.set(rawTicker, { slCount: 0, tpCount: 0, slOrderIds: [], tpOrderIds: [] });
    }
    const entry = activeOrdersByTicker.get(rawTicker)!;
    if (orderType === "STP") { entry.slCount++; entry.slOrderIds.push(o.orderId); }
    if (orderType === "LMT") { entry.tpCount++; entry.tpOrderIds.push(o.orderId); }
  }

  // Print summary
  console.log(`\n[Manual SL/TP Cleanup] Orders by ticker:`);
  for (const [ticker, counts] of Array.from(activeOrdersByTicker)) {
    console.log(`  ${ticker}: ${counts.slCount} SL, ${counts.tpCount} TP`);
  }

  // Cancel DUPLICATE orders (keep first, cancel rest)
  let cancelledDupes = 0;
  for (const [ticker, counts] of Array.from(activeOrdersByTicker)) {
    if (counts.slCount > 1) {
      for (let i = 1; i < counts.slOrderIds.length; i++) {
        try {
          await cancelSingleOrder(counts.slOrderIds[i]);
          cancelledDupes++;
          console.log(`  ❌ ${ticker}: cancelled duplicate SL order ${counts.slOrderIds[i]}`);
        } catch (e: any) { console.log(`  ⚠️ ${ticker}: failed to cancel SL ${counts.slOrderIds[i]}: ${e.message}`); }
        await new Promise(r => setTimeout(r, 200));
      }
    }
    if (counts.tpCount > 1) {
      for (let i = 1; i < counts.tpOrderIds.length; i++) {
        try {
          await cancelSingleOrder(counts.tpOrderIds[i]);
          cancelledDupes++;
          console.log(`  ❌ ${ticker}: cancelled duplicate TP order ${counts.tpOrderIds[i]}`);
        } catch (e: any) { console.log(`  ⚠️ ${ticker}: failed to cancel TP ${counts.tpOrderIds[i]}: ${e.message}`); }
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }
  console.log(`\n[Manual SL/TP Cleanup] Cancelled ${cancelledDupes} duplicate orders`);

  // Cancel ORPHAN orders (no matching open position)
  const openTickers = new Set(openPos.map(p => p.ticker.toUpperCase().trim()));
  let cancelledOrphans = 0;
  for (const [ticker, counts] of Array.from(activeOrdersByTicker)) {
    if (!openTickers.has(ticker)) {
      for (const oid of [...counts.slOrderIds, ...counts.tpOrderIds]) {
        try {
          await cancelSingleOrder(oid);
          cancelledOrphans++;
          console.log(`  🗑️ ${ticker}: cancelled ORPHAN order ${oid} (no open position)`);
        } catch (e: any) { console.log(`  ⚠️ ${ticker}: failed to cancel orphan ${oid}: ${e.message}`); }
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }
  console.log(`[Manual SL/TP Cleanup] Cancelled ${cancelledOrphans} orphan orders`);

  console.log(`\n✅ DONE — Dupes cancelled: ${cancelledDupes}, Orphans cancelled: ${cancelledOrphans}`);
  process.exit(0);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
