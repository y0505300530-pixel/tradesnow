/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  elzaV41ParabolicLock.ts — Elza v4.1 "Parabolic Lock" : LONG-ONLY vs SPY.  ║
 * ║                                                                            ║
 * ║  PURE SIMULATION. NO DB writes. NO IBKR. NO orders. NO deploy. NO SSH.     ║
 * ║                                                                            ║
 * ║  ENTRY (IDENTICAL to elzaV41Improved.ts — Genesis-TRUE v1.0):             ║
 * ║    genesisScore (8 sub-scores, cap +0.99, base up to 10);                  ║
 * ║    gate = totalScore >= 7.0 AND confluence >= 4.5 AND liquidity >= 2.0     ║
 * ║    (getTickerIntelligence(ticker, bars.slice(0,i+1)) — REAL & CAUSAL);     ║
 * ║    EMA-200 macro guards baked into tiers; RC-2 skip if risk > 12%;         ║
 * ║    SL = 10-bar low; NO fast-kill; conviction-ranked 12-slot fill;          ║
 * ║    149 catalog (getCatalogTickers(1)).                                     ║
 * ║                                                                            ║
 * ║  EXIT = THE PARABOLIC LOCK (3-stage; replaces single free-roll+chandelier):║
 * ║    R = entry − initialSL.                                                  ║
 * ║    Stage 1 @ +1.5R: bank 50% (realized 0.5×1.5R = +0.75R). Stop on the     ║
 * ║      remaining 50% → BREAKEVEN.                                            ║
 * ║    Stage 2 @ +3.0R: bank 50% of the REMAINING (= 25% of original;          ║
 * ║      realized 0.25×3.0R = +0.75R).                                         ║
 * ║    Stage 3 (last 25%): TIGHT Chandelier = max(priorTrail, highHigh −       ║
 * ║      1.5×ATR14). Exits when low<=trail; contribution 0.25×(exit−entry)/R.  ║
 * ║    Pre-Stage-1 full stop = −1R. SL-FIRST-ON-TIE strict at EVERY stage.     ║
 * ║    If stopped between stages, the then-open fraction realizes at the stop. ║
 * ║    60-bar backstop only.                                                   ║
 * ║                                                                            ║
 * ║  WINDOW: CALENDAR 2025 ONLY = entryDate in [2025-01-01, 2025-12-31].       ║
 * ║  FRICTION REALISTIC (5bps adverse entry + each exit fill + $1/side) = head. ║
 * ║                                                                            ║
 * ║  PORTFOLIO — TWO honest leverage modes:                                    ║
 * ║    1.0× (clean alpha): 1% risk/trade.                                      ║
 * ║    1.9× (CEO margin — HONEST, not cosmetic): 1.9% risk/trade. Amplifies    ║
 * ║      returns AND drawdown; each −1R loser becomes −1.9R. marginCallFlag if  ║
 * ║      the 1.9× equity ever draws down >40% peak-to-trough.                   ║
 * ║                                                                            ║
 * ║  FLIGHT RECORDER (mandatory): per-trade log                                ║
 * ║    Ticker | EntryDate | ExitDate | MFE_R | FinalNetR(1.0×) | ExitReason     ║
 * ║    to stdout AND /tmp/elza-v41-parabolic-2025-tradelog.md.                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * RUN (manager runs this on the droplet — has Yahoo/DB data; 149 tickers is slow):
 *   node --import tsx --env-file=.env scripts/elzaV41ParabolicLock.ts
 *
 * BUILD-CHECK (local, no run):
 *   npx esbuild scripts/elzaV41ParabolicLock.ts --bundle --platform=node --packages=external --outdir=/tmp/plbc
 *
 * Scoring / dynamic-catalog / conviction-ranking / SPY are faithful copies of
 * scripts/elzaV41Improved.ts. Only the EXIT engine (3-stage Parabolic Lock), the
 * window (CALENDAR 2025), and the portfolio (dual-leverage) differ. No P&L/price
 * formula is re-implemented — calcEMA/calcRSI/Bar (server/zivEngine.ts) and
 * getTickerIntelligence (server/runtimeIntelligence.ts) are reused.
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";
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
 * US-only + non-IPO_INCUBATOR filter. dynamic getCatalogTickers(1) ≈ 149 USA.
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
const BARS_DAYS = 600;               // need 2024 warmup + all of calendar-2025
const MIN_BARS = 50;                 // need a stable EMA50/trend history before scoring

const SL_LOOKBACK = 10;              // structural SL = min(low) over last 10 bars (i-9..i)
const RC2_MAX_RISK_PCT = 12;         // RC-2 guard: skip entry if (entry-SL)/entry > 12%

// ── TRUE v1.0 ENTRY GATES (Genesis-TRUE — identical to elzaV41Improved). ──
const LONG_ENTRY_MIN_SCORE = 7.0;    // authoritative v1.0 floor
const MIN_CONFLUENCE        = 4.5;   // v1.0 gated on confluenceScore >= 4.5
const MIN_LIQUIDITY_SCORE   = 2.0;   // v1.0 gated on liquidityScore  >= 2.0

// ── PARABOLIC LOCK EXIT (3-stage) ──
const STAGE1_R          = 1.5;       // Stage 1 trigger: +1.5R
const STAGE1_BANK_FRAC  = 0.50;      // bank 50% of original at Stage 1
const STAGE2_R          = 3.0;       // Stage 2 trigger: +3.0R
const STAGE2_BANK_FRAC  = 0.25;      // bank 50% of remaining = 25% of original at Stage 2
const STAGE3_FRAC       = 0.25;      // last 25% trails on the tight Chandelier
const CHANDELIER_ATR_MULT = 1.5;     // TIGHT trail = peakHigh − 1.5×ATR14 (tightened from 2.5)
const ATR_PERIOD = 14;

// ── TIME-STOP: generous 60-bar backstop ONLY (pre-Stage-1). NO FAST-KILL. ──
const GENESIS_TIME_STOP_BARS = 60;

// ─── EMA / Donchian periods ───────────────────────────────────────────────────
const EMA_20 = 20;
const EMA_50 = 50;
const EMA_200 = 200;
const DONCHIAN_PERIOD = 20;

// ─── Portfolio sizing parameters ──────────────────────────────────────────────
const START_EQUITY = 100_000;
const HEAT_CAP = 0.20;
const MAX_POSITION_USD = 85_000;
const MAX_CONCURRENT = 12;            // 12 LONG slots
const MAX_PER_SECTOR = 3;

// ── DUAL LEVERAGE (honest) ──
//   1.0× clean alpha = 1% risk/trade, headroom = 1.0×equity.
//   1.9× CEO margin  = 1.9% risk/trade, headroom = 1.9×equity. Each −1R → −1.9R.
interface LeverageMode { label: string; leverage: number; riskPct: number; }
const LEV_1X: LeverageMode  = { label: "1.0x", leverage: 1.0, riskPct: 0.01 };
const LEV_19X: LeverageMode = { label: "1.9x", leverage: 1.9, riskPct: 0.019 };
const MARGIN_CALL_DD = 0.40;         // 1.9× peak-to-trough >40% → marginCallFlag

// ─── Friction model (REALISTIC is the headline) ───────────────────────────────
const SLIPPAGE_BPS = 0.0005;         // 5 bps adverse on entry AND every exit fill
const COMMISSION_PER_SIDE = 1.0;     // flat $1/side on the implied (baseline-size) share count

// ─── Window: CALENDAR 2025 ONLY ───────────────────────────────────────────────
interface WindowDef { label: string; start: string; end: string; }
const WINDOW: WindowDef = { label: "CY-2025", start: "2025-01-01", end: "2025-12-31" };
const EARLIEST_WINDOW_START = WINDOW.start;

const TRADELOG_PATH = "/tmp/elza-v41-parabolic-2025-tradelog.md";

type FrictionMode = "FRICTIONLESS" | "REALISTIC";

// ════════════════════════════════════════════════════════════════════════════
// GENESIS SCORING — copied verbatim from elzaV41Improved.ts (v1.0 spec).
// ════════════════════════════════════════════════════════════════════════════

interface GenesisScore {
  tier: "Gold Retest" | "Gold Breakout" | "Breakout Override" | null;
  baseScore: number;
  subScore: number;     // capped at +0.99
  totalScore: number;   // base + subScore
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

  // Tier 4 — Gold Breakout: base 9 (or 10 if Bullish PA). price>=Donchian20H*0.995 & >EMA50 & >EMA200.
  if (price >= donchian20High * 0.995 && price > ema50 && price > ema200) {
    tier = "Gold Breakout";
    baseScore = bullishPA ? 10 : 9;
    isBreakoutTier = true;
  }
  // Tier 3 — Gold Retest: base 7 (or 8 if Bullish PA). price>EMA200 & weeklyEma50Slope>0 & |Δ EMA50|<=3%.
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
// The forward exit walk is the 3-STAGE PARABOLIC LOCK, NO fast-kill, 60-bar backstop.
// Friction is applied later per-mode from the recorded fill LEVELS & fractions.
// ════════════════════════════════════════════════════════════════════════════

type ExitReason =
  | "SL"          // full stop pre-Stage-1 (−1R)
  | "TIME"        // 60-bar backstop (pre-Stage-1)
  | "STOP_S1"     // breakeven stop hit after Stage 1 (before Stage 2)
  | "TRAIL"       // tight Chandelier on the last 25% (Stage 3 active)
  | "TRAIL_OPEN"  // Stage 3 still open at last bar → mark at close
  | "OPEN";       // never advanced past Stage 1 and ran out of bars → mark at close

interface Candidate {
  ticker: string;
  sector: string;
  entryDate: string;
  exitDate: string;
  tier: string;
  totalScore: number;        // conviction rank key
  entry: number;
  sl: number;                // initial SL = 10-bar low. R = entry − sl.
  exitReason: ExitReason;

  // Stage flags + the EXIT LEVEL for each banked/open fraction.
  stage1Banked: boolean;     // +1.5R reached (banked 50% @ firstTarget)
  stage2Banked: boolean;     // +3.0R reached (banked 25% @ secondTarget)
  firstTarget: number;       // +1.5R price (Stage-1 bank level)
  secondTarget: number;      // +3.0R price (Stage-2 bank level)
  // Exit level for whatever fraction was OPEN when the trade closed:
  //   pre-Stage1   → openFrac=1.00 exits at openExitPrice (SL/TIME/OPEN)
  //   post-Stage1  → openFrac=0.50 exits at openExitPrice (STOP_S1 = breakeven)
  //   post-Stage2  → openFrac=0.25 exits at openExitPrice (TRAIL/TRAIL_OPEN)
  openFrac: number;
  openExitPrice: number;

  stopDistPct: number;       // (entry - sl) / entry
  mfeR: number;              // FLIGHT RECORDER — max favorable excursion in R over WHOLE trade
}

/**
 * Aggregate the trade into a single net R for the whole position, given a friction
 * mode. Realized contributions are weighted by the ORIGINAL-position fraction each
 * leg represents, so each leg's R is on the SAME entry-risk denominator (R).
 *
 *   Stage 1 (50%): +0.5 × 1.5R                          (banked at firstTarget)
 *   Stage 2 (25%): +0.25 × 3.0R                          (banked at secondTarget)
 *   open fraction: openFrac × (openExitPrice − entry)/R  (SL/BE/trail/close)
 *
 * REALISTIC applies 5bps adverse on the entry fill AND on every exit fill, plus a
 * $1/side commission converted to R at the BASELINE 1%-risk full size. Commission
 * sides = 1 entry + (number of distinct exit fills actually taken).
 */
function computeTradeR(c: Candidate, friction: FrictionMode): number {
  const real = friction === "REALISTIC";
  const entryFill = real ? c.entry * (1 + SLIPPAGE_BPS) : c.entry;
  const risk = entryFill - c.sl;
  if (!(risk > 0)) return 0;

  // exit-fill helper (5bps adverse on sells = fill LOWER).
  const sell = (px: number): number => (real ? px * (1 - SLIPPAGE_BPS) : px);

  let r = 0;
  let exitSides = 0;

  // Stage 1 banked 50% @ firstTarget.
  if (c.stage1Banked) {
    const f1 = sell(c.firstTarget);
    r += STAGE1_BANK_FRAC * ((f1 - entryFill) / risk);
    exitSides += 1;
  }
  // Stage 2 banked 25% @ secondTarget.
  if (c.stage2Banked) {
    const f2 = sell(c.secondTarget);
    r += STAGE2_BANK_FRAC * ((f2 - entryFill) / risk);
    exitSides += 1;
  }
  // Whatever fraction was OPEN at close exits at openExitPrice.
  if (c.openFrac > 0) {
    const fo = sell(c.openExitPrice);
    r += c.openFrac * ((fo - entryFill) / risk);
    exitSides += 1;
  }

  if (real) {
    const riskPerShare = entryFill - c.sl;
    const sharesFull = (LEV_1X.riskPct * START_EQUITY) / riskPerShare; // baseline implied shares
    const commR_perSide = sharesFull > 0 ? COMMISSION_PER_SIDE / (sharesFull * riskPerShare) : 0;
    const sides = 1 /* entry */ + exitSides;
    r -= sides * commR_perSide;
  }

  return Math.round(r * 100) / 100;
}

/**
 * Walk ONE ticker's bars, emit a Candidate per qualifying bar.
 * Entry gates: totalScore>=7.0, confluence>=4.5, liquidity>=2.0, RC-2 (<=12%).
 *
 * EXIT = 3-STAGE PARABOLIC LOCK. SL-FIRST-ON-TIE strict at EVERY stage:
 *   • Pre-Stage1 (full size, stop=initial SL = −1R): if low<=stop → STOP fills even
 *     if high>=firstTarget the same bar (do NOT bank +1.5R). Else if high>=firstTarget
 *     → Stage 1: bank 50% @ firstTarget, move stop on remaining 50% to BREAKEVEN.
 *   • Post-Stage1 (50% open, stop=breakeven): if low<=BE → STOP_S1 fills the 50%
 *     even if high>=secondTarget the same bar (do NOT bank +3.0R). Else if
 *     high>=secondTarget → Stage 2: bank 50% of remaining (=25% original) @ secondTarget;
 *     begin TIGHT Chandelier on last 25%.
 *   • Post-Stage2 (25% open): tight Chandelier max(prior, highHigh − 1.5×ATR14). If
 *     low<=trail → TRAIL fills the 25% at the trail.
 *   • 60-bar backstop applies pre-Stage1 only; residual legs trail with no time-stop.
 *
 * MFE_R (FLIGHT RECORDER): running max of (barHigh − entry)/R over the WHOLE held window.
 */
async function generateCandidates(
  ticker: string,
  bars: Bar[],
  out: Candidate[],
): Promise<void> {
  let i = 0;
  while (i < bars.length && bars[i].date < EARLIEST_WINDOW_START) i++;

  for (; i < bars.length; i++) {
    if (i + 1 < MIN_BARS) continue;
    if (i + 1 < SL_LOOKBACK) continue;
    // CALENDAR-2025: only entries whose entry bar is within the window.
    if (bars[i].date > WINDOW.end) break;

    const gs = genesisScore(bars, i);
    if (gs.tier === null) continue;

    // ── ENTRY GATE 1 — TRUE v1.0 score floor. ──
    if (!(gs.totalScore >= LONG_ENTRY_MIN_SCORE)) continue;

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
    const firstTarget = entry + STAGE1_R * risk;  // +1.5R
    const secondTarget = entry + STAGE2_R * risk; // +3.0R

    // ── EXIT walk-forward — 3-stage parabolic lock + 60-bar backstop. ──
    let exitDate = bars[bars.length - 1].date;
    let exitReason: ExitReason = "OPEN";

    let stage1Banked = false;
    let stage2Banked = false;
    let openFrac = 1.0;          // fraction of ORIGINAL position still open
    let openExitPrice = entry;

    let currentStop = sl;        // pre-Stage1 stop = initial SL (−1R)
    let highestHigh = bars[i].high;
    let trailStop = -Infinity;
    let mfeR = 0;
    let closedOut = false;

    for (let j = i + 1; j < bars.length; j++) {
      const bar = bars[j];
      const heldBars = j - i;

      const excursionR = risk > 0 ? (bar.high - entry) / risk : 0;
      if (excursionR > mfeR) mfeR = excursionR;

      if (!stage1Banked) {
        // PHASE 1: full size, stop at initial SL (−1R). SL-FIRST-ON-TIE strict.
        if (bar.low <= currentStop) {
          exitReason = "SL"; exitDate = bar.date;
          openFrac = 1.0; openExitPrice = currentStop; closedOut = true;
          break;
        }
        if (bar.high >= firstTarget) {
          // Stage 1: bank 50% @ firstTarget; move stop on remaining 50% to BREAKEVEN.
          stage1Banked = true;
          openFrac = 0.5;
          currentStop = entry; // breakeven
          highestHigh = Math.max(highestHigh, bar.high);
          // NOTE: do NOT start the tight Chandelier until Stage 2 (last 25%).
          continue;
        }
        if (heldBars >= GENESIS_TIME_STOP_BARS) {
          exitReason = "TIME"; exitDate = bar.date;
          openFrac = 1.0; openExitPrice = bar.close; closedOut = true;
          break;
        }
        if (j === bars.length - 1) {
          exitReason = "OPEN"; exitDate = bar.date;
          openFrac = 1.0; openExitPrice = bar.close; closedOut = true;
        }
      } else if (!stage2Banked) {
        // PHASE 2: 50% open, stop=breakeven. SL-FIRST-ON-TIE strict.
        if (bar.low <= currentStop) {
          exitReason = "STOP_S1"; exitDate = bar.date;
          openFrac = 0.5; openExitPrice = currentStop; closedOut = true;
          break;
        }
        if (bar.high >= secondTarget) {
          // Stage 2: bank 50% of remaining (=25% original) @ secondTarget;
          // begin tight Chandelier on the last 25%.
          stage2Banked = true;
          openFrac = 0.25;
          highestHigh = Math.max(highestHigh, bar.high);
          const atr = computeAtr14Local(bars.slice(0, j + 1));
          trailStop = (atr != null && atr > 0)
            ? Math.max(entry, highestHigh - CHANDELIER_ATR_MULT * atr)
            : entry;
          currentStop = trailStop;
          continue;
        }
        if (j === bars.length - 1) {
          // Stage 1 banked, Stage 2 never reached; mark remaining 50% at close.
          exitReason = "OPEN"; exitDate = bar.date;
          openFrac = 0.5; openExitPrice = bar.close; closedOut = true;
        }
      } else {
        // PHASE 3: last 25% trails on the TIGHT Chandelier. NO time-stop.
        highestHigh = Math.max(highestHigh, bar.high);
        const atr = computeAtr14Local(bars.slice(0, j + 1));
        if (atr != null && atr > 0) {
          trailStop = Math.max(trailStop, highestHigh - CHANDELIER_ATR_MULT * atr);
        }
        currentStop = trailStop;

        if (bar.low <= currentStop) {
          exitReason = "TRAIL"; exitDate = bar.date;
          openFrac = 0.25; openExitPrice = currentStop; closedOut = true;
          break;
        }
        if (j === bars.length - 1) {
          exitReason = "TRAIL_OPEN"; exitDate = bar.date;
          openFrac = 0.25; openExitPrice = bar.close; closedOut = true;
        }
      }
    }

    // Entry on the very last bar: no forward bar → mark flat OPEN at entry.
    if (i === bars.length - 1 && !closedOut) {
      exitDate = bars[i].date; exitReason = "OPEN";
      stage1Banked = false; stage2Banked = false;
      openFrac = 1.0; openExitPrice = entry;
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
      stage1Banked,
      stage2Banked,
      firstTarget,
      secondTarget,
      openFrac,
      openExitPrice,
      stopDistPct,
      mfeR: Math.round(mfeR * 100) / 100,
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PORTFOLIO SIM — CONVICTION-RANKED auction, parametrised by leverage mode.
// ════════════════════════════════════════════════════════════════════════════

interface OpenPos {
  ticker: string; sector: string; notional: number; riskDollars: number;
  pnl: number; exitDate: string; candIdx: number;
}
interface ClosedTrade {
  ticker: string; entryDate: string; exitDate: string; exitReason: ExitReason;
  r: number; pnl: number; skipped: boolean; mfeR: number;
}
interface CellResult {
  windowLabel: string;
  friction: FrictionMode;
  leverageLabel: string;
  tradesTaken: number;
  wins: number;
  winPct: number;
  totalR: number;
  finalReturnPct: number;
  maxDrawdownPct: number;
  finalEquity: number;
  marginCallFlag: boolean;
  exitBreakdown: Record<string, number>;
  closed: ClosedTrade[];          // FLIGHT RECORDER — taken trades only
}

function runPortfolio(
  windowCands: Candidate[],
  friction: FrictionMode,
  windowLabel: string,
  lev: LeverageMode,
): CellResult {
  const rOf = (c: Candidate): number => computeTradeR(c, friction);

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
  let marginCallFlag = false;

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
        exitReason: c.exitReason, r: rOf(c), pnl: pos.pnl, skipped: false, mfeR: c.mfeR,
      });
      if (equity > peakEquity) peakEquity = equity;
      const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
      if (dd > MARGIN_CALL_DD) marginCallFlag = true;
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
      let riskDollars = lev.riskPct * equityAtEntry;

      const heatAfter = (grossOpenRisk() + riskDollars) / (equityAtEntry > 0 ? equityAtEntry : 1);
      if (heatAfter > HEAT_CAP) {
        closed.push({
          ticker: c.ticker, entryDate: c.entryDate, exitDate: c.exitDate,
          exitReason: c.exitReason, r: rOf(c), pnl: 0, skipped: true, mfeR: c.mfeR,
        });
        continue;
      }

      let notional = riskDollars / c.stopDistPct;
      if (notional > MAX_POSITION_USD) {
        const scale = MAX_POSITION_USD / notional;
        notional *= scale; riskDollars *= scale;
      }
      const headroom = Math.max(0, lev.leverage * equityAtEntry - grossOpenNotional());
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
    leverageLabel: lev.label,
    tradesTaken: taken.length,
    wins,
    winPct: taken.length > 0 ? (wins / taken.length) * 100 : 0,
    totalR: Math.round(totalR * 100) / 100,
    finalReturnPct: ((equity - START_EQUITY) / START_EQUITY) * 100,
    maxDrawdownPct: maxDrawdownPct * 100,
    finalEquity: Math.round(equity),
    marginCallFlag,
    exitBreakdown,
    closed: taken,
  };
}

// ─── SPY benchmark (copied from elzaV41Improved.ts) ───────────────────────────
interface SpyResult { windowLabel: string; returnPct: number; maxDDPct: number; finalEquity: number; }
function computeSpyBenchmark(
  windowLabel: string, spyBars: Bar[], windowStart: string, windowEnd: string,
): SpyResult | null {
  const inWin = spyBars
    .filter(b => b.date >= windowStart && b.date <= windowEnd)
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
    finalEquity: Math.round(lastEq),
  };
}

function candsForWindow(all: Candidate[], start: string, end: string): Candidate[] {
  return all.filter(c => c.entryDate >= start && c.entryDate <= end);
}

// ─── Reporting helpers ────────────────────────────────────────────────────────
function pad(s: string | number, w: number): string {
  const str = String(s); return str.length >= w ? str : str + " ".repeat(w - str.length);
}
function padL(s: string | number, w: number): string {
  const str = String(s); return str.length >= w ? str : " ".repeat(w - str.length) + str;
}
function sign(n: number): string { return n >= 0 ? "+" : ""; }

// ════════════════════════════════════════════════════════════════════════════
// FLIGHT RECORDER — per-trade log (Ticker | EntryDate | ExitDate | MFE_R |
// FinalNetR(1.0×, realistic) | ExitReason), sorted by EntryDate. Printed to stdout
// AND written to /tmp/elza-v41-parabolic-2025-tradelog.md.
// ════════════════════════════════════════════════════════════════════════════
function buildFlightRecorder(realClosed: ClosedTrade[]): { stdout: string; markdown: string } {
  const rows = [...realClosed].sort((a, b) =>
    a.entryDate < b.entryDate ? -1
      : a.entryDate > b.entryDate ? 1
      : (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0),
  );

  // ── stdout fixed-width table. ──
  const head =
    `  ${pad("Ticker", 8)}${pad("EntryDate", 13)}${pad("ExitDate", 13)}` +
    `${padL("MFE_R", 9)}${padL("FinalNetR", 12)}  ExitReason`;
  const sep = `  ${"─".repeat(58)}`;
  const lines = [head, sep];
  for (const t of rows) {
    lines.push(
      `  ${pad(t.ticker, 8)}${pad(t.entryDate, 13)}${pad(t.exitDate, 13)}` +
      `${padL(sign(t.mfeR) + t.mfeR.toFixed(2), 9)}` +
      `${padL(sign(t.r) + t.r.toFixed(2), 12)}  ${t.exitReason}`,
    );
  }
  const stdout = lines.join("\n");

  // ── markdown table for /tmp/elza-v41-parabolic-2025-tradelog.md. ──
  const md: string[] = [];
  md.push(`# Elza v4.1 "Parabolic Lock" — Flight Recorder (per closed trade) — CALENDAR 2025`);
  md.push("");
  md.push(`Generated ${new Date().toISOString()} — READ-ONLY simulation. LONG-ONLY. FinalNetR is the 1.0× REALISTIC net R (after 5bps/side + $1/side commission). MFE_R is daily-bar max favorable excursion in R (overstated vs intraday).`);
  md.push("");
  md.push(`| Ticker | EntryDate | ExitDate | MFE_R | FinalNetR (1.0x) | ExitReason |`);
  md.push(`|--------|-----------|----------|------:|-----------------:|------------|`);
  for (const t of rows) {
    md.push(`| ${t.ticker} | ${t.entryDate} | ${t.exitDate} | ${sign(t.mfeR)}${t.mfeR.toFixed(2)} | ${sign(t.r)}${t.r.toFixed(2)} | ${t.exitReason} |`);
  }
  md.push("");
  md.push(`Total closed trades: ${rows.length}.`);
  const markdown = md.join("\n");

  return { stdout, markdown };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`Elza v4.1 "Parabolic Lock" Backtest — Genesis-TRUE LONG-ONLY, 3-stage parabolic exit, dual-leverage vs SPY — CALENDAR 2025 — READ-ONLY (no DB writes, no IBKR, no orders, no SSH)`);

  // ── Resolve the LIVE scan universe (dynamic getCatalogTickers(1) ≈ 149 USA). ──
  const catalog = await getCatalogTickers(1);
  for (const a of catalog) SECTOR_BY_TICKER[a.ticker] = a.sector;
  const TICKERS: string[] = catalog.map(a => a.ticker);
  console.log("[CATALOG] live universe: " + TICKERS.length + " USA tickers (uid=1, US-only, non-IPO) — expected ~149 (catalog parity).");

  console.log(`Scoring: FRESH genesisScore (NOT calcZivEngineScore). LONG-ONLY — NO SHORT ENGINE.`);
  console.log(`ENTRY GATES (Genesis-TRUE v1.0, UNCHANGED): totalScore >= ${LONG_ENTRY_MIN_SCORE} AND confluenceScore >= ${MIN_CONFLUENCE} AND liquidityScore >= ${MIN_LIQUIDITY_SCORE}.`);
  console.log(`  (confluence/liquidity via getTickerIntelligence(ticker, bars.slice(0,i+1)) — REAL, causal, daily-bar-only.)`);
  console.log(`Tiers: Gold Retest 7/8 | Gold Breakout 9/10 | Breakout Override 6. +1 base on bullish PA. Sub-scores capped at +0.99.`);
  console.log(`RANKING: per-day conviction auction — highest totalScore fills the ${MAX_CONCURRENT} LONG slots (NOT FIFO).`);
  console.log(`EXIT (PARABOLIC LOCK, 3-stage): R=entry−SL(${SL_LOOKBACK}-bar low). Stage1 @+${STAGE1_R}R bank ${STAGE1_BANK_FRAC * 100}% → stop on rest to BREAKEVEN. Stage2 @+${STAGE2_R}R bank ${STAGE2_BANK_FRAC * 100}% of original. Stage3 last ${STAGE3_FRAC * 100}% TIGHT Chandelier max(prior, highHigh − ${CHANDELIER_ATR_MULT}×ATR${ATR_PERIOD}). Pre-Stage1 full stop = −1R.`);
  console.log(`TIME-STOP: NO FAST-KILL. Generous ${GENESIS_TIME_STOP_BARS}-bar backstop (pre-Stage1 only).`);
  console.log(`PESSIMISM: SL-FIRST-ON-TIE strict at EVERY stage (stop wins any bar low<=stop & high>=target). REALISTIC = 5bps adverse entry & every exit fill + $1/side commission-in-R (headline).`);
  console.log(`Portfolio: $${START_EQUITY.toLocaleString()} compounding, maxConcurrent ${MAX_CONCURRENT}, maxPerSector ${MAX_PER_SECTOR}, heat ≤ ${HEAT_CAP * 100}%, maxPos $${MAX_POSITION_USD.toLocaleString()}.`);
  console.log(`  LEVERAGE MODES (honest): 1.0× = ${LEV_1X.riskPct * 100}% risk/trade, headroom 1.0×eq | 1.9× = ${LEV_19X.riskPct * 100}% risk/trade, headroom 1.9×eq (each −1R → −1.9R; marginCallFlag if DD > ${MARGIN_CALL_DD * 100}%).`);
  console.log(`Window: ${WINDOW.label} = entryDate in [${WINDOW.start}, ${WINDOW.end}]. SPY buy&hold calendar-2025.`);
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

  // ── Fetch each ticker's bars ONCE, then build candidates. ──
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

  // Build candidates (single Genesis-TRUE config).
  const cands: Candidate[] = [];
  let n = 0;
  for (const ticker of usableTickers) {
    n++;
    if (n % 20 === 0) {
      console.log(`[PROGRESS-SCORE] ${n}/${usableTickers.length} tickers scored (${cands.length} candidates so far).`);
    }
    await generateCandidates(ticker, barsByTicker.get(ticker)!, cands);
  }
  console.log(`[DONE BUILDING] ${cands.length} candidates (Genesis-TRUE, calendar-2025 entries).`);

  // SPY for calendar-2025.
  const spy = computeSpyBenchmark(WINDOW.label, spyBars, WINDOW.start, WINDOW.end);

  // ── Run calendar-2025: REALISTIC headline, BOTH leverage modes. ──
  const wc = candsForWindow(cands, WINDOW.start, WINDOW.end);
  const real1x  = runPortfolio(wc, "REALISTIC", WINDOW.label, LEV_1X);
  const real19x = runPortfolio(wc, "REALISTIC", WINDOW.label, LEV_19X);
  const fric1x  = runPortfolio(wc, "FRICTIONLESS", WINDOW.label, LEV_1X);

  // ════════════════════════════════════════════════════════════════════════
  // FLIGHT RECORDER — print + write file. (1.0× REALISTIC book; FinalNetR after friction.)
  // ════════════════════════════════════════════════════════════════════════
  const fr = buildFlightRecorder(real1x.closed);
  console.log("");
  console.log(`══════════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`═══ FLIGHT RECORDER — per-trade log (Ticker | EntryDate | ExitDate | MFE_R | FinalNetR[1.0×] | ExitReason) — sorted by EntryDate ═══`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════════`);
  console.log(fr.stdout);
  try {
    writeFileSync(TRADELOG_PATH, fr.markdown, "utf8");
    console.log("");
    console.log(`[FLIGHT RECORDER] wrote ${real1x.closed.length} trades → ${TRADELOG_PATH}`);
  } catch (e) {
    console.log(`[WARN] flight-recorder write failed (${TRADELOG_PATH}): ${(e as Error).message ?? e}`);
  }

  // ── SUMMARY TABLE: rows {1.0×, 1.9×, SPY}, cols trades|win%|totalR|return%|maxDD%|finalEq$. ──
  console.log("");
  console.log(`══════════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`═══ v4.1 Parabolic Lock — CALENDAR 2025 — REALISTIC headline (LONG only) — DUAL LEVERAGE vs SPY ═══`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  candidates-in-window: ${wc.length}`);
  console.log("");
  console.log(
    `  ${pad("strategy", 10)}${padL("trades", 8)}${padL("win%", 9)}${padL("totalR", 10)}` +
    `${padL("return%", 11)}${padL("maxDD%", 10)}${padL("finalEq$", 14)}  flags`,
  );
  console.log(`  ${"─".repeat(82)}`);
  const rowLine = (label: string, r: CellResult): string =>
    `  ${pad(label, 10)}${padL(r.tradesTaken, 8)}${padL(r.winPct.toFixed(1) + "%", 9)}` +
    `${padL(sign(r.totalR) + r.totalR.toFixed(2), 10)}` +
    `${padL(sign(r.finalReturnPct) + r.finalReturnPct.toFixed(2) + "%", 11)}` +
    `${padL(r.maxDrawdownPct.toFixed(2) + "%", 10)}` +
    `${padL("$" + r.finalEquity.toLocaleString(), 14)}` +
    `  ${r.leverageLabel === "1.9x" ? (r.marginCallFlag ? "marginCall=YES" : "marginCall=no") : ""}`;
  console.log(rowLine("1.0x", real1x));
  console.log(rowLine("1.9x", real19x));
  if (spy) {
    console.log(
      `  ${pad("SPY", 10)}${padL("-", 8)}${padL("-", 9)}${padL("-", 10)}` +
      `${padL(sign(spy.returnPct) + spy.returnPct.toFixed(2) + "%", 11)}` +
      `${padL(spy.maxDDPct.toFixed(2) + "%", 10)}` +
      `${padL("$" + spy.finalEquity.toLocaleString(), 14)}  buy&hold`,
    );
  } else {
    console.log(`  ${pad("SPY", 10)}${padL("- (no 2025 bars → INDETERMINATE)", 62)}`);
  }
  console.log("");
  console.log(`  (reference) 1.0× FRICTIONLESS return%: ${sign(fric1x.finalReturnPct)}${fric1x.finalReturnPct.toFixed(2)}%`);

  // ── Exit-reason breakdown (1.0× book) — confirms the 3-stage exit is firing. ──
  console.log("");
  console.log(`  ── exit-reason breakdown (1.0× REALISTIC book) ──`);
  const eb = real1x.exitBreakdown;
  console.log(`     SL=${eb["SL"] ?? 0}  TIME(${GENESIS_TIME_STOP_BARS}bar)=${eb["TIME"] ?? 0}  STOP_S1(BE)=${eb["STOP_S1"] ?? 0}  TRAIL=${eb["TRAIL"] ?? 0}  TRAIL_OPEN=${eb["TRAIL_OPEN"] ?? 0}  OPEN=${eb["OPEN"] ?? 0}`);

  // Catalog parity.
  console.log("");
  console.log(`  [CATALOG PARITY] live universe = ${TICKERS.length} USA tickers (expected ~149).`);

  // ── VERDICTS (per leverage). ──
  console.log("");
  console.log(`  ── VERDICTS ──`);
  if (spy == null) {
    console.log(`     [SKIP] No SPY bars in 2025 window → SPY comparison INDETERMINATE.`);
    console.log(`     v4.1-ParabolicLock @1.0× (realistic) = ${sign(real1x.finalReturnPct)}${real1x.finalReturnPct.toFixed(2)}% at DD ${real1x.maxDrawdownPct.toFixed(2)}%.`);
    console.log(`     v4.1-ParabolicLock @1.9× (realistic) = ${sign(real19x.finalReturnPct)}${real19x.finalReturnPct.toFixed(2)}% at DD ${real19x.maxDrawdownPct.toFixed(2)}% (margin-call risk: ${real19x.marginCallFlag ? "YES" : "no"}).`);
  } else {
    const diff = real1x.finalReturnPct - spy.returnPct;
    const verdict = diff >= 0 ? "BEATS" : "LOSES";
    console.log(`     v4.1-ParabolicLock @1.0× ${verdict} SPY by ${Math.abs(diff).toFixed(2)} pts [${sign(real1x.finalReturnPct)}${real1x.finalReturnPct.toFixed(2)}% vs SPY ${sign(spy.returnPct)}${spy.returnPct.toFixed(2)}%; DD ${real1x.maxDrawdownPct.toFixed(2)}% vs SPY ${spy.maxDDPct.toFixed(2)}%].`);
    console.log(`     v4.1-ParabolicLock @1.9× return ${sign(real19x.finalReturnPct)}${real19x.finalReturnPct.toFixed(2)}% at DD ${real19x.maxDrawdownPct.toFixed(2)}% (margin-call risk: ${real19x.marginCallFlag ? "YES" : "no"}).`);
  }

  // Machine-readable line.
  console.log("");
  console.log(`[JSON] ${JSON.stringify({
    window: WINDOW.label,
    catalogTickers: TICKERS.length,
    candidates: wc.length,
    parabolicLock: {
      lev1x: {
        trades: real1x.tradesTaken,
        winPct: Math.round(real1x.winPct * 10) / 10,
        totalR: real1x.totalR,
        returnPct: Math.round(real1x.finalReturnPct * 100) / 100,
        maxDDPct: Math.round(real1x.maxDrawdownPct * 100) / 100,
        finalEquity: real1x.finalEquity,
        exitBreakdown: real1x.exitBreakdown,
      },
      lev19x: {
        trades: real19x.tradesTaken,
        winPct: Math.round(real19x.winPct * 10) / 10,
        totalR: real19x.totalR,
        returnPct: Math.round(real19x.finalReturnPct * 100) / 100,
        maxDDPct: Math.round(real19x.maxDrawdownPct * 100) / 100,
        finalEquity: real19x.finalEquity,
        marginCallFlag: real19x.marginCallFlag,
      },
      frictionless1xReturnPct: Math.round(fric1x.finalReturnPct * 100) / 100,
    },
    spy: spy ? { returnPct: Math.round(spy.returnPct * 100) / 100, maxDDPct: Math.round(spy.maxDDPct * 100) / 100, finalEquity: spy.finalEquity } : null,
    flightRecorder: { path: TRADELOG_PATH, trades: real1x.closed.length },
  })}`);

  printDisclaimer();

  console.log("");
  console.log(`Done. 1 config (Genesis-TRUE entry, Parabolic-Lock exit) × CALENDAR-2025 × {1.0×, 1.9×} leverage. (Simulation only — no live actions taken.)`);
}

function printDisclaimer(): void {
  console.log("");
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`SIMPLIFICATIONS / DISCLAIMER — read before trusting any number above`);
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`  • DAILY-BAR TRAIL/MFE OVERSTATES: the +1.5R / +3.0R tags, the tight Chandelier, and MFE_R all use`);
  console.log(`    DAILY highs/lows — the staged exits AND the recorded MFE_R are OVERSTATED vs intraday reality.`);
  console.log(`    Treat MFE_R as a CEILING, and the staged P&L as optimistic on intraday whipsaw.`);
  console.log(`  • 1.9× LINEAR MODEL UNDERSTATES RISK: the 1.9× book is modelled as 1.9% risk/trade with a linear`);
  console.log(`    1.9×eq headroom. REAL 1.9× margin is WORSE than this: a CLUSTER GAP-DOWN on correlated high-beta`);
  console.log(`    names forces liquidation at the worst price, intraday maintenance-margin calls, and gap-through`);
  console.log(`    stops — none of which this linear model captures. The marginCallFlag (DD>40%) is a PROXY, not a`);
  console.log(`    guarantee; treat "marginCall=no" with suspicion on any correlated drawdown day.`);
  console.log(`  • SURVIVORSHIP: the universe is the CURRENT 2025 catalog (getCatalogTickers(1)); de-listed/removed`);
  console.log(`    names that traded in 2025 are NOT back-filled — a survivorship tilt that flatters returns.`);
  console.log(`  • NO MENTOR BOOST: the live +0..2.0 mentor boost is OMITTED (needs live pattern data), so the 7.0`);
  console.log(`    floor is HARDER to clear here than live — these results UNDER-count entries.`);
  console.log(`  • LONG-ONLY: NO short engine; the live regime/breadth short-gate is not reproduced offline.`);
  console.log(`  • FRESH SCORING: genesisScore is implemented from the v1.0 spec, NOT the live v2.2 engine.`);
  console.log(`  • CONVICTION AUCTION is a per-CALENDAR-DAY ranking on totalScore; intraday entry timing is not modelled.`);
  console.log(`  • FRICTION IS APPROXIMATE: 5bps flat haircut on entry + each exit fill; commission-in-R at the BASELINE`);
  console.log(`    1%-risk full size (implied shares), NOT post-cap size. REALISTIC is a FLOOR on cost.`);
  console.log(`  • SL-FIRST-ON-TIE (strict): any bar with low<=stop & high>=target fills the STOP, never the take-profit.`);
  console.log(`  • MAX_CORRELATION 0.80 pairwise gate is NOT reproduced offline; the per-sector cap (≤3) is a partial proxy.`);
}

main().catch(err => {
  console.error(`[FATAL] ${(err as Error).stack ?? err}`);
  process.exit(1);
});
