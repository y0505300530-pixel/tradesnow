/**
 * intradayArmedWatcher.ts — Intraday Breakout Detection (Armed-Level Watcher).
 *
 * BUILD-spec 2026-06-29 §1 F3. Self-contained timing/detection layer that watches
 * Tier-4 LONG candidates as their live price approaches the prior-day Donchian-20
 * breakout line, and — on a CONFIRMED 5-minute hold above the line with adequate
 * intraday volume — triggers the SAME validated war-engine entry path off-cadence,
 * instead of waiting for the next universe slot.
 *
 * ── THE INERT INVARIANT (non-negotiable) ─────────────────────────────────────────
 * `elzaIntradayWatcherEnabled` defaults to 0. When 0, `runArmedWatcherTick()` reads
 * the flag at the TOP and RETURNS IMMEDIATELY — before any fetch, DB read, or state
 * mutation. Runtime is byte-identical to today. The flag is live-flippable (read per
 * tick), owner-only, and STAYS 0 until the §5 backtest arm-gate passes. Build != arm.
 *
 * ── WHAT THIS MODULE DOES NOT DO ─────────────────────────────────────────────────
 *   • It NEVER sizes a position, computes an SL/TP, or places an order itself.
 *   • It NEVER calls /positions or /orders. The cross-check reuses the already-polled
 *     60s live-quote cache (zero new quote calls). The ONLY new gateway load is the
 *     capped 5m-bar confirm fetch (≤1/ticker/60s, ≤3/tick) on CROSSED candidates.
 *   • On ENTER it routes through `runWarEngineCycle(userId, { manual: true })` — the
 *     SAME path the universe cycle uses, which performs the validated 1%-risk /
 *     wideLungSL sizing, the never-naked SL, the existing duplicate-bracket guard,
 *     and the single `tryLiveEntry` bracket placement. No second order path is created.
 *
 * ── FAIL-CLOSED (non-negotiable) ─────────────────────────────────────────────────
 * If the 5m bars / RVOL inputs are unavailable, stale, throw, or the gateway 503s /
 * session-steals → the candidate does NOT promote and does NOT enter. State stays
 * CROSSED and re-attempts next tick. NEVER "assume confirmed." Mirrors the s===null
 * fail-closed in warEngine.ts.
 *
 * State machine (design §7):
 *   ARMED ─(live ≥ breakLevel)─▶ CROSSED ─(5m close ≥ level & RVOL≥1.2)─▶ HELD_5M ─▶ ENTER
 *     └─(live > breakLevel×1.035)──────────────────────────────────────▶ BLOCKED (anti-chase)
 *     └─(confirm data unavailable)── stays CROSSED, retry next tick (FAIL-CLOSED)
 */

import { getLiveConfig, isIntradayWatcherEnabled, isIntradayWatcherShadow } from "./liveOrderExecutor";
import { shouldDeferEnqueue, drainDecision } from "./warRaceDefer";
import { fetchIbkrLivePricesBatch } from "./marketData";
import { fetchIntradayBarsForTicker, filterRegularSession, type IntradayBar } from "./intradayMarketData";
import { getDb } from "./db";
import { dbLog } from "./persistentLogger";
// SELECTED_TEAM rank priority (SORT-ONLY) — favors team names into the watcher top-N.
// Never touches the state machine, ARM_PROXIMITY, or anti-chase. See server/selectedTeam.ts.
import { getSelectedTeamSet } from "./selectedTeam";

// ── Constants (design Appendix §7 — pinned, backtestable) ────────────────────────
/** breakLevel = donchian20High × BREAK_MULT (the breakout line). */
export const BREAK_MULT = 1.005;
/** Anti-chase ceiling: live > breakLevel × ANTI_CHASE_MULT (~3.5% past) → BLOCKED. (owner 2026-06-30: 2.5%→3.5%) */
export const ANTI_CHASE_MULT = 1.035;
/** ARMED = live within ARM_PROXIMITY below breakLevel. (owner 2026-06-30: 1%→4% — watch ALL names near the line, not just razor-close) */
export const ARM_PROXIMITY = 0.04;
/** Watch the N hottest (by readiness) every tick. (owner 2026-06-30: run on top-10) */
export const WATCHER_TOP_N = 10;
/** Hot-list / confirm minimum intraday RVOL. (owner 2026-06-30: 1.5→1.2 — catch weaker-volume breakouts) */
export const INTRADAY_RVOL_MIN = 1.2;
/** Confirm-fetch caps (rate-budget §4). */
export const CONFIRM_FETCH_TTL_MS = 60_000;     // ≤1 confirm-fetch / ticker / 60s
export const MAX_CONFIRM_FETCHES_PER_TICK = 3;  // ≤N confirm-fetches / tick (global)

export type WatcherState = "ARMED" | "CROSSED" | "HELD_5M" | "BLOCKED";

/** A persisted Tier-4 LONG candidate row the watcher reasons about (from war_upcoming_signals). */
export interface WatcherCandidate {
  ticker: string;
  donchian20High: number;   // prior-day Donchian-20 high (fixed for the day)
  readinessPct: number;     // 0..100 imminence rank
}

// ── PURE helpers (unit-tested; no IO) ────────────────────────────────────────────

/** breakLevel for a candidate = donchian20High × 1.005. 0 when donchian is non-positive. */
export function breakLevelFor(donchian20High: number): number {
  return donchian20High > 0 ? donchian20High * BREAK_MULT : 0;
}

/**
 * classifyCrossState — PURE state classifier from the LIVE cross alone.
 *   live > breakLevel×1.035  → BLOCKED (anti-chase; chased breakout, no entry today)
 *   live ≥ breakLevel        → CROSSED (awaits the 5m-hold + RVOL confirm)
 *   live ≥ breakLevel×(1−4%) → ARMED   (within ARM_PROXIMITY below the line)
 *   otherwise                → null    (not yet armed — not watched)
 * donchian≤0 ⇒ null (cannot define a breakLevel → never armed, never blocked).
 */
export function classifyCrossState(livePrice: number, donchian20High: number): WatcherState | null {
  const lvl = breakLevelFor(donchian20High);
  if (lvl <= 0 || !(livePrice > 0)) return null;
  if (livePrice > lvl * ANTI_CHASE_MULT) return "BLOCKED";
  if (livePrice >= lvl) return "CROSSED";
  if (livePrice >= lvl * (1 - ARM_PROXIMITY)) return "ARMED";
  return null;
}

/**
 * computeIntradayRvol — PURE. intraday_volume_so_far(today) / median(same-time-of-day
 * cumulative volume, trailing sessions). Deterministic so it is backtestable. Bars are
 * regular-session 5m bars across multiple sessions, ascending by ts. Returns null when
 * there is not enough history to form a baseline (→ caller fails closed).
 */
export function computeIntradayRvol(bars: IntradayBar[]): number | null {
  if (!bars.length) return null;
  // Group cumulative volume by session date, keyed by intraday slot (time string).
  const bySession = new Map<string, IntradayBar[]>();
  for (const b of bars) {
    const arr = bySession.get(b.date) ?? [];
    arr.push(b);
    bySession.set(b.date, arr);
  }
  const sessions = [...bySession.keys()].sort();
  if (sessions.length < 2) return null;            // need ≥1 prior session for a baseline
  const today = sessions[sessions.length - 1];
  const todayBars = bySession.get(today)!;
  const lastSlot = todayBars[todayBars.length - 1].time;
  // Cumulative volume up to lastSlot for a given session.
  const cumTo = (sBars: IntradayBar[]): number =>
    sBars.filter(b => b.time <= lastSlot).reduce((s, b) => s + (b.volume || 0), 0);
  const todayCum = cumTo(todayBars);
  if (!(todayCum > 0)) return null;
  const priorCums = sessions
    .slice(0, -1)
    .map(d => cumTo(bySession.get(d)!))
    .filter(v => v > 0)
    .sort((a, b) => a - b);
  if (!priorCums.length) return null;
  const mid = Math.floor(priorCums.length / 2);
  const median = priorCums.length % 2
    ? priorCums[mid]
    : (priorCums[mid - 1] + priorCums[mid]) / 2;
  if (!(median > 0)) return null;
  return todayCum / median;
}

/**
 * is5mHoldConfirmed — PURE. The HOLD_CONFIRM step: the LAST closed 5m bar of the
 * current session closes ≥ breakLevel AND intraday RVOL ≥ INTRADAY_RVOL_MIN.
 * Returns { confirmed, reason }. FAIL-CLOSED: any missing/insufficient input ⇒
 * confirmed=false (never throws into a "true"). breakLevel must be > 0.
 */
export function is5mHoldConfirmed(
  bars: IntradayBar[],
  breakLevel: number,
): { confirmed: boolean; reason: string } {
  if (!(breakLevel > 0)) return { confirmed: false, reason: "no breakLevel" };
  const rth = filterRegularSession(bars);
  if (!rth.length) return { confirmed: false, reason: "no 5m bars" };
  const sessions = [...new Set(rth.map(b => b.date))].sort();
  const today = sessions[sessions.length - 1];
  const todayBars = rth.filter(b => b.date === today);
  if (!todayBars.length) return { confirmed: false, reason: "no session bars" };
  const lastClose = todayBars[todayBars.length - 1].close;
  if (!(lastClose >= breakLevel)) {
    return { confirmed: false, reason: `5m close ${lastClose.toFixed(2)} < level ${breakLevel.toFixed(2)}` };
  }
  const rvol = computeIntradayRvol(rth);
  if (rvol == null) return { confirmed: false, reason: "rvol unavailable" };
  if (rvol < INTRADAY_RVOL_MIN) {
    return { confirmed: false, reason: `rvol ${rvol.toFixed(2)} < ${INTRADAY_RVOL_MIN}` };
  }
  return { confirmed: true, reason: `5m close ${lastClose.toFixed(2)} ≥ ${breakLevel.toFixed(2)}, rvol ${rvol.toFixed(2)}` };
}

/**
 * buildArmList — PURE. From persisted Tier-4 LONG candidates + already-polled live
 * quotes (NO new bars fetch), keep names that are ARMED/CROSSED/BLOCKED (within ≤1%
 * of breakLevel or beyond), ranked by IMMINENCE (readinessPct desc, then proximity).
 * BLOCKED names are surfaced (anti-chase visibility) but never confirm/enter.
 */
export function buildArmList(
  candidates: WatcherCandidate[],
  livePriceByTicker: Map<string, number>,
  selectedTeam: Set<string> = new Set<string>(),
): Array<{ ticker: string; state: WatcherState; livePrice: number; breakLevel: number; readinessPct: number }> {
  const out: Array<{ ticker: string; state: WatcherState; livePrice: number; breakLevel: number; readinessPct: number }> = [];
  for (const c of candidates) {
    const live = livePriceByTicker.get(c.ticker.toUpperCase()) ?? 0;
    const state = classifyCrossState(live, c.donchian20High);
    if (!state) continue;
    out.push({
      ticker: c.ticker.toUpperCase(),
      state,
      livePrice: live,
      breakLevel: breakLevelFor(c.donchian20High),
      readinessPct: c.readinessPct,
    });
  }
  // Imminence rank: readiness desc, then closeness to breakLevel (smaller gap first).
  // SELECTED_TEAM rank priority is SORT-ONLY: a team membership outranks a non-team
  // peer of equal readiness, favoring team names into the top-N. It NEVER changes
  // classifyCrossState (the ARM/CROSS/BLOCKED state machine), ARM_PROXIMITY, or anti-
  // chase — a team name that is BLOCKED stays BLOCKED and never confirms/enters.
  const isTeam = (t: string) => selectedTeam.has(t.toUpperCase());
  out.sort((a, b) => {
    if (b.readinessPct !== a.readinessPct) return b.readinessPct - a.readinessPct;
    const ta = isTeam(a.ticker) ? 1 : 0;
    const tb = isTeam(b.ticker) ? 1 : 0;
    if (tb !== ta) return tb - ta;   // team-member tiebreak (rank-priority, sort-only)
    const gapA = a.breakLevel > 0 ? Math.abs(a.livePrice - a.breakLevel) / a.breakLevel : Infinity;
    const gapB = b.breakLevel > 0 ? Math.abs(b.livePrice - b.breakLevel) / b.breakLevel : Infinity;
    return gapA - gapB;
  });
  return out.slice(0, WATCHER_TOP_N);   // owner 2026-06-30: actively watch only the 10 hottest
}

// ── DISPLAY-ONLY status surface (consumed by F6 liveEngine.getStatus) ────────────
// Per-ticker watcher state for the War Room candidate chip. NEVER gates an order.
// Empty when the flag is 0 (the tick early-returns and never writes), so getStatus
// attaches watcherStatus=null for every candidate → byte-identical display.
const _watcherStatus = new Map<string, Exclude<WatcherState, never> | "HOT_LIST">();
/** Read-only snapshot of the current per-ticker watcher status (DISPLAY-ONLY). */
export function getWatcherStatusMap(): Map<string, string> {
  return new Map(_watcherStatus);
}

// ── Confirm-fetch rate limiter (rate-budget §4) ──────────────────────────────────
const _lastConfirmFetchAt = new Map<string, number>();   // ticker → last 5m-bar fetch epoch ms

// ── In-process state machine memory (per ticker, current process/day) ────────────
const _state = new Map<string, WatcherState>();
// War-race deferred retry (P1d, INERT unless warRaceDeferQueueEnabled=1): a confirmed breakout
// whose entry cycle returned a TRANSIENT block (busy latch / 30s gap) is parked here — it is
// HELD_5M and would NEVER re-fire via the normal path — and re-attempted at the top of later
// ticks until it enters, the cycle terminally declines it, or its TTL expires. Cleared daily.
const _deferredArmed = new Map<string, { breakLevel: number; firstSeenMs: number }>();
let _watcherTickRunning = false;   // module-local reentrancy (separate from F4's _watcherRunning)

/** Israel-time YYYY-MM-DD date key (for the once-daily ARM-state reset). */
function israelDateKey(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "0";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
let _stateDay = "";

/** Read the persisted Tier-4 LONG candidates (war_upcoming_signals). NO new scan/bars. */
async function loadPersistedCandidates(): Promise<WatcherCandidate[]> {
  try {
    const db = await getDb();
    if (!db) return [];
    const { systemSettings } = await import("../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(systemSettings)
      .where(eq(systemSettings.key, "war_upcoming_signals")).limit(1);
    if (!(row as any)?.value) return [];
    const parsed = JSON.parse((row as any).value);
    const items: any[] = parsed?.items ?? [];
    return items
      .filter(it => Number(it?.donchian20High) > 0 && String(it?.direction ?? "long") !== "short")
      .map(it => ({
        ticker: String(it.ticker).toUpperCase(),
        donchian20High: Number(it.donchian20High),
        readinessPct: Number(it.readinessPct ?? 0),
      }));
  } catch {
    return [];
  }
}

/**
 * Fetch ~recent 5m bars for ONE ticker via the shared intraday helper, rate-capped.
 * Returns null on cap-hit / empty / throw → caller FAILS CLOSED (stays CROSSED).
 */
async function fetchConfirmBars(ticker: string): Promise<IntradayBar[] | null> {
  const now = Date.now();
  const last = _lastConfirmFetchAt.get(ticker) ?? 0;
  if (now - last < CONFIRM_FETCH_TTL_MS) return null;   // per-ticker TTL cap
  _lastConfirmFetchAt.set(ticker, now);
  try {
    // ~5 sessions of 5m bars: enough for a same-time-of-day RVOL baseline.
    const end = new Date();
    const start = new Date(end.getTime() - 8 * 86400_000);   // 8 calendar days back
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const bars = await fetchIntradayBarsForTicker(ticker, "5m", fmt(start), fmt(end));
    if (!bars.length) return null;     // empty/stale/503 inside the helper → fail-closed
    return bars;
  } catch {
    return null;                       // throw → fail-closed
  }
}

/**
 * runArmedWatcherTick — the 60–90s tick. INERT-FIRST: reads the flag at the TOP and
 * RETURNS IMMEDIATELY when off (no fetch, no DB read, no state mutation). The reentrancy
 * latch + the market-open guard live in the caller (F4 alertPoller); this function also
 * guards its own reentrancy and never throws into the scheduler.
 */
export async function runArmedWatcherTick(userId: number): Promise<void> {
  // ── INERT GATE — read the flag FIRST, before ANY work. flag=0 ⇒ byte-identical. ──
  let config: Awaited<ReturnType<typeof getLiveConfig>> = null;
  try {
    config = await getLiveConfig(userId);
  } catch {
    return;   // can't read config → do nothing (fail-closed, no work)
  }
  // Three states: LIVE (place real entry) · SHADOW (detect + log would-be entry, NO order)
  // · INERT (flag & shadow both 0 ⇒ byte-identical early-return before any work).
  const liveOn = isIntradayWatcherEnabled(config as any);
  const shadowOn = isIntradayWatcherShadow(config as any);
  // War-race deferred retry gate (INERT unless warRaceDeferQueueEnabled=1) — LIVE mode only
  // (shadow places no order → nothing to retry). At flag=0 the queue is never touched.
  const deferOn = liveOn && (((config as any)?.warRaceDeferQueueEnabled ?? 0) === 1);
  const deferTtlMs = (Number((config as any)?.warRaceDeferTtlSec) || 120) * 1000;
  if (!liveOn && !shadowOn) return;   // ← THE inert early-return

  if (_watcherTickRunning) return;   // never overlap our own tick
  _watcherTickRunning = true;
  try {
    // Daily reset of the in-process state machine memory.
    const day = israelDateKey();
    if (day !== _stateDay) {
      _state.clear();
      _watcherStatus.clear();
      _lastConfirmFetchAt.clear();
      _deferredArmed.clear();
      _stateDay = day;
    }

    // ── War-race deferred retry (INERT unless deferOn): re-attempt transient-blocked breakouts
    //    BEFORE this tick's fresh scan. TTL-bounded; the 30s manual gap naturally serializes so
    //    at most one real cycle runs per tick (the rest stay queued). Fail-closed per entry. ──
    if (deferOn && _deferredArmed.size > 0) {
      const { runWarEngineCycle } = await import("./warEngine");
      for (const [tk, d] of [..._deferredArmed]) {
        if (Date.now() - d.firstSeenMs > deferTtlMs) {
          _deferredArmed.delete(tk);
          dbLog("info", "SYSTEM", `[ArmedWatcher-Defer] ⏱ ${tk} expired (>${(deferTtlMs / 1000).toFixed(0)}s) — dropped, no stale entry`);
          continue;
        }
        try {
          const rr = await runWarEngineCycle(userId, { manual: true, onlyTicker: tk });
          const action = drainDecision(Date.now(), d.firstSeenMs, deferTtlMs, rr.entered, rr.regimeDecision);
          if (action === "success") {
            _deferredArmed.delete(tk);
            dbLog("info", "SYSTEM", `[ArmedWatcher-Defer] ✅ ${tk} entered on retry (recovered a transient-blocked breakout)`);
          } else if (action === "terminal") {
            _deferredArmed.delete(tk);
            dbLog("info", "SYSTEM", `[ArmedWatcher-Defer] ${tk} terminal on retry (${rr.regimeDecision}) — cycle declined, stop retrying`);
          } // "keep" → still transient within TTL → leave queued for next tick
        } catch (e) {
          _deferredArmed.delete(tk);
          dbLog("warn", "SYSTEM", `[ArmedWatcher-Defer] ${tk} retry threw — dropped: ${String(e).slice(0, 60)}`);
        }
      }
    }

    const candidates = await loadPersistedCandidates();
    if (!candidates.length) { _watcherStatus.clear(); return; }

    // Cross-check off the ALREADY-POLLED 60s live-quote cache — zero new quote calls.
    // (skipCache omitted ⇒ served from the tickIbkrSync cache the poller maintains.)
    let priceMap: Map<string, { price: number; source: string } | null>;
    try {
      priceMap = (await fetchIbkrLivePricesBatch(candidates.map(c => c.ticker))) as any;
    } catch {
      return;   // quote read failed → fail-closed, no state change this tick
    }
    const livePriceByTicker = new Map<string, number>();
    for (const c of candidates) {
      const lp = priceMap.get(c.ticker) ?? null;
      // Only IBKR broker-truth prices drive the cross (never a stale yahoo/db print).
      const px = lp && (lp as any).source === "ibkr" ? Number((lp as any).price ?? 0) : 0;
      if (px > 0) livePriceByTicker.set(c.ticker.toUpperCase(), px);
    }

    // SORT-ONLY rank priority: bias selected-team names into the watched top-N. Read
    // is best-effort (fails open to empty → byte-identical ordering) and never throws.
    let _team = new Set<string>();
    try { _team = await getSelectedTeamSet(); } catch { /* sort hint only */ }
    const armed = buildArmList(candidates, livePriceByTicker, _team);
    console.log(`[AW-HB] cands=${candidates.length} priced=${livePriceByTicker.size} armed=${armed.length} states=[${armed.map(a => a.ticker + ":" + a.state).join(",")}]`);

    // Refresh the DISPLAY status map (ARMED/CROSSED/HELD_5M/BLOCKED). HOT_LIST is a
    // hint for high-readiness names that are not yet armed (set by F4's light pass).
    _watcherStatus.clear();

    let confirmFetchesThisTick = 0;
    let enterTicker: string | null = null;
    let enterDetail: { ticker: string; breakLevel: number; reason: string } | null = null;

    for (const a of armed) {
      const prior = _state.get(a.ticker) ?? null;

      // Anti-chase is terminal-for-the-day: once BLOCKED, stay BLOCKED.
      if (prior === "BLOCKED" || a.state === "BLOCKED") {
        _state.set(a.ticker, "BLOCKED");
        _watcherStatus.set(a.ticker, "BLOCKED");
        continue;
      }
      // Already entered/confirmed this name this cycle → leave as HELD_5M (no re-fire).
      if (prior === "HELD_5M") {
        _watcherStatus.set(a.ticker, "HELD_5M");
        continue;
      }

      if (a.state === "ARMED") {
        _state.set(a.ticker, "ARMED");
        _watcherStatus.set(a.ticker, "ARMED");
        continue;
      }

      // a.state === "CROSSED": run the confirm step, capped + FAIL-CLOSED.
      _state.set(a.ticker, "CROSSED");
      _watcherStatus.set(a.ticker, "CROSSED");

      if (enterTicker) continue;   // one ENTER trigger per tick (single bracket discipline)
      if (confirmFetchesThisTick >= MAX_CONFIRM_FETCHES_PER_TICK) continue;   // global cap

      confirmFetchesThisTick++;
      const bars = await fetchConfirmBars(a.ticker);
      if (!bars) {
        // FAIL-CLOSED: cap-hit / empty / stale / throw → stay CROSSED, retry next tick.
        continue;
      }
      const conf = is5mHoldConfirmed(bars, a.breakLevel);
      if (!conf.confirmed) {
        // FAIL-CLOSED: not yet held / low RVOL → stay CROSSED.
        continue;
      }
      // CONFIRMED hold → promote and mark for the single off-cadence entry trigger.
      _state.set(a.ticker, "HELD_5M");
      _watcherStatus.set(a.ticker, "HELD_5M");
      enterTicker = a.ticker;
      enterDetail = { ticker: a.ticker, breakLevel: a.breakLevel, reason: conf.reason };
      dbLog("info", "SYSTEM",
        `[ArmedWatcher] ✅ ${a.ticker} HELD_5M confirmed (${conf.reason}) — ${liveOn ? "triggering war-engine entry cycle" : "SHADOW: logging would-be entry (no order)"}`);
    }

    // ── ENTER: route through the SAME validated war-engine entry path ─────────────
    // No new sizing/stop/order here. runWarEngineCycle re-scores + sizes (1%-risk /
    // wideLungSL), applies every guard (never-naked, ClusterGuard, exposure caps), and
    // fires the SINGLE tryLiveEntry bracket with the existing duplicate-bracket guard.
    // `manual:true` uses the 30s gap (a confirmed cross is a deliberate trigger, like
    // the UI "Run Cycle"); the cycle's own _warRunning latch prevents overlap. The
    // anti-chase gate (F5) re-validates the live price inside that cycle as a backstop.
    if (enterTicker) {
      if (liveOn) {
        try {
          const { runWarEngineCycle } = await import("./warEngine");
          const r = await runWarEngineCycle(userId, { manual: true, onlyTicker: enterTicker });
          dbLog("info", "SYSTEM",
            `[ArmedWatcher] entry cycle for ${enterTicker} → entered=${r.entered} scanned=${r.scanned}`);
          // War-race deferred retry (INERT unless deferOn): a confirmed breakout that hit a
          // TRANSIENT block is HELD_5M now → would NEVER re-fire via the normal path → park it.
          if (shouldDeferEnqueue(deferOn, r.entered, r.regimeDecision) && enterDetail) {
            _deferredArmed.set(enterTicker, { breakLevel: enterDetail.breakLevel, firstSeenMs: Date.now() });
            dbLog("info", "SYSTEM", `[ArmedWatcher-Defer] ⏸ ${enterTicker} transient-blocked (${r.regimeDecision}) — queued for retry (TTL ${(deferTtlMs / 1000).toFixed(0)}s)`);
          }
        } catch (e) {
          dbLog("warn", "SYSTEM", `[ArmedWatcher] entry cycle threw for ${enterTicker}: ${String(e).slice(0, 80)}`);
        }
      } else {
        // SHADOW MODE — record the would-be entry for forward validation. NO sizing, NO
        // order, NO war cycle. This line is the dataset: ticker, the Donchian break level
        // it crossed, and the 5m-hold confirm reason (price + RVOL), stamped at fire time.
        const px = livePriceByTicker.get(enterTicker.toUpperCase()) ?? 0;
        dbLog("info", "SYSTEM",
          `[ArmedWatcher-SHADOW] 👻 would ENTER ${enterTicker} @ ~$${px.toFixed(2)} ` +
          `(break $${(enterDetail?.breakLevel ?? 0).toFixed(2)}; ${enterDetail?.reason ?? ""}) — NO order placed (shadow mode)`);
      }
    }
  } catch (e) {
    // Never let the watcher throw into the scheduler.
    dbLog("warn", "SYSTEM", `[ArmedWatcher] tick error: ${String(e).slice(0, 120)}`);
  } finally {
    _watcherTickRunning = false;
  }
}
