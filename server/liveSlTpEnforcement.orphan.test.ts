import { describe, expect, it } from "vitest";
import { isBracketLeg, isOrphanProtectiveOrder } from "./liveSlTpEnforcement";

describe("isBracketLeg", () => {
  it("detects BR-P-/BR-SL-/BR-TP- coids", () => {
    expect(isBracketLeg({ cOID: "BR-P-NFLX-123" })).toBe(true);
    expect(isBracketLeg({ coid: "BR-SL-ACHR-456" })).toBe(true);
    expect(isBracketLeg({ local_order_id: "BR-TP-NFLX-789" })).toBe(true);
  });

  it("detects child orders via parent_order_id", () => {
    expect(isBracketLeg({ parent_order_id: "1648064743" })).toBe(true);
  });

  it("returns false for standalone protective orders", () => {
    expect(isBracketLeg({ cOID: "SL-NET-1", orderType: "STP" })).toBe(false);
  });
});

describe("isOrphanProtectiveOrder", () => {
  const noPositions = new Set<string>();

  it("does NOT flag pending bracket legs without a position (NFLX/ACHR bug)", () => {
    const shortBracketEntry = {
      description1: "NFLX",
      side: "SELL",
      orderType: "LMT",
      cOID: "BR-P-NFLX-abc",
    };
    const shortBracketSl = {
      description1: "NFLX",
      side: "BUY",
      orderType: "STP",
      cOID: "BR-SL-NFLX-abc",
      parent_order_id: "999",
    };
    expect(isOrphanProtectiveOrder(shortBracketEntry, noPositions)).toBe(false);
    expect(isOrphanProtectiveOrder(shortBracketSl, noPositions)).toBe(false);
  });

  it("flags standalone SL/TP with no live position", () => {
    const straySl = { description1: "AMZN", side: "SELL", orderType: "STP" };
    expect(isOrphanProtectiveOrder(straySl, noPositions)).toBe(true);
  });

  it("ignores orders when ticker has a live position", () => {
    const withNet = new Set(["NET"]);
    const sl = { description1: "NET", side: "SELL", orderType: "STP" };
    expect(isOrphanProtectiveOrder(sl, withNet)).toBe(false);
  });
});
