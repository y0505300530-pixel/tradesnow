import { describe, it, expect, afterEach } from "vitest";
import {
  calcZivHScore,
  getZivHPhaseBoundaries,
  type Bar,
} from "./zivEngine";

function makeTrendBars(count: number, trend: "up" | "down" = "up", startPrice = 100): Bar[] {
  const bars: Bar[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    price += trend === "up" ? 0.35 : -0.35;
    bars.push({
      date: `2024-01-${String((i % 28) + 1).padStart(2, "0")}`,
      open: price - 0.1,
      high: price + 0.5,
      low: price - 0.5,
      close: price,
      volume: 1_000_000,
    });
  }
  return bars;
}

describe("getZivHPhaseBoundaries", () => {
  const orig = process.env.ELSA_TRADING_MODE;
  afterEach(() => {
    if (orig === undefined) delete process.env.ELSA_TRADING_MODE;
    else process.env.ELSA_TRADING_MODE = orig;
  });

  it("swing extends active management to 21 days", () => {
    process.env.ELSA_TRADING_MODE = "swing";
    const b = getZivHPhaseBoundaries();
    expect(b.phase3EndMin).toBe(21 * 24 * 60);
    expect(b.phase1EndMin).toBe(24 * 60);
  });

  it("intraday keeps legacy horizons", () => {
    process.env.ELSA_TRADING_MODE = "intraday";
    const b = getZivHPhaseBoundaries();
    expect(b.phase1EndMin).toBe(30);
    expect(b.phase3EndMin).toBe(3 * 24 * 60);
  });
});

describe("calcZivHScore — mode-aware phases", () => {
  const orig = process.env.ELSA_TRADING_MODE;
  afterEach(() => {
    if (orig === undefined) delete process.env.ELSA_TRADING_MODE;
    else process.env.ELSA_TRADING_MODE = orig;
  });

  it("swing: day 4 stays in active phase with dynamic score", () => {
    process.env.ELSA_TRADING_MODE = "swing";
    const bars = makeTrendBars(60, "up");
    const result = calcZivHScore(bars, 100, 85, 130, {
      minutesInTrade: 4 * 24 * 60,
      direction: "long",
    });
    expect(result.phase).toBe("active");
    expect(result.score).not.toBe(7.0);
  });

  it("intraday: day 4 enters blind trail phase", () => {
    process.env.ELSA_TRADING_MODE = "intraday";
    const bars = makeTrendBars(60, "up");
    const result = calcZivHScore(bars, 100, 85, 130, {
      minutesInTrade: 4 * 24 * 60,
      direction: "long",
    });
    expect(result.phase).toBe("trail");
    expect(result.score).toBe(7.0);
  });

  it("swing: first 24h is entry grace window", () => {
    process.env.ELSA_TRADING_MODE = "swing";
    const bars = makeTrendBars(60, "up");
    const result = calcZivHScore(bars, 100, 85, 130, { minutesInTrade: 12 * 60 });
    expect(result.phase).toBe("entry-window");
    expect(result.score).toBe(7.0);
  });
});

describe("calcZivHScore — short direction", () => {
  it("infers short from SL above entry", () => {
    process.env.ELSA_TRADING_MODE = "swing";
    const bars = makeTrendBars(60, "down", 100);
    const result = calcZivHScore(bars, 100, 115, 70, {
      minutesInTrade: 5 * 24 * 60,
    });
    expect(result.phase).toBe("active");
    expect(result.indicators.slDistance).toBeGreaterThan(5);
  });
});

describe("calcZivHScore — risk modifiers (P3)", () => {
  it("applies over-exposure penalty when position weight > 15%", () => {
    process.env.ELSA_TRADING_MODE = "swing";
    const bars = makeTrendBars(60, "up");
    const result = calcZivHScore(bars, 100, 85, 130, {
      minutesInTrade: 5 * 24 * 60,
      direction: "long",
      positionValue: 30_000,
      totalPortfolioValue: 150_000,
    });
    expect(result.penalties.overExposure).toBe(true);
    expect(result.details).toContain("Over-exposure");
  });

  it("flags scoreDegraded when current catalog ZIV < 4", () => {
    process.env.ELSA_TRADING_MODE = "swing";
    const bars = makeTrendBars(60, "up");
    const result = calcZivHScore(bars, 100, 85, 130, {
      minutesInTrade: 5 * 24 * 60,
      direction: "long",
      buyScore: 7.5,
      currentEngineScore: 3.2,
    });
    expect(result.penalties.scoreDegraded).toBe(true);
    expect(result.details).toContain("Catalog ZIV");
  });

  it("applies peak bleed penalty when price fell 1+ ATR from peak", () => {
    process.env.ELSA_TRADING_MODE = "swing";
    const bars = makeTrendBars(60, "up");
    const lastClose = bars[bars.length - 1].close;
    const result = calcZivHScore(bars, 100, 85, 200, {
      minutesInTrade: 5 * 24 * 60,
      direction: "long",
      peakPrice: lastClose + 5,
    });
    expect(result.penalties.farFromPeak).toBe(true);
    expect(result.details).toContain("Profit bleed");
  });
});
