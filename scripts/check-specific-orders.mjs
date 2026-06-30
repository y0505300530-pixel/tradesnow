import 'dotenv/config';
import crypto from 'crypto';
const BASE_URL = process.env.PAPER_API_BASE_URL;
const BEARER = process.env.PAPER_IBIND_API_SECRET;

// Check specific order IDs from our liquidation attempt
const orderIds = ['312582439', '312582441', '312582442', '312582131'];
for (const oid of orderIds) {
  const res = await fetch(`${BASE_URL}/orders/${oid}`, {
    headers: { 'Authorization': `Bearer ${BEARER}`, 'Idempotency-Key': crypto.randomUUID() }
  });
  const data = await res.json();
  console.log(`Order ${oid}: status=${res.status}`, JSON.stringify(data).slice(0, 200));
}

// Also check: what's the total position for CRWD, DDOG, OPEN?
// The issue might be that the production engine is SELLING these tickers 
// (orphan cleanup) right after we BUY them, creating new shorts
console.log('\n--- Checking if production engine is creating new sells ---');
const ordersRes = await fetch(`${BASE_URL}/orders`, {
  headers: { 'Authorization': `Bearer ${BEARER}`, 'Idempotency-Key': crypto.randomUUID() }
});
const allOrders = await ordersRes.json();
const orders = allOrders.orders || allOrders.live_orders || allOrders || [];
const recentSells = orders.filter(o => {
  const side = (o.side || '').toUpperCase();
  const ticker = (o.ticker || o.symbol || '').toUpperCase();
  const status = (o.status || '').toLowerCase();
  return side === 'SELL' && ['CRWD','DDOG','OPEN'].includes(ticker) && status === 'filled';
}).slice(0, 10);
console.log(`Recent SELL (filled) for CRWD/DDOG/OPEN: ${recentSells.length}`);
for (const o of recentSells) {
  console.log(`  ${o.ticker} SELL qty=${o.totalSize || o.filledQuantity} status=${o.status} price=${o.price} id=${o.orderId}`);
}
