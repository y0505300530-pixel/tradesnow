import mysql from 'mysql2/promise';

const DATABASE_URL = process.env.DATABASE_URL;
const connection = await mysql.createConnection(DATABASE_URL);

// Close TSLA, AMZN, OPEN (keep CRWV)
const [result] = await connection.execute(`
  UPDATE paperPositions 
  SET status = 'closed', closedAt = NOW()
  WHERE status IN ('open', 'orphan_stuck') 
  AND ticker IN ('TSLA', 'AMZN', 'OPEN')
`);
console.log(`Closed ${result.affectedRows} positions (TSLA, AMZN, OPEN)`);

// Verify remaining open
const [open] = await connection.execute(`
  SELECT ticker, status, units, entryPrice FROM paperPositions 
  WHERE status IN ('open', 'pending_entry', 'pending_exit', 'orphan_stuck')
`);
console.log(`\nRemaining open positions: ${open.length}`);
for (const r of open) {
  console.log(`  ${r.ticker} | status=${r.status} | units=${r.units} | entry=$${r.entryPrice}`);
}

await connection.end();
process.exit(0);
