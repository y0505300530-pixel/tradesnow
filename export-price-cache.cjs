const mysql = require('mysql2/promise');
const fs = require('fs');

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

async function main() {
  const conn = await mysql.createConnection({
    uri: dbUrl,
    ssl: { rejectUnauthorized: true }
  });
  
  console.log('Querying priceCache (319,617 rows)...');
  const [rows] = await conn.execute('SELECT ticker, date, open, high, low, close, volume FROM priceCache ORDER BY ticker, date');
  
  const outputPath = '/home/ubuntu/priceCache_yahoo_data.csv';
  const ws = fs.createWriteStream(outputPath);
  ws.write('ticker,date,open,high,low,close,volume\n');
  
  for (const r of rows) {
    ws.write(`${r.ticker},${r.date},${r.open},${r.high},${r.low},${r.close},${r.volume}\n`);
  }
  
  ws.end();
  ws.on('finish', () => {
    console.log(`Exported ${rows.length} rows to ${outputPath}`);
    const size = fs.statSync(outputPath).size;
    console.log(`File size: ${(size / 1024 / 1024).toFixed(1)} MB`);
    conn.end();
  });
}

main().catch(e => { console.error(e); process.exit(1); });
