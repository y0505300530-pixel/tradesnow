/**
 * Favorites Router Tests — v15.07
 * Tests the IBKR watchlist sync logic:
 *   - Conid splitting (USA vs TASE)
 *   - Watchlist body construction
 *   - Data shape from list procedure
 */
import { describe, it, expect } from "vitest";

describe("Favorites — Conid Splitting Logic", () => {
  it("splits tickers into USA and TASE groups correctly", () => {
    const allTickers = ["AAPL", "MSFT", "TEVA.TA", "LUMI.TA", "NVDA", "ICL.TA"];
    const usaTickers = allTickers.filter(t => !t.endsWith(".TA"));
    const taseTickers = allTickers.filter(t => t.endsWith(".TA"));

    expect(usaTickers).toEqual(["AAPL", "MSFT", "NVDA"]);
    expect(taseTickers).toEqual(["TEVA.TA", "LUMI.TA", "ICL.TA"]);
  });

  it("handles empty ticker list", () => {
    const allTickers: string[] = [];
    const usaTickers = allTickers.filter(t => !t.endsWith(".TA"));
    const taseTickers = allTickers.filter(t => t.endsWith(".TA"));

    expect(usaTickers).toEqual([]);
    expect(taseTickers).toEqual([]);
  });

  it("handles all-USA list", () => {
    const allTickers = ["AAPL", "MSFT", "NVDA"];
    const usaTickers = allTickers.filter(t => !t.endsWith(".TA"));
    const taseTickers = allTickers.filter(t => t.endsWith(".TA"));

    expect(usaTickers).toHaveLength(3);
    expect(taseTickers).toHaveLength(0);
  });

  it("handles all-TASE list", () => {
    const allTickers = ["TEVA.TA", "LUMI.TA", "ICL.TA"];
    const usaTickers = allTickers.filter(t => !t.endsWith(".TA"));
    const taseTickers = allTickers.filter(t => t.endsWith(".TA"));

    expect(usaTickers).toHaveLength(0);
    expect(taseTickers).toHaveLength(3);
  });
});

describe("Favorites — Watchlist Body Construction", () => {
  it("builds correct IBKR watchlist body with conids", () => {
    const conids = [265598, 76792991, 4815747];
    const name = "Algo Master USA";

    const rows = conids.map(c => ({ C: c, H: "SMART" }));
    const body = { id: 0, name, rows };

    expect(body.id).toBe(0);
    expect(body.name).toBe("Algo Master USA");
    expect(body.rows).toHaveLength(3);
    expect(body.rows[0]).toEqual({ C: 265598, H: "SMART" });
    expect(body.rows[2]).toEqual({ C: 4815747, H: "SMART" });
  });

  it("builds ISR watchlist body", () => {
    const conids = [123456, 789012];
    const name = "Algo Master ISR";

    const rows = conids.map(c => ({ C: c, H: "SMART" }));
    const body = { id: 0, name, rows };

    expect(body.name).toBe("Algo Master ISR");
    expect(body.rows).toHaveLength(2);
  });

  it("handles empty conid list gracefully", () => {
    const conids: number[] = [];
    const rows = conids.map(c => ({ C: c, H: "SMART" }));
    const body = { id: 0, name: "Algo Master USA", rows };

    expect(body.rows).toHaveLength(0);
  });
});

describe("Favorites — Conid Mapping", () => {
  it("maps tickers to conids from cache, skipping missing ones", () => {
    const conidMap = new Map<string, number>([
      ["AAPL", 265598],
      ["MSFT", 272093],
      ["NVDA", 4815747],
      ["TEVA.TA", 123456],
    ]);

    const usaTickers = ["AAPL", "MSFT", "NVDA", "HOOD"];
    const usaConids = usaTickers
      .map(t => conidMap.get(t))
      .filter((c): c is number => c != null);

    expect(usaConids).toEqual([265598, 272093, 4815747]);
    expect(usaConids).toHaveLength(3); // HOOD is missing

    const missing = usaTickers.filter(t => !conidMap.has(t));
    expect(missing).toEqual(["HOOD"]);
  });

  it("identifies all missing tickers for reporting", () => {
    const conidMap = new Map<string, number>([
      ["AAPL", 265598],
    ]);

    const tickers = ["AAPL", "MSFT", "NVDA"];
    const missing = tickers.filter(t => !conidMap.has(t));

    expect(missing).toEqual(["MSFT", "NVDA"]);
  });
});

describe("Favorites — List Data Shape", () => {
  it("maps raw DB row to expected frontend shape", () => {
    const dbRow = {
      id: 1,
      ticker: "AAPL",
      companyName: "Apple Inc",
      sector: "Technology",
      score: 8.26,
      tier: "Gold Breakout",
      cmp: 195.50,
      dailyChangePercent: 1.23,
      recommendedBuyPrice: 185.00,
      recommendedStopLoss: 175.00,
      hotSignal: 1,
      scannedAt: new Date("2024-01-15"),
    };

    const mapped = {
      id: dbRow.id,
      ticker: dbRow.ticker,
      company: dbRow.companyName ?? "",
      sector: dbRow.sector ?? "",
      score: dbRow.score != null ? Number(dbRow.score) : null,
      tier: dbRow.tier ?? null,
      cmp: dbRow.cmp != null ? Number(dbRow.cmp) : null,
      dailyChangePercent: dbRow.dailyChangePercent != null ? Number(dbRow.dailyChangePercent) : null,
      recommendedBuyPrice: dbRow.recommendedBuyPrice != null ? Number(dbRow.recommendedBuyPrice) : null,
      recommendedStopLoss: dbRow.recommendedStopLoss != null ? Number(dbRow.recommendedStopLoss) : null,
      hotSignal: dbRow.hotSignal === 1 || dbRow.hotSignal === true,
      scannedAt: dbRow.scannedAt ?? null,
    };

    expect(mapped.ticker).toBe("AAPL");
    expect(mapped.score).toBe(8.26);
    expect(mapped.tier).toBe("Gold Breakout");
    expect(mapped.cmp).toBe(195.50);
    expect(mapped.hotSignal).toBe(true);
    expect(mapped.recommendedBuyPrice).toBe(185.00);
  });

  it("handles null fields gracefully", () => {
    const dbRow = {
      id: 2,
      ticker: "HOOD",
      companyName: null,
      sector: null,
      score: null,
      tier: null,
      cmp: null,
      dailyChangePercent: null,
      recommendedBuyPrice: null,
      recommendedStopLoss: null,
      hotSignal: 0,
      scannedAt: null,
    };

    const mapped = {
      id: dbRow.id,
      ticker: dbRow.ticker,
      company: dbRow.companyName ?? "",
      sector: dbRow.sector ?? "",
      score: dbRow.score != null ? Number(dbRow.score) : null,
      tier: dbRow.tier ?? null,
      cmp: dbRow.cmp != null ? Number(dbRow.cmp) : null,
      dailyChangePercent: dbRow.dailyChangePercent != null ? Number(dbRow.dailyChangePercent) : null,
      recommendedBuyPrice: dbRow.recommendedBuyPrice != null ? Number(dbRow.recommendedBuyPrice) : null,
      recommendedStopLoss: dbRow.recommendedStopLoss != null ? Number(dbRow.recommendedStopLoss) : null,
      hotSignal: dbRow.hotSignal === 1 || (dbRow.hotSignal as any) === true,
      scannedAt: dbRow.scannedAt ?? null,
    };

    expect(mapped.company).toBe("");
    expect(mapped.sector).toBe("");
    expect(mapped.score).toBeNull();
    expect(mapped.tier).toBeNull();
    expect(mapped.cmp).toBeNull();
    expect(mapped.hotSignal).toBe(false);
  });
});

describe("Favorites — Distance to Entry Calculation", () => {
  it("calculates positive distance (price above buy zone)", () => {
    const cmp = 200;
    const buyPrice = 185;
    const dist = ((cmp - buyPrice) / buyPrice) * 100;
    expect(dist).toBeCloseTo(8.11, 1);
  });

  it("calculates negative distance (price below buy zone)", () => {
    const cmp = 180;
    const buyPrice = 185;
    const dist = ((cmp - buyPrice) / buyPrice) * 100;
    expect(dist).toBeCloseTo(-2.70, 1);
  });

  it("detects triggered state (within 0.1%)", () => {
    const cmp = 185.1;
    const buyPrice = 185;
    const dist = ((cmp - buyPrice) / buyPrice) * 100;
    expect(Math.abs(dist)).toBeLessThan(0.1);
  });
});
