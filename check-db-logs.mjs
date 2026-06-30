import mysql from 'mysql2/promise';
const DATABASE_URL = process.env.DATABASE_URL;
const connection = await mysql.createConnection(DATABASE_URL);

// Check if there's a persistent log table
const [tables] = await connection.execute(`SHOW TABLES LIKE '%log%'`);
console.log("Log tables:", tables.map(t => Object.values(t)[0]).join(', '));

// Check for June 6 activity in persistent logs
for (const t of tables) {
  const tableName = Object.values(t)[0];
  const [count] = await connection.execute(`SELECT COUNT(*) as cnt FROM \`${tableName}\` WHERE createdAt >= '2026-06-06' AND createdAt < '2026-06-07'`);
  console.log(`\n${tableName} on June 6: ${count[0].cnt} entries`);
  if (count[0].cnt > 0) {
    const [rows] = await connection.execute(`SELECT * FROM \`${tableName}\` WHERE createdAt >= '2026-06-06' AND createdAt < '2026-06-07' ORDER BY createdAt ASC LIMIT 10`);
    for (const r of rows) {
      console.log(`  ${r.createdAt} | ${r.level || ''} | ${r.source || ''} | ${(r.message || '').slice(0, 100)}`);
    }
  }
}

// Also check server start/stop events
const [starts] = await connection.execute(`SELECT * FROM persistentLogs WHERE message LIKE '%Server started%' OR message LIKE '%Server running%' OR message LIKE '%SIGTERM%' ORDER BY createdAt DESC LIMIT 20`);
console.log("\n=== SERVER START/STOP EVENTS ===");
for (const r of starts) {
  console.log(`  ${r.createdAt} | ${r.message.slice(0, 120)}`);
}

await connection.end();
process.exit(0);
