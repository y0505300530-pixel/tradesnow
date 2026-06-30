/**
 * waiterBacktest5m.ts — THE WAITER, FOCUSED 5-MINUTE backtest (Stage B of the G2-INTRADAY
 * protocol, docs/QA_PLAN_WAITER_V45.md "נספח B").
 *
 * WHY 5m: G2 on DAILY bars is invalid for the Waiter (the reviewer's binding conclusion). The
 * Waiter is an INTRADAY mechanism — the ±2% touch at retestLevel happens tick-by-tick *within
 * the day* (price touches the level and bounces) while the daily CLOSE is extended. A daily
 * backtest gates eligibility on the close but fills on the low → ~0 fills even when the code is
 * correct. This harness evaluates the SAME WAITER-ZIV-SSOT gate (retestEligible) per 5-MINUTE
 * bar and fills the resting LMT when a 5m bar's low ≤ limitPrice. THAT is the real G2.
 *
 * SCOPE (per the protocol — keep it cheap, avoid Yahoo rate-limits):
 *   • Window: 30 NYSE days (default; override WAITER_BT5M_DAYS).
 *   • Universe: ONLY the tickers that hit "Gold Retest" tier in the DAILY pass — pass them via
 *     WAITER_BT5M_TICKERS="AAPL,MSFT,..." (waiterBacktest.ts prints this list at the end). NOT
 *     the full 214-name universe.
 *   • 5m source: fetchIntradayBarsForTicker(ticker, '5m', start, end) (server/intradayMarketData.ts;
 *     Yahoo, ~55 calendar days per chunk). Daily bars (for the Ziv gate: retestLevel / ema50 /
 *     weeklyBullish / tier) come from the DB price cache (getBulkCachedPrices) — the SAME source
 *     the daily pass uses, so the structural signal is identical; only the FILL resolution is 5m.
 *
 * GATE PARITY (non-negotiable — the SAME gate the daily pass + live war cycle use):
 *   retestEligible(...) — Gold Retest + retestLevel!=null + WK-L weeklyBullish + live>ema50 +
 *   distPct≤2% + live≥level×0.98 + gapGuard FOMO≤1.5% + distPct≤5%. NO evaluateRetestV2/detectZones.
 *   LMT = computeAmbushLimit(retestLevel, live).limit = retestLevel × 1.0075 (FOMO-capped 1.015).
 *   Stop = computeRetestStop(...).stop (retestLevel × 0.99, wideLungSL-bounded). FAIL-CLOSED.
 *
 * FILL MODEL (intraday): the daily Ziv signal (retestLevel / ema50 / WK-L / tier) is computed from
 * daily bars up to the PRIOR close (the signal that is "live" at the open). During the session we
 * walk the 5m RTH bars in order: a name with no resting LMT becomes eligible the FIRST 5m bar whose
 * CLOSE passes retestEligible (live = 5m close) — we place the resting LMT then; the LMT FILLS on
 * the FIRST SUBSEQUENT 5m bar whose LOW ≤ limit (passive pullback; fill price = limit). On fill it
 * is a normal managed position; exits run the SAME golden ladder as waiterBacktest, evaluated per
 * 5m bar (intrabar high/low/close). EOD (last 5m bar of the session): an unfilled LMT is CANCELLED
 * (DAY tif — no overnight ambush), mirroring the live Waiter.
 *
 * Reports: placed, filled, fills/session, AvgR, win-rate + the funnel.
 * If fetchIntradayBarsForTicker 5m is unavailable / rate-limited / returns empty: this does NOT
 * fail — it reports "5M_UNAVAILABLE" per ticker and a final NO-DATA verdict (→ the shadow/2-slots
 * fallback in the protocol).
 *
 * Run (LOCAL — needs .env + DB price cache reachable for the daily Ziv gate; Yahoo for 5m):
 *   WAITER_BT5M_TICKERS="AAPL,MSFT,..." node --import tsx --env-file=.env scripts/waiterBacktest5m.ts
 * DB is droplet-only (ECONNREFUSED locally) → run THERE with the same command.
 *
 * READ-ONLY backtest: no DB writes, no IBKR calls, no order placement.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { getDb, getBulkCachedPrices, getUserAssets } from "../server/db";
import { calcZivEngineScore, calcEMA } from "../server/zivEngine";
import {
  computeAmbushLimit,
  computeRetestStop,
  capSharesToMaxPosition,
  retestEligible,
} from "../server/waiterEngine";
import { classifyWeeklyTrend } from "../server/weeklyTrend";
import { vixRiskSize } from "../server/engine/elzaV45Master";
import { calcTarget1Price } from "../server/slCalculator";
import { fetchIntradayBarsForTicker, filterRegularSession, type IntradayBar } from "../server/intradayMarketData";
import { liveEngineConfig, type LiveEngineConfig } from "../drizzle/schema";
import { eq } from "drizzle-orm";

// ─── Exit-ladder constants (IDENTICAL to waiterBacktest.ts — the golden ladder) ────
const PARTIAL_TP1_R = 1.5;
const PARTIAL_TP2_R = 2.5;
const PARTIAL_TP1_FRAC = 0.33;
const PARTIAL_TP2_FRAC = 0.33;
const TRAILING_FROM_PEAK = 0.15;
const BREAKEVEN_TRIGGER_R = 1.5;
const COMMISSION = 2.5;
const SLIPPAGE = 0.001;

const USER_ID = 1;

// ─── Window: 30 NYSE days by default (the protocol's "30 יום NYSE בלבד"). ──────────
const SESSION_DAYS = Number(process.env.WAITER_BT5M_DAYS ?? 30);
// Calendar end (default today). Start = end − ~ceil(SESSION_DAYS × 1.5) cal days to cover the
// sessions (weekends/holidays). Yahoo 5m only retains ~60 calendar days, so 30 sessions is safe.
const END_DATE = process.env.WAITER_BT5M_END ?? new Date().toISOString().slice(0, 10);
const CAL_SPAN = Math.ceil(SESSION_DAYS * 1.6) + 5;
const START_DATE =
  process.env.WAITER_BT5M_START ??
  new Date(new Date(`${END_DATE}T00:00:00Z`).getTime() - CAL_SPAN * 86400_000).toISOString().slice(0, 10);
// Daily lookback for the Ziv structural gate (needs ≥ lookback+confirm history before the window).
const DAILY_LOOKBACK = process.env.WAITER_BT5M_DAILY_LOOKBACK ?? "2025-09-01";

type Bar = { date: string; open: number; high: number; low: number; close: number; volume: number };

function parseTickers(): string[] {
  const raw = process.env.WAITER_BT5M_TICKERS ?? "";
  return [...new Set(raw.split(/[,\s]+/).map(t => t.trim().toUpperCase()).filter(Boolean))];
}

function buildConfig(cfg: LiveEngineConfig) {
  const nlv = cfg.totalNlv ?? 120_000;
  const maxPos = cfg.maxPositionUsd ?? 70_000;
  const retestSlots = (cfg as any).maxRetestSlots ?? 8;
  const retestNlvPct = (cfg as any).waiterNlvPct ?? 0.30;
  return { totalNlv: nlv, maxPositionUsd: maxPos, maxRetestSlots: retestSlots, waiterNlvPct: retestNlvPct };
}

function barsUpTo(allBars: Bar[], date: string): Bar[] {
  const idx = allBars.findIndex(b => b.date > date);
  return idx === -1 ? allBars : allBars.slice(0, idx);
}

function legPnl(entry: number, exit: number, units: number) {
  return (exit - entry) * units - COMMISSION;
}

// ─── State ─────────────────────────────────────────────────────────────────────────
interface RestingOrder {
  ticker: string; placedDate: string; restingLimit: number; stop: number; units: number;
  entryScore: number; retestLevel: number;
}
interface Position {
  ticker: string; entryDate: string; entryPrice: number; units: number; initialUnits: number;
  stopLoss: number; takeProfit: number; initialSl: number; extremePrice: number;
  partialTp1Done: boolean; partialTp2Done: boolean; slAtBreakeven: boolean;
  realizedPnl: number; entryScore: number; riskPerShare: number;
}
interface ClosedTrade {
  ticker: string; entryDate: string; exitDate: string; entryPrice: number; exitPrice: number;
  units: number; pnl: number; pnlR: number; exitReason: string;
}

async function main() {
  console.log("=== THE WAITER — FOCUSED 5-MINUTE Backtest (Stage B / G2-INTRADAY) ===");

  const tickers = parseTickers();
  if (!tickers.length) {
    console.error(
      "NO UNIVERSE: set WAITER_BT5M_TICKERS to the Gold-Retest names from the daily pass, e.g.\n" +
      '  WAITER_BT5M_TICKERS="AAPL,MSFT,NVDA" node --import tsx --env-file=.env scripts/waiterBacktest5m.ts\n' +
      "(waiterBacktest.ts prints this comma list at the end of its run.)",
    );
    process.exit(2);
  }

  const db = await getDb();
  if (!db) throw new Error("DB unavailable (daily Ziv gate needs the price cache)");
  const cfgRows = await db.select().from(liveEngineConfig).where(eq(liveEngineConfig.userId, USER_ID));
  const liveCfg = cfgRows[0];
  if (!liveCfg) throw new Error("liveEngineConfig not found for user 1");
  const cfg = buildConfig(liveCfg);

  // VIX proxy for sizing — neutral default (parity with the daily pass's regime fallback).
  const VIX = 18;

  console.log(`Window: ${START_DATE} → ${END_DATE} (~${SESSION_DAYS} NYSE sessions) | universe: ${tickers.length} Gold-Retest names`);
  console.log(`NLV $${cfg.totalNlv.toLocaleString()} | maxPos $${cfg.maxPositionUsd.toLocaleString()} | slots ${cfg.maxRetestSlots} | sleeve ${(cfg.waiterNlvPct * 100).toFixed(0)}%`);

  // ── Daily bars (DB cache) for the Ziv structural gate — the SAME source the daily pass uses ──
  const dailyMap = await getBulkCachedPrices(tickers, DAILY_LOOKBACK, END_DATE);

  // ── Funnel (per-5m evaluation) — mirrors waiterBacktest.ts Stage-A buckets ──────────
  const funnel = {
    fiveMinBarsScanned: 0,
    goldRetestSessions: 0,   // (ticker,session) pairs where the DAILY signal was Gold Retest
    notTier: 0, notWeeklyBullish: 0, belowEma50: 0, distPctBlocked: 0,
    belowFloor: 0, fomoBlocked: 0, distTooFar: 0, ambushNull: 0,
    stopFail: 0, sizedOut: 0, maxPosCap: 0, placed: 0,
  };
  function bucketEligDrop(reason: string) {
    if (reason.includes("no WK-L")) { funnel.notWeeklyBullish++; return; }
    if (reason.includes("RT-08")) { funnel.belowEma50++; return; }
    if (reason.includes("RT-03")) { funnel.distPctBlocked++; return; }
    if (reason.includes("RT-04")) { funnel.belowFloor++; return; }
    if (reason.includes("EX-03")) { funnel.fomoBlocked++; return; }
    if (reason.includes("EX-07")) { funnel.distTooFar++; return; }
    funnel.notTier++;
  }

  const closedTrades: ClosedTrade[] = [];
  let restingPlaced = 0;
  let restingFilled = 0;
  let restingExpiredEod = 0;
  const sessionsWithFills = new Set<string>();
  const noDataTickers: string[] = [];
  const dataTickers: string[] = [];

  // ── Per-ticker independent book (focused single-name 5m sim — slot/sleeve caps applied
  // per-ticker since the 5m universe is the isolated Gold-Retest list, not the full book). ──
  for (const ticker of tickers) {
    const daily = (dailyMap[ticker] ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
    if (daily.length < 50) {
      console.log(`  ${ticker}: SKIP — daily history < 50 bars (${daily.length}) for the Ziv gate`);
      continue;
    }

    // 5m bars (Yahoo). FAIL-SOFT: empty/throw → report NO-DATA, do NOT abort the run.
    let intraday: IntradayBar[] = [];
    try {
      intraday = await fetchIntradayBarsForTicker(ticker, "5m", START_DATE, END_DATE);
    } catch (e: any) {
      console.log(`  ${ticker}: 5M_UNAVAILABLE — fetch threw: ${String(e?.message ?? e).slice(0, 80)}`);
      noDataTickers.push(ticker);
      continue;
    }
    const rth = filterRegularSession(intraday);
    if (!rth.length) {
      console.log(`  ${ticker}: 5M_UNAVAILABLE — 0 RTH 5m bars in window (rate-limited / outside Yahoo's ~60d retention?)`);
      noDataTickers.push(ticker);
      continue;
    }
    dataTickers.push(ticker);

    // Group 5m bars by session date.
    const bySession = new Map<string, IntradayBar[]>();
    for (const b of rth) {
      if (!bySession.has(b.date)) bySession.set(b.date, []);
      bySession.get(b.date)!.push(b);
    }
    const sessions = [...bySession.keys()].sort().slice(-SESSION_DAYS);

    let resting: RestingOrder | null = null;
    let position: Position | null = null;

    for (const session of sessions) {
      const bars = bySession.get(session)!.slice().sort((a, b) => a.ts - b.ts);

      // ── DAILY Ziv signal as of the PRIOR close (the signal "live" at the open) ──────
      // Use daily bars strictly BEFORE this session (no look-ahead on the structural level).
      const priorDaily = daily.filter(d => d.date < session);
      if (priorDaily.length < 50) continue;
      const ziv = calcZivEngineScore(priorDaily as any);
      const closes = priorDaily.map(d => d.close);
      const ema50 = calcEMA(closes, 50);
      const retestLevel = (ziv as any).retestLevel ?? null;
      const tier = ziv.tier;
      const weeklyBullish = classifyWeeklyTrend(priorDaily as any).structure === "WK-L";
      const isGoldRetest = tier === "Gold Retest" && Number(retestLevel) > 0;
      if (isGoldRetest) funnel.goldRetestSessions++;

      // ── Walk the session's 5m bars ───────────────────────────────────────────────
      for (let bi = 0; bi < bars.length; bi++) {
        const bar = bars[bi];
        funnel.fiveMinBarsScanned++;
        const live = bar.close;

        // ── 1) MANAGE an open position (golden ladder, evaluated per 5m bar) ──────────
        if (position) {
          const pos = position;
          pos.extremePrice = Math.max(pos.extremePrice, bar.high);
          const risk = pos.riskPerShare;
          const r = risk > 0 ? (bar.close - pos.entryPrice) / risk : 0;
          if (!pos.slAtBreakeven && r >= BREAKEVEN_TRIGGER_R) {
            pos.stopLoss = pos.entryPrice * 1.002; pos.slAtBreakeven = true;
          }
          const target1 = calcTarget1Price(pos.entryPrice, pos.initialSl, "long", PARTIAL_TP1_R);
          const target2 = calcTarget1Price(pos.entryPrice, pos.initialSl, "long", PARTIAL_TP2_R);

          const closePartial = (frac: number, price: number, reason: string) => {
            const want = Math.max(1, Math.floor(pos.initialUnits * frac));
            const actual = Math.min(want, pos.units);
            if (actual <= 0) return;
            const exitPx = price * (1 - SLIPPAGE);
            const pnl = legPnl(pos.entryPrice, exitPx, actual);
            pos.realizedPnl += pnl; pos.units -= actual;
            closedTrades.push({
              ticker: pos.ticker, entryDate: pos.entryDate, exitDate: bar.datetime,
              entryPrice: pos.entryPrice, exitPrice: exitPx, units: actual, pnl,
              pnlR: pos.riskPerShare > 0 ? (exitPx - pos.entryPrice) / pos.riskPerShare * (actual / pos.initialUnits) : 0,
              exitReason: reason,
            });
          };

          if (!pos.partialTp1Done && bar.high >= target1 && pos.units > 1) {
            closePartial(PARTIAL_TP1_FRAC, target1, "partial_tp_1.5R");
            pos.partialTp1Done = true; pos.stopLoss = pos.entryPrice * 1.002; pos.slAtBreakeven = true;
          }
          if (pos.partialTp1Done && !pos.partialTp2Done && bar.high >= target2 && pos.units > 1) {
            closePartial(PARTIAL_TP2_FRAC, target2, "partial_tp_2.5R");
            pos.partialTp2Done = true;
          }

          let exitReason: string | null = null;
          let exitPrice = bar.close;
          const hitSl = bar.low <= pos.stopLoss;
          const hitTp = bar.high >= pos.takeProfit;
          const trailingHit = pos.partialTp2Done && bar.close <= pos.extremePrice * (1 - TRAILING_FROM_PEAK);
          if (hitSl) { exitReason = pos.slAtBreakeven ? "breakeven_stop" : "stop_loss"; exitPrice = pos.stopLoss; }
          else if (hitTp) { exitReason = "take_profit"; exitPrice = pos.takeProfit; }
          else if (trailingHit) { exitReason = "trailing_15pct_peak"; exitPrice = bar.close; }

          if (exitReason && pos.units > 0) {
            const exitPx = exitPrice * (1 - SLIPPAGE);
            const pnl = legPnl(pos.entryPrice, exitPx, pos.units);
            closedTrades.push({
              ticker: pos.ticker, entryDate: pos.entryDate, exitDate: bar.datetime,
              entryPrice: pos.entryPrice, exitPrice: exitPx, units: pos.units, pnl,
              pnlR: pos.riskPerShare > 0 ? (exitPx - pos.entryPrice) / pos.riskPerShare * (pos.units / pos.initialUnits) : 0,
              exitReason,
            });
            position = null;
          }
          continue;   // one event per 5m bar (don't also place/fill on a managed bar)
        }

        // ── 2) FILL a resting LMT on a 5m pullback (low ≤ limit; fill price = limit) ──
        if (resting) {
          if (bar.low <= resting.restingLimit) {
            restingFilled++;
            sessionsWithFills.add(`${ticker}|${session}`);
            const entryPrice = resting.restingLimit;
            const takeProfit = entryPrice + (entryPrice - resting.stop) * 5.0;
            const riskPerShare = Math.abs(entryPrice - resting.stop);
            position = {
              ticker, entryDate: bar.datetime, entryPrice, units: resting.units, initialUnits: resting.units,
              stopLoss: resting.stop, takeProfit, initialSl: resting.stop, extremePrice: entryPrice,
              partialTp1Done: false, partialTp2Done: false, slAtBreakeven: false, realizedPnl: 0,
              entryScore: resting.entryScore, riskPerShare: riskPerShare > 0 ? riskPerShare : entryPrice * 0.05,
            };
            resting = null;
          }
          continue;
        }

        // ── 3) PLACE a resting LMT when this 5m bar is eligible (WAITER-ZIV-SSOT) ─────
        if (!isGoldRetest) continue;   // daily structural signal is the prerequisite

        // pre-floor (RT-04 broken-below) — bucketed separately like the daily pass.
        if (Number(retestLevel) > 0 && live < (retestLevel as number) * 0.98) { funnel.belowFloor++; continue; }
        const elig = retestEligible({ tier, retestLevel, weeklyBullish, live, ema50 });
        if (!elig.eligible) { bucketEligDrop(elig.reason); continue; }

        const ambush = computeAmbushLimit(retestLevel, live);
        if (!(ambush.limit > 0)) { funnel.ambushNull++; continue; }

        const stopRes = computeRetestStop({ retestLevel, entry: ambush.limit, ema50 });
        if (!(stopRes.stop > 0)) { funnel.stopFail++; continue; }

        const sized = vixRiskSize({ nlv: cfg.totalNlv, entry: ambush.limit, stop: stopRes.stop, vix: VIX });
        if (sized.skip || !(sized.shares > 0)) { funnel.sizedOut++; continue; }

        const cap = capSharesToMaxPosition({
          sizedShares: sized.shares, entry: ambush.limit, existingTickerUnits: 0, maxPositionUsd: cfg.maxPositionUsd,
        });
        if (cap.cappedShares < 1) { funnel.maxPosCap++; continue; }

        resting = {
          ticker, placedDate: bar.datetime, restingLimit: ambush.limit, stop: stopRes.stop,
          units: cap.cappedShares, entryScore: ziv.score, retestLevel: retestLevel as number,
        };
        funnel.placed++; restingPlaced++;
      }

      // ── EOD: a still-resting LMT is cancelled (DAY tif — no overnight ambush). ──────
      if (resting) { restingExpiredEod++; resting = null; }
      // An open position carries overnight in the live model (managed); we keep it across
      // sessions and mark it out at the very end (below).
    }

    // Mark-out any still-open position at the last 5m close of the universe window.
    if (position) {
      const pos = position;
      const lastBars = bySession.get(sessions[sessions.length - 1]) ?? [];
      const lastPx = (lastBars.length ? lastBars[lastBars.length - 1].close : pos.entryPrice) * (1 - SLIPPAGE);
      const pnl = legPnl(pos.entryPrice, lastPx, pos.units);
      closedTrades.push({
        ticker: pos.ticker, entryDate: pos.entryDate, exitDate: "end_of_5m",
        entryPrice: pos.entryPrice, exitPrice: lastPx, units: pos.units, pnl,
        pnlR: pos.riskPerShare > 0 ? (lastPx - pos.entryPrice) / pos.riskPerShare * (pos.units / pos.initialUnits) : 0,
        exitReason: "end_of_backtest",
      });
    }

    console.log(`  ${ticker}: ${sessions.length} sessions, ${bySession.size} 5m-days loaded`);
  }

  // ── Stats — round-trip aggregation (per entry) ──────────────────────────────────
  const roundTrips = new Map<string, { pnl: number; pnlR: number }>();
  for (const t of closedTrades) {
    const key = `${t.ticker}|${t.entryDate}`;
    const cur = roundTrips.get(key) ?? { pnl: 0, pnlR: 0 };
    cur.pnl += t.pnl; cur.pnlR += t.pnlR;
    roundTrips.set(key, cur);
  }
  const rts = [...roundTrips.values()];
  const wins = rts.filter(r => r.pnl > 0).length;
  const totalR = rts.reduce((s, r) => s + r.pnlR, 0);
  const avgR = rts.length ? Math.round((totalR / rts.length) * 1000) / 1000 : 0;
  const winRatePct = rts.length ? Math.round((wins / rts.length) * 1000) / 10 : 0;
  const totalPnl = Math.round(closedTrades.reduce((s, t) => s + t.pnl, 0) * 100) / 100;

  // fills/session = filled LMTs / distinct (ticker,session) pairs that ran a 5m walk.
  const sessionsRun = funnel.goldRetestSessions;   // (ticker,session) pairs with a Gold-Retest signal
  const fillsPerSession = sessionsRun > 0 ? Math.round((restingFilled / sessionsRun) * 1000) / 1000 : 0;

  const noData = dataTickers.length === 0;
  const verdict = noData
    ? "G2-5M NO-DATA — 5m bars unavailable for EVERY ticker (rate-limited / outside Yahoo ~60d retention). NOT a code failure → trigger the shadow/2-slots fallback (protocol שלב ד / Fallback)."
    : `G2-5M ${funnel.placed > 0 ? "GO" : "NO-GO"} — placed ${funnel.placed}, filled ${restingFilled}, round-trips ${rts.length}, AvgR ${avgR}R, win-rate ${winRatePct}% (GO criterion: placed > 0)`;

  console.log("\n=== 5M FUNNEL (per-5m-bar WAITER-ZIV-SSOT eligibility) ===");
  console.log(`Tickers with 5m data: ${dataTickers.length} | NO-DATA: ${noDataTickers.length} ${noDataTickers.length ? `(${noDataTickers.join(",")})` : ""}`);
  console.log(`5m bars scanned: ${funnel.fiveMinBarsScanned} | Gold-Retest (ticker,session) signals: ${funnel.goldRetestSessions}`);
  console.log(`  ELIG drops: notTier ${funnel.notTier} | notWeeklyBullish ${funnel.notWeeklyBullish} | belowEma50 ${funnel.belowEma50} | distPctBlocked ${funnel.distPctBlocked} | belowFloor ${funnel.belowFloor} | fomoBlocked ${funnel.fomoBlocked} | distTooFar ${funnel.distTooFar}`);
  console.log(`  CAP drops: ambushNull ${funnel.ambushNull} | stopFail ${funnel.stopFail} | sizedOut ${funnel.sizedOut} | maxPosCap ${funnel.maxPosCap}`);
  console.log(`  → LMTs placed: ${funnel.placed}`);

  console.log("\n=== 5M FILL MODEL ===");
  console.log(`Placed: ${restingPlaced} | Filled: ${restingFilled} | Expired(EOD): ${restingExpiredEod} | fills/Gold-Retest-session: ${fillsPerSession}`);

  console.log("\n=== 5M RETEST SLEEVE (the real G2) ===");
  console.log(`Round-trips: ${rts.length} | Win-rate: ${winRatePct}% | AvgR: ${avgR}R | P&L: $${totalPnl.toLocaleString()}`);

  console.log(`\n=== G2-5M VERDICT (GO = placed > 0) ===\n${verdict}`);

  const results = {
    meta: {
      generatedAt: new Date().toISOString(),
      model: "The Waiter — FOCUSED 5m intraday backtest (Stage B / G2-INTRADAY). Daily Ziv gate as of prior close; per-5m-bar retestEligible; LMT fills on 5m low ≤ limit; golden exit ladder per 5m bar.",
      window: { start: START_DATE, end: END_DATE, sessionDays: SESSION_DAYS, dailyLookback: DAILY_LOOKBACK },
      universeRequested: tickers,
      universeWithData: dataTickers,
      universeNoData: noDataTickers,
      config: cfg,
      assumptions: [
        "Daily Ziv signal (retestLevel/ema50/WK-L/tier) computed from DB-cached daily bars up to the PRIOR close (no look-ahead on the structural level)",
        "Eligibility = retestEligible per 5m bar (live = 5m close) — the SAME WAITER-ZIV-SSOT gate the daily pass + live war cycle use",
        "LMT = computeAmbushLimit(retestLevel, live).limit (retestLevel×1.0075, FOMO-capped 1.015); fills on the FIRST subsequent 5m bar where low ≤ limit (fill price = limit)",
        "Stop = computeRetestStop (retestLevel×0.99, wideLungSL-bounded); size = vixRiskSize (1% risk, VIX proxy 18); capSharesToMaxPosition(maxPositionUsd)",
        "EOD: an unfilled resting LMT is cancelled (DAY tif, no overnight ambush)",
        "Golden exit ladder (TP1 1.5R / TP2 2.5R / breakeven / 15% trail-from-peak) evaluated per 5m bar; score-decay exit omitted (no per-5m Ziv recompute — daily-only structural signal)",
        "Per-ticker isolated book (the focused Gold-Retest universe, not the full 214-name portfolio)",
        "Commission $2.50/leg; 0.1% slippage",
        "5m source: Yahoo via fetchIntradayBarsForTicker; empty/throw → NO-DATA report, NOT a failure",
      ],
    },
    funnel,
    fillModel: { restingPlaced, restingFilled, restingExpiredEod, fillsPerSession },
    sleeve: { roundTrips: rts.length, winRatePct, avgR, totalPnl, closedLegs: closedTrades.length },
    trades: closedTrades.slice(0, 300),
    g2: {
      placed: funnel.placed, filled: restingFilled, fillsPerSession, avgR, winRatePct,
      roundTrips: rts.length, noData,
      verdict: noData ? "NO-DATA" : (funnel.placed > 0 ? "GO" : "NO-GO"),
    },
    verdict,
  };

  const outPath = path.join(process.cwd(), "scripts", "waiterBacktest5m-results.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nWritten to ${outPath}`);
  process.exit(0);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
