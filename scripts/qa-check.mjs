import https from 'https';

const BASE = process.env.PAPER_API_BASE_URL;
const TOKEN = process.env.PAPER_IBIND_API_SECRET;

function fetchApi(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = { headers: { 'Authorization': 'Bearer ' + TOKEN }, timeout: 15000 };
    https.get(url, opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('=== QA2: LIVE IBKR POSITIONS ===');
  const pos = await fetchApi('/positions');
  console.log('Status:', pos.status);
  const posBody = pos.body;
  let positions = [];
  if (Array.isArray(posBody)) positions = posBody;
  else if (posBody && posBody.positions) positions = posBody.positions;
  else if (posBody && posBody.data) positions = posBody.data;
  else { console.log('Raw response:', JSON.stringify(posBody).slice(0, 500)); }
  
  const nonZero = positions.filter(p => Math.abs(Number(p.position || p.qty || p.size || 0)) > 0);
  console.log(`Non-zero positions: ${nonZero.length}`);
  nonZero.forEach(p => {
    console.log(`  ${p.ticker || p.contractDesc || p.symbol} | qty=${p.position || p.qty || p.size} | avgCost=${p.avgCost || p.avg_cost} | mktValue=${p.mktValue || p.market_value}`);
  });

  console.log('\n=== QA2: LIVE IBKR ORDERS ===');
  const ord = await fetchApi('/orders');
  console.log('Status:', ord.status);
  const ordBody = ord.body;
  let orders = [];
  if (Array.isArray(ordBody)) orders = ordBody;
  else if (ordBody && ordBody.orders) orders = ordBody.orders;
  else if (ordBody && ordBody.data) orders = ordBody.data;
  else { console.log('Raw response:', JSON.stringify(ordBody).slice(0, 500)); }

  const cancelledStatuses = ['Cancelled', 'Rejected', 'Filled', 'Inactive', 'cancelled', 'rejected', 'filled'];
  const working = orders.filter(o => {
    const s = o.status || o.order_status || '';
    return !cancelledStatuses.includes(s);
  });
  console.log(`Total orders: ${orders.length}`);
  console.log(`Working orders: ${working.length}`);
  working.slice(0, 15).forEach(o => {
    console.log(`  id=${o.orderId || o.order_id} | ${o.ticker || o.symbol} | ${o.side} | status=${o.status || o.order_status} | ref=${o.orderRef || o.order_ref || 'none'}`);
  });
}

main().catch(e => console.error('ERROR:', e.message));
