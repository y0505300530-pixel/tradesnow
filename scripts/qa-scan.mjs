// QA Scan: Check IBKR positions and working orders
import https from 'https';

const baseUrl = process.env.PAPER_API_BASE_URL;
const secret = process.env.PAPER_IBIND_API_SECRET;

if (!baseUrl || !secret) {
  console.error('Missing PAPER_API_BASE_URL or PAPER_IBIND_API_SECRET');
  process.exit(1);
}

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const url = baseUrl + path;
    https.get(url, { headers: { 'Authorization': 'Bearer ' + secret } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('=== QA2: IBKR Broker Scan ===\n');
  
  // 1. Positions
  console.log('--- LIVE POSITIONS ---');
  const posData = await apiGet('/positions');
  const positions = (posData.positions || posData || []).filter(p => Math.abs(p.position || p.quantity || 0) > 0);
  for (const p of positions) {
    console.log(`  ${p.ticker || p.symbol}: qty=${p.position || p.quantity}, avgCost=${p.avgCost || p.avg_cost}`);
  }
  console.log(`  Total non-zero positions: ${positions.length}\n`);
  
  // 2. Working orders
  console.log('--- WORKING ORDERS ---');
  const ordData = await apiGet('/orders');
  const orders = ordData.orders || ordData || [];
  const working = orders.filter(o => {
    const s = (o.status || '').toLowerCase();
    return !s.includes('cancel') && !s.includes('reject') && !s.includes('filled') && !s.includes('inactive');
  });
  console.log(`  Total orders returned: ${orders.length}`);
  console.log(`  Truly working (not cancelled/rejected/filled): ${working.length}`);
  for (const o of working.slice(0, 10)) {
    console.log(`    ${o.ticker || o.symbol} | side=${o.side} | qty=${o.quantity || o.totalSize} | status=${o.status} | orderId=${o.orderId || o.order_id}`);
  }
  
  // 3. Check for orphan adoption risk
  console.log('\n--- ORPHAN ISOLATION CHECK ---');
  const dbTickers = ['ASTS', 'STX', 'AMZN', 'ALAB'];
  const brokerTickers = positions.map(p => (p.ticker || p.symbol || '').toUpperCase());
  const unknownPositions = brokerTickers.filter(t => !dbTickers.includes(t));
  if (unknownPositions.length > 0) {
    console.log(`  ⚠️  UNKNOWN positions in broker (not in DB): ${unknownPositions.join(', ')}`);
  } else {
    console.log(`  ✅ All broker positions match DB tickers`);
  }
  
  const unknownOrders = working.filter(o => {
    const t = (o.ticker || o.symbol || '').toUpperCase();
    return !dbTickers.includes(t);
  });
  if (unknownOrders.length > 0) {
    console.log(`  ⚠️  Working orders for UNKNOWN tickers: ${unknownOrders.map(o => o.ticker || o.symbol).join(', ')}`);
  } else {
    console.log(`  ✅ No working orders for unknown tickers`);
  }
}

main().catch(e => console.error('Error:', e.message));
