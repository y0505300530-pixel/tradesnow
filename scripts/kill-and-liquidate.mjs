import 'dotenv/config';
import crypto from 'crypto';
const BASE_URL = process.env.PAPER_API_BASE_URL;
const BEARER = process.env.PAPER_IBIND_API_SECRET;

async function paperRequest(method, path, body) {
  const url = `${BASE_URL}${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${BEARER}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
      'X-Confirm-Live-Order': 'yes',
      'X-Confirm-Kill': 'yes',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, body: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, body: text }; }
}

// Step 1: Call the KILL SWITCH on production to stop the engine
console.log('=== Calling Kill Switch on production ===');
// The kill switch is a tRPC endpoint, we can't call it directly without auth.
// Instead, let's just place the BUY MKT orders. The issue is that the engine 
// is running OrphanCleanup which sees these positions as "not in DB" and sells them.
// But we already closed them in DB! So the engine should NOT be selling them anymore.
// Let me check what's actually happening...

// The real issue: our BUY MKT orders DID fill (the first batch showed as Filled).
// But the production engine's OrphanCleanup is creating NEW sell orders for these tickers
// because it sees them in IBKR but not in DB (we closed them in DB).
// This creates a race condition: we buy → engine sells → net position stays short.

// Solution: We need to add these tickers to the DB as "open" positions so the engine 
// doesn't treat them as orphans. OR we need to stop the engine.

// Let's check: the engine skips CRWD and OPEN with "cooldown/max attempts reached"
// So it's NOT selling them. The issue must be something else.

// Let me just verify the current state
const posRes = await paperRequest('GET', '/positions');
const positions = posRes.body?.positions || posRes.body || [];
console.log('\nCurrent IBKR positions:');
for (const p of positions) {
  const ticker = p.ticker || p.symbol || p.contractDesc || '?';
  const units = p.position ?? p.units ?? p.size ?? 0;
  if (units !== 0) console.log(`  ${ticker}: ${units}${units < 0 ? ' ⚠️ SHORT' : ''}`);
}

// Check working orders for these tickers
const ordersRes = await paperRequest('GET', '/orders?filter=working');
const orders = ordersRes.body?.orders || ordersRes.body?.live_orders || ordersRes.body || [];
const targetOrders = Array.isArray(orders) ? orders.filter(o => {
  const ticker = (o.ticker || o.symbol || '').toUpperCase();
  return ['CRWD','DDOG','OPEN','MRVL'].includes(ticker);
}) : [];
console.log(`\nWorking orders for CRWD/DDOG/OPEN/MRVL: ${targetOrders.length}`);
for (const o of targetOrders) {
  console.log(`  ${o.ticker} ${o.side} ${o.orderType} qty=${o.totalSize || o.remainingQuantity} status=${o.status} price=${o.price}`);
}
