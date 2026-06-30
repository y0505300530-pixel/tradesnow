/**
 * surfSensitivityCalibration.ts — SURF sensitivity matrix + Golden cannibalization.
 *
 * Same 60-day harness/window as surfModuleBacktest.ts with:
 *   • Tight intraday SL: max(entry − 1.5×ATR14, entry × 0.97)
 *   • 4 variants: flush 45/90 min × RVOL 2.0/2.5
 *   • Cannibalization: SURF fills overlapping Golden entry signal (ticker+date)
 *
 * RUN:
 *   node --import tsx --env-file=.env scripts/surfSensitivityCalibration.ts
 */
import "dotenv/config";
import { fetchBarsForTicker } from "../server/marketData";
import { calcEMA, type Bar } from "../server/zivEngine";
import {
  fetchIntradayBarsForTicker,
  filterRegularSession,
  type IntradayBar,
} from "../server/intradayMarketData";
import { computeIntradayRvol } from "../server/intradayArmedWatcher";
import { genesisScore } from "../server/engine/elzaV45Master";
import { computeAtr14 } from "../server/slCalculator";
import { getTickerIntelligence } from "../server/runtimeIntelligence";

const TRADING_DAYS = 60;
const INTRADAY_LEV = 4.0;
const ALLOC_PCT = 0.40;
const START_EQUITY = 100_000;
const SURF_RISK_PCT = 0.02;
const MAX_CONCURRENT = 8;
const MAX_POSITION_USD = 85_000;
const DONCHIAN_DAYS = 5;
const MICRO_FLUSH_MIN_R = 1.0;
const EOD_FLATTEN_MINS = 15 * 60 + 45;
const ATR_STOP_MULT = 1.5;
const STOP_ENTRY_FLOOR = 0.97; // 3% floor
const SLIPPAGE_BPS = 0.0005;
const COMMISSION = 1.0;

const LONG_ENTRY_MIN_SCORE = 7.0;
const MIN_CONFLUENCE = 4.5;
const MIN_LIQUIDITY_SCORE = 2.0;
const VIX_BLOCK = 35;
const BARS_DAYS = 600; // Golden DNA warmup — EMA200 + genesis gates need deep history
const MIN_BARS = 50;

type ExitReason = "SL" | "MICRO_FLUSH" | "EOD_FLATTEN";

interface SurfConfig {
  label: string;
  microFlushMin: number;
  rvolMin: number;
}

const VARIANTS: SurfConfig[] = [
  { label: "A", microFlushMin: 45, rvolMin: 2.5 },
  { label: "B", microFlushMin: 45, rvolMin: 2.0 },
  { label: "C", microFlushMin: 90, rvolMin: 2.5 },
  { label: "D", microFlushMin: 90, rvolMin: 2.0 },
];

interface SurfSignal {
  ticker: string;
  date: string;
  entryTs: number;
  entry: number;
  stop: number;
  r: number;
  bars: IntradayBar[];
  entryIdx: number;
}

interface ClosedSurf {
  ticker: string;
  date: string;
  entry: number;
  exit: number;
  exitTs: number;
  exitReason: ExitReason;
  shares: number;
  pnl: number;
  pnlR: number;
  mfeR: number;
  goldenOverlap: boolean;
}

interface VariantResult {
  label: string;
  microFlushMin: number;
  rvolMin: number;
  rawSignals: number;
  trades: number;
  winPct: number;
  totalR: number;
  avgR: number;
  returnPct: number;
  maxDrawdownPct: number;
  maxIntradayDrawdownPct: number;
  goldenOverlap: number;
  goldenOverlapPct: number;
  uniqueSurf: number;
  exitBreakdown: Record<string, number>;
  avgStopPct: number;
}

interface TickerData {
  ticker: string;
  daily: Bar[];
  bars5m: IntradayBar[];
}

function etMins(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function tightSurfStop(entry: number, dailyUpTo: Bar[]): number {
  const atr = computeAtr14(dailyUpTo);
  const atrStop = atr != null && atr > 0 ? entry - ATR_STOP_MULT * atr : entry * STOP_ENTRY_FLOOR;
  return Math.max(atrStop, entry * STOP_ENTRY_FLOOR);
}

function frictionEntry(px: number): number {
  return +(px * (1 + SLIPPAGE_BPS)).toFixed(4);
}

function frictionExit(px: number): number {
  return +(px * (1 - SLIPPAGE_BPS)).toFixed(4);
}

function donchian5High(daily: Bar[], beforeDate: string): number {
  const prior = daily.filter((b) => b.date < beforeDate).slice(-DONCHIAN_DAYS);
  if (prior.length < DONCHIAN_DAYS) return 0;
  return Math.max(...prior.map((b) => b.high));
}

async function getCatalogTickers(): Promise<string[]> {
  const { getUserAssets } = await import("../server/db");
  const assets = await getUserAssets(1);
  return assets
    .filter((a) => !a.ticker.toUpperCase().endsWith(".TA"))
    .filter((a) => (a as { catalogStatus?: string }).catalogStatus !== "IPO_INCUBATOR")
    .map((a) => a.ticker.toUpperCase());
}

function buildVixCloseMap(vixBars: Bar[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of vixBars) if (b.close > 0) out.set(b.date, b.close);
  return out;
}

function vixCloseForDate(date: string, vixMap: Map<string, number>): number | null {
  if (vixMap.has(date)) return vixMap.get(date)!;
  let best: string | null = null;
  for (const d of vixMap.keys()) if (d <= date && (best === null || d > best)) best = d;
  return best === null ? null : vixMap.get(best)!;
}

async function buildGoldenSignalSet(
  tickerData: TickerData[],
  sessionSet: Set<string>,
  vixMap: Map<string, number>,
): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const { ticker, daily } of tickerData) {
    for (let i = MIN_BARS - 1; i < daily.length; i++) {
      const date = daily[i].date;
      if (!sessionSet.has(date)) continue;

      const gs = genesisScore(daily, i);
      if (gs.tier === null) continue;
      if (!(gs.totalScore >= LONG_ENTRY_MIN_SCORE)) continue;

      const entry = daily[i].close;
      if (!(entry > 0) || !(entry > gs.ema200)) continue;

      const intel = await getTickerIntelligence(ticker, daily.slice(0, i + 1));
      if (!(intel.confluenceScore >= MIN_CONFLUENCE)) continue;
      if (!(intel.liquidityScore >= MIN_LIQUIDITY_SCORE)) continue;

      const vixClose = vixCloseForDate(date, vixMap);
      if (vixClose != null && vixClose > VIX_BLOCK) continue;

      keys.add(`${ticker}|${date}`);
    }
  }
  return keys;
}

function scanSurfSignals(
  ticker: string,
  daily: Bar[],
  bars5m: IntradayBar[],
  sessionDates: Set<string>,
  cfg: SurfConfig,
): SurfSignal[] {
  const out: SurfSignal[] = [];
  const rth = filterRegularSession(bars5m);
  const byDate = new Map<string, IntradayBar[]>();
  for (const b of rth) {
    if (!sessionDates.has(b.date)) continue;
    const arr = byDate.get(b.date) ?? [];
    arr.push(b);
    byDate.set(b.date, arr);
  }

  for (const [date, dayBars] of byDate) {
    const breakLevel = donchian5High(daily, date);
    if (!(breakLevel > 0)) continue;

    const dailyUpTo = daily.filter((b) => b.date <= date);

    let entered = false;
    for (let i = 0; i < dayBars.length; i++) {
      if (entered) break;
      const bar = dayBars[i];
      if (bar.close <= breakLevel) continue;

      const hist = rth.filter((b) => b.ts <= bar.ts);
      const rvol = computeIntradayRvol(hist);
      if (rvol == null || rvol < cfg.rvolMin) continue;

      const entry = bar.close;
      const stop = tightSurfStop(entry, dailyUpTo);
      if (!(stop < entry)) continue;
      const r = entry - stop;

      out.push({
        ticker,
        date,
        entryTs: bar.ts,
        entry,
        stop,
        r,
        bars: dayBars,
        entryIdx: i,
      });
      entered = true;
    }
  }
  return out;
}

function simulateExit(sig: SurfSignal, microFlushMin: number): Omit<ClosedSurf, "shares" | "pnl" | "goldenOverlap"> {
  const entryFill = frictionEntry(sig.entry);
  const flushDeadline = sig.entryTs + microFlushMin * 60_000;
  let mfeR = 0;
  let exitPrice = entryFill;
  let exitTs = sig.entryTs;
  let exitReason: ExitReason = "EOD_FLATTEN";

  for (let i = sig.entryIdx + 1; i < sig.bars.length; i++) {
    const b = sig.bars[i];
    const mins = etMins(b.time);
    const highR = (b.high - entryFill) / sig.r;
    mfeR = Math.max(mfeR, highR);

    if (b.low <= sig.stop) {
      exitPrice = frictionExit(sig.stop);
      exitTs = b.ts;
      exitReason = "SL";
      break;
    }

    if (b.ts >= flushDeadline) {
      const markR = (b.close - entryFill) / sig.r;
      if (markR < MICRO_FLUSH_MIN_R) {
        exitPrice = frictionExit(b.close);
        exitTs = b.ts;
        exitReason = "MICRO_FLUSH";
        break;
      }
    }

    if (mins >= EOD_FLATTEN_MINS) {
      exitPrice = frictionExit(b.close);
      exitTs = b.ts;
      exitReason = "EOD_FLATTEN";
      break;
    }
  }

  if (exitReason === "EOD_FLATTEN" && sig.bars.length > sig.entryIdx + 1) {
    const last = sig.bars[sig.bars.length - 1];
    exitPrice = frictionExit(last.close);
    exitTs = last.ts;
  }

  const pnlR = (exitPrice - entryFill) / sig.r;
  return {
    ticker: sig.ticker,
    date: sig.date,
    entry: entryFill,
    exit: exitPrice,
    exitTs,
    exitReason,
    mfeR: +mfeR.toFixed(2),
    pnlR,
  };
}

function runPortfolio(
  signals: SurfSignal[],
  cfg: SurfConfig,
  goldenKeys: Set<string>,
): { trades: ClosedSurf[]; metrics: Omit<VariantResult, "label" | "microFlushMin" | "rvolMin" | "rawSignals"> } {
  const sorted = [...signals].sort((a, b) => a.entryTs - b.entryTs);
  let equity = START_EQUITY;
  let peak = equity;
  let maxDD = 0;
  let maxIntradayDD = 0;
  const open: Array<ClosedSurf & { exitTs: number; notional: number }> = [];
  const closed: ClosedSurf[] = [];
  const exitBreakdown: Record<string, number> = {};
  let dayStartEquity = equity;
  let dayTrough = equity;
  let curDay = "";
  let stopPctSum = 0;

  const releaseThrough = (ts: number) => {
    const still: typeof open = [];
    for (const t of open) {
      if (t.exitTs <= ts) {
        equity += t.pnl;
        closed.push(t);
        peak = Math.max(peak, equity);
        maxDD = Math.max(maxDD, peak > 0 ? ((peak - equity) / peak) * 100 : 0);
        exitBreakdown[t.exitReason] = (exitBreakdown[t.exitReason] ?? 0) + 1;
      } else {
        still.push(t);
      }
    }
    open.length = 0;
    open.push(...still);
  };

  for (const sig of sorted) {
    const d = sig.date;
    if (d !== curDay) {
      curDay = d;
      dayStartEquity = equity;
      dayTrough = equity;
    }

    releaseThrough(sig.entryTs);

    const grossOpen = open.reduce((s, t) => s + t.notional, 0);
    const maxGross = equity * ALLOC_PCT * INTRADAY_LEV;
    if (open.length >= MAX_CONCURRENT) continue;
    if (open.some((t) => t.ticker === sig.ticker)) continue;

    const riskDollars = equity * SURF_RISK_PCT;
    const entryFill = frictionEntry(sig.entry);
    let shares = Math.floor(riskDollars / sig.r);
    const notional = shares * entryFill;
    if (notional > MAX_POSITION_USD) {
      shares = Math.floor(MAX_POSITION_USD / entryFill);
    }
    if (shares < 1) continue;
    const posNotional = shares * entryFill;
    if (grossOpen + posNotional > maxGross) continue;

    stopPctSum += ((sig.entry - sig.stop) / sig.entry) * 100;

    const sim = simulateExit(sig, cfg.microFlushMin);
    const pnl = (sim.exit - entryFill) * shares - COMMISSION * 2;
    const goldenOverlap = goldenKeys.has(`${sig.ticker}|${sig.date}`);

    open.push({
      ...sim,
      shares,
      pnl,
      pnlR: sim.pnlR,
      goldenOverlap,
      notional: posNotional,
    });

    dayTrough = Math.min(dayTrough, equity);
    const intradayDD =
      dayStartEquity > 0 ? ((dayStartEquity - dayTrough) / dayStartEquity) * 100 : 0;
    maxIntradayDD = Math.max(maxIntradayDD, intradayDD);
  }

  releaseThrough(Number.MAX_SAFE_INTEGER);

  const wins = closed.filter((t) => t.pnl > 0).length;
  const totalR = closed.reduce((s, t) => s + t.pnlR, 0);
  const goldenOverlap = closed.filter((t) => t.goldenOverlap).length;

  return {
    trades: closed,
    metrics: {
      trades: closed.length,
      winPct: closed.length ? (wins / closed.length) * 100 : 0,
      totalR: +totalR.toFixed(2),
      avgR: closed.length ? +(totalR / closed.length).toFixed(3) : 0,
      returnPct: ((equity - START_EQUITY) / START_EQUITY) * 100,
      maxDrawdownPct: maxDD,
      maxIntradayDrawdownPct: maxIntradayDD,
      goldenOverlap,
      goldenOverlapPct: closed.length ? (goldenOverlap / closed.length) * 100 : 0,
      uniqueSurf: closed.length - goldenOverlap,
      exitBreakdown,
      avgStopPct: closed.length ? +(stopPctSum / closed.length).toFixed(2) : 0,
    },
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printTable(results: VariantResult[], window: { start: string; end: string }): void {
  console.log("\n═══════════════════════════════════════════════════════════════════════════════");
  console.log(" SURF SENSITIVITY MATRIX — TIGHT SL (1.5×ATR / 3% floor) + CANNIBALIZATION");
  console.log(` Window: ${window.start} → ${window.end} (${TRADING_DAYS} sessions)`);
  console.log(" Golden overlap = SURF fill where Golden entry signal exists same ticker+date");
  console.log("═══════════════════════════════════════════════════════════════════════════════\n");

  const hdr = [
    pad("Var", 4),
    pad("Flush", 6),
    pad("RVOL", 5),
    pad("Raw", 5),
    pad("Taken", 6),
    pad("Win%", 6),
    pad("TotR", 7),
    pad("AvgR", 7),
    pad("Net%", 7),
    pad("MaxDD", 7),
    pad("ID-DD", 7),
    pad("AvgSL%", 7),
    pad("G.Ovl", 6),
    pad("G.Ovl%", 7),
    pad("Unique", 7),
  ].join(" | ");
  console.log(hdr);
  console.log("-".repeat(hdr.length));

  for (const r of results) {
    const row = [
      pad(r.label, 4),
      pad(`${r.microFlushMin}m`, 6),
      pad(`${r.rvolMin}x`, 5),
      pad(String(r.rawSignals), 5),
      pad(String(r.trades), 6),
      pad(`${r.winPct.toFixed(1)}`, 6),
      pad(`${r.totalR >= 0 ? "+" : ""}${r.totalR.toFixed(2)}`, 7),
      pad(`${r.avgR >= 0 ? "+" : ""}${r.avgR.toFixed(3)}`, 7),
      pad(`${r.returnPct >= 0 ? "+" : ""}${r.returnPct.toFixed(2)}`, 7),
      pad(`${r.maxDrawdownPct.toFixed(2)}`, 7),
      pad(`${r.maxIntradayDrawdownPct.toFixed(2)}`, 7),
      pad(`${r.avgStopPct.toFixed(2)}`, 7),
      pad(String(r.goldenOverlap), 6),
      pad(`${r.goldenOverlapPct.toFixed(1)}`, 7),
      pad(String(r.uniqueSurf), 7),
    ].join(" | ");
    console.log(row);
  }

  console.log("\nExit breakdown per variant:");
  for (const r of results) {
    const parts = Object.entries(r.exitBreakdown)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    console.log(`  ${r.label}: ${parts || "—"}`);
  }
}

async function main(): Promise<void> {
  console.log("SURF Sensitivity Calibration — fetching data once, running variants A–D\n");
  console.log(
    `  SL: max(entry−${ATR_STOP_MULT}×ATR14, entry×${STOP_ENTRY_FLOOR}) | Lev ${INTRADAY_LEV}× | Risk ${SURF_RISK_PCT * 100}%`,
  );

  const tickers = await getCatalogTickers();
  console.log(`[CATALOG] ${tickers.length} VIP tickers`);

  const [spyDaily, vixDaily] = await Promise.all([
    fetchBarsForTicker("SPY", BARS_DAYS),
    fetchBarsForTicker("^VIX", BARS_DAYS),
  ]);
  const spySorted = [...spyDaily].sort((a, b) => (a.date < b.date ? -1 : 1));
  const sessionDates = new Set(spySorted.slice(-TRADING_DAYS - 5).map((b) => b.date));
  const sessionList = [...sessionDates].sort().slice(-TRADING_DAYS);
  const sessionSet = new Set(sessionList);
  const startDate = sessionList[0];
  const endDate = sessionList[sessionList.length - 1];
  console.log(`[WINDOW] ${startDate} → ${endDate}\n`);

  const vixMap = buildVixCloseMap([...vixDaily].sort((a, b) => (a.date < b.date ? -1 : 1)));
  const tickerData: TickerData[] = [];
  let fetched = 0;
  let skipped = 0;

  for (const ticker of tickers) {
    fetched++;
    if (fetched % 25 === 0) console.log(`[FETCH] ${fetched}/${tickers.length}`);
    try {
      const daily = [...(await fetchBarsForTicker(ticker, BARS_DAYS))].sort((a, b) =>
        a.date < b.date ? -1 : 1,
      );
      if (daily.length < MIN_BARS) {
        skipped++;
        continue;
      }
      const bars5m = await fetchIntradayBarsForTicker(ticker, "5m", startDate, endDate);
      if (!bars5m.length) {
        skipped++;
        continue;
      }
      tickerData.push({ ticker, daily, bars5m });
    } catch {
      skipped++;
    }
  }
  console.log(`[DATA] ${tickerData.length} tickers loaded (${skipped} skipped)\n`);

  console.log("[GOLDEN] Building entry-signal set for cannibalization test...");
  const goldenKeys = await buildGoldenSignalSet(tickerData, sessionSet, vixMap);
  console.log(`[GOLDEN] ${goldenKeys.size} ticker-day Golden signals in window\n`);

  const results: VariantResult[] = [];
  for (const cfg of VARIANTS) {
    const allSignals: SurfSignal[] = [];
    for (const td of tickerData) {
      allSignals.push(...scanSurfSignals(td.ticker, td.daily, td.bars5m, sessionSet, cfg));
    }
    const { metrics } = runPortfolio(allSignals, cfg, goldenKeys);
    results.push({
      label: cfg.label,
      microFlushMin: cfg.microFlushMin,
      rvolMin: cfg.rvolMin,
      rawSignals: allSignals.length,
      ...metrics,
    });
    console.log(
      `[${cfg.label}] raw=${allSignals.length} taken=${metrics.trades} totalR=${metrics.totalR} goldenOvl=${metrics.goldenOverlap}`,
    );
  }

  printTable(results, { start: startDate, end: endDate });
  console.log(
    "\n" +
      JSON.stringify({
        window: { start: startDate, end: endDate, sessions: TRADING_DAYS },
        goldenSignalsInWindow: goldenKeys.size,
        variants: results,
      }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
