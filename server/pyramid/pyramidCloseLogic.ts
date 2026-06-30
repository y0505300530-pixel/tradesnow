// server/pyramid/pyramidCloseLogic.ts
// PURE pyramid scale-in planner. ZERO I/O — no DB, no IBKR, no side effects.
// Side effects live in executePyramid.ts (future).

/** Minimum live/entry ratio — must be strictly above +1% (running winner). */
export const PYRAMID_MIN_PROFIT_MULT = 1.01;

/** Add exactly 50% of original size (floor — odd lots may reject). */
export const PYRAMID_ADD_FRACTION = 0.5;

export type PyramidRejectReason =
  | "PROFIT_TOO_LOW"
  | "INSUFFICIENT_CAPITAL"
  | "ALREADY_PYRAMIDED"
  | "ODD_LOT_TOO_SMALL";

export type PyramidPlan = {
  isEligible: boolean;
  rejectReason?: PyramidRejectReason;
  addUnits: number;
  addUsd: number;
  /** SL peg for the add leg — always the original entry price (principal protection). */
  pyramidSl: number;
};

export type PyramidPositionInput = {
  units: number;
  originalUnits: number;
  entryPrice: number;
  pyramidDone: number;
};

function ineligible(
  rejectReason: PyramidRejectReason,
  entryPrice: number,
): PyramidPlan {
  return {
    isEligible: false,
    rejectReason,
    addUnits: 0,
    addUsd: 0,
    pyramidSl: +entryPrice.toFixed(2),
  };
}

/**
 * Compute a single scale-in plan for one open long position.
 * Score / regime / mutex gates are evaluated by the caller (pyramidEngine).
 */
export function computePyramidPlan(
  pos: PyramidPositionInput,
  livePrice: number,
  remainingAccountCapital: number,
): PyramidPlan {
  const pyramidSl = +pos.entryPrice.toFixed(2);

  if (pos.pyramidDone !== 0) {
    return ineligible("ALREADY_PYRAMIDED", pos.entryPrice);
  }

  if (!Number.isFinite(livePrice) || livePrice <= 0) {
    return ineligible("PROFIT_TOO_LOW", pos.entryPrice);
  }

  if (livePrice <= pos.entryPrice * PYRAMID_MIN_PROFIT_MULT) {
    return ineligible("PROFIT_TOO_LOW", pos.entryPrice);
  }

  const anchorUnits = pos.originalUnits > 0 ? pos.originalUnits : pos.units;
  const addUnits = Math.floor(anchorUnits * PYRAMID_ADD_FRACTION);

  if (addUnits < 1) {
    return ineligible("ODD_LOT_TOO_SMALL", pos.entryPrice);
  }

  if (addUnits > pos.units) {
    return ineligible("ODD_LOT_TOO_SMALL", pos.entryPrice);
  }

  const addUsd = +(addUnits * livePrice).toFixed(2);

  if (!Number.isFinite(remainingAccountCapital) || remainingAccountCapital < addUsd) {
    return ineligible("INSUFFICIENT_CAPITAL", pos.entryPrice);
  }

  return {
    isEligible: true,
    addUnits,
    addUsd,
    pyramidSl,
  };
}
