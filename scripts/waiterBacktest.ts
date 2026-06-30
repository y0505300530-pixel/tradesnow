/**
 * waiterBacktest.ts — THE WAITER (retest resting-LMT entry model) backtest.
 *
 * Derived from scripts/elza-backtest.ts (same data fetch, portfolio loop, golden
 * exit ladder, reporting). The ONLY thing that changes for "Gold Retest" tier
 * candidates is the ENTRY MECHANISM: instead of a bar-close market buy, the Waiter
 * places a RESTING LMT at computeAmbushLimit(ema20, livePrice).limit (EMA20×1.005),
 * gated by isNearRetestZone(). The resting LMT becomes `open` on the FIRST subsequent
 * bar whose low ≤ restingLimit (passive pullback fill). No pullback / EOD-of-data →
 * the candidate NEVER fills (no trade). On fill: stop = wideLungSL, size =
 * vixRiskSize (1% risk), then the SAME golden exit ladder as elza-backtest.
 *
 * "Gold Breakout" tier KEEPS the elza-backtest market-entry path UNCHANGED so we can
 * compare the two sleeves side-by-side over the same window.
 *
 * EDGE GATE: does the resting-LMT retest model show positive expectancy (R) +
 * acceptable max-DD?
 *
 * Run (LOCAL — needs .env + DB price cache reachable):
 *   node --import tsx --env-file=.env scripts/waiterBacktest.ts
 * If the DB / price-cache is droplet-only, run THERE with the same command.
 *
 * READ-ONLY backtest: no DB writes, no IBKR calls, no order placement.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { getDb, getBulkCachedPrices, getUserAssets } from "../server/db";
import { calcZivEngineScore, calcEMA } from "../server/zivEngine";
import { calcCorrelation } from "../server/runtimeIntelligence";
import { calcEntrySlTp, calcTarget1Price, ema50FromBars } from "../server/slCalculator";
import { computeAmbushLimit, isNearRetestZone } from "../server/waiterEngine";
import { wideLungSL, vixRiskSize } from "../server/engine/elzaV45Master";
import { liveEngineConfig } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import type { LiveEngineConfig } from "../drizzle/schema";

// ─── War Engine constants (mirror elza-backtest exit ladder) ──────────────────────
const LONG_ENTRY_MIN_SCORE = 8.0;
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

const COMMISSION = 2.5;
const SLIPPAGE = 0.001;

// ─── Waiter sleeve caps (BUILD-spec defaults) ─────────────────────────────────────
const MAX_RETEST_SLOTS = 8;        // concurrent resting + open retests
const WAITER_NLV_PCT = 0.30;       // aggregate retest-sleeve cap (30% of NLV)

const LOOKBACK_START = "2025-09-01";
const BACKTEST_START = "2026-01-01";
const BACKTEST_END = "2026-06-20";
const USER_ID = 1;

type Bar = { date: string; open: number; high: number; low: number; close: number; volume: number };

// ─── Sleeve tag — which entry pipeline owns this position ─────────────────────────
type Sleeve = "retest" | "breakout";

interface Position {
  ticker: string;
  sleeve: Sleeve;
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
  realizedPnl: number;
  entryScore: number;
  /** Risk-per-share at entry = |entry − initialSl|. Used for per-trade expectancy in R. */
  riskPerShare: number;
}

// ─── A resting LMT order waiting for a passive pullback fill ───────────────────────
interface RestingOrder {
  ticker: string;
  sector: string;
  placedDate: string;
  restingLimit: number;     // EMA20 × 1.005 (computeAmbushLimit)
  stop: number;             // wideLungSL off the ambush level
  units: number;
  entryScore: number;
  ema20: number;
}

interface ClosedTrade {
  ticker: string;
  sleeve: Sleeve;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  units: number;
  pnl: number;
  pnlPct: number;
  pnlR: number;             // P&L of this leg expressed in R (risk units)
  exitReason: string;
  entryScore: number;
}

interface ElzaConfig {
  totalNlv: number;
  cashBudget: number;
  allocatedCapital: number;
  perPositionUsd: number;
  minPositionUsd: number;
  maxPositionUsd: number;
  maxLong: number;
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
  const sizePct = (cfg.positionSizePct ?? 50) / 100;
  const rawPos = nlv * sizePct;
  const minPos = cfg.minPositionUsd ?? 20_000;
  const maxPos = cfg.maxPositionUsd ?? 70_000;
  const perPositionUsd = Math.min(Math.max(rawPos, minPos), maxPos);

  return {
    totalNlv: nlv,
    cashBudget,
    allocatedCapital,
    perPositionUsd,
    minPositionUsd: minPos,
    maxPositionUsd: maxPos,
    maxLong: cfg.maxLongPositions ?? cfg.maxPositions ?? 12,
    maxTotal: cfg.maxPositions ?? 12,
    intradayMultiplier: intMult,
    overnightMultiplier: ovrMult,
  };
}

function isUsaTicker(ticker: string): boolean {
  const t = ticker.toUpperCase();
  return !t.endsWith(".TA") && !t.endsWith("-USD") && !/^\d/.test(t);
}

function getTickerIntelligence(bars: Bar[]) {
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
  const weeklyAligned = weeklySlope > -0.005;

  const ema50now = calcEMA(closes, Math.min(50, closes.length));
  const ema50prev = calcEMA(closes.slice(0, -3), Math.min(50, closes.length - 3));
  const priceNow = closes[closes.length - 1];
  const pricePrev = closes[closes.length - 4];
  const distNow = (priceNow - ema50now) / ema50now;
  const distPrev = (pricePrev - ema50prev) / ema50prev;
  const momentumVelocity = (distNow - distPrev) * 100;

  let conf = 5;
  if (weeklySlope > 0.002) conf += 2;
  if (relVol > 1.2) conf += 1.5;
  if (momentumVelocity > 0.3) conf += 1.5;

  return { liquidityScore, weeklyAligned, confluenceScore: Math.min(10, conf) };
}

/** SPY-derived regime + VIX proxy (for longOk gate + vixRiskSize input). */
function getHistoricalRegime(spyBars: Bar[], asOfDate: string) {
  const idx = spyBars.findIndex(b => b.date >= asOfDate);
  const slice = spyBars.slice(0, idx >= 0 ? idx + 1 : spyBars.length);
  if (slice.length < 60) {
    return { regime: "NEUTRAL" as const, longOk: true, vix: 18 };
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

  return { regime, longOk: regime !== "BEAR", vix: vixProxy };
}

function barsUpTo(allBars: Bar[], date: string): Bar[] {
  const idx = allBars.findIndex(b => b.date > date);
  return idx === -1 ? allBars : allBars.slice(0, idx);
}

function legPnl(entry: number, exit: number, units: number) {
  return (exit - entry) * units - COMMISSION;
}

function mtmPosition(pos: Position, price: number) {
  return pos.realizedPnl + (price - pos.entryPrice) * pos.units;
}

function deployedNotional(positions: Position[]) {
  return positions.reduce((s, p) => s + p.units * p.entryPrice, 0);
}

/** Retest-sleeve committed notional = open retests (units×entry) + resting LMTs (units×limit). */
function retestSleeveNotional(positions: Position[], resting: RestingOrder[]): number {
  let sum = 0;
  for (const p of positions) if (p.sleeve === "retest") sum += p.units * p.entryPrice;
  for (const r of resting) sum += r.units * r.restingLimit;
  return sum;
}

function weekKey(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  const day = d.getUTCDay();
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

interface EquityPoint { date: string; equity: number; cash: number; positions: number; retests: number; breakouts: number; resting: number }

function buildWeeklyEquity(equityCurve: EquityPoint[]) {
  const byWeek = new Map<string, EquityPoint>();
  for (const pt of equityCurve) byWeek.set(weekKey(pt.date), pt);
  return [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekStart, pt]) => ({
      weekStart,
      weekEnd: pt.date,
      equity: Math.round(pt.equity * 100) / 100,
      returnFromStartPct: 0,
      wowChangePct: 0,
      retests: pt.retests,
      breakouts: pt.breakouts,
      resting: pt.resting,
    }));
}

/** Per-sleeve performance: expectancy (R), win-rate, return%, round-trips, sleeve P&L. */
function sleeveStats(trades: ClosedTrade[], sleeve: Sleeve, startingCapital: number) {
  const legs = trades.filter(t => t.sleeve === sleeve);
  const roundTrips = new Map<string, { pnl: number; pnlR: number }>();
  for (const t of legs) {
    const key = `${t.ticker}|${t.entryDate}`;
    const cur = roundTrips.get(key) ?? { pnl: 0, pnlR: 0 };
    cur.pnl += t.pnl;
    cur.pnlR += t.pnlR;
    roundTrips.set(key, cur);
  }
  const rts = [...roundTrips.values()];
  const wins = rts.filter(r => r.pnl > 0).length;
  const totalPnl = legs.reduce((s, t) => s + t.pnl, 0);
  const totalR = rts.reduce((s, r) => s + r.pnlR, 0);
  const expectancyR = rts.length ? totalR / rts.length : 0;
  const winRatePct = rts.length ? (wins / rts.length) * 100 : 0;
  return {
    roundTrips: rts.length,
    closedLegs: legs.length,
    totalPnl: Math.round(totalPnl * 100) / 100,
    totalReturnPct: Math.round((totalPnl / startingCapital) * 10000) / 100,
    expectancyR: Math.round(expectancyR * 1000) / 1000,
    winRatePct: Math.round(winRatePct * 10) / 10,
  };
}

async function main() {
  console.log("=== THE WAITER — Retest Resting-LMT Backtest ===");

  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const cfgRows = await db.select().from(liveEngineConfig).where(eq(liveEngineConfig.userId, USER_ID));
  const liveCfg = cfgRows[0];
  if (!liveCfg) throw new Error("liveEngineConfig not found for user 1");

  const elza = buildElzaConfig(liveCfg);
  const STARTING_CAPITAL = elza.cashBudget;

  console.log(`Period: ${BACKTEST_START} → ${BACKTEST_END}`);
  console.log(`NLV: $${elza.totalNlv.toLocaleString()} | Cash budget: $${elza.cashBudget.toLocaleString()}`);
  console.log(`Retest sleeve: max ${MAX_RETEST_SLOTS} slots | ${(WAITER_NLV_PCT * 100).toFixed(0)}% NLV sub-cap`);
  console.log(`Breakout sleeve: market entry, $${elza.perPositionUsd.toLocaleString()}/pos (UNCHANGED elza path)`);

  const assets = await getUserAssets(USER_ID);
  const usaAssets = assets.filter(a => isUsaTicker(a.ticker));
  const universe = [...new Set(["SPY", ...usaAssets.map(a => a.ticker.toUpperCase())])];

  console.log(`Loading prices for ${universe.length} tickers...`);
  const priceMap = await getBulkCachedPrices(universe, LOOKBACK_START, BACKTEST_END);
  const spyBars = (priceMap.SPY ?? []).sort((a, b) => a.date.localeCompare(b.date));

  const assetMeta = usaAssets.map(a => ({ ticker: a.ticker.toUpperCase(), sector: a.sector ?? "Unknown" }));
  const activeTickers = usaAssets
    .map(a => a.ticker.toUpperCase())
    .filter(t => (priceMap[t]?.length ?? 0) >= 50);

  console.log(`USA catalogue: ${usaAssets.length} | With price data: ${activeTickers.length}`);

  const tradingDays = spyBars.map(b => b.date).filter(d => d >= BACKTEST_START && d <= BACKTEST_END);

  let cash = STARTING_CAPITAL;
  const positions: Position[] = [];
  const resting: RestingOrder[] = [];           // resting retest LMTs awaiting a pullback fill
  const closedTrades: ClosedTrade[] = [];
  const closedToday = new Set<string>();
  const equityCurve: EquityPoint[] = [];

  // Fill-model telemetry.
  let restingPlaced = 0;
  let restingFilled = 0;
  let restingExpired = 0;                        // never pulled back / EOD-cancel
  let restingCancelledInvalid = 0;               // setup invalidated while resting (live < EMA50)
  const fillDelays: number[] = [];               // bars from placement to fill

  const sectorOf = (t: string) => assetMeta.find(a => a.ticker === t)?.sector ?? "Unknown";
  const dayIndex = new Map<string, number>();
  tradingDays.forEach((d, i) => dayIndex.set(d, i));

  function currentEquity(barByTicker: Map<string, Bar>) {
    let eq = cash;
    for (const p of positions) {
      const bar = barByTicker.get(p.ticker);
      const px = bar?.close ?? p.entryPrice;
      eq += mtmPosition(p, px);
    }
    return eq;
  }

  // ── Open a managed position (shared by both sleeves once entry price is known) ──
  function openPosition(args: {
    ticker: string; sleeve: Sleeve; day: string; entryPrice: number;
    units: number; stopLoss: number; takeProfit: number; entryScore: number;
  }) {
    const riskPerShare = Math.abs(args.entryPrice - args.stopLoss);
    positions.push({
      ticker: args.ticker,
      sleeve: args.sleeve,
      sector: sectorOf(args.ticker),
      entryDate: args.day,
      entryPrice: args.entryPrice,
      units: args.units,
      initialUnits: args.units,
      notional: args.units * args.entryPrice,
      stopLoss: args.stopLoss,
      takeProfit: args.takeProfit,
      initialSl: args.stopLoss,
      extremePrice: args.entryPrice,
      partialTp1Done: false,
      partialTp2Done: false,
      slAtBreakeven: false,
      realizedPnl: 0,
      entryScore: args.entryScore,
      riskPerShare: riskPerShare > 0 ? riskPerShare : args.entryPrice * 0.05,
    });
  }

  // ── Golden exit ladder — IDENTICAL to elza-backtest manageExits (long-only here) ──
  function manageExits(day: string, barByTicker: Map<string, Bar>) {
    for (let i = positions.length - 1; i >= 0; i--) {
      const pos = positions[i];
      const bar = barByTicker.get(pos.ticker);
      if (!bar) continue;

      const { close, high } = bar;
      pos.extremePrice = Math.max(pos.extremePrice, high);

      const histBars = barsUpTo(priceMap[pos.ticker] ?? [], day);
      const liveScore = histBars.length >= 50 ? calcZivEngineScore(histBars).score : pos.entryScore;

      const risk = pos.riskPerShare;
      const r = risk > 0 ? (close - pos.entryPrice) / risk : 0;
      if (!pos.slAtBreakeven && r >= BREAKEVEN_TRIGGER_R) {
        pos.stopLoss = pos.entryPrice * 1.002;
        pos.slAtBreakeven = true;
      }

      const target1 = calcTarget1Price(pos.entryPrice, pos.initialSl, "long", PARTIAL_TP1_R);
      const target2 = calcTarget1Price(pos.entryPrice, pos.initialSl, "long", PARTIAL_TP2_R);

      const closePartial = (frac: number, price: number, reason: string) => {
        const unitsToClose = Math.max(1, Math.floor(pos.initialUnits * frac));
        const actual = Math.min(unitsToClose, pos.units);
        if (actual <= 0) return;
        const exitPx = price * (1 - SLIPPAGE);
        const pnl = legPnl(pos.entryPrice, exitPx, actual);
        pos.realizedPnl += pnl;
        cash += pnl;
        pos.units -= actual;
        pos.notional = pos.units * pos.entryPrice;
        closedTrades.push({
          ticker: pos.ticker, sleeve: pos.sleeve, entryDate: pos.entryDate, exitDate: day,
          entryPrice: pos.entryPrice, exitPrice: exitPx, units: actual, pnl,
          pnlPct: ((exitPx / pos.entryPrice) - 1) * 100,
          pnlR: pos.riskPerShare > 0 ? (exitPx - pos.entryPrice) / pos.riskPerShare * (actual / pos.initialUnits) : 0,
          exitReason: reason, entryScore: pos.entryScore,
        });
      };

      const hitTp1 = high >= target1;
      const hitTp2 = high >= target2;
      if (!pos.partialTp1Done && hitTp1 && pos.units > 1) {
        closePartial(PARTIAL_TP1_FRAC, target1, "partial_tp_1.5R");
        pos.partialTp1Done = true;
        pos.stopLoss = pos.entryPrice * 1.002;
        pos.slAtBreakeven = true;
      }
      if (pos.partialTp1Done && !pos.partialTp2Done && hitTp2 && pos.units > 1) {
        closePartial(PARTIAL_TP2_FRAC, target2, "partial_tp_2.5R");
        pos.partialTp2Done = true;
      }

      let exitReason: string | null = null;
      let exitPrice = close;

      const hitSl = bar.low <= pos.stopLoss;
      const hitTp = high >= pos.takeProfit;
      const trailingHit = pos.partialTp2Done && close <= pos.extremePrice * (1 - TRAILING_FROM_PEAK);
      const scoreExit = liveScore < LONG_EXIT_SCORE_MIN;

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
        const exitPx = exitPrice * (1 - SLIPPAGE);
        const finalLegPnl = legPnl(pos.entryPrice, exitPx, pos.units);
        cash += finalLegPnl;
        closedTrades.push({
          ticker: pos.ticker, sleeve: pos.sleeve, entryDate: pos.entryDate, exitDate: day,
          entryPrice: pos.entryPrice, exitPrice: exitPx, units: pos.units, pnl: finalLegPnl,
          pnlPct: ((exitPx / pos.entryPrice) - 1) * 100,
          pnlR: pos.riskPerShare > 0 ? (exitPx - pos.entryPrice) / pos.riskPerShare * (pos.units / pos.initialUnits) : 0,
          exitReason, entryScore: pos.entryScore,
        });
        closedToday.add(pos.ticker);
        positions.splice(i, 1);
      }
    }
  }

  // ── §5 Resting-LMT manager: fill on pullback, cancel on invalidation ──────────────
  // FILL MODEL: the resting LMT becomes `open` on the FIRST subsequent bar where
  // bar.low ≤ restingLimit. The fill price is the limit (passive — a marketable limit
  // resting below price executes at the limit when price trades down to it). On fill,
  // the stop is the wideLungSL computed at PLACEMENT, size is the qty reserved then.
  function processResting(day: string, barByTicker: Map<string, Bar>, regime: ReturnType<typeof getHistoricalRegime>) {
    for (let i = resting.length - 1; i >= 0; i--) {
      const ro = resting[i];
      const bar = barByTicker.get(ro.ticker);
      if (!bar) continue;

      // Already hold an open position on this ticker (R1 one-pipeline) → drop the rest.
      if (positions.some(p => p.ticker === ro.ticker)) {
        resting.splice(i, 1);
        restingCancelledInvalid++;
        continue;
      }

      // FILL: a pullback to/through the resting limit.
      if (bar.low <= ro.restingLimit) {
        const placedIdx = dayIndex.get(ro.placedDate) ?? 0;
        const fillIdx = dayIndex.get(day) ?? placedIdx;
        fillDelays.push(Math.max(0, fillIdx - placedIdx));
        restingFilled++;

        // takeProfit ladder anchor — same 5:1-style band the elza ladder uses (TP via R).
        const takeProfit = ro.restingLimit + (ro.restingLimit - ro.stop) * 5.0;
        openPosition({
          ticker: ro.ticker, sleeve: "retest", day, entryPrice: ro.restingLimit,
          units: ro.units, stopLoss: ro.stop, takeProfit, entryScore: ro.entryScore,
        });
        resting.splice(i, 1);
        continue;
      }

      // Setup invalidation while resting: uptrend dead (close < EMA50) → cancel.
      const histBars = barsUpTo(priceMap[ro.ticker] ?? [], day);
      if (histBars.length >= 50) {
        const closes = histBars.map(b => b.close);
        const ema50 = calcEMA(closes, 50);
        if (bar.close < ema50) {
          resting.splice(i, 1);
          restingCancelledInvalid++;
          continue;
        }
      }
    }
  }

  // ── Scan for new entries: retest → resting LMT; breakout → market buy ─────────────
  function scanEntries(day: string, barByTicker: Map<string, Bar>, regime: ReturnType<typeof getHistoricalRegime>) {
    if (!regime.longOk) return;

    interface Cand { ticker: string; tier: "Gold Retest" | "Gold Breakout"; finalScore: number; bars: Bar[]; ema20: number; ema50: number }
    const candidates: Cand[] = [];

    const equityNow = currentEquity(barByTicker);

    for (const t of activeTickers) {
      if (positions.some(p => p.ticker === t)) continue;
      if (resting.some(r => r.ticker === t)) continue;
      if (closedToday.has(t)) continue;

      const bar = barByTicker.get(t);
      if (!bar || bar.close < 2) continue;

      const histBars = barsUpTo(priceMap[t] ?? [], day);
      if (histBars.length < 50) continue;

      const intel = getTickerIntelligence(histBars);
      if (intel.liquidityScore < MIN_LIQUIDITY_SCORE) continue;

      const ziv = calcZivEngineScore(histBars);
      if (ziv.tier !== "Gold Retest" && ziv.tier !== "Gold Breakout") continue;
      if (ziv.score < LONG_ENTRY_MIN_SCORE) continue;
      if (intel.confluenceScore < MIN_CONFLUENCE) continue;
      if (!intel.weeklyAligned) continue;

      const closes = histBars.map(b => b.close);
      const ema20 = calcEMA(closes, 20);
      const ema50 = calcEMA(closes, 50);

      const newClose = closes;
      const correlated = positions.some(p => {
        const oc = barsUpTo(priceMap[p.ticker] ?? [], day).map(b => b.close);
        return calcCorrelation(newClose, oc) > MAX_CORRELATION;
      });
      if (correlated) continue;

      const sector = sectorOf(t);
      const sectorPos = positions.filter(p => sectorOf(p.ticker) === sector);
      if (sectorPos.length >= MAX_POSITIONS_PER_SECTOR) continue;
      const sectorVal = sectorPos.reduce((s, p) => s + p.notional, 0);
      if (equityNow > 0 && sectorVal / equityNow >= MAX_SECTOR_EQUITY_PCT) continue;

      candidates.push({ ticker: t, tier: ziv.tier, finalScore: ziv.score, bars: histBars, ema20, ema50 });
    }

    candidates.sort((a, b) => b.finalScore - a.finalScore);

    for (const c of candidates) {
      if (positions.length >= elza.maxTotal) break;

      const bar = barByTicker.get(c.ticker)!;
      const livePrice = bar.close;   // backtest "live price" = current bar close (no intraday quote)

      if (c.tier === "Gold Retest") {
        // ── RESTING LMT path (THE WAITER) ──────────────────────────────────────────
        // Slot guard: open retests + resting LMTs < MAX_RETEST_SLOTS.
        const usedSlots = positions.filter(p => p.sleeve === "retest").length + resting.length;
        if (usedSlots >= MAX_RETEST_SLOTS) continue;

        // Zone gate: price approaching EMA-20 from above in a confirmed uptrend.
        const zone = isNearRetestZone({ livePrice, ema20: c.ema20, ema50: c.ema50 });
        if (!zone.near) continue;

        // Ambush limit = EMA20 × 1.005 (anti-chase: must be below live, ≥ $2).
        const ambush = computeAmbushLimit(c.ema20, livePrice);
        if (!(ambush.limit > 0)) continue;

        // Structural stop off the ambush level (the SAME wideLungSL the live order pairs).
        let stop: number;
        try { stop = wideLungSL(ambush.limit, c.ema50, "long"); } catch { continue; }

        // 1%-risk sizing — IDENTICAL to Elza (vixRiskSize off ambush entry + wideLungSL stop).
        const sized = vixRiskSize({ nlv: elza.totalNlv, entry: ambush.limit, stop, vix: regime.vix });
        if (sized.skip || !(sized.shares > 0)) continue;

        // §3 30% NLV sub-cap on the aggregate retest sleeve (open + resting notional).
        const thisNotional = sized.shares * ambush.limit;
        const sleeveUsed = retestSleeveNotional(positions, resting);
        if (sleeveUsed + thisNotional > WAITER_NLV_PCT * elza.totalNlv) continue;

        // Buying-power cap (shared allocatedCapital) against open positions.
        if (deployedNotional(positions) + thisNotional > elza.allocatedCapital) continue;

        resting.push({
          ticker: c.ticker, sector: sectorOf(c.ticker), placedDate: day,
          restingLimit: ambush.limit, stop, units: sized.shares,
          entryScore: c.finalScore, ema20: c.ema20,
        });
        restingPlaced++;
      } else {
        // ── BREAKOUT path (UNCHANGED elza-backtest market entry) ────────────────────
        const deployedNow = deployedNotional(positions);
        const remaining = elza.allocatedCapital - deployedNow;
        if (remaining < elza.minPositionUsd) continue;

        const entryPrice = bar.close * (1 + SLIPPAGE);
        let sizeUsd = Math.min(elza.perPositionUsd, remaining, elza.maxPositionUsd);
        sizeUsd = Math.max(sizeUsd, elza.minPositionUsd);
        if (sizeUsd > remaining) continue;

        const ema50 = ema50FromBars(c.bars);
        let entrySlTp = calcEntrySlTp({ entryPrice, ema50, bars: c.bars, direction: "long" });
        if (!entrySlTp.stopLoss || entrySlTp.stopLoss >= entryPrice) {
          entrySlTp = { ...entrySlTp, stopLoss: entryPrice * 0.97, takeProfit: entryPrice * 1.06 };
        }

        const units = Math.floor(sizeUsd / entryPrice);
        if (units < 1) continue;
        const notional = units * entryPrice;
        if (deployedNotional(positions) + notional > elza.allocatedCapital) continue;

        openPosition({
          ticker: c.ticker, sleeve: "breakout", day, entryPrice, units,
          stopLoss: entrySlTp.stopLoss, takeProfit: entrySlTp.takeProfit, entryScore: c.finalScore,
        });
      }
    }
  }

  // ── Daily loop ────────────────────────────────────────────────────────────────
  for (const day of tradingDays) {
    closedToday.clear();
    const barByTicker = new Map<string, Bar>();
    for (const t of activeTickers) {
      const bar = priceMap[t]?.find(b => b.date === day);
      if (bar) barByTicker.set(t, bar);
    }

    const regime = getHistoricalRegime(spyBars, day);
    manageExits(day, barByTicker);
    processResting(day, barByTicker, regime);   // fills happen on the SUBSEQUENT bar (placed yesterday or earlier)
    scanEntries(day, barByTicker, regime);

    const eq = currentEquity(barByTicker);
    equityCurve.push({
      date: day, equity: eq, cash,
      positions: positions.length,
      retests: positions.filter(p => p.sleeve === "retest").length,
      breakouts: positions.filter(p => p.sleeve === "breakout").length,
      resting: resting.length,
    });
  }

  // ── End-of-data: any resting LMT that never filled is CANCELLED (no trade). ──
  restingExpired += resting.length;
  resting.length = 0;

  // Mark-out any still-open positions at the last close.
  const lastDay = tradingDays[tradingDays.length - 1];
  for (const pos of [...positions]) {
    const bar = priceMap[pos.ticker]?.find(b => b.date === lastDay);
    const exitPx = (bar?.close ?? pos.entryPrice) * (1 - SLIPPAGE);
    const pnl = legPnl(pos.entryPrice, exitPx, pos.units);
    cash += pnl;
    closedTrades.push({
      ticker: pos.ticker, sleeve: pos.sleeve, entryDate: pos.entryDate, exitDate: lastDay,
      entryPrice: pos.entryPrice, exitPrice: exitPx, units: pos.units, pnl,
      pnlPct: ((exitPx / pos.entryPrice) - 1) * 100,
      pnlR: pos.riskPerShare > 0 ? (exitPx - pos.entryPrice) / pos.riskPerShare * (pos.units / pos.initialUnits) : 0,
      exitReason: "end_of_backtest", entryScore: pos.entryScore,
    });
  }
  positions.length = 0;

  // ── Performance ────────────────────────────────────────────────────────────────
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

  // Per-sleeve drawdown (equity slice of each sleeve's own mark-to-market would require a
  // separate book; here we report the FULL-portfolio max-DD plus each sleeve's stand-alone
  // expectancy/return so the EDGE gate is on retest-sleeve stats, not commingled equity).
  const retest = sleeveStats(closedTrades, "retest", STARTING_CAPITAL);
  const breakout = sleeveStats(closedTrades, "breakout", STARTING_CAPITAL);

  const fillRatePct = restingPlaced > 0 ? (restingFilled / restingPlaced) * 100 : 0;
  const avgFillDelayBars = fillDelays.length ? fillDelays.reduce((a, b) => a + b, 0) / fillDelays.length : 0;

  const results = {
    meta: {
      generatedAt: new Date().toISOString(),
      model: "The Waiter — retest RESTING-LMT entry vs Gold-Breakout market entry (elza-backtest exit ladder)",
      period: { start: BACKTEST_START, end: BACKTEST_END, lookbackFrom: LOOKBACK_START },
      universe: { catalogueUsa: usaAssets.length, withData: activeTickers.length },
      waiterConfig: {
        ambushMult: 1.005,
        maxRetestSlots: MAX_RETEST_SLOTS,
        waiterNlvPct: WAITER_NLV_PCT,
        riskPct: 0.01,
      },
      liveConfig: {
        totalNlv: elza.totalNlv,
        cashBudget: elza.cashBudget,
        allocatedCapital: elza.allocatedCapital,
        perPositionUsd: elza.perPositionUsd,
      },
      assumptions: [
        "RETEST: resting LMT = EMA20×1.005 (computeAmbushLimit), gated by isNearRetestZone",
        "FILL = first subsequent bar where low ≤ restingLimit; fill price = limit (passive pullback)",
        "Never pulled back / EOD-of-data → cancelled, NO trade",
        "RETEST size = vixRiskSize (1% NLV risk); stop = wideLungSL(ambush, ema50)",
        "BREAKOUT path UNCHANGED from elza-backtest (market buy, perPositionUsd sizing)",
        "Backtest 'live price' = current daily-bar close (no intraday quote in cache)",
        "Both sleeves share the elza-backtest golden exit ladder (TP1/TP2/trail/score-decay)",
        "Commission $2.50/leg; 0.1% slippage",
      ],
    },
    fillModel: {
      restingPlaced,
      restingFilled,
      restingExpired,
      restingCancelledInvalid,
      fillRatePct: Math.round(fillRatePct * 10) / 10,
      avgFillDelayBars: Math.round(avgFillDelayBars * 100) / 100,
    },
    retestSleeve: retest,
    breakoutSleeve: breakout,
    sideBySide: {
      retest: { expectancyR: retest.expectancyR, winRatePct: retest.winRatePct, totalReturnPct: retest.totalReturnPct, roundTrips: retest.roundTrips },
      breakout: { expectancyR: breakout.expectancyR, winRatePct: breakout.winRatePct, totalReturnPct: breakout.totalReturnPct, roundTrips: breakout.roundTrips },
    },
    portfolio: {
      startingCapital: STARTING_CAPITAL,
      finalEquity: Math.round(finalEquity * 100) / 100,
      totalPnl: Math.round(totalPnl * 100) / 100,
      totalReturnPct: Math.round(totalReturnPct * 100) / 100,
      maxDrawdownPct: Math.round(maxDd * 10000) / 100,
      spyBuyAndHoldPct: Math.round(spyBhPct * 100) / 100,
    },
    weeklyEquity: weekly,
    trades: closedTrades.slice(0, 300),
    tradeCount: closedTrades.length,
  };

  const outPath = path.join(process.cwd(), "scripts", "waiterBacktest-results.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  console.log("\n=== FILL MODEL ===");
  console.log(`Placed: ${restingPlaced} | Filled: ${restingFilled} | Expired(no-pullback/EOD): ${restingExpired} | Cancelled(invalid): ${restingCancelledInvalid}`);
  console.log(`Fill-rate: ${results.fillModel.fillRatePct}% | Avg fill-delay: ${results.fillModel.avgFillDelayBars} bars`);

  console.log("\n=== RETEST SLEEVE (THE WAITER — the EDGE gate) ===");
  console.log(`Round trips: ${retest.roundTrips} | Win-rate: ${retest.winRatePct}% | Expectancy: ${retest.expectancyR}R/trade`);
  console.log(`Return: ${retest.totalReturnPct}% | P&L: $${retest.totalPnl.toLocaleString()}`);

  console.log("\n=== BREAKOUT SLEEVE (elza market entry — baseline) ===");
  console.log(`Round trips: ${breakout.roundTrips} | Win-rate: ${breakout.winRatePct}% | Expectancy: ${breakout.expectancyR}R/trade`);
  console.log(`Return: ${breakout.totalReturnPct}% | P&L: $${breakout.totalPnl.toLocaleString()}`);

  console.log("\n=== SIDE-BY-SIDE ===");
  console.log(`            RETEST        BREAKOUT`);
  console.log(`Expectancy  ${retest.expectancyR}R`.padEnd(26) + `${breakout.expectancyR}R`);
  console.log(`Win-rate    ${retest.winRatePct}%`.padEnd(26) + `${breakout.winRatePct}%`);
  console.log(`Return      ${retest.totalReturnPct}%`.padEnd(26) + `${breakout.totalReturnPct}%`);
  console.log(`RoundTrips  ${retest.roundTrips}`.padEnd(26) + `${breakout.roundTrips}`);

  console.log("\n=== PORTFOLIO (commingled) ===");
  console.log(`Starting: $${STARTING_CAPITAL.toLocaleString()} → Final: $${results.portfolio.finalEquity.toLocaleString()}`);
  console.log(`Return: ${results.portfolio.totalReturnPct}% | Max DD: ${results.portfolio.maxDrawdownPct}% | SPY B&H: ${results.portfolio.spyBuyAndHoldPct}%`);

  const verdict = retest.expectancyR > 0 && retest.roundTrips >= 5
    ? `EDGE: POSITIVE — retest expectancy ${retest.expectancyR}R over ${retest.roundTrips} trips, max-DD ${results.portfolio.maxDrawdownPct}%`
    : retest.roundTrips < 5
      ? `EDGE: INCONCLUSIVE — only ${retest.roundTrips} retest round-trips (need ≥5 to trust expectancy)`
      : `EDGE: NEGATIVE — retest expectancy ${retest.expectancyR}R ≤ 0`;
  console.log(`\n=== EDGE VERDICT ===\n${verdict}`);
  console.log(`\nWritten to ${outPath}`);
  process.exit(0);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
