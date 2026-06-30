/**
 * elzaV4Improved2025.ts — Cross-validation: Elza v4.1 Improved on 2025 CAL (equities only)
 *
 * v4.1 = V4_MASTER: shallow retest + EMA-200 macro, TP1 @1.5R, Stage-2 Chandelier 2.5×ATR,
 *        NO Fast Kill, 12-slot conviction auction, full friction.
 *
 * RUN:
 *   node --import tsx --env-file=.env scripts/elzaV4Improved2025.ts
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { fetchBarsForTicker } from "../server/marketData";
import type { Bar } from "../server/zivEngine";
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

const WINDOW_START = "2025-01-01";
const WINDOW_END = "2025-12-31";
const OUT_SUMMARY = "/tmp/elza-v4.1-2025-summary.md";
const OUT_FLIGHT = "/tmp/elza-v4.1-2025-flight-recorder.md";

function fmtR(n: number): string {
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(2)}R`;
}

function fmtPct(n: number): string {
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(2)}%`;
}

function computeSpy2025(spyBars: Bar[]): { returnPct: number; maxDDPct: number } | null {
  const inWin = spyBars
    .filter(b => b.date >= WINDOW_START && b.date <= WINDOW_END)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (inWin.length < 2) return null;
  const base = inWin[0].close;
  let peak = 100_000;
  let maxDD = 0;
  let lastEq = 100_000;
  for (const b of inWin) {
    const eq = 100_000 * (b.close / base);
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    if (dd > maxDD) maxDD = dd;
    lastEq = eq;
  }
  return {
    returnPct: ((lastEq - 100_000) / 100_000) * 100,
    maxDDPct: maxDD * 100,
  };
}

function buildFlightRecorder(taken: ClosedTrade[], cands: Candidate[]): string {
  const header =
    "| Ticker | Entry | Exit | Tier | Score | MFE (R) | Exit Reason | Final Net R | PnL $ |";
  const sep = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const sorted = [...taken].sort((a, b) =>
    a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : a.ticker.localeCompare(b.ticker),
  );
  const rows = sorted.map(t => {
    const c = cands.find(x => x.ticker === t.ticker && x.entryDate === t.entryDate)!;
    return `| ${t.ticker} | ${t.entryDate} | ${t.exitDate} | ${c.tier} | ${c.totalScore.toFixed(2)} | ${fmtR(t.maxHighR)} | ${t.exitReason} | ${fmtR(t.r)} | $${Math.round(t.pnl).toLocaleString()} |`;
  });
  return [header, sep, ...rows].join("\n");
}

async function main(): Promise<void> {
  console.log("Elza v4.1 Improved — 2025 CAL Cross-Validation (EQUITIES ONLY, NO Fast Kill)");
  console.log(`Window: ${WINDOW_START} → ${WINDOW_END} | Friction: REALISTIC (5bps + $1/side)`);
  console.log("Entry: score≥7.0 + confluence/liquidity + shallow EMA20→50 retest + EMA-200 macro");
  console.log("Exit: TP1 @1.5R free-roll → BE → Chandelier 2.5×ATR | 20-bar pre-TP backstop | NO Fast Kill");
  console.log("Portfolio: 12 slots, conviction auction, 1% risk/trade");
  console.log("");

  const stats = await loadProductionCatalogueWithStats();
  for (const a of stats.assets) SECTOR_BY_TICKER[a.ticker] = a.sector;
  const tickers = stats.assets.map(a => a.ticker);
  console.log(`[CATALOG] ${tickers.length} VIP USA (raw=${stats.rawRows})`);

  let spyBars: Bar[] = [];
  try {
    spyBars = await fetchBarsForTicker("SPY", BARS_DAYS);
    spyBars = [...spyBars].sort((a, b) => (a.date < b.date ? -1 : 1));
  } catch (e) {
    console.log(`[WARN] SPY fetch failed: ${(e as Error).message}`);
  }

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
  console.log(`[CANDS] ${cands.length} v4.1 candidates total`);

  const windowCands = cands.filter(
    c => c.entryDate >= WINDOW_START && c.entryDate <= WINDOW_END,
  );
  console.log(`[WINDOW] ${windowCands.length} candidates with entry in 2025`);

  const result = runPortfolio(windowCands, "REALISTIC", "W-CAL2025");
  const taken = result.closed.filter(t => !t.skipped);
  const spy = computeSpy2025(spyBars);
  const alpha = spy ? result.finalReturnPct - spy.returnPct : null;

  const exitLines = Object.entries(result.exitBreakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `- **${k}**: ${v}`)
    .join("\n");

  const summaryMd = [
    "# Elza v4.1 Improved — 2025 CAL Results (Cross-Validation)",
    "",
    `Universe: ${tickers.length} VIP USA | Usable: ${barsByTicker.size}`,
    `Friction: REALISTIC (5bps slippage + $1/side commission-in-R)`,
    `Fast Kill: **DISABLED** | TP1: 1.5R | Stage-2: Chandelier 2.5×ATR`,
    "",
    "## Headline vs SPY",
    "",
    "| Metric | v4.1 Improved | SPY Buy & Hold | Alpha |",
    "| --- | --- | --- | --- |",
    `| Net Return | ${fmtPct(result.finalReturnPct)} | ${spy ? fmtPct(spy.returnPct) : "N/A"} | ${alpha != null ? fmtPct(alpha) : "N/A"} |`,
    `| Max Drawdown | ${fmtPct(-result.maxDrawdownPct)} | ${spy ? fmtPct(-spy.maxDDPct) : "N/A"} | — |`,
    `| Trades | ${taken.length} | — | — |`,
    `| Win Rate | ${taken.length ? ((result.wins / taken.length) * 100).toFixed(1) : "0.0"}% | — | — |`,
    `| Total R | ${fmtR(result.totalR)} | — | — |`,
    `| Final Equity | $${result.finalEquity.toLocaleString()} | — | — |`,
    "",
    "## Exit Breakdown",
    exitLines,
    "",
    alpha != null && alpha >= 0
      ? `**Verdict: v4.1 BEATS SPY by ${fmtPct(alpha)}**`
      : alpha != null
        ? `**Verdict: v4.1 UNDERPERFORMS SPY by ${fmtPct(Math.abs(alpha))}**`
        : "**Verdict: SPY data unavailable**",
  ].join("\n");

  const flightMd = [
    "# Elza v4.1 — 2025 Flight Recorder (All Taken Trades)",
    "",
    summaryMd.split("## Exit Breakdown")[0].trim(),
    "",
    buildFlightRecorder(taken, windowCands),
    "",
    `Total taken trades: **${taken.length}** | Skipped (heat/cap): **${result.closed.length - taken.length}**`,
  ].join("\n");

  writeFileSync(OUT_SUMMARY, summaryMd, "utf8");
  writeFileSync(OUT_FLIGHT, flightMd, "utf8");

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log(" ELZA v4.1 IMPROVED — 2025 CAL vs SPY (REALISTIC)");
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log(`  Trades:    ${taken.length}`);
  console.log(`  Win%:      ${taken.length ? ((result.wins / taken.length) * 100).toFixed(1) : "0.0"}%`);
  console.log(`  Total R:   ${fmtR(result.totalR)}`);
  console.log(`  Return:    ${fmtPct(result.finalReturnPct)}`);
  console.log(`  Max DD:    ${fmtPct(-result.maxDrawdownPct)}`);
  if (spy) {
    console.log(`  SPY:       ${fmtPct(spy.returnPct)} (DD ${fmtPct(-spy.maxDDPct)})`);
    console.log(`  Alpha:     ${fmtPct(alpha!)}`);
  }
  console.log("");
  console.log("  Exit breakdown:", JSON.stringify(result.exitBreakdown));
  console.log("");
  console.log(`[SAVED] ${OUT_SUMMARY}`);
  console.log(`[SAVED] ${OUT_FLIGHT}`);
  console.log("");
  console.log("## Flight Recorder (all trades)");
  console.log(buildFlightRecorder(taken, windowCands));
}

main().catch(err => {
  console.error(`[FATAL] ${(err as Error).stack ?? err}`);
  process.exit(1);
});
