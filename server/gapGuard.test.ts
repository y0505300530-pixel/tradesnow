import { describe, it, expect } from "vitest";
import { isGapChase, gapPctFromEntryZone, GAP_GUARD_PCT } from "./gapGuard";

describe("gapGuard (P0-6)", () => {
  it("blocks a LONG that gapped > +1.5% above the entry zone", () => {
    expect(isGapChase("long", 100, 101.6)).toBe(true);   // +1.6%
  });
  it("allows a LONG within the entry zone (<= 1.5%)", () => {
    expect(isGapChase("long", 100, 101.5)).toBe(false);  // +1.5% exactly
    expect(isGapChase("long", 100, 99)).toBe(false);     // below entry = fine
  });
  it("blocks a SHORT that gapped > 1.5% below the entry zone", () => {
    expect(isGapChase("short", 100, 98.4)).toBe(true);   // -1.6%
  });
  it("allows a SHORT within the entry zone", () => {
    expect(isGapChase("short", 100, 98.5)).toBe(false);  // -1.5% exactly
    expect(isGapChase("short", 100, 101)).toBe(false);   // above entry = fine for short
  });
  it("does not block when signal price is missing (gap unknowable)", () => {
    expect(isGapChase("long", 0, 105)).toBe(false);
  });
  it("gapPctFromEntryZone is signed and correct", () => {
    expect(gapPctFromEntryZone(100, 102)).toBeCloseTo(2, 6);
    expect(gapPctFromEntryZone(100, 97)).toBeCloseTo(-3, 6);
    expect(GAP_GUARD_PCT).toBe(1.5);
  });
});
