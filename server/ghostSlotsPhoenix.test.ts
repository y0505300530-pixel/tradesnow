/**
 * ghostSlotsPhoenix.test.ts — Ghost Slots (G-S1) + Phoenix Protocol (P-S1) BUILD tests.
 *
 * Loop-2 exit-gate tests (spec §7/§8). All driven against the PURE/injectable SSOT
 * helpers (no live broker/DB) plus source-regex INERT assertions:
 *
 *   (i)   flags=0 ⇒ byte-identical (no ghost, no phoenix, slot counter unchanged)
 *   (ii)  slot counter: 3 active + 2 ghost = 3 counted
 *   (iii) ghost ONLY after IBKR-SL-verified mock=true (fail-closed when false)
 *   (iv)  Phoenix sizing: tight reclaim → capped, no /0 / ∞-qty
 *   (v)   anti-loop persists across a simulated restart (DB-read, not in-memory)
 *
 * Plus parity guards: heat=0 for ghost rows (G1-C), Golden 2.5R/5R ladder untouched,
 * and the inert flag-readers default to OFF.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
// G1-A broker-transport fail-closed: mock ONLY ibindRequest so verifyRestingStopAtBe's
// real `/orders` branch (no injectedOrders) can be driven to 405 / throw. importOriginal
// preserves every other ibkrProxy export so nothing else is disturbed.
import { ibindRequest } from "./routers/ibkrProxy";
vi.mock("./routers/ibkrProxy", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  ibindRequest: vi.fn(),
}));
import {
  isGhostSlotsEnabled,
  rowCountsTowardSlot,
  slotCounts,
  positionPlannedRiskUsd,
  meetsGhostTrigger,
  verifyRestingStopAtBe,
  onBreakevenConfirmed,
  GHOST_TRIGGER_R,
  GHOST_STAGE,
} from "./ghostSlots";
import {
  isPhoenixEnabled,
  isPhoenixWideLungStop,
  is5mReclaimAbove,
  computePhoenixSize,
  checkPhoenixAntiLoop,
  PHOENIX_ELIGIBLE_SIGNALS,
} from "./phoenixProtocol";
import { GOLDEN_SCALE_R, GOLDEN_TP_FINAL_R } from "./engine/elzaV45Master";

// ── A live STP order book fixture (broker-truth) ─────────────────────────────────
function stpOrder(over: Record<string, any> = {}) {
  return {
    description1: "AAPL", side: "SELL", status: "Submitted", orderType: "STP",
    stopPrice: 100.0, totalQuantity: 50, ...over,
  };
}

describe("Ghost Slots — flag reader + INERT invariant (i)", () => {
  it("ghostSlotsEnabled defaults OFF", () => {
    expect(isGhostSlotsEnabled(null)).toBe(false);
    expect(isGhostSlotsEnabled({} as any)).toBe(false);
    expect(isGhostSlotsEnabled({ ghostSlotsEnabled: 0 } as any)).toBe(false);
    expect(isGhostSlotsEnabled({ ghostSlotsEnabled: 1 } as any)).toBe(true);
  });

  it("flag OFF ⇒ every row counts toward a slot (byte-identical to today)", () => {
    const ghostRow = { slotGhost: 1, countsTowardSlot: 0 };
    expect(rowCountsTowardSlot(ghostRow, /*ghostEnabled*/ false)).toBe(true);  // ignored when off
    expect(rowCountsTowardSlot(ghostRow, /*ghostEnabled*/ true)).toBe(false);  // honored when on
  });

  it("flag OFF ⇒ ghost row still contributes full planned risk (heat unchanged)", () => {
    const row = { entryPrice: 100, currentSl: 92, units: 10, slotGhost: 1 };
    expect(positionPlannedRiskUsd(row, false)).toBe(80);  // |100-92|×10, NOT zeroed
    expect(positionPlannedRiskUsd(row, true)).toBe(0);    // G1-C: ghost ⇒ 0 only when ON
  });

  it("onBreakevenConfirmed is a no-op when the flag is OFF (no broker read / no write)", async () => {
    const r = await onBreakevenConfirmed(
      { id: 1, ticker: "AAPL", units: 50, direction: "long", entryPrice: 100,
        currentSl: 100.2, initialSl: 90, currentPrice: 116, slMovedToBreakEven: 1 },
      { ghostSlotsEnabled: 0 } as any,
      { injectedOrders: [stpOrder()], db: { update: () => { throw new Error("must not write"); } } as any },
    );
    expect(r.ghosted).toBe(false);
    expect(r.reason).toMatch(/disabled/);
  });
});

describe("Ghost Slots — slot counter 3 active + 2 ghost = 3 (ii)", () => {
  const rows = [
    { slotGhost: 0, countsTowardSlot: 1, direction: "long" },
    { slotGhost: 0, countsTowardSlot: 1, direction: "long" },
    { slotGhost: 0, countsTowardSlot: 1, direction: "short" },
    { slotGhost: 1, countsTowardSlot: 0, direction: "long" },
    { slotGhost: 1, countsTowardSlot: 0, direction: "long" },
  ];

  it("flag ON ⇒ active=3, ghost=2, free=9 (cap 12)", () => {
    const c = slotCounts(rows, 12, true);
    expect(c.active).toBe(3);
    expect(c.ghost).toBe(2);
    expect(c.free).toBe(9);
  });

  it("flag OFF ⇒ all 5 count (byte-identical) — active=5, ghost=0, free=7", () => {
    const c = slotCounts(rows, 12, false);
    expect(c.active).toBe(5);
    expect(c.ghost).toBe(0);
    expect(c.free).toBe(7);
  });
});

describe("Ghost Slots — broker-truth fail-closed (iii / G1-A)", () => {
  const pos = {
    id: 7, ticker: "AAPL", units: 50, direction: "long",
    entryPrice: 100, currentSl: 100.2, initialSl: 90, currentPrice: 116, slMovedToBreakEven: 1,
  };

  it("trigger pre-gate: +1.5R + SL@BE ⇒ true", () => {
    // r = 100-90 = 10; profitR = (116-100)/10 = 1.6 ≥ 1.5; slMovedToBreakEven=1; SL≥entry.
    expect(meetsGhostTrigger(pos)).toBe(true);
  });
  it("trigger pre-gate fails below 1.5R", () => {
    expect(meetsGhostTrigger({ ...pos, currentPrice: 112 })).toBe(false); // 1.2R
  });
  it("trigger pre-gate fails when SL not yet at BE", () => {
    expect(meetsGhostTrigger({ ...pos, currentSl: 95, slMovedToBreakEven: 0 })).toBe(false);
  });
  it("degenerate r (entry==initialSl) ⇒ never ghost (no /0)", () => {
    expect(meetsGhostTrigger({ ...pos, initialSl: 100, currentSl: 100 })).toBe(false);
  });

  it("verify TRUE when a resting STP rests at BE for full qty", async () => {
    const v = await verifyRestingStopAtBe(pos, [stpOrder({ stopPrice: 100.2, totalQuantity: 50 })]);
    expect(v.verified).toBe(true);
  });
  it("verify FALSE when no resting STP (orphan-cancelled / OCA-reject)", async () => {
    const v = await verifyRestingStopAtBe(pos, []);
    expect(v.verified).toBe(false);
  });
  it("verify FALSE when STP qty != position qty (partial)", async () => {
    const v = await verifyRestingStopAtBe(pos, [stpOrder({ stopPrice: 100.2, totalQuantity: 20 })]);
    expect(v.verified).toBe(false);
  });
  it("verify FALSE when STP not yet at BE (still at the wide stop)", async () => {
    const v = await verifyRestingStopAtBe(pos, [stpOrder({ stopPrice: 90, totalQuantity: 50 })]);
    expect(v.verified).toBe(false);
  });

  // ── G1-A broker-transport fail-closed (the gap Cursor flagged) ──────────────
  it("FAIL-CLOSED: live /orders read returns HTTP 405 (not-ok) ⇒ verified=false (no ghost)", async () => {
    (ibindRequest as any).mockResolvedValueOnce({ ok: false, status: 405, body: {} });
    const v = await verifyRestingStopAtBe(pos); // NO injectedOrders ⇒ real broker branch
    expect(v.verified).toBe(false);
    expect(v.reason).toMatch(/405|not-ok/i);
  });
  it("FAIL-CLOSED: live /orders read THROWS (timeout/network) ⇒ verified=false (no ghost)", async () => {
    (ibindRequest as any).mockRejectedValueOnce(new Error("ETIMEDOUT"));
    const v = await verifyRestingStopAtBe(pos);
    expect(v.verified).toBe(false);
    expect(v.reason).toMatch(/threw/i);
  });
  it("FAIL-CLOSED: a 405 from the broker ⇒ onBreakevenConfirmed does NOT ghost / does NOT write", async () => {
    (ibindRequest as any).mockResolvedValueOnce({ ok: false, status: 405, body: {} });
    const r = await onBreakevenConfirmed(pos as any, { ghostSlotsEnabled: 1 } as any,
      { db: { update: () => { throw new Error("must NOT write on unverified broker read"); } } as any });
    expect(r.ghosted).toBe(false);
  });

  it("hook GHOSTS only when broker-verified true (flag ON)", async () => {
    let written: any = null;
    const db = { update: () => ({ set: (v: any) => ({ where: async () => { written = v; } }) }) };
    const r = await onBreakevenConfirmed(pos, { ghostSlotsEnabled: 1 } as any,
      { injectedOrders: [stpOrder({ stopPrice: 100.2, totalQuantity: 50 })], db: db as any });
    expect(r.ghosted).toBe(true);
    expect(written.slotGhost).toBe(1);
    expect(written.countsTowardSlot).toBe(0);
    expect(written.ghostStage).toBe(GHOST_STAGE);
  });

  it("hook FAIL-CLOSED: does NOT ghost when SL not verified (no write)", async () => {
    const db = { update: () => { throw new Error("must not write"); } };
    const r = await onBreakevenConfirmed(pos, { ghostSlotsEnabled: 1 } as any,
      { injectedOrders: [] /* no resting STP */, db: db as any });
    expect(r.ghosted).toBe(false);
    expect(r.reason).toMatch(/not verified/i);
  });

  it("hook idempotent: already-ghost ⇒ no-op", async () => {
    const r = await onBreakevenConfirmed({ ...pos, slotGhost: 1 } as any,
      { ghostSlotsEnabled: 1 } as any,
      { injectedOrders: [stpOrder()], db: { update: () => { throw new Error("no"); } } as any });
    expect(r.ghosted).toBe(false);
    expect(r.reason).toMatch(/already ghost/);
  });
});

describe("Phoenix — flag + eligibility (P-S0)", () => {
  it("phoenixProtocolEnabled defaults OFF", () => {
    expect(isPhoenixEnabled(null)).toBe(false);
    expect(isPhoenixEnabled({ phoenixProtocolEnabled: 1 } as any)).toBe(true);
  });
  it("eligible signals: Gold breakout / Full break only (ADR-P3)", () => {
    expect(PHOENIX_ELIGIBLE_SIGNALS.has("GOLD_BREAKOUT_WAR")).toBe(true);
    expect(PHOENIX_ELIGIBLE_SIGNALS.has("ARMED_FULL_BREAK")).toBe(true);
    expect(PHOENIX_ELIGIBLE_SIGNALS.has("WAR_ENGINE")).toBe(false);
  });
  it("wide-lung stop: STOP at/below initialSl×1.002 on an eligible breakout ⇒ true", () => {
    expect(isPhoenixWideLungStop({
      signal: "GOLD_BREAKOUT_WAR", direction: "long",
      exitReason: "SL_HIT_IBKR", exitPrice: 90.1, initialSl: 90,
    })).toBe(true);
  });
  it("NOT eligible: a tighter (non-wide-lung) stop above initialSl×1.002", () => {
    expect(isPhoenixWideLungStop({
      signal: "GOLD_BREAKOUT_WAR", direction: "long",
      exitReason: "SL_HIT_IBKR", exitPrice: 95, initialSl: 90,
    })).toBe(false);
  });
  it("NOT eligible: TP close, manual close, or P&L-UNKNOWN", () => {
    const base = { signal: "GOLD_BREAKOUT_WAR", direction: "long", exitPrice: 90, initialSl: 90 } as const;
    expect(isPhoenixWideLungStop({ ...base, exitReason: "TP_HIT_IBKR" })).toBe(false);
    expect(isPhoenixWideLungStop({ ...base, exitReason: "MANUAL_CLOSE" })).toBe(false);
    expect(isPhoenixWideLungStop({ ...base, exitReason: "CLOSED_IBKR_NO_PRICE" })).toBe(false);
  });
  it("NOT eligible: wrong origin signal", () => {
    expect(isPhoenixWideLungStop({
      signal: "WAR_ENGINE", direction: "long", exitReason: "SL_HIT_IBKR", exitPrice: 90, initialSl: 90,
    })).toBe(false);
  });
});

describe("Phoenix — 5m reclaim (P4)", () => {
  const bars = (closes: number[]) => closes.map((c, i) => ({
    date: "2026-06-29", time: `1${i}:00`, datetime: `2026-06-29T1${i}:00:00`, ts: i,
    open: c, high: c, low: c, close: c, volume: 1000,
  })) as any[];
  it("reclaimed when last 5m close > breakoutLine (long)", () => {
    const r = is5mReclaimAbove(bars([99, 100, 101.5]), 101, false);
    expect(r.reclaimed).toBe(true);
    expect(r.reclaimClose).toBe(101.5);
  });
  it("NOT reclaimed when last close ≤ breakoutLine", () => {
    expect(is5mReclaimAbove(bars([99, 100, 100.5]), 101, false).reclaimed).toBe(false);
  });
  it("fail-closed on no bars", () => {
    expect(is5mReclaimAbove([], 101, false).reclaimed).toBe(false);
  });
});

describe("Phoenix — sizing tight reclaim → capped, no /0 (iv)", () => {
  it("tight reclaim stop ⇒ 1%-recalc would oversize → HARD-CAPPED at origin×1.25", () => {
    // entry 100, stop 99.9 → perShareRisk 0.10; risk$ = 100000×0.01 = 1000 → 10000 shares!
    // origin qty 50 → cap = floor(50×1.25)=62. Must bind to 62, not 10000.
    const s = computePhoenixSize({
      nlv: 100000, entry: 100, stop: 99.9, vix: 15, originQty: 50, qtyCapMult: 1.25, direction: "long",
    });
    expect(s.skip).toBe(false);
    expect(s.qty).toBe(62);
    expect(s.capped).toBe(true);
    expect(Number.isFinite(s.qty)).toBe(true);
  });
  it("degenerate entry==stop ⇒ SKIP (no /0, no ∞-qty)", () => {
    const s = computePhoenixSize({
      nlv: 100000, entry: 100, stop: 100, vix: 15, originQty: 50, qtyCapMult: 1.25, direction: "long",
    });
    expect(s.skip).toBe(true);
    expect(s.qty).toBe(0);
  });
  it("VIX block (>35) ⇒ SKIP", () => {
    const s = computePhoenixSize({
      nlv: 100000, entry: 100, stop: 92, vix: 40, originQty: 50, qtyCapMult: 1.25, direction: "long",
    });
    expect(s.skip).toBe(true);
  });
  it("normal wide stop within cap ⇒ NOT capped, sane qty", () => {
    // entry 100, stop 92 → perShareRisk 8; risk$ 1000 → 125 sh; origin 200 → cap 250 (not bound).
    const s = computePhoenixSize({
      nlv: 100000, entry: 100, stop: 92, vix: 15, originQty: 200, qtyCapMult: 1.25, direction: "long",
    });
    expect(s.skip).toBe(false);
    expect(s.capped).toBe(false);
    expect(s.qty).toBe(125);
  });
  it("origin qty 0 ⇒ SKIP (cannot anchor the cap)", () => {
    const s = computePhoenixSize({
      nlv: 100000, entry: 100, stop: 92, vix: 15, originQty: 0, qtyCapMult: 1.25, direction: "long",
    });
    expect(s.skip).toBe(true);
  });
});

describe("Phoenix — anti-loop persists across a simulated restart (v)", () => {
  const today = "2026-06-29";
  // Simulate the DB ledger surviving a process restart: the SAME rows are re-read.
  const ledgerAfterOneReentry = [
    { ticker: "ALAB", status: "reentered", cooldownUntil: null },
  ];

  it("≤1/ticker/day: a re-entered ticker is blocked even after restart (DB-read)", () => {
    // "Restart" = a fresh checkPhoenixAntiLoop call with the persisted rows; no in-memory state.
    const r = checkPhoenixAntiLoop({
      ticker: "ALAB", ledgerToday: ledgerAfterOneReentry, maxPerDay: 3,
      ghostOpenTickers: new Set(), now: Date.parse("2026-06-29T20:00:00Z"),
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/already re-entered/);
  });

  it("≤3/account/day: 3 fired today ⇒ a 4th (new ticker) blocked", () => {
    const led = [
      { ticker: "AAA", status: "reentered" },
      { ticker: "BBB", status: "reentered" },
      { ticker: "CCC", status: "reentered" },
    ];
    const r = checkPhoenixAntiLoop({ ticker: "DDD", ledgerToday: led, maxPerDay: 3, ghostOpenTickers: new Set() });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/daily cap/);
  });

  it("30-min cooldown blocks even when caps not hit", () => {
    const now = Date.parse("2026-06-29T20:00:00Z");
    const led = [{ ticker: "MU", status: "eligible", cooldownUntil: now + 10 * 60_000 }];
    const r = checkPhoenixAntiLoop({ ticker: "MU", ledgerToday: led, maxPerDay: 3, ghostOpenTickers: new Set(), now });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/cooldown/);
  });

  it("ghost open on same ticker ⇒ blocked", () => {
    const r = checkPhoenixAntiLoop({
      ticker: "NVDA", ledgerToday: [], maxPerDay: 3, ghostOpenTickers: new Set(["NVDA"]),
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/ghost open/);
  });

  it("clean slate ⇒ allowed", () => {
    const r = checkPhoenixAntiLoop({ ticker: "TSLA", ledgerToday: [], maxPerDay: 3, ghostOpenTickers: new Set() });
    expect(r.allowed).toBe(true);
  });

  void today;
});

describe("Parity guards — exit ladder + INERT source (G1-D)", () => {
  it("Golden 2.5R scale + 5R final UNCHANGED (LIVE_OPS_OVERLAY)", () => {
    expect(GOLDEN_SCALE_R).toBe(2.5);
    expect(GOLDEN_TP_FINAL_R).toBe(5.0);
    expect(GHOST_TRIGGER_R).toBe(1.5); // ghost is a SEPARATE +1.5R hook, not folded into the ladder
  });

  it("warEngine slot counter is flag-gated (ghost helpers consulted, INERT at flag=0)", () => {
    const src = readFileSync(join(__dirname, "warEngine.ts"), "utf8");
    // Heat recalc routes through positionPlannedRiskUsd(p, _ghostOn).
    expect(src).toMatch(/positionPlannedRiskUsd\(p, _ghostOn\)/);
    // Slot seeds route through rowCountsTowardSlot.
    expect(src).toMatch(/rowCountsTowardSlot\(p, _ghostOn\)/);
    // The single hook is called from the manage path (G1-D).
    expect(src).toMatch(/onBreakevenConfirmed\(/);
  });

  it("tryLiveEntry slot count is ghost-aware (INERT at flag=0)", () => {
    const src = readFileSync(join(__dirname, "liveOrderExecutor.ts"), "utf8");
    expect(src).toMatch(/rowCountsTowardSlot\(p as any, _ghostOn\)/);
    expect(src).toMatch(/slotCount >= config\.maxPositions/);
  });

  it("Phoenix watcher is isolated (NOT invoked from the war-20m scan)", () => {
    const war = readFileSync(join(__dirname, "warEngine.ts"), "utf8");
    expect(war).not.toMatch(/runPhoenixWatcherTick/);
  });
});
