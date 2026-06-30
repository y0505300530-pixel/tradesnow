/**
 * Elza backtest v2 — proposed engine improvements (2026)
 * Run: npx tsx scripts/elza-backtest-v2.ts
 *
 * Changes vs baseline elza-backtest.ts:
 *  1. score_decay guard — grace period, skip if >1R profit, higher floor after TP1
 *  2. Shorts only in BEAR regime
 *  3. Hybrid breakout — momentum names bypass goldBreakout kill-switch with volume confirm
 *  4. Chandelier trailing after partial TP1 (2×ATR from peak)
 *  5. One pyramid add (33%) on EMA-50 retest after TP1
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { getDb, getBulkCachedPrices, getUserAssets } from "../server/db";
import { calcZivEngineScore, calcEMA } from "../server/zivEngine";
import { calcBearScore } from "../server/shortEngine";
import { calcEntrySlTp, calcTarget1Price, ema50FromBars } from "../server/slCalculator";
import { calcCorrelation } from "../server/runtimeIntelligence";
import { classifyCyclePhaseFromBars } from "../server/cyclePhaseEngine";
import { classifyWeeklyTrend, evaluateWeeklyGate } from "../server/weeklyTrend";
import { detectZones, evaluateZoneGate } from "../server/zonesEngine";
import { evaluateRetestV2 } from "../server/trueRetestEngine";
import { confirmVolume } from "../server/volumeConfirm";
import { liveEngineConfig } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import type { LiveEngineConfig } from "../drizzle/schema";

const MIN_CONFLUENCE = 4.5;
const MIN_LIQUIDITY_SCORE = 2.0;
const MAX_CORRELATION = 0.80;
const MAX_POSITIONS_PER_SECTOR = 3;
const MAX_SECTOR_EQUITY_PCT = 0.20;
const PARTIAL_TP1_R = 1.5;
const PARTIAL_TP2_R = 2.5;
const PARTIAL_TP1_FRAC = 0.33;
const PARTIAL_TP2_FRAC = 0.33;
const TRAILING_FROM_PEAK = 0.15;
const BREAKEVEN_TRIGGER_R = 1.5;
const LONG_EXIT_SCORE_MIN = 3.5;
const SHORT_EXIT_SCORE_MIN = 3.5;
const LONG_EXIT_SCORE_MIN_AFTER_TP1 = 5.0;
const SCORE_DECAY_GRACE_DAYS = 8;
const SCORE_DECAY_MIN_R = 1.0;

const COMMISSION = 2.5;
const SLIPPAGE = 0.001;

const LOOKBACK_START = "2023-09-01";
const BACKTEST_START = "2024-01-01";
const BACKTEST_END = "2025-12-31";
const WEAK_BREADTH_PCT_HARD = 0.70;
const USER_ID = 1;

type Bar = { date: string; open: number; high: number; low: number; close: number; volume: number };

interface Position {
  ticker: string;
  direction: "long" | "short";
  sector: string;
  entryDate: string;
  entryPrice: number;
  units: number;
  initialUnits: number;
  notional: number;
  stopLoss: number;
  takeProfit: number;
  initialSl: number;
  extremePrice: number;
  partialTp1Done: boolean;
  partialTp2Done: boolean;
  slAtBreakeven: boolean;
  pyramidDone: boolean;
  realizedPnl: number;
  entryScore: number;
}

interface ClosedTrade {
  ticker: string;
  direction: "long" | "short";
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  exitReason: string;
  entryScore: number;
}

interface ElzaConfig {
  totalNlv: number;
  cashBudget: number;
  allocatedCapital: number;
  overnightCap: number;
  perPositionUsd: number;
  minPositionUsd: number;
  maxPositionUsd: number;
  maxLong: number;
  maxShort: number;
  maxTotal: number;
  intradayMultiplier: number;
  overnightMultiplier: number;
}

interface WarGateConfig {
  kronosOn: boolean;
  zivStructuralCap: number;
  zivStructuralFloor: number;
  zivOnlyFloor: number;
  combinedGate: number;
  goldBreakoutEnabled: boolean;
  bearBreakdownEnabled: boolean;
  weeklyAnchorEnabled: boolean;
  zonesGateEnabled: boolean;
  retestV2Enabled: boolean;
  volumeConfirmEnabled: boolean;
  cyclePhaseGateEnabled: boolean;
  breadthThreshold: number;
  riskSizingEnabled: boolean;
  structuralExitsEnabled: boolean;
}

function buildElzaConfig(cfg: LiveEngineConfig): ElzaConfig {
  const nlv = cfg.totalNlv ?? 120_000;
  const allocPct = (cfg.allocatedPct ?? 100) / 100;
  const cashBudget = nlv * allocPct;
  const intMult = cfg.intradayMultiplier ?? 3.5;
  const ovrMult = cfg.overnightMultiplier ?? 1.5;
  const allocatedCapital = cashBudget * intMult;
  const overnightCap = cashBudget * ovrMult;
  const sizePct = (cfg.positionSizePct ?? 50) / 100;
  const rawPos = nlv * sizePct;
  const minPos = cfg.minPositionUsd ?? 20_000;
  const maxPos = cfg.maxPositionUsd ?? 70_000;
  const perPositionUsd = Math.min(Math.max(rawPos, minPos), maxPos);

  return {
    totalNlv: nlv,
    cashBudget,
    allocatedCapital,
    overnightCap,
    perPositionUsd,
    minPositionUsd: minPos,
    maxPositionUsd: maxPos,
    maxLong: cfg.maxLongPositions ?? cfg.maxPositions ?? 12,
    maxShort: cfg.maxShortPositions ?? 6,
    maxTotal: cfg.maxPositions ?? 12,
    intradayMultiplier: intMult,
    overnightMultiplier: ovrMult,
  };
}

function buildWarGateConfig(cfg: LiveEngineConfig): WarGateConfig {
  return {
    kronosOn: (cfg.kronosConvictionWeight ?? 0) >= 0.5,
    zivStructuralCap: cfg.zivStructuralCap ?? 7.5,
    zivStructuralFloor: cfg.zivStructuralFloor ?? 6.5,
    zivOnlyFloor: cfg.zivOnlyFloor ?? 7.5,
    combinedGate: cfg.combinedGate ?? 8.0,
    goldBreakoutEnabled: (cfg.goldBreakoutEnabled ?? 0) === 1,
    bearBreakdownEnabled: (cfg.bearBreakdownEnabled ?? 0) === 1,
    weeklyAnchorEnabled: (cfg.weeklyAnchorEnabled ?? 0) === 1,
    zonesGateEnabled: (cfg.zonesGateEnabled ?? 0) === 1,
    retestV2Enabled: (cfg.retestV2Enabled ?? 0) === 1,
    volumeConfirmEnabled: (cfg.volumeConfirmEnabled ?? 0) === 1,
    cyclePhaseGateEnabled: (cfg.cyclePhaseGateEnabled ?? 1) === 1,
    breadthThreshold: cfg.breadthThreshold ?? 0.55,
    riskSizingEnabled: (cfg.riskSizingEnabled ?? 0) === 1,
    structuralExitsEnabled: (cfg.structuralExitsEnabled ?? 0) === 1,
  };
}

function isUsaTicker(ticker: string): boolean {
  const t = ticker.toUpperCase();
  return !t.endsWith(".TA") && !t.endsWith(".USD") && !/^\d/.test(t);
}

function calcATR(bars: Bar[], period = 14): number {
  if (bars.length < 2) return 0;
  const n = Math.min(period, bars.length - 1);
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    sum += tr;
  }
  return sum / n;
}

function isMomentumBreakout(histBars: Bar[]): boolean {
  if (histBars.length < 50) return false;
  const ziv = calcZivEngineScore(histBars);
  const closes = histBars.map(b => b.close);
  const lookback = Math.min(252, closes.length);
  const high52 = Math.max(...closes.slice(-lookback));
  const lastClose = closes[closes.length - 1];
  const near52wHigh = lastClose >= high52 * 0.90;
  const volOk = confirmVolume(histBars, ziv.donchian20High, "long").confirmed;
  const vols = histBars.map(b => b.volume ?? 0).filter(v => v > 0);
  const avgVol20 = vols.slice(-20).reduce((a, v) => a + v, 0) / Math.min(20, vols.length);
  const lastVol = vols[vols.length - 1] ?? 0;
  const relVol = avgVol20 > 0 ? lastVol / avgVol20 : 1;
  return (ziv.tier === "Gold Breakout" || near52wHigh) && volOk && relVol >= 1.8;
}

function getTickerIntelligence(bars: Bar[], direction: "long" | "short") {
  if (bars.length < 30) {
    return { liquidityScore: 5, weeklyAligned: true, confluenceScore: 5 };
  }
  const vols = bars.map(x => x.volume ?? 0).filter(v => v > 0);
  const avgVol20 = vols.slice(-20).reduce((a, v) => a + v, 0) / Math.min(20, vols.length);
  const avgVol5 = vols.slice(-5).reduce((a, v) => a + v, 0) / 5;
  const relVol = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;
  const liquidityScore = Math.min(10, relVol * 5);

  const closes = bars.map(x => x.close);
  const weeklyC: number[] = [];
  for (let i = 4; i < bars.length; i += 5) weeklyC.push(closes[i]);
  const wEma = weeklyC.length >= 6 ? calcEMA(weeklyC, Math.min(50, weeklyC.length)) : closes[closes.length - 1];
  const wEmaPrev = weeklyC.length >= 9 ? calcEMA(weeklyC.slice(0, -3), Math.min(50, weeklyC.length - 3)) : wEma;
  const weeklySlope = (wEma - wEmaPrev) / wEmaPrev;
  const weeklyAligned = direction === "long" ? weeklySlope > -0.005 : weeklySlope < 0.005;

  const ema50now = calcEMA(closes, Math.min(50, closes.length));
  const ema50prev = calcEMA(closes.slice(0, -3), Math.min(50, closes.length - 3));
  const priceNow = closes[closes.length - 1];
  const pricePrev = closes[closes.length - 4];
  const distNow = (priceNow - ema50now) / ema50now;
  const distPrev = (pricePrev - ema50prev) / ema50prev;
  const momentumVelocity = (distNow - distPrev) * 100;

  let conf = 5;
  if (direction === "long" && weeklySlope > 0.002) conf += 2;
  if (direction === "short" && weeklySlope < -0.002) conf += 2;
  if (relVol > 1.2) conf += 1.5;
  if (direction === "long" && momentumVelocity > 0.3) conf += 1.5;
  if (direction === "short" && momentumVelocity < -0.3) conf += 1.5;

  return { liquidityScore, weeklyAligned, confluenceScore: Math.min(10, conf) };
}

function getHistoricalRegime(spyBars: Bar[], asOfDate: string) {
  const idx = spyBars.findIndex(b => b.date >= asOfDate);
  const slice = spyBars.slice(0, idx >= 0 ? idx + 1 : spyBars.length);
  if (slice.length < 60) {
    return { regime: "NEUTRAL" as const, longOk: true, shortOk: true };
  }
  const closes = slice.map(b => b.close);
  const weeklyCloses: number[] = [];
  for (let i = 4; i < slice.length; i += 5) weeklyCloses.push(closes[i]);
  const ema50Now = calcEMA(weeklyCloses, Math.min(50, weeklyCloses.length));
  const ema50Prev = calcEMA(weeklyCloses.slice(0, -3), Math.min(50, weeklyCloses.length - 3));
  const spyEmaSlope = weeklyCloses.length >= 53 ? ((ema50Now - ema50Prev) / ema50Prev) * 100 : 0;

  const last10 = closes.slice(-11);
  const dailyReturns = last10.slice(1).map((c, i) => (c - last10[i]) / last10[i]);
  const avgReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const vixProxy = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / dailyReturns.length) * Math.sqrt(252) * 100;

  let regime: "BULL" | "NEUTRAL" | "BEAR";
  if (spyEmaSlope > 0.3 && vixProxy < 25) regime = "BULL";
  else if (spyEmaSlope < -0.3 || vixProxy > 35) regime = "BEAR";
  else regime = "NEUTRAL";

  return { regime, longOk: regime !== "BEAR", shortOk: regime !== "BULL" };
}

function computeBreadthPctBelow200(day: string, tickers: string[], priceMap: Record<string, Bar[]>) {
  let scored = 0;
  let below = 0;
  for (const t of tickers) {
    const histBars = barsUpTo(priceMap[t] ?? [], day);
    if (histBars.length < 50) continue;
    const closes = histBars.map(b => b.close);
    const ema200 = calcEMA(closes, Math.min(200, closes.length));
    const last = closes[closes.length - 1];
    if (ema200 > 0 && last > 0) {
      scored++;
      if (last < ema200) below++;
    }
  }
  return scored > 0 ? below / scored : 0.5;
}

function applyBreadthGate(
  base: ReturnType<typeof getHistoricalRegime>,
  breadthPctBelow200: number,
  breadthThreshold: number,
) {
  const weakBreadth = breadthPctBelow200 >= breadthThreshold;
  const broadRout = breadthPctBelow200 >= WEAK_BREADTH_PCT_HARD;
  return {
    ...base,
    longOk: base.regime !== "BEAR" && !broadRout,
    // v2: shorts only in BEAR — ignore breadth-based short allowance in bull/neutral
    shortOk: base.regime === "BEAR",
    breadthPctBelow200,
  };
}

function passesLongWarGates(
  histBars: Bar[],
  gates: WarGateConfig,
  signalBias: string | undefined,
): { pass: boolean; finalScore: number } {
  const ziv = calcZivEngineScore(histBars);
  const zivStructural = Math.min(ziv.score, gates.zivStructuralCap);
  const gateFloor = gates.kronosOn ? gates.zivStructuralFloor : gates.zivOnlyFloor;
  if (zivStructural < gateFloor) return { pass: false, finalScore: ziv.score };

  if (ziv.tier === "Gold Breakout" && !gates.goldBreakoutEnabled) {
    const volOk = gates.volumeConfirmEnabled && confirmVolume(histBars, ziv.donchian20High, "long").confirmed;
    const hybridOk = isMomentumBreakout(histBars);
    if (!volOk && !hybridOk) return { pass: false, finalScore: ziv.score };
  }
  if (gates.kronosOn && zivStructural < gates.combinedGate) return { pass: false, finalScore: ziv.score };

  const wt = classifyWeeklyTrend(histBars);
  const zones = detectZones(histBars, { trend: wt.direction === "down" ? "down" : "up" });
  if (gates.weeklyAnchorEnabled && !evaluateWeeklyGate(wt, "long").pass) return { pass: false, finalScore: ziv.score };
  if (gates.zonesGateEnabled && !evaluateZoneGate(zones, histBars[histBars.length - 1].close, "long").inZone) {
    return { pass: false, finalScore: ziv.score };
  }
  if (gates.retestV2Enabled && gates.zonesGateEnabled) {
    const zg = evaluateZoneGate(zones, histBars[histBars.length - 1].close, "long");
    if (zg.zone && !evaluateRetestV2({ zone: zg.zone, direction: "long", priceAtSignal: histBars[histBars.length - 1].close, isFirstRetest: true }, histBars, ziv.retestLevel ?? null).valid) {
      return { pass: false, finalScore: ziv.score };
    }
  }
  const cyc = classifyCyclePhaseFromBars(histBars);
  if (gates.cyclePhaseGateEnabled && cyc?.longGate === "BLOCK") return { pass: false, finalScore: ziv.score };
  if (signalBias === "REJECTED") return { pass: false, finalScore: ziv.score };

  return { pass: true, finalScore: ziv.score };
}

function passesShortWarGates(
  histBars: Bar[],
  gates: WarGateConfig,
  signalBias: string | undefined,
): { pass: boolean; finalScore: number } {
  const bear = calcBearScore(histBars);
  const zivStructural = Math.min(bear.score, gates.zivStructuralCap);
  const gateFloor = gates.kronosOn ? gates.zivStructuralFloor : gates.zivOnlyFloor;
  if (zivStructural < gateFloor) return { pass: false, finalScore: bear.score };

  const donchian20Low = Math.min(...histBars.slice(-20).map(b => b.low));
  if (bear.tier === "Bear Breakdown" && !gates.bearBreakdownEnabled
    && !(gates.volumeConfirmEnabled && confirmVolume(histBars, donchian20Low, "short").confirmed)) {
    return { pass: false, finalScore: bear.score };
  }
  if (gates.kronosOn && zivStructural < gates.combinedGate) return { pass: false, finalScore: bear.score };

  const wt = classifyWeeklyTrend(histBars);
  const zones = detectZones(histBars, { trend: wt.direction === "down" ? "down" : "up" });
  if (gates.weeklyAnchorEnabled && !evaluateWeeklyGate(wt, "short").pass) return { pass: false, finalScore: bear.score };
  if (gates.zonesGateEnabled && !evaluateZoneGate(zones, histBars[histBars.length - 1].close, "short").inZone) {
    return { pass: false, finalScore: zivStructural };
  }
  if (gates.retestV2Enabled && gates.zonesGateEnabled) {
    const zg = evaluateZoneGate(zones, histBars[histBars.length - 1].close, "short");
    if (zg.zone && !evaluateRetestV2({ zone: zg.zone, direction: "short", priceAtSignal: histBars[histBars.length - 1].close, isFirstRetest: true }, histBars, null).valid) {
      return { pass: false, finalScore: bear.score };
    }
  }
  const cyc = classifyCyclePhaseFromBars(histBars);
  if (gates.cyclePhaseGateEnabled && cyc?.shortGate === "BLOCK") return { pass: false, finalScore: bear.score };
  if (signalBias === "REJECTED") return { pass: false, finalScore: bear.score };

  return { pass: true, finalScore: bear.score };
}

function barsUpTo(allBars: Bar[], date: string): Bar[] {
  const idx = allBars.findIndex(b => b.date > date);
  return idx === -1 ? allBars : allBars.slice(0, idx);
}

function tradingDaysHeld(entryDate: string, currentDay: string, tradingDays: string[]): number {
  const startIdx = tradingDays.indexOf(entryDate);
  const endIdx = tradingDays.indexOf(currentDay);
  if (startIdx < 0 || endIdx < 0) return 999;
  return endIdx - startIdx;
}

function profitR(entry: number, sl: number, price: number, direction: "long" | "short") {
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return 0;
  return direction === "long" ? (price - entry) / risk : (entry - price) / risk;
}

function legPnl(entry: number, exit: number, units: number, direction: "long" | "short") {
  return direction === "long"
    ? (exit - entry) * units - COMMISSION
    : (entry - exit) * units - COMMISSION;
}

function mtmPosition(pos: Position, price: number) {
  const unrealized = pos.direction === "long"
    ? (price - pos.entryPrice) * pos.units
    : (pos.entryPrice - price) * pos.units;
  return pos.realizedPnl + unrealized;
}

function deployedNotional(positions: Position[]) {
  return positions.reduce((s, p) => s + p.units * p.entryPrice, 0);
}

function weekKey(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  const day = d.getUTCDay();
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

function buildWeeklyEquity(
  equityCurve: { date: string; equity: number; cash: number; positions: number; longs: number; shorts: number }[],
) {
  const byWeek = new Map<string, typeof equityCurve[0]>();
  for (const pt of equityCurve) {
    byWeek.set(weekKey(pt.date), pt);
  }
  return [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekStart, pt]) => ({
      weekStart,
      weekEnd: pt.date,
      equity: Math.round(pt.equity * 100) / 100,
      returnFromStartPct: 0,
      wowChangePct: 0,
      positions: pt.positions,
      longs: pt.longs,
      shorts: pt.shorts,
    }));
}

async function main() {
  console.log("=== Elza Backtest V2 (Proposed Improvements) ===");

  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const cfgRows = await db.select().from(liveEngineConfig).where(eq(liveEngineConfig.userId, USER_ID));
  const liveCfg = cfgRows[0];
  if (!liveCfg) throw new Error("liveEngineConfig not found for user 1");

  const elza = buildElzaConfig(liveCfg);
  const gates = buildWarGateConfig(liveCfg);
  const STARTING_CAPITAL = elza.cashBudget;

  console.log(`Period: ${BACKTEST_START} → ${BACKTEST_END}`);
  console.log("V2 improvements: score_decay guard | shorts BEAR-only | hybrid breakout | chandelier after TP1 | pyramid on EMA50 retest");

  const assets = await getUserAssets(USER_ID);
  const usaAssets = assets.filter(a => isUsaTicker(a.ticker));
  const universe = [...new Set(["SPY", ...usaAssets.map(a => a.ticker.toUpperCase())])];
  const priceMap = await getBulkCachedPrices(universe, LOOKBACK_START, BACKTEST_END);
  const spyBars = (priceMap.SPY ?? []).sort((a, b) => a.date.localeCompare(b.date));

  const assetMeta = usaAssets.map(a => ({
    ticker: a.ticker.toUpperCase(),
    sector: a.sector ?? "Unknown",
    signalBias: (a as { signalBias?: string }).signalBias,
  }));

  const activeTickers = usaAssets
    .map(a => a.ticker.toUpperCase())
    .filter(t => (priceMap[t]?.length ?? 0) >= 50);

  const tradingDays = spyBars.map(b => b.date).filter(d => d >= BACKTEST_START && d <= BACKTEST_END);

  let cash = STARTING_CAPITAL;
  const positions: Position[] = [];
  const closedTrades: ClosedTrade[] = [];
  const closedToday = new Set<string>();
  const equityCurve: { date: string; equity: number; cash: number; positions: number; longs: number; shorts: number }[] = [];

  const sectorOf = (t: string) => assetMeta.find(a => a.ticker === t)?.sector ?? "Unknown";
  const signalBiasOf = (t: string) => assetMeta.find(a => a.ticker === t)?.signalBias;

  function currentEquity(barByTicker: Map<string, Bar>) {
    let eq = cash;
    for (const p of positions) {
      const bar = barByTicker.get(p.ticker);
      const px = bar?.close ?? p.entryPrice;
      eq += mtmPosition(p, px);
    }
    return eq;
  }

  function manageExits(day: string, barByTicker: Map<string, Bar>) {
    for (let i = positions.length - 1; i >= 0; i--) {
      const pos = positions[i];
      const bar = barByTicker.get(pos.ticker);
      if (!bar) continue;

      const { close, high, low } = bar;
      const isLong = pos.direction === "long";
      if (isLong) pos.extremePrice = Math.max(pos.extremePrice, high);
      else pos.extremePrice = Math.min(pos.extremePrice, low);

      const histBars = barsUpTo(priceMap[pos.ticker] ?? [], day);
      const liveScore = isLong
        ? (histBars.length >= 50 ? calcZivEngineScore(histBars).score : pos.entryScore)
        : (histBars.length >= 50 ? calcBearScore(histBars).score : pos.entryScore);

      const r = profitR(pos.entryPrice, pos.initialSl, close, pos.direction);
      if (!pos.slAtBreakeven && r >= BREAKEVEN_TRIGGER_R) {
        pos.stopLoss = isLong ? pos.entryPrice * 1.002 : pos.entryPrice * 0.998;
        pos.slAtBreakeven = true;
      }

      const target1 = calcTarget1Price(pos.entryPrice, pos.initialSl, pos.direction, PARTIAL_TP1_R);
      const target2 = calcTarget1Price(pos.entryPrice, pos.initialSl, pos.direction, PARTIAL_TP2_R);

      const closePartial = (frac: number, price: number, reason: string) => {
        const unitsToClose = Math.max(1, Math.floor(pos.initialUnits * frac));
        const actual = Math.min(unitsToClose, pos.units);
        if (actual <= 0) return;
        const exitPx = isLong ? price * (1 - SLIPPAGE) : price * (1 + SLIPPAGE);
        const pnl = legPnl(pos.entryPrice, exitPx, actual, pos.direction);
        pos.realizedPnl += pnl;
        cash += pnl;
        pos.units -= actual;
        pos.notional = pos.units * pos.entryPrice;
        closedTrades.push({
          ticker: pos.ticker, direction: pos.direction, entryDate: pos.entryDate, exitDate: day,
          entryPrice: pos.entryPrice, exitPrice: exitPx, pnl,
          pnlPct: isLong ? ((exitPx / pos.entryPrice) - 1) * 100 : ((pos.entryPrice / exitPx) - 1) * 100,
          exitReason: reason, entryScore: pos.entryScore,
        });
      };

      const hitTp1 = isLong ? high >= target1 : low <= target1;
      const hitTp2 = isLong ? high >= target2 : low <= target2;
      if (!pos.partialTp1Done && hitTp1 && pos.units > 1) {
        closePartial(PARTIAL_TP1_FRAC, target1, "partial_tp_1.5R");
        pos.partialTp1Done = true;
        pos.stopLoss = isLong ? pos.entryPrice * 1.002 : pos.entryPrice * 0.998;
        pos.slAtBreakeven = true;
      }
      if (pos.partialTp1Done && !pos.partialTp2Done && hitTp2 && pos.units > 1) {
        closePartial(PARTIAL_TP2_FRAC, target2, "partial_tp_2.5R");
        pos.partialTp2Done = true;
      }

      let exitReason: string | null = null;
      let exitPrice = close;

      const atr = calcATR(histBars);
      const chandelierMult = 2.0;
      const chandelierStop = isLong
        ? pos.extremePrice - chandelierMult * atr
        : pos.extremePrice + chandelierMult * atr;

      const hitSl = isLong ? low <= pos.stopLoss : high >= pos.stopLoss;
      const hitTp = isLong ? high >= pos.takeProfit : low <= pos.takeProfit;
      const trailingHit = pos.partialTp2Done && (
        isLong ? close <= pos.extremePrice * (1 - TRAILING_FROM_PEAK)
          : close >= pos.extremePrice * (1 + TRAILING_FROM_PEAK)
      );
      const chandelierHit = pos.partialTp1Done && atr > 0 && (
        isLong ? low <= Math.max(pos.stopLoss, chandelierStop) : high >= Math.min(pos.stopLoss, chandelierStop)
      );

      const daysHeld = tradingDaysHeld(pos.entryDate, day, tradingDays);
      const exitFloor = pos.partialTp1Done ? LONG_EXIT_SCORE_MIN_AFTER_TP1 : LONG_EXIT_SCORE_MIN;
      const shortFloor = pos.partialTp1Done ? LONG_EXIT_SCORE_MIN_AFTER_TP1 : SHORT_EXIT_SCORE_MIN;
      const scoreBelowFloor = isLong ? liveScore < exitFloor : liveScore < shortFloor;
      const scoreExitAllowed = daysHeld >= SCORE_DECAY_GRACE_DAYS && r < SCORE_DECAY_MIN_R && scoreBelowFloor;

      if (hitSl) {
        exitReason = pos.slAtBreakeven ? "breakeven_stop" : "stop_loss";
        exitPrice = pos.stopLoss;
      } else if (hitTp) {
        exitReason = "take_profit";
        exitPrice = pos.takeProfit;
      } else if (chandelierHit) {
        exitReason = "chandelier_trail_tp1";
        exitPrice = isLong ? Math.max(pos.stopLoss, chandelierStop) : Math.min(pos.stopLoss, chandelierStop);
      } else if (trailingHit) {
        exitReason = "trailing_15pct_peak";
        exitPrice = close;
      } else if (scoreExitAllowed) {
        exitReason = `score_decay_${liveScore.toFixed(1)}`;
        exitPrice = close;
      }

      if (exitReason && pos.units > 0) {
        const exitPx = isLong ? exitPrice * (1 - SLIPPAGE) : exitPrice * (1 + SLIPPAGE);
        const finalLegPnl = legPnl(pos.entryPrice, exitPx, pos.units, pos.direction);
        cash += finalLegPnl;
        closedTrades.push({
          ticker: pos.ticker, direction: pos.direction, entryDate: pos.entryDate, exitDate: day,
          entryPrice: pos.entryPrice, exitPrice: exitPx, pnl: finalLegPnl,
          pnlPct: isLong ? ((exitPx / pos.entryPrice) - 1) * 100 : ((pos.entryPrice / exitPx) - 1) * 100,
          exitReason, entryScore: pos.entryScore,
        });
        closedToday.add(`${pos.direction}:${pos.ticker}`);
        positions.splice(i, 1);
      }
    }
  }

  function tryPyramid(day: string, barByTicker: Map<string, Bar>) {
    for (const pos of positions) {
      if (pos.pyramidDone || !pos.partialTp1Done || pos.direction !== "long") continue;
      const bar = barByTicker.get(pos.ticker);
      if (!bar) continue;
      const histBars = barsUpTo(priceMap[pos.ticker] ?? [], day);
      const ema50 = ema50FromBars(histBars);
      if (!ema50 || ema50 <= 0) continue;
      const distPct = Math.abs(bar.close - ema50) / ema50;
      if (distPct > 0.025) continue;
      if (bar.close <= pos.entryPrice) continue;
      const r = profitR(pos.entryPrice, pos.initialSl, bar.close, "long");
      if (r < 1) continue;

      const deployedNow = deployedNotional(positions);
      const remaining = elza.allocatedCapital - deployedNow;
      const addUsd = Math.min(elza.perPositionUsd * 0.33, remaining, elza.maxPositionUsd);
      if (addUsd < elza.minPositionUsd * 0.5) continue;

      const addPrice = bar.close * (1 + SLIPPAGE);
      const addUnits = Math.floor(addUsd / addPrice);
      if (addUnits < 1) continue;
      if (deployedNow + addUnits * addPrice > elza.allocatedCapital) continue;

      pos.units += addUnits;
      pos.notional = pos.units * pos.entryPrice;
      pos.pyramidDone = true;
      cash -= addUnits * addPrice + COMMISSION;
    }
  }

  function scanEntries(day: string, barByTicker: Map<string, Bar>, regime: ReturnType<typeof applyBreadthGate>) {
    interface Cand { ticker: string; direction: "long" | "short"; finalScore: number; bars: Bar[] }
    const candidates: Cand[] = [];

    const longCount = positions.filter(p => p.direction === "long").length;
    const shortCount = positions.filter(p => p.direction === "short").length;
    const equityNow = currentEquity(barByTicker);

    for (const t of activeTickers) {
      for (const direction of ["long", "short"] as const) {
        if (direction === "long" && !regime.longOk) continue;
        if (direction === "short" && !regime.shortOk) continue;
        if (direction === "long" && longCount >= elza.maxLong) continue;
        if (direction === "short" && shortCount >= elza.maxShort) continue;
        if (positions.length >= elza.maxTotal) continue;
        if (positions.some(p => p.ticker === t && p.direction === direction)) continue;
        if (closedToday.has(`${direction}:${t}`)) continue;

        const bar = barByTicker.get(t);
        if (!bar || bar.close < 2) continue;

        const histBars = barsUpTo(priceMap[t] ?? [], day);
        if (histBars.length < 50) continue;

        const intel = getTickerIntelligence(histBars, direction);
        if (intel.liquidityScore < MIN_LIQUIDITY_SCORE) continue;

        const bias = signalBiasOf(t);
        if (direction === "long") {
          const war = passesLongWarGates(histBars, gates, bias);
          if (!war.pass) continue;
          if (intel.confluenceScore < MIN_CONFLUENCE) continue;
          if (!intel.weeklyAligned) continue;
          candidates.push({ ticker: t, direction, finalScore: war.finalScore, bars: histBars });
        } else {
          const war = passesShortWarGates(histBars, gates, bias);
          if (!war.pass) continue;
          if (!intel.weeklyAligned) continue;
          candidates.push({ ticker: t, direction, finalScore: war.finalScore, bars: histBars });
        }
      }
    }

    candidates.sort((a, b) => b.finalScore - a.finalScore);

    for (const c of candidates) {
      const longC = positions.filter(p => p.direction === "long").length;
      const shortC = positions.filter(p => p.direction === "short").length;
      if (positions.length >= elza.maxTotal) break;
      if (c.direction === "long" && longC >= elza.maxLong) continue;
      if (c.direction === "short" && shortC >= elza.maxShort) continue;

      const deployedNow = deployedNotional(positions);
      const remaining = elza.allocatedCapital - deployedNow;
      if (remaining < elza.minPositionUsd) break;

      const bar = barByTicker.get(c.ticker)!;
      const entryPrice = c.direction === "long" ? bar.close * (1 + SLIPPAGE) : bar.close * (1 - SLIPPAGE);

      let sizeUsd = Math.min(elza.perPositionUsd, remaining, elza.maxPositionUsd);
      if (c.finalScore >= 9) sizeUsd = Math.min(sizeUsd * 1.2, elza.maxPositionUsd);
      sizeUsd = Math.max(sizeUsd, elza.minPositionUsd);
      if (sizeUsd > remaining) continue;

      const ema50 = ema50FromBars(c.bars);
      let entrySlTp = calcEntrySlTp({ entryPrice, ema50, bars: c.bars, direction: c.direction });
      if (c.direction === "long") {
        if (!entrySlTp.stopLoss || entrySlTp.stopLoss >= entryPrice) {
          entrySlTp = { ...entrySlTp, stopLoss: entryPrice * 0.97, takeProfit: entryPrice * 1.06 };
        }
      } else {
        if (!entrySlTp.stopLoss || entrySlTp.stopLoss <= entryPrice) {
          entrySlTp = { ...entrySlTp, stopLoss: entryPrice * 1.03, takeProfit: entryPrice * 0.94 };
        }
      }

      const units = Math.floor(sizeUsd / entryPrice);
      if (units < 1) continue;
      const notional = units * entryPrice;
      if (deployedNotional(positions) + notional > elza.allocatedCapital) continue;

      positions.push({
        ticker: c.ticker,
        direction: c.direction,
        sector: sectorOf(c.ticker),
        entryDate: day,
        entryPrice,
        units,
        initialUnits: units,
        notional,
        stopLoss: entrySlTp.stopLoss,
        takeProfit: entrySlTp.takeProfit,
        initialSl: entrySlTp.stopLoss,
        extremePrice: entryPrice,
        partialTp1Done: false,
        partialTp2Done: false,
        slAtBreakeven: false,
        pyramidDone: false,
        realizedPnl: 0,
        entryScore: c.finalScore,
      });
    }
  }

  for (const day of tradingDays) {
    closedToday.clear();
    const barByTicker = new Map<string, Bar>();
    for (const t of activeTickers) {
      const bar = priceMap[t]?.find(b => b.date === day);
      if (bar) barByTicker.set(t, bar);
    }

    const breadth = computeBreadthPctBelow200(day, activeTickers, priceMap);
    const regime = applyBreadthGate(getHistoricalRegime(spyBars, day), breadth, gates.breadthThreshold);
    manageExits(day, barByTicker);
    tryPyramid(day, barByTicker);
    scanEntries(day, barByTicker, regime);

    equityCurve.push({
      date: day,
      equity: currentEquity(barByTicker),
      cash,
      positions: positions.length,
      longs: positions.filter(p => p.direction === "long").length,
      shorts: positions.filter(p => p.direction === "short").length,
    });
  }

  const lastDay = tradingDays[tradingDays.length - 1];
  for (const pos of [...positions]) {
    const bar = priceMap[pos.ticker]?.find(b => b.date === lastDay);
    const exitPx = pos.direction === "long"
      ? (bar?.close ?? pos.entryPrice) * (1 - SLIPPAGE)
      : (bar?.close ?? pos.entryPrice) * (1 + SLIPPAGE);
    const pnl = legPnl(pos.entryPrice, exitPx, pos.units, pos.direction);
    cash += pnl;
    closedTrades.push({
      ticker: pos.ticker, direction: pos.direction, entryDate: pos.entryDate, exitDate: lastDay,
      entryPrice: pos.entryPrice, exitPrice: exitPx, pnl,
      exitReason: "end_of_backtest", entryScore: pos.entryScore,
    });
  }
  positions.length = 0;

  const finalEquity = cash;
  const totalPnl = finalEquity - STARTING_CAPITAL;
  const totalReturnPct = (totalPnl / STARTING_CAPITAL) * 100;

  let weekly = buildWeeklyEquity(equityCurve);
  weekly = weekly.map((w, i) => ({
    ...w,
    returnFromStartPct: Math.round(((w.equity / STARTING_CAPITAL) - 1) * 10000) / 100,
    wowChangePct: i === 0 ? 0 : Math.round(((w.equity / weekly[i - 1].equity) - 1) * 10000) / 100,
  }));

  let peak = STARTING_CAPITAL;
  let maxDd = 0;
  for (const e of equityCurve) {
    peak = Math.max(peak, e.equity);
    maxDd = Math.max(maxDd, (peak - e.equity) / peak);
  }

  const roundTrips = new Map<string, { pnl: number }>();
  for (const tr of closedTrades) {
    const key = `${tr.direction}|${tr.ticker}|${tr.entryDate}`;
    const cur = roundTrips.get(key) ?? { pnl: 0 };
    cur.pnl += tr.pnl;
    roundTrips.set(key, cur);
  }

  const longPnl = closedTrades.filter(t => t.direction === "long").reduce((s, t) => s + t.pnl, 0);
  const shortPnl = closedTrades.filter(t => t.direction === "short").reduce((s, t) => s + t.pnl, 0);

  const exitReasons: Record<string, number> = {};
  for (const t of closedTrades) {
    const key = t.exitReason.replace(/_\d+(\.\d+)?$/, "_X");
    exitReasons[key] = (exitReasons[key] ?? 0) + 1;
  }

  const baselineReturnPct = 26.09;

  const results = {
    meta: {
      generatedAt: new Date().toISOString(),
      model: "Elza V2 — proposed improvements",
      period: { start: BACKTEST_START, end: BACKTEST_END },
      universe: { catalogueUsa: usaAssets.length, withData: activeTickers.length },
      improvements: [
        "score_decay: 8-day grace, skip if >1R profit, floor 5.0 after TP1",
        "shorts: BEAR regime only",
        "hybrid breakout: momentum + volume bypass goldBreakout kill-switch",
        "chandelier trail (2×ATR) after partial TP1",
        "pyramid +33% on EMA-50 retest after TP1",
        "score≥9: +20% position size",
      ],
      baselineComparison: { baselineReturnPct, v2ReturnPct: Math.round(totalReturnPct * 100) / 100, deltaPct: Math.round((totalReturnPct - baselineReturnPct) * 100) / 100 },
    },
    performance: {
      startingCapital: STARTING_CAPITAL,
      finalEquity: Math.round(finalEquity * 100) / 100,
      totalPnl: Math.round(totalPnl * 100) / 100,
      totalReturnPct: Math.round(totalReturnPct * 100) / 100,
      roundTrips: roundTrips.size,
      closedLegs: closedTrades.length,
      maxDrawdownPct: Math.round(maxDd * 10000) / 100,
      longLegsPnl: Math.round(longPnl * 100) / 100,
      shortLegsPnl: Math.round(shortPnl * 100) / 100,
    },
    weeklyEquity: weekly,
    exitReasonBreakdown: exitReasons,
    trades: closedTrades.slice(0, 200),
  };

  const outPath = path.join(process.cwd(), "elza-backtest-oos-results.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  console.log("\n=== V2 RESULTS ===");
  console.log(`Starting: $${STARTING_CAPITAL.toLocaleString()} → Final: $${results.performance.finalEquity.toLocaleString()}`);
  console.log(`Return: ${results.performance.totalReturnPct}% (baseline: ${baselineReturnPct}%, delta: ${results.meta.baselineComparison.deltaPct}%)`);
  console.log(`Max DD: ${results.performance.maxDrawdownPct}% | Round trips: ${results.performance.roundTrips}`);
  console.log(`Long P&L: $${results.performance.longLegsPnl} | Short P&L: $${results.performance.shortLegsPnl}`);
  console.log("\n=== EXIT REASONS ===");
  for (const [k, v] of Object.entries(exitReasons)) console.log(`  ${k}: ${v}`);
  console.log(`\nWritten to ${outPath}`);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
