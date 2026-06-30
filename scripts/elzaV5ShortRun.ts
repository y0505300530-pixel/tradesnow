/**
 * elzaV5ShortRun.ts — Elza v5 Short Engine harness (2022 bear market)
 *
 * RUN:
 *   node --import tsx --env-file=.env scripts/elzaV5ShortRun.ts
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { fetchBarsForTicker } from "../server/marketData";
import { calcEMA, type Bar } from "../server/zivEngine";
import { ELZA_V5_SHORT_CONFIG as CFG } from "../server/engine/elzaV5Short";
import { loadProductionCatalogueWithStats } from "./lib/productionCatalogue";

const OUT_PATH = "/tmp/elza-v5-short-2022-results.md";

type ExitReason = "SL" | "BE" | "SCALE" | "TRAIL" | "TRAIL_OPEN" | "OPEN";
type FrictionMode = "FRICTIONLESS" | "REALISTIC";

interface Candidate {
  ticker: string;
  sector: string;
  entryDate: string;
  exitDate: string;
  breakdownType: "EMA20" | "EMA50" | "BOTH";
  volumeSpike: boolean;
  totalScore: number;
  entry: number;
  sl: number;
  exitReason: ExitReason;
  scaledOut: boolean;
  scaleTarget: number;
  leg1ExitPrice: number;
  leg2ExitPrice: number;
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
  label: string;
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

function hasBearishPA(bar: Bar, prev: Bar | undefined): boolean {
  if (!prev) return false;
  const body = Math.abs(bar.close - bar.open);
  const range = bar.high - bar.low;
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  const shootingStar = range > 0 && upperWick / range >= 0.55 && body / range <= 0.35;
  const bearEngulf =
    bar.close < bar.open &&
    prev.close > prev.open &&
    bar.close < prev.open &&
    bar.open > prev.close;
  return shootingStar || bearEngulf;
}

interface BreakdownSignal {
  totalScore: number;
  breakdownType: "EMA20" | "EMA50" | "BOTH";
  volumeSpike: boolean;
  ema20: number;
  ema50: number;
  ema200: number;
}

function detectBreakdown(bars: Bar[], i: number): BreakdownSignal | null {
  if (i < 1) return null;
  const closes = bars.slice(0, i + 1).map(b => b.close);
  if (closes.length < CFG.MIN_BARS) return null;

  const bar = bars[i];
  const prev = bars[i - 1];
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const ema200 = closes.length >= 200 ? calcEMA(closes, 200) : calcEMA(closes, closes.length);

  if (!(bar.close < ema200)) return null;

  const crossEma20 = bar.close < ema20 && prev.close >= ema20;
  const crossEma50 = bar.close < ema50 && prev.close >= ema50;
  if (!crossEma20 && !crossEma50) return null;

  const avgVol = avgVolume20(bars, i);
  const barVol = bar.volume ?? 0;
  const volRatio = avgVol > 0 ? barVol / avgVol : 1;
  const volumeSpike = volRatio >= CFG.VOLUME_SPIKE_RATIO;

  let score = 7.0;
  let breakdownType: "EMA20" | "EMA50" | "BOTH";
  if (crossEma20 && crossEma50) breakdownType = "BOTH";
  else if (crossEma20) breakdownType = "EMA20";
  else breakdownType = "EMA50";

  if (breakdownType === "EMA20" || breakdownType === "BOTH") score += 0.5;
  if (breakdownType === "EMA50" || breakdownType === "BOTH") score += 0.3;
  if (volumeSpike) score += 1.0;
  if (hasBearishPA(bar, prev)) score += 0.5;
  score = Math.min(10, Math.round(score * 100) / 100);

  return { totalScore: score, breakdownType, volumeSpike, ema20, ema50, ema200 };
}

function computeShortTradeR(c: Candidate, friction: FrictionMode): number {
  const risk = c.sl - c.entry;
  if (!(risk > 0)) return 0;

  if (friction === "FRICTIONLESS") {
    if (c.scaledOut) {
      const leg1R = CFG.STAGE2_SCALE_FRACTION * CFG.STAGE2_SCALE_R;
      const leg2R = CFG.STAGE2_SCALE_FRACTION * ((c.entry - c.leg2ExitPrice) / risk);
      return Math.round((leg1R + leg2R) * 100) / 100;
    }
    const fullR = (c.entry - c.leg1ExitPrice) / risk;
    return Math.round(fullR * 100) / 100;
  }

  const entryFill = c.entry * (1 - CFG.SLIPPAGE_BPS);
  const riskFill = c.sl - entryFill;
  if (!(riskFill > 0)) return 0;

  const sharesFull = (CFG.RISK_PCT * CFG.START_EQUITY) / riskFill;
  const commR = sharesFull > 0 ? CFG.COMMISSION_PER_SIDE / (sharesFull * riskFill) : 0;

  if (c.scaledOut) {
    const leg1Fill = c.scaleTarget * (1 + CFG.SLIPPAGE_BPS);
    const leg2Fill = c.leg2ExitPrice * (1 + CFG.SLIPPAGE_BPS);
    const leg1R = CFG.STAGE2_SCALE_FRACTION * ((entryFill - leg1Fill) / riskFill);
    const leg2R = CFG.STAGE2_SCALE_FRACTION * ((entryFill - leg2Fill) / riskFill);
    const commTotal = 3 * commR;
    return Math.round((leg1R + leg2R - commTotal) * 100) / 100;
  }

  const exitFill = c.leg1ExitPrice * (1 + CFG.SLIPPAGE_BPS);
  const fullR = (entryFill - exitFill) / riskFill;
  return Math.round((fullR - 2 * commR) * 100) / 100;
}

function simulateTicker(ticker: string, bars: Bar[], out: Candidate[]): void {
  let i = 0;
  while (i < bars.length && bars[i].date < CFG.WARMUP_START) i++;

  for (; i < bars.length; i++) {
    if (bars[i].date > CFG.WINDOW_END) break;

    const sig = detectBreakdown(bars, i);
    if (!sig) continue;

    const breakdownBar = bars[i];
    const entry = breakdownBar.close;
    if (!(entry > 0)) continue;

    const sl = breakdownBar.high * (1 + CFG.SL_ABOVE_BREAKDOWN_BPS);
    if (!(sl > entry)) continue;

    const stopDistPct = (sl - entry) / entry;
    if (stopDistPct * 100 > CFG.RC2_MAX_RISK_PCT) continue;

    const risk = sl - entry;
    const targetBe = entry - CFG.STAGE1_BE_R * risk;
    const targetScale = entry - CFG.STAGE2_SCALE_R * risk;

    let exitDate = bars[bars.length - 1].date;
    let exitReason: ExitReason = "OPEN";
    let currentStop = sl;
    let scaledOut = false;
    let beLocked = false;
    let leg1ExitPrice = entry;
    let leg2ExitPrice = entry;
    let lowestLow = breakdownBar.low;
    let trailStop = Infinity;
    let maxFavorableR = 0;

    let exitIdx = bars.length - 1;

    for (let j = i + 1; j < bars.length; j++) {
      exitIdx = j;
      const bar = bars[j];
      const favR = risk > 0 ? (entry - bar.low) / risk : 0;
      if (favR > maxFavorableR) maxFavorableR = favR;

      if (!scaledOut) {
        if (bar.high >= currentStop) {
          exitReason = beLocked && currentStop <= entry * (1 + 0.0001) ? "BE" : "SL";
          exitDate = bar.date;
          leg1ExitPrice = currentStop;
          break;
        }

        if (bar.low <= targetScale) {
          scaledOut = true;
          beLocked = true;
          leg1ExitPrice = targetScale;
          lowestLow = Math.min(lowestLow, bar.low);
          const atr = computeAtr14(bars.slice(0, j + 1));
          trailStop = atr != null && atr > 0
            ? lowestLow + CFG.STAGE3_CHAND_ATR_MULT * atr
            : entry;
          currentStop = trailStop;
          continue;
        }

        if (!beLocked && bar.low <= targetBe) {
          beLocked = true;
          currentStop = entry;
        }

        if (j === bars.length - 1) {
          exitDate = bar.date;
          leg1ExitPrice = bar.close;
        }
      } else {
        lowestLow = Math.min(lowestLow, bar.low);
        const atr = computeAtr14(bars.slice(0, j + 1));
        if (atr != null && atr > 0) {
          const chand = lowestLow + CFG.STAGE3_CHAND_ATR_MULT * atr;
          trailStop = Math.min(trailStop, chand);
        }
        currentStop = trailStop;

        if (bar.high >= currentStop) {
          exitReason = "TRAIL";
          exitDate = bar.date;
          leg2ExitPrice = currentStop;
          break;
        }
        if (j === bars.length - 1) {
          exitReason = "TRAIL_OPEN";
          exitDate = bar.date;
          leg2ExitPrice = bar.close;
        }
      }
    }

    out.push({
      ticker,
      sector: sectorOf(ticker),
      entryDate: breakdownBar.date,
      exitDate,
      breakdownType: sig.breakdownType,
      volumeSpike: sig.volumeSpike,
      totalScore: sig.totalScore,
      entry,
      sl,
      exitReason,
      scaledOut,
      scaleTarget: targetScale,
      leg1ExitPrice,
      leg2ExitPrice,
      stopDistPct,
      maxFavorableR: Math.round(maxFavorableR * 100) / 100,
    });

    i = exitIdx;
  }
}

function runPortfolio(
  cands: Candidate[],
  friction: FrictionMode,
  label: string,
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
        ticker: c.ticker,
        entryDate: c.entryDate,
        exitDate: c.exitDate,
        exitReason: c.exitReason,
        r: rOf(c),
        pnl: pos.pnl,
        skipped: false,
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
    label,
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

function spyBenchmark2022(spyBars: Bar[]): { returnPct: number; maxDDPct: number } | null {
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
  };
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function fmtR(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}R`;
}

function buildSummaryTable(
  spy: { returnPct: number; maxDDPct: number } | null,
  r1x: CellResult,
  r19x: CellResult,
): string {
  const rows = [
    ["Metric", "SPY B&H 2022", "Elza v5 (1.0×)", "Elza v5 (1.9×)"],
    ["Net Return", spy ? fmtPct(spy.returnPct) : "N/A", fmtPct(r1x.finalReturnPct), fmtPct(r19x.finalReturnPct)],
    ["Alpha vs SPY", "—", spy ? fmtPct(r1x.finalReturnPct - spy.returnPct) : "N/A", spy ? fmtPct(r19x.finalReturnPct - spy.returnPct) : "N/A"],
    ["Max Drawdown", spy ? fmtPct(-spy.maxDDPct) : "N/A", fmtPct(-r1x.maxDrawdownPct), fmtPct(-r19x.maxDrawdownPct)],
    ["Trades Taken", "—", String(r1x.tradesTaken), String(r19x.tradesTaken)],
    ["Win Rate", "—", `${r1x.winPct.toFixed(1)}%`, `${r19x.winPct.toFixed(1)}%`],
    ["Total R", "—", fmtR(r1x.totalR), fmtR(r19x.totalR)],
    ["Final Equity", spy ? `$${Math.round(CFG.START_EQUITY * (1 + spy.returnPct / 100)).toLocaleString()}` : "N/A", `$${r1x.finalEquity.toLocaleString()}`, `$${r19x.finalEquity.toLocaleString()}`],
  ];
  const header = `| ${rows[0].join(" | ")} |`;
  const sep = `| ${rows[0].map(() => "---").join(" | ")} |`;
  const body = rows.slice(1).map(r => `| ${r.join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

function buildTradeTable(trades: ClosedTrade[], cands: Candidate[]): string {
  const header = "| Ticker | Entry | Exit | Breakdown | Vol Spike | Exit Reason | Max Fav R | Net R | PnL $ |";
  const sep = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const body = trades
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.ticker.localeCompare(b.ticker))
    .map(t => {
      const c = cands.find(x => x.ticker === t.ticker && x.entryDate === t.entryDate)!;
      const r = computeShortTradeR(c, "REALISTIC");
      return `| ${t.ticker} | ${t.entryDate} | ${t.exitDate} | ${c.breakdownType} | ${c.volumeSpike ? "YES" : "no"} | ${t.exitReason} | ${fmtR(c.maxFavorableR)} | ${fmtR(r)} | $${Math.round(t.pnl).toLocaleString()} |`;
    });
  return [header, sep, ...body].join("\n");
}

async function main(): Promise<void> {
  console.log("Elza v5 Short Engine — 2022 Bear Market (READ-ONLY)");
  console.log(`  Bear Wall: below EMA-${CFG.BEAR_WALL_EMA} | Breakdown: EMA-${CFG.BREAKDOWN_EMAS.join("/")} cross`);
  console.log(`  Fakeout SL: above breakdown high | Parabolic Lock: +${CFG.STAGE1_BE_R}R BE → +${CFG.STAGE2_SCALE_R}R scale → ${CFG.STAGE3_CHAND_ATR_MULT}×ATR trail`);
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
      let bars = await fetchBarsForTicker(ticker, CFG.BARS_DAYS);
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
  const inWindow = allCands.filter(
    c => c.entryDate >= CFG.WINDOW_START && c.entryDate <= CFG.WINDOW_END,
  );
  console.log(`[SIGNALS] ${allCands.length} total | ${inWindow.length} with entry in 2022`);

  const r1x = runPortfolio(allCands, "REALISTIC", "2022-1.0x", CFG.LEVERAGE_1X);
  const r19x = runPortfolio(allCands, "REALISTIC", "2022-1.9x", CFG.LEVERAGE_19X);

  let spy: { returnPct: number; maxDDPct: number } | null = null;
  try {
    const spyBars = await fetchBarsForTicker("SPY", CFG.BARS_DAYS);
    spy = spyBenchmark2022([...spyBars].sort((a, b) => (a.date < b.date ? -1 : 1)));
  } catch (e) {
    console.log(`[WARN] SPY fetch failed: ${(e as Error).message}`);
  }

  const summary = buildSummaryTable(spy, r1x, r19x);
  const exitLines = Object.entries(r1x.exitBreakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const md = [
    "# Elza v5 Short Engine — 2022 Bear Market Results",
    "",
    `Universe: ${tickers.length} VIP USA | Usable: ${barsByTicker.size}`,
    `Window: ${CFG.WINDOW_START} → ${CFG.WINDOW_END} | Slots: ${CFG.MAX_CONCURRENT}`,
    "",
    "## Portfolio vs SPY",
    "",
    summary,
    "",
    "### Exit breakdown (1.0×)",
    exitLines,
    "",
    "## All Taken Trades (1.0× leverage, REALISTIC friction)",
    "",
    buildTradeTable(r1x.closed, inWindow),
    "",
    `Total: **${r1x.tradesTaken}** trades`,
  ].join("\n");

  writeFileSync(OUT_PATH, md, "utf8");

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log(" ELZA v5 SHORT — 2022 BEAR MARKET vs SPY");
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log(summary);
  console.log("");
  console.log("Exit breakdown (1.0×):");
  console.log(exitLines);
  console.log("");
  console.log(`[SAVED] ${OUT_PATH}`);
}

main().catch(err => {
  console.error(`[FATAL] ${(err as Error).stack ?? err}`);
  process.exit(1);
});
