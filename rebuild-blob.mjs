// Rebuild priceCacheBlob from priceCache table (all tickers, stored as chunks)
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
dotenv.config();

async function main() {
  const t0 = Date.now();
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  console.log(`[${Date.now() - t0}ms] DB connected`);

  // Step 1: Get all distinct tickers
  const [tickerRows] = await conn.execute('SELECT DISTINCT ticker FROM priceCache');
  const tickers = tickerRows.map(r => r.ticker);
  console.log(`[${Date.now() - t0}ms] Found ${tickers.length} distinct tickers`);

  // Step 2: Read ALL bars from priceCache
  const [allBars] = await conn.execute('SELECT ticker, date, open, high, low, close, volume FROM priceCache ORDER BY ticker, date');
  console.log(`[${Date.now() - t0}ms] Read ${allBars.length.toLocaleString()} bars from priceCache`);

  // Step 3: Group by ticker in compact format
  const grouped = {};
  for (const bar of allBars) {
    const t = bar.ticker.toUpperCase();
    if (!grouped[t]) grouped[t] = [];
    const dateStr = bar.date instanceof Date 
      ? bar.date.toISOString().split('T')[0] 
      : String(bar.date);
    grouped[t].push({
      d: dateStr,
      o: Number(bar.open),
      h: Number(bar.high),
      l: Number(bar.low),
      c: Number(bar.close),
      v: Number(bar.volume),
    });
  }

  const tickerCount = Object.keys(grouped).length;
  let totalBars = 0;
  for (const bars of Object.values(grouped)) totalBars += bars.length;
  console.log(`[${Date.now() - t0}ms] Grouped: ${tickerCount} tickers, ${totalBars.toLocaleString()} bars`);

  // Step 4: Clear blob table
  await conn.execute('DELETE FROM priceCacheBlob');
  console.log(`[${Date.now() - t0}ms] Cleared old blob`);

  // Step 5: Write chunks (DB has 6MB entry limit, so ~20 tickers per chunk)
  const allTickerKeys = Object.keys(grouped);
  const chunkSize = 20;
  let chunkIdx = 0;
  for (let i = 0; i < allTickerKeys.length; i += chunkSize) {
    const chunkKeys = allTickerKeys.slice(i, i + chunkSize);
    const chunk = {};
    let chunkBars = 0;
    for (const k of chunkKeys) {
      chunk[k] = grouped[k];
      chunkBars += grouped[k].length;
    }
    const chunkJson = JSON.stringify(chunk);
    await conn.query('INSERT INTO priceCacheBlob (data, tickerCount, totalBars) VALUES (?, ?, ?)', [chunkJson, chunkKeys.length, chunkBars]);
    console.log(`[${Date.now() - t0}ms] Chunk ${chunkIdx}: ${chunkKeys.length} tickers, ${chunkBars} bars, ${(Buffer.byteLength(chunkJson, 'utf8') / 1024 / 1024).toFixed(1)}MB`);
    chunkIdx++;
  }

  // Step 6: Verify
  const [verify] = await conn.execute('SELECT COUNT(*) as chunks, SUM(tickerCount) as tickers, SUM(totalBars) as bars FROM priceCacheBlob');
  console.log(`[${Date.now() - t0}ms] Verified: ${verify[0].chunks} chunks, ${verify[0].tickers} tickers, ${Number(verify[0].bars).toLocaleString()} bars`);

  await conn.end();
  console.log(`\n=== DONE in ${Date.now() - t0}ms ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
