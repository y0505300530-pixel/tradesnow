/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║                        ZIV ENGINE v2.2                              ║
 * ║  Single source of truth for all Ziv scoring logic.                  ║
 * ║  Used by: Trading Lab (checkStatus) + Trade Manager (analyze*)      ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Tier System:
 *   Tier 1 — No Signal (1-3):        Price below EMA-200 or Weekly EMA-50 slope negative
 *   Tier 2 — Near Entry Watch (4-6):  Above EMA-200, no clear setup — watch for entry
 *   Tier 3 — Gold Retest (7-8):       Within 3% of EMA-50 in bullish trend — pullback entry
 *   Tier 4 — Gold Breakout (9-10):    At/above 20-day Donchian high with momentum
 *
 * v2.0 changes:
 *   - Richer decimal sub-score (0.00–0.99) with 6 components instead of 3
 *   - RSI 70-85 in Breakout = BONUS (not penalty) — momentum confirmation
 *   - New: EMA-20 > EMA-50 (Golden Cross) bonus
 *   - New: 52W High proximity bonus
 *   - New: ATR Contraction (coiling) bonus
 *   - New: Relative Strength vs recent high bonus
 *   - Pullback zone widened to 3% (from 2%) for more entries
 *   - Neutral tier split: Near-EMA (5-6.5) vs Extended (4-4.5)
 *
 * v2.1 changes:
 *   - New: Trend Strength component — EMA slope steepness + consecutive up-bars + price vs EMA-50 gap
 *   - New: Profit Potential component — upside room via Donchian channel width + ATR-based expected move
 *   - Sub-score now has 8 components (was 6)
 *
 * v2.2 changes:
 *   - New: Breakout Override Mode — when volume > 2x AND price at/above Donchian 20-day high,
 *     override the EMA-200 Trash filter and assign tier "Breakout Override" with base score 6.
 *     Rationale: high-volume breakouts above structure can succeed even below EMA-200 (recovery breakouts).
 *     These are flagged distinctly so traders know they carry higher risk.
 */

import { detectTrueRetest } from "./trueRetestEngine";
import { detectRoleReversal } from "./roleReversalEngine";

export type ZivTier = "No Signal" | "Near Entry Watch" | "Gold Retest" | "Gold Breakout" | "No Data" | "Error";

export interface Bar {
  date: string;
  close: number;
  high: number;
  low: number;
  open: number;
  volume?: number;
}

export interface ZivBreakdown {
  rsi: number;
  volume: number;
  proximity: number;
  goldenCross: number;
  high52w: number;
  atrContraction: number;
  trendStrength: number;
  profitPotential: number;
  total: number;
  isOverride: boolean;
}
export interface ZivScoreResult {
  score: number;
  tier: ZivTier;
  reason: string;
  price: number;
  ema50: number;
  ema200: number;
  donchian20High: number;
  weeklyEma50Slope: number;
  distToEma50Pct: number;
  priceAction: string | null;
  breakdown?: ZivBreakdown;
  /**
   * RC-2: the role-reversed level this Gold-Retest entry is retesting (broken
   * resistance now acting as support). Stop belongs JUST BELOW it (invalidation).
   * Null when the qualifying setup is not a structural retest/role-reversal.
   * Priority: True Retest (priorBreakoutLevel) > Role Reversal (level).
   */
  retestLevel?: number | null;
}

// ─── Math Helpers ─────────────────────────────────────────────────────────────

export function calcEMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

export function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const rs = gains / (losses || 0.0001);
  return 100 - 100 / (1 + rs);
}

// ─── Core Scoring Function ────────────────────────────────────────────────────

/**
 * Full Ziv Engine score: uses Donchian breakout, Weekly EMA-50 slope, and
 * bullish price action detection — identical to Trading Lab checkStatus logic.
 */
export function calcZivEngineScore(bars: Bar[]): ZivScoreResult {
  // ── Penny Stock Guard (runs before everything else) ────────────────────────
  const _lastClose = bars.length > 0 ? (bars[bars.length - 1]?.close ?? 0) : 0;
  const _avgVol    = bars.length > 0 ? bars.slice(-20).reduce((s, b) => s + (b.volume ?? 0), 0) / Math.min(20, bars.length) : 0;
  const _isIlliquid = _avgVol > 0 && _avgVol < 10000;

  if (_lastClose > 0 && _lastClose < 1.0) {
    const priceStr = _lastClose < 0.01 ? `$${_lastClose.toFixed(6)}` : `$${_lastClose.toFixed(4)}`;
    return {
      score: 1, tier: "No Signal" as ZivTier,
      price: _lastClose, ema50: _lastClose, ema200: _lastClose,
      donchian20High: _lastClose, weeklyEma50Slope: 0,
      distToEma50Pct: 0, priceAction: null,
      reason: `❌ PENNY STOCK: Price ${priceStr} is below the $1.00 minimum. Ziv Engine does not score penny stocks. Score: 1/10.`,
      zivHScore: null,
    } as ZivScoreResult;
  }

  if (bars.length < 50) {
    return {
      score: 1, tier: "No Data",
      reason: "Insufficient price history (need 50+ bars)",
      price: 0, ema50: 0, ema200: 0, donchian20High: 0,
      weeklyEma50Slope: 0, distToEma50Pct: 0, priceAction: null,
    };
  }

  const closes = bars.map(b => b.close);
  const lastClose = closes[closes.length - 1];
  const lastBar = bars[bars.length - 1];

  // ── EMAs ──
  const ema50 = calcEMA(closes, 50);
  const ema200 = closes.length >= 200 ? calcEMA(closes, 200) : calcEMA(closes, closes.length);

  // ── Weekly EMA-50 slope (compare now vs 4 weeks ago) ──
  const weeklyCloses = closes.filter((_, idx) => idx % 5 === 0);
  const weeklyEma50Now = weeklyCloses.length >= 10
    ? calcEMA(weeklyCloses, Math.min(50, weeklyCloses.length))
    : ema50;
  const weeklyEma50Prev = weeklyCloses.length >= 14
    ? calcEMA(weeklyCloses.slice(0, -4), Math.min(50, weeklyCloses.length - 4))
    : weeklyEma50Now;
  const weeklyEma50Slope = weeklyEma50Now - weeklyEma50Prev;

  // ── Donchian 20-day high ──
  const last20Bars = bars.slice(-20);
  const donchian20High = Math.max(...last20Bars.map(b => b.high));

  // ── Bullish Price Action Detection ──
  const bodySize = Math.abs(lastBar.close - lastBar.open);
  const totalRange = lastBar.high - lastBar.low;
  const lowerWick = Math.min(lastBar.open, lastBar.close) - lastBar.low;
  const isHammer = totalRange > 0 && lowerWick / totalRange >= 0.55 && bodySize / totalRange <= 0.35;
  const prevBar = bars[bars.length - 2];
  const isInsideBar = prevBar && lastBar.high <= prevBar.high && lastBar.low >= prevBar.low;
  const isBullishEngulfing = prevBar
    && lastBar.close > lastBar.open
    && prevBar.close < prevBar.open
    && lastBar.close > prevBar.open
    && lastBar.open < prevBar.close;
  const hasBullishPA = isHammer || isInsideBar || isBullishEngulfing;
  const priceAction = isHammer ? "Hammer"
    : isInsideBar ? "Inside Bar"
    : isBullishEngulfing ? "Bullish Engulfing"
    : null;

  // ── EMA-20 ──
  const ema20 = calcEMA(closes, 20);

  // ── Proximity to EMA-50 ──
  const distToEma50Pct = ema50 > 0 ? Math.abs(lastClose - ema50) / ema50 * 100 : 999;

  // ── RSI ──
  const rsi = calcRSI(closes);

  // ── Volume momentum (last 5 days avg vs 20-day avg) ──
  const volumes = bars.map(b => b.volume ?? 0);
  const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const avgVol5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const volumeRatio = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;

  // ── ATR-14 (for contraction detection) ──
  const atrBars = bars.slice(-20);
  const atr14Raw = atrBars.slice(-14).map((b, i) => {
    const prev = atrBars[atrBars.length - 14 + i - 1];
    if (!prev) return b.high - b.low;
    return Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
  });
  const atr14 = atr14Raw.reduce((a, b) => a + b, 0) / atr14Raw.length;
  const atr5Raw = atrBars.slice(-5).map((b, i) => {
    const prev = atrBars[atrBars.length - 5 + i - 1];
    if (!prev) return b.high - b.low;
    return Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
  });
  const atr5 = atr5Raw.reduce((a, b) => a + b, 0) / atr5Raw.length;
  const atrContraction = atr14 > 0 && atr5 < atr14 * 0.75; // last 5 days quieter than 14-day avg

  // ── 52-Week High proximity ──
  const lookback52w = bars.slice(-252);
  const high52w = lookback52w.length > 0 ? Math.max(...lookback52w.map(b => b.high)) : lastClose;
  const pctFrom52wHigh = high52w > 0 ? ((lastClose - high52w) / high52w) * 100 : 0; // negative = below high

  // ── Golden Cross: EMA-20 > EMA-50 ──
  const goldenCross = ema20 > ema50;

  // ── Trend Strength ──
  // 1. EMA-50 slope steepness: compare EMA-50 now vs 10 bars ago
  const ema50Prev10 = calcEMA(closes.slice(0, -10), 50);
  const ema50SlopePct = ema50Prev10 > 0 ? ((ema50 - ema50Prev10) / ema50Prev10) * 100 : 0;
  // 2. Consecutive up-bars in last 10 days (close > prev close)
  const last10Closes = closes.slice(-11);
  let consecutiveUpBars = 0;
  for (let i = 1; i < last10Closes.length; i++) {
    if (last10Closes[i] > last10Closes[i - 1]) consecutiveUpBars++;
  }
  // 3. Price above EMA-50 by a healthy margin (3-15% = strong, not overextended)
  const pricePremiumToEma50 = ema50 > 0 ? ((lastClose - ema50) / ema50) * 100 : 0;

  // ── Profit Potential ──
  // 1. Donchian channel width as % of price (wider channel = more room)
  const donchian20Low = Math.min(...last20Bars.map(b => b.low));
  const donchianWidthPct = donchian20High > 0 ? ((donchian20High - donchian20Low) / donchian20High) * 100 : 0;
  // 2. ATR-based expected move: ATR-14 as % of price (higher = more potential per trade)
  const atrPct = lastClose > 0 ? (atr14 / lastClose) * 100 : 0;
  // 3. Distance from 52W high (negative = below high, positive = above = new high)
  // Already computed as pctFrom52wHigh above

  // ── Tier Scoring ──
  // ELZA 2.0 P0-3: structural True Retest (priorBreakoutLevel + 5-candle hold),
  // replaces bare EMA-proximity as the Gold Retest qualifier (Tier 3 below).
  const retest = detectTrueRetest(bars);
  // ELZA 2.0 P0-9: Role Reversal (resistance→support) is also a valid Gold-Retest-
  // grade structural entry (priority: True Retest > Role Reversal).
  const roleRev = detectRoleReversal(bars, "long");

  let baseScore = 5;
  let tier: ZivTier = "Near Entry Watch";
  let reason = "";

  // ── Breakout Override check (computed before tier assignment) ──
  // Volume ratio for override: compare last bar volume vs 20-day avg
  const lastBarVol = bars[bars.length - 1].volume ?? 0;
  const volRatioSingle = avgVol20 > 0 ? lastBarVol / avgVol20 : volumeRatio;
  const isBreakoutOverride = (
    lastClose >= donchian20High * 0.995 &&  // at/above 20-day high
    volumeRatio >= 2.0 &&                    // volume > 2x 20-day avg (5-day avg)
    lastClose < ema200                       // only applies when below EMA-200
  );

  // TIER 1: Trash (1-3) — fails primary trend filter
  if (lastClose < ema200 && !isBreakoutOverride) {
    baseScore = 2;
    tier = "No Signal";
    reason = `Price ($${lastClose.toFixed(2)}) is BELOW EMA-200 ($${ema200.toFixed(2)}). Primary downtrend — do not trade.`;
  } else if (isBreakoutOverride) {
    // ⚡ BREAKOUT OVERRIDE: high-volume breakout above 20-day high despite being below EMA-200
    baseScore = 6;
    tier = "Near Entry Watch"; // use Near Entry Watch tier so sub-score can push it to 6.x-6.99
    reason = `⚡ BREAKOUT OVERRIDE: Price ($${lastClose.toFixed(2)}) broke above 20-day high ($${donchian20High.toFixed(2)}) with ${(volumeRatio).toFixed(1)}x volume — high-volume recovery breakout. Below EMA-200 ($${ema200.toFixed(2)}) — elevated risk, smaller position size recommended.`;
  } else if (weeklyEma50Slope < 0) {
    baseScore = 3;
    tier = "No Signal";
    reason = `Weekly EMA-50 slope is NEGATIVE (${weeklyEma50Slope.toFixed(2)}). Structural downtrend — wait for trend reversal.`;
  }
  // TIER 4: Gold Breakout (9-10) — at/above 20-day Donchian high
  else if (lastClose >= donchian20High * 0.995 && lastClose > ema50 && lastClose > ema200) {
    if (_isIlliquid) {
      // Illiquid breakout — suppress score
      baseScore = 3;
      tier = "No Signal";
      reason = `❌ ILLIQUID: Price at 20-day high but avg volume ${Math.round(_avgVol).toLocaleString()} shares/day is below 10,000 minimum. No tradeable setup.`;
    } else {
      baseScore = hasBullishPA ? 10 : 9;
      tier = "Gold Breakout";
      reason = `Price ($${lastClose.toFixed(2)}) is at/above 20-day high ($${donchian20High.toFixed(2)}) — Tier-1 momentum breakout.${priceAction ? ` ${priceAction} candle confirms.` : ""}`;
    }
  }
  // TIER 3: Gold Retest (7-8) — ELZA 2.0 P0-3: STRUCTURAL true retest required
  // (broke a prior resistance, pulled back to it, held 5 candles) — NOT bare EMA
  // proximity. No structure → falls through to Near Entry Watch (WATCH, not EXECUTE).
  else if (lastClose > ema200 && weeklyEma50Slope >= 0 && (retest.isRetest || roleRev.isReversal)) {
    baseScore = hasBullishPA ? 8 : 7;
    if (_isIlliquid) baseScore = Math.max(3, baseScore - 3); // penalize illiquid retests
    tier = _isIlliquid ? "No Signal" : "Gold Retest";
    const struct = retest.isRetest
      ? `True retest of $${retest.priorBreakoutLevel?.toFixed(2)} (held ${retest.heldCandles}/${retest.confirmCandles}, dist ${retest.distPct?.toFixed(1)}%)`
      : `Role reversal at $${roleRev.level?.toFixed(2)} (resistance→support, dist ${roleRev.distPct?.toFixed(1)}%)`;
    reason = `${struct} in a bullish trend.${priceAction ? ` ${priceAction} candle confirms — high-probability entry.` : " Watch for bullish PA confirmation."}`;
  }
  // TIER 2: Neutral (4-6.5) — above EMA-200 but no clear setup
  else {
    if (distToEma50Pct > 8) {
      // Very extended — wait for deep pullback
      baseScore = 4;
      tier = "Near Entry Watch";
      reason = `Price ($${lastClose.toFixed(2)}) is ${distToEma50Pct.toFixed(1)}% above EMA-50 ($${ema50.toFixed(2)}) — very extended, wait for pullback.`;
    } else if (distToEma50Pct > 3) {
      // Moderately extended — still tradeable with momentum
      baseScore = goldenCross ? 6 : 5;
      tier = "Near Entry Watch";
      reason = `Trend is bullish (Price > EMA-200) but price ($${lastClose.toFixed(2)}) is ${distToEma50Pct.toFixed(1)}% from EMA-50${goldenCross ? " — EMA-20 > EMA-50 (Golden Cross active)" : " — no clear entry setup yet"}.`;
    } else {
      // Near EMA-50 but weekly slope flat — borderline setup
      baseScore = 6;
      tier = "Near Entry Watch";
      reason = `Price ($${lastClose.toFixed(2)}) near EMA-50 ($${ema50.toFixed(2)}) but weekly slope is flat — borderline setup.`;
    }
  }

  // ── Decimal Sub-Score v2 (0.00–0.99) — 6 components ──────────────────────
  //
  // Component 1: RSI (context-aware — Breakout gets bonus for high RSI)
  let rsiSub = 0;
  if (tier === "Gold Breakout") {
    // In a breakout, RSI 60-85 = momentum confirmation (BONUS, not penalty)
    if (rsi >= 60 && rsi <= 85) rsiSub = 0.20;
    else if (rsi > 85) rsiSub = 0.12;          // very overbought — slight caution
    else if (rsi >= 50 && rsi < 60) rsiSub = 0.15;
    else rsiSub = 0.05;                         // weak RSI on breakout = suspicious
  } else {
    // For non-breakout: RSI 50-70 is ideal sweet spot
    if (rsi >= 50 && rsi <= 70) rsiSub = 0.20;
    else if (rsi > 70 && rsi <= 80) rsiSub = 0.14;
    else if (rsi >= 40 && rsi < 50) rsiSub = 0.10;
    else if (rsi > 80) rsiSub = 0.05;           // overbought
    else rsiSub = 0;                             // oversold
  }

  // Component 2: Volume confirmation
  let volSub = 0;
  if (volumeRatio >= 2.0) volSub = 0.20;
  else if (volumeRatio >= 1.5) volSub = 0.16;
  else if (volumeRatio >= 1.2) volSub = 0.12;
  else if (volumeRatio >= 0.8) volSub = 0.06;
  else volSub = 0;

  // Component 3: Proximity precision (entry quality)
  let proxSub = 0;
  if (tier === "Gold Breakout") {
    const breakoutPct = lastClose > 0 ? (lastClose - donchian20High) / donchian20High * 100 : 0;
    proxSub = breakoutPct <= 0.5 ? 0.20 : breakoutPct <= 2.0 ? 0.14 : 0.07;
  } else if (tier === "Gold Retest") {
    proxSub = distToEma50Pct <= 0.5 ? 0.20 : distToEma50Pct <= 1.5 ? 0.14 : 0.07;
  } else {
    proxSub = 0.07;
  }

  // Component 4: Golden Cross — EMA-20 > EMA-50 (short-term momentum > medium-term)
  const goldenCrossSub = goldenCross ? 0.15 : 0;

  // Component 5: 52-Week High proximity (within 10% = strong momentum)
  let high52wSub = 0;
  if (pctFrom52wHigh >= -3) high52wSub = 0.15;       // at/near 52w high
  else if (pctFrom52wHigh >= -10) high52wSub = 0.10;  // within 10%
  else if (pctFrom52wHigh >= -20) high52wSub = 0.05;  // within 20%
  else high52wSub = 0;

  // Component 6: ATR Contraction (coiling before breakout)
  const atrSub = atrContraction ? 0.09 : 0;

  // Component 7: Trend Strength — EMA slope + consecutive up-bars + healthy price premium
  let trendStrengthSub = 0;
  // EMA-50 slope: rising steeply (>1.5% in 10 bars) = strong trend
  const slopeBonus = ema50SlopePct >= 2.0 ? 0.10
    : ema50SlopePct >= 1.0 ? 0.07
    : ema50SlopePct >= 0.3 ? 0.04
    : 0;
  // Consecutive up-bars: 6+ out of 10 = strong momentum
  const upBarBonus = consecutiveUpBars >= 7 ? 0.06
    : consecutiveUpBars >= 5 ? 0.04
    : consecutiveUpBars >= 3 ? 0.02
    : 0;
  // Price premium to EMA-50: 3-15% above = healthy trend (not overextended)
  const premiumBonus = (pricePremiumToEma50 >= 3 && pricePremiumToEma50 <= 15) ? 0.04
    : (pricePremiumToEma50 > 0 && pricePremiumToEma50 < 3) ? 0.02
    : 0;
  trendStrengthSub = slopeBonus + upBarBonus + premiumBonus; // max ~0.20

  // Component 8: Profit Potential — upside room available
  let profitPotentialSub = 0;
  // Donchian channel width: wider = more price range = more potential
  const channelBonus = donchianWidthPct >= 15 ? 0.08
    : donchianWidthPct >= 8 ? 0.06
    : donchianWidthPct >= 4 ? 0.04
    : 0.02;
  // ATR % of price: higher ATR = bigger expected moves per bar
  const atrMoveBonus = atrPct >= 4.0 ? 0.07
    : atrPct >= 2.5 ? 0.05
    : atrPct >= 1.5 ? 0.03
    : 0.01;
  // New 52W high = maximum upside (no overhead resistance)
  const newHighBonus = pctFrom52wHigh >= -1 ? 0.05 : 0;
  profitPotentialSub = channelBonus + atrMoveBonus + newHighBonus; // max ~0.20

  const decimalAddon = Math.round((rsiSub + volSub + proxSub + goldenCrossSub + high52wSub + atrSub + trendStrengthSub + profitPotentialSub) * 100) / 100;
  // Cap at tier boundary: score 9 can reach max 9.99 but not 10.00 (unless baseScore=10)
  const score = baseScore === 10 ? 10.00 : Math.min(baseScore + decimalAddon, baseScore + 0.99);
  const scoreRounded = Math.round(score * 100) / 100;

  const breakdown: ZivBreakdown = {
    rsi: Math.round(rsiSub * 100) / 100,
    volume: Math.round(volSub * 100) / 100,
    proximity: Math.round(proxSub * 100) / 100,
    goldenCross: Math.round(goldenCrossSub * 100) / 100,
    high52w: Math.round(high52wSub * 100) / 100,
    atrContraction: Math.round(atrSub * 100) / 100,
    trendStrength: Math.round(trendStrengthSub * 100) / 100,
    profitPotential: Math.round(profitPotentialSub * 100) / 100,
    total: Math.round(decimalAddon * 100) / 100,
    isOverride: isBreakoutOverride,
  };

  // RC-2: surface the role-reversed level being retested so the entry path can
  // anchor the stop structurally (just below it for a long). Only meaningful when
  // the qualifying setup IS a structural retest; priority True Retest > Role Reversal.
  const retestLevel: number | null = tier === "Gold Retest"
    ? (retest.isRetest ? retest.priorBreakoutLevel : (roleRev.isReversal ? roleRev.level : null))
    : null;

  return { score: scoreRounded, tier, reason, price: lastClose, ema50, ema200, donchian20High, weeklyEma50Slope, distToEma50Pct, priceAction, breakdown, retestLevel };
}

// ─── OBV Helper ─────────────────────────────────────────────────────────────

/**
 * Compute On-Balance Volume array from bars.
 * OBV[i] = OBV[i-1] + volume if close > prev_close, - volume if close < prev_close.
 */
export function calcOBV(bars: Bar[]): number[] {
  if (bars.length < 2) return bars.map(() => 0);
  const obv: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const vol = bars[i].volume ?? 0;
    if (bars[i].close > bars[i - 1].close) obv.push(obv[i - 1] + vol);
    else if (bars[i].close < bars[i - 1].close) obv.push(obv[i - 1] - vol);
    else obv.push(obv[i - 1]);
  }
  return obv;
}

// ─── Directional Decimal Sub-Score (shared long/short, anti-drift) ───────────
//
// The 8-component 0.00–0.99 decimal addon, mirror-symmetric by direction. The LONG
// branch reproduces calcZivEngineScore's inline block (zivEngine.ts §"Decimal Sub-
// Score v2") EXACTLY; the SHORT branch is its literal sign-flip per the symmetric-
// short spec §2.1. calcZivEngineScore keeps its own inline long block (byte-identical,
// untouched); calcBearScore routes through dir="short" so the two sides cannot drift.
//
//   LONG component → SHORT mirror
//   1 RSI ideal 50-70 / breakout 60-85        → RSI ideal 30-50 / breakdown 15-40 (reflect about 50)
//   2 Volume confirmation (stepped, ≥2.0→0.20) → identical (volume confirms a breakdown as a breakout)
//   3 Proximity to Donchian-HIGH / EMA-50      → proximity to Donchian-LOW / role-reversal level
//   4 Golden Cross EMA-20 > EMA-50 → 0.15      → Death Cross  EMA-20 < EMA-50 → 0.15
//   5 52-week HIGH proximity → ≤0.15           → 52-week LOW  proximity → ≤0.15
//   6 ATR contraction (coiling) → 0.09         → identical (direction-neutral)
//   7 Trend Strength (up slope/up-bars/premium)→ Trend Weakness (down slope/down-bars/discount)
//   8 Profit Potential (width + ATR% + new-high)→ width + ATR% + new-LOW
export type ScoreDirection = "long" | "short";

export interface DirectionalAddonMetrics {
  tierKind: "breakout" | "retest" | "other";   // long: Gold Breakout/Gold Retest/other; short: Bear Breakdown/Bear Retest/other
  rsi: number;
  volumeRatio: number;
  lastClose: number;
  ema20: number;
  ema50: number;
  donchian20High: number;
  donchian20Low: number;
  proximityLevel: number | null;  // retest tier: the structural level being retested (EMA-50 long / role-rev short)
  pctFrom52wHigh: number;         // (lastClose − high52w)/high52w × 100  (≤0)
  pctFrom52wLow: number;          // (lastClose − low52w)/low52w   × 100  (≥0)
  atrContraction: boolean;
  ema50SlopePct: number;          // EMA-50 now vs 10 bars ago, %
  consecutiveUpBars: number;
  consecutiveDownBars: number;
  pricePremiumToEma50: number;    // (lastClose − ema50)/ema50 × 100 (long: premium ABOVE; short uses the discount BELOW)
  donchianWidthPct: number;
  atrPct: number;
}

export function calcDirectionalDecimalAddon(m: DirectionalAddonMetrics, dir: ScoreDirection): number {
  const isLong = dir === "long";

  // Component 1: RSI (context-aware). Short reflects the band about 50: long(rsi)≡short(100−rsi).
  const rsiEff = isLong ? m.rsi : 100 - m.rsi;
  let rsiSub = 0;
  if (m.tierKind === "breakout") {
    if (rsiEff >= 60 && rsiEff <= 85) rsiSub = 0.20;
    else if (rsiEff > 85) rsiSub = 0.12;
    else if (rsiEff >= 50 && rsiEff < 60) rsiSub = 0.15;
    else rsiSub = 0.05;
  } else {
    if (rsiEff >= 50 && rsiEff <= 70) rsiSub = 0.20;
    else if (rsiEff > 70 && rsiEff <= 80) rsiSub = 0.14;
    else if (rsiEff >= 40 && rsiEff < 50) rsiSub = 0.10;
    else if (rsiEff > 80) rsiSub = 0.05;
    else rsiSub = 0;
  }

  // Component 2: Volume confirmation — identical both directions.
  let volSub = 0;
  if (m.volumeRatio >= 2.0) volSub = 0.20;
  else if (m.volumeRatio >= 1.5) volSub = 0.16;
  else if (m.volumeRatio >= 1.2) volSub = 0.12;
  else if (m.volumeRatio >= 0.8) volSub = 0.06;
  else volSub = 0;

  // Component 3: Proximity precision (entry quality). Long: dist to Donchian-HIGH / EMA-50.
  // Short mirror: dist to Donchian-LOW / role-reversal level.
  let proxSub = 0;
  if (m.tierKind === "breakout") {
    const breakPct = isLong
      ? (m.lastClose > 0 ? (m.lastClose - m.donchian20High) / m.donchian20High * 100 : 0)
      : (m.donchian20Low > 0 ? (m.donchian20Low - m.lastClose) / m.donchian20Low * 100 : 0);
    proxSub = breakPct <= 0.5 ? 0.20 : breakPct <= 2.0 ? 0.14 : 0.07;
  } else if (m.tierKind === "retest") {
    const lvl = m.proximityLevel ?? (isLong ? m.ema50 : m.lastClose);
    const distPct = lvl > 0 ? Math.abs(m.lastClose - lvl) / lvl * 100 : 999;
    proxSub = distPct <= 0.5 ? 0.20 : distPct <= 1.5 ? 0.14 : 0.07;
  } else {
    proxSub = 0.07;
  }

  // Component 4: Golden Cross (long: EMA-20 > EMA-50) / Death Cross (short: EMA-20 < EMA-50).
  const crossSub = (isLong ? m.ema20 > m.ema50 : m.ema20 < m.ema50) ? 0.15 : 0;

  // Component 5: 52-week HIGH (long) / 52-week LOW (short) proximity.
  let extremeSub = 0;
  if (isLong) {
    if (m.pctFrom52wHigh >= -3) extremeSub = 0.15;
    else if (m.pctFrom52wHigh >= -10) extremeSub = 0.10;
    else if (m.pctFrom52wHigh >= -20) extremeSub = 0.05;
    else extremeSub = 0;
  } else {
    if (m.pctFrom52wLow <= 3) extremeSub = 0.15;          // at/near 52w low
    else if (m.pctFrom52wLow <= 10) extremeSub = 0.10;
    else if (m.pctFrom52wLow <= 20) extremeSub = 0.05;
    else extremeSub = 0;
  }

  // Component 6: ATR contraction (coiling) — direction-neutral.
  const atrSub = m.atrContraction ? 0.09 : 0;

  // Component 7: Trend Strength (long) / Trend Weakness (short) — flip every sign.
  const slopeMag = isLong ? m.ema50SlopePct : -m.ema50SlopePct;     // long: rising; short: falling
  const slopeBonus = slopeMag >= 2.0 ? 0.10 : slopeMag >= 1.0 ? 0.07 : slopeMag >= 0.3 ? 0.04 : 0;
  const dirBars = isLong ? m.consecutiveUpBars : m.consecutiveDownBars;
  const barBonus = dirBars >= 7 ? 0.06 : dirBars >= 5 ? 0.04 : dirBars >= 3 ? 0.02 : 0;
  const gapMag = isLong ? m.pricePremiumToEma50 : -m.pricePremiumToEma50; // long: premium above; short: discount below
  const gapBonus = (gapMag >= 3 && gapMag <= 15) ? 0.04 : (gapMag > 0 && gapMag < 3) ? 0.02 : 0;
  const trendSub = slopeBonus + barBonus + gapBonus;

  // Component 8: Profit Potential — width + ATR% identical; new-52w-HIGH (long) / new-52w-LOW (short).
  const channelBonus = m.donchianWidthPct >= 15 ? 0.08 : m.donchianWidthPct >= 8 ? 0.06 : m.donchianWidthPct >= 4 ? 0.04 : 0.02;
  const atrMoveBonus = m.atrPct >= 4.0 ? 0.07 : m.atrPct >= 2.5 ? 0.05 : m.atrPct >= 1.5 ? 0.03 : 0.01;
  const newExtremeBonus = isLong ? (m.pctFrom52wHigh >= -1 ? 0.05 : 0) : (m.pctFrom52wLow <= 1 ? 0.05 : 0);
  const profitSub = channelBonus + atrMoveBonus + newExtremeBonus;

  return Math.round((rsiSub + volSub + proxSub + crossSub + extremeSub + atrSub + trendSub + profitSub) * 100) / 100;
}

// ─── ZIV H Score — Position Health Engine ────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// ZIV Health Score v2.2 — mode-aware phases + active risk modifiers
// Intraday horizons: 30m / 4h / 3d / 3d+
// Swing horizons:    24h / 3d / 21d / 21d+ (Chandelier trail)
// Long + short symmetric scoring via ctx.direction or SL inference
// ─────────────────────────────────────────────────────────────────────────────

export type ZivHTier = "Strong Hold" | "Stable" | "Watch" | "Weak" | "No Data";

export interface ZivHScoreResult {
  score: number;
  tier: ZivHTier;
  suggestedAction: string;
  phase: "entry-window" | "confirmation" | "active" | "trail";
  indicators: {
    // Phase 2 (Confirmation)
    momentumUp: boolean;
    volumeConfirmed: boolean;
    aboveEma20: boolean;
    // Phase 3 (Active) — weighted components
    slDistance: number;   // 0-10
    momentum: number;     // 0-10
    volumeScore: number;  // 0-10
    marketContext: number; // 0-10
    // Legacy fields kept for UI compatibility
    profitCushion: boolean;
    trendSupport: boolean;
    trendDominance: boolean;
    momentumStrength: boolean;
    notOverExtended: boolean;
    volumeHealth: boolean;
  };
  bonuses: {
    riskFreeTrail: boolean;
    targetProximity: boolean;
    scoreImproved: boolean;
    recentBreakout: boolean;
    nearPeak: boolean;
    goodEntryTier: boolean;
  };
  penalties: {
    overExposure: boolean;
    deadCapital: boolean;
    reallocationSignal: boolean;
    underperformance: boolean;
    scoreDegraded: boolean;
    farFromPeak: boolean;
    hiddenDistribution: boolean;
  };
  details: string;
}

export interface ZivHContext {
  /** Total portfolio value in $ (for over-exposure check) */
  totalPortfolioValue?: number;
  /** Capital currently allocated to this position ($) */
  positionValue?: number;
  /** Days held (for dead capital check) */
  daysHeld?: number;
  /** Highest ZIV score among current watchlist entries */
  highestWatchlistZivScore?: number;
  /** SPY bars for 14-day RS calculation */
  spyBars?: Bar[];
  /** ZIV score at time of purchase (for delta tracking) */
  buyScore?: number | null;
  /** Highest price since entry (for peak proximity check) */
  peakPrice?: number | null;
  /** ZIV Engine tier at time of entry (for entry quality bonus) */
  entryTier?: string | null;
  /** IBKR unrealized P&L (more accurate than computed pnlPct for dead capital) */
  ibkrUnrealizedPnl?: number | null;
  /** Donchian 20-day high at time of most recent breakout scan */
  recentBreakoutLevel?: number | null;
  /** Minutes the position has been open (drives phase selection) */
  minutesInTrade?: number;
  /** Timestamp (ms) when score first dropped below FC threshold — for V-Shape Grace (3-min window) */
  graceStartTime?: number | null;
  /** SPY price at start of current trading day — for Beta Context (market-wide FC threshold reduction) */
  spyDayStartPrice?: number | null;
  /** Current SPY price — for Beta Context check */
  spyCurrentPrice?: number | null;
  /** Position direction — inferred from SL vs entry when omitted */
  direction?: "long" | "short";
  /** Current catalog ZIV Engine score (vs buyScore at entry) */
  currentEngineScore?: number | null;
}

/** Portfolio weight above which over-exposure penalties apply */
const ZIVH_OVER_EXPOSURE_PCT = 0.15;
const ZIVH_OVER_EXPOSURE_SEVERE_PCT = 0.20;
const ZIVH_PENALTY_OVER_EXPOSURE = 1.5;
const ZIVH_PENALTY_OVER_EXPOSURE_SEVERE = 2.0;
const ZIVH_PENALTY_PEAK_BLEED = 1.0;
const ZIVH_PEAK_BLEED_ATR = 1.0;
const ZIVH_NEAR_PEAK_ATR = 0.25;
const ZIVH_BONUS_NEAR_PEAK = 0.25;
const ZIVH_PENALTY_SCORE_DEGRADED = 0.5;
const ZIVH_BONUS_SCORE_IMPROVED = 0.25;
const ZIVH_ENGINE_WEAK_THRESHOLD = 4.0;
const ZIVH_BUY_SCORE_DROP_THRESHOLD = 2.0;

interface ZivHModifierResult {
  scoreDelta: number;
  bonuses: Partial<ZivHScoreResult["bonuses"]>;
  penalties: Partial<ZivHScoreResult["penalties"]>;
  notes: string[];
}

export type ZivHTradingMode = "intraday" | "swing";

export interface ZivHPhaseBoundaries {
  mode: ZivHTradingMode;
  phase1EndMin: number;
  phase2EndMin: number;
  phase3EndMin: number;
  fadeInStartMin: number;
  fadeInEndMin: number;
  deadCapitalActiveDays: number;
  deadCapitalTrailDays: number;
  graceWindowMs: number;
}

/** Read trading mode without importing slCalculator (avoids circular dep). */
export function getZivHTradingMode(): ZivHTradingMode {
  const m = (process.env.ELSA_TRADING_MODE ?? "swing").toLowerCase();
  return m === "intraday" ? "intraday" : "swing";
}

export function getZivHPhaseBoundaries(mode = getZivHTradingMode()): ZivHPhaseBoundaries {
  if (mode === "intraday") {
    return {
      mode: "intraday",
      phase1EndMin: 30,
      phase2EndMin: 4 * 60,
      phase3EndMin: 3 * 24 * 60,
      fadeInStartMin: 30,
      fadeInEndMin: 35,
      deadCapitalActiveDays: 2,
      deadCapitalTrailDays: 7,
      graceWindowMs: 3 * 60 * 1000,
    };
  }
  return {
    mode: "swing",
    phase1EndMin: 24 * 60,
    phase2EndMin: 3 * 24 * 60,
    phase3EndMin: 21 * 24 * 60,
    fadeInStartMin: 24 * 60,
    fadeInEndMin: 25 * 60,
    deadCapitalActiveDays: 5,
    deadCapitalTrailDays: 14,
    graceWindowMs: 24 * 60 * 60 * 1000,
  };
}

type ZivHDirection = "long" | "short";

function resolveZivHDirection(
  entryPrice: number,
  stopLoss: number | null,
  ctx?: ZivHContext,
): ZivHDirection {
  if (ctx?.direction === "short" || ctx?.direction === "long") return ctx.direction;
  if (stopLoss != null && stopLoss > entryPrice) return "short";
  return "long";
}

function zivHMomentumOk(ema20Slope: number, rsi: number, dir: ZivHDirection): boolean {
  return dir === "long" ? ema20Slope > 0 && rsi > 45 : ema20Slope < 0 && rsi < 55;
}

function zivHFavorableEma20(price: number, ema20: number, dir: ZivHDirection): boolean {
  return dir === "long" ? price > ema20 : price < ema20;
}

function zivHSlAtrDistance(price: number, sl: number, atr14: number, dir: ZivHDirection): number {
  const cushion = dir === "long" ? price - sl : sl - price;
  return atr14 > 0 ? cushion / atr14 : 0;
}

function zivHPnlPct(price: number, entry: number, dir: ZivHDirection): number {
  return dir === "long"
    ? ((price - entry) / entry) * 100
    : ((entry - price) / entry) * 100;
}

function zivHCatastrophic(price: number, entry: number, atr14: number, dir: ZivHDirection): boolean {
  if (atr14 <= 0) return false;
  return dir === "long"
    ? price < entry - 3 * atr14
    : price > entry + 3 * atr14;
}

function zivHMarketContextScore(
  stockRet5: number,
  spyRet5: number,
  dir: ZivHDirection,
): number {
  const rs = dir === "long" ? stockRet5 - spyRet5 : spyRet5 - stockRet5;
  return Math.min(10, Math.max(0, 5 + (rs / 0.05) * 5));
}

function formatZivHHoldTime(minutes: number, mode: ZivHTradingMode): string {
  if (mode === "intraday") return `${minutes}min`;
  if (minutes < 60) return `${minutes}min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function resolveEffectivePeak(
  ctx: ZivHContext | undefined,
  bars: Bar[],
  dir: ZivHDirection,
): number | null {
  if (ctx?.peakPrice != null && ctx.peakPrice > 0) return ctx.peakPrice;
  if (bars.length === 0) return null;
  const window = bars.slice(-60);
  return dir === "long"
    ? Math.max(...window.map((b) => b.high))
    : Math.min(...window.map((b) => b.low));
}

/** Institutional risk/reward modifiers layered on phase base score */
function computeZivHModifiers(
  currentPrice: number,
  entryPrice: number,
  atr14: number,
  dir: ZivHDirection,
  bars: Bar[],
  ctx?: ZivHContext,
): ZivHModifierResult {
  let scoreDelta = 0;
  const bonuses: ZivHModifierResult["bonuses"] = {};
  const penalties: ZivHModifierResult["penalties"] = {};
  const notes: string[] = [];

  const posVal = ctx?.positionValue ?? 0;
  const totalVal = ctx?.totalPortfolioValue ?? 0;
  if (totalVal > 0 && posVal > 0) {
    const weightPct = posVal / totalVal;
    if (weightPct > ZIVH_OVER_EXPOSURE_SEVERE_PCT) {
      penalties.overExposure = true;
      scoreDelta -= ZIVH_PENALTY_OVER_EXPOSURE_SEVERE;
      notes.push(`Over-exposure ${(weightPct * 100).toFixed(0)}% (−${ZIVH_PENALTY_OVER_EXPOSURE_SEVERE})`);
    } else if (weightPct > ZIVH_OVER_EXPOSURE_PCT) {
      penalties.overExposure = true;
      scoreDelta -= ZIVH_PENALTY_OVER_EXPOSURE;
      notes.push(`Over-exposure ${(weightPct * 100).toFixed(0)}% (−${ZIVH_PENALTY_OVER_EXPOSURE})`);
    }
  }

  const peak = resolveEffectivePeak(ctx, bars, dir);
  if (peak != null && atr14 > 0) {
    const hadProfitAtPeak = dir === "long"
      ? peak > entryPrice * 1.005
      : peak < entryPrice * 0.995;
    const bleedAtr = dir === "long"
      ? (peak - currentPrice) / atr14
      : (currentPrice - peak) / atr14;

    if (hadProfitAtPeak) {
      if (bleedAtr >= ZIVH_PEAK_BLEED_ATR) {
        penalties.farFromPeak = true;
        scoreDelta -= ZIVH_PENALTY_PEAK_BLEED;
        notes.push(`Profit bleed ${bleedAtr.toFixed(1)}×ATR from peak (−${ZIVH_PENALTY_PEAK_BLEED})`);
      } else if (bleedAtr <= ZIVH_NEAR_PEAK_ATR) {
        bonuses.nearPeak = true;
        scoreDelta += ZIVH_BONUS_NEAR_PEAK;
        notes.push(`Near peak (+${ZIVH_BONUS_NEAR_PEAK})`);
      }
    }
  }

  const buyScore = ctx?.buyScore;
  const currentEngine = ctx?.currentEngineScore;
  if (currentEngine != null) {
    if (currentEngine < ZIVH_ENGINE_WEAK_THRESHOLD) {
      penalties.scoreDegraded = true;
      scoreDelta -= ZIVH_PENALTY_SCORE_DEGRADED;
      notes.push(`Catalog ZIV ${currentEngine.toFixed(1)} < ${ZIVH_ENGINE_WEAK_THRESHOLD} (−${ZIVH_PENALTY_SCORE_DEGRADED})`);
    } else if (buyScore != null && buyScore - currentEngine >= ZIVH_BUY_SCORE_DROP_THRESHOLD) {
      penalties.scoreDegraded = true;
      scoreDelta -= ZIVH_PENALTY_SCORE_DEGRADED;
      notes.push(`ZIV degraded ${buyScore.toFixed(1)}→${currentEngine.toFixed(1)} (−${ZIVH_PENALTY_SCORE_DEGRADED})`);
    } else if (buyScore != null && currentEngine > buyScore + 0.5) {
      bonuses.scoreImproved = true;
      scoreDelta += ZIVH_BONUS_SCORE_IMPROVED;
      notes.push(`ZIV improved ${buyScore.toFixed(1)}→${currentEngine.toFixed(1)} (+${ZIVH_BONUS_SCORE_IMPROVED})`);
    }
  }

  const watchBest = ctx?.highestWatchlistZivScore ?? 0;
  if (watchBest >= 7.5 && currentEngine != null && watchBest > currentEngine + 2) {
    penalties.reallocationSignal = true;
    notes.push(`Better watchlist setup ${watchBest.toFixed(1)} vs holding ${currentEngine.toFixed(1)}`);
  }

  const entryTier = ctx?.entryTier ?? "";
  if (entryTier === "Gold Retest" || entryTier === "Gold Breakout") {
    bonuses.goodEntryTier = true;
    scoreDelta += 0.2;
    notes.push(`Quality entry tier ${entryTier} (+0.2)`);
  }

  const breakoutLevel = ctx?.recentBreakoutLevel;
  if (breakoutLevel != null && breakoutLevel > 0) {
    const holdingBreakout = dir === "long"
      ? currentPrice >= breakoutLevel * 0.98
      : currentPrice <= breakoutLevel * 1.02;
    if (holdingBreakout) {
      bonuses.recentBreakout = true;
      scoreDelta += 0.2;
      notes.push("Recent breakout level holding (+0.2)");
    }
  }

  return { scoreDelta, bonuses, penalties, notes };
}

function applyZivHModifiers(
  base: ZivHScoreResult,
  modifiers: ZivHModifierResult,
  opts: { fcThreshold: number; graceActive?: boolean; baseDetails: string },
): ZivHScoreResult {
  if (modifiers.scoreDelta === 0 && modifiers.notes.length === 0) return base;

  const adjusted = Math.max(0, Math.min(10, Math.round((base.score + modifiers.scoreDelta) * 100) / 100));
  let tier = base.tier;
  let suggestedAction = base.suggestedAction;

  if (modifiers.scoreDelta !== 0) {
    if (adjusted >= 7.5) tier = "Strong Hold";
    else if (adjusted >= 5.5) tier = "Stable";
    else if (adjusted >= opts.fcThreshold || opts.graceActive) tier = "Watch";
    else {
      tier = "Weak";
      if (!suggestedAction.includes("Force-Close")) {
        suggestedAction = `Risk modifiers lowered health to ${adjusted.toFixed(1)} — review position.`;
      }
    }
  }

  return {
    ...base,
    score: adjusted,
    tier,
    suggestedAction,
    bonuses: { ...base.bonuses, ...modifiers.bonuses },
    penalties: { ...base.penalties, ...modifiers.penalties },
    details: modifiers.notes.length > 0
      ? `${opts.baseDetails} | ${modifiers.notes.join("; ")}`
      : opts.baseDetails,
  };
}

/**
 * ZIV Health Score v2 — 4-Phase Lifecycle Model.
 *
 * Phase boundaries depend on ELSA_TRADING_MODE (see getZivHPhaseBoundaries).
 * Intraday: 30m / 4h / 3d / 3d+ trail
 * Swing:    24h / 3d / 21d / 21d+ trail (Chandelier)
 */
export function calcZivHScore(
  bars: Bar[],
  entryPrice: number,
  stopLoss: number | null,
  takeProfit: number | null,
  ctx?: ZivHContext,
): ZivHScoreResult {
  const bounds = getZivHPhaseBoundaries();
  const dir = resolveZivHDirection(entryPrice, stopLoss, ctx);

  const noData: ZivHScoreResult = {
    score: 7.0,
    tier: "Stable",
    suggestedAction: "Insufficient data — holding",
    phase: "entry-window",
    indicators: {
      momentumUp: false, volumeConfirmed: false, aboveEma20: false,
      slDistance: 5, momentum: 5, volumeScore: 5, marketContext: 5,
      profitCushion: false, trendSupport: false, trendDominance: false,
      momentumStrength: false, notOverExtended: false, volumeHealth: false,
    },
    bonuses: { riskFreeTrail: false, targetProximity: false, scoreImproved: false, recentBreakout: false, nearPeak: false, goodEntryTier: false },
    penalties: { overExposure: false, deadCapital: false, reallocationSignal: false, underperformance: false, scoreDegraded: false, farFromPeak: false, hiddenDistribution: false },
    details: "Need 50+ bars",
  };

  if (bars.length < 50 || entryPrice <= 0) return noData;

  const minutesInTrade = ctx?.minutesInTrade ?? 0;
  const closes = bars.map(b => b.close);
  const currentPrice = closes[closes.length - 1];
  const volumes = bars.map(b => b.volume ?? 0);
  const holdLabel = formatZivHHoldTime(minutesInTrade, bounds.mode);

  // ── Phase 1: Entry grace window ───────────────────────────────────────────
  if (minutesInTrade < bounds.phase1EndMin) {
    const trsEarly = bars.slice(1).map((b, i) =>
      Math.max(b.high - b.low, Math.abs(b.high - bars[i].close), Math.abs(b.low - bars[i].close))
    );
    const atr14Early = trsEarly.length >= 14
      ? trsEarly.slice(-14).reduce((a, b) => a + b, 0) / 14
      : 0;
    const catastrophicDrop = zivHCatastrophic(currentPrice, entryPrice, atr14Early, dir);
    if (catastrophicDrop) {
      const atrUnits = dir === "long"
        ? (entryPrice - currentPrice) / atr14Early
        : (currentPrice - entryPrice) / atr14Early;
      return {
        score: 0,
        tier: "Weak",
        suggestedAction: `Catastrophic ${dir === "short" ? "rally" : "drop"}: price moved ${atrUnits.toFixed(1)}×ATR14 against entry — immediate Force-Close.`,
        phase: "entry-window",
        indicators: {
          momentumUp: false, volumeConfirmed: false, aboveEma20: false,
          slDistance: 0, momentum: 0, volumeScore: 5, marketContext: 5,
          profitCushion: false, trendSupport: false, trendDominance: false,
          momentumStrength: false, notOverExtended: false, volumeHealth: false,
        },
        bonuses: { riskFreeTrail: false, targetProximity: false, scoreImproved: false, recentBreakout: false, nearPeak: false, goodEntryTier: false },
        penalties: { overExposure: false, deadCapital: false, reallocationSignal: false, underperformance: false, scoreDegraded: false, farFromPeak: false, hiddenDistribution: false },
        details: `Catastrophic move: ${atrUnits.toFixed(1)}×ATR14 in entry window (${bounds.mode})`,
      };
    }
    const graceEndLabel = bounds.mode === "swing" ? "24h" : "30min";
    return {
      score: 7.0,
      tier: "Stable",
      suggestedAction: `Entry window (${bounds.mode}) — monitoring only. SL is the primary guard.`,
      phase: "entry-window",
      indicators: {
        momentumUp: false, volumeConfirmed: false, aboveEma20: false,
        slDistance: 5, momentum: 5, volumeScore: 5, marketContext: 5,
        profitCushion: false, trendSupport: false, trendDominance: false,
        momentumStrength: false, notOverExtended: false, volumeHealth: false,
      },
      bonuses: { riskFreeTrail: false, targetProximity: false, scoreImproved: false, recentBreakout: false, nearPeak: false, goodEntryTier: false },
      penalties: { overExposure: false, deadCapital: false, reallocationSignal: false, underperformance: false, scoreDegraded: false, farFromPeak: false, hiddenDistribution: false },
      details: `Entry window (${holdLabel} < ${graceEndLabel}, ${bounds.mode}) — no Force-Close`,
    };
  }

  // ── Shared technical indicators (used by phases 2, 3, 4) ─────────────────
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const rsi = calcRSI(closes);
  const trs = bars.slice(1).map((b, i) =>
    Math.max(b.high - b.low, Math.abs(b.high - bars[i].close), Math.abs(b.low - bars[i].close))
  );
  const atr14 = trs.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const lastVol = volumes[volumes.length - 1];

  // EMA slope: compare current EMA-20 to EMA-20 of 5 bars ago
  const ema20_5ago = calcEMA(closes.slice(0, -5), 20);
  const ema20Slope = ema20 - ema20_5ago; // positive = rising

  // ── Beta Context: if SPY dropped >1.5% from day open, lower FC threshold ───────
  // Normal FC threshold = 4.0; market-wide selloff threshold = 2.5
  const spyDayDrop = (ctx?.spyDayStartPrice != null && ctx?.spyCurrentPrice != null && ctx.spyDayStartPrice > 0)
    ? (ctx.spyCurrentPrice - ctx.spyDayStartPrice) / ctx.spyDayStartPrice
    : 0;
  const fcThreshold = spyDayDrop <= -0.015 ? 2.5 : 4.0;
  const favorableEma20 = zivHFavorableEma20(currentPrice, ema20, dir);
  const trendDominant = dir === "long" ? ema20 > ema50 : ema20 < ema50;

  // ── Phase 2: Confirmation ───────────────────────────────────────────────────
  if (minutesInTrade < bounds.phase2EndMin) {
    const momentumUp = zivHMomentumOk(ema20Slope, rsi, dir);
    const volumeConfirmed = avgVol20 > 0 && lastVol >= avgVol20 * 0.8;

    const confirmed = (momentumUp ? 1 : 0) + (volumeConfirmed ? 1 : 0) + (favorableEma20 ? 1 : 0);
    const rawScore = (confirmed / 3) * 10;

    const inFade = minutesInTrade >= bounds.fadeInStartMin && minutesInTrade < bounds.fadeInEndMin;
    const fadeSpan = Math.max(1, bounds.fadeInEndMin - bounds.fadeInStartMin);
    const score = inFade
      ? 7.0 * (1 - (minutesInTrade - bounds.fadeInStartMin) / fadeSpan) + rawScore * ((minutesInTrade - bounds.fadeInStartMin) / fadeSpan)
      : rawScore;

    let tier: ZivHTier;
    let suggestedAction: string;
    if (score >= 7.5) { tier = "Strong Hold"; suggestedAction = "Confirmation strong — hold."; }
    else if (score >= 5.5) { tier = "Stable"; suggestedAction = "Confirmation partial — monitoring."; }
    else if (score >= fcThreshold) { tier = "Watch"; suggestedAction = "Weak confirmation — watch closely."; }
    else { tier = "Weak"; suggestedAction = `Confirmation failed — Force-Close triggered${spyDayDrop <= -0.015 ? " (Beta Context: SPY "+((spyDayDrop*100).toFixed(1))+"%)" : ""}.`; }

    const emaLabel = dir === "long" ? "Price below EMA-20" : "Price above EMA-20";
    const failedChecks = [
      !momentumUp && `Momentum not confirmed (${dir})`,
      !volumeConfirmed && "Volume below average",
      !favorableEma20 && emaLabel,
    ].filter(Boolean) as string[];

    const baseDetails = failedChecks.length > 0
      ? `Confirmation (${bounds.mode}, ${holdLabel}): ${failedChecks.join(", ")}`
      : `Confirmation (${bounds.mode}): all 3 checks passed`;

    const phase2Base: ZivHScoreResult = {
      score: Math.round(score * 100) / 100,
      tier,
      suggestedAction,
      phase: "confirmation",
      indicators: {
        momentumUp, volumeConfirmed, aboveEma20: favorableEma20,
        slDistance: 5, momentum: 5, volumeScore: 5, marketContext: 5,
        profitCushion: false, trendSupport: favorableEma20, trendDominance: trendDominant,
        momentumStrength: dir === "long" ? rsi > 50 : rsi < 50, notOverExtended: true, volumeHealth: volumeConfirmed,
      },
      bonuses: { riskFreeTrail: false, targetProximity: false, scoreImproved: false, recentBreakout: false, nearPeak: false, goodEntryTier: false },
      penalties: { overExposure: false, deadCapital: false, reallocationSignal: false, underperformance: false, scoreDegraded: false, farFromPeak: false, hiddenDistribution: false },
      details: baseDetails,
    };

    return applyZivHModifiers(
      phase2Base,
      computeZivHModifiers(currentPrice, entryPrice, atr14, dir, bars, ctx),
      { fcThreshold, baseDetails },
    );
  }

  // ── Phase 3: Active Management ────────────────────────────────────────────
  if (minutesInTrade < bounds.phase3EndMin) {
    let slDistanceScore = 5;
    if (stopLoss != null && atr14 > 0) {
      const slAtrRatio = zivHSlAtrDistance(currentPrice, stopLoss, atr14, dir);
      slDistanceScore = Math.min(10, Math.max(0, (slAtrRatio / 3) * 10));
    }

    const ema12 = calcEMA(closes, 12);
    const ema26 = calcEMA(closes, 26);
    const macdLine = ema12 - ema26;
    const macdFavorable = dir === "long" ? macdLine > 0 : macdLine < 0;
    const slopeFavorable = dir === "long" ? ema20Slope > 0 : ema20Slope < 0;
    const ema20SlopeScore = slopeFavorable
      ? Math.min(5, (Math.abs(ema20Slope) / (atr14 * 0.1)) * 5)
      : 0;
    const momentumScore = Math.min(10, ema20SlopeScore + (macdFavorable ? 5 : 0));

    const volRatio = avgVol20 > 0 ? lastVol / avgVol20 : 1;
    const volumeScore = Math.min(10, Math.max(0, (Math.min(volRatio, 2) / 2) * 10));

    let marketContextScore = 5;
    if (ctx?.spyBars && ctx.spyBars.length >= 5 && bars.length >= 5) {
      const stockRet5 = (bars[bars.length - 1].close - bars[bars.length - 5].close) / bars[bars.length - 5].close;
      const spyRet5 = (ctx.spyBars[ctx.spyBars.length - 1].close - ctx.spyBars[ctx.spyBars.length - 5].close) / ctx.spyBars[ctx.spyBars.length - 5].close;
      marketContextScore = zivHMarketContextScore(stockRet5, spyRet5, dir);
    }

    const pnlPct = zivHPnlPct(currentPrice, entryPrice, dir);
    const effectivePnlPct = (ctx?.ibkrUnrealizedPnl != null && ctx.positionValue != null && ctx.positionValue > 0)
      ? (ctx.ibkrUnrealizedPnl / (ctx.positionValue - ctx.ibkrUnrealizedPnl)) * 100
      : pnlPct;
    const daysHeld = ctx?.daysHeld ?? (minutesInTrade / (60 * 24));
    const deadCapital = daysHeld > bounds.deadCapitalActiveDays
      && effectivePnlPct >= -0.5 && effectivePnlPct <= 0.5;
    const timeEfficiencyScore = deadCapital ? 0 : 10;

    const score =
      slDistanceScore   * 0.30 +
      momentumScore     * 0.25 +
      volumeScore       * 0.20 +
      marketContextScore * 0.15 +
      timeEfficiencyScore * 0.10;

    const finalScore = Math.max(0, Math.min(Math.round(score * 100) / 100, 10));

    const now = Date.now();
    const graceActive = finalScore < fcThreshold
      && ctx?.graceStartTime != null
      && (now - ctx.graceStartTime) < bounds.graceWindowMs;

    let tier: ZivHTier;
    let suggestedAction: string;
    if (finalScore >= 7.5) { tier = "Strong Hold"; suggestedAction = "Position healthy — consider trailing SL up."; }
    else if (finalScore >= 5.5) { tier = "Stable"; suggestedAction = "Normal behavior — no action needed."; }
    else if (finalScore >= fcThreshold || graceActive) {
      tier = "Watch";
      suggestedAction = graceActive
        ? `V-Shape Grace: score ${finalScore.toFixed(1)} < ${fcThreshold} but within recovery window — holding.`
        : "Weakening — monitor closely.";
    }
    else { tier = "Weak"; suggestedAction = `Health failed — Force-Close triggered${spyDayDrop <= -0.015 ? " (Beta Context: SPY "+((spyDayDrop*100).toFixed(1))+"%)" : ""}.`; }

    const issues: string[] = [];
    if (slDistanceScore < 3) issues.push(`SL too close (${slDistanceScore.toFixed(1)}/10)`);
    if (momentumScore < 3) issues.push(`Momentum weak (${momentumScore.toFixed(1)}/10)`);
    if (volumeScore < 3) issues.push(`Volume low (${volumeScore.toFixed(1)}/10)`);
    if (marketContextScore < 3) issues.push(`Underperforming market (${marketContextScore.toFixed(1)}/10)`);
    if (deadCapital) issues.push(`Dead capital (${daysHeld.toFixed(1)}d, P/L ${effectivePnlPct.toFixed(1)}%)`);

    const riskFree = stopLoss != null && (
      dir === "long" ? stopLoss > entryPrice : stopLoss < entryPrice
    );

    const activeDetails = graceActive
      ? `V-Shape Grace (${Math.ceil((bounds.graceWindowMs - (now - (ctx?.graceStartTime ?? now))) / 1000)}s left, ${bounds.mode}): ${issues.join(", ") || "score recovering"}`
      : (issues.length > 0
        ? `Active (${bounds.mode}, ${dir}, ${holdLabel}): ${issues.join(", ")}`
        : `Active (${bounds.mode}): SL=${slDistanceScore.toFixed(1)} Mom=${momentumScore.toFixed(1)} Vol=${volumeScore.toFixed(1)} Mkt=${marketContextScore.toFixed(1)}${spyDayDrop <= -0.015 ? " [Beta:FC@2.5]" : ""}`);

    const phase3Base: ZivHScoreResult = {
      score: finalScore,
      tier,
      suggestedAction,
      phase: "active",
      indicators: {
        momentumUp: momentumScore >= 5, volumeConfirmed: volumeScore >= 5, aboveEma20: favorableEma20,
        slDistance: slDistanceScore, momentum: momentumScore, volumeScore, marketContext: marketContextScore,
        profitCushion: slDistanceScore >= 5, trendSupport: favorableEma20, trendDominance: trendDominant,
        momentumStrength: dir === "long" ? rsi > 50 : rsi < 50, notOverExtended: true, volumeHealth: volumeScore >= 5,
      },
      bonuses: {
        riskFreeTrail: riskFree,
        targetProximity: takeProfit != null && takeProfit > 0 && Math.abs(currentPrice - takeProfit) / takeProfit <= 0.02,
        scoreImproved: false, recentBreakout: false, nearPeak: false, goodEntryTier: false,
      },
      penalties: {
        overExposure: false, deadCapital, reallocationSignal: false, underperformance: marketContextScore < 4,
        scoreDegraded: false, farFromPeak: false, hiddenDistribution: false,
      },
      details: activeDetails,
    };

    return applyZivHModifiers(
      phase3Base,
      computeZivHModifiers(currentPrice, entryPrice, atr14, dir, bars, ctx),
      { fcThreshold, graceActive, baseDetails: activeDetails },
    );
  }

  // ── Phase 4: Trail / Chandelier (> phase3 end) ────────────────────────────
  const pnlPct4 = zivHPnlPct(currentPrice, entryPrice, dir);
  const effectivePnlPct4 = (ctx?.ibkrUnrealizedPnl != null && ctx.positionValue != null && ctx.positionValue > 0)
    ? (ctx.ibkrUnrealizedPnl / (ctx.positionValue - ctx.ibkrUnrealizedPnl)) * 100
    : pnlPct4;
  const daysHeld4 = ctx?.daysHeld ?? (minutesInTrade / (60 * 24));
  const deadCapital4 = daysHeld4 > bounds.deadCapitalTrailDays
    && effectivePnlPct4 >= -0.5 && effectivePnlPct4 <= 0.5;

  const trailScore = deadCapital4 ? 3.5 : 7.0;
  const tier4: ZivHTier = deadCapital4 ? "Weak" : "Stable";
  const trailLabel = bounds.mode === "swing" ? "Chandelier trail" : "Trail mode";
  const action4 = deadCapital4
    ? `Dead capital (${daysHeld4.toFixed(0)}d, P/L ${effectivePnlPct4.toFixed(1)}%) — Force-Close.`
    : `${trailLabel} — holding. SL manages the exit.`;

  const riskFree4 = stopLoss != null && (
    dir === "long" ? stopLoss > entryPrice : stopLoss < entryPrice
  );

  const trailDetails = deadCapital4
    ? `Dead capital (${bounds.mode}): ${daysHeld4.toFixed(0)} days, P/L ${effectivePnlPct4.toFixed(1)}%`
    : `${trailLabel} (${bounds.mode}): ${daysHeld4.toFixed(0)} days held`;

  const phase4Base: ZivHScoreResult = {
    score: trailScore,
    tier: tier4,
    suggestedAction: action4,
    phase: "trail",
    indicators: {
      momentumUp: false, volumeConfirmed: false, aboveEma20: favorableEma20,
      slDistance: 5, momentum: 5, volumeScore: 5, marketContext: 5,
      profitCushion: false, trendSupport: favorableEma20, trendDominance: trendDominant,
      momentumStrength: dir === "long" ? rsi > 50 : rsi < 50, notOverExtended: true, volumeHealth: true,
    },
    bonuses: {
      riskFreeTrail: riskFree4,
      targetProximity: takeProfit != null && takeProfit > 0 && Math.abs(currentPrice - takeProfit) / takeProfit <= 0.02,
      scoreImproved: false, recentBreakout: false, nearPeak: false, goodEntryTier: false,
    },
    penalties: {
      overExposure: false, deadCapital: deadCapital4, reallocationSignal: false,
      underperformance: false, scoreDegraded: false, farFromPeak: false, hiddenDistribution: false,
    },
    details: trailDetails,
  };

  return applyZivHModifiers(
    phase4Base,
    computeZivHModifiers(currentPrice, entryPrice, atr14, dir, bars, ctx),
    { fcThreshold, baseDetails: trailDetails },
  );
}
