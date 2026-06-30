import { describe, it, expect } from "vitest";
import {
  positionUnrealizedPnl,
  positionRealizedPnl,
  pnlPct,
} from "./PnlService.js";

describe("positionUnrealizedPnl", () => {
  it("long winner: entry 100, current 110, 10 units → +100", () => {
    expect(positionUnrealizedPnl("long", 100, 110, 10)).toBe(100);
  });

  it("long loser: entry 100, current 90, 10 units → -100", () => {
    expect(positionUnrealizedPnl("long", 100, 90, 10)).toBe(-100);
  });

  it("short winner: entry 100, current 90, 10 units → +100", () => {
    expect(positionUnrealizedPnl("short", 100, 90, 10)).toBe(100);
  });

  it("short loser: entry 100, current 110, 10 units → -100", () => {
    expect(positionUnrealizedPnl("short", 100, 110, 10)).toBe(-100);
  });

  it("breakeven long: entry == current → 0", () => {
    expect(positionUnrealizedPnl("long", 100, 100, 10)).toBe(0);
  });

  it("breakeven short: entry == current → 0", () => {
    expect(positionUnrealizedPnl("short", 100, 100, 10)).toBe(0);
  });
});

describe("positionRealizedPnl", () => {
  it("long winner: entry 100, exit 110, 10 units → +100", () => {
    expect(positionRealizedPnl("long", 100, 110, 10)).toBe(100);
  });

  it("long loser: entry 100, exit 90, 10 units → -100", () => {
    expect(positionRealizedPnl("long", 100, 90, 10)).toBe(-100);
  });

  it("short winner: entry 100, exit 90, 10 units → +100", () => {
    expect(positionRealizedPnl("short", 100, 90, 10)).toBe(100);
  });

  it("short loser: entry 100, exit 110, 10 units → -100", () => {
    expect(positionRealizedPnl("short", 100, 110, 10)).toBe(-100);
  });

  it("matches liveOrderExecutor formula for short: (entryPrice - exitPrice) * units", () => {
    // Exact formula from liveOrderExecutor.ts ~line 1125:
    //   (pos.entryPrice - exitPrice) * pos.units
    const entry = 200;
    const exit = 180;
    const units = 5;
    const expected = (entry - exit) * units; // 100
    expect(positionRealizedPnl("short", entry, exit, units)).toBe(expected);
  });
});

describe("pnlPct", () => {
  it("returns correct percent: entry 100, pnl 100, 10 units → 10%", () => {
    expect(pnlPct(100, 100, 10)).toBe(10);
  });

  it("returns negative percent for a loss", () => {
    expect(pnlPct(100, -50, 10)).toBe(-5);
  });

  it("divide-by-zero guard: entryPrice=0 → 0", () => {
    expect(pnlPct(0, 100, 10)).toBe(0);
  });

  it("divide-by-zero guard: units=0 → 0", () => {
    expect(pnlPct(100, 100, 0)).toBe(0);
  });
});
