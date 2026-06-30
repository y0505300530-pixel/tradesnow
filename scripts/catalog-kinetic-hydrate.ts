/**
 * Hydrate missing USA catalogue price cache (≥60 daily bars).
 * Run: npx tsx scripts/catalog-kinetic-hydrate.ts
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { getUserAssets, getBulkCachedPrices, upsertPriceCache } from "../server/db";
import { fetchBarsForTicker } from "../server/marketData";

const USER_ID = 1;
const MIN_BARS = 60;
const FETCH_DAYS = 420;
const DELAY_MS = 400;

function isUsaTicker(ticker: string): boolean {
  const t = ticker.toUpperCase();
  return !t.endsWith(".TA") && !t.endsWith("-USD") && !/^\d/.test(t);
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function hydrateTicker(ticker: string): Promise<{ ticker: string; bars: number; ok: boolean; error?: string }> {
  try {
    const bars = await fetchBarsForTicker(ticker, FETCH_DAYS);
    if (bars.length < MIN_BARS) {
      return { ticker, bars: bars.length, ok: false, error: `Only ${bars.length} bars returned` };
    }
    await upsertPriceCache(ticker, bars.map(b => ({
      date: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume ?? 0,
    })));
    return { ticker, bars: bars.length, ok: true };
  } catch (e: any) {
    return { ticker, bars: 0, ok: false, error: e.message ?? String(e) };
  }
}

async function main() {
  const assets = await getUserAssets(USER_ID);
  const usaTickers = [...new Set(
    assets.filter(a => isUsaTicker(a.ticker)).map(a => a.ticker.toUpperCase()),
  )].sort();

  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  const cached = await getBulkCachedPrices(usaTickers, start, end);

  const dry = usaTickers.filter(t => (cached[t]?.length ?? 0) < MIN_BARS);
  console.log(`USA catalogue: ${usaTickers.length} | Need hydration: ${dry.length}`);

  if (dry.length === 0) {
    console.log("All tickers already hydrated.");
    process.exit(0);
  }

  const results: Awaited<ReturnType<typeof hydrateTicker>>[] = [];

  for (let i = 0; i < dry.length; i++) {
    const ticker = dry[i];
    console.log(`[${i + 1}/${dry.length}] Hydrating ${ticker}...`);
    let res = await hydrateTicker(ticker);
    if (!res.ok) {
      await sleep(1500);
      console.log(`  Retry ${ticker}...`);
      res = await hydrateTicker(ticker);
    }
    results.push(res);
    console.log(`  → ${res.ok ? `OK (${res.bars} bars)` : `FAIL: ${res.error}`}`);
    await sleep(DELAY_MS);
  }

  // Re-verify from DB
  const cached2 = await getBulkCachedPrices(usaTickers, start, end);
  const stillDry = usaTickers.filter(t => (cached2[t]?.length ?? 0) < MIN_BARS);

  const report = {
    generatedAt: new Date().toISOString(),
    total: usaTickers.length,
    attempted: dry.length,
    succeeded: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok),
    stillMissing: stillDry,
    fullyHydrated: stillDry.length === 0,
  };

  const outPath = path.join(process.cwd(), "catalog_kinetic_hydration_report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nHydration report: ${outPath}`);
  console.log(`Fully hydrated: ${report.fullyHydrated ? "YES" : "NO"} (${usaTickers.length - stillDry.length}/${usaTickers.length})`);
  if (stillDry.length) console.log("Still missing:", stillDry.join(", "));
  process.exit(stillDry.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
