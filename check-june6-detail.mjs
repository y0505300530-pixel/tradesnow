import mysql from 'mysql2/promise';
const DATABASE_URL = process.env.DATABASE_URL;
const connection = await mysql.createConnection(DATABASE_URL);

// Check labExecutionLogs and labDailyLogs for June 5-8
const [execLogs] = await connection.execute(`SELECT * FROM labExecutionLogs ORDER BY createdAt DESC LIMIT 20`);
console.log(`=== labExecutionLogs (last 20): ===`);
for (const r of execLogs) {
  console.log(`  ${new Date(r.createdAt).toISOString()} | ${(r.action || r.type || '').toString().slice(0,20)} | ${(r.ticker || '').toString().slice(0,8)} | ${(r.message || r.details || JSON.stringify(r)).slice(0, 120)}`);
}

const [dailyLogs] = await connection.execute(`SELECT * FROM labDailyLogs ORDER BY createdAt DESC LIMIT 10`);
console.log(`\n=== labDailyLogs (last 10): ===`);
for (const r of dailyLogs) {
  console.log(`  ${new Date(r.createdAt).toISOString()} | ${JSON.stringify(r).slice(0, 200)}`);
}

// Check if there's a paperPositions entry from June 1-4
const [olderPos] = await connection.execute(`
  SELECT ticker, status, signal, openedAt, closedAt FROM paperPositions 
  WHERE openedAt >= '2026-06-01' AND openedAt < '2026-06-05'
  ORDER BY openedAt ASC
`);
console.log(`\n=== Positions June 1-4: ${olderPos.length} ===`);
for (const r of olderPos) {
  console.log(`  ${new Date(r.openedAt).toISOString()} | ${r.ticker} | ${r.signal} | ${r.status}`);
}

// Check the IBKR connection log
const [connLog] = await connection.execute(`SELECT * FROM ibkrConnectionLog ORDER BY createdAt DESC LIMIT 20`);
console.log(`\n=== ibkrConnectionLog (last 20): ===`);
for (const r of connLog) {
  console.log(`  ${new Date(r.createdAt).toISOString()} | ${JSON.stringify(r).slice(0, 200)}`);
}

await connection.end();
process.exit(0);
