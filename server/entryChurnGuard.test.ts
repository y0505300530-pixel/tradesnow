/**
 * entryChurnGuard.test.ts — Entry Churn Guard (2026-07-01 spec) pure-helper tests.
 *
 *   (i)   C1 — same-day automated entry → block; MANUAL_% not counted
 *   (ii)  C2 — cooldown active → block; expired → pass
 *   (iii) INERT — flag=0 path builds no ledger (empty sets) → never blocks (source guard)
 *   (iv)  Waiter / manual exempt — GOLD_RETEST_WAITER & MANUAL_ are not "automated"
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  isAutomatedSignal,
  buildChurnLedger,
  isChurnBlocked,
  startOfIsraelDayMs,
  type ChurnLedgerRow,
} from "./entryChurnGuard";

const NOW = Date.UTC(2026, 6, 1, 19, 0, 0); // 2026-07-01 19:00 UTC (Israel evening RTH)
const dayStart = startOfIsraelDayMs(NOW);
const cooldownMin = 90;
const cooldownFromMs = NOW - cooldownMin * 60_000;

function ledger(rows: ChurnLedgerRow[]) {
  return buildChurnLedger(rows, { dayStartMs: dayStart, cooldownFromMs });
}

describe("isAutomatedSignal — MANUAL_% & Waiter exemption classification", () => {
  it("automated War/Bear/Waiter signals are automated", () => {
    expect(isAutomatedSignal("GOLD_BREAKOUT_WAR")).toBe(true);
    expect(isAutomatedSignal("BEAR_WAR_RETEST")).toBe(true);
    // NOTE: GOLD_RETEST_WAITER IS an automated signal string; the Waiter EXEMPTION is
    // enforced at the call site (it never routes through the churn gate), not here.
    expect(isAutomatedSignal("GOLD_RETEST_WAITER")).toBe(true);
  });
  it("MANUAL_% and empty are NOT automated (C5 exempt)", () => {
    expect(isAutomatedSignal("MANUAL_CLOSE")).toBe(false);
    expect(isAutomatedSignal("MANUAL_BUY")).toBe(false);
    expect(isAutomatedSignal("")).toBe(false);
    expect(isAutomatedSignal(null)).toBe(false);
  });
});

describe("C1 — one automated entry / ticker / day", () => {
  it("blocks a second automated entry after a same-day automated open", () => {
    const l = ledger([
      { ticker: "AAPL", signal: "GOLD_RETEST_WAR", status: "open", openedAt: new Date(NOW - 3 * 3600_000), closedAt: null },
    ]);
    expect(l.automatedToday.has("AAPL")).toBe(true);
    const r = isChurnBlocked({ ticker: "AAPL", direction: "long", automatedToday: l.automatedToday, lastCloseAt: l.lastCloseAt, nowMs: NOW, cooldownMin });
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/C1/);
  });

  it("a MANUAL_ open today does NOT arm C1 (manual exempt)", () => {
    const l = ledger([
      { ticker: "ZIM", signal: "MANUAL_BUY", status: "open", openedAt: new Date(NOW - 3600_000), closedAt: null },
    ]);
    expect(l.automatedToday.has("ZIM")).toBe(false);
    const r = isChurnBlocked({ ticker: "ZIM", direction: "long", automatedToday: l.automatedToday, lastCloseAt: l.lastCloseAt, nowMs: NOW, cooldownMin });
    expect(r.blocked).toBe(false);
  });

  it("a fresh ticker with no history passes", () => {
    const l = ledger([]);
    const r = isChurnBlocked({ ticker: "NSC", direction: "long", automatedToday: l.automatedToday, lastCloseAt: l.lastCloseAt, nowMs: NOW, cooldownMin });
    expect(r.blocked).toBe(false);
  });
});

describe("C2 — cooldown after any close", () => {
  it("blocks when closed 30m ago (< 90m cooldown), any exit reason", () => {
    const l = ledger([
      { ticker: "AAPL", signal: "MANUAL_CLOSE", status: "closed", openedAt: new Date(NOW - 6 * 3600_000), closedAt: new Date(NOW - 30 * 60_000) },
    ]);
    const r = isChurnBlocked({ ticker: "AAPL", direction: "long", automatedToday: l.automatedToday, lastCloseAt: l.lastCloseAt, nowMs: NOW, cooldownMin });
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/C2/);
  });

  it("passes when the close is older than the cooldown (95m ago)", () => {
    // 95m ago is OUTSIDE the 90m cooldownFromMs window, so buildChurnLedger drops it →
    // lastCloseAt is empty. Use a MANUAL_ signal so C1 (automated-today) does NOT fire
    // and this test isolates C2 alone → not blocked.
    const l = ledger([
      { ticker: "AAPL", signal: "MANUAL_CLOSE", status: "closed", openedAt: new Date(NOW - 6 * 3600_000), closedAt: new Date(NOW - 95 * 60_000) },
    ]);
    expect(l.lastCloseAt.has("AAPL")).toBe(false);
    expect(l.automatedToday.has("AAPL")).toBe(false);
    const r = isChurnBlocked({ ticker: "AAPL", direction: "long", automatedToday: l.automatedToday, lastCloseAt: l.lastCloseAt, nowMs: NOW, cooldownMin });
    expect(r.blocked).toBe(false);
  });

  it("C2 is direction-symmetric (short re-entry after a long close is also blocked)", () => {
    const l = ledger([
      { ticker: "TSLA", signal: "SL", status: "closed", openedAt: new Date(NOW - 4 * 3600_000), closedAt: new Date(NOW - 10 * 60_000) },
    ]);
    const r = isChurnBlocked({ ticker: "TSLA", direction: "short", automatedToday: l.automatedToday, lastCloseAt: l.lastCloseAt, nowMs: NOW, cooldownMin });
    expect(r.blocked).toBe(true);
  });
});

describe("30-Jun replay — AAPL #2/#3 SKIP", () => {
  it("AAPL opened + closed same day → C1 blocks the re-entry", () => {
    const l = ledger([
      { ticker: "AAPL", signal: "GOLD_RETEST_WAR", status: "closed", openedAt: new Date(NOW - 4 * 3600_000), closedAt: new Date(NOW - 40 * 60_000) },
    ]);
    // Both C1 (opened today automated) and C2 (closed 40m ago) fire — C1 first.
    const r = isChurnBlocked({ ticker: "AAPL", direction: "long", automatedToday: l.automatedToday, lastCloseAt: l.lastCloseAt, nowMs: NOW, cooldownMin });
    expect(r.blocked).toBe(true);
  });
});

describe("INERT — flag=0 wiring is byte-identical (source guard)", () => {
  const warSrc = readFileSync(join(__dirname, "warEngine.ts"), "utf8");
  const execSrc = readFileSync(join(__dirname, "liveOrderExecutor.ts"), "utf8");

  it("warEngine builds the ledger ONLY behind entryChurnGuardEnabled===1", () => {
    expect(warSrc).toMatch(/_churnGuardOn\s*=\s*\(\(cfgKv as any\)\?\.entryChurnGuardEnabled\s*\?\?\s*0\)\s*===\s*1/);
    // The DB read is inside `if (_churnGuardOn)` — no read when the flag is off.
    expect(warSrc).toMatch(/if \(_churnGuardOn\) \{[\s\S]*?buildChurnLedger/);
    // The per-candidate skip is also gated.
    expect(warSrc).toMatch(/if \(_churnGuardOn\) \{[\s\S]*?isChurnBlocked/);
  });

  it("tryLiveEntry churn check is gated + skips MANUAL_% + exempts the Waiter", () => {
    expect(execSrc).toMatch(/entryChurnGuardEnabled\s*\?\?\s*0\)\s*===\s*1/);
    expect(execSrc).toMatch(/isAutomatedSignal\(signal\)/);
    expect(execSrc).toMatch(/GOLD_RETEST_WAITER/);
  });

  it("empty ledger (flag-off default) never blocks", () => {
    const l = ledger([]);
    const r = isChurnBlocked({ ticker: "ANY", direction: "long", automatedToday: l.automatedToday, lastCloseAt: l.lastCloseAt, nowMs: NOW, cooldownMin });
    expect(r.blocked).toBe(false);
  });
});

describe("startOfIsraelDayMs", () => {
  it("returns an instant <= now and within the last 24h", () => {
    const s = startOfIsraelDayMs(NOW);
    expect(s).toBeLessThanOrEqual(NOW);
    expect(NOW - s).toBeLessThanOrEqual(24 * 3600_000);
  });
});
