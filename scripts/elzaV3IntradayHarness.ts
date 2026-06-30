/**
 * elzaV3IntradayHarness.ts — Pilot intraday replay for Elza v3 rules (READ-ONLY)
 *
 * Same mechanical rules as elzaV3.ts (shallow EMA touch, EMA-50 reject, 4-session-day
 * +1R fast kill, structural SL, +2R free-roll, Chandelier) but on 60m/15m bars.
 *
 * Macro gate (score, tier, weeklyEma50Slope) still comes from DAILY calcZivEngineScore
 * evaluated once per session — matching how live ZivH uses daily context + intraday timing.
 *
 * RUN (pilot — 8 tickers, 2025 H1):
 *   npx tsx scripts/elzaV3IntradayHarness.ts
 *   npx tsx scripts/elzaV3IntradayHarness.ts --interval=15m --start=2025-01-01 --end=2025-03-31
 *
 * LIMITATIONS (see stdout):
 *   - No DB cache for intraday yet (Yahoo-only, rate-limit sensitive)
 *   - Full 214-ticker × 2yr @ 15m requires chunked batch job (not in this pilot)
 *   - Weekly slope / Ziv tier from daily bars only (no intraday rescore yet)
 */
import "dotenv/config";
import { fetchBarsForTicker } from "../server/marketData";
import {
  fetchIntradayBarsForTicker,
  filterRegularSession,
  sessionDaysBetween,
  type IntradayBar,
  type IntradayInterval,
} from "../server/intradayMarketData";
import { calcZivEngineScore, calcEMA, type Bar, type ZivScoreResult } from "../server/zivEngine";
import { confirmVolume } from "../server/volumeConfirm";

const PILOT_TICKERS = ["NVDA", "META", "GOOGL", "AMZN", "MSFT", "AAPL", "PLTR", "RKLB"];
const DEFAULT_INTERVAL: IntradayInterval = "60m";
const DEFAULT_START = "2025-01-01";
const DEFAULT_END = "2025-06-30";

const ENTRY_MIN_SCORE = 7.5;
const BREAKOUT_MIN_SCORE = 9;
const EMA_TOUCH_PCT = 1.5;
const EMA50_TOUCH_LOOKBACK = 5;
const SL_LOOKBACK = 10;
const RC2_MAX = 12;
const FIRST_TARGET_R = 2;
const FREE_ROLL_FRAC = 0.5;
const CHAND_MULT = 2.5;
const ATR_PERIOD = 14;
const FAST_SESSION_DAYS = 4;
const FAST_MIN_R = 1.0;

function parseArgs() {
  const args = process.argv.slice(2);
  let interval: IntradayInterval = DEFAULT_INTERVAL;
  let start = DEFAULT_START;
  let end = DEFAULT_END;
  for (const a of args) {
    if (a.startsWith("--interval=")) interval = a.split("=")[1] as IntradayInterval;
    if (a.startsWith("--start=")) start = a.split("=")[1];
    if (a.startsWith("--end=")) end = a.split("=")[1];
  }
  return { interval, start, end };
}

function atr14(bars: IntradayBar[], end: number): number | null {
  if (end < 1) return null;
  const slice = bars.slice(0, end + 1);
  const period = Math.min(ATR_PERIOD, slice.length - 1);
  let sum = 0;
  for (let i = slice.length - period; i < slice.length; i++) {
    sum += Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i - 1].close),
      Math.abs(slice[i].low - slice[i - 1].close),
    );
  }
  return sum / period;
}

function touchesEma50(bars: IntradayBar[], i: number): boolean {
  const start = Math.max(10, i - EMA50_TOUCH_LOOKBACK + 1);
  for (let k = start; k <= i; k++) {
    const closes = bars.slice(0, k + 1).map(b => b.close);
    const ema50 = calcEMA(closes, Math.min(50, closes.length));
    if (ema50 > 0 && bars[k].low <= ema50 * 1.002) return true;
  }
  return false;
}

function isShallow(bars: IntradayBar[], i: number): boolean {
  const closes = bars.slice(0, i + 1).map(b => b.close);
  const entry = bars[i].close;
  const e20 = calcEMA(closes, Math.min(20, closes.length));
  const e10 = calcEMA(closes, Math.min(10, closes.length));
  const d20 = e20 > 0 ? Math.abs(entry - e20) / e20 * 100 : 999;
  const d10 = e10 > 0 ? Math.abs(entry - e10) / e10 * 100 : 999;
  return d20 <= EMA_TOUCH_PCT || d10 <= EMA_TOUCH_PCT;
}

function dailyContext(dailyBars: Bar[], sessionDate: string): ZivScoreResult | null {
  const idx = dailyBars.findIndex(b => b.date <= sessionDate);
  if (idx < 49) return null;
  const slice = dailyBars.slice(0, idx + 1);
  try { return calcZivEngineScore(slice); } catch { return null; }
}

function wantsEntry(
  res: ZivScoreResult,
  dailyBars: Bar[],
  intraday: IntradayBar[],
  i: number,
): "shallow" | "breakout" | null {
  if (res.score < ENTRY_MIN_SCORE || res.weeklyEma50Slope <= 0) return null;
  if (touchesEma50(intraday, i)) return null;

  if (res.tier === "Gold Breakout" && res.score >= BREAKOUT_MIN_SCORE) {
    const daySlice = dailyBars.filter(b => b.date <= intraday[i].date);
    if (confirmVolume(daySlice, res.donchian20High, "long").confirmed) return "breakout";
  }
  if (isShallow(intraday, i)) return "shallow";
  return null;
}

interface SimTrade {
  ticker: string;
  entryDatetime: string;
  exitDatetime: string;
  kind: "shallow" | "breakout";
  r: number;
  exitReason: string;
  maxR: number;
}

function simulateTicker(
  ticker: string,
  intraday: IntradayBar[],
  daily: Bar[],
  out: SimTrade[],
): void {
  const bars = filterRegularSession(intraday);
  if (bars.length < 60) return;

  let i = 50;
  while (i < bars.length) {
    const sessionDate = bars[i].date;
    const res = dailyContext(daily, sessionDate);
    if (!res || res.tier === "No Data" || res.tier === "Error") { i++; continue; }

    const kind = wantsEntry(res, daily, bars, i);
    if (!kind) { i++; continue; }

    const entry = bars[i].close;
    const sl = Math.min(...bars.slice(Math.max(0, i - SL_LOOKBACK + 1), i + 1).map(b => b.low));
    if (!(sl < entry)) { i++; continue; }
    if (((entry - sl) / entry) * 100 > RC2_MAX) { i++; continue; }

    const risk = entry - sl;
    const target1R = entry + FAST_MIN_R * risk;
    const target2R = entry + FIRST_TARGET_R * risk;

    let reached2R = false;
    let reached1R = false;
    let maxR = 0;
    let leg1 = 0;
    let leg2 = 0;
    let exitReason = "OPEN";
    let exitIdx = bars.length - 1;
    let currentStop = sl;
    let trail = -Infinity;
    let peak = bars[i].high;

    for (let j = i + 1; j < bars.length; j++) {
      const bar = bars[j];
      maxR = Math.max(maxR, (bar.high - entry) / risk);
      if (bar.high >= target1R) reached1R = true;

      if (!reached2R) {
        if (bar.low <= currentStop) {
          exitReason = "SL"; exitIdx = j; leg1 = (currentStop - entry) / risk; break;
        }
        if (bar.high >= target2R) {
          reached2R = true;
          leg1 = FREE_ROLL_FRAC * FIRST_TARGET_R;
          currentStop = entry;
          peak = Math.max(peak, bar.high);
          const a = atr14(bars, j);
          trail = a ? Math.max(entry, peak - CHAND_MULT * a) : entry;
          currentStop = trail;
          continue;
        }
        const sessDays = sessionDaysBetween(bars, i, j);
        if (sessDays >= FAST_SESSION_DAYS && !reached1R) {
          exitReason = "FAST_TIME"; exitIdx = j; leg1 = (bar.close - entry) / risk; break;
        }
        if (j === bars.length - 1) {
          exitReason = "OPEN"; exitIdx = j; leg1 = (bar.close - entry) / risk;
        }
      } else {
        peak = Math.max(peak, bar.high);
        const a = atr14(bars, j);
        if (a) trail = Math.max(trail, peak - CHAND_MULT * a);
        currentStop = trail;
        if (bar.low <= currentStop) {
          exitReason = "TRAIL"; exitIdx = j;
          leg2 = FREE_ROLL_FRAC * ((currentStop - entry) / risk);
          break;
        }
        if (j === bars.length - 1) {
          exitReason = "TRAIL_OPEN"; exitIdx = j;
          leg2 = FREE_ROLL_FRAC * ((bar.close - entry) / risk);
        }
      }
    }

    out.push({
      ticker,
      entryDatetime: bars[i].datetime,
      exitDatetime: bars[exitIdx].datetime,
      kind,
      r: Math.round((leg1 + leg2) * 100) / 100,
      exitReason,
      maxR: Math.round(maxR * 100) / 100,
    });
    i = exitIdx + 1;
  }
}

async function main() {
  const { interval, start, end } = parseArgs();

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  ELZA v3 INTRADAY PILOT — shallow + fast-kill on sub-daily   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  console.log("INFRA STATUS:");
  console.log("  Daily harness (elzaV3.ts):     fetchBarsForTicker → interval=1d ONLY");
  console.log("  DB priceCache:                 daily YYYY-MM-DD only — NO intraday rows");
  console.log("  This pilot:                    fetchIntradayBarsForTicker → Yahoo 15m/60m");
  console.log("  Live ZivH (ELSA_TRADING_MODE): intraday phase boundaries exist in zivEngine");
  console.log("                                 but backtest harness was daily until now.\n");

  console.log(`Config: ${interval} | ${start} → ${end} | tickers: ${PILOT_TICKERS.join(", ")}\n`);

  const trades: SimTrade[] = [];

  for (const ticker of PILOT_TICKERS) {
    process.stdout.write(`[${ticker}] daily... `);
    let daily: Bar[] = [];
    try {
      daily = [...(await fetchBarsForTicker(ticker, 420))].sort((a, b) => a.date.localeCompare(b.date));
    } catch { console.log("daily FAIL"); continue; }

    process.stdout.write(`${interval}... `);
    let intra: IntradayBar[] = [];
    try {
      intra = await fetchIntradayBarsForTicker(ticker, interval, start, end);
    } catch { console.log("intra FAIL"); continue; }

    const before = trades.length;
    simulateTicker(ticker, intra, daily, trades);
    console.log(`${intra.length} bars → ${trades.length - before} signals`);
    await new Promise(r => setTimeout(r, 300));
  }

  const totalR = trades.reduce((s, t) => s + t.r, 0);
  const wins = trades.filter(t => t.r > 0).length;
  const fast = trades.filter(t => t.exitReason === "FAST_TIME").length;

  console.log(`\n${"═".repeat(56)}`);
  console.log(`PILOT RESULTS (${interval}, ${start}–${end})`);
  console.log(`${"═".repeat(56)}`);
  console.log(`  Signals:     ${trades.length}`);
  console.log(`  Win%:        ${trades.length ? (100 * wins / trades.length).toFixed(1) : 0}%`);
  console.log(`  Total R:     ${totalR >= 0 ? "+" : ""}${totalR.toFixed(2)}R`);
  console.log(`  FAST_TIME:   ${fast} (${trades.length ? (100 * fast / trades.length).toFixed(0) : 0}%)`);
  console.log(`  Shallow:     ${trades.filter(t => t.kind === "shallow").length}`);
  console.log(`  Breakout:    ${trades.filter(t => t.kind === "breakout").length}`);

  if (trades.length > 0) {
    console.log("\n  Sample trades:");
    for (const t of trades.slice(0, 8)) {
      console.log(`    ${t.ticker} ${t.entryDatetime} → ${t.exitDatetime} ${t.r}R ${t.exitReason} maxR=${t.maxR}`);
    }
  }

  console.log("\nNEXT: batch job for full catalogue + SPY benchmark on intraday equity curve.");
  console.log("=== END INTRADAY PILOT ===");
}

main().catch(e => { console.error(e); process.exit(1); });
