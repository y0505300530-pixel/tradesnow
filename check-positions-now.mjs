import mysql from 'mysql2/promise';
const DATABASE_URL = process.env.DATABASE_URL;
const connection = await mysql.createConnection(DATABASE_URL);

const [positions] = await connection.execute(`SELECT * FROM paperPositions WHERE status IN ('open', 'pending_entry', 'pending_exit') ORDER BY openedAt DESC`);
console.log(`\n=== OPEN POSITIONS (${positions.length}) ===\n`);
for (const p of positions) {
  const ticker = p.ticker || '?';
  const status = p.status || '?';
  const signal = p.signal || 'N/A';
  const units = p.units || 0;
  const entry = Number(p.entry_price || p.entryPrice || 0).toFixed(2);
  const sl = Number(p.sl || p.stop_loss || p.initialSl || 0).toFixed(2);
  const tp = Number(p.tp || p.take_profit || p.initialTp || 0).toFixed(2);
  const opened = p.openedAt ? new Date(p.openedAt).toISOString().slice(0,16) : '?';
  console.log(`  ${ticker.padEnd(6)} | ${status.padEnd(13)} | ${signal.padEnd(14)} | ${units}u @ $${entry} | SL: $${sl} | TP: $${tp} | opened: ${opened}`);
}

console.log(`\n=== COLUMNS: ===`);
if (positions.length > 0) console.log(Object.keys(positions[0]).join(', '));

await connection.end();
process.exit(0);
