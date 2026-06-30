/**
 * Elza v4.5 Master — LONG engine live-capable; SHORT engine BACKTEST-ONLY (2022),
 * must NEVER fire live. Leverage is OWNER-CONTROLLED DYNAMICALLY via the WAR ROOM:
 * INTRADAY_LEVERAGE (default 4.0×, high firepower while the owner is at the desk)
 * reduced to OVERNIGHT_LEVERAGE (default 1.9×) before close via the overnight
 * gross-cap wall — intraday-heavy / overnight-light is deliberate gap protection.
 * The 3 gap-walls MITIGATE but do NOT eliminate overnight-gap risk. CRO
 * recommendation (logged): validate gap-walls live at lower leverage for the first
 * 4-8 weeks before pressing full firepower.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * PURE DECISION LOGIC. NO DB writes. NO IBKR calls. NO order placement. Every
 * exported function in this module is a pure function of its inputs — live wiring
 * (sizing→order→stop→DB) is a SEPARATE, GATED step that lives in the execution
 * layer (warEngine / liveOrderExecutor), never here.
 *
 * Reuses the shared `Bar` shape from zivEngine (date/open/high/low/close/volume?).
 * ──────────────────────────────────────────────────────────────────────────────
 */

import type { Bar } from "../zivEngine";

export type { Bar };

// ─── Config ────────────────────────────────────────────────────────────────────

/**
 * Volatility-class caps — how many open positions of one high-volatility theme we
 * allow concurrently. Correlated names crash together; this caps cluster risk.
 */
export interface VolClassCaps {
  SEMIS: number;
  CRYPTO: number;
  AI_DATA: number;
  NUCLEAR: number;
  SPACE: number;
}

export interface ElzaV45Config {
  /** INTRADAY firepower while the owner is at the desk. Owner-settable, dynamic. */
  INTRADAY_LEVERAGE: number;
  /** OVERNIGHT firepower — the gross-cap wall trims to this before the bell. Owner-settable, dynamic. */
  OVERNIGHT_LEVERAGE: number;
  LONG_MIN_SCORE: number;
  MIN_CONFLUENCE: number;
  MIN_LIQUIDITY: number;
  MAX_CONCURRENT: number;
  MAX_PER_SECTOR: number;
  /** Per-name heat (risk) as a fraction of portfolio. */
  HEAT_MAX_PCT: number;
  MAX_POSITION_USD: number;
  /**
   * Circuit-breaker trigger. A PORTFOLIO-% trigger (not a $ figure) so it
   * auto-scales with whatever live leverage the owner has set.
   */
  MAX_DAILY_LOSS_PCT: number;
  VIX_REDUCE: number;
  VIX_BLOCK: number;
  RSI_GREED: number;
  RSI_FEAR: number;
  VOL_CLASS_CAPS: VolClassCaps;
}

export const ELZA_V45_CFG: ElzaV45Config = {
  INTRADAY_LEVERAGE: 4.0, // owner-settable, dynamic (War Room)
  OVERNIGHT_LEVERAGE: 1.9, // owner-settable, dynamic (War Room)
  LONG_MIN_SCORE: 7.0,
  MIN_CONFLUENCE: 4.5,
  MIN_LIQUIDITY: 2.0,
  MAX_CONCURRENT: 12,
  MAX_PER_SECTOR: 3,
  HEAT_MAX_PCT: 0.2,
  MAX_POSITION_USD: 85000,
  MAX_DAILY_LOSS_PCT: 0.07, // portfolio-% — auto-scales with live leverage
  VIX_REDUCE: 25,
  VIX_BLOCK: 35,
  RSI_GREED: 75,
  RSI_FEAR: 30,
  VOL_CLASS_CAPS: { SEMIS: 3, CRYPTO: 2, AI_DATA: 3, NUCLEAR: 2, SPACE: 2 },
};

// ─── Shared math (pure, self-contained) ─────────────────────────────────────────

/**
 * SMA-seeded EMA — BIT-IDENTICAL to server/zivEngine.ts `calcEMA`, which is what
 * the VALIDATED v4.5 backtest (scripts/elzaV45GoldenDNA.ts) scored against. The
 * SSOT MUST use this exact seeding (simple-average of the first `period` closes,
 * then the recursive step) — the prior `closes[0]`-seeded EMA silently diverged
 * from the backtest. "Live == Backtest" → this is the authoritative EMA.
 */
function ema(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

/**
 * RSI — BIT-IDENTICAL to server/zivEngine.ts `calcRSI` (the validated backtest's
 * RSI). Note the `< period + 1 → 50` floor and the `losses || 0.0001` divisor
 * (NOT a 100-cap on zero-loss): these differ from a naive RSI and MUST match (B).
 */
function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const rs = gains / (losses || 0.0001);
  return 100 - 100 / (1 + rs);
}

/** Wilder-style ATR over the last `period` true ranges ending at bar `i`. */
function atr14(bars: Bar[], i: number, period = 14): number {
  if (i < 1) return NaN;
  const start = Math.max(1, i - period + 1);
  let sum = 0;
  let n = 0;
  for (let k = start; k <= i; k++) {
    const tr = Math.max(
      bars[k].high - bars[k].low,
      Math.abs(bars[k].high - bars[k - 1].close),
      Math.abs(bars[k].low - bars[k - 1].close),
    );
    sum += tr;
    n++;
  }
  return n > 0 ? sum / n : NaN;
}

/** Donchian high over `period` bars ending at i (inclusive). */
function donchianHigh(bars: Bar[], i: number, period = 20): number {
  const start = Math.max(0, i - period + 1);
  let h = -Infinity;
  for (let k = start; k <= i; k++) h = Math.max(h, bars[k].high);
  return h;
}

/** Donchian low over `period` bars ending at i (inclusive). */
function donchianLow(bars: Bar[], i: number, period = 20): number {
  const start = Math.max(0, i - period + 1);
  let l = Infinity;
  for (let k = start; k <= i; k++) l = Math.min(l, bars[k].low);
  return l;
}

/** Average volume over the prior `period` bars BEFORE i (excludes i itself). */
function avgVol(bars: Bar[], i: number, period = 20): number {
  const start = Math.max(0, i - period);
  let sum = 0;
  let n = 0;
  for (let k = start; k < i; k++) {
    sum += bars[k].volume ?? 0;
    n++;
  }
  return n > 0 ? sum / n : 0;
}

function closesUpTo(bars: Bar[], i: number): number[] {
  return bars.slice(0, i + 1).map((b) => b.close);
}

// ─── Intel (caller-supplied confluence / liquidity context) ─────────────────────

export interface ElzaIntel {
  /** Multi-factor confluence score (caller's aggregation). Gate ≥ MIN_CONFLUENCE. */
  confluence: number;
  /** Liquidity score (e.g. ADV / spread quality). Gate ≥ MIN_LIQUIDITY. */
  liquidity: number;
  /** Optional weekly EMA-50 slope (% over lookback). >0 required for Gold Retest. */
  weeklySlope?: number;
}

// ─── LONG engine (live-capable) ─────────────────────────────────────────────────

export type LongTier = "TIER3_GOLD_RETEST" | "TIER4_POWER_BREAKOUT";

export interface LongScore {
  tier: LongTier;
  totalScore: number;
  entry: number;
  initialSL: number;
  /**
   * Fraction of a full position (Tier-3 = 1.0 conviction, Tier-4 = 0.5 starter).
   *
   * ⚠️ INTENTIONALLY NOT CONSUMED by the live sizer (CV-C). The VALIDATED v4.5
   * backtest (scripts/elzaV45GoldenDNA.ts) sizes BOTH tiers at the SAME 1% base
   * risk — it never reads any tier sizeFraction. Wiring this field into the live
   * 1%-risk path would make Tier-4 entries HALF the size the backtest took and
   * BREAK Live==Backtest. The field is retained only because the parity-proof /
   * entry-wiring tests assert on it; the live sizer (`vixRiskSize` below) deliberately
   * ignores it. See server/warEngineVixSizing.test.ts (TIER-PARITY).
   */
  sizeFraction: number;
  /** Risk per share = entry − initialSL (long). Caller turns this into share count. */
  rValue: number;
}

// ─── Genesis scorer — the VALIDATED backtest brain, now the SSOT ──────────────────

/** Backtest tier labels (string form used by the validated flight recorder). */
export type GenesisTier = "Gold Retest" | "Gold Breakout";

export interface GenesisScore {
  tier: GenesisTier | null;
  baseScore: number;
  /** Decimal addon, capped at +0.99 (Σ of the 8 sub-scores). */
  subScore: number;
  /** baseScore + subScore. */
  totalScore: number;
  price: number;
  ema20: number;
  ema50: number;
  ema200: number;
}

/**
 * ATR over `period` true ranges ending at the LAST bar of `window` — BIT-IDENTICAL
 * to the backtest's `atrOver` (period = min(period, len-1); divides by that p).
 * This differs from `atr14()` above (which is bar/index-anchored); the backtest's
 * sub-scores use THIS window-anchored form, so the SSOT must too.
 */
function atrOverWindow(window: Bar[], period: number): number {
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
 * Bullish price-action detector — BIT-IDENTICAL to the backtest's `hasBullishPA`.
 * Hammer / inside-bar / bullish-engulfing on the last two bars of `window`. A
 * +1 base bump (7→8 retest, 9→10 breakout) in the validated backtest.
 */
function hasBullishPA(window: Bar[]): boolean {
  const lastBar = window[window.length - 1];
  const prevBar = window[window.length - 2];
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
 * genesisScore — THE SSOT scorer, reconciled to reproduce the VALIDATED v4.5
 * backtest (scripts/elzaV45GoldenDNA.ts `genesisScore`) EXACTLY. Score the bar at
 * index `i` from data up to (and including) i. Precedence: Gold Breakout → Gold
 * Retest. tier===null → no signal.
 *
 * Tiers (price > EMA200 required by both — Breakout-Override is intentionally
 * OMITTED because it needs price < EMA200, violating the §0 macro guard):
 *   Gold Breakout (Tier-4): price ≥ Donchian20High×0.995 & > EMA50 & > EMA200.
 *                           base 9, or 10 with Bullish PA.
 *   Gold Retest   (Tier-3): price > EMA200 & weekly-EMA50 slope > 0 & |Δ EMA50| ≤ 3%.
 *                           base 7, or 8 with Bullish PA.
 *
 * The 8 sub-scores (Σ capped at +0.99) match the backtest term-for-term: RSI band,
 * 5/20 volume ratio, EMA-50 proximity (linear), EMA20>EMA50 cross, 52w-high
 * proximity, ATR contraction (atr5 < 0.75×atr14), trend (capped 0.20), profit
 * potential (capped 0.20). Pure — no DB / IBKR / order side effects.
 */
export function genesisScore(bars: Bar[], i: number): GenesisScore {
  const NONE: GenesisScore = {
    tier: null, baseScore: 0, subScore: 0, totalScore: 0,
    price: 0, ema20: 0, ema50: 0, ema200: 0,
  };
  if (i < 1) return NONE;

  const window = bars.slice(0, i + 1);
  const closes = window.map((b) => b.close);
  const price = closes[closes.length - 1];
  if (!(price > 0)) return NONE;

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = closes.length >= 200 ? ema(closes, 200) : ema(closes, closes.length);

  const weeklyCloses = closes.filter((_, idx) => idx % 5 === 0);
  const weeklyEma50Now = weeklyCloses.length >= 10
    ? ema(weeklyCloses, Math.min(50, weeklyCloses.length))
    : (weeklyCloses[weeklyCloses.length - 1] ?? price);
  const weeklyEma50Prev = weeklyCloses.length >= 14
    ? ema(weeklyCloses.slice(0, -4), Math.min(50, weeklyCloses.length - 4))
    : weeklyEma50Now;
  const weeklyEma50Slope = weeklyEma50Now - weeklyEma50Prev;

  const last20 = window.slice(-20);
  const donchian20High = Math.max(...last20.map((b) => b.high));
  const donchian20Low = Math.min(...last20.map((b) => b.low));

  const volumes = window.map((b) => b.volume ?? 0);
  const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length || 1);
  const avgVol5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, volumes.length || 1);
  const volRatio = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;

  const distEma50 = ema50 > 0 ? Math.abs(price - ema50) / ema50 : 999;

  const bullishPA = hasBullishPA(window);

  let tier: GenesisTier | null = null;
  let baseScore = 0;
  let isBreakoutTier = false;

  if (price >= donchian20High * 0.995 && price > ema50 && price > ema200) {
    tier = "Gold Breakout";
    baseScore = bullishPA ? 10 : 9;
    isBreakoutTier = true;
  } else if (price > ema200 && weeklyEma50Slope > 0 && distEma50 <= 0.03) {
    tier = "Gold Retest";
    baseScore = bullishPA ? 8 : 7;
  }

  if (tier === null) return NONE;

  const rsiVal = rsi(closes);
  let sub = 0;

  if (isBreakoutTier) {
    if (rsiVal >= 60 && rsiVal <= 85) sub += 0.20;
  } else {
    if (rsiVal >= 50 && rsiVal <= 70) sub += 0.20;
    else if (rsiVal > 80) sub += 0.05;
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
  const high52w = lookback52w.length > 0 ? Math.max(...lookback52w.map((b) => b.high)) : price;
  const pctFrom52w = high52w > 0 ? (high52w - price) / high52w : 1;
  if (pctFrom52w <= 0.02) sub += 0.10;
  else if (pctFrom52w <= 0.05) sub += 0.06;

  const atr5 = atrOverWindow(window, 5);
  const atr14v = atrOverWindow(window, 14);
  if (atr14v > 0 && atr5 < atr14v * 0.75) sub += 0.08;

  let trend = 0;
  const ema50Prev10 = closes.length > 10 ? ema(closes.slice(0, -10), 50) : ema50;
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
  const atrPct = price > 0 ? atr14v / price : 0;
  if (atrPct > 0.04) profit += 0.07;
  if (price >= high52w) profit += 0.05;
  sub += Math.min(0.20, profit);

  const subScore = Math.min(0.99, sub);
  const totalScore = baseScore + subScore;

  return { tier, baseScore, subScore, totalScore, price, ema20, ema50, ema200 };
}

/** Map the backtest's string tier to the live LongTier enum. */
function toLongTier(t: GenesisTier): LongTier {
  return t === "Gold Breakout" ? "TIER4_POWER_BREAKOUT" : "TIER3_GOLD_RETEST";
}

/**
 * AUTHORITATIVE initial stop — the "wide lung" structural stop.
 *   LONG : max(entry × 0.92, ema50 × 0.99)
 *   SHORT: min(entry × 1.08, ema50 × 1.01)
 * NOT a tight swing-low: tight stops proved to collapse win-rate (they get wicked
 * out of structurally-valid trades). This is the stop the live entry is paired
 * with — never-naked-SL is enforced in the execution layer using THIS value.
 */
export function wideLungSL(entry: number, ema50: number, dir: "long" | "short"): number {
  // FAIL CLOSED: a non-finite or non-positive input cannot produce a trustworthy
  // structural stop. Throwing here means the execution layer can NEVER pair a live
  // entry with a garbage stop (never-naked-SL relies on THIS value being sane).
  if (!Number.isFinite(entry) || !Number.isFinite(ema50) || entry <= 0) {
    throw new Error(`wideLungSL: invalid inputs entry=${entry} ema50=${ema50}`);
  }
  if (dir === "long") {
    return Math.max(entry * 0.92, ema50 * 0.99);
  }
  return Math.min(entry * 1.08, ema50 * 1.01);
}

/**
 * scoreLong — pure LONG decision. Returns null when no qualifying setup OR a gate
 * fails. Two tiers:
 *   Tier-3 Gold Retest   — price>EMA200, weeklySlope>0, |Δ vs EMA50|≤3%. base 7
 *                          (+addon → up to ~8). Full conviction sizeFraction 1.0.
 *   Tier-4 Power Breakout — price≥Donchian20H×0.995, >EMA50, >EMA200, REQUIRES a
 *                          volume spike ≥1.5×avg20. base 9 (+addon → up to ~10).
 *                          Starter sizeFraction 0.5.
 * Gate: totalScore≥7.0 AND intel.confluence≥4.5 AND intel.liquidity≥2.0.
 */
export function scoreLong(
  bars: Bar[],
  i: number,
  intel: ElzaIntel,
  cfg: ElzaV45Config = ELZA_V45_CFG,
): LongScore | null {
  // The Tier-3/Tier-4 trend gates depend on a REAL EMA-200 (price>ema200). With
  // fewer than 200 bars the EMA-200 is under-seeded and the trend gate is
  // meaningless, so suppress any signal. Live carries 420+ bars so this never
  // hurts live; it only kills under-seeded early-window signals. (This is the
  // SSOT's own fail-closed guard — the backtest never scores under-seeded bars
  // because it walks a warmup window, so this floor does NOT change any (B)
  // result; it only protects live from a thin-history EMA-200.)
  const MIN_HISTORY = 200;
  if (i < MIN_HISTORY || i >= bars.length) return null;

  // SSOT scorer — reconciled to the validated backtest (B). intel.weeklySlope is
  // intentionally NOT consulted here: the backtest's Tier-3 retest derives the
  // weekly EMA-50 slope INTERNALLY from the bar series (closes filtered idx%5),
  // so genesisScore is fully self-contained. Feeding an external weeklySlope here
  // would re-introduce a parity divergence — DON'T.
  const gs = genesisScore(bars, i);
  if (gs.tier === null) return null;

  const totalScore = gs.totalScore;

  // ─── Gate ─────────────────────────────────────────────────────────────────
  if (
    totalScore < cfg.LONG_MIN_SCORE ||
    intel.confluence < cfg.MIN_CONFLUENCE ||
    intel.liquidity < cfg.MIN_LIQUIDITY
  ) {
    return null;
  }

  const tier = toLongTier(gs.tier);
  const entry = gs.price;
  const initialSL = wideLungSL(entry, gs.ema50, "long");
  const rValue = entry - initialSL;
  // A long stop MUST sit below entry — otherwise the trade has no defined risk.
  if (!(rValue > 0)) return null;

  const sizeFraction = tier === "TIER3_GOLD_RETEST" ? 1.0 : 0.5;

  return { tier, totalScore, entry, initialSL, sizeFraction, rValue };
}

// ─── §2 VIX entry guard + 1%-risk sizing — the VALIDATED backtest, now the SSOT ───

/**
 * §2 VIX size band — BIT-IDENTICAL to the validated backtest
 * (scripts/elzaV45GoldenDNA.ts §2: VIX_BLOCK=35, VIX_HALF=25, VIX_MID_MULT=0.70).
 *
 *   vix  > 35  → BLOCK  (no entry; handled by the caller / CV-A guard)
 *   vix  > 25  → ×0.70  (elevated)
 *   vix  ≤ 25  → ×1.00  (calm)
 *
 * FAIL CLOSED: a non-finite VIX read is a degraded/defensive BLOCK (block=true).
 * NOTE: spyMult is intentionally ABSENT here — live Defense Mode (SPY<EMA50 → BLOCK)
 * covers the SPY regime more conservatively than the backtest's ×0.5, so a live
 * trade always has backtest spyMult=1.0. Do NOT add ×0.5 here.
 */
export const VIX_BLOCK_LEVEL = 35;
export const VIX_HALF_LEVEL = 25;
export const VIX_MID_MULT = 0.70;

export interface VixSizeBand {
  block: boolean;
  vixMult: number;
}

export function vixSizeBand(vix: number): VixSizeBand {
  if (!Number.isFinite(vix)) return { block: true, vixMult: 0 };
  if (vix > VIX_BLOCK_LEVEL) return { block: true, vixMult: 0 };
  return { block: false, vixMult: vix > VIX_HALF_LEVEL ? VIX_MID_MULT : 1.0 };
}

export interface VixRiskSizeInput {
  /** Net liquidation value (equity) the 1% risk is taken against. */
  nlv: number;
  /** Live IBKR entry price the order is sized/priced off. */
  entry: number;
  /** The wide-lung stop the broker order is actually paired with (wideLungSL). */
  stop: number;
  /** Live VIX proxy (regime.vixProxy). >35 → block; >25 → ×0.70; ≤25 → ×1.0. */
  vix: number;
}

export interface VixRiskSizeResult {
  /** True → fail-closed: do NOT enter (VIX block, bad inputs, or non-positive risk). */
  skip: boolean;
  reason: string;
  vixMult: number;
  perShareRisk: number;
  riskDollars: number;
  shares: number;
  perPosUsd: number;
}

/**
 * vixRiskSize — the AUTHORITATIVE live mirror of the backtest's per-trade sizing
 * (scripts/elzaV45GoldenDNA.ts runPortfolio §2, lines ~546/558):
 *
 *   riskDollars = NLV × 0.01 × vixMult           (spyMult=1.0 live — Defense Mode covers SPY)
 *   perShareRisk = entry − stop                  (stop = wideLungSL, the actual broker stop)
 *   shares       = floor(riskDollars / perShareRisk)
 *   perPosUsd    = shares × entry
 *
 * This is bit-for-bit the backtest's `notional = riskDollars / stopDistPct`
 * (= riskDollars × entry / perShareRisk), with the live share floor applied.
 *
 * sizeFraction is INTENTIONALLY NOT consumed (CV-C): the backtest sizes BOTH tiers
 * at the SAME 1% base risk. FAIL CLOSED on VIX>35, non-finite VIX, or perShareRisk≤0.
 */
export const BASE_RISK_PCT = 0.01;

export function vixRiskSize(input: VixRiskSizeInput): VixRiskSizeResult {
  const { nlv, entry, stop, vix } = input;
  const band = vixSizeBand(vix);
  if (band.block) {
    return { skip: true, reason: Number.isFinite(vix) ? `VIX ${vix} > ${VIX_BLOCK_LEVEL} — block` : "VIX not finite — block", vixMult: 0, perShareRisk: 0, riskDollars: 0, shares: 0, perPosUsd: 0 };
  }
  const perShareRisk = entry - stop;
  if (!Number.isFinite(perShareRisk) || perShareRisk <= 0) {
    return { skip: true, reason: `perShareRisk ${perShareRisk} ≤ 0 — block`, vixMult: band.vixMult, perShareRisk, riskDollars: 0, shares: 0, perPosUsd: 0 };
  }
  if (!Number.isFinite(nlv) || nlv <= 0 || !Number.isFinite(entry) || entry <= 0) {
    return { skip: true, reason: `bad nlv/entry (nlv=${nlv} entry=${entry}) — block`, vixMult: band.vixMult, perShareRisk, riskDollars: 0, shares: 0, perPosUsd: 0 };
  }
  const riskDollars = nlv * BASE_RISK_PCT * band.vixMult;
  const shares = Math.floor(riskDollars / perShareRisk);
  const perPosUsd = shares * entry;
  return { skip: false, reason: `vixMult ${band.vixMult} → ${shares} sh`, vixMult: band.vixMult, perShareRisk, riskDollars, shares, perPosUsd };
}

// ─── GOLDEN 5:1 EXIT — the VALIDATED backtest ladder, now the SSOT ───────────────

/**
 * Golden 5:1 exit constants — reconciled to the validated backtest (B). Note the
 * Chandelier multiple is 2.5× (a WIDE trail), NOT 1.5×; and there is NO standalone
 * +1.5R breakeven stage — breakeven is moved AT the +2.5R scale-out, together.
 */
export const GOLDEN_SCALE_R = 2.5; // +2.5R → scale-out 40% + move stop to breakeven
export const GOLDEN_SCALE_BANK_FRAC = 0.40; // 40% banked at the +2.5R scale
export const GOLDEN_RUNNER_FRAC = 0.60; // 60% runner to +5R / chandelier
export const GOLDEN_TP_FINAL_R = 5.0; // +5.0R final take-profit
export const GOLDEN_CHANDELIER_ATR_MULT = 2.5; // WIDE chandelier = peakHigh − 2.5×ATR14
export const GOLDEN_TIME_STOP_BARS = 60; // pre-scale-out 60-bar backstop only

/** ATR-14 over a window (SSOT mirror of the backtest's pre-scale chandelier ATR). */
export function goldenAtr14(window: Bar[]): number | null {
  if (window.length < 2) return null;
  const period = Math.min(14, window.length - 1);
  let atrSum = 0;
  for (let k = window.length - period; k < window.length; k++) {
    atrSum += Math.max(
      window[k].high - window[k].low,
      Math.abs(window[k].high - window[k - 1].close),
      Math.abs(window[k].low - window[k - 1].close),
    );
  }
  return atrSum / period;
}

export type ExitAction =
  | "HOLD"
  | "SCALE_40"
  | "TP_FINAL"
  | "TRAIL_EXIT"
  | "STOP";

export interface ExitDecision {
  action: ExitAction;
  /** The price the action references (scale price, TP, trail, or stop). */
  price: number;
}

/**
 * Open position view for the per-bar exit machine. `scaled` records whether the
 * +2.5R scale-out has already fired (= breakeven moved + chandelier armed).
 * `peak` is the highest HIGH seen since entry (caller maintains it); `priorTrail`
 * is the last chandelier level (caller persists it; starts at −Infinity / 0).
 *
 * NOTE: `movedBE` and `chandelierArmed` are RETAINED on the interface only for
 * back-compat with existing callers — the reconciled (B) ladder folds breakeven
 * INTO the scale-out, so `scaled === true` IS "BE moved + chandelier armed".
 */
export interface OpenPositionView {
  side: "long";
  entry: number;
  initialSL: number;
  rValue: number; // entry − initialSL
  atr14: number;
  peak: number;
  scaled: boolean; // +2.5R scale-out fired (40% banked, BE moved, chandelier armed)?
  /** @deprecated (B) folds BE into the scale-out; kept for caller back-compat. */
  chandelierArmed?: boolean;
  priorTrail: number; // last chandelier level (−Infinity / 0 if none)
  /** @deprecated (B) folds BE into the scale-out; kept for caller back-compat. */
  movedBE?: boolean;
}

/**
 * goldenExitDecision — pure, per-bar exit-stage machine, reconciled to reproduce
 * the VALIDATED backtest (B) inline exit walk EXACTLY. SL-FIRST-ON-TIE is strict:
 * a bar whose LOW breaches the working stop returns STOP/TRAIL_EXIT BEFORE any
 * scale-out or take-profit, even if the same bar's HIGH reaches the target.
 *
 *   PRE-scale (full size, stop = initialSL = −1R):
 *     • bar.low ≤ initialSL                → STOP @ initialSL
 *     • else bar.high ≥ entry + 2.5R       → SCALE_40 @ +2.5R (bank 40%, move stop
 *                                            to breakeven, arm a 2.5×ATR chandelier)
 *   POST-scale (60% runner, stop = max(breakeven, chandelier 2.5×ATR)):
 *     • bar.low ≤ workingStop              → TRAIL_EXIT @ workingStop
 *                                            (this is the BE stop or the ratcheted
 *                                            chandelier — whichever is higher)
 *     • else bar.high ≥ entry + 5.0R       → TP_FINAL @ +5.0R
 *
 * The 60-bar time-stop is a SERIES-level backstop (pre-scale only) handled by
 * goldenExitWalk, not this single-bar evaluator. Returns HOLD when nothing fires.
 */
export function goldenExitDecision(pos: OpenPositionView, bar: Bar): ExitDecision {
  const r = pos.rValue;
  const entry = pos.entry;
  const price = bar.close;
  const peak = Math.max(pos.peak, bar.high);

  if (!pos.scaled) {
    // PHASE 1 — full size, stop at the initial SL (−1R). SL-FIRST-ON-TIE strict.
    if (bar.low <= pos.initialSL) {
      return { action: "STOP", price: pos.initialSL };
    }
    if (r > 0 && bar.high >= entry + GOLDEN_SCALE_R * r) {
      return { action: "SCALE_40", price: entry + GOLDEN_SCALE_R * r };
    }
    return { action: "HOLD", price };
  }

  // PHASE 2 — 60% runner. Stop = max(breakeven, chandelier 2.5×ATR), ratcheted by
  // the caller via priorTrail/peak. Never below breakeven (entry).
  const chandelier = peak - GOLDEN_CHANDELIER_ATR_MULT * pos.atr14;
  const workingStop = Math.max(entry, pos.priorTrail, chandelier);

  if (bar.low <= workingStop) {
    return { action: "TRAIL_EXIT", price: workingStop };
  }
  if (r > 0 && bar.high >= entry + GOLDEN_TP_FINAL_R * r) {
    return { action: "TP_FINAL", price: entry + GOLDEN_TP_FINAL_R * r };
  }
  return { action: "HOLD", price };
}

// ─── Golden exit WALK (series) — SSOT version of the backtest's inline exit ───────

export type GoldenExitReason =
  | "SL" // full stop pre-scale-out (−1R)
  | "TIME" // 60-bar backstop (pre-scale-out)
  | "STOP_BE" // breakeven stop on the 60% runner after scale-out
  | "TP_FINAL" // runner reached +5.0R
  | "TRAIL" // wide Chandelier on the 60% runner
  | "TRAIL_OPEN" // runner still open at last bar → mark at close
  | "OPEN"; // never scaled out and ran out of bars → mark at close

export interface GoldenExitResult {
  exitDate: string;
  exitReason: GoldenExitReason;
  scaledOut: boolean;
  scaleTarget: number; // +2.5R price (scale-out bank level)
  openFrac: number; // fraction of ORIGINAL position open at close (1.0 or 0.60)
  openExitPrice: number; // exit level for whatever fraction was open at close
  mfeR: number; // max favorable excursion in R over the WHOLE trade
}

/**
 * goldenExitWalk — the AUTHORITATIVE forward exit walk, ported BIT-FOR-BIT from the
 * validated backtest (scripts/elzaV45GoldenDNA.ts inline walk) and now the SSOT.
 * Given the entry index `i` (entry = bars[i].close paired with `sl`), walk bars
 * (i+1 .. end) and return the Golden 5:1 outcome. Pure; SL-FIRST-ON-TIE strict.
 *
 * The portfolio sim drives sizing/P&L off this result (scaleTarget/openFrac/
 * openExitPrice). `sl` is the wide-lung stop the caller computed; risk = entry−sl.
 */
export function goldenExitWalk(bars: Bar[], i: number, sl: number): GoldenExitResult {
  const entry = bars[i].close;
  const risk = entry - sl;
  const scaleTarget = entry + GOLDEN_SCALE_R * risk; // +2.5R
  const tpFinal = entry + GOLDEN_TP_FINAL_R * risk; // +5.0R

  let exitDate = bars[bars.length - 1].date;
  let exitReason: GoldenExitReason = "OPEN";

  let scaledOut = false;
  let openFrac = 1.0;
  let openExitPrice = entry;

  let currentStop = sl; // pre-scale-out stop = initial SL (−1R)
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
        scaledOut = true;
        openFrac = GOLDEN_RUNNER_FRAC;
        currentStop = entry; // breakeven
        highestHigh = Math.max(highestHigh, bar.high);
        const atr = goldenAtr14(bars.slice(0, j + 1));
        trailStop = (atr != null && atr > 0)
          ? Math.max(entry, highestHigh - GOLDEN_CHANDELIER_ATR_MULT * atr)
          : entry;
        continue;
      }
      if (heldBars >= GOLDEN_TIME_STOP_BARS) {
        exitReason = "TIME"; exitDate = bar.date;
        openFrac = 1.0; openExitPrice = bar.close; closedOut = true;
        break;
      }
      if (j === bars.length - 1) {
        exitReason = "OPEN"; exitDate = bar.date;
        openFrac = 1.0; openExitPrice = bar.close; closedOut = true;
      }
    } else {
      // PHASE 2: 60% runner. WIDE Chandelier max(prior, highHigh − 2.5×ATR14) ≥ BE.
      highestHigh = Math.max(highestHigh, bar.high);
      const atr = goldenAtr14(bars.slice(0, j + 1));
      if (atr != null && atr > 0) {
        trailStop = Math.max(trailStop, highestHigh - GOLDEN_CHANDELIER_ATR_MULT * atr);
      }
      currentStop = Math.max(currentStop, trailStop); // never below breakeven

      if (bar.low <= currentStop) {
        exitReason = currentStop <= entry ? "STOP_BE" : "TRAIL";
        exitDate = bar.date;
        openFrac = GOLDEN_RUNNER_FRAC; openExitPrice = currentStop; closedOut = true;
        break;
      }
      if (bar.high >= tpFinal) {
        exitReason = "TP_FINAL"; exitDate = bar.date;
        openFrac = GOLDEN_RUNNER_FRAC; openExitPrice = tpFinal; closedOut = true;
        break;
      }
      if (j === bars.length - 1) {
        exitReason = "TRAIL_OPEN"; exitDate = bar.date;
        openFrac = GOLDEN_RUNNER_FRAC; openExitPrice = bar.close; closedOut = true;
      }
    }
  }

  // Entry on the very last bar: no forward bar → mark flat OPEN at entry.
  if (i === bars.length - 1 && !closedOut) {
    exitDate = bars[i].date; exitReason = "OPEN";
    scaledOut = false;
    openFrac = 1.0; openExitPrice = entry;
  }

  return {
    exitDate,
    exitReason,
    scaledOut,
    scaleTarget,
    openFrac,
    openExitPrice,
    mfeR: Math.round(mfeR * 100) / 100,
  };
}

// ─── GAP-WALL #1: Circuit breaker (pure) ────────────────────────────────────────

export interface CircuitBreakerResult {
  halt: boolean;
  flattenAll: boolean;
  reason: string;
}

/**
 * circuitBreaker — daily-loss kill switch. Because MAX_DAILY_LOSS_PCT is a
 * PORTFOLIO-% it auto-scales with whatever leverage the owner has dialed in. When
 * the day's portfolio P&L ≤ −MAX_DAILY_LOSS_PCT we HALT new entries and signal
 * flattenAll (the execution layer does the actual flattening — never here).
 */
export function circuitBreaker(
  portfolioDayPnlPct: number,
  cfg: ElzaV45Config = ELZA_V45_CFG,
): CircuitBreakerResult {
  // FAIL CLOSED: a non-finite day-P&L (NaN/±Infinity) means we cannot trust the
  // book — halt and signal flatten rather than silently passing the loss gate.
  if (!Number.isFinite(portfolioDayPnlPct)) {
    return {
      halt: true,
      flattenAll: true,
      reason: "Day-P&L not finite — failing SAFE (halt+flatten)",
    };
  }
  if (portfolioDayPnlPct <= -cfg.MAX_DAILY_LOSS_PCT) {
    return {
      halt: true,
      flattenAll: true,
      reason: `Daily loss ${(portfolioDayPnlPct * 100).toFixed(2)}% ≤ −${(cfg.MAX_DAILY_LOSS_PCT * 100).toFixed(2)}% — CIRCUIT BREAKER tripped`,
    };
  }
  return { halt: false, flattenAll: false, reason: "within daily-loss limit" };
}

// ─── GAP-WALL #2: Correlation / volatility-class cap (pure) ──────────────────────

export type VolClass = "SEMIS" | "CRYPTO" | "AI_DATA" | "NUCLEAR" | "SPACE" | "OTHER";

/**
 * Best-effort ticker → volatility-class map. NOT exhaustive — anything unmapped is
 * "OTHER" (uncapped by class; still bound by MAX_CONCURRENT / MAX_PER_SECTOR
 * upstream). Extend as the catalogue grows.
 */
export const VOL_CLASS: Record<string, VolClass> = {
  // Semiconductors
  NVDA: "SEMIS", AMD: "SEMIS", AVGO: "SEMIS", MU: "SEMIS", TSM: "SEMIS",
  ASML: "SEMIS", SMCI: "SEMIS", ARM: "SEMIS", INTC: "SEMIS", QCOM: "SEMIS",
  LRCX: "SEMIS", AMAT: "SEMIS", KLAC: "SEMIS", MRVL: "SEMIS", ON: "SEMIS",
  // Crypto / crypto-proxies
  COIN: "CRYPTO", MARA: "CRYPTO", RIOT: "CRYPTO", MSTR: "CRYPTO", CLSK: "CRYPTO",
  HUT: "CRYPTO", BITF: "CRYPTO", BTBT: "CRYPTO", IBIT: "CRYPTO", GBTC: "CRYPTO",
  // AI / data-center
  PLTR: "AI_DATA", AI: "AI_DATA", SNOW: "AI_DATA", PATH: "AI_DATA", BBAI: "AI_DATA",
  SOUN: "AI_DATA", VRT: "AI_DATA", DELL: "AI_DATA", ANET: "AI_DATA",
  // Nuclear / uranium
  CCJ: "NUCLEAR", SMR: "NUCLEAR", OKLO: "NUCLEAR", LEU: "NUCLEAR", UEC: "NUCLEAR",
  NNE: "NUCLEAR", BWXT: "NUCLEAR", URA: "NUCLEAR",
  // Space
  RKLB: "SPACE", LUNR: "SPACE", ASTS: "SPACE", RDW: "SPACE", SPCE: "SPACE",
  ACHR: "SPACE", JOBY: "SPACE",
};

export function classifyTicker(
  ticker: string,
  classMap: Record<string, VolClass> = VOL_CLASS,
): VolClass {
  return classMap[ticker.toUpperCase()] ?? "OTHER";
}

export interface CorrelationCapResult {
  allowed: boolean;
  reason: string;
}

/**
 * correlationCap — reject a candidate when opening it would push that volatility
 * class above its VOL_CLASS_CAP (>3 SEMIS, >2 CRYPTO, …). Correlated cluster
 * names gap together; this is the second airbag. Pure. "OTHER"-class candidates
 * are not class-capped here.
 */
export function correlationCap(
  openPositions: string[],
  candidateTicker: string,
  classMap: Record<string, VolClass> = VOL_CLASS,
  cfg: ElzaV45Config = ELZA_V45_CFG,
): CorrelationCapResult {
  const cls = classifyTicker(candidateTicker, classMap);
  if (cls === "OTHER") {
    return { allowed: true, reason: "candidate class OTHER — not class-capped" };
  }
  const cap = cfg.VOL_CLASS_CAPS[cls];
  const openInClass = openPositions.filter(
    (t) => classifyTicker(t, classMap) === cls,
  ).length;
  if (openInClass + 1 > cap) {
    return {
      allowed: false,
      reason: `${cls} cap ${cap} reached (${openInClass} open) — reject ${candidateTicker.toUpperCase()}`,
    };
  }
  return {
    allowed: true,
    reason: `${cls} ${openInClass + 1}/${cap} after open`,
  };
}

// ─── GAP-WALL #3: Overnight gross cap (pure) ─────────────────────────────────────

export interface OvernightGrossCapResult {
  /** Target gross exposure as a leverage multiple to hold overnight. */
  targetGrossPct: number;
  /** How much gross (in leverage-multiple terms) must be trimmed before the bell. */
  trimNeededPct: number;
  reason: string;
}

/**
 * overnightGrossCap — THE WALL that enforces 4.0×→1.9× (or lower) before the bell.
 * Pre-close, cut intraday gross down to OVERNIGHT_LEVERAGE, and FURTHER if VIX is
 * elevated:
 *   VIX > VIX_BLOCK (35)        → target 0.5 × OVERNIGHT_LEVERAGE (defensive)
 *   VIX in (VIX_REDUCE, BLOCK]  → target 1.0 × OVERNIGHT_LEVERAGE
 *   else                        → OVERNIGHT_LEVERAGE
 * Deliberate intraday-heavy / overnight-light gap protection. Pure — the execution
 * layer performs the actual trim.
 */
export function overnightGrossCap(
  vix: number,
  currentGrossPct: number,
  cfg: ElzaV45Config = ELZA_V45_CFG,
): OvernightGrossCapResult {
  let targetGrossPct = cfg.OVERNIGHT_LEVERAGE;
  let band: string;
  // FAIL CLOSED: non-finite VIX takes the MOST defensive branch (0.5× overnight),
  // identical to the VIX>BLOCK panic band — never assume calm on a bad VIX read.
  if (!Number.isFinite(vix) || vix > cfg.VIX_BLOCK) {
    targetGrossPct = cfg.OVERNIGHT_LEVERAGE * 0.5;
    band = Number.isFinite(vix)
      ? `VIX ${vix} > ${cfg.VIX_BLOCK}: 0.5× overnight`
      : `VIX not finite — defensive 0.5× overnight`;
  } else if (vix > cfg.VIX_REDUCE) {
    targetGrossPct = cfg.OVERNIGHT_LEVERAGE * 1.0;
    band = `VIX ${vix} in (${cfg.VIX_REDUCE},${cfg.VIX_BLOCK}]: 1.0× overnight`;
  } else {
    band = `VIX ${vix} ≤ ${cfg.VIX_REDUCE}: full overnight ${cfg.OVERNIGHT_LEVERAGE}×`;
  }
  const trimNeededPct = Math.max(0, currentGrossPct - targetGrossPct);
  return {
    targetGrossPct,
    trimNeededPct,
    reason: `${band} — target ${targetGrossPct.toFixed(2)}×, trim ${trimNeededPct.toFixed(2)}×`,
  };
}

// ─── Regime + sentiment (pure) ───────────────────────────────────────────────────

export type Regime = "BULL" | "BEAR";

/** Market regime from SPY vs its EMA-50. */
export function getRegime(spyClose: number, spyEMA50: number): Regime {
  return spyClose >= spyEMA50 ? "BULL" : "BEAR";
}

export interface VixGuardResult {
  blockAll: boolean;
  sizeMult: number;
}

/**
 * vixGuard — VIX > VIX_BLOCK (35) blocks ALL new entries; VIX > VIX_REDUCE (25)
 * scales size ×0.7; otherwise full size.
 */
export function vixGuard(vix: number, cfg: ElzaV45Config = ELZA_V45_CFG): VixGuardResult {
  // FAIL CLOSED: a non-finite VIX read blocks ALL new entries (size 0).
  if (!Number.isFinite(vix)) return { blockAll: true, sizeMult: 0 };
  if (vix > cfg.VIX_BLOCK) return { blockAll: true, sizeMult: 0 };
  if (vix > cfg.VIX_REDUCE) return { blockAll: false, sizeMult: 0.7 };
  return { blockAll: false, sizeMult: 1.0 };
}

export interface RsiSentimentResult {
  block: boolean;
  reason: string;
}

/**
 * rsiSentimentGuard — euphoria / capitulation filter on SPY RSI-14:
 *   RSI > RSI_GREED (75) → block NEW LONG Tier-4 breakouts (chasing into froth)
 *   RSI < RSI_FEAR  (30) → block NEW SHORTs (capitulation / mean-revert risk)
 */
export function rsiSentimentGuard(
  spyRsi14: number,
  side: "long" | "short",
  tier: LongTier | "SHORT",
  cfg: ElzaV45Config = ELZA_V45_CFG,
): RsiSentimentResult {
  // FAIL CLOSED: a non-finite SPY RSI blocks the candidate rather than passing it.
  if (!Number.isFinite(spyRsi14)) {
    return { block: true, reason: "RSI not finite — block" };
  }
  if (side === "long" && tier === "TIER4_POWER_BREAKOUT" && spyRsi14 > cfg.RSI_GREED) {
    return {
      block: true,
      reason: `SPY RSI ${spyRsi14.toFixed(1)} > ${cfg.RSI_GREED} — block LONG Tier-4 breakout (greed)`,
    };
  }
  if (side === "short" && spyRsi14 < cfg.RSI_FEAR) {
    return {
      block: true,
      reason: `SPY RSI ${spyRsi14.toFixed(1)} < ${cfg.RSI_FEAR} — block new SHORT (fear)`,
    };
  }
  return { block: false, reason: "RSI sentiment OK" };
}

// ─── SHORT engine — BACKTEST-ONLY, HARD-GUARDED ──────────────────────────────────

export interface ShortScore {
  tier: "TIER5_DEATH_BREAKDOWN";
  totalScore: number;
  entry: number;
  initialSL: number;
  sizeFraction: number;
  rValue: number;
}

export interface ShortOpts {
  /** MUST be exactly true or this engine throws. The 2022-backtest gate. */
  backtest2022: boolean;
}

/**
 * scoreShort_BACKTEST_ONLY — Bloodhound Tier-5 Death Breakdown. BACKTEST-ONLY.
 * THIS ENGINE MUST NEVER FIRE LIVE. It throws unless opts.backtest2022 === true,
 * so there is no code path by which the live loop can produce a short signal here.
 *   Trigger: price ≤ Donchian20Low × 1.005, < EMA50, ideally < EMA200,
 *            REQUIRES a volume spike ≥ 1.5× avg20.
 */
export function scoreShort_BACKTEST_ONLY(
  bars: Bar[],
  i: number,
  intel: ElzaIntel,
  opts?: ShortOpts,
  cfg: ElzaV45Config = ELZA_V45_CFG,
): ShortScore | null {
  // HARD GUARD — refuse to run anywhere but the explicit 2022 backtest.
  if (opts?.backtest2022 !== true) {
    throw new Error("Bloodhound short is BACKTEST-ONLY — not live");
  }

  if (i < 21 || i >= bars.length) return null;

  const closes = closesUpTo(bars, i);
  const price = bars[i].close;
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const d20Low = donchianLow(bars, i, 20);
  const av20 = avgVol(bars, i, 20);
  const vol = bars[i].volume ?? 0;
  const volumeRatio = av20 > 0 ? vol / av20 : 0;

  const breakdownPriceOk = price <= d20Low * 1.005 && price < ema50;
  const volumeSpikeOk = volumeRatio >= 1.5; // HARD requirement
  if (!breakdownPriceOk || !volumeSpikeOk) return null;

  // base 9, +1 if also below EMA-200 (cleaner breakdown), capped to 10.
  let base = 9;
  if (price < ema200) base += 1;
  const totalScore = Math.min(10, base);

  if (
    totalScore < cfg.LONG_MIN_SCORE ||
    intel.confluence < cfg.MIN_CONFLUENCE ||
    intel.liquidity < cfg.MIN_LIQUIDITY
  ) {
    return null;
  }

  const entry = price;
  const initialSL = wideLungSL(entry, ema50, "short");
  const rValue = initialSL - entry; // short risk per share (stop is ABOVE)
  if (!(rValue > 0)) return null;

  return {
    tier: "TIER5_DEATH_BREAKDOWN",
    totalScore,
    entry,
    initialSL,
    sizeFraction: 0.5,
    rValue,
  };
}
