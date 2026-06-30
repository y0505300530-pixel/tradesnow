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
import { eq, and, inArray, sql, lt } from "drizzle-orm";
import { log } from "./logger";
import { sendTelegramMessage } from "./telegram";
import { fmtPrice, toPriceNumber } from "./utils/formatPrice";
import { fetchBarsBatch, fetchBarsForTicker, fetchIbkrLivePricesBatch, type Bar } from "./marketData";
import { calcEntrySlTp, ema50FromBars, ensureDirectionalSlTp, validateSlTpDirection, freeRollTriggerGain } from "./slCalculator";
import { isGapChase, gapPctFromEntryZone, GAP_GUARD_PCT } from "./gapGuard";
import { calcZivHScore, type ZivHContext } from "./utils/zivHealth";
import { safeInsertLivePosition } from "./livePositionsSyncCore";
import { isGhostSlotsEnabled, rowCountsTowardSlot } from "./ghostSlots";
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
  const maxPosUsd = (config as any).maxPositionUsd ?? 999999;
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
  // schema default is 50000 (NOT NULL) — the ?? is a dead-safe fallback only.
  const _maxPosCapUsd = config?.maxPositionUsd ?? 50000;
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
 * Tighten-only is enforced by the CALLER (Stage 2 ratchet);