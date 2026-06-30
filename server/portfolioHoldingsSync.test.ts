import { describe, it, expect } from "vitest";
import {
  signedUnitsFromLive,
  holdingFieldsFromLivePosition,
  mergeIbkrHoldingWithLive,
  isShortHolding,
} from "./portfolioHoldingsSync";
import { calcHoldingSlTp } from "./slCalculator";

describe("portfolioHoldingsSync", () => {
  it("signedUnitsFromLive negates qty for shorts", () => {
    expect(signedUnitsFromLive({ units: 50, direction: "short" })).toBe(-50);
    expect(signedUnitsFromLive({ units: 50, direction: "long" })).toBe(50);
  });

  it("holdingFieldsFromLivePosition uses entryPrice and current SL/TP", () => {
    const fields = holdingFieldsFromLivePosition({
      entryPrice: 142.5,
      units: 30,
      direction: "short",
      currentSl: 155.2,
      currentTp: 128.4,
      currentPrice: 140.1,
    });
    expect(fields.buyPrice).toBe(142.5);
    expect(fields.units).toBe(-30);
    expect(fields.stopLoss).toBe(155.2);
    expect(fields.takeProfit).toBe(128.4);
    expect(fields.source).toBe("elza");
  });

  it("mergeIbkrHoldingWithLive prefers livePositions over IBKR avgCost", () => {
    const live = {
      id: 1,
      userId: 1,
      accountId: "",
      ticker: "ENTG",
      direction: "short" as const,
      units: 25,
      entryPrice: 141.0,
      allocatedCapital: 3525,
      currentSl: 154.0,
      currentTp: 126.0,
      initialSl: 154.0,
      initialTp: 126.0,
      status: "open" as const,
      signal: "TEST",
      openedAt: new Date(),
      slProtection: "ibkr" as const,
      isFreeRolled: 0,
    };
    const map = new Map([["ENTG", live]]);
    const merged = mergeIbkrHoldingWithLive(
      "ENTG",
      { position: -25, avgCost: 143.8, mktPrice: 139.5 },
      map,
    );
    expect(merged.buyPrice).toBe(141.0);
    expect(merged.units).toBe(-25);
    expect(merged.stopLoss).toBe(154.0);
    expect(merged.takeProfit).toBe(126.0);
    expect(merged.source).toBe("elza");
  });

  it("mergeIbkrHoldingWithLive falls back to IBKR when no live row", () => {
    const merged = mergeIbkrHoldingWithLive(
      "AAPL",
      { position: 10, avgCost: 200, mktPrice: 205 },
      new Map(),
    );
    expect(merged.buyPrice).toBe(200);
    expect(merged.units).toBe(10);
    expect(merged.source).toBeUndefined();
  });
});

describe("calcHoldingSlTp", () => {
  it("long: SL below entry, TP above entry", () => {
    const { stopLoss, takeProfit } = calcHoldingSlTp(100, 94, 10);
    expect(stopLoss).toBeLessThan(100);
    expect(takeProfit).toBeGreaterThan(100);
    expect(isShortHolding(10)).toBe(false);
  });

  it("short: SL above entry, TP below entry", () => {
    const { stopLoss, takeProfit } = calcHoldingSlTp(100, 106, -10);
    expect(stopLoss).toBeGreaterThan(100);
    expect(takeProfit).toBeLessThan(100);
    expect(isShortHolding(-10)).toBe(true);
  });
});
