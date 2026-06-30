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

// The /orders/market endpoint uses aggressive LMT (not true MKT).
// For shorts that are stuck, we need to use a much higher limit price.
// Let's try /orders/close-position which should close the entire position at market.

const posRes = await paperRequest('GET', '/positions');
const positions = posRes.body?.positions || posRes.body || [];
const shorts = positions.filter(p => (p.position ?? p.units ?? p.size ?? 0) < 0);

console.log(`Shorts to close: ${shorts.length}`);
for (const p of shorts) {
  const ticker = p.ticker || p.symbol || p.contractDesc || '?';
  const units = Math.abs(p.position ?? p.units ?? p.size ?? 0);
  const conid = p.conid ?? p.conId;
  
  console.log(`\n→ ${ticker}: closing ${units} short units (conid=${conid})...`);
  
  // Try close-position endpoint first
  let res = await paperRequest('POST', '/orders/close-position', {
    conid,
    ticker,
  });
  console.log(`  close-position: ${res.status}`, JSON.stringify(res.body).slice(0, 200));
  
  if (!res.ok || res.status === 404) {
    // Fallback: use /orders/take-profit with a very high limit price (for BUY side)
    // This is essentially a BUY at a price way above market to guarantee fill
    const marketPrice = p.mktPrice || p.marketPrice || p.lastPrice || 0;
    const aggressivePrice = marketPrice > 0 ? Math.ceil(marketPrice * 1.05) : undefined;
    
    console.log(`  Trying aggressive BUY LMT at $${aggressivePrice} (market: $${marketPrice})...`);
    res = await paperRequest('POST', '/orders/take-profit', {
      conid,
      side: 'BUY',
      quantity: units,
      price: aggressivePrice,
      tif: 'DAY',
    });
    console.log(`  take-profit: ${res.status}`, JSON.stringify(res.body).slice(0, 200));
  }
  
  await new Promise(r => setTimeout(r, 2000));
}

// Wait and verify
await new Promise(r => setTimeout(r, 10000));
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
