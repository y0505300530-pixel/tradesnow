import { describe, expect, it } from "vitest";
import {
  PYRAMID_ADD_FRACTION,
  PYRAMID_MIN_PROFIT_MULT,
  computePyramidPlan,
} from "./pyramidCloseLogic";

const basePos = {
  units: 100,
  originalUnits: 100,
  entryPrice: 50,
  pyramidDone: 0,
};

describe("computePyramidPlan", () => {
  it("approves +50% when profit and capital gates pass", () => {
    const plan = computePyramidPlan(basePos, 51, 50_000);
    expect(plan).toEqual({
      isEligible: true,
      addUnits: 50,
      addUsd: 2550,
      pyramidSl: 50,
    });
  });

  it("pegs pyramidSl strictly to entryPrice", () => {
    const plan = computePyramidPlan(
      { ...basePos, entryPrice: 123.456 },
      125,
      50_000,
    );
    expect(plan.pyramidSl).toBe(123.46);
  });

  it("rejects when profit below +1%", () => {
    expect(computePyramidPlan(basePos, 50.5, 50_000).rejectReason).toBe("PROFIT_TOO_LOW");
    expect(computePyramidPlan(basePos, 50 * PYRAMID_MIN_PROFIT_MULT, 50_000).rejectReason).toBe(
      "PROFIT_TOO_LOW",
    );
    expect(computePyramidPlan(basePos, 50.51, 50_000).isEligible).toBe(true);
  });

  it("rejects when already pyramided", () => {
    const plan = computePyramidPlan({ ...basePos, pyramidDone: 1 }, 55, 50_000);
    expect(plan.rejectReason).toBe("ALREADY_PYRAMIDED");
    expect(plan.addUnits).toBe(0);
  });

  it("rejects odd lot when floor yields zero add shares", () => {
    const plan = computePyramidPlan(
      { ...basePos, units: 1, originalUnits: 1 },
      55,
      50_000,
    );
    expect(plan.rejectReason).toBe("ODD_LOT_TOO_SMALL");
  });

  it("rejects when add size exceeds current units", () => {
    const plan = computePyramidPlan(
      { ...basePos, units: 30, originalUnits: 100 },
      55,
      50_000,
    );
    expect(plan.rejectReason).toBe("ODD_LOT_TOO_SMALL");
  });

  it("rejects insufficient capital", () => {
    const plan = computePyramidPlan(basePos, 51, 1000);
    expect(plan.rejectReason).toBe("INSUFFICIENT_CAPITAL");
  });

  it("uses floor(originalUnits * fraction) sizing", () => {
    const plan = computePyramidPlan(
      { ...basePos, units: 73, originalUnits: 73 },
      60,
      50_000,
    );
    expect(plan.addUnits).toBe(Math.floor(73 * PYRAMID_ADD_FRACTION));
    expect(plan.isEligible).toBe(true);
  });
});
