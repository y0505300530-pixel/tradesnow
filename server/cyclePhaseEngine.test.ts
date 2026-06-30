import { describe, it, expect } from "vitest";
import {
  classifyCyclePhase,
  buildCyclePhaseInput,
  classifyCyclePhaseFromBars,
  LOW_VOL_RATIO,
  HIGH_VOL_RATIO,
  type CyclePhaseInput,
  type CycleBar,
} from "./cyclePhaseEngine";

const base: CyclePhaseInput = {
  close: 100, ema50: 95, distToEma50Pct: 5.2, rsi: 55,
  donchian20High: 105, donchian20Low: 90, volumeRatio: 1.0, priceRising: true,
};

describe("classifyCyclePhase — CYC-L1 (long block)", () => {
  it("BLOCKS long on rise + low volume (false breakout)", () => {
    const r = classifyCyclePhase({ ...base, priceRising: true, volumeRatio: 0.70 });
    expect(r.longGate).toBe("BLOCK");
    expect(r.code).toBe("CYC-L1");
    expect(r.reason).toMatch(/false breakout/);
  });

  it("does NOT block a dry PULLBACK (low volume, not rising = healthy retest)", () => {
    const r = classifyCyclePhase({ ...base, priceRising: false, volumeRatio: 0.70 });
    expect(r.longGate).toBe("OK"); // positive confirmation, not a block
  });

  it("does NOT block a rise on healthy volume", () => {
    const r = classifyCyclePhase({ ...base, priceRising: true, volumeRatio: 1.2 });
    expect(r.longGate).toBe("OK");
  });

  it("threshold is exclusive at LOW_VOL_RATIO", () => {
    expect(classifyCyclePhase({ ...base, priceRising: true, volumeRatio: LOW_VOL_RATIO }).longGate).toBe("OK");
    expect(classifyCyclePhase({ ...base, priceRising: true, volumeRatio: LOW_VOL_RATIO - 0.01 }).longGate).toBe("BLOCK");
  });
});

describe("classifyCyclePhase — CYC-S1 (short block)", () => {
  it("BLOCKS short on drop + high volume (bear trap)", () => {
    const r = classifyCyclePhase({ ...base, priceRising: false, volumeRatio: HIGH_VOL_RATIO + 0.5 });
    expect(r.shortGate).toBe("BLOCK");
    expect(r.reason).toMatch(/bear trap/);
  });

  it("does NOT block a short on a drop with normal volume", () => {
    const r = classifyCyclePhase({ ...base, priceRising: false, volumeRatio: 1.1 });
    expect(r.shortGate).toBe("OK");
  });
});

describe("classifyCyclePhase — location", () => {
  it("HIGH when extended from EMA-50", () => {
    expect(classifyCyclePhase({ ...base, distToEma50Pct: 8, rsi: 50 }).location).toBe("HIGH");
  });
  it("LOW when at/under EMA-50 in lower Donchian half", () => {
    const r = classifyCyclePhase({ ...base, close: 91, ema50: 95, distToEma50Pct: 4, rsi: 45 });
    expect(r.location).toBe("LOW");
    expect(r.isLowCycle).toBe(true);
  });
});

describe("buildCyclePhaseInput / fromBars", () => {
  it("returns null with insufficient history (<20 bars)", () => {
    const few: CycleBar[] = Array.from({ length: 10 }, () => ({ close: 10, high: 11, low: 9, volume: 1000 }));
    expect(buildCyclePhaseInput(few)).toBeNull();
    expect(classifyCyclePhaseFromBars(few)).toBeNull();
  });

  it("flags rise-on-low-volume from real bars → CYC-L1", () => {
    // 25 flat bars on high volume, then a sharp rise on collapsing volume.
    const bars: CycleBar[] = [];
    for (let i = 0; i < 20; i++) bars.push({ close: 100, high: 101, low: 99, volume: 1_000_000 });
    for (let i = 0; i < 5; i++) bars.push({ close: 100 + i * 2, high: 100 + i * 2 + 1, low: 100 + i * 2 - 1, volume: 200_000 });
    const input = buildCyclePhaseInput(bars)!;
    expect(input.priceRising).toBe(true);                  // input field
    expect(input.volumeRatio).toBeLessThan(LOW_VOL_RATIO); // input field
    expect(classifyCyclePhaseFromBars(bars)!.longGate).toBe("BLOCK"); // result field
  });
});
