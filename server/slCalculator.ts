/**
 * slCalculator.ts — Shared SL/TP formula (Ziv Engine rules)
 *
 * Pure function — no DB, no network. Single source of truth used by:
 *   - paperLabEngine.ts (entry + position management)
 *   - warEngine.ts (live entries)
 *   - portfolio.ts (analyzeHoldings, addHolding)
 *   - nightlySlResync.ts
 *   - slCheckScheduled.ts (15-min poller)
 *
 * Modes (ELSA_TRADING_MODE env):
 *   intraday — tight SL (8% / 2×ATR), TP = 5R, scale-out at 1.5R
 *   swing    — wide structural SL (2.5×ATR / swing low), TP = 2.5–3R, scale-out at 1.5R
 */

import { calcEMA } from "./zivEngine";

// ─── Mode ─────────────────────────────────────────────────────────────────────

export type ElsaTradingMode = "intraday" | "swing";

export function getElsaTradingMode(): ElsaTradingMode {
  const m = (process.env.ELSA_TRADING_MODE ?? "swing").toLowerCase();
  return m === "intraday" ? "intraday" : "swing";
}

// ─── Intraday constants ───────────────────────────────────────────────────────

export const INTRADAY_SL_PCT = 0.08;
export const INTRADAY_ATR_MULT = 2.0;
export const INTRADAY_TP_R = 5.0;

// ─── Swing constants ──────────────────────────────────────────────────────────

export const SWING_SL_MIN_PCT = 0.12;
export const SWING_SL_MAX_PCT = 0.25;
export const SWING_SL_ATR_MULT = 2.5;
export const SWING_STRUCT_BUFFER = 0.5;
// Pillar 1 — Fat-Tail v2.0: structural buffer multiplier (same value, named for clarity)
export const FATTAIL_STRUCT_BUFFER = 0.5;
export const SWING_TP_R = 2.5;
export const SWING_TP_R_STRONG = 3.0;
export const SWING_WEEKLY_SLOPE_STRONG = 0.5;

// ─── RC-2: Structural-invalidation stop ──────────────────────────────────────
//
// A Gold Retest / Role Reversal enters on the retest of a role-reversed level
// (broken resistance→support for LONG; broken support→resistance for SHORT). The
// stop belongs JUST PAST that level — if price breaks back through it the role
// reversal FAILED = structural invalidation = exit. The buffer keeps the stop far
// enough past the level that ordinary wick noise doesn't trip it, but no further:
//   buffer = max(STRUCT_INVAL_ATR_MULT × ATR, STRUCT_INVAL_MIN_PCT × entry)
// LONG : stopLoss = invalidationLevel − buffer  (must be < entry)
// SHORT: stopLoss = invalidationLevel + buffer  (must be > entry)
export const STRUCT_INVAL_ATR_MULT = 0.3;   // 0.3×ATR past the level
export const STRUCT_INVAL_MIN_PCT = 0.002;  // or 0.2% of entry, whichever is larger
// If the structural stop implies risk > this fraction of entry, the setup is too
// far gone to risk — the CALLER must SKIP the entry. We NEVER rewrite the stop to a
// flat line (the old `entry×0.85` clamp): a fabricated stop is not the invalidation.
export const MAX_STRUCTURAL_RISK_PCT = 0.12; // 12%

// ─── Scale-out (both modes) ───────────────────────────────────────────────────

// ELZA 2.0 (decision #4 / Approach B): scale out 50% at +2R — NOT 1.5R.
// The remainder is structurally trailed (no percentage TP, no EMA exit).
export const SCALE_OUT_TP1_R = 2.0;
export const SCALE_OUT_SELL_FRAC = 0.50;

/**
 * Per-share unrealized gain at which the Open Skies free-roll (50% scale-out)
 * triggers. Single source of truth = SCALE_OUT_TP1_R × R. Used by the live tick
 * loop so the live engine and the bracket constant can never disagree.
 */
export function freeRollTriggerGain(rValue: number): number {
  return SCALE_OUT_TP1_R * rValue;
}

/**
 * ELZA 2.0 — quality-scaled position size. Maps the signal score linearly into
 * the configured [minUsd, maxUsd] band: minScore→minUsd, maxScore→maxUsd. Higher
 * conviction → bigger size. Score is clamped to the band (≤minScore→min, ≥max→max).
 *
 * NOTE (2026-06-25, kronos-conviction): `score` is the COMBINED conviction score
 * (ZIV≤7.5 + kronos addon 0..2.5) when kronos is ON, with `minScore` anchored to the
 * combined gate (8.0). With kronos OFF it remains the capped-ZIV structural score.
 */
export function recommendedPositionSize(
  score: number,
  minUsd: number,
  maxUsd: number,
  minScore = 8.0,
  maxScore = 10.0,
): number {
  if (!(maxUsd > minUsd) || !(maxScore > minScore)) return Math.max(0, minUsd);
  const t = Math.max(0, Math.min(1, (score - minScore) / (maxScore - minScore)));
  return Math.round(minUsd + t * (maxUsd - minUsd));
}

// Legacy aliases (backward compat)
const SL_PCT = INTRADAY_SL_PCT;
const RISK_REWARD = INTRADAY_TP_R;

export interface SlTpResult {
  stopLoss: number;
  takeProfit: number;
  /** Which rule determined the SL floor */
  slSource: "pct" | "ema50" | "atr" | "structural";
  rValue: number;  // absolute per-share dollar risk = |entry - stopLoss|
}

// ─── Price tick rounding (owner request 2026-06-25: "לעגל תמיד") ───────────────
//
// Round SL/TP to clean values by price magnitude so we don't ship ugly
// fractions like SL=$454.35 on a ~$500 stock. Pure + testable.
//   price ≥ $100        → whole dollar       (454.35 → 454, 1552.90 → 1553)
//   $10 ≤ price < $100   → nearest $0.10
//   $1  ≤ price < $10    → nearest $0.05      (ACHR ~$5.62 stays sensible)
//   price < $1           → keep 2 decimals    (engine rejects <$2 anyway)
//
// NOTE: rounds to the NEAREST tick. Direction-safety (never weakening a stop,
// never crossing entry) is re-asserted by the caller in calcEntrySlTp.
export function tickSizeForPrice(price: number): number {
  const p = Math.abs(price);
  if (p >= 100) return 1;
  if (p >= 10) return 0.1;
  if (p >= 1) return 0.05;
  return 0.01;
}

/** Round a price to the sensible tick for its magnitude (nearest). */
export function roundToTick(price: number): number {
  const tick = tickSizeForPrice(price);
  // Work in integer tick units to avoid binary-float drift, then 2-dp clean.
  const rounded = Math.round(price / tick) * tick;
  return Math.round(rounded * 100) / 100;
}

/** True when signed position size indicates a short (portfolioHoldings convention). */
export function isShortUnits(units: number): boolean {
  return units < 0;
}

export function directionFromUnits(units: number): "long" | "short" {
  return isShortUnits(units) ? "short" : "long";
}

/**
 * Verify SL/TP orientation relative to entry.
 * Long: SL < entry < TP. Short (units < 0): TP < entry < SL.
 */
export function validateSlTpDirection(
  entryPrice: number,
  stopLoss: number,
  takeProfit: number,
  directionOrUnits: "long" | "short" | number,
): boolean {
  const direction =
    typeof directionOrUnits === "number"
      ? directionFromUnits(directionOrUnits)
      : directionOrUnits;
  if (direction === "short") {
    return stopLoss > entryPrice && takeProfit < entryPrice;
  }
  return stopLoss < entryPrice && takeProfit > entryPrice;
}

/**
 * Return SL/TP unchanged when directionally valid; otherwise recompute via calcEntrySlTp.
 */
export function ensureDirectionalSlTp(
  entryPrice: number,
  ema50: number,
  stopLoss: number,
  takeProfit: number,
  directionOrUnits: "long" | "short" | number,
  bars?: Bar[],
): SlTpResult {
  const direction =
    typeof directionOrUnits === "number"
      ? directionFromUnits(directionOrUnits)
      : directionOrUnits;
  if (validateSlTpDirection(entryPrice, stopLoss, takeProfit, direction)) {
    const risk = direction === "long"
      ? entryPrice - stopLoss
      : stopLoss - entryPrice;
    return {
      stopLoss,
      takeProfit,
      slSource: "pct",
      rValue: Math.round(Math.max(0, risk) * 100) / 100,
    };
  }
  return calcEntrySlTp({ entryPrice, ema50, bars, direction });
}

export interface EntrySlTpResult extends SlTpResult {
  target1Price: number;
  atr14: number | null;
  mode: ElsaTradingMode;
  tpR: number;
  /**
   * Ziv Phase 5 §3 — which rule set the take-profit:
   *   "structural"  — TP pinned to the next opposing zone boundary (structuralTpLevel),
   *                   because that level lies BEYOND the 2R floor in the trade direction.
   *   "rMultiple"   — TP is the legacy entry ± tpR×risk multiple (no structural level
   *                   supplied, or the level was nearer than 2R so it was IGNORED).
   * The 2R floor (SCALE_OUT_TP1_R) is never reduced — a sub-2R structural level never wins.
   */
  tpSource: "structural" | "rMultiple";
  /**
   * RC-2 skip sentinel. When true the structural (or fallback) stop implies risk
   * above MAX_STRUCTURAL_RISK_PCT — the CALLER must SKIP the entry rather than place
   * a fabricated/flat stop. stopLoss/takeProfit are still populated (the would-be
   * structural levels) for logging, but MUST NOT be used to place an order.
   */
  skip?: boolean;
  skipReason?: string;
}

export interface EntrySlTpInput {
  entryPrice: number;
  ema50: number;
  bars?: Bar[];
  atr14?: number;
  /** 20-day low (long) or high (short) */
  swingExtreme20?: number;
  weeklyEma50Slope?: number;
  direction?: "long" | "short";
  /**
   * RC-2: the role-reversal / true-retest level being retested (resistance→support
   * for LONG, support→resistance for SHORT). When present the stop is anchored JUST
   * PAST this level (structural invalidation) instead of the 20-bar extreme.
   */
  invalidationLevel?: number;
  /**
   * Ziv Phase 5 §3 — STRUCTURAL TAKE-PROFIT. The next opposing zone boundary in the
   * trade direction (the CALLER computes it from the cached zones, this fn only
   * consumes it):
   *   LONG  — the nearest supply zone's near edge ABOVE entry (target = zone.low).
   *   SHORT — the nearest demand zone's near edge BELOW entry (target = zone.high).
   * Applied as `TP = max(floor2R, structuralTpLevel)` (long) / `min(...)` (short),
   * where floor2R = entry ± MIN_RR(=2.0)×R. A structural level NEARER than 2R is
   * IGNORED — the TP is never reduced below the 2R floor. When absent/null the TP is
   * byte-identical to today (the legacy entry ± tpR×risk multiple).
   */
  structuralTpLevel?: number | null;
}

// ─── ATR helper ───────────────────────────────────────────────────────────────

export function computeAtr14(bars: Bar[]): number | null {
  if (bars.length < 2) return null;
  const atrPeriod = Math.min(14, bars.length - 1);
  let atrSum = 0;
  for (let i = bars.length - atrPeriod; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    atrSum += tr;
  }
  return atrSum / atrPeriod;
}

/**
 * Scale-out Target 1 — sell 50% at 1.5R (unified, R-based).
 */
export function calcTarget1Price(
  entryPrice: number,
  stopLoss: number,
  direction: "long" | "short" = "long",
  tp1R: number = SCALE_OUT_TP1_R,
): number {
  const risk = direction === "long"
    ? entryPrice - stopLoss
    : stopLoss - entryPrice;
  if (risk <= 0) return entryPrice;
  const target = direction === "long"
    ? entryPrice + tp1R * risk
    : entryPrice - tp1R * risk;
  return Math.round(target * 100) / 100;
}

/**
 * Compute SL and TP for a long position (legacy intraday formula).
 */
export function calcSlTp(buyPrice: number, ema50: number): SlTpResult {
  const slByPct = buyPrice * (1 - SL_PCT);
  const slByEma50 = ema50 * 0.99 < buyPrice ? ema50 * 0.99 : slByPct;
  const slRaw = Math.max(slByPct, slByEma50);
  const stopLoss = slRaw < buyPrice ? slRaw : slByPct;
  const takeProfit = buyPrice + RISK_REWARD * (buyPrice - stopLoss);
  const slSource: SlTpResult["slSource"] =
    slByEma50 > slByPct && slByEma50 < buyPrice ? "ema50" : "pct";
  return { stopLoss, takeProfit, slSource, rValue: Math.round((buyPrice - stopLoss) * 100) / 100 };
}

/**
 * Direction-aware SL/TP for portfolioHoldings updates.
 * Long (units > 0): SL below entry, TP above entry.
 * Short (units < 0): SL above entry, TP below entry.
 */
export function calcHoldingSlTp(
  buyPrice: number,
  ema50: number,
  units: number,
  bars?: Bar[],
): SlTpResult {
  const direction = directionFromUnits(units);
  if (isShortUnits(units)) {
    return calcEntrySlTp({
      entryPrice: buyPrice,
      ema50,
      bars,
      direction: "short",
    });
  }
  return calcSlTp(buyPrice, ema50);
}

/**
 * Swing SL/TP — wide structural stops for multi-day holds.
 */
export function calcSwingSlTp(input: EntrySlTpInput): SlTpResult {
  const {
    entryPrice,
    ema50,
    atr14: atrIn,
    swingExtreme20,
    weeklyEma50Slope,
    direction = "long",
  } = input;

  const atr14 = atrIn ?? entryPrice * 0.04;

  if (direction === "short") {
    const slByAtr = entryPrice + SWING_SL_ATR_MULT * atr14;               // fallback only
    // PRIMARY: 20-bar structural HIGH + 0.5·ATR
    let stopLoss = (swingExtreme20 && swingExtreme20 > entryPrice)
      ? swingExtreme20 + FATTAIL_STRUCT_BUFFER * atr14
      : slByAtr;
    const slSource: SlTpResult["slSource"] = (swingExtreme20 && swingExtreme20 > entryPrice) ? "structural" : "atr";
    if (stopLoss <= entryPrice) stopLoss = slByAtr;                        // safety: SL must be above entry for a short

    const risk = stopLoss - entryPrice;
    let tpR = SWING_TP_R;
    if (weeklyEma50Slope != null && weeklyEma50Slope < -SWING_WEEKLY_SLOPE_STRONG) {
      tpR = SWING_TP_R_STRONG;
    }
    const takeProfit = entryPrice - tpR * risk;

    return {
      stopLoss: Math.round(stopLoss * 100) / 100,
      takeProfit: Math.round(takeProfit * 100) / 100,
      slSource,
      rValue: Math.round(risk * 100) / 100,
    };
  }

  // LONG
  const slByAtr = entryPrice - SWING_SL_ATR_MULT * atr14;                 // fallback only
  // PRIMARY: 20-bar structural LOW − 0.5·ATR
  let stopLoss = (swingExtreme20 && swingExtreme20 < entryPrice)
    ? swingExtreme20 - FATTAIL_STRUCT_BUFFER * atr14
    : slByAtr;
  const slSource: SlTpResult["slSource"] = (swingExtreme20 && swingExtreme20 < entryPrice) ? "structural" : "atr";
  if (stopLoss >= entryPrice) stopLoss = slByAtr;                          // safety: SL must be below entry for a long

  const risk = entryPrice - stopLoss;
  let tpR = SWING_TP_R;
  if (weeklyEma50Slope != null && weeklyEma50Slope > SWING_WEEKLY_SLOPE_STRONG) {
    tpR = SWING_TP_R_STRONG;
  }
  const takeProfit = entryPrice + tpR * risk;

  return {
    stopLoss: Math.round(stopLoss * 100) / 100,
    takeProfit: Math.round(takeProfit * 100) / 100,
    slSource,
    rValue: Math.round(risk * 100) / 100,
  };
}

/**
 * Intraday entry SL/TP — tight stops + 5R target.
 */
export function calcIntradaySlTp(input: EntrySlTpInput): SlTpResult & { tpR: number } {
  const { entryPrice, ema50, atr14, direction = "long" } = input;

  if (direction === "short") {
    const riskPct = INTRADAY_SL_PCT;
    let stopLoss = entryPrice * (1 + riskPct);
    if (atr14) {
      const atrSl = entryPrice + INTRADAY_ATR_MULT * atr14;
      stopLoss = Math.min(stopLoss, atrSl);
    }
    if (stopLoss <= entryPrice) stopLoss = entryPrice * (1 + riskPct);
    const risk = stopLoss - entryPrice;
    const takeProfit = entryPrice - INTRADAY_TP_R * risk;
    return { stopLoss, takeProfit, slSource: atr14 ? "atr" : "pct", tpR: INTRADAY_TP_R };
  }

  const { stopLoss: zivSl } = calcSlTp(entryPrice, ema50);
  let stopLoss = zivSl;
  if (atr14) {
    const atrSl = entryPrice - INTRADAY_ATR_MULT * atr14;
    stopLoss = Math.max(zivSl, atrSl, entryPrice * (1 - INTRADAY_SL_PCT));
    if (stopLoss >= entryPrice) stopLoss = zivSl;
  }
  const risk = entryPrice - stopLoss;
  const takeProfit = entryPrice + INTRADAY_TP_R * risk;
  return {
    stopLoss: Math.round(stopLoss * 100) / 100,
    takeProfit: Math.round(takeProfit * 100) / 100,
    slSource: atr14 ? "atr" : zivSl < entryPrice * (1 - INTRADAY_SL_PCT) ? "ema50" : "pct",
    tpR: INTRADAY_TP_R,
  };
}

/**
 * Unified entry SL/TP — mode-aware. Used by Paper Lab + War Engine.
 */
export function calcEntrySlTp(input: EntrySlTpInput): EntrySlTpResult {
  const mode = getElsaTradingMode();
  const direction = input.direction ?? "long";

  let bars = input.bars;
  const atr14 = input.atr14 ?? (bars ? computeAtr14(bars) : null);

  let swingExtreme20 = input.swingExtreme20;
  if (!swingExtreme20 && bars && bars.length >= 20) {
    const slice = bars.slice(-20);
    swingExtreme20 = direction === "short"
      ? Math.max(...slice.map(b => b.high))
      : Math.min(...slice.map(b => b.low));
  }

  const base: EntrySlTpInput = { ...input, atr14: atr14 ?? undefined, swingExtreme20, direction };

  const entry = input.entryPrice;

  let result: SlTpResult & { tpR: number };

  // ── RC-2: STRUCTURAL-INVALIDATION stop (preferred when a retest level is known) ──
  //    The stop sits JUST PAST the role-reversed level. Symmetric for long/short.
  //    A valid invalidationLevel must be on the correct side of entry:
  //      LONG  — level ≤ entry (broken resistance now support, below price);
  //      SHORT — level ≥ entry (broken support now resistance, above price).
  //    When valid we anchor structurally; otherwise we fall through to the
  //    swing/intraday extreme-based stop below.
  const inval = input.invalidationLevel;
  const tpRStruct = direction === "long"
    ? (input.weeklyEma50Slope != null && input.weeklyEma50Slope > SWING_WEEKLY_SLOPE_STRONG ? SWING_TP_R_STRONG : SWING_TP_R)
    : (input.weeklyEma50Slope != null && input.weeklyEma50Slope < -SWING_WEEKLY_SLOPE_STRONG ? SWING_TP_R_STRONG : SWING_TP_R);
  const structValid = inval != null && inval > 0 &&
    (direction === "long" ? inval <= entry : inval >= entry);

  if (structValid) {
    const atrForBuffer = atr14 ?? entry * 0.04;
    const buffer = Math.max(STRUCT_INVAL_ATR_MULT * atrForBuffer, STRUCT_INVAL_MIN_PCT * entry);
    let stopLoss = direction === "long" ? inval! - buffer : inval! + buffer;
    // Guarantee correct orientation even if level == entry (buffer pushes it past).
    if (direction === "long" && stopLoss >= entry) stopLoss = entry - buffer;
    if (direction === "short" && stopLoss <= entry) stopLoss = entry + buffer;
    const risk = Math.abs(entry - stopLoss);
    const takeProfit = direction === "long" ? entry + tpRStruct * risk : entry - tpRStruct * risk;
    result = {
      stopLoss: Math.round(stopLoss * 100) / 100,
      takeProfit: Math.round(takeProfit * 100) / 100,
      slSource: "structural",
      rValue: Math.round(risk * 100) / 100,
      tpR: tpRStruct,
    };
  } else if (mode === "swing") {
    const swing = calcSwingSlTp(base);
    result = { ...swing, tpR: tpRStruct };
  } else {
    result = calcIntradaySlTp(base);
  }

  // ── RC-2: risk gate — SKIP, never fake. A stop whose distance exceeds
  //    MAX_STRUCTURAL_RISK_PCT of entry is too-far-gone risk. Previously the code
  //    rewrote it to a flat entry×0.85 line (a meaningless stop). We now flag the
  //    entry to be SKIPPED by the caller and place NO order. No flat clamp.
  let skip = false;
  let skipReason: string | undefined;
  {
    const maxSlDist = entry * MAX_STRUCTURAL_RISK_PCT;
    if (Math.abs(entry - result.stopLoss) > maxSlDist) {
      skip = true;
      skipReason = `structural risk too large (${(Math.abs(entry - result.stopLoss) / entry * 100).toFixed(1)}% > ${(MAX_STRUCTURAL_RISK_PCT * 100).toFixed(0)}%)`;
    }
    // Floor: a short TP must never reach/cross zero (invalid IBKR limit price → rejected bracket).
    if (direction === "short") result.takeProfit = Math.max(result.takeProfit, 0.01);
    result.stopLoss   = Math.round(result.stopLoss   * 100) / 100;
    result.takeProfit = Math.round(result.takeProfit * 100) / 100;
  }

  // ── Ziv Phase 5 §3: STRUCTURAL TAKE-PROFIT (aim at the next opposing zone) ──────
  //    TP = max(floor2R, structuralTpLevel) for a long / min(...) for a short, where
  //    floor2R = entry ± MIN_RR(=2.0)×R. A structural level BEYOND 2R lets the winner
  //    run to real structure; a level NEARER than 2R is IGNORED (we never reduce the
  //    TP below the 2R floor — that sub-2R case should already have been skipped at
  //    the entry gate, R-TP-SKIP). Absent/null ⇒ TP unchanged (byte-identical to
  //    today). Runs BEFORE tick-rounding so the structural level is rounded the same
  //    way and gets the same direction-safety as a multiple-derived TP.
  let tpSource: "structural" | "rMultiple" = "rMultiple";
  {
    const lvl = input.structuralTpLevel;
    if (lvl != null && lvl > 0) {
      const floor2R = direction === "long"
        ? entry + SCALE_OUT_TP1_R * result.rValue
        : entry - SCALE_OUT_TP1_R * result.rValue;
      // The level must be in the trade direction AND at/beyond the 2R floor.
      const beyond2R = direction === "long" ? lvl >= floor2R : lvl <= floor2R;
      if (beyond2R) {
        result.takeProfit = Math.round(lvl * 100) / 100;
        tpSource = "structural";
      }
    }
  }

  // ── Tick rounding (owner request 2026-06-25): round SL/TP to clean values.
  //    Rounding must NEVER weaken the stop or cross entry. After rounding to the
  //    nearest tick we re-assert direction safety and, if a round-to-nearest
  //    pushed a price to the wrong side of entry, step it one tick into the SAFE
  //    direction (SL away-from-entry / widen, TP away-from-entry). rValue is then
  //    recomputed from the rounded SL so downstream sizing/R-multiples agree.
  {
    let roundedSl = roundToTick(result.stopLoss);
    let roundedTp = roundToTick(result.takeProfit);

    if (direction === "short") {
      // SHORT: SL must stay ABOVE entry, TP BELOW entry.
      const slTick = tickSizeForPrice(roundedSl);
      while (roundedSl <= entry) roundedSl = Math.round((roundedSl + slTick) * 100) / 100;
      const tpTick = tickSizeForPrice(roundedTp);
      while (roundedTp >= entry && roundedTp > 0.01) {
        roundedTp = Math.round((roundedTp - tpTick) * 100) / 100;
      }
      roundedTp = Math.max(roundedTp, 0.01);
    } else {
      // LONG: SL must stay BELOW entry, TP ABOVE entry.
      const slTick = tickSizeForPrice(roundedSl);
      while (roundedSl >= entry && roundedSl > 0.01) {
        roundedSl = Math.round((roundedSl - slTick) * 100) / 100;
      }
      roundedSl = Math.max(roundedSl, 0.01);
      const tpTick = tickSizeForPrice(roundedTp);
      while (roundedTp <= entry) roundedTp = Math.round((roundedTp + tpTick) * 100) / 100;
    }

    result.stopLoss = roundedSl;
    result.takeProfit = roundedTp;
    // Keep per-share risk consistent with the ROUNDED stop.
    result.rValue = Math.round(Math.abs(entry - roundedSl) * 100) / 100;
  }

  const target1Price = calcTarget1Price(input.entryPrice, result.stopLoss, direction);

  return {
    ...result,
    target1Price,
    atr14,
    mode,
    tpSource,
    skip,
    skipReason,
  };
}

/**
 * Chandelier trailing stop (swing runner) — highest high − N×ATR.
 */
export function calcChandelierTrailSl(bars: Bar[], atrMult = 3.0): number | null {
  if (bars.length < 22) return null;
  const atr14 = computeAtr14(bars);
  if (!atr14) return null;
  const highest22 = Math.max(...bars.slice(-22).map(b => b.high));
  return Math.round((highest22 - atrMult * atr14) * 100) / 100;
}

/**
 * Catalogue alert: triggers when currentPrice <= buyPrice (entry-level alert).
 */
export function calcCatalogueAlertTarget(buyPrice: number): number {
  return buyPrice;
}

// ─── Dynamic SL/TP (ZIV H bridge) ────────────────────────────────────────────

export interface DynamicSlTpResult {
  stopLoss: number;
  takeProfit: number;
  slSource: "dynamic_ema20" | "dynamic_3day_low" | "winners_extension" | "chandelier" | "unchanged";
  tpMode: "escape" | "extension" | "unchanged";
  changed: boolean;
}

export function calcDynamicSlTp(
  bars: Bar[],
  zivHScore: number,
  currentSL: number | null,
  currentTP: number | null,
  buyPrice: number,
): DynamicSlTpResult {
  const unchanged: DynamicSlTpResult = {
    stopLoss: currentSL ?? 0,
    takeProfit: currentTP ?? 0,
    slSource: "unchanged",
    tpMode: "unchanged",
    changed: false,
  };

  if (bars.length < 20) return unchanged;

  const mode = getElsaTradingMode();
  const tpR = mode === "swing" ? SWING_TP_R : INTRADAY_TP_R;

  const closes = bars.map(b => b.close);
  const currentPrice = closes[closes.length - 1];

  const k20 = 2 / 21;
  let ema20 = closes.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
  for (let i = 20; i < closes.length; i++) ema20 = closes[i] * k20 + ema20 * (1 - k20);

  let atrSum = 0;
  const atrPeriod = Math.min(14, bars.length - 1);
  for (let i = bars.length - atrPeriod; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    atrSum += tr;
  }
  const atr14 = atrSum / atrPeriod;

  const last3Lows = bars.slice(-3).map(b => b.low);
  const lowest3DayLow = Math.min(...last3Lows);

  let newSL = currentSL ?? 0;
  let newTP = currentTP ?? 0;
  let slSource: DynamicSlTpResult["slSource"] = "unchanged";
  let tpMode: DynamicSlTpResult["tpMode"] = "unchanged";
  let changed = false;

  if (zivHScore < 6) {
    const slByEma20 = ema20 * 0.99;
    const candidateSL = Math.max(slByEma20, lowest3DayLow);
    const tighterSL = candidateSL < currentPrice ? candidateSL : slByEma20;

    if (tighterSL > (currentSL ?? 0) && tighterSL < currentPrice) {
      newSL = tighterSL;
      slSource = lowest3DayLow > slByEma20 ? "dynamic_3day_low" : "dynamic_ema20";
      changed = true;
    }

    const escapeTP = currentPrice + 1.0 * atr14;
    if (escapeTP < (currentTP ?? Infinity)) {
      newTP = escapeTP;
      tpMode = "escape";
      changed = true;
    }
  } else if (zivHScore >= 8 && currentTP != null && currentTP > 0) {
    const distToTP = (currentTP - currentPrice) / currentPrice;
    if (distToTP <= 0.02) {
      newTP = currentTP + 1.5 * atr14;
      tpMode = "extension";
      changed = true;

      const lockedSL = currentTP - 1.0 * atr14;
      if (lockedSL > (currentSL ?? 0) && lockedSL < currentPrice) {
        newSL = lockedSL;
        slSource = "winners_extension";
      }
    } else {
      const trailSL = mode === "swing"
        ? (calcChandelierTrailSl(bars) ?? ema20 * 0.99)
        : ema20 * 0.99;
      if (trailSL > (currentSL ?? 0) && trailSL < currentPrice) {
        newSL = trailSL;
        slSource = mode === "swing" ? "chandelier" : "dynamic_ema20";
        changed = true;
      }
      const risk = buyPrice - newSL;
      const standardTP = buyPrice + tpR * risk;
      if (standardTP !== (currentTP ?? 0)) {
        newTP = standardTP;
        changed = true;
      }
    }
  } else {
    const trailSL = mode === "swing"
      ? (calcChandelierTrailSl(bars) ?? ema20 * 0.99)
      : ema20 * 0.99;
    if (trailSL > (currentSL ?? 0) && trailSL < currentPrice) {
      newSL = trailSL;
      slSource = mode === "swing" ? "chandelier" : "dynamic_ema20";
      changed = true;
    }
    const risk = buyPrice - (newSL > 0 ? newSL : buyPrice * (1 - INTRADAY_SL_PCT));
    const standardTP = buyPrice + tpR * risk;
    if (standardTP !== (currentTP ?? 0)) {
      newTP = standardTP;
      changed = true;
    }
  }

  if (!changed) return unchanged;

  return {
    stopLoss: Math.round(newSL * 100) / 100,
    takeProfit: Math.round(newTP * 100) / 100,
    slSource,
    tpMode,
    changed: true,
  };
}

/** Resolve EMA-50 from bars for entry SL/TP. */
export function ema50FromBars(bars: Bar[]): number {
  if (bars.length < 10) return bars[bars.length - 1]?.close ?? 0;
  const closes = bars.map(b => b.close);
  return calcEMA(closes, Math.min(50, closes.length));
}

export interface Bar {
  date?: string;
  close: number;
  high: number;
  low: number;
  open?: number;
  volume?: number;
}
