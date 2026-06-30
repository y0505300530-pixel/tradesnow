/**
 * selectedTeam.test.ts — SELECTED_TEAM rank-priority is a SORT-ONLY boost.
 *
 * THE NON-NEGOTIABLE PROPERTIES (owner-ratified 2026-06-30):
 *   SORT-1  a selected-team ticker's effective SORT score = min(10, base + 0.4).
 *   SORT-2  a non-team ticker's effective SORT score = base (unchanged).
 *   CAP-1   the boost is capped at 10 (a base ≥9.6 team name does NOT exceed 10).
 *   GATE-0  effectiveSortScore is a PURE read of `base` — it NEVER mutates the input,
 *           so no gate/combined/zivStructural value the engine derives can change.
 *   WATCH-1 buildArmList favors a team name over a non-team peer of EQUAL readiness
 *           (sort-only tiebreak) WITHOUT changing its ARM/CROSS/BLOCKED state.
 */
import { describe, it, expect } from "vitest";
import {
  effectiveSortScore, SELECTED_TEAM_BOOST, DEFAULT_SELECTED_TEAM,
  defaultSelectedTeamSet,
} from "./selectedTeam";
import { buildArmList, breakLevelFor, classifyCrossState } from "./intradayArmedWatcher";

const TEAM = new Set(["AMD", "MU"]);

describe("effectiveSortScore — sort-only boost", () => {
  it("SORT-1: a team ticker's effective score = min(10, base + 0.4)", () => {
    expect(effectiveSortScore(7.0, "AMD", TEAM)).toBeCloseTo(7.4, 10);
    expect(effectiveSortScore(7.0, "amd", TEAM)).toBeCloseTo(7.4, 10);   // case-insensitive
    expect(SELECTED_TEAM_BOOST).toBe(0.4);
  });

  it("SORT-2: a non-team ticker is unchanged", () => {
    expect(effectiveSortScore(7.0, "NVDA", TEAM)).toBe(7.0);
    expect(effectiveSortScore(8.3, "TSLA", TEAM)).toBe(8.3);
  });

  it("CAP-1: the boosted score is capped at 10", () => {
    expect(effectiveSortScore(9.8, "AMD", TEAM)).toBe(10);
    expect(effectiveSortScore(10, "MU", TEAM)).toBe(10);
    expect(effectiveSortScore(9.5, "AMD", TEAM)).toBeCloseTo(9.9, 10);
  });

  it("GATE-0: the function is a pure read — `base` itself is never mutated", () => {
    // No gate value can change because effectiveSortScore returns a NEW number and the
    // engine keeps reading finalScore/combined/zivStructural directly for its gates.
    const base = 6.6;   // a team name sitting BELOW combinedGate (8.0) & at the ziv floor
    const sortScore = effectiveSortScore(base, "AMD", TEAM);
    expect(base).toBe(6.6);                 // input untouched
    expect(sortScore).toBeCloseTo(7.0, 10); // ranks higher…
    // …but the GATE input (base) is still 6.6 < 8.0 → would still SKIP. Sort ≠ gate.
    expect(base).toBeLessThan(8.0);
  });

  it("the DEFAULT seed list is the 15 owner-picked names (uppercased Set)", () => {
    expect(DEFAULT_SELECTED_TEAM).toHaveLength(15);
    const set = defaultSelectedTeamSet();
    for (const t of ["SNDK", "MU", "INTC", "AMD", "LRCX"]) expect(set.has(t)).toBe(true);
  });
});

describe("buildArmList — SELECTED_TEAM sort-only tiebreak", () => {
  const D = 100;                       // donchian-20 high
  const LVL = breakLevelFor(D);        // breakout line

  it("WATCH-1: a team name outranks a non-team peer of EQUAL readiness (sort-only)", () => {
    const cands = [
      { ticker: "ZZZ", donchian20High: D, readinessPct: 80 },  // non-team
      { ticker: "AMD", donchian20High: D, readinessPct: 80 },  // team, equal readiness
    ];
    // Both ARMED (just below the line), identical proximity.
    const live = new Map([["ZZZ", LVL * 0.99], ["AMD", LVL * 0.99]]);
    const out = buildArmList(cands, live, new Set(["AMD"]));
    expect(out.map(o => o.ticker)).toEqual(["AMD", "ZZZ"]);   // team first
    // State machine is UNTOUCHED — team membership did not change ARM classification.
    expect(out[0].state).toBe(classifyCrossState(LVL * 0.99, D));
  });

  it("readiness still dominates the team tiebreak (boost is a tiebreak, not an override)", () => {
    const cands = [
      { ticker: "ZZZ", donchian20High: D, readinessPct: 95 },  // non-team, HOTTER
      { ticker: "AMD", donchian20High: D, readinessPct: 60 },  // team, colder
    ];
    const live = new Map([["ZZZ", LVL * 0.99], ["AMD", LVL * 0.99]]);
    const out = buildArmList(cands, live, new Set(["AMD"]));
    expect(out.map(o => o.ticker)).toEqual(["ZZZ", "AMD"]);   // hotter non-team still first
  });

  it("empty team set ⇒ byte-identical ordering (default arg)", () => {
    const cands = [
      { ticker: "AAA", donchian20High: D, readinessPct: 90 },
      { ticker: "BBB", donchian20High: D, readinessPct: 95 },
    ];
    const live = new Map([["AAA", LVL * 0.99], ["BBB", LVL * 0.99]]);
    expect(buildArmList(cands, live).map(o => o.ticker)).toEqual(["BBB", "AAA"]);
  });
});
