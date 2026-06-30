/**
 * intradayArmedWatcher.test.ts — BUILD-spec §9 inert + fail-closed invariants (F3).
 *
 * THE NON-NEGOTIABLE PROPERTIES:
 *   INERT-1  flag=0 ⇒ runArmedWatcherTick returns BEFORE any quote/bars fetch and writes
 *            NO state (watcherStatus map stays empty) → runtime byte-identical to today.
 *   FAILCLOSED-1  a CROSSED candidate with missing/empty 5m bars NEVER promotes/enters
 *                 (no runWarEngineCycle trigger) — it stays CROSSED for the next tick.
 *   PURE-*   the state classifier, RVOL, 5m-hold confirm and ARM-list builders are pure
 *            and match the design Appendix constants (breakLevel ×1.005, anti-chase ×1.035,
 *            RVOL≥1.2, 4% arm proximity). (owner 2026-06-30: chase 2.5%→3.5%, RVOL 1.5→1.2, arm 1%→4%)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks: the watcher's only IO collaborators ───────────────────────────────────
const getLiveConfigMock = vi.fn(async (_uid: number) => ({ elzaIntradayWatcherEnabled: 0 } as any));
const fetchQuotesMock = vi.fn(async (_tk: string[]) => new Map<string, any>());
const fetchIntradayMock = vi.fn(async (..._a: any[]) => [] as any[]);
const runWarCycleMock = vi.fn(async (..._a: any[]) => ({ entered: 0, scanned: 0 } as any));
const getDbMock = vi.fn(async () => null as any);

vi.mock("./liveOrderExecutor", async () => {
  const actual = await vi.importActual<any>("./liveOrderExecutor").catch(() => ({}));
  return {
    ...actual,
    getLiveConfig: (...a: any[]) => getLiveConfigMock(a[0]),
    // Use the REAL flag-reader shape so the inert contract is genuinely exercised.
    isIntradayWatcherEnabled: (c: any) => ((c?.elzaIntradayWatcherEnabled ?? 0) === 1),
  };
});
vi.mock("./marketData", () => ({
  fetchIbkrLivePricesBatch: (...a: any[]) => fetchQuotesMock(a[0]),
}));
vi.mock("./intradayMarketData", () => ({
  fetchIntradayBarsForTicker: (...a: any[]) => fetchIntradayMock(...a),
  // Real session filter (pure) so is5mHoldConfirmed behaves authentically.
  filterRegularSession: (bars: any[]) => bars.filter((b: any) => {
    const [h, m] = String(b.time).split(":").map(Number);
    const mins = h * 60 + m;
    return mins >= 9 * 60 + 30 && mins <= 16 * 60;
  }),
}));
vi.mock("./db", () => ({ getDb: (...a: any[]) => getDbMock() }));
vi.mock("./persistentLogger", () => ({ dbLog: vi.fn() }));
vi.mock("./warEngine", () => ({ runWarEngineCycle: (...a: any[]) => runWarCycleMock(...a) }));

import {
  classifyCrossState, breakLevelFor, computeIntradayRvol, is5mHoldConfirmed,
  buildArmList, getWatcherStatusMap, runArmedWatcherTick,
  BREAK_MULT, ANTI_CHASE_MULT, ARM_PROXIMITY, INTRADAY_RVOL_MIN,
} from "./intradayArmedWatcher";

const D = 100;                 // donchian20High
const LVL = D * BREAK_MULT;    // breakLevel = 100.5

// 5m bar helper (regular-session ET).
function bar(date: string, time: string, close: number, volume: number) {
  return { date, time, datetime: `${date}T${time}:00`, ts: 0, open: close, high: close, low: close, close, volume };
}

describe("classifyCrossState — pure state machine (design §7 constants)", () => {
  it("BLOCKED above the anti-chase ceiling (breakLevel × 1.025)", () => {
    expect(classifyCrossState(LVL * ANTI_CHASE_MULT + 0.01, D)).toBe("BLOCKED");
  });
  it("CROSSED at/above breakLevel but within the chase ceiling", () => {
    expect(classifyCrossState(LVL, D)).toBe("CROSSED");
    expect(classifyCrossState(LVL * ANTI_CHASE_MULT, D)).toBe("CROSSED"); // exactly at ceiling = admit
  });
  it("ARMED within ARM_PROXIMITY (4%) below breakLevel", () => {
    expect(classifyCrossState(LVL * 0.995, D)).toBe("ARMED");                 // 0.5% below = armed
    expect(classifyCrossState(LVL * (1 - ARM_PROXIMITY) + 0.01, D)).toBe("ARMED"); // just inside 4% = armed
  });
  it("null when not yet armed (outside ARM_PROXIMITY), or donchian non-positive", () => {
    expect(classifyCrossState(LVL * (1 - ARM_PROXIMITY) - 0.01, D)).toBeNull(); // just outside 4% = null
    expect(classifyCrossState(LVL, 0)).toBeNull();
    expect(classifyCrossState(0, D)).toBeNull();
  });
  it("breakLevelFor = donchian × 1.005 (0 when non-positive)", () => {
    expect(breakLevelFor(D)).toBeCloseTo(LVL, 6);
    expect(breakLevelFor(0)).toBe(0);
  });
});

describe("computeIntradayRvol — pure, deterministic", () => {
  it("today cumulative / median(prior same-time cumulative)", () => {
    const bars = [
      bar("2026-06-25", "09:30", 100, 100), bar("2026-06-25", "09:35", 100, 100), // prior: 200
      bar("2026-06-26", "09:30", 100, 200), bar("2026-06-26", "09:35", 100, 200), // prior: 400
      bar("2026-06-29", "09:30", 100, 300), bar("2026-06-29", "09:35", 100, 300), // today: 600
    ];
    // median(prior cum @ ≤09:35) = median(200,400) = 300; today=600 → rvol=2.0
    expect(computeIntradayRvol(bars)).toBeCloseTo(2.0, 6);
  });
  it("null without ≥1 prior session (fail-closed input)", () => {
    expect(computeIntradayRvol([bar("2026-06-29", "09:30", 100, 300)])).toBeNull();
    expect(computeIntradayRvol([])).toBeNull();
  });
});

describe("is5mHoldConfirmed — HOLD_CONFIRM (5m close ≥ level & RVOL ≥ 1.2)", () => {
  const baseline = [
    bar("2026-06-25", "09:30", 100, 100),
    bar("2026-06-26", "09:30", 100, 100),
  ];
  it("confirmed when last 5m close ≥ level AND rvol ≥ min", () => {
    const bars = [...baseline, bar("2026-06-29", "09:30", LVL + 0.1, 1000)];
    const r = is5mHoldConfirmed(bars, LVL);
    expect(r.confirmed).toBe(true);
  });
  it("FAIL-CLOSED: last close below level → not confirmed", () => {
    const bars = [...baseline, bar("2026-06-29", "09:30", LVL - 0.5, 1000)];
    expect(is5mHoldConfirmed(bars, LVL).confirmed).toBe(false);
  });
  it("FAIL-CLOSED: rvol below min → not confirmed", () => {
    const bars = [...baseline, bar("2026-06-29", "09:30", LVL + 0.1, 100)]; // rvol = 1.0
    const r = is5mHoldConfirmed(bars, LVL);
    expect(r.confirmed).toBe(false);
    expect(INTRADAY_RVOL_MIN).toBe(1.2);
  });
  it("FAIL-CLOSED: no bars / no breakLevel → not confirmed", () => {
    expect(is5mHoldConfirmed([], LVL).confirmed).toBe(false);
    expect(is5mHoldConfirmed(baseline, 0).confirmed).toBe(false);
  });
});

describe("buildArmList — imminence ranking, BLOCKED surfaced", () => {
  it("ranks by readiness desc then proximity; drops not-armed names", () => {
    const cands = [
      { ticker: "AAA", donchian20High: D, readinessPct: 90 },  // armed
      { ticker: "BBB", donchian20High: D, readinessPct: 95 },  // crossed
      { ticker: "CCC", donchian20High: D, readinessPct: 50 },  // far below → dropped
    ];
    const live = new Map([["AAA", LVL * 0.997], ["BBB", LVL + 0.05], ["CCC", LVL * 0.90]]);
    const out = buildArmList(cands, live);
    expect(out.map(o => o.ticker)).toEqual(["BBB", "AAA"]);
    expect(out[0].state).toBe("CROSSED");
    expect(out[1].state).toBe("ARMED");
  });
});

describe("runArmedWatcherTick — INERT + FAIL-CLOSED orchestration", () => {
  beforeEach(() => {
    getLiveConfigMock.mockReset();
    fetchQuotesMock.mockReset();
    fetchIntradayMock.mockReset();
    runWarCycleMock.mockReset();
    getDbMock.mockReset();
    fetchQuotesMock.mockResolvedValue(new Map());
    fetchIntradayMock.mockResolvedValue([]);
    runWarCycleMock.mockResolvedValue({ entered: 0, scanned: 0 });
    getDbMock.mockResolvedValue(null);
  });

  it("INERT-1: flag=0 ⇒ returns before ANY fetch + writes no state", async () => {
    getLiveConfigMock.mockResolvedValue({ elzaIntradayWatcherEnabled: 0 } as any);
    await runArmedWatcherTick(1);
    expect(fetchQuotesMock).not.toHaveBeenCalled();      // no quote read
    expect(fetchIntradayMock).not.toHaveBeenCalled();    // no bars fetch
    expect(getDbMock).not.toHaveBeenCalled();            // no DB read
    expect(runWarCycleMock).not.toHaveBeenCalled();      // no entry trigger
    expect(getWatcherStatusMap().size).toBe(0);          // no state mutation
  });

  it("FAILCLOSED-1: flag=1, CROSSED candidate, empty 5m bars ⇒ never enters", async () => {
    getLiveConfigMock.mockResolvedValue({ elzaIntradayWatcherEnabled: 1 } as any);
    // Persisted candidate above breakLevel (CROSSED).
    getDbMock.mockResolvedValue({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{
        value: JSON.stringify({ ts: Date.now(), items: [
          { ticker: "ZZZ", direction: "long", donchian20High: D, readinessPct: 99 },
        ] }),
      }] }) }) }),
    } as any);
    fetchQuotesMock.mockResolvedValue(new Map([["ZZZ", { price: LVL + 0.1, source: "ibkr" }]]));
    fetchIntradayMock.mockResolvedValue([]);   // 503/empty → fail-closed

    await runArmedWatcherTick(1);

    expect(runWarCycleMock).not.toHaveBeenCalled();      // NEVER promoted/entered on missing data
    expect(getWatcherStatusMap().get("ZZZ")).toBe("CROSSED"); // stays CROSSED for next tick
  });
});
