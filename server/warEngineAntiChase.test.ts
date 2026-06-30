/**
 * warEngineAntiChase.test.ts — BUILD-spec §9.2 Phase-0 anti-chase gate (F5).
 *
 * THE GATE: a LONG whose validated live price has run > breakLevel × 1.035 (breakLevel
 * = donchian20High × 1.005, ~3.5% past the prior-day breakout line) is a CHASED entry →
 * BLOCK. Pure subtraction — it only rejects, never sizes/widens.
 *
 * THE INERT INVARIANT (non-negotiable): with the watcher flag OFF (default), the gate is
 * NEVER consulted (antiChaseBlocks returns false for ANY price) → a would-pass Tier-4
 * entry is admitted exactly as today → byte-identical.
 *
 * antiChaseBlocks is the SINGLE source of the inline gate's decision in runWarEngineCycle,
 * so pinning it here pins the live behavior without driving the DB/IBKR-bound cycle.
 */
import { describe, it, expect } from "vitest";
import { antiChaseBlocks } from "./warEngine";

const D = 100;                // donchian20High
const LVL = D * 1.005;        // breakLevel = 100.5
const CEIL = LVL * 1.035;     // anti-chase ceiling ≈ 104.0175 (owner 2026-06-30: 2.5%→3.5%)

describe("antiChaseBlocks — Phase-0 gate (flag-gated, subtraction-only)", () => {
  it("INERT: flag OFF ⇒ NEVER blocks (byte-identical to today), even far above the ceiling", () => {
    expect(antiChaseBlocks(CEIL + 100, D, /*watcherOn*/ false)).toBe(false);
    expect(antiChaseBlocks(LVL, D, false)).toBe(false);
    expect(antiChaseBlocks(LVL * 0.5, D, false)).toBe(false);
  });

  it("flag ON: BLOCKS one tick above breakLevel × 1.035", () => {
    expect(antiChaseBlocks(CEIL + 0.01, D, true)).toBe(true);
    expect(antiChaseBlocks(LVL * 1.04, D, true)).toBe(true);   // 4% past the line = blocked
  });

  it("flag ON: ADMITS at ×1.03 (inside the 3.5% ceiling, no longer chased)", () => {
    expect(antiChaseBlocks(LVL * 1.03, D, true)).toBe(false);  // 3% past — was blocked @1.025, now admitted
  });

  it("flag ON: ADMITS exactly at the ceiling and below (boundary is inclusive-admit)", () => {
    expect(antiChaseBlocks(CEIL, D, true)).toBe(false);          // exactly at ceiling = admit
    expect(antiChaseBlocks(LVL, D, true)).toBe(false);           // at breakLevel = admit
    expect(antiChaseBlocks(LVL * 0.99, D, true)).toBe(false);    // below breakLevel = admit
  });

  it("flag ON: non-positive donchian or price ⇒ never blocks (cannot define breakLevel)", () => {
    expect(antiChaseBlocks(CEIL + 100, 0, true)).toBe(false);
    expect(antiChaseBlocks(0, D, true)).toBe(false);
    expect(antiChaseBlocks(-5, D, true)).toBe(false);
  });
});
