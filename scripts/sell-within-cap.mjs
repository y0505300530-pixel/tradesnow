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
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, body: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, body: text }; }
}

// Cancel all first
console.log('=== Cancel ALL ===');
await paperRequest('POST', '/api/trade/cancel-all');
await new Promise(r => setTimeout(r, 5000));

// Get fresh positions with current market prices
const posRes = await paperRequest('GET', '/positions');
const positions = posRes.body?.positions || posRes.body || [];

const KEEP = { 'FFIV': 42, 'AMZN': 66 };

console.log('\n=== Selling excess (within IBKR 2.8% cap) ===');
for (const p of positions) {
  const ticker = (p.ticker || p.symbol || p.contractDesc || '?').toUpperCase();
  const units = p.position ?? p.units ?? p.size ?? 0;
  const conid = p.conid ?? p.conId;
  const marketPrice = p.mktPrice || p.marketPrice || p.lastPrice || 0;
  
  if (units <= 0) continue;
  
  const keepQty = KEEP[ticker] || 0;
  const sellQty = units - keepQty;
  
  if (sellQty <= 0) {
    console.log(`  ${ticker}: ${units} ✅ keeping`);
    continue;
  }
  
  // IBKR Paper cap: limit price must be within ~2.8% of market
  // For SELL: use market * 0.972 (2.8% below market - aggressive enough to fill)
  const limitPrice = Number((marketPrice * 0.972).toFixed(2));
  
  console.log(`→ ${ticker}: SELL ${sellQty} @ $${limitPrice} (market: $${marketPrice.toFixed(2)}, -2.8%)`);
  
  const body = {
    conid,
    side: 'SELL',
    quantity: sellQty,
    limitPrice,
    tif: 'GTC',
  };
  
  const res = await paperRequest('POST', '/orders/take-profit', body);
  if (res.ok) {
    const orderId = res.body?.result?.order_id || res.body?.order_id || 'unknown';
    console.log(`  ✅ orderId=${orderId}`);
  } else {
    const errMsg = JSON.stringify(res.body).slice(0, 200);
    console.log(`  ❌ ${res.status} — ${errMsg}`);
    
    // If still rejected, try -1% (closer to market)
    const closerPrice = Number((marketPrice * 0.99).toFixed(2));
    console.log(`  Retrying @ $${closerPrice} (-1%)...`);
    body.limitPrice = closerPrice;
    const retry = await paperRequest('POST', '/orders/take-profit', body);
    if (retry.ok) {
      console.log(`  ✅ Retry worked: orderId=${retry.body?.result?.order_id || retry.body?.order_id}`);
    } else {
      console.log(`  ❌ Retry also failed: ${JSON.stringify(retry.body).slice(0, 150)}`);
    }
  }
  await new Promise(r => setTimeout(r, 2000));
}

// Wait
console.log('\n⏳ Waiting 20s for fills...');
await new Promise(r => setTimeout(r, 20000));

// Verify
console.log('\n=== Final positions ===');
const verifyRes = await paperRequest('GET', '/positions');
const verifyPos = verifyRes.body?.positions || verifyRes.body || [];
for (const p of verifyPos) {
  const ticker = (p.ticker || p.symbol || p.contractDesc || '?').toUpperCase();
  const units = p.position ?? p.units ?? p.size ?? 0;
  if (units !== 0) {
    const expected = KEEP[ticker] || 0;
    const status = units === expected ? '✅' : `⚠️ (expected ${expected})`;
    console.log(`  ${ticker}: ${units} ${status}`);
  }
}
