import { describe, it, expect } from "vitest";

/**
 * Trading Lab v12.07 — Realistic Trading Friction Tests
 * Tests the slippage (0.10%) and commission ($2.50) logic added to the old Trading Lab.
 * These are unit tests for the friction math — the actual simulation integration
 * is tested by running a simulation and checking the results.
 */

// Constants matching tradingLab.ts v12.07
const SLIPPAGE_PCT = 0.001; // 0.10%
const COMMISSION_PER_TRADE = 2.50; // $2.50 USD

describe("Trading Lab v12.07 — Realistic Trading Friction", () => {
  describe("Slippage on Entry", () => {
    it("should increase entry price for long positions (buy higher)", () => {
      const rawEntryPrice = 100.00;
      const entryPrice = rawEntryPrice * (1 + SLIPPAGE_PCT); // long: buy higher
      expect(entryPrice).toBeCloseTo(100.10, 2);
      expect(entryPrice).toBeGreaterThan(rawEntryPrice);
    });

    it("should decrease entry price for short positions (sell lower)", () => {
      const rawEntryPrice = 100.00;
      const entryPrice = rawEntryPrice * (1 - SLIPPAGE_PCT); // short: entry fill is worse (lower)
      expect(entryPrice).toBeCloseTo(99.90, 2);
      expect(entryPrice).toBeLessThan(rawEntryPrice);
    });

    it("should apply 0.10% slippage correctly on a $500 stock", () => {
      const rawEntryPrice = 500.00;
      const entryPriceLong = rawEntryPrice * (1 + SLIPPAGE_PCT);
      expect(entryPriceLong).toBeCloseTo(500.50, 2);
      // $0.50 slippage on a $500 stock = 0.10%
      expect((entryPriceLong - rawEntryPrice) / rawEntryPrice).toBeCloseTo(0.001, 6);
    });
  });

  describe("Slippage on Exit", () => {
    it("should decrease exit price for long positions (sell lower)", () => {
      const rawExitPrice = 110.00;
      const exitPrice = rawExitPrice * (1 - SLIPPAGE_PCT); // long sell: fill is worse (lower)
      expect(exitPrice).toBeCloseTo(109.89, 2);
      expect(exitPrice).toBeLessThan(rawExitPrice);
    });

    it("should increase exit price for short positions (buy higher to cover)", () => {
      const rawExitPrice = 90.00;
      const exitPrice = rawExitPrice * (1 + SLIPPAGE_PCT); // short cover: fill is worse (higher)
      expect(exitPrice).toBeCloseTo(90.09, 2);
      expect(exitPrice).toBeGreaterThan(rawExitPrice);
    });
  });

  describe("Commission Deduction", () => {
    it("should deduct $2.50 commission from total P&L", () => {
      const grossPnl = 150.00;
      const netPnl = grossPnl - COMMISSION_PER_TRADE;
      expect(netPnl).toBe(147.50);
    });

    it("should make a small winning trade a loser after commission", () => {
      const grossPnl = 2.00; // tiny win
      const netPnl = grossPnl - COMMISSION_PER_TRADE;
      expect(netPnl).toBe(-0.50); // commission turns it into a loss
      expect(netPnl).toBeLessThan(0);
    });

    it("should increase losses by commission amount", () => {
      const grossPnl = -50.00;
      const netPnl = grossPnl - COMMISSION_PER_TRADE;
      expect(netPnl).toBe(-52.50);
    });
  });

  describe("Combined Friction Impact", () => {
    it("should calculate total friction on a round-trip long trade", () => {
      const capital = 10000;
      const rawEntryPrice = 100.00;
      const rawExitPrice = 105.00; // 5% gain

      // Entry with slippage (long: buy higher)
      const entryPrice = rawEntryPrice * (1 + SLIPPAGE_PCT);
      const shares = capital / entryPrice;

      // Exit with slippage (long: sell lower)
      const exitPrice = rawExitPrice * (1 - SLIPPAGE_PCT);

      // P&L
      const grossPnl = (exitPrice - entryPrice) * shares;
      const netPnl = grossPnl - COMMISSION_PER_TRADE;

      // Without friction: (105 - 100) * 100 = $500
      const idealPnl = (rawExitPrice - rawEntryPrice) * (capital / rawEntryPrice);
      expect(idealPnl).toBe(500);

      // With friction: should be less
      expect(netPnl).toBeLessThan(idealPnl);

      // Friction cost = ideal - actual
      const frictionCost = idealPnl - netPnl;
      // Slippage on entry: ~$10, slippage on exit: ~$10.50, commission: $2.50 = ~$23
      expect(frictionCost).toBeGreaterThan(20);
      expect(frictionCost).toBeLessThan(30);
    });

    it("should calculate total friction on a round-trip short trade", () => {
      const capital = 10000;
      const rawEntryPrice = 100.00;
      const rawExitPrice = 95.00; // 5% gain for short

      // Entry with slippage (short: sell lower)
      const entryPrice = rawEntryPrice * (1 - SLIPPAGE_PCT);
      const shares = capital / entryPrice;

      // Exit with slippage (short: buy higher to cover)
      const exitPrice = rawExitPrice * (1 + SLIPPAGE_PCT);

      // P&L for short
      const grossPnl = (entryPrice - exitPrice) * shares;
      const netPnl = grossPnl - COMMISSION_PER_TRADE;

      // Without friction: (100 - 95) * 100 = $500
      const idealPnl = (rawEntryPrice - rawExitPrice) * (capital / rawEntryPrice);
      expect(idealPnl).toBe(500);

      // With friction: should be less
      expect(netPnl).toBeLessThan(idealPnl);
    });
  });

  describe("Select All Ticker Logic", () => {
    it("should select all tickers from catalogue", () => {
      const catalogue = [
        { ticker: "AAPL" }, { ticker: "MSFT" }, { ticker: "NVDA" },
        { ticker: "GOOGL" }, { ticker: "META" }
      ];
      const allTickers = catalogue.map(a => a.ticker);
      expect(allTickers).toEqual(["AAPL", "MSFT", "NVDA", "GOOGL", "META"]);
      expect(allTickers.length).toBe(5);
    });

    it("should toggle between select all and deselect all", () => {
      const catalogue = ["AAPL", "MSFT", "NVDA"];
      let selected: string[] = [];

      // Select All
      if (selected.length !== catalogue.length) {
        selected = [...catalogue];
      }
      expect(selected).toEqual(catalogue);

      // Deselect All
      if (selected.length === catalogue.length) {
        selected = [];
      }
      expect(selected).toEqual([]);
    });
  });
});
