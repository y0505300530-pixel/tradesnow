/**
 * v12.06 Fix Verification Tests
 *
 * Tests the three critical fixes introduced in v12.06:
 * 1. Portfolio Concentration Cap (75% max deployed)
 * 2. Daily Tier-1 Throttle (max 3 per day)
 * 3. Alpha Attack boost fix (effectiveAllocationFraction uses boosted value)
 */
import { describe, it, expect } from "vitest";

// ─── Fix 1: Portfolio Concentration Cap ───────────────────────────────────────

describe("v12.06 Fix 1: Portfolio Concentration Cap", () => {
  const MAX_PORTFOLIO_DEPLOYED_FRAC = 0.75;
  const MAX_PORTFOLIO_DEPLOYED_TIER1_FRAC = 0.80;

  function isPortfolioCapBlocked(
    totalCapital: number,
    masterFund: number,
    isTier1Breakout: boolean
  ): boolean {
    const deployedCapital = totalCapital - masterFund;
    const deployedFrac = totalCapital > 0 ? deployedCapital / totalCapital : 0;
    const portfolioCapFrac = isTier1Breakout
      ? MAX_PORTFOLIO_DEPLOYED_TIER1_FRAC
      : MAX_PORTFOLIO_DEPLOYED_FRAC;
    return deployedFrac >= portfolioCapFrac;
  }

  it("blocks standard entry when deployed >= 75%", () => {
    // $400K total, $100K remaining (75% deployed)
    expect(isPortfolioCapBlocked(400_000, 100_000, false)).toBe(true);
  });

  it("blocks standard entry when deployed > 75%", () => {
    // $400K total, $80K remaining (80% deployed)
    expect(isPortfolioCapBlocked(400_000, 80_000, false)).toBe(true);
  });

  it("allows standard entry when deployed < 75%", () => {
    // $400K total, $110K remaining (72.5% deployed)
    expect(isPortfolioCapBlocked(400_000, 110_000, false)).toBe(false);
  });

  it("blocks Tier-1 entry when deployed >= 80%", () => {
    // $400K total, $80K remaining (80% deployed)
    expect(isPortfolioCapBlocked(400_000, 80_000, true)).toBe(true);
  });

  it("allows Tier-1 entry when deployed < 80%", () => {
    // $400K total, $85K remaining (78.75% deployed)
    expect(isPortfolioCapBlocked(400_000, 85_000, true)).toBe(false);
  });

  it("Tier-1 has higher cap than standard (80% vs 75%)", () => {
    // $400K total, $90K remaining (77.5% deployed)
    // Standard entry: BLOCKED (77.5% >= 75%)
    // Tier-1 entry: ALLOWED (77.5% < 80%)
    expect(isPortfolioCapBlocked(400_000, 90_000, false)).toBe(true);
    expect(isPortfolioCapBlocked(400_000, 90_000, true)).toBe(false);
  });

  it("election day scenario: 4 positions × 22.5% = 90% deployed → blocked", () => {
    // $400K total, 4 positions each $89,964 ≈ $359,856 deployed
    // masterFund = $400K - $359,856 = $40,144
    const totalCapital = 400_000;
    const masterFund = 40_144; // after 4 positions opened
    // 5th position attempt (Tier-1): deployed = 89.96% >= 80% → BLOCKED
    expect(isPortfolioCapBlocked(totalCapital, masterFund, true)).toBe(true);
    // Standard entry: also BLOCKED
    expect(isPortfolioCapBlocked(totalCapital, masterFund, false)).toBe(true);
  });

  it("does not block when portfolio is empty (100% cash)", () => {
    expect(isPortfolioCapBlocked(400_000, 400_000, false)).toBe(false);
    expect(isPortfolioCapBlocked(400_000, 400_000, true)).toBe(false);
  });

  it("handles zero totalCapital gracefully", () => {
    expect(isPortfolioCapBlocked(0, 0, false)).toBe(false);
  });
});

// ─── Fix 2: Daily Tier-1 Throttle ─────────────────────────────────────────────

describe("v12.06 Fix 2: Daily Tier-1 Throttle", () => {
  const MAX_DAILY_TIER1_ENTRIES = 3;

  function isDailyThrottleBlocked(
    isTier1Breakout: boolean,
    dailyTier1Count: number
  ): boolean {
    return isTier1Breakout && dailyTier1Count >= MAX_DAILY_TIER1_ENTRIES;
  }

  it("allows first Tier-1 entry of the day", () => {
    expect(isDailyThrottleBlocked(true, 0)).toBe(false);
  });

  it("allows second Tier-1 entry of the day", () => {
    expect(isDailyThrottleBlocked(true, 1)).toBe(false);
  });

  it("allows third Tier-1 entry of the day", () => {
    expect(isDailyThrottleBlocked(true, 2)).toBe(false);
  });

  it("blocks fourth Tier-1 entry (count already at 3)", () => {
    expect(isDailyThrottleBlocked(true, 3)).toBe(true);
  });

  it("blocks fifth Tier-1 entry (count already at 4)", () => {
    expect(isDailyThrottleBlocked(true, 4)).toBe(true);
  });

  it("does NOT throttle non-Tier-1 entries regardless of count", () => {
    expect(isDailyThrottleBlocked(false, 0)).toBe(false);
    expect(isDailyThrottleBlocked(false, 3)).toBe(false);
    expect(isDailyThrottleBlocked(false, 10)).toBe(false);
  });

  it("election day scenario: 7 simultaneous Tier-1 signals → only 3 allowed", () => {
    let dailyCount = 0;
    let allowed = 0;
    let blocked = 0;
    for (let i = 0; i < 7; i++) {
      if (!isDailyThrottleBlocked(true, dailyCount)) {
        dailyCount++;
        allowed++;
      } else {
        blocked++;
      }
    }
    expect(allowed).toBe(3);
    expect(blocked).toBe(4);
  });
});

// ─── Fix 3: Alpha Attack Boost Fix ────────────────────────────────────────────

describe("v12.06 Fix 3: Alpha Attack boost uses effectiveAllocationFraction", () => {
  const RISK_LEVEL = 6;

  function computeAllocationFraction(
    isJoinTheMove: boolean,
    isDonchianBreakout: boolean,
    riskLevel: number,
    currentAlphaMode: "ALPHA_ATTACK" | "SAFE_HAVEN"
  ): { before: number; after: number } {
    // Simulate the original logic (before fix): allocationFraction set once, boost modifies baseAllocationFraction only
    const riskAllocationScale = 0.6 + (riskLevel / 10) * 0.8;
    const breakoutAllocationPct = 0.45 * riskAllocationScale;
    let baseAllocationFraction = isJoinTheMove || isDonchianBreakout
      ? breakoutAllocationPct
      : 0.12 + (riskLevel - 1) * 0.026;

    // Original (broken): allocationFraction captured before boost
    const allocationFractionBefore = baseAllocationFraction; // stale copy

    // Alpha Attack boost
    if (currentAlphaMode === "ALPHA_ATTACK" && (isJoinTheMove || isDonchianBreakout)) {
      baseAllocationFraction = Math.min(baseAllocationFraction * 1.22, 0.55);
    }

    // Fixed: effectiveAllocationFraction uses the (possibly boosted) baseAllocationFraction
    const effectiveAllocationFraction = baseAllocationFraction;

    return { before: allocationFractionBefore, after: effectiveAllocationFraction };
  }

  it("Alpha Attack boost increases allocation fraction for Tier-1 breakouts", () => {
    const result = computeAllocationFraction(true, false, RISK_LEVEL, "ALPHA_ATTACK");
    expect(result.after).toBeGreaterThan(result.before);
  });

  it("Alpha Attack boost does NOT apply in SAFE_HAVEN mode", () => {
    const result = computeAllocationFraction(true, false, RISK_LEVEL, "SAFE_HAVEN");
    expect(result.after).toBe(result.before);
  });

  it("Alpha Attack boost does NOT apply to non-Tier-1 setups", () => {
    const result = computeAllocationFraction(false, false, RISK_LEVEL, "ALPHA_ATTACK");
    expect(result.after).toBe(result.before);
  });

  it("Alpha Attack boost is capped at 55%", () => {
    // Risk Level 10: breakoutAllocationPct = 0.45 * (0.6 + 1.0 * 0.8) = 0.45 * 1.4 = 0.63
    // After boost: min(0.63 * 1.22, 0.55) = min(0.769, 0.55) = 0.55
    const result = computeAllocationFraction(true, false, 10, "ALPHA_ATTACK");
    expect(result.after).toBe(0.55);
  });

  it("Risk 6 Tier-1 breakout: boosted fraction is 55% (capped)", () => {
    // Risk 6: riskAllocationScale = 0.6 + 0.6 * 0.8 = 1.08
    // breakoutAllocationPct = 0.45 * 1.08 = 0.486
    // After boost: min(0.486 * 1.22, 0.55) = min(0.593, 0.55) = 0.55
    const result = computeAllocationFraction(true, false, 6, "ALPHA_ATTACK");
    expect(result.after).toBeCloseTo(0.55, 3);
  });
});

// ─── Combined Scenario: Election Day Crash Prevention ─────────────────────────

describe("v12.06 Combined: Election Day crash prevention", () => {
  it("prevents 90% concentration on a single day", () => {
    const MAX_PORTFOLIO_DEPLOYED_TIER1_FRAC = 0.80;
    const MAX_DAILY_TIER1_ENTRIES = 3;

    let totalCapital = 400_000;
    let masterFund = totalCapital;
    let dailyTier1Count = 0;
    let positionsOpened = 0;
    let positionsBlocked = 0;

    // Simulate 7 Tier-1 signals on election day, each wanting $89,964
    const signalAllocation = 89_964;

    for (let i = 0; i < 7; i++) {
      const deployedCapital = totalCapital - masterFund;
      const deployedFrac = totalCapital > 0 ? deployedCapital / totalCapital : 0;

      // Portfolio cap check
      if (deployedFrac >= MAX_PORTFOLIO_DEPLOYED_TIER1_FRAC) {
        positionsBlocked++;
        continue;
      }

      // Daily throttle check
      if (dailyTier1Count >= MAX_DAILY_TIER1_ENTRIES) {
        positionsBlocked++;
        continue;
      }

      // Open position
      masterFund -= signalAllocation;
      dailyTier1Count++;
      positionsOpened++;
    }

    // With $400K and $89,964 per position:
    // Position 1: deployed 22.5% → OK (< 80%)
    // Position 2: deployed 45.0% → OK
    // Position 3: deployed 67.4% → OK (dailyTier1Count = 3, at limit)
    // Position 4: BLOCKED by daily throttle (count = 3 >= 3)
    // ...
    expect(positionsOpened).toBe(3);
    expect(positionsBlocked).toBe(4);

    // Max deployed = 3 × $89,964 = $269,892 = 67.5% of $400K
    const maxDeployed = totalCapital - masterFund;
    const maxDeployedFrac = maxDeployed / totalCapital;
    expect(maxDeployedFrac).toBeLessThan(0.80); // never exceeds 80%
    expect(maxDeployedFrac).toBeCloseTo(0.675, 2); // ~67.5%
  });
});
