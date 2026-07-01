import { describe, it, expect } from "vitest";
import {
  scoreVipRank, applyTierCaps, tierSortBoost, compareEnterPriority,
  VIP_A_MAX, VIP_B_MAX, type VipTier,
} from "./dynamicVip";

const base = {
  closeAboveEma50: true, closeAboveEma200: true, weeklyEma50SlopePos: true,
  kineticScore: 80, finalScore: 8, sectorHot: true,
};

describe("scoreVipRank", () => {
  it("energy bomb (all points, 6) → VIP-A", () => {
    const r = scoreVipRank(base);
    expect(r.points).toBe(6);
    expect(r.tier).toBe("VIP-A");
  });
  it("4 points → VIP-A (owner-ratified ≥4 threshold, was ≥5)", () => {
    // ema50 + ema200 + kinetic>=70 + sector = 4 (no weekly slope, no finalScore)
    const r = scoreVipRank({ closeAboveEma50: true, closeAboveEma200: true, weeklyEma50SlopePos: false, kineticScore: 80, finalScore: null, sectorHot: true });
    expect(r.points).toBe(4);
    expect(r.tier).toBe("VIP-A");
  });
  it("MTSI/RIOT below EMA50 → hard BENCH regardless of momentum", () => {
    const r = scoreVipRank({ ...base, closeAboveEma50: false });
    expect(r.tier).toBe("BENCH");
    expect(r.reasons).toContain("below_ema50");
  });
  it("mid strength (3 points) → VIP-B", () => {
    // above ema50 (+1) + kinetic>=70 (+1) + finalScore>=7.5 (+1) = 3, no ema200/slope/sector
    const r = scoreVipRank({ closeAboveEma50: true, closeAboveEma200: false, weeklyEma50SlopePos: false, kineticScore: 75, finalScore: 7.6, sectorHot: false });
    expect(r.points).toBe(3);
    expect(r.tier).toBe("VIP-B");
  });
  it("weak but above ema50 (1 point) → BENCH", () => {
    const r = scoreVipRank({ closeAboveEma50: true, closeAboveEma200: false, weeklyEma50SlopePos: false, kineticScore: 40, finalScore: 5, sectorHot: false });
    expect(r.points).toBe(1);
    expect(r.tier).toBe("BENCH");
  });
  it("null kinetic/finalScore treated as 0 (no momentum points)", () => {
    const r = scoreVipRank({ closeAboveEma50: true, closeAboveEma200: true, weeklyEma50SlopePos: true, kineticScore: null, finalScore: null, sectorHot: false });
    expect(r.points).toBe(3); // structural only
    expect(r.tier).toBe("VIP-B");
  });
});

describe("applyTierCaps (INV-4: VIP-A ≤ 12, VIP-B ≤ 20)", () => {
  it("15 VIP-A candidates → top 12 stay VIP-A, next 3 → VIP-B", () => {
    const ranked = Array.from({ length: 15 }, (_, i) => ({ ticker: `T${i}`, points: 6 - i * 0.01, tier: "VIP-A" as VipTier }));
    const caps = applyTierCaps(ranked);
    const tiers = [...caps.values()];
    expect(tiers.filter(t => t === "VIP-A").length).toBe(VIP_A_MAX);
    expect(tiers.filter(t => t === "VIP-B").length).toBe(3);
    expect(caps.get("T0")).toBe("VIP-A");   // highest points
    expect(caps.get("T14")).toBe("VIP-B");  // overflow demoted
  });
  it("VIP-B overflow beyond 20 → BENCH", () => {
    const ranked = Array.from({ length: 25 }, (_, i) => ({ ticker: `B${i}`, points: 3, tier: "VIP-B" as VipTier }));
    const caps = applyTierCaps(ranked);
    expect([...caps.values()].filter(t => t === "VIP-B").length).toBe(VIP_B_MAX);
    expect([...caps.values()].filter(t => t === "BENCH").length).toBe(5);
  });
  it("equal points → kineticScore desc breaks the VIP-A cap tie (§C.5)", () => {
    const ranked = Array.from({ length: 13 }, (_, i) => ({ ticker: `K${i}`, points: 5, tier: "VIP-A" as VipTier, kineticScore: 100 - i }));
    const caps = applyTierCaps(ranked);
    expect(caps.get("K0")).toBe("VIP-A");   // highest kinetic (100) keeps the slot
    expect(caps.get("K12")).toBe("VIP-B");  // lowest kinetic (88) overflows
    expect([...caps.values()].filter(t => t === "VIP-A").length).toBe(VIP_A_MAX);
  });
});

describe("compareEnterPriority (INV-2: edge > 0.5 always beats a lower tier)", () => {
  const A = (finalScore: number, tier: VipTier, kineticScore = 50) => ({ finalScore, kineticScore, tier });
  it("VIP-A@6.2 vs VIP-B@8.1 (gap 1.9 > 0.5) → the 8.1 edge wins", () => {
    const arr = [A(6.2, "VIP-A"), A(8.1, "VIP-B")].sort(compareEnterPriority);
    expect(arr[0].finalScore).toBe(8.1);   // VIP-B with the real edge enters first
  });
  it("VIP-A@7.8 vs BENCH@7.5 (gap 0.3 ≤ 0.5) → tier wins → VIP-A", () => {
    const arr = [A(7.5, "BENCH"), A(7.8, "VIP-A")].sort(compareEnterPriority);
    expect(arr[0].tier).toBe("VIP-A");
  });
  it("exact 0.5 gap is NOT > threshold → tier breaks it", () => {
    // VIP-A@7.5 vs BENCH@8.0 → gap 0.5, not >0.5 → tier decides → VIP-A first
    const arr = [A(8.0, "BENCH"), A(7.5, "VIP-A")].sort(compareEnterPriority);
    expect(arr[0].tier).toBe("VIP-A");
  });
  it("same tier within band → higher finalScore, then kinetic", () => {
    const arr = [A(7.5, "VIP-A", 40), A(7.6, "VIP-A", 90)].sort(compareEnterPriority);
    expect(arr[0].finalScore).toBe(7.6);
  });
});

describe("tierSortBoost (display only, never a gate)", () => {
  it("A=0.6, B=0.2, BENCH=0", () => {
    expect(tierSortBoost("VIP-A")).toBe(0.6);
    expect(tierSortBoost("VIP-B")).toBe(0.2);
    expect(tierSortBoost("BENCH")).toBe(0);
  });
});
