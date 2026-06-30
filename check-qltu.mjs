import { createConnection } from 'mysql2/promise';

const url = process.env.DATABASE_URL;
if (!url) { console.error('No DATABASE_URL'); process.exit(1); }

const conn = await createConnection(url);

console.log('\n=== QLTU.TA Positions ===');
const [positions] = await conn.execute(
  "SELECT * FROM paper_positions WHERE ticker = 'QLTU.TA' ORDER BY created_at DESC LIMIT 5"
);
console.table(positions);

console.log('\n=== QLTU.TA Orders ===');
const [orders] = await conn.execute(
  "SELECT * FROM paper_orders WHERE ticker = 'QLTU.TA' ORDER BY created_at DESC LIMIT 10"
);
console.table(orders);

console.log('\n=== QLTU.TA Trades ===');
const [trades] = await conn.execute(
  "SELECT * FROM paper_trades WHERE ticker = 'QLTU.TA' ORDER BY created_at DESC LIMIT 5"
);
console.table(trades);

await conn.end();
