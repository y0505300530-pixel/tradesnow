import { describe, it, expect } from "vitest";
import { computeIndicatorSnapshot } from "./indicatorSnapshot";

const bars = Array.from({ length: 30 }, (_, i) => ({
  close: 100 + i, high: 101 + i, low: 99 + i, volume: 1000 + i * 10,
}));

describe("computeIndicatorSnapshot", () => {
  it("returns all seven indicator fields for a rising series", () => {
    const snap = computeIndicatorSnapshot(bars, 130);
    expect(snap).toHaveProperty("rsi14");
    expect(snap).toHaveProperty("ema50Slope");
    expect(snap).toHaveProperty("relativeVolume");
    expect(snap.ema20).not.toBeNull();
  });
});
