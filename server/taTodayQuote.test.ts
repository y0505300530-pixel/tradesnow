import { describe, it, expect } from "vitest";
import { enrichTaTodayQuote, resolveTaQuotePersist } from "@shared/taTodayQuote";

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

describe("resolveTaQuotePersist", () => {
  it("restores session % for flat IBKR quote on persist", () => {
    const out = resolveTaQuotePersist(
      "CLIS.TA",
      { price: 78.5, prevClose: 78.5, changePercent: 0 },
      { dailyBasePrice: 76.45, prevClose: 76.45, prevCloseDb: 76.45 },
    );
    expect(out.prevClose).toBe(76.45);
    expect(out.changePercent).toBeCloseTo(2.68, 0);
  });

  it("preserves existing DB dailyChangePercent when enrich cannot fix", () => {
    const out = resolveTaQuotePersist(
      "CLIS.TA",
      { price: 76.45, prevClose: 76.45, changePercent: 0 },
      { dailyBasePrice: 76.45, dailyChangePercent: 2.5, prevCloseDb: 74.5 },
    );
    expect(out.changePercent).toBe(2.5);
    expect(out.prevClose).toBe(74.5);
  });

  it("leaves non-TA tickers unchanged", () => {
    const inQ = { price: 100, prevClose: 99, changePercent: 1.01 };
    expect(resolveTaQuotePersist("AAPL", inQ, { dailyBasePrice: 90 })).toEqual({
      prevClose: 99,
      changePercent: 1.01,
    });
  });
});
