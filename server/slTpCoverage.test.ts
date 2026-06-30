import { describe, expect, it } from "vitest";
import { isPositionSlTpCovered } from "@/components/war-room/SlTpBadge";

describe("isPositionSlTpCovered", () => {
  const position = { ticker: "AAPL", units: 10, direction: "long" as const };

  it("returns true when live IBKR TP order matches ticker, side, qty", () => {
    const orders = [{
      ticker: "AAPL",
      orderType: "LMT",
      side: "SELL",
      status: "Submitted",
      qty: 10,
      price: 200,
    }];
    expect(isPositionSlTpCovered(position, orders, "TP")).toBe(true);
  });

  it("returns false when only DB field is empty and no live TP order", () => {
    expect(isPositionSlTpCovered(
      { ...position, ibkrTpOrderId: null },
      [],
      "TP",
    )).toBe(false);
  });

  it("returns true via dbConfirmed when ibkrTpOrderId set but orders not yet visible", () => {
    expect(isPositionSlTpCovered(
      { ...position, ibkrTpOrderId: "12345" },
      [],
      "TP",
    )).toBe(true);
  });

  it("short cover uses BUY side for TP", () => {
    const orders = [{
      ticker: "TSLA",
      orderType: "LMT",
      side: "BUY",
      status: "PreSubmitted",
      qty: 5,
    }];
    expect(isPositionSlTpCovered(
      { ticker: "TSLA", units: 5, direction: "short" },
      orders,
      "TP",
    )).toBe(true);
  });
});
