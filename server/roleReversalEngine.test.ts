import { describe, it, expect } from "vitest";
import { detectRoleReversal, type RRBar } from "./roleReversalEngine";

/** LONG: 25 bars below `res`, a breakout close above, then a pullback that retests
 *  `res` from above and holds. */
function longReversal(res = 100): RRBar[] {
  const bars: RRBar[] = [];
  for (let i = 0; i < 30; i++) bars.push({ high: res, low: res - 4, close: res - 2 });      // base: resistance = res
  bars.push({ high: res + 5, low: res - 1, close: res + 4 });                               // breakout close above
  for (let i = 0; i < 5; i++) bars.push({ high: res + 2, low: res * 0.995, close: res + 0.5 }); // retest, holds above
  return bars;
}

/** SHORT: 25 bars above `sup`, a breakdown close below, then a rally that retests
 *  `sup` from below and gets rejected. */
function shortReversal(sup = 100): RRBar[] {
  const bars: RRBar[] = [];
  for (let i = 0; i < 30; i++) bars.push({ high: sup + 4, low: sup, close: sup + 2 });       // base: support = sup
  bars.push({ high: sup + 1, low: sup - 5, close: sup - 4 });                                // breakdown close below
  for (let i = 0; i < 5; i++) bars.push({ high: sup * 1.005, low: sup - 2, close: sup - 0.5 }); // retest, rejected below
  return bars;
}

describe("detectRoleReversal — LONG (resistance→support)", () => {
  it("detects V1+V2 long reversal", () => {
    const r = detectRoleReversal(longReversal(100), "long");
    expect(r.isReversal).toBe(true);
    expect(r.level).toBeCloseTo(100, 0);
    expect(r.brokeRole).toBe(true);
    expect(r.retested).toBe(true);
  });

  it("no reversal when the level never broke (price stayed below)", () => {
    const bars: RRBar[] = Array.from({ length: 35 }, () => ({ high: 99, low: 96, close: 97 }));
    const r = detectRoleReversal(bars, "long");
    expect(r.isReversal).toBe(false);
    expect(r.brokeRole).toBe(false);
  });

  it("no reversal when price ran away (no retest near the level)", () => {
    const bars = longReversal(100);
    for (let i = 0; i < 5; i++) bars.push({ high: 115, low: 112, close: 114 }); // ran far above, last close ~114
    const r = detectRoleReversal(bars, "long");
    expect(r.isReversal).toBe(false);
  });
});

describe("detectRoleReversal — SHORT (support→resistance)", () => {
  it("detects BR1+BR2 short reversal", () => {
    const r = detectRoleReversal(shortReversal(100), "short");
    expect(r.isReversal).toBe(true);
    expect(r.level).toBeCloseTo(100, 0);
    expect(r.brokeRole).toBe(true);
    expect(r.retested).toBe(true);
  });

  it("no short reversal when support held (never broke below)", () => {
    const bars: RRBar[] = Array.from({ length: 35 }, () => ({ high: 105, low: 101, close: 103 }));
    expect(detectRoleReversal(bars, "short").isReversal).toBe(false);
  });
});
