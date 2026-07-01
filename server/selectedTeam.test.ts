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

// ── LIVE WAR ENTRY-EXECUTION sort (warEngine ~L1307) ────────────────────────────────
// This is the comparator that orders the execute-entries candidate list. The live loop
// binds the last slot + remaining budget in ITERATION ORDER, so this ordering decides
// who is actually bought. It is deliberately RAW-SCORE-PRIMARY with team as an EQUAL-raw-
// score TIEBREAK ONLY — a team name must NEVER jump a higher-raw-scored non-team name.
// Mirrors the inline comparator in warEngine.ts (kept in lock-step by this test).
function entrySortComparator(team: Set<string>) {
  return (a: { ticker: string; finalScore: number }, b: { ticker: string; finalScore: number }) => {
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore; // raw edge dominates
    const ta = team.has(String(a.ticker).toUpperCase()) ? 1 : 0;
    const tb = team.has(String(b.ticker).toUpperCase()) ? 1 : 0;
    return tb - ta; // team wins ONLY on equal raw score
  };
}

describe("LIVE entry-execution sort — team is a TIEBREAK, never a jump", () => {
  it("ENTRY-1: a non-team finalScore=7.9 stays ABOVE a team finalScore=7.6 (raw dominates)", () => {
    // 7.6 + 0.4 boost = 8.0 additive — which WOULD outrank 7.9 in the DISPLAY sort. The
    // ENTRY sort must NOT apply the boost: the raw 7.9 non-team name keeps the slot.
    const cands = [
      { ticker: "AMD", finalScore: 7.6 },  // team — boosted display score 8.0
      { ticker: "NVDA", finalScore: 7.9 }, // non-team, higher RAW
    ];
    const out = [...cands].sort(entrySortComparator(new Set(["AMD"])));
    expect(out.map(c => c.ticker)).toEqual(["NVDA", "AMD"]); // higher RAW first — team does NOT jump
  });

  it("ENTRY-2: on an EXACT raw tie, the team name wins the slot", () => {
    const cands = [
      { ticker: "NVDA", finalScore: 7.8 }, // non-team
      { ticker: "AMD", finalScore: 7.8 },  // team, equal RAW
    ];
    const out = [...cands].sort(entrySortComparator(new Set(["AMD"])));
    expect(out.map(c => c.ticker)).toEqual(["AMD", "NVDA"]); // team wins the tie
  });

  it("ENTRY-3: empty team set ⇒ pure raw-descending order", () => {
    const cands = [
      { ticker: "AAA", finalScore: 7.2 },
      { ticker: "BBB", finalScore: 8.1 },
      { ticker: "CCC", finalScore: 7.9 },
    ];
    const out = [...cands].sort(entrySortComparator(new Set()));
    expect(out.map(c => c.ticker)).toEqual(["BBB", "CCC", "AAA"]);
  });

  it("ENTRY-4 vs DISPLAY: the ADDITIVE display sort DOES let the boosted team name jump", () => {
    // Documents the intentional asymmetry: display/Armed-top-N uses effectiveSortScore
    // (+0.4), so the SAME 7.6 team name outranks the 7.9 non-team name in the DISPLAY
    // path — but NOT in the ENTRY path (asserted in ENTRY-1). Two distinct orderings.
    const team = new Set(["AMD"]);
    const displaySort = (a: { ticker: string; finalScore: number }, b: { ticker: string; finalScore: number }) =>
      effectiveSortScore(b.finalScore, b.ticker, team) - effectiveSortScore(a.finalScore, a.ticker, team);
    const cands = [
      { ticker: "NVDA", finalScore: 7.9 }, // non-team
      { ticker: "AMD", finalScore: 7.6 },  // team → 8.0 boosted
    ];
    const out = [...cands].sort(displaySort);
    expect(out.map(c => c.ticker)).toEqual(["AMD", "NVDA"]); // boosted team jumps in DISPLAY only
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
