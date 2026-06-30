import 'dotenv/config';
import crypto from 'crypto';
const BASE_URL = process.env.PAPER_API_BASE_URL;
const BEARER = process.env.PAPER_IBIND_API_SECRET;

// Check recent orders to see if our BUY MKT filled
const res = await fetch(`${BASE_URL}/orders`, {
  headers: { 'Authorization': `Bearer ${BEARER}`, 'Idempotency-Key': crypto.randomUUID() }
});
const data = await res.json();
const orders = data.orders || data.live_orders || data || [];
// Filter for our recent BUY orders
const recentBuys = orders.filter(o => {
  const side = (o.side || '').toUpperCase();
  const ticker = (o.ticker || o.symbol || '').toUpperCase();
  return side === 'BUY' && ['CRWD','DDOG','OPEN','MRVL','TMC','SOXX'].includes(ticker);
}).slice(0, 20);

console.log(`Recent BUY orders for target tickers: ${recentBuys.length}`);
for (const o of recentBuys) {
  console.log(`  ${o.ticker || o.symbol} | side=${o.side} | type=${o.orderType} | qty=${o.totalSize || o.quantity || o.remainingQuantity} | status=${o.status} | price=${o.price || o.auxPrice || 'MKT'} | id=${o.orderId || o.order_id}`);
}
