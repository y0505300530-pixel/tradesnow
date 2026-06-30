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

// Step 1: CANCEL ALL working orders
console.log('=== Step 1: Cancel ALL working orders ===');
const cancelRes = await paperRequest('POST', '/api/trade/cancel-all');
console.log(`Cancel-all: ${cancelRes.status}`, JSON.stringify(cancelRes.body).slice(0, 200));

// Wait for cancellations to process
console.log('⏳ Waiting 10s for cancellations...');
await new Promise(r => setTimeout(r, 10000));

// Step 2: Verify no working orders remain
const ordersRes = await paperRequest('GET', '/orders?filter=working');
const workingOrders = ordersRes.body?.orders || ordersRes.body || [];
const workingCount = Array.isArray(workingOrders) ? workingOrders.filter(o => 
  !['cancelled','filled','inactive'].includes((o.status || '').toLowerCase())
).length : 0;
console.log(`Working orders after cancel: ${workingCount}`);

// Step 3: Place BUY orders for shorts
console.log('\n=== Step 2: Close shorts ===');
const posRes = await paperRequest('GET', '/positions');
const positions = posRes.body?.positions || posRes.body || [];
const shorts = positions.filter(p => (p.position ?? p.units ?? p.size ?? 0) < 0);

console.log(`Shorts to close: ${shorts.length}`);
for (const p of shorts) {
  const ticker = p.ticker || p.symbol || p.contractDesc || '?';
  const units = Math.abs(p.position ?? p.units ?? p.size ?? 0);
  const conid = p.conid ?? p.conId;
  const marketPrice = p.mktPrice || p.marketPrice || p.lastPrice || 0;
  const aggressivePrice = Number((marketPrice * 1.05).toFixed(2));
  
  console.log(`\n→ ${ticker}: BUY ${units} @ $${aggressivePrice} (market: $${marketPrice.toFixed(2)})`);
  
  const body = {
    conid,
    side: 'BUY',
    quantity: units,
    limitPrice: aggressivePrice,
    tif: 'GTC',
  };
  
  const res = await paperRequest('POST', '/orders/take-profit', body);
  if (res.ok) {
    const orderId = res.body?.result?.order_id || res.body?.order_id || 'unknown';
    console.log(`  ✅ ${ticker}: orderId=${orderId}`);
  } else {
    console.log(`  ❌ ${ticker}: ${res.status} — ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  await new Promise(r => setTimeout(r, 2000));
}

// Wait for fills
console.log('\n⏳ Waiting 15s for fills...');
await new Promise(r => setTimeout(r, 15000));

// Final check
console.log('\n=== Final verification ===');
const verifyRes = await paperRequest('GET', '/positions');
const verifyPos = verifyRes.body?.positions || verifyRes.body || [];
const remainingShorts = verifyPos.filter(p => (p.position ?? p.units ?? p.size ?? 0) < 0);
console.log(`Remaining shorts: ${remainingShorts.length}`);
for (const p of remainingShorts) {
  const ticker = p.ticker || p.symbol || p.contractDesc || '?';
  const units = p.position ?? p.units ?? p.size ?? 0;
  console.log(`  ⚠️ ${ticker}: ${units}`);
}
if (remainingShorts.length === 0) console.log('\n🎉 ALL SHORTS CLOSED!');
