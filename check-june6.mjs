import mysql from 'mysql2/promise';
const DATABASE_URL = process.env.DATABASE_URL;
const connection = await mysql.createConnection(DATABASE_URL);

// Full systemLogs for June 6
const [logs] = await connection.execute(`SELECT * FROM systemLogs WHERE createdAt >= '2026-06-06' AND createdAt < '2026-06-07' ORDER BY createdAt ASC`);
console.log(`=== systemLogs June 6: ${logs.length} entries ===`);
for (const r of logs) {
  console.log(`  ${new Date(r.createdAt).toISOString()} | ${r.level} | ${r.source || 'SYSTEM'} | ${(r.message || '').slice(0, 150)}`);
}

// Check ALL server start events across all days
const [allStarts] = await connection.execute(`SELECT * FROM systemLogs WHERE message LIKE '%Server started%' ORDER BY createdAt DESC LIMIT 30`);
console.log(`\n=== ALL SERVER STARTS ===`);
for (const r of allStarts) {
  console.log(`  ${new Date(r.createdAt).toISOString()} | ${(r.message || '').slice(0, 100)}`);
}

// Check ALL SIGTERM events
const [sigterms] = await connection.execute(`SELECT * FROM systemLogs WHERE message LIKE '%SIGTERM%' ORDER BY createdAt DESC LIMIT 30`);
console.log(`\n=== ALL SIGTERM EVENTS ===`);
for (const r of sigterms) {
  console.log(`  ${new Date(r.createdAt).toISOString()} | ${(r.message || '').slice(0, 100)}`);
}

// Check June 6 during US market hours (13:30-20:00 UTC)
const [marketHours] = await connection.execute(`
  SELECT * FROM systemLogs 
  WHERE createdAt >= '2026-06-06 13:30:00' AND createdAt < '2026-06-06 20:00:00' 
  ORDER BY createdAt ASC
`);
console.log(`\n=== June 6 during US Market Hours (13:30-20:00 UTC): ${marketHours.length} entries ===`);
for (const r of marketHours) {
  console.log(`  ${new Date(r.createdAt).toISOString()} | ${r.level} | ${(r.message || '').slice(0, 150)}`);
}

await connection.end();
process.exit(0);
