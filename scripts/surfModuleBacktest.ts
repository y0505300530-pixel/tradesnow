/**
 * surfModuleBacktest.ts — SURF Module 60-day intraday harness (READ-ONLY simulation).
 *
 * Rules (CEO draft v1):
 *   • Capital: 4.0× intraday gross cap on allocated NLV
 *   • Entry: SURF_BREAKOUT — 5m close > prior 5-day Donchian high + intraday RVOL ≥ 2.0
 *   • Stop: Wide Lung max(entry×0.92, EMA50×0.99) from daily bars
 *   • Exit: Micro-Flush @ +60m if profitR < +1.0R | SL | EOD flatten @ 15:45 ET
 *   • Friction: REALISTIC 5bps/side + $1 commission/side
 *
 * RUN:
 *   node --import tsx --env-file=.env scripts/surfModuleBacktest.ts
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

// ── SURF constants (pinned for replay) ───────────────────────────────────────
const TRADING_DAYS = 60;
const INTRADAY_LEV = 4.0;
const ALLOC_PCT = 0.40;
const START_EQUITY = 100_000;
const SURF_RISK_PCT = 0.02;
const MAX_CONCURRENT = 8;
const MAX_POSITION_USD = 85_000;
const DONCHIAN_DAYS = 5;
const SURF_RVOL_MIN = 2.0;
const MICRO_FLUSH_MIN = 60;
const MICRO_FLUSH_MIN_R = 1.0;
const EOD_FLATTEN_MINS = 15 * 60 + 45; // 15:45 ET
const STOP_ENTRY_FLOOR = 0.92;
const STOP_EMA50_MULT = 0.99;
const SLIPPAGE_BPS = 0.0005;
const COMMISSION = 1.0;

type ExitReason = "SL" | "MICRO_FLUSH" | "EOD_FLATTEN";

interface SurfSignal {
  ticker: string;
  date: string;
  entryTs: number;
  entryDt: string;
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
}

function etMins(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function wideLungStop(entry: number, ema50: number): number {
  return Math.max(entry * STOP_ENTRY_FLOOR, ema50 * STOP_EMA50_MULT);
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

function scanSurfSignals(
  ticker: string,
  daily: Bar[],
  bars5m: IntradayBar[],
  sessionDates: Set<string>,
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
    const closes = dailyUpTo.map((b) => b.close);
    const ema50 = calcEMA(closes, Math.min(50, closes.length));

    let entered = false;
    for (let i = 0; i < dayBars.length; i++) {
      if (entered) break;
      const bar = dayBars[i];
      if (bar.close <= breakLevel) continue;

      const hist = rth.filter((b) => b.ts <= bar.ts);
      const rvol = computeIntradayRvol(hist);
      if (rvol == null || rvol < SURF_RVOL_MIN) continue;

      const entry = bar.close;
      const stop = wideLungStop(entry, ema50);
      if (!(stop < entry)) continue;
      const r = entry - stop;

      out.push({
        ticker,
        date,
        entryTs: bar.ts,
        entryDt: bar.datetime,
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

function simulateExit(sig: SurfSignal): Omit<ClosedSurf, "shares" | "pnl" | "pnlR"> {
  const entryFill = frictionEntry(sig.entry);
  const flushDeadline = sig.entryTs + MICRO_FLUSH_MIN * 60_000;
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

interface PortfolioResult {
  trades: ClosedSurf[];
  finalEquity: number;
  returnPct: number;
  maxDrawdownPct: number;
  maxIntradayDrawdownPct: number;
  winPct: number;
  totalR: number;
  exitBreakdown: Record<string, number>;
}

function runPortfolio(signals: SurfSignal[]): PortfolioResult {
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

    const sim = simulateExit(sig);
    const pnl =
      (sim.exit - entryFill) * shares - COMMISSION * 2;

    open.push({
      ...sim,
      shares,
      pnl,
      pnlR: sim.pnlR,
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

  return {
    trades: closed,
    finalEquity: equity,
    returnPct: ((equity - START_EQUITY) / START_EQUITY) * 100,
    maxDrawdownPct: maxDD,
    maxIntradayDrawdownPct: maxIntradayDD,
    winPct: closed.length ? (wins / closed.length) * 100 : 0,
    totalR: +totalR.toFixed(2),
    exitBreakdown,
  };
}

async function main(): Promise<void> {
  console.log("SURF Module — 60-Day Intraday Backtest (5m bars, READ-ONLY)");
  console.log(
    `  Lev ${INTRADAY_LEV}× | Risk ${SURF_RISK_PCT * 100}%/trade | RVOL≥${SURF_RVOL_MIN} | Micro-Flush ${MICRO_FLUSH_MIN}m/<${MICRO_FLUSH_MIN_R}R | EOD ${Math.floor(EOD_FLATTEN_MINS / 60)}:${String(EOD_FLATTEN_MINS % 60).padStart(2, "0")} ET`,
  );
  console.log(`  Friction: ${SLIPPAGE_BPS * 10000}bps/side + $${COMMISSION}/side\n`);

  const tickers = await getCatalogTickers();
  console.log(`[CATALOG] ${tickers.length} VIP tickers`);

  const spyDaily = [...(await fetchBarsForTicker("SPY", 120))].sort((a, b) =>
    a.date < b.date ? -1 : 1,
  );
  const sessionDates = new Set(spyDaily.slice(-TRADING_DAYS - 5).map((b) => b.date));
  const sessionList = [...sessionDates].sort().slice(-TRADING_DAYS);
  const sessionSet = new Set(sessionList);
  const startDate = sessionList[0];
  const endDate = sessionList[sessionList.length - 1];
  console.log(`[WINDOW] ${TRADING_DAYS} sessions: ${startDate} → ${endDate}\n`);

  const allSignals: SurfSignal[] = [];
  let fetched = 0;
  let skipped = 0;

  for (const ticker of tickers) {
    fetched++;
    if (fetched % 25 === 0) console.log(`[FETCH] ${fetched}/${tickers.length}`);
    try {
      const daily = [...(await fetchBarsForTicker(ticker, 120))].sort((a, b) =>
        a.date < b.date ? -1 : 1,
      );
      if (daily.length < 55) {
        skipped++;
        continue;
      }
      const bars5m = await fetchIntradayBarsForTicker(ticker, "5m", startDate, endDate);
      if (!bars5m.length) {
        skipped++;
        continue;
      }
      allSignals.push(...scanSurfSignals(ticker, daily, bars5m, sessionSet));
    } catch {
      skipped++;
    }
  }

  console.log(`[SCAN] ${allSignals.length} raw SURF signals (${skipped} tickers skipped)\n`);

  const result = runPortfolio(allSignals);

  console.log("═══════════════════════════════════════════════════════════");
  console.log(" SURF 60-DAY RESULTS (REALISTIC FRICTION)");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Trades taken     : ${result.trades.length}`);
  console.log(`  Win rate         : ${result.winPct.toFixed(1)}%`);
  console.log(`  Total R          : ${result.totalR >= 0 ? "+" : ""}${result.totalR.toFixed(2)}R`);
  console.log(`  Net return       : ${result.returnPct >= 0 ? "+" : ""}${result.returnPct.toFixed(2)}%`);
  console.log(`  Final equity     : $${result.finalEquity.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`  Max DD (equity)  : ${result.maxDrawdownPct.toFixed(2)}%`);
  console.log(`  Max DD (intraday): ${result.maxIntradayDrawdownPct.toFixed(2)}%`);
  console.log("");
  console.log("  Exit breakdown:");
  for (const [k, v] of Object.entries(result.exitBreakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k}: ${v}`);
  }
  console.log("");
  console.log(
    JSON.stringify({
      window: { start: startDate, end: endDate, sessions: TRADING_DAYS },
      signals: allSignals.length,
      taken: result.trades.length,
      returnPct: +result.returnPct.toFixed(2),
      maxDrawdownPct: +result.maxDrawdownPct.toFixed(2),
      maxIntradayDrawdownPct: +result.maxIntradayDrawdownPct.toFixed(2),
      winPct: +result.winPct.toFixed(1),
      totalR: result.totalR,
      exitBreakdown: result.exitBreakdown,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
