import mysql from 'mysql2/promise';
const conn = await mysql.createConnection(process.env.DATABASE_URL);

const [positions] = await conn.query("SELECT COUNT(*) as cnt FROM paperPositions WHERE status = 'open'");
console.log("Open positions:", positions[0].cnt);

const [allPos] = await conn.query("SELECT COUNT(*) as cnt FROM paperPositions");
console.log("All positions (any status):", allPos[0].cnt);

const [trades] = await conn.query("SELECT COUNT(*) as cnt FROM paperTrades");
console.log("Paper trades:", trades[0].cnt);

const [ledger] = await conn.query("SELECT COUNT(*) as cnt FROM paperLedger");
console.log("Paper ledger entries:", ledger[0].cnt);

const [equity] = await conn.query("SELECT COUNT(*) as cnt FROM paperEquitySnapshots");
console.log("Equity snapshots:", equity[0].cnt);

const [settings] = await conn.query("SELECT `key`, value FROM systemSettings WHERE `key` IN ('paperEngineHold', 'paperResetCooldownUntil', 'paperCircuitBreakerNlv')");
console.log("\nSystem settings:");
settings.forEach(s => console.log(`  ${s.key}: ${s.value}`));

await conn.end();
