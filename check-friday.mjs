import mysql from 'mysql2/promise';

const DATABASE_URL = process.env.DATABASE_URL;
const connection = await mysql.createConnection(DATABASE_URL);

// Check column names first
const [cols] = await connection.execute(`SHOW COLUMNS FROM paperPositions`);
console.log("=== Columns ===");
console.log(cols.map(c => c.Field).join(', '));

// Check positions opened on Friday June 6
const [rows] = await connection.execute(`
  SELECT * FROM paperPositions 
  WHERE openedAt >= '2026-06-05' AND openedAt < '2026-06-07'
  ORDER BY openedAt DESC
`);
console.log("\n=== Positions opened June 5-6 (Thu-Fri): " + rows.length + " ===");
for (const r of rows) {
  console.log(`  ${r.ticker} | status=${r.status} | entry=$${r.entryPrice} | SL=$${r.currentSl} | TP=$${r.currentTp} | units=${r.units} | opened=${r.openedAt}`);
}

// Check current open positions
const [open] = await connection.execute(`
  SELECT * FROM paperPositions 
  WHERE status IN ('open', 'pending_entry', 'pending_exit', 'orphan_stuck')
  ORDER BY openedAt DESC
`);
console.log("\n=== Currently open positions: " + open.length + " ===");
for (const r of open) {
  console.log(`  ${r.ticker} | status=${r.status} | entry=$${r.entryPrice} | SL=$${r.currentSl} | TP=$${r.currentTp} | units=${r.units} | opened=${r.openedAt}`);
}

// Check paper ledger
const [ledger] = await connection.execute(`SELECT * FROM paperLedger ORDER BY id DESC LIMIT 1`);
console.log("\n=== Paper Ledger ===");
console.log(JSON.stringify(ledger[0], null, 2));

await connection.end();
process.exit(0);
