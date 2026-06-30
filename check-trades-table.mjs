import mysql from 'mysql2/promise';
const DATABASE_URL = process.env.DATABASE_URL;
const connection = await mysql.createConnection(DATABASE_URL);

const [count] = await connection.execute(`SELECT COUNT(*) as cnt FROM paperTrades`);
console.log(`Total rows in paperTrades: ${count[0].cnt}`);

const [all] = await connection.execute(`SELECT ticker, signal, units, entryPrice, exitPrice, realizedPnl, exitReason, openedAt, closedAt FROM paperTrades ORDER BY closedAt DESC LIMIT 20`);
console.log(`\nLast 20 trades in paperTrades:`);
for (const r of all) {
  console.log(`  ${new Date(r.closedAt).toISOString().slice(0,16)} | ${r.ticker.padEnd(6)} | ${r.signal?.padEnd(14)} | ${r.units}u | entry:$${Number(r.entryPrice).toFixed(2)} exit:$${Number(r.exitPrice).toFixed(2)} | P&L:$${Number(r.realizedPnl).toFixed(2)} | ${r.exitReason}`);
}

// Check earliest and latest dates
const [minMax] = await connection.execute(`SELECT MIN(closedAt) as earliest, MAX(closedAt) as latest FROM paperTrades`);
console.log(`\nDate range: ${minMax[0].earliest} → ${minMax[0].latest}`);

await connection.end();
process.exit(0);
