/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  zivDiagnostics.ts — READ-ONLY 4-part EDGE-DIAGNOSTIC pipeline on the Ziv  ║
 * ║  catalogue backtest (Config-C, LONG-ONLY). NO DB writes. NO IBKR. NO       ║
 * ║  orders. NO deploy. NO SSH. PURE SIMULATION.                               ║
 * ║                                                                            ║
 * ║  Reuses the trade-gen + Config-C entry/exit + portfolio sim from           ║
 * ║  scripts/zivCatalogOOS.ts (relevant blocks COPIED here — that file exports  ║
 * ║  nothing). Four diagnostics, each with a one-line verdict:                  ║
 * ║                                                                            ║
 * ║   P1  QUEUE-LOCK CROSS-REFERENCE — does S1's FIFO 12-slot book reject the   ║
 * ║       big winners S4 caught? (FIFO-vs-conviction expectancy test)           ║
 * ║   P2  DYNAMIC PREEMPTION (S1-B) — evict a languishing weak occupant for a   ║
 * ║       much-higher-score new signal; does it recover S4's totalR?            ║
 * ║   P3  SPY BENCHMARK — is S1 negative-alpha (S1 down while SPY up)?           ║
 * ║   P4  BRUTAL FILTER — gate S1 on REAL getTickerIntelligence confluence +     ║
 * ║       liquidity (live thresholds); does win% rise from 42% toward ~51%?      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * RUN (manager runs this on the droplet — has Yahoo/DB data; 214 tickers is slow):
 *   node --import tsx --env-file=.env scripts/zivDiagnostics.ts
 *
 * BUILD-CHECK (local, no run):
 *   npx esbuild scripts/zivDiagnostics.ts --bundle --platform=node --packages=external --outdir=/tmp/diagbc
 *
 * Base configs (per spec):
 *   S1 = leverage 1.0× / maxConcurrent 12 / maxPerSector 3   (sane-base)
 *   S4 = leverage 1.9× / maxConcurrent ∞  / maxPerSector ∞   (reference, broken)
 *
 * P4 CONFLUENCE/LIQUIDITY ARE >>REAL<<, NOT A PROXY: server/runtimeIntelligence.ts
 * getTickerIntelligence(ticker, bars) computes confluenceScore + liquidityScore
 * PURELY from the passed daily bars (volume / close / high / low + calcEMA) — it
 * uses NO live snapshot, NO cross-sectional/breadth data. We call it AS-OF the entry
 * bar by passing bars.slice(0, i+1), reproducing exactly the value warEngine gated on
 * (MIN_CONFLUENCE=5.5, MIN_LIQUIDITY_SCORE=2.0). The ONLY simplification vs live is
 * that live passed the full live `bars` (current state) into the same function; here
 * we slice to the entry bar so the gate is causal (no look-ahead). See P4 header.
 */

import "dotenv/config";
import { fetchBarsForTicker } from "../server/marketData";
import { calcZivEngineScore, type Bar, type ZivScoreResult } from "../server/zivEngine";
import { confirmVolume } from "../server/volumeConfirm";
import { DEFAULT_60_ASSETS } from "../server/routers/portfolio";
import { getTickerIntelligence } from "../server/runtimeIntelligence";

// ─── Universe (the ~214-stock live catalogue) ────────────────────────────────
const TICKERS: string[] = DEFAULT_60_ASSETS.map(a => a.ticker);

// ─── Sector map (ticker → sector) for the per-sector ClusterGuard cap ─────────
const SECTOR_BY_TICKER: Record<string, string> = {};
for (const a of DEFAULT_60_ASSETS) SECTOR_BY_TICKER[a.ticker] = a.sector ?? "OTHER";
function sectorOf(ticker: string): string {
  return SECTOR_BY_TICKER[ticker] ?? "OTHER";
}

// ─── Engine / trade-model parameters (mirror zivCatalogOOS.ts Config C) ───────
const BARS_DAYS = 420;
const MIN_BARS = 50;
const ENTRY_MIN_SCORE = 7.5;

const SL_LOOKBACK = 10;
const RC2_MAX_RISK_PCT = 12;
const FIRST_TARGET_R = 2;
const FREE_ROLL_FRACTION = 0.5;
const TIME_STOP_BARS = 10;
const CHANDELIER_ATR_MULT = 2.5;
const ATR_PERIOD = 14;

// ─── Out-of-sample windows ────────────────────────────────────────────────────
const WINDOWS: { label: string; start: string }[] = [
  { label: "WINDOW 2025", start: "2025-01-01" },
  { label: "WINDOW 2026", start: "2026-01-01" },
];
const EARLIEST_WINDOW_START = WINDOWS.reduce(
  (min, w) => (w.start < min ? w.start : min),
  WINDOWS[0].start,
);

// ─── Portfolio sizing parameters ──────────────────────────────────────────────
const START_EQUITY = 100_000;
const HEAT_CAP = 0.20;
const MAX_POSITION_USD = 85_000;
const RISK_PCT = 0.01;

// ─── Base risk configs (per spec — only S1 and S4) ────────────────────────────
interface RiskConfig {
  id: string;
  label: string;
  leverage: number;
  maxConcurrent: number;
  maxPerSector: number;
}
const S1: RiskConfig = { id: "S1", label: "sane-base",        leverage: 1.0, maxConcurrent: 12,  maxPerSector: 3   };
const S4: RiskConfig = { id: "S4", label: "reference(broken)", leverage: 1.9, maxConcurrent: 999, maxPerSector: 999 };

// ─── P2 / P4 tunables ─────────────────────────────────────────────────────────
// P2 dynamic-preemption: a full-book new signal evicts the weakest occupant iff
//   newScore >= weakestScore + PREEMPT_SCORE_EDGE  AND  weakest occupant is
//   "languishing" (current unrealized R in [PREEMPT_LANG_LO, PREEMPT_LANG_HI]).
const PREEMPT_SCORE_EDGE = 1.5;
const PREEMPT_LANG_LO = -0.3;
const PREEMPT_LANG_HI = 0.3;

// P4 brutal-filter live thresholds (from server/warEngine.ts):
const MIN_CONFLUENCE = 5.5;       // warEngine LONG gate
const MIN_LIQUIDITY_SCORE = 2.0;  // warEngine LONG gate

/** SIMPLE 14-period ATR — byte-for-byte computeAtr14 (server/slCalculator.ts). */
function computeAtr14Local(window: Bar[]): number | null {
  if (window.length < 2) return null;
  const period = Math.min(ATR_PERIOD, window.length - 1);
  let atrSum = 0;
  for (let i = window.length - period; i < window.length; i++) {
    const tr = Math.max(
      window[i].high - window[i].low,
      Math.abs(window[i].high - window[i - 1].close),
      Math.abs(window[i].low - window[i - 1].close),
    );
    atrSum += tr;
  }
  return atrSum / period;
}

type ExitReason = "SL" | "TIME" | "TRAIL" | "TRAIL_OPEN" | "OPEN";

// ── Raw Config-C trade. Adds entryScore + bar-index bookkeeping needed by P1/P2. ──
interface RawTrade {
  ticker: string;
  entryDate: string;
  exitDate: string;
  tier: string;
  entry: number;
  sl: number;
  exitReason: ExitReason;
  r: number;
  stopDistPct: number;
  entryScore: number;        // ZIV score at entry — needed for P1 (rejected-score) & P2 (preempt)
  entryBarIndex: number;     // index into this ticker's bars[] at entry — for P2 unrealized-R lookup
  // P4 gate values (REAL getTickerIntelligence, as-of entry bar). Filled in trade-gen.
  confluenceScore: number;
  liquidityScore: number;
}

// Per-ticker bar cache so P2 can recompute an open position's unrealized R at an
// arbitrary event date (it needs that ticker's bar at/just-before the event date).
const BARS_BY_TICKER = new Map<string, Bar[]>();

function wantsEntryConfigC(res: ZivScoreResult, windowBars: Bar[]): boolean {
  const weeklyAligned = res.weeklyEma50Slope > 0;
  const scoreOk = res.score >= ENTRY_MIN_SCORE;
  const retestEntry = res.tier === "Gold Retest" && scoreOk && weeklyAligned;
  if (retestEntry) return true;
  const isGoldBreakout = res.tier === "Gold Breakout" && scoreOk && weeklyAligned;
  if (!isGoldBreakout) return false;
  return confirmVolume(windowBars, res.donchian20High, "long").confirmed;
}

/**
 * Simulate Config C over one ticker's bars (REAL free-roll+trail exit), pushing
 * RawTrades into `out`. Identical to zivCatalogOOS.ts simulateConfigC EXCEPT it also
 * records entryScore, entryBarIndex, and the REAL as-of-entry confluence/liquidity
 * (getTickerIntelligence on bars.slice(0, i+1)) for the P1/P2/P4 diagnostics.
 *
 * async because getTickerIntelligence is async (no fetch — it's given the bar slice).
 */
async function simulateConfigC(ticker: string, bars: Bar[], out: RawTrade[]): Promise<void> {
  let i = 0;
  while (i < bars.length && bars[i].date < EARLIEST_WINDOW_START) i++;

  for (; i < bars.length; i++) {
    if (i + 1 < MIN_BARS) continue;
    if (i + 1 < SL_LOOKBACK) continue;

    const windowBars = bars.slice(0, i + 1);
    let res: ZivScoreResult;
    try {
      res = calcZivEngineScore(windowBars);
    } catch {
      continue;
    }
    if (res.tier === "No Data" || res.tier === "Error") continue;
    if (!wantsEntryConfigC(res, windowBars)) continue;

    const entry = bars[i].close;
    const slWindow = bars.slice(i - (SL_LOOKBACK - 1), i + 1);
    const sl = Math.min(...slWindow.map(b => b.low));
    if (!(sl < entry) || !(entry > 0)) continue;

    const riskPct = ((entry - sl) / entry) * 100;
    if (riskPct > RC2_MAX_RISK_PCT) continue;

    const risk = entry - sl;
    const firstTarget = entry + FIRST_TARGET_R * risk;

    let exitDate = bars[bars.length - 1].date;
    let exitReason: ExitReason = "OPEN";
    let exitIndex = bars.length - 1;

    let reachedFirstTarget = false;
    let leg1R = 0;
    let leg2R = 0;

    let currentStop = sl;
    let highestHigh = bars[i].high;
    let trailStop = -Infinity;

    for (let j = i + 1; j < bars.length; j++) {
      const bar = bars[j];
      const heldBars = j - i;

      if (!reachedFirstTarget) {
        if (bar.low <= currentStop) {
          exitReason = "SL"; exitDate = bar.date; exitIndex = j;
          leg1R = (currentStop - entry) / risk;
          leg2R = 0;
          break;
        }
        if (bar.high >= firstTarget) {
          reachedFirstTarget = true;
          leg1R = FREE_ROLL_FRACTION * FIRST_TARGET_R;
          currentStop = entry;
          highestHigh = Math.max(highestHigh, bar.high);
          const atr = computeAtr14Local(bars.slice(0, j + 1));
          if (atr != null && atr > 0) {
            const chand = highestHigh - CHANDELIER_ATR_MULT * atr;
            trailStop = Math.max(currentStop, chand);
          } else {
            trailStop = currentStop;
          }
          currentStop = trailStop;
          continue;
        }
        if (heldBars > TIME_STOP_BARS) {
          exitReason = "TIME"; exitDate = bar.date; exitIndex = j;
          leg1R = (bar.close - entry) / risk;
          leg2R = 0;
          break;
        }
        if (j === bars.length - 1) {
          exitReason = "OPEN"; exitDate = bar.date; exitIndex = j;
          leg1R = (bar.close - entry) / risk;
          leg2R = 0;
        }
      } else {
        highestHigh = Math.max(highestHigh, bar.high);
        const atr = computeAtr14Local(bars.slice(0, j + 1));
        if (atr != null && atr > 0) {
          const chand = highestHigh - CHANDELIER_ATR_MULT * atr;
          trailStop = Math.max(trailStop, chand);
        }
        currentStop = trailStop;

        if (bar.low <= currentStop) {
          exitReason = "TRAIL"; exitDate = bar.date; exitIndex = j;
          leg2R = FREE_ROLL_FRACTION * ((currentStop - entry) / risk);
          break;
        }
        if (j === bars.length - 1) {
          exitReason = "TRAIL_OPEN"; exitDate = bar.date; exitIndex = j;
          leg2R = FREE_ROLL_FRACTION * ((bar.close - entry) / risk);
        }
      }
    }

    if (i === bars.length - 1) {
      exitDate = bars[i].date; exitReason = "OPEN"; exitIndex = i;
      leg1R = 0; leg2R = 0; reachedFirstTarget = false;
    }

    const r = Math.round((leg1R + leg2R) * 100) / 100;

    // ── REAL P4 intelligence, computed AS-OF the entry bar (no look-ahead). ──
    // getTickerIntelligence is pure over the passed bars (no live snapshot); passing
    // the slice through the entry bar reproduces the live confluence/liquidity gate
    // values causally. Degrade-safe internally (returns mid scores on thin/throwing).
    let confluenceScore = 5;
    let liquidityScore = 5;
    try {
      const intel = await getTickerIntelligence(ticker, windowBars);
      confluenceScore = intel.confluenceScore;
      liquidityScore = intel.liquidityScore;
    } catch {
      // keep neutral defaults — never abort trade-gen on an intel hiccup
    }

    out.push({
      ticker,
      entryDate: bars[i].date,
      exitDate,
      tier: res.tier,
      entry,
      sl,
      exitReason,
      r,
      stopDistPct: (entry - sl) / entry,
      entryScore: res.score,
      entryBarIndex: i,
      confluenceScore,
      liquidityScore,
    });

    i = exitIndex;
  }
}

// ─── Portfolio equity-curve simulator (adapted from zivCatalogOOS.ts) ─────────
interface EventRec {
  date: string;
  kind: "ENTRY" | "EXIT";
  tradeIndex: number;
}
interface OpenPos {
  tradeIndex: number;
  ticker: string;
  sector: string;
  notional: number;
  riskDollars: number;
  pnl: number;
  exitDate: string;
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
interface PortfolioResult {
  window: string;
  config: RiskConfig;
  tradesTaken: number;
  tickersTraded: number;
  wins: number;
  winPct: number;
  totalR: number;
  finalEquity: number;
  finalReturnPct: number;
  maxDrawdownPct: number;
  rejectedConcurrency: number;
  rejectedSector: number;
  leverageCapHits: number;
  heatSkips: number;
  maxPosCapHits: number;
  preemptions: number;            // P2 only
  exitBreakdown: Record<string, number>;
  curve: Array<{ date: string; equity: number }>;
  // P1 instrumentation: every concurrency-rejected trade (full book).
  concurrencyRejects: RejectedRec[];
}

interface RejectedRec {
  tradeIndex: number;
  ticker: string;
  entryDate: string;
  entryScore: number;
  r: number;                          // the rejected trade's EVENTUAL R
  occupantsAtReject: OccupantSnap[];  // the 12 names that held the book at reject time
}
interface OccupantSnap {
  ticker: string;
  entryDate: string;
  entryScore: number;
  eventualR: number;                  // that occupant's eventual R (full trade is known)
}

/** Compute an OPEN position's unrealized R at `eventDate` from that ticker's bar. */
function unrealizedRAt(t: RawTrade, eventDate: string): number {
  const bars = BARS_BY_TICKER.get(t.ticker);
  if (!bars) return 0;
  // Last bar with date <= eventDate (the most recent close available at the event).
  let px = t.entry;
  for (let k = t.entryBarIndex; k < bars.length; k++) {
    if (bars[k].date <= eventDate) px = bars[k].close;
    else break;
  }
  const risk = t.entry - t.sl;
  if (!(risk > 0)) return 0;
  return (px - t.entry) / risk;
}

/**
 * Run the portfolio sim for ONE window × ONE config. When `preempt` is true the
 * S1-B dynamic-preemption rule is active (full-book evicts a languishing weak
 * occupant for a far-higher-score new signal). Otherwise it is the plain
 * ClusterGuard sim (concurrency → sector → heat → maxPos → leverage), and every
 * concurrency rejection is recorded into `concurrencyRejects` for P1.
 */
function runPortfolio(
  windowTrades: RawTrade[],
  windowLabel: string,
  cfg: RiskConfig,
  opts: { preempt?: boolean } = {},
): PortfolioResult {
  const preempt = opts.preempt === true;

  const events: EventRec[] = [];
  windowTrades.forEach((t, idx) => {
    events.push({ date: t.entryDate, kind: "ENTRY", tradeIndex: idx });
    events.push({ date: t.exitDate, kind: "EXIT", tradeIndex: idx });
  });
  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "EXIT" ? -1 : 1;
    return a.tradeIndex - b.tradeIndex;
  });

  let equity = START_EQUITY;
  let peakEquity = START_EQUITY;
  let maxDrawdownPct = 0;

  let rejectedConcurrency = 0;
  let rejectedSector = 0;
  let leverageCapHits = 0;
  let heatSkips = 0;
  let maxPosCapHits = 0;
  let preemptions = 0;

  const openByTradeIndex = new Map<number, OpenPos>();
  const closed: ClosedTrade[] = [];
  const tickersTraded = new Set<string>();
  const concurrencyRejects: RejectedRec[] = [];

  const curve: Array<{ date: string; equity: number }> = [
    { date: windowTrades.length ? windowTrades[0].entryDate : EARLIEST_WINDOW_START, equity },
  ];

  const grossOpenNotional = (): number => {
    let s = 0;
    for (const p of openByTradeIndex.values()) s += p.notional;
    return s;
  };
  const grossOpenRisk = (): number => {
    let s = 0;
    for (const p of openByTradeIndex.values()) s += p.riskDollars;
    return s;
  };
  const openCountInSector = (sec: string): number => {
    let n = 0;
    for (const p of openByTradeIndex.values()) if (p.sector === sec) n++;
    return n;
  };

  // Realize an OPEN position into equity (used by normal EXIT and by P2 preemption).
  const realize = (pos: OpenPos, t: RawTrade, eventDate: string, pnlOverride?: number): void => {
    const pnl = pnlOverride != null ? pnlOverride : pos.pnl;
    equity += pnl;
    tickersTraded.add(pos.ticker);
    closed.push({
      ticker: t.ticker, entryDate: t.entryDate, exitDate: eventDate,
      exitReason: t.exitReason, r: pnlOverride != null ? (t.entry - t.sl) > 0 ? pnl / (RISK_PCT * START_EQUITY) : t.r : t.r,
      pnl, skipped: false,
    });
    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    curve.push({ date: eventDate, equity: Math.round(equity) });
  };

  // P2: find the weakest languishing occupant eligible for preemption by `newScore`.
  // Returns the tradeIndex to evict, or null. Weakest = lowest entryScore among
  // occupants whose current unrealized R is in [PREEMPT_LANG_LO, PREEMPT_LANG_HI]
  // and whose entryScore + PREEMPT_SCORE_EDGE <= newScore.
  const findPreemptTarget = (newScore: number, eventDate: string): number | null => {
    let bestIdx: number | null = null;
    let bestScore = Infinity;
    for (const [idx, pos] of openByTradeIndex) {
      const occT = windowTrades[idx];
      if (occT.entryScore + PREEMPT_SCORE_EDGE > newScore) continue; // not enough edge
      const uR = unrealizedRAt(occT, eventDate);
      if (uR < PREEMPT_LANG_LO || uR > PREEMPT_LANG_HI) continue;    // not languishing
      if (occT.entryScore < bestScore) { bestScore = occT.entryScore; bestIdx = idx; }
    }
    return bestIdx;
  };

  for (const ev of events) {
    const t = windowTrades[ev.tradeIndex];

    if (ev.kind === "ENTRY") {
      // ── Concurrency cap ──────────────────────────────────────────────────────
      if (openByTradeIndex.size >= cfg.maxConcurrent) {
        if (preempt) {
          // P2: try to evict a languishing weak occupant for this stronger signal.
          const victimIdx = findPreemptTarget(t.entryScore, t.entryDate);
          if (victimIdx != null) {
            const victim = openByTradeIndex.get(victimIdx)!;
            const victimT = windowTrades[victimIdx];
            // Realize the victim at its CURRENT price (R-so-far), not its natural exit.
            const uR = unrealizedRAt(victimT, t.entryDate);
            const realizedPnl = uR * victim.riskDollars;
            openByTradeIndex.delete(victimIdx);
            realize(victim, victimT, t.entryDate, realizedPnl);
            preemptions++;
            // fall through to open the new signal (book now has a slot)
          } else {
            rejectedConcurrency++;
            recordReject(t, ev.tradeIndex);
            continue;
          }
        } else {
          rejectedConcurrency++;
          recordReject(t, ev.tradeIndex);
          continue;
        }
      }

      const sec = sectorOf(t.ticker);
      if (openCountInSector(sec) >= cfg.maxPerSector) {
        rejectedSector++;
        continue;
      }

      const equityAtEntry = equity;
      let riskDollars = RISK_PCT * equityAtEntry;

      const heatAfter = (grossOpenRisk() + riskDollars) / (equityAtEntry > 0 ? equityAtEntry : 1);
      if (heatAfter > HEAT_CAP) {
        heatSkips++;
        closed.push({
          ticker: t.ticker, entryDate: t.entryDate, exitDate: t.exitDate,
          exitReason: t.exitReason, r: t.r, pnl: 0, skipped: true,
        });
        continue;
      }

      let notional = riskDollars / t.stopDistPct;

      if (notional > MAX_POSITION_USD) {
        const scale = MAX_POSITION_USD / notional;
        notional *= scale;
        riskDollars *= scale;
        maxPosCapHits++;
      }

      const headroom = Math.max(0, cfg.leverage * equityAtEntry - grossOpenNotional());
      if (notional > headroom) {
        const scale = headroom > 0 ? headroom / notional : 0;
        notional *= scale;
        riskDollars *= scale;
        leverageCapHits++;
      }

      const pnl = t.r * riskDollars;

      openByTradeIndex.set(ev.tradeIndex, {
        tradeIndex: ev.tradeIndex,
        ticker: t.ticker,
        sector: sec,
        notional,
        riskDollars,
        pnl,
        exitDate: t.exitDate,
      });
    } else {
      const pos = openByTradeIndex.get(ev.tradeIndex);
      if (!pos) continue; // rejected / heat-skipped / already preempted — nothing to realize
      openByTradeIndex.delete(ev.tradeIndex);
      realize(pos, t, ev.date);
    }
  }

  // Helper closure to record a concurrency reject WITH the book snapshot (P1).
  function recordReject(rt: RawTrade, idx: number): void {
    const occupants: OccupantSnap[] = [];
    for (const [oi] of openByTradeIndex) {
      const ot = windowTrades[oi];
      occupants.push({
        ticker: ot.ticker,
        entryDate: ot.entryDate,
        entryScore: ot.entryScore,
        eventualR: ot.r,
      });
    }
    concurrencyRejects.push({
      tradeIndex: idx,
      ticker: rt.ticker,
      entryDate: rt.entryDate,
      entryScore: rt.entryScore,
      r: rt.r,
      occupantsAtReject: occupants,
    });
  }

  const taken = closed.filter(c => !c.skipped);
  const wins = taken.filter(c => c.r > 0).length;
  const totalR = taken.reduce((s, c) => s + c.r, 0);

  const exitBreakdown: Record<string, number> = {};
  for (const c of taken) exitBreakdown[c.exitReason] = (exitBreakdown[c.exitReason] ?? 0) + 1;

  return {
    window: windowLabel,
    config: cfg,
    tradesTaken: taken.length,
    tickersTraded: tickersTraded.size,
    wins,
    winPct: taken.length > 0 ? (wins / taken.length) * 100 : 0,
    totalR: Math.round(totalR * 100) / 100,
    finalEquity: Math.round(equity),
    finalReturnPct: ((equity - START_EQUITY) / START_EQUITY) * 100,
    maxDrawdownPct: maxDrawdownPct * 100,
    rejectedConcurrency,
    rejectedSector,
    leverageCapHits,
    heatSkips,
    maxPosCapHits,
    preemptions,
    exitBreakdown,
    curve,
    concurrencyRejects,
  };
}

// ─── Reporting helpers ─────────────────────────────────────────────────────────
function pad(s: string | number, w: number): string {
  const str = String(s);
  return str.length >= w ? str : str + " ".repeat(w - str.length);
}
function padL(s: string | number, w: number): string {
  const str = String(s);
  return str.length >= w ? str : " ".repeat(w - str.length) + str;
}
function sign(n: number): string { return n >= 0 ? "+" : ""; }
function fixR(n: number): string { return sign(n) + n.toFixed(2) + "R"; }

/** Reduce a per-exit equity curve to ~N evenly-spaced points (start … end). */
function sampleCurve(
  curve: Array<{ date: string; equity: number }>,
  n: number,
): Array<{ date: string; equity: number }> {
  if (curve.length <= n) return curve;
  const out: Array<{ date: string; equity: number }> = [];
  for (let k = 0; k < n; k++) {
    const idx = Math.round((curve.length - 1) * (k / (n - 1)));
    out.push(curve[idx]);
  }
  // de-dupe by date, keep order
  const seen = new Set<string>();
  return out.filter(p => (seen.has(p.date) ? false : (seen.add(p.date), true)));
}

// ═══════════════════════════════════════════════════════════════════════════════
// P1 — QUEUE-LOCK CROSS-REFERENCE
// ═══════════════════════════════════════════════════════════════════════════════
function reportP1(windowLabel: string, s1: PortfolioResult, s4: PortfolioResult, windowTrades: RawTrade[]): void {
  console.log("");
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  console.log(`P1 — QUEUE-LOCK CROSS-REFERENCE  ·  ${windowLabel}  (S1 12-slot FIFO vs S4 ∞)`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);

  // S4 top-20 winners by $ P&L. S4 is uncapped so every trade is taken.
  // We rebuild S4's per-trade $ — but rather than re-thread P&L out of runPortfolio,
  // rank S4-taken winners by r (S4 sizing is ~uniform: 1% risk, lev headroom rarely
  // binds at 1.9× early), then by stopDistPct (bigger notional → more $). For ranking
  // "top winners by $" we use r as the dominant term, breaking ties toward larger size.
  // NOTE: S4 took ALL trades (no concurrency/sector caps), so the winner set = the
  // window's biggest-R trades. We rank by r (primary) then notional proxy.
  const taken = windowTrades.slice(); // S4 takes all (caps are ∞); heat may skip a few but rarely
  const winners = taken
    .filter(t => t.r > 0)
    .sort((a, b) => {
      if (b.r !== a.r) return b.r - a.r;
      // larger notional ≈ smaller stopDistPct → more $ for same R
      return a.stopDistPct - b.stopDistPct;
    })
    .slice(0, 20);

  // Index S1's concurrency rejects by tradeIndex for O(1) lookup.
  const rejectByIdx = new Map<number, RejectedRec>();
  for (const rr of s1.concurrencyRejects) rejectByIdx.set(rr.tradeIndex, rr);

  // Map each winner back to its tradeIndex in windowTrades.
  const idxOf = new Map<RawTrade, number>();
  windowTrades.forEach((t, i) => idxOf.set(t, i));

  console.log(`  S1 concurrency-rejects this window: ${s1.concurrencyRejects.length}` +
    `   |   S4 winners examined: ${winners.length}`);
  console.log("");
  console.log(`  ${pad("S4 winner", 9)}${pad("entryDate", 12)}${padL("score", 7)}${padL("R", 8)}  ${pad("rejected-in-S1?", 18)}${padL("blockers avgR", 14)}`);
  console.log(`  ${"─".repeat(76)}`);

  let nRejected = 0;
  let sumMissedR = 0;
  const blockerRs: number[] = [];

  for (const w of winners) {
    const idx = idxOf.get(w)!;
    const rr = rejectByIdx.get(idx);
    if (rr) {
      nRejected++;
      sumMissedR += w.r;
      const avgOcc = rr.occupantsAtReject.length
        ? rr.occupantsAtReject.reduce((s, o) => s + o.eventualR, 0) / rr.occupantsAtReject.length
        : 0;
      for (const o of rr.occupantsAtReject) blockerRs.push(o.eventualR);
      console.log(
        `  ${pad(w.ticker, 9)}${pad(w.entryDate, 12)}${padL(w.entryScore.toFixed(2), 7)}${padL(fixR(w.r), 8)}  ` +
        `${pad("YES", 18)}${padL(fixR(avgOcc), 14)}`,
      );
    } else {
      console.log(
        `  ${pad(w.ticker, 9)}${pad(w.entryDate, 12)}${padL(w.entryScore.toFixed(2), 7)}${padL(fixR(w.r), 8)}  ` +
        `${pad("no (taken in S1)", 18)}${padL("—", 14)}`,
      );
    }
  }

  // Detail: for the FIRST few rejected winners, dump the 12 book occupants + their R.
  const detailed = winners.filter(w => rejectByIdx.has(idxOf.get(w)!)).slice(0, 3);
  if (detailed.length) {
    console.log("");
    console.log(`  ── BOOK SNAPSHOT at reject (first ${detailed.length} rejected winners) ──`);
    for (const w of detailed) {
      const rr = rejectByIdx.get(idxOf.get(w)!)!;
      console.log(`  ${w.ticker} ${w.entryDate} (score ${w.entryScore.toFixed(2)}, eventual ${fixR(w.r)}) was BLOCKED by these ${rr.occupantsAtReject.length}:`);
      const occ = [...rr.occupantsAtReject].sort((a, b) => a.eventualR - b.eventualR);
      const line = occ.map(o => `${o.ticker}(${o.entryScore.toFixed(1)}|${fixR(o.eventualR)})`).join(", ");
      console.log(`      ${line}`);
    }
  }

  const blockerAvg = blockerRs.length ? blockerRs.reduce((a, b) => a + b, 0) / blockerRs.length : 0;
  console.log("");
  console.log(
    `  HEADLINE ${windowLabel}: S1 rejected ${nRejected} of S4's top-${winners.length} winners ` +
    `(sum ${fixR(sumMissedR)} missed); the blocking occupants averaged ${fixR(blockerAvg)}.`,
  );
  const verdict =
    nRejected >= 5 && blockerAvg < sumMissedR / Math.max(1, nRejected)
      ? `FIFO-vs-conviction CONFIRMED — low-R laggards (${fixR(blockerAvg)} avg) blocked high-R winners. Queue policy is an expectancy bug.`
      : nRejected >= 3
        ? `PARTIAL — ${nRejected} winners blocked, but blockers averaged ${fixR(blockerAvg)} (not clearly laggards). Concurrency cap costs R but isn't a pure FIFO bug.`
        : `WEAK — only ${nRejected} top winners blocked; the 12-slot book rarely sat full on a winner. Concurrency is not the main edge leak this window.`;
  console.log(`  VERDICT P1 ${windowLabel}: ${verdict}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// P2 — DYNAMIC PREEMPTION (S1-B)
// ═══════════════════════════════════════════════════════════════════════════════
function reportP2(windowLabel: string, s1: PortfolioResult, s1b: PortfolioResult, s4: PortfolioResult): void {
  console.log("");
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  console.log(`P2 — DYNAMIC PREEMPTION (S1-B)  ·  ${windowLabel}`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  console.log(`  Rule: book full (12/12) & newScore >= weakestScore + ${PREEMPT_SCORE_EDGE} & weakest`);
  console.log(`        occupant unrealized-R in [${PREEMPT_LANG_LO}, ${PREEMPT_LANG_HI}] → evict weak, open new.`);
  console.log(`  (SIMPLIFICATION: compares ENTRY scores, not live-recomputed scores at the event date.)`);
  console.log("");
  console.log(`  ${pad("cfg", 8)}${padL("taken", 7)}${padL("preempts", 10)}${padL("win%", 8)}${padL("totalR", 10)}${padL("ret%", 9)}${padL("maxDD%", 9)}${padL("finalEq$", 13)}`);
  console.log(`  ${"─".repeat(74)}`);
  for (const r of [s1, s1b, s4]) {
    console.log(
      `  ${pad(r.config.id, 8)}` +
      `${padL(r.tradesTaken, 7)}` +
      `${padL(r.preemptions, 10)}` +
      `${padL(r.winPct.toFixed(1), 8)}` +
      `${padL(fixR(r.totalR), 10)}` +
      `${padL(sign(r.finalReturnPct) + r.finalReturnPct.toFixed(1) + "%", 9)}` +
      `${padL(r.maxDrawdownPct.toFixed(1) + "%", 9)}` +
      `${padL("$" + r.finalEquity.toLocaleString(), 13)}`,
    );
  }
  const recovered = s4.totalR > s1.totalR ? (s1b.totalR - s1.totalR) / (s4.totalR - s1.totalR) : 0;
  console.log("");
  console.log(
    `  S1-B made ${s1b.preemptions} preemptions; totalR moved ${fixR(s1.totalR)} (S1) → ${fixR(s1b.totalR)} (S1-B) ` +
    `vs ${fixR(s4.totalR)} (S4) — recovered ${(recovered * 100).toFixed(0)}% of the S1→S4 gap.`,
  );
  const verdict =
    s1b.preemptions === 0
      ? `INERT — preemption never fired (book rarely full with a languishing weak occupant + a +${PREEMPT_SCORE_EDGE} stronger signal). Concurrency loss is NOT recoverable by this eviction rule.`
      : recovered >= 0.5
        ? `EFFECTIVE — preemption recovered ${(recovered * 100).toFixed(0)}% of S1's R-gap to S4 with comparable DD. Conviction-evict beats FIFO.`
        : recovered > 0
          ? `MARGINAL — preemption recovered only ${(recovered * 100).toFixed(0)}% of the gap. The S1→S4 gap is mostly SIZE/leverage, not queue policy.`
          : `NEGATIVE — preemption did not improve (or hurt) totalR; evicting on entry-score is not a reliable proxy.`;
  console.log(`  VERDICT P2 ${windowLabel}: ${verdict}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// P3 — SPY BENCHMARK
// ═══════════════════════════════════════════════════════════════════════════════
interface SpyResult {
  windowLabel: string;
  returnPct: number;
  maxDDPct: number;
  curve: Array<{ date: string; equity: number }>;
}
function computeSpyBenchmark(windowLabel: string, spyBars: Bar[], windowStart: string): SpyResult | null {
  const inWin = spyBars.filter(b => b.date >= windowStart).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (inWin.length < 2) return null;
  const base = inWin[0].close;
  let peak = START_EQUITY;
  let maxDD = 0;
  const curve = inWin.map(b => {
    const eq = START_EQUITY * (b.close / base);
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    if (dd > maxDD) maxDD = dd;
    return { date: b.date, equity: Math.round(eq) };
  });
  const last = curve[curve.length - 1];
  return {
    windowLabel,
    returnPct: ((last.equity - START_EQUITY) / START_EQUITY) * 100,
    maxDDPct: maxDD * 100,
    curve,
  };
}
function reportP3(windowLabel: string, s1: PortfolioResult, spy: SpyResult | null): void {
  console.log("");
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  console.log(`P3 — SPY BENCHMARK  ·  ${windowLabel}  (S1 long-only vs SPY buy&hold $100k)`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  if (!spy) {
    console.log(`  [SKIP] No SPY bars in window — fetchBarsForTicker("SPY",420) returned too little.`);
    console.log(`  VERDICT P3 ${windowLabel}: INDETERMINATE (no SPY data).`);
    return;
  }
  console.log(
    `  ${pad("metric", 12)}${padL("S1", 14)}${padL("SPY b&h", 14)}`,
  );
  console.log(`  ${"─".repeat(40)}`);
  console.log(`  ${pad("return%", 12)}${padL(sign(s1.finalReturnPct) + s1.finalReturnPct.toFixed(1) + "%", 14)}${padL(sign(spy.returnPct) + spy.returnPct.toFixed(1) + "%", 14)}`);
  console.log(`  ${pad("maxDD%", 12)}${padL(s1.maxDrawdownPct.toFixed(1) + "%", 14)}${padL(spy.maxDDPct.toFixed(1) + "%", 14)}`);

  // ~weekly 10-point side-by-side (sample both curves to 10 dates from SPY's date grid).
  const spyPts = sampleCurve(spy.curve, 10);
  // S1 equity is realized-on-exit; for each SPY sample date show the latest S1 equity <= that date.
  const s1Sorted = s1.curve.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const s1At = (date: string): number => {
    let eq = START_EQUITY;
    for (const p of s1Sorted) { if (p.date <= date) eq = p.equity; else break; }
    return eq;
  };
  console.log("");
  console.log(`  ── ~weekly 10-point equity (S1 realized-on-exit vs SPY b&h) ──`);
  console.log(`  ${pad("date", 12)}${padL("S1 $", 13)}${padL("SPY $", 13)}${padL("S1−SPY", 12)}`);
  for (const p of spyPts) {
    const s1eq = s1At(p.date);
    const diff = s1eq - p.equity;
    console.log(`  ${pad(p.date, 12)}${padL("$" + s1eq.toLocaleString(), 13)}${padL("$" + p.equity.toLocaleString(), 13)}${padL(sign(diff) + "$" + Math.abs(diff).toLocaleString(), 12)}`);
  }

  const negAlpha = spy.returnPct > 0 && s1.finalReturnPct < spy.returnPct;
  const hardNeg = spy.returnPct > 0 && s1.finalReturnPct < 0;
  console.log("");
  const verdict = hardNeg
    ? `NEGATIVE-ALPHA (severe) — S1 was DOWN ${s1.finalReturnPct.toFixed(1)}% while SPY rose +${spy.returnPct.toFixed(1)}%. Scoring is picking laggards; the engine added negative value vs just holding SPY.`
    : negAlpha
      ? `NEGATIVE-ALPHA — S1 (+${s1.finalReturnPct.toFixed(1)}%) UNDERPERFORMED SPY (+${spy.returnPct.toFixed(1)}%) on the same window. The selection edge did not beat passive beta.`
      : s1.finalReturnPct >= spy.returnPct && spy.returnPct >= 0
        ? `POSITIVE-ALPHA — S1 (${sign(s1.finalReturnPct)}${s1.finalReturnPct.toFixed(1)}%) >= SPY (+${spy.returnPct.toFixed(1)}%). Selection beat passive beta this window.`
        : `MIXED — SPY was down (${spy.returnPct.toFixed(1)}%); compare DD-adjusted (S1 ${s1.maxDrawdownPct.toFixed(1)}% vs SPY ${spy.maxDDPct.toFixed(1)}% maxDD).`;
  console.log(`  VERDICT P3 ${windowLabel}: ${verdict}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// P4 — BRUTAL FILTER (REAL confluence + liquidity gate on S1)
// ═══════════════════════════════════════════════════════════════════════════════
function reportP4(windowLabel: string, s1: PortfolioResult, s1f: PortfolioResult): void {
  console.log("");
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  console.log(`P4 — BRUTAL FILTER (REAL confluence + liquidity)  ·  ${windowLabel}`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  console.log(`  Gate (live warEngine LONG): confluenceScore >= ${MIN_CONFLUENCE} AND liquidityScore >= ${MIN_LIQUIDITY_SCORE}.`);
  console.log(`  REAL, NOT PROXY: getTickerIntelligence(ticker, bars.slice(0,entryBar+1)) — the exact`);
  console.log(`  live function, computed as-of the entry bar (no look-ahead).`);
  console.log("");
  console.log(`  ${pad("cfg", 14)}${padL("taken", 8)}${padL("win%", 8)}${padL("totalR", 10)}${padL("ret%", 9)}${padL("maxDD%", 9)}`);
  console.log(`  ${"─".repeat(58)}`);
  for (const r of [{ tag: "S1 (raw)", res: s1 }, { tag: "S1+brutal", res: s1f }]) {
    console.log(
      `  ${pad(r.tag, 14)}` +
      `${padL(r.res.tradesTaken, 8)}` +
      `${padL(r.res.winPct.toFixed(1), 8)}` +
      `${padL(fixR(r.res.totalR), 10)}` +
      `${padL(sign(r.res.finalReturnPct) + r.res.finalReturnPct.toFixed(1) + "%", 9)}` +
      `${padL(r.res.maxDrawdownPct.toFixed(1) + "%", 9)}`,
    );
  }
  console.log("");
  console.log(
    `  win% before ${s1.winPct.toFixed(1)}% → after ${s1f.winPct.toFixed(1)}%  ` +
    `(taken ${s1.tradesTaken} → ${s1f.tradesTaken}, ret ${sign(s1.finalReturnPct)}${s1.finalReturnPct.toFixed(1)}% → ${sign(s1f.finalReturnPct)}${s1f.finalReturnPct.toFixed(1)}%).`,
  );
  const verdict =
    s1f.winPct >= 50
      ? `EDGE-CONFIRMED — win% rose to ${s1f.winPct.toFixed(1)}% (>=50%). The confluence+liquidity filter isolates a real edge; the raw engine's ~42% is diluted by low-confluence/thin names.`
      : s1f.winPct > s1.winPct + 3
        ? `IMPROVING but SHORT — win% rose ${s1.winPct.toFixed(1)}% → ${s1f.winPct.toFixed(1)}% (still <50%). The filter helps but does not cross the edge line; partial signal.`
        : `EDGE-LESS (KILL) — win% stuck ~${s1f.winPct.toFixed(1)}% (was ${s1.winPct.toFixed(1)}%) after the brutal filter. Confluence/liquidity does NOT separate winners from losers — the long edge is not confirmed.`;
  console.log(`  VERDICT P4 ${windowLabel}: ${verdict}`);
}

// ─── Disclaimer ───────────────────────────────────────────────────────────────
function printDisclaimer(): void {
  console.log("");
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`SIMPLIFICATIONS / DISCLAIMER — read before trusting any number above`);
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`  • SHORTS OMITTED: LONG side of the engine only. The live regime/breadth`);
  console.log(`    short-gate is not reproduced offline.`);
  console.log(`  • DAILY-BAR TRAIL OVERSTATES: the Chandelier trail is evaluated on DAILY`);
  console.log(`    highs/lows; the live INTRADAY tick stop exits tighter → less R.`);
  console.log(`  • NO FRICTION: zero slippage / commissions; perfect fills at signal close`);
  console.log(`    and exact stop/trail levels. Live is worse on all three.`);
  console.log(`  • P1 "top-20 by $": S4 takes all trades (∞ caps), so winners are ranked by`);
  console.log(`    R (primary) then notional proxy (1/stopDistPct). A few low-R/high-notional`);
  console.log(`    trades could outrank on pure $ — the R-ranking is a faithful approximation.`);
  console.log(`  • P2 uses ENTRY scores, not live-recomputed scores at the event date, and`);
  console.log(`    realizes the evicted position at its daily close (not an intraday fill).`);
  console.log(`  • P2 preempted-trade R is back-derived as realizedPnl / (1% × START_EQUITY)`);
  console.log(`    for the win/R tally — an approximation of a partial-hold R.`);
  console.log(`  • P3 SPY b&h is gross (no dividends, no friction); S1 equity is realized-on-`);
  console.log(`    exit so the side-by-side compares a step curve to a continuous one.`);
  console.log(`  • P4 confluence/liquidity are REAL (getTickerIntelligence over the entry-bar`);
  console.log(`    slice) — the ONLY deviation from live is the causal slice vs live's full-`);
  console.log(`    bar call; thin/throwing tickers fall back to the function's neutral 5/5.`);
  console.log(`  • THIN 2025 WARMUP: fetchBarsForTicker(..,420) reaches ~2024-10, so early-2025`);
  console.log(`    scores lean on short history — treat early-2025 entries with caution.`);
}

// ─── Window-trade filter (shared) ─────────────────────────────────────────────
function tradesForWindow(allTrades: RawTrade[], start: string): RawTrade[] {
  return allTrades
    .filter(t => t.entryDate >= start)
    .sort((a, b) => {
      if (a.entryDate !== b.entryDate) return a.entryDate < b.entryDate ? -1 : 1;
      if (a.exitDate !== b.exitDate) return a.exitDate < b.exitDate ? -1 : 1;
      return a.ticker < b.ticker ? -1 : 1;
    });
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`Ziv 4-PART EDGE DIAGNOSTICS — READ-ONLY (no DB writes, no IBKR, no orders, no SSH)`);
  console.log(`Engine: CONFIG C (current live), LONG-ONLY. Universe: ${TICKERS.length} tickers (DEFAULT_60_ASSETS).`);
  console.log(`Base configs: S1 = ${S1.leverage}× / ${S1.maxConcurrent} / ${S1.maxPerSector}  ·  S4 = ${S4.leverage}× / ${S4.maxConcurrent} / ${S4.maxPerSector}.`);
  console.log(`Windows: ${WINDOWS.map(w => `${w.label} (entryDate >= ${w.start})`).join("  |  ")}.`);
  console.log(`P4 gate: confluence >= ${MIN_CONFLUENCE} & liquidity >= ${MIN_LIQUIDITY_SCORE} (REAL getTickerIntelligence, as-of entry bar).`);

  // 1) Build the FULL Config-C trade list ONCE (one fetch per ticker). Cache bars for P2.
  const allTrades: RawTrade[] = [];
  let processed = 0;
  let skippedNoData = 0;
  let spyBars: Bar[] = [];

  // P3: fetch SPY once (420 bars) — used by both windows.
  try {
    spyBars = await fetchBarsForTicker("SPY", 420);
    spyBars = [...spyBars].sort((a, b) => (a.date < b.date ? -1 : 1));
    console.log(`[SPY] fetched ${spyBars.length} bars for benchmark.`);
  } catch (e) {
    console.log(`[WARN] SPY fetch failed: ${(e as Error).message ?? e}. P3 will be skipped.`);
  }

  for (const ticker of TICKERS) {
    processed++;
    if (processed % 20 === 0) {
      console.log(`[PROGRESS] ${processed}/${TICKERS.length} tickers, ${allTrades.length} trades so far.`);
    }
    try {
      let bars = await fetchBarsForTicker(ticker, BARS_DAYS);
      if (!bars || bars.length < MIN_BARS) { skippedNoData++; continue; }
      bars = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

      const lastDate = bars[bars.length - 1].date;
      if (lastDate < EARLIEST_WINDOW_START) { skippedNoData++; continue; }
      const warmupBefore = bars.filter(b => b.date < EARLIEST_WINDOW_START).length;
      if (warmupBefore < MIN_BARS) { skippedNoData++; continue; }

      BARS_BY_TICKER.set(ticker, bars); // P2 needs these for unrealized-R lookups
      await simulateConfigC(ticker, bars, allTrades);
    } catch (e) {
      console.log(`[WARN] ${ticker}: ${(e as Error).message ?? e}. Skipping ticker.`);
      continue;
    }
  }

  console.log("");
  console.log(`[DONE BUILDING] ${allTrades.length} Config-C LONG entries across ${TICKERS.length - skippedNoData} usable tickers (${skippedNoData} skipped).`);

  // 2) Per window: run S1, S4, S1-B (preempt), S1+brutal; emit the 4 diagnostics.
  for (const w of WINDOWS) {
    const windowTrades = tradesForWindow(allTrades, w.start);

    const s1  = runPortfolio(windowTrades, w.label, S1);
    const s4  = runPortfolio(windowTrades, w.label, S4);
    const s1b = runPortfolio(windowTrades, w.label, S1, { preempt: true });

    // P4: brutal-filter trade set — drop entries failing the REAL confluence/liquidity gate.
    const brutalTrades = windowTrades.filter(
      t => t.confluenceScore >= MIN_CONFLUENCE && t.liquidityScore >= MIN_LIQUIDITY_SCORE,
    );
    const s1f = runPortfolio(brutalTrades, w.label, S1);

    console.log("");
    console.log(`\n████████████████████████████████████████████████████████████████████████████████`);
    console.log(`███  ${w.label}  ·  trades in window: ${windowTrades.length}  (brutal-passing: ${brutalTrades.length})`);
    console.log(`████████████████████████████████████████████████████████████████████████████████`);

    reportP1(w.label, s1, s4, windowTrades);
    reportP2(w.label, s1, s1b, s4);
    reportP3(w.label, s1, computeSpyBenchmark(w.label, spyBars, w.start));
    reportP4(w.label, s1, s1f);
  }

  printDisclaimer();
  console.log("");
  console.log(`Done. 4-part edge diagnostics over ${WINDOWS.length} windows. (Simulation only — no live actions taken.)`);
}

main().catch(err => {
  console.error(`[FATAL] ${(err as Error).stack ?? err}`);
  process.exit(1);
});
