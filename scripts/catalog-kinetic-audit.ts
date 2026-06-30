/**
 * Kinetic Power Score audit — scorable USA universe (N=126).
 * Excludes IPO_INCUBATOR (SPCX) and DATA_BLIP_BYPASS (CYBR).
 * Scoring: rank percentiles 0–100 (not min-max).
 * Run: npx tsx scripts/catalog-kinetic-audit.ts
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { eq, and } from "drizzle-orm";
import { getUserAssets, getBulkCachedPrices, getDb } from "../server/db";
import { userAssets } from "../drizzle/schema";
import { isKineticScorable } from "../server/catalogStatus";

const USER_ID = 1;
const WINDOW = 15;
const ATR_PERIOD = 14;
const MIN_BARS = 60;
const SCORABLE_N = 126;

type Bar = { date: string; open: number; high: number; low: number; close: number; volume: number };

function isUsaTicker(ticker: string): boolean {
  const t = ticker.toUpperCase();
  return !t.endsWith(".TA") && !t.endsWith("-USD") && !/^\d/.test(t);
}

function calcATR(bars: Bar[], period = ATR_PERIOD): number[] {
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) tr.push(bars[i].high - bars[i].low);
    else {
      const prev = bars[i - 1].close;
      tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prev), Math.abs(bars[i].low - prev)));
    }
  }
  const atr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < period - 1) { atr.push(NaN); continue; }
    atr.push(tr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
  }
  return atr;
}

function atrPct(bars: Bar[]): number {
  const atrSeries = calcATR(bars).filter(v => !isNaN(v));
  if (!atrSeries.length || !bars.length) return 0;
  const avgAtr = atrSeries.slice(-60).reduce((a, b) => a + b, 0) / Math.min(atrSeries.length, 60);
  return bars[bars.length - 1].close > 0 ? (avgAtr / bars[bars.length - 1].close) * 100 : 0;
}

/** O(n·window) trough→peak run */
function maxSwingLong(bars: Bar[]): number {
  let best = 0;
  for (let start = 0; start <= bars.length - WINDOW; start++) {
    const win = bars.slice(start, start + WINDOW);
    let minLow = Infinity;
    for (let i = 0; i < win.length; i++) {
      minLow = Math.min(minLow, win[i].low);
      if (minLow > 0) best = Math.max(best, ((win[i].high - minLow) / minLow) * 100);
    }
  }
  return best;
}

/** O(n·window) peak→trough drop */
function maxSwingShort(bars: Bar[]): number {
  let best = 0;
  for (let start = 0; start <= bars.length - WINDOW; start++) {
    const win = bars.slice(start, start + WINDOW);
    let maxHigh = 0;
    for (let i = 0; i < win.length; i++) {
      maxHigh = Math.max(maxHigh, win[i].high);
      if (maxHigh > 0) best = Math.max(best, ((maxHigh - win[i].low) / maxHigh) * 100);
    }
  }
  return best;
}

function rankPercentileScores(raw: number[]): number[] {
  const n = raw.length;
  if (n === 0) return [];
  if (n === 1) return [50];
  const order = raw.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i);
  const scores = new Array<number>(n);
  for (let rank = 0; rank < n; rank++) scores[order[rank].i] = (rank / (n - 1)) * 100;
  return scores;
}

function classifyPredator(kineticScore: number, longRun: number, shortDrop: number, medLong: number, medShort: number): string {
  const maxSwing = Math.max(longRun, shortDrop);
  if (kineticScore < 25 || maxSwing < 8) return "FLATLINER";
  const ratio = shortDrop > 0 ? longRun / shortDrop : 999;
  const highLong = longRun >= medLong * 1.1;
  const highShort = shortDrop >= medShort * 1.1;
  if (longRun >= medLong && shortDrop >= medShort && maxSwing >= 15 && ratio >= 0.65 && ratio <= 1.55) return "OMNI-VIOLENT";
  if (longRun >= shortDrop * 1.35 && highLong) return "LONG DRIVER";
  if (shortDrop >= longRun * 1.35 && highShort) return "SHORT BLEEDER";
  if (maxSwing >= 20 && ratio >= 0.75 && ratio <= 1.33) return "OMNI-VIOLENT";
  if (longRun > shortDrop) return "LONG DRIVER";
  if (shortDrop > longRun) return "SHORT BLEEDER";
  return "FLATLINER";
}

async function main() {
  const assets = await getUserAssets(USER_ID);
  const usaAssets = assets.filter(a => isUsaTicker(a.ticker));
  const scorableAssets = usaAssets.filter(a => isKineticScorable((a as { catalogStatus?: string }).catalogStatus ?? null));
  const excluded = usaAssets.filter(a => !isKineticScorable((a as { catalogStatus?: string }).catalogStatus ?? null));

  console.log(`USA catalogue: ${usaAssets.length} | Scorable: ${scorableAssets.length} | Excluded: ${excluded.map(a => a.ticker).join(", ")}`);

  if (scorableAssets.length !== SCORABLE_N) {
    console.warn(`⚠️  Expected N=${SCORABLE_N}, got ${scorableAssets.length}`);
  }

  const tickers = scorableAssets.map(a => a.ticker.toUpperCase()).sort();
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  const priceMap = await getBulkCachedPrices(tickers, start, end);

  interface Row {
    symbol: string; atrPct: number; bestLong: number; bestShort: number;
    rawKinetic: number; kineticScore: number; predatorType: string; bars: number;
  }
  const rows: Row[] = [];
  const missing: string[] = [];

  for (const symbol of tickers) {
    const bars = (priceMap[symbol] ?? []).sort((a, b) => a.date.localeCompare(b.date));
    if (bars.length < MIN_BARS) { missing.push(symbol); continue; }
    const atr = atrPct(bars);
    const bestLong = maxSwingLong(bars);
    const bestShort = maxSwingShort(bars);
    const rawKinetic = atr * Math.max(bestLong, bestShort);
    rows.push({ symbol, atrPct: atr, bestLong, bestShort, rawKinetic, kineticScore: 0, predatorType: "", bars: bars.length });
  }

  if (missing.length > 0) {
    console.error(`❌ ABORT: ${missing.length} scorable tickers lack ≥${MIN_BARS} bars:`, missing.join(", "));
    process.exit(1);
  }
  if (rows.length !== SCORABLE_N) {
    console.error(`❌ ABORT: scorable count ${rows.length} !== ${SCORABLE_N}`);
    process.exit(1);
  }

  const pct = rankPercentileScores(rows.map(r => r.rawKinetic));
  for (let i = 0; i < rows.length; i++) rows[i].kineticScore = Math.round(pct[i] * 100) / 100;

  const medLong = [...rows.map(r => r.bestLong)].sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  const medShort = [...rows.map(r => r.bestShort)].sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  for (const r of rows) r.predatorType = classifyPredator(r.kineticScore, r.bestLong, r.bestShort, medLong, medShort);

  rows.sort((a, b) => b.kineticScore - a.kineticScore);

  const outPath = path.join(process.cwd(), "catalog_kinetic_audit_126.csv");
  fs.writeFileSync(outPath, [
    "Rank,Symbol,Kinetic_Score,ATR_pct,Best_Long_Run_pct,Best_Short_Drop_pct,Predator_Type",
    ...rows.map((r, i) =>
      `${i + 1},${r.symbol},${r.kineticScore.toFixed(2)},${r.atrPct.toFixed(2)},${r.bestLong.toFixed(2)},${r.bestShort.toFixed(2)},${r.predatorType}`),
  ].join("\n") + "\n");

  // Persist kinetic scores to DB
  const db = await getDb();
  if (db) {
    for (const r of rows) {
      await db.update(userAssets)
        .set({ kineticScore: r.kineticScore })
        .where(and(eq(userAssets.userId, USER_ID), eq(userAssets.ticker, r.symbol)));
    }
    console.log(`Updated kineticScore for ${rows.length} tickers in userAssets`);
  }

  const apex = rows.filter(r => r.kineticScore >= 80).slice(0, 20);
  const dead = rows.slice(-15).reverse();

  fs.writeFileSync(path.join(process.cwd(), "catalog_kinetic_audit_summary.json"), JSON.stringify({
    path: outPath,
    universe: SCORABLE_N,
    scoringMethod: "rank_percentile",
    excluded: excluded.map(a => ({ ticker: a.ticker, catalogStatus: (a as { catalogStatus?: string }).catalogStatus })),
    apex,
    dead,
    predatorCounts: rows.reduce((m, r) => { m[r.predatorType] = (m[r.predatorType] ?? 0) + 1; return m; }, {} as Record<string, number>),
  }, null, 2));

  console.log(`\n✅ Written: ${outPath}`);
  console.log(`Apex (≥80): ${apex.length} | Dead bottom 15: ${dead.length}`);
  for (const a of apex) console.log(`  APEX ${a.symbol} ${a.kineticScore} ${a.predatorType}`);
  for (const d of dead) console.log(`  DEAD ${d.symbol} ${d.kineticScore} ${d.predatorType}`);
}

main().catch(e => { console.error(e); process.exit(1); });
