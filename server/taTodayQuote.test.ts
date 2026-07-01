import { describe, it, expect } from "vitest";
import { enrichTaTodayQuote } from "../../shared/taTodayQuote";

describe("enrichTaTodayQuote", () => {
  it("restores session move when IBKR sends flat change after TASE close", () => {
    const out = enrichTaTodayQuote(
      "CLIS.TA",
      { price: 78.5, change: 0, changePercent: 0, prevClose: 78.5 },
      { dailyBasePrice: 76.45, prevClose: 76.45 },
    );
    expect(out.change).toBeCloseTo(2.05, 1);
    expect(out.prevClose).toBe(76.45);
    expect(out.changePercent).toBeCloseTo(2.68, 0);
  });

  it("leaves non-TA tickers unchanged", () => {
    const inQ = { price: 100, change: 0, changePercent: 0, prevClose: 100 };
    expect(enrichTaTodayQuote("AAPL", inQ, { dailyBasePrice: 90 })).toEqual(inQ);
  });

  it("leaves real IBKR change untouched", () => {
    const inQ = { price: 78.5, change: 2.05, changePercent: 2.67, prevClose: 76.45 };
    expect(enrichTaTodayQuote("CLIS.TA", inQ, { dailyBasePrice: 76.45 })).toEqual(inQ);
  });
});
