/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  elzaV41Strict2025.ts — Elza v4.1 "STRICT" : split Retest/Breakout LONG-ONLY║
 * ║                                                                            ║
 * ║  PURE SIMULATION. NO DB writes. NO IBKR. NO orders. NO deploy. NO SSH.     ║
 * ║                                                                            ║
 * ║  ENTRY GATES (Genesis-TRUE v1.0 — identical scoring to ParabolicLock):     ║
 * ║    genesisScore (8 sub-scores, cap +0.99, base up to 10);                  ║
 * ║    gate = totalScore >= 7.0 AND confluence >= 4.5 AND liquidity >= 2.0     ║
 * ║    (getTickerIntelligence(ticker, bars.slice(0,i+1)) — REAL & CAUSAL);     ║
 * ║    EMA-200 macro guard: entry ONLY if price > EMA200 (long macro filter).  ║
 * ║    conviction-ranked 12-slot fill; 149 catalog (getCatalogTickers(1)).     ║
 * ║    BOTH Tier-3 Gold Retest AND Tier-4 Gold Breakout (+Override) ACTIVE.     ║
 * ║                                                                            ║
 * ║  SPLIT ENTRY / STOP MECHANICS (the v4.1-STRICT thesis):                    ║
 * ║   • TIER 3 GOLD RETEST:                                                     ║
 * ║       entry  = signalClose × 1.005 (Limit +0.5%);                          ║
 * ║       size   = 100% of slot (1% risk);                                      ║
 * ║       SL     = STRUCTURAL SWING LOW (most recent pivot low in ~20-bar       ║
 * ║               lookback: a bar whose low < lows of 2 bars EACH side).        ║
 * ║       *** NO valid swing low → REJECT the entry. NO 2.5-ATR fallback,       ║
 * ║           NO 10-bar-low fallback. ***                                       ║
 * ║   • TIER 4 GOLD BREAKOUT (+ Override):                                      ║
 * ║       entry  = signalClose × 1.015 (aggressive Limit +1.5%);               ║
 * ║       size   = 50% of slot (0.5% risk — half = exposure protection);        ║
 * ║       SL     = FAKEOUT-PROTECTION TIGHT STOP = the TIGHTER of               ║
 * ║               { breakout-bar low , entry − 1.0×ATR14 }, placed JUST BELOW   ║
 * ║               the breakout line — NOT 2.5 ATR. (If breakout-bar low is       ║
 * ║               above entry, use entry − 1.0×ATR14.) Failed breakout that      ║
 * ║               crashes back is cut IMMEDIATELY at a tiny loss.                ║
 * ║   R = entry − SL (per tier). RC-2: skip if (entry−SL)/entry > 12%.          ║
 * ║                                                                            ║
 * ║  PARABOLIC LOCK (Stage-1 = BREAKEVEN ONLY — the v4.1-STRICT change):        ║
 * ║    Stage 1 @ +1.5R: move SL to BREAKEVEN. SELL NOTHING — full pos runs.     ║
 * ║    Stage 2 @ +3.0R: SELL 50% (bank; contribution 0.5×3.0R = +1.5R).         ║
 * ║    Stage 3: remaining 50% trails max(priorTrail, highHigh − 1.5×ATR14);     ║
 * ║      exit on low<=trail.                                                     ║
 * ║    Pre-+1.5R full stop = −1R (×0.5 exposure for half-size breakouts via      ║
 * ║      sizing). Between +1.5R and +3.0R stop = breakeven. SL-FIRST-ON-TIE      ║
 * ║      strict. NO fast-kill; 60-bar backstop. Track mfeR.                      ║
 * ║                                                                            ║
 * ║  WINDOW: CALENDAR 2025 = entryDate in [2025-01-01, 2025-12-31].             ║
 * ║  FRICTION REALISTIC: 5 bps each fill + $1/side.                             ║
 * ║                                                                            ║
 * ║  PORTFOLIO: $100k compounding, risk 1% (Retest) / 0.5% (Breakout half),     ║
 * ║    leverage 1.0×, maxConcurrent 12, maxPerSector 3, heat ≤ 20%, maxPos $85k.║
 * ║                                                                            ║
 * ║  DUAL RETURN COLUMNS:                                                        ║
 * ║    Net 1.0×       = portfolio as sized.                                      ║
 * ║    Leveraged 1.9× = multiply EACH trade's $ P&L by 1.9 in the equity curve   ║
 * ║      (CEO instruction). Report return% AND maxDD% (amplified) + marginCall   ║
 * ║      Flag if 1.9× DD > 40%.                                                  ║
 * ║                                                                            ║
 * ║  FLIGHT RECORDER (mandatory): per-trade log                                 ║
 * ║    Ticker | EntryDate | ExitDate | MFE_R | FinalNetR(1.0×) | ExitReason      ║
 * ║    to stdout AND /tmp/elza-v41-strict-2025-tradelog.md.                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * RUN (manager runs this on the droplet — has Yahoo/DB data; 149 tickers is slow):
 *   node --import tsx --env-file=.env scripts/elzaV41Strict2025.ts
 *
 * BUILD-CHECK (local, no run):
 *   npx esbuild scripts/elzaV41Strict2025.ts --bundle --platform=node --packages=external --outdir=/tmp/st25bc
 *
 * Scoring / dynamic-catalog / conviction-ranking / SPY are faithful copies of
 * scripts/elzaV41ParabolicLock.ts. Only the SPLIT entry/stop mechanics, the
 * Stage-1=breakeven-only Parabolic Lock, and the dual-return columns differ.
 * No P&L/price formula is re-implemented — calcEMA/calcRSI/Bar (server/zivEngine.ts)
 * and getTickerIntelligence (server/runtimeIntelligence.ts) are reused.
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

const RC2_MAX_RISK_PCT = 12;         // RC-2 guard: skip entry if (entry-SL)/entry > 12%

// ── SPLIT ENTRY MECHANICS ──
const RETEST_LIMIT_OFFSET   = 0.005; // Tier 3: entry = signalClose × 1.005 (Limit +0.5%)
const BREAKOUT_LIMIT_OFFSET = 0.015; // Tier 4: entry = signalClose × 1.015 (Limit +1.5%)

// ── SPLIT STOP MECHANICS ──
const SWING_LOOKBACK = 20;           // Retest structural-swing-low scan window (~20 bars)
const SWING_FRACTAL_SIDE = 2;        // pivot low = low < lows of 2 bars EACH side
const BREAKOUT_ATR_MULT = 1.0;       // Breakout fakeout stop: entry − 1.0×ATR14 (TIGHT, not 2.5)

// ── SPLIT SIZING (risk fraction of equity per tier) ──
const RETEST_RISK_PCT   = 0.01;      // Tier 3 Retest = 100% of slot = 1% risk
const BREAKOUT_RISK_PCT = 0.005;     // Tier 4 Breakout = 50% of slot = 0.5% risk (exposure protection)

// ── TRUE v1.0 ENTRY GATES (Genesis-TRUE — identical to ParabolicLock). ──
const LONG_ENTRY_MIN_SCORE = 7.0;    // authoritative v1.0 floor
const MIN_CONFLUENCE        = 4.5;   // v1.0 gated on confluenceScore >= 4.5
const MIN_LIQUIDITY_SCORE   = 2.0;   // v1.0 gated on liquidityScore  >= 2.0

// ── PARABOLIC LOCK EXIT (Stage-1 = BREAKEVEN ONLY) ──
const STAGE1_R          = 1.5;       // Stage 1 trigger: +1.5R → SL to breakeven, sell NOTHING
const STAGE2_R          = 3.0;       // Stage 2 trigger: +3.0R → SELL 50%
const STAGE2_BANK_FRAC  = 0.50;      // bank 50% of ORIGINAL at Stage 2
const STAGE3_FRAC       = 0.50;      // remaining 50% trails on the tight Chandelier
const CHANDELIER_ATR_MULT = 1.5;     // TIGHT trail = peakHigh − 1.5×ATR14
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
const LEVERAGE = 1.0;                 // base book leverage (headroom 1.0×eq)

// ── DUAL RETURN — CEO 1.9× amplifier (per-trade $ P&L × 1.9 in the equity curve). ──
const CEO_AMPLIFIER = 1.9;
const MARGIN_CALL_DD = 0.40;         // 1.9× peak-to-trough >40% → marginCallFlag

// ─── Friction model (REALISTIC) ───────────────────────────────────────────────
const SLIPPAGE_BPS = 0.0005;         // 5 bps adverse on entry AND every exit fill
const COMMISSION_PER_SIDE = 1.0;     // flat $1/side on the implied (baseline-size) share count

// ─── Window: CALENDAR 2025 ONLY ───────────────────────────────────────────────
interface WindowDef { label: string; start: string; end: string; }
const WINDOW: WindowDef = { label: "CY-2025", start: "2025-01-01", end: "2025-12-31" };
const EARLIEST_WINDOW_START = WINDOW.start;

const TRADELOG_PATH = "/tmp/elza-v41-strict-2025-tradelog.md";

type FrictionMode = "FRICTIONLESS" | "REALISTIC";

// ════════════════════════════════════════════════════════════════════════════
// GENESIS SCORING — copied verbatim from elzaV41ParabolicLock.ts (v1.0 spec).
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

/**
 * STRUCTURAL SWING LOW (fractal pivot): scan the last ~SWING_LOOKBACK bars (up to and
 * including the signal bar i) and return the most RECENT bar whose low is strictly less
 * than the lows of SWING_FRACTAL_SIDE bars on EACH side. Requires that both neighbour
 * windows exist inside the array. Returns null if no valid pivot exists.
 */
function findStructuralSwingLow(bars: Bar[], i: number): number | null {
  const side = SWING_FRACTAL_SIDE;
  // A pivot at index p needs side bars to its right; the most recent confirmable pivot
  // is at i-side. Scan backward from there over the ~20-bar lookback window.
  const earliest = Math.max(side, i - SWING_LOOKBACK + 1);
  for (let p = i - side; p >= earliest; p--) {
    if (p - side < 0 || p + side >= bars.length) continue;
    const lowP = bars[p].low;
    let isPivot = true;
    for (let k = 1; k <= side; k++) {
      if (!(lowP < bars[p - k].low) || !(lowP < bars[p + k].low)) { isPivot = false; break; }
    }
    if (isPivot) return lowP;
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// CANDIDATE GENERATION — one candidate per (ticker, bar) qualifying tier that
// passes: (i) totalScore>=7.0, (ii) confluence>=4.5 & liquidity>=2.0,
// (iii) EMA-200 macro guard (price>EMA200), (iv) split-stop validity, (v) RC-2.
//
// SPLIT MECHANICS:
//   Retest   → entry×1.005, structural swing low SL (REJECT if none), 1% risk.
//   Breakout → entry×1.015, tighter-of{breakout-bar low, entry−1×ATR14}, 0.5% risk.
//
// EXIT = PARABOLIC LOCK (Stage1=breakeven-only). NO fast-kill, 60-bar backstop.
// ════════════════════════════════════════════════════════════════════════════

type ExitReason =
  | "SL"          // full stop pre-Stage-1 (−1R)
  | "TIME"        // 60-bar backstop (pre-Stage-1)
  | "STOP_BE"     // breakeven stop hit after Stage 1 (before Stage 2)
  | "SCALE_3R"    // Stage 2 banked 50% then... (only set if last leg also exits as trail/open; SCALE is recorded in flags)
  | "TRAIL"       // tight Chandelier on the last 50% (Stage 3 active)
  | "TRAIL_OPEN"  // Stage 3 still open at last bar → mark at close
  | "OPEN";       // never advanced past Stage 1 and ran out of bars → mark at close

type TradeTier = "RETEST" | "BREAKOUT";

interface Candidate {
  ticker: string;
  sector: string;
  entryDate: string;
  exitDate: string;
  tier: string;              // genesis tier label (display)
  tradeTier: TradeTier;      // RETEST (1% risk) | BREAKOUT (0.5% risk)
  riskPct: number;           // per-tier risk fraction (sizing)
  totalScore: number;        // conviction rank key
  entry: number;             // limit-offset entry level
  sl: number;                // initial SL (per tier). R = entry − sl.
  exitReason: ExitReason;

  // Stage flags + the EXIT LEVEL for each banked/open fraction.
  stage1BE: boolean;         // +1.5R reached (SL→breakeven, NOTHING sold)
  stage2Banked: boolean;     // +3.0R reached (banked 50% @ secondTarget)
  firstTarget: number;       // +1.5R price (Stage-1 breakeven trigger)
  secondTarget: number;      // +3.0R price (Stage-2 bank level)
  openFrac: number;          // fraction OPEN when trade closed (1.0 / 0.5)
  openExitPrice: number;

  stopDistPct: number;       // (entry - sl) / entry
  mfeR: number;              // FLIGHT RECORDER — max favorable excursion in R over WHOLE trade
}

/**
 * Aggregate the trade into a single net R for the whole position, given a friction
 * mode. Realized contributions are weighted by the ORIGINAL-position fraction each
 * leg represents, so each leg's R is on the SAME entry-risk denominator (R).
 *
 *   Stage 1 (+1.5R): SELL NOTHING — breakeven only, no realized leg.
 *   Stage 2 (50%): +0.5 × 3.0R                          (banked at secondTarget)
 *   open fraction: openFrac × (openExitPrice − entry)/R  (SL/BE/trail/close)
 *
 * REALISTIC applies 5bps adverse on the entry fill AND on every exit fill, plus a
 * $1/side commission converted to R at the BASELINE full size for THIS tier's risk%.
 */
function computeTradeR(c: Candidate, friction: FrictionMode): number {
  const real = friction === "REALISTIC";
  const entryFill = real ? c.entry * (1 + SLIPPAGE_BPS) : c.entry;
  const risk = entryFill - c.sl;
  if (!(risk > 0)) return 0;

  const sell = (px: number): number => (real ? px * (1 - SLIPPAGE_BPS) : px);

  let r = 0;
  let exitSides = 0;

  // Stage 2 banked 50% @ secondTarget. (Stage 1 sold nothing.)
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
    const sharesFull = (c.riskPct * START_EQUITY) / riskPerShare; // baseline implied shares (this tier)
    const commR_perSide = sharesFull > 0 ? COMMISSION_PER_SIDE / (sharesFull * riskPerShare) : 0;
    const sides = 1 /* entry */ + exitSides;
    r -= sides * commR_perSide;
  }

  return Math.round(r * 100) / 100;
}

interface GenStats { retestEntries: number; breakoutEntries: number; retestRejectedNoSwing: number; }

/**
 * Walk ONE ticker's bars, emit a Candidate per qualifying bar.
 * Entry gates: totalScore>=7.0, confluence>=4.5, liquidity>=2.0, EMA200 macro guard,
 * split-stop validity (Retest swing-low-or-REJECT), RC-2 (<=12%).
 *
 * EXIT = PARABOLIC LOCK (Stage1=breakeven-only). SL-FIRST-ON-TIE strict at EVERY stage.
 *   • Pre-Stage1 (full size, stop=initial SL = −1R): if low<=stop → STOP fills even if
 *     high>=firstTarget the same bar. Else if high>=firstTarget → Stage 1: SELL NOTHING,
 *     move stop to BREAKEVEN, full position keeps running.
 *   • Post-Stage1 (100% open, stop=breakeven): if low<=BE → STOP_BE fills even if
 *     high>=secondTarget. Else if high>=secondTarget → Stage 2: SELL 50% @ secondTarget,
 *     begin TIGHT Chandelier on remaining 50%.
 *   • Post-Stage2 (50% open): tight Chandelier max(prior, highHigh − 1.5×ATR14).
 *     If low<=trail → TRAIL fills the 50% at the trail.
 *   • 60-bar backstop applies pre-Stage1 only; residual legs trail with no time-stop.
 *
 * MFE_R: running max of (barHigh − entry)/R over the WHOLE held window.
 */
async function generateCandidates(
  ticker: string,
  bars: Bar[],
  out: Candidate[],
  stats: GenStats,
): Promise<void> {
  let i = 0;
  while (i < bars.length && bars[i].date < EARLIEST_WINDOW_START) i++;

  for (; i < bars.length; i++) {
    if (i + 1 < MIN_BARS) continue;
    // CALENDAR-2025: only entries whose entry bar is within the window.
    if (bars[i].date > WINDOW.end) break;

    const gs = genesisScore(bars, i);
    if (gs.tier === null) continue;

    // ── ENTRY GATE 1 — TRUE v1.0 score floor. ──
    if (!(gs.totalScore >= LONG_ENTRY_MIN_SCORE)) continue;

    const signalClose = bars[i].close;
    if (!(signalClose > 0)) continue;

    // ── EMA-200 MACRO GUARD — long entry ONLY if price > EMA200. ──
    if (!(gs.price > gs.ema200)) continue;

    // ── ENTRY GATE 2 — confluence & liquidity (REAL, causal from bars[0..i]). ──
    const intel = await getTickerIntelligence(ticker, bars.slice(0, i + 1));
    if (!(intel.confluenceScore >= MIN_CONFLUENCE)) continue;
    if (!(intel.liquidityScore >= MIN_LIQUIDITY_SCORE)) continue;

    // ── SPLIT ENTRY/STOP MECHANICS by tier. ──
    const isRetest = gs.tier === "Gold Retest";
    const tradeTier: TradeTier = isRetest ? "RETEST" : "BREAKOUT";
    const riskPct = isRetest ? RETEST_RISK_PCT : BREAKOUT_RISK_PCT;

    let entry: number;
    let sl: number;

    if (isRetest) {
      // Tier 3 Retest: Limit +0.5%; SL = STRUCTURAL SWING LOW or REJECT (no fallback).
      entry = signalClose * (1 + RETEST_LIMIT_OFFSET);
      const swingLow = findStructuralSwingLow(bars, i);
      if (swingLow === null) { stats.retestRejectedNoSwing++; continue; } // *** REJECT — no valid swing low ***
      sl = swingLow;
    } else {
      // Tier 4 Breakout (+ Override): aggressive Limit +1.5%; FAKEOUT-PROTECTION TIGHT STOP.
      entry = signalClose * (1 + BREAKOUT_LIMIT_OFFSET);
      const atr14 = computeAtr14Local(bars.slice(0, i + 1));
      const breakoutBarLow = bars[i].low;
      const atrStop = (atr14 != null && atr14 > 0) ? entry - BREAKOUT_ATR_MULT * atr14 : Number.NEGATIVE_INFINITY;
      // Tighter of {breakout-bar low, entry − 1.0×ATR14}. If breakout low is ABOVE entry,
      // it is not a valid stop → fall back to the ATR stop. "Tighter" = closer to entry = higher.
      const candidateStops: number[] = [];
      if (breakoutBarLow < entry) candidateStops.push(breakoutBarLow);
      if (atrStop > Number.NEGATIVE_INFINITY) candidateStops.push(atrStop);
      if (candidateStops.length === 0) continue;     // no valid tight stop available
      sl = Math.max(...candidateStops);              // tighter = closer to entry = the higher level
    }

    if (!(sl < entry)) continue;
    const stopDistPct = (entry - sl) / entry;
    if (stopDistPct * 100 > RC2_MAX_RISK_PCT) continue;   // RC-2 skip

    if (isRetest) stats.retestEntries++; else stats.breakoutEntries++;

    const risk = entry - sl;
    const firstTarget = entry + STAGE1_R * risk;  // +1.5R (breakeven trigger)
    const secondTarget = entry + STAGE2_R * risk; // +3.0R (sell 50%)

    // ── EXIT walk-forward — parabolic lock (Stage1=breakeven-only) + 60-bar backstop. ──
    let exitDate = bars[bars.length - 1].date;
    let exitReason: ExitReason = "OPEN";

    let stage1BE = false;
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

      if (!stage1BE) {
        // PHASE 1: full size, stop at initial SL (−1R). SL-FIRST-ON-TIE strict.
        if (bar.low <= currentStop) {
          exitReason = "SL"; exitDate = bar.date;
          openFrac = 1.0; openExitPrice = currentStop; closedOut = true;
          break;
        }
        if (bar.high >= firstTarget) {
          // Stage 1: SELL NOTHING; move stop to BREAKEVEN; full position keeps running.
          stage1BE = true;
          openFrac = 1.0;
          currentStop = entry; // breakeven
          highestHigh = Math.max(highestHigh, bar.high);
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
        // PHASE 2: 100% open, stop=breakeven. SL-FIRST-ON-TIE strict.
        if (bar.low <= currentStop) {
          exitReason = "STOP_BE"; exitDate = bar.date;
          openFrac = 1.0; openExitPrice = currentStop; closedOut = true;
          break;
        }
        if (bar.high >= secondTarget) {
          // Stage 2: SELL 50% @ secondTarget; begin tight Chandelier on remaining 50%.
          stage2Banked = true;
          openFrac = STAGE3_FRAC; // 0.50 remains open
          highestHigh = Math.max(highestHigh, bar.high);
          const atr = computeAtr14Local(bars.slice(0, j + 1));
          trailStop = (atr != null && atr > 0)
            ? Math.max(entry, highestHigh - CHANDELIER_ATR_MULT * atr)
            : entry;
          currentStop = trailStop;
          continue;
        }
        if (j === bars.length - 1) {
          // Stage 1 (breakeven) reached, Stage 2 never reached; mark full 100% at close.
          exitReason = "OPEN"; exitDate = bar.date;
          openFrac = 1.0; openExitPrice = bar.close; closedOut = true;
        }
      } else {
        // PHASE 3: last 50% trails on the TIGHT Chandelier. NO time-stop.
        highestHigh = Math.max(highestHigh, bar.high);
        const atr = computeAtr14Local(bars.slice(0, j + 1));
        if (atr != null && atr > 0) {
          trailStop = Math.max(trailStop, highestHigh - CHANDELIER_ATR_MULT * atr);
        }
        currentStop = trailStop;

        if (bar.low <= currentStop) {
          exitReason = "TRAIL"; exitDate = bar.date;
          openFrac = STAGE3_FRAC; openExitPrice = currentStop; closedOut = true;
          break;
        }
        if (j === bars.length - 1) {
          exitReason = "TRAIL_OPEN"; exitDate = bar.date;
          openFrac = STAGE3_FRAC; openExitPrice = bar.close; closedOut = true;
        }
      }
    }

    // Entry on the very last bar: no forward bar → mark flat OPEN at entry.
    if (i === bars.length - 1 && !closedOut) {
      exitDate = bars[i].date; exitReason = "OPEN";
      stage1BE = false; stage2Banked = false;
      openFrac = 1.0; openExitPrice = entry;
    }

    out.push({
      ticker,
      sector: sectorOf(ticker),
      entryDate: bars[i].date,
      exitDate,
      tier: gs.tier,
      tradeTier,
      riskPct,
      totalScore: gs.totalScore,
      entry,
      sl,
      exitReason,
      stage1BE,
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
// PORTFOLIO SIM — CONVICTION-RANKED auction. Records both the as-sized $ P&L (Net
// 1.0×) AND the per-trade ×1.9 amplified $ P&L (Leveraged 1.9×, CEO) on TWO separate
// equity curves computed in a SINGLE pass.
// ════════════════════════════════════════════════════════════════════════════

interface OpenPos {
  ticker: string; sector: string; notional: number; riskDollars: number;
  pnl: number;        // as-sized $ P&L (Net 1.0×)
  pnlLev: number;     // amplified $ P&L (= pnl × 1.9) for the Leveraged curve
  exitDate: string; candIdx: number;
}
interface ClosedTrade {
  ticker: string; entryDate: string; exitDate: string; exitReason: ExitReason;
  tradeTier: TradeTier; r: number; pnl: number; pnlLev: number; skipped: boolean; mfeR: number;
}
interface CellResult {
  windowLabel: string;
  friction: FrictionMode;
  // Net 1.0× book.
  tradesTaken: number;
  wins: number;
  winPct: number;
  totalR: number;
  netReturnPct: number;
  netMaxDDPct: number;
  netFinalEquity: number;
  // Leveraged 1.9× book (same trades, $ P&L × 1.9 on the equity curve).
  levReturnPct: number;
  levMaxDDPct: number;
  levFinalEquity: number;
  marginCallFlag: boolean;
  exitBreakdown: Record<string, number>;
  closed: ClosedTrade[];          // FLIGHT RECORDER — taken trades only
}

function runPortfolio(
  windowCands: Candidate[],
  friction: FrictionMode,
  windowLabel: string,
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

  // Net 1.0× book (drives sizing/heat/headroom — the REAL portfolio).
  let equity = START_EQUITY;
  let peakEquity = START_EQUITY;
  let maxDrawdownPct = 0;

  // Leveraged 1.9× book (CEO amplifier — same trade selection, $ P&L × 1.9).
  let equityLev = START_EQUITY;
  let peakEquityLev = START_EQUITY;
  let maxDrawdownLevPct = 0;
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
      equityLev += pos.pnlLev;

      const c = windowCands[idx];
      closed.push({
        ticker: c.ticker, entryDate: c.entryDate, exitDate: c.exitDate,
        exitReason: c.exitReason, tradeTier: c.tradeTier, r: rOf(c),
        pnl: pos.pnl, pnlLev: pos.pnlLev, skipped: false, mfeR: c.mfeR,
      });

      if (equity > peakEquity) peakEquity = equity;
      const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;

      if (equityLev > peakEquityLev) peakEquityLev = equityLev;
      const ddLev = peakEquityLev > 0 ? (peakEquityLev - equityLev) / peakEquityLev : 0;
      if (ddLev > maxDrawdownLevPct) maxDrawdownLevPct = ddLev;
      if (ddLev > MARGIN_CALL_DD) marginCallFlag = true;
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
      // PER-TIER risk%: Retest 1% (full slot), Breakout 0.5% (half slot).
      let riskDollars = c.riskPct * equityAtEntry;

      const heatAfter = (grossOpenRisk() + riskDollars) / (equityAtEntry > 0 ? equityAtEntry : 1);
      if (heatAfter > HEAT_CAP) {
        closed.push({
          ticker: c.ticker, entryDate: c.entryDate, exitDate: c.exitDate,
          exitReason: c.exitReason, tradeTier: c.tradeTier, r: rOf(c),
          pnl: 0, pnlLev: 0, skipped: true, mfeR: c.mfeR,
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
      const pnlLev = pnl * CEO_AMPLIFIER;   // CEO instruction: amplify EACH trade's $ P&L ×1.9
      openByIdx.set(idx, {
        ticker: c.ticker, sector: c.sector, notional, riskDollars,
        pnl, pnlLev, exitDate: c.exitDate, candIdx: idx,
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
    netReturnPct: ((equity - START_EQUITY) / START_EQUITY) * 100,
    netMaxDDPct: maxDrawdownPct * 100,
    netFinalEquity: Math.round(equity),
    levReturnPct: ((equityLev - START_EQUITY) / START_EQUITY) * 100,
    levMaxDDPct: maxDrawdownLevPct * 100,
    levFinalEquity: Math.round(equityLev),
    marginCallFlag,
    exitBreakdown,
    closed: taken,
  };
}

// ─── SPY benchmark (copied from elzaV41ParabolicLock.ts) ──────────────────────
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
// AND written to /tmp/elza-v41-strict-2025-tradelog.md.
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

  // ── markdown table for /tmp/elza-v41-strict-2025-tradelog.md. ──
  const md: string[] = [];
  md.push(`# Elza v4.1 "STRICT" — Flight Recorder (per closed trade) — CALENDAR 2025`);
  md.push("");
  md.push(`Generated ${new Date().toISOString()} — READ-ONLY simulation. LONG-ONLY. Split Retest/Breakout mechanics + fakeout-protection tight stop + Parabolic Lock (Stage-1 = breakeven-only). FinalNetR is the 1.0× REALISTIC net R (after 5bps/side + $1/side commission). MFE_R is daily-bar max favorable excursion in R (overstated vs intraday).`);
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
  console.log(`Elza v4.1 "STRICT" Backtest — split Retest/Breakout mechanics + FAKEOUT PROTECTION + Parabolic Lock (Stage-1=breakeven-only) + dual-return columns — CALENDAR 2025 — READ-ONLY (no DB writes, no IBKR, no orders, no SSH)`);

  // ── Resolve the LIVE scan universe (dynamic getCatalogTickers(1) ≈ 149 USA). ──
  const catalog = await getCatalogTickers(1);
  for (const a of catalog) SECTOR_BY_TICKER[a.ticker] = a.sector;
  const TICKERS: string[] = catalog.map(a => a.ticker);
  console.log("[CATALOG] live universe: " + TICKERS.length + " USA tickers (uid=1, US-only, non-IPO) — expected ~149 (catalog parity).");

  console.log(`Scoring: FRESH genesisScore (NOT calcZivEngineScore). LONG-ONLY — NO SHORT ENGINE.`);
  console.log(`ENTRY GATES (Genesis-TRUE v1.0): totalScore >= ${LONG_ENTRY_MIN_SCORE} AND confluenceScore >= ${MIN_CONFLUENCE} AND liquidityScore >= ${MIN_LIQUIDITY_SCORE} AND price > EMA200 (macro guard).`);
  console.log(`  (confluence/liquidity via getTickerIntelligence(ticker, bars.slice(0,i+1)) — REAL, causal, daily-bar-only.)`);
  console.log(`Tiers ACTIVE: Gold Retest (Tier 3) AND Gold Breakout (Tier 4) + Breakout Override. Sub-scores capped at +0.99.`);
  console.log(`SPLIT ENTRY/STOP:`);
  console.log(`  RETEST  : entry = close×${(1 + RETEST_LIMIT_OFFSET).toFixed(3)} (Limit +${RETEST_LIMIT_OFFSET * 100}%); risk ${RETEST_RISK_PCT * 100}% (full slot); SL = STRUCTURAL SWING LOW (${SWING_FRACTAL_SIDE}-bar fractal in ~${SWING_LOOKBACK}-bar lookback) or REJECT — NO ATR/10-bar fallback.`);
  console.log(`  BREAKOUT: entry = close×${(1 + BREAKOUT_LIMIT_OFFSET).toFixed(3)} (Limit +${BREAKOUT_LIMIT_OFFSET * 100}%); risk ${BREAKOUT_RISK_PCT * 100}% (half slot = exposure protection); SL = TIGHTER of {breakout-bar low, entry − ${BREAKOUT_ATR_MULT}×ATR${ATR_PERIOD}} (fakeout protection — NOT 2.5 ATR).`);
  console.log(`  RC-2: skip if (entry−SL)/entry > ${RC2_MAX_RISK_PCT}%.`);
  console.log(`RANKING: per-day conviction auction — highest totalScore fills the ${MAX_CONCURRENT} LONG slots (NOT FIFO).`);
  console.log(`EXIT (PARABOLIC LOCK): R=entry−SL. Stage1 @+${STAGE1_R}R → SL to BREAKEVEN, SELL NOTHING (full pos runs). Stage2 @+${STAGE2_R}R → SELL ${STAGE2_BANK_FRAC * 100}%. Stage3 last ${STAGE3_FRAC * 100}% TIGHT Chandelier max(prior, highHigh − ${CHANDELIER_ATR_MULT}×ATR${ATR_PERIOD}). Pre-Stage1 full stop = −1R.`);
  console.log(`TIME-STOP: NO FAST-KILL. Generous ${GENESIS_TIME_STOP_BARS}-bar backstop (pre-Stage1 only).`);
  console.log(`PESSIMISM: SL-FIRST-ON-TIE strict at EVERY stage. REALISTIC = 5bps adverse entry & every exit fill + $1/side commission-in-R (headline).`);
  console.log(`Portfolio: $${START_EQUITY.toLocaleString()} compounding, maxConcurrent ${MAX_CONCURRENT}, maxPerSector ${MAX_PER_SECTOR}, heat ≤ ${HEAT_CAP * 100}%, maxPos $${MAX_POSITION_USD.toLocaleString()}, leverage ${LEVERAGE}×.`);
  console.log(`DUAL RETURN: Net 1.0× = portfolio as sized. Leveraged 1.9× = each trade's $ P&L × ${CEO_AMPLIFIER} on the equity curve (CEO instruction); marginCallFlag if 1.9× DD > ${MARGIN_CALL_DD * 100}%.`);
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

  // Build candidates (single Genesis-TRUE config, split mechanics).
  const cands: Candidate[] = [];
  const stats: GenStats = { retestEntries: 0, breakoutEntries: 0, retestRejectedNoSwing: 0 };
  let n = 0;
  for (const ticker of usableTickers) {
    n++;
    if (n % 20 === 0) {
      console.log(`[PROGRESS-SCORE] ${n}/${usableTickers.length} tickers scored (${cands.length} candidates so far).`);
    }
    await generateCandidates(ticker, barsByTicker.get(ticker)!, cands, stats);
  }
  console.log(`[DONE BUILDING] ${cands.length} candidates (Genesis-TRUE, split mechanics, calendar-2025 entries).`);

  // SPY for calendar-2025.
  const spy = computeSpyBenchmark(WINDOW.label, spyBars, WINDOW.start, WINDOW.end);

  // ── Run calendar-2025: REALISTIC headline (dual-return computed in one pass). ──
  const wc = candsForWindow(cands, WINDOW.start, WINDOW.end);
  const real  = runPortfolio(wc, "REALISTIC", WINDOW.label);
  const fric  = runPortfolio(wc, "FRICTIONLESS", WINDOW.label);

  // ════════════════════════════════════════════════════════════════════════
  // FLIGHT RECORDER — print + write file. (1.0× REALISTIC book; FinalNetR after friction.)
  // ════════════════════════════════════════════════════════════════════════
  const fr = buildFlightRecorder(real.closed);
  console.log("");
  console.log(`══════════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`═══ FLIGHT RECORDER — per-trade log (Ticker | EntryDate | ExitDate | MFE_R | FinalNetR[1.0×] | ExitReason) — sorted by EntryDate ═══`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════════`);
  console.log(fr.stdout);
  try {
    writeFileSync(TRADELOG_PATH, fr.markdown, "utf8");
    console.log("");
    console.log(`[FLIGHT RECORDER] wrote ${real.closed.length} trades → ${TRADELOG_PATH}`);
  } catch (e) {
    console.log(`[WARN] flight-recorder write failed (${TRADELOG_PATH}): ${(e as Error).message ?? e}`);
  }

  // ── ENTRY-TYPE COUNTS. ──
  console.log("");
  console.log(`  ── ENTRY-TYPE COUNTS (candidate generation, calendar-2025) ──`);
  console.log(`     retest-entries          = ${stats.retestEntries}`);
  console.log(`     breakout-entries        = ${stats.breakoutEntries}`);
  console.log(`     retest-REJECTED-no-swing-low = ${stats.retestRejectedNoSwing}  (STRICT: no swing low → no entry, no fallback)`);

  // ── SUMMARY TABLE: rows {Net 1.0×, Leveraged 1.9×, SPY}, cols trades|win%|totalR|return%|maxDD%|finalEq$. ──
  console.log("");
  console.log(`══════════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`═══ v4.1 STRICT — CALENDAR 2025 — REALISTIC headline (LONG only) — DUAL RETURN (Net 1.0× / Leveraged 1.9×) vs SPY ═══`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  candidates-in-window: ${wc.length}`);
  console.log("");
  console.log(
    `  ${pad("strategy", 16)}${padL("trades", 8)}${padL("win%", 9)}${padL("totalR", 10)}` +
    `${padL("return%", 11)}${padL("maxDD%", 10)}${padL("finalEq$", 14)}  flags`,
  );
  console.log(`  ${"─".repeat(90)}`);
  // Net 1.0× row.
  console.log(
    `  ${pad("Net 1.0x", 16)}${padL(real.tradesTaken, 8)}${padL(real.winPct.toFixed(1) + "%", 9)}` +
    `${padL(sign(real.totalR) + real.totalR.toFixed(2), 10)}` +
    `${padL(sign(real.netReturnPct) + real.netReturnPct.toFixed(2) + "%", 11)}` +
    `${padL(real.netMaxDDPct.toFixed(2) + "%", 10)}` +
    `${padL("$" + real.netFinalEquity.toLocaleString(), 14)}  as-sized`,
  );
  // Leveraged 1.9× row (same trades, $ P&L ×1.9).
  console.log(
    `  ${pad("Leveraged 1.9x", 16)}${padL(real.tradesTaken, 8)}${padL(real.winPct.toFixed(1) + "%", 9)}` +
    `${padL(sign(real.totalR * CEO_AMPLIFIER) + (real.totalR * CEO_AMPLIFIER).toFixed(2), 10)}` +
    `${padL(sign(real.levReturnPct) + real.levReturnPct.toFixed(2) + "%", 11)}` +
    `${padL(real.levMaxDDPct.toFixed(2) + "%", 10)}` +
    `${padL("$" + real.levFinalEquity.toLocaleString(), 14)}  ${real.marginCallFlag ? "marginCall=YES" : "marginCall=no"}`,
  );
  if (spy) {
    console.log(
      `  ${pad("SPY", 16)}${padL("-", 8)}${padL("-", 9)}${padL("-", 10)}` +
      `${padL(sign(spy.returnPct) + spy.returnPct.toFixed(2) + "%", 11)}` +
      `${padL(spy.maxDDPct.toFixed(2) + "%", 10)}` +
      `${padL("$" + spy.finalEquity.toLocaleString(), 14)}  buy&hold`,
    );
  } else {
    console.log(`  ${pad("SPY", 16)}${padL("- (no 2025 bars → INDETERMINATE)", 62)}`);
  }
  console.log("");
  console.log(`  (reference) Net 1.0× FRICTIONLESS return%: ${sign(fric.netReturnPct)}${fric.netReturnPct.toFixed(2)}%`);

  // ── Exit-reason breakdown (Net 1.0× book) — confirms the parabolic-lock exit is firing. ──
  console.log("");
  console.log(`  ── exit-reason breakdown (Net 1.0× REALISTIC book) ──`);
  const eb = real.exitBreakdown;
  console.log(`     SL=${eb["SL"] ?? 0}  TIME(${GENESIS_TIME_STOP_BARS}bar)=${eb["TIME"] ?? 0}  STOP_BE=${eb["STOP_BE"] ?? 0}  TRAIL=${eb["TRAIL"] ?? 0}  TRAIL_OPEN=${eb["TRAIL_OPEN"] ?? 0}  OPEN=${eb["OPEN"] ?? 0}`);
  console.log(`     (SCALE_3R = number that banked Stage-2 50% before the residual exited; counted via stage2Banked flag in the trade log, reason shows the residual leg's exit.)`);

  // Catalog parity.
  console.log("");
  console.log(`  [CATALOG PARITY] live universe = ${TICKERS.length} USA tickers (expected ~149).`);

  // ── VERDICTS (per leverage). ──
  console.log("");
  console.log(`  ── VERDICTS ──`);
  if (spy == null) {
    console.log(`     [SKIP] No SPY bars in 2025 window → SPY comparison INDETERMINATE.`);
    console.log(`     v4.1-STRICT Net 1.0× (realistic) = ${sign(real.netReturnPct)}${real.netReturnPct.toFixed(2)}% at DD ${real.netMaxDDPct.toFixed(2)}%.`);
    console.log(`     v4.1-STRICT Leveraged 1.9× = ${sign(real.levReturnPct)}${real.levReturnPct.toFixed(2)}% at DD ${real.levMaxDDPct.toFixed(2)}% (margin-call risk: ${real.marginCallFlag ? "YES" : "no"}).`);
  } else {
    const diffNet = real.netReturnPct - spy.returnPct;
    const verdictNet = diffNet >= 0 ? "BEATS" : "LOSES";
    console.log(`     v4.1-STRICT Net 1.0× ${verdictNet} SPY by ${Math.abs(diffNet).toFixed(2)} pts [${sign(real.netReturnPct)}${real.netReturnPct.toFixed(2)}% vs SPY ${sign(spy.returnPct)}${spy.returnPct.toFixed(2)}%; DD ${real.netMaxDDPct.toFixed(2)}% vs SPY ${spy.maxDDPct.toFixed(2)}%].`);
    const diffLev = real.levReturnPct - spy.returnPct;
    const verdictLev = diffLev >= 0 ? "BEATS" : "LOSES";
    console.log(`     v4.1-STRICT Leveraged 1.9× ${verdictLev} SPY by ${Math.abs(diffLev).toFixed(2)} pts [${sign(real.levReturnPct)}${real.levReturnPct.toFixed(2)}% vs SPY ${sign(spy.returnPct)}${spy.returnPct.toFixed(2)}%; DD ${real.levMaxDDPct.toFixed(2)}% (margin-call risk: ${real.marginCallFlag ? "YES" : "no"})].`);
  }

  // Machine-readable line.
  console.log("");
  console.log(`[JSON] ${JSON.stringify({
    window: WINDOW.label,
    catalogTickers: TICKERS.length,
    candidates: wc.length,
    entryTypeCounts: {
      retestEntries: stats.retestEntries,
      breakoutEntries: stats.breakoutEntries,
      retestRejectedNoSwingLow: stats.retestRejectedNoSwing,
    },
    strict: {
      net1x: {
        trades: real.tradesTaken,
        winPct: Math.round(real.winPct * 10) / 10,
        totalR: real.totalR,
        returnPct: Math.round(real.netReturnPct * 100) / 100,
        maxDDPct: Math.round(real.netMaxDDPct * 100) / 100,
        finalEquity: real.netFinalEquity,
        exitBreakdown: real.exitBreakdown,
      },
      leveraged19x: {
        trades: real.tradesTaken,
        winPct: Math.round(real.winPct * 10) / 10,
        totalR: Math.round(real.totalR * CEO_AMPLIFIER * 100) / 100,
        returnPct: Math.round(real.levReturnPct * 100) / 100,
        maxDDPct: Math.round(real.levMaxDDPct * 100) / 100,
        finalEquity: real.levFinalEquity,
        marginCallFlag: real.marginCallFlag,
      },
      frictionlessNet1xReturnPct: Math.round(fric.netReturnPct * 100) / 100,
    },
    spy: spy ? { returnPct: Math.round(spy.returnPct * 100) / 100, maxDDPct: Math.round(spy.maxDDPct * 100) / 100, finalEquity: spy.finalEquity } : null,
    flightRecorder: { path: TRADELOG_PATH, trades: real.closed.length },
  })}`);

  printDisclaimer();

  console.log("");
  console.log(`Done. 1 config (Genesis-TRUE entry + split Retest/Breakout mechanics + Parabolic-Lock exit) × CALENDAR-2025 × dual-return {Net 1.0×, Leveraged 1.9×}. (Simulation only — no live actions taken.)`);
}

function printDisclaimer(): void {
  console.log("");
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`SIMPLIFICATIONS / DISCLAIMER — read before trusting any number above`);
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`  • DAILY-BAR OVERSTATES STAGED EXITS + MFE: the +1.5R breakeven trigger, the +3.0R 50% scale, the`);
  console.log(`    tight Chandelier, and MFE_R all use DAILY highs/lows — the staged exits AND the recorded MFE_R are`);
  console.log(`    OVERSTATED vs intraday reality. Treat MFE_R as a CEILING, and staged P&L as optimistic on whipsaw.`);
  console.log(`  • LIMIT FILLS MODELLED AT close×offset: Retest entry = close×1.005, Breakout = close×1.015 are assumed`);
  console.log(`    to FILL at that level — real limit orders may not fill (price runs away) or fill worse on a gap.`);
  console.log(`  • 1.9× ×P&L AMPLIFIES DD + UNDERSTATES REAL RISK: the Leveraged column multiplies EACH trade's $ P&L`);
  console.log(`    by 1.9 on the equity curve. This amplifies drawdown but UNDERSTATES real cluster-gap / margin-call`);
  console.log(`    risk: a correlated high-beta gap-down forces liquidation at the worst price, intraday maintenance`);
  console.log(`    calls, and gap-through stops — none captured by a linear ×1.9. marginCallFlag (DD>40%) is a PROXY.`);
  console.log(`  • SURVIVORSHIP: the universe is the CURRENT 2025 catalog (getCatalogTickers(1)); de-listed/removed`);
  console.log(`    names that traded in 2025 are NOT back-filled — a survivorship tilt that flatters returns.`);
  console.log(`  • NO MENTOR BOOST: the live +0..2.0 mentor boost is OMITTED, so the 7.0 floor is HARDER to clear here`);
  console.log(`    than live — these results UNDER-count entries.`);
  console.log(`  • LONG-ONLY: NO short engine; the live regime/breadth short-gate is not reproduced offline.`);
  console.log(`  • FRESH SCORING: genesisScore is implemented from the v1.0 spec, NOT the live v2.2 engine.`);
  console.log(`  • CONVICTION AUCTION is a per-CALENDAR-DAY ranking on totalScore; intraday entry timing is not modelled.`);
  console.log(`  • SL-FIRST-ON-TIE (strict): any bar with low<=stop & high>=target fills the STOP, never the take-profit.`);
  console.log(`  • MAX_CORRELATION 0.80 pairwise gate is NOT reproduced offline; the per-sector cap (≤3) is a partial proxy.`);
}

main().catch(err => {
  console.error(`[FATAL] ${(err as Error).stack ?? err}`);
  process.exit(1);
});
