/**
 * elzaV4FastKillTable.ts — FAST_TIME victims from v4-Hybrid portfolio sim (148 USA)
 *
 * RUN:
 *   node --import tsx --env-file=.env scripts/elzaV4FastKillTable.ts
 *
 * Output: /tmp/elza-v4-fastkill-table.md + stdout summary
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { fetchBarsForTicker } from "../server/marketData";
import type { Bar } from "../server/zivEngine";
import {
  BARS_DAYS,
  EARLIEST_WINDOW_START,
  MIN_BARS,
  SECTOR_BY_TICKER,
  computeTradeR,
  generateCandidates,
  getCatalogTickers,
  runPortfolio,
  type Candidate,
  type ClosedTrade,
} from "./elzaV4Hybrid";

const OUT_PATH = "/tmp/elza-v4-fastkill-table.md";
const WINDOW_START = "2025-01-01";
const WINDOW_END: string | null = null; // 2026 YTD through last bar

function fmtR(n: number): string {
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(2)}R`;
}

function buildMarkdownTable(rows: ClosedTrade[], candsByIdx: Map<number, Candidate>): string {
  const header =
    "| Ticker | Entry Date | Exit Date | Exit Reason | Max Profit Reached (MFE) | Final Net R |";
  const sep = "| --- | --- | --- | --- | --- | --- |";
  const body = rows.map(t => {
    const mfe = t.maxHighR;
    return `| ${t.ticker} | ${t.entryDate} | ${t.exitDate} | ${t.exitReason} | ${fmtR(mfe)} | ${fmtR(t.r)} |`;
  });
  return [header, sep, ...body].join("\n");
}

async function main(): Promise<void> {
  console.log("[elzaV4FastKillTable] v4-Hybrid FAST_TIME victims — 2025 CAL + 2026 YTD (148 USA catalogue)");

  const catalog = await getCatalogTickers(1);
  for (const a of catalog) SECTOR_BY_TICKER[a.ticker] = a.sector;
  const tickers = catalog.map(a => a.ticker);
  console.log(`[CATALOG] ${tickers.length} USA tickers`);

  const barsByTicker = new Map<string, Bar[]>();
  let skipped = 0;
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    if ((i + 1) % 25 === 0) console.log(`[FETCH] ${i + 1}/${tickers.length}`);
    try {
      let bars = await fetchBarsForTicker(ticker, BARS_DAYS);
      if (!bars || bars.length < MIN_BARS) { skipped++; continue; }
      bars = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      if (bars[bars.length - 1].date < EARLIEST_WINDOW_START) { skipped++; continue; }
      if (bars.filter(b => b.date < EARLIEST_WINDOW_START).length < MIN_BARS) { skipped++; continue; }
      barsByTicker.set(ticker, bars);
    } catch {
      skipped++;
    }
  }
  console.log(`[FETCH DONE] ${barsByTicker.size} usable (${skipped} skipped)`);

  const cands: Candidate[] = [];
  const usable = [...barsByTicker.keys()];
  for (let i = 0; i < usable.length; i++) {
    const ticker = usable[i];
    if ((i + 1) % 25 === 0) console.log(`[SCORE] ${i + 1}/${usable.length} (${cands.length} cands)`);
    await generateCandidates(ticker, barsByTicker.get(ticker)!, "V4_HYBRID", cands);
  }
  console.log(`[CANDS] ${cands.length} v4-Hybrid candidates total`);

  const windowCands = cands.filter(
    c => c.entryDate >= WINDOW_START && (WINDOW_END == null || c.entryDate <= WINDOW_END),
  );
  console.log(`[WINDOW] ${windowCands.length} candidates with entryDate >= ${WINDOW_START}`);

  // Tag indices for portfolio lookup
  windowCands.forEach((c, idx) => { (c as Candidate & { __idx: number }).__idx = idx; });

  const { closed } = runPortfolio(windowCands, "REALISTIC", "2025+2026");
  const taken = closed.filter(t => !t.skipped);
  const fastKill = taken
    .filter(t => t.exitReason === "FAST_TIME")
    .sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : a.ticker.localeCompare(b.ticker)));

  console.log(`[PORTFOLIO] ${taken.length} taken trades, ${fastKill.length} FAST_TIME exits`);

  const candsByIdx = new Map<number, Candidate>();
  windowCands.forEach((c, idx) => candsByIdx.set(idx, c));

  const md = [
    "# Elza v4 Hybrid — FAST_TIME (Fast Kill) Victims",
    "",
    `Universe: ${tickers.length} USA catalogue tickers (same as elzaV4Hybrid.ts).`,
    `Window: entryDate ${WINDOW_START} through latest bar (2025 CAL + 2026 YTD).`,
    `Portfolio: 12-slot conviction auction, REALISTIC friction (5bps slippage + $1/side commission-in-R).`,
    `MFE: max bar-HIGH favorable excursion in R through and including the fast-kill bar (typically bar +4).`,
    "",
    buildMarkdownTable(fastKill, candsByIdx),
    "",
    `Total FAST_TIME victims: **${fastKill.length}**`,
  ].join("\n");

  writeFileSync(OUT_PATH, md, "utf8");
  console.log(`[SAVED] ${OUT_PATH}`);
  console.log("");
  console.log(md);
}

main().catch(err => {
  console.error(`[FATAL] ${(err as Error).stack ?? err}`);
  process.exit(1);
});
