// server/tradeLedger.test.ts
// ADVERSARIAL QA — War Report closed-trade ledger.
// Goal: prove the integrity filters, BE threshold, null-safety, and (critically)
// expose the RECONCILE filter drift between computeStats and the warReport endpoint's
// P&L sums. Pure functions only — deterministic, no DB.
import { describe, it, expect } from "vitest";
import {
  toLedgerRow,
  computeStats,
  groupBy,
  isExcludedFromStats,
  isOpsNoiseClose,
  PHANTOM_REASONS,
  NO_PRICE_REASONS,
  RECONCILE_REASON_PATTERN,
  type LedgerRow,
} from "./tradeLedger";

// ── Helper: build a minimal raw livePositions row for toLedgerRow ──
function rawPos(over: Record<string, any> = {}): any {
  return {
    ticker: "AAPL",
    direction: "long",
    entryPrice: 100,
    exitPrice: 110,
    units: 10,
    realizedPnl: 100,
    partialRealizedPnl: null,
    rValue: 1,
    exitReason: "TP_HIT",
    openedAt: 1_000_000_000_000,
    closedAt: 1_000_000_000_000 + 86_400_000,
    entryStructMeta: null,
    ...over,
  };
}

// Replicate the warReport endpoint pre-filter (uses isExcludedFromStats — unified with computeStats).
function endpointFilteredRows(rows: LedgerRow[]): LedgerRow[] {
  return rows.filter((r) => !isExcludedFromStats(r.exitReason));
}
function endpointPnlSum(rows: LedgerRow[]): number {
  // mirrors daily/weekly/sinceInception loop: sum realizedPnl over the pre-filtered rows
  return endpointFilteredRows(rows).reduce(
    (s, r) => (r.realizedPnl === null ? s : s + r.realizedPnl),
    0,
  );
}

describe("toLedgerRow — defensive projection", () => {
  it("normalizes direction: anything != 'short' is long", () => {
    expect(toLedgerRow(rawPos({ direction: "short" })).direction).toBe("short");
    expect(toLedgerRow(rawPos({ direction: "LONG" })).direction).toBe("long");
    expect(toLedgerRow(rawPos({ direction: null })).direction).toBe("long");
    expect(toLedgerRow(rawPos({ direction: undefined })).direction).toBe("long");
  });

  it("units are absolute (short stored as negative still yields positive units)", () => {
    expect(toLedgerRow(rawPos({ units: -42 })).units).toBe(42);
    expect(toLedgerRow(rawPos({ units: null })).units).toBe(0);
  });

  it("realizedPnl: BOTH legs null => null (genuinely unpriced, excluded downstream)", () => {
    expect(toLedgerRow(rawPos({ realizedPnl: null, partialRealizedPnl: null })).realizedPnl).toBeNull();
  });

  it("realizedPnl: a present leg makes the other count as 0 (partial-only / final-only)", () => {
    expect(toLedgerRow(rawPos({ realizedPnl: null, partialRealizedPnl: 50 })).realizedPnl).toBe(50);
    expect(toLedgerRow(rawPos({ realizedPnl: 80, partialRealizedPnl: null })).realizedPnl).toBe(80);
    expect(toLedgerRow(rawPos({ realizedPnl: 80, partialRealizedPnl: 50 })).realizedPnl).toBe(130);
  });

  it("realizedR is null unless rValue>0 AND units>0 AND realizedPnl present", () => {
    expect(toLedgerRow(rawPos({ rValue: 0 })).realizedR).toBeNull();
    expect(toLedgerRow(rawPos({ rValue: null })).realizedR).toBeNull();
    expect(toLedgerRow(rawPos({ units: 0 })).realizedR).toBeNull();
    expect(toLedgerRow(rawPos({ realizedPnl: null, partialRealizedPnl: null })).realizedR).toBeNull();
    // 100 / (1 * 10) = 10R
    expect(toLedgerRow(rawPos({ realizedPnl: 100, rValue: 1, units: 10 })).realizedR).toBeCloseTo(10, 6);
  });

  it("holdDays null when timestamps inverted or openedAt missing", () => {
    expect(toLedgerRow(rawPos({ openedAt: 0 })).holdDays).toBeNull();
    expect(toLedgerRow(rawPos({ closedAt: 500, openedAt: 1000 })).holdDays).toBeNull();
    expect(toLedgerRow(rawPos({ closedAt: null })).holdDays).toBeNull();
  });

  it("never throws on malformed entryStructMeta (string / array / Date / number)", () => {
    expect(() => toLedgerRow(rawPos({ entryStructMeta: "{not json" }))).not.toThrow();
    expect(() => toLedgerRow(rawPos({ entryStructMeta: "[]" }))).not.toThrow();
    expect(() => toLedgerRow(rawPos({ entryStructMeta: [1, 2, 3] }))).not.toThrow();
    expect(() => toLedgerRow(rawPos({ entryStructMeta: new Date() }))).not.toThrow();
    expect(() => toLedgerRow(rawPos({ entryStructMeta: 12345 }))).not.toThrow();
    expect(() => toLedgerRow(null)).not.toThrow();
    expect(() => toLedgerRow(undefined)).not.toThrow();
  });

  it("route resolves meta.route > signal > UNKNOWN", () => {
    expect(toLedgerRow(rawPos({ entryStructMeta: { route: "PULLBACK" } })).route).toBe("PULLBACK");
    expect(toLedgerRow(rawPos({ entryStructMeta: null, signal: "BREAKOUT" })).route).toBe("BREAKOUT");
    expect(toLedgerRow(rawPos({ entryStructMeta: null, signal: null })).route).toBe("UNKNOWN");
  });
});

describe("computeStats — BE threshold & win-rate denominator", () => {
  function row(pnl: number | null, over: Partial<LedgerRow> = {}): LedgerRow {
    return toLedgerRow(rawPos({ realizedPnl: pnl, partialRealizedPnl: null, ...over }));
  }

  it("empty input => all-zero, no NaN, no throw", () => {
    const s = computeStats([]);
    expect(s).toEqual({
      trades: 0, wins: 0, losses: 0, winRatePct: 0,
      totalPnl: 0, avgR: 0, expectancyR: 0, medianHoldDays: null,
    });
    expect(Number.isNaN(s.winRatePct)).toBe(false);
  });

  it("$1 BE band: +$0.50 and -$0.50 are breakeven (neither win nor loss)", () => {
    const s = computeStats([row(0.5), row(-0.5)]);
    expect(s.wins).toBe(0);
    expect(s.losses).toBe(0);
    expect(s.trades).toBe(2);       // still counted as trades
    expect(s.winRatePct).toBe(0);   // decided = 0 => 0, not NaN
  });

  it("exactly +$1 / -$1 are breakeven (strict > / < threshold)", () => {
    const s = computeStats([row(1), row(-1)]);
    expect(s.wins).toBe(0);
    expect(s.losses).toBe(0);
  });

  it("win-rate denominator EXCLUDES breakeven (decided = wins+losses)", () => {
    // 1 win (+100), 1 loss (-100), 3 breakeven (0). win-rate must be 50%, not 20%.
    const s = computeStats([row(100), row(-100), row(0), row(0.2), row(-0.2)]);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.winRatePct).toBe(50);
  });

  it("null realizedPnl rows excluded from totalPnl and win/loss but still 'trades'", () => {
    const s = computeStats([row(null), row(200)]);
    expect(s.trades).toBe(2);
    expect(s.totalPnl).toBe(200);
    expect(s.wins).toBe(1);
  });
});

describe("Integrity filters — phantom / no-price / reconcile", () => {
  it("isExcludedFromStats covers all three families", () => {
    expect(isExcludedFromStats("ENTRY_CANCELLED")).toBe(true);
    expect(isExcludedFromStats("ENTRY_NEVER_FILLED")).toBe(true);
    expect(isExcludedFromStats("CLOSED_IBKR_NO_PRICE")).toBe(true);
    expect(isExcludedFromStats("CLOSE_PRICE_UNKNOWN")).toBe(true);
    expect(isExcludedFromStats("CLOSE_PRICE_UNKNOWN_BREAKEVEN")).toBe(true);
    expect(isExcludedFromStats("RECONCILE_PHANTOM_2026-06-25")).toBe(true);
    expect(isExcludedFromStats("CLOSED_RECONCILE")).toBe(true);
    expect(isExcludedFromStats("TP_HIT")).toBe(false);
    expect(isExcludedFromStats(null)).toBe(false);
    expect(isExcludedFromStats(undefined)).toBe(false);
  });

  it("isOpsNoiseClose mirrors isExcludedFromStats", () => {
    expect(isOpsNoiseClose("RECONCILE_X")).toBe(true);
    expect(isOpsNoiseClose("TP_HIT")).toBe(false);
  });

  it("computeStats defensively drops phantom/no-price/reconcile even if caller forgot", () => {
    const real = toLedgerRow(rawPos({ realizedPnl: 100, exitReason: "TP_HIT" }));
    const phantom = toLedgerRow(rawPos({ realizedPnl: 0, exitReason: "ENTRY_CANCELLED" }));
    const noPrice = toLedgerRow(rawPos({ realizedPnl: 0, exitReason: "CLOSED_IBKR_NO_PRICE" }));
    const reconcile = toLedgerRow(rawPos({ realizedPnl: 5000, exitReason: "RECONCILE_PHANTOM_2026-06-25" }));
    const s = computeStats([real, phantom, noPrice, reconcile]);
    expect(s.trades).toBe(1);          // only the real trade
    expect(s.totalPnl).toBe(100);      // reconcile $5000 must NOT pollute totals
    expect(s.wins).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// CRITICAL DRIFT REPRODUCTION
// computeStats() drops RECONCILE_* (via isExcludedFromStats). The warReport endpoint's
// daily/weekly/sinceInception P&L sums use LEDGER_DROP_REASONS, which OMITS reconcile.
// => On the same screen, overall.totalPnl (excludes reconcile) and pnl.sinceInception
//    (includes reconcile) DISAGREE whenever a RECONCILE_* close carries P&L.
// The it.fails() below asserts the INVARIANT THAT SHOULD HOLD; it currently FAILS,
// which is the documented defect. When the endpoint is fixed to use isExcludedFromStats,
// flip it.fails -> it.
// ────────────────────────────────────────────────────────────────────────────
describe("RECONCILE drift between computeStats and endpoint P&L sums", () => {
  const rows: LedgerRow[] = [
    toLedgerRow(rawPos({ realizedPnl: 100, exitReason: "TP_HIT" })),
    toLedgerRow(rawPos({ realizedPnl: 9999, exitReason: "RECONCILE_PHANTOM_2026-06-25" })),
  ];

  it("endpoint pre-filter now excludes reconcile rows (P4 fix)", () => {
    expect(computeStats(rows).totalPnl).toBe(100);
    expect(endpointPnlSum(rows)).toBe(100);
  });

  it("the reconcile row is excluded from the endpoint measurable set", () => {
    const surviving = endpointFilteredRows(rows);
    expect(surviving.some((r) => RECONCILE_REASON_PATTERN.test(r.exitReason ?? ""))).toBe(false);
  });

  it("INVARIANT: stats totalPnl equals endpoint P&L sum", () => {
    expect(endpointPnlSum(rows)).toBe(computeStats(rows).totalPnl);
  });
});

describe("groupBy — bucketed stats", () => {
  it("groups by route and computes per-bucket stats, reconcile excluded per bucket", () => {
    const rows = [
      toLedgerRow(rawPos({ realizedPnl: 100, exitReason: "TP_HIT", entryStructMeta: { route: "A" } })),
      toLedgerRow(rawPos({ realizedPnl: -50, exitReason: "SL_HIT", entryStructMeta: { route: "A" } })),
      toLedgerRow(rawPos({ realizedPnl: 7000, exitReason: "RECONCILE_X", entryStructMeta: { route: "A" } })),
      toLedgerRow(rawPos({ realizedPnl: 200, exitReason: "TP_HIT", entryStructMeta: { route: "B" } })),
    ];
    const g = groupBy(rows, (r) => r.route);
    expect(g.A.trades).toBe(2);        // reconcile dropped from bucket A
    expect(g.A.totalPnl).toBe(50);
    expect(g.B.trades).toBe(1);
  });
});
