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
  computeRetestStop,
  isNearRetestZone,
  freeRetestSlots,
  retestSleeveUsed,
  subCapAllows,
  capSharesToMaxPosition,
  shouldRequote,
  shouldCancelRest,
  waiterHoldsRetest,
  classifyVerifyReason,
  confirmStpAbsentForFlatten,
  reconcileWaiterPositions,
  RETEST_AMBUSH_ABOVE_PCT,
  RETEST_STOP_BELOW_PCT,
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
    expect(res).toEqual({ filled: 0, flattened: 0, unknown: 0 });
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

// ── (1) §2 ambush level — the SSOT evaluateRetestV2.limitPrice (FOMO-aligned anti-chase) ──
//    computeAmbushLimit(limitPrice, structLevel, livePrice): consumes the THREADED
//    evaluateRetestV2.limitPrice (level×1.0075, FOMO-capped); applies penny + pullback +
//    FOMO-cap guards. NO ×1.02 re-derivation. The §2-old +2% assertions are dropped.
describe("Waiter §2 ambush level (evaluateRetestV2.limitPrice SSOT)", () => {
  it("LMT = the threaded limitPrice (level×1.0075), placed when live > LMT AND live ≤ level×1.015", () => {
    expect(RETEST_AMBUSH_ABOVE_PCT).toBe(0.0075);     // aligned to LIMIT_ABOVE_PCT/100
    // structural level 100 → limitPrice 100.75 (level×1.0075). live 101 → above LMT (pullback)
    // AND ≤ FOMO cap 101.50 → valid. LMT = the threaded limitPrice exactly (no re-derive).
    const r = computeAmbushLimit(100.75, 100, 101);
    expect(r.limit).toBeCloseTo(100.75, 2);
  });

  it("REJECTS a null/absent limitPrice or structLevel — NO EMA20 fallback (caller skips)", () => {
    expect(computeAmbushLimit(null, 100, 101).limit).toBe(0);
    expect(computeAmbushLimit(undefined, 100, 101).limit).toBe(0);
    expect(computeAmbushLimit(0, 100, 101).limit).toBe(0);
    expect(computeAmbushLimit(100.75, null, 101).limit).toBe(0);
    expect(computeAmbushLimit(100.75, 0, 101).limit).toBe(0);
  });

  it("REJECTS a LMT at/above the live price (anti-chase floor — price not yet pulled back)", () => {
    // limitPrice 100.75; live 100.5 → LMT ≥ live → reject (not a pullback yet)
    expect(computeAmbushLimit(100.75, 100, 100.5).limit).toBe(0);
  });

  it("REJECTS when live > level × 1.015 (FOMO anti-chase ceiling — too extended)", () => {
    // structural level 100 → FOMO cap 101.50; live 102 > cap → reject (chasing an extended move)
    expect(computeAmbushLimit(100.75, 100, 102).limit).toBe(0);
  });

  it("REJECTS a sub-$2 LMT (penny guard)", () => {
    expect(computeAmbushLimit(1.5, 1.49, 1.8).limit).toBe(0);
  });

  it("zone requires price > retestLevel AND price > EMA50 (uptrend), within band", () => {
    expect(isNearRetestZone({ livePrice: 102, retestLevel: 100, ema50: 95 }).near).toBe(true);
    // below EMA50 → uptrend invalid
    expect(isNearRetestZone({ livePrice: 94, retestLevel: 100, ema50: 95 }).near).toBe(false);
    // below the retest support (broke through, not approaching from above)
    expect(isNearRetestZone({ livePrice: 99, retestLevel: 100, ema50: 95 }).near).toBe(false);
    // too far above support (>8%)
    expect(isNearRetestZone({ livePrice: 110, retestLevel: 100, ema50: 95 }).near).toBe(false);
    // null retestLevel → fail-closed
    expect(isNearRetestZone({ livePrice: 102, retestLevel: null, ema50: 95 }).near).toBe(false);
  });
});

// ── (1b) §2 structural retest stop (just below support, bounded by wideLungSL) ─────
describe("Waiter §2 structural retest stop", () => {
  it("anchors stop at retestLevel × (1 − 1%) when that is TIGHTER than wideLungSL", () => {
    expect(RETEST_STOP_BELOW_PCT).toBe(0.01);
    // retest support 100 → struct stop 99.0. entry 100.25, ema50 90 →
    // wideLungSL = max(100.25×0.92=92.23, 90×0.99=89.1) = 92.23. struct 99 > 92.23 → take struct.
    const r = computeRetestStop({ retestLevel: 100, entry: 100.25, ema50: 90 });
    expect(r.stop).toBeCloseTo(99.0, 2);
  });
  it("falls back to the wideLungSL floor when the structural stop would be far below entry", () => {
    // retest support 100 → struct 99.0; but ema50 99.5 → wideLungSL = max(entry×0.92, 99.5×0.99=98.5)
    // entry 100.25 → 92.23 vs 98.5 → 98.5; struct 99 > 98.5 → still struct (tighter). Use a case
    // where wideLungSL is HIGHER (tighter): ema50 100.2 → lung = max(92.23, 100.2×0.99=99.2)=99.2 > struct 99.
    const r = computeRetestStop({ retestLevel: 100, entry: 100.25, ema50: 100.2 });
    expect(r.stop).toBeCloseTo(99.2, 1);
  });
  it("fail-closed on null retestLevel or a stop that would be ≥ entry", () => {
    expect(computeRetestStop({ retestLevel: null, entry: 100, ema50: 95 }).stop).toBe(0);
    // retestLevel above entry → struct stop ≈ entry → invalid
    expect(computeRetestStop({ retestLevel: 200, entry: 100, ema50: 95 }).stop).toBe(0);
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

// ── (3b) §3b per-ticker maxPositionUsd cap (the PANW $142k concentration BLOCKER) ───
//    The Waiter transmits via placeRestingBracket (NOT tryLiveEntry) so the executor's
//    cap never applied. capSharesToMaxPosition mirrors liveOrderExecutor.ts:1337-1359 on
//    the qty ACTUALLY transmitted. The cappedShares feed BOTH the DB insert AND the bracket.
describe("Waiter §3b per-ticker maxPositionUsd cap (concentration BLOCKER)", () => {
  it("CLAMP: a tight-stop retest at high NLV where sized.shares breaches the cap ⇒ notional ≤ maxPositionUsd", () => {
    // Reproduce the bug window: high NLV + tight retest stop (perShareRisk ≈ 1.7%).
    // entry = evaluateRetestV2.limitPrice = level × 1.0075, structStop = level × 0.99.
    const retestLevel = 100, nlv = 200_000, vix = 18;
    // SSOT limitPrice for level 100 = 100.75; live 101 → above LMT, ≤ FOMO cap 101.5.
    const entry = computeAmbushLimit(100.75, retestLevel, 101).limit;     // 100.75
    const stop = computeRetestStop({ retestLevel, entry, ema50: 95 }).stop; // 99.00 (struct, tighter)
    const sized = vixRiskSize({ nlv, entry, stop, vix });
    // Uncapped 1%-risk sizing at $200k NLV with ~3% per-share risk ⇒ notional far over $50k.
    expect(sized.shares * entry).toBeGreaterThan(50_000);
    const cap = capSharesToMaxPosition({
      sizedShares: sized.shares, entry, existingTickerUnits: 0, maxPositionUsd: 50_000,
    });
    expect(cap.clamped).toBe(true);
    expect(cap.cappedShares).toBeLessThan(sized.shares);
    expect(cap.cappedShares).toBeGreaterThanOrEqual(1);
    // The TRANSMITTED notional (cappedShares × entry) must not breach the cap.
    expect(cap.cappedNotional).toBeLessThanOrEqual(50_000);
    expect(cap.cappedShares * entry).toBeLessThanOrEqual(50_000);
    // cappedNotional is exactly cappedShares × entry — the insert/bracket/BP-reserve basis.
    expect(cap.cappedNotional).toBeCloseTo(cap.cappedShares * entry, 2);
  });

  it("SKIP: existingTickerUsd ≥ maxPositionUsd ⇒ cappedShares < 1 (no LMT — caller releases lock & continues)", () => {
    // Already holding 600 sh @ $102 ≈ $61.2k ≥ $50k cap ⇒ zero headroom.
    const cap = capSharesToMaxPosition({
      sizedShares: 400, entry: 102, existingTickerUnits: 600, maxPositionUsd: 50_000,
    });
    expect(cap.cappedShares).toBeLessThan(1);
    expect(cap.cappedNotional).toBe(0);
    expect(cap.remainingUsd).toBe(0);
  });

  it("PASS-THROUGH: when sized.shares already fits, qty & notional are unchanged (no clamp)", () => {
    const cap = capSharesToMaxPosition({
      sizedShares: 100, entry: 102, existingTickerUnits: 0, maxPositionUsd: 50_000,
    });
    expect(cap.clamped).toBe(false);
    expect(cap.cappedShares).toBe(100);
    expect(cap.cappedNotional).toBeCloseTo(10_200, 2);
  });

  it("EXISTING exposure shrinks headroom (existing + new ≤ maxPositionUsd, NOT just new)", () => {
    // 200 sh @ $100 = $20k existing; cap $50k ⇒ $30k headroom ⇒ ≤ 300 sh @ $100.
    const cap = capSharesToMaxPosition({
      sizedShares: 1000, entry: 100, existingTickerUnits: 200, maxPositionUsd: 50_000,
    });
    expect(cap.existingUsd).toBe(20_000);
    expect(cap.remainingUsd).toBe(30_000);
    expect(cap.cappedShares).toBe(300);
    expect(cap.existingUsd + cap.cappedNotional).toBeLessThanOrEqual(50_000);
  });

  it("$2 penny-floor on the divisor (parity with executor) — never sizes off a sub-$2 price", () => {
    // entry $1 would explode shares/$ without the floor; divisor clamps to $2.
    const cap = capSharesToMaxPosition({
      sizedShares: 1_000_000, entry: 1, existingTickerUnits: 0, maxPositionUsd: 50_000,
    });
    expect(cap.cappedShares).toBe(Math.floor(50_000 / 2));
  });

  it("INERT — the cap reads config.maxPositionUsd at the place site (default 50000), gated behind flag=0", () => {
    const src = readFileSync(join(__dirname, "waiterEngine.ts"), "utf8");
    // The cap is computed inside placeNewRestingLimits, INSIDE the entrySlotLock, on `rows`.
    const fn = src.slice(src.indexOf("async function placeNewRestingLimits"));
    const lockIdx = fn.indexOf("tryAcquireEntrySlot(`waiter:${sym}`)");
    const capIdx = fn.indexOf("capSharesToMaxPosition({");
    const insertIdx = fn.indexOf("await db.insert(livePositions)");
    const bracketIdx = fn.indexOf("placeRestingBracket({ ticker: sym, conid, qty: cappedShares");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(capIdx).toBeGreaterThan(lockIdx);     // cap is INSIDE the lock (atomic exposure)
    expect(capIdx).toBeLessThan(insertIdx);      // cap precedes the slot-reserve insert
    expect(bracketIdx).toBeGreaterThan(-1);      // transmitted qty == cappedShares
    // Insert uses cappedShares for BOTH units and requestedQty (insert qty == transmit qty).
    expect(fn).toContain("units: cappedShares");
    expect(fn).toContain("requestedQty: cappedShares");
    // BP reserve uses the CAPPED notional, not the pre-cap thisNotional.
    expect(fn).toContain("reserveOptimisticBP(cappedNotional)");
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
  // Window spans ALL naked outcomes inside the reconcile body: the PARTIAL guard (BLOCKER-2 —
  // no-flatten), the UNKNOWN branch (gateway-unreachable → no-flatten backstop), and the
  // DEFINITIVE-ABSENT branch (real flatten → on transmit-fail: "flatten transmit FAILED" +
  // software-SL). Scoped to the whole reconcile function body so adding earlier `[WAITER_NAKED]`
  // logs (e.g. the partial guard) can never shrink the window below the transmit-fail log.
  const nakedBranch = recFn.slice(recFn.indexOf("[WAITER_NAKED]"), recFn.indexOf("\n}\n", recFn.indexOf("return summary;")));

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
describe("Waiter parity (risk stays 1%, stop stays wideLungSL-bounded)", () => {
  it("retest ambush + structural-stop (wideLungSL-bounded) + vixRiskSize → 1%-risk floored qty", () => {
    const retestLevel = 100, ema50 = 98, nlv = 100_000, vix = 18;
    // SSOT limitPrice for level 100 = 100.75; live 101 → pullback, ≤ FOMO cap 101.5.
    const ambush = computeAmbushLimit(100.75, retestLevel, 101);     // 100.75 (evaluateRetestV2.limitPrice)
    expect(ambush.limit).toBeCloseTo(100.75, 2);
    // structural stop just below support, bounded by wideLungSL (never wider than parity).
    const stopRes = computeRetestStop({ retestLevel, entry: ambush.limit, ema50 });
    expect(stopRes.stop).toBeGreaterThan(0);
    // wideLungSL is the never-wider floor: the chosen stop must be ≥ wideLungSL (tighter $-risk).
    expect(stopRes.stop).toBeGreaterThanOrEqual(wideLungSL(ambush.limit, ema50, "long"));
    const sized = vixRiskSize({ nlv, entry: ambush.limit, stop: stopRes.stop, vix });
    expect(sized.skip).toBe(false);
    // riskDollars = NLV × 0.01 × vixMult(1.0 @ vix≤25) = $1,000; qty = floor(1000 / perShareRisk)
    expect(sized.riskDollars).toBeCloseTo(1000, 2);
    expect(sized.shares).toBe(Math.floor(1000 / sized.perShareRisk));
  });
  it("RETEST_TOP_N is 10 (the 10/10 split)", () => {
    expect(RETEST_TOP_N).toBe(10);
  });
});

// ── (8) R4 BEHAVIORAL — classifyVerifyReason (transient vs definitive-absent vs ok) ─────────
//    Exercises the actual flatten-decision core (NOT source regex). BLOCKER-3.
describe("Waiter R4 behavioral — classifyVerifyReason", () => {
  it("a gateway THROW reason → transient (do NOT trust as absent)", () => {
    expect(classifyVerifyReason({ verified: false, reason: "orders read threw: ECONNRESET" })).toBe("transient");
  });
  it('a not-ok "HTTP 405" reason → transient', () => {
    expect(classifyVerifyReason({ verified: false, reason: "orders read not-ok (HTTP 405)" })).toBe("transient");
  });
  it('"no resting STP" → definitive_absent (healthy-book candidate for flatten)', () => {
    expect(classifyVerifyReason({ verified: false, reason: "no resting STP for ticker" })).toBe("definitive_absent");
  });
  it("verified:true → ok (the STP is resting — never flatten)", () => {
    expect(classifyVerifyReason({ verified: true, reason: "STP qty=100 @ $99.00 ≈ BE $95.00" })).toBe("ok");
  });
  it('timeout/econn substrings anywhere → transient', () => {
    expect(classifyVerifyReason({ verified: false, reason: "socket ETIMEDOUT after 5s" })).toBe("transient");
    expect(classifyVerifyReason({ verified: false, reason: "connect ECONNREFUSED" })).toBe("transient");
  });
});

// ── (9) R4 BEHAVIORAL — confirmStpAbsentForFlatten (the bounded gateway-aware verdict) ──────
//    A long pos; the exit-side STP is SELL. A book containing the matching STP ⇒ "verified".
describe("Waiter R4 behavioral — confirmStpAbsentForFlatten", () => {
  const POS = { ticker: "AAPL", units: 100, direction: "long", entryPrice: 95 }; // BE ref = 95
  const matchingStp = [{ status: "Submitted", side: "SELL", description1: "AAPL", orderType: "STP", remainingQuantity: "100", stopPrice: 99 }];
  // A healthy, non-empty book that has working orders but NO qualifying STP for AAPL.
  const healthyNoStp = [{ status: "Submitted", side: "SELL", description1: "MSFT", orderType: "STP", remainingQuantity: "50", stopPrice: 200 }];
  const fast = { backoffMs: 0, sleep: async () => {} };

  it('["THROW","THROW","THROW"] → unknown (gateway down across retries — NO flatten)', async () => {
    const r = await confirmStpAbsentForFlatten(POS, { ...fast, retries: 3, injectedSequence: ["THROW", "THROW", "THROW"] });
    expect(r.decision).toBe("unknown");
  });
  it("[[],[],[]] (empty healthy books) → unknown (empty book is a known flake — NO flatten)", async () => {
    const r = await confirmStpAbsentForFlatten(POS, { ...fast, retries: 3, injectedSequence: [[], [], []] });
    expect(r.decision).toBe("unknown");
  });
  it("healthy NON-EMPTY books with no matching STP across retries → absent (genuinely naked)", async () => {
    const r = await confirmStpAbsentForFlatten(POS, { ...fast, retries: 3, injectedSequence: [healthyNoStp, healthyNoStp, healthyNoStp] });
    expect(r.decision).toBe("absent");
  });
  it("a book CONTAINING the matching STP → verified (protected — never flatten)", async () => {
    const r = await confirmStpAbsentForFlatten(POS, { ...fast, retries: 3, injectedSequence: [matchingStp] });
    expect(r.decision).toBe("verified");
  });
  it('mixed: ["THROW", healthyNoStp] → absent (a clean later read proves naked)', async () => {
    const r = await confirmStpAbsentForFlatten(POS, { ...fast, retries: 2, injectedSequence: ["THROW", healthyNoStp] });
    expect(r.decision).toBe("absent");
  });
});

// ── (10) R4 BEHAVIORAL — reconcileWaiterPositions flatten-decision (unknown/absent/partial) ──
//    Drives the WHOLE reconcile with an injected DB + injected executeLiveSell so we can OBSERVE
//    whether a real flatten is transmitted. BLOCKER-2 (partial) + BLOCKER-3 (unknown/absent).
describe("Waiter R4 behavioral — reconcileWaiterPositions flatten decision", () => {
  // Minimal injectable Drizzle-like stub: select()/from()/where() resolves to the seeded rows;
  // update()/set()/where() records the patch (and is awaitable). No real DB.
  function makeDb(rows: any[]) {
    const updates: Array<Record<string, any>> = [];
    const db: any = {
      select: () => ({ from: () => ({ where: async () => rows }) }),
      update: () => ({ set: (patch: any) => ({ where: async () => { updates.push(patch); return undefined; } }) }),
    };
    return { db, updates };
  }
  const ON = { waiterEnabled: 1 } as any;
  const baseRow = {
    id: 7, ticker: "AAPL", isWaiterEntry: 1, status: "pending_entry",
    requestedQty: 100, units: 100, entryPrice: 100, initialSl: 95,
    allocatedCapital: 10000, openedAt: new Date(),
  };

  it('UNKNOWN (gateway down) → NO executeLiveSell, row slProtection:"software", summary.unknown===1', async () => {
    const { db, updates } = makeDb([{ ...baseRow }]);
    const sellCalls: any[] = [];
    const res = await reconcileWaiterPositions(1, new Map([["AAPL", 100]]), {
      config: ON, db,
      injectedOrders: [],                                   // first v0 read: deterministic empty book (no network)
      injectedNakedSequence: ["THROW", "THROW", "THROW"],
      executeLiveSell: (async (a: any) => { sellCalls.push(a); return { success: true, reason: "stub" }; }) as any,
    });
    expect(sellCalls.length).toBe(0);                       // NEVER blind-flatten on unknown
    expect(res.unknown).toBe(1);
    expect(res.flattened).toBe(0);
    expect(updates.some((u) => u.slProtection === "software")).toBe(true);
  });

  it("ABSENT (healthy book, no STP) → executeLiveSell IS called, summary.flattened===1", async () => {
    const { db } = makeDb([{ ...baseRow }]);
    const sellCalls: any[] = [];
    const healthyNoStp = [{ status: "Submitted", side: "SELL", description1: "MSFT", orderType: "STP", remainingQuantity: "50", stopPrice: 200 }];
    const res = await reconcileWaiterPositions(1, new Map([["AAPL", 100]]), {
      config: ON, db,
      injectedOrders: [],                                   // first v0 read: deterministic empty book (no network)
      injectedNakedSequence: [healthyNoStp, healthyNoStp, healthyNoStp],
      executeLiveSell: (async (a: any) => { sellCalls.push(a); return { success: true, reason: "filled" }; }) as any,
    });
    expect(sellCalls.length).toBe(1);                       // a genuinely-naked filled pos IS flattened
    expect(sellCalls[0].reason).toBe("WAITER_NAKED_FLATTEN");
    expect(res.flattened).toBe(1);
  });

  it("BLOCKER-2 PARTIAL fill (ibkrQty < reqQty) → NO executeLiveSell (oversized STP still protects)", async () => {
    // Broker reports only 40 of the 100 requested filled. The full-size child STP still rests.
    // Even with a DEFINITIVELY-absent sequence injected, a partial must NOT flatten.
    const { db, updates } = makeDb([{ ...baseRow }]);
    const sellCalls: any[] = [];
    const healthyNoStp = [{ status: "Submitted", side: "SELL", description1: "MSFT", orderType: "STP", remainingQuantity: "50", stopPrice: 200 }];
    const res = await reconcileWaiterPositions(1, new Map([["AAPL", 40]]), {
      config: ON, db,
      injectedNakedSequence: [healthyNoStp, healthyNoStp, healthyNoStp],
      executeLiveSell: (async (a: any) => { sellCalls.push(a); return { success: true, reason: "filled" }; }) as any,
    });
    expect(sellCalls.length).toBe(0);                       // false-positive flatten PREVENTED
    expect(res.flattened).toBe(0);
    expect(res.unknown).toBe(1);                            // routed to the UNKNOWN/no-flatten branch
    expect(updates.some((u) => u.slProtection === "software")).toBe(true);
  });

  it("VERIFIED (first read finds the resting STP) → NO flatten (healthy)", async () => {
    const { db } = makeDb([{ ...baseRow }]);
    const sellCalls: any[] = [];
    const matchingStp = [{ status: "Submitted", side: "SELL", description1: "AAPL", orderType: "STP", remainingQuantity: "100", stopPrice: 99 }];
    const res = await reconcileWaiterPositions(1, new Map([["AAPL", 100]]), {
      config: ON, db,
      injectedOrders: matchingStp,
      executeLiveSell: (async (a: any) => { sellCalls.push(a); return { success: true, reason: "x" }; }) as any,
    });
    expect(sellCalls.length).toBe(0);
    expect(res.flattened).toBe(0);
  });
});
