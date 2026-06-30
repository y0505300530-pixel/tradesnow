/**
 * waiterEngine.test.ts — THE WAITER (retest resting-LMT) BUILD tests (spec §7).
 *
 * Driven against the PURE/injectable SSOT helpers (no live broker/DB) + source-regex
 * INERT assertions. Covers the safety core:
 *   • flag=0 ⇒ byte-identical (the inert early-return is the FIRST statement)
 *   • §4 slot-guard never exceeds free slots
 *   • §3 30%-sub-cap never exceeded
 *   • §5 falling-knife cancel
 *   • R1 no double-fill (Waiter + War same ticker) — waiterHoldsRetest
 *   • R2 re-quote on EMA drift (anti-chase: never re-quote up past live)
 *   • parity: ambush/size reuse wideLungSL + vixRiskSize (1%-risk, unchanged)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  isWaiterEnabled,
  computeAmbushLimit,
  isNearRetestZone,
  freeRetestSlots,
  retestSleeveUsed,
  subCapAllows,
  shouldRequote,
  shouldCancelRest,
  waiterHoldsRetest,
  RETEST_AMBUSH_MULT,
  RETEST_TOP_N,
  REQUOTE_DRIFT,
} from "./waiterEngine";
import { wideLungSL, vixRiskSize } from "./engine/elzaV45Master";

// ── (0) INERT INVARIANT — flag default OFF + early-return is byte-identical ─────────
describe("Waiter INERT invariant (flag=0 ⇒ byte-identical)", () => {
  it("isWaiterEnabled defaults OFF (undefined / null / 0 config)", () => {
    expect(isWaiterEnabled(null)).toBe(false);
    expect(isWaiterEnabled(undefined)).toBe(false);
    expect(isWaiterEnabled({} as any)).toBe(false);
    expect(isWaiterEnabled({ waiterEnabled: 0 } as any)).toBe(false);
    expect(isWaiterEnabled({ waiterEnabled: 1 } as any)).toBe(true);
  });

  it("runWaiterTick reads the flag FIRST — early-return before any work", () => {
    const src = readFileSync(join(__dirname, "waiterEngine.ts"), "utf8");
    // The inert early-return must precede the reentrancy latch / DB / fetch.
    const fn = src.slice(src.indexOf("export async function runWaiterTick"));
    const guardIdx = fn.indexOf("if (!isWaiterEnabled(config)) return");
    const dbIdx = fn.indexOf("getDb()");
    const tickRunIdx = fn.indexOf("_waiterTickRunning = true");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(dbIdx);
    expect(guardIdx).toBeLessThan(tickRunIdx);
  });

  it("reconcileWaiterPositions (ibkrSync hook) is INERT at flag=0", async () => {
    const { reconcileWaiterPositions } = await import("./waiterEngine");
    const res = await reconcileWaiterPositions(1, new Map([["AAPL", 100]]), {
      config: { waiterEnabled: 0 } as any,
    });
    expect(res).toEqual({ filled: 0, flattened: 0 });
  });

  it("alertPoller Waiter tick + ibkrSync reconcile + warEngine R1 are flag-gated in source", () => {
    const poller = readFileSync(join(__dirname, "alertPoller.ts"), "utf8");
    expect(poller).toContain("runWaiterTick");
    expect(poller).toContain("INERT until waiterEnabled=1");
    const sync = readFileSync(join(__dirname, "ibkrSync.ts"), "utf8");
    expect(sync).toContain("reconcileWaiterPositions");
    const war = readFileSync(join(__dirname, "warEngine.ts"), "utf8");
    expect(war).toContain("waiterEnabled === 1");
    expect(war).toContain("waiterHoldsRetest");
  });
});

// ── (1) §2 ambush level + zone (anti-chase, penny guard, uptrend) ──────────────────
describe("Waiter §2 ambush level + zone", () => {
  it("ambush = EMA20 × 1.005, must be BELOW live price (a pullback, not a chase)", () => {
    expect(RETEST_AMBUSH_MULT).toBe(1.005);
    // live above EMA20 → ambush sits below live = valid
    const r = computeAmbushLimit(100, 103);
    expect(r.limit).toBeCloseTo(100.5, 2);
  });

  it("REJECTS an ambush at/above the live price (anti-chase)", () => {
    // EMA20=100 → ambush 100.5; live 100.2 → ambush ≥ live → reject
    expect(computeAmbushLimit(100, 100.2).limit).toBe(0);
  });

  it("REJECTS a sub-$2 ambush (penny guard) and bad EMA", () => {
    expect(computeAmbushLimit(1.5, 10).limit).toBe(0);
    expect(computeAmbushLimit(0, 100).limit).toBe(0);
    expect(computeAmbushLimit(NaN, 100).limit).toBe(0);
  });

  it("zone requires price > EMA20 > and price > EMA50 (uptrend), within band", () => {
    expect(isNearRetestZone({ livePrice: 102, ema20: 100, ema50: 95 }).near).toBe(true);
    // below EMA50 → uptrend invalid
    expect(isNearRetestZone({ livePrice: 94, ema20: 100, ema50: 95 }).near).toBe(false);
    // below EMA20 (not approaching from above)
    expect(isNearRetestZone({ livePrice: 99, ema20: 100, ema50: 95 }).near).toBe(false);
    // too far above EMA20 (>8%)
    expect(isNearRetestZone({ livePrice: 110, ema20: 100, ema50: 95 }).near).toBe(false);
  });
});

// ── (2) §4 slot-guard never exceeds free slots ────────────────────────────────────
describe("Waiter §4 slot-guard", () => {
  const W = (status: string) => ({ isWaiterEntry: 1, status });
  it("free = max − (open retests + resting retest LMTs); never negative", () => {
    const rows = [W("open"), W("pending_entry"), W("pending_entry")];
    expect(freeRetestSlots(rows, 8)).toBe(5);     // 8 − 3 used
    expect(freeRetestSlots(rows, 2)).toBe(0);     // 2 − 3 → clamp 0 (never broadcast > free)
    expect(freeRetestSlots(rows, 3)).toBe(0);
  });
  it("non-Waiter rows + closed rows do NOT consume a retest slot", () => {
    const rows = [
      { isWaiterEntry: 1, status: "open" },
      { isWaiterEntry: 0, status: "open" },         // a normal war position
      { isWaiterEntry: 1, status: "closed" },       // a cancelled/filled-out resting LMT
    ];
    expect(freeRetestSlots(rows, 8)).toBe(7);       // only the 1 open Waiter counts
  });
});

// ── (3) §3 30% sub-cap never exceeded ─────────────────────────────────────────────
describe("Waiter §3 30% sub-cap", () => {
  it("blocks when sleeveUsed + thisOrder > pct × NLV", () => {
    const nlv = 100_000, pct = 0.30; // cap = $30k
    expect(subCapAllows({ sleeveUsed: 25_000, thisOrderNotional: 4_000, nlv, waiterNlvPct: pct }).allowed).toBe(true);  // 29k ≤ 30k
    expect(subCapAllows({ sleeveUsed: 28_000, thisOrderNotional: 4_000, nlv, waiterNlvPct: pct }).allowed).toBe(false); // 32k > 30k
  });
  it("fail-closed on bad NLV/pct (no entry)", () => {
    expect(subCapAllows({ sleeveUsed: 0, thisOrderNotional: 1000, nlv: 0, waiterNlvPct: 0.30 }).allowed).toBe(false);
    expect(subCapAllows({ sleeveUsed: 0, thisOrderNotional: 1000, nlv: 100_000, waiterNlvPct: 0 }).allowed).toBe(false);
  });
  it("retestSleeveUsed sums committed notional of open + resting Waiter rows only", () => {
    const rows = [
      { isWaiterEntry: 1, status: "pending_entry", allocatedCapital: 5000 },
      { isWaiterEntry: 1, status: "open", allocatedCapital: 7000 },
      { isWaiterEntry: 0, status: "open", allocatedCapital: 99999 },   // not Waiter — excluded
      { isWaiterEntry: 1, status: "closed", allocatedCapital: 4000 },  // closed — excluded
    ];
    expect(retestSleeveUsed(rows)).toBe(12_000);
  });
});

// ── (4) §5 falling-knife / setup-invalidation cancel ──────────────────────────────
describe("Waiter §5 falling-knife / invalidation", () => {
  const base = { ticker: "X", structStop: 95, livePrice: 101, ema50: 96, stillOnRetestList: true };
  it("KNIFE: a 5m close below the structural stop cancels", () => {
    const r = shouldCancelRest({ ...base, last5mClose: 94.5 });
    expect(r.cancel).toBe(true);
    expect(r.reason).toContain("KNIFE");
  });
  it("INVALIDATED: dropped off the top-N retest list cancels", () => {
    const r = shouldCancelRest({ ...base, last5mClose: 100, stillOnRetestList: false });
    expect(r.cancel).toBe(true);
    expect(r.reason).toContain("INVALIDATED");
  });
  it("INVALIDATED: price < EMA50 (uptrend dead) cancels", () => {
    const r = shouldCancelRest({ ...base, last5mClose: 100, livePrice: 95.5 });
    expect(r.cancel).toBe(true);
  });
  it("HOLDS when setup intact (5m close above stop, on list, above EMA50)", () => {
    expect(shouldCancelRest({ ...base, last5mClose: 100 }).cancel).toBe(false);
  });
});

// ── (5) R1 no double-fill (Waiter + War same ticker) ──────────────────────────────
describe("Waiter R1 mutual-exclusion (waiterHoldsRetest)", () => {
  it("true when a Waiter pending_entry / open LMT exists for the ticker", () => {
    const rows = [{ ticker: "NVDA", isWaiterEntry: 1, status: "pending_entry" }];
    expect(waiterHoldsRetest("NVDA", rows)).toBe(true);
    expect(waiterHoldsRetest("nvda", rows)).toBe(true);   // case-insensitive
  });
  it("false for a non-Waiter row, a closed Waiter row, or a different ticker", () => {
    expect(waiterHoldsRetest("NVDA", [{ ticker: "NVDA", isWaiterEntry: 0, status: "open" }])).toBe(false);
    expect(waiterHoldsRetest("NVDA", [{ ticker: "NVDA", isWaiterEntry: 1, status: "closed" }])).toBe(false);
    expect(waiterHoldsRetest("NVDA", [{ ticker: "AMD", isWaiterEntry: 1, status: "pending_entry" }])).toBe(false);
  });
});

// ── (5b) R4 — never-naked is a REAL flatten (not a deferred CRON park) ─────────────
describe("Waiter R4 real-flatten (fail-closed) on unverified STP", () => {
  const waiterSrc = readFileSync(join(__dirname, "waiterEngine.ts"), "utf8");
  // Isolate the reconcileWaiterPositions body so the assertions are scoped to R4.
  const recFn = waiterSrc.slice(waiterSrc.indexOf("export async function reconcileWaiterPositions"));
  const nakedBranch = recFn.slice(recFn.indexOf("[WAITER_NAKED]"), recFn.indexOf("[WAITER_NAKED]") + 2200);

  it("transmits a REAL flatten via executeLiveSell with WAITER_NAKED_FLATTEN reason", () => {
    // The validated never-naked exit path is reused — not a stage mutation that defers to a cron.
    expect(waiterSrc).toContain("executeLiveSell");
    expect(nakedBranch).toContain("executeLiveSell({ userId, positionId: row.id, reason: \"WAITER_NAKED_FLATTEN\" })");
  });

  it("the flatten transmit is wrapped (never-throw) — a transmit failure cannot crash reconcile", () => {
    // executeLiveSell is awaited inside a try/catch so a gateway flake degrades to the CRON backstop.
    expect(nakedBranch).toContain("try {");
    expect(nakedBranch).toContain("catch (sellErr)");
  });

  it("on transmit FAILURE keeps the loud alert + arms the software-SL CRON backstop", () => {
    // Fail-closed degradation: row stays open + slProtection=software so the enforcement cron retries.
    expect(nakedBranch).toContain("flatten transmit FAILED");
    expect(nakedBranch).toContain("slProtection: \"software\"");
  });

  it("INERT — the naked branch is unreachable at waiterEnabled=0 (isWaiterEnabled guard precedes it)", () => {
    const guardIdx = recFn.indexOf("if (!isWaiterEnabled(config)) return summary");
    const nakedIdx = recFn.indexOf("[WAITER_NAKED]");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(nakedIdx);
  });
});

// ── (5c) R1 — cross-pipeline lock serialization (War retest under the shared lock) ──
describe("Waiter R1 cross-pipeline lock (War retest serialized with Waiter insert)", () => {
  const warSrc = readFileSync(join(__dirname, "warEngine.ts"), "utf8");

  it("War imports the SAME shared entrySlotLock API the Waiter uses", () => {
    expect(warSrc).toContain('from "./entrySlotLock"');
    expect(warSrc).toContain("tryAcquireEntrySlot");
    expect(warSrc).toContain("releaseEntrySlot");
  });

  it("acquires war:<ticker> on the shared lock BEFORE reading waiterHoldsRetest", () => {
    const r1 = warSrc.slice(warSrc.indexOf("R1 cross-pipeline lock"));
    const acqIdx = r1.indexOf("tryAcquireEntrySlot(_warLockHolder)");
    const readIdx = r1.indexOf("waiterHoldsRetest(c.ticker");
    expect(acqIdx).toBeGreaterThan(-1);
    expect(readIdx).toBeGreaterThan(-1);
    // The lock acquire must precede the dup-check read (closes the TOCTOU window).
    expect(acqIdx).toBeLessThan(readIdx);
    expect(warSrc).toContain("`war:${String(c.ticker).toUpperCase()}`");
  });

  it("releases the lock on EVERY iteration exit via a per-candidate finally (no leak)", () => {
    expect(warSrc).toContain("} finally {");
    expect(warSrc).toContain("if (_waiterLockHeld) releaseEntrySlot(_warLockHolder)");
  });

  it("INERT — the whole lock block is gated on waiterEnabled===1 (byte-identical at flag=0)", () => {
    // The acquire lives inside the `waiterEnabled === 1 && long && finalScore<9` guard.
    const guardIdx = warSrc.indexOf("(warLiveConfig as any)?.waiterEnabled === 1 && c.direction === \"long\" && c.finalScore < 9");
    const acqIdx = warSrc.indexOf("tryAcquireEntrySlot(_warLockHolder)");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(acqIdx);
  });
});

// ── (6) R2 re-quote on EMA drift (anti-chase) ─────────────────────────────────────
describe("Waiter R2 re-quote on EMA drift", () => {
  it("no re-quote when drift ≤ 0.5%", () => {
    expect(REQUOTE_DRIFT).toBe(0.005);
    // resting 100, fresh 100.3 (0.3% drift) → hold
    expect(shouldRequote({ restingLimit: 100, freshLimit: 100.3, livePrice: 105 }).requote).toBe(false);
  });
  it("re-quote DOWN when drift > 0.5% (the level fell)", () => {
    expect(shouldRequote({ restingLimit: 100, freshLimit: 99.0, livePrice: 105 }).requote).toBe(true);
  });
  it("ANTI-CHASE: never re-quote UP past the live price", () => {
    // fresh 104 has drifted up >0.5% but ≥ live 103.5 → must NOT chase up
    expect(shouldRequote({ restingLimit: 100, freshLimit: 104, livePrice: 103.5 }).requote).toBe(false);
  });
});

// ── (7) PARITY — sizing reuses vixRiskSize (1%-risk) + wideLungSL (unchanged) ──────
describe("Waiter parity (risk stays 1%, stop stays wideLungSL)", () => {
  it("ambush + wideLungSL + vixRiskSize compose to a 1%-risk floored qty", () => {
    const ema20 = 100, ema50 = 98, nlv = 100_000, vix = 18;
    const ambush = computeAmbushLimit(ema20, 103);          // 100.5
    expect(ambush.limit).toBeCloseTo(100.5, 2);
    const stop = wideLungSL(ambush.limit, ema50, "long");   // SAME stop math as Elza
    const sized = vixRiskSize({ nlv, entry: ambush.limit, stop, vix });
    expect(sized.skip).toBe(false);
    // riskDollars = NLV × 0.01 × vixMult(1.0 @ vix≤25) = $1,000; qty = floor(1000 / perShareRisk)
    expect(sized.riskDollars).toBeCloseTo(1000, 2);
    expect(sized.shares).toBe(Math.floor(1000 / sized.perShareRisk));
  });
  it("RETEST_TOP_N is 10 (the 10/10 split)", () => {
    expect(RETEST_TOP_N).toBe(10);
  });
});
