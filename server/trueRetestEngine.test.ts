import { describe, it, expect } from "vitest";
import { detectTrueRetest, RETEST_CONFIRM_CANDLES, type RetestBar } from "./trueRetestEngine";

/** Helper: build a flat base at `base`, a breakout pop to `peak`, then a pullback that
 *  holds at `holdClose` for the confirm window. */
function makeBars(base: number, peak: number, holdClose: number, baseLen = 30): RetestBar[] {
  const bars: RetestBar[] = [];
  for (let i = 0; i < baseLen; i++) bars.push({ high: base, low: base - 2, close: base - 1 });   // base: resistance ≈ `base`
  bars.push({ high: peak, low: base, close: peak });                                              // breakout close above base
  for (let i = 0; i < RETEST_CONFIRM_CANDLES; i++) bars.push({ high: holdClose + 1, low: holdClose - 1, close: holdClose }); // hold
  return bars;
}

describe("detectTrueRetest", () => {
  it("detects a real retest: broke 100, pulled back to ~100.5, held 5 candles", () => {
    const bars = makeBars(100, 106, 100.5);  // level≈100, retest at 100.5 (0.5%), holds
    const r = detectTrueRetest(bars);
    expect(r.isRetest).toBe(true);
    expect(r.priorBreakoutLevel).toBeCloseTo(100, 0);
    expect(r.heldCandles).toBe(RETEST_CONFIRM_CANDLES);
  });

  it("rejects EMA-proximity-without-structure (never broke the level)", () => {
    // Price wanders below the resistance the whole time — no breakout close above base.
    const bars: RetestBar[] = Array.from({ length: 40 }, () => ({ high: 99, low: 95, close: 97 }));
    const r = detectTrueRetest(bars);
    expect(r.isRetest).toBe(false);
    expect(r.reason).toMatch(/no breakout/);
  });

  it("rejects when price ran far above (no pullback to the level)", () => {
    const bars = makeBars(100, 110, 112);  // never came back near 100
    const r = detectTrueRetest(bars);
    expect(r.isRetest).toBe(false);
    expect(r.reason).toMatch(/not near level/);
  });

  it("rejects a failed retest (closed back below the broken level)", () => {
    const bars = makeBars(100, 106, 96);   // pulled back BELOW floor (100*0.98=98)
    const r = detectTrueRetest(bars);
    expect(r.isRetest).toBe(false);
    expect(r.reason).toMatch(/failed hold|not near/);
  });

  it("returns insufficient history for short series", () => {
    const bars: RetestBar[] = Array.from({ length: 10 }, () => ({ high: 100, low: 99, close: 99.5 }));
    expect(detectTrueRetest(bars).isRetest).toBe(false);
    expect(detectTrueRetest(bars).reason).toMatch(/insufficient/);
  });
});
