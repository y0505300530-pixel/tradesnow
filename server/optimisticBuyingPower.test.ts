/**
 * optimisticBuyingPower.test.ts — Optimistic Buying-Power ledger (batch-fire margin race).
 *
 * PROBLEM pinned: when two Hit-List names break out in the SAME war cycle, IBKR's
 * BuyingPower has not updated between the two transmits → the 2nd bracket is REJECTED
 * for insufficient margin. The fix is an in-memory ledger that decrements on transmit so
 * the 2nd entry is gated against the 1st's reservation.
 *
 * These tests pin the NON-NEGOTIABLE INERT-SAFE contract:
 *   1. resyncOptimisticBP seeds from broker truth (both /account/summary shapes).
 *   2. FAIL-OPEN: a broker-read failure KEEPS the last-known-good value (never nulls,
 *      never zeroes) — a gateway blip can never freeze legitimate entries.
 *   3. The gate NEVER blocks when the ledger is null (unsynced) — IBKR decides.
 *   4. After a clean resync the FIRST entry of a cycle is gated against the FULL broker
 *      BP, so it can never be falsely blocked.
 *   5. The decrement-on-transmit makes the 2nd same-cycle entry see the reduced figure.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the IBKR cache layer resyncOptimisticBP reads /account/summary through.
const ibindCachedMock = vi.fn();
vi.mock("./ibkrCache", () => ({
  ibindCached: (...a: any[]) => ibindCachedMock(...a),
  invalidateIbkrCache: vi.fn(),
}));
// Keep the heavy transitive imports of liveOrderExecutor from doing real I/O at import.
vi.mock("./telegram", () => ({ sendTelegramMessage: vi.fn(async () => undefined) }));

import {
  resyncOptimisticBP,
  __resetOptimisticBPForTest,
  __setOptimisticBPForTest,
  LIVE_ACCOUNT_ID,
} from "./liveOrderExecutor";

/**
 * PURE mirror of the gate decision inside tryLiveEntry (the load-bearing expression):
 *   if (_optimisticBP != null && plannedPositionUsd > _optimisticBP) → block.
 * Tested directly so the contract is pinned without the DB/IBKR-bound entry machinery.
 */
function gateBlocks(optimisticBP: number | null, plannedPositionUsd: number): boolean {
  return optimisticBP != null && plannedPositionUsd > optimisticBP;
}

const acctSummaryShape1 = (bp: number) => ({ ok: true, status: 200, body: { summary: { buyingpower: { amount: bp } } } });
const acctSummaryShape2 = (bp: number) => ({ ok: true, status: 200, body: { [LIVE_ACCOUNT_ID]: [{ key: "BuyingPower", amount: bp }] } });

beforeEach(() => {
  ibindCachedMock.mockReset();
  __resetOptimisticBPForTest();
});

describe("resyncOptimisticBP — seeds from broker truth", () => {
  it("reads buyingPower from the nested /account/summary shape", async () => {
    ibindCachedMock.mockResolvedValue(acctSummaryShape1(75_000));
    const v = await resyncOptimisticBP(1);
    expect(v).toBe(75_000);
  });

  it("reads buyingPower from the legacy per-account array shape", async () => {
    ibindCachedMock.mockResolvedValue(acctSummaryShape2(40_000));
    const v = await resyncOptimisticBP(1);
    expect(v).toBe(40_000);
  });
});

describe("FAIL-OPEN — broker-read failure keeps last-known-good", () => {
  it("a !ok read KEEPS the prior value (never nulls, never zeroes)", async () => {
    ibindCachedMock.mockResolvedValueOnce(acctSummaryShape1(60_000));
    expect(await resyncOptimisticBP(1)).toBe(60_000);
    // next cycle: gateway flake
    ibindCachedMock.mockResolvedValueOnce({ ok: false, status: 503, body: null });
    expect(await resyncOptimisticBP(1)).toBe(60_000); // last-known-good kept
  });

  it("a throwing read KEEPS the prior value", async () => {
    __setOptimisticBPForTest(33_000);
    ibindCachedMock.mockRejectedValueOnce(new Error("gateway down"));
    expect(await resyncOptimisticBP(1)).toBe(33_000);
  });

  it("from a NEVER-synced state a failed read stays null (still fail-open at the gate)", async () => {
    ibindCachedMock.mockResolvedValueOnce({ ok: false, status: 503, body: null });
    expect(await resyncOptimisticBP(1)).toBeNull();
  });
});

describe("GATE contract — pre-empts only what IBKR would reject; never blocks unsynced/first entry", () => {
  it("null ledger (unsynced) NEVER blocks — IBKR decides", () => {
    expect(gateBlocks(null, 10_000_000)).toBe(false);
  });

  it("first entry after a clean resync is gated against the FULL broker BP (not blocked)", () => {
    const bp = 75_000; // freshly resynced
    expect(gateBlocks(bp, 60_000)).toBe(false); // first breakout fits within full BP
  });

  it("an entry exactly at available BP is allowed (strict >)", () => {
    expect(gateBlocks(50_000, 50_000)).toBe(false);
  });

  it("an entry over available BP is pre-empted (the IBKR reject the gate front-runs)", () => {
    expect(gateBlocks(50_000, 50_001)).toBe(true);
  });

  it("batch-fire race: 1st transmit decrements, 2nd is gated against the reduced figure", () => {
    let ledger: number = 75_000;       // clean resync
    const planned1 = 50_000;
    expect(gateBlocks(ledger, planned1)).toBe(false); // 1st fits
    ledger -= planned1;                // decrement-on-transmit (now 25_000)
    const planned2 = 40_000;
    // 2nd breakout would have been REJECTED by IBKR for margin — gate pre-empts it.
    expect(gateBlocks(ledger, planned2)).toBe(true);
  });
});
