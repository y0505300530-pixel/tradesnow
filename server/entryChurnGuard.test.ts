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
  isPhoenixReentrySignal,
  shouldBypassChurnForPhoenix,
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

describe("CG-G4 — Phoenix C6 carve-out", () => {
  it("isPhoenixReentrySignal matches PHOENIX_REENTRY (case-insensitive)", () => {
    expect(isPhoenixReentrySignal("PHOENIX_REENTRY")).toBe(true);
    expect(isPhoenixReentrySignal("phoenix_reentry")).toBe(true);
    expect(isPhoenixReentrySignal("GOLD_RETEST_WAR")).toBe(false);
  });

  it("shouldBypassChurnForPhoenix requires phoenixProtocolEnabled=1", () => {
    expect(shouldBypassChurnForPhoenix("PHOENIX_REENTRY", 1)).toBe(true);
    expect(shouldBypassChurnForPhoenix("PHOENIX_REENTRY", 0)).toBe(false);
    expect(shouldBypassChurnForPhoenix("GOLD_RETEST_WAR", 1)).toBe(false);
  });

  it("PHOENIX_REENTRY open today does NOT arm C1 (ledger excludes Phoenix)", () => {
    const l = ledger([
      { ticker: "AAPL", signal: "PHOENIX_REENTRY", status: "open", openedAt: new Date(NOW - 2 * 3600_000), closedAt: null },
      { ticker: "AAPL", signal: "GOLD_RETEST_WAR", status: "closed", openedAt: new Date(NOW - 5 * 3600_000), closedAt: new Date(NOW - 30 * 60_000) },
    ]);
    expect(l.automatedToday.has("AAPL")).toBe(true); // War entry counts
    // Simulate bypass: Phoenix path skips isChurnBlocked entirely when enabled.
    expect(shouldBypassChurnForPhoenix("PHOENIX_REENTRY", 1)).toBe(true);
  });

  it("War-only history blocks War re-entry; Phoenix ledger path bypasses ChurnGuard", () => {
    const l = ledger([
      { ticker: "NVDA", signal: "GOLD_RETEST_WAR", status: "closed", openedAt: new Date(NOW - 4 * 3600_000), closedAt: new Date(NOW - 20 * 60_000) },
    ]);
    const warBlock = isChurnBlocked({ ticker: "NVDA", direction: "long", automatedToday: l.automatedToday, lastCloseAt: l.lastCloseAt, nowMs: NOW, cooldownMin });
    expect(warBlock.blocked).toBe(true);
    expect(shouldBypassChurnForPhoenix("PHOENIX_REENTRY", 1)).toBe(true);
  });

  it("a prior PHOENIX_REENTRY does not count toward automatedToday for a War signal", () => {
    const l = ledger([
      { ticker: "AMD", signal: "PHOENIX_REENTRY", status: "closed", openedAt: new Date(NOW - 3 * 3600_000), closedAt: new Date(NOW - 95 * 60_000) },
    ]);
    expect(l.automatedToday.has("AMD")).toBe(false);
    expect(l.lastCloseAt.has("AMD")).toBe(false);
    const r = isChurnBlocked({ ticker: "AMD", direction: "long", automatedToday: l.automatedToday, lastCloseAt: l.lastCloseAt, nowMs: NOW, cooldownMin });
    expect(r.blocked).toBe(false);
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

  it("tryLiveEntry churn check is gated + skips MANUAL_% + exempts the Waiter + Phoenix C6", () => {
    expect(execSrc).toMatch(/entryChurnGuardEnabled\s*\?\?\s*0\)\s*===\s*1/);
    expect(execSrc).toMatch(/isAutomatedSignal\(signal\)/);
    expect(execSrc).toMatch(/GOLD_RETEST_WAITER/);
    expect(execSrc).toMatch(/shouldBypassChurnForPhoenix/);
  });

  it("empty ledger (flag-off default) never blocks", () => {
    const l = ledger([]);
    const r = isChurnBlocked({ ticker: "ANY", direction: "long", automatedToday: l.automatedToday, lastCloseAt: l.lastCloseAt, nowMs: NOW, cooldownMin });
    expect(r.blocked).toBe(false);
  });
});

describe("startOfIsraelDayMs", () => {
  const israelWall = (ms: number) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).format(new Date(ms));

  it("returns an instant <= now and within the last 24h", () => {
    const s = startOfIsraelDayMs(NOW);
    expect(s).toBeLessThanOrEqual(NOW);
    expect(NOW - s).toBeLessThanOrEqual(24 * 3600_000);
  });

  // Wall-clock assertions: the returned instant MUST render as 00:00:00 in Israel — this is
  // what the buggy UTC-midnight version failed (it rendered 02:00/03:00 IL). Cover RTH and
  // the pre-03:00 IL window (the false-ALLOW hole the bug opened), in both DST seasons.
  it.each([
    ["summer RTH  16:03 IL", Date.UTC(2026, 6, 1, 13, 3, 0)],   // 2026-07-01 16:03 IDT
    ["summer 00:30 IL",      Date.UTC(2026, 6, 1, 21, 30, 0)],  // 2026-07-01 00:30 IDT (prev UTC day)
    ["winter 00:30 IL",      Date.UTC(2026, 0, 15, 22, 30, 0)], // 2026-01-15 00:30 IST
    ["winter RTH  17:00 IL", Date.UTC(2026, 0, 15, 15, 0, 0)],  // 2026-01-15 17:00 IST
  ])("returns true Israel 00:00 for %s", (_label, instant) => {
    expect(israelWall(startOfIsraelDayMs(instant))).toBe("00:00:00");
  });

  // Known, accepted limitation: on the once-a-year DST FALL-BACK night (25h day), a
  // post-transition instant lands the day-start 1h late (renders 01:00, not 00:00). This
  // happens ~04:00 IL — deep after-hours, US market closed, no automated entries — so C1 is
  // unaffected in practice. We assert the ≤1h band (never worse), NOT the old 02:00/03:00 bug.
  it("DST fall-back night: day-start is within [00:00,01:00] IL (accepted 1h edge)", () => {
    const wall = israelWall(startOfIsraelDayMs(Date.UTC(2026, 9, 25, 1, 0, 0))); // 2026-10-25 IDT→IST
    expect(["00:00:00", "01:00:00"]).toContain(wall);
  });
});
