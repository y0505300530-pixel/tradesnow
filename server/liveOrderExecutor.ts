/**
 * liveOrderExecutor.ts — Elza Live Engine v1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Places and manages REAL orders on IBKR Live account (U16881054).
 * 
 * Key design decisions:
 *   1. Only manages positions IT opened (tracked in livePositions table)
 *   2. Capital = totalNlv × (allocatedPct / 100) — isolated budget
 *   3. SL is software-side only — no IBKR stop orders (avoids 15-order limit)
 *   4. TP is placed on IBKR (limit sell)
 *   5. Market hours enforced: 16:30-23:00 Israel time
 *   6. Completely isolated from paperLabEngine / paperOrderExecutor
 */

import { ibindRequest } from "./routers/ibkrProxy";
import { ibindCached } from "./ibkrCache";
import { getBrokerageStealGraceRemainingSec } from "./ibkrSessionMonitor";
import { resolveConid } from "./conidResolver";
import { ENV } from "./_core/env";
import { getDb, getSystemSetting, setSystemSetting } from "./db";
import { livePositions, liveEngineConfig, liveTrades, liveEntryLock, userAssets } from "../drizzle/schema";
import { eq, and, inArray, sql, lt, or, gte } from "drizzle-orm";
import { log } from "./logger";
import { sendTelegramMessage } from "./telegram";
import { fmtPrice, toPriceNumber } from "./utils/formatPrice";
import { fetchBarsBatch, fetchBarsForTicker, fetchIbkrLivePricesBatch, type Bar } from "./marketData";
import { calcEntrySlTp, ema50FromBars, ensureDirectionalSlTp, validateSlTpDirection, freeRollTriggerGain } from "./slCalculator";
import { isGapChase, gapPctFromEntryZone, GAP_GUARD_PCT } from "./gapGuard";
import { calcZivHScore, type ZivHContext } from "./utils/zivHealth";
import { safeInsertLivePosition } from "./livePositionsSyncCore";
import { isGhostSlotsEnabled, rowCountsTowardSlot } from "./ghostSlots";
import { buildChurnLedger, isChurnBlocked, startOfIsraelDayMs, isAutomatedSignal, shouldBypassChurnForPhoenix } from "./entryChurnGuard";
import { assertMinRValuePct } from "./minRValueGate";
import { pollEntryFill } from "./liveMarketOrder";
import { executeLivePartialClose, realDeps, type PartialDeps } from "./executePartial";
import { withStopModLock } from "./stopModMutex";
import { blocksElzaEntry, elzaEntryBlockReason, KINETIC_MIN_BARS } from "./catalogStatus";
import { getPriceByTicker } from "./services/ibkrWebSocket";
import { positionUnrealizedPnl, positionRealizedPnl } from "./services/PnlService";
import { positionValue } from "./services/PortfolioValueService";
// Elza v4.5 Master — PURE gap-wall decision functions (no DB/IBKR/order side-effects).
// Wired live ONLY behind the inert `elzaV45LiveEnabled` flag (default 0).
import {
  overnightGrossCap,
  circuitBreaker,
  wideLungSL,
  ELZA_V45_CFG,
  goldenExitDecision,
  GOLDEN_SCALE_BANK_FRAC,
  type OpenPositionView,
  type ExitDecision,
} from "./engine/elzaV45Master";
import type { Bar as ElzaBar } from "./engine/elzaV45Master";

export const LIVE_ACCOUNT_ID = ENV.ibkrLiveAccountId;
export { resolveConid };
const LIVE_ENGINE_VERSION = "1.0";

/**
 * DEFAULT_MAX_POSITION_USD — the ONE shared per-ticker notional cap fallback (owner-
 * ratified 2026-07-01). Mirrors the live config SSOT (liveEngineConfig.maxPositionUsd,
 * $85k). Used ONLY when that config value is absent/null (the degraded/null-config path)
 * — no behavior change when the live value is present (it always is). Consolidates the
 * previously divergent fallbacks (999999 / 50000 / 70000) so a null-config read can
 * never leave a per-ticker cap effectively unbounded.
 */
export const DEFAULT_MAX_POSITION_USD = 85000;

// ── In-memory state ───────────────────────────────────────────────────────────
let _liveRunning = false;
let _lastLiveCycleAt = 0;

// ── BUILD 1: order-placement failure observability ──────────────────────────────
// A stale ibind gateway can silently 405 on /orders/* (the "[Sell] FAILED … HTTP 405"
// outage). This counter + helper make a placement failure LOUD and structured so it
// is never silent. Pure observability — it changes NO order-placement/pricing logic.
let _consecutiveOrderFailures = 0;

/**
 * Emit a high-visibility, structured alert when a LIVE order PLACEMENT fails
 * (non-2xx / throw on /orders/bracket | /orders/limit | /orders/close-position).
 * Increments the consecutive-failure counter and, once it crosses 2, appends a
 * gateway-stale hint (consider `systemctl restart ibind-oauth.service`). Best-effort
 * Telegram fan-out via the existing notifier. Never throws.
 */
function reportOrderFailure(args: {
  ticker: string;
  action: string;     // e.g. "BUY" | "SELL" | "ENTRY-BRACKET" | "EXIT-LMT"
  status: number | string;
  endpoint: string;   // e.g. "/orders/bracket"
  errMsg?: string;
}): void {
  const { ticker, action, status, endpoint, errMsg } = args;
  _consecutiveOrderFailures += 1;
  log.error("LIVE_EXEC",
    `[ORDER-FAIL] ${action} ${ticker} HTTP ${status} — order NOT placed`,
    { context: { ticker, action, status, endpoint, errMsg: errMsg ?? null } },
  );
  if (_consecutiveOrderFailures >= 2) {
    log.error("LIVE_EXEC",
      `[ORDER-FAIL] ${_consecutiveOrderFailures}th consecutive — gateway may be stale, consider systemctl restart ibind-oauth.service`,
      { context: { consecutiveFailures: _consecutiveOrderFailures, lastTicker: ticker, lastEndpoint: endpoint } },
    );
  }
  // Best-effort high-visibility push via the existing notifier — never block/throw.
  try {
    void sendTelegramMessage(
      `🚨 <b>ORDER-FAIL</b>\n` +
      `${action} <b>${ticker}</b> HTTP ${status} — order NOT placed\n` +
      `endpoint: ${endpoint}\n` +
      (_consecutiveOrderFailures >= 2
        ? `⚠️ ${_consecutiveOrderFailures}th consecutive — gateway may be stale (consider: systemctl restart ibind-oauth.service)`
        : ``)
    ).catch(() => {});
  } catch { /* notifier is best-effort */ }
}

/** Reset the consecutive-failure counter after a confirmed successful placement. */
function noteOrderSuccess(): void {
  _consecutiveOrderFailures = 0;
}

// ── Elza v4.5 Master gap-wall wiring (INERT until elzaV45LiveEnabled=1) ──────────
/**
 * Read the inert master switch for the Elza v4.5 gap-walls. When 0 (DEFAULT) EVERY
 * new gap-wall code path (never-naked verify-or-flatten, EOD overnight-gross trim,
 * idempotent circuit-breaker flatten) is skipped → behavior byte-identical to today.
 * Reuses the existing getLiveConfig reader (same source as every other live flag).
 */
function isElzaV45LiveEnabled(config: typeof liveEngineConfig.$inferSelect | null): boolean {
  return ((config as any)?.elzaV45LiveEnabled ?? 0) === 1;
}

// ── Intraday Armed-Watcher master switch (INERT until elzaIntradayWatcherEnabled=1) ──
/**
 * Read the inert master switch for the intraday armed-watcher (BUILD-spec F2/§3).
 * When 0 (DEFAULT) EVERY new watcher code path is skipped — the watcher tick early-
 * returns, the tiered cadence keeps today's :00/:20/:40 universe cadence, the
 * Phase-0 anti-chase gate is a no-op, and watcherStatus is null → behavior
 * byte-identical to today. Same shape/source as isElzaV45LiveEnabled. Exported so
 * the watcher (F3), alertPoller (F4) and warEngine anti-chase gate (F5) all read the
 * SAME flag from the SAME getLiveConfig source — one source of truth, live-flippable.
 */
export function isIntradayWatcherEnabled(
  config: typeof liveEngineConfig.$inferSelect | null,
): boolean {
  return ((config as any)?.elzaIntradayWatcherEnabled ?? 0) === 1;
}

/**
 * isIntradayWatcherShadow — SHADOW MODE. When elzaIntradayWatcherShadow=1 (and the live
 * flag is 0), the Armed-Watcher runs its FULL detection (ARM→CROSS→HELD_5M) and LOGS the
 * would-be entries for forward validation, but NEVER places an order / calls the war cycle.
 * Default 0 ⇒ byte-identical. Same source/shape as isIntradayWatcherEnabled.
 */
export function isIntradayWatcherShadow(
  config: typeof liveEngineConfig.$inferSelect | null,
): boolean {
  return ((config as any)?.elzaIntradayWatcherShadow ?? 0) === 1;
}

/** Israel-time date key (matches deleverageCron's day-key convention). */
function israelDateKey(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// REQ 4 / CB-3 — IDEMPOTENT FLATTEN. Per-day halt latch. Once the circuit breaker
// flattens (or Alert Mode latches on a bad NLV read) for `tradingHaltedDate`,
// re-triggers the same day are a no-op and EVERY entry path refuses ALL new entries
// while halted. The latch is BOTH module-level (fast in-process check) AND persisted
// in systemSettings (CB-3 — so two concurrent cron ticks can't both pass the
// pre-latch check). The day-key makes it self-clearing at IST midnight.
// FIX SELF-DOS (CB-4) — TWO DISTINCT LATCHES, never conflated:
//   _tradingHaltedDate  — the STICKY real-flatten latch. Set ONLY when
//                         circuitBreaker().flattenAll actually flattened the book. Never
//                         auto-cleared (re-arming intraday after a real liquidation is a
//                         human decision). Self-clears at IST midnight via the day-key.
//   _alertModeDate      — the RECOVERABLE alert-mode latch. Set when a transient bad
//                         NLV/PnL read fails closed and blocks entries. CLEARED on the
//                         next SUCCESSFUL live read IF (and only if) the day's block was
//                         alert-mode-ONLY (no real flatten ever happened) — so a single
//                         gateway blip can no longer freeze the entire trading day.
// assertNotHalted / the entry chokepoint blocks if EITHER latch is set for today.
let _tradingHaltedDate: string | null = null;
let _alertModeDate: string | null = null;
const TRADING_HALT_KEY = "elzaTradingHaltedDate"; // persisted STICKY flatten latch (CB-3)
const ALERT_MODE_KEY = "elzaAlertModeDate";       // persisted RECOVERABLE alert latch (CB-4)

/**
 * True if NEW ENTRIES are blocked for the current Israel-time day — set by EITHER the
 * sticky real-flatten latch OR the recoverable alert-mode latch.
 */
export function isTradingHaltedToday(): boolean {
  const today = israelDateKey();
  return _tradingHaltedDate === today || _alertModeDate === today;
}

/** True only if a REAL circuit-breaker flatten latched today (sticky, never auto-cleared). */
function isFlattenLatchedToday(): boolean {
  return _tradingHaltedDate === israelDateKey();
}

/** True only if alert-mode latched today (recoverable). */
function isAlertModeLatchedToday(): boolean {
  return _alertModeDate === israelDateKey();
}

/**
 * Persist + set the STICKY real-flatten halt latch for today (CB-3). Idempotent. Used
 * ONLY after an actual circuitBreaker().flattenAll. Never auto-cleared.
 */
async function latchTradingHaltToday(): Promise<void> {
  _tradingHaltedDate = israelDateKey();
  try { await setSystemSetting(TRADING_HALT_KEY, _tradingHaltedDate); } catch { /* in-proc latch stands */ }
}

/**
 * Persist + set the RECOVERABLE alert-mode latch for today (CB-4). Blocks entries on a
 * bad live read WITHOUT flattening, but can be cleared by a subsequent good read.
 */
async function latchAlertModeToday(): Promise<void> {
  _alertModeDate = israelDateKey();
  try { await setSystemSetting(ALERT_MODE_KEY, _alertModeDate); } catch { /* in-proc latch stands */ }
}

/**
 * CB-4 RECOVERY — clear the alert-mode latch after a SUCCESSFUL live read, but ONLY when
 * the day's block was alert-mode-ONLY (no real flatten ever latched). The sticky
 * flatten latch is NEVER touched here. Best-effort on the DB clear.
 */
async function clearAlertModeIfRecoverable(): Promise<void> {
  if (isFlattenLatchedToday()) return; // a real flatten happened — stays halted, sticky.
  if (!isAlertModeLatchedToday()) return; // nothing to clear.
  _alertModeDate = null;
  try { await setSystemSetting(ALERT_MODE_KEY, ""); } catch { /* in-proc clear stands */ }
}

/**
 * Hydrate BOTH in-process latches from the persisted values (CB-3/CB-4). Lets a tick
 * that did NOT itself trip the breaker still observe a halt/alert latched by a prior
 * tick / a restarted process. Only adopts a latch when its persisted day-key === today.
 */
async function syncTradingHaltFromDb(): Promise<void> {
  try {
    const today = israelDateKey();
    const storedHalt = await getSystemSetting(TRADING_HALT_KEY);
    if (storedHalt && storedHalt === today) _tradingHaltedDate = storedHalt;
    const storedAlert = await getSystemSetting(ALERT_MODE_KEY);
    if (storedAlert && storedAlert === today) _alertModeDate = storedAlert;
  } catch { /* best-effort */ }
}

/** Test-only reset of BOTH latches (never call from production paths). */
export function __resetTradingHaltForTest(): void {
  _tradingHaltedDate = null;
  _alertModeDate = null;
}

/**
 * Test-only force-set of the STICKY flatten latch to today (drives the HALT-universal
 * tests without invoking the full circuit-breaker flatten side effects).
 */
export function __forceTradingHaltForTest(): void {
  _tradingHaltedDate = israelDateKey();
}

/** Test-only force-set of the RECOVERABLE alert-mode latch to today. */
export function __forceAlertModeForTest(): void {
  _alertModeDate = israelDateKey();
}

/**
 * FIX HALT-1 — UNIVERSAL HALT CHOKEPOINT. Every path that sends an entry/add bracket
 * MUST call this at the TOP. Returns a block decision when (and ONLY when) the inert
 * flag is ON AND trading is halted today. When the flag is OFF (DEFAULT) this is a
 * no-op `{ blocked:false }` → behavior byte-identical to today. Halt = halt for the
 * ENTIRE book (longs, shorts, scale-ins, manual).
 */
export function assertNotHalted(
  config: typeof liveEngineConfig.$inferSelect | null,
): { blocked: boolean; reason: string } {
  if (isElzaV45LiveEnabled(config) && isTradingHaltedToday()) {
    return { blocked: true, reason: "Trading halted today — circuit breaker tripped (no new entries)" };
  }
  return { blocked: false, reason: "not halted" };
}

/**
 * DEFENSE MODE (regime switch) — block ALL NEW LONG ENTRIES when SPY is below its
 * daily/structural EMA-50 (a BEAR regime). The system goes to "bunker": existing longs
 * keep being managed normally by the SL/exit monitor (this gate NEVER closes anything),
 * so slots drain naturally and are NOT re-filled.
 *
 * SOURCE OF TRUTH: the owner's LITERAL spec — SPY last-close vs its DAILY EMA-50. Fetches
 * SPY daily bars (fetchBarsForTicker), computes the daily EMA-50 (calcEMA), and decides via
 * the pure getRegime(spyClose, dailyEma50) ("BULL"|"BEAR") in elzaV45Master. NOT the weekly
 * getMarketRegime() slope/vol classification — that is too insensitive (SPY below its daily
 * EMA-50 but not yet weekly-BEAR would fail to bunker).
 *
 * FAIL-CLOSED: a broken/degraded/throwing SPY read (regime.degraded === true, a thrown
 * fetch, or a non-string regime) is treated as DEFENSE MODE — NEW LONGS are BLOCKED. We
 * NEVER fail-open into new longs on an unknown regime.
 *
 * INERT: when elzaV45LiveEnabled=0 (DEFAULT) this always returns allowed:true and does
 * NOT even consult the regime — behavior byte-identical to today.
 */
export async function assertLongAllowedByRegime(
  config: typeof liveEngineConfig.$inferSelect | null,
): Promise<{ allowed: boolean; reason: string }> {
  // INERT unless the master flag is ON.
  if (!isElzaV45LiveEnabled(config)) {
    return { allowed: true, reason: "regime gate inert (flag off)" };
  }
  try {
    // LITERAL daily SPY < EMA-50 (the owner's exact spec — NOT the weekly-slope regime).
    const { fetchBarsForTicker } = await import("./marketData");
    const { calcEMA } = await import("./zivEngine");
    const { getRegime } = await import("./engine/elzaV45Master");
    const spyBars = await fetchBarsForTicker("SPY", 420);
    // FAIL-CLOSED: no/short/unreadable SPY history is NOT a trustworthy read → bunker.
    if (!spyBars || spyBars.length < 50) {
      return { allowed: false, reason: "DEFENSE_MODE — SPY bars insufficient/unavailable, longs blocked (fail-closed)" };
    }
    const closes = spyBars.map((b) => b.close);
    const spyClose = closes[closes.length - 1];
    const dailyEma50 = calcEMA(closes, 50);
    if (!Number.isFinite(spyClose) || !Number.isFinite(dailyEma50) || spyClose <= 0) {
      return { allowed: false, reason: "DEFENSE_MODE — SPY close/EMA-50 not finite, longs blocked (fail-closed)" };
    }
    // getRegime is the literal close-vs-EMA50 compare: BEAR == SPY < daily EMA-50.
    if (getRegime(spyClose, dailyEma50) === "BEAR") {
      return { allowed: false, reason: `DEFENSE_MODE — SPY $${spyClose.toFixed(2)} < daily EMA-50 $${dailyEma50.toFixed(2)}, longs blocked` };
    }
    // FC-1 (2026-06-30): SPY itself reads healthy, but if the BROADER regime is DEGRADED
    // (Insufficient SPY data / regime calc threw), its vixProxy is a synthetic placeholder
    // (20), NOT a real measurement — so the VIX>35 stress block cannot fire and we'd enter
    // on FALSE CALM. Honor this gate's own documented contract ("never fail-open into longs
    // on an unknown/degraded regime") and mirror the EOD deleverage's treatment (degraded ⇒
    // VIX untrustworthy ⇒ fail-closed). getMarketRegime is TTL-cached, so this is cheap.
    const { getMarketRegime } = await import("./runtimeIntelligence");
    const regime = await getMarketRegime();
    if (regime?.degraded === true) {
      return { allowed: false, reason: `DEFENSE_MODE — regime DEGRADED (${regime.regimeReason}), VIX untrustworthy → longs blocked (fail-closed)` };
    }
    return { allowed: true, reason: `BULL — SPY $${spyClose.toFixed(2)} > daily EMA-50 $${dailyEma50.toFixed(2)}, longs allowed` };
  } catch (e: any) {
    // A throwing SPY read is an UNKNOWN regime → fail-closed (block new longs).
    return { allowed: false, reason: `DEFENSE_MODE — SPY daily-EMA50 read threw (${e?.message ?? e}), longs blocked (fail-closed)` };
  }
}

/**
 * FIX CB-1/CB-2 — fetch LIVE broker NLV + day P&L DIRECTLY from IBKR. Reuses the EXACT
 * parse the War-Room read uses (liveEngine.ts:341-370): NetLiquidation from
 * /account/summary (nested `summary.netliquidation.amount` OR legacy per-account array)
 * and daily P&L from /pnl (`upnl.<acct>.dpl` sum, OR a flat daily_pnl). Returns
 * `{ ok:false }` (FAIL-CLOSED) whenever the read is broken / non-finite / stale so the
 * caller can enter Alert Mode rather than seed a bad baseline or pass the loss gate.
 *
 * NEVER reads liveEngineConfig.totalNlv (static, UI-refreshed) for the circuit breaker.
 */
export async function fetchLiveNlvAndDayPnl(
  _userId: number,
): Promise<{ ok: true; nlvNow: number; brokerDayPnlUsd: number } | { ok: false; reason: string }> {
  let acctRes: any, pnlRes: any;
  try {
    [acctRes, pnlRes] = await Promise.all([
      ibindCached("GET", "/account/summary", undefined, 4_000).catch(() => ({ ok: false, status: 503, body: null })),
      ibindCached("GET", "/pnl", undefined, 4_000).catch(() => ({ ok: false, status: 503, body: null })),
    ]);
  } catch (e: any) {
    return { ok: false, reason: `IBKR read threw: ${e?.message ?? e}` };
  }

  // ── NLV — from /account/summary (same two shapes as the War-Room read) ──
  const acctBody: any = acctRes?.ok ? acctRes.body : null;
  let nlvNow: number | undefined;
  if ((acctBody?.summary?.netliquidation?.amount ?? 0) > 0) {
    nlvNow = acctBody.summary.netliquidation.amount;
  } else if (Array.isArray(acctBody?.[LIVE_ACCOUNT_ID])) {
    const nlvEntry = (acctBody[LIVE_ACCOUNT_ID] as any[]).find((e: any) =>
      (e?.key ?? e?.tag ?? "").toLowerCase() === "netliquidation");
    nlvNow = nlvEntry?.amount ?? nlvEntry?.value;
  }
  if (!(typeof nlvNow === "number" && Number.isFinite(nlvNow) && nlvNow > 0)) {
    return { ok: false, reason: "NLV read broken/non-finite (failing CLOSED)" };
  }

  // ── Daily P&L — from /pnl (upnl.<acct>.dpl sum, or flat daily_pnl) ──
  // The day P&L read MUST succeed too: a missing /pnl body cannot be silently treated
  // as a $0 day (that would feed a 0% pct and PASS the loss gate). Fail closed.
  const pnlBody: any = pnlRes?.ok ? pnlRes.body : null;
  if (!pnlBody) {
    return { ok: false, reason: "Day-P&L read broken (failing CLOSED)" };
  }
  let brokerDayPnlUsd: number | undefined;
  const partitions: Record<string, any> = pnlBody.upnl ?? {};
  const keys = Object.keys(partitions);
  if (keys.length > 0) {
    brokerDayPnlUsd = 0;
    let sawDpl = false;
    for (const k of keys) {
      if (typeof partitions[k]?.dpl === "number") { brokerDayPnlUsd += partitions[k].dpl; sawDpl = true; }
    }
    if (!sawDpl) brokerDayPnlUsd = undefined;
  } else if (typeof (pnlBody.daily_pnl ?? pnlBody.dailyPnl) === "number") {
    brokerDayPnlUsd = pnlBody.daily_pnl ?? pnlBody.dailyPnl;
  }
  if (!(typeof brokerDayPnlUsd === "number" && Number.isFinite(brokerDayPnlUsd))) {
    return { ok: false, reason: "Day-P&L non-finite (failing CLOSED)" };
  }

  return { ok: true, nlvNow, brokerDayPnlUsd };
}

/**
 * FIX NN-1 — read the ACTUAL held qty for a ticker at the broker via /positions.
 * Returns the signed-absolute held quantity for the matched conid, OR a confirmed `0`
 * when the read SUCCEEDS but the ticker is not in the book. Returns `null` (UNKNOWN)
 * whenever the read itself is unusable: `!res.ok`, a throw, or an unparseable body.
 *
 * CRITICAL (reverse-race remediation): `null` is NOT `0`. A degraded/lagging /positions
 * read must NEVER be silently treated as "broker holds nothing" — that is exactly how a
 * genuinely-filled entry becomes a naked, untracked position. The never-naked branch
 * only aborts a flatten when this returns a POSITIVELY-CONFIRMED `0`.
 * Matches on conid first, then ticker.
 */
async function readBrokerPositionQty(conid: number | null, ticker: string): Promise<number | null> {
  try {
    const res = await ibindRequest("GET", "/positions");
    if (!res.ok) return null; // UNKNOWN — never collapse a degraded read to "holds 0".
    const body: any = res.body;
    if (!(Array.isArray(body) || Array.isArray(body?.positions))) return null; // unparseable ⇒ UNKNOWN
    const rows: any[] = Array.isArray(body) ? body : body.positions;
    const wantConid = conid != null ? String(conid) : null;
    const wantTk = ticker.toUpperCase().trim();
    for (const p of rows) {
      const pConid = p?.conid ?? p?.conidEx ?? null;
      const pTk = String(p?.contractDesc ?? p?.ticker ?? "").toUpperCase().trim();
      const conidMatch = wantConid != null && pConid != null && String(pConid) === wantConid;
      const tickerMatch = pTk !== "" && pTk === wantTk;
      if (conidMatch || tickerMatch) {
        return Math.abs(Number(p?.position ?? 0)) || 0;
      }
    }
    return 0; // CONFIRMED read, ticker not in book ⇒ genuinely flat.
  } catch {
    return null; // throw ⇒ UNKNOWN
  }
}

/**
 * REQ 1 — NEVER-NAKED decision (PURE, unit-testable). Given the bracket entry
 * outcome and the resolved SL leg, decide whether the position is NAKED (entry took
 * on size but no live stop confirmed) and must be force-flattened.
 *   entryHasSize  — entry leg accepted/filled (any qty on the book)
 *   slOrderId     — confirmed live SL/stop child order id (null = unconfirmed)
 * Returns true ⇒ caller must executeLiveSell(reason:"NAKED_SL_FLATTEN").
 */
export function isNakedAfterBracket(entryHasSize: boolean, slOrderId: string | null | undefined): boolean {
  return entryHasSize === true && (slOrderId == null || String(slOrderId).length === 0);
}

/**
 * REQ 4 — IDEMPOTENT FLATTEN trigger. Evaluates circuitBreaker(portfolioDayPnlPct)
 * and, on flattenAll, calls emergencyExitAll(userId) EXACTLY ONCE per IST day, latches
 * the halt, and blocks all new entries via isTradingHaltedToday(). A re-trigger the
 * same day is a no-op (no double-flatten). Reuses the existing emergencyExitAll loop
 * (itself partial-fill-safe). Returns the action taken for the caller to log/alert.
 * GUARDED BY THE FLAG at the call site — this fn assumes the flag is already ON.
 */
export async function maybeCircuitBreakerFlatten(
  userId: number,
  portfolioDayPnlPct: number,
): Promise<{ halted: boolean; flattened: boolean; alreadyHalted: boolean; reason: string }> {
  // CB-3: adopt a latch a prior/concurrent tick may have already persisted.
  await syncTradingHaltFromDb();
  const cb = circuitBreaker(portfolioDayPnlPct, ELZA_V45_CFG);
  if (!cb.flattenAll) {
    return { halted: false, flattened: false, alreadyHalted: false, reason: cb.reason };
  }
  // Idempotent: already halted today → no-op (no double-flatten).
  if (isTradingHaltedToday()) {
    return { halted: true, flattened: false, alreadyHalted: true, reason: `already halted today — ${cb.reason}` };
  }
  // Latch (in-proc + persisted) BEFORE flattening so a concurrent re-entry observes the
  // halt and cannot launch a second emergencyExitAll pass (emergencyExitAll is itself
  // idempotent on already-closed rows, but the latch makes the double-flatten impossible).
  await latchTradingHaltToday();
  log.error("LIVE_EXEC", `[CIRCUIT-BREAKER] flattenAll — ${cb.reason}. Halting trading for ${_tradingHaltedDate} and flattening all.`);
  await emergencyExitAll(userId);
  return { halted: true, flattened: true, alreadyHalted: false, reason: cb.reason };
}

/**
 * FIX CB-1/CB-2/CB-3 — the LIVE-BROKER circuit-breaker tick. Reads LIVE NLV + day P&L
 * directly from IBKR (fetchLiveNlvAndDayPnl), derives the day-open baseline as
 * NLV_now − brokerDayPnlUsd (correct even on the very first tick — no first-tick-seed
 * dependency), computes portfolioDayPnlPct = brokerDayPnlUsd / dayOpenNlv, and feeds
 * the PURE circuitBreaker the LIVE pct.
 *
 * FAIL-CLOSED: a broken / non-finite / stale NLV-or-PnL read enters ALERT MODE — latch
 * the halt (block ALL new entries) and signal the caller to fire a 🚨 War-Room alert.
 * It does NOT flatten on bad data and does NOT seed a bad baseline.
 *
 * Returns the action taken so the cron logs / alerts. GUARDED BY THE FLAG at the call
 * site (cron only invokes this behind elzaV45LiveEnabled=1).
 */
export async function runCircuitBreakerTick(
  userId: number,
): Promise<{
  mode: "ok" | "flattened" | "already-halted" | "alert";
  halted: boolean;
  flattened: boolean;
  alertFired: boolean;
  portfolioDayPnlPct: number | null;
  nlvNow: number | null;
  dayOpenNlv: number | null;
  reason: string;
}> {
  await syncTradingHaltFromDb();

  const stealGraceRem = await getBrokerageStealGraceRemainingSec();
  if (stealGraceRem > 0) {
    // Mobile SESSION-STEAL grace — NLV/P&L reads fail expectedly; do not latch or Telegram-flood.
    await clearAlertModeIfRecoverable();
    return {
      mode: "ok",
      halted: false,
      flattened: false,
      alertFired: false,
      portfolioDayPnlPct: null,
      nlvNow: null,
      dayOpenNlv: null,
      reason: `SESSION-STEAL grace (${stealGraceRem}s)`,
    };
  }

  const live = await fetchLiveNlvAndDayPnl(userId);
  if (!live.ok) {
    // ── ALERT MODE (fail-closed) — block ALL new entries; do NOT flatten, do NOT seed. ──
    // CB-4: use the RECOVERABLE alert-mode latch (NOT the sticky flatten latch) so a
    // subsequent good read can resume entries instead of freezing the whole day.
    const wasHalted = isAlertModeLatchedToday() || isFlattenLatchedToday();
    await latchAlertModeToday();
    log.error("LIVE_EXEC", `[CIRCUIT-BREAKER] ALERT MODE — ${live.reason}. Blocking all new entries (no flatten, no baseline seeded).`);
    if (!wasHalted) {
      try {
        void sendTelegramMessage(
          `🚨 <b>CIRCUIT BREAKER — ALERT MODE</b>\n` +
          `Live NLV / day-P&L read FAILED: ${live.reason}\n` +
          `ALL new entries BLOCKED for the day (fail-closed). No flatten performed — verify the gateway.`
        ).catch(() => {});
      } catch { /* best-effort */ }
    }
    return {
      mode: "alert", halted: true, flattened: false, alertFired: !wasHalted,
      portfolioDayPnlPct: null, nlvNow: null, dayOpenNlv: null, reason: live.reason,
    };
  }

  // Baseline that needs NO first-tick seed: day-open NLV = NLV_now − brokerDayPnlUsd.
  const dayOpenNlv = live.nlvNow - live.brokerDayPnlUsd;
  if (!(Number.isFinite(dayOpenNlv) && dayOpenNlv > 0)) {
    // Derived baseline is unusable → also Alert Mode (fail-closed), never seed garbage.
    // CB-4: recoverable alert latch, not the sticky flatten latch.
    const wasHalted = isAlertModeLatchedToday() || isFlattenLatchedToday();
    await latchAlertModeToday();
    log.error("LIVE_EXEC", `[CIRCUIT-BREAKER] ALERT MODE — derived dayOpenNlv=${dayOpenNlv} unusable. Blocking all new entries.`);
    if (!wasHalted) {
      try {
        void sendTelegramMessage(
          `🚨 <b>CIRCUIT BREAKER — ALERT MODE</b>\n` +
          `Derived day-open NLV unusable (NLV $${live.nlvNow.toFixed(0)} − dayPnl $${live.brokerDayPnlUsd.toFixed(0)}). ALL new entries BLOCKED.`
        ).catch(() => {});
      } catch { /* best-effort */ }
    }
    return {
      mode: "alert", halted: true, flattened: false, alertFired: !wasHalted,
      portfolioDayPnlPct: null, nlvNow: live.nlvNow, dayOpenNlv: null, reason: "derived dayOpenNlv unusable",
    };
  }

  // CB-4 RECOVERY — this read SUCCEEDED. If the day's block was alert-mode-ONLY (a
  // transient gateway blip, no real flatten ever happened), clear the alert latch and
  // resume entries. A real flatten latch stays STICKY (clearAlertModeIfRecoverable
  // leaves it untouched).
  await clearAlertModeIfRecoverable();

  const portfolioDayPnlPct = live.brokerDayPnlUsd / dayOpenNlv;
  const res = await maybeCircuitBreakerFlatten(userId, portfolioDayPnlPct);
  const mode: "ok" | "flattened" | "already-halted" =
    res.flattened ? "flattened" : res.alreadyHalted ? "already-halted" : "ok";
  return {
    mode, halted: res.halted, flattened: res.flattened, alertFired: false,
    portfolioDayPnlPct, nlvNow: live.nlvNow, dayOpenNlv, reason: res.reason,
  };
}
// ── OPTIMISTIC BUYING-POWER LEDGER (batch-fire margin race remediation) ─────────
// PROBLEM: when two Hit-List names break out in the SAME war cycle, IBKR's BuyingPower
// has not updated between the two order transmits, so the 2nd bracket is sent and
// REJECTED for insufficient margin. FIX: an in-memory optimistic ledger that decrements
// IMMEDIATELY on transmit (before the fill), so the next entry in the same cycle is gated
// against the reduced figure — pre-empting exactly the rejection IBKR would already make.
//
// INERT-SAFE / FAIL-OPEN contract (NON-NEGOTIABLE):
//   • _optimisticBP == null  ⇒  NOT YET SYNCED. The gate NEVER blocks (IBKR decides).
//     Never block a legitimate entry on a stale/unsynced ledger.
//   • resyncOptimisticBP() is called at the TOP of each war cycle to seed from broker
//     truth. On a broker-read FAILURE it KEEPS the last-known-good value (does NOT null
//     it, does NOT block) — fail-open/conservative.
//   • At steady state _optimisticBP ≈ real BP, so the gate only rejects what IBKR would
//     reject anyway. After a clean resync the FIRST entry of a cycle is gated against the
//     full broker BP, so it can never be falsely blocked.
let _optimisticBP: number | null = null;

/**
 * Read the LIVE broker buying power from /account/summary (same body + two shapes the
 * War-Room read uses: nested `summary.buyingpower.amount` OR legacy per-account
 * `[{ key:"BuyingPower", amount }]`). Returns null when the read is broken / non-finite
 * so the caller can KEEP the last-known-good ledger value rather than null it.
 */
async function readBrokerBuyingPower(): Promise<number | null> {
  let acctRes: any;
  try {
    acctRes = await ibindCached("GET", "/account/summary", undefined, 4_000)
      .catch(() => ({ ok: false, status: 503, body: null }));
  } catch {
    return null;
  }
  const body: any = acctRes?.ok ? acctRes.body : null;
  if (!body) return null;
  // Shape 1 (current IBIND): { summary: { buyingpower: { amount } } }
  const nested = body?.summary?.buyingpower?.amount ?? body?.summary?.buyingpower;
  if (typeof nested === "number" && Number.isFinite(nested) && nested >= 0) return nested;
  // Shape 2 (legacy): { U16881054: [ { key:"BuyingPower", amount } ] }
  if (Array.isArray(body?.[LIVE_ACCOUNT_ID])) {
    const entry = (body[LIVE_ACCOUNT_ID] as any[]).find((e: any) =>
      String(e?.key ?? e?.tag ?? "").toLowerCase() === "buyingpower");
    const v = entry?.amount ?? entry?.value;
    const vn = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(vn) && vn >= 0) return vn;
  }
  return null;
}

/**
 * resyncOptimisticBP — reseed the optimistic buying-power ledger from LIVE broker truth.
 * Called at the TOP of runWarEngineCycle so each cycle starts from broker reality.
 *
 * FAIL-OPEN: on a broker-read failure (non-finite / gateway flake) the LAST-KNOWN-GOOD
 * value is KEPT — never nulled, never zeroed — so a transient read failure can never
 * turn the gate into a hard block, and equally never erases a within-cycle decrement.
 * Returns the value now in effect (or null if never yet synced).
 */
export async function resyncOptimisticBP(_userId: number): Promise<number | null> {
  const bp = await readBrokerBuyingPower();
  if (bp != null && Number.isFinite(bp)) {
    _optimisticBP = bp;
    log.debug("LIVE_EXEC", `[OptimisticBP] resynced from broker: $${bp.toFixed(0)}`);
  } else {
    log.warn("LIVE_EXEC", `[OptimisticBP] broker BP read failed — keeping last-known-good ($${_optimisticBP == null ? "null/unsynced" : _optimisticBP.toFixed(0)})`);
  }
  return _optimisticBP;
}

/**
 * peekOptimisticBP — read the SHARED optimistic buying-power ledger (null = unsynced).
 * Used by the Waiter (resting-LMT path) to gate against the SAME ledger the war cycle /
 * Armed-Watcher use — one shared budget, no separate sleeve. Read-only; never mutates.
 */
export function peekOptimisticBP(): number | null {
  return _optimisticBP;
}

/**
 * reserveOptimisticBP — decrement the SHARED ledger on a resting-LMT TRANSMIT (spec §3:
 * "a resting LMT decrements _optimisticBP the moment it's sent"). FAIL-OPEN: when the
 * ledger is unsynced (null) it is left null (the gate never blocks on a stale ledger).
 * Mirrors the in-cycle decrement tryLiveEntry does after a bracket transmit, so a burst
 * of Waiter fills can't blow the shared bound. Returns the value now in effect.
 */
export function reserveOptimisticBP(usd: number): number | null {
  if (_optimisticBP != null && Number.isFinite(usd) && usd > 0) {
    _optimisticBP -= usd;
    log.debug("LIVE_EXEC", `[OptimisticBP] Waiter reserved $${usd.toFixed(0)} → available $${_optimisticBP.toFixed(0)}`);
  }
  return _optimisticBP;
}

/**
 * releaseOptimisticBP — credit the SHARED ledger back when a reserved resting LMT is
 * CANCELLED before fill (the committed margin is returned). FAIL-OPEN on an unsynced
 * ledger. Symmetric to reserveOptimisticBP; next cycle's resyncOptimisticBP reseeds from
 * broker truth so this estimate never drifts.
 */
export function releaseOptimisticBP(usd: number): number | null {
  if (_optimisticBP != null && Number.isFinite(usd) && usd > 0) {
    _optimisticBP += usd;
    log.debug("LIVE_EXEC", `[OptimisticBP] Waiter released $${usd.toFixed(0)} → available $${_optimisticBP.toFixed(0)}`);
  }
  return _optimisticBP;
}

/** Test-only reset of the optimistic ledger (never call from production paths). */
export function __resetOptimisticBPForTest(): void {
  _optimisticBP = null;
}

/** Test-only force-set of the optimistic ledger (drives gate tests deterministically). */
export function __setOptimisticBPForTest(v: number | null): void {
  _optimisticBP = v;
}

const LIVE_CYCLE_GAP_MS = 60_000; // minimum 60s between SL monitor cycles
/** REST poller updates every 1.5s — treat older cache rows as stale */
const POLLER_PRICE_MAX_AGE_MS = 15_000;

/**
 * SL-MONITOR tick price (source-gated per the live-order price-source ADR).
 *
 * A price used to evaluate a LIVE software stop-loss MUST be real-time IBKR
 * truth and fresh — otherwise the software monitor could trigger (or fail to
 * trigger) an exit off a Yahoo/DB-cache/stale-EOD print. The only IBKR-fresh
 * tick source here is the ibkrQuotesPoller REST cache (POST /quotes → IBKR
 * broker truth), age-gated by POLLER_PRICE_MAX_AGE_MS.
 *
 * Returns:
 *   { price, fresh: true }  — an IBKR-fresh tick this cycle (safe to evaluate SL)
 *   { price, fresh: false } — no IBKR-fresh tick; `price` is a DISPLAY-ONLY
 *                             fallback (broker /positions mktPrice → DB →
 *                             entryPrice) for P&L/UI persistence ONLY. SL-breach
 *                             logic must NOT fire off this value — the broker-side
 *                             OCA stop remains the primary protection.
 */
function resolveMonitorTickPrice(
  ticker: string,
  ibkrMktPrice?: number | null,
  dbCurrentPrice?: number | null,
  entryPrice?: number,
): { price: number; fresh: boolean } {
  const polled = getPriceByTicker(ticker);
  if (polled?.last != null && polled.last > 0) {
    const ageMs = Date.now() - polled.updatedAt;
    if (ageMs <= POLLER_PRICE_MAX_AGE_MS) return { price: polled.last, fresh: true };
  }
  // No IBKR-fresh tick this cycle — fall through to a DISPLAY-ONLY value so the
  // DB row / P&L stays populated, but flag it not-fresh so the SL monitor skips.
  if (ibkrMktPrice != null && ibkrMktPrice > 0) return { price: ibkrMktPrice, fresh: false };
  if (dbCurrentPrice != null && dbCurrentPrice > 0) return { price: dbCurrentPrice, fresh: false };
  return { price: entryPrice ?? 0, fresh: false };
}

// ── Market hours check (Israel time) ─────────────────────────────────────────
export function isLiveMarketOpen(): boolean {
  const now = new Date();
  // Israel time = UTC+3
  const israelHour = (now.getUTCHours() + 3) % 24;
  const israelMin  = now.getUTCMinutes();
  const totalMins  = israelHour * 60 + israelMin;
  const openMins   = 16 * 60 + 30;  // 16:30
  const closeMins  = 23 * 60 + 0;   // 23:00
  return totalMins >= openMins && totalMins < closeMins;
}

// ── Get or init config ────────────────────────────────────────────────────────
export async function getLiveConfig(userId: number): Promise<typeof liveEngineConfig.$inferSelect | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(liveEngineConfig).where(eq(liveEngineConfig.userId, userId)).limit(1);
  if (rows.length > 0) return rows[0];
  // Init default config
  await db.insert(liveEngineConfig).values({
    userId,
    isEnabled: 0,
    allocatedPct: 10,
    maxPositions: 5,
    positionSizePct: 10,
    marketOpen: "16:30",
    marketClose: "23:00",
    accountId: LIVE_ACCOUNT_ID,
    totalNlv: 120000,
    dailyLossEnabled: 1,
    dailyLossLimitUsd: 2000,
  });
  const rows2 = await db.select().from(liveEngineConfig).where(eq(liveEngineConfig.userId, userId)).limit(1);
  return rows2[0] ?? null;
}

export async function updateLiveConfig(userId: number, patch: Partial<typeof liveEngineConfig.$inferInsert>): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(liveEngineConfig).set(patch).where(eq(liveEngineConfig.userId, userId));
}

// ── Compute available capital ─────────────────────────────────────────────────
// ─── Leverage helpers ─────────────────────────────────────────────────────────
function isIntradayWindow(config: typeof liveEngineConfig.$inferSelect): boolean {
  // true during 16:30 – 22:45 Israel time (intraday leverage window)
  const now      = new Date();
  const ilHour   = (now.getUTCHours() + 3) % 24;
  const ilMinute = now.getUTCMinutes();
  const ilTotal  = ilHour * 60 + ilMinute;
  const cutoff   = (config as any).deleverageCutoffTime ?? "22:45";
  const [cutH, cutM] = cutoff.split(":").map(Number);
  const cutoffTotal  = cutH * 60 + cutM;
  return ilTotal >= (16 * 60 + 30) && ilTotal < cutoffTotal;
}

export function computeLiveCapital(config: typeof liveEngineConfig.$inferSelect): {
  totalNlv: number;
  allocatedCapital: number;    // buying power NOW (leverage applied)
  perPositionSize: number;     // target per position
  cashBudget: number;          // base cash — no leverage
  isIntraday: boolean;
  multiplier: number;
  overnightCap: number;        // overnight hard cap in USD
} {
  const nlv          = config.totalNlv ?? 120000;
  const allocPct     = (config.allocatedPct ?? 40) / 100;
  const maxPos       = Math.max(config.maxPositions ?? 28, 1);
  const cashBudget   = nlv * allocPct;

  const intraday     = isIntradayWindow(config);
  // ── Hard leverage clamps (owner safety envelope) ──
  // INTRADAY multiplier ∈ [0, 4]; OVERNIGHT multiplier ∈ [0, 2].
  // A config value outside the range is a fat-finger and is clamped, never honored.
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  const rawInt = Number((config as any).intradayMultiplier  ?? 1.9);
  const rawOvr = Number((config as any).overnightMultiplier ?? 1.9);
  const safeInt = Number.isNaN(rawInt) ? 1.9 : rawInt;
  const safeOvr = Number.isNaN(rawOvr) ? 1.9 : rawOvr;
  const intMult = clamp(safeInt, 0, 4);
  const ovrMult = clamp(safeOvr, 0, 2);
  if (safeInt < 0 || safeInt > 4) {
    log.warn(`[LeverageClamp] intradayMultiplier ${rawInt} out of [0,4] → clamped to ${intMult}`);
  }
  if (safeOvr < 0 || safeOvr > 2) {
    log.warn(`[LeverageClamp] overnightMultiplier ${rawOvr} out of [0,2] → clamped to ${ovrMult}`);
  }
  const multiplier   = intraday ? intMult : ovrMult;

  const allocatedCapital = cashBudget * multiplier;
  const overnightCap     = cashBudget * ovrMult;
  // Clamp perPositionSize by min/max USD from config
  const minPosUsd = (config as any).minPositionUsd ?? 1000;
  const maxPosUsd = (config as any).maxPositionUsd ?? DEFAULT_MAX_POSITION_USD;
  const rawPerPos = allocatedCapital / maxPos;
  const perPositionSize = Math.min(Math.max(rawPerPos, minPosUsd), maxPosUsd);

  return { totalNlv: nlv, allocatedCapital, perPositionSize, cashBudget, isIntraday: intraday, multiplier, overnightCap, minPosUsd, maxPosUsd };
}

// ── Place a LIVE entry order ──────────────────────────────────────────────────
export interface LiveEntryParams {
  userId: number;
  ticker: string;
  direction: "long" | "short";
  signal: string;
  zivScore: number;
  currentPrice: number;
  slPrice: number;
  tpPrice: number;
  positionSizeUsd: number;
  sector?: string;
  companyName?: string;
  entryStructMeta?: string | null;   // Ziv ledger-fix: route/weekly/zone snapshot persisted on the row
  // ── STOP-BASIS PARITY (flag=1 long path only; optional, INERT when absent) ──
  // warEngine's CV-B sizing computes the wide-lung stop ONCE off (scan currentPrice,
  // ema50FromBars(420-bar bars)) and divides risk by it to get the share count. When
  // these are passed, tryLiveEntry uses THIS EXACT stop as the SSOT broker stop + the
  // Golden-ladder rValue basis, so perShareRisk (sizing) == rValue (broker+ladder) is an
  // algebraic identity — no second EMA-50 bar-count / re-fetched-price divergence. The
  // resolved IBKR fill price remains the ONLY allowed residual (modeled slippage). When
  // omitted (shorts, manual/alert paths, flag=0) tryLiveEntry recomputes as before.
  sizingStop?: number;          // = elzaWideLungSL(sizingEntryPrice, ema50FromBars(bars), dir)
  sizingEntryPrice?: number;    // = the scan currentPrice the share-count was sized off
  // ── Phoenix lineage (optional; only set on a PHOENIX_REENTRY). Default 0/undefined ⇒
  //    a normal entry, byte-identical to today. Stamped onto the new livePositions row.
  phoenixGeneration?: number;   // 1 on a phoenix re-entry child
  originPosId?: number;         // the stopped origin's livePositions.id
}

// ── Ziv Rotation Flush ────────────────────────────────────────────────────────
// When the book is at Max Positions and a TOP-conviction Tier-4 Power Breakout
// arrives, displace the single weakest dead-money long (low Ziv Health, aged ≥72h,
// not yet de-risked) to free its slot. Behind the inert `zivRotationFlushEnabled`
// flag (default 0). FAIL-CLOSED throughout: ANY miss / unknown ⇒ no flush, caller
// falls back to the normal Max-positions reject. Exactly ONE rotation, no loop.
const ZIV_FLUSH_MIN_AGE_H = 72;
const ZIV_FLUSH_HEALTH_THRESHOLD = 5.0;   // weakest must score STRICTLY below this
const ZIV_FLUSH_BREAKOUT_MIN_SCORE = 9.0; // Tier-4 admission floor

async function attemptZivRotationFlush(args: {
  userId: number;
  config: any;
  openPos: any[];
  newTicker: string;
  newSignal: string;
  newZivScore: number;
  newDirection: "long" | "short";
}): Promise<{ flushed: boolean; freedPositionId?: number; reason: string }> {
  const { userId, config, openPos, newTicker, newSignal, newZivScore, newDirection } = args;

  // 1) TRIGGER GATE — every condition must hold, else inert.
  if (config?.zivRotationFlushEnabled !== 1 || config?.elzaV45LiveEnabled !== 1) {
    return { flushed: false, reason: "rotation flush disabled" };
  }
  if (newDirection !== "long") {
    return { flushed: false, reason: "rotation flush long-only" };
  }
  if (newSignal !== "GOLD_BREAKOUT_WAR" || !(newZivScore >= ZIV_FLUSH_BREAKOUT_MIN_SCORE)) {
    return { flushed: false, reason: "not a Tier-4 power breakout" };
  }

  // 2) CANDIDATE FILTER — only a settled, aged, not-yet-de-risked long may be flushed.
  const newTickerU = newTicker.toUpperCase();
  const candidates = openPos.filter((p) => {
    if (p.status !== "open") return false;                 // never pending/zombie/frozen
    if (p.direction !== "long") return false;              // never flush a short for a long
    if (p.isFreeRolled === 1) return false;                // already de-risked
    if (p.slMovedToBreakEven === 1) return false;          // already at break-even
    if (p.ticker?.toUpperCase() === newTickerU) return false;
    const ageH = (Date.now() - new Date(p.openedAt).getTime()) / 3_600_000;
    if (!(ageH >= ZIV_FLUSH_MIN_AGE_H)) return false;      // must be aged ≥72h (NaN ⇒ excluded)
    return true;
  });
  if (candidates.length === 0) {
    return { flushed: false, reason: "no eligible flush candidate" };
  }

  // 3) SCORE each candidate, fail-safe per candidate (unknown ⇒ Infinity ⇒ protected).
  let weakest: any = null;
  let weakestHealth = Infinity;
  for (const pos of candidates) {
    let health = Infinity; // unknown ⇒ treat as healthy ⇒ NOT flushed
    try {
      const bars = await fetchBarsForTicker(pos.ticker, 90);
      const minutesInTrade = (Date.now() - new Date(pos.openedAt).getTime()) / 60000;
      const r = calcZivHScore(bars, pos.entryPrice, pos.currentSl, pos.currentTp, {
        minutesInTrade,
        buyScore: pos.zivScore ?? null,
        peakPrice: pos.peakPrice ?? null,
        ibkrUnrealizedPnl: pos.unrealizedPnl ?? null,
      });
      health = r.score;
    } catch {
      /* unknown ⇒ stays Infinity ⇒ protected */
    }
    if (health < weakestHealth) {
      weakestHealth = health;
      weakest = pos;
    }
  }

  // 4) EXECUTION GATE — only displace a genuinely weak (sub-threshold) position.
  if (!weakest || !(weakestHealth < ZIV_FLUSH_HEALTH_THRESHOLD)) {
    return { flushed: false, reason: `weakest Ziv <threshold not met (min ${weakestHealth.toFixed(1)})` };
  }

  // 5) EXECUTE the displacement via the tracked exit primitive.
  const healthStr = weakestHealth.toFixed(1);
  const sell = await executeLiveSell({ userId, positionId: weakest.id, reason: "ZIV_ROTATION_FLUSH" });
  if (!sell.success) {
    await sendTelegramMessage(
      `🟠 ROTATION-FLUSH-FAILED ${weakest.ticker} (Ziv ${healthStr}) could not be displaced for ${newTicker} Tier-4 ${newZivScore} — ${sell.reason}`,
    );
    return { flushed: false, reason: `rotation flush sell failed: ${sell.reason}` };
  }

  log.warn("LIVE_EXEC", `🔄 [ROTATION-FLUSH] ${weakest.ticker} (Ziv ${healthStr}, id=${weakest.id}) displaced for ${newTicker} Tier-4 breakout (${newZivScore})`);
  await sendTelegramMessage(
    `🔄 ROTATION-FLUSH ${weakest.ticker} (Ziv ${healthStr}) displaced for ${newTicker} Tier-4 ${newZivScore}`,
  );
  return { flushed: true, freedPositionId: weakest.id, reason: `flushed ${weakest.ticker} Ziv ${healthStr}` };
}

export async function tryLiveEntry(params: LiveEntryParams): Promise<{ entered: boolean; reason: string; orderId?: string | null; sl?: number; tp?: number }> {
  const { userId, ticker, direction, signal, zivScore, currentPrice, slPrice, tpPrice, positionSizeUsd, sizingStop, sizingEntryPrice } = params;

  const config = await getLiveConfig(userId);
  if (!config || !config.isEnabled) {
    return { entered: false, reason: "Live engine disabled" };
  }

  // HALT-1 — UNIVERSAL HALT CHOKEPOINT (checked FIRST). Block ALL new entries while the
  // circuit breaker (or Alert Mode) has halted today — regardless of clock/market hours.
  // Routed through assertNotHalted so every entry path shares ONE chokepoint. Guarded by
  // the inert flag inside the helper: when elzaV45LiveEnabled=0 the latch is never set and
  // this is a no-op (identical to today).
  const haltCheck = assertNotHalted(config);
  if (haltCheck.blocked) {
    log.warn("LIVE_EXEC", `[CIRCUIT-BREAKER] ${ticker} entry blocked — trading halted today (circuit breaker tripped).`);
    return { entered: false, reason: haltCheck.reason };
  }

  // DEFENSE MODE (regime switch) — block ALL NEW LONG entries when SPY<EMA50 (BEAR).
  // Covers EVERY long path (warEngine, manual, alertPoller; pyramid via its own gate)
  // because they all funnel through tryLiveEntry. SHORT is unaffected (backtest-only).
  // INERT when elzaV45LiveEnabled=0; FAIL-CLOSED (block) on a degraded/throwing SPY read.
  if (direction === "long") {
    const regimeCheck = await assertLongAllowedByRegime(config);
    if (!regimeCheck.allowed) {
      log.warn("LIVE_EXEC", `[DEFENSE-MODE] ${ticker} long entry blocked — ${regimeCheck.reason}`);
      return { entered: false, reason: regimeCheck.reason };
    }
  }

  if (!isLiveMarketOpen()) {
    return { entered: false, reason: "Market closed (outside 16:30-23:00 Israel)" };
  }

  const db = await getDb();
  if (!db) return { entered: false, reason: "DB unavailable" };

  // ── IPO_INCUBATOR gate (Phase: kinetic catalogue) ─────────────────────────
  const assetRows = await db.select({
    catalogStatus: userAssets.catalogStatus,
  }).from(userAssets)
    .where(and(eq(userAssets.userId, userId), eq(userAssets.ticker, ticker.toUpperCase())))
    .limit(1);
  const catalogStatus = assetRows[0]?.catalogStatus ?? null;
  if (blocksElzaEntry(catalogStatus)) {
    let barCount: number | undefined;
    try {
      const bars = await fetchBarsForTicker(ticker, 90);
      barCount = bars.length;
    } catch { /* non-fatal */ }
    const block = elzaEntryBlockReason(ticker, catalogStatus, barCount);
    if (block) {
      log.block("LIVE_EXEC", block, { ticker, catalogStatus, barCount, minBars: KINETIC_MIN_BARS });
      return { entered: false, reason: block };
    }
  }

  // Check max positions + duplicate ticker (open OR pending — uq_open_ticker is per-status)
  // ELZA 2.0 QA fix: include `zombie` — a zombie still occupies capital + a slot at
  // IBKR, so it must count against maxPositions and the deployed-capital budget below.
  const activeStatuses = ["open", "pending_entry", "pending_exit", "zombie"] as const;
  const openPos = await db.select().from(livePositions)
    .where(and(
      eq(livePositions.userId, userId),
      inArray(livePositions.status, [...activeStatuses]),
    ));
  // ── Ghost Slots: a ghosted row no longer consumes a slot, so exclude it from the
  //    slot COUNT (the duplicate-ticker block below still sees ALL rows incl. ghosts →
  //    ADR-G2: ghost ∈ openTickerSet, still blocked). INERT when ghostSlotsEnabled=0:
  //    rowCountsTowardSlot honors every row → slotCount === openPos.length (byte-identical).
  //    G1-B: this is the slot governor ONLY — the IBKR-gross/budget cap below binds
  //    independently, so a freed slot with no capital headroom still yields no entry.
  const _ghostOn = isGhostSlotsEnabled(config as any);
  const slotCount = openPos.filter((p) => rowCountsTowardSlot(p as any, _ghostOn)).length;
  if (slotCount >= config.maxPositions) {
    // ── Ziv Rotation Flush (inert unless zivRotationFlushEnabled=1) ──
    // At/over max: a TOP Tier-4 power breakout may displace the single weakest
    // dead-money long to free its slot. On success FALL THROUGH (exactly ONE
    // rotation, no loop); on any miss keep the original Max-positions reject.
    const flush = await attemptZivRotationFlush({
      userId, config, openPos,
      newTicker: ticker, newSignal: signal, newZivScore: zivScore, newDirection: direction,
    });
    if (!flush.flushed) {
      return { entered: false, reason: `Max positions reached (${config.maxPositions}) — ${flush.reason}` };
    }
    // flushed:true ⇒ a slot was freed; proceed with this entry.
  }

  // Block duplicate ticker across open + pending (prevents uq_open_ticker violation)
  const dup = openPos.find(p => p.ticker.toUpperCase() === ticker.toUpperCase());
  if (dup) {
    return { entered: false, reason: `${ticker} already active (${dup.status}) — no duplicate entry` };
  }

  // Compute capital
  const { allocatedCapital, perPositionSize, isIntraday, multiplier, overnightCap } = computeLiveCapital(config);

  // ── CRITICAL: Check total deployed vs allocation cap (leverage-aware) ────────
  const totalDeployed   = openPos.reduce((sum, p) => sum + (p.allocatedCapital ?? 0), 0);
  const remainingBudget = allocatedCapital - totalDeployed;
  const leverageLabel   = `${isIntraday ? "INTRADAY" : "OVERNIGHT"} x${multiplier} | cap=$${allocatedCapital.toFixed(0)}`;
  if (remainingBudget < 5000) {
    log.block("LIVE_EXEC",
      `Capital cap reached for ${ticker}. Deployed $${totalDeployed.toFixed(0)} / $${allocatedCapital.toFixed(0)} [${leverageLabel}]. Remaining: $${remainingBudget.toFixed(0)}`,
      { ticker, totalDeployed, allocatedCapital, multiplier, isIntraday }
    );
    return { entered: false, reason: `Capital cap reached — deployed $${totalDeployed.toFixed(0)} / $${allocatedCapital.toFixed(0)} [${leverageLabel}]` };
  }
  // Cap actual size to remaining budget
  // Clamp final position size to min/max USD from config
  const rawSize0 = positionSizeUsd > 0 ? Math.min(positionSizeUsd, perPositionSize * 1.5) : perPositionSize;
  const { minPosUsd: cfgMin, maxPosUsd: cfgMax } = computeLiveCapital(config);
  const rawSize = Math.min(Math.max(rawSize0, cfgMin), cfgMax);
  const cappedSize = Math.min(rawSize, remainingBudget);
  // $5,000 minimum per position — but never exceed remaining budget or per-position allocation
  const actualSize = Math.max(cappedSize, 5000);
  if (actualSize > remainingBudget) {
    return { entered: false, reason: `Insufficient budget: need $${actualSize.toFixed(0)} but only $${remainingBudget.toFixed(0)} remaining` };
  }

  // ── Entry Churn Guard (SSOT for War / Armed / LiveEngine) — INERT@0 ───────────
  // C1 (≤1 automated entry/ticker/Israel-day) + C2 (cooldown after any close). Applies to
  // NON-manual signals only (MANUAL_% is exempt in v1); the Waiter retest (GOLD_RETEST_WAITER)
  // is the MANAGED re-entry, not churn — EXEMPT. When the flag is off we do ZERO extra reads
  // and never block → byte-identical. warEngine ALSO skips these BEFORE sizing; this is the
  // authoritative backstop that additionally covers any non-warEngine automated caller.
  if (((config as any)?.entryChurnGuardEnabled ?? 0) === 1
      && isAutomatedSignal(signal)
      && signal.toUpperCase() !== "GOLD_RETEST_WAITER"
      && !shouldBypassChurnForPhoenix(signal, (config as any)?.phoenixProtocolEnabled)) {
    const _cooldownMin = Number((config as any)?.churnCooldownMin ?? 90) || 90;
    const _nowMs = Date.now();
    const _dayStartMs = startOfIsraelDayMs(_nowMs);
    const _cooldownFromMs = _nowMs - _cooldownMin * 60_000;
    const _churnRows = await db
      .select({
        ticker: livePositions.ticker,
        signal: livePositions.signal,
        status: livePositions.status,
        openedAt: livePositions.openedAt,
        closedAt: livePositions.closedAt,
      })
      .from(livePositions)
      .where(and(
        eq(livePositions.userId, userId),
        or(
          gte(livePositions.openedAt, new Date(_dayStartMs)),
          and(
            eq(livePositions.status, "closed" as any),
            gte(livePositions.closedAt, new Date(_cooldownFromMs)),
          ),
        ),
      ));
    const _ledger = buildChurnLedger(_churnRows as any, { dayStartMs: _dayStartMs, cooldownFromMs: _cooldownFromMs });
    const _cg = isChurnBlocked({
      ticker, direction,
      automatedToday: _ledger.automatedToday, lastCloseAt: _ledger.lastCloseAt,
      nowMs: _nowMs, cooldownMin: _cooldownMin,
    });
    if (_cg.blocked) {
      log.warn("LIVE_EXEC", `[ChurnGuard] ${ticker} skip: ${_cg.reason}`);
      return { entered: false, reason: `Churn guard: ${_cg.reason}` };
    }
  }

  // Resolve conid
  // Auto-calculate SL/TP from current price if not provided
  let resolvedEntry = currentPrice;
  let resolvedSl = slPrice;
  let resolvedTp = tpPrice;
  // ── IBKR live snapshot: always re-verify price at order time (v2026-06-18) ──
  try {
    // REPOINT 2026-06-25: /iserver/marketdata/snapshot 404s on the OAuth gateway.
    // Re-verify against the working POST /quotes pipeline (IBKR broker truth; returns a
    // LivePrice object → use .price). On failure → ibkrLive stays 0 → fall back to the
    // warEngine-passed price (preserves prior behavior; downstream NaN/penny guards still run).
    const priceMap = await fetchIbkrLivePricesBatch([ticker], { skipCache: true });
    const lp = priceMap.get(ticker) ?? null;
    // QA fix #2: accept the order-time price ONLY when it is real-time IBKR truth. A silent Yahoo
    // (delayed) / DB-cache fallback (source!=='ibkr') is treated as no live price → resolvedEntry
    // stays at the warEngine-passed value and the NaN/penny guards below still run.
    const ibkrLive = lp?.source === 'ibkr' ? Number(lp.price ?? 0) : 0;
    if (ibkrLive > 0) {
      log.debug("LIVE_EXEC", `[PriceVerify] ${ticker} IBKR live=$${ibkrLive} (warEngine passed $${currentPrice})`);
      if (currentPrice > 0 && Math.abs(ibkrLive - currentPrice) / currentPrice > 0.20) {
        log.warn("LIVE_EXEC", `[PriceVerify] ${ticker} IBKR $${ibkrLive} vs signal $${currentPrice} diverge >20% — BLOCKING (stale signal)`);
        return { entered: false, reason: `Price staleness: IBKR $${ibkrLive} vs signal $${currentPrice} diverge >20%` };
      }
      // ── QA fix #3 (2026-06-25): order-time divergence guard against an INDEPENDENT source. ──
      // The IBKR price is broker truth, but on a thin/illiquid name a stale/wide IBKR quote can
      // still be wrong. Cross-check it against the Yahoo EOD / last bar close (independent feed)
      // and block on a divergence as low as ~3–5% (NOT 20%) — the >20% signal check above cannot
      // catch a 5–15% skew on a low-liquidity ticker.
      const ORDER_TIME_DIV_PCT = 0.05; // 5% — tight bound for low-liquidity names
      let eodClose = 0;
      try {
        const eodBars = await fetchBarsForTicker(ticker, 5);
        eodClose = eodBars?.[eodBars.length - 1]?.close ?? 0;
      } catch { /* no bars — handled below */ }
      if (eodClose > 0 && Math.abs(ibkrLive - eodClose) / eodClose > ORDER_TIME_DIV_PCT) {
        log.warn("LIVE_EXEC", `[PriceVerify] ${ticker} IBKR $${ibkrLive} vs independent EOD $${eodClose.toFixed(2)} diverge >${ORDER_TIME_DIV_PCT*100}% — BLOCKING (possible bad/stale quote on illiquid name)`);
        return { entered: false, reason: `Order-time divergence: IBKR $${ibkrLive} vs EOD $${eodClose.toFixed(2)} > ${ORDER_TIME_DIV_PCT*100}%` };
      }
      resolvedEntry = ibkrLive;
    }
  } catch (e: any) {
    log.warn("LIVE_EXEC", `[PriceVerify] ${ticker} live-quote failed: ${e.message} — using warEngine price $${currentPrice}`);
  }
  if (resolvedSl === 0 || resolvedTp === 0) {
    resolvedSl = 0;
    resolvedTp = 0;
  }
  // ─── CRITICAL GUARD: Block entry if price is invalid ────────────────────────
  // Bug fixed 2026-06-18: `|| 1` fallback caused gigantic positions (e.g. $35k / $1 = 35,000 shares)
  if (!resolvedEntry || isNaN(resolvedEntry) || resolvedEntry <= 0) {
    log.warn("LIVE_EXEC", `[NaN Guard] ${ticker} — resolvedEntry=${resolvedEntry} (NaN/0/null). BLOCKING entry.`);
    return { entered: false, reason: `Price invalid: resolvedEntry=${resolvedEntry} — will not submit order` };
  }
  if (resolvedEntry < 2) {
    log.warn("LIVE_EXEC", `[Penny Guard] ${ticker} — price=$${resolvedEntry} < $2.00. BLOCKING entry (penny stock).`);
    return { entered: false, reason: `Penny stock blocked: price=$${resolvedEntry} < $2.00` };
  }

  // ── ELZA 2.0 P0-6: GAP GUARD — don't chase a gap beyond the entry zone. ─────
  if (isGapChase(direction, currentPrice, resolvedEntry)) {
    const gapPct = gapPctFromEntryZone(currentPrice, resolvedEntry);
    log.warn("LIVE_EXEC", `[GapGuard] ${ticker} ${direction} — live $${resolvedEntry} gapped ${gapPct.toFixed(2)}% from entry zone $${currentPrice} (>±${GAP_GUARD_PCT}%). Aborting — no chasing.`);
    return { entered: false, reason: `Gap Guard: ${gapPct.toFixed(2)}% gap from entry zone (>±${GAP_GUARD_PCT}%)` };
  }

  const effectiveEntry = resolvedEntry;

  // ── SSOT PASS-THROUGH detection (flag=1 long path only) ──────────────────────
  // warEngine sized the share-count off ONE wide-lung stop computed off (scan
  // currentPrice, 420-bar ema50FromBars) and passes it (sizingStop/sizingEntryPrice).
  // When that unit is present & valid we use it VERBATIM as the broker stop + Golden
  // rValue basis — NO recompute, and (per directive) NO 90-bar bar fetch / no
  // calcEntrySlTp / no second ema50 on this path. The RC-2 stop would only be
  // discarded by the override, and re-fetching bars at the broker hand-off is exactly
  // the gateway-flaky second source we are eliminating. The fill-vs-signal slippage on
  // the entry LMT is the ONLY allowed residual (the backtest models 5bps).
  const _stopBasisEntry =
    Number.isFinite(sizingEntryPrice) && (sizingEntryPrice ?? 0) > 0
      ? (sizingEntryPrice as number)
      : effectiveEntry;
  const hasPassThroughStop =
    isElzaV45LiveEnabled(config) &&
    Number.isFinite(sizingStop) &&
    (sizingStop ?? 0) > 0 &&
    (direction === "long" ? (sizingStop as number) < _stopBasisEntry : (sizingStop as number) > _stopBasisEntry);

  let entryBars: Bar[] = [];
  let ema50Val: number;
  let slTpResult: ReturnType<typeof calcEntrySlTp>;
  let effectiveSl: number;
  let effectiveTp: number;
  // When flag=1 the persisted rValue is overridden to the wideLungSL basis (see below);
  // null means "use the RC-2 slTpResult.rValue" (byte-identical legacy behavior).
  let goldenRValue: number | null = null;

  if (hasPassThroughStop) {
    // SSOT path — no 90-bar fetch, no calcEntrySlTp, no wideLungSL recompute. The stop
    // arrives from warEngine; seed effectiveSl/Tp from it (overridden below in the flag
    // block with the +5R Golden backstop). ema50Val is unused on this path but kept
    // finite for the (skipped) log fields.
    ema50Val = effectiveEntry * (direction === "long" ? 0.96 : 1.04);
    effectiveSl = sizingStop as number;
    effectiveTp = direction === "long" ? effectiveEntry * 1.05 : effectiveEntry * 0.95;
    slTpResult = { stopLoss: effectiveSl, takeProfit: effectiveTp, slSource: "ema50", rValue: 0, target1Price: 0, atr14: null, mode: "swing", tpR: 5, tpSource: "rMultiple" } as ReturnType<typeof calcEntrySlTp>;
  } else {
    try {
      entryBars = await fetchBarsForTicker(ticker, 90);
    } catch {
      /* bars optional for SL/TP fallback */
    }
    ema50Val = entryBars.length >= 10
      ? ema50FromBars(entryBars)
      : effectiveEntry * (direction === "long" ? 0.96 : 1.04);

    slTpResult = calcEntrySlTp({
      entryPrice: effectiveEntry,
      ema50: ema50Val,
      bars: entryBars.length >= 20 ? entryBars : undefined,
      direction,
    });

    if (resolvedSl > 0 && resolvedTp > 0) {
      slTpResult = {
        ...slTpResult,
        ...ensureDirectionalSlTp(
          effectiveEntry,
          ema50Val,
          resolvedSl,
          resolvedTp,
          direction,
          entryBars.length >= 20 ? entryBars : undefined,
        ),
      };
    }

    effectiveSl = slTpResult.stopLoss;
    effectiveTp = slTpResult.takeProfit;

    if (!validateSlTpDirection(effectiveEntry, effectiveSl, effectiveTp, direction)) {
      log.warn("LIVE_EXEC",
        `[SlTp] ${ticker} ${direction} — invalid SL/TP after calc (entry=$${effectiveEntry} sl=$${effectiveSl} tp=$${effectiveTp}). BLOCKING.`,
      );
      return { entered: false, reason: `Invalid SL/TP orientation for ${direction} ${ticker}` };
    }
  }

  // ── FIX R1 — wideLungSL is the REAL live stop + rValue basis (INERT unless flag=1) ─
  // The validated Genesis backtest computes R and the ENTIRE Golden exit ladder
  // (+2.5R scale / +5R target) off wideLungSL (entry×0.92 / ema50×0.99). The live
  // engine previously sent the RC-2 calcEntrySlTp structural stop to the broker, so
  // live pos.rValue diverged from the backtest → the dollar ladder levels drifted.
  // When the flag is ON we make wideLungSL the SSOT live stop, derive rValue from it,
  // and set the bracket TP to the Golden +5R target as a consistent backstop (the
  // per-tick goldenExitDecision still manages the actual scale/BE/trail). wideLungSL
  // FAILS CLOSED (throws on non-finite / non-positive input) — a garbage stop can
  // never reach a live order; on throw OR a non-positive rValue we SKIP this candidate.
  if (isElzaV45LiveEnabled(config)) {
    // ── STOP-BASIS PARITY ────────────────────────────────────────────────────
    // The stop + rValue MUST be the SAME basis warEngine sized the share count off.
    // When warEngine passed its CV-B sizing stop (computed off the scan currentPrice
    // and the converged 420-bar ema50FromBars), USE IT VERBATIM — this is the single
    // source of truth shared by sizing, the broker order, and the Golden ladder, so
    // perShareRisk == rValue exactly (no second ema50 bar-count or re-fetched-price
    // divergence). It is derived from `sizingEntryPrice` (the scan price), NOT the
    // resolved IBKR fill: the fill remains the only allowed residual (modeled slippage).
    // Absent (shorts / manual / alert paths), recompute the legacy wideLungSL off the
    // executor's own ema50Val — byte-identical to the pre-parity behavior.
    const stopBasisEntry = _stopBasisEntry;
    // hasPassThroughStop was computed above (same predicate) — when true we ALSO skipped
    // the 90-bar fetch / calcEntrySlTp. Reuse it verbatim here so the two decisions can
    // never disagree.
    const passedStopValid = hasPassThroughStop;

    let structuralSl: number;
    if (passedStopValid) {
      structuralSl = sizingStop as number;
    } else {
      try {
        structuralSl = wideLungSL(effectiveEntry, ema50Val, direction);
      } catch (slErr: any) {
        log.warn("LIVE_EXEC", `[NeverNaked] ${ticker} ${direction} — wideLungSL threw (${slErr?.message ?? slErr}). SKIPPING candidate.`);
        return { entered: false, reason: `wideLungSL rejected ${ticker}: ${slErr?.message ?? slErr}` };
      }
    }
    // rValue is ALWAYS the positive distance |basis-entry − structuralSl|, measured off
    // the SAME entry the stop was derived from (the sizing scan price when passed) so the
    // ladder's R == the sizing R. Guard >0 so the Golden ladder can never divide-by-zero /
    // invert (entry==SL or SL on the wrong side).
    const rValue = Math.abs(stopBasisEntry - structuralSl);
    const directionalOk = direction === "long" ? structuralSl < stopBasisEntry : structuralSl > stopBasisEntry;
    if (!Number.isFinite(rValue) || !(rValue > 0) || !directionalOk) {
      log.warn("LIVE_EXEC", `[NeverNaked] ${ticker} ${direction} — structural rValue not finite & >0 (entry=$${stopBasisEntry} ema50=$${ema50Val} SL=$${structuralSl}). SKIPPING.`);
      return { entered: false, reason: `Non-finite/zero structural rValue for ${direction} ${ticker} — skipped` };
    }
    // SSOT stop path (reachable ONLY behind the flag): broker SL = wideLungSL,
    // rValue = |entry − wideLungSL|, bracket TP = Golden +5R backstop.
    const goldenTp = direction === "long"
      ? effectiveEntry + 5 * rValue
      : effectiveEntry - 5 * rValue;
    effectiveSl = structuralSl;
    effectiveTp = goldenTp;
    goldenRValue = rValue;
    log.info("LIVE_EXEC", `[GoldenSSOT] ${ticker} ${direction} — wideLungSL stop=$${structuralSl.toFixed(2)} rValue=$${rValue.toFixed(2)} TP(+5R)=$${goldenTp.toFixed(2)} (entry=$${effectiveEntry} ema50=$${ema50Val})`);
  }

  // ── MIN_R_PCT gate (SSOT: War + manual + alert) — INERT@0 ─────────────────────
  // Wired AFTER the structural stop is finalized (calcEntrySlTp / wideLungSL, both paths
  // set effectiveSl above) and BEFORE the conid resolve / order transmit. RC-2's
  // MAX_STRUCTURAL_RISK_PCT (0.12) skips a stop that is TOO FAR; this is the missing floor
  // for a stop that is TOO TIGHT: |entry−stop|/entry below minRValuePct is a scalp, not a
  // tradeable swing (AAPL $288.35 / $286.71 = 0.11% → skip). effectiveEntry/effectiveSl are
  // the real broker stop across EVERY path here, so this ONE gate covers War, manual and
  // alert entries. When minRValuePctEnabled!=1 (or minRValuePct<=0) it is a no-op → byte-identical.
  if (((config as any)?.minRValuePctEnabled ?? 0) === 1) {
    const _minRPct = Number((config as any)?.minRValuePct ?? 0.015);
    const _mr = assertMinRValuePct({ entry: effectiveEntry, stop: effectiveSl, minRPct: _minRPct });
    if (_mr.skip) {
      log.warn("LIVE_EXEC", `[MinRPct] ${ticker} ${_mr.reason}`);
      return { entered: false, reason: `Min-R gate: ${ticker} ${_mr.reason}` };
    }
  }

  const conid = await resolveConid(ticker);
  if (!conid) return { entered: false, reason: `Cannot resolve conid for ${ticker}` };

  // ── Atomic entry lock — prevents concurrent double-entry (Phase 6) ─────────
  const lockTicker = ticker.toUpperCase();
  // Stale-lock TTL: a prior attempt that died without releasing leaves a row that blocks this ticker
  // FOREVER (e.g. NFLX/ACHR stuck after a fill=0 bracket). Release locks older than 10 min first.
  await db.delete(liveEntryLock).where(and(
    eq(liveEntryLock.userId, userId),
    eq(liveEntryLock.ticker, lockTicker),
    lt(liveEntryLock.createdAt, new Date(Date.now() - 10 * 60 * 1000)),
  ));
  const lockResult = await db.execute(sql`
    INSERT IGNORE INTO liveEntryLock (userId, ticker) VALUES (${userId}, ${lockTicker})
  `);
  const lockAffected = (lockResult as any)?.[0]?.affectedRows ?? (lockResult as any)?.affectedRows ?? 1;
  if (lockAffected === 0) {
    return { entered: false, reason: `${ticker} entry lock held by concurrent request` };
  }

  const releaseLock = async () => {
    try {
      await db.delete(liveEntryLock).where(and(eq(liveEntryLock.userId, userId), eq(liveEntryLock.ticker, lockTicker)));
    } catch { /* non-fatal */ }
  };

  // Aggressive LMT entry (+0.5% for US)
  const aggressiveEntry = +(effectiveEntry * 1.005).toFixed(2);
  const rawQty = Math.floor(actualSize / aggressiveEntry);
  // ── AUTHORITATIVE PER-TICKER NOTIONAL CAP (2026-06-30 concentration fix) ─────
  // This is the LAST gate every entry path (war-engine CV-B vixRiskSize, legacy
  // conviction, risk-sizing, manual/alert) funnels through, AFTER all multipliers.
  // Root cause it closes: vixRiskSize (elzaV45Master.ts) sizes shares = floor(1%NLV /
  // perShareRisk) with NO maxPositionUsd bound — a tight wide-lung stop ⇒ huge shares ⇒
  // huge notional. The only upstream guard (warEngine remainingForTicker) equals
  // maxPositionUsd ONLY for a fresh entry, and the prior cap here ignored the EXISTING
  // same-ticker position entirely (so existing + new could stack past the cap).
  //
  // schema default is 85000 (NOT NULL) — the ?? is a dead-safe fallback only.
  const _maxPosCapUsd = config?.maxPositionUsd ?? DEFAULT_MAX_POSITION_USD;
  // Existing same-ticker exposure (DB rows, magnitude). Engine path is usually 0 here
  // (duplicate-ticker block above), but manual/adoption/phoenix adds can be non-zero;
  // valued at the resolved live entry so existing + new ≤ maxPositionUsd is enforced.
  const _existingTickerUnits = openPos
    .filter((p) => p.ticker?.toUpperCase() === ticker.toUpperCase())
    .reduce((s, p) => s + Math.abs(Number(p.units ?? 0)), 0);
  const _existingTickerUsd = _existingTickerUnits * effectiveEntry;
  const _remainingTickerUsd = Math.max(0, _maxPosCapUsd - _existingTickerUsd);
  // Hard cap: never more than $remainingTickerUsd / $2 shares (defense against price
  // cache bugs AND uncapped 1%-risk sizing). Uses aggressiveEntry (the transmit price).
  const maxAllowedQty = Math.floor(_remainingTickerUsd / Math.max(aggressiveEntry, 2));
  const qty = Math.min(Math.max(1, rawQty), maxAllowedQty);
  if (rawQty > maxAllowedQty) {
    log.warn("LIVE_EXEC", `[QTY Cap] ${ticker} rawQty=${rawQty} capped to ${maxAllowedQty} (maxPositionUsd=${_maxPosCapUsd} existing=$${Math.round(_existingTickerUsd)} remaining=$${Math.round(_remainingTickerUsd)})`);
  }
  // If the per-ticker cap leaves no room for even one share, do NOT round Math.max(1,…)
  // up past the cap — skip the entry rather than place a single over-cap share.
  if (maxAllowedQty < 1) {
    await releaseLock();
    log.warn("LIVE_EXEC", `[QTY Cap] ${ticker} no headroom — existing $${Math.round(_existingTickerUsd)} ≥ maxPositionUsd $${Math.round(_maxPosCapUsd)}. SKIPPING entry.`);
    return { entered: false, reason: `Per-ticker cap: existing $${Math.round(_existingTickerUsd)} ≥ max $${Math.round(_maxPosCapUsd)} — no headroom` };
  }

  log.info("LIVE_EXEC", `[Entry] ${ticker} ${direction.toUpperCase()} qty=${qty} entry=$${aggressiveEntry} sl=$${slPrice} tp=$${tpPrice}`);

  // ── OPTIMISTIC BUYING-POWER GATE (batch-fire margin race) ───────────────────
  // plannedPositionUsd = the notional this LMT bracket will consume at IBKR (qty ×
  // aggressiveEntry — the same aggressive LMT price the order is transmitted at). When
  // the in-memory ledger is synced AND this notional exceeds the (already-decremented)
  // available buying power, PRE-EMPT the rejection IBKR would make anyway — this is the
  // race fix: the 2nd breakout in the same cycle is gated against the 1st's decrement.
  //
  // FAIL-OPEN (NON-NEGOTIABLE): _optimisticBP == null ⇒ NOT YET SYNCED ⇒ do NOT block;
  // let the order through and let IBKR decide. After a clean cycle-start resync the FIRST
  // entry is gated against the FULL broker BP, so it can never be falsely blocked.
  const plannedPositionUsd = qty * aggressiveEntry;
  if (_optimisticBP != null && plannedPositionUsd > _optimisticBP) {
    await releaseLock();
    log.warn("LIVE_EXEC",
      `[OptimisticBP] ${ticker} blocked — planned $${plannedPositionUsd.toFixed(0)} > available $${_optimisticBP.toFixed(0)} (optimistic ledger; pre-empting IBKR margin reject)`);
    return {
      entered: false,
      reason: `Insufficient Buying Power (optimistic ledger): planned $${plannedPositionUsd.toFixed(0)} > available $${_optimisticBP.toFixed(0)}`,
    };
  }

  // ── Place IBKR-SIDE Bracket: Entry LMT + SL STP + TP LMT (OCA Group) ────────
  // Iron Rule: BOTH SL and TP must be native IBKR orders (not software-side).
  // IBKR enforces One-Cancels-All (OCA) natively — if SL fills, TP is cancelled and vice versa.
  const side = direction === "long" ? "BUY" : "SELL";
  const exitSide = direction === "long" ? "SELL" : "BUY";
  const ocaGroup = `ELZA_OCA_${ticker}_${Date.now()}`;

  const bracketBody = {
    conid,
    side,
    quantity: qty,
    entryPrice: aggressiveEntry,
    stopLoss: +effectiveSl.toFixed(2),
    takeProfit: +effectiveTp.toFixed(2),
    tif: "GTC",
    outsideRth: false,
    // Explicit OCA group — ibind /orders/bracket handles this natively
    ocaGroup,
    // SL order type: STP (Market Stop) for guaranteed fill at breach
    slOrderType: "STP",
    // TP order type: LMT (Limit) for price target
    tpOrderType: "LMT",
  };

  log.info("LIVE_EXEC",
    `[BracketOrder] SENDING: ${ticker} ${side} qty=${qty} entry=$${aggressiveEntry} SL=$${effectiveSl.toFixed(2)} TP=$${effectiveTp.toFixed(2)} OCA=${ocaGroup}`,
    { ticker, qty, entry: aggressiveEntry, sl: effectiveSl, tp: effectiveTp, ocaGroup, posSize: actualSize }
  );

  const entryRes = await ibindRequest("POST", "/orders/bracket", bracketBody, {
    "X-Confirm-Live-Order": "yes",
  });
  if (!entryRes.ok) {
    const errMsg = (entryRes.body as any)?.message ?? `HTTP ${entryRes.status}`;
    log.error("LIVE_EXEC",
      `[BracketOrder] FAILED for ${ticker}: ${errMsg}. DB insert ABORTED.`,
      { ticker, error: errMsg, status: entryRes.status }
    );
    // BUILD 1: loud structured alert + consecutive-failure tracking (gateway-stale hint).
    reportOrderFailure({ ticker, action: side, status: entryRes.status, endpoint: "/orders/bracket", errMsg: String(errMsg) });
    await releaseLock();
    return { entered: false, reason: `IBKR bracket failed: ${errMsg}` };
  }
  // Placement accepted by the gateway — reset the consecutive-failure streak.
  noteOrderSuccess();

  // ── OPTIMISTIC BUYING-POWER DECREMENT (on transmit, BEFORE waiting for fill) ──
  // The bracket is transmitted to IBKR (margin is now committed even pre-fill). Decrement
  // the in-memory ledger IMMEDIATELY so the NEXT entry in the SAME war cycle is gated
  // against the reduced figure — this is what stops the batch-fire margin reject. Only
  // when the ledger is synced (null ⇒ fail-open, leave untouched). Next cycle's
  // resyncOptimisticBP reseeds from broker truth, so this estimate never drifts.
  if (_optimisticBP != null) {
    _optimisticBP -= plannedPositionUsd;
    log.debug("LIVE_EXEC", `[OptimisticBP] ${ticker} transmitted — decremented $${plannedPositionUsd.toFixed(0)} → available $${_optimisticBP.toFixed(0)}`);
  }

  // ── Extract order IDs from IBKR response ──────────────────────────────────
  // IBKR returns: { result: [{local_order_id:"BR-P-...", order_id:"123"}, {local_order_id:"BR-SL-..."}, {local_order_id:"BR-TP-..."}] }
  const respBody      = entryRes.body as any;
  const resultArr: any[] = Array.isArray(respBody?.result) ? respBody.result : [];
  const parentEntry = resultArr.find((r: any) => String(r.local_order_id ?? "").startsWith("BR-P-")) 
                  ?? resultArr.find((r: any) => r.parent_order_id == null && r.order_id)
                  ?? resultArr[0];
  const slEntry     = resultArr.find((r: any) => String(r.local_order_id ?? "").startsWith("BR-SL-")) ?? resultArr[1];
  const tpEntry     = resultArr.find((r: any) => String(r.local_order_id ?? "").startsWith("BR-TP-")) ?? resultArr[2];

  // IBKR sometimes returns order_id only on child entries (SL/TP have parent_order_id set)
  // The parent entry (BR-P-) may have order_id OR be referenced via parent_order_id of children
  const ibkrEntryOrderId = parentEntry?.order_id?.toString()
                        ?? slEntry?.parent_order_id?.toString()  // ← children carry parent's order_id
                        ?? tpEntry?.parent_order_id?.toString()
                        ?? respBody?.entry_order_id?.toString()
                        ?? respBody?.order_id?.toString()
                ?? respBody?.result?.order_id?.toString()
                        ?? respBody?.orderId?.toString()
                        ?? resultArr.find((r: any) => r.order_id && !r.parent_order_id)?.order_id?.toString()
                        ?? null;
  const ibkrSlOrderId    = slEntry?.order_id?.toString()
                        ?? respBody?.sl_order_id?.toString()
                        ?? respBody?.stop_order_id?.toString()
                        ?? null;
  const ibkrTpOrderId    = tpEntry?.order_id?.toString()
                        ?? respBody?.tp_order_id?.toString()
                        ?? respBody?.limit_order_id?.toString()
                        ?? null;

  if (!ibkrEntryOrderId) {
    // Orders were accepted by IBKR (PendingSubmit/PreSubmitted) — log as WARN not ERROR
    // Extract any available order_id to use as fallback
    const anyOrderId = resultArr.find((r: any) => r.order_id)?.order_id?.toString() ?? null;
    if (anyOrderId) {
      log.warn("LIVE_EXEC",
        `[BracketOrder] ${ticker}: no BR-P- orderId found, using fallback orderId=${anyOrderId}`,
        { ticker, anyOrderId, resultArr: JSON.stringify(resultArr).slice(0, 300) }
      );
      // Use anyOrderId as the entry order id so DB insert proceeds
      const fallbackEntryId = anyOrderId;
      // Redefine for use below via a local override (patch-friendly approach)
      (resultArr as any).__fallbackEntryOrderId = fallbackEntryId;
    } else {
      log.error("LIVE_EXEC",
        `[BracketOrder] Placed for ${ticker} but IBKR returned no orderId at all. DB insert ABORTED.`,
        { ticker, responseBody: JSON.stringify(respBody).slice(0, 400) }
      );
      await releaseLock();
      return { entered: false, reason: "IBKR returned null orderId — insert aborted" };
    }
  }

  // Apply fallback if needed
  const finalEntryOrderId = ibkrEntryOrderId ?? (resultArr as any).__fallbackEntryOrderId ?? null;
  if (!finalEntryOrderId) {
    await releaseLock();
    return { entered: false, reason: "IBKR returned null orderId — insert aborted" };
  }

  // ── Phase 5: Locate SL order — poll /orders if not in bracket response ─────
  // IBKR sometimes returns only Parent + TP in bracket response (SL appears async).
  // Fix: poll /orders for up to 2s to find the SL leg by matching coid BR-SL-*
  let finalSlOrderId = ibkrSlOrderId;
  let slProtection: "ibkr" | "software" = "ibkr";
  if (!finalSlOrderId) {
    log.warn("LIVE_EXEC", `[BracketOrder] ${ticker} bracket response missing SL leg — polling /orders to find it`);
    // Poll up to 4 times (500ms apart) for the SL order to appear
    for (let attempt = 0; attempt < 4 && !finalSlOrderId; attempt++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const ordersRes = await ibindRequest("GET", "/orders");
        if (ordersRes.ok) {
          const activeOrders: any[] = (ordersRes.body as any)?.orders ?? [];
          // Find order with coid matching BR-SL- pattern for this ticker, placed in last 10s
          const slMatch = activeOrders.find((o: any) => {
            const coid = String(o.cOID ?? o.coid ?? o.client_order_id ?? "");
            const desc = String(o.description1 ?? o.ticker ?? "").toUpperCase();
            const type = String(o.orderType ?? o.order_type ?? "").toLowerCase();
            const isSlType = type === "stop" || type === "stp" || type === "stop limit";
            const isSell = String(o.side ?? "").toUpperCase().startsWith("S");
            return (coid.startsWith("BR-SL-") && desc === ticker.toUpperCase()) ||
                   (isSlType && desc === ticker.toUpperCase() && (direction === "long" ? isSell : !isSell));
          });
          if (slMatch) {
            finalSlOrderId = String(slMatch.orderId ?? slMatch.order_id ?? "");
            log.info("LIVE_EXEC", `[BracketOrder] ${ticker} SL found via /orders poll (attempt ${attempt+1}): ${finalSlOrderId}`);
          }
        }
      } catch { /* non-fatal poll attempt */ }
    }
    // If still missing — try standalone STP as last resort
    if (!finalSlOrderId) {
      log.warn("LIVE_EXEC", `[BracketOrder] ${ticker} SL not found via poll — placing standalone STP`);
      const exitSide = direction === "long" ? "SELL" : "BUY";
      const slRes = await ibindRequest("POST", "/orders/stop-loss", {
        conid,
        side: exitSide,
        quantity: qty,
        stopPrice: +effectiveSl.toFixed(2),
        tif: "GTC",
      }, { "X-Confirm-Live-Order": "yes" });
      if (slRes.ok) {
        finalSlOrderId = String((slRes.body as any)?.order_id ?? (slRes.body as any)?.result?.order_id ?? "") || null;
        if (finalSlOrderId) {
          log.info("LIVE_EXEC", `[BracketOrder] ${ticker} standalone STP placed: ${finalSlOrderId}`);
        }
      }
    }
  }
  if (!finalSlOrderId) {
    log.error("LIVE_EXEC", `[BracketOrder] ${ticker} NO IBKR SL after all attempts — aborting entry, cancelling bracket`);
    if (finalEntryOrderId) {
      await ibindRequest("DELETE", `/iserver/account/${LIVE_ACCOUNT_ID}/order/${finalEntryOrderId}`);
    }
    // ── REQ 1 — NEVER-NAKED verify-or-flatten (INERT unless elzaV45LiveEnabled=1) ──
    // GAP: the DELETE above only un-books an UNFILLED entry. If the entry leg already
    // took on size (partial acceptance / fill before the SL leg was confirmed), the
    // cancel is a no-op and we are left with a NAKED position. Behind the flag, poll
    // the real fill; if the entry has size, flatten it IMMEDIATELY with a marketable
    // LMT (IRON RULE — never a naked MKT), reusing the same exit-pricing pattern as
    // executeLiveSell. We cannot use executeLiveSell here (no DB position row exists
    // yet), so we close the filled qty directly off the IBKR-fresh /quotes price.
    if (isElzaV45LiveEnabled(config)) {
      try {
        // FIX NN-1 (reverse-race) — NEVER fail OPEN on an unreadable /positions.
        // We read BOTH the real fill (pollEntryFill) and the broker-held qty. The
        // decision table:
        //   held === 0 (CONFIRMED flat) AND no fill  ⇒ phantom — ABORT (no order).
        //   held  >  0 (CONFIRMED held)               ⇒ flatten min(held, qty).
        //   held === null (UNKNOWN read)  OR fill>0   ⇒ DO NOT silent-abort. Flatten
        //                                               `qty` anyway (a flatten of a
        //                                               non-held position is a harmless
        //                                               rejected/no-op order — far cheaper
        //                                               than a naked position) + fire the
        //                                               🚨 NAKED-VERIFY-REQUIRED alert.
        // Invariant: on UNKNOWN broker state we NEVER leave this path without either a
        // flatten attempt or a tracked position.
        const nakedFill = await pollEntryFill(finalEntryOrderId, qty, 3);
        const brokerHeldQty = await readBrokerPositionQty(conid, ticker);
        const fillSawSize = (nakedFill.filledQty ?? 0) > 0;
        const brokerUnknown = brokerHeldQty == null;
        // AUTHORITATIVE broker-confirmed-zero aborts the flatten — even when pollEntryFill
        // claimed a fill. A marketable SELL when the broker CONFIRMS 0 held does NOT no-op
        // on a margin account: it OPENS A NAKED SHORT. An authoritative /positions=0 read
        // contradicts the poll, so the entry never filled → place no order. (An UNKNOWN
        // read is null ≠ 0 → it falls through to flatten-anyway + alert below.)
        const confirmedFlat = brokerHeldQty === 0;

        if (confirmedFlat) {
          if (fillSawSize) {
            // CONTRADICTION: poll saw a fill but the broker authoritatively holds 0. Do
            // NOT place a phantom sell (short risk); escalate in case /positions lags a
            // real fill. A naked long (if any) is bounded + re-protected by the SL cron;
            // a phantom short is not — so abort-and-alert is the safer failure mode.
            log.error("LIVE_EXEC", `[NEVER-NAKED] ${ticker} CONTRADICTION — pollEntryFill saw ${nakedFill.filledQty} filled but broker /positions CONFIRMS 0 held. NO flatten sent (a sell on confirmed-0 would open a naked short). Treating as phantom fill.`);
            try {
              void sendTelegramMessage(
                `🚨 <b>NAKED-VERIFY-REQUIRED</b>\n` +
                `<b>${ticker}</b> entry poll reported a FILL but broker /positions CONFIRMS 0 held — NO flatten sent (avoids a phantom short). ` +
                `VERIFY MANUALLY that /positions isn't lagging a real fill (no residual naked position).`
              ).catch(() => {});
            } catch { /* best-effort */ }
          } else {
            log.info("LIVE_EXEC", `[NEVER-NAKED] ${ticker} broker CONFIRMED holds 0 and no fill — entry never filled. ABORTING flatten (no phantom order).`);
          }
        } else {
          // Choose the qty to flatten: a positively-read held qty caps it; otherwise
          // (UNKNOWN broker OR fill-saw-size) flatten the full requested `qty`.
          const nakedQty = (brokerHeldQty != null && brokerHeldQty > 0)
            ? Math.min(brokerHeldQty, qty)
            : qty;
          const flatSide = direction === "long" ? "SELL" : "BUY";
          const MAX_SLIP_PCT = 0.01;
          let flatPx: number | null = null;
          try {
            const pm = await fetchIbkrLivePricesBatch([ticker], { skipCache: true });
            const lp = pm.get(ticker) ?? null;
            const live = lp?.source === "ibkr" ? Number(lp.price ?? 0) : 0;
            if (live > 0) {
              flatPx = flatSide === "SELL"
                ? +(live * (1 - MAX_SLIP_PCT)).toFixed(2)
                : +(live * (1 + MAX_SLIP_PCT)).toFixed(2);
            }
          } catch { /* fall through to fill-price-based LMT */ }
          if (!flatPx) {
            const base = nakedFill.avgPrice && nakedFill.avgPrice > 0 ? nakedFill.avgPrice : aggressiveEntry;
            flatPx = flatSide === "SELL"
              ? +(base * (1 - MAX_SLIP_PCT)).toFixed(2)
              : +(base * (1 + MAX_SLIP_PCT)).toFixed(2);
          }
          // ENDPOINT FIX 2026-06-29: /orders/limit 405s on the gateway; route through /orders/close-position (marketable LMT, never naked MKT).
          await ibindRequest("POST", "/orders/close-position", {
            account_id: LIVE_ACCOUNT_ID,
            conid,
            side: flatSide,
            quantity: nakedQty,
            orderType: "LMT",
            limitPrice: flatPx,
            outsideRth: false,
            tif: "IOC",
            orderRef: `ELZA_NAKED_FLATTEN_${ticker}_${Date.now()}`,
          }, { "X-Confirm-Live-Order": "yes" });
          log.error("LIVE_EXEC", `[NEVER-NAKED] SL leg unconfirmed — flattened ${ticker} (${nakedQty} @ marketable-LMT $${flatPx}, reason NAKED_SL_FLATTEN; brokerHeld=${brokerHeldQty == null ? "UNKNOWN" : brokerHeldQty}, fillSawSize=${fillSawSize})`);
          if (brokerUnknown) {
            // UNKNOWN broker state on a flatten attempt — a human MUST verify there is no
            // residual naked position. This is the reverse-race alarm.
            try {
              void sendTelegramMessage(
                `🚨 <b>NAKED-VERIFY-REQUIRED</b>\n` +
                `<b>${ticker}</b> SL leg UNCONFIRMED and broker /positions UNREADABLE — sent a ${flatSide} flatten LMT for ${nakedQty} @ ~$${flatPx} as a precaution. ` +
                `VERIFY MANUALLY there is no residual NAKED position (no IBKR stop, no DB row).`
              ).catch(() => {});
            } catch { /* best-effort */ }
          } else {
            try {
              void sendTelegramMessage(
                `🚨 <b>NEVER-NAKED FLATTEN</b>\n` +
                `<b>${ticker}</b> entry filled ${nakedQty} but SL leg UNCONFIRMED — flattened @ ~$${flatPx}`
              ).catch(() => {});
            } catch { /* best-effort */ }
          }
        }
      } catch (nakedErr: any) {
        log.error("LIVE_EXEC", `[NEVER-NAKED] ${ticker} flatten-check failed: ${nakedErr?.message ?? nakedErr} — manual verify required`);
      }
    }
    await releaseLock();
    return { entered: false, reason: "No IBKR stop-loss order — entry aborted (unprotected position blocked)" };
  }

  // ── Phase 4: Poll real fill — do not assume full fill at submission ─────────
  const fillInfo = await pollEntryFill(finalEntryOrderId, qty, 3);
  if (fillInfo.status === "cancelled") {
    await releaseLock();
    return { entered: false, reason: `Entry order cancelled/rejected for ${ticker}` };
  }
  const filledQty = fillInfo.filledQty > 0 ? Math.min(fillInfo.filledQty, qty) : 0;
  const fillPrice = fillInfo.avgPrice && fillInfo.avgPrice > 0 ? fillInfo.avgPrice : aggressiveEntry;
  const fillStatus: "none" | "partial" | "full" =
    filledQty <= 0 ? "none" :
    filledQty >= qty ? "full" : "partial";
  const posStatus = filledQty > 0 ? "open" as const : "pending_entry" as const;

  log.info("LIVE_EXEC",
    `[BracketOrder] CONFIRMED: ${ticker} entry=${finalEntryOrderId} SL=${finalSlOrderId ?? "pending"} TP=${ibkrTpOrderId ?? "pending"} fill=${filledQty}/${qty} @ $${fillPrice}`,
    { ticker, finalEntryOrderId, finalSlOrderId, ibkrTpOrderId, filledQty, fillPrice }
  );

  // ── Save to DB with all three IBKR order IDs ─────────────────────────────
  await safeInsertLivePosition(db, {
    userId,
    accountId: LIVE_ACCOUNT_ID,
    ticker,
    companyName: params.companyName ?? ticker,
    direction,
    units: filledQty > 0 ? filledQty : qty,
    originalUnits: filledQty > 0 ? filledQty : qty,
    entryPrice: fillPrice,
    allocatedCapital: (filledQty > 0 ? filledQty : qty) * fillPrice,
    currentSl: effectiveSl,
    currentTp: effectiveTp,
    initialSl: effectiveSl,
    initialTp: effectiveTp,
    currentPrice: fillPrice,
    signal,
    zivScore,
    entryStructMeta: params.entryStructMeta ?? null,   // ledger-fix: route-attributed closes
    sector: params.sector ?? null,
    // Phoenix lineage (optional; undefined ⇒ schema defaults 0/null ⇒ byte-identical).
    phoenixGeneration: params.phoenixGeneration ?? 0,
    originPosId: params.originPosId ?? null,
    ibkrEntryOrderId: finalEntryOrderId,
    ibkrSlOrderId: finalSlOrderId ?? null,
    ibkrTpOrderId: ibkrTpOrderId ?? null,
    status: posStatus,
    slProtection,
    requestedQty: qty,
    filledQty: filledQty,
    remainingQty: Math.max(0, qty - filledQty),
    fillStatus,
    ibkrAvgCost: fillPrice,
    ibkrUnits: filledQty > 0 ? filledQty : 0,
    // ── Fat-Tail v2.0 metadata ────────────────────────────────────────────────
    // FIX R1: behind the flag, rValue is the wideLungSL basis (goldenRValue, computed off
    // effectiveEntry — NOT aggressiveEntry — so it matches the backtest's |entry − stop|).
    // Flag OFF: byte-identical legacy (slTpResult.rValue ?? |aggressiveEntry − RC-2 stop|).
    rValue: goldenRValue ?? slTpResult.rValue ?? Math.abs(+(aggressiveEntry - effectiveSl).toFixed(2)),
    peakPrice: aggressiveEntry,   // seed peak = entry price
    isFreeRolled: 0,
    atr14: slTpResult.atr14 ?? null,
    pyramidDone: 0,
    pyramidUnits: 0,
  });

  // Log trade — fetch inserted id
  const insertedRows = await db.select({ id: livePositions.id })
    .from(livePositions)
    .where(and(
      eq(livePositions.userId, userId),
      eq(livePositions.ticker, ticker),
      inArray(livePositions.status, ["open", "pending_entry"]),
    ))
    .orderBy(livePositions.openedAt)
    .limit(1);
  const newPosId = insertedRows[0]?.id ?? 0;
  if (newPosId > 0) {
    await db.update(liveEntryLock).set({ positionId: newPosId })
      .where(and(eq(liveEntryLock.userId, userId), eq(liveEntryLock.ticker, lockTicker)));
  }
  await db.insert(liveTrades).values({
    userId,
    positionId: newPosId,
    ticker,
    side,
    units: filledQty > 0 ? filledQty : qty,
    price: fillPrice,
    reason: `ENTRY:${signal}`,
    ibkrOrderId: finalEntryOrderId ?? undefined,
    status: fillStatus === "full" ? "filled" : fillStatus === "partial" ? "partial" : "failed",
  });

  if (filledQty <= 0) {
    // Keep pending_entry — bracket may fill later; War Engine blocks via IBKR open orders + DB row
    // BUGFIX 2026-06-24: was `dbLog(...)` but dbLog is NOT imported in this file → ReferenceError
    // on EVERY no-fill entry, which threw out of tryLiveEntry, skipped releaseLock() below, and
    // surfaced as "[WarEngine] Entry error … dbLog is not defined". Use the imported `log` instead.
    log.info("LIVE_EXEC", `[Entry] ${ticker} no fill yet — pending_entry pos ${newPosId} kept (orderId=${finalEntryOrderId})`);
    await releaseLock();
    return { entered: false, reason: `${ticker} entry pending — no fill confirmed yet`, orderId: finalEntryOrderId, sl: effectiveSl, tp: effectiveTp };
  }

  // Telegram notification
  const emoji = direction === "long" ? "📈" : "📉";
  await sendTelegramMessage(
    `${emoji} <b>ELZA LIVE ENTRY</b>\n` +
    `<b>${ticker}</b> ${direction.toUpperCase()} × ${filledQty} @ $${fillPrice.toFixed(2)}\n` +
    `SL: $${effectiveSl.toFixed(2)} | TP: $${effectiveTp.toFixed(2)}\n` +
    `Capital: $${(filledQty * fillPrice).toFixed(0)} | Signal: ${signal}`
  );

  try {
    const { reconcileHoldingFromLivePosition } = await import("./portfolioHoldingsSync");
    await reconcileHoldingFromLivePosition(db, userId, ticker);
  } catch {
    /* portfolio mirror is best-effort */
  }

  return { entered: true, reason: `Entry filled ${filledQty}/${qty} orderId=${finalEntryOrderId}`, orderId: finalEntryOrderId, sl: effectiveSl, tp: effectiveTp };
}


// ── Cancel orphaned bracket orders after manual close ─────────────────────────
// Called by ibkrSync when it detects a position was manually closed in TWS
// while SL/TP orders are still live on IBKR (would otherwise stay as orphans).
export async function cancelBracketOrders(params: {
  ticker: string;
  ibkrSlOrderId?: string | null;
  ibkrTpOrderId?: string | null;
}): Promise<{ cancelled: number; errors: string[] }> {
  const { ticker, ibkrSlOrderId, ibkrTpOrderId } = params;
  const orderIds = [ibkrSlOrderId, ibkrTpOrderId].filter(Boolean) as string[];
  let cancelled = 0;
  const errors: string[] = [];

  for (const ordId of orderIds) {
    try {
      // Primary: DELETE /iserver/account/{accountId}/order/{orderId}
      const r = await ibindRequest("DELETE", `/iserver/account/${LIVE_ACCOUNT_ID}/order/${ordId}`);
      if (r.ok) {
        cancelled++;
        log.info("LIVE_EXEC", `[BracketCancel] ✅ Cancelled order ${ordId} for ${ticker}`);
      } else {
        // Fallback: DELETE /order/{accountId}/{orderId}
        const r2 = await ibindRequest("DELETE", `/order/${LIVE_ACCOUNT_ID}/${ordId}`);
        if (r2.ok) {
          cancelled++;
          log.info("LIVE_EXEC", `[BracketCancel] ✅ Cancelled (fallback) order ${ordId} for ${ticker}`);
        } else {
          const msg = `Order ${ordId} cancel failed: HTTP ${r2.status}`;
          errors.push(msg);
          log.warn("LIVE_EXEC", `[BracketCancel] ⚠️ ${msg}`, { ordId, status: r2.status });
        }
      }
    } catch (err: any) {
      errors.push(`${ordId}: ${err.message}`);
      log.warn("LIVE_EXEC", `[BracketCancel] ❌ Exception: ${err.message}`, { ordId });
    }
  }
  return { cancelled, errors };
}

async function cancelIbkrOrder(orderId: string): Promise<void> {
  await ibindRequest("DELETE", `/iserver/account/${LIVE_ACCOUNT_ID}/order/${orderId}`);
}

/** Robustly extract an order_id from a /orders/stop-loss response (object or array result). */
function extractStopOrderId(body: any): string | null {
  const r = body?.result;
  const cand =
    (Array.isArray(r) ? r[0]?.order_id ?? r[0]?.coid : r?.order_id ?? r?.coid) ??
    body?.order_id ??
    body?.sl_order_id ??
    null;
  return cand != null ? String(cand) : null;
}

/**
 * Push a tightened protective stop to the IBKR broker for a live residual (Lever 1).
 *
 * Iron Rule — the residual must NEVER go naked during the round-trip. IBKR cannot
 * MODIFY a resting bracket leg, so this is a cancel+replace; we therefore PLACE the
 * new STP FIRST and only cancel the old one AFTER the new one is broker-accepted.
 * If the new placement fails, the OLD stop is left resting untouched → still protected.
 *
 * Tighten-only is enforced by the CALLER (Stage 2 ratchet); this fn just executes the
 * round-trip for an already-validated tighter level. Works for long (SELL stop) and
 * short (BUY stop). Returns the new order id on success, or null (old stop kept).
 */
async function pushTrailStopToBroker(params: {
  conid: number;
  direction: "long" | "short";
  units: number;
  newStop: number;
  oldOrderId: string | null;
  ticker: string;
}): Promise<{ ok: boolean; newOrderId: string | null }> {
  const { conid, direction, units, newStop, oldOrderId, ticker } = params;
  const exitSide = direction === "long" ? "SELL" : "BUY";

  // 1) PLACE the new (tighter) STP first — residual is over-protected (two stops) but never naked.
  let newOrderId: string | null = null;
  try {
    const placeRes = await ibindRequest("POST", "/orders/stop-loss", {
      conid,
      side: exitSide,
      quantity: units,
      stopPrice: +newStop.toFixed(2),
      tif: "GTC",
      outsideRth: false,
    }, { "X-Confirm-Live-Order": "yes" });
    if (!placeRes.ok) {
      log.error("LIVE_EXEC", `[TrailPush] ${ticker} new STP @ $${newStop.toFixed(2)} REJECTED (HTTP ${placeRes.status}) — keeping old stop ${oldOrderId ?? "<none>"} resting (residual still protected)`);
      return { ok: false, newOrderId: null };
    }
    newOrderId = extractStopOrderId(placeRes.body);
    if (!newOrderId) {
      // Accepted but id not parseable: do NOT cancel the old stop (would risk double-naked on a later sync).
      log.warn("LIVE_EXEC", `[TrailPush] ${ticker} new STP accepted but order_id unparseable — keeping old stop ${oldOrderId ?? "<none>"} as well (over-protected, never naked)`);
      return { ok: false, newOrderId: null };
    }
  } catch (err) {
    log.error("LIVE_EXEC", `[TrailPush] ${ticker} place exception: ${err} — old stop ${oldOrderId ?? "<none>"} kept resting`);
    return { ok: false, newOrderId: null };
  }

  // 2) New STP is live → now safe to cancel the OLD, looser stop. If this fails the
  //    residual is merely double-protected (two stops) — acceptable, never naked.
  if (oldOrderId && oldOrderId !== newOrderId) {
    try {
      await cancelIbkrOrder(oldOrderId);
    } catch (err) {
      log.warn("LIVE_EXEC", `[TrailPush] ${ticker} old stop ${oldOrderId} cancel failed: ${err} — new STP ${newOrderId} is live; residual double-protected, not naked`);
    }
  }
  log.info("LIVE_EXEC", `[TrailPush] ${ticker} trail stop pushed to broker @ $${newStop.toFixed(2)} (new id ${newOrderId}, retired ${oldOrderId ?? "<none>"})`);
  return { ok: true, newOrderId };
}

// ── Golden 5:1 SSOT live exit (TASK 2a — gated on elzaV45LiveEnabled) ────────────
/**
 * Drive the LIVE per-tick exit from the PROVEN backtest SSOT (`goldenExitDecision`
 * in engine/elzaV45Master.ts) instead of the legacy 2.0R/observe-only ladder. This
 * runs ONLY when isElzaV45LiveEnabled(config)===true; the legacy Open-Skies path
 * stays byte-identical when the flag is 0 (the caller never reaches here).
 *
 * Returns `true` if it OWNED the exit decision for this tick (caller must `continue`
 * past the legacy block), `false` if it fell back fail-closed (caller leaves the
 * existing resting SL in place — never naked, never widened).
 *
 * Ladder (reconciled to the validated backtest):
 *   PRE-scale  : SL breach → full exit (SL); +2.5R → SCALE_40 (sell 40% of ORIGINAL
 *                units once, move stop to BREAKEVEN, persist partialTpHit/isFreeRolled).
 *   POST-scale : 2.5×ATR chandelier ratchet on the 60% runner (tighten-only); +5R →
 *                full exit (TP_FINAL); breakeven/trail breach → full exit.
 *   TIME       : 60-bar pre-scale time-stop → full exit (handled here from openedAt).
 */
async function runGoldenSsotExit(args: {
  db: any;
  userId: number;
  pos: any;
  livePrice: number;
  deps: PartialDeps;
}): Promise<boolean> {
  const { db, userId, pos, livePrice, deps } = args;
  const isLong = pos.direction === "long";

  // SHORT is BACKTEST-ONLY — the Golden SSOT view is long-only. A short position must
  // NEVER be driven by this path; let the legacy loop manage it (fail-open to legacy).
  if (!isLong) return false;

  // ── FAIL-CLOSED view build: any non-finite input ⇒ do NOT place a garbage exit. ──
  const entry = Number(pos.entryPrice);
  const rValue = Number(pos.rValue);
  const atr14 = Number(pos.atr14);
  const initialSL = Number(pos.initialSl);
  if (
    !Number.isFinite(entry) || entry <= 0 ||
    !Number.isFinite(rValue) || rValue <= 0 ||
    !Number.isFinite(atr14) || atr14 <= 0 ||
    !Number.isFinite(initialSL) ||
    !Number.isFinite(livePrice) || livePrice <= 0
  ) {
    log.warn("LIVE_EXEC", `[GoldenExit] ${pos.ticker} fail-closed — non-finite view (entry=${pos.entryPrice} R=${pos.rValue} atr14=${pos.atr14} sl=${pos.initialSl} live=${livePrice}). Leaving resting SL in place; no exit placed.`);
    return false;
  }

  // Per-tick degenerate bar: the live tick is high=low=close=livePrice (the same
  // single-price breach/target semantics the legacy live loop already uses).
  const peak = Math.max(Number(pos.peakPrice ?? entry), livePrice);
  const scaled = (pos.partialTpHit ?? 0) === 1;
  const priorTrail = Number.isFinite(Number(pos.currentSl)) ? Number(pos.currentSl) : entry;

  let decision: ExitDecision;
  try {
    const view: OpenPositionView = {
      side: "long",
      entry,
      initialSL,
      rValue,
      atr14,
      peak,
      scaled,
      priorTrail,
    };
    const bar: ElzaBar = { date: "live", open: livePrice, high: livePrice, low: livePrice, close: livePrice };
    decision = goldenExitDecision(view, bar);
  } catch (err) {
    log.error("LIVE_EXEC", `[GoldenExit] ${pos.ticker} view threw — fail-closed, resting SL untouched: ${err}`);
    return false;
  }

  // 60-bar pre-scale TIME-STOP (series-level backstop). The per-bar machine does not
  // evaluate it, so apply it here from openedAt (1 trading bar = 1 day for daily DNA).
  if (!scaled && decision.action === "HOLD" && pos.openedAt) {
    const barsHeld = Math.floor((Date.now() - new Date(pos.openedAt).getTime()) / 86_400_000);
    if (barsHeld >= 60) {
      if (pos._isClosing) return true;
      pos._isClosing = true;
      try {
        log.info("LIVE_EXEC", `[GoldenExit] ${pos.ticker} 60-bar pre-scale TIME-STOP (held ${barsHeld}) — full exit.`);
        await executeLiveSell({ userId, positionId: pos.id, reason: "GOLDEN_TIME_STOP" });
      } catch (err) {
        log.error("LIVE_EXEC", `[GoldenExit] ${pos.ticker} TIME exit failed: ${err}`);
        pos._isClosing = false;
      }
      return true;
    }
  }

  switch (decision.action) {
    case "HOLD":
      break; // fall through to the post-scale chandelier ratchet below (no terminal action).

    case "STOP": {
      // Pre-scale full SL breach (−1R).
      if (pos._isClosing) return true;
      pos._isClosing = true;
      try {
        log.warn("LIVE_EXEC", `[GoldenExit] ${pos.ticker} SL breach @ $${decision.price.toFixed(2)} (live $${livePrice.toFixed(2)}) — full exit.`);
        await executeLiveSell({ userId, positionId: pos.id, reason: "GOLDEN_SL" });
      } catch (err) {
        log.error("LIVE_EXEC", `[GoldenExit] ${pos.ticker} SL exit failed: ${err}`);
        pos._isClosing = false;
      }
      return true;
    }

    case "SCALE_40": {
      // Scale 40% of ORIGINAL units ONCE, then move the stop to breakeven. partialTpHit
      // is the idempotency guard (scaled===true short-circuits before we get here next tick).
      if (pos._isClosing) return true;
      pos._isClosing = true;
      try {
        // 40% of ORIGINAL units. At the scale event units == originalUnits (full size),
        // so 0.40 of current units == 0.40 of original; if originalUnits is recorded and
        // differs (already pyramided/reduced), re-anchor the fraction to original.
        const originalUnits = Number(pos.originalUnits ?? pos.units);
        const targetQty = Math.max(1, Math.floor(originalUnits * GOLDEN_SCALE_BANK_FRAC));
        const fraction = pos.units > 0 ? Math.min(0.99, targetQty / pos.units) : GOLDEN_SCALE_BANK_FRAC;

        log.info("LIVE_EXEC", `[GoldenExit] ${pos.ticker} SCALE_40 @ +2.5R ($${decision.price.toFixed(2)}) — banking ${targetQty}/${originalUnits} original units (frac ${fraction.toFixed(3)}), moving stop → breakeven.`);

        const partRes = await executeLivePartialClose(
          { userId: pos.userId, positionId: pos.id, fraction, reason: "GOLDEN_SCALE_40" },
          deps,
        );
        if (!partRes.success) {
          log.error("LIVE_EXEC", `[GoldenExit] ${pos.ticker} SCALE_40 reduce leg failed: ${partRes.reason} — NOT flipping scaled flags; resting SL untouched.`);
          pos._isClosing = false;
          return true;
        }

        // Move the resting stop to BREAKEVEN (entry) — tighten-only ratchet. Never below
        // the existing resting stop (the reduce-leg's BE re-arm may already be in flight;
        // this is an explicit, idempotent ratchet to entry).
        const prevSl = Number.isFinite(Number(pos.currentSl)) ? Number(pos.currentSl) : initialSL;
        const beStop = entry;
        if (beStop - prevSl > 0.001) {
          await ratchetStopTo(db, pos, beStop, "breakeven");
        }

        // Persist the scale flags so the next tick enters the POST-scale (runner) branch.
        try {
          await db.update(livePositions)
            .set({ partialTpHit: 1, slMovedToBreakEven: 1, isFreeRolled: 1 })
            .where(eq(livePositions.id, pos.id));
          pos.partialTpHit = 1;
          pos.slMovedToBreakEven = 1;
          pos.isFreeRolled = 1;
        } catch (err) {
          log.error("LIVE_EXEC", `[GoldenExit] ${pos.ticker} scale-flag persist failed: ${err}`);
        }
      } catch (err) {
        log.error("LIVE_EXEC", `[GoldenExit] ${pos.ticker} SCALE_40 failed: ${err}`);
      } finally {
        pos._isClosing = false;
      }
      return true;
    }

    case "TRAIL_EXIT": {
      // POST-scale runner: the working stop (max(breakeven, chandelier)) was breached.
      if (pos._isClosing) return true;
      pos._isClosing = true;
      try {
        log.warn("LIVE_EXEC", `[GoldenExit] ${pos.ticker} TRAIL/BE breach @ $${decision.price.toFixed(2)} (live $${livePrice.toFixed(2)}) — full exit of runner.`);
        await executeLiveSell({ userId, positionId: pos.id, reason: "GOLDEN_TRAIL" });
      } catch (err) {
        log.error("LIVE_EXEC", `[GoldenExit] ${pos.ticker} TRAIL exit failed: ${err}`);
        pos._isClosing = false;
      }
      return true;
    }

    case "TP_FINAL": {
      if (pos._isClosing) return true;
      pos._isClosing = true;
      try {
        log.info("LIVE_EXEC", `[GoldenExit] ${pos.ticker} TP_FINAL @ +5R ($${decision.price.toFixed(2)}) — full exit.`);
        await executeLiveSell({ userId, positionId: pos.id, reason: "GOLDEN_TP_FINAL" });
      } catch (err) {
        log.error("LIVE_EXEC", `[GoldenExit] ${pos.ticker} TP_FINAL exit failed: ${err}`);
        pos._isClosing = false;
      }
      return true;
    }
  }

  // After a HOLD with no terminal action and (when scaled) no breach/TP, RATCHET the
  // chandelier on the 60% runner so the resting broker stop tracks the SSOT working
  // stop. Tighten-only — never loosens, never below breakeven.
  if (scaled) {
    const chandelier = peak - 2.5 * atr14;
    const workingStop = Math.max(entry, priorTrail, chandelier);
    if (workingStop - priorTrail > 0.001) {
      await ratchetStopTo(db, pos, workingStop, "chandelier");
    }
  }
  return true;
}

/**
 * Tighten-only stop ratchet (long): push a strictly-higher STP to the broker via the
 * existing place-new-then-cancel-old primitive, then persist. NEVER loosens a stop and
 * NEVER goes naked on a broker push failure (the old stop keeps resting). Used by the
 * Golden SSOT exit for both the breakeven move and the chandelier trail.
 */
async function ratchetStopTo(db: any, pos: any, newStop: number, label: string): Promise<void> {
  const prevSl = Number.isFinite(Number(pos.currentSl)) ? Number(pos.currentSl) : null;
  // Long-only safety: only ratchet UP. (runGoldenSsotExit already gates to long.)
  if (prevSl != null && newStop - prevSl <= 0.001) return;
  let brokerOk = true;
  try {
    const conid = await resolveConid(pos.ticker);
    if (conid) {
      const push = await pushTrailStopToBroker({
        conid,
        direction: pos.direction,
        units: pos.units,
        newStop,
        oldOrderId: pos.ibkrSlOrderId ?? null,
        ticker: pos.ticker,
      });
      if (push.ok && push.newOrderId) {
        pos.ibkrSlOrderId = push.newOrderId;
      } else {
        brokerOk = false;
      }
    } else {
      brokerOk = false;
      log.warn("LIVE_EXEC", `[GoldenExit] ${pos.ticker} ${label} push skipped — no conid; SL kept at $${prevSl ?? "<none>"}`);
    }
  } catch (err) {
    brokerOk = false;
    log.error("LIVE_EXEC", `[GoldenExit] ${pos.ticker} ${label} broker push failed: ${err} — old stop kept resting (never naked)`);
  }
  if (brokerOk) {
    try {
      await db.update(livePositions)
        .set({ currentSl: +newStop.toFixed(2), ibkrSlOrderId: pos.ibkrSlOrderId ?? null })
        .where(eq(livePositions.id, pos.id));
      pos.currentSl = +newStop.toFixed(2);
      log.info("LIVE_EXEC", `[GoldenExit] ${pos.ticker} ${label} stop ratcheted → $${newStop.toFixed(2)}`);
    } catch { /* non-fatal */ }
  }
}

// ── Software-side SL monitor ──────────────────────────────────────────────────
/** Test-only overrides (scripts/trigger_paper_freeroll.ts). Never pass from production callers. */
export interface SlMonitorTestOpts {
  skipHardSync?: boolean;
  bypassThrottle?: boolean;
  bypassMarketHours?: boolean;
  onlyPositionId?: number;
}

// Open Skies observe-mode: positions already logged as "would free-roll" (log once/pos).
const _observedFreeRoll = new Set<number>();

/**
 * Public entry — QA FIX #2: acquire the shared stop-modification lock before running
 * the monitor, which does Open Skies free-roll partial closes, Chandelier-trail stop
 * cancel+replace, and software-SL exits — all of which mutate ibkrSlOrderId on the same
 * rows runLiveSlTpEnforcement touches. If the lock is held (enforcement CRON mid-pass),
 * SKIP this tick (next 5-min tick reattempts). Test callers (bypassThrottle) bypass the
 * lock so trigger scripts run deterministically.
 */
export async function runLiveSlMonitor(userId: number, opts?: SlMonitorTestOpts): Promise<void> {
  if (opts?.bypassThrottle) {
    await _runLiveSlMonitorImpl(userId, opts);
    return;
  }
  const lockRes = await withStopModLock(userId, "SL_MONITOR", () => _runLiveSlMonitorImpl(userId, opts));
  if (!lockRes.ran) {
    log.warn("LIVE_EXEC", `[SlMonitor] Stop-mod lock held (SL/TP enforcement active) — skipping this tick`);
  }
}

/** Mirror ibkrSync.ts:182-189 — abort mass-zombie when IBKR response is degraded/empty. */
export function hardSyncMassDisappearanceGuard(
  dbOpenTickers: string[],
  ibkrPositions: Array<{ ticker?: string; contractDesc?: string; symbol?: string }>,
): { abort: boolean; missingCount: number; missingPct: number; ibkrFoundCount: number } {
  const ibkrTickersWithAnyRecord = new Set(
    ibkrPositions.map((p) => (p.ticker ?? p.contractDesc ?? p.symbol ?? "").toUpperCase().trim()),
  );
  const ibkrFoundCount = dbOpenTickers.filter((t) =>
    ibkrTickersWithAnyRecord.has(t.toUpperCase()),
  ).length;
  const missingCount = dbOpenTickers.length - ibkrFoundCount;
  const missingPct = dbOpenTickers.length > 0 ? missingCount / dbOpenTickers.length : 0;
  const abort =
    dbOpenTickers.length >= 3 && missingPct > 0.7 && ibkrPositions.length < 3;
  return { abort, missingCount, missingPct, ibkrFoundCount };
}

async function _runLiveSlMonitorImpl(userId: number, opts?: SlMonitorTestOpts): Promise<void> {
  if (!opts?.bypassMarketHours && !isLiveMarketOpen()) return;
  if (_liveRunning && !opts?.bypassThrottle) return;

  const now = Date.now();
  if (!opts?.bypassThrottle && now - _lastLiveCycleAt < LIVE_CYCLE_GAP_MS) return;
  _lastLiveCycleAt = now;
  _liveRunning = true;

  try {
    const db = await getDb();
    if (!db) return;

    const openPos = await db.select().from(livePositions)
      .where(and(eq(livePositions.userId, userId), eq(livePositions.status, "open")));

    if (openPos.length === 0) return;

    // Ziv Phase 5 — arm the 50%@2R free-roll LIVE close via the DB switch (OFF = observe-only, today's behavior).
    const _exitCfg = await getLiveConfig(userId);
    const structuralExitsEnabled = ((_exitCfg as any)?.structuralExitsEnabled ?? 0) === 1;

    // ── HARD SYNC: If IBKR returns a clean 0-position response, force-close DB orphans ──
    // Prevents zombie management: if broker closed a position (margin call / manual),
    // we must honour that and NOT keep managing a ghost position.
    const ibkrRes = await ibindRequest("GET", `/portfolio/${LIVE_ACCOUNT_ID}/positions/0`);
    const ibkrPositions: any[] = ibkrRes.ok ? (ibkrRes.body as any[]) ?? [] : [];

    if (!opts?.skipHardSync && ibkrRes.ok) {
      const guard = hardSyncMassDisappearanceGuard(
        openPos.map((p) => p.ticker),
        ibkrPositions,
      );
      if (guard.abort) {
        log.warn(
          "LIVE_EXEC",
          `[HardSync] ABORTED — mass-disappearance guard: ${guard.missingCount}/${openPos.length} DB opens absent from IBKR response, IBKR returned ${ibkrPositions.length} records — skipping zombie-marking (gateway blip).`,
          { missingPct: guard.missingPct },
        );
        await sendTelegramMessage(
          `⚠️ <b>HardSync ABORTED — Mass Disappearance Guard</b>\n` +
            `DB has ${openPos.length} open positions, IBKR returned only ${guard.ibkrFoundCount} matching tickers (${(guard.missingPct * 100).toFixed(0)}% missing).\n` +
            `IBKR total positions list: ${ibkrPositions.length} records. Possible gateway disconnect.\n` +
            `Zombie-marking skipped. Check IBKR session/gateway.`,
        ).catch(() => {});
      } else {
        // Build set of live IBKR tickers with non-zero qty
        const ibkrActiveTickers = new Set(
          ibkrPositions
            .filter((p) => Math.abs(p.position ?? 0) > 0)
            .map((p) => (p.ticker ?? p.contractDesc ?? "").toUpperCase().trim()),
        );
        // For each DB-open position — if IBKR has zero or no entry, mark as zombie
        for (const pos of openPos) {
          if (!ibkrActiveTickers.has(pos.ticker.toUpperCase()) && pos.status === "open") {
            log.warn(
              "LIVE_EXEC",
              `[HardSync] ${pos.ticker} in DB as open but IBKR reports 0 qty — marking zombie (broker closed)`,
            );
            await db.update(livePositions)
              .set({ status: "zombie", exitReason: "hard_sync_ibkr_zero", closedAt: new Date() })
              .where(eq(livePositions.id, pos.id));
          }
        }
      }
    }

    // Re-fetch openPos after hard sync (some may now be zombie)
    let syncedOpenPos = await db.select().from(livePositions)
      .where(and(eq(livePositions.userId, userId), eq(livePositions.status, "open")));

    if (opts?.onlyPositionId != null) {
      syncedOpenPos = syncedOpenPos.filter(p => p.id === opts.onlyPositionId);
    }

    const deps = await realDeps(userId);

    // ── ZIV Shadow: batch bars once per cycle (observation only) ───────────────
    const shadowTickers = [...new Set(syncedOpenPos.map((p) => p.ticker.toUpperCase()))];
    let shadowBarsMap = new Map<string, Bar[]>();
    let shadowSpyBars: Bar[] = [];
    try {
      if (shadowTickers.length > 0) {
        shadowBarsMap = await fetchBarsBatch([...shadowTickers, "SPY"], 120);
        shadowSpyBars = shadowBarsMap.get("SPY") ?? [];
      }
    } catch {
      /* shadow monitor is best-effort — never block SL management */
    }
    const totalPortfolioValue = syncedOpenPos.reduce((s, p) => s + (p.allocatedCapital ?? 0), 0);

    for (const pos of syncedOpenPos) {
      const posAny = pos as typeof pos & { _isClosing?: boolean; peakPrice?: number | null };
      const ibkrPos = ibkrPositions.find(p =>
        p.ticker?.toUpperCase().trim() === pos.ticker.toUpperCase()
      );
      const monitorTick = resolveMonitorTickPrice(
        pos.ticker,
        ibkrPos?.mktPrice,
        pos.currentPrice,
        pos.entryPrice,
      );
      const currentTickPrice = monitorTick.price;
      // ADR source-gate: only an IBKR-fresh tick may drive a software-SL exit
      // decision. A stale/non-IBKR display value must NEVER fire (or suppress) a
      // live exit — the broker-side OCA stop remains the primary protection.
      const tickIsIbkrFresh = monitorTick.fresh && Number.isFinite(currentTickPrice) && currentTickPrice > 0;

      // Update current price in DB
      const pnl = positionUnrealizedPnl(pos.direction, pos.entryPrice, currentTickPrice, pos.units);
      const pnlPct = pos.entryPrice > 0 ? (pnl / pos.allocatedCapital) * 100 : 0;

      await db.update(livePositions)
        .set({ currentPrice: currentTickPrice, unrealizedPnl: +pnl.toFixed(2), unrealizedPnlPct: +pnlPct.toFixed(3) })
        .where(eq(livePositions.id, pos.id));

      // ── ZIV Shadow Monitor — log only, no exit actions ─────────────────────
      try {
        const tk = pos.ticker.toUpperCase();
        const bars = shadowBarsMap.get(tk) ?? shadowBarsMap.get(pos.ticker) ?? [];
        if (bars.length >= 50 && pos.entryPrice > 0) {
          const openedAt = pos.openedAt;
          const minutesInTrade = openedAt
            ? Math.floor((Date.now() - new Date(openedAt).getTime()) / 60_000)
            : 0;
          const daysHeld = openedAt
            ? Math.floor((Date.now() - new Date(openedAt).getTime()) / 86_400_000)
            : Math.floor(minutesInTrade / (60 * 24));
          const ctx: ZivHContext = {
            totalPortfolioValue,
            positionValue: positionValue(currentTickPrice, pos.units),
            daysHeld,
            spyBars: shadowSpyBars,
            minutesInTrade,
            direction: pos.direction,
            ibkrUnrealizedPnl: pnl,
            buyScore: pos.zivScore ?? null,
            peakPrice: posAny.peakPrice ?? pos.peakPrice ?? null,
            graceStartTime: null,
            spyDayStartPrice: null,
            spyCurrentPrice: null,
          };
          const zivResult = calcZivHScore(
            bars,
            pos.entryPrice,
            pos.currentSl,
            pos.currentTp,
            ctx,
          );
          const zivScore = zivResult.score;
          console.log(
            `[ZIV_SHADOW] Position ${pos.ticker} (ID: ${pos.id}): ZivScore=${zivScore} | Threshold=4.0`,
          );
        }
      } catch {
        /* non-blocking — shadow must not affect Open Skies / SL paths */
      }

      // ── Open Skies v3 — Fat-Tail two-stage exit ─────────────────────────────
      {
        const isLong    = pos.direction === "long";
        const R         = pos.rValue ?? 0;
        const atr       = pos.atr14 ?? 0;
        const livePrice = currentTickPrice;

        // ADR source-gate: Open Skies free-roll / Chandelier-trail BREACH exits
        // are live-order decisions — only act on an IBKR-fresh tick. A stale /
        // non-IBKR display price must not move the trail or fire a breach exit.
        if (!tickIsIbkrFresh) continue;
        if (!Number.isFinite(livePrice) || livePrice <= 0) continue;

        // STAGE 0: Peak Tracking
        {
          const prevPeak = posAny.peakPrice ?? pos.entryPrice;
          const newPeak  = isLong ? Math.max(prevPeak, livePrice) : Math.min(prevPeak, livePrice);

          if (Math.abs(newPeak - prevPeak) > 1e-9) {
            posAny.peakPrice = newPeak;
            try {
              await db.update(livePositions).set({ peakPrice: newPeak }).where(eq(livePositions.id, pos.id));
            } catch (err) {
              log.error("LIVE_EXEC", `[OPEN SKIES] Peak persist failed: ${err}`);
            }
          }
        }

        // ── GOLDEN 5:1 SSOT exit (TASK 2a) — gated on elzaV45LiveEnabled (default 0) ──
        // When the flag is ON, the PROVEN backtest ladder (goldenExitDecision) OWNS the
        // exit decision for this tick: it either handles it fully (continue past the legacy
        // ladder AND the software-SL fallback) or fail-closes (skip the legacy 2.0R stages
        // entirely — do NOT fire a legacy free-roll off a bad view — and fall through ONLY
        // to the software-SL fallback so the resting protective stop still guards).
        // When the flag is OFF (default) this branch is skipped and the legacy path runs
        // UNCHANGED (byte-identical to today).
        let goldenFailClosed = false;
        if (isElzaV45LiveEnabled(_exitCfg)) {
          const owned = await runGoldenSsotExit({ db, userId, pos: posAny, livePrice, deps });
          if (owned) continue; // SSOT handled the tick (HOLD/scale/ratchet/exit). Skip ALL legacy.
          goldenFailClosed = true; // non-finite view / throw / short — skip legacy stages, keep resting SL.
        }

        // STAGE 1: +2R Free-Roll
        if (!goldenFailClosed && !pos.isFreeRolled && R > 0) {
          const perShareGain = isLong ? (livePrice - pos.entryPrice) : (pos.entryPrice - livePrice);

          if (perShareGain >= freeRollTriggerGain(R)) {
            if (posAny._isClosing) continue;

            // ELZA 2.0 — Open Skies SAFE-BY-DEFAULT (observe-only until runtime-verified).
            // The 50%@2R live path is not yet proven (DU drill unavailable on this gateway),
            // so by default we LOG what we WOULD do and do NOT trade. Arm with
            // ELZA_OPEN_SKIES_EXECUTE=1 (+ restart) after 1–2 confirmed observe events.
            // Armed when EITHER the legacy env flag OR the Ziv Phase-5 DB switch is on; else observe-only.
            if (process.env.ELZA_OPEN_SKIES_EXECUTE !== "1" && !structuralExitsEnabled) {
              if (!_observedFreeRoll.has(pos.id)) {
                _observedFreeRoll.add(pos.id);
                log.warn("LIVE_EXEC", `[OPEN SKIES] OBSERVE-ONLY — would free-roll 50% @+2R for ${pos.ticker} (gain $${perShareGain.toFixed(2)} >= trigger $${freeRollTriggerGain(R).toFixed(2)}, R=${R}). NOT executing. Arm via structuralExitsEnabled=1 or ELZA_OPEN_SKIES_EXECUTE=1.`);
              }
              continue;
            }

            posAny._isClosing = true;

            try {
              // P0-1b: Stage 1 (50%@2R free-roll) executes on LIVE once armed.
              log.info("LIVE_EXEC", `[OPEN SKIES] Stage 1 free-roll @ +2R for ${pos.ticker} (acct ${pos.accountId}) — closing 50%.`);

              await executeLivePartialClose(
                { userId: pos.userId, positionId: pos.id, fraction: 0.5, reason: "FREE_ROLL_2R" },
                deps,
              );

              // QA FIX #1 — SINGLE BE-STOP OWNER.
              // The reduce leg above placed the 50% IOC and returned "pending fill"
              // WITHOUT decrementing `units`. The post-partial BE stop is now armed
              // EXCLUSIVELY by the fill poller (onPartialExitFilled → replaceStopToBreakeven),
              // which runs AFTER applyFillTxn decrements units → the BE stop is sized to
              // the RESIDUAL half. We deliberately DO NOT place a BE stop here anymore:
              // the old inline push used `pos.units` (the FULL, pre-decrement size) and
              // then the poller placed a SECOND BE stop at the correct half → oversized /
              // duplicate resting stop. replaceStopToBreakeven is now idempotent and the
              // sole owner; exactly one residual-sized BE stop ever rests.
              //
              // `executeLivePartialClose` already cancelled the original bracket SL+TP
              // (place-before-reduce, so they can't over-sell), so no inline TP cancel is
              // needed here either. We do NOT flip isFreeRolled here — applyFillTxn sets
              // isFreeRolled=1 / currentTp=null / slMovedToBreakEven=1 atomically on the
              // CONFIRMED fill, the same transaction that decrements units. Flipping it
              // pre-fill would let the Chandelier Stage-2 block (which keys off
              // isFreeRolled===1) start trailing a position whose reduce leg has not yet
              // filled — and whose `units` is still the full size.
              log.info("LIVE_EXEC", `[OPEN SKIES] ${pos.ticker} free-roll reduce leg placed — BE stop + isFreeRolled flip deferred to fill poller (single-owner, residual-sized).`);
            } catch (err) {
              log.error("LIVE_EXEC", `[OPEN SKIES] Stage 1 failed: ${err}`);
            } finally {
              posAny._isClosing = false;
            }
            continue;
          }
        }

        // STAGE 2: Chandelier Ratchet
        if (!goldenFailClosed && pos.isFreeRolled === 1 && atr > 0) {
          if (pos.ibkrTpOrderId) {
            try {
              await cancelIbkrOrder(pos.ibkrTpOrderId);
              await db.update(livePositions)
                .set({ currentTp: null, ibkrTpOrderId: null })
                .where(eq(livePositions.id, pos.id));
              pos.currentTp = null;
              pos.ibkrTpOrderId = null;
            } catch (err) {
              log.error("LIVE_EXEC", `[OPEN SKIES] TP cancel failed: ${err}`);
            }
          }

          const peakRef = posAny.peakPrice ?? pos.entryPrice;
          const chand = isLong ? (peakRef - (2.5 * atr)) : (peakRef + (2.5 * atr));
          const prevSl = pos.currentSl ?? chand;
          // TIGHTEN-ONLY: long stop ratchets UP, short stop ratchets DOWN. Never loosens.
          const trail = isLong ? Math.max(prevSl, chand) : Math.min(prevSl, chand);

          // A genuine tighten this cycle (guard float noise). Drives both the DB write
          // AND the broker cancel+replace below.
          const tightened = isLong ? (trail - prevSl > 0.001) : (prevSl - trail > 0.001);

          if (tightened) {
            // LEVER 1 — push the ratcheted stop to the broker BEFORE persisting, using a
            // place-new-then-cancel-old round-trip so the residual is never naked. We push
            // off the source-gated IBKR-fresh tick path only (this whole block is fenced by
            // `tickIsIbkrFresh` above) — never a stale/Yahoo price moves a live stop.
            let brokerOk = true;
            try {
              const conid = await resolveConid(pos.ticker);
              if (conid) {
                const push = await pushTrailStopToBroker({
                  conid,
                  direction: pos.direction,
                  units: pos.units,
                  newStop: trail,
                  oldOrderId: pos.ibkrSlOrderId ?? null,
                  ticker: pos.ticker,
                });
                if (push.ok && push.newOrderId) {
                  pos.ibkrSlOrderId = push.newOrderId;
                } else {
                  // Broker push failed → keep the OLD stop level in the DB too, so we don't
                  // advertise a tighter protective level that the broker never accepted.
                  // (Software-SL fallback below still guards off the IBKR-fresh tick.)
                  brokerOk = false;
                }
              } else {
                brokerOk = false;
                log.warn("LIVE_EXEC", `[OPEN SKIES] Trail push skipped — no conid for ${pos.ticker}; SL kept at $${prevSl}`);
              }
            } catch (err) {
              brokerOk = false;
              log.error("LIVE_EXEC", `[OPEN SKIES] Trail broker push failed for ${pos.ticker}: ${err}`);
            }

            if (brokerOk) {
              try {
                await db.update(livePositions)
                  .set({ currentSl: trail, ibkrSlOrderId: pos.ibkrSlOrderId ?? null })
                  .where(eq(livePositions.id, pos.id));
                pos.currentSl = trail;
              } catch { /* non-fatal */ }
            }
          }

          const stopLevel = pos.currentSl ?? trail;
          const isCrossed = isLong ? (livePrice <= stopLevel) : (livePrice >= stopLevel);

          if (isCrossed) {
            if (posAny._isClosing) continue;
            posAny._isClosing = true;

            try {
              await executeLiveSell({ userId: pos.userId, positionId: pos.id, reason: "CHANDELIER_TRAIL_BREACH" });
            } catch (err) {
              log.error("LIVE_EXEC", `[OPEN SKIES] Chandelier exit failed: ${err}`);
              posAny._isClosing = false;
            }
            continue;
          }
        }
      }

      // ── Phase 5: Software-side SL fallback when IBKR stop missing ───────────
      const slMissing = !pos.ibkrSlOrderId;
      const useSoftwareSl = slMissing || (pos as any).slProtection === "software";
      // ADR source-gate: a software-SL breach MUST be evaluated off an IBKR-fresh
      // tick. A stale/non-IBKR/0 price → treat as "no tick this cycle": do NOT
      // force-exit off it (a 0 price would falsely read as breached for a long).
      // The broker-side OCA stop is the primary protection meanwhile.
      if (useSoftwareSl && pos.currentSl && tickIsIbkrFresh) {
        const breached = pos.direction === "long"
          ? currentTickPrice <= pos.currentSl
          : currentTickPrice >= pos.currentSl;
        if (breached) {
          log.warn("LIVE_EXEC", `[SoftwareSL] ${pos.ticker} breached SL $${pos.currentSl} @ $${currentTickPrice} — force exit`);
          await executeLiveSell({ userId, positionId: pos.id, reason: "SOFTWARE_SL" });
          continue;
        }
      }

      // ── IBKR-side SL: price display only (native STP handles fill) ──────────
    }

    try {
      const { syncAllElzaHoldingsFromLivePositions } = await import("./portfolioHoldingsSync");
      await syncAllElzaHoldingsFromLivePositions(db, userId);
    } catch {
      /* portfolio mirror is best-effort */
    }
  } finally {
    _liveRunning = false;
  }
}

/** Backfill atr14/rValue/initialSl for legacy opens missing GoldenExit metadata. */
export async function backfillOpenPositionRiskMetrics(
  db: Awaited<ReturnType<typeof getDb>>,
  pos: {
    id: number;
    ticker: string;
    direction: string;
    entryPrice: number;
    currentSl?: number | null;
    initialSl?: number | null;
    rValue?: number | null;
    atr14?: number | null;
  },
): Promise<boolean> {
  if (!db) return false;
  const needsR = pos.rValue == null || !Number.isFinite(Number(pos.rValue)) || Number(pos.rValue) <= 0;
  const needsAtr = pos.atr14 == null || !Number.isFinite(Number(pos.atr14)) || Number(pos.atr14) <= 0;
  const needsInitSl = pos.initialSl == null || !Number.isFinite(Number(pos.initialSl));
  if (!needsR && !needsAtr && !needsInitSl) return false;

  try {
    const bars = await fetchBarsForTicker(pos.ticker, 90);
    if (!bars?.length) return false;
    const entry = Number(pos.entryPrice);
    if (!Number.isFinite(entry) || entry <= 0) return false;
    const slTp = calcEntrySlTp({
      entryPrice: entry,
      direction: (pos.direction === "short" ? "short" : "long") as "long" | "short",
      bars,
      ema50: ema50FromBars(bars),
    });
    const updates: Record<string, number> = {};
    if (needsAtr && slTp.atr14 != null && slTp.atr14 > 0) updates.atr14 = +slTp.atr14.toFixed(4);
    if (needsR && slTp.rValue > 0) updates.rValue = +slTp.rValue.toFixed(4);
    const slRef = pos.currentSl ?? slTp.stopLoss;
    if (needsInitSl && slRef != null && Number(slRef) > 0) updates.initialSl = +Number(slRef).toFixed(4);
    if (!Object.keys(updates).length) return false;
    await db.update(livePositions).set(updates).where(eq(livePositions.id, pos.id));
    log.info("LIVE_EXEC", `[RiskBackfill] ${pos.ticker} atr14=${updates.atr14 ?? "—"} rValue=${updates.rValue ?? "—"}`, { ticker: pos.ticker });
    return true;
  } catch (e: any) {
    log.warn("LIVE_EXEC", `[RiskBackfill] ${pos.ticker} failed: ${e?.message ?? e}`);
    return false;
  }
}

// ── Execute a LIVE sell ───────────────────────────────────────────────────────
export async function executeLiveSell(params: {
  userId: number;
  positionId: number;
  reason: string;
}): Promise<{ success: boolean; reason: string }> {
  const { userId, positionId, reason } = params;
  const db = await getDb();
  if (!db) return { success: false, reason: "DB unavailable" };

  const rows = await db.select().from(livePositions)
    .where(and(eq(livePositions.id, positionId), eq(livePositions.userId, userId))).limit(1);
  const pos = rows[0];
  if (!pos) return { success: false, reason: "Position not found" };
  if (pos.status !== "open" && pos.status !== "zombie") {
    return { success: false, reason: `Already ${pos.status}` };
  }

  // Mark as pending — exitReason is set only after IBKR accepts the exit order
  if (pos.status === "open") {
    await db.update(livePositions).set({ status: "pending_exit", exitReason: null }).where(eq(livePositions.id, positionId));
  }

  const conid = await resolveConid(pos.ticker);
  if (!conid) {
    await db.update(livePositions).set({ status: "zombie" }).where(eq(livePositions.id, positionId));
    return { success: false, reason: `No conid for ${pos.ticker}` };
  }

  // ── Cancel BOTH SL and TP bracket orders on IBKR ────────────────────────────
  // IBKR OCA should auto-cancel, but we cancel explicitly for safety
  const ordersToCancel = [pos.ibkrSlOrderId, pos.ibkrTpOrderId].filter(Boolean) as string[];
  for (const ordId of ordersToCancel) {
    const cancelRes = await ibindRequest("DELETE", `/iserver/account/${LIVE_ACCOUNT_ID}/order/${ordId}`);
    if (cancelRes.ok) {
      log.info("LIVE_EXEC", `[Sell] Cancelled bracket order ${ordId} for ${pos.ticker}`);
    } else {
      log.warn("LIVE_EXEC", `[Sell] Could not cancel order ${ordId} for ${pos.ticker}: HTTP ${cancelRes.status}`);
    }
  }

  // ── IRON RULE: No naked Market orders — Marketable LMT with 1% max offset ──
  // Prevents catastrophic slippage on low-liquidity / halted instruments.
  const exitSide = pos.direction === "long" ? "SELL" : "BUY";
  const MAX_SLIP_PCT = 0.01; // 1% max slippage tolerance

  // Fetch live price for LMT offset — IBKR snapshot
  let lmtPrice: number | null = null;
  try {
    // REPOINT 2026-06-25: /iserver/marketdata/snapshot 404s on the OAuth gateway.
    // Re-price the exit LMT off the working POST /quotes pipeline (IBKR broker truth;
    // returns a LivePrice → use .price). On failure / 0 price → lmtPrice stays null and
    // the DB-price fallback below runs (never a naked MKT; never price off stale EOD here).
    const priceMap = await fetchIbkrLivePricesBatch([pos.ticker], { skipCache: true });
    const lp = priceMap.get(pos.ticker) ?? null;
    // QA fix #2: price the exit LMT ONLY off real-time IBKR truth. A silent Yahoo/DB-cache fallback
    // (source!=='ibkr') is treated as no live price → lmtPrice stays null and the DB-price LMT
    // fallback below runs (never a naked MKT; never price a live exit off a delayed/stale print).
    const live = lp?.source === 'ibkr' ? Number(lp.price ?? 0) : 0;
    if (live > 0) {
      // SELL: LMT at live - 1% (willing to accept up to 1% below market)
      // BUY (short cover): LMT at live + 1% (willing to pay up to 1% above market)
      lmtPrice = exitSide === "SELL"
        ? +(live * (1 - MAX_SLIP_PCT)).toFixed(2)
        : +(live * (1 + MAX_SLIP_PCT)).toFixed(2);
      log.info("LIVE_EXEC", `[Sell] Marketable LMT exit ${pos.ticker} ${exitSide} @ $${lmtPrice} (live=$${live} offset=${MAX_SLIP_PCT*100}%)`);
    }
  } catch {}

  // If live quote failed/0 — still use LMT based on DB price (not raw MKT)
  if (!lmtPrice) {
    const fallbackPrice = pos.currentPrice ?? pos.entryPrice;
    lmtPrice = exitSide === "SELL"
      ? +(fallbackPrice * (1 - MAX_SLIP_PCT)).toFixed(2)
      : +(fallbackPrice * (1 + MAX_SLIP_PCT)).toFixed(2);
    log.warn("LIVE_EXEC", `[Sell] Live quote unavailable for ${pos.ticker} — Marketable LMT fallback @ $${lmtPrice} (DB price=$${fallbackPrice})`);
  }

  const sellBody = {
    account_id: LIVE_ACCOUNT_ID,
    conid,
    side: exitSide,
    quantity: Math.abs(pos.units),
    orderType: "LMT",
    limitPrice: lmtPrice,
    outsideRth: false,
    tif: "IOC",   // Immediate-or-Cancel: fill at limit or cancel; no resting order risk
    orderRef: `ELZA_EXIT_${pos.ticker}_${Date.now()}`,
  };

  // ENDPOINT FIX 2026-06-29: /orders/limit 405s on the gateway; route exit through /orders/close-position.
  const res = await ibindRequest("POST", "/orders/close-position", sellBody, { "X-Confirm-Live-Order": "yes" });
  // If IOC LMT didn't fill, retry once as DAY LMT (wider window)
  let retryRes: typeof res | null = null;
  if (!res.ok || (res.body as any)?.filled === false) {
    log.warn("LIVE_EXEC", `[Sell] IOC LMT ${pos.ticker} not filled — retrying as DAY LMT`);
    retryRes = await ibindRequest("POST", "/orders/close-position", { ...sellBody, tif: "DAY" }, { "X-Confirm-Live-Order": "yes" });
  }
  const finalRes = retryRes ?? res;
  if (!finalRes.ok) {
    const errMsg = ((finalRes.body as any)?.message ?? `HTTP ${finalRes.status}`).toString();

    // ── V2.00 Feature 4: LULD Halt Detection ──────────────────────────────
    // IBKR error codes / messages that indicate a trading halt:
    //   Error 1100: "Connectivity between IB and exchange lost"
    //   Error 162: "Historical Market Data Service error"
    //   Message contains "halt" / "luld" / "limit up" / "limit down" / "suspended"
    const isHaltError = /halt|luld|limit.?up|limit.?down|suspended|1100|trading.*stopped/i.test(errMsg)
      || finalRes.status === 1100;

    if (isHaltError) {
      const exitSideHalt = pos.direction === "long" ? "SELL" : "BUY";
      log.warn("LIVE_EXEC",
        `[Sell] 🛑 LULD HALT detected for ${pos.ticker} — marking PENDING_HALT. Will retry when halt lifts.`,
        { ticker: pos.ticker, error: errMsg }
      );
      try {
        const { markPositionPendingHalt } = await import("./partialFillMonitor");
        await markPositionPendingHalt(positionId, exitSideHalt as "BUY" | "SELL");
      } catch (haltErr: any) {
        log.warn("LIVE_EXEC", `[Sell] markPositionPendingHalt failed: ${haltErr.message}`);
      }
      // Also send Telegram alert
      try {
        await sendTelegramMessage(
          `🛑 *TRADING HALT DETECTED*
` +
          `${pos.ticker} exit order REJECTED — halt in progress.
` +
          `Position marked PENDING_HALT. Recovery monitor will re-send when halt lifts.
` +
          `Error: ${errMsg.slice(0, 120)}`
        );
      } catch {}
      return { success: false, reason: `LULD halt: ${errMsg}` };
    }

    log.error("LIVE_EXEC", `[Sell] FAILED ${pos.ticker}: ${errMsg}`);
    // BUILD 1: loud structured alert + consecutive-failure tracking (gateway-stale hint).
    // This is the exact silent-405 outage path ("[Sell] FAILED … HTTP 405").
    reportOrderFailure({ ticker: pos.ticker, action: exitSide, status: finalRes.status, endpoint: "/orders/close-position", errMsg });
    const newRetryCount = (pos.exitRetryCount ?? 0) + 1;
    if (newRetryCount >= 3) {
      await db.update(livePositions)
        .set({ status: "zombie", exitRetryCount: newRetryCount, exitReason: null })
        .where(eq(livePositions.id, positionId));
    } else {
      await db.update(livePositions)
        .set({ status: "open", exitReason: null, exitRetryCount: newRetryCount })
        .where(eq(livePositions.id, positionId));
    }
    return { success: false, reason: errMsg };
  }
  // Exit placement accepted by the gateway — reset the consecutive-failure streak.
  noteOrderSuccess();

  const exitOrderId = (finalRes.body as any)?.order_id?.toString() ?? null;

  // War Room manual close: return fast — popup polls getExitProgress until IBKR + DB clear
  if (reason === "MANUAL_CLOSE" && exitOrderId) {
    await db.update(livePositions).set({ ibkrExitOrderId: exitOrderId, exitReason: reason }).where(eq(livePositions.id, positionId));
    log.info("LIVE_EXEC", `[Sell] MANUAL_CLOSE ${pos.ticker} order sent — defer finalize`, { exitOrderId });
    return {
      success: true,
      reason: "פקודת מכירה נשלחה — ממתין לביצוע",
      orderId: exitOrderId,
      orderType: "LMT",
      quantity: Math.abs(pos.units),
      ticker: pos.ticker,
      side: exitSide as "BUY" | "SELL",
    };
  }

  let exitPrice = toPriceNumber(pos.currentPrice, toPriceNumber(pos.entryPrice, 0));
  if (exitOrderId) {
    const { resolveOrderFill } = await import("./liveMarketOrder");
    const exitFill = await resolveOrderFill(exitOrderId, Math.abs(pos.units));
    if (exitFill.avgPrice && exitFill.avgPrice > 0) exitPrice = exitFill.avgPrice;
  }
  const realizedPnl = positionRealizedPnl(pos.direction, pos.entryPrice, exitPrice, pos.units);

  await db.update(livePositions).set({
    status: "closed",
    exitPrice,
    realizedPnl: +realizedPnl.toFixed(2),
    exitReason: reason,
    ibkrExitOrderId: exitOrderId,
    closedAt: new Date(),
  }).where(eq(livePositions.id, positionId));

  await db.delete(liveEntryLock).where(and(eq(liveEntryLock.userId, userId), eq(liveEntryLock.ticker, pos.ticker.toUpperCase())));

  await db.insert(liveTrades).values({
    userId,
    positionId,
    ticker: pos.ticker,
    side: exitSide,
    units: Math.abs(pos.units),
    price: exitPrice,
    reason,
    ibkrOrderId: exitOrderId ?? undefined,
    status: "filled",
  });

  const emoji = realizedPnl >= 0 ? "✅" : "🔴";
  await sendTelegramMessage(
    `${emoji} <b>ELZA LIVE EXIT</b>\n` +
    `<b>${pos.ticker}</b> closed @ $${fmtPrice(exitPrice)}\n` +
    `P&L: ${realizedPnl >= 0 ? "+" : ""}$${fmtPrice(realizedPnl)} | Reason: ${reason}`
  );

  return {
    success: true,
    reason: `Closed at $${fmtPrice(exitPrice)}`,
    orderId: exitOrderId,
    orderType: "LMT",
    quantity: Math.abs(pos.units),
    ticker: pos.ticker,
    side: exitSide as "BUY" | "SELL",
    exitPrice,
  };
}

/** Finalize a pending_exit row after IBKR position qty hits 0 (War Room poll path). */
export async function finalizePendingExit(params: {
  userId: number;
  ticker: string;
  avgPrice?: number | null;
}): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  const ticker = params.ticker.toUpperCase().trim();
  const rows = await db.select().from(livePositions)
    .where(and(
      eq(livePositions.userId, params.userId),
      eq(livePositions.ticker, ticker),
      eq(livePositions.status, "pending_exit"),
    ))
    .limit(1);
  const pos = rows[0];
  if (!pos) return false;

  const exitSide = pos.direction === "long" ? "SELL" : "BUY";
  const exitPrice = params.avgPrice && params.avgPrice > 0
    ? params.avgPrice
    : toPriceNumber(pos.currentPrice, toPriceNumber(pos.entryPrice, 0));
  const realizedPnl = positionRealizedPnl(pos.direction, pos.entryPrice, exitPrice, pos.units);
  const reason = pos.exitReason ?? "MANUAL_CLOSE";

  await db.update(livePositions).set({
    status: "closed",
    exitPrice,
    realizedPnl: +realizedPnl.toFixed(2),
    exitReason: reason,
    closedAt: new Date(),
  }).where(eq(livePositions.id, pos.id));

  await db.delete(liveEntryLock).where(and(eq(liveEntryLock.userId, params.userId), eq(liveEntryLock.ticker, ticker)));

  await db.insert(liveTrades).values({
    userId: params.userId,
    positionId: pos.id,
    ticker: pos.ticker,
    side: exitSide,
    units: Math.abs(pos.units),
    price: exitPrice,
    reason,
    ibkrOrderId: pos.ibkrExitOrderId ?? undefined,
    status: "filled",
  });

  log.info("LIVE_EXEC", `[Sell] Finalized pending_exit ${ticker} @ $${fmtPrice(exitPrice)}`);
  return true;
}


// ─── EOD Deleverage Sweep (22:45 Israel time) ────────────────────────────────
/**
 * runDeleveragingCycle — called at 22:45 Israel time.
 *
 * Strategy for selecting positions to close:
 *   1. First close LOSERS (negative P&L) — clean the dead weight
 *   2. Then close WINNERS (positive P&L) — lock in profits if still over limit
 *
 * Rationale: Overnight losses compound (margin interest + gap risk).
 *            Keeping winners overnight has asymmetric upside vs margin cost.
 *            If we must choose — clear losers first, then lock winners.
 */
export async function runDeleveragingCycle(
  userId: number = 1,
  opts: { excludeFreeRolled?: boolean } = {},
): Promise<{
  trimmed: number;
  failed: number;
  uvBeforeUsd: number;
  uvAfterUsd: number;
}> {
  const db = await getDb();
  if (!db) return { trimmed: 0, failed: 0, uvBeforeUsd: 0, uvAfterUsd: 0 };

  const config = await getLiveConfig(userId);
  if (!config) return { trimmed: 0, failed: 0, uvBeforeUsd: 0, uvAfterUsd: 0 };

  const { overnightCap: staticOvernightCap, cashBudget } = computeLiveCapital(config);

  const openPos = await db.select().from(livePositions)
    .where(and(eq(livePositions.userId, userId), eq(livePositions.status, "open")));

  const totalDeployed = openPos.reduce((s, p) => s + (p.allocatedCapital ?? 0), 0);

  // ── REQ 2 — EOD-TRIM: wire overnightGrossCap (VIX-aware) — INERT unless flag=1 ──
  // When elzaV45LiveEnabled=0 the static 1.9× overnightCap (today's behavior) is used
  // unchanged. When armed, compute the gross-exposure leverage multiple (Σ notional /
  // NLV) and the VIX-aware overnight target via the PURE overnightGrossCap(); a high
  // VIX tightens the target further (1.0× / 0.5× overnight) so we never carry 4×
  // overnight on an elevated-vol close. We translate the leverage-multiple target back
  // to a USD cap (targetGrossPct × cashBudget) and feed it into the EXISTING loser-first
  // trim loop below (reuses executeLiveSell + the cron's verify/alert path).
  let overnightCap = staticOvernightCap;
  if (isElzaV45LiveEnabled(config)) {
    // EOD-3 FIX — the gross-leverage denominator MUST be LIVE NLV, never the static,
    // UI-refreshed config.totalNlv (which can be hours/days stale and silently loosens
    // the overnight cap). Pull NLV from the SAME fail-closed broker read the circuit
    // breaker uses. On a failed read we DROP the dynamic VIX-aware tightening entirely
    // and fall back to ONLY the static 1.9× cap below — i.e. fail to the existing static
    // behavior, NEVER to a looser cap.
    const liveNlvRead = await fetchLiveNlvAndDayPnl(userId);
    if (!liveNlvRead.ok) {
      log.warn("LIVE_MONITOR", `[Deleverage-EOD][Elza] live NLV read FAILED (${liveNlvRead.reason}) — skipping VIX-aware tightening, using static 1.9× cap only.`);
    } else {
    const nlv = liveNlvRead.nlvNow > 0 ? liveNlvRead.nlvNow : Math.max(totalDeployed, 1);
    const currentGrossPct = totalDeployed / nlv; // gross exposure as a leverage multiple
    // No real ^VIX feed on this gateway — reuse the SPY realized-vol proxy (vixProxy)
    // that runtimeIntelligence already computes for the regime gate. On any failure the
    // PURE overnightGrossCap FAILS CLOSED (non-finite VIX → most-defensive 0.5×).
    let vix = NaN;
    try {
      const { getMarketRegime } = await import("./runtimeIntelligence");
      const regime = await getMarketRegime();
      // EOD-1 FIX: a DEGRADED/fallback regime (SPY fetch failed / insufficient data /
      // throw) carries a PLACEHOLDER vixProxy=20, NOT a real measurement. Treat it as a
      // BAD VIX read → vix=NaN so overnightGrossCap takes the 0.5× fail-closed branch.
      vix = regime.degraded === true ? NaN : regime.vixProxy;
      if (regime.degraded === true) {
        log.warn("LIVE_MONITOR", `[Deleverage-EOD][Elza] regime DEGRADED (${regime.regimeReason}) — VIX untrustworthy → overnightGrossCap fails-closed (0.5×)`);
      }
    } catch (e: any) {
      log.warn("LIVE_MONITOR", `[Deleverage-EOD][Elza] VIX proxy read failed: ${e?.message ?? e} — overnightGrossCap will fail-closed (0.5×)`);
    }
    const cap = overnightGrossCap(vix, currentGrossPct, ELZA_V45_CFG);
    if (cap.trimNeededPct > 0) {
      const elzaCapUsd = cap.targetGrossPct * cashBudget;
      // Use the MORE defensive of the static 1.9× cap and the Elza VIX-aware target.
      overnightCap = Math.min(staticOvernightCap, elzaCapUsd);
      log.warn("LIVE_MONITOR",
        `[Deleverage-EOD][Elza] ${cap.reason} | gross ${currentGrossPct.toFixed(2)}× → target ${cap.targetGrossPct.toFixed(2)}× ($${elzaCapUsd.toFixed(0)}); effective overnight cap $${overnightCap.toFixed(0)} (static was $${staticOvernightCap.toFixed(0)})`,
        { vix, currentGrossPct, targetGrossPct: cap.targetGrossPct, elzaCapUsd, staticOvernightCap }
      );
    } else {
      log.info("LIVE_MONITOR", `[Deleverage-EOD][Elza] ${cap.reason} — no extra Elza trim needed (gross ${currentGrossPct.toFixed(2)}×)`);
    }
    } // end else (live NLV read ok)
  }

  log.warn("LIVE_MONITOR",
    `[Deleverage-EOD] Sweep triggered. Total deployed: $${totalDeployed.toFixed(0)} vs overnight cap: $${overnightCap.toFixed(0)} (cash base: $${cashBudget.toFixed(0)} × 1.9x)`,
    { totalDeployed, overnightCap, cashBudget, openCount: openPos.length }
  );

  if (totalDeployed <= overnightCap) {
    log.info("LIVE_MONITOR",
      `[Deleverage-EOD] ✅ Portfolio within overnight cap ($${totalDeployed.toFixed(0)} <= $${overnightCap.toFixed(0)}). No action needed.`,
      { totalDeployed, overnightCap }
    );
    return { trimmed: 0, failed: 0, uvBeforeUsd: totalDeployed, uvAfterUsd: totalDeployed };
  }

  const excess = totalDeployed - overnightCap;
  log.warn("LIVE_MONITOR",
    `[Deleverage-EOD] ⚠️ Over overnight cap by $${excess.toFixed(0)}. Trimming weakest positions...`,
    { excess, overnightCap, totalDeployed }
  );

  // ── Free-Roll immunity (manual EOD-Trim only) ────────────────────────────────
  // A free-rolled position has already shed 50% and trails on a breakeven stop — it
  // carries ZERO downside risk overnight, so the manual owner trim must never flatten
  // it. INERT for the cron: opts.excludeFreeRolled is undefined on the scheduled call
  // (cron passes no opts), so trimCandidates === openPos and behavior is byte-identical.
  const trimCandidates = opts.excludeFreeRolled
    ? openPos.filter((p) => p.isFreeRolled !== 1)
    : openPos;

  // ── Sort: LOSERS first (ascending unrealized P&L), winners last ──────────────
  const sorted = [...trimCandidates].sort((a, b) => {
    // Use unrealizedPnlUsd if stored, otherwise compute from currentPrice
    const unrealA = a.direction === "long"
      ? ((a.currentPrice ?? a.entryPrice) - a.entryPrice) * a.units
      : (a.entryPrice - (a.currentPrice ?? a.entryPrice)) * a.units;
    const unrealB = b.direction === "long"
      ? ((b.currentPrice ?? b.entryPrice) - b.entryPrice) * b.units
      : (b.entryPrice - (b.currentPrice ?? b.entryPrice)) * b.units;
    return unrealA - unrealB; // losers first (most negative P&L → closed first)
  });

  let trimmed = 0;
  let failed  = 0;
  let remainingExcess = excess;
  const uvBeforeUsd = totalDeployed;

  for (const pos of sorted) {
    if (remainingExcess <= 0) break;

    const posCapital = pos.allocatedCapital ?? (pos.entryPrice * pos.units);
    const pnlUsd = (pos.currentPrice ?? pos.entryPrice) - pos.entryPrice;
    const pnlPct = (pnlUsd / pos.entryPrice) * 100;

    log.warn("LIVE_MONITOR",
      `[Deleverage-EOD] Trimming ${pos.ticker} (P&L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%, Capital: $${posCapital.toFixed(0)}) to meet overnight margin compliance.`,
      { ticker: pos.ticker, posCapital, pnlPct: +pnlPct.toFixed(2), remainingExcess }
    );

    const result = await executeLiveSell({
      userId,
      positionId: pos.id,
      reason: `DELEVERAGE_EOD — overnight margin compliance (excess $${excess.toFixed(0)})`,
    });

    // EOD-2 FIX: executeLiveSell returning success means the exit order was ACCEPTED,
    // NOT necessarily FILLED. Before counting the trim, VERIFY the broker position
    // actually went to ~0. If it is still held by the bell → the excess carries
    // overnight: do NOT count trimmed++/decrement remainingExcess, and fire an alert.
    let trimVerified = false;
    if (result.success && isElzaV45LiveEnabled(config)) {
      const conid = await resolveConid(pos.ticker).catch(() => null);
      let brokerHeld = await readBrokerPositionQty(conid, pos.ticker);
      // One short re-poll — the fill may land a beat after the accept.
      if (brokerHeld > 0) {
        await new Promise((r) => setTimeout(r, 800));
        brokerHeld = await readBrokerPositionQty(conid, pos.ticker);
      }
      trimVerified = brokerHeld <= 0;
      if (!trimVerified) {
        log.error("LIVE_MONITOR",
          `[Deleverage-EOD] ⚠️ ${pos.ticker} exit accepted but STILL HELD (${brokerHeld}) at the broker — NOT counting as trimmed (excess carries overnight).`,
          { ticker: pos.ticker, brokerHeld });
        try {
          void sendTelegramMessage(
            `🚨 <b>EOD-TRIM FAILED (UNFILLED)</b>\n` +
            `<b>${pos.ticker}</b> exit ACCEPTED but still held ${brokerHeld} at the bell — excess carries overnight. MANUAL flatten required.`
          ).catch(() => {});
        } catch { /* best-effort */ }
      }
    } else if (result.success) {
      // Flag OFF (DEFAULT) → preserve today's behavior: accept = counted.
      trimVerified = true;
    }

    if (result.success && trimVerified) {
      // Cancel orphaned bracket orders
      await cancelBracketOrders({
        ticker: pos.ticker,
        ibkrSlOrderId: (pos as any).ibkrSlOrderId,
        ibkrTpOrderId: pos.ibkrTpOrderId,
      });

      trimmed++;
      remainingExcess -= posCapital;
      log.info("LIVE_MONITOR",
        `[Deleverage-EOD] ✅ Closed ${pos.ticker} @ ~$${(pos.currentPrice ?? pos.entryPrice).toFixed(2)}. Remaining excess: $${Math.max(0, remainingExcess).toFixed(0)}`,
        { ticker: pos.ticker, trimmedCount: trimmed, remainingExcess }
      );
    } else if (result.success && !trimVerified) {
      // Accepted-but-unfilled: count as a failure, do NOT decrement remainingExcess.
      failed++;
    } else {
      failed++;
      log.error("LIVE_MONITOR",
        `[Deleverage-EOD] ❌ Failed to close ${pos.ticker}: ${result.reason}`,
        { ticker: pos.ticker, reason: result.reason }
      );
      // ── REQ 2 — a trim that fails to fill before the bell carries excess overnight.
      // Fire a War-Room alert (reuse the same Telegram path the cron uses) so the owner
      // can manually flatten. INERT unless armed: only fans out when the flag is ON, so
      // default behavior (the cron's end-of-sweep summary) is unchanged.
      if (isElzaV45LiveEnabled(config)) {
        try {
          void sendTelegramMessage(
            `🚨 <b>EOD-TRIM FAILED</b>\n` +
            `<b>${pos.ticker}</b> did NOT close before the bell — ${result.reason}\n` +
            `Excess may carry overnight. MANUAL flatten required.`
          ).catch(() => {});
        } catch { /* best-effort */ }
      }
    }
  }

  const uvAfterUsd = Math.max(0, uvBeforeUsd - (trimmed > 0 ? excess - Math.max(0, remainingExcess) : 0));
  log.info("LIVE_MONITOR",
    `[Deleverage-EOD] Sweep complete. Trimmed: ${trimmed} | Failed: ${failed} | Deployed: $${uvBeforeUsd.toFixed(0)} → ~$${uvAfterUsd.toFixed(0)} | Overnight cap: $${overnightCap.toFixed(0)}`,
    { trimmed, failed, uvBeforeUsd, uvAfterUsd, overnightCap }
  );

  return { trimmed, failed, uvBeforeUsd, uvAfterUsd };
}

// ── Emergency exit all positions ─────────────────────────────────────────────
export async function emergencyExitAll(userId: number): Promise<{ closed: number; failed: number }> {
  const db = await getDb();
  if (!db) return { closed: 0, failed: 0 };

  const openPos = await db.select({ id: livePositions.id })
    .from(livePositions)
    .where(and(eq(livePositions.userId, userId), eq(livePositions.status, "open")));

  let closed = 0, failed = 0;
  for (const pos of openPos) {
    const result = await executeLiveSell({ userId, positionId: pos.id, reason: "EMERGENCY_EXIT" });
    result.success ? closed++ : failed++;
  }

  log.info("LIVE_EXEC", `[EmergencyExit] closed=${closed} failed=${failed}`);
  return { closed, failed };
}
