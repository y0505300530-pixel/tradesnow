import mysql from 'mysql2/promise';
const DATABASE_URL = process.env.DATABASE_URL;
const connection = await mysql.createConnection(DATABASE_URL);

// Check paperTrades table creation time / earliest data
const [allTrades] = await connection.execute(`SELECT MIN(openedAt) as earliest, MAX(openedAt) as latest, COUNT(*) as cnt FROM paperTrades`);
console.log(`paperTrades: ${allTrades[0].cnt} rows | earliest: ${allTrades[0].earliest} | latest: ${allTrades[0].latest}`);

// Check paperPositions for older data
const [allPos] = await connection.execute(`SELECT MIN(openedAt) as earliest, MAX(openedAt) as latest, COUNT(*) as cnt FROM paperPositions`);
console.log(`paperPositions: ${allPos[0].cnt} rows | earliest: ${allPos[0].earliest} | latest: ${allPos[0].latest}`);

// Check if there are May positions
const [mayPos] = await connection.execute(`SELECT COUNT(*) as cnt FROM paperPositions WHERE openedAt >= '2026-05-01' AND openedAt < '2026-06-01'`);
console.log(`\npaperPositions in May: ${mayPos[0].cnt}`);

const [mayTrades] = await connection.execute(`SELECT COUNT(*) as cnt FROM paperTrades WHERE openedAt >= '2026-05-01' AND openedAt < '2026-06-01'`);
console.log(`paperTrades in May: ${mayTrades[0].cnt}`);

// Check if the table was recently created (schema info)
const [tableInfo] = await connection.execute(`SELECT TABLE_NAME, CREATE_TIME, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('paperTrades', 'paperPositions', 'paperLedger')`);
console.log(`\n=== TABLE CREATION TIMES ===`);
for (const t of tableInfo) {
  console.log(`  ${t.TABLE_NAME}: created ${t.CREATE_TIME} | rows: ${t.TABLE_ROWS}`);
}

// Check paperLedger for history
const [ledger] = await connection.execute(`SELECT MIN(createdAt) as earliest, MAX(createdAt) as latest, COUNT(*) as cnt FROM paperLedger`);
console.log(`\npaperLedger: ${ledger[0].cnt} rows | earliest: ${ledger[0].earliest} | latest: ${ledger[0].latest}`);

// Check if there's an older positions table or archive
const [allTables] = await connection.execute(`SHOW TABLES LIKE '%paper%'`);
console.log(`\n=== All paper-related tables ===`);
for (const t of allTables) {
  console.log(`  ${Object.values(t)[0]}`);
}

// Check May positions detail
const [mayDetail] = await connection.execute(`SELECT ticker, status, signal, openedAt, closedAt FROM paperPositions WHERE openedAt >= '2026-05-01' AND openedAt < '2026-06-01' ORDER BY openedAt ASC LIMIT 10`);
console.log(`\n=== May positions (first 10): ===`);
for (const r of mayDetail) {
  console.log(`  ${r.openedAt ? new Date(r.openedAt).toISOString().slice(0,16) : '?'} | ${r.ticker} | ${r.signal} | ${r.status} | closed: ${r.closedAt ? new Date(r.closedAt).toISOString().slice(0,16) : 'still open'}`);
}

await connection.end();
process.exit(0);
