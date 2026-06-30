import { describe, expect, it } from "vitest";
import { validateDetectedTradeLevels } from "./tradeOutputValidator";
import { calcMarketableLmtPrice, MARKETABLE_LMT_OFFSET } from "./liveMarketOrder";

describe("tradeOutputValidator", () => {
  it("accepts valid long geometry", () => {
    const r = validateDetectedTradeLevels({
      ticker: "AAPL",
      entry: 100,
      direction: "long",
      sl: 95,
      tp: 110,
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("rejects long SL above entry", () => {
    const r = validateDetectedTradeLevels({
      ticker: "AAPL",
      entry: 100,
      direction: "long",
      sl: 101,
      tp: 110,
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes("below entry"))).toBe(true);
  });

  it("rejects invalid ticker", () => {
    const r = validateDetectedTradeLevels({
      ticker: "!!!",
      entry: 100,
      direction: "long",
      sl: 95,
      tp: 110,
    });
    expect(r.valid).toBe(false);
  });
});

describe("liveMarketOrder", () => {
  it("SELL LMT is below live price", () => {
    const p = calcMarketableLmtPrice("SELL", 100);
    expect(p).toBe(+(100 * (1 - MARKETABLE_LMT_OFFSET)).toFixed(2));
  });

  it("BUY LMT is above live price", () => {
    const p = calcMarketableLmtPrice("BUY", 100);
    expect(p).toBe(+(100 * (1 + MARKETABLE_LMT_OFFSET)).toFixed(2));
  });
});
