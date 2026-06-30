/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║                    SHORT ENGINE v2.0 (symmetric)                    ║
 * ║  Bear Breakdown + Bear Retest scoring for short positions.          ║
 * ║  Full long/short parity: shared 8-component decimal addon, structural ║
 * ║  true-retest tier, mirrored penny/illiquid guards. See spec          ║
 * ║  docs/superpowers/specs/2026-06-26-symmetric-short-engine.md.        ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Scoring Tiers (mirror of zivEngine long tiers):
 *   Bear Breakdown (9-10): Price breaks Donchian 20-day LOW + below EMA-200
 *                           + break volume. (+1 for bearish PA candle → 10.)
 *                           Does NOT hard-require weekly-negative (mirror of Gold
 *                           Breakout which does not require weekly-up; §4).
 *   Bear Retest    (7):    Structural retest of a broken support now acting as
 *                          resistance — EITHER detectTrueRetest(bars,"short")
 *                          OR detectRoleReversal(bars,"short"). Requires negative
 *                          weekly (mirror of Gold Retest requiring weekly-up; §4/§6.1).
 *   Weak Bear      (5):    Below EMA-200, downtrend, RSI < 45, no clear trigger.
 *
 * Risk Management:
 *   - Sizing: LIVE shorts size through the SAME path as longs in warEngine
 *     (recommendedPositionSize, $20k-$70k band) — NOT in this file. The old
 *     asymmetric calcShortPositionSize (5/4/3%) was DELETED (had zero callers; §5.2).
 *   - SL: ATR-based ABOVE entry (calcShortSL) or structural invalidationLevel
 *     (slCalculator RC-2) anchored to bear.retestLevel.
 *   - TP / squeeze / dividend / earnings guards live in the execution layer.
 *
 * §6.2 PENDING the owner's supply-zone definition (do NOT build yet): explicit
 *   supply-zone-touch scoring component + supply-zone-anchored SL. Until the
 *   zone-def lands, Donchian-low / 20-bar-high stand in as the supply proxy.
 */

import { calcEMA, calcRSI, calcDirectionalDecimalAddon, Bar } from './zivEngine';
import { detectRoleReversal } from './roleReversalEngine';
import { detectTrueRetest } from './trueRetestEngine';

export type BearTier = "Bear Breakdown" | "Bear Retest" | "Weak Bear" | "No Bear Signal" | "No Data";

export interface BearScoreResult {
  score: number;
  tier: BearTier;
  reason: string;
  price: number;
  ema50: number;
  ema200: number;
  donchian20Low: number;
  weeklyEma50Slope: number;
  rsi: number;
  volumeRatio: number;
  retestConfirmed: boolean;
  retestBarsAgo: number | null;
  /**
   * RC-2: the role-reversed/structural level this Bear-Retest entry is retesting
   * (broken support now acting as resistance). Stop belongs JUST ABOVE it
   * (invalidation). Null unless the qualifying setup is a structural support→
   * resistance reversal (priority: true-retest > role-reversal).
   */
  retestLevel?: number | null;
}

// ─── Bear Retest Detection (EMA-50, informational/addon only) ──────────────────
// A retest "fails" when:
//   1. High of bar >= EMA-50 × 0.98 (came within 2% of EMA-50)
//   2. Close of bar < EMA-50 (couldn't close above — failure confirmed)
//   3. This happened within the last 3 bars
function detectBearRetest(bars: Bar[], ema50: number): { confirmed: boolean; barsAgo: number | null } {
  if (bars.length < 4) return { confirmed: false, barsAgo: null };

  const last3 = bars.slice(-4, -1); // check last 3 completed bars (not current)
  for (let i = last3.length - 1; i >= 0; i--) {
    const bar = last3[i];
    const touchedEma50 = bar.high >= ema50 * 0.98;    // high came within 2% of EMA-50
    const closedBelow  = bar.close < ema50;            // but couldn't close above
    if (touchedEma50 && closedBelow) {
      return { confirmed: true, barsAgo: last3.length - i };
    }
  }
  return { confirmed: false, barsAgo: null };
}

function finalizeBearScore(baseTierScore: number, bearDecimalAddon: number): number {
  if (baseTierScore <= 0) return 0;
  // Mirror long: a base-10 tier (breakdown + bearish PA) reaches exactly 10.00;
  // otherwise cap at tier boundary (base + 0.99).
  if (baseTierScore >= 10) return 10.00;
  const capped = Math.min(baseTierScore + bearDecimalAddon, baseTierScore + 0.99);
  return Math.min(10.00, Math.round(capped * 100) / 100);
}

// ─── ATR-Based Stop Loss ───────────────────────────────────────────────────────
// Use ATR(14) × 1.5 above entry as stop loss for shorts.
// If ATR > 8%, fallback to fixed 8% stop.
export function calcShortSL(bars: Bar[], entryPrice: number): number {
  if (bars.length < 15) return entryPrice * 1.08; // fallback

  const recent = bars.slice(-15);
  const trValues = recent.slice(-14).map((b, i) => {
    const prev = recent[i]; // prev bar
    return Math.max(
      b.high - b.low,
      Math.abs(b.high - prev.close),
      Math.abs(b.low - prev.close)
    );
  });
  const atr14 = trValues.reduce((a, b) => a + b, 0) / trValues.length;
  const atrStop = entryPrice + atr14 * 1.5;
  const maxStop = entryPrice * 1.08; // never risk more than 8%

  return Math.min(atrStop, maxStop);
}

// ─── Main Bear Scoring Function ────────────────────────────────────────────────
export function calcBearScore(bars: Bar[]): BearScoreResult {
  if (bars.length < 50) {
    return {
      score: 0, tier: "No Data", reason: "Insufficient price history (need 50+ bars)",
      price: 0, ema50: 0, ema200: 0, donchian20Low: 0,
      weeklyEma50Slope: 0, rsi: 50, volumeRatio: 1,
      retestConfirmed: false, retestBarsAgo: null, retestLevel: null,
    };
  }

  const closes  = bars.map(b => b.close);
  const lastBar = bars[bars.length - 1];
  const lastClose = closes[closes.length - 1];

  // ── EMAs ──
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, 50);
  const ema200 = closes.length >= 200 ? calcEMA(closes, 200) : calcEMA(closes, closes.length);

  // ── Weekly EMA-50 slope ──
  const weeklyCloses   = closes.filter((_, i) => i % 5 === 0);
  const weeklyEma50Now = weeklyCloses.length >= 10
    ? calcEMA(weeklyCloses, Math.min(50, weeklyCloses.length)) : ema50;
  const weeklyEma50Old = weeklyCloses.length >= 14
    ? calcEMA(weeklyCloses.slice(0, -4), Math.min(50, weeklyCloses.length - 4)) : weeklyEma50Now;
  const weeklyEma50Slope = weeklyEma50Now - weeklyEma50Old;

  // ── Donchian 20-day LOW / HIGH ──
  const last20Bars = bars.slice(-20);
  const donchian20Low  = Math.min(...last20Bars.map(b => b.low));
  const donchian20High = Math.max(...last20Bars.map(b => b.high));

  // ── RSI ──
  const rsi = calcRSI(closes);

  // ── Volume ratio (5-day avg vs 20-day avg) ──
  const volumes  = bars.map(b => b.volume ?? 0);
  const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const avgVol5  = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const volumeRatio = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;

  // ── Illiquid suppressor (mirror zivEngine: < 10k shares/day avg = untradeable) ──
  const _avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const _isIlliquid = _avgVol > 0 && _avgVol < 10000;

  // ── Bearish Price Action Detection (mirror of zivEngine bullish PA, sign-flipped) ──
  const bodySize = Math.abs(lastBar.close - lastBar.open);
  const totalRange = lastBar.high - lastBar.low;
  const upperWick = lastBar.high - Math.max(lastBar.open, lastBar.close);
  const isShootingStar = totalRange > 0 && upperWick / totalRange >= 0.55 && bodySize / totalRange <= 0.35;
  const prevBar = bars[bars.length - 2];
  const isInsideBar = prevBar && lastBar.high <= prevBar.high && lastBar.low >= prevBar.low;
  const isBearishEngulfing = prevBar
    && lastBar.close < lastBar.open
    && prevBar.close > prevBar.open
    && lastBar.close < prevBar.open
    && lastBar.open > prevBar.close;
  const hasBearishPA = isShootingStar || isInsideBar || isBearishEngulfing;
  const bearPriceAction = isShootingStar ? "Shooting Star"
    : isInsideBar ? "Inside Bar"
    : isBearishEngulfing ? "Bearish Engulfing"
    : null;

  // ── ATR-14 / ATR-5 (contraction detection, mirror zivEngine) ──
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
  const atrContraction = atr14 > 0 && atr5 < atr14 * 0.75;
  const atrPct = lastClose > 0 ? (atr14 / lastClose) * 100 : 0;

  // ── 52-Week LOW proximity (mirror of 52w HIGH) ──
  const lookback52w = bars.slice(-252);
  const low52w  = lookback52w.length > 0 ? Math.min(...lookback52w.map(b => b.low))  : lastClose;
  const high52w = lookback52w.length > 0 ? Math.max(...lookback52w.map(b => b.high)) : lastClose;
  const pctFrom52wLow  = low52w  > 0 ? ((lastClose - low52w)  / low52w)  * 100 : 0;  // ≥0, near low = strong
  const pctFrom52wHigh = high52w > 0 ? ((lastClose - high52w) / high52w) * 100 : 0;  // ≤0

  // ── Trend Weakness inputs (mirror Trend Strength) ──
  const ema50Prev10  = calcEMA(closes.slice(0, -10), 50);
  const ema50SlopePct = ema50Prev10 > 0 ? ((ema50 - ema50Prev10) / ema50Prev10) * 100 : 0;
  const last10Closes = closes.slice(-11);
  let consecutiveUpBars = 0, consecutiveDownBars = 0;
  for (let i = 1; i < last10Closes.length; i++) {
    if (last10Closes[i] > last10Closes[i - 1]) consecutiveUpBars++;
    else if (last10Closes[i] < last10Closes[i - 1]) consecutiveDownBars++;
  }
  const pricePremiumToEma50 = ema50 > 0 ? ((lastClose - ema50) / ema50) * 100 : 0;
  const donchianWidthPct = donchian20High > 0 ? ((donchian20High - donchian20Low) / donchian20High) * 100 : 0;

  // ── Structural retest detection ───────────────────────────────────────────────
  const retest = detectBearRetest(bars, ema50);   // EMA-50 retest (informational/addon only)
  // ELZA 2.0 (mirror of P0-3): structural bear true-retest — support broke down,
  // rallied back to it as resistance, HELD below 5 candles. Priority over role-rev.
  const trueBreakdownRetest = detectTrueRetest(bars, "short");
  // Role reversal (BR1/BR2) — support broke down, retested from below as resistance.
  const bearRR = detectRoleReversal(bars, "short");

  // ── Build the 8-component decimal addon via the shared (anti-drift) helper ──────
  const mkAddon = (tierKind: "breakout" | "retest" | "other", proximityLevel: number | null) =>
    calcDirectionalDecimalAddon({
      tierKind,
      rsi, volumeRatio, lastClose, ema20, ema50,
      donchian20High, donchian20Low, proximityLevel,
      pctFrom52wHigh, pctFrom52wLow,
      atrContraction, ema50SlopePct,
      consecutiveUpBars, consecutiveDownBars,
      pricePremiumToEma50, donchianWidthPct, atrPct,
    }, "short");

  // ── Scoring Logic ──────────────────────────────────────────────────────────

  const isBelowEma200    = lastClose < ema200;
  const isBelowDonchian  = lastBar.low <= donchian20Low || lastClose <= donchian20Low * 1.005; // at/near 20d low
  const isWeeklyNegative = weeklyEma50Slope < 0;
  const hasBreakVolume   = volumeRatio >= 1.3;

  // ── Bear Breakdown (9-10): mirror of Gold Breakout. Requires below-EMA-200 +
  // at/below Donchian-low + break volume. Does NOT hard-require weekly-negative
  // (the per-ticker weekly gate is enforced ONCE at the warEngine boundary via
  // intel.weeklyAligned, §4). Illiquid breakdowns are suppressed (mirror zivEngine).
  if (isBelowEma200 && isBelowDonchian && hasBreakVolume) {
    if (_isIlliquid) {
      // fall through to lower tiers — a thin-volume "breakdown" cannot score 9.
    } else {
      const bearDecimalAddon = mkAddon("breakout", null);
      const base = hasBearishPA ? 10 : 9;
      return {
        score: finalizeBearScore(base, bearDecimalAddon), tier: "Bear Breakdown",
        reason: `Bear Breakdown: Close $${lastClose.toFixed(2)} at/below Donchian 20d-low $${donchian20Low.toFixed(2)}, below EMA-200 $${ema200.toFixed(2)}, Volume ${volumeRatio.toFixed(1)}x avg, RSI=${rsi.toFixed(0)}, Weekly EMA-50 slope=${weeklyEma50Slope.toFixed(2)}.${bearPriceAction ? ` ${bearPriceAction} candle confirms.` : ""}`,
        price: lastClose, ema50, ema200, donchian20Low, weeklyEma50Slope, rsi, volumeRatio,
        retestConfirmed: false, retestBarsAgo: null, retestLevel: null,
      };
    }
  }

  // ── Bear Retest (7): structural support→resistance retest. Qualifies on EITHER
  // detectTrueRetest(bars,"short") OR detectRoleReversal(bars,"short") (priority:
  // true-retest > role-reversal). Requires negative weekly (mirror Gold Retest).
  if ((trueBreakdownRetest.isRetest || bearRR.isReversal) && isBelowEma200 && isWeeklyNegative) {
    const structLevel = trueBreakdownRetest.isRetest
      ? trueBreakdownRetest.priorBreakoutLevel
      : (bearRR.isReversal ? bearRR.level : null);
    let base = hasBearishPA ? 8 : 7;
    if (_isIlliquid) base = Math.max(3, base - 3);
    const bearDecimalAddon = mkAddon("retest", structLevel);
    const struct = trueBreakdownRetest.isRetest
      ? `True retest of $${trueBreakdownRetest.priorBreakoutLevel?.toFixed(2)} (held ${trueBreakdownRetest.heldCandles}/${trueBreakdownRetest.confirmCandles}, dist ${trueBreakdownRetest.distPct?.toFixed(1)}%)`
      : `Role reversal at $${bearRR.level?.toFixed(2)} (support→resistance, dist ${bearRR.distPct?.toFixed(1)}%)`;
    return {
      score: _isIlliquid ? 0 : finalizeBearScore(base, bearDecimalAddon),
      tier: _isIlliquid ? "No Bear Signal" : "Bear Retest",
      reason: `Bear Retest (structural): ${struct} in a bearish trend. Below EMA-200, weekly slope neg.${retest.confirmed ? " EMA-50 retest also confirmed." : ""}${bearPriceAction ? ` ${bearPriceAction} candle confirms.` : ""}`,
      price: lastClose, ema50, ema200, donchian20Low, weeklyEma50Slope, rsi, volumeRatio,
      retestConfirmed: retest.confirmed, retestBarsAgo: retest.barsAgo, retestLevel: structLevel,
    };
  }

  // ── Weak Bear (5-6): Below EMA-200, downtrend, but no trigger event ──
  if (isBelowEma200 && isWeeklyNegative && rsi < 45) {
    const bearDecimalAddon = mkAddon("other", null);
    return {
      score: finalizeBearScore(5, bearDecimalAddon), tier: "Weak Bear",
      reason: `Weak Bear: Below EMA-200, Weekly slope negative, RSI=${rsi.toFixed(0)} < 45. No breakdown/retest trigger.`,
      price: lastClose, ema50, ema200, donchian20Low, weeklyEma50Slope, rsi, volumeRatio,
      retestConfirmed: false, retestBarsAgo: null, retestLevel: null,
    };
  }

  // No signal
  return {
    score: 0, tier: "No Bear Signal",
    reason: `No short signal: Close $${lastClose.toFixed(2)}, EMA-200 $${ema200.toFixed(2)}, Weekly slope ${weeklyEma50Slope.toFixed(2)}, RSI ${rsi.toFixed(0)}.`,
    price: lastClose, ema50, ema200, donchian20Low, weeklyEma50Slope, rsi, volumeRatio,
    retestConfirmed: false, retestBarsAgo: null, retestLevel: null,
  };
}

// ─── Short Squeeze Guard ───────────────────────────────────────────────────────
// Returns true if position should be exited due to squeeze risk
// Checks: daily gain > 3% from entry price (not % in a single 5-min candle)
export function isShortSqueezeTriggered(entryPrice: number, currentPrice: number): boolean {
  const gainPct = ((currentPrice - entryPrice) / entryPrice) * 100;
  return gainPct > 3.0; // position is moving against us > 3%
}
