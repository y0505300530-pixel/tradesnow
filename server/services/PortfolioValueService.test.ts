import { describe, it, expect } from "vitest";
import {
  positionValue,
  computeInvestedValue,
  computePortfolioNlv,
} from "./PortfolioValueService.js";

describe("positionValue", () => {
  it("150 * 10 = 1500", () => {
    expect(positionValue(150, 10)).toBe(1500);
  });

  it("price 0 → 0", () => {
    expect(positionValue(0, 10)).toBe(0);
  });

  it("units 0 → 0", () => {
    expect(positionValue(150, 0)).toBe(0);
  });

  it("matches client/src/lib/positionMath.ts formula: price * units", () => {
    // positionMath.ts line 18: return price * units;
    expect(positionValue(200, 5)).toBe(1000);
  });
});

describe("computeInvestedValue", () => {
  it("sums two positions", () => {
    const positions = [
      { price: 100, units: 10 }, // 1000
      { price: 50, units: 20 },  // 1000
    ];
    expect(computeInvestedValue(positions)).toBe(2000);
  });

  it("empty array → 0", () => {
    expect(computeInvestedValue([])).toBe(0);
  });

  it("single position", () => {
    expect(computeInvestedValue([{ price: 150, units: 10 }])).toBe(1500);
  });

  it("three positions with fractional values", () => {
    const positions = [
      { price: 10.5, units: 4 },  // 42
      { price: 20,   units: 3 },  // 60
      { price: 5,    units: 8 },  // 40
    ];
    expect(computeInvestedValue(positions)).toBeCloseTo(142, 5);
  });
});

describe("computePortfolioNlv", () => {
  it("positionsValue + cash", () => {
    expect(computePortfolioNlv(10000, 2000)).toBe(12000);
  });

  it("negative cash (margin account, fully invested) still works", () => {
    // 100% leverage scenario: positions > NLV, cash negative
    expect(computePortfolioNlv(15000, -3000)).toBe(12000);
  });

  it("zero positions + cash = cash only", () => {
    expect(computePortfolioNlv(0, 5000)).toBe(5000);
  });
});
