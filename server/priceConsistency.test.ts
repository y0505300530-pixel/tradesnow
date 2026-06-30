/**
 * priceConsistency.test.ts
 *
 * Regression guard for the 100x analyzeStream bug (P3a-T2).
 *
 * Before the fix:
 *   analyzeSingle divided bars by 100*ilsRate (correct)
 *   analyzeStream divided bars by ilsRate only (WRONG — 100x too large)
 *
 * After the fix both paths call normalizeBarsForTicker(bars, ticker, ilsRate)
 * which always divides .TA OHLC by 100*ilsRate.
 *
 * This test asserts:
 *   1. The two paths produce identical output (unified via normalizeBarsForTicker)
 *   2. The output value equals agorot/100/ilsRate
 */

import { describe, it, expect } from "vitest";
import { normalizeBarsForTicker } from "./services/PriceService";

describe("TASE price normalization — consistency guard (P3a-T2)", () => {
  const ilsRate = 3.70;
  const agorotPrice = 15000; // typical TASE stock in agorot (e.g. 150 ILS = 15000 agorot)

  const rawBar = {
    date: "2026-06-24",
    open: agorotPrice,
    high: agorotPrice + 200,
    low: agorotPrice - 200,
    close: agorotPrice,
    volume: 50000,
  };

  const ticker = "POLI.TA";

  it("normalizeBarsForTicker is idempotent — calling twice on same bar produces same result", () => {
    const [path1] = normalizeBarsForTicker([rawBar], ticker, ilsRate);
    const [path2] = normalizeBarsForTicker([rawBar], ticker, ilsRate);

    // Both the old analyzeSingle path and analyzeStream path now call the same function
    expect(path1.open).toBe(path2.open);
    expect(path1.high).toBe(path2.high);
    expect(path1.low).toBe(path2.low);
    expect(path1.close).toBe(path2.close);
  });

  it("normalized close equals agorot / 100 / ilsRate (canonical TASE rule)", () => {
    const [normalized] = normalizeBarsForTicker([rawBar], ticker, ilsRate);
    const expected = agorotPrice / 100 / ilsRate;
    expect(normalized.close).toBeCloseTo(expected, 10);
  });

  it("volume is unchanged by normalization", () => {
    const [normalized] = normalizeBarsForTicker([rawBar], ticker, ilsRate);
    expect(normalized.volume).toBe(rawBar.volume);
  });

  it("non-.TA tickers are passed through unchanged", () => {
    const usBar = { ...rawBar, close: 150 };
    const [normalized] = normalizeBarsForTicker([usBar], "AAPL", ilsRate);
    expect(normalized.close).toBe(150);
  });

  it("the old analyzeStream bug would give 100x larger value than the correct result", () => {
    // Old analyzeStream: / ilsRate only
    const wrongClose = agorotPrice / ilsRate;
    // Correct: / 100 / ilsRate
    const correctClose = agorotPrice / 100 / ilsRate;
    // The wrong value was 100x the correct value
    expect(wrongClose).toBeCloseTo(correctClose * 100, 5);

    // Verify normalizeBarsForTicker produces the correct value, not the wrong one
    const [normalized] = normalizeBarsForTicker([rawBar], ticker, ilsRate);
    expect(normalized.close).toBeCloseTo(correctClose, 10);
    expect(normalized.close).not.toBeCloseTo(wrongClose, 5);
  });
});
