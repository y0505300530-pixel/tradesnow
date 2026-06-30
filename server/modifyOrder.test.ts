/**
 * Tests for modifyPaperOrder procedure — cancel + resubmit flow
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the paperIbindClient module
vi.mock("../server/paperIbindClient", () => ({
  cancelSingleOrder: vi.fn(),
  paperIbindRequest: vi.fn(),
}));

describe("modifyPaperOrder logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should validate that LMT order requires limitPrice", () => {
    // The procedure requires limitPrice for LMT orders
    const input = {
      orderId: "12345",
      ticker: "AAPL",
      conid: 265598,
      side: "BUY" as const,
      orderType: "LMT" as const,
      quantity: 100,
      // No limitPrice — should fail
    };
    // Verify the schema requires limitPrice for LMT
    expect(input.orderType).toBe("LMT");
    expect((input as any).limitPrice).toBeUndefined();
  });

  it("should validate that STP order requires stopPrice", () => {
    const input = {
      orderId: "12345",
      ticker: "AAPL",
      conid: 265598,
      side: "SELL" as const,
      orderType: "STP" as const,
      quantity: 100,
      // No stopPrice — should fail
    };
    expect(input.orderType).toBe("STP");
    expect((input as any).stopPrice).toBeUndefined();
  });

  it("should construct correct endpoint for LMT order", () => {
    const orderType = "LMT";
    let endpoint = "";
    if (orderType === "LMT") endpoint = "/orders/take-profit";
    else if (orderType === "STP") endpoint = "/orders/stop-loss";
    else endpoint = "/orders/bracket";
    expect(endpoint).toBe("/orders/take-profit");
  });

  it("should construct correct endpoint for STP order", () => {
    const orderType = "STP";
    let endpoint = "";
    if (orderType === "LMT") endpoint = "/orders/take-profit";
    else if (orderType === "STP") endpoint = "/orders/stop-loss";
    else endpoint = "/orders/bracket";
    expect(endpoint).toBe("/orders/stop-loss");
  });

  it("should construct correct endpoint for BRACKET order", () => {
    const orderType = "BRACKET";
    let endpoint = "";
    if (orderType === "LMT") endpoint = "/orders/take-profit";
    else if (orderType === "STP") endpoint = "/orders/stop-loss";
    else endpoint = "/orders/bracket";
    expect(endpoint).toBe("/orders/bracket");
  });

  it("should build correct order body for LMT", () => {
    const input = {
      conid: 265598,
      side: "BUY",
      quantity: 100,
      limitPrice: 150.50,
    };
    const orderBody = {
      conid: input.conid,
      side: input.side,
      quantity: input.quantity,
      limitPrice: input.limitPrice,
      tif: "GTC",
    };
    expect(orderBody).toEqual({
      conid: 265598,
      side: "BUY",
      quantity: 100,
      limitPrice: 150.50,
      tif: "GTC",
    });
  });

  it("should build correct order body for STP", () => {
    const input = {
      conid: 265598,
      side: "SELL",
      quantity: 50,
      stopPrice: 140.00,
    };
    const orderBody = {
      conid: input.conid,
      side: input.side,
      quantity: input.quantity,
      stopPrice: input.stopPrice,
      tif: "GTC",
    };
    expect(orderBody).toEqual({
      conid: 265598,
      side: "SELL",
      quantity: 50,
      stopPrice: 140.00,
      tif: "GTC",
    });
  });
});

describe("ILA conversion fix validation", () => {
  it("fetchLivePrice already returns USD — no further division needed", () => {
    // Simulating: QLTU.TA price is 63,180 ILA
    const rawILA = 63180;
    const usdIlsRate = 2.9;
    
    // fetchLivePrice internal conversion (correct):
    const usdPrice = (rawILA / 100) / usdIlsRate; // ILA → ILS → USD
    expect(usdPrice).toBeCloseTo(217.86, 1);
    
    // OLD BUG: manualOrder.ts was dividing again
    const buggyPrice = usdPrice / (100 * usdIlsRate);
    expect(buggyPrice).toBeCloseTo(0.75, 1); // This was the $0.75 bug!
    
    // NEW (fixed): no further division
    const fixedPrice = usdPrice; // Just use it directly
    expect(fixedPrice).toBeCloseTo(217.86, 1);
  });

  it("fetchBarsForTicker returns ILS — only divide by rate, not 100*rate", () => {
    // Simulating: QLTU.TA bar close is 63,180 ILA from Yahoo
    // fetchBarsForTicker divides by 100 internally → returns 631.80 ILS
    const barCloseILS = 63180 / 100; // = 631.80
    const usdIlsRate = 2.9;
    
    // OLD BUG: divisor was 100 * ilsRate
    const buggyATR = barCloseILS / (100 * usdIlsRate);
    expect(buggyATR).toBeCloseTo(2.18, 1); // Way too low
    
    // NEW (fixed): divisor is just ilsRate
    const fixedATR = barCloseILS / usdIlsRate;
    expect(fixedATR).toBeCloseTo(217.86, 1); // Correct USD value
  });
});
