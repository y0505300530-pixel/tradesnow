/**
 * sizingEngine.ts — Ziv Phase 3 sizing SSOT (PURE).
 *
 * No I/O, no DB, no broker calls, no clock. The caller resolves NLV, entry,
 * SL, and every cap and passes them in; this module owns the 1%-risk formula
 * and the portfolio-heat downsize/skip logic, returning qty/usd + diagnostics.
 *
 * The 1%-risk rule (GAP_03 §5.3 / phase3-sizing-spec §1):
 *   riskUsd = (RISK_PER_TRADE_PCT × NLV)          (1.0%, fixed; not raised after wins)
 *   qty     = floor(riskUsd / slDistance)          (slDistance = |entry − SL|)
 * Tight stop → more shares; wide stop → fewer. Same dollar risk either way.
 * Symmetric long/short: slDistance = long ? entry − SL : SL − entry.
 *
 * Caps BOUND the size (they never inflate it):
 *   - maxPositionUsd  : per-position USD cap (config + conviction ceiling)
 *   - leverageCapUsd  : leverage-envelope / per-ticker / budget headroom share
 *   - heatMaxPct      : portfolio-heat cap (default 0.07) — downsize, then skip
 *   - minOrderUsd     : live floor (default 5000) — skip if below, NEVER floor UP
 *
 * Safety (live money):
 *   - slDistance ≤ 0  → SKIP (never a naked / infinite size off a degenerate stop)
 *   - nlv ≤ 0 / NaN   → SKIP (no risk basis; do not size off a stale guess)
 *   - heat breach     → downsize so heat == cap; if that lands sub-min → SKIP
 *   - sub-min order    → SKIP (flooring UP would silently exceed the 1% risk unit)
 */

export const RISK_PER_TRADE_PCT = 1.0; // percent of NLV; fixed (L17-1). NOT raised after wins.
export const HEAT_MAX_PCT = 0.07; // owner decision — fraction of NLV of simultaneous open risk.
export const MIN_ORDER_USD = 5000; // existing live floor (liveOrderExecutor).

export interface RiskSizeInput {
  /** Net liquidation value (risk basis). ≤ 0 / NaN → skip. */
  nlv: number;
  /** Resolved live entry price. */
  entryPrice: number;
  /** Structural SL from calcEntrySlTp. */
  slPrice: number;
  direction: "long" | "short";
  /** Risk per trade, in PERCENT of NLV. Default 1.0. */
  riskPerTradePct?: number;
  /** Per-position USD cap (config + conviction ceiling). */
  maxPositionUsd: number;
  /** Live min-order floor. Default 5000. Order below this → skip. */
  minOrderUsd?: number;
  /** Leverage-envelope / per-ticker / budget headroom USD cap. */
  leverageCapUsd: number;
  /** Current open dollar risk (Σ slDistance_i × |units_i|) across open positions. */
  openHeatUsd: number;
  /** Portfolio-heat cap as a fraction of NLV. Default 0.07. */
  heatMaxPct?: number;
}

export interface RiskSizeResult {
  /** Final share count (floor). 0 when skipped. */
  qty: number;
  /** qty × entryPrice. 0 when skipped. */
  usd: number;
  /** qty × slDistance — actual dollars at risk if the stop is hit. */
  plannedRiskUsd: number;
  /** (openHeatUsd + plannedRiskUsd) / nlv — heat AFTER this entry. */
  heatPctAfter: number;
  /** true → caller MUST NOT enter. */
  skip: boolean;
  /** Diagnostic: binding cap or skip cause. */
  reason: string;
}

function skipResult(reason: string): RiskSizeResult {
  return { qty: 0, usd: 0, plannedRiskUsd: 0, heatPctAfter: 0, reason, skip: true };
}

/**
 * Ziv 1%-risk sizing, bounded by per-position / leverage / heat caps and the
 * min-order floor. Pure. Symmetric across long/short. Returns the binding cap
 * (or skip cause) in `reason` for telemetry.
 */
export function computeRiskSizedQty(i: RiskSizeInput): RiskSizeResult {
  const riskPct = i.riskPerTradePct ?? RISK_PER_TRADE_PCT;
  const minOrderUsd = i.minOrderUsd ?? MIN_ORDER_USD;
  const heatMaxPct = i.heatMaxPct ?? HEAT_MAX_PCT;

  // ── Risk basis must exist. No NLV → no risk basis → skip (never size off a guess).
  if (!(i.nlv > 0)) return skipResult("NLV_UNAVAILABLE");

  // ── Entry must be a real positive price.
  if (!(i.entryPrice > 0)) return skipResult("ENTRY_INVALID");

  // ── slDistance, symmetric. ≤ 0 (degenerate / inverted stop) → skip (never naked).
  const slDistance =
    i.direction === "long" ? i.entryPrice - i.slPrice : i.slPrice - i.entryPrice;
  if (!(slDistance > 0)) return skipResult("SL_DISTANCE_INVALID");

  // ── 1%-risk size. riskUsd = (riskPct/100) × NLV.
  const riskUsd = (riskPct / 100) * i.nlv;
  let qty = Math.floor(riskUsd / slDistance);
  let bindingCap = "risk";

  // ── Bound USD by the per-position and leverage/ticker/budget caps (min of all).
  //    Recompute qty from the bounded USD — caps only ever REDUCE qty.
  const usdCap = Math.min(i.maxPositionUsd, i.leverageCapUsd);
  if (usdCap > 0) {
    const qtyByUsd = Math.floor(usdCap / i.entryPrice);
    if (qtyByUsd < qty) {
      qty = qtyByUsd;
      bindingCap = i.maxPositionUsd <= i.leverageCapUsd ? "maxPositionUsd" : "leverageCap";
    }
  } else {
    // No positive USD headroom from the caps at all → nothing to enter.
    return skipResult("NO_USD_HEADROOM");
  }

  // ── Portfolio heat. heatHeadroomUsd = max(0, NLV×heatMaxPct − openHeatUsd).
  //    If the new entry would breach the cap, downsize qty so heat == cap. If
  //    heat is already maxed, headroom is 0 → qty 0 → skip below.
  const heatHeadroomUsd = Math.max(0, i.nlv * heatMaxPct - i.openHeatUsd);
  const qtyByHeat = Math.floor(heatHeadroomUsd / slDistance);
  if (qtyByHeat < qty) {
    qty = qtyByHeat;
    bindingCap = "heat";
  }

  // ── Floor never inflates: a sub-min order is SKIPPED, never floored UP to the
  //    min (flooring up would silently exceed the 1% risk unit).
  if (qty <= 0) {
    // Distinguish heat-maxed (no headroom) from an ordinary sub-min landing.
    const reason = heatHeadroomUsd <= 0 ? "HEAT_MAXED" : "BELOW_MIN_ORDER";
    return skipResult(reason);
  }

  const usd = qty * i.entryPrice;
  if (usd < minOrderUsd) {
    const reason = bindingCap === "heat" ? "HEAT_CAP_BELOW_MIN" : "BELOW_MIN_ORDER";
    return skipResult(reason);
  }

  const plannedRiskUsd = qty * slDistance;
  const heatPctAfter = (i.openHeatUsd + plannedRiskUsd) / i.nlv;

  return {
    qty,
    usd,
    plannedRiskUsd,
    heatPctAfter,
    skip: false,
    reason: bindingCap,
  };
}
