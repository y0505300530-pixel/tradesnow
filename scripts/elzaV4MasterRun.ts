/**
 * elzaV4MasterRun.ts — Elza v4.0 High-Beta Master (NO Fast Kill + options leverage)
 *
 * RUN:
 *   node --import tsx --env-file=.env scripts/elzaV4MasterRun.ts
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { fetchBarsForTicker } from "../server/marketData";
import type { Bar } from "../server/zivEngine";
import {
  ELZA_V4_MASTER_CONFIG,
  computeOptionTradeR,
  heldDaysBetween,
} from "../server/engine/elzaV4Master";
import { loadProductionCatalogueWithStats } from "./lib/productionCatalogue";
import {
  BARS_DAYS,
  MIN_BARS,
  SECTOR_BY_TICKER,
  computeTradeR,
  generateCandidates,
  runPortfolio,
  type Candidate,
  type ClosedTrade,
} from "./elzaV4Hybrid";

const OUT_PATH = "/tmp/elza-v4-master-options-table.md";
const { WINDOW_START, WINDOW_END, OPTIONS_LEVERAGE_MULTIPLIER } = ELZA_V4_MASTER_CONFIG;

function fmtR(n: number): string {
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(2)}R`;
}

function fmtPct(n: number): string {
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(1)}%`;
}

function optionROf(c: Candidate, friction: "REALISTIC" | "FRICTIONLESS"): number {
  const stockR = computeTradeR(c, friction);
  return computeOptionTradeR(
    { stockR, heldDays: heldDaysBetween(c.entryDate, c.exitDate), friction },
  );
}

function buildTradeTable(rows: ClosedTrade[], cands: Candidate[]): string {
  const byKey = new Map<number, Candidate>();
  cands.forEach((c, idx) => byKey.set(idx, c));

  const header =
    "| Ticker | Entry | Exit | Exit Reason | Stock R | Option R (Leveraged) | Option PnL $ |";
  const sep = "| --- | --- | --- | --- | --- | --- | --- |";
  const body = rows.map(t => {
    const c = cands.find(x => x.ticker === t.ticker && x.entryDate === t.entryDate)!;
    const stockR = computeTradeR(c, "REALISTIC");
    const optR = optionROf(c, "REALISTIC");
    const pnl = Math.round(t.pnl);
    return `| ${t.ticker} | ${t.entryDate} | ${t.exitDate} | ${t.exitReason} | ${fmtR(stockR)} | ${fmtR(optR)} | $${pnl.toLocaleString()} |`;
  });
  return [header, sep, ...body].join("\n");
}

async function main(): Promise<void> {
  console.log("Elza v4.0 High-Beta Master — NO Fast Kill + ATM Call leverage sim (READ-ONLY)");
  console.log(`  ENABLE_FAST_KILL: false | SIMULATE_OPTIONS: true | Leverage: ${OPTIONS_LEVERAGE_MULTIPLIER}×`);
  console.log(`  Window: ${WINDOW_START} → latest (${WINDOW_END ?? "open"})`);
  console.log("");

  const stats = await loadProductionCatalogueWithStats();
  for (const a of stats.assets) SECTOR_BY_TICKER[a.ticker] = a.sector;
  const tickers = stats.assets.map(a => a.ticker);
  console.log(
    `[CATALOG] ${tickers.length} USA VIP tickers (raw=${stats.rawRows}, skippedIsr=${stats.skippedIsr}, skippedIpo=${stats.skippedIpo})`,
  );

  const barsByTicker = new Map<string, Bar[]>();
  let skipped = 0;
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    if ((i + 1) % 25 === 0) console.log(`[FETCH] ${i + 1}/${tickers.length}`);
    try {
      let bars = await fetchBarsForTicker(ticker, BARS_DAYS);
      if (!bars || bars.length < MIN_BARS) { skipped++; continue; }
      bars = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      if (bars[bars.length - 1].date < WINDOW_START) { skipped++; continue; }
      if (bars.filter(b => b.date < WINDOW_START).length < MIN_BARS) { skipped++; continue; }
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
    await generateCandidates(ticker, barsByTicker.get(ticker)!, "V4_MASTER", cands);
  }
  console.log(`[CANDS] ${cands.length} v4-Master candidates`);

  const windowCands = cands.filter(
    c => c.entryDate >= WINDOW_START && (WINDOW_END == null || c.entryDate <= WINDOW_END),
  );
  console.log(`[WINDOW] ${windowCands.length} in-range candidates`);

  const stockResult = runPortfolio(windowCands, "REALISTIC", "2025+2026-stock");
  const optResult = runPortfolio(
    windowCands,
    "REALISTIC",
    "2025+2026-options",
    c => optionROf(c, "REALISTIC"),
  );

  const taken = optResult.closed.filter(t => !t.skipped);
  const stockTaken = stockResult.closed.filter(t => !t.skipped);
  const totalStockR = stockTaken.reduce((s, t) => s + t.r, 0);
  const totalOptR = taken.reduce((s, t) => s + t.r, 0);
  const avgOptR = taken.length > 0 ? totalOptR / taken.length : 0;
  const wins = taken.filter(t => t.r > 0).length;

  const summaryHeader = "| Metric | Stock (baseline) | Options (Leveraged) |";
  const summarySep = "| --- | --- | --- |";
  const summaryRows = [
    `| Trades taken | ${stockTaken.length} | ${taken.length} |`,
    `| Win rate | ${stockTaken.length ? ((stockTaken.filter(t => t.r > 0).length / stockTaken.length) * 100).toFixed(1) : "0.0"}% | ${taken.length ? ((wins / taken.length) * 100).toFixed(1) : "0.0"}% |`,
    `| Total R | ${fmtR(Math.round(totalStockR * 100) / 100)} | ${fmtR(Math.round(totalOptR * 100) / 100)} |`,
    `| Avg R / trade | ${fmtR(stockTaken.length ? Math.round((totalStockR / stockTaken.length) * 100) / 100 : 0)} | ${fmtR(Math.round(avgOptR * 100) / 100)} |`,
    `| Net return | ${fmtPct(stockResult.finalReturnPct)} | ${fmtPct(optResult.finalReturnPct)} |`,
    `| Max drawdown | ${fmtPct(-stockResult.maxDrawdownPct)} | ${fmtPct(-optResult.maxDrawdownPct)} |`,
    `| Final equity | $${stockResult.finalEquity.toLocaleString()} | $${optResult.finalEquity.toLocaleString()} |`,
  ];

  const exitLines = Object.entries(optResult.exitBreakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const md = [
    "# Elza v4.0 High-Beta Master — Options Leverage Results",
    "",
    `Universe: ${tickers.length} VIP USA catalogue | Usable: ${barsByTicker.size}`,
    `Config: V4_MASTER (shallow retest, Genesis 20-bar backstop, **NO Fast Kill**)`,
    `Options: ${OPTIONS_LEVERAGE_MULTIPLIER}× leverage, theta ${ELZA_V4_MASTER_CONFIG.OPTIONS_THETA_R_PER_DAY}R/day, spread ${ELZA_V4_MASTER_CONFIG.OPTIONS_SPREAD_COST_R}R`,
    "",
    "## Portfolio Summary",
    "",
    summaryHeader,
    summarySep,
    ...summaryRows,
    "",
    "### Exit breakdown (options sim)",
    exitLines,
    "",
    "## All Taken Trades (Options R)",
    "",
    buildTradeTable(taken, windowCands),
    "",
    `Total trades: **${taken.length}**`,
  ].join("\n");

  writeFileSync(OUT_PATH, md, "utf8");

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log(" PORTFOLIO SUMMARY — Stock vs Options (REALISTIC friction)");
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log(summaryHeader);
  console.log(summarySep);
  for (const row of summaryRows) console.log(row);
  console.log("");
  console.log("Exit breakdown (options):");
  console.log(exitLines);
  console.log("");
  console.log(`[SAVED] ${OUT_PATH}`);
  console.log("");
  console.log("## All Taken Trades (first 30 rows — full table in file)");
  console.log(buildTradeTable(taken.slice(0, 30), windowCands));
  if (taken.length > 30) console.log(`\n... +${taken.length - 30} more rows in ${OUT_PATH}`);
}

main().catch(err => {
  console.error(`[FATAL] ${(err as Error).stack ?? err}`);
  process.exit(1);
});
