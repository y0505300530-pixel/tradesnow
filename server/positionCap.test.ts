import { describe, expect, it } from "vitest";
import { capQtyToPerTickerNotional, resolveMaxPositionUsd } from "./liveOrderExecutor";

describe("resolveMaxPositionUsd", () => {
  it("uses config when positive", () => {
    expect(resolveMaxPositionUsd({ maxPositionUsd: 85000 })).toBe(85000);
  });
  it("falls back when missing or zero", () => {
    expect(resolveMaxPositionUsd({ maxPositionUsd: 0 })).toBe(85000);
    expect(resolveMaxPositionUsd(null)).toBe(85000);
  });
});

describe("capQtyToPerTickerNotional", () => {
  it("caps fresh entry to maxPositionUsd", () => {
    const r = capQtyToPerTickerNotional({
      maxPositionUsd: 85000,
      existingUnits: 0,
      transmitPrice: 348,
      requestedQty: 401,
    });
    expect(r.skip).toBe(false);
    expect(r.qty).toBe(244); // floor(85000/348)
  });

  it("blocks pyramid when at cap", () => {
    const r = capQtyToPerTickerNotional({
      maxPositionUsd: 85000,
      existingUnits: 267,
      transmitPrice: 348,
      requestedQty: 134,
    });
    expect(r.skip).toBe(true);
  });

  it("partial pyramid when headroom remains", () => {
    const r = capQtyToPerTickerNotional({
      maxPositionUsd: 85000,
      existingUnits: 200,
      transmitPrice: 348,
      requestedQty: 100,
    });
    expect(r.skip).toBe(false);
    expect(r.qty).toBeLessThan(100);
  });
});
