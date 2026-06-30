/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  elzaV45GoldenDNA.ts — Elza v4.5 "Golden DNA" : LONG-ONLY vs SPY.          ║
 * ║                                                                            ║
 * ║  PURE SIMULATION. NO DB writes. NO IBKR. NO orders. NO deploy. NO SSH.     ║
 * ║                                                                            ║
 * ║  ENTRY (Genesis-TRUE v1.0 core, copied from elzaV41ParabolicLock.ts):     ║
 * ║    genesisScore (8 sub-scores, cap +0.99, base up to 10);                  ║
 * ║    gate = totalScore >= 7.0 AND confluence >= 4.5 AND liquidity >= 2.0     ║
 * ║    (getTickerIntelligence(ticker, bars.slice(0,i+1)) — REAL & CAUSAL);     ║
 * ║    EMA-200 macro guard: price > EMA200 (Tier-3 Retest AND Tier-4 Breakout  ║
 * ║      active; Breakout-Override DROPPED — it requires price<EMA200);        ║
 * ║    Entry = signal-bar CLOSE (NO limit offset — the +0.5%/+1.5% offsets     ║
 * ║      hurt; reverted to close);                                             ║
 * ║    conviction-ranked 12-slot fill; getCatalogTickers(1) (~149 USA).        ║
 * ║                                                                            ║
 * ║  §1 — WIDE-LUNG STOP (ALL trades, both tiers):                             ║
 * ║    initialSL = max(entry × 0.92, EMA50 × 0.99). R = entry − initialSL.     ║
 * ║    (RC-2 >12% skip retained but won't bind: risk ≤ 8% by construction.)    ║
 * ║    Swing-low / tight-breakout-stop logic DROPPED entirely.                 ║
 * ║                                                                            ║
 * ║  §2 — MACRO + VIX GUARDS (size modifiers on the 1%-risk base):             ║
 * ║    SPY EMA-50 as-of entry date: SPY>EMA50 → Attack ×1.0; SPY<EMA50 →       ║
 * ║      Safe-Haven ×0.5.                                                      ║
 * ║    ^VIX daily close mapped to entry date: VIX>35 → BLOCK entry (skip);     ║
 * ║      VIX in (25,35] → ×0.70; VIX ≤ 25 → ×1.0.                              ║
 * ║    Final risk = 1% × spyMult × vixMult (compounding equity-based).         ║
 * ║                                                                            ║
 * ║  §3 — GOLDEN 5:1 EXIT:                                                     ║
 * ║    R = entry − initialSL. TP final = +5.0R.                                ║
 * ║    Golden Scale-Out @ +2.5R: sell 40% (bank 0.40×2.5R = +1.0R); move stop  ║
 * ║      on remaining 60% to BREAKEVEN.                                        ║
 * ║    Remaining 60% runs to +5.0R OR a Chandelier max(priorTrail, highHigh −  ║
 * ║      2.5×ATR14), whichever hits first. Contribution 0.60×(exit−entry)/R.   ║
 * ║    Pre-2.5R full stop = −1R. SL-FIRST-ON-TIE strict. NO fast-kill;         ║
 * ║      60-bar backstop. Track mfeR.                                          ║
 * ║                                                                            ║
 * ║  WINDOWS: BOTH. W-2025 = entryDate [2025-01-01, 2025-12-31];               ║
 * ║           W-2026 = entryDate [2026-01-01, last]. BARS_DAYS 600.            ║
 * ║  FRICTION REALISTIC (5bps each fill + $1/side).                            ║
 * ║                                                                            ║
 * ║  PORTFOLIO — $100k compounding, base risk 1% × guards, leverage 1.0×,      ║
 * ║    maxConcurrent 12, maxPerSector 3, heat ≤ 20%, maxPos $85k.              ║
 * ║  DUAL RETURN per window: Net (1.0×) as sized; Leveraged (1.9×) = each       ║
 * ║    trade $ P&L ×1.9 on the equity curve → return% + maxDD% + marginCall    ║
 * ║    (DD>40%).                                                               ║
 * ║                                                                            ║
 * ║  FLIGHT RECORDER (mandatory): per-trade log w/ Window + MFE_R column →     ║
 * ║    /tmp/elza-v45-golden-2025-tradelog.md and -2026-tradelog.md + stdout.   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * RUN (manager runs this on the droplet — has Yahoo/DB data; 149 tickers is slow):
 *   node --import tsx --env-file=.env scripts/elzaV45GoldenDNA.ts
 *
 * BUILD-CHECK (local, no run):
 *   npx esbuild scripts/elzaV45GoldenDNA.ts --bundle --platform=node --packages=external --outdir=/tmp/v45bc
 *
 * Scoring / dynamic-catalog / conviction-ranking / SPY / friction / flight-recorder /
 * portfolio are faithful copies of scripts/elzaV41ParabolicLock.ts. The STOP (wide-lung),
 * the GUARDS (SPY-EMA50 + ^VIX size/block), the EXIT (Golden 5:1 scale-at-2.5R), the
 * WINDOWS (both 2025 + 2026), and the 1.9× $-amplified curve differ. No P&L/price formula
 * is re-implemented — calcEMA/calcRSI/Bar (server/zivEngine.ts) and getTickerIntelligence
 * (server/runtimeIntelligence.ts) are reused.
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
const BARS_DAYS = 600;               // need 2024 warmup + all of calendar-2025 + 2026
const MIN_BARS = 50;                 // need a stable EMA50/trend history before scoring

const RC2_MAX_RISK_PCT = 12;         // RC-2 guard: skip entry if (entry-SL)/entry > 12% (won't bind — risk ≤ 8%)

// ── TRUE v1.0 ENTRY GATES (Genesis-TRUE — identical to elzaV41ParabolicLock). ──
const LONG_ENTRY_MIN_SCORE = 7.0;    // authoritative v1.0 floor
const MIN_CONFLUENCE        = 4.5;   // v1.0 gated on confluenceScore >= 4.5
const MIN_LIQUIDITY_SCORE   = 2.0;   // v1.0 gated on liquidityScore  >= 2.0

// ── §1 WIDE-LUNG STOP ──
const STOP_ENTRY_FLOOR_MULT = 0.92;  // 8%-below-entry floor
const STOP_EMA50_MULT       = 0.99;  // 1%-below-EMA50

// ── §3 GOLDEN 5:1 EXIT ──
const SCALE_R          = 2.5;        // Golden Scale-Out trigger: +2.5R
const SCALE_BANK_FRAC  = 0.40;       // sell 40% at +2.5R (contribution 0.40 × 2.5R = +1.0R)
const RUNNER_FRAC      = 0.60;       // remaining 60% runs to +5.0R or Chandelier
const TP_FINAL_R       = 5.0;        // final take-profit = +5.0R
const CHANDELIER_ATR_MULT = 2.5;     // WIDE trail = peakHigh − 2.5×ATR14
const ATR_PERIOD = 14;

// ── §2 MACRO + VIX GUARDS ──
const VIX_BLOCK = 35;                // VIX > 35 → block entry entirely
const VIX_HALF  = 25;                // VIX in (25, 35] → ×0.70 ; VIX ≤ 25 → ×1.0
const VIX_MID_MULT = 0.70;
const SPY_EMA = 50;                  // SPY EMA-50 regime gate
const SPY_SAFE_HAVEN_MULT = 0.5;     // SPY < EMA50 → half size

// ── TIME-STOP: generous 60-bar backstop ONLY (pre-scale-out). NO FAST-KILL. ──
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
const BASE_RISK_PCT = 0.01;          // 1% base risk per trade (× SPY-mult × VIX-mult)

// ── DUAL RETURN: 1.0× as-sized; 1.9× = each trade $ P&L ×1.9 on the curve. ──
const LEV_MULT = 1.9;
const MARGIN_CALL_DD = 0.40;         // 1.9× peak-to-trough > 40% → marginCallFlag

// ─── Friction model (REALISTIC) ───────────────────────────────────────────────
const SLIPPAGE_BPS = 0.0005;         // 5 bps adverse on entry AND every exit fill
const COMMISSION_PER_SIDE = 1.0;     // flat $1/side on the implied (baseline-size) share count

// ─── Windows: BOTH calendar-2025 AND 2026-onward ──────────────────────────────
interface WindowDef { label: string; start: string; end: string; tradelog: string; }
const WINDOWS: WindowDef[] = [
  { label: "CY-2025", start: "2025-01-01", end: "2025-12-31", tradelog: "/tmp/elza-v45-golden-2025-tradelog.md" },
  { label: "CY-2026", start: "2026-01-01", end: "2099-12-31", tradelog: "/tmp/elza-v45-golden-2026-tradelog.md" },
];
const EARLIEST_WINDOW_START = WINDOWS[0].start;
const LATEST_WINDOW_END = WINDOWS[WINDOWS.length - 1].end;

type FrictionMode = "FRICTIONLESS" | "REALISTIC";

// ════════════════════════════════════════════════════════════════════════════
// SPY-EMA50 + ^VIX guard maps. Built once in main() from daily bars; consulted
// per-entry-date during candidate generation. spyMult ∈ {1.0, 0.5}; vix → block
// or mult ∈ {1.0, 0.70}. Date-keyed on the same daily closes used for SPY bench.
// ════════════════════════════════════════════════════════════════════════════
interface GuardMaps {
  spyMultByDate: Map<string, number>;   // entryDate → 1.0 (Attack) | 0.5 (Safe Haven)
  vixCloseByDate: Map<string, number>;  // entryDate → that day's VIX close
}
let GUARDS: GuardMaps = { spyMultByDate: new Map(), vixCloseByDate: new Map() };

/** SPY EMA-50 regime map: for each SPY bar date, 1.0 if close > EMA50(as-of), else 0.5. */
function buildSpyMultMap(spyBars: Bar[]): Map<string, number> {
  const out = new Map<string, number>();
  const sorted = [...spyBars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const closes: number[] = [];
  for (const b of sorted) {
    closes.push(b.close);
    const ema = calcEMA(closes, Math.min(SPY_EMA, closes.length));
    out.set(b.date, b.close > ema ? 1.0 : SPY_SAFE_HAVEN_MULT);
  }
  return out;
}

/** ^VIX close map: entry date → that day's VIX close. */
function buildVixCloseMap(vixBars: Bar[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of vixBars) if (b.close > 0) out.set(b.date, b.close);
  return out;
}

/**
 * Resolve the SPY size-mult for an entry date. If the exact date is absent
 * (holiday/non-session alignment) fall back to the most recent prior SPY date.
 */
function spyMultForDate(date: string): number {
  const m = GUARDS.spyMultByDate;
  if (m.has(date)) return m.get(date)!;
  let best: string | null = null;
  for (const d of m.keys()) if (d <= date && (best === null || d > best)) best = d;
  return best === null ? 1.0 : m.get(best)!;
}

/**
 * Resolve the VIX close for an entry date (most-recent-prior fallback).
 * Returns null only if no VIX data exists at/before the date.
 */
function vixCloseForDate(date: string): number | null {
  const m = GUARDS.vixCloseByDate;
  if (m.has(date)) return m.get(date)!;
  let best: string | null = null;
  for (const d of m.keys()) if (d <= date && (best === null || d > best)) best = d;
  return best === null ? null : m.get(best)!;
}

// ════════════════════════════════════════════════════════════════════════════
// GENESIS SCORING — copied verbatim from elzaV41ParabolicLock.ts (v1.0 spec),
// EXCEPT the Breakout-Override tier (price<EMA200) is DROPPED: §0 macro guard
// requires price > EMA200, so only Gold Retest (Tier-3) + Gold Breakout (Tier-4).
// ════════════════════════════════════════════════════════════════════════════

interface GenesisScore {
  tier: "Gold Retest" | "Gold Breakout" | null;
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
 * Precedence: Gold Breakout → Gold Retest. tier===null → no signal.
 * Breakout-Override (price<EMA200) intentionally OMITTED — §0 EMA-200 macro guard.
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
  // (Breakout-Override DROPPED: it requires price<EMA200, which violates the §0 macro guard.)

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
// passes (i) totalScore>=7.0, (ii) confluence>=4.5 & liquidity>=2.0, (iii) RC-2,
// and is NOT VIX-blocked. The forward exit walk is the GOLDEN 5:1 ladder, NO
// fast-kill, 60-bar backstop. The SPY/VIX SIZE-mults are stored on the candidate
// and applied to the 1% base risk inside the portfolio sim. Friction is applied
// later per-mode from the recorded fill LEVELS & fractions.
// ════════════════════════════════════════════════════════════════════════════

type ExitReason =
  | "SL"          // full stop pre-scale-out (−1R)
  | "TIME"        // 60-bar backstop (pre-scale-out)
  | "STOP_BE"     // breakeven stop on the 60% runner after scale-out
  | "TP_FINAL"    // runner reached +5.0R
  | "TRAIL"       // wide Chandelier on the 60% runner
  | "TRAIL_OPEN"  // runner still open at last bar → mark at close
  | "OPEN";       // never scaled out and ran out of bars → mark at close

interface Candidate {
  ticker: string;
  sector: string;
  entryDate: string;
  exitDate: string;
  tier: string;
  totalScore: number;        // conviction rank key
  entry: number;
  sl: number;                // initial SL = max(entry×0.92, EMA50×0.99). R = entry − sl.
  exitReason: ExitReason;

  // §2 guard mults (applied to the 1% base risk in the portfolio sim).
  spyMult: number;           // 1.0 (Attack) | 0.5 (Safe Haven)
  vixMult: number;           // 1.0 | 0.70
  vixClose: number;          // VIX close mapped to entry date (for the recorder)
  safeHaven: boolean;        // spyMult === 0.5

  // Scale-out flag + the EXIT LEVEL for the banked/open fractions.
  scaledOut: boolean;        // +2.5R reached (banked 40% @ scaleTarget)
  scaleTarget: number;       // +2.5R price (scale-out bank level)
  // Exit level for whatever fraction was OPEN when the trade closed:
  //   pre-scale-out → openFrac=1.00 exits at openExitPrice (SL/TIME/OPEN)
  //   post-scale-out→ openFrac=0.60 exits at openExitPrice (STOP_BE/TP_FINAL/TRAIL)
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
 *   Scale-out (40%): +0.40 × 2.5R                           (banked at scaleTarget = +1.0R)
 *   runner (60%):    +0.60 × (openExitPrice − entry)/R       (SL/BE/TP_FINAL/trail/close)
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

  // Golden scale-out banked 40% @ scaleTarget (+2.5R).
  if (c.scaledOut) {
    const fs = sell(c.scaleTarget);
    r += SCALE_BANK_FRAC * ((fs - entryFill) / risk);
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
    const sharesFull = (BASE_RISK_PCT * START_EQUITY) / riskPerShare; // baseline implied shares
    const commR_perSide = sharesFull > 0 ? COMMISSION_PER_SIDE / (sharesFull * riskPerShare) : 0;
    const sides = 1 /* entry */ + exitSides;
    r -= sides * commR_perSide;
  }

  return Math.round(r * 100) / 100;
}

/**
 * Walk ONE ticker's bars, emit a Candidate per qualifying bar.
 * Entry gates: totalScore>=7.0, confluence>=4.5, liquidity>=2.0, RC-2 (<=12%),
 * VIX<=35 (VIX>35 BLOCKS — counted, not emitted).
 *
 * §1 WIDE-LUNG STOP: initialSL = max(entry × 0.92, EMA50 × 0.99). R = entry − SL.
 *
 * §3 GOLDEN 5:1 EXIT. SL-FIRST-ON-TIE strict at every phase:
 *   • Pre-scale-out (full size, stop=initial SL = −1R): if low<=stop → SL fills even
 *     if high>=scaleTarget the same bar (do NOT bank +2.5R). Else if high>=scaleTarget
 *     → scale out: bank 40% @ +2.5R, move stop on remaining 60% to BREAKEVEN.
 *   • Post-scale-out (60% open, stop=breakeven, wide Chandelier active): if low<=stop →
 *     STOP_BE/TRAIL fills the 60% even if high>=TP_FINAL the same bar. Else if
 *     high>=TP_FINAL (+5.0R) → TP_FINAL fills the 60% @ +5.0R.
 *   • 60-bar backstop applies pre-scale-out only; the runner trails with no time-stop.
 *
 * MFE_R (FLIGHT RECORDER): running max of (barHigh − entry)/R over the WHOLE held window.
 */
async function generateCandidates(
  ticker: string,
  bars: Bar[],
  out: Candidate[],
  blockedCounter: { vixBlocked: number; blockedDates: string[] },
): Promise<void> {
  let i = 0;
  while (i < bars.length && bars[i].date < EARLIEST_WINDOW_START) i++;

  for (; i < bars.length; i++) {
    if (i + 1 < MIN_BARS) continue;
    // entries only within the union of both windows [2025-01-01 .. latest].
    if (bars[i].date > LATEST_WINDOW_END) break;

    const gs = genesisScore(bars, i);
    if (gs.tier === null) continue;

    // ── ENTRY GATE 1 — TRUE v1.0 score floor. ──
    if (!(gs.totalScore >= LONG_ENTRY_MIN_SCORE)) continue;

    // Entry = signal-bar CLOSE (NO limit offset).
    const entry = bars[i].close;
    if (!(entry > 0)) continue;

    // §0 macro guard is baked into the tiers (both require price > EMA200), but assert it.
    if (!(entry > gs.ema200)) continue;

    // ── ENTRY GATE 2 — confluence & liquidity (REAL, causal from bars[0..i]). ──
    const intel = await getTickerIntelligence(ticker, bars.slice(0, i + 1));
    if (!(intel.confluenceScore >= MIN_CONFLUENCE)) continue;
    if (!(intel.liquidityScore >= MIN_LIQUIDITY_SCORE)) continue;

    // ── §2 VIX BLOCK guard — VIX>35 skips the entry entirely (counted). ──
    const vixClose = vixCloseForDate(bars[i].date);
    if (vixClose != null && vixClose > VIX_BLOCK) { blockedCounter.vixBlocked++; blockedCounter.blockedDates.push(bars[i].date); continue; }
    const vixMult = (vixClose != null && vixClose > VIX_HALF) ? VIX_MID_MULT : 1.0;

    // ── §2 SPY EMA-50 regime size-mult. ──
    const spyMult = spyMultForDate(bars[i].date);

    // ── §1 WIDE-LUNG STOP: max(entry×0.92, EMA50×0.99). ──
    const sl = Math.max(entry * STOP_ENTRY_FLOOR_MULT, gs.ema50 * STOP_EMA50_MULT);
    if (!(sl < entry)) continue;
    const stopDistPct = (entry - sl) / entry;
    // RC-2 retained (won't bind: risk ≤ 8% by the entry-floor leg).
    if (stopDistPct * 100 > RC2_MAX_RISK_PCT) continue;

    const risk = entry - sl;
    const scaleTarget = entry + SCALE_R * risk;     // +2.5R
    const tpFinal = entry + TP_FINAL_R * risk;      // +5.0R

    // ── EXIT walk-forward — Golden 5:1 ladder + 60-bar backstop. ──
    let exitDate = bars[bars.length - 1].date;
    let exitReason: ExitReason = "OPEN";

    let scaledOut = false;
    let openFrac = 1.0;          // fraction of ORIGINAL position still open
    let openExitPrice = entry;

    let currentStop = sl;        // pre-scale-out stop = initial SL (−1R)
    let highestHigh = bars[i].high;
    let trailStop = -Infinity;
    let mfeR = 0;
    let closedOut = false;

    for (let j = i + 1; j < bars.length; j++) {
      const bar = bars[j];
      const heldBars = j - i;

      const excursionR = risk > 0 ? (bar.high - entry) / risk : 0;
      if (excursionR > mfeR) mfeR = excursionR;

      if (!scaledOut) {
        // PHASE 1: full size, stop at initial SL (−1R). SL-FIRST-ON-TIE strict.
        if (bar.low <= currentStop) {
          exitReason = "SL"; exitDate = bar.date;
          openFrac = 1.0; openExitPrice = currentStop; closedOut = true;
          break;
        }
        if (bar.high >= scaleTarget) {
          // Golden Scale-Out: bank 40% @ +2.5R; move stop on remaining 60% to BREAKEVEN;
          // arm the WIDE Chandelier on the runner.
          scaledOut = true;
          openFrac = RUNNER_FRAC;
          currentStop = entry; // breakeven
          highestHigh = Math.max(highestHigh, bar.high);
          const atr = computeAtr14Local(bars.slice(0, j + 1));
          trailStop = (atr != null && atr > 0)
            ? Math.max(entry, highestHigh - CHANDELIER_ATR_MULT * atr)
            : entry;
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
      } else {
        // PHASE 2: 60% runner. WIDE Chandelier max(prior, highHigh − 2.5×ATR14) ≥ breakeven.
        // Target +5.0R. SL-FIRST-ON-TIE strict (stop fills before TP on a same-bar tie).
        highestHigh = Math.max(highestHigh, bar.high);
        const atr = computeAtr14Local(bars.slice(0, j + 1));
        if (atr != null && atr > 0) {
          trailStop = Math.max(trailStop, highestHigh - CHANDELIER_ATR_MULT * atr);
        }
        currentStop = Math.max(currentStop, trailStop); // never below breakeven

        if (bar.low <= currentStop) {
          // breakeven or trail — whichever the stop has ratcheted to.
          exitReason = currentStop <= entry ? "STOP_BE" : "TRAIL";
          exitDate = bar.date;
          openFrac = RUNNER_FRAC; openExitPrice = currentStop; closedOut = true;
          break;
        }
        if (bar.high >= tpFinal) {
          exitReason = "TP_FINAL"; exitDate = bar.date;
          openFrac = RUNNER_FRAC; openExitPrice = tpFinal; closedOut = true;
          break;
        }
        if (j === bars.length - 1) {
          exitReason = "TRAIL_OPEN"; exitDate = bar.date;
          openFrac = RUNNER_FRAC; openExitPrice = bar.close; closedOut = true;
        }
      }
    }

    // Entry on the very last bar: no forward bar → mark flat OPEN at entry.
    if (i === bars.length - 1 && !closedOut) {
      exitDate = bars[i].date; exitReason = "OPEN";
      scaledOut = false;
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
      spyMult,
      vixMult,
      vixClose: vixClose ?? 0,
      safeHaven: spyMult === SPY_SAFE_HAVEN_MULT,
      scaledOut,
      scaleTarget,
      openFrac,
      openExitPrice,
      stopDistPct,
      mfeR: Math.round(mfeR * 100) / 100,
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PORTFOLIO SIM — CONVICTION-RANKED auction. Net (1.0×) is as-sized with the
// per-entry guard mults (1% × spyMult × vixMult). The 1.9× column re-runs the
// SAME book but amplifies each trade's $ P&L ×1.9 on its own equity curve.
// ════════════════════════════════════════════════════════════════════════════

interface OpenPos {
  ticker: string; sector: string; notional: number; riskDollars: number;
  pnl: number;       // 1.0× $ P&L for this trade (already includes guard mults)
  pnlLev: number;    // 1.9× $ P&L (= pnl × 1.9) for the leveraged curve
  exitDate: string; candIdx: number;
}
interface ClosedTrade {
  ticker: string; entryDate: string; exitDate: string; exitReason: ExitReason;
  r: number; pnl: number; skipped: boolean; mfeR: number;
  spyMult: number; vixMult: number; vixClose: number; safeHaven: boolean;
}
interface CellResult {
  windowLabel: string;
  friction: FrictionMode;
  tradesTaken: number;
  wins: number;
  winPct: number;
  totalR: number;
  // 1.0× curve
  finalReturnPct: number;
  maxDrawdownPct: number;
  finalEquity: number;
  // 1.9× curve (same book, $ P&L ×1.9)
  finalReturnPctLev: number;
  maxDrawdownPctLev: number;
  finalEquityLev: number;
  marginCallFlag: boolean;
  exitBreakdown: Record<string, number>;
  closed: ClosedTrade[];          // FLIGHT RECORDER — taken trades only
  safeHavenEntries: number;       // §2 stat — count of half-size (SPY<EMA50) entries TAKEN
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

  // 1.0× book equity (also the SIZING book — both mults size off this curve).
  let equity = START_EQUITY;
  let peakEquity = START_EQUITY;
  let maxDrawdownPct = 0;

  // 1.9× $-amplified curve (independent peak/trough; same trade $ ×1.9).
  let equityLev = START_EQUITY;
  let peakEquityLev = START_EQUITY;
  let maxDrawdownPctLev = 0;
  let marginCallFlag = false;

  const openByIdx = new Map<number, OpenPos>();
  const openTickers = new Set<string>();
  const closed: ClosedTrade[] = [];
  let safeHavenEntries = 0;

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
      if (equity > peakEquity) peakEquity = equity;
      const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;

      equityLev += pos.pnlLev;
      if (equityLev > peakEquityLev) peakEquityLev = equityLev;
      const ddLev = peakEquityLev > 0 ? (peakEquityLev - equityLev) / peakEquityLev : 0;
      if (ddLev > maxDrawdownPctLev) maxDrawdownPctLev = ddLev;
      if (ddLev > MARGIN_CALL_DD) marginCallFlag = true;

      const c = windowCands[idx];
      closed.push({
        ticker: c.ticker, entryDate: c.entryDate, exitDate: c.exitDate,
        exitReason: c.exitReason, r: rOf(c), pnl: pos.pnl, skipped: false, mfeR: c.mfeR,
        spyMult: c.spyMult, vixMult: c.vixMult, vixClose: c.vixClose, safeHaven: c.safeHaven,
      });
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
      // §2 final risk = 1% × spyMult × vixMult (compounding equity-based).
      let riskDollars = BASE_RISK_PCT * c.spyMult * c.vixMult * equityAtEntry;

      const heatAfter = (grossOpenRisk() + riskDollars) / (equityAtEntry > 0 ? equityAtEntry : 1);
      if (heatAfter > HEAT_CAP) {
        closed.push({
          ticker: c.ticker, entryDate: c.entryDate, exitDate: c.exitDate,
          exitReason: c.exitReason, r: rOf(c), pnl: 0, skipped: true, mfeR: c.mfeR,
          spyMult: c.spyMult, vixMult: c.vixMult, vixClose: c.vixClose, safeHaven: c.safeHaven,
        });
        continue;
      }

      let notional = riskDollars / c.stopDistPct;
      if (notional > MAX_POSITION_USD) {
        const scale = MAX_POSITION_USD / notional;
        notional *= scale; riskDollars *= scale;
      }
      // headroom on the 1.0× (sizing) book: leverage 1.0× per spec.
      const headroom = Math.max(0, 1.0 * equityAtEntry - grossOpenNotional());
      if (notional > headroom) {
        const scale = headroom > 0 ? headroom / notional : 0;
        notional *= scale; riskDollars *= scale;
      }

      const pnl = rOf(c) * riskDollars;
      openByIdx.set(idx, {
        ticker: c.ticker, sector: c.sector, notional, riskDollars,
        pnl, pnlLev: pnl * LEV_MULT, exitDate: c.exitDate, candIdx: idx,
      });
      openTickers.add(c.ticker);
      if (c.safeHaven) safeHavenEntries++;
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
    finalReturnPctLev: ((equityLev - START_EQUITY) / START_EQUITY) * 100,
    maxDrawdownPctLev: maxDrawdownPctLev * 100,
    finalEquityLev: Math.round(equityLev),
    marginCallFlag,
    exitBreakdown,
    closed: taken,
    safeHavenEntries,
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
// FLIGHT RECORDER — per-trade log (Window | Ticker | EntryDate | ExitDate | MFE_R |
// FinalNetR(1.0×, realistic) | ExitReason | SPY×/VIX× | VIX), sorted by EntryDate.
// Printed to stdout AND written to the per-window /tmp path.
// ════════════════════════════════════════════════════════════════════════════
function buildFlightRecorder(windowLabel: string, realClosed: ClosedTrade[]): { stdout: string; markdown: string } {
  const rows = [...realClosed].sort((a, b) =>
    a.entryDate < b.entryDate ? -1
      : a.entryDate > b.entryDate ? 1
      : (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0),
  );

  // ── stdout fixed-width table. ──
  const head =
    `  ${pad("Win", 9)}${pad("Ticker", 8)}${pad("EntryDate", 13)}${pad("ExitDate", 13)}` +
    `${padL("MFE_R", 9)}${padL("FinalNetR", 12)}${padL("SPY×", 7)}${padL("VIX×", 7)}${padL("VIX", 8)}  ExitReason`;
  const sep = `  ${"─".repeat(92)}`;
  const lines = [head, sep];
  for (const t of rows) {
    lines.push(
      `  ${pad(windowLabel, 9)}${pad(t.ticker, 8)}${pad(t.entryDate, 13)}${pad(t.exitDate, 13)}` +
      `${padL(sign(t.mfeR) + t.mfeR.toFixed(2), 9)}` +
      `${padL(sign(t.r) + t.r.toFixed(2), 12)}` +
      `${padL(t.spyMult.toFixed(2), 7)}${padL(t.vixMult.toFixed(2), 7)}${padL(t.vixClose.toFixed(1), 8)}  ${t.exitReason}`,
    );
  }
  const stdout = lines.join("\n");

  // ── markdown table. ──
  const md: string[] = [];
  md.push(`# Elza v4.5 "Golden DNA" — Flight Recorder (per closed trade) — ${windowLabel}`);
  md.push("");
  md.push(`Generated ${new Date().toISOString()} — READ-ONLY simulation. LONG-ONLY. FinalNetR is the 1.0× REALISTIC net R (after 5bps/side + $1/side commission). MFE_R is daily-bar max favorable excursion in R (overstated vs intraday). SPY× = SPY-EMA50 regime size-mult (0.50 = Safe Haven). VIX× = VIX-band size-mult (0.70 = elevated). VIX = VIX close mapped to the entry date.`);
  md.push("");
  md.push(`| Window | Ticker | EntryDate | ExitDate | MFE_R | FinalNetR (1.0x) | SPY× | VIX× | VIX | ExitReason |`);
  md.push(`|--------|--------|-----------|----------|------:|-----------------:|-----:|-----:|----:|------------|`);
  for (const t of rows) {
    md.push(`| ${windowLabel} | ${t.ticker} | ${t.entryDate} | ${t.exitDate} | ${sign(t.mfeR)}${t.mfeR.toFixed(2)} | ${sign(t.r)}${t.r.toFixed(2)} | ${t.spyMult.toFixed(2)} | ${t.vixMult.toFixed(2)} | ${t.vixClose.toFixed(1)} | ${t.exitReason} |`);
  }
  md.push("");
  md.push(`Total closed trades: ${rows.length}.`);
  const markdown = md.join("\n");

  return { stdout, markdown };
}

// ─── Per-window summary printer ───────────────────────────────────────────────
function reportWindow(
  win: WindowDef,
  wc: Candidate[],
  cell: CellResult,
  fric1x: CellResult,
  spy: SpyResult | null,
  vixBlockedInWindow: number,
): void {
  console.log("");
  console.log(`══════════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`═══ v4.5 Golden DNA — ${win.label} — REALISTIC headline (LONG only) — DUAL RETURN vs SPY ═══`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  candidates-in-window: ${wc.length}`);
  console.log("");
  console.log(
    `  ${pad("row", 12)}${padL("trades", 8)}${padL("win%", 9)}${padL("totalR", 10)}` +
    `${padL("return%", 11)}${padL("maxDD%", 10)}${padL("finalEq$", 14)}  flags`,
  );
  console.log(`  ${"─".repeat(86)}`);

  // Net 1.0×
  console.log(
    `  ${pad("Net 1.0x", 12)}${padL(cell.tradesTaken, 8)}${padL(cell.winPct.toFixed(1) + "%", 9)}` +
    `${padL(sign(cell.totalR) + cell.totalR.toFixed(2), 10)}` +
    `${padL(sign(cell.finalReturnPct) + cell.finalReturnPct.toFixed(2) + "%", 11)}` +
    `${padL(cell.maxDrawdownPct.toFixed(2) + "%", 10)}` +
    `${padL("$" + cell.finalEquity.toLocaleString(), 14)}`,
  );
  // Leveraged 1.9×
  console.log(
    `  ${pad("Leveraged 1.9x", 12)}${padL(cell.tradesTaken, 8)}${padL(cell.winPct.toFixed(1) + "%", 9)}` +
    `${padL(sign(cell.totalR * LEV_MULT) + (cell.totalR * LEV_MULT).toFixed(2), 10)}` +
    `${padL(sign(cell.finalReturnPctLev) + cell.finalReturnPctLev.toFixed(2) + "%", 11)}` +
    `${padL(cell.maxDrawdownPctLev.toFixed(2) + "%", 10)}` +
    `${padL("$" + cell.finalEquityLev.toLocaleString(), 14)}` +
    `  ${cell.marginCallFlag ? "marginCall=YES" : "marginCall=no"}`,
  );
  // SPY
  if (spy) {
    console.log(
      `  ${pad("SPY", 12)}${padL("-", 8)}${padL("-", 9)}${padL("-", 10)}` +
      `${padL(sign(spy.returnPct) + spy.returnPct.toFixed(2) + "%", 11)}` +
      `${padL(spy.maxDDPct.toFixed(2) + "%", 10)}` +
      `${padL("$" + spy.finalEquity.toLocaleString(), 14)}  buy&hold`,
    );
  } else {
    console.log(`  ${pad("SPY", 12)}${padL("- (no bars in window → INDETERMINATE)", 62)}`);
  }

  console.log("");
  console.log(`  (reference) Net 1.0× FRICTIONLESS return%: ${sign(fric1x.finalReturnPct)}${fric1x.finalReturnPct.toFixed(2)}%`);

  // ── §2 guard stats. ──
  console.log("");
  console.log(`  ── §2 GUARD STATS (${win.label}) ──`);
  console.log(`     VIX-blocked entries (VIX>${VIX_BLOCK}, skipped): ${vixBlockedInWindow}`);
  console.log(`     Safe-Haven half-size entries TAKEN (SPY<EMA${SPY_EMA}, ×${SPY_SAFE_HAVEN_MULT}): ${cell.safeHavenEntries}`);

  // ── exit-reason breakdown (1.0× book). ──
  console.log("");
  console.log(`  ── exit-reason breakdown (Net 1.0× REALISTIC book) ──`);
  const eb = cell.exitBreakdown;
  console.log(`     SL=${eb["SL"] ?? 0}  TIME(${GENESIS_TIME_STOP_BARS}bar)=${eb["TIME"] ?? 0}  STOP_BE=${eb["STOP_BE"] ?? 0}  TP_FINAL=${eb["TP_FINAL"] ?? 0}  TRAIL=${eb["TRAIL"] ?? 0}  TRAIL_OPEN=${eb["TRAIL_OPEN"] ?? 0}  OPEN=${eb["OPEN"] ?? 0}`);

  // ── VERDICT vs SPY (1.0×). ──
  console.log("");
  console.log(`  ── VERDICT (${win.label}) ──`);
  if (spy == null) {
    console.log(`     [SKIP] No SPY bars in window → SPY comparison INDETERMINATE.`);
    console.log(`     Net 1.0× = ${sign(cell.finalReturnPct)}${cell.finalReturnPct.toFixed(2)}% at DD ${cell.maxDrawdownPct.toFixed(2)}%.`);
  } else {
    const diff = cell.finalReturnPct - spy.returnPct;
    const verdict = diff >= 0 ? "BEATS" : "LOSES";
    console.log(`     Net 1.0× ${verdict} SPY by ${Math.abs(diff).toFixed(2)} pts [${sign(cell.finalReturnPct)}${cell.finalReturnPct.toFixed(2)}% vs SPY ${sign(spy.returnPct)}${spy.returnPct.toFixed(2)}%; DD ${cell.maxDrawdownPct.toFixed(2)}% vs SPY ${spy.maxDDPct.toFixed(2)}%].`);
  }
  console.log(`     Leveraged 1.9× = ${sign(cell.finalReturnPctLev)}${cell.finalReturnPctLev.toFixed(2)}% at DD ${cell.maxDrawdownPctLev.toFixed(2)}% (margin-call risk: ${cell.marginCallFlag ? "YES" : "no"}).`);
}

// ─── Shared dataset builder (exported for leverage A/B harness) ───────────────
export type { Candidate, ExitReason, FrictionMode, WindowDef };
export {
  computeTradeR,
  candsForWindow,
  WINDOWS,
  START_EQUITY,
  LEV_MULT,
  MARGIN_CALL_DD,
  BASE_RISK_PCT,
  HEAT_CAP,
  MAX_POSITION_USD,
  MAX_PER_SECTOR,
  MAX_CONCURRENT,
  SCALE_BANK_FRAC,
  RUNNER_FRAC,
  SCALE_R,
  TP_FINAL_R,
  SLIPPAGE_BPS,
  COMMISSION_PER_SIDE,
  GENESIS_TIME_STOP_BARS,
  CHANDELIER_ATR_MULT,
  computeAtr14Local,
};

export interface GoldenDataset {
  cands: Candidate[];
  barsByTicker: Map<string, Bar[]>;
  blockedCounter: { vixBlocked: number; blockedDates: string[] };
}

export async function buildGoldenDataset(): Promise<GoldenDataset> {
  const catalog = await getCatalogTickers(1);
  for (const a of catalog) SECTOR_BY_TICKER[a.ticker] = a.sector;
  const TICKERS: string[] = catalog.map((a) => a.ticker);

  let spyBars: Bar[] = [];
  try {
    spyBars = await fetchBarsForTicker("SPY", BARS_DAYS);
    spyBars = [...spyBars].sort((a, b) => (a.date < b.date ? -1 : 1));
  } catch {
    spyBars = [];
  }

  let vixBars: Bar[] = [];
  try {
    vixBars = await fetchBarsForTicker("^VIX", BARS_DAYS);
    vixBars = [...vixBars].sort((a, b) => (a.date < b.date ? -1 : 1));
  } catch {
    vixBars = [];
  }

  GUARDS = {
    spyMultByDate: buildSpyMultMap(spyBars),
    vixCloseByDate: buildVixCloseMap(vixBars),
  };

  const barsByTicker = new Map<string, Bar[]>();
  for (const ticker of TICKERS) {
    try {
      let bars = await fetchBarsForTicker(ticker, BARS_DAYS);
      if (!bars || bars.length < MIN_BARS) continue;
      bars = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const lastDate = bars[bars.length - 1].date;
      if (lastDate < EARLIEST_WINDOW_START) continue;
      const warmupBefore = bars.filter((b) => b.date < EARLIEST_WINDOW_START).length;
      if (warmupBefore < MIN_BARS) continue;
      barsByTicker.set(ticker, bars);
    } catch {
      continue;
    }
  }

  const cands: Candidate[] = [];
  const blockedCounter = { vixBlocked: 0, blockedDates: [] as string[] };
  for (const ticker of barsByTicker.keys()) {
    await generateCandidates(ticker, barsByTicker.get(ticker)!, cands, blockedCounter);
  }

  return { cands, barsByTicker, blockedCounter };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`Elza v4.5 "Golden DNA" Backtest — Genesis-TRUE LONG-ONLY, wide-lung stop + macro/VIX guards + Golden 5:1 exit, dual-return — BOTH 2025 + 2026 — READ-ONLY (no DB writes, no IBKR, no orders, no SSH)`);

  // ── Resolve the LIVE scan universe (dynamic getCatalogTickers(1) ≈ 149 USA). ──
  const catalog = await getCatalogTickers(1);
  for (const a of catalog) SECTOR_BY_TICKER[a.ticker] = a.sector;
  const TICKERS: string[] = catalog.map(a => a.ticker);
  console.log("[CATALOG] live universe: " + TICKERS.length + " USA tickers (uid=1, US-only, non-IPO) — expected ~149 (catalog parity).");

  console.log(`Scoring: FRESH genesisScore (NOT calcZivEngineScore). LONG-ONLY — NO SHORT ENGINE.`);
  console.log(`ENTRY GATES (Genesis-TRUE v1.0): totalScore >= ${LONG_ENTRY_MIN_SCORE} AND confluenceScore >= ${MIN_CONFLUENCE} AND liquidityScore >= ${MIN_LIQUIDITY_SCORE}. Entry = signal-bar CLOSE (no offset).`);
  console.log(`  §0 EMA-200 macro guard: price > EMA200 (Tier-3 Retest + Tier-4 Breakout active; Breakout-Override dropped).`);
  console.log(`§1 WIDE-LUNG STOP (all trades): initialSL = max(entry × ${STOP_ENTRY_FLOOR_MULT}, EMA50 × ${STOP_EMA50_MULT}). R = entry − SL. RC-2 >${RC2_MAX_RISK_PCT}% skip retained (won't bind; risk ≤ 8%).`);
  console.log(`§2 GUARDS (size on 1% base): SPY>EMA${SPY_EMA} → Attack ×1.0 | SPY<EMA${SPY_EMA} → Safe Haven ×${SPY_SAFE_HAVEN_MULT}. VIX>${VIX_BLOCK} → BLOCK | VIX in (${VIX_HALF},${VIX_BLOCK}] → ×${VIX_MID_MULT} | VIX ≤ ${VIX_HALF} → ×1.0. Final risk = 1% × spyMult × vixMult.`);
  console.log(`§3 GOLDEN 5:1 EXIT: TP final +${TP_FINAL_R}R. Scale-out @+${SCALE_R}R sell ${SCALE_BANK_FRAC * 100}% (bank +1.0R) → stop on ${RUNNER_FRAC * 100}% to BREAKEVEN. Runner → +${TP_FINAL_R}R OR wide Chandelier max(prior, highHigh − ${CHANDELIER_ATR_MULT}×ATR${ATR_PERIOD}). Pre-scale full stop = −1R. SL-FIRST-ON-TIE. ${GENESIS_TIME_STOP_BARS}-bar backstop.`);
  console.log(`Portfolio: $${START_EQUITY.toLocaleString()} compounding, base risk ${BASE_RISK_PCT * 100}% × guards, leverage 1.0×, maxConcurrent ${MAX_CONCURRENT}, maxPerSector ${MAX_PER_SECTOR}, heat ≤ ${HEAT_CAP * 100}%, maxPos $${MAX_POSITION_USD.toLocaleString()}.`);
  console.log(`DUAL RETURN: Net 1.0× as-sized | Leveraged 1.9× = each trade $ P&L ×${LEV_MULT} on its own curve (marginCallFlag if DD > ${MARGIN_CALL_DD * 100}%).`);
  console.log(`Windows: ${WINDOWS.map(w => `${w.label} [${w.start}..${w.end === LATEST_WINDOW_END ? "last" : w.end}]`).join("  AND  ")}. SPY buy&hold per window.`);
  console.log("");

  // ── SPY once (benchmark + §2 SPY-EMA50 regime map). ──
  let spyBars: Bar[] = [];
  try {
    spyBars = await fetchBarsForTicker("SPY", BARS_DAYS);
    spyBars = [...spyBars].sort((a, b) => (a.date < b.date ? -1 : 1));
    console.log(`[SPY] fetched ${spyBars.length} bars for benchmark + EMA50 regime map.`);
  } catch (e) {
    console.log(`[WARN] SPY fetch failed: ${(e as Error).message ?? e}. SPY benchmark + regime map will be empty (spyMult defaults ×1.0).`);
  }

  // ── ^VIX once (§2 block/size guard). Same Yahoo chart path as SPY (interval=1d). ──
  let vixBars: Bar[] = [];
  try {
    vixBars = await fetchBarsForTicker("^VIX", BARS_DAYS);
    vixBars = [...vixBars].sort((a, b) => (a.date < b.date ? -1 : 1));
    console.log(`[VIX] fetched ${vixBars.length} ^VIX daily bars for the macro/VIX guard.`);
    if (vixBars.length === 0) {
      console.log(`[WARN] ^VIX returned 0 bars — VIX guard DISABLED (no block, vixMult defaults ×1.0). VERIFY the ^VIX fetch path before trusting guard stats.`);
    }
  } catch (e) {
    console.log(`[WARN] ^VIX fetch failed: ${(e as Error).message ?? e}. VIX guard DISABLED (no block, vixMult defaults ×1.0).`);
  }

  // Build the guard maps once.
  GUARDS = {
    spyMultByDate: buildSpyMultMap(spyBars),
    vixCloseByDate: buildVixCloseMap(vixBars),
  };

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

  // Build candidates (single Genesis-TRUE config across BOTH windows' union).
  const cands: Candidate[] = [];
  const blockedCounter = { vixBlocked: 0, blockedDates: [] as string[] };
  let n = 0;
  for (const ticker of usableTickers) {
    n++;
    if (n % 20 === 0) {
      console.log(`[PROGRESS-SCORE] ${n}/${usableTickers.length} tickers scored (${cands.length} candidates so far).`);
    }
    await generateCandidates(ticker, barsByTicker.get(ticker)!, cands, blockedCounter);
  }
  console.log(`[DONE BUILDING] ${cands.length} candidates (Genesis-TRUE, 2025+2026 entries). VIX-blocked (all windows): ${blockedCounter.vixBlocked}.`);

  // ── Per-window runs. ──
  for (const win of WINDOWS) {
    const wc = candsForWindow(cands, win.start, win.end);
    const cell  = runPortfolio(wc, "REALISTIC", win.label);
    const fric  = runPortfolio(wc, "FRICTIONLESS", win.label);
    const spy   = computeSpyBenchmark(win.label, spyBars, win.start, win.end);

    // VIX-blocked count attributable to THIS window's entry-date range (honest per-window split).
    const vixBlockedInWindow = blockedCounter.blockedDates
      .filter(d => d >= win.start && d <= win.end).length;
    reportWindow(win, wc, cell, fric, spy, vixBlockedInWindow);

    // ── FLIGHT RECORDER (per window) — print + write file. ──
    const fr = buildFlightRecorder(win.label, cell.closed);
    console.log("");
    console.log(`══════════════════════════════════════════════════════════════════════════════════════════`);
    console.log(`═══ FLIGHT RECORDER — ${win.label} (Win | Ticker | Entry | Exit | MFE_R | FinalNetR[1.0×] | SPY× | VIX× | VIX | ExitReason) ═══`);
    console.log(`══════════════════════════════════════════════════════════════════════════════════════════`);
    console.log(fr.stdout);
    try {
      writeFileSync(win.tradelog, fr.markdown, "utf8");
      console.log("");
      console.log(`[FLIGHT RECORDER] ${win.label}: wrote ${cell.closed.length} trades → ${win.tradelog}`);
    } catch (e) {
      console.log(`[WARN] flight-recorder write failed (${win.tradelog}): ${(e as Error).message ?? e}`);
    }

    // Machine-readable per-window line.
    console.log("");
    console.log(`[JSON ${win.label}] ${JSON.stringify({
      window: win.label,
      candidates: wc.length,
      net1x: {
        trades: cell.tradesTaken,
        winPct: Math.round(cell.winPct * 10) / 10,
        totalR: cell.totalR,
        returnPct: Math.round(cell.finalReturnPct * 100) / 100,
        maxDDPct: Math.round(cell.maxDrawdownPct * 100) / 100,
        finalEquity: cell.finalEquity,
        exitBreakdown: cell.exitBreakdown,
      },
      lev19x: {
        returnPct: Math.round(cell.finalReturnPctLev * 100) / 100,
        maxDDPct: Math.round(cell.maxDrawdownPctLev * 100) / 100,
        finalEquity: cell.finalEquityLev,
        marginCallFlag: cell.marginCallFlag,
      },
      guards: {
        vixBlocked: vixBlockedInWindow,
        safeHavenEntries: cell.safeHavenEntries,
      },
      frictionless1xReturnPct: Math.round(fric.finalReturnPct * 100) / 100,
      spy: spy ? { returnPct: Math.round(spy.returnPct * 100) / 100, maxDDPct: Math.round(spy.maxDDPct * 100) / 100, finalEquity: spy.finalEquity } : null,
      flightRecorder: { path: win.tradelog, trades: cell.closed.length },
    })}`);
  }

  // Catalog parity.
  console.log("");
  console.log(`  [CATALOG PARITY] live universe = ${TICKERS.length} USA tickers (expected ~149).`);

  printDisclaimer();

  console.log("");
  console.log(`Done. 1 config (Genesis-TRUE entry, wide-lung stop, macro/VIX guards, Golden 5:1 exit) × {CY-2025, CY-2026} × {Net 1.0×, Leveraged 1.9×}. (Simulation only — no live actions taken.)`);
}

function printDisclaimer(): void {
  console.log("");
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`SIMPLIFICATIONS / DISCLAIMER — read before trusting any number above`);
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`  • DAILY-BAR STAGED EXITS / MFE OVERSTATE: the +2.5R scale-out, +5.0R TP, the wide Chandelier, and MFE_R`);
  console.log(`    all use DAILY highs/lows — the staged exits AND the recorded MFE_R are OVERSTATED vs intraday reality.`);
  console.log(`    Treat MFE_R as a CEILING and the staged P&L as optimistic on intraday whipsaw.`);
  console.log(`  • 1.9× $-AMPLIFIED CURVE UNDERSTATES RISK: the leveraged column simply multiplies each trade's $ P&L by`);
  console.log(`    1.9× on an independent equity curve. REAL 1.9× margin is WORSE: a CLUSTER GAP-DOWN on correlated`);
  console.log(`    high-beta names forces liquidation at the worst price, intraday maintenance-margin calls, and`);
  console.log(`    gap-through stops — none captured here. marginCallFlag (DD>40%) is a PROXY, not a guarantee; treat`);
  console.log(`    "marginCall=no" with suspicion on any correlated drawdown day. It AMPLIFIES DD and UNDERSTATES real`);
  console.log(`    margin / cluster-gap risk.`);
  console.log(`  • SURVIVORSHIP: the universe is the CURRENT catalog (getCatalogTickers(1)); de-listed/removed names that`);
  console.log(`    traded in 2025/2026 are NOT back-filled — a survivorship tilt that flatters returns.`);
  console.log(`  • NO MENTOR BOOST: the live +0..2.0 mentor boost is OMITTED, so the 7.0 floor is HARDER to clear here`);
  console.log(`    than live — these results UNDER-count entries.`);
  console.log(`  • VIX/SPY REGIME ON DAILY CLOSES: the §2 guards map SPY-EMA50 regime and the ^VIX block/size band on`);
  console.log(`    DAILY closes (most-recent-prior fallback on date misalignment). Intraday VIX spikes / SPY whipsaws`);
  console.log(`    that would have blocked or resized live are NOT captured.`);
  console.log(`  • LONG-ONLY: NO short engine; the live regime/breadth short-gate is not reproduced offline.`);
  console.log(`  • FRESH SCORING: genesisScore is implemented from the v1.0 spec, NOT the live v2.2 engine.`);
  console.log(`  • CONVICTION AUCTION is a per-CALENDAR-DAY ranking on totalScore; intraday entry timing is not modelled.`);
  console.log(`  • FRICTION IS APPROXIMATE: 5bps flat haircut on entry + each exit fill; commission-in-R at the BASELINE`);
  console.log(`    1%-risk full size (implied shares), NOT post-cap/post-guard size. REALISTIC is a FLOOR on cost.`);
  console.log(`  • SL-FIRST-ON-TIE (strict): any bar with low<=stop & high>=target fills the STOP, never the take-profit.`);
  console.log(`  • MAX_CORRELATION 0.80 pairwise gate is NOT reproduced offline; the per-sector cap (≤3) is a partial proxy.`);
  console.log(`  • 2026 WINDOW IS PARTIAL: it runs to the last available bar; trades still open at the last bar mark at`);
  console.log(`    close (OPEN/TRAIL_OPEN) — the 2026 numbers are an INCOMPLETE, in-progress year.`);
}

if (process.argv[1]?.includes("elzaV45GoldenDNA")) {
  main().catch((err) => {
    console.error(`[FATAL] ${(err as Error).stack ?? err}`);
    process.exit(1);
  });
}
