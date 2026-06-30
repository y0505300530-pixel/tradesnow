/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  elzaV1Genesis.ts — the ORIGINAL "Genesis" ruleset (warEngine v1.0),       ║
 * ║  implemented FRESH from the authoritative spec. READ-ONLY backtest.        ║
 * ║                                                                            ║
 * ║  PURE SIMULATION. NO DB writes. NO IBKR. NO orders. NO deploy. NO SSH.     ║
 * ║                                                                            ║
 * ║  WHY FRESH: the live `calcZivEngineScore` is the v2.2 engine and is NOT    ║
 * ║  the Genesis ruleset. This script therefore implements `genesisScore`      ║
 * ║  DIRECTLY from the v1.0 spec (tiers, +1 bullish-PA, sub-scores capped at   ║
 * ║  +0.99) so the numbers reflect Genesis, not the current engine. The bar-   ║
 * ║  fetch, exit machinery, portfolio sim and SPY benchmark are FAITHFUL       ║
 * ║  ADAPTATIONS of scripts/elzaV3.ts / scripts/elzaV3Decomp.ts — no P&L or    ║
 * ║  price formula is re-implemented beyond those copies.                      ║
 * ║                                                                            ║
 * ║  KEY GENESIS BEHAVIORS (vs v3):                                            ║
 * ║   • SCORING — genesisScore (3 tiers: Gold Retest 7/8, Gold Breakout 9/10,  ║
 * ║     Breakout Override 6) + 8 sub-score components capped at +0.99.          ║
 * ║   • RANKING — when >1 candidate competes for free slots, fill the 10 slots ║
 * ║     by HIGHEST totalScore (conviction-ranked), NOT FIFO. This is the headline║
 * ║     Genesis behavior reproduced here as a per-day conviction auction.       ║
 * ║   • EXIT — free-roll trigger = 1.5R (NOT 2R): bank 50% at +1.5R, residual   ║
 * ║     to breakeven, then Chandelier max(priorTrail, highHigh − 2.5×ATR14).    ║
 * ║   • NO fast 4-day kill. Genesis let positions run to SL / trail. A generous ║
 * ║     20-bar time-stop is the ONLY backstop (see GENESIS_TIME_STOP_BARS).      ║
 * ║   • LONG-ONLY. SHORTS OMITTED.                                              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * RUN (manager runs this on the droplet — has Yahoo/DB data; 214 tickers is slow):
 *   node --import tsx --env-file=.env scripts/elzaV1Genesis.ts
 *
 * BUILD-CHECK (local, no run):
 *   npx esbuild scripts/elzaV1Genesis.ts --bundle --platform=node --packages=external --outdir=/tmp/genbc
 *
 * DATA SOURCE: only `fetchBarsForTicker` (server/marketData.ts). Scoring is the FRESH
 * `genesisScore` below; only `calcEMA` / `calcRSI` / the `Bar` type are reused from
 * server/zivEngine.ts (shared math primitives, NOT the v2.2 tier logic).
 *
 * ── TIME-STOP CHOICE (stated per spec) ───────────────────────────────────────
 *   Genesis had NO aggressive 4-day dead-money kill. We reproduce the original
 *   "let it run" behavior and add only a GENEROUS 20-bar (≈4 trading weeks)
 *   time-stop as a backstop so an open position can't ride indefinitely past the
 *   end of data. It only fires PRE-free-roll (a free-rolled residual rides the
 *   Chandelier with no time-stop, exactly like v3). See GENESIS_TIME_STOP_BARS.
 */

import "dotenv/config";
import { fetchBarsForTicker } from "../server/marketData";
import { calcEMA, calcRSI, type Bar } from "../server/zivEngine";

// ─── Sector map (ticker → sector) for the per-sector cap ──────────────────────
// Populated from the live catalog in main(); see getCatalogTickers().
const SECTOR_BY_TICKER: Record<string, string> = {};
function sectorOf(ticker: string): string {
  return SECTOR_BY_TICKER[ticker] ?? "OTHER";
}

/**
 * Pull the EXACT live scan universe the war engine uses (the "USA assets" on the
 * live dashboard). Mirrors warEngine.ts:528-531 — getUserAssets(uid) (which returns
 * userAssets rows with archived=0), then US-only + non-IPO_INCUBATOR filter.
 * Field names are off the Drizzle userAssets schema: `ticker`, `sector` (both
 * notNull), `catalogStatus` (nullable varchar).
 */
async function getCatalogTickers(userId = 1): Promise<{ ticker: string; sector: string }[]> {
  const { getUserAssets } = await import("../server/db");
  const assets = await getUserAssets(userId);
  return assets
    .filter(a => !a.ticker.toUpperCase().endsWith(".TA"))                 // US only
    .filter(a => (a as { catalogStatus?: string | null }).catalogStatus !== "IPO_INCUBATOR") // exclude IPO incubator
    .map(a => ({ ticker: a.ticker.toUpperCase(), sector: (a as { sector?: string | null }).sector ?? "OTHER" }));
}

// ─── Engine / trade-model parameters ──────────────────────────────────────────
const BARS_DAYS = 420;               // fetchBarsForTicker(ticker, 420) — ~back to 2024-10
const MIN_BARS = 50;                 // need a stable EMA50/trend history before scoring

const SL_LOOKBACK = 10;              // structural SL = min(low) over last 10 bars (i-9..i)
const RC2_MAX_RISK_PCT = 12;         // RC-2 guard: skip entry if (entry-SL)/entry > 12%

// ── GENESIS EXIT: free-roll at +1.5R (NOT +2R). ──
const PARTIAL_TP1_R = 1.5;           // bank 50% at +1.5R (the Genesis free-roll trigger)
const FREE_ROLL_FRACTION = 0.5;      // partial-close fraction at +1.5R
const CHANDELIER_ATR_MULT = 2.5;     // chand = peakHigh − 2.5×ATR14 (simple)
const ATR_PERIOD = 14;

// ── GENESIS TIME-STOP: generous 20-bar backstop (NO 4-day fast-kill). ──
const GENESIS_TIME_STOP_BARS = 20;   // pre-free-roll only; residual trails with no time-stop

// ─── genesisScore EMA periods ─────────────────────────────────────────────────
const EMA_20 = 20;
const EMA_50 = 50;
const EMA_200 = 200;
const DONCHIAN_PERIOD = 20;

// ─── Portfolio sizing parameters (per the spec) ───────────────────────────────
const START_EQUITY = 100_000;        // $100k single compounding account
const HEAT_CAP = 0.20;               // Σ open riskDollars / equity ≤ 0.20 → skip new entry
const MAX_POSITION_USD = 85_000;     // cap notional of any single position
const RISK_PCT = 0.01;               // riskDollars = 1% × equityAtEntry
const LEVERAGE = 1.0;                // gross notional of OPEN positions ≤ 1.0 × equity
const MAX_CONCURRENT = 12;           // conviction-ranked hard cap on simultaneously-OPEN positions (production value)
const MAX_PER_SECTOR = 3;            // hard cap on simultaneously-OPEN positions per sector

// ─── Friction model (REALISTIC is the headline; frictionless printed for ref) ─
const SLIPPAGE_BPS = 0.0005;         // 5 bps adverse on entry AND every exit fill
const COMMISSION_PER_SIDE = 1.0;     // flat $1/side on the implied (baseline-size) share count

// ─── Windows ──────────────────────────────────────────────────────────────────
//   W-CAL2025 = entryDate in [2025-01-01, 2025-12-31] (BOTH ends).
//   W-2026    = entryDate in [2026-01-01, last bar].
interface WindowDef { label: string; start: string; end: string | null; }
const WINDOWS: WindowDef[] = [
  { label: "W-CAL2025", start: "2025-01-01", end: "2025-12-31" },
  { label: "W-2026",    start: "2026-01-01", end: null },
];
const EARLIEST_WINDOW_START = WINDOWS.reduce(
  (min, w) => (w.start < min ? w.start : min),
  WINDOWS[0].start,
);

type FrictionMode = "FRICTIONLESS" | "REALISTIC";
const FRICTION_MODES: FrictionMode[] = ["FRICTIONLESS", "REALISTIC"];

// ════════════════════════════════════════════════════════════════════════════
// GENESIS SCORING — implemented FRESH from the authoritative v1.0 spec.
// Computes everything from daily closes/highs/lows/volume up to bar i.
// ════════════════════════════════════════════════════════════════════════════

interface GenesisScore {
  tier: "Gold Retest" | "Gold Breakout" | "Breakout Override" | null;
  baseScore: number;
  subScore: number;     // capped at +0.99
  totalScore: number;   // base + subScore
}

/** SIMPLE 14-period ATR — byte-for-byte elzaV3.ts computeAtr14Local. */
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

/** ATR over a given period (simple mean True Range over the last `period` bars). */
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

/**
 * Bullish Price Action (+1 to base): Hammer OR Inside Bar OR Bullish Engulfing.
 * Detection mirrors the engine's helper (zivEngine.ts) on the last bar of `bars`.
 */
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

/**
 * genesisScore(bars, i): score the bar at index i from data up to (and including) i.
 * Returns { tier, baseScore, subScore, totalScore }. tier === null → no signal.
 *
 * A bar qualifies for AT MOST one tier; precedence (most-conviction first) is:
 *   Gold Breakout → Gold Retest → Breakout Override. (Breakout Override is the
 *   below-EMA200 recovery case, so it can only apply when the above two cannot.)
 */
function genesisScore(bars: Bar[], i: number): GenesisScore {
  const NONE: GenesisScore = { tier: null, baseScore: 0, subScore: 0, totalScore: 0 };
  if (i < 1) return NONE;

  const window = bars.slice(0, i + 1);
  const closes = window.map(b => b.close);
  const price = closes[closes.length - 1];
  if (!(price > 0)) return NONE;

  const ema20 = calcEMA(closes, EMA_20);
  const ema50 = calcEMA(closes, EMA_50);
  const ema200 = closes.length >= EMA_200 ? calcEMA(closes, EMA_200) : calcEMA(closes, closes.length);

  // Weekly EMA-50 slope proxy (engine convention): sample every 5th close, EMA50-of-weekly
  // now vs 4 weekly-samples ago. >0 → weekly uptrend.
  const weeklyCloses = closes.filter((_, idx) => idx % 5 === 0);
  const weeklyEma50Now = weeklyCloses.length >= 10
    ? calcEMA(weeklyCloses, Math.min(50, weeklyCloses.length))
    : (weeklyCloses[weeklyCloses.length - 1] ?? price);
  const weeklyEma50Prev = weeklyCloses.length >= 14
    ? calcEMA(weeklyCloses.slice(0, -4), Math.min(50, weeklyCloses.length - 4))
    : weeklyEma50Now;
  const weeklyEma50Slope = weeklyEma50Now - weeklyEma50Prev;

  // Donchian-20 high/low over the last 20 bars.
  const last20 = window.slice(-DONCHIAN_PERIOD);
  const donchian20High = Math.max(...last20.map(b => b.high));
  const donchian20Low = Math.min(...last20.map(b => b.low));

  // Volume ratio (5d avg vs 20d avg).
  const volumes = window.map(b => b.volume ?? 0);
  const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length || 1);
  const avgVol5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, volumes.length || 1);
  const volRatio = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;

  // Distance from EMA50 (fraction).
  const distEma50 = ema50 > 0 ? Math.abs(price - ema50) / ema50 : 999;

  const bullishPA = hasBullishPA(window);

  // ── TIER ASSIGNMENT (at most one). ──
  let tier: GenesisScore["tier"] = null;
  let baseScore = 0;
  let isBreakoutTier = false;

  // Tier 4 — Gold Breakout: base 9 (or 10 if Bullish PA).
  if (price >= donchian20High * 0.995 && price > ema50 && price > ema200) {
    tier = "Gold Breakout";
    baseScore = bullishPA ? 10 : 9;
    isBreakoutTier = true;
  }
  // Tier 3 — Gold Retest: base 7 (or 8 if Bullish PA).
  else if (price > ema200 && weeklyEma50Slope > 0 && distEma50 <= 0.03) {
    tier = "Gold Retest";
    baseScore = bullishPA ? 8 : 7;
  }
  // Breakout Override: base 6. VolRatio>=2.0 AND price<EMA200.
  else if (volRatio >= 2.0 && price < ema200) {
    tier = "Breakout Override";
    baseScore = 6;
    isBreakoutTier = true;
  }

  if (tier === null) return NONE;

  // ── SUB-SCORES (sum capped at +0.99). ──
  const rsi = calcRSI(closes);
  let sub = 0;

  // RSI (max +0.20).
  if (isBreakoutTier) {
    if (rsi >= 60 && rsi <= 85) sub += 0.20;
  } else {
    if (rsi >= 50 && rsi <= 70) sub += 0.20;
    else if (rsi > 80) sub += 0.05;
  }

  // VolRatio 5d-vs-20d (max +0.20).
  if (volRatio >= 2.0) sub += 0.20;
  else if (volRatio >= 1.5) sub += 0.16;
  else if (volRatio >= 1.2) sub += 0.12;
  else if (volRatio >= 0.8) sub += 0.06;

  // Proximity to EMA50 (max +0.20): linear, cap +0.20 at touch, 0 at >=3%.
  if (distEma50 < 0.03) {
    sub += 0.20 * (1 - distEma50 / 0.03);
  }

  // Golden Cross (max +0.15): EMA20 > EMA50.
  if (ema20 > ema50) sub += 0.15;

  // 52W-High proximity (max +0.10).
  const lookback52w = window.slice(-252);
  const high52w = lookback52w.length > 0 ? Math.max(...lookback52w.map(b => b.high)) : price;
  const pctFrom52w = high52w > 0 ? (high52w - price) / high52w : 1; // >=0 below high
  if (pctFrom52w <= 0.02) sub += 0.10;
  else if (pctFrom52w <= 0.05) sub += 0.06;

  // ATR contraction (max +0.08): ATR5 < ATR14*0.75.
  const atr5 = atrOver(window, 5);
  const atr14 = atrOver(window, 14);
  if (atr14 > 0 && atr5 < atr14 * 0.75) sub += 0.08;

  // Trend strength (max +0.20, additive within cap).
  let trend = 0;
  const ema50Prev10 = closes.length > 10 ? calcEMA(closes.slice(0, -10), EMA_50) : ema50;
  const ema50SlopePct = ema50Prev10 > 0 ? (ema50 - ema50Prev10) / ema50Prev10 : 0;
  if (ema50SlopePct > 0.02) trend += 0.10;                          // EMA50 slope >2% over 10 bars
  const last11 = closes.slice(-11);
  let greenBars = 0;
  for (let k = 1; k < last11.length; k++) if (last11[k] > last11[k - 1]) greenBars++;
  if (greenBars >= 7) trend += 0.06;                                // 7-of-last-10 green
  const premiumEma50 = ema50 > 0 ? (price - ema50) / ema50 : 0;
  if (premiumEma50 >= 0.03 && premiumEma50 <= 0.15) trend += 0.04;  // price 3-15% above EMA50
  sub += Math.min(0.20, trend);

  // Profit potential (max +0.20, additive within cap).
  let profit = 0;
  const donchianWidth = donchian20High > 0 ? (donchian20High - donchian20Low) / donchian20High : 0;
  if (donchianWidth > 0.15) profit += 0.08;                         // channel width >15%
  const atrPct = price > 0 ? atr14 / price : 0;
  if (atrPct > 0.04) profit += 0.07;                                // ATR% >4%
  if (price >= high52w) profit += 0.05;                             // new 52W high
  sub += Math.min(0.20, profit);

  // Final cap on the sub-score sum.
  const subScore = Math.min(0.99, sub);
  const totalScore = baseScore + subScore;

  return { tier, baseScore, subScore, totalScore };
}

// ════════════════════════════════════════════════════════════════════════════
// CANDIDATE GENERATION — for every (ticker, bar) that qualifies a tier and passes
// the RC-2 stop-width guard, emit a CANDIDATE with its totalScore + the FULL
// forward exit walk pre-computed (entry=close; SL=10-bar low). Friction is applied
// later per-mode from the recorded fill LEVELS, exactly like elzaV3Decomp.ts.
// The conviction auction (highest totalScore fills free slots) runs in the sim.
// ════════════════════════════════════════════════════════════════════════════

type ExitReason = "SL" | "TIME" | "TRAIL" | "TRAIL_OPEN" | "OPEN";

interface Candidate {
  ticker: string;
  sector: string;
  entryDate: string;
  exitDate: string;
  tier: string;
  totalScore: number;        // conviction rank key
  entry: number;
  sl: number;
  exitReason: ExitReason;
  leg1FreeRolled: boolean;
  firstTarget: number;       // +1.5R level (leg1 bank price when free-rolled)
  leg1ExitPrice: number;     // full-position exit level when NOT free-rolled
  leg2ExitPrice: number;     // residual exit level when free-rolled
  stopDistPct: number;       // (entry - sl) / entry
}

/**
 * Compute a candidate's total R under a friction mode (faithful port of
 * elzaV3Decomp.computeTradeR, retuned to the Genesis 1.5R free-roll).
 */
function computeTradeR(c: Candidate, friction: FrictionMode): number {
  if (friction === "FRICTIONLESS") {
    const risk = c.entry - c.sl;
    if (!(risk > 0)) return 0;
    if (c.leg1FreeRolled) {
      const leg1R = FREE_ROLL_FRACTION * ((c.firstTarget - c.entry) / risk);
      const leg2R = FREE_ROLL_FRACTION * ((c.leg2ExitPrice - c.entry) / risk);
      return Math.round((leg1R + leg2R) * 100) / 100;
    }
    const fullR = (c.leg1ExitPrice - c.entry) / risk;
    return Math.round(fullR * 100) / 100;
  }

  // ── REALISTIC: 5bps adverse on entry + each exit fill, $1/side commission. ──
  const entryFill = c.entry * (1 + SLIPPAGE_BPS);  // adverse (higher) entry for a long
  const risk = entryFill - c.sl;                    // risk basis widens with slipped entry
  if (!(risk > 0)) return 0;

  const riskPerShare = entryFill - c.sl;
  const sharesFull = (RISK_PCT * START_EQUITY) / riskPerShare; // baseline implied share count
  const commR_perSide = sharesFull > 0 ? COMMISSION_PER_SIDE / (sharesFull * riskPerShare) : 0;

  if (c.leg1FreeRolled) {
    const leg1Fill = c.firstTarget * (1 - SLIPPAGE_BPS); // banked 50% fills LOWER
    const leg2Fill = c.leg2ExitPrice * (1 - SLIPPAGE_BPS);
    const leg1R = FREE_ROLL_FRACTION * ((leg1Fill - entryFill) / risk);
    const leg2R = FREE_ROLL_FRACTION * ((leg2Fill - entryFill) / risk);
    const commR = 3 * commR_perSide; // entry + two exit legs
    return Math.round((leg1R + leg2R - commR) * 100) / 100;
  }
  const exitFill = c.leg1ExitPrice * (1 - SLIPPAGE_BPS);
  const fullR = (exitFill - entryFill) / risk;
  const commR = 2 * commR_perSide;   // entry + one exit
  return Math.round((fullR - commR) * 100) / 100;
}

/**
 * Walk ONE ticker's bars, emit a Candidate for every qualifying bar. The exit walk
 * is the Genesis free-roll(1.5R) + Chandelier + generous 20-bar pre-free-roll
 * time-stop. NO re-entry suppression here: every qualifying bar is a candidate; the
 * portfolio auction decides which actually open and concurrency prevents overlap on
 * the same ticker (a ticker can't open twice while still open — enforced in the sim).
 */
function generateCandidates(ticker: string, bars: Bar[], out: Candidate[]): void {
  let i = 0;
  while (i < bars.length && bars[i].date < EARLIEST_WINDOW_START) i++;

  for (; i < bars.length; i++) {
    if (i + 1 < MIN_BARS) continue;
    if (i + 1 < SL_LOOKBACK) continue;

    const gs = genesisScore(bars, i);
    if (gs.tier === null) continue;

    const entry = bars[i].close;
    if (!(entry > 0)) continue;

    // SL = 10-bar low. RC-2: skip if (entry-SL)/entry > 12%.
    const slWindow = bars.slice(i - (SL_LOOKBACK - 1), i + 1);
    const sl = Math.min(...slWindow.map(b => b.low));
    if (!(sl < entry)) continue;
    const stopDistPct = (entry - sl) / entry;
    if (stopDistPct * 100 > RC2_MAX_RISK_PCT) continue;

    const risk = entry - sl;
    const firstTarget = entry + PARTIAL_TP1_R * risk; // +1.5R Genesis free-roll level

    // ── EXIT walk-forward — free-roll(1.5R) + Chandelier + 20-bar time-stop. ──
    let exitDate = bars[bars.length - 1].date;
    let exitReason: ExitReason = "OPEN";

    let reachedFirstTarget = false;
    let leg1FreeRolled = false;
    let leg1ExitPrice = entry;
    let leg2ExitPrice = entry;

    let currentStop = sl;
    let highestHigh = bars[i].high;
    let trailStop = -Infinity;

    for (let j = i + 1; j < bars.length; j++) {
      const bar = bars[j];
      const heldBars = j - i;

      if (!reachedFirstTarget) {
        // PHASE 1: full size, stop at initial SL. SL-first on tie.
        if (bar.low <= currentStop) {
          exitReason = "SL"; exitDate = bar.date;
          leg1ExitPrice = currentStop;
          break;
        }
        if (bar.high >= firstTarget) {
          // PHASE 2: tag +1.5R. Bank 50% at firstTarget, residual to BE, seed trail.
          reachedFirstTarget = true;
          leg1FreeRolled = true;
          currentStop = entry; // breakeven on residual
          highestHigh = Math.max(highestHigh, bar.high);
          const atr = computeAtr14Local(bars.slice(0, j + 1));
          trailStop = (atr != null && atr > 0)
            ? Math.max(currentStop, highestHigh - CHANDELIER_ATR_MULT * atr)
            : currentStop;
          currentStop = trailStop;
          continue;
        }
        // GENESIS TIME-STOP — generous 20-bar backstop (pre-free-roll only).
        if (heldBars >= GENESIS_TIME_STOP_BARS) {
          exitReason = "TIME"; exitDate = bar.date;
          leg1ExitPrice = bar.close;
          break;
        }
        if (j === bars.length - 1) {
          exitReason = "OPEN"; exitDate = bar.date;
          leg1ExitPrice = bar.close;
        }
      } else {
        // PHASE 3: residual 50% trails on the ATR-Chandelier. NO time-stop here.
        highestHigh = Math.max(highestHigh, bar.high);
        const atr = computeAtr14Local(bars.slice(0, j + 1));
        if (atr != null && atr > 0) {
          trailStop = Math.max(trailStop, highestHigh - CHANDELIER_ATR_MULT * atr);
        }
        currentStop = trailStop;

        if (bar.low <= currentStop) {
          exitReason = "TRAIL"; exitDate = bar.date;
          leg2ExitPrice = currentStop;
          break;
        }
        if (j === bars.length - 1) {
          exitReason = "TRAIL_OPEN"; exitDate = bar.date;
          leg2ExitPrice = bar.close;
        }
      }
    }

    if (i === bars.length - 1) {
      exitDate = bars[i].date; exitReason = "OPEN";
      leg1FreeRolled = false; leg1ExitPrice = entry; leg2ExitPrice = entry;
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
      leg1FreeRolled,
      firstTarget,
      leg1ExitPrice,
      leg2ExitPrice,
      stopDistPct,
    });
    // NO i-jump: Genesis evaluates every bar as a fresh candidate. Same-ticker overlap
    // is prevented by the portfolio auction (a ticker already OPEN cannot re-open).
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PORTFOLIO SIM — CONVICTION-RANKED auction (the headline Genesis behavior).
// On each calendar day we (a) process EXITS first (free slots/capital), then
// (b) collect ALL candidate ENTRIES whose entryDate == that day, sort them by
// totalScore DESC, and fill the remaining slots highest-conviction-first.
// ════════════════════════════════════════════════════════════════════════════

interface OpenPos {
  ticker: string; sector: string; notional: number; riskDollars: number;
  pnl: number; exitDate: string; candIdx: number;
}
interface ClosedTrade {
  ticker: string; entryDate: string; exitDate: string; exitReason: ExitReason;
  r: number; pnl: number; skipped: boolean;
}
interface CellResult {
  windowLabel: string;
  friction: FrictionMode;
  tradesTaken: number;
  wins: number;
  winPct: number;
  totalR: number;
  finalReturnPct: number;
  maxDrawdownPct: number;
  finalEquity: number;
  exitBreakdown: Record<string, number>;
}

/**
 * Run the conviction-ranked portfolio for ONE (window-filtered candidate list × friction).
 * Realized-equity convention. Caps: concurrency (10), per-sector (3), then heat/leverage/
 * maxPosition sizing trims. A ticker already OPEN is skipped (no same-ticker overlap).
 */
function runPortfolio(
  windowCands: Candidate[],
  friction: FrictionMode,
  windowLabel: string,
): CellResult {
  const rOf = (c: Candidate): number => computeTradeR(c, friction);

  // Build the set of distinct calendar dates (entries + exits), processed in order.
  const dates = new Set<string>();
  windowCands.forEach(c => { dates.add(c.entryDate); dates.add(c.exitDate); });
  const sortedDates = [...dates].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // Index candidates by entryDate for the per-day auction.
  const candsByEntryDate = new Map<string, Candidate[]>();
  windowCands.forEach((c, idx) => {
    (c as any).__idx = idx;
    const arr = candsByEntryDate.get(c.entryDate) ?? [];
    arr.push(c);
    candsByEntryDate.set(c.entryDate, arr);
  });

  let equity = START_EQUITY;
  let peakEquity = START_EQUITY;
  let maxDrawdownPct = 0;

  const openByIdx = new Map<number, OpenPos>();
  const openTickers = new Set<string>();
  const closed: ClosedTrade[] = [];

  const grossOpenNotional = (): number => {
    let s = 0; for (const p of openByIdx.values()) s += p.notional; return s;
  };
  const grossOpenRisk = (): number => {
    let s = 0; for (const p of openByIdx.values()) s += p.riskDollars; return s;
  };
  const openCountInSector = (sec: string): number => {
    let n = 0; for (const p of openByIdx.values()) if (p.sector === sec) n++; return n;
  };

  for (const day of sortedDates) {
    // ── (a) EXITS first — free slots/capital before the day's entry auction. ──
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
      if (equity > peakEquity) peakEquity = equity;
      const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }

    // ── (b) ENTRY auction — highest totalScore fills the free slots (NOT FIFO). ──
    const todays = (candsByEntryDate.get(day) ?? [])
      .slice()
      .sort((a, b) => {
        if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore; // conviction DESC
        return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;          // stable tiebreak
      });

    for (const c of todays) {
      const idx = (c as any).__idx as number;
      if (openByIdx.size >= MAX_CONCURRENT) break;          // book full — stop the auction
      if (openTickers.has(c.ticker)) continue;              // no same-ticker overlap
      if (openCountInSector(c.sector) >= MAX_PER_SECTOR) continue;

      const equityAtEntry = equity;
      let riskDollars = RISK_PCT * equityAtEntry;

      const heatAfter = (grossOpenRisk() + riskDollars) / (equityAtEntry > 0 ? equityAtEntry : 1);
      if (heatAfter > HEAT_CAP) {
        closed.push({
          ticker: c.ticker, entryDate: c.entryDate, exitDate: c.exitDate,
          exitReason: c.exitReason, r: rOf(c), pnl: 0, skipped: true,
        });
        continue;
      }

      let notional = riskDollars / c.stopDistPct;
      if (notional > MAX_POSITION_USD) {
        const scale = MAX_POSITION_USD / notional;
        notional *= scale; riskDollars *= scale;
      }
      const headroom = Math.max(0, LEVERAGE * equityAtEntry - grossOpenNotional());
      if (notional > headroom) {
        const scale = headroom > 0 ? headroom / notional : 0;
        notional *= scale; riskDollars *= scale;
      }

      const pnl = rOf(c) * riskDollars;
      openByIdx.set(idx, {
        ticker: c.ticker, sector: c.sector, notional, riskDollars,
        pnl, exitDate: c.exitDate, candIdx: idx,
      });
      openTickers.add(c.ticker);
    }
  }

  const taken = closed.filter(c => !c.skipped);
  const wins = taken.filter(c => c.r > 0).length;
  const totalR = taken.reduce((s, c) => s + c.r, 0);
  const exitBreakdown: Record<string, number> = {};
  for (const c of taken) exitBreakdown[c.exitReason] = (exitBreakdown[c.exitReason] ?? 0) + 1;

  return {
    windowLabel,
    friction,
    tradesTaken: taken.length,
    wins,
    winPct: taken.length > 0 ? (wins / taken.length) * 100 : 0,
    totalR: Math.round(totalR * 100) / 100,
    finalReturnPct: ((equity - START_EQUITY) / START_EQUITY) * 100,
    maxDrawdownPct: maxDrawdownPct * 100,
    finalEquity: Math.round(equity),
    exitBreakdown,
  };
}

// ─── SPY benchmark (copied from elzaV3Decomp.ts; respects an end-date) ─────────
interface SpyResult { windowLabel: string; returnPct: number; maxDDPct: number; }
function computeSpyBenchmark(
  windowLabel: string, spyBars: Bar[], windowStart: string, windowEnd: string | null,
): SpyResult | null {
  const inWin = spyBars
    .filter(b => b.date >= windowStart && (windowEnd == null || b.date <= windowEnd))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (inWin.length < 2) return null;
  const base = inWin[0].close;
  let peak = START_EQUITY;
  let maxDD = 0;
  let lastEq = START_EQUITY;
  for (const b of inWin) {
    const eq = START_EQUITY * (b.close / base);
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    if (dd > maxDD) maxDD = dd;
    lastEq = eq;
  }
  return {
    windowLabel,
    returnPct: ((lastEq - START_EQUITY) / START_EQUITY) * 100,
    maxDDPct: maxDD * 100,
  };
}

// ─── Window-candidate filter (both ends) ──────────────────────────────────────
function candsForWindow(all: Candidate[], start: string, end: string | null): Candidate[] {
  return all.filter(c => c.entryDate >= start && (end == null || c.entryDate <= end));
}

// ─── Reporting helpers ────────────────────────────────────────────────────────
function pad(s: string | number, w: number): string {
  const str = String(s); return str.length >= w ? str : str + " ".repeat(w - str.length);
}
function padL(s: string | number, w: number): string {
  const str = String(s); return str.length >= w ? str : " ".repeat(w - str.length) + str;
}
function sign(n: number): string { return n >= 0 ? "+" : ""; }

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`Elza v1-GENESIS (warEngine v1.0) Backtest — READ-ONLY (no DB writes, no IBKR, no orders, no SSH)`);

  // ── Resolve the LIVE scan universe (mirrors warEngine.ts:528-531). ──
  const catalog = await getCatalogTickers(1);
  for (const a of catalog) SECTOR_BY_TICKER[a.ticker] = a.sector;
  const TICKERS: string[] = catalog.map(a => a.ticker);
  console.log("[CATALOG] live universe: " + TICKERS.length + " USA tickers (uid=1, US-only, non-IPO)");

  console.log(`Scoring: FRESH genesisScore (NOT calcZivEngineScore). LONG-ONLY. Universe: ${TICKERS.length} live USA tickers (uid=1, US-only, non-IPO_INCUBATOR).`);
  console.log(`Tiers: Gold Retest 7/8 (price>EMA200 & weeklySlope>0 & |ΔEMA50|<=3%) | Gold Breakout 9/10 (>=Donchian20H*0.995 & >EMA50 & >EMA200) | Breakout Override 6 (vol5/20>=2.0 & price<EMA200). +1 base on bullish PA.`);
  console.log(`Sub-scores: RSI/Vol/Prox/GoldenCross/52W/ATR-contraction/Trend/Profit, sum capped at +0.99. totalScore = base + min(0.99, Σsubs).`);
  console.log(`RANKING (headline): per-day conviction auction — highest totalScore fills the ${MAX_CONCURRENT} slots (NOT FIFO).`);
  console.log(`Exit: SL=${SL_LOOKBACK}-bar low; RC-2 skip if (entry-SL)/entry>${RC2_MAX_RISK_PCT}%; free-roll bank 50% at +${PARTIAL_TP1_R}R → BE; Chandelier max(prior, highHigh − ${CHANDELIER_ATR_MULT}×ATR${ATR_PERIOD}). SL-first on tie.`);
  console.log(`Time-stop: NO 4-day fast-kill (Genesis "let it run"); generous ${GENESIS_TIME_STOP_BARS}-bar pre-free-roll backstop only.`);
  console.log(`Portfolio: $${START_EQUITY.toLocaleString()}, ${RISK_PCT * 100}% risk, leverage ${LEVERAGE}×, maxConcurrent ${MAX_CONCURRENT} (conviction-ranked), maxPerSector ${MAX_PER_SECTOR}, heat ≤ ${HEAT_CAP * 100}%, maxPos $${MAX_POSITION_USD.toLocaleString()}.`);
  console.log(`Friction REALISTIC (headline): 5bps adverse entry & every exit fill + $1/side commission. FRICTIONLESS printed for reference.`);
  console.log(`Windows: W-CAL2025 = entryDate in [2025-01-01, 2025-12-31] | W-2026 = entryDate in [2026-01-01, last bar]. SPY buy&hold per window.`);
  console.log(`SHORTS ARE OMITTED — long side of the engine only.`);
  console.log("");

  // SPY once.
  let spyBars: Bar[] = [];
  try {
    spyBars = await fetchBarsForTicker("SPY", BARS_DAYS);
    spyBars = [...spyBars].sort((a, b) => (a.date < b.date ? -1 : 1));
    console.log(`[SPY] fetched ${spyBars.length} bars for benchmark.`);
  } catch (e) {
    console.log(`[WARN] SPY fetch failed: ${(e as Error).message ?? e}. SPY benchmark will be skipped.`);
  }

  // Build candidates once across all tickers.
  const allCands: Candidate[] = [];
  let processed = 0;
  let skippedNoData = 0;

  for (const ticker of TICKERS) {
    processed++;
    if (processed % 20 === 0) {
      console.log(`[PROGRESS] ${processed}/${TICKERS.length} tickers processed (${allCands.length} candidates so far).`);
    }
    try {
      let bars = await fetchBarsForTicker(ticker, BARS_DAYS);
      if (!bars || bars.length < MIN_BARS) { skippedNoData++; continue; }
      bars = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

      const lastDate = bars[bars.length - 1].date;
      if (lastDate < EARLIEST_WINDOW_START) { skippedNoData++; continue; }
      const warmupBefore = bars.filter(b => b.date < EARLIEST_WINDOW_START).length;
      if (warmupBefore < MIN_BARS) { skippedNoData++; continue; }

      generateCandidates(ticker, bars, allCands);
    } catch (e) {
      console.log(`[WARN] ${ticker}: ${(e as Error).message ?? e}. Skipping ticker.`);
      continue;
    }
  }

  console.log("");
  console.log(`[DONE BUILDING] ${allCands.length} Genesis LONG candidates across ${TICKERS.length - skippedNoData} usable tickers (${skippedNoData} skipped).`);

  // SPY per window.
  const spyByWindow = new Map<string, SpyResult | null>();
  for (const w of WINDOWS) {
    spyByWindow.set(w.label, computeSpyBenchmark(w.label, spyBars, w.start, w.end));
  }

  // ── Per window: run both friction modes, print the report + SPY verdict. ──
  for (const w of WINDOWS) {
    const wc = candsForWindow(allCands, w.start, w.end);
    const real = runPortfolio(wc, "REALISTIC", w.label);
    const fric = runPortfolio(wc, "FRICTIONLESS", w.label);
    const spy = spyByWindow.get(w.label) ?? null;

    console.log("");
    console.log(`══════════════════════════════════════════════════════════════════════════════`);
    console.log(`═══ ${w.label} — Elza v1-GENESIS (conviction-ranked, LONG only, SHORTS OMITTED) ═══`);
    console.log(`══════════════════════════════════════════════════════════════════════════════`);
    console.log(`  candidates-in-window : ${wc.length}`);
    console.log("");
    console.log(`  ${pad("metric", 16)}${padL("REALISTIC", 16)}${padL("frictionless", 16)}`);
    console.log(`  ${"─".repeat(48)}`);
    console.log(`  ${pad("trades", 16)}${padL(real.tradesTaken, 16)}${padL(fric.tradesTaken, 16)}`);
    console.log(`  ${pad("win%", 16)}${padL(real.winPct.toFixed(1) + "%", 16)}${padL(fric.winPct.toFixed(1) + "%", 16)}`);
    console.log(`  ${pad("totalR", 16)}${padL(sign(real.totalR) + real.totalR.toFixed(2), 16)}${padL(sign(fric.totalR) + fric.totalR.toFixed(2), 16)}`);
    console.log(`  ${pad("return%", 16)}${padL(sign(real.finalReturnPct) + real.finalReturnPct.toFixed(2) + "%", 16)}${padL(sign(fric.finalReturnPct) + fric.finalReturnPct.toFixed(2) + "%", 16)}`);
    console.log(`  ${pad("maxDD%", 16)}${padL(real.maxDrawdownPct.toFixed(2) + "%", 16)}${padL(fric.maxDrawdownPct.toFixed(2) + "%", 16)}`);
    console.log(`  ${pad("finalEq$", 16)}${padL("$" + real.finalEquity.toLocaleString(), 16)}${padL("$" + fric.finalEquity.toLocaleString(), 16)}`);

    // Exit-reason breakdown (taken trades, REALISTIC book).
    const eb = real.exitBreakdown;
    console.log("");
    console.log(`  ── exit-reason breakdown (REALISTIC book) ──`);
    console.log(`     SL=${eb["SL"] ?? 0}  TIME(${GENESIS_TIME_STOP_BARS}bar)=${eb["TIME"] ?? 0}  TRAIL=${eb["TRAIL"] ?? 0}  FREE_ROLL_OPEN(TRAIL_OPEN)=${eb["TRAIL_OPEN"] ?? 0}  OPEN=${eb["OPEN"] ?? 0}`);

    // SPY side-by-side + verdict (REALISTIC is the headline column vs SPY).
    console.log("");
    console.log(`  ── v1-Genesis (REALISTIC) vs SPY buy&hold $100k ──`);
    if (!spy) {
      console.log(`     [SKIP] No SPY bars in window. VERDICT: INDETERMINATE (no SPY data).`);
    } else {
      console.log(`     ${pad("metric", 10)}${padL("Genesis", 14)}${padL("SPY b&h", 14)}`);
      console.log(`     ${"─".repeat(38)}`);
      console.log(`     ${pad("return%", 10)}${padL(sign(real.finalReturnPct) + real.finalReturnPct.toFixed(2) + "%", 14)}${padL(sign(spy.returnPct) + spy.returnPct.toFixed(2) + "%", 14)}`);
      console.log(`     ${pad("maxDD%", 10)}${padL(real.maxDrawdownPct.toFixed(2) + "%", 14)}${padL(spy.maxDDPct.toFixed(2) + "%", 14)}`);
      const diff = real.finalReturnPct - spy.returnPct;
      const beats = diff >= 0;
      console.log("");
      console.log(`  v1-Genesis ${beats ? "BEATS" : "LOSES"} SPY by ${Math.abs(diff).toFixed(2)} pts (realistic) ` +
        `(Genesis ${sign(real.finalReturnPct)}${real.finalReturnPct.toFixed(2)}% vs SPY ${sign(spy.returnPct)}${spy.returnPct.toFixed(2)}%).`);
    }

    // Machine-readable line.
    console.log(`[JSON] ${JSON.stringify({
      window: w.label,
      candidates: wc.length,
      realistic: {
        trades: real.tradesTaken, winPct: Math.round(real.winPct * 10) / 10,
        totalR: real.totalR, returnPct: Math.round(real.finalReturnPct * 100) / 100,
        maxDDPct: Math.round(real.maxDrawdownPct * 100) / 100, exitBreakdown: real.exitBreakdown,
      },
      frictionless: {
        trades: fric.tradesTaken, winPct: Math.round(fric.winPct * 10) / 10,
        totalR: fric.totalR, returnPct: Math.round(fric.finalReturnPct * 100) / 100,
        maxDDPct: Math.round(fric.maxDrawdownPct * 100) / 100,
      },
      spy: spy ? { returnPct: Math.round(spy.returnPct * 100) / 100, maxDDPct: Math.round(spy.maxDDPct * 100) / 100 } : null,
    })}`);
  }

  printDisclaimer();

  console.log("");
  console.log(`Done. v1-Genesis sized over ${WINDOWS.length} windows × 2 friction modes. (Simulation only — no live actions taken.)`);
}

function printDisclaimer(): void {
  console.log("");
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`SIMPLIFICATIONS / DISCLAIMER — read before trusting any number above`);
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`  • SHORTS OMITTED: LONG side only. The live regime/breadth short-gate is not reproduced offline.`);
  console.log(`  • FRESH SCORING: genesisScore is implemented from the v1.0 spec, NOT the live v2.2 engine.`);
  console.log(`    True-Retest/Role-Reversal structure is approximated by the spec's |Δ EMA50|<=3% proximity test.`);
  console.log(`  • CONVICTION AUCTION is a per-CALENDAR-DAY ranking on totalScore; intraday entry timing within`);
  console.log(`    a day is not modelled (all same-day candidates compete at the daily close).`);
  console.log(`  • DAILY-BAR TRAIL OVERSTATES: the +1.5R tag and Chandelier trail use DAILY highs/lows; an intraday`);
  console.log(`    path might never have permitted a run a daily high implies. Trail runs are OVERSTATED.`);
  console.log(`  • FRICTION IS APPROXIMATE: 5bps flat haircut on entry + each exit fill; commission-in-R at the`);
  console.log(`    BASELINE 1%-risk full size (implied shares), NOT post-cap size. REALISTIC is a FLOOR on cost.`);
  console.log(`  • TIME-STOP CHOICE: ${GENESIS_TIME_STOP_BARS}-bar pre-free-roll backstop only (Genesis had no 4-day kill). A different`);
  console.log(`    generous backstop would shift the TIME-exit bucket but leave the conviction/free-roll core intact.`);
  console.log(`  • THIN 2025 WARMUP: fetchBarsForTicker(..,420) reaches ~2024-10, so early-2025 entries open on`);
  console.log(`    ~50 bars of warmup. EMA200 falls back to a shorter EMA until 200 bars exist — treat early entries with caution.`);
  console.log(`  • CAPS MODEL HEADROOM ONLY: leverage/heat/maxPosition trim/skip size but do NOT model margin calls,`);
  console.log(`    gap risk, or forced liquidation. Max-DD is on REALIZED equity — a FLOOR.`);
}

main().catch(err => {
  console.error(`[FATAL] ${(err as Error).stack ?? err}`);
  process.exit(1);
});
