import { describe, it, expect } from "vitest";
import { normalizeBarsForTicker } from "./PriceService.js";

describe("normalizeBarsForTicker", () => {
  const taBar = { open: 30000, high: 32000, low: 29000, close: 31000, volume: 100 };
  const usBar = { open: 150, high: 155, low: 148, close: 153, volume: 200 };

  it("converts .TA bars from agorot to USD (÷100 ÷ ilsRate)", () => {
    const ilsRate = 3.6;
    const [result] = normalizeBarsForTicker([taBar], "POLI.TA", ilsRate);
    expect(result.open).toBeCloseTo(30000 / 100 / 3.6, 4); // ≈ 83.33
    expect(result.high).toBeCloseTo(32000 / 100 / 3.6, 4);
    expect(result.low).toBeCloseTo(29000 / 100 / 3.6, 4);
    expect(result.close).toBeCloseTo(31000 / 100 / 3.6, 4);
    expect(result.volume).toBe(100); // volume unchanged
  });

  it("is case-insensitive for .TA suffix", () => {
    const [result] = normalizeBarsForTicker([taBar], "TEST.ta", 3.6);
    expect(result.open).toBeCloseTo(30000 / 100 / 3.6, 4);
  });

  it("passes through US ticker bars unchanged", () => {
    const [result] = normalizeBarsForTicker([usBar], "AAPL", 3.6);
    expect(result.open).toBe(150);
    expect(result.high).toBe(155);
    expect(result.low).toBe(148);
    expect(result.close).toBe(153);
    expect(result.volume).toBe(200);
  });

  it("guards against ilsRate <= 0 (falls back to passthrough for .TA)", () => {
    const [result] = normalizeBarsForTicker([taBar], "POLI.TA", 0);
    // when ilsRate <= 0 the effective factor is 1 (no conversion)
    expect(result.open).toBe(30000);
  });
});
