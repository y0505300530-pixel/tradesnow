// Quick scan: positions + orders (handles "query /accounts first" by retrying)
import https from 'https';

const baseUrl = process.env.PAPER_API_BASE_URL;
const secret = process.env.PAPER_IBIND_API_SECRET;

function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: { 'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json' }
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ raw: data.slice(0, 300) }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  console.log('=== CURRENT STATE ===\n');

  // Positions
  console.log('--- POSITIONS ---');
  const posData = await apiCall('GET', '/positions');
  if (posData.error) {
    console.log('  ERROR:', posData.message || posData.error);
  } else {
    const positions = (posData.positions || posData || []).filter(p => Math.abs(p.position || p.quantity || 0) > 0);
    for (const p of positions) {
      console.log(`  ${p.ticker || p.symbol}: qty=${p.position || p.quantity}, avgCost=${(p.avgCost || p.avg_cost || 0).toFixed(2)}`);
    }
    console.log(`  Total: ${positions.length} positions`);
  }

  // Orders
  console.log('\n--- ORDERS ---');
  const ordData = await apiCall('GET', '/orders');
  if (ordData.error) {
    console.log('  ERROR:', ordData.message || ordData.error);
  } else {
    const orders = ordData.orders || (Array.isArray(ordData) ? ordData : []);
    const working = orders.filter(o => {
      const s = (o.status || '').toLowerCase();
      return !s.includes('cancel') && !s.includes('reject') && !s.includes('filled') && !s.includes('inactive');
    });
    const cancelled = orders.filter(o => (o.status || '').toLowerCase().includes('cancel'));
    console.log(`  Total returned: ${orders.length}`);
    console.log(`  Working (live): ${working.length}`);
    console.log(`  Cancelled: ${cancelled.length}`);
    if (working.length > 0) {
      console.log('  Working orders:');
      for (const o of working.slice(0, 15)) {
        console.log(`    ${o.ticker || o.symbol} | ${o.side} | qty=${o.quantity || o.totalSize} | status=${o.status} | id=${o.orderId || o.order_id}`);
      }
      if (working.length > 15) console.log(`    ... and ${working.length - 15} more`);
    }
  }
}

main().catch(e => console.error('Fatal:', e.message));
