/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  elzaV4Hybrid.ts — TWO configs in ONE harness vs SPY. READ-ONLY backtest.  ║
 * ║                                                                            ║
 * ║  PURE SIMULATION. NO DB writes. NO IBKR. NO orders. NO deploy. NO SSH.     ║
 * ║                                                                            ║
 * ║  CONFIG 1 — Genesis-TRUE : a FAITHFUL warEngine v1.0 baseline. The         ║
 * ║    authoritative entry gate is LONG_ENTRY_MIN_SCORE = 7.0 (NOT 7.5 — 7.5   ║
 * ║    was a v2 value) AND MIN_CONFLUENCE = 4.5 AND MIN_LIQUIDITY_SCORE = 2.0. ║
 * ║    Confluence/liquidity come from getTickerIntelligence(bars.slice(0,i+1)) ║
 * ║    — computed CAUSALLY (as-of the entry bar) from daily bars only.          ║
 * ║                                                                            ║
 * ║  CONFIG 2 — v4-Hybrid : = Genesis-TRUE PLUS                                 ║
 * ║    [A] Shallow focus on Tier-3 (Gold Retest) ONLY — entry must sit in the  ║
 * ║        EMA20→EMA50 pullback band (price<=EMA20*1.005 & price>=EMA50*0.995 & ║
 * ║        price>EMA200). Tier-4 breakouts are EXEMPT (above all MAs).          ║
 * ║    [C] Fast Kill — at entryIndex+4 bars, if the trade has NOT reached      ║
 * ║        mfeR>=1.0R (and not yet free-rolled), exit at that bar's close       ║
 * ║        (FAST_TIME). Replaces the 20-bar backstop for v4.                    ║
 * ║                                                                            ║
 * ║  Both configs: conviction-ranked 12-slot fill; SL-FIRST-ON-TIE (strict);   ║
 * ║  free-roll +1.5R → BE → Chandelier; RC-2 12% skip; full pessimism friction.║
 * ║  LONG-ONLY. SHORTS OMITTED.                                                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * RUN (manager runs this on the droplet — has Yahoo/DB data; 148 tickers is slow):
 *   node --import tsx --env-file=.env scripts/elzaV4Hybrid.ts
 *
 * BUILD-CHECK (local, no run):
 *   npx esbuild scripts/elzaV4Hybrid.ts --bundle --platform=node --packages=external --outdir=/tmp/v4bc
 *
 * Scoring / exit / portfolio / dynamic-catalog / friction / conviction-ranking are
 * faithful copies of scripts/elzaV1Genesis.ts. Only `calcEMA`/`calcRSI`/the `Bar`
 * type (server/zivEngine.ts) and `getTickerIntelligence` (server/runtimeIntelligence.ts)
 * are reused — no P&L/price formula is re-implemented.
 */

import "dotenv/config";
import { fetchBarsForTicker } from "../server/marketData";
import { calcEMA, calcRSI, type Bar } from "../server/zivEngine";
import { getTickerIntelligence } from "../server/runtimeIntelligence";

// ─── Sector map (ticker → sector) for the per-sector cap ──────────────────────
const SECTOR_BY_TICKER: Record<string, string> = {};
function sectorOf(ticker: string): string {
  return SECTOR_BY_TICKER[ticker] ?? "OTHER";
}

/**
 * Pull the EXACT live scan universe the war engine uses (the "USA assets").
 * Mirrors warEngine.ts:528-531 — getUserAssets(uid) (archived=0), then
 * US-only + non-IPO_INCUBATOR filter. dynamic getCatalogTickers(1) ≈ 148 USA.
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

// ── TRUE v1.0 ENTRY GATES (the correction). ──
const LONG_ENTRY_MIN_SCORE = 7.0;    // authoritative v1.0 floor (NOT 7.5 — that was v2)
const MIN_CONFLUENCE        = 4.5;   // v1.0 gated on confluenceScore >= 4.5
const MIN_LIQUIDITY_SCORE   = 2.0;   // v1.0 gated on liquidityScore  >= 2.0

// ── GENESIS EXIT: free-roll at +1.5R (NOT +2R). ──
const PARTIAL_TP1_R = 1.5;           // bank 50% at +1.5R (the Genesis free-roll trigger)
const FREE_ROLL_FRACTION = 0.5;      // partial-close fraction at +1.5R
const CHANDELIER_ATR_MULT = 2.5;     // chand = peakHigh − 2.5×ATR14 (simple)
const ATR_PERIOD = 14;

// ── GENESIS TIME-STOP: generous 20-bar backstop (Config 1 only). ──
const GENESIS_TIME_STOP_BARS = 20;   // pre-free-roll only; residual trails with no time-stop

// ── v4-Hybrid [C] FAST KILL (Config 2 only) — replaces the 20-bar backstop. ──
const FAST_KILL_BARS = 4;            // at entryIndex+4 bars …
const FAST_KILL_MFE_R = 1.0;         // … if mfeR < 1.0R and not free-rolled → exit at close

// ─── EMA / Donchian periods ───────────────────────────────────────────────────
const EMA_20 = 20;
const EMA_50 = 50;
const EMA_200 = 200;
const DONCHIAN_PERIOD = 20;

// ── v4-Hybrid [A] SHALLOW FOCUS band (Tier-3 Retest only). ──
const SHALLOW_EMA20_TOL = 1.005;     // price <= EMA20 * 1.005
const SHALLOW_EMA50_TOL = 0.995;     // price >= EMA50 * 0.995

// ─── Portfolio sizing parameters ──────────────────────────────────────────────
const START_EQUITY = 100_000;
const HEAT_CAP = 0.20;
const MAX_POSITION_USD = 85_000;
const RISK_PCT = 0.01;
const LEVERAGE = 1.0;
const MAX_CONCURRENT = 12;
const MAX_PER_SECTOR = 3;

// ─── Friction model (REALISTIC is the headline; frictionless printed for ref) ─
const SLIPPAGE_BPS = 0.0005;         // 5 bps adverse on entry AND every exit fill
const COMMISSION_PER_SIDE = 1.0;     // flat $1/side on the implied (baseline-size) share count

// ─── Windows ──────────────────────────────────────────────────────────────────
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

// ─── Config identity ──────────────────────────────────────────────────────────
type ConfigId = "GENESIS_TRUE" | "V4_HYBRID" | "V4_MASTER";
const CONFIGS: ConfigId[] = ["GENESIS_TRUE", "V4_HYBRID"];
function configLabel(c: ConfigId): string {
  if (c === "GENESIS_TRUE") return "Genesis-TRUE";
  if (c === "V4_MASTER") return "v4-Master";
  return "v4-Hybrid";
}

// ════════════════════════════════════════════════════════════════════════════
// GENESIS SCORING — copied verbatim from elzaV1Genesis.ts (v1.0 spec).
// ════════════════════════════════════════════════════════════════════════════

interface GenesisScore {
  tier: "Gold Retest" | "Gold Breakout" | "Breakout Override" | null;
  baseScore: number;
  subScore: number;     // capped at +0.99
  totalScore: number;   // base + subScore
  // ── extra fields the v4 shallow-focus gate needs (causal, from bar i). ──
  price: number;
  ema20: number;
  ema50: number;
  ema200: number;
}

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

/**
 * genesisScore(bars, i): score the bar at index i from data up to (and including) i.
 * Precedence: Gold Breakout → Gold Retest → Breakout Override. tier===null → no signal.
 * Also returns the causal price/EMA20/EMA50/EMA200 (the v4 shallow gate reuses them).
 */
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

  if (distEma50 < 0.03) {
    sub += 0.20 * (1 - distEma50 / 0.03);
  }

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
  const totalScore = baseScore + subScore;

  return { tier, baseScore, subScore, totalScore, price, ema20, ema50, ema200 };
}

// ════════════════════════════════════════════════════════════════════════════
// CANDIDATE GENERATION — emit ONE candidate per (ticker, bar) qualifying tier that
// passes (i) totalScore>=7.0, (ii) confluence>=4.5 & liquidity>=2.0, (iii) RC-2.
// The forward exit walk is pre-computed PER CONFIG (Config 2 uses fast-kill +
// shallow-focus). Friction is applied later per-mode from the recorded fill LEVELS.
// ════════════════════════════════════════════════════════════════════════════

type ExitReason = "SL" | "TIME" | "FAST_TIME" | "TRAIL" | "TRAIL_OPEN" | "OPEN";

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
  /** Max favorable excursion in R (bar HIGH) through exit bar — pre-free-roll phase only. */
  maxHighR: number;
}

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
  const entryFill = c.entry * (1 + SLIPPAGE_BPS);
  const risk = entryFill - c.sl;
  if (!(risk > 0)) return 0;

  const riskPerShare = entryFill - c.sl;
  const sharesFull = (RISK_PCT * START_EQUITY) / riskPerShare;
  const commR_perSide = sharesFull > 0 ? COMMISSION_PER_SIDE / (sharesFull * riskPerShare) : 0;

  if (c.leg1FreeRolled) {
    const leg1Fill = c.firstTarget * (1 - SLIPPAGE_BPS);
    const leg2Fill = c.leg2ExitPrice * (1 - SLIPPAGE_BPS);
    const leg1R = FREE_ROLL_FRACTION * ((leg1Fill - entryFill) / risk);
    const leg2R = FREE_ROLL_FRACTION * ((leg2Fill - entryFill) / risk);
    const commR = 3 * commR_perSide;
    return Math.round((leg1R + leg2R - commR) * 100) / 100;
  }
  const exitFill = c.leg1ExitPrice * (1 - SLIPPAGE_BPS);
  const fullR = (exitFill - entryFill) / risk;
  const commR = 2 * commR_perSide;
  return Math.round((fullR - commR) * 100) / 100;
}

/**
 * Walk ONE ticker's bars, emit a Candidate per qualifying bar FOR A GIVEN CONFIG.
 * Entry gates (BOTH configs): totalScore>=7.0, confluence>=4.5, liquidity>=2.0, RC-2.
 * v4-Hybrid adds [A] shallow-focus (Tier-3 only) at the gate and [C] fast-kill in
 * the walk. async because getTickerIntelligence is async (it's offline-causal here:
 * we pass bars.slice(0, i+1) so it never fetches and is computed as-of the entry bar).
 *
 * SL-FIRST-ON-TIE (strict): on any bar where low<=stop AND high>=target, the STOP
 * fills — the take-profit is NOT credited. The +1.5R leg1 only banks if
 * high>=firstTarget AND low>currentStop on that bar.
 */
async function generateCandidates(
  ticker: string,
  bars: Bar[],
  config: ConfigId,
  out: Candidate[],
): Promise<void> {
  let i = 0;
  while (i < bars.length && bars[i].date < EARLIEST_WINDOW_START) i++;

  for (; i < bars.length; i++) {
    if (i + 1 < MIN_BARS) continue;
    if (i + 1 < SL_LOOKBACK) continue;

    const gs = genesisScore(bars, i);
    if (gs.tier === null) continue;

    // ── ENTRY GATE 1 — TRUE v1.0 score floor. ──
    if (!(gs.totalScore >= LONG_ENTRY_MIN_SCORE)) continue;

    // ── v4-Hybrid [A] SHALLOW FOCUS — Tier-3 Gold Retest ONLY. ──
    // Require the entry to sit in the EMA20→EMA50 pullback band, EMA-200 guarded.
    // Tier-4 Gold Breakout is EXEMPT (above all MAs by definition). Breakout
    // Override is below EMA-200 (a falling-knife case) → shallow focus EXCLUDES it.
    if ((config === "V4_HYBRID" || config === "V4_MASTER") && gs.tier === "Gold Retest") {
      const inBand = gs.price <= gs.ema20 * SHALLOW_EMA20_TOL
        && gs.price >= gs.ema50 * SHALLOW_EMA50_TOL
        && gs.price > gs.ema200;
      if (!inBand) continue;
    }
    if ((config === "V4_HYBRID" || config === "V4_MASTER") && gs.tier === "Breakout Override") {
      continue; // below-EMA200 recovery is excluded from v4 shallow-focus universe
    }

    const entry = bars[i].close;
    if (!(entry > 0)) continue;

    // ── ENTRY GATE 2 — confluence & liquidity (REAL, causal from bars[0..i]). ──
    const intel = await getTickerIntelligence(ticker, bars.slice(0, i + 1));
    if (!(intel.confluenceScore >= MIN_CONFLUENCE)) continue;
    if (!(intel.liquidityScore >= MIN_LIQUIDITY_SCORE)) continue;

    // SL = 10-bar low. RC-2: skip if (entry-SL)/entry > 12%.
    const slWindow = bars.slice(i - (SL_LOOKBACK - 1), i + 1);
    const sl = Math.min(...slWindow.map(b => b.low));
    if (!(sl < entry)) continue;
    const stopDistPct = (entry - sl) / entry;
    if (stopDistPct * 100 > RC2_MAX_RISK_PCT) continue;

    const risk = entry - sl;
    const firstTarget = entry + PARTIAL_TP1_R * risk; // +1.5R free-roll level

    // ── EXIT walk-forward — free-roll(1.5R) + Chandelier + time/fast-kill. ──
    let exitDate = bars[bars.length - 1].date;
    let exitReason: ExitReason = "OPEN";

    let reachedFirstTarget = false;
    let leg1FreeRolled = false;
    let leg1ExitPrice = entry;
    let leg2ExitPrice = entry;

    let currentStop = sl;
    let highestHigh = bars[i].high;
    let trailStop = -Infinity;
    let maxHighR = 0; // max favorable excursion in R from bar HIGH (pre-free-roll), for fast-kill + MFE report

    for (let j = i + 1; j < bars.length; j++) {
      const bar = bars[j];
      const heldBars = j - i;

      if (!reachedFirstTarget) {
        // PHASE 1: full size, stop at initial SL.
        // SL-FIRST-ON-TIE (strict): if low<=stop this bar, the STOP fills even if
        // high>=firstTarget on the same bar — do NOT credit the +1.5R bank.
        if (bar.low <= currentStop) {
          exitReason = "SL"; exitDate = bar.date;
          leg1ExitPrice = currentStop;
          break;
        }
        // free-roll only banks if the target was hit AND the stop was NOT breached.
        if (bar.high >= firstTarget) {
          reachedFirstTarget = true;
          leg1FreeRolled = true;
          currentStop = entry; // breakeven on residual
          highestHigh = Math.max(highestHigh, bar.high);
          const excursionR = risk > 0 ? (bar.high - entry) / risk : 0;
          if (excursionR > maxHighR) maxHighR = excursionR;
          const atr = computeAtr14Local(bars.slice(0, j + 1));
          trailStop = (atr != null && atr > 0)
            ? Math.max(currentStop, highestHigh - CHANDELIER_ATR_MULT * atr)
            : currentStop;
          currentStop = trailStop;
          continue;
        }

        // track MFE in R for the v4 fast-kill (favorable daily high only).
        const excursionR = risk > 0 ? (bar.high - entry) / risk : 0;
        if (excursionR > maxHighR) maxHighR = excursionR;

        // ── v4-Hybrid [C] FAST KILL — at +4 bars, maxHighR<1.0R & not free-rolled. ──
        if (config === "V4_HYBRID" && heldBars >= FAST_KILL_BARS && maxHighR < FAST_KILL_MFE_R) {
          exitReason = "FAST_TIME"; exitDate = bar.date;
          leg1ExitPrice = bar.close;
          break;
        }

        // ── Genesis-TRUE / v4-Master generous 20-bar backstop (pre-free-roll only). ──
        if ((config === "GENESIS_TRUE" || config === "V4_MASTER") && heldBars >= GENESIS_TIME_STOP_BARS) {
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
        const excursionR = risk > 0 ? (bar.high - entry) / risk : 0;
        if (excursionR > maxHighR) maxHighR = excursionR;
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
      maxHighR: Math.round(maxHighR * 100) / 100,
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PORTFOLIO SIM — CONVICTION-RANKED auction (copied from elzaV1Genesis.ts).
// ════════════════════════════════════════════════════════════════════════════

interface OpenPos {
  ticker: string; sector: string; notional: number; riskDollars: number;
  pnl: number; exitDate: string; candIdx: number;
}
interface ClosedTrade {
  ticker: string; entryDate: string; exitDate: string; exitReason: ExitReason;
  r: number; pnl: number; skipped: boolean; maxHighR: number;
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

function runPortfolio(
  windowCands: Candidate[],
  friction: FrictionMode,
  windowLabel: string,
  rOfOverride?: (c: Candidate) => number,
): CellResult & { closed: ClosedTrade[] } {
  const rOf = rOfOverride ?? ((c: Candidate): number => computeTradeR(c, friction));

  const dates = new Set<string>();
  windowCands.forEach(c => { dates.add(c.entryDate); dates.add(c.exitDate); });
  const sortedDates = [...dates].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

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
    // ── (a) EXITS first. ──
    for (const [idx, pos] of [...openByIdx.entries()]) {
      if (pos.exitDate !== day) continue;
      openByIdx.delete(idx);
      openTickers.delete(pos.ticker);
      equity += pos.pnl;
      const c = windowCands[idx];
      closed.push({
        ticker: c.ticker, entryDate: c.entryDate, exitDate: c.exitDate,
        exitReason: c.exitReason, r: rOf(c), pnl: pos.pnl, skipped: false,
        maxHighR: c.maxHighR,
      });
      if (equity > peakEquity) peakEquity = equity;
      const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }

    // ── (b) ENTRY auction — highest totalScore fills the free slots (NOT FIFO). ──
    const todays = (candsByEntryDate.get(day) ?? [])
      .slice()
      .sort((a, b) => {
        if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
        return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
      });

    for (const c of todays) {
      const idx = (c as any).__idx as number;
      if (openByIdx.size >= MAX_CONCURRENT) break;
      if (openTickers.has(c.ticker)) continue;
      if (openCountInSector(c.sector) >= MAX_PER_SECTOR) continue;

      const equityAtEntry = equity;
      let riskDollars = RISK_PCT * equityAtEntry;

      const heatAfter = (grossOpenRisk() + riskDollars) / (equityAtEntry > 0 ? equityAtEntry : 1);
      if (heatAfter > HEAT_CAP) {
        closed.push({
          ticker: c.ticker, entryDate: c.entryDate, exitDate: c.exitDate,
          exitReason: c.exitReason, r: rOf(c), pnl: 0, skipped: true,
          maxHighR: c.maxHighR,
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
    closed,
  };
}

// ─── SPY benchmark (copied from elzaV1Genesis.ts) ──────────────────────────────
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
  console.log(`Elza v4-Hybrid Backtest — TWO configs (Genesis-TRUE vs v4-Hybrid) vs SPY — READ-ONLY (no DB writes, no IBKR, no orders, no SSH)`);

  // ── Resolve the LIVE scan universe (dynamic getCatalogTickers(1) ≈ 148 USA). ──
  const catalog = await getCatalogTickers(1);
  for (const a of catalog) SECTOR_BY_TICKER[a.ticker] = a.sector;
  const TICKERS: string[] = catalog.map(a => a.ticker);
  console.log("[CATALOG] live universe: " + TICKERS.length + " USA tickers (uid=1, US-only, non-IPO) — expected ~148 (catalog parity).");

  console.log(`Scoring: FRESH genesisScore (NOT calcZivEngineScore). LONG-ONLY.`);
  console.log(`ENTRY GATES (TRUE v1.0): totalScore >= ${LONG_ENTRY_MIN_SCORE} AND confluenceScore >= ${MIN_CONFLUENCE} AND liquidityScore >= ${MIN_LIQUIDITY_SCORE}.`);
  console.log(`  (confluence/liquidity via getTickerIntelligence(bars.slice(0,i+1)) — REAL, causal, daily-bar-only.)`);
  console.log(`Tiers: Gold Retest 7/8 | Gold Breakout 9/10 | Breakout Override 6. +1 base on bullish PA. Sub-scores capped at +0.99.`);
  console.log(`RANKING (headline): per-day conviction auction — highest totalScore fills the ${MAX_CONCURRENT} slots (NOT FIFO).`);
  console.log(`CONFIG 1 — Genesis-TRUE : faithful v1.0; ${GENESIS_TIME_STOP_BARS}-bar pre-free-roll backstop (NO fast-kill, NO shallow-focus).`);
  console.log(`CONFIG 2 — v4-Hybrid    : Genesis-TRUE + [A] shallow-focus (Tier-3 in EMA20→EMA50 band, EMA200-guarded; Tier-4 exempt; Override excluded)`);
  console.log(`                           + [C] fast-kill at +${FAST_KILL_BARS} bars if mfeR<${FAST_KILL_MFE_R}R & not free-rolled (replaces 20-bar backstop).`);
  console.log(`Exit (both): SL=${SL_LOOKBACK}-bar low; RC-2 skip if (entry-SL)/entry>${RC2_MAX_RISK_PCT}%; free-roll bank 50% at +${PARTIAL_TP1_R}R → BE; Chandelier max(prior, highHigh − ${CHANDELIER_ATR_MULT}×ATR${ATR_PERIOD}).`);
  console.log(`PESSIMISM (both): SL-FIRST-ON-TIE strict (stop wins any bar low<=stop & high>=target; +1.5R banks only if high>=TP & low>stop). REALISTIC = 5bps adverse entry & every exit fill + $1/side commission-in-R (headline); FRICTIONLESS for reference.`);
  console.log(`Portfolio (both): $${START_EQUITY.toLocaleString()}, ${RISK_PCT * 100}% risk, leverage ${LEVERAGE}×, maxConcurrent ${MAX_CONCURRENT}, maxPerSector ${MAX_PER_SECTOR}, heat ≤ ${HEAT_CAP * 100}%, maxPos $${MAX_POSITION_USD.toLocaleString()}.`);
  console.log(`Windows: W-CAL2025 = entryDate in [2025-01-01, 2025-12-31] | W-2026 = [2026-01-01, last bar]. SPY buy&hold per window.`);
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

  // ── Fetch each ticker's bars ONCE, then build candidates for BOTH configs. ──
  const barsByTicker = new Map<string, Bar[]>();
  let processed = 0;
  let skippedNoData = 0;
  for (const ticker of TICKERS) {
    processed++;
    if (processed % 20 === 0) {
      console.log(`[PROGRESS-FETCH] ${processed}/${TICKERS.length} tickers fetched.`);
    }
    try {
      let bars = await fetchBarsForTicker(ticker, BARS_DAYS);
      if (!bars || bars.length < MIN_BARS) { skippedNoData++; continue; }
      bars = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const lastDate = bars[bars.length - 1].date;
      if (lastDate < EARLIEST_WINDOW_START) { skippedNoData++; continue; }
      const warmupBefore = bars.filter(b => b.date < EARLIEST_WINDOW_START).length;
      if (warmupBefore < MIN_BARS) { skippedNoData++; continue; }
      barsByTicker.set(ticker, bars);
    } catch (e) {
      console.log(`[WARN] ${ticker}: ${(e as Error).message ?? e}. Skipping ticker.`);
      continue;
    }
  }
  const usableTickers = [...barsByTicker.keys()];
  console.log(`[FETCH DONE] ${usableTickers.length} usable tickers (${skippedNoData} skipped).`);

  // Build candidates per config (reusing the same bars; no re-fetch).
  const candsByConfig = new Map<ConfigId, Candidate[]>();
  for (const config of CONFIGS) {
    const cands: Candidate[] = [];
    let n = 0;
    for (const ticker of usableTickers) {
      n++;
      if (n % 20 === 0) {
        console.log(`[PROGRESS-${configLabel(config)}] ${n}/${usableTickers.length} tickers scored (${cands.length} candidates so far).`);
      }
      await generateCandidates(ticker, barsByTicker.get(ticker)!, config, cands);
    }
    candsByConfig.set(config, cands);
    console.log(`[DONE BUILDING ${configLabel(config)}] ${cands.length} candidates.`);
  }

  // SPY per window.
  const spyByWindow = new Map<string, SpyResult | null>();
  for (const w of WINDOWS) {
    spyByWindow.set(w.label, computeSpyBenchmark(w.label, spyBars, w.start, w.end));
  }

  // ── Run + report: the matrix (CONFIG × WINDOW) + SPY row + head-to-head verdict. ──
  for (const w of WINDOWS) {
    const spy = spyByWindow.get(w.label) ?? null;

    // Run both configs (REALISTIC headline + FRICTIONLESS reference).
    const results: Record<ConfigId, { real: CellResult; fric: CellResult; cands: number }> = {} as any;
    for (const config of CONFIGS) {
      const wc = candsForWindow(candsByConfig.get(config)!, w.start, w.end);
      results[config] = {
        real: runPortfolio(wc, "REALISTIC", w.label),
        fric: runPortfolio(wc, "FRICTIONLESS", w.label),
        cands: wc.length,
      };
    }

    console.log("");
    console.log(`══════════════════════════════════════════════════════════════════════════════════════════`);
    console.log(`═══ ${w.label} — MATRIX (CONFIG × WINDOW) — REALISTIC headline (LONG only, SHORTS OMITTED) ═══`);
    console.log(`══════════════════════════════════════════════════════════════════════════════════════════`);

    // Matrix header.
    console.log(`  ${pad("config", 16)}${padL("trades", 9)}${padL("win%", 9)}${padL("totalR", 10)}${padL("ret%REAL", 11)}${padL("ret%FRIC", 11)}${padL("maxDD%", 10)}`);
    console.log(`  ${"─".repeat(76)}`);
    for (const config of CONFIGS) {
      const r = results[config].real;
      const f = results[config].fric;
      console.log(`  ${pad(configLabel(config), 16)}` +
        `${padL(r.tradesTaken, 9)}` +
        `${padL(r.winPct.toFixed(1) + "%", 9)}` +
        `${padL(sign(r.totalR) + r.totalR.toFixed(2), 10)}` +
        `${padL(sign(r.finalReturnPct) + r.finalReturnPct.toFixed(2) + "%", 11)}` +
        `${padL(sign(f.finalReturnPct) + f.finalReturnPct.toFixed(2) + "%", 11)}` +
        `${padL(r.maxDrawdownPct.toFixed(2) + "%", 10)}`);
    }
    // SPY row.
    if (spy) {
      console.log(`  ${pad("SPY buy&hold", 16)}` +
        `${padL("—", 9)}${padL("—", 9)}${padL("—", 10)}` +
        `${padL(sign(spy.returnPct) + spy.returnPct.toFixed(2) + "%", 11)}` +
        `${padL(sign(spy.returnPct) + spy.returnPct.toFixed(2) + "%", 11)}` +
        `${padL(spy.maxDDPct.toFixed(2) + "%", 10)}`);
    } else {
      console.log(`  ${pad("SPY buy&hold", 16)}${padL("[no SPY data in window]", 50)}`);
    }

    // candidates-in-window line per config.
    console.log("");
    for (const config of CONFIGS) {
      console.log(`  candidates-in-window [${configLabel(config)}]: ${results[config].cands}`);
    }

    // Exit-reason breakdown per config (REALISTIC book).
    console.log("");
    console.log(`  ── exit-reason breakdown (REALISTIC book) ──`);
    for (const config of CONFIGS) {
      const eb = results[config].real.exitBreakdown;
      console.log(`     [${configLabel(config)}]  SL=${eb["SL"] ?? 0}  TIME(20bar)=${eb["TIME"] ?? 0}  FAST_TIME(+4)=${eb["FAST_TIME"] ?? 0}  TRAIL=${eb["TRAIL"] ?? 0}  TRAIL_OPEN=${eb["TRAIL_OPEN"] ?? 0}  OPEN=${eb["OPEN"] ?? 0}`);
    }

    // ── HEAD-TO-HEAD verdict (REALISTIC vs SPY). ──
    console.log("");
    console.log(`  ── HEAD-TO-HEAD verdict (REALISTIC) — Genesis-TRUE vs v4-Hybrid vs SPY ──`);
    const gReal = results["GENESIS_TRUE"].real.finalReturnPct;
    const vReal = results["V4_HYBRID"].real.finalReturnPct;
    const spyRet = spy ? spy.returnPct : null;

    if (spyRet == null) {
      console.log(`     [SKIP] No SPY bars in window → SPY comparison INDETERMINATE.`);
      const bestStrat = vReal >= gReal ? "v4-Hybrid" : "Genesis-TRUE";
      console.log(`     winner (strategies only) = ${bestStrat} (Genesis-TRUE ${sign(gReal)}${gReal.toFixed(2)}% vs v4-Hybrid ${sign(vReal)}${vReal.toFixed(2)}%).`);
    } else {
      const contenders: Array<{ name: string; ret: number }> = [
        { name: "Genesis-TRUE", ret: gReal },
        { name: "v4-Hybrid",    ret: vReal },
        { name: "SPY",          ret: spyRet },
      ];
      contenders.sort((a, b) => b.ret - a.ret);
      const winner = contenders[0].name;
      const v4BeatsSpy = vReal >= spyRet;
      console.log(`     Genesis-TRUE ${sign(gReal)}${gReal.toFixed(2)}%  |  v4-Hybrid ${sign(vReal)}${vReal.toFixed(2)}%  |  SPY ${sign(spyRet)}${spyRet.toFixed(2)}%`);
      console.log(`     winner = ${winner}`);
      console.log(`     does v4-Hybrid BEAT SPY (realistic)? ${v4BeatsSpy ? "YES" : "NO"} ` +
        `(v4-Hybrid ${sign(vReal)}${vReal.toFixed(2)}% vs SPY ${sign(spyRet)}${spyRet.toFixed(2)}%, diff ${sign(vReal - spyRet)}${(vReal - spyRet).toFixed(2)} pts).`);
    }

    // Machine-readable line.
    console.log(`[JSON] ${JSON.stringify({
      window: w.label,
      genesisTrue: {
        candidates: results["GENESIS_TRUE"].cands,
        realistic: {
          trades: results["GENESIS_TRUE"].real.tradesTaken,
          winPct: Math.round(results["GENESIS_TRUE"].real.winPct * 10) / 10,
          totalR: results["GENESIS_TRUE"].real.totalR,
          returnPct: Math.round(gReal * 100) / 100,
          maxDDPct: Math.round(results["GENESIS_TRUE"].real.maxDrawdownPct * 100) / 100,
          exitBreakdown: results["GENESIS_TRUE"].real.exitBreakdown,
        },
        frictionlessReturnPct: Math.round(results["GENESIS_TRUE"].fric.finalReturnPct * 100) / 100,
      },
      v4Hybrid: {
        candidates: results["V4_HYBRID"].cands,
        realistic: {
          trades: results["V4_HYBRID"].real.tradesTaken,
          winPct: Math.round(results["V4_HYBRID"].real.winPct * 10) / 10,
          totalR: results["V4_HYBRID"].real.totalR,
          returnPct: Math.round(vReal * 100) / 100,
          maxDDPct: Math.round(results["V4_HYBRID"].real.maxDrawdownPct * 100) / 100,
          exitBreakdown: results["V4_HYBRID"].real.exitBreakdown,
        },
        frictionlessReturnPct: Math.round(results["V4_HYBRID"].fric.finalReturnPct * 100) / 100,
      },
      spy: spy ? { returnPct: Math.round(spy.returnPct * 100) / 100, maxDDPct: Math.round(spy.maxDDPct * 100) / 100 } : null,
    })}`);
  }

  console.log("");
  console.log(`[CATALOG PARITY] live universe = ${TICKERS.length} USA tickers (expected ~148).`);

  printDisclaimer();

  console.log("");
  console.log(`Done. ${CONFIGS.length} configs × ${WINDOWS.length} windows × 2 friction modes. (Simulation only — no live actions taken.)`);
}

function printDisclaimer(): void {
  console.log("");
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`SIMPLIFICATIONS / DISCLAIMER — read before trusting any number above`);
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`  • SHORTS OMITTED: LONG side only. The live regime/breadth short-gate is not reproduced offline.`);
  console.log(`  • FRESH SCORING: genesisScore is implemented from the v1.0 spec, NOT the live v2.2 engine.`);
  console.log(`    True-Retest/Role-Reversal structure is approximated by the spec's |Δ EMA50|<=3% proximity test.`);
  console.log(`  • ENTRY GATE: TRUE v1.0 floor = totalScore>=7.0 (NOT 7.5) AND confluence>=4.5 AND liquidity>=2.0.`);
  console.log(`    Confluence/liquidity come from getTickerIntelligence(bars.slice(0,i+1)) — daily-bar-only & causal.`);
  console.log(`  • CONVICTION AUCTION is a per-CALENDAR-DAY ranking on totalScore; intraday entry timing is not modelled.`);
  console.log(`  • DAILY-BAR TRAIL OVERSTATES: +1.5R tag and Chandelier use DAILY highs/lows; trail runs are OVERSTATED.`);
  console.log(`  • FRICTION IS APPROXIMATE: 5bps flat haircut on entry + each exit fill; commission-in-R at the BASELINE`);
  console.log(`    1%-risk full size (implied shares), NOT post-cap size. REALISTIC is a FLOOR on cost.`);
  console.log(`  • SL-FIRST-ON-TIE (strict): any bar with low<=stop & high>=target fills the STOP, never the take-profit.`);
  console.log(`  • THIN 2025 WARMUP: fetchBarsForTicker(..,420) reaches ~2024-10; early-2025 entries open on ~50 warmup bars.`);
  console.log("");
  console.log(`  ── OMISSIONS (noted per spec) ──`);
  console.log(`  • MAX_CORRELATION 0.80 pairwise gate is NOT reproduced (not feasible offline). The per-sector cap (≤3)`);
  console.log(`    is the partial proxy for correlation clustering.`);
  console.log(`  • MENTOR BOOST +0..2.0 is OMITTED (needs live pattern data). Scores here are CONSERVATIVE / LOWER than live,`);
  console.log(`    so the 7.0 floor is harder to clear than it would be live — these results UNDER-count entries.`);
}

export type {
  Candidate,
  ClosedTrade,
  ConfigId,
  ExitReason,
  FrictionMode,
};
export {
  BARS_DAYS,
  EARLIEST_WINDOW_START,
  MIN_BARS,
  SECTOR_BY_TICKER,
  WINDOWS,
  computeTradeR,
  generateCandidates,
  getCatalogTickers,
  runPortfolio,
  candsForWindow,
};

const isDirectRun = process.argv[1]?.includes("elzaV4Hybrid");
if (isDirectRun) {
  main().catch(err => {
    console.error(`[FATAL] ${(err as Error).stack ?? err}`);
    process.exit(1);
  });
}
