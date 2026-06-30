import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  calcSlTp,
  calcCatalogueAlertTarget,
  calcEntrySlTp,
  calcTarget1Price,
  calcSwingSlTp,
  calcHoldingSlTp,
  isShortUnits,
  directionFromUnits,
  validateSlTpDirection,
  ensureDirectionalSlTp,
  SCALE_OUT_TP1_R,
  freeRollTriggerGain,
  recommendedPositionSize,
  INTRADAY_SL_PCT,
} from "./slCalculator";

describe("calcSlTp", () => {
  it("uses EMA-50 floor when it is tighter than 8%", () => {
    const { stopLoss, takeProfit, slSource } = calcSlTp(100, 94);
    expect(stopLoss).toBeCloseTo(93.06, 1);
    expect(takeProfit).toBeGreaterThan(100);
    expect(slSource).toBe("ema50");
  });

  it("uses 8% rule when EMA-50 is below the 8% floor", () => {
    const { stopLoss, slSource } = calcSlTp(100, 80);
    expect(stopLoss).toBeCloseTo(92, 1);
    expect(slSource).toBe("pct");
  });

  it("falls back to 8% when EMA-50 is above buyPrice (safety guard)", () => {
    const { stopLoss, slSource } = calcSlTp(100, 105);
    expect(stopLoss).toBeCloseTo(92, 1);
    expect(slSource).toBe("pct");
  });

  it("SL is always strictly below buyPrice for various inputs", () => {
    const cases: [number, number][] = [
      [100, 99.5],
      [50, 48],
      [200, 195],
      [30, 35],
      [500, 460],
    ];
    for (const [buyPrice, ema50] of cases) {
      const { stopLoss } = calcSlTp(buyPrice, ema50);
      expect(stopLoss).toBeLessThan(buyPrice);
    }
  });

  it("TP = buyPrice + 5.0 × risk", () => {
    const buyPrice = 100;
    const { stopLoss, takeProfit } = calcSlTp(buyPrice, 80);
    const risk = buyPrice - stopLoss;
    expect(takeProfit).toBeCloseTo(buyPrice + 5.0 * risk, 4);
  });
});

describe("calcSwingSlTp", () => {
  it("uses wider SL than intraday for same entry", () => {
    const entry = 100;
    const ema50 = 95;
    const atr14 = 3;
    const swing = calcSwingSlTp({
      entryPrice: entry,
      ema50,
      atr14,
      swingExtreme20: 90,
      direction: "long",
    });
    const intra = calcSlTp(entry, ema50);
    expect(swing.stopLoss).toBeLessThan(intra.stopLoss);
    // Structural swing low can be slightly under SWING_SL_MIN_PCT when ATR buffer applies
    expect(entry - swing.stopLoss).toBeGreaterThan(entry * INTRADAY_SL_PCT);
  });
});

describe("calcTarget1Price", () => {
  // ELZA 2.0: scale-out trigger is +2R (decision #4). Lock the value so a
  // regression back to 1.5R is caught.
  it("SCALE_OUT_TP1_R is 2.0R (ELZA 2.0 Approach B)", () => {
    expect(SCALE_OUT_TP1_R).toBe(2.0);
  });

  it("places TP1 at 2.0R for long", () => {
    const entry = 100;
    const sl = 88;                              // risk = 12
    const tp1 = calcTarget1Price(entry, sl, "long", SCALE_OUT_TP1_R);
    expect(tp1).toBeCloseTo(124, 2);            // 100 + 2.0 * 12
    expect(tp1).toBeCloseTo(entry + SCALE_OUT_TP1_R * (entry - sl), 2);
  });

  it("places TP1 at 2.0R for short", () => {
    const entry = 100;
    const sl = 112;                             // risk = 12
    const tp1 = calcTarget1Price(entry, sl, "short", SCALE_OUT_TP1_R);
    expect(tp1).toBeCloseTo(76, 2);             // 100 - 2.0 * 12
    expect(tp1).toBeCloseTo(entry - SCALE_OUT_TP1_R * (sl - entry), 2);
  });
});

describe("recommendedPositionSize (quality-scaled sizing)", () => {
  const MIN = 20000, MAX = 70000;
  it("min score (8.0) → min size", () => {
    expect(recommendedPositionSize(8.0, MIN, MAX)).toBe(MIN);
  });
  it("max score (10.0) → max size", () => {
    expect(recommendedPositionSize(10.0, MIN, MAX)).toBe(MAX);
  });
  it("midpoint (9.0) → midpoint size", () => {
    expect(recommendedPositionSize(9.0, MIN, MAX)).toBe(45000);   // 20k + 0.5*50k
  });
  it("scales linearly (8.5 → 32.5k)", () => {
    expect(recommendedPositionSize(8.5, MIN, MAX)).toBe(32500);
  });
  it("clamps below/above the score band", () => {
    expect(recommendedPositionSize(7.0, MIN, MAX)).toBe(MIN);   // < minScore
    expect(recommendedPositionSize(11.0, MIN, MAX)).toBe(MAX);  // > maxScore
  });
  it("degenerate band → min", () => {
    expect(recommendedPositionSize(9.0, 50000, 50000)).toBe(50000);
  });
});

describe("freeRollTriggerGain (Open Skies Stage 1 threshold — P0-1b)", () => {
  it("triggers the 50% free-roll at exactly 2.0 × R", () => {
    const R = 1.25;                             // per-share risk
    expect(freeRollTriggerGain(R)).toBeCloseTo(2.0 * R, 6);   // = 2.50
  });

  it("a +2R gain meets the threshold; just under does not", () => {
    const R = 4;
    const trigger = freeRollTriggerGain(R);     // 8
    const gainAt2R = 2 * R;                      // 8
    expect(gainAt2R >= trigger).toBe(true);
    expect((2 * R - 0.01) >= trigger).toBe(false);
  });
});

describe("calcEntrySlTp", () => {
  const origMode = process.env.ELSA_TRADING_MODE;

  afterEach(() => {
    if (origMode === undefined) delete process.env.ELSA_TRADING_MODE;
    else process.env.ELSA_TRADING_MODE = origMode;
  });

  it("defaults to swing mode with 2.5R target", () => {
    delete process.env.ELSA_TRADING_MODE;
    const bars = Array.from({ length: 60 }, (_, i) => ({
      close: 100 + i * 0.1,
      high: 101 + i * 0.1,
      low: 99 + i * 0.1,
    }));
    const result = calcEntrySlTp({ entryPrice: 110, ema50: 105, bars, direction: "long" });
    expect(result.mode).toBe("swing");
    expect(result.target1Price).toBeGreaterThan(110);
    expect(result.takeProfit).toBeGreaterThan(result.target1Price);
  });

  it("uses intraday 5R when mode=intraday", () => {
    process.env.ELSA_TRADING_MODE = "intraday";
    const bars = Array.from({ length: 30 }, (_, i) => ({
      close: 100,
      high: 102,
      low: 98,
    }));
    const result = calcEntrySlTp({ entryPrice: 100, ema50: 94, bars, direction: "long" });
    expect(result.mode).toBe("intraday");
    expect(result.tpR).toBe(5);
  });
});

describe("calcHoldingSlTp", () => {
  it("long (units > 0): SL below entry, TP above entry", () => {
    const { stopLoss, takeProfit } = calcHoldingSlTp(100, 94, 10);
    expect(stopLoss).toBeLessThan(100);
    expect(takeProfit).toBeGreaterThan(100);
    expect(isShortUnits(10)).toBe(false);
  });

  it("short (units < 0): SL above entry, TP below entry", () => {
    const bars = Array.from({ length: 60 }, (_, i) => ({
      close: 100 - i * 0.05,
      high: 101 - i * 0.05,
      low: 99 - i * 0.05,
    }));
    const { stopLoss, takeProfit } = calcHoldingSlTp(100, 106, -10, bars);
    expect(stopLoss).toBeGreaterThan(100);
    expect(takeProfit).toBeLessThan(100);
    expect(isShortUnits(-10)).toBe(true);
    expect(directionFromUnits(-10)).toBe("short");
  });
});

describe("validateSlTpDirection", () => {
  it("accepts correct long orientation", () => {
    expect(validateSlTpDirection(100, 92, 140, "long")).toBe(true);
    expect(validateSlTpDirection(100, 92, 140, 50)).toBe(true);
  });

  it("accepts correct short orientation via units < 0", () => {
    expect(validateSlTpDirection(100, 108, 80, "short")).toBe(true);
    expect(validateSlTpDirection(100, 108, 80, -25)).toBe(true);
  });

  it("rejects inverted short levels", () => {
    expect(validateSlTpDirection(100, 92, 140, "short")).toBe(false);
    expect(validateSlTpDirection(100, 92, 140, -10)).toBe(false);
  });
});

describe("ensureDirectionalSlTp", () => {
  it("recomputes when short SL/TP are inverted (long-style)", () => {
    const bars = Array.from({ length: 60 }, (_, i) => ({
      close: 100 - i * 0.05,
      high: 101 - i * 0.05,
      low: 99 - i * 0.05,
    }));
    const fixed = ensureDirectionalSlTp(100, 106, 92, 140, "short", bars);
    expect(fixed.stopLoss).toBeGreaterThan(100);
    expect(fixed.takeProfit).toBeLessThan(100);
  });
});

describe("calcEntrySlTp short", () => {
  it("swing short: SL above entry, TP below entry", () => {
    const bars = Array.from({ length: 60 }, (_, i) => ({
      close: 100 - i * 0.1,
      high: 102 - i * 0.1,
      low: 98 - i * 0.1,
    }));
    const result = calcEntrySlTp({ entryPrice: 100, ema50: 105, bars, direction: "short" });
    expect(result.stopLoss).toBeGreaterThan(100);
    expect(result.takeProfit).toBeLessThan(100);
    expect(result.target1Price).toBeLessThan(100);
  });
});

describe("calcCatalogueAlertTarget", () => {
  it("returns buyPrice as the target", () => {
    expect(calcCatalogueAlertTarget(150)).toBe(150);
    expect(calcCatalogueAlertTarget(0.5)).toBe(0.5);
  });
});
