/**
 * waiterEngine.ts — THE WAITER (retest resting-limit system, BUILD-spec 2026-06-30).
 *
 * A breakout CHASES strength; a retest WAITS for price to pull back to support and buys
 * the bounce. The right mechanism for "price comes to you" is NOT polling — it is a
 * resting LMT buy sitting at the support level, held by IBKR, filling passively. The
 * Waiter places and MANAGES those resting orders for the top-N GOLD_RETEST_WAR candidates.
 *
 * Parity (non-negotiable — §9): risk stays 1% (riskDollars = NLV × 0.01 × vixMult,
 * IDENTICAL to Elza via vixRiskSize), stop stays wideLungSL, exits stay the Golden ladder.
 * ONLY the entry mechanism changes (resting LMT vs market). On fill it is a normal
 * v4.5-managed `open` position — the Waiter's job ends at the fill.
 *
 * ── THE INERT INVARIANT (non-negotiable) ─────────────────────────────────────────
 * `waiterEnabled` defaults to 0. When 0, EVERY exported orchestrator (runWaiterTick,
 * reconcileWaiterPositions, R1 helper) reads the flag FIRST and returns before ANY
 * candidate load / order / DB write / extra fetch → runtime byte-identical to today.
 * The owner arms it later (a SEPARATE action) after the retest-sleeve backtest.
 *
 * ── §3 BUDGET — ONE shared budget, 30% is a HARD SUB-CAP within it (not a sleeve) ──
 * Waiter + War draw from the SAME shared budget + the SAME live _optimisticBP ledger.
 * Before placing a resting LMT: BOTH must hold — (a) Σ(open-retest value +
 * resting-retest-LMT notional) + thisOrder ≤ waiterNlvPct × NLV, AND (b) the shared
 * Optimistic-BP check. A resting LMT decrements _optimisticBP (shared) AND counts against
 * the 30% sub-cap the MOMENT it is sent, so a burst of fills can't blow either bound.
 *
 * ── §4 SLOT GUARD — a resting/pending LMT IS a committed slot ─────────────────────
 * Every resting LMT creates a livePositions row at status="pending_entry",
 * countsTowardSlot=1, isWaiterEntry=1. freeRetestSlots = maxRetestSlots − (open retests +
 * resting retest LMTs), computed ATOMICALLY under the shared entrySlotLock. Broadcast at
 * most freeRetestSlots, ranked by score (best first).
 *
 * ── §5/§5b MANAGER (ONE tick, not competing loops) ───────────────────────────────
 * While a LMT rests: cancel on falling-knife (5m close < struct stop), setup-invalidation
 * (off the retest list / price < EMA-50), EOD (DAY tif, no overnight ambush); R2 re-quote
 * on retest-level drift > 0.5% (cancel+replace, never chase up past anti-chase). On fill: R3
 * bind STP + slot/budget to the ACTUAL filled qty; R4 arm wideLungSL STP → re-read /orders
 * (G1-A) to confirm resting → if not confirmed within N s, FLATTEN + alert (no naked window).
 *
 * ── R1 — Mutual exclusion Waiter ↔ War (the most important catch) ─────────────────
 * The slow War cycle ALSO enters GOLD_RETEST_WAR names (market buy). When the Waiter holds
 * an armed/resting LMT on a ticker, the War cycle MUST skip that ticker's retest entry
 * (waiterHoldsRetest, checked under the shared entrySlotLock before any retest market buy).
 */

import { getDb } from "./db";
import { livePositions, systemSettings, type LiveEngineConfig } from "../drizzle/schema";
import { eq, and, inArray } from "drizzle-orm";
import { wideLungSL, vixRiskSize } from "./engine/elzaV45Master";
import { calcEMA } from "./zivEngine";
import { resolveConid } from "./conidResolver";
import {
  getLiveConfig,
  peekOptimisticBP,
  reserveOptimisticBP,
  releaseOptimisticBP,
  executeLiveSell,
} from "./liveOrderExecutor";
import { verifyRestingStopAtBe } from "./ghostSlots";
import { ibindRequest } from "./routers/ibkrProxy";
import { fetchBarsForTicker, fetchIbkrLivePricesBatch } from "./marketData";
import { fetchIntradayBarsForTicker, filterRegularSession, type IntradayBar } from "./intradayMarketData";
import { getMarketRegime } from "./runtimeIntelligence";
import { tryAcquireEntrySlot, releaseEntrySlot } from "./entrySlotLock";
import { dbLog } from "./persistentLogger";
import { log } from "./logger";

export const LIVE_ACCOUNT_ID = "U16881054";
const CONFIRM_HEADERS = { "X-Confirm-Live-Order": "yes" };

// ── Constants (Appendix — pinned, backtestable) ──────────────────────────────────
/**
 * THE RETEST FIX (2026-06-30, owner-ratified — DR_WAITER_RETEST_ELIGIBILITY.md). The
 * resting LMT price is NO LONGER a separate ×1.02 ambush. It is now the SINGLE SSOT
 * `evaluateRetestV2(...).limitPrice` (trueRetestEngine.ts) = structuralLevel × (1 +
 * LIMIT_ABOVE_PCT/100) = level × 1.0075, FOMO-capped at level × (1 + FOMO_PCT/100) =
 * level × 1.015. The OLD +2% ambush CONTRADICTED Ziv's ±2% retest-confirmation band: when
 * the retest CONFIRMS (live ≈ level), live is not yet >+2% above level, so the +2% LMT
 * rested ABOVE live → anti-chase rejected every candidate (G2 = 0 fills over 60 days). We
 * delete the ×1.02 model and consume the threaded `limitPrice`. The FOMO cap (1.5%) is the
 * anti-chase ceiling. RETEST_AMBUSH_ABOVE_PCT is retained ONLY as the documented alignment
 * value (= LIMIT_ABOVE_PCT/100 = 0.75%) — it NO LONGER derives a price (kept so existing
 * imports/tests have the aligned number).
 */
export const RETEST_AMBUSH_ABOVE_PCT = 0.0075;  // = LIMIT_ABOVE_PCT/100 (doc alignment; price = evaluateRetestV2.limitPrice)
/** FOMO anti-chase cap fraction = structuralLevel × (1 + RETEST_FOMO_ABOVE_PCT). Mirrors trueRetestEngine FOMO_PCT=1.5. */
export const RETEST_FOMO_ABOVE_PCT = 0.015;
/**
 * THE RETEST STOP (risk-critical): the retest is invalidated when price closes back BELOW
 * the broken-support level (zivEngine.ts:76 — stop belongs JUST BELOW retestLevel). We
 * anchor the structural stop at retestLevel × (1 − 1%) and then bound it to wideLungSL so
 * the $-risk can NEVER blow out past the parity cap (we take the TIGHTER / higher of the
 * two for a long — structural-invalidation first, wideLungSL as the never-wider safety
 * floor). See computeRetestStop below.
 */
export const RETEST_STOP_BELOW_PCT = 0.01;      // structural stop = retestLevel × (1 − 1%)
export const RETEST_TOP_N = 10;            // top-10 retests get the Waiter
export const REQUOTE_DRIFT = 0.005;        // R2: re-quote when |freshLimit − resting| / resting > 0.5%
export const WAITER_ROUTE = "GOLD_RETEST_WAR" as const;
export const WAITER_SIGNAL = "GOLD_RETEST_WAITER" as const;
/** R4: max seconds a filled retest may sit before the STP is broker-verified resting. */
export const NAKED_VERIFY_TIMEOUT_MS = 25_000;
/** R4 naked-confirm: how many bounded re-reads of the resting-STP check before deciding. */
export const NAKED_CONFIRM_RETRIES = 3;
/** R4 naked-confirm: short backoff between re-reads (ms). Kept small — reconcile is hot. */
export const NAKED_CONFIRM_BACKOFF_MS = 400;

// ── Flag reader — same shape/source as every other live flag (one source of truth) ──
export function isWaiterEnabled(config: LiveEngineConfig | null | undefined): boolean {
  return ((config as any)?.waiterEnabled ?? 0) === 1;
}

// ── PURE: ambush level (§2.1) — the SSOT evaluateRetestV2.limitPrice, FOMO-aligned ──
/**
 * computeAmbushLimit — THE RETEST FIX (2026-06-30 owner-ratified). The resting LMT price
 * is the SINGLE SSOT `evaluateRetestV2(...).limitPrice` computed once in the war cycle and
 * THREADED here (= structuralLevel × 1.0075, FOMO-capped at structuralLevel × 1.015). This
 * function is now a thin wrapper: it does NOT re-derive a price (no ×1.02), it only applies
 * the live-time guards on the threaded limit. We pass BOTH the threaded `limitPrice` and the
 * structural `level` evaluateRetestV2 used (for the FOMO-cap anti-chase ceiling).
 *
 * Guards (per the DR parameter table):
 *   • FAIL-CLOSED: a null/non-positive limitPrice or level returns 0 → caller SKIPS.
 *   • Penny guard: never rest a sub-$2 order.
 *   • Pullback guard (anti-chase floor): the LMT must be BELOW live (live > limitPrice) —
 *     a retest buys a pullback to support; it never rests AT/ABOVE market.
 *   • FOMO-cap (anti-chase ceiling): place only when live ≤ level × (1 + RETEST_FOMO_ABOVE_PCT)
 *     = level × 1.015. Above the FOMO cap the move is extended → skip (chasing).
 */
export function computeAmbushLimit(
  limitPrice: number | null | undefined,
  structLevel: number | null | undefined,
  livePrice: number,
): { limit: number; reason: string } {
  if (!Number.isFinite(limitPrice as number) || !((limitPrice as number) > 0)) return { limit: 0, reason: "no limitPrice (skip — no SSOT retest)" };
  if (!Number.isFinite(structLevel as number) || !((structLevel as number) > 0)) return { limit: 0, reason: "no structural level (skip)" };
  if (!Number.isFinite(livePrice) || livePrice <= 0) return { limit: 0, reason: "no live price" };
  const raw = +(limitPrice as number).toFixed(2);
  const lvl = structLevel as number;
  if (!(raw > 0)) return { limit: 0, reason: "limit ≤ 0" };
  // Penny guard: never rest a sub-$2 order.
  if (raw < 2) return { limit: 0, reason: `limit $${raw.toFixed(2)} < $2 penny guard` };
  // Pullback guard (anti-chase floor): never rest a buy AT/ABOVE the live price.
  if (!(livePrice > raw)) return { limit: 0, reason: `limit $${raw.toFixed(2)} ≥ live $${livePrice.toFixed(2)} (price not yet pulled back to support)` };
  // FOMO-cap (anti-chase ceiling): the move is too extended above the structural level.
  const fomoCap = +(lvl * (1 + RETEST_FOMO_ABOVE_PCT)).toFixed(2);
  if (livePrice > fomoCap) return { limit: 0, reason: `live $${livePrice.toFixed(2)} > FOMO cap $${fomoCap.toFixed(2)} (level $${lvl.toFixed(2)} × ${(1 + RETEST_FOMO_ABOVE_PCT)}) — too extended` };
  return { limit: raw, reason: `LMT $${raw.toFixed(2)} = evaluateRetestV2.limitPrice (level $${lvl.toFixed(2)}, FOMO cap $${fomoCap.toFixed(2)})` };
}

// ── PURE: structural retest stop (just below the broken-support level) ──────────────
/**
 * computeRetestStop — RISK-CRITICAL. The retest is invalidated when price closes back
 * below the broken-support level (zivEngine.ts:76 — the stop belongs JUST BELOW
 * retestLevel). We anchor the structural stop at retestLevel × (1 − RETEST_STOP_BELOW_PCT)
 * and then bound it by wideLungSL(entry, ema50, "long") so the $-risk can NEVER blow out
 * past the parity cap: for a long we take the HIGHER (tighter) of the two stops, so the
 * structural-invalidation stop applies when it is tighter than wideLungSL, and wideLungSL
 * is the never-wider safety floor when the structural level sits far below entry. Returns
 * 0 (caller skips) on any non-positive/non-finite input or if the bound throws — never
 * pair a live retest order with a garbage stop (never-naked-SL relies on this being sane).
 */
export function computeRetestStop(args: {
  retestLevel: number | null | undefined; entry: number; ema50: number;
}): { stop: number; reason: string } {
  const { retestLevel, entry, ema50 } = args;
  if (!Number.isFinite(retestLevel as number) || !((retestLevel as number) > 0)) return { stop: 0, reason: "no retestLevel" };
  if (!Number.isFinite(entry) || entry <= 0) return { stop: 0, reason: "bad entry" };
  const structStop = +((retestLevel as number) * (1 - RETEST_STOP_BELOW_PCT)).toFixed(2);
  let lungStop: number;
  try { lungStop = +wideLungSL(entry, ema50, "long").toFixed(2); } catch { return { stop: 0, reason: "wideLungSL threw" }; }
  // Long: HIGHER stop = TIGHTER (smaller $-risk). Take the tighter of structural vs lung,
  // but never above entry (a stop ≥ entry would invert risk → fail-closed skip).
  const stop = Math.max(structStop, lungStop);
  if (!(stop > 0) || stop >= entry) return { stop: 0, reason: `stop $${stop.toFixed(2)} ≥ entry $${entry.toFixed(2)} (invalid)` };
  const which = structStop >= lungStop ? "structural (below retest support)" : "wideLungSL floor";
  return { stop, reason: `stop $${stop.toFixed(2)} = ${which} [struct $${structStop.toFixed(2)}, lung $${lungStop.toFixed(2)}]` };
}

// ── PURE: "near its retest zone" (§2 — price approaching the support from above, uptrend) ──
/**
 * isNearRetestZone — THE RETEST FIX. The ambush qualifies only when price is approaching
 * the STRUCTURAL retest level (broken-support) FROM ABOVE in a confirmed uptrend:
 *   • live > retestLevel  (still above the support — a pullback TO it, not a break through)
 *   • live > EMA50        (uptrend not invalidated — the macro long context still holds)
 *   • within a sane band of retestLevel (≤8% above — else the pullback is too far off and
 *     the resting LMT would never fill this session).
 * FAIL-CLOSED on bad inputs / null retestLevel (no ambush). EMA20 is no longer consulted —
 * the qualifying reference is the structural support the price is returning to.
 */
export function isNearRetestZone(args: {
  livePrice: number; retestLevel: number | null | undefined; ema50: number; maxAboveZonePct?: number;
}): { near: boolean; reason: string } {
  const { livePrice, retestLevel, ema50 } = args;
  const maxAbove = args.maxAboveZonePct ?? 0.08; // ≤8% above the support — else the pullback is far off
  if (!(livePrice > 0) || !Number.isFinite(retestLevel as number) || !((retestLevel as number) > 0) || !(ema50 > 0)) {
    return { near: false, reason: "bad inputs / no retestLevel" };
  }
  const lvl = retestLevel as number;
  if (!(livePrice > ema50)) return { near: false, reason: `price < EMA50 — uptrend invalid` };
  if (!(livePrice > lvl)) return { near: false, reason: `price below retest support $${lvl.toFixed(2)} — broke through, not approaching from above` };
  const abovePct = (livePrice - lvl) / lvl;
  if (abovePct > maxAbove) return { near: false, reason: `${(abovePct * 100).toFixed(1)}% above support — pullback too far` };
  return { near: true, reason: `${(abovePct * 100).toFixed(1)}% above retest support $${lvl.toFixed(2)} (uptrend)` };
}

// ── PURE: §4 slot guard ─────────────────────────────────────────────────────────
/**
 * freeRetestSlots — maxRetestSlots − (open retests + resting retest LMTs). A retest row
 * is any isWaiterEntry=1 row that is open OR pending_entry (a resting/pending LMT is a
 * committed slot). Never negative. The caller broadcasts at most this many.
 */
export function freeRetestSlots(
  rows: Array<{ isWaiterEntry?: number | null; status?: string | null }>,
  maxRetestSlots: number,
): number {
  const used = rows.filter((r) =>
    (r.isWaiterEntry ?? 0) === 1 && (r.status === "open" || r.status === "pending_entry")).length;
  return Math.max(0, (maxRetestSlots || 0) - used);
}

// ── PURE: §3 30% sub-cap ──────────────────────────────────────────────────────────
/**
 * retestSleeveUsed — Σ(open-retest market value + resting-retest-LMT notional) for the
 * Waiter rows. Open rows use units × price; resting rows use requestedQty × entryLimit
 * (allocatedCapital carries that notional). A row carries either; we use allocatedCapital
 * (set to qty × limit at place) for both so the sub-cap reflects committed notional.
 */
export function retestSleeveUsed(
  rows: Array<{ isWaiterEntry?: number | null; status?: string | null; allocatedCapital?: number | null; units?: number | null; currentPrice?: number | null; entryPrice?: number | null }>,
): number {
  let sum = 0;
  for (const r of rows) {
    if ((r.isWaiterEntry ?? 0) !== 1) continue;
    if (r.status !== "open" && r.status !== "pending_entry") continue;
    const notional = Number(r.allocatedCapital) > 0
      ? Number(r.allocatedCapital)
      : Math.abs(Number(r.units) || 0) * (Number(r.currentPrice ?? r.entryPrice) || 0);
    sum += notional;
  }
  return sum;
}

/**
 * subCapAllows — the 30%-NLV hard sub-cap (§3). Returns true only when
 * sleeveUsed + thisOrderNotional ≤ waiterNlvPct × NLV. FAIL-CLOSED on bad NLV (no entry).
 */
export function subCapAllows(args: {
  sleeveUsed: number; thisOrderNotional: number; nlv: number; waiterNlvPct: number;
}): { allowed: boolean; capUsd: number; reason: string } {
  const cap = (Number(args.nlv) || 0) * (Number(args.waiterNlvPct) || 0);
  if (!(cap > 0)) return { allowed: false, capUsd: 0, reason: "bad NLV / pct (fail-closed)" };
  const after = args.sleeveUsed + args.thisOrderNotional;
  if (after > cap) {
    return { allowed: false, capUsd: cap, reason: `sleeve $${Math.round(after)} > 30%-cap $${Math.round(cap)}` };
  }
  return { allowed: true, capUsd: cap, reason: `sleeve $${Math.round(after)} ≤ $${Math.round(cap)}` };
}

/**
 * capSharesToMaxPosition — the AUTHORITATIVE per-ticker notional cap (§3b), mirroring
 * liveOrderExecutor.ts:1337-1359. The Waiter transmits via placeRestingBracket (NOT
 * tryLiveEntry), so the executor's maxPositionUsd cap NEVER applied to a resting LMT.
 * A tight retest stop (perShareRisk ≈ 3%) lets vixRiskSize produce a single position
 * ≈34% of NLV; the 30% sleeve only bounds pure-tight cases, leaving a breach window for
 * NLV>~$166k. This clamps the ACTUALLY-transmitted qty so existing + new ≤ maxPositionUsd.
 *
 * existingTickerUsd = Σ|units| (same-ticker open/pending_entry rows) × entry; the floor on
 * the divisor mirrors the executor's $2 penny-guard. cappedShares < 1 ⇒ caller skips.
 */
export function capSharesToMaxPosition(args: {
  sizedShares: number; entry: number; existingTickerUnits: number; maxPositionUsd: number;
}): { cappedShares: number; cappedNotional: number; remainingUsd: number; existingUsd: number; clamped: boolean } {
  const maxPosUsd = Number(args.maxPositionUsd) > 0 ? Number(args.maxPositionUsd) : 50000;
  const entry = Number(args.entry) || 0;
  const existingUsd = Math.abs(Number(args.existingTickerUnits) || 0) * entry;
  const remainingUsd = Math.max(0, maxPosUsd - existingUsd);
  const cappedShares = Math.min(
    Math.max(0, Math.floor(Number(args.sizedShares) || 0)),
    Math.floor(remainingUsd / Math.max(entry, 2)),
  );
  const cappedNotional = +(cappedShares * entry).toFixed(2);
  return { cappedShares, cappedNotional, remainingUsd, existingUsd, clamped: cappedShares < (Number(args.sizedShares) || 0) };
}

// ── PURE: R2 re-quote drift ────────────────────────────────────────────────────────
/**
 * shouldRequote — R2: re-quote when the resting LMT's anchor moves. The anchor is now the
 * STRUCTURAL retest level (republished by the war cycle), so a re-quote fires only when
 * that level shifts: |freshLimit − restingLimit| / restingLimit > REQUOTE_DRIFT. Anti-chase:
 * NEVER re-quote UPWARD past the live price (that would chase the level up). FAIL-CLOSED.
 */
export function shouldRequote(args: {
  restingLimit: number; freshLimit: number; livePrice: number;
}): { requote: boolean; reason: string } {
  const { restingLimit, freshLimit, livePrice } = args;
  if (!(restingLimit > 0) || !(freshLimit > 0)) return { requote: false, reason: "bad limits" };
  const drift = Math.abs(freshLimit - restingLimit) / restingLimit;
  if (drift <= REQUOTE_DRIFT) return { requote: false, reason: `drift ${(drift * 100).toFixed(2)}% ≤ ${(REQUOTE_DRIFT * 100).toFixed(1)}%` };
  // Anti-chase: a fresh limit that has risen to/above the live price would chase up — skip.
  if (freshLimit >= livePrice && freshLimit > restingLimit) {
    return { requote: false, reason: `fresh $${freshLimit.toFixed(2)} ≥ live $${livePrice.toFixed(2)} — anti-chase, no re-quote up` };
  }
  return { requote: true, reason: `drift ${(drift * 100).toFixed(2)}% > ${(REQUOTE_DRIFT * 100).toFixed(1)}% → re-quote $${restingLimit.toFixed(2)}→$${freshLimit.toFixed(2)}` };
}

// ── PURE: §5 falling-knife / setup-invalidation cancel ─────────────────────────────
/**
 * shouldCancelRest — a resting LMT must be cancelled when the setup is dead:
 *   • falling-knife: the last closed 5m RTH bar closed BELOW the structural stop, OR
 *   • setup-invalidation: the name dropped out of the top-N retest list, OR the uptrend
 *     invalidated (live price < EMA-50).
 * Returns the FIRST binding cancel reason (knife → list → trend), or null to keep resting.
 * Pure; the caller supplies the 5m close + the live retest-list membership.
 */
export function shouldCancelRest(args: {
  ticker: string;
  structStop: number;
  last5mClose: number | null;
  livePrice: number;
  ema50: number;
  stillOnRetestList: boolean;
}): { cancel: boolean; reason: string | null } {
  // Falling-knife: a 5m close below the structural stop = the setup is broken.
  if (args.last5mClose != null && args.structStop > 0 && args.last5mClose < args.structStop) {
    return { cancel: true, reason: `KNIFE: 5m close $${args.last5mClose.toFixed(2)} < struct stop $${args.structStop.toFixed(2)}` };
  }
  if (!args.stillOnRetestList) {
    return { cancel: true, reason: "INVALIDATED: dropped off top-N retest list" };
  }
  if (args.ema50 > 0 && args.livePrice > 0 && args.livePrice < args.ema50) {
    return { cancel: true, reason: `INVALIDATED: live $${args.livePrice.toFixed(2)} < EMA50 $${args.ema50.toFixed(2)} (uptrend dead)` };
  }
  return { cancel: false, reason: null };
}

// ── Helpers: EMA from daily bars, last 5m RTH close, RTH-close window ──────────────
async function ema20And50(ticker: string): Promise<{ ema20: number; ema50: number } | null> {
  try {
    const bars = await fetchBarsForTicker(ticker, 120);
    const closes = bars.map((b: any) => Number(b.close) || 0).filter((c: number) => c > 0);
    if (closes.length < 50) return null;
    return { ema20: calcEMA(closes, 20), ema50: calcEMA(closes, 50) };
  } catch {
    return null;
  }
}

async function last5mClose(ticker: string): Promise<number | null> {
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 5 * 86400_000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const bars: IntradayBar[] = await fetchIntradayBarsForTicker(ticker, "5m", fmt(start), fmt(end));
    const rth = filterRegularSession(bars);
    if (!rth.length) return null;
    return rth[rth.length - 1].close;
  } catch {
    return null;
  }
}

/** RTH near-close (Israel time ≥ 22:50) — the DAY-tif EOD cancel window. */
export function isNearRtxClose(now: Date = new Date()): boolean {
  const ilHour = (now.getUTCHours() + 3) % 24;
  const ilMin = now.getUTCMinutes();
  const total = ilHour * 60 + ilMin;
  return total >= 22 * 60 + 50 && total < 23 * 60 + 5;
}

// ── Cancel a resting order (DELETE — same path liveSlTpEnforcement uses) ────────────
async function cancelRestingOrder(orderId: string): Promise<boolean> {
  const paths = [
    `/api/proxy/iserver/account/${LIVE_ACCOUNT_ID}/order/${orderId}`,
    `/iserver/account/${LIVE_ACCOUNT_ID}/order/${orderId}`,
  ];
  for (const path of paths) {
    try {
      const r = await ibindRequest("DELETE", path, undefined, CONFIRM_HEADERS);
      if (r.ok) return true;
      const text = JSON.stringify(r.body ?? "").toLowerCase();
      if (r.status === 404 || text.includes("already") || text.includes("not found") || text.includes("cancel")) return true;
    } catch { /* try next path */ }
  }
  return false;
}

// ── R1: mutual-exclusion helper (called from warEngine under entrySlotLock) ─────────
/**
 * waiterHoldsRetest — true when the Waiter holds an armed/resting LMT (pending_entry) OR
 * an open Waiter position on this ticker. The War cycle MUST skip a GOLD_RETEST_WAR
 * market buy when this is true (one ticker, one pipeline). The caller passes the live
 * livePositions rows (already loaded under the shared lock). Pure; INERT when the caller's
 * flag is off (it only calls this when waiterEnabled=1).
 */
export function waiterHoldsRetest(
  ticker: string,
  rows: Array<{ ticker?: string | null; isWaiterEntry?: number | null; status?: string | null }>,
): boolean {
  const sym = String(ticker).toUpperCase();
  return rows.some((r) =>
    String(r.ticker ?? "").toUpperCase() === sym &&
    (r.isWaiterEntry ?? 0) === 1 &&
    (r.status === "pending_entry" || r.status === "open"));
}

// ── Place a resting LMT-entry bracket (entry LMT + child STP) via /orders/bracket ──
/**
 * placeRestingBracket — the resting LMT entry with its structural STP attached (OCA),
 * DAY tif (no overnight ambush). Reuses the proven /orders/bracket path (it already
 * supports a LMT entry). Returns the entry order id on success. NEVER places a TP here —
 * the Golden ladder TP is computed on FILL by the manage path; the protective STP is the
 * never-naked guard. FAIL-CLOSED on any gateway non-ok.
 */
async function placeRestingBracket(args: {
  ticker: string; conid: number; qty: number; entryLimit: number; stop: number;
}): Promise<{ ok: boolean; orderId: string | null; reason: string }> {
  const { ticker, conid, qty, entryLimit, stop } = args;
  const ocaGroup = `WAITER_OCA_${ticker}_${Date.now()}`;
  const body = {
    conid,
    side: "BUY",
    quantity: qty,
    entryPrice: +entryLimit.toFixed(2),     // resting LMT below market (the ambush)
    stopLoss: +stop.toFixed(2),             // structural wideLungSL child STP
    // No takeProfit: the Golden-ladder TP is armed on fill by the engine's managed path.
    tif: "DAY",                             // DAY — cancel @ RTH close, no overnight rest
    outsideRth: false,
    ocaGroup,
    slOrderType: "STP",
    entryOrderType: "LMT",
  };
  try {
    const res = await ibindRequest("POST", "/orders/bracket", body, CONFIRM_HEADERS);
    if (!res.ok) {
      return { ok: false, orderId: null, reason: `bracket HTTP ${res.status}` };
    }
    const respBody = res.body as any;
    const resultArr: any[] = Array.isArray(respBody?.result) ? respBody.result : [];
    const parent = resultArr.find((r: any) => String(r.local_order_id ?? "").startsWith("BR-P-"))
      ?? resultArr.find((r: any) => r.parent_order_id == null && r.order_id)
      ?? resultArr[0];
    const orderId = parent?.order_id?.toString()
      ?? resultArr.find((r: any) => r.order_id && !r.parent_order_id)?.order_id?.toString()
      ?? respBody?.order_id?.toString()
      ?? null;
    return { ok: true, orderId, reason: "placed" };
  } catch (e: any) {
    return { ok: false, orderId: null, reason: `bracket threw: ${String(e?.message ?? e).slice(0, 60)}` };
  }
}

// ── Load the top-N retest candidates from war_upcoming_signals ─────────────────────
/**
 * RetestCandidate — now carries the STRUCTURAL retest level (broken-support the LMT rests
 * at) + ema50 (the wideLungSL stop floor), threaded from the war cycle's persisted item
 * (warEngine: retestLevel = ziv.retestLevel via invalidationLevel; ema50 = ziv.ema50).
 * A null retestLevel means the war cycle had no structural retest for that name → the
 * Waiter MUST skip it (no EMA20 fallback).
 */
interface RetestCandidate {
  ticker: string; score: number; retestLevel: number | null; ema50: number | null;
  // THE RETEST FIX (SSOT eligibility + price): evaluateRetestV2 outputs persisted by the
  // war cycle. retestValid = the execution-window gate (the Waiter ARMS only when true);
  // retestLimitPrice = the resting LMT price (level×1.0075, FOMO-capped); retestStructLevel
  // = the structural `level` evaluateRetestV2 used (anti-chase FOMO-cap basis).
  retestValid: boolean;
  retestLimitPrice: number | null;
  retestStructLevel: number | null;
}
async function loadRetestCandidates(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
): Promise<RetestCandidate[]> {
  try {
    const [row] = await db.select().from(systemSettings)
      .where(eq(systemSettings.key, "war_upcoming_signals")).limit(1);
    if (!(row as any)?.value) return [];
    const parsed = JSON.parse((row as any).value as string);
    const items: any[] = Array.isArray(parsed?.items) ? parsed.items : [];
    return items
      .filter((it) => String(it.route ?? "").toUpperCase() === WAITER_ROUTE)
      .map((it) => ({
        ticker: String(it.ticker ?? "").toUpperCase(),
        score: Number(it.score ?? 0),
        retestLevel: Number.isFinite(Number(it.retestLevel)) && Number(it.retestLevel) > 0 ? Number(it.retestLevel) : null,
        ema50: Number.isFinite(Number(it.ema50)) && Number(it.ema50) > 0 ? Number(it.ema50) : null,
        retestValid: (it.retestValid ?? false) === true,
        retestLimitPrice: Number.isFinite(Number(it.retestLimitPrice)) && Number(it.retestLimitPrice) > 0 ? Number(it.retestLimitPrice) : null,
        retestStructLevel: Number.isFinite(Number(it.retestStructLevel)) && Number(it.retestStructLevel) > 0 ? Number(it.retestStructLevel) : null,
      }))
      .filter((it) => it.ticker)
      .sort((a, b) => b.score - a.score)
      .slice(0, RETEST_TOP_N);
  } catch {
    return [];
  }
}

// ── R5: structured logs (systemLogs via dbLog) ────────────────────────────────────
function waiterLog(event:
  | "WAITER_ARM" | "WAITER_LMT_PLACED" | "WAITER_FILL" | "WAITER_REQUOTE"
  | "WAITER_CANCEL_KNIFE" | "WAITER_CANCEL_EOD" | "WAITER_CANCEL_INVALID" | "WAITER_NAKED_FLATTEN",
  ticker: string, detail: string): void {
  dbLog("info", "SYSTEM", `[${event}] ${ticker} — ${detail}`);
}

// ── In-process reentrancy + EMA fetch cache (mirror phoenix) ───────────────────────
let _waiterTickRunning = false;

/**
 * runWaiterTick — the unified Waiter tick (place new resting LMTs §2/§3/§4 + manage the
 * resting book §5/§5b R2/R3/R4). INERT-FIRST: reads the flag at the TOP and RETURNS
 * IMMEDIATELY when off (no candidate load, no order, no DB write, no fetch). FAIL-CLOSED
 * throughout. Acquires the shared entrySlotLock for the atomic slot/budget reserve so it
 * never double-fires with the war cycle / Armed-Watcher / Phoenix. Never throws.
 */
export async function runWaiterTick(userId: number): Promise<void> {
  let config: Awaited<ReturnType<typeof getLiveConfig>> = null;
  try {
    config = await getLiveConfig(userId);
  } catch {
    return;
  }
  if (!isWaiterEnabled(config)) return;        // ← THE inert early-return (flag=0 ⇒ no-op)
  if (_waiterTickRunning) return;
  _waiterTickRunning = true;
  try {
    const db = await getDb();
    if (!db) return;

    // ── 1) MANAGE the existing resting/filled Waiter book FIRST (never naked / falling-knife) ──
    await manageWaiterBook(userId, db, config).catch((e) =>
      dbLog("warn", "SYSTEM", `[Waiter] manage error: ${String(e).slice(0, 100)}`));

    // ── 2) PLACE new resting LMTs for fresh retest candidates (slot + 30% sub-cap) ──
    await placeNewRestingLimits(userId, db, config).catch((e) =>
      dbLog("warn", "SYSTEM", `[Waiter] place error: ${String(e).slice(0, 100)}`));
  } catch (e) {
    dbLog("warn", "SYSTEM", `[Waiter] tick error: ${String(e).slice(0, 120)}`);
  } finally {
    _waiterTickRunning = false;
  }
}

// ── §2/§3/§4 — broadcast new resting LMTs (slot-guard + 30% sub-cap, atomic) ────────
async function placeNewRestingLimits(
  userId: number,
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  config: LiveEngineConfig | null | undefined,
): Promise<void> {
  const candidates = await loadRetestCandidates(db);
  if (!candidates.length) return;

  const nlv = Number((config as any)?.totalNlv ?? 0);
  const maxRetestSlots = Number((config as any)?.maxRetestSlots ?? 8);
  const waiterNlvPct = Number((config as any)?.waiterNlvPct ?? 0.30);
  if (!(nlv > 0)) return;                       // no NLV → fail-closed (no sizing basis)

  // Live quotes for the candidate names (broker-truth only).
  let priceMap: Map<string, any>;
  try {
    priceMap = (await fetchIbkrLivePricesBatch(candidates.map((c) => c.ticker))) as any;
  } catch {
    return;
  }
  let vix = NaN;
  try { vix = (await getMarketRegime() as any)?.vixProxy ?? NaN; } catch { vix = NaN; }

  for (const cand of candidates) {
    const sym = cand.ticker;

    // ── OPTION-2 ELIGIBILITY (DR_WAITER_RETEST_ELIGIBILITY.md) ──────────────────────
    // The Waiter ARMS a candidate ONLY when evaluateRetestV2.valid === true (the in-band
    // ±0.5×ATR + 5-close-hold + not-FOMO execution window the war cycle persisted) — NOT
    // the "Gold Retest" tier label. The tier picks the NAME; .valid picks WHEN to arm. A
    // candidate not in the execution window (or missing the SSOT outputs) gets NO LMT.
    if (cand.retestValid !== true) {
      dbLog("info", "SYSTEM", `[Waiter] ${sym} retest not in execution window (evaluateRetestV2.valid=false) — skip`);
      continue;
    }
    if (!(Number(cand.retestLimitPrice) > 0) || !(Number(cand.retestStructLevel) > 0)) {
      dbLog("info", "SYSTEM", `[Waiter] ${sym} no SSOT limitPrice/level — skip (no EMA20 fallback)`);
      continue;
    }

    // Broker-truth live price (never price a live order off stale EOD).
    const lp = priceMap.get(sym) ?? null;
    const live = lp && lp.source === "ibkr" ? Number(lp.price ?? 0) : 0;
    if (!(live > 0)) continue;

    // EMA-50 — the wideLungSL stop floor. Prefer the threaded ema50 (computed in the war
    // cycle from the SAME bars that produced retestLevel); fall back to a fresh fetch only
    // if the war cycle didn't carry it (older persisted payloads). retestLevel is NEVER
    // recomputed here — it is the structural truth from the war cycle.
    let ema50 = Number(cand.ema50) > 0 ? Number(cand.ema50) : 0;
    if (!(ema50 > 0)) {
      const emas = await ema20And50(sym);
      if (!emas) continue;
      ema50 = emas.ema50;
    }

    // The resting LMT price = the SSOT evaluateRetestV2.limitPrice (threaded). Anti-chase
    // (FOMO-aligned): place only when live > limitPrice (a pullback) AND live ≤ structLevel
    // × 1.015 (FOMO cap). Penny guard inside. NO ×1.02 re-derivation.
    const ambush = computeAmbushLimit(cand.retestLimitPrice, cand.retestStructLevel, live);
    if (!(ambush.limit > 0)) {
      dbLog("info", "SYSTEM", `[Waiter] ${sym} anti-chase/penny — ${ambush.reason}`);
      continue;
    }

    // Structural stop JUST BELOW the retest support (invalidation), bounded by wideLungSL
    // (parity safety floor). FAIL-CLOSED — never rest a garbage stop (never-naked-SL). The
    // stop anchors on retestStructLevel (the level the SSOT limitPrice was derived from).
    const stopRes = computeRetestStop({ retestLevel: cand.retestStructLevel, entry: ambush.limit, ema50 });
    if (!(stopRes.stop > 0)) { dbLog("info", "SYSTEM", `[Waiter] ${sym} bad retest stop — ${stopRes.reason}`); continue; }
    const stop = stopRes.stop;

    // 1%-risk sizing — IDENTICAL to Elza (vixRiskSize off the ambush entry + wideLungSL stop).
    const sized = vixRiskSize({ nlv, entry: ambush.limit, stop, vix });
    if (sized.skip || !(sized.shares > 0)) {
      dbLog("info", "SYSTEM", `[Waiter] ${sym} sized-out — ${sized.reason}`);
      continue;
    }
    const thisNotional = +(sized.shares * ambush.limit).toFixed(2);

    // ── ATOMIC slot-guard + 30% sub-cap + shared-BP, UNDER the shared entrySlotLock ──
    if (!tryAcquireEntrySlot(`waiter:${sym}`)) {
      dbLog("info", "SYSTEM", `[Waiter] ${sym} slot lock busy — retry next tick`);
      continue;
    }
    try {
      // Re-read the live book INSIDE the lock (atomicity vs. a concurrent war/phoenix fill).
      const rows = await db.select().from(livePositions)
        .where(and(eq(livePositions.userId, userId),
          inArray(livePositions.status, ["open", "pending_entry"] as any)));

      // R1: a Waiter (or war) pending/open on this ticker already ⇒ skip (one pipeline).
      if (waiterHoldsRetest(sym, rows as any) ||
          (rows as any[]).some((r) => String(r.ticker).toUpperCase() === sym && r.status === "open")) {
        continue;
      }

      // §4 slot guard.
      const free = freeRetestSlots(rows as any, maxRetestSlots);
      if (free <= 0) { dbLog("info", "SYSTEM", `[Waiter] ${sym} no free retest slot (max ${maxRetestSlots})`); continue; }

      // §3 30% sub-cap (within the shared budget).
      const sleeveUsed = retestSleeveUsed(rows as any);
      const sub = subCapAllows({ sleeveUsed, thisOrderNotional: thisNotional, nlv, waiterNlvPct });
      if (!sub.allowed) { dbLog("info", "SYSTEM", `[Waiter] ${sym} 30%-cap blocks — ${sub.reason}`); continue; }

      // §3 shared optimistic-BP check (the SAME ledger the war cycle uses).
      const bp = peekOptimisticBP();
      if (bp != null && thisNotional > bp) {
        dbLog("info", "SYSTEM", `[Waiter] ${sym} shared-BP blocks — planned $${Math.round(thisNotional)} > $${Math.round(bp)}`);
        continue;
      }

      // ── AUTHORITATIVE PER-TICKER NOTIONAL CAP (2026-06-30 concentration fix) ─────
      // The Waiter transmits via placeRestingBracket (NOT tryLiveEntry), so the
      // maxPositionUsd cap in liveOrderExecutor.ts:1337-1359 NEVER applied. Mirror that
      // cap here, on the qty ACTUALLY transmitted, computed INSIDE the entrySlotLock
      // against the SAME fresh same-ticker exposure (`rows`, re-read at ~L570) and the
      // SAME final qty that goes to placeRestingBracket — never the pre-lock sized.shares.
      const maxPosUsd = Number((config as any)?.maxPositionUsd ?? 50000);
      const existingTickerUnits = (rows as any[])
        .filter((r) => String(r.ticker).toUpperCase() === sym)
        .reduce((s, r) => s + Math.abs(Number(r.units) || 0), 0);
      const cap = capSharesToMaxPosition({
        sizedShares: sized.shares, entry: ambush.limit, existingTickerUnits, maxPositionUsd: maxPosUsd,
      });
      const cappedShares = cap.cappedShares;
      // The notional ACTUALLY transmitted (and reserved) — recomputed from the capped qty
      // so the DB insert, the bracket qty and the BP reserve all agree.
      const cappedNotional = cap.cappedNotional;
      if (cappedShares < 1) {
        dbLog("info", "SYSTEM", `[Waiter] ${sym} maxPositionUsd cap — no headroom (existing $${Math.round(cap.existingUsd)} ≥ max $${Math.round(maxPosUsd)})`);
        continue; // entrySlotLock released by the finally — no leak (R1 discipline)
      }
      if (cap.clamped) {
        dbLog("info", "SYSTEM", `[Waiter] ${sym} maxPositionUsd cap — qty ${sized.shares}→${cappedShares} (notional $${Math.round(thisNotional)}→$${Math.round(cappedNotional)}, max $${Math.round(maxPosUsd)})`);
      }

      const conid = await resolveConid(sym);
      if (!conid) { dbLog("info", "SYSTEM", `[Waiter] ${sym} no conid — skip`); continue; }

      waiterLog("WAITER_ARM", sym, `valid retest (live $${live.toFixed(2)}); ${ambush.reason}; stop $${stop.toFixed(2)}; qty ${cappedShares}`);

      // Reserve the slot FIRST (pending_entry row) so a crash mid-order cannot over-broadcast.
      const ts = new Date();
      const inserted = await db.insert(livePositions).values({
        userId,
        ticker: sym,
        direction: "long",
        units: cappedShares,
        requestedQty: cappedShares,
        entryPrice: ambush.limit,
        allocatedCapital: cappedNotional,
        currentSl: +stop.toFixed(2),
        currentTp: 0,
        initialSl: +stop.toFixed(2),
        initialTp: 0,
        status: "pending_entry",
        signal: WAITER_SIGNAL,
        isWaiterEntry: 1,
        countsTowardSlot: 1,
        // THE RETEST FIX: this column records the STRUCTURAL retest level (the
        // evaluateRetestV2 `level` the SSOT limitPrice was derived from — broken-support,
        // NOT EMA-20). It is the re-quote drift basis (R2) and the audit anchor.
        waiterEmaAtPlace: +Number(cand.retestStructLevel).toFixed(4),
        waiterStage: "RESTING",
        openedAt: ts,
      } as any);
      const newId = Number((inserted as any)?.insertId ?? 0) || null;

      // Place the resting LMT bracket (entry LMT + child STP), DAY tif.
      // Transmitted qty == capped qty == DB insert qty (the maxPositionUsd-bounded qty).
      const placed = await placeRestingBracket({ ticker: sym, conid, qty: cappedShares, entryLimit: ambush.limit, stop });
      if (!placed.ok) {
        // Roll back the slot reservation — no resting order exists.
        if (newId) await db.update(livePositions)
          .set({ status: "closed", exitReason: "WAITER_PLACE_FAILED", countsTowardSlot: 0, closedAt: ts } as any)
          .where(eq(livePositions.id, newId));
        dbLog("warn", "SYSTEM", `[Waiter] ${sym} bracket place failed (${placed.reason}) — slot rolled back`);
        continue;
      }

      // Reserve the shared optimistic-BP ledger on TRANSMIT (§3 — the moment it's sent).
      // Use the CAPPED notional (the qty actually transmitted), not the pre-cap notional.
      reserveOptimisticBP(cappedNotional);
      if (newId && placed.orderId) {
        await db.update(livePositions)
          .set({ ibkrEntryOrderId: placed.orderId } as any)
          .where(eq(livePositions.id, newId));
      }
      waiterLog("WAITER_LMT_PLACED", sym, `LMT $${ambush.limit.toFixed(2)} qty ${cappedShares} notional $${Math.round(cappedNotional)} (sleeve ${sub.reason})`);
    } finally {
      releaseEntrySlot(`waiter:${sym}`);
    }
  }
}

// ── §5/§5b — manage the resting + filled Waiter book (ONE manager) ─────────────────
async function manageWaiterBook(
  userId: number,
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  config: LiveEngineConfig | null | undefined,
): Promise<void> {
  const restingRows = await db.select().from(livePositions)
    .where(and(
      eq(livePositions.userId, userId),
      eq(livePositions.status, "pending_entry" as any),
    ));
  const waiterRows = (restingRows as any[]).filter((r) => (r.isWaiterEntry ?? 0) === 1);
  if (!waiterRows.length) return;

  const nearClose = isNearRtxClose();
  const liveList = await loadRetestCandidates(db);
  const onList = new Set(liveList.map((c) => c.ticker));
  // THE RETEST FIX: index the live retest level + ema50 per name (the war cycle's
  // structural truth) so re-quote/invalidation read the SAME anchor the place path used.
  const candBySym = new Map(liveList.map((c) => [c.ticker, c]));

  let priceMap: Map<string, any>;
  try {
    priceMap = (await fetchIbkrLivePricesBatch(waiterRows.map((r) => String(r.ticker).toUpperCase()))) as any;
  } catch {
    priceMap = new Map();
  }

  for (const row of waiterRows) {
    const sym = String(row.ticker).toUpperCase();
    const orderId = row.ibkrEntryOrderId ? String(row.ibkrEntryOrderId) : null;

    // EOD cancel (DAY tif, no overnight ambush).
    if (nearClose) {
      if (orderId) await cancelRestingOrder(orderId);
      await freeRestingRow(db, row, "WAITER_CANCEL_EOD");
      waiterLog("WAITER_CANCEL_EOD", sym, "RTH close — DAY cancel, no overnight rest");
      continue;
    }

    const lp = priceMap.get(sym) ?? null;
    const live = lp && lp.source === "ibkr" ? Number(lp.price ?? 0) : 0;
    if (!(live > 0)) continue;                    // no broker truth → leave resting (fail-closed)

    // EMA-50 for the uptrend-invalidation cancel: prefer the live candidate's threaded
    // ema50, else a fresh fetch (fail-closed if neither available).
    const liveCand = candBySym.get(sym) ?? null;
    let ema50 = Number(liveCand?.ema50) > 0 ? Number(liveCand!.ema50) : 0;
    if (!(ema50 > 0)) {
      const emas = await ema20And50(sym);
      if (!emas) continue;
      ema50 = emas.ema50;
    }

    // Falling-knife / setup-invalidation cancel.
    const c5m = await last5mClose(sym);
    const cancel = shouldCancelRest({
      ticker: sym, structStop: Number(row.initialSl) || 0, last5mClose: c5m,
      livePrice: live, ema50, stillOnRetestList: onList.has(sym),
    });
    if (cancel.cancel) {
      if (orderId) await cancelRestingOrder(orderId);
      await freeRestingRow(db, row, cancel.reason!.startsWith("KNIFE") ? "WAITER_CANCEL_KNIFE" : "WAITER_CANCEL_INVALID");
      waiterLog(cancel.reason!.startsWith("KNIFE") ? "WAITER_CANCEL_KNIFE" : "WAITER_CANCEL_INVALID", sym, cancel.reason!);
      continue;
    }

    // R2 re-quote: the resting LMT anchor is the STRUCTURAL retest level (fixed by the
    // war cycle), NOT EMA-20. Re-quote only when the war cycle republishes a DIFFERENT
    // retest level for this name (>0.5% drift) — a moving structural support — and never
    // chase up past live. A stable structural level ⇒ no re-quote (the LMT just waits).
    const restingLimit = Number(row.entryPrice) || 0;
    // Re-quote basis = the SSOT limitPrice the war cycle republished for this name (FOMO-
    // aligned). Only re-quote a name still in the valid execution window; an invalidated
    // name is cancelled by shouldCancelRest above, not re-quoted.
    const fresh = (liveCand?.retestValid === true)
      ? computeAmbushLimit(liveCand?.retestLimitPrice ?? null, liveCand?.retestStructLevel ?? null, live)
      : { limit: 0, reason: "not in valid execution window" };
    if (fresh.limit > 0 && restingLimit > 0) {
      const rq = shouldRequote({ restingLimit, freshLimit: fresh.limit, livePrice: live });
      if (rq.requote) {
        // Cancel the stale resting order; the next tick re-places at the fresh level (re-quote).
        if (orderId) {
          const ok = await cancelRestingOrder(orderId);
          if (ok) {
            await freeRestingRow(db, row, "WAITER_REQUOTE");
            waiterLog("WAITER_REQUOTE", sym, rq.reason);
          }
        }
        continue;
      }
    }
    // else: leave it resting (waiting for the pullback to support).
  }
}

/**
 * freeRestingRow — close a resting Waiter row (cancelled/re-quoted/EOD) and release its
 * shared-budget reservation. Frees the slot (countsTowardSlot=0) and credits back the
 * reserved optimistic-BP so the bound stays honest. Best-effort.
 */
async function freeRestingRow(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  row: any, exitReason: string,
): Promise<void> {
  try {
    const reserved = Number(row.allocatedCapital) || 0;
    await db.update(livePositions).set({
      status: "closed", exitReason, realizedPnl: 0, countsTowardSlot: 0, closedAt: new Date(),
    } as any).where(eq(livePositions.id, row.id));
    if (reserved > 0) releaseOptimisticBP(reserved);
  } catch { /* best-effort */ }
}

// ── R4 naked-confirmation: gateway-aware classifier + bounded retry (the FALSE-NEGATIVE fix) ──
/**
 * classifyVerifyReason — PURE. Split a `verifyRestingStopAtBe` `!verified` `reason` into:
 *   • "definitive_absent" — a HEALTHY /orders response that genuinely shows no qualifying
 *     STP (the STP truly is not resting). SAFE to flatten on.
 *   • "transient"         — a gateway error (throw / not-ok / 405 / timeout). The STP status
 *     is UNKNOWN — a real broker stop may well be resting; we just can't read it. NEVER
 *     flatten on this (a down gateway is a HALT/alert condition, not a flatten trigger).
 *   • "ok"                — verified true (no classification needed).
 *
 * This is the crux of the R4 hardening: `verifyRestingStopAtBe` collapses TRANSIENT and
 * DEFINITIVE into a single `verified:false`; R4 must NOT. We classify on the reason prefix
 * the verifier emits (its semantics are unchanged — the G1-A ghost path still fail-closes).
 *
 * NOTE: the verifier reports an `res.ok` empty `/orders` body as "no resting STP for ticker"
 * — which LOOKS definitive but can be a known gateway flake. confirmStpAbsentForFlatten()
 * therefore independently re-reads /orders to prove the book is healthy & non-empty before
 * trusting any "absent" verdict.
 */
export function classifyVerifyReason(v: { verified: boolean; reason: string }): "ok" | "transient" | "definitive_absent" {
  if (v.verified) return "ok";
  const r = (v.reason ?? "").toLowerCase();
  // Gateway-error prefixes emitted by verifyRestingStopAtBe → status UNKNOWN.
  if (r.startsWith("orders read threw") || r.startsWith("orders read not-ok") ||
      r.includes("timeout") || r.includes("etimedout") || r.includes("econn")) {
    return "transient";
  }
  // Everything else (no STP / wrong qty / wrong price / no entry) is a healthy-book "absent".
  return "definitive_absent";
}

/**
 * confirmStpAbsentForFlatten — R4-ONLY robust naked-confirmation. Re-reads the resting-STP
 * check up to NAKED_CONFIRM_RETRIES times (short backoff) AND independently confirms the
 * /orders book is HEALTHY (gateway ok) and NON-EMPTY before ever returning "absent".
 *
 * Returns one of:
 *   • "verified"  — a qualifying STP was found on some attempt ⇒ position is protected ⇒ NO flatten.
 *   • "absent"    — every attempt returned a HEALTHY /orders response that consistently shows no
 *                   qualifying STP ⇒ genuinely naked ⇒ FLATTEN.
 *   • "unknown"   — the gateway was unreachable/erroring (or returned an empty book that could be
 *                   a flake) and never produced a clean "STP found" or a healthy non-empty "no STP"
 *                   ⇒ status UNKNOWN ⇒ do NOT blind-flatten (software-SL backstop + alert).
 *
 * NEVER throws. INERT-safe (only called from inside the flag-gated reconcile). `deps` mirror
 * the verifier/test injection: `injectedOrders` (deterministic book) and `injectedSequence`
 * (an array of per-attempt books / "THROW" sentinels) for tests; production passes nothing
 * and we read the live /orders book each attempt.
 */
export async function confirmStpAbsentForFlatten(
  pos: { ticker: string; units: number; direction: string; entryPrice: number },
  deps?: {
    injectedSequence?: Array<any[] | "THROW" | "NOTOK" | null> | null;
    retries?: number;
    backoffMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<{ decision: "verified" | "absent" | "unknown"; reason: string }> {
  const retries = Math.max(1, deps?.retries ?? NAKED_CONFIRM_RETRIES);
  const backoff = Math.max(0, deps?.backoffMs ?? NAKED_CONFIRM_BACKOFF_MS);
  const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const seq = deps?.injectedSequence ?? null;

  let sawHealthyAbsent = false;   // a clean, non-empty /orders response that genuinely lacked the STP
  let lastReason = "no attempts";

  for (let i = 0; i < retries; i++) {
    if (i > 0 && backoff > 0) await sleep(backoff);

    // Resolve THIS attempt's order book: a transient sentinel forces verifyRestingStopAtBe to
    // take its gateway-error path; a real array is a deterministic healthy book; null = live read.
    let attemptOrders: any[] | null | undefined;
    let forcedTransient: string | null = null;
    if (seq) {
      const slot = seq[Math.min(i, seq.length - 1)];
      if (slot === "THROW") { forcedTransient = "orders read threw: injected"; }
      else if (slot === "NOTOK") { forcedTransient = "orders read not-ok (HTTP 405)"; }
      else { attemptOrders = slot; }
    } else {
      attemptOrders = undefined; // production: verifier reads live /orders itself
    }

    let v: { verified: boolean; reason: string };
    try {
      if (forcedTransient) {
        v = { verified: false, reason: forcedTransient };
      } else {
        v = await verifyRestingStopAtBe(pos, attemptOrders ?? null);
      }
    } catch (e: any) {
      // Defensive: verifier is documented never-throw, but treat any throw as transient/unknown.
      v = { verified: false, reason: `orders read threw: ${String(e?.message ?? e).slice(0, 40)}` };
    }

    const cls = classifyVerifyReason(v);
    lastReason = v.reason;
    if (cls === "ok") {
      return { decision: "verified", reason: v.reason };       // STP IS resting → never flatten
    }
    if (cls === "transient") {
      continue;                                                // gateway flake → unknown so far, retry
    }

    // cls === "definitive_absent": independently prove the book is HEALTHY & NON-EMPTY before
    // trusting "absent". An res.ok EMPTY /orders is a known flake → treat as transient/unknown.
    const healthy = await ordersBookHealthyNonEmpty(seq ? attemptOrders ?? null : undefined);
    if (healthy === "healthy_nonempty") {
      sawHealthyAbsent = true;                                 // a real, readable book with no STP
      continue;                                                // confirm it persists across retries
    }
    // empty/unreachable book → cannot trust the "absent" verdict this attempt.
    continue;
  }

  if (sawHealthyAbsent) {
    return { decision: "absent", reason: `STP genuinely absent across ${retries} healthy reads (${lastReason})` };
  }
  return { decision: "unknown", reason: `gateway unknown across ${retries} reads (${lastReason})` };
}

/**
 * ordersBookHealthyNonEmpty — R4 helper. Independently re-reads /orders (or inspects an
 * injected book) and reports whether the gateway returned a HEALTHY, NON-EMPTY order book.
 * "healthy_nonempty" is the ONLY signal we trust to back an "STP absent" flatten decision.
 * An empty book or any gateway non-ok/throw ⇒ "unreachable_or_empty" (status unknown).
 * NEVER throws.
 */
async function ordersBookHealthyNonEmpty(
  injected?: any[] | null,
): Promise<"healthy_nonempty" | "unreachable_or_empty"> {
  try {
    if (injected !== undefined) {
      return Array.isArray(injected) && injected.length > 0 ? "healthy_nonempty" : "unreachable_or_empty";
    }
    const res = await ibindRequest("GET", "/orders");
    if (!res.ok) return "unreachable_or_empty";
    const orders = (res.body as any)?.orders ?? [];
    return Array.isArray(orders) && orders.length > 0 ? "healthy_nonempty" : "unreachable_or_empty";
  } catch {
    return "unreachable_or_empty";
  }
}

// ── T4 / R3 / R4 — fill reconcile (called from ibkrSync; INERT at flag=0) ───────────
/**
 * reconcileWaiterPositions — the resting-LMT lifecycle reconcile. INERT-FIRST: reads the
 * flag and returns before ANY DB read/write when waiterEnabled=0 → ibkrSync byte-identical.
 *
 * When ON, for each Waiter pending_entry row, given the broker's live position qty for that
 * ticker (passed in by ibkrSync, which already holds the /positions + /orders snapshot):
 *   • FILLED (ibkrQty > 0): R3 — bind STP + slot/budget accounting to the ACTUAL filled qty;
 *     flip pending_entry → open, isWaiterEntry stays 1 (it remains a managed retest), then
 *     R4 — re-read /orders (G1-A verifyRestingStopAtBe) to confirm the protective STP rests;
 *     if NOT confirmed within NAKED_VERIFY_TIMEOUT_MS of the fill, FLATTEN + alert (no naked
 *     window). The Golden ladder then manages it via the engine's normal `open` path.
 *   • NOT FILLED + order gone (ibkrQty==0, no working entry order): handled by ibkrSync's
 *     existing pending_entry → ENTRY_CANCELLED close (frees the slot) — we release the
 *     reserved budget here so the shared ledger stays honest.
 *
 * Returns a small summary for ibkrSync's log. Never throws.
 */
export async function reconcileWaiterPositions(
  userId: number,
  brokerQtyByTicker: Map<string, number>,
  deps?: {
    config?: LiveEngineConfig | null;
    db?: Awaited<ReturnType<typeof getDb>>;
    injectedOrders?: any[] | null;
    // R4 test injection: the per-attempt /orders book sequence for the naked-confirm retry.
    injectedNakedSequence?: Array<any[] | "THROW" | "NOTOK" | null> | null;
    nakedConfirm?: typeof confirmStpAbsentForFlatten;
    // R4 test injection: observe/stub the real never-naked flatten transmit (default = real one).
    executeLiveSell?: typeof executeLiveSell;
  },
): Promise<{ filled: number; flattened: number; unknown?: number }> {
  const summary = { filled: 0, flattened: 0, unknown: 0 };
  let config = deps?.config;
  try {
    if (config === undefined) config = await getLiveConfig(userId);
  } catch {
    return summary;
  }
  if (!isWaiterEnabled(config)) return summary;        // ← INERT: ibkrSync byte-identical at flag=0
  try {
    const db = deps?.db ?? (await getDb());
    if (!db) return summary;
    const rows = await db.select().from(livePositions)
      .where(and(
        eq(livePositions.userId, userId),
        eq(livePositions.status, "pending_entry" as any),
      ));
    const waiterRows = (rows as any[]).filter((r) => (r.isWaiterEntry ?? 0) === 1);
    if (!waiterRows.length) return summary;

    for (const row of waiterRows) {
      const sym = String(row.ticker).toUpperCase();
      const ibkrQty = Math.abs(Number(brokerQtyByTicker.get(sym) ?? 0));
      if (ibkrQty <= 0) continue;                       // not filled — ibkrSync handles cancel/expiry

      // ── R3: bind slot/budget to the ACTUAL filled qty (partial leaves a smaller pos). ──
      const reqQty = Math.abs(Number(row.requestedQty ?? row.units ?? 0)) || ibkrQty;
      const entry = Number(row.entryPrice) || 0;
      const filledNotional = +(ibkrQty * entry).toFixed(2);
      const reserved = Number(row.allocatedCapital) || 0;
      // Credit back the over-reserved budget on a partial fill (reserved at requested qty).
      if (ibkrQty < reqQty && reserved > filledNotional) releaseOptimisticBP(reserved - filledNotional);

      await db.update(livePositions).set({
        status: "open",
        units: ibkrQty,
        filledQty: ibkrQty,
        allocatedCapital: filledNotional,
        waiterStage: "FILLED_ARMING",
        fillStatus: ibkrQty < reqQty ? "partial" : "full",
      } as any).where(eq(livePositions.id, row.id));
      summary.filled++;
      waiterLog("WAITER_FILL", sym, `filled ${ibkrQty}/${reqQty} @ ~$${entry.toFixed(2)} → managed (Golden ladder)`);

      // ── BLOCKER-2 — PARTIAL fill guard (never false-positive flatten a protected position). ──
      //    The OCA child STP of the bracket was placed for the FULL requestedQty
      //    (placeRestingBracket); IBKR does NOT auto-resize the child stop to a partial parent
      //    fill. So on a partial fill (ibkrQty < reqQty) verifyRestingStopAtBe sees a qty mismatch
      //    (ghostSlots BE_VERIFY_QTY_SLACK 0.5sh) → skips the real (oversized-but-resting) STP →
      //    "definitive_absent" → reconcile would transmit a REAL flatten of a position that is
      //    actually OVER-protected. That is a false-positive flatten of a healthy, broker-protected
      //    position. A partial fill is UNCERTAINTY, not confirmed-naked — and the oversized resting
      //    STP fully covers the filled shares. So route a partial straight to the UNKNOWN/no-flatten
      //    branch: software-SL backstop + loud alert + summary.unknown, and DO NOT flatten. The next
      //    reconcile re-confirms (by which point the fill may have completed or the stop be resized).
      if (ibkrQty < reqQty) {
        log.error("LIVE_EXEC",
          `[WAITER_NAKED] ${sym} PARTIAL fill ${ibkrQty}/${reqQty}u — child STP was sized for the FULL ${reqQty}u (IBKR does not auto-resize). ` +
          `Treating as UNKNOWN (not naked): NOT flattening — the oversized resting STP still protects the filled shares; software-SL backstop armed, re-confirm next reconcile`,
          { ticker: sym, posId: row.id });
        await db.update(livePositions).set({ waiterStage: "FILLED_ARMING", slProtection: "software", status: "open" } as any)
          .where(eq(livePositions.id, row.id));
        waiterLog("WAITER_NAKED_FLATTEN", sym, `PARTIAL fill ${ibkrQty}/${reqQty}u — NO flatten (oversized STP still protects filled shares), software-SL backstop armed (re-confirm next reconcile)`);
        summary.unknown++;
        continue;
      }

      // ── R4: broker-verify the STP rests for the FILLED qty (G1-A) — GATEWAY-AWARE. ──
      //    The OCA child STP of the bracket should already be resting. A first read MAY come
      //    back `!verified` for two very different reasons:
      //       (1) the STP genuinely is NOT resting (real naked position) → must FLATTEN, OR
      //       (2) a TRANSIENT gateway hiccup (timeout / 405 / empty /orders) on a position
      //           whose STP IS actually resting → a FALSE NEGATIVE.
      //    Blind-flattening on (2) would CLOSE A HEALTHY POSITION that has a real broker stop
      //    we merely could not read — strictly worse than a brief software-SL gap. So R4 runs
      //    a bounded, gateway-aware naked-confirmation (confirmStpAbsentForFlatten): it retries
      //    the resting-STP check and flattens ONLY on a DEFINITIVE absent (healthy, non-empty
      //    /orders consistently showing no qualifying STP). On UNKNOWN (gateway down/empty
      //    across retries) it does NOT flatten — it degrades to software-SL + a loud alert and
      //    leaves the position for the next reconcile. (verifyRestingStopAtBe's own fail-closed
      //    semantics are UNCHANGED — the G1-A ghost path still depends on them.) ──
      const v0 = await verifyRestingStopAtBe(
        { ticker: sym, units: ibkrQty, direction: "long", entryPrice: Number(row.initialSl) || entry },
        deps?.injectedOrders,
      );
      // NOTE: verifyRestingStopAtBe checks the STP is at/through the supplied "BE" price.
      // For a fresh fill the protective stop is BELOW entry (wideLungSL), so we verify a
      // resting STP EXISTS for the filled qty by passing initialSl as the reference floor.
      if (v0.verified) {
        await db.update(livePositions).set({ waiterStage: "MANAGED", slProtection: "ibkr" } as any)
          .where(eq(livePositions.id, row.id));
        continue;
      }

      // First read was not-verified → run the bounded, gateway-aware confirmation before any flatten.
      const confirm = (deps?.nakedConfirm ?? confirmStpAbsentForFlatten);
      const decision = await confirm(
        { ticker: sym, units: ibkrQty, direction: "long", entryPrice: Number(row.initialSl) || entry },
        { injectedSequence: deps?.injectedNakedSequence ?? (deps?.injectedOrders !== undefined ? [deps?.injectedOrders ?? null] : undefined) },
      ).catch((e) => ({ decision: "unknown" as const, reason: `confirm threw: ${String(e).slice(0, 60)}` }));

      const ageMs = Date.now() - (Number(row.openedAt instanceof Date ? row.openedAt.getTime() : Date.parse(String(row.openedAt))) || Date.now());

      if (decision.decision === "verified") {
        // The retry FOUND the resting STP — the first read was a transient false negative. Healthy.
        await db.update(livePositions).set({ waiterStage: "MANAGED", slProtection: "ibkr" } as any)
          .where(eq(livePositions.id, row.id));
        continue;
      }

      if (decision.decision === "unknown") {
        // ── GATEWAY UNKNOWN (false-negative guard): do NOT blind-flatten. The position likely
        //    HAS a real broker STP we just can't read. Degrade to software-SL (SL/TP cron
        //    backstop), keep the loud alert, and leave the row for the next reconcile. A down
        //    gateway is a HALT/alert condition — NOT a flatten trigger. ──
        log.error("LIVE_EXEC",
          `[WAITER_NAKED] ${sym} filled ${ibkrQty}u — STP status UNKNOWN (gateway unreachable: ${decision.reason}). NOT flattening (false-negative guard); software-SL backstop armed, will re-confirm next reconcile`,
          { ticker: sym, posId: row.id, ageMs });
        await db.update(livePositions).set({ waiterStage: "FILLED_ARMING", slProtection: "software", status: "open" } as any)
          .where(eq(livePositions.id, row.id));
        waiterLog("WAITER_NAKED_FLATTEN", sym, `STP status UNKNOWN (${decision.reason}) — NO flatten, software-SL backstop armed (re-confirm next reconcile)`);
        summary.unknown++;
        continue;
      }

      // ── decision === "absent": DEFINITIVE naked (healthy, non-empty /orders, no STP across
      //    retries). A filled retest that genuinely has no protective STP must be CLOSED NOW —
      //    never parked for a cron. TRANSMIT a real flatten of the FILLED qty through the
      //    validated never-naked exit path (executeLiveSell → marketable LMT via
      //    /orders/close-position; cancels the bracket, 1% slip cap, IOC→DAY retry). The row was
      //    flipped to `open` above, so executeLiveSell operates on broker truth (`ibkrQty`).
      //    Idempotent: executeLiveSell flips to pending_exit first, so a re-entrant reconcile
      //    sees `Already pending_exit` and is a no-op. Never throws (wrapped) — on transmit
      //    failure we still leave the loud alert + the SL/TP enforcement CRON as backstop. ──
      log.error("LIVE_EXEC",
        `[WAITER_NAKED] ${sym} filled ${ibkrQty}u but STP DEFINITIVELY absent (${decision.reason}) — FLATTENING now`,
        { ticker: sym, posId: row.id, ageMs });
      let sellOk = false;
      let sellReason = "transmit not attempted";
      const _executeLiveSell = deps?.executeLiveSell ?? executeLiveSell;
      try {
        const sell = await _executeLiveSell({ userId, positionId: row.id, reason: "WAITER_NAKED_FLATTEN" });
        sellOk = sell.success;
        sellReason = sell.reason;
      } catch (sellErr) {
        sellReason = String(sellErr).slice(0, 120);
      }
      summary.flattened++;
      if (sellOk) {
        waiterLog("WAITER_NAKED_FLATTEN", sym, `STP definitively absent (${decision.reason}) — REAL flatten transmitted (${ibkrQty}u)`);
        // executeLiveSell owns the row state (pending_exit → closed on fill). slProtection
        // stays meaningful for any audit; no further mutation needed here.
      } else {
        // Transmit failed (gateway flake / reject). Keep the loud alert + flag software-SL so
        // the SL/TP enforcement CRON retries the protective close on its next pass (backstop,
        // NOT the primary path). The next reconcile tick also re-attempts the flatten.
        waiterLog("WAITER_NAKED_FLATTEN", sym, `STP definitively absent (${decision.reason}) — flatten transmit FAILED (${sellReason}); CRON backstop armed`);
        await db.update(livePositions).set({ waiterStage: "FILLED_ARMING", slProtection: "software", status: "open" } as any)
          .where(eq(livePositions.id, row.id));
      }
    }
  } catch (e) {
    dbLog("warn", "SYSTEM", `[Waiter] reconcile error: ${String(e).slice(0, 120)}`);
  }
  return summary;
}
