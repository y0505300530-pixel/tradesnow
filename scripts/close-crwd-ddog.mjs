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

// IBKR rejects limit prices more than ~2.8% above market.
// Use exactly +2.5% to stay under the threshold.
const targets = [
  { ticker: 'CRWD', conid: 370757467, marketPrice: 761.64, maxPrice: 783.11 },
  { ticker: 'DDOG', conid: 383858515, marketPrice: 271.64, maxPrice: 279.18 },
];

for (const t of targets) {
  // Use the max allowed price minus a small buffer
  const limitPrice = Number((t.maxPrice - 0.01).toFixed(2));
  const qty = t.ticker === 'CRWD' ? 80 : 91;
  
  console.log(`→ ${t.ticker}: BUY ${qty} @ $${limitPrice} (IBKR max: $${t.maxPrice})`);
  
  const body = {
    conid: t.conid,
    side: 'BUY',
    quantity: qty,
    limitPrice,
    tif: 'GTC',
  };
  
  const res = await paperRequest('POST', '/orders/take-profit', body);
  if (res.ok) {
    const orderId = res.body?.result?.order_id || res.body?.order_id || 'unknown';
    console.log(`  ✅ orderId=${orderId}`);
  } else {
    console.log(`  ❌ ${res.status} — ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  await new Promise(r => setTimeout(r, 2000));
}

// Wait and verify
console.log('\n⏳ Waiting 10s for fills...');
await new Promise(r => setTimeout(r, 10000));
const posRes = await paperRequest('GET', '/positions');
const positions = posRes.body?.positions || posRes.body || [];
for (const p of positions) {
  const ticker = p.ticker || p.symbol || p.contractDesc || '?';
  const units = p.position ?? p.units ?? p.size ?? 0;
  if (['CRWD','DDOG','OPEN'].includes(ticker.toUpperCase())) {
    console.log(`  ${ticker}: ${units}${units < 0 ? ' ⚠️ STILL SHORT' : ' ✅ CLOSED'}`);
  }
}
