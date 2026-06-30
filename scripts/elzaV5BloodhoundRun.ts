/**
 * elzaV5BloodhoundRun.ts — Elza v5.0 Bloodhound short harness (2022 crash test)
 *
 * RUN:
 *   node --import tsx --env-file=.env scripts/elzaV5BloodhoundRun.ts
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import type { Bar } from "../server/zivEngine";
import { calcEMA } from "../server/zivEngine";
import { ELZA_V5_BLOODHOUND_CONFIG as CFG } from "../server/engine/elzaV5Bloodhound";
import { loadProductionCatalogueWithStats } from "./lib/productionCatalogue";

const OUT_PATH = "/tmp/elza-v5-bloodhound-2022-results.md";
const TRADELOG_PATH = "/tmp/elza-v5-bloodhound-2022-tradelog.md";

/** Yahoo range=5y — fetchBarsForTicker uses range=2y and cannot reach 2022. */
const DEEP_RANGE = "5y";
const DEEP_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchDeepBars(ticker: string): Promise<Bar[]> {
  const sym = encodeURIComponent(ticker.toUpperCase());
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEEP_TIMEOUT_MS);
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=${DEEP_RANGE}`,
        { signal: controller.signal },
      );
      clearTimeout(timer);
      if (res.status === 429) {
        if (attempt === 0) { await sleep(1500); continue; }
        return [];
      }
      if (!res.ok) return [];
      const data = await res.json().catch(() => null) as Record<string, unknown> | null;
      if (!data) {
        if (attempt === 0) { await sleep(1500); continue; }
        return [];
      }
      const result = (data as { chart?: { result?: Array<Record<string, unknown>> } })?.chart?.result?.[0];
      if (!result) return [];
      const timestamps: number[] = (result.timestamp as number[]) ?? [];
      const q = ((result.indicators as { quote?: Array<Record<string, number[]>> })?.quote?.[0]) ?? {};
      const closes: number[] = q.close ?? [];
      const volumes: number[] = q.volume ?? [];
      const highs: number[] = q.high ?? [];
      const lows: number[] = q.low ?? [];
      const opens: number[] = q.open ?? [];
      return timestamps
        .map((t, i) => ({
          date: new Date(t * 1000).toISOString().slice(0, 10),
          close: closes[i] ?? 0,
          high: highs[i] ?? closes[i] ?? 0,
          low: lows[i] ?? closes[i] ?? 0,
          open: opens[i] ?? closes[i] ?? 0,
          volume: volumes[i] ?? 0,
        }))
        .filter(b => b.close > 0);
    } catch {
      if (attempt === 0) { await sleep(1500); continue; }
      return [];
    }
  }
  return [];
}

type FrictionMode = "FRICTIONLESS" | "REALISTIC";
type ExitReason = "SL" | "BE" | "TP_MAX" | "TRAIL" | "TRAIL_OPEN" | "OPEN";

interface Candidate {
  ticker: string;
  sector: string;
  entryDate: string;
  exitDate: string;
  totalScore: number;
  entry: number;
  sl: number;
  exitReason: ExitReason;
  goldenScaled: boolean;
  scaleTarget: number;
  maxTarget: number;
  openFrac: number;
  openExitPrice: number;
  stopDistPct: number;
  maxFavorableR: number;
}

interface ClosedTrade {
  ticker: string;
  entryDate: string;
  exitDate: string;
  exitReason: ExitReason;
  r: number;
  pnl: number;
  skipped: boolean;
}

interface CellResult {
  leverage: number;
  tradesTaken: number;
  wins: number;
  winPct: number;
  totalR: number;
  finalReturnPct: number;
  maxDrawdownPct: number;
  finalEquity: number;
  exitBreakdown: Record<string, number>;
  closed: ClosedTrade[];
}

const SECTOR_BY_TICKER: Record<string, string> = {};
function sectorOf(ticker: string): string {
  return SECTOR_BY_TICKER[ticker] ?? "OTHER";
}

function computeAtr14(window: Bar[]): number | null {
  if (window.length < 2) return null;
  const period = Math.min(14, window.length - 1);
  let sum = 0;
  for (let i = window.length - period; i < window.length; i++) {
    sum += Math.max(
      window[i].high - window[i].low,
      Math.abs(window[i].high - window[i - 1].close),
      Math.abs(window[i].low - window[i - 1].close),
    );
  }
  return sum / period;
}

function avgVolume20(bars: Bar[], i: number): number {
  const slice = bars.slice(Math.max(0, i - 19), i + 1);
  const vols = slice.map(b => b.volume ?? 0);
  return vols.reduce((a, b) => a + b, 0) / vols.length;
}

/** Wide Lung inverted: max(entry×1.08, EMA-50×1.01). */
function wideLungShortSl(entry: number, ema50: number): number {
  const slByPct = entry * CFG.SL_PCT_CEILING;
  const slByEma50 = ema50 * CFG.SL_EMA50_MULT;
  let sl = Math.max(slByPct, slByEma50);
  if (!(sl > entry)) sl = slByPct;
  return sl;
}

interface Tier5Signal {
  totalScore: number;
  ema50: number;
  donchianLow: number;
  volRatio: number;
}

function detectTier5Breakdown(bars: Bar[], i: number): Tier5Signal | null {
  if (i < CFG.DONCHIAN_PERIOD) return null;
  const closes = bars.slice(0, i + 1).map(b => b.close);
  if (closes.length < CFG.MIN_BARS) return null;

  const bar = bars[i];
  const ema50 = calcEMA(closes, 50);
  if (!(bar.close < ema50)) return null;

  const prior = bars.slice(i - CFG.DONCHIAN_PERIOD, i);
  const donchianLow = Math.min(...prior.map(b => b.low));
  if (!(bar.close < donchianLow)) return null;

  const avgVol = avgVolume20(bars, i);
  const barVol = bar.volume ?? 0;
  const volRatio = avgVol > 0 ? barVol / avgVol : 0;
  if (volRatio < CFG.VOLUME_SPIKE_RATIO) return null;

  let score = CFG.TIER5_BASE_SCORE;
  if (volRatio >= 2.0) score += 0.5;
  if (bar.close < bar.open) score += 0.3;
  score = Math.min(10, Math.round(score * 100) / 100);

  return { totalScore: score, ema50, donchianLow, volRatio };
}

function computeShortTradeR(c: Candidate, friction: FrictionMode): number {
  const real = friction === "REALISTIC";
  const entryFill = real ? c.entry * (1 - CFG.SLIPPAGE_BPS) : c.entry;
  const risk = c.sl - entryFill;
  if (!(risk > 0)) return 0;

  const cover = (px: number): number => (real ? px * (1 + CFG.SLIPPAGE_BPS) : px);
  let r = 0;
  let exitSides = 0;

  if (c.goldenScaled) {
    const scaleFill = cover(c.scaleTarget);
    r += CFG.STAGE2_SCALE_FRAC * ((entryFill - scaleFill) / risk);
    exitSides += 1;
  }
  if (c.openFrac > 0) {
    const openFill = cover(c.openExitPrice);
    r += c.openFrac * ((entryFill - openFill) / risk);
    exitSides += 1;
  }

  if (real) {
    const sharesFull = (CFG.RISK_PCT * CFG.START_EQUITY) / risk;
    const commR = sharesFull > 0 ? CFG.COMMISSION_PER_SIDE / (sharesFull * risk) : 0;
    r -= (1 + exitSides) * commR;
  }

  return Math.round(r * 100) / 100;
}

function simulateTicker(ticker: string, bars: Bar[], out: Candidate[]): void {
  let i = 0;
  while (i < bars.length && bars[i].date < CFG.WARMUP_START) i++;

  for (; i < bars.length; i++) {
    if (bars[i].date > CFG.WINDOW_END) break;

    const sig = detectTier5Breakdown(bars, i);
    if (!sig) continue;

    const entryBar = bars[i];
    const entry = entryBar.close;
    if (!(entry > 0)) continue;

    const sl = wideLungShortSl(entry, sig.ema50);
    if (!(sl > entry)) continue;

    const stopDistPct = (sl - entry) / entry;
    if (stopDistPct * 100 > CFG.RC2_MAX_RISK_PCT) continue;

    const risk = sl - entry;
    const targetBe = entry - CFG.STAGE1_BE_R * risk;
    const targetScale = entry - CFG.STAGE2_SCALE_R * risk;
    const maxTarget = entry - CFG.TP_MAX_R * risk;

    let exitDate = bars[bars.length - 1].date;
    let exitReason: ExitReason = "OPEN";
    let goldenScaled = false;
    let beLocked = false;
    let openFrac = 1.0;
    let openExitPrice = entry;
    let currentStop = sl;
    let lowestLow = entryBar.low;
    let trailStop = Infinity;
    let maxFavorableR = 0;
    let closedOut = false;
    let exitIdx = i;

    for (let j = i + 1; j < bars.length; j++) {
      exitIdx = j;
      const bar = bars[j];
      const favR = risk > 0 ? (entry - bar.low) / risk : 0;
      if (favR > maxFavorableR) maxFavorableR = favR;

      if (!goldenScaled) {
        if (bar.high >= currentStop) {
          exitReason = beLocked && currentStop <= entry * 1.0001 ? "BE" : "SL";
          exitDate = bar.date;
          openFrac = 1.0;
          openExitPrice = currentStop;
          closedOut = true;
          break;
        }

        if (bar.low <= targetScale) {
          goldenScaled = true;
          beLocked = true;
          openFrac = CFG.RUNNER_FRAC;
          lowestLow = Math.min(lowestLow, bar.low);
          const atr = computeAtr14(bars.slice(0, j + 1));
          trailStop = atr != null && atr > 0
            ? lowestLow + CFG.CHANDELIER_ATR_MULT * atr
            : entry;
          currentStop = trailStop;
          continue;
        }

        if (!beLocked && bar.low <= targetBe) {
          beLocked = true;
          currentStop = entry;
        }

        if (j === bars.length - 1) {
          exitReason = "OPEN";
          exitDate = bar.date;
          openFrac = 1.0;
          openExitPrice = bar.close;
          closedOut = true;
        }
      } else {
        if (bar.low <= maxTarget) {
          exitReason = "TP_MAX";
          exitDate = bar.date;
          openExitPrice = maxTarget;
          closedOut = true;
          break;
        }

        lowestLow = Math.min(lowestLow, bar.low);
        const atr = computeAtr14(bars.slice(0, j + 1));
        if (atr != null && atr > 0) {
          const chand = lowestLow + CFG.CHANDELIER_ATR_MULT * atr;
          trailStop = Math.min(trailStop, chand);
        }
        currentStop = trailStop;

        if (bar.high >= currentStop) {
          exitReason = currentStop <= entry * 1.0001 ? "BE" : "TRAIL";
          exitDate = bar.date;
          openExitPrice = currentStop;
          closedOut = true;
          break;
        }

        if (j === bars.length - 1) {
          exitReason = "TRAIL_OPEN";
          exitDate = bar.date;
          openExitPrice = bar.close;
          closedOut = true;
        }
      }
    }

    out.push({
      ticker,
      sector: sectorOf(ticker),
      entryDate: entryBar.date,
      exitDate,
      totalScore: sig.totalScore,
      entry,
      sl,
      exitReason,
      goldenScaled,
      scaleTarget: targetScale,
      maxTarget,
      openFrac,
      openExitPrice,
      stopDistPct,
      maxFavorableR: Math.round(maxFavorableR * 100) / 100,
    });

    i = exitIdx;
  }
}

function runPortfolio(
  cands: Candidate[],
  friction: FrictionMode,
  leverage: number,
): CellResult {
  const windowCands = cands.filter(
    c => c.entryDate >= CFG.WINDOW_START && c.entryDate <= CFG.WINDOW_END,
  );
  const rOf = (c: Candidate) => computeShortTradeR(c, friction);

  const dates = new Set<string>();
  windowCands.forEach(c => { dates.add(c.entryDate); dates.add(c.exitDate); });
  const sortedDates = [...dates].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const byEntry = new Map<string, Candidate[]>();
  windowCands.forEach((c, idx) => {
    (c as Candidate & { __idx: number }).__idx = idx;
    const arr = byEntry.get(c.entryDate) ?? [];
    arr.push(c);
    byEntry.set(c.entryDate, arr);
  });

  let equity = CFG.START_EQUITY;
  let peak = CFG.START_EQUITY;
  let maxDD = 0;
  const openByIdx = new Map<number, { pnl: number; exitDate: string; ticker: string; sector: string; riskDollars: number }>();
  const openTickers = new Set<string>();
  const closed: ClosedTrade[] = [];

  const grossRisk = () => {
    let s = 0;
    for (const p of openByIdx.values()) s += p.riskDollars;
    return s;
  };
  const sectorCount = (sec: string) => {
    let n = 0;
    for (const p of openByIdx.values()) if (p.sector === sec) n++;
    return n;
  };

  for (const day of sortedDates) {
    for (const [idx, pos] of [...openByIdx.entries()]) {
      if (pos.exitDate !== day) continue;
      openByIdx.delete(idx);
      openTickers.delete(pos.ticker);
      equity += pos.pnl;
      const c = windowCands[idx];
      closed.push({
        ticker: c.ticker, entryDate: c.entryDate, exitDate: c.exitDate,
        exitReason: c.exitReason, r: rOf(c), pnl: pos.pnl, skipped: false,
      });
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? (peak - equity) / peak : 0;
      if (dd > maxDD) maxDD = dd;
    }

    const todays = (byEntry.get(day) ?? [])
      .slice()
      .sort((a, b) => b.totalScore - a.totalScore || a.ticker.localeCompare(b.ticker));

    for (const c of todays) {
      const idx = (c as Candidate & { __idx: number }).__idx;
      if (openByIdx.size >= CFG.MAX_CONCURRENT) break;
      if (openTickers.has(c.ticker)) continue;
      if (sectorCount(c.sector) >= CFG.MAX_PER_SECTOR) continue;

      const eqAtEntry = equity;
      let riskDollars = CFG.RISK_PCT * eqAtEntry;

      const heat = (grossRisk() + riskDollars) / (eqAtEntry > 0 ? eqAtEntry : 1);
      if (heat > CFG.HEAT_CAP) {
        closed.push({
          ticker: c.ticker, entryDate: c.entryDate, exitDate: c.exitDate,
          exitReason: c.exitReason, r: rOf(c), pnl: 0, skipped: true,
        });
        continue;
      }

      let notional = riskDollars / c.stopDistPct;
      if (notional > CFG.MAX_POSITION_USD) {
        const scale = CFG.MAX_POSITION_USD / notional;
        notional *= scale;
        riskDollars *= scale;
      }

      const pnl = rOf(c) * riskDollars * leverage;
      openByIdx.set(idx, { pnl, exitDate: c.exitDate, ticker: c.ticker, sector: c.sector, riskDollars });
      openTickers.add(c.ticker);
    }
  }

  const taken = closed.filter(t => !t.skipped);
  const wins = taken.filter(t => t.r > 0).length;
  const exitBreakdown: Record<string, number> = {};
  for (const t of taken) exitBreakdown[t.exitReason] = (exitBreakdown[t.exitReason] ?? 0) + 1;

  return {
    leverage,
    tradesTaken: taken.length,
    wins,
    winPct: taken.length ? (wins / taken.length) * 100 : 0,
    totalR: Math.round(taken.reduce((s, t) => s + t.r, 0) * 100) / 100,
    finalReturnPct: ((equity - CFG.START_EQUITY) / CFG.START_EQUITY) * 100,
    maxDrawdownPct: maxDD * 100,
    finalEquity: Math.round(equity),
    exitBreakdown,
    closed: taken,
  };
}

function spyBenchmark2022(spyBars: Bar[]): { returnPct: number; maxDDPct: number; finalEquity: number } | null {
  const win = spyBars
    .filter(b => b.date >= CFG.WINDOW_START && b.date <= CFG.WINDOW_END)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (win.length < 2) return null;
  const base = win[0].close;
  let peak = CFG.START_EQUITY;
  let maxDD = 0;
  let last = CFG.START_EQUITY;
  for (const b of win) {
    const eq = CFG.START_EQUITY * (b.close / base);
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    if (dd > maxDD) maxDD = dd;
    last = eq;
  }
  return {
    returnPct: ((last - CFG.START_EQUITY) / CFG.START_EQUITY) * 100,
    maxDDPct: maxDD * 100,
    finalEquity: Math.round(last),
  };
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function fmtR(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}R`;
}

function heldDays(entryDate: string, exitDate: string): number {
  const a = new Date(`${entryDate}T12:00:00Z`).getTime();
  const b = new Date(`${exitDate}T12:00:00Z`).getTime();
  return Math.max(1, Math.round((b - a) / 86_400_000));
}

function buildFlightRecorder(
  taken: ClosedTrade[],
  cands: Candidate[],
): string {
  const rows = [...taken].sort((a, b) =>
    a.entryDate.localeCompare(b.entryDate) || a.ticker.localeCompare(b.ticker),
  );
  const header =
    "| Ticker | Entry | Exit | Days | Scaled 40% | Max Fav R | Net R (1.0×) | PnL $ | Exit Reason |";
  const sep = "| --- | --- | --- | ---: | --- | --- | --- | --- | --- |";
  const body = rows.map(t => {
    const c = cands.find(x => x.ticker === t.ticker && x.entryDate === t.entryDate)!;
    const r = computeShortTradeR(c, "REALISTIC");
    return `| ${t.ticker} | ${t.entryDate} | ${t.exitDate} | ${heldDays(t.entryDate, t.exitDate)} | ${c.goldenScaled ? "YES" : "no"} | ${fmtR(c.maxFavorableR)} | ${fmtR(r)} | $${Math.round(t.pnl).toLocaleString()} | ${t.exitReason} |`;
  });
  return [
    "## Flight Recorder — All Taken Trades (1.0× REALISTIC, NO time-stop)",
    "",
    header,
    sep,
    ...body,
    "",
    `Total: **${rows.length}** trades`,
  ].join("\n");
}

async function main(): Promise<void> {
  console.log("Elza v5.0 Bloodhound — 2022 Short Crash Test (READ-ONLY)");
  console.log(`  Tier-5: Donchian-${CFG.DONCHIAN_PERIOD} breakdown + below EMA-50 + vol≥${CFG.VOLUME_SPIKE_RATIO}x`);
  console.log(`  Wide Lung SL: max(entry×${CFG.SL_PCT_CEILING}, EMA-50×${CFG.SL_EMA50_MULT})`);
  console.log(`  Golden Short: +${CFG.STAGE1_BE_R}R BE → +${CFG.STAGE2_SCALE_R}R scale ${CFG.STAGE2_SCALE_FRAC * 100}% → runner +${CFG.TP_MAX_R}R / ${CFG.CHANDELIER_ATR_MULT}×ATR`);
  console.log(`  TIME-STOP / Fast Kill: OFF (exit = SL | BE | TP_MAX | TRAIL only)`);
  console.log("");

  const cat = await loadProductionCatalogueWithStats();
  for (const a of cat.assets) SECTOR_BY_TICKER[a.ticker] = a.sector;
  const tickers = cat.assets.map(a => a.ticker);
  console.log(`[CATALOG] ${tickers.length} VIP USA tickers`);

  const barsByTicker = new Map<string, Bar[]>();
  let skipped = 0;
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    if ((i + 1) % 25 === 0) console.log(`[FETCH] ${i + 1}/${tickers.length}`);
    try {
      let bars = await fetchDeepBars(ticker);
      if (!bars || bars.length < CFG.MIN_BARS) { skipped++; continue; }
      bars = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      if (bars[bars.length - 1].date < CFG.WINDOW_START) { skipped++; continue; }
      barsByTicker.set(ticker, bars);
    } catch {
      skipped++;
    }
  }
  console.log(`[FETCH DONE] ${barsByTicker.size} usable (${skipped} skipped)`);

  const allCands: Candidate[] = [];
  const usable = [...barsByTicker.keys()];
  for (let i = 0; i < usable.length; i++) {
    const ticker = usable[i];
    if ((i + 1) % 25 === 0) console.log(`[SIM] ${i + 1}/${usable.length} (${allCands.length} signals)`);
    simulateTicker(ticker, barsByTicker.get(ticker)!, allCands);
  }
  const in2022 = allCands.filter(
    c => c.entryDate >= CFG.WINDOW_START && c.entryDate <= CFG.WINDOW_END,
  );
  console.log(`[SIGNALS] ${allCands.length} total | ${in2022.length} entry in 2022`);

  const r1x = runPortfolio(allCands, "REALISTIC", CFG.LEVERAGE_1X);
  const r19x = runPortfolio(allCands, "REALISTIC", CFG.LEVERAGE_19X);

  let spy: { returnPct: number; maxDDPct: number; finalEquity: number } | null = null;
  try {
    const spyBars = await fetchDeepBars("SPY");
    spy = spyBenchmark2022([...spyBars].sort((a, b) => (a.date < b.date ? -1 : 1)));
  } catch (e) {
    console.log(`[WARN] SPY: ${(e as Error).message}`);
  }

  const table = [
    "| Metric | SPY B&H 2022 | Bloodhound (1.0×) | Bloodhound (1.9×) |",
    "| --- | --- | --- | --- |",
    `| Net Return | ${spy ? fmtPct(spy.returnPct) : "N/A"} | ${fmtPct(r1x.finalReturnPct)} | ${fmtPct(r19x.finalReturnPct)} |`,
    `| Alpha vs SPY | — | ${spy ? fmtPct(r1x.finalReturnPct - spy.returnPct) : "N/A"} | ${spy ? fmtPct(r19x.finalReturnPct - spy.returnPct) : "N/A"} |`,
    `| Max Drawdown | ${spy ? fmtPct(-spy.maxDDPct) : "N/A"} | ${fmtPct(-r1x.maxDrawdownPct)} | ${fmtPct(-r19x.maxDrawdownPct)} |`,
    `| Trades | — | ${r1x.tradesTaken} | ${r19x.tradesTaken} |`,
    `| Win Rate | — | ${r1x.winPct.toFixed(1)}% | ${r19x.winPct.toFixed(1)}% |`,
    `| Total R | — | ${fmtR(r1x.totalR)} | ${fmtR(r19x.totalR)} |`,
    `| Final Equity | ${spy ? `$${spy.finalEquity.toLocaleString()}` : "N/A"} | $${r1x.finalEquity.toLocaleString()} | $${r19x.finalEquity.toLocaleString()} |`,
  ].join("\n");

  const exitLines = Object.entries(r1x.exitBreakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const windowCands = allCands.filter(
    c => c.entryDate >= CFG.WINDOW_START && c.entryDate <= CFG.WINDOW_END,
  );
  const flight = buildFlightRecorder(r1x.closed, windowCands);

  const md = [
    "# Elza v5.0 Bloodhound — 2022 Short Crash Test",
    "",
    `Universe: ${tickers.length} VIP USA | Usable: ${barsByTicker.size} | Slots: ${CFG.MAX_CONCURRENT}`,
    `TIME-STOP / Fast Kill: **DISABLED**`,
    "",
    table,
    "",
    "### Exit breakdown (1.0×)",
    exitLines,
    "",
    flight,
  ].join("\n");

  writeFileSync(OUT_PATH, md, "utf8");
  writeFileSync(TRADELOG_PATH, flight, "utf8");

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log(" ELZA v5.0 BLOODHOUND — 2022 vs SPY");
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log(table);
  console.log("");
  console.log("Exit breakdown (1.0×):");
  console.log(exitLines);
  console.log("");
  console.log(flight);
  console.log("");
  console.log(`[SAVED] ${OUT_PATH}`);
  console.log(`[SAVED] ${TRADELOG_PATH}`);
}

main().catch(err => {
  console.error(`[FATAL] ${(err as Error).stack ?? err}`);
  process.exit(1);
});
