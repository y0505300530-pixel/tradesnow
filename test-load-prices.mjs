// Test script to measure loadPricesForSimulation timing and memory
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// We need to call the DB directly since loadPricesForSimulation is in TS
// Simulate what Layer 3 does: read blob from DB, parse JSON, measure timing + memory

const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

// Load env
dotenv.config({ path: path.join(process.cwd(), '.env') });

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('No DATABASE_URL found');
    process.exit(1);
  }
  
  console.log('=== Memory & Timing Test for loadPricesForSimulation ===');
  console.log(`Initial memory: ${JSON.stringify(getMemory())}`);
  
  const t0 = Date.now();
  
  // Step 1: Connect to DB
  const conn = await mysql.createConnection(dbUrl);
  console.log(`[${Date.now() - t0}ms] DB connected`);
  
  // Step 2: Read blob from price_cache_blob table
  const [rows] = await conn.execute('SELECT data, tickerCount, totalBars FROM priceCacheBlob LIMIT 1');
  if (rows.length === 0) {
    console.log('No blob found in DB!');
    await conn.end();
    return;
  }
  
  const rawData = rows[0].data;
  const rawSize = Buffer.byteLength(rawData, 'utf8');
  console.log(`[${Date.now() - t0}ms] Blob read from DB — ${(rawSize / 1024 / 1024).toFixed(1)}MB raw, tickerCount=${rows[0].tickerCount}, totalBars=${rows[0].totalBars}`);
  console.log(`Memory after DB read: ${JSON.stringify(getMemory())}`);
  
  // Step 3: Parse JSON (this is the heavy part)
  const t1 = Date.now();
  const blobData = JSON.parse(rawData);
  console.log(`[${Date.now() - t0}ms] JSON.parse complete (${Date.now() - t1}ms for parse alone)`);
  console.log(`Memory after parse: ${JSON.stringify(getMemory())}`);
  
  // Step 4: Transform to PriceFileData format (like the real code does)
  const t2 = Date.now();
  const parsed = {};
  let totalBars = 0;
  for (const [ticker, bars] of Object.entries(blobData)) {
    parsed[ticker] = bars.map(b => ({ date: b.d, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
    totalBars += bars.length;
  }
  console.log(`[${Date.now() - t0}ms] Transform complete (${Date.now() - t2}ms) — ${Object.keys(parsed).length} tickers, ${totalBars.toLocaleString()} bars`);
  console.log(`Memory after transform: ${JSON.stringify(getMemory())}`);
  
  // Step 5: Simulate filtering for 100 tickers
  const allTickers = Object.keys(parsed).slice(0, 100);
  const result = {};
  let found = 0;
  for (const t of allTickers) {
    const bars = parsed[t.toUpperCase()] ?? parsed[t] ?? [];
    result[t] = bars;
    if (bars.length > 0) found++;
  }
  console.log(`[${Date.now() - t0}ms] Filter complete — ${found}/${allTickers.length} tickers have data`);
  console.log(`Final memory: ${JSON.stringify(getMemory())}`);
  console.log(`\n=== TOTAL TIME: ${Date.now() - t0}ms ===`);
  
  await conn.end();
}

function getMemory() {
  const mem = process.memoryUsage();
  return {
    rss: `${(mem.rss / 1024 / 1024).toFixed(0)}MB`,
    heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB`,
    heapTotal: `${(mem.heapTotal / 1024 / 1024).toFixed(0)}MB`,
  };
}

main().catch(e => { console.error(e); process.exit(1); });
