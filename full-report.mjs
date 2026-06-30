import mysql from 'mysql2/promise';

const DATABASE_URL = process.env.DATABASE_URL;
const connection = await mysql.createConnection(DATABASE_URL);

// Get column names
const [cols] = await connection.execute(`SHOW COLUMNS FROM paperPositions`);
console.log("Columns:", cols.map(c => c.Field).join(', '));

// All positions from last 7 days
const [all] = await connection.execute(`
  SELECT * FROM paperPositions 
  WHERE openedAt >= DATE_SUB(NOW(), INTERVAL 7 DAY)
  ORDER BY openedAt ASC
`);
console.log(`\n=== ALL POSITIONS LAST 7 DAYS: ${all.length} total ===`);

// Summary stats
let totalTrades = 0, wins = 0, losses = 0, totalPnl = 0;
let openCount = 0, closedCount = 0;
const byDay = {};
const byTicker = {};

for (const r of all) {
  const day = r.openedAt ? new Date(r.openedAt).toISOString().slice(0, 10) : 'unknown';
  if (!byDay[day]) byDay[day] = { trades: 0, pnl: 0, wins: 0, losses: 0 };
  byDay[day].trades++;
  
  if (!byTicker[r.ticker]) byTicker[r.ticker] = { trades: 0, pnl: 0, wins: 0, losses: 0, totalUnits: 0, totalAllocated: 0 };
  byTicker[r.ticker].trades++;
  byTicker[r.ticker].totalUnits += r.units || 0;
  byTicker[r.ticker].totalAllocated += Number(r.allocatedCapital) || 0;
  
  if (r.status === 'closed') {
    closedCount++;
    const pnl = Number(r.pnlDollar) || 0;
    totalPnl += pnl;
    byDay[day].pnl += pnl;
    byTicker[r.ticker].pnl += pnl;
    if (pnl > 0) { wins++; byDay[day].wins++; byTicker[r.ticker].wins++; }
    else { losses++; byDay[day].losses++; byTicker[r.ticker].losses++; }
  } else {
    openCount++;
  }
  totalTrades++;
}

console.log(`\n--- SUMMARY ---`);
console.log(`Total trades: ${totalTrades}`);
console.log(`Closed: ${closedCount} | Still Open: ${openCount}`);
console.log(`Wins: ${wins} | Losses: ${losses} | Win Rate: ${closedCount > 0 ? ((wins/closedCount)*100).toFixed(1) : 0}%`);
console.log(`Total P&L: $${totalPnl.toFixed(2)}`);

console.log(`\n--- BY DAY ---`);
for (const [day, d] of Object.entries(byDay).sort()) {
  console.log(`  ${day}: ${d.trades} trades | P&L: $${d.pnl.toFixed(2)} | W:${d.wins} L:${d.losses}`);
}

console.log(`\n--- BY TICKER ---`);
for (const [ticker, t] of Object.entries(byTicker).sort((a,b) => b[1].pnl - a[1].pnl)) {
  console.log(`  ${ticker}: ${t.trades} trades | P&L: $${t.pnl.toFixed(2)} | W:${t.wins} L:${t.losses} | Allocated: $${t.totalAllocated.toFixed(0)}`);
}

// Show all individual trades
console.log(`\n--- ALL TRADES (chronological) ---`);
for (const r of all) {
  const opened = r.openedAt ? new Date(r.openedAt).toISOString().slice(0, 16) : '?';
  const pnl = r.pnlDollar != null ? `$${Number(r.pnlDollar).toFixed(2)}` : 'n/a';
  const exit = r.exitReason || r.status;
  const entry = Number(r.entryPrice).toFixed(2);
  const sl = Number(r.currentSl).toFixed(2);
  const tp = Number(r.currentTp).toFixed(2);
  console.log(`  ${opened} | ${r.ticker.padEnd(6)} | ${(r.signal || 'n/a').padEnd(14)} | ${r.units}u @ $${entry} | SL:$${sl} TP:$${tp} | P&L: ${pnl} | ${exit} | hold: ${r.holdMinutes || 0}min`);
}

await connection.end();
process.exit(0);
