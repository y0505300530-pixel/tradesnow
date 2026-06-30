/**
 * elzaV45GoldenRun.ts — Elza v4.5 Golden DNA harness (2025 + 2026 YTD)
 *
 * Wide Lung SL | Alpha Mode + VIX Guard | Golden 5:1 scale-out | vs SPY @ 1.0× / 1.9×
 *
 * RUN:
 *   node --import tsx --env-file=.env scripts/elzaV45GoldenRun.ts
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { fetchBarsForTicker } from "../server/marketData";
import { calcEMA, calcRSI, type Bar } from "../server/zivEngine";
import { getTickerIntelligence } from "../server/runtimeIntelligence";
import { ELZA_V45_GOLDEN_CONFIG as CFG } from "../server/engine/elzaV45Golden";
import { loadProductionCatalogueWithStats } from "./lib/productionCatalogue";

const OUT_PATH = "/tmp/elza-v45-golden-results.md";

const SECTOR_BY_TICKER: Record<string, string> = {};
function sectorOf(ticker: string): string {
  return SECTOR_BY_TICKER[ticker] ?? "OTHER";
}

const EMA_20 = 20;
const EMA_50 = 50;
const EMA_200 = 200;
const DONCHIAN_PERIOD = 20;
const ATR_PERIOD = 14;

const LONG_ENTRY_MIN_SCORE = 7.0;
const MIN_CONFLUENCE = 4.5;
const MIN_LIQUIDITY_SCORE = 2.0;

const EARLIEST_WINDOW_START = CFG.WINDOWS.reduce(
  (min, w) => (w.start < min ? w.start : min),
  CFG.WINDOWS[0].start,
);

type FrictionMode = "FRICTIONLESS" | "REALISTIC";
type ExitReason = "SL" | "TIME" | "BE" | "TP_MAX" | "TRAIL" | "TRAIL_OPEN" | "OPEN";

interface GenesisScore {
  tier: "Gold Retest" | "Gold Breakout" | "Breakout Override" | null;
  baseScore: number;
  subScore: number;
  totalScore: number;
  price: number;
  ema20: number;
  ema50: number;
  ema200: number;
}

interface Candidate {
  ticker: string;
  sector: string;
  entryDate: string;
  exitDate: string;
  tier: string;
  totalScore: number;
  entry: number;
  sl: number;
  exitReason: ExitReason;
  goldenScaled: boolean;
  goldenTarget: number;
  maxTarget: number;
  openFrac: number;
  openExitPrice: number;
  stopDistPct: number;
  mfeR: number;
}

interface ClosedTrade {
  ticker: string;
  entryDate: string;
  exitDate: string;
  exitReason: ExitReason;
  r: number;
  pnl: number;
  skipped: boolean;
  mfeR: number;
}

interface CellResult {
  windowLabel: string;
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

interface MacroContext {
  spyByDate: Map<string, { close: number; ema50: number }>;
  vixByDate: Map<string, number>;
}

function computeAtr14Local(window: Bar[]): number | null {
  if (window.length < 2) return null;
  const period = Math.min(ATR_PERIOD, window.length - 1);
  let atrSum = 0;
  for (let i = window.length - period; i < window.length; i++) {
    atrSum += Math.max(
      window[i].high - window[i].low,
      Math.abs(window[i].high - window[i - 1].close),
      Math.abs(window[i].low - window[i - 1].close),
    );
  }
  return atrSum / period;
}

function atrOver(window: Bar[], period: number): number {
  if (window.length < 2) return 0;
  const p = Math.min(period, window.length - 1);
  let sum = 0;
  for (let i = window.length - p; i < window.length; i++) {
    sum += Math.max(
      window[i].high - window[i].low,
      Math.abs(window[i].high - window[i - 1].close),
      Math.abs(window[i].low - window[i - 1].close),
    );
  }
  return sum / p;
}

function hasBullishPA(bars: Bar[]): boolean {
  const lastBar = bars[bars.length - 1];
  const prevBar = bars[bars.length - 2];
  const totalRange = lastBar.high - lastBar.low;
  const bodySize = Math.abs(lastBar.close - lastBar.open);
  const lowerWick = Math.min(lastBar.open, lastBar.close) - lastBar.low;
  const isHammer = totalRange > 0 && lowerWick / totalRange >= 0.55 && bodySize / totalRange <= 0.35;
  const isInsideBar = !!prevBar && lastBar.high <= prevBar.high && lastBar.low >= prevBar.low;
  const isBullishEngulfing = !!prevBar
    && lastBar.close > lastBar.open
    && prevBar.close < prevBar.open
    && lastBar.close > prevBar.open
    && lastBar.open < prevBar.close;
  return isHammer || isInsideBar || isBullishEngulfing;
}

function genesisScore(bars: Bar[], i: number): GenesisScore {
  const NONE: GenesisScore = { tier: null, baseScore: 0, subScore: 0, totalScore: 0, price: 0, ema20: 0, ema50: 0, ema200: 0 };
  if (i < 1) return NONE;

  const window = bars.slice(0, i + 1);
  const closes = window.map(b => b.close);
  const price = closes[closes.length - 1];
  if (!(price > 0)) return NONE;

  const ema20 = calcEMA(closes, EMA_20);
  const ema50 = calcEMA(closes, EMA_50);
  const ema200 = closes.length >= EMA_200 ? calcEMA(closes, EMA_200) : calcEMA(closes, closes.length);

  const weeklyCloses = closes.filter((_, idx) => idx % 5 === 0);
  const weeklyEma50Now = weeklyCloses.length >= 10
    ? calcEMA(weeklyCloses, Math.min(50, weeklyCloses.length))
    : (weeklyCloses[weeklyCloses.length - 1] ?? price);
  const weeklyEma50Prev = weeklyCloses.length >= 14
    ? calcEMA(weeklyCloses.slice(0, -4), Math.min(50, weeklyCloses.length - 4))
    : weeklyEma50Now;
  const weeklyEma50Slope = weeklyEma50Now - weeklyEma50Prev;

  const last20 = window.slice(-DONCHIAN_PERIOD);
  const donchian20High = Math.max(...last20.map(b => b.high));
  const donchian20Low = Math.min(...last20.map(b => b.low));

  const volumes = window.map(b => b.volume ?? 0);
  const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length || 1);
  const avgVol5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, volumes.length || 1);
  const volRatio = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;
  const distEma50 = ema50 > 0 ? Math.abs(price - ema50) / ema50 : 999;
  const bullishPA = hasBullishPA(window);

  let tier: GenesisScore["tier"] = null;
  let baseScore = 0;
  let isBreakoutTier = false;

  if (price >= donchian20High * 0.995 && price > ema50 && price > ema200) {
    tier = "Gold Breakout";
    baseScore = bullishPA ? 10 : 9;
    isBreakoutTier = true;
  } else if (price > ema200 && weeklyEma50Slope > 0 && distEma50 <= 0.03) {
    tier = "Gold Retest";
    baseScore = bullishPA ? 8 : 7;
  } else if (volRatio >= 2.0 && price < ema200) {
    tier = "Breakout Override";
    baseScore = 6;
    isBreakoutTier = true;
  }

  if (tier === null) return NONE;

  const rsi = calcRSI(closes);
  let sub = 0;

  if (isBreakoutTier) {
    if (rsi >= 60 && rsi <= 85) sub += 0.20;
  } else {
    if (rsi >= 50 && rsi <= 70) sub += 0.20;
    else if (rsi > 80) sub += 0.05;
  }

  if (volRatio >= 2.0) sub += 0.20;
  else if (volRatio >= 1.5) sub += 0.16;
  else if (volRatio >= 1.2) sub += 0.12;
  else if (volRatio >= 0.8) sub += 0.06;

  if (distEma50 < 0.03) sub += 0.20 * (1 - distEma50 / 0.03);
  if (ema20 > ema50) sub += 0.15;

  const lookback52w = window.slice(-252);
  const high52w = lookback52w.length > 0 ? Math.max(...lookback52w.map(b => b.high)) : price;
  const pctFrom52w = high52w > 0 ? (high52w - price) / high52w : 1;
  if (pctFrom52w <= 0.02) sub += 0.10;
  else if (pctFrom52w <= 0.05) sub += 0.06;

  const atr5 = atrOver(window, 5);
  const atr14 = atrOver(window, 14);
  if (atr14 > 0 && atr5 < atr14 * 0.75) sub += 0.08;

  let trend = 0;
  const ema50Prev10 = closes.length > 10 ? calcEMA(closes.slice(0, -10), EMA_50) : ema50;
  const ema50SlopePct = ema50Prev10 > 0 ? (ema50 - ema50Prev10) / ema50Prev10 : 0;
  if (ema50SlopePct > 0.02) trend += 0.10;
  const last11 = closes.slice(-11);
  let greenBars = 0;
  for (let k = 1; k < last11.length; k++) if (last11[k] > last11[k - 1]) greenBars++;
  if (greenBars >= 7) trend += 0.06;
  const premiumEma50 = ema50 > 0 ? (price - ema50) / ema50 : 0;
  if (premiumEma50 >= 0.03 && premiumEma50 <= 0.15) trend += 0.04;
  sub += Math.min(0.20, trend);

  let profit = 0;
  const donchianWidth = donchian20High > 0 ? (donchian20High - donchian20Low) / donchian20High : 0;
  if (donchianWidth > 0.15) profit += 0.08;
  const atrPct = price > 0 ? atr14 / price : 0;
  if (atrPct > 0.04) profit += 0.07;
  if (price >= high52w) profit += 0.05;
  sub += Math.min(0.20, profit);

  const subScore = Math.min(0.99, sub);
  return { tier, baseScore, subScore, totalScore: baseScore + subScore, price, ema20, ema50, ema200 };
}

/** Wide Lung SL — v1.0 DNA: max(entry×0.92, EMA-50×0.99). */
function wideLungSl(entry: number, ema50: number): number {
  const slByPct = entry * CFG.SL_PCT_FLOOR;
  const slByEma50 = ema50 * CFG.SL_EMA50_MULT;
  let sl = Math.max(slByPct, slByEma50);
  if (!(sl < entry)) sl = slByPct;
  return sl;
}

function computeTradeR(c: Candidate, friction: FrictionMode): number {
  const real = friction === "REALISTIC";
  const entryFill = real ? c.entry * (1 + CFG.SLIPPAGE_BPS) : c.entry;
  const risk = entryFill - c.sl;
  if (!(risk > 0)) return 0;

  const sell = (px: number): number => (real ? px * (1 - CFG.SLIPPAGE_BPS) : px);
  let r = 0;
  let exitSides = 0;

  if (c.goldenScaled) {
    const gFill = sell(c.goldenTarget);
    r += CFG.GOLDEN_SCALE_FRAC * ((gFill - entryFill) / risk);
    exitSides += 1;
  }
  if (c.openFrac > 0) {
    const oFill = sell(c.openExitPrice);
    r += c.openFrac * ((oFill - entryFill) / risk);
    exitSides += 1;
  }

  if (real) {
    const sharesFull = (CFG.RISK_PCT * CFG.START_EQUITY) / (entryFill - c.sl);
    const commR = sharesFull > 0 ? CFG.COMMISSION_PER_SIDE / (sharesFull * (entryFill - c.sl)) : 0;
    r -= (1 + exitSides) * commR;
  }

  return Math.round(r * 100) / 100;
}

async function generateCandidates(ticker: string, bars: Bar[], out: Candidate[]): Promise<void> {
  let i = 0;
  while (i < bars.length && bars[i].date < EARLIEST_WINDOW_START) i++;

  for (; i < bars.length; i++) {
    if (i + 1 < CFG.MIN_BARS) continue;

    const gs = genesisScore(bars, i);
    if (gs.tier === null || !(gs.totalScore >= LONG_ENTRY_MIN_SCORE)) continue;

    const entry = bars[i].close;
    if (!(entry > 0)) continue;

    const intel = await getTickerIntelligence(ticker, bars.slice(0, i + 1));
    if (!(intel.confluenceScore >= MIN_CONFLUENCE)) continue;
    if (!(intel.liquidityScore >= MIN_LIQUIDITY_SCORE)) continue;

    const sl = wideLungSl(entry, gs.ema50);
    if (!(sl < entry)) continue;
    const stopDistPct = (entry - sl) / entry;
    if (stopDistPct * 100 > CFG.RC2_MAX_RISK_PCT) continue;

    const risk = entry - sl;
    const goldenTarget = entry + CFG.GOLDEN_SCALE_R * risk;
    const maxTarget = entry + CFG.TP_MAX_R * risk;

    let exitDate = bars[bars.length - 1].date;
    let exitReason: ExitReason = "OPEN";
    let goldenScaled = false;
    let openFrac = 1.0;
    let openExitPrice = entry;
    let currentStop = sl;
    let highestHigh = bars[i].high;
    let trailStop = -Infinity;
    let mfeR = 0;
    let closedOut = false;

    for (let j = i + 1; j < bars.length; j++) {
      const bar = bars[j];
      const heldBars = j - i;
      const excursionR = risk > 0 ? (bar.high - entry) / risk : 0;
      if (excursionR > mfeR) mfeR = excursionR;

      if (!goldenScaled) {
        if (bar.low <= currentStop) {
          exitReason = "SL";
          exitDate = bar.date;
          openFrac = 1.0;
          openExitPrice = currentStop;
          closedOut = true;
          break;
        }
        if (bar.high >= goldenTarget) {
          goldenScaled = true;
          openFrac = CFG.RUNNER_FRAC;
          currentStop = entry;
          highestHigh = Math.max(highestHigh, bar.high);
          continue;
        }
        if (heldBars >= CFG.TIME_STOP_BARS) {
          exitReason = "TIME";
          exitDate = bar.date;
          openFrac = 1.0;
          openExitPrice = bar.close;
          closedOut = true;
          break;
        }
        if (j === bars.length - 1) {
          exitReason = "OPEN";
          exitDate = bar.date;
          openFrac = 1.0;
          openExitPrice = bar.close;
          closedOut = true;
        }
      } else {
        if (bar.low <= currentStop) {
          exitReason = currentStop <= entry * 1.0001 ? "BE" : "TRAIL";
          exitDate = bar.date;
          openExitPrice = currentStop;
          closedOut = true;
          break;
        }
        if (bar.high >= maxTarget) {
          exitReason = "TP_MAX";
          exitDate = bar.date;
          openExitPrice = maxTarget;
          closedOut = true;
          break;
        }
        highestHigh = Math.max(highestHigh, bar.high);
        const atr = computeAtr14Local(bars.slice(0, j + 1));
        if (atr != null && atr > 0) {
          trailStop = Math.max(trailStop, highestHigh - CFG.CHANDELIER_ATR_MULT * atr);
          currentStop = Math.max(entry, trailStop);
        }
        if (j === bars.length - 1) {
          exitReason = "TRAIL_OPEN";
          exitDate = bar.date;
          openExitPrice = bar.close;
          closedOut = true;
        }
      }
    }

    if (i === bars.length - 1 && !closedOut) {
      exitDate = bars[i].date;
      exitReason = "OPEN";
      openFrac = goldenScaled ? CFG.RUNNER_FRAC : 1.0;
      openExitPrice = entry;
    }

    out.push({
      ticker,
      sector: sectorOf(ticker),
      entryDate: bars[i].date,
      exitDate,
      tier: gs.tier,
      totalScore: gs.totalScore,
      entry,
      sl,
      exitReason,
      goldenScaled,
      goldenTarget,
      maxTarget,
      openFrac,
      openExitPrice,
      stopDistPct,
      mfeR: Math.round(mfeR * 100) / 100,
    });
  }
}

function macroSlotMultiplier(entryDate: string, macro: MacroContext): { mult: number; blocked: boolean } {
  let mult = 1.0;

  const spy = macro.spyByDate.get(entryDate);
  if (spy) {
    mult *= spy.close > spy.ema50 ? CFG.ALPHA_ATTACK_MULT : CFG.ALPHA_SAFE_HAVEN_MULT;
  }

  const vix = macro.vixByDate.get(entryDate);
  if (vix != null) {
    if (vix > CFG.VIX_BLOCK_THRESHOLD) return { mult: 0, blocked: true };
    if (vix > CFG.VIX_REDUCE_THRESHOLD) mult *= CFG.VIX_REDUCE_MULT;
  }

  return { mult, blocked: false };
}

function buildMacroMaps(spyBars: Bar[], vixBars: Bar[]): MacroContext {
  const spySorted = [...spyBars].sort((a, b) => (a.date < b.date ? -1 : 1));
  const spyByDate = new Map<string, { close: number; ema50: number }>();
  for (let i = 0; i < spySorted.length; i++) {
    const closes = spySorted.slice(0, i + 1).map(b => b.close);
    if (closes.length >= 50) {
      spyByDate.set(spySorted[i].date, {
        close: spySorted[i].close,
        ema50: calcEMA(closes, 50),
      });
    }
  }

  const vixByDate = new Map<string, number>();
  for (const b of vixBars) {
    if (b.close > 0) vixByDate.set(b.date, b.close);
  }

  return { spyByDate, vixByDate };
}

function runPortfolio(
  windowCands: Candidate[],
  friction: FrictionMode,
  windowLabel: string,
  leverage: number,
  macro: MacroContext,
): CellResult {
  const rOf = (c: Candidate) => computeTradeR(c, friction);

  const dates = new Set<string>();
  windowCands.forEach(c => { dates.add(c.entryDate); dates.add(c.exitDate); });
  const sortedDates = [...dates].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const candsByEntryDate = new Map<string, Candidate[]>();
  windowCands.forEach((c, idx) => {
    (c as Candidate & { __idx: number }).__idx = idx;
    const arr = candsByEntryDate.get(c.entryDate) ?? [];
    arr.push(c);
    candsByEntryDate.set(c.entryDate, arr);
  });

  let equity = CFG.START_EQUITY;
  let peakEquity = CFG.START_EQUITY;
  let maxDrawdownPct = 0;
  const openByIdx = new Map<number, { pnl: number; exitDate: string; ticker: string; sector: string; riskDollars: number }>();
  const openTickers = new Set<string>();
  const closed: ClosedTrade[] = [];

  const grossOpenRisk = (): number => {
    let s = 0;
    for (const p of openByIdx.values()) s += p.riskDollars;
    return s;
  };
  const openCountInSector = (sec: string): number => {
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
        exitReason: c.exitReason, r: rOf(c), pnl: pos.pnl, skipped: false, mfeR: c.mfeR,
      });
      if (equity > peakEquity) peakEquity = equity;
      const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }

    const todays = (candsByEntryDate.get(day) ?? [])
      .slice()
      .sort((a, b) => b.totalScore - a.totalScore || a.ticker.localeCompare(b.ticker));

    for (const c of todays) {
      const idx = (c as Candidate & { __idx: number }).__idx;
      if (openByIdx.size >= CFG.MAX_CONCURRENT) break;
      if (openTickers.has(c.ticker)) continue;
      if (openCountInSector(c.sector) >= CFG.MAX_PER_SECTOR) continue;

      const { mult: macroMult, blocked } = macroSlotMultiplier(c.entryDate, macro);
      if (blocked) {
        closed.push({
          ticker: c.ticker, entryDate: c.entryDate, exitDate: c.exitDate,
          exitReason: c.exitReason, r: rOf(c), pnl: 0, skipped: true, mfeR: c.mfeR,
        });
        continue;
      }

      const equityAtEntry = equity;
      let riskDollars = CFG.RISK_PCT * equityAtEntry * macroMult;

      const heatAfter = (grossOpenRisk() + riskDollars) / (equityAtEntry > 0 ? equityAtEntry : 1);
      if (heatAfter > CFG.HEAT_CAP) {
        closed.push({
          ticker: c.ticker, entryDate: c.entryDate, exitDate: c.exitDate,
          exitReason: c.exitReason, r: rOf(c), pnl: 0, skipped: true, mfeR: c.mfeR,
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
    windowLabel,
    leverage,
    tradesTaken: taken.length,
    wins,
    winPct: taken.length ? (wins / taken.length) * 100 : 0,
    totalR: Math.round(taken.reduce((s, t) => s + t.r, 0) * 100) / 100,
    finalReturnPct: ((equity - CFG.START_EQUITY) / CFG.START_EQUITY) * 100,
    maxDrawdownPct: maxDrawdownPct * 100,
    finalEquity: Math.round(equity),
    exitBreakdown,
    closed: taken,
  };
}

function computeSpyBenchmark(
  spyBars: Bar[],
  windowStart: string,
  windowEnd: string | null,
): { returnPct: number; maxDDPct: number; finalEquity: number } | null {
  const inWin = spyBars
    .filter(b => b.date >= windowStart && (windowEnd == null || b.date <= windowEnd))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (inWin.length < 2) return null;
  const base = inWin[0].close;
  let peak = CFG.START_EQUITY;
  let maxDD = 0;
  let last = CFG.START_EQUITY;
  for (const b of inWin) {
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

function buildSummaryTable(
  label: string,
  spy: { returnPct: number; maxDDPct: number; finalEquity: number } | null,
  r1x: CellResult,
  r19x: CellResult,
): string {
  const rows = [
    ["Metric", "SPY B&H", "Elza v4.5 (1.0×)", "Elza v4.5 (1.9×)"],
    ["Net Return", spy ? fmtPct(spy.returnPct) : "N/A", fmtPct(r1x.finalReturnPct), fmtPct(r19x.finalReturnPct)],
    ["Alpha vs SPY", "—", spy ? fmtPct(r1x.finalReturnPct - spy.returnPct) : "N/A", spy ? fmtPct(r19x.finalReturnPct - spy.returnPct) : "N/A"],
    ["Max Drawdown", spy ? fmtPct(-spy.maxDDPct) : "N/A", fmtPct(-r1x.maxDrawdownPct), fmtPct(-r19x.maxDrawdownPct)],
    ["Trades", "—", String(r1x.tradesTaken), String(r19x.tradesTaken)],
    ["Win Rate", "—", `${r1x.winPct.toFixed(1)}%`, `${r19x.winPct.toFixed(1)}%`],
    ["Total R", "—", fmtR(r1x.totalR), fmtR(r19x.totalR)],
    ["Final Equity", spy ? `$${spy.finalEquity.toLocaleString()}` : "N/A", `$${r1x.finalEquity.toLocaleString()}`, `$${r19x.finalEquity.toLocaleString()}`],
  ];
  const header = `| ${rows[0].join(" | ")} |`;
  const sep = `| ${rows[0].map(() => "---").join(" | ")} |`;
  const body = rows.slice(1).map(r => `| ${r.join(" | ")} |`);
  return [`### ${label}`, "", header, sep, ...body].join("\n");
}

async function main(): Promise<void> {
  console.log("Elza v4.5 Golden DNA — Wide Lung + Alpha/VIX + Golden 5:1 — READ-ONLY");
  console.log(`  SL: max(entry×${CFG.SL_PCT_FLOOR}, EMA-50×${CFG.SL_EMA50_MULT})`);
  console.log(`  Golden Scale @ +${CFG.GOLDEN_SCALE_R}R (${CFG.GOLDEN_SCALE_FRAC * 100}% bank) → runner to +${CFG.TP_MAX_R}R / ${CFG.CHANDELIER_ATR_MULT}×ATR`);
  console.log(`  Alpha: SPY>EMA50=100% slot | SPY<EMA50=50% | VIX>${CFG.VIX_REDUCE_THRESHOLD}=-30% | VIX>${CFG.VIX_BLOCK_THRESHOLD}=BLOCK`);
  console.log("");

  const cat = await loadProductionCatalogueWithStats();
  for (const a of cat.assets) SECTOR_BY_TICKER[a.ticker] = a.sector;
  const tickers = cat.assets.map(a => a.ticker);
  console.log(`[CATALOG] ${tickers.length} VIP USA tickers`);

  let spyBars: Bar[] = [];
  let vixBars: Bar[] = [];
  try {
    spyBars = [...(await fetchBarsForTicker("SPY", CFG.BARS_DAYS))].sort((a, b) => (a.date < b.date ? -1 : 1));
    console.log(`[SPY] ${spyBars.length} bars`);
  } catch (e) {
    console.log(`[WARN] SPY: ${(e as Error).message}`);
  }
  try {
    vixBars = [...(await fetchBarsForTicker("^VIX", CFG.BARS_DAYS))].sort((a, b) => (a.date < b.date ? -1 : 1));
    console.log(`[VIX] ${vixBars.length} bars`);
  } catch {
    try {
      vixBars = [...(await fetchBarsForTicker("VIXY", CFG.BARS_DAYS))].sort((a, b) => (a.date < b.date ? -1 : 1));
      console.log(`[VIX] VIXY proxy ${vixBars.length} bars`);
    } catch (e) {
      console.log(`[WARN] VIX unavailable: ${(e as Error).message}`);
    }
  }

  const macro = buildMacroMaps(spyBars, vixBars);

  const barsByTicker = new Map<string, Bar[]>();
  let skipped = 0;
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    if ((i + 1) % 25 === 0) console.log(`[FETCH] ${i + 1}/${tickers.length}`);
    try {
      let bars = await fetchBarsForTicker(ticker, CFG.BARS_DAYS);
      if (!bars || bars.length < CFG.MIN_BARS) { skipped++; continue; }
      bars = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      if (bars[bars.length - 1].date < EARLIEST_WINDOW_START) { skipped++; continue; }
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
    if ((i + 1) % 25 === 0) console.log(`[SCORE] ${i + 1}/${usable.length} (${allCands.length} cands)`);
    await generateCandidates(ticker, barsByTicker.get(ticker)!, allCands);
  }
  console.log(`[CANDS] ${allCands.length} Golden DNA candidates`);

  const mdSections: string[] = [
    "# Elza v4.5 Golden DNA — Results vs SPY",
    "",
    `Universe: ${tickers.length} VIP USA | Usable: ${barsByTicker.size} | Slots: ${CFG.MAX_CONCURRENT}`,
    `SL: Wide Lung max(entry×0.92, EMA-50×0.99) | Exit: Golden 40% @ +2.5R → runner +5R / 2.5×ATR`,
    "",
  ];

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log(" ELZA v4.5 GOLDEN DNA vs SPY");
  console.log("═══════════════════════════════════════════════════════════════════════");

  for (const win of CFG.WINDOWS) {
    const windowCands = allCands.filter(
      c => c.entryDate >= win.start && (win.end == null || c.entryDate <= win.end),
    );
    console.log(`\n[${win.label}] ${windowCands.length} in-window candidates`);

    const r1x = runPortfolio(windowCands, "REALISTIC", win.label, CFG.LEVERAGE_1X, macro);
    const r19x = runPortfolio(windowCands, "REALISTIC", win.label, CFG.LEVERAGE_19X, macro);
    const spy = computeSpyBenchmark(spyBars, win.start, win.end);

    const table = buildSummaryTable(win.label, spy, r1x, r19x);
    mdSections.push(table, "");
    mdSections.push(`Exit breakdown (${win.label}, 1.0×):`);
    mdSections.push(...Object.entries(r1x.exitBreakdown).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`));
    mdSections.push("");

    console.log(table);
    console.log(`Exits: ${JSON.stringify(r1x.exitBreakdown)}`);
  }

  writeFileSync(OUT_PATH, mdSections.join("\n"), "utf8");
  console.log(`\n[SAVED] ${OUT_PATH}`);
}

main().catch(err => {
  console.error(`[FATAL] ${(err as Error).stack ?? err}`);
  process.exit(1);
});
