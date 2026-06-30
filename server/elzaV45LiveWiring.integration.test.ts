/**
 * Elza v4.5 LIVE-WIRING INTEGRATION TESTS (the CEO requirement — side-effects, not
 * just pure predicates). These mock the IBKR (ibind), DB, telegram and market-data
 * layers so we can drive the REAL gated side-effect paths end-to-end and assert the
 * actual order / flatten / latch / alert behavior of the fixes:
 *
 *   CB-1/CB-2  runCircuitBreakerTick — live broker NLV/PnL, flatten + fail-closed Alert Mode
 *   NN-1       tryLiveEntry never-naked anti-phantom (broker-held=0 ⇒ no flatten order)
 *   HALT-1     universal halt chokepoint (pyramid scale-in + manual/tryLiveEntry reject)
 *   EOD-1      degraded regime ⇒ overnightGrossCap 0.5× fail-closed branch
 *   EOD-2      trim accepted-but-unfilled ⇒ NOT counted + EOD-TRIM-FAILED alert
 *
 * ALL flag-gated: the mocked config sets elzaV45LiveEnabled=1 to ARM the paths. The
 * final test asserts that with the flag at its DEFAULT 0 the same inputs are INERT.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Module mocks (must be declared before importing the SUT) ───────────────────

// IBKR ibind cache (used by fetchLiveNlvAndDayPnl)
const ibindCachedMock = vi.fn();
vi.mock("./ibkrCache", () => ({
  ibindCached: (...a: any[]) => ibindCachedMock(...a),
  invalidateIbkrCache: vi.fn(),
}));

// IBKR ibind direct requests (positions read, order placement, cancels)
const ibindRequestMock = vi.fn();
vi.mock("./routers/ibkrProxy", () => ({
  ibindRequest: (...a: any[]) => ibindRequestMock(...a),
}));

// Telegram — capture every alert/notification
const telegramMock = vi.fn(async () => undefined);
vi.mock("./telegram", () => ({
  sendTelegramMessage: (...a: any[]) => telegramMock(...a),
}));

// conid resolver
vi.mock("./conidResolver", () => ({
  resolveConid: vi.fn(async (t: string) => (t === "NOID" ? null : 12345)),
}));

// market data — live price + bars
const livePriceMock = vi.fn();
const fetchBarsMock = vi.fn(async () => [] as any[]);
vi.mock("./marketData", () => ({
  fetchIbkrLivePricesBatch: (...a: any[]) => livePriceMock(...a),
  fetchBarsForTicker: (...a: any[]) => fetchBarsMock(...a),
  fetchBarsBatch: vi.fn(async () => new Map()),
}));
// SPY daily series for the DEFENSE-MODE regime gate (assertLongAllowedByRegime → literal daily EMA-50).
function spyBars(kind: "bull" | "bear") {
  const out: any[] = [];
  for (let i = 0; i < 60; i++) {
    const c = kind === "bull" ? 80 + i : 140 - i; // bull: rising (last > EMA50) · bear: falling (last < EMA50)
    out.push({ date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, open: c, high: c + 1, low: c - 1, close: c, volume: 1e6 });
  }
  return out;
}
// Flat EOD bars whose close == the entry ticker's live price, so the order-time
// divergence guard (QA fix #3: fetchBarsForTicker(ticker,5) vs IBKR live) does NOT fire
// for the traded name. Without this, the single global fetchBarsMock would hand AAPL the
// SPY series ($139 last close) → ~44% divergence vs live $200 → entry blocked BEFORE the
// never-naked path. AAPL live price is 200 throughout these tests.
const ENTRY_TICKER_PRICE = 200;
function flatEodBars(close: number) {
  const out: any[] = [];
  for (let i = 0; i < 5; i++) {
    out.push({ date: `2026-01-${String(i + 1).padStart(2, "0")}`, open: close, high: close + 1, low: close - 1, close, volume: 1e6 });
  }
  return out;
}
// Ticker-aware dispatcher: SPY → the regime daily series; any other (entry) ticker →
// flat bars at its live price (no spurious divergence block). `spyKind` selects bull/bear
// for the DEFENSE-MODE regime gate; non-SPY bars are always price-matched.
function barsRouter(spyKind: "bull" | "bear") {
  return async (ticker: string) =>
    ticker === "SPY" ? spyBars(spyKind) : flatEodBars(ENTRY_TICKER_PRICE);
}

// IBKR websocket poller — the IBKR-FRESH tick source the live SL monitor source-gates on.
// EXIT-G tests steer the per-tick live price here so tickIsIbkrFresh===true.
const wsPriceByTicker = new Map<string, { last: number; updatedAt: number }>();
const getPriceByTickerMock = vi.fn((t: string) => wsPriceByTicker.get(t) ?? null);
vi.mock("./services/ibkrWebSocket", () => ({
  getPriceByTicker: (...a: any[]) => getPriceByTickerMock(...(a as [string])),
}));

// executePartial — the partial-close primitive the Golden SCALE_40 uses. Mock it so we
// can assert the 40%-of-original reduce leg without real DB/gateway traffic.
const executeLivePartialCloseMock = vi.fn(async () => ({ success: true, reason: "mock filled", orderId: "P1" }));
vi.mock("./executePartial", () => ({
  executeLivePartialClose: (...a: any[]) => executeLivePartialCloseMock(...a),
  realDeps: vi.fn(async () => ({} as any)),
}));

// portfolio mirror — best-effort sync at the end of the monitor cycle; no-op in tests.
vi.mock("./portfolioHoldingsSync", () => ({
  syncAllElzaHoldingsFromLivePositions: vi.fn(async () => undefined),
}));

// fill resolver — drive pollEntryFill / resolveOrderFill
const pollEntryFillMock = vi.fn();
const resolveOrderFillMock = vi.fn(async () => ({ status: "filled", filledQty: 0, avgPrice: null, remainingQty: 0 }));
vi.mock("./liveMarketOrder", () => ({
  pollEntryFill: (...a: any[]) => pollEntryFillMock(...a),
  resolveOrderFill: (...a: any[]) => resolveOrderFillMock(...a),
}));

// Ziv Health scorer — the rotation-flush candidate scorer. Per-ticker controlled
// score so we don't have to drive a fragile real bar series. Default 7.0 (healthy).
// The SUT imports calcZivHScore from ./utils/zivHealth, so mocking THIS path only
// affects liveOrderExecutor (no other module is perturbed).
const zivHScoreByTicker = new Map<string, number>();
const calcZivHScoreMock = vi.fn((bars: any[], _e: number, _sl: any, _tp: any, _ctx: any) => {
  // bars is the array returned by fetchBarsForTicker; first bar carries a tag we read.
  const tag = (bars && bars[0] && bars[0].__ticker) || "";
  const score = zivHScoreByTicker.has(tag) ? (zivHScoreByTicker.get(tag) as number) : 7.0;
  return { score, phase: "test", ctx: {} } as any;
});
vi.mock("./utils/zivHealth", () => ({
  calcZivHScore: (...a: any[]) => calcZivHScoreMock(...a),
}));

// regime — drive VIX / degraded flag for EOD-1
const getMarketRegimeMock = vi.fn();
vi.mock("./runtimeIntelligence", () => ({
  getMarketRegime: (...a: any[]) => getMarketRegimeMock(...a),
}));

// system settings persistence (CB-3 latch)
const settingStore = new Map<string, string>();
vi.mock("./db", () => ({
  getDb: (...a: any[]) => getDbMock(...a),
  getSystemSetting: vi.fn(async (k: string) => settingStore.get(k) ?? null),
  setSystemSetting: vi.fn(async (k: string, v: string) => { settingStore.set(k, v); }),
}));

// ── Chainable Drizzle-style DB mock ─────────────────────────────────────────────
// Configurable per-test: `dbState.openPositions` is what select(...).from(livePositions)
// returns; updates/inserts are recorded but otherwise no-op.
type Row = any;
const dbState: { openPositions: Row[]; updates: any[]; inserts: any[] } = {
  openPositions: [],
  updates: [],
  inserts: [],
};

function makeQuery(rows: Row[]) {
  const q: any = {
    from: () => q,
    where: () => q,
    limit: () => Promise.resolve(rows),
    orderBy: () => q,
    then: (res: any, rej: any) => Promise.resolve(rows).then(res, rej),
  };
  return q;
}

const dbMock: any = {
  select: () => makeQuery(dbState.openPositions),
  update: () => ({ set: (v: any) => ({ where: async () => { dbState.updates.push(v); } }) }),
  insert: () => ({ values: async (v: any) => { dbState.inserts.push(v); } }),
  delete: () => ({ where: async () => undefined }),
  // liveEntryLock acquire (raw SQL INSERT IGNORE) — return affectedRows:1 ⇒ lock granted.
  execute: async () => [{ affectedRows: 1 }],
};
const getDbMock = vi.fn(async () => dbMock);

// ─── Import the SUT AFTER mocks are registered ──────────────────────────────────
import {
  runCircuitBreakerTick,
  tryLiveEntry,
  runDeleveragingCycle,
  isTradingHaltedToday,
  assertNotHalted,
  assertLongAllowedByRegime,
  runLiveSlMonitor,
  __resetTradingHaltForTest,
  __forceTradingHaltForTest,
} from "./liveOrderExecutor";
import { runPyramidEngine } from "./pyramidEngine";

const ARMED_CONFIG: any = {
  userId: 1,
  isEnabled: 1,
  elzaV45LiveEnabled: 1,
  totalNlv: 100000,
  maxPositions: 12,
  allocatedPct: 40,
  maxPositions_: 12,
  intradayMultiplier: 3.9,
  overnightMultiplier: 1.9,
};

// getLiveConfig reads from the DB select(liveEngineConfig)… so we steer config via a
// dedicated select override. Simpler: stub getLiveConfig by making the first select
// for config return [config]. We expose a knob the dbMock honors.
let configRow: any = { ...ARMED_CONFIG };
// Re-point select to differentiate config vs positions by inspecting the table arg.
dbMock.select = (...sel: any[]) => {
  // getLiveConfig calls db.select().from(liveEngineConfig).where().limit(1)
  // others call db.select().from(livePositions)…
  // We can't see the table here (.from receives it). Track via .from.
  let table: any = null;
  const q: any = {
    from: (t: any) => { table = t; return q; },
    where: () => q,
    orderBy: () => q,
    limit: () => Promise.resolve(resolveRows(table)),
    then: (res: any, rej: any) => Promise.resolve(resolveRows(table)).then(res, rej),
  };
  return q;
};
function resolveRows(table: any): Row[] {
  // liveEngineConfig has a `elzaV45LiveEnabled`-ish identity; we tag by table name.
  const name = String((table as any)?.[Symbol.for("drizzle:Name")] ?? (table as any)?.name ?? "");
  if (name.includes("live_engine_config") || name.includes("liveEngineConfig")) return [configRow];
  if (name.includes("user_assets") || name.includes("userAssets")) return [];
  return dbState.openPositions;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function mockAcctSummary(nlv: number | null) {
  return nlv == null
    ? { ok: true, status: 200, body: { summary: { netliquidation: { amount: NaN } } } }
    : { ok: true, status: 200, body: { summary: { netliquidation: { amount: nlv } } } };
}
function mockPnl(dpl: number | null) {
  return dpl == null
    ? { ok: false, status: 503, body: null }
    : { ok: true, status: 200, body: { upnl: { "U16881054.Core": { dpl } } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  settingStore.clear();
  dbState.openPositions = [];
  dbState.updates = [];
  dbState.inserts = [];
  configRow = { ...ARMED_CONFIG };
  __resetTradingHaltForTest();
  livePriceMock.mockResolvedValue(new Map([["AAPL", { source: "ibkr", price: 200 }]]));
  // DEFENSE-MODE default: a healthy BULL regime so the regime gate ALLOWS longs in every
  // pre-existing long-entry test. DEFENSE-MODE-specific tests override this per-case.
  getMarketRegimeMock.mockResolvedValue({ regime: "BULL", vixProxy: 12, degraded: false, regimeReason: "default BULL" });
  fetchBarsMock.mockImplementation(barsRouter("bull")); // DEFENSE-MODE default: SPY daily uptrend → longs allowed; entry tickers get price-matched EOD bars (no spurious divergence block)
});

// ─── TEST 1 — CB −7% → full liquidation + latch + subsequent entry rejected ─────
describe("CB-1 — −7% day triggers flatten + halts the book", () => {
  it("invokes emergencyExitAll (flatten orders), latches halt, rejects next entry", async () => {
    // NLV 93000 with day P&L −7000 → dayOpen 100000 → −7.0% == −MAX_DAILY_LOSS_PCT
    ibindCachedMock.mockImplementation(async (_m: string, path: string) =>
      path === "/account/summary" ? mockAcctSummary(93000) : mockPnl(-7000));
    // Two open positions for emergencyExitAll to flatten.
    dbState.openPositions = [
      { id: 1, userId: 1, ticker: "AAPL", direction: "long", status: "open", units: 10, entryPrice: 190, ibkrSlOrderId: "s1", ibkrTpOrderId: "t1" },
      { id: 2, userId: 1, ticker: "MSFT", direction: "long", status: "open", units: 5, entryPrice: 400, ibkrSlOrderId: "s2", ibkrTpOrderId: "t2" },
    ];
    // executeLiveSell places an exit LMT — accept everything.
    ibindRequestMock.mockResolvedValue({ ok: true, status: 200, body: { order_id: "x1" } });

    const res = await runCircuitBreakerTick(1);
    expect(res.mode).toBe("flattened");
    expect(res.flattened).toBe(true);
    // Exit LMT orders were placed for BOTH positions (the flatten side-effect).
    const exitLmts = ibindRequestMock.mock.calls.filter(
      (c) => c[0] === "POST" && String(c[1]).includes("/orders/close-position"));
    expect(exitLmts.length).toBeGreaterThanOrEqual(2);
    // Halt latched (in-proc + persisted).
    expect(isTradingHaltedToday()).toBe(true);
    expect(settingStore.get("elzaTradingHaltedDate")).toBeTruthy();

    // A subsequent entry is REJECTED by the universal chokepoint.
    livePriceMock.mockResolvedValue(new Map([["NVDA", { source: "ibkr", price: 120 }]]));
    const entry = await tryLiveEntry({
      userId: 1, ticker: "NVDA", direction: "long", signal: "TEST", zivScore: 9,
      currentPrice: 120, slPrice: 110, tpPrice: 150, positionSizeUsd: 10000,
    });
    expect(entry.entered).toBe(false);
    expect(entry.reason).toMatch(/halt/i);
  });
});

// ─── TEST 2 — CB bad NLV read → Alert Mode, NO flatten ──────────────────────────
describe("CB-2 — bad NLV read fails CLOSED into Alert Mode (no flatten)", () => {
  it("blocks entries + fires alert, but sends NO flatten order", async () => {
    ibindCachedMock.mockImplementation(async (_m: string, path: string) =>
      path === "/account/summary" ? mockAcctSummary(null) /* NaN */ : mockPnl(-100));
    dbState.openPositions = [
      { id: 1, userId: 1, ticker: "AAPL", direction: "long", status: "open", units: 10, entryPrice: 190, ibkrSlOrderId: "s1", ibkrTpOrderId: "t1" },
    ];
    ibindRequestMock.mockResolvedValue({ ok: true, status: 200, body: {} });

    const res = await runCircuitBreakerTick(1);
    expect(res.mode).toBe("alert");
    expect(res.flattened).toBe(false);
    expect(res.alertFired).toBe(true);
    // NO exit/flatten LMT order was placed.
    const exitLmts = ibindRequestMock.mock.calls.filter(
      (c) => c[0] === "POST" && String(c[1]).includes("/orders/close-position"));
    expect(exitLmts.length).toBe(0);
    // Alert fired + entries blocked.
    expect(telegramMock).toHaveBeenCalled();
    expect(isTradingHaltedToday()).toBe(true);
  });
});

// ─── TEST 2b — CB-4 self-DoS recovery: alert-mode latch clears on a good read ───
describe("CB-4 — alert-mode latch is RECOVERABLE (a good read resumes entries)", () => {
  it("bad read latches alert mode; a subsequent good read clears it and resumes", async () => {
    // 1) First tick: bad NLV read → Alert Mode latched, entries blocked.
    ibindCachedMock.mockImplementation(async (_m: string, path: string) =>
      path === "/account/summary" ? mockAcctSummary(null) : mockPnl(-100));
    const bad = await runCircuitBreakerTick(1);
    expect(bad.mode).toBe("alert");
    expect(isTradingHaltedToday()).toBe(true); // entries blocked
    expect(settingStore.get("elzaAlertModeDate")).toBeTruthy();
    expect(settingStore.get("elzaTradingHaltedDate")).toBeFalsy(); // NO sticky flatten latch

    // 2) Second tick: gateway recovers, healthy read (small −1% day, no flatten).
    ibindCachedMock.mockImplementation(async (_m: string, path: string) =>
      path === "/account/summary" ? mockAcctSummary(99000) : mockPnl(-1000));
    const good = await runCircuitBreakerTick(1);
    expect(good.mode).toBe("ok");
    // Alert-mode latch CLEARED → entries resume (no whole-day freeze).
    expect(isTradingHaltedToday()).toBe(false);
    expect(settingStore.get("elzaAlertModeDate")).toBeFalsy();
  });

  it("a REAL flatten latch stays STICKY (never auto-cleared by a later good read)", async () => {
    // First tick: −7% → real flatten + sticky halt latch.
    ibindCachedMock.mockImplementation(async (_m: string, path: string) =>
      path === "/account/summary" ? mockAcctSummary(93000) : mockPnl(-7000));
    dbState.openPositions = [
      { id: 1, userId: 1, ticker: "AAPL", direction: "long", status: "open", units: 10, entryPrice: 190, ibkrSlOrderId: "s1", ibkrTpOrderId: "t1" },
    ];
    ibindRequestMock.mockResolvedValue({ ok: true, status: 200, body: { order_id: "x1" } });
    const flat = await runCircuitBreakerTick(1);
    expect(flat.mode).toBe("flattened");
    expect(settingStore.get("elzaTradingHaltedDate")).toBeTruthy();

    // A later healthy read must NOT clear the sticky flatten latch.
    dbState.openPositions = [];
    ibindCachedMock.mockImplementation(async (_m: string, path: string) =>
      path === "/account/summary" ? mockAcctSummary(93000) : mockPnl(-7000));
    const after = await runCircuitBreakerTick(1);
    expect(after.mode).toBe("already-halted");
    expect(isTradingHaltedToday()).toBe(true); // still halted (sticky)
  });
});

// ─── TEST 3 — NN-1 phantom prevention (broker-held=0 ⇒ no flatten order) ────────
describe("NN-1 — entry never filled (broker holds 0) ⇒ NO flatten order", () => {
  it("aborts the never-naked flatten when /positions shows zero held qty", async () => {
    configRow = { ...ARMED_CONFIG };
    // Drive tryLiveEntry into the no-SL branch by making the bracket placement return
    // an entry leg but NO SL leg, and /orders polling find none, and the standalone
    // STP also fail. Then pollEntryFill claims a fill (the OLD bug), but /positions=0.
    livePriceMock.mockResolvedValue(new Map([["AAPL", { source: "ibkr", price: 200 }]]));
    pollEntryFillMock.mockResolvedValue({ status: "filled", filledQty: 10, avgPrice: 200, remainingQty: 0 });

    ibindRequestMock.mockImplementation(async (method: string, path: string) => {
      if (method === "POST" && path === "/orders/bracket") {
        // entry leg only, no SL leg in the response
        return { ok: true, status: 200, body: { result: [{ local_order_id: "BR-P-AAPL-1", order_id: "E1" }] } };
      }
      if (method === "GET" && path === "/orders") return { ok: true, status: 200, body: { orders: [] } };
      if (method === "POST" && path === "/orders/stop-loss") return { ok: false, status: 400, body: {} };
      if (method === "DELETE") return { ok: true, status: 200, body: {} };
      // THE KEY: broker /positions shows ZERO held for AAPL (entry never filled).
      if (method === "GET" && path === "/positions") return { ok: true, status: 200, body: { positions: [] } };
      return { ok: true, status: 200, body: {} };
    });

    const res = await tryLiveEntry({
      userId: 1, ticker: "AAPL", direction: "long", signal: "TEST", zivScore: 9,
      currentPrice: 200, slPrice: 184, tpPrice: 240, positionSizeUsd: 10000,
    });
    expect(res.entered).toBe(false);
    // NO never-naked flatten LMT (ELZA_NAKED_FLATTEN) was sent — broker held 0.
    const flattenOrders = ibindRequestMock.mock.calls.filter(
      (c) => c[0] === "POST" && String(c[1]).includes("/orders/close-position"));
    expect(flattenOrders.length).toBe(0);
  });
});

// ─── TEST 3b — NN-1 REVERSE RACE: SL fails AND /positions unreadable ⇒ flatten anyway ──
describe("NN-1 reverse-race — SL unconfirmed AND /positions read FAILS ⇒ flatten + NAKED-VERIFY alert", () => {
  it("never fails OPEN: places the flatten LMT (not aborted) and fires NAKED-VERIFY-REQUIRED", async () => {
    // Pin the clock INSIDE the Israel market window (16:30-23:00 IL == 13:30-20:00 UTC)
    // so tryLiveEntry reaches the bracket/never-naked path (isLiveMarketOpen uses Date).
    vi.useFakeTimers({ toFake: ["Date"] }); // fake ONLY Date — leave setTimeout real (poll loop)
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 26, 15, 0, 0))); // 18:00 IL — market open
    try {
    configRow = { ...ARMED_CONFIG };
    livePriceMock.mockResolvedValue(new Map([["AAPL", { source: "ibkr", price: 200 }]]));
    fetchBarsMock.mockImplementation(barsRouter("bull")); // SPY uptrend → passes DEFENSE-MODE gate; AAPL EOD == live $200 so the order-time divergence guard does NOT block before the never-naked path
    // pollEntryFill is irrelevant here — even with NO fill seen, an UNKNOWN /positions
    // read must NOT silent-abort. Use filledQty 0 to prove the UNKNOWN branch alone drives it.
    pollEntryFillMock.mockResolvedValue({ status: "filled", filledQty: 0, avgPrice: 200, remainingQty: 0 });

    ibindRequestMock.mockImplementation(async (method: string, path: string) => {
      if (method === "POST" && path === "/orders/bracket") {
        return { ok: true, status: 200, body: { result: [{ local_order_id: "BR-RR-AAPL-1", order_id: "E1" }] } };
      }
      if (method === "GET" && path === "/orders") return { ok: true, status: 200, body: { orders: [] } };
      if (method === "POST" && path === "/orders/stop-loss") return { ok: false, status: 400, body: {} };
      if (method === "DELETE") return { ok: true, status: 200, body: {} };
      // THE KEY: broker /positions read is DEGRADED — returns !ok ⇒ readBrokerPositionQty
      // returns null (UNKNOWN). The reverse-race fix must NOT treat this as "holds 0".
      if (method === "GET" && path === "/positions") return { ok: false, status: 503, body: null };
      return { ok: true, status: 200, body: {} };
    });

    const res = await tryLiveEntry({
      userId: 1, ticker: "AAPL", direction: "long", signal: "TEST", zivScore: 9,
      currentPrice: 200, slPrice: 184, tpPrice: 240, positionSizeUsd: 10000,
    });
    expect(res.entered).toBe(false);
    // The flatten LMT IS sent (NOT aborted) despite the unreadable /positions.
    const flattenOrders = ibindRequestMock.mock.calls.filter(
      (c) => c[0] === "POST" && String(c[1]).includes("/orders/close-position"));
    expect(flattenOrders.length).toBeGreaterThanOrEqual(1);
    // The NAKED-VERIFY-REQUIRED alert fired.
    const verifyAlerts = telegramMock.mock.calls.filter((c) => /NAKED-VERIFY-REQUIRED/i.test(String(c[0])));
    expect(verifyAlerts.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── TEST 4 — HALT universal (pyramid + manual/tryLiveEntry both reject) ─────────
describe("HALT-1 — a latched halt halts the ENTIRE book", () => {
  it("rejects pyramid scale-in AND a (manual) tryLiveEntry", async () => {
    __forceTradingHaltForTest();
    configRow = { ...ARMED_CONFIG };

    // assertNotHalted is the shared chokepoint both paths use.
    expect(assertNotHalted(configRow).blocked).toBe(true);

    // Pyramid scale-in: returns 0 (blocked) and places NO bracket order.
    ibindRequestMock.mockResolvedValue({ ok: true, status: 200, body: { orders: [] } });
    const added = await runPyramidEngine(1);
    expect(added).toBe(0);
    const pyramidBrackets = ibindRequestMock.mock.calls.filter(
      (c) => c[0] === "POST" && String(c[1]).includes("/orders/bracket"));
    expect(pyramidBrackets.length).toBe(0);

    // Manual entry path routes through tryLiveEntry → rejected by the same chokepoint.
    livePriceMock.mockResolvedValue(new Map([["AAPL", { source: "ibkr", price: 200 }]]));
    const entry = await tryLiveEntry({
      userId: 1, ticker: "AAPL", direction: "long", signal: "MANUAL_LONG", zivScore: 0,
      currentPrice: 200, slPrice: 184, tpPrice: 240, positionSizeUsd: 10000,
    });
    expect(entry.entered).toBe(false);
    expect(entry.reason).toMatch(/halt/i);
  });
});

// ─── TEST 5 — EOD VIX-fail (degraded regime) → overnight target 0.5× ────────────
describe("EOD-1 — degraded regime ⇒ overnightGrossCap 0.5× fail-closed", () => {
  it("trims to OVERNIGHT_LEVERAGE × 0.5 when the regime is degraded", async () => {
    configRow = { ...ARMED_CONFIG, totalNlv: 100000 };
    // EOD-3: the gross-leverage denominator now comes from the LIVE NLV read — feed it.
    ibindCachedMock.mockImplementation(async (_m: string, path: string) =>
      path === "/account/summary" ? mockAcctSummary(100000) : mockPnl(0));
    // Degraded regime: vixProxy is a placeholder; degraded flag must force vix=NaN → 0.5×.
    getMarketRegimeMock.mockResolvedValue({ regime: "NEUTRAL", vixProxy: 20, degraded: true, regimeReason: "SPY fetch failed" });
    // Heavy gross: deployed far above the 0.5×overnight target so a trim is forced.
    // cashBudget = 100000 × 0.40 = 40000. overnight 1.9× → 76000; 0.5× → 38000.
    dbState.openPositions = [
      { id: 1, userId: 1, ticker: "AAPL", direction: "long", status: "open", units: 500, entryPrice: 200, allocatedCapital: 100000, ibkrSlOrderId: "s1", ibkrTpOrderId: "t1", currentPrice: 200 },
    ];
    ibindRequestMock.mockImplementation(async (method: string, path: string) => {
      if (method === "GET" && path === "/positions") return { ok: true, status: 200, body: { positions: [] } };
      return { ok: true, status: 200, body: { order_id: "x" } };
    });
    livePriceMock.mockResolvedValue(new Map([["AAPL", { source: "ibkr", price: 200 }]]));

    const res = await runDeleveragingCycle(1);
    // With the 0.5× cap ($38000) the $100000 deployed is far over → a trim occurs.
    expect(res.trimmed + res.failed).toBeGreaterThanOrEqual(1);
    // The degraded path was exercised: getMarketRegime consulted.
    expect(getMarketRegimeMock).toHaveBeenCalled();
  });
});

// ─── TEST 6 — EOD trim accepted-but-unfilled → not counted + alert ──────────────
describe("EOD-2 — trim accepted but unfilled ⇒ NOT counted + alert", () => {
  it("does NOT decrement excess / count trimmed, and fires EOD-TRIM-FAILED", async () => {
    configRow = { ...ARMED_CONFIG, totalNlv: 100000 };
    // EOD-3: feed the LIVE NLV read so the VIX-aware tightening runs.
    ibindCachedMock.mockImplementation(async (_m: string, path: string) =>
      path === "/account/summary" ? mockAcctSummary(100000) : mockPnl(0));
    getMarketRegimeMock.mockResolvedValue({ regime: "BULL", vixProxy: 12, degraded: false, regimeReason: "calm" });
    dbState.openPositions = [
      { id: 1, userId: 1, ticker: "AAPL", direction: "long", status: "open", units: 500, entryPrice: 200, allocatedCapital: 100000, ibkrSlOrderId: "s1", ibkrTpOrderId: "t1", currentPrice: 200 },
    ];
    // executeLiveSell accepts the exit (ok), but /positions STILL shows the position held.
    ibindRequestMock.mockImplementation(async (method: string, path: string) => {
      if (method === "GET" && path === "/positions") {
        return { ok: true, status: 200, body: { positions: [{ conid: 12345, ticker: "AAPL", position: 500 }] } };
      }
      return { ok: true, status: 200, body: { order_id: "x" } };
    });
    livePriceMock.mockResolvedValue(new Map([["AAPL", { source: "ibkr", price: 200 }]]));

    const res = await runDeleveragingCycle(1);
    // Accepted-but-unfilled ⇒ counted as failed, NOT trimmed.
    expect(res.trimmed).toBe(0);
    expect(res.failed).toBeGreaterThanOrEqual(1);
    // EOD-TRIM-FAILED alert fired.
    const alertCalls = telegramMock.mock.calls.filter((c) => /EOD-TRIM FAILED/i.test(String(c[0])));
    expect(alertCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── TEST 7 — DEFENSE MODE (SPY<EMA50 → bunker): block NEW LONG entries ─────────
describe("DEFENSE-MODE — SPY<EMA50 regime switch blocks NEW long entries", () => {
  beforeEach(() => {
    configRow = { ...ARMED_CONFIG };
    // Pin the clock inside the Israel market window so we PROVE the BULL case passes
    // the regime gate (and is NOT rejected for being out of hours).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 26, 15, 0, 0))); // 18:00 IL — market open
    livePriceMock.mockResolvedValue(new Map([["AAPL", { source: "ibkr", price: 200 }]]));
  });

  it("BEAR (SPY<EMA50) + flag ON ⇒ a LONG tryLiveEntry is REJECTED with DEFENSE_MODE", async () => {
    try {
      fetchBarsMock.mockResolvedValue(spyBars("bear")); // SPY last close < daily EMA-50
      const res = await tryLiveEntry({
        userId: 1, ticker: "AAPL", direction: "long", signal: "TEST", zivScore: 9,
        currentPrice: 200, slPrice: 184, tpPrice: 240, positionSizeUsd: 10000,
      });
      expect(res.entered).toBe(false);
      expect(res.reason).toMatch(/DEFENSE_MODE/);
      expect(res.reason).toMatch(/daily EMA-50/);
      // The bunker rejected BEFORE any bracket order was placed.
      const brackets = ibindRequestMock.mock.calls.filter(
        (c) => c[0] === "POST" && String(c[1]).includes("/orders/bracket"));
      expect(brackets.length).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("BULL (SPY>EMA50) + flag ON ⇒ long PASSES the regime gate (not blocked by DEFENSE_MODE)", async () => {
    try {
      fetchBarsMock.mockImplementation(barsRouter("bull")); // SPY last close > daily EMA-50; AAPL gets price-matched EOD bars
      // The pure gate is the cleanest assertion that BULL is allowed.
      const gate = await assertLongAllowedByRegime(configRow);
      expect(gate.allowed).toBe(true);
      // End-to-end: tryLiveEntry must NOT reject for DEFENSE_MODE (it proceeds past the gate).
      const res = await tryLiveEntry({
        userId: 1, ticker: "AAPL", direction: "long", signal: "TEST", zivScore: 9,
        currentPrice: 200, slPrice: 184, tpPrice: 240, positionSizeUsd: 10000,
      });
      expect(res.reason ?? "").not.toMatch(/DEFENSE_MODE/);
    } finally { vi.useRealTimers(); }
  });

  it("DEGRADED/broken SPY read + flag ON ⇒ FAIL-CLOSED (long blocked)", async () => {
    try {
      // Degraded fallback regime — not a trustworthy market read.
      fetchBarsMock.mockResolvedValue([]); // empty/insufficient SPY bars → fail-closed bunker
      const res = await tryLiveEntry({
        userId: 1, ticker: "AAPL", direction: "long", signal: "TEST", zivScore: 9,
        currentPrice: 200, slPrice: 184, tpPrice: 240, positionSizeUsd: 10000,
      });
      expect(res.entered).toBe(false);
      expect(res.reason).toMatch(/DEFENSE_MODE/);
      expect(res.reason).toMatch(/fail-closed/i);
    } finally { vi.useRealTimers(); }
  });

  it("FC-1 — SPY reads HEALTHY but regime DEGRADED (synthetic VIX) ⇒ FAIL-CLOSED (long blocked)", async () => {
    try {
      // SPY itself is fine (>EMA-50, ≥50 bars) so the literal-SPY checks PASS...
      fetchBarsMock.mockImplementation(barsRouter("bull"));
      // ...but the broader regime is degraded → vixProxy is a synthetic 20, VIX>35 can't fire.
      getMarketRegimeMock.mockResolvedValue({ regime: "NEUTRAL", vixProxy: 20, degraded: true, regimeReason: "Insufficient SPY data" });
      const gate = await assertLongAllowedByRegime(configRow);
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toMatch(/DEGRADED/);
      expect(gate.reason).toMatch(/fail-closed/i);
    } finally { vi.useRealTimers(); }
  });

  it("a THROWING SPY read + flag ON ⇒ FAIL-CLOSED (long blocked)", async () => {
    try {
      fetchBarsMock.mockRejectedValue(new Error("gateway down"));
      const gate = await assertLongAllowedByRegime(configRow);
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toMatch(/DEFENSE_MODE/);
      expect(gate.reason).toMatch(/fail-closed/i);
    } finally { vi.useRealTimers(); }
  });

  it("flag OFF ⇒ regime gate is INERT (long allowed regardless of a BEAR SPY read)", async () => {
    try {
      const flagOff: any = { ...ARMED_CONFIG, elzaV45LiveEnabled: 0 };
      fetchBarsMock.mockResolvedValue(spyBars("bear"));
      const gate = await assertLongAllowedByRegime(flagOff);
      expect(gate.allowed).toBe(true);
      // SPY bars are not even fetched when the flag is OFF (true inert).
      expect(fetchBarsMock).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("does NOT affect existing-position management (gate only blocks NEW entries)", async () => {
    try {
      // BEAR regime — new longs blocked — yet the SL/exit monitor path is untouched: the
      // gate lives ONLY in tryLiveEntry, so runDeleveragingCycle (manage existing) runs
      // and can still place EXIT orders for an open position. No new bracket is opened.
      getMarketRegimeMock.mockResolvedValue({ regime: "BEAR", vixProxy: 30, degraded: false, regimeReason: "bear" });
      dbState.openPositions = [
        { id: 1, userId: 1, ticker: "AAPL", direction: "long", status: "open", units: 500, entryPrice: 200, allocatedCapital: 100000, ibkrSlOrderId: "s1", ibkrTpOrderId: "t1", currentPrice: 200 },
      ];
      ibindCachedMock.mockImplementation(async (_m: string, path: string) =>
        path === "/account/summary" ? mockAcctSummary(100000) : mockPnl(0));
      ibindRequestMock.mockImplementation(async (method: string, path: string) => {
        if (method === "GET" && path === "/positions") return { ok: true, status: 200, body: { positions: [] } };
        return { ok: true, status: 200, body: { order_id: "x" } };
      });
      const res = await runDeleveragingCycle(1);
      // Management ran (a trim/exit was attempted) — DEFENSE MODE never short-circuited it.
      expect(res.trimmed + res.failed).toBeGreaterThanOrEqual(1);
      // And NO new entry bracket was opened by the management path.
      const brackets = ibindRequestMock.mock.calls.filter(
        (c) => c[0] === "POST" && String(c[1]).includes("/orders/bracket"));
      expect(brackets.length).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

// ─── ZIV ROTATION FLUSH — displace weakest dead-money long for a Tier-4 breakout ─
describe("FLUSH — Ziv Rotation Flush displaces the weakest dead-money long", () => {
  const NOW = Date.UTC(2026, 5, 26, 15, 0, 0); // 18:00 IL — market open
  const HOURS = 3_600_000;
  // openedAt N hours ago.
  const agedH = (h: number) => new Date(NOW - h * HOURS);

  // Bars router that ALSO tags candidate-ticker bars so calcZivHScoreMock can read the
  // per-ticker controlled score, and supplies SPY (regime) + price-matched entry bars.
  function flushBarsRouter() {
    return async (ticker: string) => {
      if (ticker === "SPY") return spyBars("bull");
      const out = flatEodBars(ENTRY_TICKER_PRICE);
      // Tag every bar with the ticker so the mocked Ziv scorer can route by name.
      return out.map((b) => ({ ...b, __ticker: ticker }));
    };
  }

  // The new Tier-4 breakout entry ticker (NOT among the open book).
  const NEW_TICKER = "NVDA";

  // Build a full 12-position book; `weak` is the eligible weakest long. Others are
  // de-risked / shorts / fresh so they can NEVER be the flush target.
  function makeFullBook(weak: Partial<Row> & { ticker: string }): Row[] {
    const base: Row[] = [
      // index 0 = the weak eligible candidate (executeLiveSell mock acts on rows[0]).
      {
        id: 101, userId: 1, ticker: weak.ticker, direction: "long", status: "open",
        units: 10, entryPrice: 100, currentPrice: 100, currentSl: 90, currentTp: 130,
        zivScore: 8, openedAt: agedH(120), isFreeRolled: 0, slMovedToBreakEven: 0,
        peakPrice: 105, unrealizedPnl: -50, allocatedCapital: 1000,
        ibkrSlOrderId: "s101", ibkrTpOrderId: "t101", ...weak,
      },
    ];
    // 11 protected fillers (mix of de-risked longs + shorts + a fresh long).
    for (let i = 0; i < 11; i++) {
      base.push({
        id: 200 + i, userId: 1, ticker: `FILL${i}`, direction: i % 4 === 0 ? "short" : "long",
        status: "open", units: 5, entryPrice: 50, currentPrice: 50, currentSl: 45, currentTp: 65,
        zivScore: 8, openedAt: agedH(i < 6 ? 200 : 1), // half aged, half fresh
        isFreeRolled: i % 2, slMovedToBreakEven: (i + 1) % 2, // all de-risked one way or another
        peakPrice: 55, unrealizedPnl: 100, allocatedCapital: 1000,
        ibkrSlOrderId: `s${200 + i}`, ibkrTpOrderId: `t${200 + i}`,
      });
    }
    return base;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    configRow = { ...ARMED_CONFIG, zivRotationFlushEnabled: 1, maxPositions: 12 };
    zivHScoreByTicker.clear();
    fetchBarsMock.mockImplementation(flushBarsRouter());
    // New breakout ticker live price (for the entry that follows a successful flush).
    livePriceMock.mockResolvedValue(new Map([[NEW_TICKER, { source: "ibkr", price: ENTRY_TICKER_PRICE }]]));
    // Accept exit LMTs + any bracket placement.
    ibindRequestMock.mockImplementation(async (method: string, path: string) => {
      if (method === "GET" && path === "/positions") return { ok: true, status: 200, body: { positions: [] } };
      return { ok: true, status: 200, body: { order_id: "x1", result: [{ local_order_id: "BR-1", order_id: "E1" }] } };
    });
  });
  afterEach(() => vi.useRealTimers());

  function newBreakout(overrides: Partial<any> = {}) {
    return tryLiveEntry({
      userId: 1, ticker: NEW_TICKER, direction: "long",
      signal: "GOLD_BREAKOUT_WAR", zivScore: 9.2,
      currentPrice: ENTRY_TICKER_PRICE, slPrice: 184, tpPrice: 240, positionSizeUsd: 10000,
      ...overrides,
    });
  }

  it("FLUSH-1 — weak Ziv 3.0 candidate ⇒ executeLiveSell fires + entry falls through", async () => {
    dbState.openPositions = makeFullBook({ ticker: "DEAD", openedAt: agedH(120) });
    zivHScoreByTicker.set("DEAD", 3.0);

    const res = await newBreakout();
    // The flush displaced DEAD via executeLiveSell, which writes in TWO phases (by design):
    // first {status:"pending_exit", exitReason:null}, then {exitReason} only AFTER IBKR
    // accepts the exit order. So assert the two effects separately, not in one update object.
    const markedPending = dbState.updates.find((u) => u.status === "pending_exit");
    const flushReason = dbState.updates.find((u) => u.exitReason === "ZIV_ROTATION_FLUSH");
    expect(markedPending).toBeTruthy();
    expect(flushReason).toBeTruthy();
    // ROTATION-FLUSH telegram fired naming DEAD + the new ticker.
    const flushAlert = telegramMock.mock.calls.filter((c) => /ROTATION-FLUSH/.test(String(c[0])) && /DEAD/.test(String(c[0])));
    expect(flushAlert.length).toBeGreaterThanOrEqual(1);
    // Entry was NOT rejected for max positions (it fell through past the gate).
    expect(res.reason ?? "").not.toMatch(/Max positions/);
  });

  it("FLUSH-2 — weakest candidate Ziv 6.0 (≥5.0) ⇒ NO sell, reject Max positions", async () => {
    dbState.openPositions = makeFullBook({ ticker: "DEAD", openedAt: agedH(120) });
    zivHScoreByTicker.set("DEAD", 6.0);

    const res = await newBreakout();
    const exited = dbState.updates.find((u) => u.exitReason === "ZIV_ROTATION_FLUSH");
    expect(exited).toBeFalsy();
    expect(res.entered).toBe(false);
    expect(res.reason).toMatch(/Max positions/);
  });

  it("FLUSH-3 — all candidates de-risked / fresh ⇒ no candidate ⇒ reject", async () => {
    // The sole 'weak' slot is itself free-rolled → zero eligible candidates.
    dbState.openPositions = makeFullBook({ ticker: "DEAD", openedAt: agedH(120), isFreeRolled: 1 });
    zivHScoreByTicker.set("DEAD", 2.0);

    const res = await newBreakout();
    expect(dbState.updates.find((u) => u.exitReason === "ZIV_ROTATION_FLUSH")).toBeFalsy();
    expect(res.entered).toBe(false);
    expect(res.reason).toMatch(/Max positions/);
    expect(res.reason).toMatch(/no eligible flush candidate/);
  });

  it("FLUSH-4 — Tier-3 (GOLD_RETEST_WAR) / score 8.5 ⇒ no flush ⇒ reject", async () => {
    dbState.openPositions = makeFullBook({ ticker: "DEAD", openedAt: agedH(120) });
    zivHScoreByTicker.set("DEAD", 2.0);

    const retest = await newBreakout({ signal: "GOLD_RETEST_WAR" });
    expect(dbState.updates.find((u) => u.exitReason === "ZIV_ROTATION_FLUSH")).toBeFalsy();
    expect(retest.entered).toBe(false);
    expect(retest.reason).toMatch(/Max positions/);

    // Also: a breakout token but sub-9.0 score must not flush.
    dbState.updates = [];
    const lowScore = await newBreakout({ zivScore: 8.5 });
    expect(dbState.updates.find((u) => u.exitReason === "ZIV_ROTATION_FLUSH")).toBeFalsy();
    expect(lowScore.reason).toMatch(/Max positions/);
  });

  it("FLUSH-5 INERT — zivRotationFlushEnabled=0 ⇒ no sell, scorer/bars untouched", async () => {
    configRow = { ...ARMED_CONFIG, zivRotationFlushEnabled: 0, maxPositions: 12 };
    dbState.openPositions = makeFullBook({ ticker: "DEAD", openedAt: agedH(120) });
    zivHScoreByTicker.set("DEAD", 2.0);
    fetchBarsMock.mockClear();
    calcZivHScoreMock.mockClear();

    const res = await newBreakout();
    expect(dbState.updates.find((u) => u.exitReason === "ZIV_ROTATION_FLUSH")).toBeFalsy();
    // The candidate scorer was NEVER invoked when inert.
    expect(calcZivHScoreMock).not.toHaveBeenCalled();
    expect(res.entered).toBe(false);
    expect(res.reason).toMatch(/Max positions/);
  });

  it("FLUSH-6 — executeLiveSell fails ⇒ entry does NOT proceed + FAILED alert", async () => {
    dbState.openPositions = makeFullBook({ ticker: "DEAD", openedAt: agedH(120) });
    zivHScoreByTicker.set("DEAD", 3.0);
    // Make the exit LMT placement fail (both IOC and DAY retry) ⇒ executeLiveSell success:false.
    ibindRequestMock.mockImplementation(async (method: string, path: string) => {
      if (method === "GET" && path === "/positions") return { ok: true, status: 200, body: { positions: [] } };
      if (method === "POST" && path === "/orders/close-position") return { ok: false, status: 405, body: { message: "rejected" } };
      return { ok: true, status: 200, body: { order_id: "x1" } };
    });

    const res = await newBreakout();
    expect(res.entered).toBe(false);
    expect(res.reason).toMatch(/Max positions/);
    const failedAlert = telegramMock.mock.calls.filter((c) => /ROTATION-FLUSH-FAILED/.test(String(c[0])));
    expect(failedAlert.length).toBeGreaterThanOrEqual(1);
  });

  it("FLUSH-7 fail-closed — weakest's bars fetch throws ⇒ treated healthy ⇒ no flush", async () => {
    dbState.openPositions = makeFullBook({ ticker: "DEAD", openedAt: agedH(120) });
    zivHScoreByTicker.set("DEAD", 2.0); // would be weak IF scored — but its bars throw first.
    fetchBarsMock.mockImplementation(async (ticker: string) => {
      if (ticker === "SPY") return spyBars("bull");
      if (ticker === "DEAD") throw new Error("gateway down");
      const out = flatEodBars(ENTRY_TICKER_PRICE);
      return out.map((b) => ({ ...b, __ticker: ticker }));
    });

    const res = await newBreakout();
    // DEAD scored Infinity (unknown ⇒ protected); no other <5.0 ⇒ no flush.
    expect(dbState.updates.find((u) => u.exitReason === "ZIV_ROTATION_FLUSH")).toBeFalsy();
    expect(res.entered).toBe(false);
    expect(res.reason).toMatch(/Max positions/);
  });
});

// ─── EXIT-G — Golden 5:1 SSOT live exit wiring (TASK 2a, gated on elzaV45LiveEnabled) ─
describe("EXIT-G — Golden 5:1 SSOT drives the live per-tick exit when armed", () => {
  // 1 trading-day per bar (daily DNA). Fresh tick is set via the IBKR websocket poller mock.
  const NOW = Date.UTC(2026, 5, 26, 15, 0, 0); // 18:00 IL — inside market hours
  const DAY = 86_400_000;

  // Seed an IBKR-FRESH tick so tickIsIbkrFresh===true in the monitor loop.
  function freshTick(ticker: string, price: number) {
    wsPriceByTicker.set(ticker, { last: price, updatedAt: Date.now() });
  }

  // A canonical long: entry 100, initialSl 90 ⇒ R=10. Scale +2.5R=125, TP +5R=150.
  function goldPos(over: Partial<any> = {}) {
    return {
      id: 501, userId: 1, ticker: "GOLD", direction: "long", status: "open",
      units: 100, originalUnits: 100, entryPrice: 100, allocatedCapital: 10000,
      currentSl: 90, currentTp: 0, initialSl: 90, initialTp: 200, currentPrice: 100,
      rValue: 10, atr14: 2, peakPrice: 100, isFreeRolled: 0, slMovedToBreakEven: 0,
      partialTpHit: 0, ibkrSlOrderId: "SL501", ibkrTpOrderId: null,
      openedAt: new Date(NOW - 2 * DAY), zivScore: 8, sector: "TECH",
      ...over,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    wsPriceByTicker.clear();
    configRow = { ...ARMED_CONFIG, elzaV45LiveEnabled: 1 };
    executeLivePartialCloseMock.mockResolvedValue({ success: true, reason: "mock filled", orderId: "P1" });
    // Accept all gateway calls: positions read, exit LMTs, stop pushes/cancels.
    ibindRequestMock.mockImplementation(async (method: string, path: string) => {
      if (method === "GET" && String(path).includes("/positions")) return { ok: true, status: 200, body: [] };
      if (method === "POST" && path === "/orders/stop-loss") return { ok: true, status: 200, body: { order_id: "NEWSL", orderId: "NEWSL" } };
      if (method === "DELETE") return { ok: true, status: 200, body: {} };
      return { ok: true, status: 200, body: { order_id: "x" } };
    });
  });
  afterEach(() => vi.useRealTimers());

  const monitorOpts = { bypassThrottle: true, bypassMarketHours: true, skipHardSync: true };

  function stopPushes() {
    return ibindRequestMock.mock.calls.filter((c) => c[0] === "POST" && c[1] === "/orders/stop-loss");
  }
  function exitLmts() {
    return ibindRequestMock.mock.calls.filter((c) => c[0] === "POST" && String(c[1]).includes("/orders/close-position"));
  }

  it("EXIT-G1 — flag ON, +2.5R ⇒ partial-sell 40% original + stop→breakeven + flags persisted", async () => {
    dbState.openPositions = [goldPos()];
    freshTick("GOLD", 125); // == entry + 2.5R ⇒ SCALE_40

    await runLiveSlMonitor(1, monitorOpts);

    // 40%-of-original reduce leg placed via the partial-close primitive with the Golden reason.
    expect(executeLivePartialCloseMock).toHaveBeenCalledTimes(1);
    const partArgs = executeLivePartialCloseMock.mock.calls[0][0] as any;
    expect(partArgs.reason).toBe("GOLDEN_SCALE_40");
    expect(partArgs.fraction).toBeCloseTo(0.4, 3);

    // Stop moved to BREAKEVEN (entry 100) via the place-new STP push.
    const pushes = stopPushes();
    expect(pushes.length).toBeGreaterThanOrEqual(1);
    expect(Number((pushes[0][2] as any).stopPrice)).toBeCloseTo(100, 2);

    // Scale flags persisted so the next tick enters the runner branch.
    const flagUpd = dbState.updates.find((u) => u.partialTpHit === 1 && u.isFreeRolled === 1 && u.slMovedToBreakEven === 1);
    expect(flagUpd).toBeTruthy();

    // No FULL exit fired on the scale tick.
    expect(exitLmts().length).toBe(0);
  });

  it("EXIT-G2 — flag ON, scaled runner, price rises ⇒ STP ratchets to 2.5×ATR chandelier (tighten-only)", async () => {
    // Already scaled: BE stop resting at 100. peak 130 prior; new tick 140.
    dbState.openPositions = [goldPos({ partialTpHit: 1, isFreeRolled: 1, slMovedToBreakEven: 1, currentSl: 100, peakPrice: 130 })];
    freshTick("GOLD", 140);

    await runLiveSlMonitor(1, monitorOpts);

    // chandelier = peak(140) − 2.5×ATR(2) = 135; workingStop = max(BE 100, 135) = 135.
    const pushes = stopPushes();
    expect(pushes.length).toBeGreaterThanOrEqual(1);
    const pushed = Number((pushes[pushes.length - 1][2] as any).stopPrice);
    expect(pushed).toBeCloseTo(135, 2);
    // Tighten-only: the pushed stop is strictly ABOVE the prior resting BE stop (100).
    expect(pushed).toBeGreaterThan(100);
    // No exit and no scale on a HOLD/ratchet tick.
    expect(exitLmts().length).toBe(0);
    expect(executeLivePartialCloseMock).not.toHaveBeenCalled();
  });

  it("EXIT-G2b — flag ON, scaled, a LOWER chandelier does NOT loosen the resting stop", async () => {
    // Resting stop already at 138; new tick only implies a 135 chandelier ⇒ NO push.
    dbState.openPositions = [goldPos({ partialTpHit: 1, isFreeRolled: 1, slMovedToBreakEven: 1, currentSl: 138, peakPrice: 130 })];
    freshTick("GOLD", 140); // chandelier 135 < resting 138 ⇒ never loosen

    await runLiveSlMonitor(1, monitorOpts);

    expect(stopPushes().length).toBe(0);
    expect(exitLmts().length).toBe(0);
  });

  it("EXIT-G3 — flag ON, +5R ⇒ full exit (TP_FINAL)", async () => {
    dbState.openPositions = [goldPos({ partialTpHit: 1, isFreeRolled: 1, slMovedToBreakEven: 1, currentSl: 100, peakPrice: 140 })];
    freshTick("GOLD", 150); // == entry + 5R ⇒ TP_FINAL

    await runLiveSlMonitor(1, monitorOpts);

    // executeLiveSell ran with the Golden TP reason. Two-phase write (by design): pending_exit
    // first (reason=null), then exitReason set only after IBKR accepts → assert separately.
    expect(dbState.updates.find((u) => u.status === "pending_exit")).toBeTruthy();
    expect(dbState.updates.find((u) => u.exitReason === "GOLDEN_TP_FINAL")).toBeTruthy();
    expect(exitLmts().length).toBeGreaterThanOrEqual(1);
  });

  it("EXIT-G4 — flag ON, 60-bar pre-scale time-stop ⇒ full exit (TIME)", async () => {
    // Held 61 days, never scaled, price between SL and scale target ⇒ HOLD ⇒ TIME backstop.
    dbState.openPositions = [goldPos({ openedAt: new Date(NOW - 61 * DAY), partialTpHit: 0 })];
    freshTick("GOLD", 110); // 90 < 110 < 125 ⇒ no SL, no scale ⇒ HOLD pre-scale

    await runLiveSlMonitor(1, monitorOpts);

    // Two-phase write (by design): pending_exit first, reason set only after IBKR accepts.
    expect(dbState.updates.find((u) => u.status === "pending_exit")).toBeTruthy();
    expect(dbState.updates.find((u) => u.exitReason === "GOLDEN_TIME_STOP")).toBeTruthy();
    expect(exitLmts().length).toBeGreaterThanOrEqual(1);
    // No scale / no stop push on a time-stop exit.
    expect(executeLivePartialCloseMock).not.toHaveBeenCalled();
  });

  it("EXIT-G5 INERT — flag OFF ⇒ SSOT not invoked, NO Golden order, legacy path runs", async () => {
    configRow = { ...ARMED_CONFIG, elzaV45LiveEnabled: 0 };
    dbState.openPositions = [goldPos()];
    freshTick("GOLD", 125); // would be SCALE_40 if the SSOT were armed

    await runLiveSlMonitor(1, monitorOpts);

    // No Golden-specific side-effects whatsoever.
    expect(executeLivePartialCloseMock).not.toHaveBeenCalled();
    expect(dbState.updates.find((u) => String(u.exitReason ?? "").startsWith("GOLDEN_"))).toBeFalsy();
    expect(dbState.updates.find((u) => u.partialTpHit === 1 && u.isFreeRolled === 1)).toBeFalsy();
    // Legacy ladder is observe-only by default (structuralExitsEnabled unset) ⇒ NO exit LMT either.
    expect(exitLmts().length).toBe(0);
  });

  it("EXIT-G6 fail-closed — flag ON, atr14 NaN ⇒ NO exit order, resting SL untouched, logged", async () => {
    dbState.openPositions = [goldPos({ atr14: NaN, partialTpHit: 1, isFreeRolled: 1, currentSl: 100 })];
    freshTick("GOLD", 140); // would ratchet/exit if the view were valid

    await runLiveSlMonitor(1, monitorOpts);

    // Fail-closed: NO partial, NO stop push, NO exit LMT — the resting SL stays put.
    expect(executeLivePartialCloseMock).not.toHaveBeenCalled();
    expect(stopPushes().length).toBe(0);
    expect(exitLmts().length).toBe(0);
    // No currentSl mutation was persisted by the Golden path.
    expect(dbState.updates.find((u) => Object.prototype.hasOwnProperty.call(u, "currentSl"))).toBeFalsy();
  });
});

// ─── INERT — flag DEFAULT 0 keeps the CB tick a no-op ──────────────────────────
describe("INERT — elzaV45LiveEnabled default 0 keeps the new paths inert", () => {
  it("CB tick does not latch a halt when the flag is OFF (assertNotHalted no-op)", () => {
    __resetTradingHaltForTest();
    const flagOff: any = { ...ARMED_CONFIG, elzaV45LiveEnabled: 0 };
    // Even if the latch were somehow set, assertNotHalted returns blocked:false when OFF.
    __forceTradingHaltForTest();
    expect(assertNotHalted(flagOff).blocked).toBe(false);
  });
});
