import { describe, it, expect } from "vitest";
import { isTransientBlock, shouldDeferEnqueue, drainDecision } from "./warRaceDefer";

describe("isTransientBlock", () => {
  it.each(["busy", "cooldown", "manual_cooldown"])("transient %s → true", (r) =>
    expect(isTransientBlock(r)).toBe(true));
  it.each(["daily_loss_limit_hit", "breaker_check_failed", "regime_off", "BULL_TREND", ""])(
    "terminal %s → false", (r) => expect(isTransientBlock(r)).toBe(false));
});

describe("shouldDeferEnqueue — INERT + transient-only", () => {
  it("flag OFF → never enqueue (byte-identical to today)", () =>
    expect(shouldDeferEnqueue(false, 0, "busy")).toBe(false));
  it("flag ON + transient block + entered=0 → enqueue", () =>
    expect(shouldDeferEnqueue(true, 0, "manual_cooldown")).toBe(true));
  it("flag ON + entered>=1 → NOT enqueued (already in)", () =>
    expect(shouldDeferEnqueue(true, 1, "busy")).toBe(false));
  it("flag ON + terminal decline → NOT enqueued (respect the gate)", () =>
    expect(shouldDeferEnqueue(true, 0, "regime_off")).toBe(false));
});

describe("drainDecision", () => {
  const T = 120_000;
  it("entered>=1 → success (drop, done)", () =>
    expect(drainDecision(1_000, 500, T, 1, "busy")).toBe("success"));
  it("past TTL, no entry → expire (no stale entry)", () =>
    expect(drainDecision(1_000_000, 1_000_000 - T - 1, T, 0, "busy")).toBe("expire"));
  it("within TTL, still transient → keep (retry next tick)", () =>
    expect(drainDecision(1_000, 500, T, 0, "cooldown")).toBe("keep"));
  it("within TTL, terminal decline → terminal (cycle declined — stop retrying)", () =>
    expect(drainDecision(1_000, 500, T, 0, "daily_loss_limit_hit")).toBe("terminal"));
  it("entered wins over a would-be-terminal regime string", () =>
    expect(drainDecision(1_000, 500, T, 2, "BULL_TREND")).toBe("success"));
});
