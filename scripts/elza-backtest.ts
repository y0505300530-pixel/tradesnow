/**
 * Elza (War Engine + Live Engine rules) full-universe backtest
 * Run: npx tsx scripts/elza-backtest.ts
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

// ─── War Engine constants ────────────────────────────────────────────────────
const LONG_ENTRY_MIN_SCORE = 8.0;
const SHORT_ENTRY_MIN_SCORE = 8.0;
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

const COMMISSION = 2.5;
const SLIPPAGE = 0.001;

const LOOKBACK_START = "2025-09-01";
const BACKTEST_START = "2026-01-01";
const BACKTEST_END = "2026-06-25";
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
  extremePrice: number; // peak for long, trough for short
  partialTp1Done: boolean;
  partialTp2Done: boolean;
  slAtBreakeven: boolean;
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

function isUsaTicker(ticker: string): boolean {
  const t = ticker.toUpperCase();
  return !t.endsWith(".TA") && !t.endsWith("-USD") && !/^\d/.test(t);
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
    shortOk: base.regime === "BEAR" || base.regime === "NEUTRAL" || weakBreadth,
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

  if (ziv.tier === "Gold Breakout" && !gates.goldBreakoutEnabled
    && !(gates.volumeConfirmEnabled && confirmVolume(histBars, ziv.donchian20High, "long").confirmed)) {
    return { pass: false, finalScore: ziv.score };
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
    return { pass: false, finalScore: bear.score };
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

function analyzeImprovements(
  closedTrades: ClosedTrade[],
  weekly: ReturnType<typeof buildWeeklyEquity>,
  startingCapital: number,
  bhSpyPct: number,
  strategyPct: number,
) {
  const longTrades = closedTrades.filter(t => t.direction === "long");
  const shortTrades = closedTrades.filter(t => t.direction === "short");
  const longPnl = longTrades.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = shortTrades.reduce((s, t) => s + t.pnl, 0);
  const wins = closedTrades.filter(t => t.pnl > 0).length;
  const losses = closedTrades.filter(t => t.pnl <= 0).length;

  const exitReasons: Record<string, number> = {};
  for (const t of closedTrades) {
    const key = t.exitReason.replace(/_\d+(\.\d+)?$/, "_X");
    exitReasons[key] = (exitReasons[key] ?? 0) + 1;
  }

  const insights: string[] = [];
  if (strategyPct < bhSpyPct) {
    insights.push(`תשואה ${strategyPct.toFixed(1)}% מול SPY B&H ${bhSpyPct.toFixed(1)}% — המודל החמיץ רלי שוק`);
  } else {
    insights.push(`תשואה ${strategyPct.toFixed(1)}% עוקפת SPY B&H ${bhSpyPct.toFixed(1)}%`);
  }
  if (shortTrades.length === 0) {
    insights.push("אין עסקאות SHORT — בדוק פילטר regime (short חסום ב-BULL) או bear score");
  } else if (shortPnl < 0) {
    insights.push(`SHORT הפסיד $${Math.abs(shortPnl).toFixed(0)} — שקול להדק כניסות short ב-BULL tape`);
  }
  if (longPnl > 0 && strategyPct < bhSpyPct) {
    insights.push("LONG רווחי אבל חשיפה נמוכה — פילטרי כניסה (Ziv≥8, confluence) משאירים הרבה כסף בצד");
  }
  const scoreDecay = (exitReasons["score_decay_X"] ?? 0) + Object.entries(exitReasons).filter(([k]) => k.startsWith("score_decay")).reduce((s, [, v]) => s + v, 0);
  if (scoreDecay > closedTrades.length * 0.3) {
    insights.push(`יציאות score_decay גבוהות (${scoreDecay}) — Ziv יורד מהר מדי וסוגר מוקדם`);
  }
  const slExits = Object.entries(exitReasons).filter(([k]) => k.includes("stop")).reduce((s, [, v]) => s + v, 0);
  if (slExits > closedTrades.length * 0.25) {
    insights.push(`הרבה יציאות SL (${slExits}) — בדוק calcEntrySlTp / רוחב stop`);
  }
  const worstWeek = weekly.reduce((w, wk) => (wk.wowChangePct < (w?.wowChangePct ?? 0) ? wk : w), weekly[1]);
  if (worstWeek && worstWeek.wowChangePct < -5) {
    insights.push(`שבוע גרוע ביותר: ${worstWeek.weekStart} (${worstWeek.wowChangePct.toFixed(1)}% WoW)`);
  }
  insights.push(`Win rate כולל: ${closedTrades.length ? ((wins / closedTrades.length) * 100).toFixed(0) : 0}% (${wins}W/${losses}L על legs)`);

  return { insights, longPnl, shortPnl, longLegs: longTrades.length, shortLegs: shortTrades.length, exitReasons };
}

async function main() {
  console.log("=== Elza Full-USA Backtest ===");

  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const cfgRows = await db.select().from(liveEngineConfig).where(eq(liveEngineConfig.userId, USER_ID));
  const liveCfg = cfgRows[0];
  if (!liveCfg) throw new Error("liveEngineConfig not found for user 1");

  const elza = buildElzaConfig(liveCfg);
  const gates = buildWarGateConfig(liveCfg);
  const STARTING_CAPITAL = elza.cashBudget;

  console.log(`Period: ${BACKTEST_START} → ${BACKTEST_END}`);
  console.log(`NLV: $${elza.totalNlv.toLocaleString()} | Cash budget: $${elza.cashBudget.toLocaleString()}`);
  console.log(`Leverage: x${elza.intradayMultiplier} intraday | x${elza.overnightMultiplier} overnight`);
  console.log(`Position: $${elza.perPositionUsd.toLocaleString()} (min $${elza.minPositionUsd} max $${elza.maxPositionUsd})`);
  console.log(`Max: ${elza.maxLong} long / ${elza.maxShort} short / ${elza.maxTotal} total`);
  console.log(`War gates: cyclePhase=${gates.cyclePhaseGateEnabled} goldBO=${gates.goldBreakoutEnabled} bearBD=${gates.bearBreakdownEnabled} weeklyAnchor=${gates.weeklyAnchorEnabled} zones=${gates.zonesGateEnabled} kronos=${gates.kronosOn}`);

  const assets = await getUserAssets(USER_ID);
  const usaAssets = assets.filter(a => isUsaTicker(a.ticker));
  const universe = [...new Set(["SPY", ...usaAssets.map(a => a.ticker.toUpperCase())])];

  console.log(`Loading prices for ${universe.length} tickers...`);
  const priceMap = await getBulkCachedPrices(universe, LOOKBACK_START, BACKTEST_END);
  const spyBars = (priceMap.SPY ?? []).sort((a, b) => a.date.localeCompare(b.date));

  const assetMeta = usaAssets.map(a => ({
    ticker: a.ticker.toUpperCase(),
    sector: a.sector ?? "Unknown",
    score: a.score ?? null,
    signalBias: (a as { signalBias?: string }).signalBias,
  }));

  const activeTickers = usaAssets
    .map(a => a.ticker.toUpperCase())
    .filter(t => (priceMap[t]?.length ?? 0) >= 50);

  console.log(`USA catalogue: ${usaAssets.length} | With price data: ${activeTickers.length}`);

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
          entryPrice: pos.entryPrice, exitPrice: exitPx, pnl, pnlPct: isLong ? ((exitPx / pos.entryPrice) - 1) * 100 : ((pos.entryPrice / exitPx) - 1) * 100,
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

      const hitSl = isLong ? low <= pos.stopLoss : high >= pos.stopLoss;
      const hitTp = isLong ? high >= pos.takeProfit : low <= pos.takeProfit;
      const trailingHit = pos.partialTp2Done && (
        isLong ? close <= pos.extremePrice * (1 - TRAILING_FROM_PEAK)
          : close >= pos.extremePrice * (1 + TRAILING_FROM_PEAK)
      );
      const scoreExit = isLong ? liveScore < LONG_EXIT_SCORE_MIN : liveScore < SHORT_EXIT_SCORE_MIN;

      if (hitSl) {
        exitReason = pos.slAtBreakeven ? "breakeven_stop" : "stop_loss";
        exitPrice = pos.stopLoss;
      } else if (hitTp) {
        exitReason = "take_profit";
        exitPrice = pos.takeProfit;
      } else if (trailingHit) {
        exitReason = "trailing_15pct_peak";
        exitPrice = close;
      } else if (scoreExit) {
        exitReason = `score_decay_${liveScore.toFixed(1)}`;
        exitPrice = close;
      }

      if (exitReason && pos.units > 0) {
        const exitPx = isLong ? exitPrice * (1 - SLIPPAGE) : exitPrice * (1 + SLIPPAGE);
        const finalLegPnl = legPnl(pos.entryPrice, exitPx, pos.units, pos.direction);
        cash += finalLegPnl;
        closedTrades.push({
          ticker: pos.ticker, direction: pos.direction, entryDate: pos.entryDate, exitDate: day,
          entryPrice: pos.entryPrice, exitPrice: exitPx, pnl: finalLegPnl, pnlPct: isLong ? ((exitPx / pos.entryPrice) - 1) * 100 : ((pos.entryPrice / exitPx) - 1) * 100,
          exitReason, entryScore: pos.entryScore,
        });
        closedToday.add(`${pos.direction}:${pos.ticker}`);
        positions.splice(i, 1);
      }
    }
  }

  function scanEntries(day: string, barByTicker: Map<string, Bar>, regime: ReturnType<typeof applyBreadthGate>) {
    interface Cand { ticker: string; direction: "long" | "short"; finalScore: number; bars: Bar[] }
    const candidates: Cand[] = [];

    const longCount = positions.filter(p => p.direction === "long").length;
    const shortCount = positions.filter(p => p.direction === "short").length;
    const deployed = deployedNotional(positions);
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

        let finalScore: number;
        const bias = signalBiasOf(t);
        if (direction === "long") {
          const war = passesLongWarGates(histBars, gates, bias);
          if (!war.pass) continue;
          finalScore = war.finalScore;
          if (intel.confluenceScore < MIN_CONFLUENCE) continue;
          if (!intel.weeklyAligned) continue;
        } else {
          const war = passesShortWarGates(histBars, gates, bias);
          if (!war.pass) continue;
          finalScore = war.finalScore;
          if (!intel.weeklyAligned) continue;
        }

        const newClose = histBars.map(b => b.close);
        const correlated = positions.some(p => {
          const oc = barsUpTo(priceMap[p.ticker] ?? [], day).map(b => b.close);
          return calcCorrelation(newClose, oc) > MAX_CORRELATION;
        });
        if (correlated) continue;

        const sector = sectorOf(t);
        const sectorPos = positions.filter(p => sectorOf(p.ticker) === sector && p.direction === direction);
        if (sectorPos.length >= MAX_POSITIONS_PER_SECTOR) continue;
        const sectorVal = sectorPos.reduce((s, p) => s + p.notional, 0);
        if (equityNow > 0 && sectorVal / equityNow >= MAX_SECTOR_EQUITY_PCT) continue;

        candidates.push({ ticker: t, direction, finalScore, bars: histBars });
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
    scanEntries(day, barByTicker, regime);

    const eq = currentEquity(barByTicker);
    equityCurve.push({
      date: day,
      equity: eq,
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

  const spyStart = spyBars.find(b => b.date >= BACKTEST_START)?.close ?? 0;
  const spyEnd = [...spyBars].reverse().find(b => b.date <= BACKTEST_END)?.close ?? 0;
  const spyBhPct = spyStart > 0 ? ((spyEnd / spyStart) - 1) * 100 : 0;

  let peak = STARTING_CAPITAL;
  let maxDd = 0;
  for (const e of equityCurve) {
    peak = Math.max(peak, e.equity);
    maxDd = Math.max(maxDd, (peak - e.equity) / peak);
  }

  const roundTrips = new Map<string, { pnl: number; ticker: string; direction: string }>();
  for (const tr of closedTrades) {
    const key = `${tr.direction}|${tr.ticker}|${tr.entryDate}`;
    const cur = roundTrips.get(key) ?? { pnl: 0, ticker: tr.ticker, direction: tr.direction };
    cur.pnl += tr.pnl;
    roundTrips.set(key, cur);
  }

  const analysis = analyzeImprovements(closedTrades, weekly, STARTING_CAPITAL, spyBhPct, totalReturnPct);

  const results = {
    meta: {
      generatedAt: new Date().toISOString(),
      model: "Elza full USA — War Engine LONG+SHORT + live leverage config",
      period: { start: BACKTEST_START, end: BACKTEST_END, lookbackFrom: LOOKBACK_START },
      universe: { catalogueUsa: usaAssets.length, withData: activeTickers.length },
      liveConfig: {
        totalNlv: elza.totalNlv,
        allocatedPct: liveCfg.allocatedPct,
        cashBudget: elza.cashBudget,
        intradayMultiplier: elza.intradayMultiplier,
        overnightMultiplier: elza.overnightMultiplier,
        allocatedCapital: elza.allocatedCapital,
        positionSizePct: liveCfg.positionSizePct,
        perPositionUsd: elza.perPositionUsd,
        minPositionUsd: elza.minPositionUsd,
        maxPositionUsd: elza.maxPositionUsd,
        maxLongPositions: elza.maxLong,
        maxShortPositions: elza.maxShort,
      },
      warGates: gates,
      rulesIncluded: [
        "Ziv LONG + Bear SHORT scoring with zivOnlyFloor/combinedGate from liveEngineConfig",
        "SPY regime (BULL/NEUTRAL/BEAR) + breadth-aware longOk/shortOk",
        `goldBreakout kill-switch (${gates.goldBreakoutEnabled ? "OFF — breakouts allowed" : "ON — blocks raw Gold Breakout unless נמ\"ס"})`,
        `bearBreakdown kill-switch (${gates.bearBreakdownEnabled ? "OFF" : "ON"})`,
        `cyclePhase gate (${gates.cyclePhaseGateEnabled ? "ON — CYC-L1/CYC-S1" : "OFF"})`,
        gates.weeklyAnchorEnabled ? "weeklyAnchor HARD gate (WK-L/WK-S)" : null,
        gates.zonesGateEnabled ? "zones demand/supply gate" : null,
        gates.retestV2Enabled && gates.zonesGateEnabled ? "retestV2 ±0.5×ATR band" : null,
        gates.volumeConfirmEnabled ? "volumeConfirm נמ\"ס for breakout bypass" : null,
        "weeklyAligned + confluence + liquidity + correlation + sector caps",
        "Partial TP 1.5R/2.5R, breakeven, trailing, score-decay exits",
        "signalBias REJECTED slang guard",
        "Live leverage/position sizing from liveEngineConfig",
      ].filter(Boolean),
      rulesOmitted: [
        gates.kronosOn ? null : "Kronos conviction addon (weight=0 in live config — no historical cache for 2026)",
        "Mentor pattern boost (requires live mentorPatterns DB; not replayed historically)",
        "gapGuard (intraday live-price chase guard — daily close entry only)",
        gates.riskSizingEnabled ? "riskSizing + heatMaxPct (flag ON but legacy fixed-capital sizing used in backtest)" : null,
        gates.structuralExitsEnabled ? "structuralExits Phase 5 (flag ON but legacy R-multiple exits used in backtest)" : null,
      ].filter(Boolean),
      assumptions: [
        "All USA catalogue tickers with ≥50 bars",
        "Daily bar simulation at close; commission $2.50/leg; 0.1% slippage",
        "Gate flags read from liveEngineConfig userId=1 (or schema defaults if DB unavailable)",
      ],
      missingData: usaAssets.map(a => a.ticker.toUpperCase()).filter(t => !activeTickers.includes(t)),
    },
    performance: {
      startingCapital: STARTING_CAPITAL,
      finalEquity: Math.round(finalEquity * 100) / 100,
      totalPnl: Math.round(totalPnl * 100) / 100,
      totalReturnPct: Math.round(totalReturnPct * 100) / 100,
      roundTrips: roundTrips.size,
      closedLegs: closedTrades.length,
      maxDrawdownPct: Math.round(maxDd * 10000) / 100,
      spyBuyAndHoldPct: Math.round(spyBhPct * 100) / 100,
      alphaVsSpyPct: Math.round((totalReturnPct - spyBhPct) * 100) / 100,
      longLegsPnl: Math.round(analysis.longPnl * 100) / 100,
      shortLegsPnl: Math.round(analysis.shortPnl * 100) / 100,
    },
    weeklyEquity: weekly,
    improvementInsights: analysis.insights,
    exitReasonBreakdown: analysis.exitReasons,
    trades: closedTrades.slice(0, 200),
    tradeCount: closedTrades.length,
  };

  const outPath = path.join(process.cwd(), "elza-backtest-results.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  console.log("\n=== RESULTS ===");
  console.log(`Starting: $${STARTING_CAPITAL.toLocaleString()} → Final: $${results.performance.finalEquity.toLocaleString()}`);
  console.log(`Return: ${results.performance.totalReturnPct}% | SPY B&H: ${results.performance.spyBuyAndHoldPct}% | Alpha: ${results.performance.alphaVsSpyPct}%`);
  console.log(`Max DD: ${results.performance.maxDrawdownPct}% | Round trips: ${results.performance.roundTrips}`);
  console.log(`Long P&L: $${results.performance.longLegsPnl} | Short P&L: $${results.performance.shortLegsPnl}`);
  console.log("\n=== WEEKLY EQUITY ===");
  for (const w of weekly) {
    console.log(`  ${w.weekStart} → ${w.weekEnd}: $${w.equity.toLocaleString()} (${w.returnFromStartPct >= 0 ? "+" : ""}${w.returnFromStartPct}% total, ${w.wowChangePct >= 0 ? "+" : ""}${w.wowChangePct}% WoW) [${w.longs}L/${w.shorts}S]`);
  }
  console.log("\n=== IMPROVEMENT INSIGHTS ===");
  for (const i of analysis.insights) console.log(`  • ${i}`);
  console.log(`\nWritten to ${outPath}`);
  process.exit(0);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
