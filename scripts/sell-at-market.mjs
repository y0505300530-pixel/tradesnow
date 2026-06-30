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

// Step 1: Cancel ALL orders first to clear the queue
console.log('=== Cancel ALL orders ===');
const cancelRes = await paperRequest('POST', '/api/trade/cancel-all');
console.log(`Cancel: ${cancelRes.status} — cancelled: ${cancelRes.body?.total || 0}`);
await new Promise(r => setTimeout(r, 5000));

// Step 2: Get positions
const posRes = await paperRequest('GET', '/positions');
const positions = posRes.body?.positions || posRes.body || [];

// KEEP only: FFIV (42) and AMZN (66) - legitimate trades
const KEEP = { 'FFIV': 42, 'AMZN': 66 };

console.log('\n=== Selling excess at MARKET ===');
for (const p of positions) {
  const ticker = (p.ticker || p.symbol || p.contractDesc || '?').toUpperCase();
  const units = p.position ?? p.units ?? p.size ?? 0;
  const conid = p.conid ?? p.conId;
  
  if (units <= 0) continue;
  
  const keepQty = KEEP[ticker] || 0;
  const sellQty = units - keepQty;
  
  if (sellQty <= 0) {
    console.log(`  ${ticker}: ${units} ✅ keeping`);
    continue;
  }
  
  console.log(`→ ${ticker}: SELL ${sellQty} at MARKET (have ${units}, keep ${keepQty})`);
  
  // Use /orders/market endpoint
  const body = { conid, side: 'SELL', quantity: sellQty };
  const res = await paperRequest('POST', '/orders/market', body);
  if (res.ok) {
    const orderId = res.body?.result?.order_id || res.body?.order_id || 'unknown';
    console.log(`  ✅ orderId=${orderId}`);
  } else {
    console.log(`  ❌ ${res.status} — ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  await new Promise(r => setTimeout(r, 1500));
}

// Wait for fills
console.log('\n⏳ Waiting 20s for fills...');
await new Promise(r => setTimeout(r, 20000));

// Final check
console.log('\n=== Final positions ===');
const verifyRes = await paperRequest('GET', '/positions');
const verifyPos = verifyRes.body?.positions || verifyRes.body || [];
let clean = true;
for (const p of verifyPos) {
  const ticker = (p.ticker || p.symbol || p.contractDesc || '?').toUpperCase();
  const units = p.position ?? p.units ?? p.size ?? 0;
  if (units !== 0) {
    const expected = KEEP[ticker] || 0;
    if (units === expected) {
      console.log(`  ${ticker}: ${units} ✅`);
    } else {
      console.log(`  ${ticker}: ${units} ⚠️ (expected ${expected})`);
      clean = false;
    }
  }
}
if (clean) console.log('\n🎉 PORTFOLIO CLEAN!');
else console.log('\n⚠️ Some positions still need attention');
