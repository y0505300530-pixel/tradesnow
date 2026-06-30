/**
 * Unit tests for server/logger.ts
 *
 * Tests:
 *  - log.info / log.warn / log.error / log.debug write to the ring buffer
 *  - getRecentLogs returns newest-first order
 *  - getRecentLogs level filter (min-level semantics)
 *  - getRecentLogs category filter
 *  - getRecentLogs limit
 *  - Ring buffer caps at RING_SIZE (500) — oldest entry is evicted
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── We need to reset the module between tests so the ring buffer starts empty ──
// We do this by re-importing the module inside each describe block.
// Vitest supports module isolation with vi.resetModules().

describe("logger — basic emit", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("log.info writes an INFO entry to the ring buffer", async () => {
    const { log, getRecentLogs } = await import("./logger");
    log.info("SYSTEM", "test info message", { key: "value" });
    const entries = getRecentLogs();
    expect(entries.length).toBeGreaterThan(0);
    const last = entries[0]; // newest first
    expect(last.level).toBe("INFO");
    expect(last.category).toBe("SYSTEM");
    expect(last.msg).toBe("test info message");
    expect(last.data).toEqual({ key: "value" });
  });

  it("log.warn writes a WARN entry", async () => {
    const { log, getRecentLogs } = await import("./logger");
    log.warn("AUTH", "auth warning");
    const entries = getRecentLogs({ category: "AUTH" });
    expect(entries[0].level).toBe("WARN");
  });

  it("log.error writes an ERROR entry", async () => {
    const { log, getRecentLogs } = await import("./logger");
    log.error("ORDER", "order failed", { ticker: "AAPL" });
    const entries = getRecentLogs({ category: "ORDER" });
    expect(entries[0].level).toBe("ERROR");
    expect(entries[0].data).toEqual({ ticker: "AAPL" });
  });

  it("log.debug writes a DEBUG entry", async () => {
    const { log, getRecentLogs } = await import("./logger");
    log.debug("IBKR", "debug ping");
    const entries = getRecentLogs({ category: "IBKR" });
    expect(entries[0].level).toBe("DEBUG");
  });
});

describe("logger — getRecentLogs filtering", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns entries newest-first", async () => {
    const { log, getRecentLogs } = await import("./logger");
    log.info("SYSTEM", "first");
    log.info("SYSTEM", "second");
    log.info("SYSTEM", "third");
    const entries = getRecentLogs({ category: "SYSTEM" });
    expect(entries[0].msg).toBe("third");
    expect(entries[1].msg).toBe("second");
    expect(entries[2].msg).toBe("first");
  });

  it("level filter: WARN returns WARN and ERROR but not INFO or DEBUG", async () => {
    const { log, getRecentLogs } = await import("./logger");
    log.debug("SYSTEM", "d");
    log.info("SYSTEM", "i");
    log.warn("SYSTEM", "w");
    log.error("SYSTEM", "e");
    const entries = getRecentLogs({ level: "WARN" });
    const levels = entries.map((e) => e.level);
    expect(levels).not.toContain("DEBUG");
    expect(levels).not.toContain("INFO");
    expect(levels).toContain("WARN");
    expect(levels).toContain("ERROR");
  });

  it("level filter: ERROR returns only ERROR", async () => {
    const { log, getRecentLogs } = await import("./logger");
    log.info("SYSTEM", "info");
    log.error("SYSTEM", "err");
    const entries = getRecentLogs({ level: "ERROR" });
    const levels = entries.map((e) => e.level);
    expect(levels).not.toContain("INFO");
    expect(levels).toContain("ERROR");
  });

  it("category filter returns only matching category", async () => {
    const { log, getRecentLogs } = await import("./logger");
    log.info("IBKR", "ibkr msg");
    log.info("AUTH", "auth msg");
    log.info("ORDER", "order msg");
    const entries = getRecentLogs({ category: "AUTH" });
    expect(entries.every((e) => e.category === "AUTH")).toBe(true);
    expect(entries.length).toBe(1);
  });

  it("limit caps the number of returned entries", async () => {
    const { log, getRecentLogs } = await import("./logger");
    for (let i = 0; i < 20; i++) log.info("SYSTEM", `msg ${i}`);
    const entries = getRecentLogs({ limit: 5 });
    expect(entries.length).toBe(5);
  });
});

describe("logger — ring buffer eviction", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("caps at 500 entries and evicts oldest", async () => {
    const { log, getRecentLogs } = await import("./logger");
    // Write 510 entries
    for (let i = 0; i < 510; i++) {
      log.info("SYSTEM", `msg ${i}`);
    }
    const entries = getRecentLogs({ limit: 500 });
    expect(entries.length).toBe(500);
    // Newest entry should be msg 509
    expect(entries[0].msg).toBe("msg 509");
    // Oldest visible entry should be msg 10 (510 - 500 = 10)
    expect(entries[499].msg).toBe("msg 10");
  });
});
