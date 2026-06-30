/**
 * One-time script: Update dailyBasePrice in DB with Yahoo Finance RTH close (regularMarketPrice)
 * for all H1 and H2 holdings.
 */
import mysql from 'mysql2/promise';
import { readFileSync } from 'fs';

// Load .env
const envContent = readFileSync('.env', 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
}

const DATABASE_URL = env.DATABASE_URL;
if (!DATABASE_URL) { console.error('No DATABASE_URL'); process.exit(1); }

// Ticker alias map (same as server)
const TICKER_ALIAS_MAP = {
  "PHINERGY.TA": "PNRG.TA",
  "ENERGEAN.TA": "ENRG.TA",
  "TABANKS.TA": "TBNK.TA",
  "TAINS.TA": "TINS.TA",
  "TAREAL.TA": "TREAL.TA",
  "LR.TA": "LEVI.TA",
  "RBN.TA": "RBNO.TA",
  "OPC.TA": "OPCE.TA",
  "NIKE": "NKE",
};

function normalizeTickerSymbol(ticker) {
  return TICKER_ALIAS_MAP[ticker] ?? TICKER_ALIAS_MAP[ticker.toUpperCase()] ?? ticker;
}

async function getUsdIlsRate() {
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/USDILS=X?interval=1d&range=1d');
    const data = await res.json();
    return data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? 3.60;
  } catch { return 3.60; }
}

async function fetchYahooRthClose(ticker, ilsRate) {
  const yahooSymbol = normalizeTickerSymbol(ticker);
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=5d&includePrePost=false`,
      { signal: AbortSignal.timeout(5000), headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trimStart().startsWith('{')) return null;
    const data = JSON.parse(text);
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    
    const rawPrice = meta.regularMarketPrice;
    const currency = meta.currency ?? 'USD';
    
    if (currency === 'ILA') return (rawPrice / 100) / ilsRate;
    if (currency === 'ILS') return rawPrice / ilsRate;
    return rawPrice;
  } catch (e) {
    console.warn(`  Failed for ${ticker}: ${e.message}`);
    return null;
  }
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL + '&ssl={"rejectUnauthorized":true}');
  const now = Date.now();
  const ilsRate = await getUsdIlsRate();
  console.log(`USD/ILS rate: ${ilsRate}`);

  // Get all H1 holdings
  const [h1Rows] = await conn.execute('SELECT id, ticker, dailyBasePrice FROM portfolio_holdings');
  console.log(`\nH1 Holdings: ${h1Rows.length} tickers`);
  
  let h1Updated = 0;
  for (const row of h1Rows) {
    const rthClose = await fetchYahooRthClose(row.ticker, ilsRate);
    if (rthClose && rthClose > 0) {
      const diff = row.dailyBasePrice ? ((rthClose - row.dailyBasePrice) / row.dailyBasePrice * 100).toFixed(2) : 'N/A';
      console.log(`  ${row.ticker}: DB=${row.dailyBasePrice?.toFixed(2)} → Yahoo RTH=${rthClose.toFixed(2)} (diff: ${diff}%)`);
      await conn.execute('UPDATE portfolio_holdings SET dailyBasePrice = ?, dailyBaseTs = ? WHERE id = ?', [rthClose, now, row.id]);
      h1Updated++;
    } else {
      console.log(`  ${row.ticker}: Yahoo failed, keeping existing`);
    }
    // Rate limit
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`H1: Updated ${h1Updated}/${h1Rows.length}`);

  // Get all H2 holdings
  const [h2Rows] = await conn.execute('SELECT id, ticker, dailyBasePrice FROM holding2');
  console.log(`\nH2 Holdings: ${h2Rows.length} tickers`);
  
  let h2Updated = 0;
  for (const row of h2Rows) {
    const rthClose = await fetchYahooRthClose(row.ticker, ilsRate);
    if (rthClose && rthClose > 0) {
      const diff = row.dailyBasePrice ? ((rthClose - row.dailyBasePrice) / row.dailyBasePrice * 100).toFixed(2) : 'N/A';
      console.log(`  ${row.ticker}: DB=${row.dailyBasePrice?.toFixed(2)} → Yahoo RTH=${rthClose.toFixed(2)} (diff: ${diff}%)`);
      await conn.execute('UPDATE holding2 SET dailyBasePrice = ?, dailyBaseTs = ? WHERE id = ?', [rthClose, now, row.id]);
      h2Updated++;
    } else {
      console.log(`  ${row.ticker}: Yahoo failed, keeping existing`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`H2: Updated ${h2Updated}/${h2Rows.length}`);

  await conn.end();
  console.log('\nDone! DB updated with Yahoo RTH closes.');
}

main().catch(e => { console.error(e); process.exit(1); });
