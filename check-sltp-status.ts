/**
 * Diagnostic script: Check SL/TP health status
 * 1. Are there positions WITHOUT SL?
 * 2. Are there positions WITHOUT TP?
 * 3. Are there SL/TP orders for tickers with NO open position?
 */
import { fetchPaperPositions, fetchPaperOrders } from "./server/paperIbindClient";

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  SL/TP HEALTH CHECK");
  console.log("═══════════════════════════════════════════════════════════\n");

  // 1. Fetch live positions from IBKR
  console.log("[1] Fetching positions from IBKR...");
  const positions = await fetchPaperPositions();
  console.log(`    Found ${positions.length} open positions:\n`);
  
  const positionTickers = new Set<string>();
  for (const p of positions) {
    const ticker = p.ticker.toUpperCase().trim();
    positionTickers.add(ticker);
    console.log(`    ${ticker.padEnd(6)} | ${p.units} units @ $${p.avgCost.toFixed(2)} | mkt: $${p.mktPrice.toFixed(2)}`);
  }

  // 2. Fetch all active orders from IBKR
  console.log("\n[2] Fetching orders from IBKR...");
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
  console.log(`    Total orders: ${allOrders.length}, Active: ${activeOrders.length}\n`);

  // 3. Build map: ticker → SL/TP orders
  const ordersByTicker = new Map<string, { slOrders: any[]; tpOrders: any[] }>();
  for (const o of activeOrders) {
    const side = String(o.side ?? "").toUpperCase();
    if (side !== "SELL") continue;
    const ticker = String(o.ticker ?? "").trim().toUpperCase().replace(/\s+/g, "");
    const orderType = String(o.orderType ?? "").toUpperCase();

    if (!ordersByTicker.has(ticker)) {
      ordersByTicker.set(ticker, { slOrders: [], tpOrders: [] });
    }
    const entry = ordersByTicker.get(ticker)!;
    if (orderType === "STP") entry.slOrders.push(o);
    if (orderType === "LMT") entry.tpOrders.push(o);
  }

  // ═══ CHECK 1: Positions without SL ═══
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  CHECK 1: Positions WITHOUT Stop Loss (SL)");
  console.log("═══════════════════════════════════════════════════════════");
  let missingSlCount = 0;
  for (const ticker of Array.from(positionTickers)) {
    const orders = ordersByTicker.get(ticker);
    if (!orders || orders.slOrders.length === 0) {
      console.log(`  ❌ ${ticker} — NO SL ORDER`);
      missingSlCount++;
    } else {
      console.log(`  ✅ ${ticker} — ${orders.slOrders.length} SL order(s) @ $${(orders.slOrders[0] as any).auxPrice ?? (orders.slOrders[0] as any).stopPrice ?? '?'}`);
    }
  }
  if (missingSlCount === 0) console.log("  ✅ ALL positions have SL!");
  else console.log(`\n  ⚠️ ${missingSlCount} position(s) MISSING SL`);

  // ═══ CHECK 2: Positions without TP ═══
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  CHECK 2: Positions WITHOUT Take Profit (TP)");
  console.log("═══════════════════════════════════════════════════════════");
  let missingTpCount = 0;
  for (const ticker of Array.from(positionTickers)) {
    const orders = ordersByTicker.get(ticker);
    if (!orders || orders.tpOrders.length === 0) {
      console.log(`  ❌ ${ticker} — NO TP ORDER`);
      missingTpCount++;
    } else {
      console.log(`  ✅ ${ticker} — ${orders.tpOrders.length} TP order(s) @ $${(orders.tpOrders[0] as any).lmtPrice ?? (orders.tpOrders[0] as any).price ?? '?'}`);
    }
  }
  if (missingTpCount === 0) console.log("  ✅ ALL positions have TP!");
  else console.log(`\n  ⚠️ ${missingTpCount} position(s) MISSING TP`);

  // ═══ CHECK 3: Orphan orders (SL/TP for tickers with no position) ═══
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  CHECK 3: ORPHAN orders (SL/TP for tickers WITHOUT position)");
  console.log("═══════════════════════════════════════════════════════════");
  let orphanCount = 0;
  for (const [ticker, orders] of Array.from(ordersByTicker)) {
    if (!positionTickers.has(ticker)) {
      const totalOrphans = orders.slOrders.length + orders.tpOrders.length;
      orphanCount += totalOrphans;
      console.log(`  🗑️ ${ticker} — ${orders.slOrders.length} SL + ${orders.tpOrders.length} TP (NO POSITION EXISTS)`);
    }
  }
  if (orphanCount === 0) console.log("  ✅ NO orphan orders found!");
  else console.log(`\n  ⚠️ ${orphanCount} orphan order(s) found`);

  // ═══ SUMMARY ═══
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Positions: ${positionTickers.size}`);
  console.log(`  Missing SL: ${missingSlCount}`);
  console.log(`  Missing TP: ${missingTpCount}`);
  console.log(`  Orphan orders: ${orphanCount}`);
  console.log(`  Status: ${missingSlCount === 0 && missingTpCount === 0 && orphanCount === 0 ? '✅ ALL CLEAN' : '⚠️ ISSUES FOUND'}`);
  console.log("═══════════════════════════════════════════════════════════");

  process.exit(0);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
