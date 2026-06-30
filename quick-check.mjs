import mysql from 'mysql2/promise';
const conn = await mysql.createConnection(process.env.DATABASE_URL);
const [rows] = await conn.query("SELECT `key`, value FROM systemSettings WHERE `key` IN ('paperEngineHold', 'paperResetCooldownUntil')");
rows.forEach(r => {
  console.log(r.key + ':', r.value);
  if (r.key === 'paperResetCooldownUntil') {
    const ts = parseInt(r.value);
    console.log('  Cooldown expires:', new Date(ts).toISOString());
    console.log('  Now:', new Date().toISOString());
    console.log('  Cooldown active:', ts > Date.now());
  }
});
await conn.end();
process.exit(0);
