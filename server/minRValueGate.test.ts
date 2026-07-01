/**
 * minRValueGate.test.ts — MIN_R_PCT gate (2026-07-01 spec) pure-helper tests.
 *
 *   (i)   AAPL entry 288.35 / stop 286.71 → rPct 0.57% < 1.5% → SKIP
 *   (ii)  NSC-like r ~3.6% → PASS
 *   (iii) flag off / minRPct<=0 → no-op (skip:false)
 *   (iv)  MIN_R_VALUE_PCT constant mirrors the config default (0.015)
 *   (v)   executor gate is wired AFTER effectiveSl + covers manual (source guard)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { assertMinRValuePct } from "./minRValueGate";
import { MIN_R_VALUE_PCT, MAX_STRUCTURAL_RISK_PCT } from "./slCalculator";

describe("assertMinRValuePct — geometry floor", () => {
  it("AAPL 288.35 / 286.71 → rPct ~0.57% < 1.5% → SKIP", () => {
    const r = assertMinRValuePct({ entry: 288.35, stop: 286.71, minRPct: 0.015 });
    // |288.35 − 286.71| / 288.35 = 1.64 / 288.35 = 0.00569 (0.57%)
    expect(r.rPct).toBeCloseTo(0.00569, 4);
    expect(r.skip).toBe(true);
    expect(r.reason).toMatch(/not tradeable/);
  });

  it("the spec's headline AAPL 0.11% case (stop 288.02) → SKIP", () => {
    const r = assertMinRValuePct({ entry: 288.35, stop: 288.02, minRPct: 0.015 });
    expect(r.rPct).toBeLessThan(0.015);
    expect(r.skip).toBe(true);
  });

  it("NSC-like r ~3.6% ($11.39 on $312) → PASS", () => {
    const entry = 312, stop = 312 - 11.39;
    const r = assertMinRValuePct({ entry, stop, minRPct: 0.015 });
    expect(r.rPct).toBeGreaterThan(0.015);
    expect(r.skip).toBe(false);
  });

  it("exactly at the floor (rPct === minRPct) is NOT skipped (strict <)", () => {
    const entry = 100, stop = 98.5; // rPct = 0.015 exactly
    const r = assertMinRValuePct({ entry, stop, minRPct: 0.015 });
    expect(r.rPct).toBeCloseTo(0.015, 6);
    expect(r.skip).toBe(false);
  });

  it("short side: stop above entry, tight → SKIP", () => {
    const r = assertMinRValuePct({ entry: 100, stop: 100.5, minRPct: 0.015 });
    expect(r.rPct).toBeCloseTo(0.005, 6);
    expect(r.skip).toBe(true);
  });
});

describe("INERT — flag off / no floor", () => {
  it("minRPct = 0 → no-op (skip:false) even on a razor-thin stop", () => {
    const r = assertMinRValuePct({ entry: 288.35, stop: 288.34, minRPct: 0 });
    expect(r.skip).toBe(false);
  });
  it("minRPct < 0 → no-op", () => {
    const r = assertMinRValuePct({ entry: 288.35, stop: 288.34, minRPct: -1 });
    expect(r.skip).toBe(false);
  });
});

describe("degraded inputs fail-open (executor guards own them)", () => {
  it("non-finite / non-positive entry → skip:false", () => {
    expect(assertMinRValuePct({ entry: NaN, stop: 100, minRPct: 0.015 }).skip).toBe(false);
    expect(assertMinRValuePct({ entry: 0, stop: 100, minRPct: 0.015 }).skip).toBe(false);
    expect(assertMinRValuePct({ entry: 100, stop: NaN, minRPct: 0.015 }).skip).toBe(false);
  });
});

describe("constants", () => {
  it("MIN_R_VALUE_PCT mirrors the config default (1.5%) and sits below the RC-2 max (14%)", () => {
    expect(MIN_R_VALUE_PCT).toBe(0.015);
    expect(MIN_R_VALUE_PCT).toBeLessThan(MAX_STRUCTURAL_RISK_PCT);
  });
});

describe("SSOT wiring — executor gate covers manual (source guard)", () => {
  const execSrc = readFileSync(join(__dirname, "liveOrderExecutor.ts"), "utf8");
  const warSrc = readFileSync(join(__dirname, "warEngine.ts"), "utf8");

  it("tryLiveEntry min-R gate is AFTER effectiveSl is set + before the conid resolve", () => {
    const gateIdx = execSrc.indexOf("[MinRPct]");
    const effSlIdx = execSrc.indexOf("let effectiveSl:");
    const conidIdx = execSrc.indexOf("const conid = await resolveConid(ticker);");
    expect(gateIdx).toBeGreaterThan(effSlIdx);
    expect(gateIdx).toBeLessThan(conidIdx);
    // Gated on the flag → INERT when off.
    expect(execSrc).toMatch(/minRValuePctEnabled\s*\?\?\s*0\)\s*===\s*1/);
    // Uses the finalized broker entry/stop (covers War + manual + alert since they all
    // funnel through tryLiveEntry).
    expect(execSrc).toMatch(/assertMinRValuePct\(\{ entry: effectiveEntry, stop: effectiveSl/);
  });

  it("warEngine early-skip is flag-gated (log parity only)", () => {
    expect(warSrc).toMatch(/minRValuePctEnabled\s*\?\?\s*0\)\s*===\s*1/);
    expect(warSrc).toMatch(/assertMinRValuePct\(\{[\s\S]*?entry: currentPrice, stop: entrySlTp.stopLoss/);
  });
});
