import { createConnection } from 'mysql2/promise';
import { readFileSync } from 'fs';

const envContent = readFileSync('/home/ubuntu/trading-youtube-analyzer/.env', 'utf8');
const dbLine = envContent.split('\n').find(l => l.startsWith('DATABASE_URL='));
const connStr = dbLine.replace('DATABASE_URL=', '').replace(/["']/g, '');
const parsed = new URL(connStr);

const conn = await createConnection({
  host: parsed.hostname,
  port: parseInt(parsed.port),
  user: parsed.username,
  password: decodeURIComponent(parsed.password),
  database: parsed.pathname.slice(1).split('?')[0],
  ssl: { rejectUnauthorized: true }
});

const [rows] = await conn.execute('SELECT ticker, exitReason, closedAt FROM paperTrades WHERE sessionId = 54 ORDER BY closedAt DESC LIMIT 15');
console.table(rows.map(r => ({
  ticker: r.ticker,
  exitReason: r.exitReason,
  closedAt: new Date(Number(r.closedAt)).toISOString()
})));

// Also check if there are any "Reset" trades (from fullReset)
const [resetRows] = await conn.execute("SELECT ticker, exitReason, closedAt FROM paperTrades WHERE sessionId = 54 AND exitReason IN ('Reset', 'Liquidate-All') ORDER BY closedAt DESC LIMIT 20");
console.log('\n--- Reset/Liquidate-All trades ---');
console.table(resetRows.map(r => ({
  ticker: r.ticker,
  exitReason: r.exitReason,
  closedAt: new Date(Number(r.closedAt)).toISOString()
})));

// Check positions that were closed recently
const [closedPos] = await conn.execute("SELECT ticker, status, closedAt, units FROM paperPositions WHERE sessionId = 54 AND status = 'closed' ORDER BY closedAt DESC LIMIT 20");
console.log('\n--- Recently closed positions ---');
console.table(closedPos.map(r => ({
  ticker: r.ticker,
  status: r.status,
  units: r.units,
  closedAt: r.closedAt ? new Date(Number(r.closedAt)).toISOString() : 'null'
})));

await conn.end();
