/**
 * Rebuild blob in CSV format from priceCache table.
 * CSV format: ticker,date,open,high,low,close,volume (one line per bar)
 * Chunks of ~20 tickers each to stay under 6MB DB entry limit.
 */
import mysql from 'mysql2/promise';
import * as dotenv from 'dotenv';
dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  console.log('Connected to DB');

  // 1. Get all tickers from price_cache
  const [tickerRows] = await conn.execute('SELECT DISTINCT ticker FROM priceCache ORDER BY ticker');
  const allTickers = tickerRows.map(r => r.ticker.toUpperCase());
  console.log(`Found ${allTickers.length} tickers in price_cache`);

  // 2. Clear blob table
  await conn.execute('DELETE FROM priceCacheBlob');
  console.log('Cleared blob table');

  // 3. Process in batches of 20 tickers
  const BATCH_SIZE = 20;
  let totalBars = 0;
  let chunkCount = 0;

  for (let i = 0; i < allTickers.length; i += BATCH_SIZE) {
    const batch = allTickers.slice(i, i + BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(',');
    const [bars] = await conn.execute(
      `SELECT ticker, date, open, high, low, close, volume FROM priceCache WHERE UPPER(ticker) IN (${placeholders}) ORDER BY ticker, date`,
      batch
    );

    // Build CSV lines
    const csvLines = [];
    for (const bar of bars) {
      const t = bar.ticker.toUpperCase();
      const rawDate = bar.date;
      const d = rawDate instanceof Date
        ? rawDate.toISOString().split('T')[0]
        : typeof rawDate === 'string' ? rawDate.split('T')[0] : String(rawDate);
      csvLines.push(`${t},${d},${Number(bar.open)},${Number(bar.high)},${Number(bar.low)},${Number(bar.close)},${Number(bar.volume)}`);
    }
    const csvData = csvLines.join('\n');
    const csvSizeMB = (Buffer.byteLength(csvData) / 1024 / 1024).toFixed(2);

    // Count unique tickers in this batch
    const tickersInBatch = new Set(bars.map(b => b.ticker.toUpperCase()));

    await conn.execute(
      'INSERT INTO priceCacheBlob (data, tickerCount, totalBars) VALUES (?, ?, ?)',
      [csvData, tickersInBatch.size, csvLines.length]
    );

    totalBars += csvLines.length;
    chunkCount++;
    console.log(`Chunk ${chunkCount}: ${tickersInBatch.size} tickers, ${csvLines.length} bars, ${csvSizeMB}MB CSV`);
  }

  // 4. Verify
  const [verify] = await conn.execute('SELECT COUNT(*) as cnt, SUM(tickerCount) as tickers, SUM(totalBars) as bars FROM priceCacheBlob');
  console.log(`\n✅ Done! ${verify[0].cnt} chunks, ${verify[0].tickers} tickers, ${Number(verify[0].bars).toLocaleString()} bars`);
  console.log(`Total CSV size: estimated ${(totalBars * 50 / 1024 / 1024).toFixed(1)}MB (vs ~33MB JSON)`);

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
