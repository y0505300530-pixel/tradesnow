/**
 * warEngine.ts — TradeSnow2 War Engine v1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Autonomous trading intelligence layer.
 * Sits ON TOP of the existing paperLabEngine cycle and enriches every decision
 * with mentor pattern knowledge + market regime + multi-timeframe confluence.
 *
 * What this does that a human CANNOT:
 *   1. Scans 162 tickers every 5 minutes across LONG + SHORT simultaneously
 *   2. Applies mentor pattern bonus (+0.0 to +2.0) from learned Ziv/Micha patterns
 *   3. Reads market regime (SPY EMA + Vol proxy) before every entry
 *   4. Checks multi-timeframe confluence (daily + weekly aligned)
 *   5. Monitors correlation between open positions — blocks redundant exposure
 *   6. Detects momentum acceleration vs decay on every bar
 *   7. Manages position lifecycle: Add / Reduce / TP / SL autonomously
 *   8. Blocks short entries on BULL regime, blocks long entries on BEAR regime
 *
 * Integration: called from alertPoller.ts checkPeriodicAnalyzeTime()
 * Frequency: every 20 minutes during US market hours (17:00-23:00 Israel)
 */

import { fetchBarsForTicker, fetchIbkrLivePricesBatch } from "./marketData";
import { normalizeBarsForTicker } from "./services/PriceService";
import { calcZivEngineScore, calcEMA } from "./zivEngine";
import { classifyCyclePhaseFromBars } from "./cyclePhaseEngine";
import { classifyWeeklyTrend, evaluateWeeklyGate } from "./weeklyTrend";
import { detectZones, evaluateZoneGate, type EntryStructMeta } from "./zonesEngine";
import { evaluateRetestV2 } from "./trueRetestEngine";
import { computeRiskSizedQty } from "./sizingEngine";
import { confirmVolume } from "./volumeConfirm";
import { runPyramidEngine }    from "./pyramidEngine";
import { calcBearScore } from "./shortEngine";
import { calcEntrySlTp, ema50FromBars, recommendedPositionSize } from "./slCalculator";
import { calcMentorBoost, invalidateMentorPatternCache } from "./mentorScoreBoost";
import { getMarketRegime, getTickerIntelligence, calcCorrelation } from "./runtimeIntelligence";
import { log } from "./logger";
import { tryLiveEntry, getLiveConfig, isLiveMarketOpen, computeLiveCapital, resyncOptimisticBP } from "./liveOrderExecutor";
import { isGhostSlotsEnabled, rowCountsTowardSlot, positionPlannedRiskUsd, onBreakevenConfirmed } from "./ghostSlots";
import { ibindRequest } from "./routers/ibkrProxy";
import { getActiveSnoozedTickerSet } from "./routers/snooze";
import { ibindCached } from "./ibkrCache";
import { placeMarketableLmtClose } from "./liveMarketOrder";
import { getUserAssets, getDb } from "./db";
import { getKronosAddonFromRow, loadKronosConvictionCache, mapKronosAddon, type TradeDir } from "./kronosConvictionJob";
import { isHtbBlocked, htbRemainingMin, markHtb } from "./htbBlocklist";
import { tryAcquireEntrySlot, releaseEntrySlot } from "./entrySlotLock";
// ── Elza v4.5 Golden-DNA SSOT (validated backtest brain). scoreLong is the SAME
// pure scorer the validated backtest drives (parity pinned by
// server/elzaV45ParityProof.test.ts). Used ONLY on the flag=1 entry path. ──
import { scoreLong as elzaScoreLong, genesisScore as elzaGenesisScore, type ElzaIntel as ElzaV45Intel } from "./engine/elzaV45Master";
// ── CV-A/CV-B: the VALIDATED §2 VIX entry guard + 1%-risk × vixMult sizer (SSOT).
// vixRiskSize mirrors scripts/elzaV45GoldenDNA.ts runPortfolio §2 bit-for-bit
// (riskDollars=NLV×0.01×vixMult; shares=floor(riskDollars/(entry−wideLungSL))). vixSizeBand
// is the VIX_BLOCK=35 / VIX_HALF=25 / ×0.70 band. wideLungSL is the SAME stop tryLiveEntry
// pairs the live order with, so the size-basis stop == the broker stop. Wired flag=1 ONLY. ──
import { vixSizeBand, vixRiskSize, wideLungSL as elzaWideLungSL } from "./engine/elzaV45Master";
// ── R2: institutional concentration guards (read-only SSOT import). classifyTicker +
// VOL_CLASS map a ticker → volatility class (SEMIS/CRYPTO/AI_DATA/NUCLEAR/SPACE/OTHER);
// ELZA_V45_CFG carries VOL_CLASS_CAPS {SEMIS:3,CRYPTO:2,AI_DATA:3,NUCLEAR:2,SPACE:2} and
// MAX_PER_SECTOR (3). Wired into the LIVE entry loop ONLY when flag=1. ──
import { classifyTicker, VOL_CLASS, ELZA_V45_CFG, type VolClass } from "./engine/elzaV45Master";
import { paperPositions, mentorPatterns, livePositions, liveEntryLock, liveEngineConfig as liveEngineConfigTable } from "../drizzle/schema"
import { sendTelegramMessage } from "./telegram";;
import { eq, and, gt, lt, inArray } from "drizzle-orm";
import { dbLog } from "./persistentLogger";
import pLimit from "p-limit";

// ─── Constants ────────────────────────────────────────────────────────────────
const WAR_ENGINE_VERSION = "1.1";

/** Minimum war-adjusted score to enter LONG */
const LONG_ENTRY_MIN_SCORE  = 6.8; // Option A (2026-06-25) — lowered 7.5 → 6.8 to admit strong Tier-2 names; 7.5 sat exactly on the ZIV Tier-3 boundary, starving the funnel in flat tapes
/** Minimum war-adjusted score to enter SHORT */
const SHORT_ENTRY_MIN_SCORE = 6.8; // Option A (2026-06-25) — same loosening for shorts (owner trades long AND short)
/** Minimum confluence score for entry */
const MIN_CONFLUENCE        = 5.5; // Option A (2026-06-25) — raised 4.5 → 5.5 so newly-admitted Tier-2 names still need independent confirmation (preserves entry quality)
/** Min relative volume for entry (0 = no filter) */
const MIN_LIQUIDITY_SCORE   = 2.0;
/** Max correlation with existing open positions before blocking entry */
const MAX_CORRELATION       = 0.80;
/** Slots reserved near deleverage window — engine won't open new positions if
 *  (maxPositions - openCount) <= DELEVERAGE_RESERVE_SLOTS and we're within
 *  DELEVERAGE_RESERVE_MINUTES of the cutoff time.  Prevents entering right
 *  before the 22:30 overnight transition forces a close. */
const DELEVERAGE_RESERVE_SLOTS   = 4;
const DELEVERAGE_RESERVE_MINUTES = 40; // block new entries from 21:50 onward

/** Partial TP1: take 33% profit at 1.5R */
const PARTIAL_TP1_R         = 1.5;
/** Partial TP2: take 33% more at 2.5R */
const PARTIAL_TP2_R         = 2.5;
/** Trailing stop from peak for remaining 33% */
const TRAILING_FROM_PEAK    = 0.15; // 15%
/** Dynamic SL: move to break-even when profit > 1.5R */
const BREAKEVEN_TRIGGER_R   = 1.5;
/** Score decay exit: exit LONG if live score drops below this */
const LONG_EXIT_SCORE_MIN   = 3.5;
/** Score decay exit: exit SHORT if live score drops below this */
const SHORT_EXIT_SCORE_MIN  = 3.5;
/** Max positions managed by war engine (in addition to base engine) */
const MAX_WAR_POSITIONS     = 28; // max intraday (x3.9 leverage)

// ─── State ────────────────────────────────────────────────────────────────────
let _warRunning      = false;
let _lastWarCycleAt  = 0;
const WAR_MIN_GAP_MS = 20 * 60 * 1000; // 20-min hard gap between automatic war cycles (ORDER SPAM protection)
const WAR_MANUAL_GAP_MS = 30 * 1000; // 30s gap for UI "Run Cycle" — user can force fresh scan

export interface WarEngineScan {
  ticker:        string;
  direction:     "long" | "short";
  baseScore:     number;
  mentorBonus:   number;
  finalScore:    number;
  /** Structural component = min(ziv/bear + mentor, zivStructuralCap≤7.5). */
  zivStructural?: number;
  /** Kronos conviction addon 0..2.5 (0 when OFF/stale/miss/mismatch). */
  convictionAddon?: number;
  /** combined = min(zivStructural + convictionAddon, 10). Aliased into finalScore. */
  combined?:      number;
  /** True when kronos cache was stale/missing → degraded gate applied. */
  kronosStale?:   boolean;
  confluence:    number;
  liquidity:     number;
  regime:        string;
  mentorReasons: string[];
  action:        "ENTER" | "SKIP" | "BLOCKED";
  blockReason?:  string;
  /** Ziv Phase 1 — weekly structure (WK-L/WK-S/CONSOLIDATION/…) at scan, for the candidates table. */
  weeklyState?:  string;
  /** Ziv Phase 1 — whether EOD price sits inside a directional zone ("in"/"out"). */
  zoneStatus?:   "in" | "out";
  /**
   * RC-2: role-reversed level being retested (broken resistance→support for LONG,
   * broken support→resistance for SHORT). Passed to calcEntrySlTp as the
   * structural invalidation anchor. Null/undefined ⇒ ATR-fallback stop.
   */
  invalidationLevel?: number | null;
  /**
   * THE WAITER (retest resting-LMT): the daily EMA-50 at scan, surfaced so the
   * persisted `war_upcoming_signals` item carries the structural-stop reference
   * (wideLungSL floor) WITHOUT the Waiter re-fetching/re-computing it. Null when
   * unavailable. DISPLAY/Waiter-only — never feeds the war gate or sizing here.
   */
  ema50?: number | null;
  /**
   * Phase-0 anti-chase (BUILD-spec F5): the prior-day Donchian-20 high (Math.max of
   * the last-20 daily-bar highs), fixed for the day. The anti-chase gate in the
   * entry-execution loop reads breakLevel = donchian20High × 1.005 from THIS value —
   * the same persisted level the watcher (F3) consumes. DISPLAY/timing only when the
   * inert watcher flag is 0 (the gate is skipped); never sizes or stops an order.
   */
  donchian20High?: number | null;
}

/**
 * War Room CANDIDATES v4.5 — per-LONG-candidate decision-data surfaced in the
 * `war_upcoming_signals` DISPLAY payload. DISPLAY-ONLY: computed from the SSOT
 * (genesisScore) so every number matches the live engine's real decision; NEVER
 * feeds a gate, sizing or order. See buildV45CandMeta for the exact formulas.
 */
export interface V45CandMeta {
  route: "GOLD_RETEST_WAR" | "GOLD_BREAKOUT_WAR" | null;
  tier: "Gold Retest" | "Gold Breakout" | null;
  score: { base: number; subTotal: number; total: number };
  /** SIGNED % from current price to the trigger. <0 below trigger, ≥0 at/above. */
  distanceToTriggerPct: number;
  /** 0–100 entry readiness (LOW when a hard wall blocks, HIGH when gate-clean + at/above trigger). */
  readinessPct: number;
  /** The SINGLE binding wall (Hebrew-friendly short form), or null when entry-ready. */
  blockReason: string | null;
  /** Cycle-phase (volume-cycle) gate fired against this long. */
  abnormalCycle: boolean;
  /** Macro wall fired: Defense Mode (SPY regime / breadth) OR VIX block. */
  macroBlocked: boolean;
}

/**
 * buildV45CandMeta — pure builder for the War Room v4.5 candidate decision-data.
 * DISPLAY-ONLY. Reuses the deployed SSOT (genesisScore already computed by the
 * caller) so the numbers are bit-identical to the engine's live decision.
 *
 * distanceToTriggerPct (SIGNED, %):
 *   Tier-4 Gold Breakout → trigger = Donchian20High × 0.995 (the breakout line).
 *   Tier-3 Gold Retest   → trigger = EMA-50 (the band the retest gate holds to).
 *   No tier              → fall back to EMA-50 (closest structural reference).
 *   = (price − trigger) / trigger × 100. Negative = below the trigger.
 *
 * readinessPct (0–100, monotonic):
 *   • A HARD wall (macroBlocked / score<7.0 / EMA200 / conf-liq / abnormal cycle)
 *     caps readiness LOW: macro/VIX → 15, score/EMA200/conf-liq → 25, abnormal
 *     cycle → 35 (a transient timing wall, the least terminal). The *binding* (single)
 *     wall is the one reported; readiness reflects the most-blocking cap.
 *   • Otherwise (gate-clean): scale by score-margin over 7.0 and trigger-proximity:
 *       scoreFactor = clamp((total − 7.0) / 3.0, 0, 1)          // 7→0 … 10→1
 *       proxFactor  = clamp(1 + distanceToTriggerPct/5, 0, 1)   // −5%→0, 0%→1, ≥0→1
 *       readiness   = round( 50 + 50 × (0.5·scoreFactor + 0.5·proxFactor) )  // 50..100
 *     i.e. a gate-clean name is ≥50 and reaches 100 only when it is high-score AND
 *     at/above its trigger. Below-trigger names taper down toward 50.
 */
export function buildV45CandMeta(args: {
  price: number;
  tier: "Gold Retest" | "Gold Breakout" | null;
  base: number;
  subTotal: number;
  total: number;
  ema50: number;
  ema200: number;
  donchian20High: number;
  confluence: number;
  liquidity: number;
  abnormalCycle: boolean;
  macroBlocked: boolean;
  macroLabel: string; // "DEFENSE (SPY<EMA50)" | "VIX>35" — which macro wall, when macroBlocked
  minScore: number;
  minConfluence: number;
  minLiquidity: number;
}): V45CandMeta {
  const route =
    args.tier === "Gold Breakout" ? "GOLD_BREAKOUT_WAR" :
    args.tier === "Gold Retest"   ? "GOLD_RETEST_WAR"   : null;

  // ── distance-to-trigger (signed %) ──
  const trigger =
    args.tier === "Gold Breakout"
      ? args.donchian20High * 0.995
      : (args.ema50 > 0 ? args.ema50 : args.price);
  const distanceToTriggerPct =
    trigger > 0 && Number.isFinite(args.price)
      ? +(((args.price - trigger) / trigger) * 100).toFixed(2)
      : 0;

  // ── single binding wall (precedence: macro → score/EMA200 → conf/liq → cycle) ──
  const ema200Pass = args.price > args.ema200 && args.ema200 > 0;
  const scorePass = args.total >= args.minScore;
  const confLiqPass = args.confluence >= args.minConfluence && args.liquidity >= args.minLiquidity;

  let blockReason: string | null = null;
  let cap: number | null = null;
  if (args.macroBlocked) {
    blockReason = args.macroLabel; cap = 15;
  } else if (!scorePass) {
    blockReason = "ציון<7.0"; cap = 25;
  } else if (!ema200Pass) {
    blockReason = "EMA200"; cap = 25;
  } else if (!confLiqPass) {
    blockReason = "conf/liq"; cap = 25;
  } else if (args.abnormalCycle) {
    blockReason = "מחזור חריג (cycle-phase)"; cap = 35;
  }

  let readinessPct: number;
  if (cap != null) {
    readinessPct = cap;
  } else {
    const scoreFactor = Math.max(0, Math.min(1, (args.total - args.minScore) / 3.0));
    const proxFactor = Math.max(0, Math.min(1, 1 + distanceToTriggerPct / 5));
    readinessPct = Math.round(50 + 50 * (0.5 * scoreFactor + 0.5 * proxFactor));
  }

  return {
    route,
    tier: args.tier,
    score: { base: +args.base.toFixed(2), subTotal: +args.subTotal.toFixed(2), total: +args.total.toFixed(2) },
    distanceToTriggerPct,
    readinessPct,
    blockReason,
    abnormalCycle: args.abnormalCycle,
    macroBlocked: args.macroBlocked,
  };
}

/** War Room preview — exclude tickers already held in the same direction. */
export function filterOpenFromUpcoming<T extends { ticker: string; direction: string }>(
  items: T[],
  opts: { heldLong: Set<string>; heldShort: Set<string> },
): T[] {
  return items.filter((item) => {
    const t = item.ticker.toUpperCase();
    return item.direction === "short" ? !opts.heldShort.has(t) : !opts.heldLong.has(t);
  });
}

// ─── R2: institutional concentration guards ─────────────────────────────────────
// Read the inert Elza v4.5 master switch (mirrors liveOrderExecutor.isElzaV45LiveEnabled,
// kept private there). flag=0 (DEFAULT) ⇒ every concentration cap below is skipped and the
// loop behaves byte-identically to today (ClusterGuard-only). The whole R2 block is gated
// on this returning TRUE.
export function isElzaV45LiveEnabled(config: { elzaV45LiveEnabled?: number | null } | null | undefined): boolean {
  return ((config as any)?.elzaV45LiveEnabled ?? 0) === 1;
}

// Read the inert intraday armed-watcher master switch (BUILD-spec F5/§3; mirrors
// liveOrderExecutor.isIntradayWatcherEnabled). flag=0 (DEFAULT) ⇒ the Phase-0
// anti-chase BLOCK in the entry-execution loop is NEVER consulted → entry admission
// byte-identical to today. Pure subtraction when on (BLOCK only; never sizes/widens).
export function isIntradayWatcherEnabled(config: { elzaIntradayWatcherEnabled?: number | null } | null | undefined): boolean {
  return ((config as any)?.elzaIntradayWatcherEnabled ?? 0) === 1;
}

/**
 * antiChaseBlocks — PURE Phase-0 anti-chase decision (BUILD-spec F5). A LONG whose
 * validated live price has run > breakLevel × 1.025 (breakLevel = donchian20High ×
 * 1.005) is a chased breakout → BLOCK. SUBTRACTION-ONLY: returns true only to reject;
 * never sizes/widens. INERT contract: watcherOn=false ⇒ ALWAYS false (no gate → entry
 * admission byte-identical to today). donchian≤0 ⇒ false (cannot define breakLevel).
 */
export function antiChaseBlocks(livePrice: number, donchian20High: number, watcherOn: boolean): boolean {
  if (!watcherOn) return false;
  if (!(donchian20High > 0) || !(livePrice > 0)) return false;
  const breakLevel = donchian20High * 1.005;
  return livePrice > breakLevel * 1.035;  // owner 2026-06-30: anti-chase 2.5%→3.5%
}

/** Per-name hard COUNT caps for the concurrent book. */
export const MAX_PER_SECTOR_CAP = ELZA_V45_CFG.MAX_PER_SECTOR ?? 3;

export interface ConcentrationCapDecision {
  blocked: boolean;
  /** "CorrelationCap" (VOL_CLASS theme cap) | "SectorCap" | "" when allowed. */
  guard: "CorrelationCap" | "SectorCap" | "";
  reason: string;
}

/**
 * concentrationCapBlocks — PURE decision for the R2 theme/sector COUNT caps. Given the
 * candidate ticker + sector and the running tallies of the CONCURRENT book (already-open
 * live positions PLUS candidates accepted earlier in this cycle, keyed by VolClass / sector),
 * decide whether admitting the candidate would breach a hard count cap:
 *   • VOL_CLASS theme cap (correlationCap intent): a 4th SEMIS, 3rd CRYPTO, … → BLOCK
 *     ([CorrelationCap]). VolClass "OTHER" (unmapped) is NEVER theme-capped.
 *   • per-sector cap (MAX_PER_SECTOR=3): a 4th name in the same sector → BLOCK ([SectorCap]).
 * Class cap is checked FIRST (the tighter, more specific concentration risk), then sector.
 * Counts are the CONCURRENT-book counts BEFORE admitting the candidate. Caller increments
 * the tallies only on a successful entry. Direction-agnostic by design — a correlated cluster
 * gaps together whether held long or short.
 */
export function concentrationCapBlocks(
  candidateTicker: string,
  candidateSector: string | undefined,
  openClassCounts: Map<VolClass, number>,
  openSectorCounts: Map<string, number>,
  cfg = ELZA_V45_CFG,
  classMap: Record<string, VolClass> = VOL_CLASS,
): ConcentrationCapDecision {
  const tkr = candidateTicker.toUpperCase();
  // ── Theme (volatility-class) cap ──────────────────────────────────────────────
  const cls = classifyTicker(tkr, classMap);
  if (cls !== "OTHER") {
    const cap = cfg.VOL_CLASS_CAPS[cls];
    const openInClass = openClassCounts.get(cls) ?? 0;
    if (openInClass + 1 > cap) {
      return {
        blocked: true,
        guard: "CorrelationCap",
        reason: `${cls} theme cap ${cap} reached (${openInClass} in book) — reject ${tkr}`,
      };
    }
  }
  // ── Per-sector cap ────────────────────────────────────────────────────────────
  const sectorCap = cfg.MAX_PER_SECTOR ?? MAX_PER_SECTOR_CAP;
  const sec = (candidateSector ?? "").trim();
  if (sec) {
    const openInSector = openSectorCounts.get(sec) ?? 0;
    if (openInSector + 1 > sectorCap) {
      return {
        blocked: true,
        guard: "SectorCap",
        reason: `sector "${sec}" cap ${sectorCap} reached (${openInSector} in book) — reject ${tkr}`,
      };
    }
  }
  return { blocked: false, guard: "", reason: cls === "OTHER" ? `${tkr} OTHER-class — sector-only` : `${tkr} ${cls} within caps` };
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────
export async function runWarEngineCycle(
  userId: number,
  opts?: {
    manual?: boolean;
    scanOnly?: boolean;
    /**
     * Optional progress sink (War Room "Run Cycle" UI). DISPLAY ONLY — purely a
     * pct/Hebrew-phase callback, NEVER consulted for any trading decision. Best-
     * effort: any throw from the callback is swallowed so it can't break a cycle.
     */
    onProgress?: (p: { pct: number; phase: string }) => void,
  },
): Promise<{
  scanned: number;
  entered: number;
  managed: number;
  skipped: number;
  regimeDecision: string;
  topCandidates: WarEngineScan[];
  liveSignals: any[];
}> {
  if (_warRunning) {
    dbLog("info", "SYSTEM", "[WarEngine] Already running — skipping");
    return { scanned: 0, entered: 0, managed: 0, skipped: 0, regimeDecision: "busy", topCandidates: [], liveSignals: [] };
  }
  const minGapMs = opts?.manual ? WAR_MANUAL_GAP_MS : WAR_MIN_GAP_MS;
  if (Date.now() - _lastWarCycleAt < minGapMs) {
    return {
      scanned: 0, entered: 0, managed: 0, skipped: 0,
      regimeDecision: opts?.manual ? "manual_cooldown" : "cooldown",
      topCandidates: [], liveSignals: [],
    };
  }

  // ── ORPHAN-LOCK SWEEP (2026-06-30, post-trauma hardening) ─────────────────
  // The per-ticker liveEntryLock TTL (liveOrderExecutor acquire) is LAZY — a stale lock
  // is only evicted on the NEXT acquire of THAT ticker, so orphans from a prior session
  // (e.g. a halted Friday) accumulate and could shadow a slot. Proactively delete every
  // lock older than the SAME 10-min staleness window at the TOP of each cycle. A real
  // entry never holds a lock 10min (it fills in seconds), so this can ONLY remove orphans
  // — never a live in-flight reservation. Best-effort: never break the cycle.
  try {
    const _lockDb = await getDb();
    if (_lockDb) {
      await _lockDb.delete(liveEntryLock).where(and(
        eq(liveEntryLock.userId, userId),
        lt(liveEntryLock.createdAt, new Date(Date.now() - 10 * 60 * 1000)),
      ));
    }
  } catch (e) {
    dbLog("warn", "SYSTEM", `[WarEngine] orphan-lock sweep failed: ${String(e).slice(0, 60)}`);
  }

  // ── DAILY LOSS CIRCUIT BREAKER (Iron Rule 4 — 2026-06-18) ─────────────────
  // If today's realized losses + commissions exceed the configured limit,
  // disable the engine and send an alert. No new entries will be made.
  try {
    const cbConfig = await getLiveConfig(userId);
    const lossBreakerOn = (cbConfig?.dailyLossEnabled ?? 1) !== 0;
    if (lossBreakerOn) {
      const limitUsd = cbConfig?.dailyLossLimitUsd ?? 2000;
      // Pull today's closed positions P&L from DB
      const db = await getDb();
      if (db) {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayTrades = await db.select().from(livePositions)
          .where(
            and(
              eq(livePositions.userId, userId),
              eq(livePositions.status, "closed"),
              // closedAt >= today midnight
              // Drizzle gte on timestamp
              gt(livePositions.closedAt, todayStart)
            )
          );
        const realizedLoss = todayTrades.reduce((sum, t) => {
          const pnl = t.realizedPnl ?? 0;
          return sum + (pnl < 0 ? Math.abs(pnl) : 0); // only count losses
        }, 0);
        // Also fetch today's IBKR commissions via pnl endpoint
        let todayCommissions = 0;
        try {
          const pnlRes = await ibindRequest("GET", "/pnl");
          if (pnlRes.ok) {
            const pnlData = pnlRes.body as any;
            // daily_pnl is negative if we're down — commissions are embedded
            // We estimate commissions as accruedcash (negative = owed to IB)
            const summaryRes = await ibindRequest("GET", "/account/summary");
            if (summaryRes.ok) {
              const smry = (summaryRes.body as any)?.summary ?? {};
              todayCommissions = Math.abs(smry?.accruedcash?.amount ?? 0);
            }
          }
        } catch {}

        const totalDailyRisk = realizedLoss + todayCommissions;
        if (totalDailyRisk >= limitUsd) {
          dbLog("error", "SYSTEM",
            `[DailyLossBreaker] 🔴 Daily loss limit HIT: $${totalDailyRisk.toFixed(2)} >= limit $${limitUsd} — ENGINE OFF`,
            { context: { realizedLoss, todayCommissions, limitUsd } }
          );
          // Auto-disable engine
          await db.update(liveEngineConfigTable).set({ isEnabled: 0 }).where(eq(liveEngineConfigTable.userId, userId));
          // Telegram push alert
          try {
            const { sendTelegramMessage } = await import("./telegram");
            await sendTelegramMessage(
              `🔴 *DAILY LOSS BREAKER TRIGGERED*\n` +
              `Realized losses: $${realizedLoss.toFixed(2)}\n` +
              `Commissions today: $${todayCommissions.toFixed(2)}\n` +
              `Total: $${totalDailyRisk.toFixed(2)} (limit: $${limitUsd})\n` +
              `Engine automatically set to OFF.`
            );
          } catch {}
          return { scanned: 0, entered: 0, managed: 0, skipped: 0, regimeDecision: "daily_loss_limit_hit", topCandidates: [], liveSignals: [] };
        }
        if (totalDailyRisk >= limitUsd * 0.75) {
          dbLog("warn", "SYSTEM",
            `[DailyLossBreaker] ⚠️ Daily risk at 75%: $${totalDailyRisk.toFixed(2)} / $${limitUsd}`,
            { context: { realizedLoss, todayCommissions, limitUsd } }
          );
        }
      }
    }
  } catch (cbErr: any) {
    dbLog("error", "SYSTEM", `[DailyLossBreaker] check FAILED — FAIL CLOSED: ${cbErr.message}`);
    return { scanned: 0, entered: 0, managed: 0, skipped: 0, regimeDecision: "breaker_check_failed", topCandidates: [], liveSignals: [] };
  }
  // ── END Daily Loss Circuit Breaker ─────────────────────────────────────────

  let entryCapReached = false;  // safety-valve flag (function scope; read by the entry gate below)
  // ── MAX_DAILY_ORDERS HARD CAP (Iron Rule — 2026-06-18) ──────────────────────
  // If the number of IBKR orders submitted today >= MAX_DAILY_ORDERS,
  // cut the engine OFF immediately. Protects against Execution Spam / high-freq loops.
  try {
    // Limit now from DB config (UI-editable), env fallback, default 50. Counts NEW ENTRIES only.
    const capConf = await getLiveConfig(userId);
    const maxDailyOrders = (capConf as any)?.maxDailyOrders ?? parseInt(process.env.MAX_DAILY_ORDERS ?? "50", 10);
    const db2 = await getDb();
    if (db2) {
      const todayMidnight2 = new Date();
      todayMidnight2.setHours(0, 0, 0, 0);
      // Count orders submitted today via liveTrades (each entry = at least 1 bracket order)
      const todayTrades2 = await db2.select({ id: livePositions.id })
        .from(livePositions)
        .where(and(
          eq(livePositions.userId, userId),
          gt(livePositions.openedAt, todayMidnight2)
        ));
      // Each bracket = 3 IBKR orders (entry + SL + TP) — use 3x multiplier
      const ordersEstimate = todayTrades2.length * 1; // SL+TP are bracket — not separate orders
      // ── ALWAYS-ON in-cycle diagnostic: print the exact values the engine is deciding on ──
      dbLog("info", "SYSTEM",
        `[DailyEntryCap] 📊 IN-CYCLE entriesToday=${ordersEstimate} maxDailyOrders=${maxDailyOrders} → ${ordersEstimate >= maxDailyOrders ? "PAUSE new entries (cap reached)" : "entries OPEN"}`,
        { context: { entriesToday: ordersEstimate, maxDailyOrders, willPauseEntries: ordersEstimate >= maxDailyOrders } }
      );
      if (ordersEstimate >= maxDailyOrders) {
        // ── SAFETY VALVE (2026-06-22): PAUSE new entries only — DO NOT disable the engine.
        //    OrderManager / SL-TP management (manageOpenPositions, line ~331) runs normally below.
        //    Auto-resumes next cycle once entries reset (new day) or the UI limit is raised —
        //    because we never set isEnabled=0, every cycle re-evaluates this condition.
        entryCapReached = true;
        dbLog("warn", "SYSTEM",
          `[DailyEntryCap] ⏸ New-entry cap reached: ${ordersEstimate}/${maxDailyOrders} new entries — ENTRIES PAUSED, SL/TP management ACTIVE, engine stays ON`,
          { context: { trades: todayTrades2.length, ordersEstimate, maxDailyOrders } }
        );
      }
      if (ordersEstimate >= maxDailyOrders * 0.70) {
        dbLog("warn", "SYSTEM",
          `[MaxDailyOrders] ⚠️ 70% of daily order cap: ~${ordersEstimate} / ${maxDailyOrders}`,
          { context: { trades: todayTrades2.length, ordersEstimate } }
        );
      }
    }
  } catch (capErr: any) {
    dbLog("error", "SYSTEM", `[MaxDailyOrders] check FAILED — FAIL CLOSED: ${capErr.message}`);
    return { scanned: 0, entered: 0, managed: 0, skipped: 0, regimeDecision: "breaker_check_failed", topCandidates: [], liveSignals: [] };
  }
  // ── END Max Daily Orders Cap ────────────────────────────────────────────────

  _warRunning = true;
  _lastWarCycleAt = Date.now();

  // ── OPTIMISTIC BUYING-POWER LEDGER — reseed from broker truth at cycle start ──
  // Each war cycle starts from broker reality so the optimistic-BP gate (in tryLiveEntry)
  // pre-empts ONLY the margin reject IBKR would already make for THIS batch. FAIL-OPEN:
  // resyncOptimisticBP keeps the last-known-good value on a broker-read failure (never
  // nulls it, never blocks) — so a gateway blip can never freeze legitimate entries, and
  // the FIRST entry after a clean resync is gated against the full broker BP. Best-effort:
  // never let a resync hiccup break the cycle.
  try {
    await resyncOptimisticBP(userId);
  } catch (e) {
    dbLog("warn", "SYSTEM", `[WarEngine] optimistic-BP resync failed (fail-open, last-known-good kept): ${String(e).slice(0, 80)}`);
  }

  // DISPLAY-ONLY progress sink (War Room "Run Cycle" bar). Never feeds any decision.
  const _emit = (pct: number, phase: string) => {
    try { opts?.onProgress?.({ pct, phase }); } catch { /* swallow — never break a cycle */ }
  };

  try {
    _emit(5, "מאתחל מחזור…");
    dbLog("info", "SYSTEM", `[WarEngine v${WAR_ENGINE_VERSION}] 🔫 Cycle START`);

    // ── 1. Market Regime ─────────────────────────────────────────────────────
    // Breadth-aware gate (symmetric-short §1): getMarketRegime folds the persisted
    // PRIOR-cycle breadthPctBelow200 into shortOk/longOk. The owner threshold knob
    // (liveEngineConfig.breadthThreshold, default 0.55) decides when weak breadth
    // turns shorts ON even if SPY reads BULL. The freshly-tallied breadth for THIS
    // cycle is computed in the scan loop and persisted at cycle end (read next cycle).
    const _breadthCfg = await getLiveConfig(userId);
    // Owner knob — reused below as an explicit per-SHORT-entry breadth gate
    // (shorts require weak breadth: breadthPctBelow200 >= breadthThreshold).
    const breadthThreshold = _breadthCfg?.breadthThreshold ?? 0.55;
    _emit(15, "בודק חומות מאקרו…");
    const regime = await getMarketRegime({ breadthThreshold });
    const regimeStr = `${regime.regime} (SPY slope ${regime.spyEmaSlope.toFixed(2)}% | vol ${regime.vixProxy.toFixed(1)}% | breadth ${(regime.breadthPctBelow200 * 100).toFixed(0)}%<200)`;
    dbLog("info", "SYSTEM", `[WarEngine] Regime: ${regimeStr}`);

    // ── Persist the LATEST regime for the War Room display (read by getStatus). ──
    // Display/plumbing only — never feeds any gate/sizing/leverage decision.
    try {
      const _rdb = await getDb();
      if (_rdb) {
        const { systemSettings } = await import("../drizzle/schema");
        const _rval = JSON.stringify({
          regime:    regime.regime,
          spySlope:  +regime.spyEmaSlope.toFixed(2),
          vol:       +regime.vixProxy.toFixed(1),
          longOk:    regime.longOk,
          shortOk:   regime.shortOk,
          computedAt: new Date().toISOString(),
        });
        await _rdb.insert(systemSettings).values({ key: "war_regime", value: _rval } as any)
          .onDuplicateKeyUpdate({ set: { value: _rval } });
      }
    } catch (e) { dbLog("warn", "SYSTEM", `[Regime] persist failed: ${String(e).slice(0,80)}`); }

    // ── 2. Load all tickers + existing open positions ────────────────────────
    const [assets, db] = await Promise.all([
      getUserAssets(userId),
      getDb(),
    ]);
    if (!db || !assets?.length) {
      _warRunning = false;
      return { scanned: 0, entered: 0, managed: 0, skipped: 0, regimeDecision: regimeStr, topCandidates: [], liveSignals: [] };
    }

    // ── Kronos conviction config + cache (read-only; engine NEVER spawns kronos) ──
    // cfgKv carries the 7 tunable knobs. kronosOn=false ⇒ pure-ZIV mode (kill-switch:
    // addon forced 0, gate falls back to zivOnlyFloor — clean total bypass).
    const cfgKv = await getLiveConfig(userId);
    // Match the read-helper threshold (kronosConvictionJob.ts: weight<0.5 snaps to 0).
    // Using >0 here would set kronosOn for a weight in (0,0.5) while the addon is hard-
    // zeroed → combined can never reach the 8.0 gate → the funnel silently freezes.
    const kronosOn = (cfgKv?.kronosConvictionWeight ?? 0) >= 0.5;
    const zivStructuralCap = cfgKv?.zivStructuralCap ?? 7.5;
    const zivStructuralFloor = cfgKv?.zivStructuralFloor ?? 6.5;
    const zivOnlyFloor = cfgKv?.zivOnlyFloor ?? LONG_ENTRY_MIN_SCORE;
    const combinedGate = cfgKv?.combinedGate ?? 8.0;
    // DEPRECATED for gating (2026-06-25): the stale/cold-cache path now reverts to
    // pure ZIV-alone (zivOnlyFloor, no combined-gate) instead of a separate degraded
    // gate, so a kronos outage can never be MORE restrictive than legacy. Kept as a
    // belt-and-suspenders default only; not consulted in the entry gates anymore.
    const degradedGate = cfgKv?.degradedGate ?? zivOnlyFloor;
    void degradedGate;
    // ── Gold Breakout kill-switch (2026-06-26, owner-disabled RC-1) ─────────────
    // Default OFF (column default 0 → live row gets 0 on ALTER ADD). When OFF, a LONG
    // candidate whose qualifying ZIV tier is "Gold Breakout" (the fresh ≥20-day Donchian
    // breakout top tier) is forced to SKIP in the long gate chain BEFORE it can reach
    // ENTER — it never sizes, never places. It stays in the funnel as a SKIP so the owner
    // sees it being held, and can still enter later via the confirmed Gold Retest tier.
    const goldBreakoutEnabled = (cfgKv?.goldBreakoutEnabled ?? 0) === 1;
    // ── Bear Breakdown kill-switch (2026-06-26, symmetric-short §3) ──────────────
    // The SHORT mirror of goldBreakoutEnabled. Default OFF (column default 0). When
    // OFF, a SHORT candidate whose qualifying tier is "Bear Breakdown" (the fresh
    // ≥20-day Donchian-LOW breakdown top tier) is forced to SKIP in the short gate
    // chain BEFORE it can ENTER — chasing extended breakdowns is the short-side
    // equivalent of the #1 long stop-out cause. It may still enter via Bear Retest.
    const bearBreakdownEnabled = (cfgKv?.bearBreakdownEnabled ?? 0) === 1;
    // ── Ziv Phase 1 gates (2026-06-26) — OFF by default = byte-identical to today ──
    // weeklyAnchorEnabled: HARD weekly gate (WK-L long / WK-S short), ADDITIONAL to the
    // legacy !intel.weeklyAligned clause. zonesGateEnabled: entry must sit at a qualifying
    // demand/supply zone. Both flag-guarded; when 0 the new clauses are unreachable.
    const weeklyAnchorEnabled = (cfgKv?.weeklyAnchorEnabled ?? 0) === 1;
    const zonesGateEnabled    = (cfgKv?.zonesGateEnabled ?? 0) === 1;
    // Ziv Phase 2 — structural retest gate (±0.5×ATR band + 5-close hold). OFF = legacy ±2% path.
    const retestV2Enabled     = (cfgKv?.retestV2Enabled ?? 0) === 1;
    // Ziv Phase 3 — 1%-risk sizing + portfolio-heat cap. OFF = legacy fixed-capital sizing.
    const riskSizingEnabled   = (cfgKv?.riskSizingEnabled ?? 0) === 1;
    const heatMaxPctCfg       = Number(cfgKv?.heatMaxPct ?? 0.07) || 0.07;
    // Ziv Phase 4 — a breakout/breakdown may ENTER only if volume-confirmed (נמ"ס). OFF = stays SKIP.
    const volumeConfirmEnabled = (cfgKv?.volumeConfirmEnabled ?? 0) === 1;
    // Ziv Phase 5 — structural TP (next opposing zone) on the entry bracket. OFF = legacy R-multiple TP.
    const structuralExitsEnabled = (cfgKv?.structuralExitsEnabled ?? 0) === 1;
    // Cycle-phase gate toggle — default 1 (ON, today's behavior); 0 = bypass (owner loosening lever).
    const cyclePhaseGateEnabled = (cfgKv?.cyclePhaseGateEnabled ?? 1) === 1;
    // Pre-load the whole asset universe's cache rows in ONE query (read helper is
    // pure thereafter — no per-ticker DB hits inside the scan loop). Empty map on
    // failure so a cache outage degrades gracefully (every name reads as stale).
    const kronosCache = kronosOn
      ? await loadKronosConvictionCache(assets.map((a) => a.ticker))
      : new Map();

    // WarEngine tracks ONLY its own live positions (not paperLab positions)
    // V2.00: exclude frozen + pending_halt positions from engine scan
    const { inArray: inArr } = await import("drizzle-orm");
    // ELZA 2.0 QA fix: count `zombie` positions as REAL exposure. A zombie is a
    // position IBKR still holds but the DB couldn't confirm — it occupies capital,
    // a sector slot and correlation risk. Including it in the EXPOSURE set stops the
    // engine from over-entering while it (wrongly) thinks it is flat. Management still
    // runs on confirmed `open` only (we never try to manage an unconfirmed zombie).
    const openPositions = await db
      .select()
      .from(livePositions)
      .where(and(
        eq(livePositions.userId, userId),
        inArr(livePositions.status, ["open", "zombie"] as any[]),
      ));
    // Ziv Phase 3 — aggregate open risk ($ at stake if every current stop hits), for the heat cap.
    // G1-C: a ghosted row (broker-verified BE stop) contributes 0 planned risk. INERT when
    // ghostSlotsEnabled=0 — positionPlannedRiskUsd then returns the legacy |entry−SL|×units
    // for every row → byte-identical to today.
    const _ghostOn = isGhostSlotsEnabled(cfgKv as any);
    const zivOpenHeatUsd = openPositions.reduce((s: number, p: any) =>
      s + positionPlannedRiskUsd(p, _ghostOn), 0);
    // Management set: confirmed-open only (exclude zombie / frozen / pending_halt).
    const activePositions = openPositions.filter(
      (p: any) => p.status === "open" && !p.corporateActionFrozen && !p.pendingHalt
    );

    // ── Pre-scan: fetch IBKR live tickers to prevent duplicate entries ────────
    // (DB may lag behind IBKR — any ticker in IBKR is treated as already open)
    // Also includes tickers with open IBKR orders (Submitted/PreSubmitted) to prevent
    // re-entry when a bracket was placed but not yet filled (IOC/LMT pending) — BUG FIX 2026-06-24
    const ibkrPreTickers = new Set<string>();
    try {
      const { ibindCached: ibindCachedPre } = await import("./ibkrCache");
      // 1. Positions with non-zero quantity
      const prePos = await ibindCachedPre("GET", "/positions");
      if (prePos.ok) {
        const prePosArr: any[] = (prePos.body as any)?.positions ?? [];
        for (const p of prePosArr) {
          if (p.position !== 0) {
            ibkrPreTickers.add((p.contractDesc ?? p.ticker ?? "").toUpperCase());
          }
        }
      }
      // 2. Open orders (Submitted/PreSubmitted) — prevents duplicate bracket on unfilled LMT
      const preOrds = await ibindCachedPre("GET", "/orders");
      if (preOrds.ok) {
        const preOrdsArr: any[] = (preOrds.body as any)?.orders ?? [];
        for (const o of preOrdsArr) {
          if (["PreSubmitted", "Submitted", "Working"].includes(o.status ?? "")) {
            const ordTicker = (o.description1 ?? o.ticker ?? "").toUpperCase();
            if (ordTicker) ibkrPreTickers.add(ordTicker);
          }
        }
      }
    } catch {}
        // SignalPersistence REMOVED — no re-entry blocking by direction
    const closedLongToday  = new Set<string>();
    const closedShortToday = new Set<string>();
    

    // openTickerSet/correlation/short-dup use the EXPOSURE set (open + zombie) so the
    // gates are not blind to unconfirmed IBKR holdings. (+ IBKR pre-fill tickers.)
    // pending_entry rows block duplicate brackets even if IBKR order poll lags
    const pendingEntryRows = await db
      .select({ ticker: livePositions.ticker })
      .from(livePositions)
      .where(and(eq(livePositions.userId, userId), eq(livePositions.status, "pending_entry" as any)));
    const openTickerSet = new Set([
      ...openPositions.map(p => p.ticker.toUpperCase()),
      ...pendingEntryRows.map(p => p.ticker.toUpperCase()),
      ...ibkrPreTickers,
    ]);
    // No direction-based re-entry blocking
    const longBlockedTickers  = new Set<string>(); // was closedLongToday — REMOVED
    const shortOpenTickers = new Set<string>([
      ...openPositions.filter(p => p.direction === "short").map(p => p.ticker.toUpperCase()),
    ]);

    // Build close series map for correlation checks (exposure set incl. zombies)
    const openCloseMap = new Map<string, number[]>();
    // LEVER 4(b) — SHORT correlation gate: a short must not pile onto the open
    // SHORT book (mirror of the LONG correlation set, filtered to shorts only).
    // Correlating a new short against LONG closes would be wrong — opposite
    // exposure is a hedge, not redundancy — so this set is short-direction-only.
    const shortOpenCloseMap = new Map<string, number[]>();
    // Ziv Phase 1: per-cycle cache of weekly-trend + zones, one compute per ticker.
    // Lives for the cycle only (rebuilt next cycle → fresh data, no stale-zone risk).
    const zivP1Cache = new Map<string, { wt: ReturnType<typeof classifyWeeklyTrend>; zones: ReturnType<typeof detectZones> }>();
    // Ziv Phase 1 measurement — emit a structured per-entry snapshot for offline
    // win-rate/expectancy attribution (route × weekly-state × zone). Best-effort, never
    // throws. NOTE: persisted to logs in Phase 1; DB-column wiring deferred (livePositions
    // rows are created by tryLiveEntry/sync, not at a warEngine insert — see Phase-1 notes).
    // Builds the per-entry structural snapshot, LOGS it, and RETURNS the JSON string so the
    // caller can persist it on the livePositions row (ledger-fix: route-attributed closes).
    const logZivMeta = (tkr: string, dir: "long" | "short", price: number, route: string): string | null => {
      try {
        const _zp1 = zivP1Cache.get(tkr);
        const _zg = _zp1 ? evaluateZoneGate(_zp1.zones, price, dir) : null;
        const _m: EntryStructMeta = {
          route,
          gatesActive: { zones: zonesGateEnabled, weeklyAnchor: weeklyAnchorEnabled },
          zone: _zg?.zone ? { kind: _zg.zone.kind, low: _zg.zone.low, high: _zg.zone.high, touches: _zg.zone.touches, strength: _zg.zone.strength, source: _zg.zone.source } : null,
          weekly: _zp1 ? { direction: _zp1.wt.direction, structure: _zp1.wt.structure, slopePct: _zp1.wt.weeklySlopePct, lastSwingLow: _zp1.wt.lastSwingLow, lastSwingHigh: _zp1.wt.lastSwingHigh } : null,
          priceAtEntry: price,
          distToZonePct: _zg?.distPct ?? null,
        };
        const _json = JSON.stringify(_m);
        dbLog("info", "SYSTEM", `[ZivMeta] ${_json}`);
        return _json;
      } catch { /* measurement is best-effort — never block an entry */ return null; }
    };
    const shortOpenTickerUpper = new Set(
      openPositions.filter(p => p.direction === "short").map(p => p.ticker.toUpperCase()),
    );
    for (const op of openPositions) {
      try {
        const b = await fetchBarsForTicker(op.ticker, 35);
        const closes = b.map(x => x.close);
        openCloseMap.set(op.ticker, closes);
        if (shortOpenTickerUpper.has(op.ticker.toUpperCase())) {
          shortOpenCloseMap.set(op.ticker, closes);
        }
      } catch { /* skip */ }
    }

    // ── 3. Manage existing positions (TP / SL / Add / Reduce) ───────────────
    _emit(30, "בודק סטופים…");
    let managed = 0;
    managed += await manageOpenPositions(userId, activePositions, db, cfgKv as any);

    // ── Pyramid Engine: scale into winning positions ─────────────────────────
    try {
      const pyramidAdds = await runPyramidEngine(userId);
      if (pyramidAdds > 0) managed += pyramidAdds;
    } catch (pe) {
      log.warn("PYRAMID", `[PyramidEngine] Uncaught: ${String(pe).slice(0, 100)}`);
    }

    // ── 4. Scan for new entries ──────────────────────────────────────────────
    // BUG #2 — Snooze/Ignore: drop ACTIVE-snoozed tickers from the entry scan. SAFETY: this filters
    // ONLY the candidate-scan universe (scoring + candidate cache + entry). Exit management ran in
    // section 3 ABOVE (manageOpenPositions + pyramid) and NEVER consults this set — a snoozed-but-HELD
    // position is still fully exit-managed (SL/TP/Golden/never-naked).
    const snoozedSet = await getActiveSnoozedTickerSet(userId);
    const tickers = entryCapReached ? [] : assets
      .filter(a => !a.ticker.toUpperCase().endsWith(".TA")) // US only for now
      .filter(a => (a as { catalogStatus?: string | null }).catalogStatus !== "IPO_INCUBATOR")
      .filter(a => !snoozedSet.has(a.ticker.toUpperCase())) // BUG #2: snoozed tickers are not scored / entered / cached as candidates
      .map(a => ({ ticker: a.ticker.toUpperCase(), mentorSources: (a as any).mentorSources ?? undefined }));

    let scanned = 0, entered = 0, skipped = 0;
    // ── Participation breadth tally (symmetric-short §1.2) ──────────────────────
    // % of the scanned universe trading below its OWN EMA-200, reusing the bars the
    // loop already fetches (zero extra data). Persisted at cycle end; read by the
    // NEXT cycle's getMarketRegime to drive the breadth-aware shortOk gate.
    let breadthBelow200Count = 0, breadthScored = 0;
    const allScans: WarEngineScan[] = [];
    const enteredLongThisCycle  = new Set<string>();
    const enteredShortThisCycle = new Set<string>();

    // ── War Room CANDIDATES v4.5 — per-LONG-candidate decision-data cache ─────────
    // Populated INSIDE the LONG scan loop (where bars/genesisScore/cyc/regime/intel
    // are in scope) and merged into the `war_upcoming_signals` DISPLAY payload at
    // persist time. DISPLAY-ONLY: nothing here feeds any gate, sizing or order path.
    // Every number is the SSOT engine's real decision (genesisScore + the gate walls),
    // so the War Room matches what the live engine would actually do. Shorts are NOT
    // cached (LONG-ONLY display); short POSITION MANAGEMENT is untouched.
    const v45CandCache = new Map<string, V45CandMeta>();

    // Scan spans the 35→80% band of the progress bar (the bulk of the work).
    _emit(35, "סורק מועמדים…");
    const _scanTotal = Math.max(1, tickers.length);
    let _scanIdx = 0;
    for (const { ticker, mentorSources } of tickers) {
      // DISPLAY-ONLY: map scan position into the 35→80% band (throttle to ~every 10 names).
      _scanIdx++;
      if (_scanIdx % 10 === 0) {
        _emit(35 + Math.round((_scanIdx / _scanTotal) * 45), "סורק מועמדים…");
      }
      try {
        // Fetch bars (shared for both LONG + SHORT scoring)
        const bars = await fetchBarsForTicker(ticker, 420);
        if (bars.length < 50) { skipped++; continue; }
        scanned++;

        // ── Participation-breadth tally (§1.2): is THIS name below its EMA-200? ──
        // Reuses the bars just fetched. Aggregated → breadthPctBelow200 at cycle end.
        try {
          const _bc = bars.map(b => b.close);
          const _ema200 = _bc.length >= 200 ? calcEMA(_bc, 200) : calcEMA(_bc, _bc.length);
          const _last = _bc[_bc.length - 1];
          if (_ema200 > 0 && _last > 0) {
            breadthScored++;
            if (_last < _ema200) breadthBelow200Count++;
          }
        } catch {}

        // ELZA 2.0 P0 — Volume-cycle gate (Ziv §3.2). Computed once per ticker;
        // CYC-L1 blocks longs (rise on low volume = false breakout), CYC-S1 blocks
        // shorts (drop on high volume = bear trap). null = insufficient history → no gate.
        const cyc = classifyCyclePhaseFromBars(bars);

        // ── Ziv Phase 1 — weekly trend + zones, once per ticker (reuses `bars`) ──────
        // Computed unconditionally (pure, O(n)) so the measurement snapshot always has
        // weekly context, even with both gates OFF. The GATES below are flag-guarded.
        const wt    = classifyWeeklyTrend(bars);
        const zones = detectZones(bars, { trend: wt.direction === "down" ? "down" : "up" });
        zivP1Cache.set(ticker, { wt, zones });

        // ── LONG scan ──────────────────────────────────────────────────────
        if (regime.longOk) {
          const ziv     = calcZivEngineScore(bars);
          // Phase 1: pull confidence score from most recent analysis for this ticker
          const tickerAssetConf = assets.find(a => a.ticker.toUpperCase() === ticker) as any;
          const confScore: number | undefined = tickerAssetConf?.score ?? undefined;
          const signalBias: string | undefined = tickerAssetConf?.signalBias ?? undefined;
          const boost   = await calcMentorBoost(userId, ticker, ziv.tier, mentorSources, confScore);
          // ── Kronos combined scoring (ADR §5.1/§5.3) ──────────────────────────
          // Structural leg = (ZIV + mentor) capped at zivStructuralCap (≤7.5). mentor
          // folds in BEFORE the cap so mentor+kronos cannot exceed 10. The 7.5 cap
          // lives HERE (warEngine boundary), NOT in zivEngine (kept pure for others).
          const zivStructural = Math.min(ziv.score + boost.bonus, zivStructuralCap);
          const kAddon = getKronosAddonFromRow(kronosCache.get(ticker), "long", cfgKv);
          const convictionAddon = kAddon.addon;        // 0 when OFF/stale/miss/mismatch
          const combined = Math.min(zivStructural + convictionAddon, 10);
          // STALE/COLD CACHE = pure legacy ZIV-alone behaviour. When the kronos cache
          // is stale/missing/cold for this name, it must be gated EXACTLY like the
          // kronos-OFF path: ONLY the zivOnlyFloor (6.8), NO combined-gate, NO veto.
          // A stale cache must NEVER be more restrictive than legacy — otherwise the
          // degraded gate sits on the ZIV cap and starves the funnel ("no buys").
          const longKronosActive = kronosOn && !kAddon.stale;
          const longGateFloor = longKronosActive ? zivStructuralFloor : zivOnlyFloor;
          const final   = combined; // finalScore is an alias of combined (downstream sort/sizing)
          const intel   = await getTickerIntelligence(ticker, bars);

          const longScan: WarEngineScan = {
            ticker, direction: "long",
            baseScore: ziv.score, mentorBonus: boost.bonus, finalScore: final,
            zivStructural, convictionAddon, combined, kronosStale: kAddon.stale,
            confluence: intel.confluenceScore, liquidity: intel.liquidityScore,
            regime: regime.regime, mentorReasons: boost.reasons,
            action: "SKIP",
            // RC-2: structural-invalidation anchor (resistance→support level retested).
            invalidationLevel: ziv.retestLevel ?? null,
            // THE WAITER: daily EMA-50 (wideLungSL floor reference) carried to the
            // persisted candidate so the Waiter never re-fetches bars to recompute it.
            ema50: Number.isFinite(ziv.ema50) ? ziv.ema50 : null,
            // Phase-0 anti-chase (F5): prior-day Donchian-20 high, fixed for the day.
            // breakLevel = donchian20High × 1.005 is read off this in the entry loop.
            // Same Math.max-of-last-20-highs the v45 candidate cache surfaces (_d20High).
            donchian20High: bars.length ? Math.max(...bars.slice(-20).map(b => b.high)) : null,
            // Ziv Phase 1 — surface weekly-state + zone-status for the candidates table.
            weeklyState: wt.structure,
            zoneStatus: evaluateZoneGate(zones, bars[bars.length - 1].close, "long").inZone ? "in" : "out",
          };

          // ── War Room CANDIDATES v4.5 decision-data (DISPLAY-ONLY) ──────────────
          // Compute the SSOT genesisScore here (bars/cyc/regime/intel all in scope)
          // and cache the entry-readiness / distance-to-trigger / binding-wall for
          // the LONG candidate. Pure read — never gates, sizes, or places an order.
          // Wrapped in try so a display-enrichment fault can NEVER abort a scan.
          try {
            const _gs = elzaGenesisScore(bars, bars.length - 1);
            const _last20 = bars.slice(-20);
            const _d20High = _last20.length ? Math.max(..._last20.map(b => b.high)) : 0;
            const _abnormalCycle = cyclePhaseGateEnabled && cyc?.longGate === "BLOCK";
            const _vixBlocked = vixSizeBand(regime.vixProxy).block;
            const _macroBlocked = !regime.longOk || _vixBlocked;
            const _macroLabel = _vixBlocked ? "VIX>35" : "DEFENSE (SPY<EMA50)";
            v45CandCache.set(ticker, buildV45CandMeta({
              price: _gs.price || bars[bars.length - 1].close,
              tier: _gs.tier,
              base: _gs.baseScore,
              subTotal: _gs.subScore,
              total: _gs.totalScore,
              ema50: _gs.ema50,
              ema200: _gs.ema200,
              donchian20High: _d20High,
              confluence: intel.confluenceScore,
              liquidity: intel.liquidityScore,
              abnormalCycle: _abnormalCycle,
              macroBlocked: _macroBlocked,
              macroLabel: _macroLabel,
              minScore: ELZA_V45_CFG.LONG_MIN_SCORE,
              minConfluence: ELZA_V45_CFG.MIN_CONFLUENCE,
              minLiquidity: ELZA_V45_CFG.MIN_LIQUIDITY,
            }));
          } catch { /* display enrichment best-effort — never aborts the scan */ }

          // ── ELZA v4.5 SSOT ENTRY GATE (flag-gated; INERT until elzaV45LiveEnabled=1) ──
          // When the master switch is ON, the LONG admission is the VALIDATED Golden-DNA
          // backtest brain (scoreLong → genesisScore), NOT the ZIV combined path. scoreLong
          // bakes in the EXACT backtest gate (totalScore≥7.0 AND confluence≥4.5 AND
          // liquidity≥2.0; price>EMA200 + wide-lung SL<entry internal). The live 6.8/5.5
          // ZIV gates are DELIBERATELY NOT applied here — replicating the backtest closes
          // the live-vs-backtest parity gap. flag=0 → this whole block is skipped and the
          // legacy ZIV chain below runs byte-identically (verified by ENTRY-G4).
          const elzaV45On = isElzaV45LiveEnabled(cfgKv as any);
          if (elzaV45On) {
            // FAIL-CLOSED: scoreLong returns null on <200 bars / no qualifying setup /
            // sub-gate / non-positive R, and a throw is caught → BLOCKED (no entry).
            let s: ReturnType<typeof elzaScoreLong> = null;
            try {
              const elzaIntel: ElzaV45Intel = {
                confluence: intel.confluenceScore,
                liquidity: intel.liquidityScore,
                // weeklySlope intentionally omitted — genesisScore derives the weekly
                // EMA-50 slope INTERNALLY from the bar series (closes idx%5). Feeding an
                // external slope here would re-introduce a parity divergence.
              };
              s = elzaScoreLong(bars, bars.length - 1, elzaIntel);
            } catch (e) {
              s = null;
              dbLog("warn", "SYSTEM", `[ElzaV45] ${ticker} scoreLong threw — failing closed (no entry): ${String(e).slice(0, 80)}`);
            }
            if (s === null) {
              longScan.action = "BLOCKED";
              longScan.blockReason = "scoreLong null (SSOT gate)";
            } else if (vixSizeBand(regime.vixProxy).block) {
              // ── CV-A — §2 VIX ENTRY GUARD (flag=1 only). ──────────────────────────
              // The VALIDATED backtest BLOCKS the entry entirely when VIX>35
              // (scripts/elzaV45GoldenDNA.ts §2: vixClose>VIX_BLOCK → skip). Mirror it
              // live off the already-loaded regime.vixProxy. FAIL CLOSED: a non-finite
              // vixProxy is a degraded/defensive block too (vixSizeBand returns block).
              // This fires AFTER scoreLong admits but BEFORE the candidate becomes ENTER,
              // so a VIX-blocked name never reaches the sizer/tryLiveEntry.
              longScan.action = "BLOCKED";
              longScan.blockReason = `[VIXGuard] vixProxy ${Number.isFinite(regime.vixProxy) ? regime.vixProxy.toFixed(1) : "n/a"} > ${35} — entry blocked (VALIDATED §2)`;
              dbLog("info", "SYSTEM", `[VIXGuard] ${ticker} LONG blocked — ${longScan.blockReason}`);
            } else {
              // finalScore IS the SSOT totalScore (6–10 scale, same as combined) → the
              // downstream sort / conviction sizing / route all consume it unchanged.
              // Route falls out of the SSOT tier: Tier-4 breakout (base 9/10 → totalScore≥9)
              // → GOLD_BREAKOUT_WAR; Tier-3 retest (base 7/8 → totalScore<9) → GOLD_RETEST_WAR
              // — which is EXACTLY the existing `finalScore>=9` router in the entry-execution
              // loop (Tier-3 max 8+0.99=8.99 < 9 ≤ Tier-3 floor 9).
              const ssotBase = s.tier === "TIER4_POWER_BREAKOUT"
                ? (s.totalScore >= 10 ? 10 : 9)
                : (s.totalScore >= 8 ? 8 : 7);
              longScan.finalScore      = s.totalScore;
              longScan.baseScore       = ssotBase;
              longScan.combined        = s.totalScore; // conviction sizing keys off combined
              longScan.zivStructural   = s.totalScore;
              longScan.convictionAddon = 0;
              longScan.action          = "ENTER";
            }
            allScans.push(longScan);
          } else {
          // Entry gates (LEGACY ZIV path) — runs ONLY when the Elza v4.5 SSOT switch is
          // OFF (default). The whole chain + its push live in this `else`, so flag=1 NEVER
          // touches the 6.8/5.5 ZIV gates; flag=0 is byte-identical to before this change.
          // §4 veto: a credible opposing kronos forecast hard-BLOCKS regardless of ZIV.
          // Only a FRESH cache can veto — a stale/cold cache reverts to legacy ZIV-alone.
          if (longKronosActive && kAddon.veto) {
            longScan.action = "BLOCKED"; longScan.blockReason = kAddon.reason;
            log.block("KRONOS_VETO", `${ticker} LONG ${kAddon.reason}`, { ticker });
          } else if (zivStructural < longGateFloor) {
            longScan.action = "SKIP"; longScan.blockReason = `ziv ${zivStructural.toFixed(2)} < floor ${longGateFloor}`;
          } else if (ziv.tier === "Gold Breakout" && !goldBreakoutEnabled && !(volumeConfirmEnabled && confirmVolume(bars, ziv.donchian20High, "long").confirmed)) {
            // ── Gold Breakout kill-switch (owner-disabled RC-1) ──────────────────
            // Chasing extended daily breakouts is the #1 stop-out cause → SKIP. Ziv Phase 4:
            // when volumeConfirmEnabled, a נמ"ס-confirmed breakout (high volume + healthy candle +
            // close-near-high) is allowed to ENTER (falls through). volumeConfirm OFF → byte-identical.
            longScan.action = "SKIP";
            longScan.blockReason = "[GoldBreakout OFF] breakout-chasing disabled (awaits retest or נמ\"ס volume confirmation)";
          } else if (longKronosActive && combined < combinedGate) {
            // Combined-gate ONLY when kronos is fresh. Stale/cold ⇒ skipped (ZIV-alone).
            longScan.action = "SKIP"; longScan.blockReason = `combined ${combined.toFixed(2)} < gate ${combinedGate}`;
          } else if (intel.confluenceScore < MIN_CONFLUENCE) {
            longScan.action = "BLOCKED"; longScan.blockReason = `confluence ${intel.confluenceScore.toFixed(1)} < ${MIN_CONFLUENCE}`;
          } else if (intel.liquidityScore < MIN_LIQUIDITY_SCORE) {
            longScan.action = "BLOCKED"; longScan.blockReason = `liquidity ${intel.liquidityScore.toFixed(1)} < ${MIN_LIQUIDITY_SCORE}`;
          } else if (!intel.weeklyAligned) {
            longScan.action = "BLOCKED"; longScan.blockReason = "weekly EMA-50 slope negative";
          } else if (weeklyAnchorEnabled && !evaluateWeeklyGate(wt, "long").pass) {
            // Ziv Phase 1 HARD weekly anchor — long only in a WK-L weekly uptrend.
            longScan.action = "BLOCKED"; longScan.blockReason = `weekly-anchor: ${evaluateWeeklyGate(wt, "long").reason}`;
          } else if (zonesGateEnabled && !evaluateZoneGate(zones, bars[bars.length - 1].close, "long").inZone) {
            // Ziv Phase 1 zone gate — price must sit at a demand zone (SKIP: re-qualifies on a pullback).
            longScan.action = "SKIP"; longScan.blockReason = "[Zones] price not at a demand zone — awaits pullback";
          } else if (retestV2Enabled && zonesGateEnabled && (() => {
            // Ziv Phase 2 retest gate — the in-zone price must show a valid ±0.5×ATR band retest (5-close hold, not FOMO).
            const _zg = evaluateZoneGate(zones, bars[bars.length - 1].close, "long");
            return _zg.zone != null && !evaluateRetestV2({ zone: _zg.zone, direction: "long", priceAtSignal: bars[bars.length - 1].close, isFirstRetest: true }, bars, ziv.retestLevel ?? null).valid;
          })()) {
            longScan.action = "SKIP"; longScan.blockReason = "[Retest] no valid retest — awaits band hold";
          } else if (cyclePhaseGateEnabled && cyc?.longGate === "BLOCK") {
            longScan.action = "BLOCKED"; longScan.blockReason = cyc.reason;
            log.block("CYC_GATE", `${ticker} LONG blocked — ${cyc.reason}`, { ticker, code: cyc.code });
          } else if (openTickerSet.has(ticker)) {
            longScan.action = "BLOCKED"; longScan.blockReason = "already open";
          } else if (signalBias === "REJECTED") {
            longScan.action = "BLOCKED"; longScan.blockReason = "signal_bias=REJECTED (Hebrew Slang Guard — bearish pattern detected)";
            log.block("SLANG_GUARD", `${ticker} LONG blocked — mentor flagged REJECTED signal`, { ticker });
          } else {
            // Correlation check
            const newClose = bars.map(b => b.close);
            const correlated = Array.from(openCloseMap.entries()).find(([, oc]) => calcCorrelation(newClose, oc) > MAX_CORRELATION);
            if (correlated) {
              longScan.action = "BLOCKED"; longScan.blockReason = `correlation ${correlated[0]} > ${MAX_CORRELATION}`;
            } else {
              longScan.action = "ENTER";
            }
          }
          allScans.push(longScan);
          } // end LEGACY ZIV long-gate `else`
        }

        // ── SHORT scan ─────────────────────────────────────────────────────
        if (regime.shortOk) {
          // ── SHORT path: IBKR live price + guards (parity with LONG — 2026-06-18) ──
          // Fetch IBKR real-time price for bear scoring context and pre-scan guard.
          let shortLivePrice = 0;
          try {
            // REPOINT 2026-06-25: /iserver/marketdata/snapshot 404s on this gateway.
            // Use the working POST /quotes pipeline (returns a LivePrice object → .price).
            const shortMap = await fetchIbkrLivePricesBatch([ticker], { skipCache: true });
            const shortLp = shortMap.get(ticker) ?? null;
            // QA fix #2: only real-time IBKR truth may price a live short. A Yahoo/DB-cache fallback
            // (source!=='ibkr') is treated as no live price → EOD-fallback / skip guards fire below.
            const ibkrShortLive = shortLp?.source === 'ibkr' ? Number(shortLp.price ?? 0) : 0;
            if (ibkrShortLive > 0) shortLivePrice = ibkrShortLive;
          } catch {}
          const shortEodClose = bars?.[bars.length - 1]?.close ?? 0;
          if (shortLivePrice <= 0) shortLivePrice = shortEodClose; // EOD fallback only

          // [ShortScan NaN Guard] — skip if price unresolvable
          if (!shortLivePrice || isNaN(shortLivePrice) || shortLivePrice <= 0) {
            dbLog("warn", "SYSTEM", `[WarEngine] ⚠️ ${ticker} SHORT — price NaN/0. Skipping.`);
            skipped++;
          } else if (shortEodClose <= 0) {
            // QA fix #4: no EOD bar data → no independent sanity bound → skip the short pre-scan.
            dbLog("warn", "SYSTEM", `[WarEngine] ⏭ ${ticker} SHORT — no EOD bar data; cannot sanity-bound live $${shortLivePrice}. Skipping.`);
            skipped++;
          } else if (shortLivePrice < 2.0) {
            // [ShortScan Penny Guard] — no shorting penny stocks
            dbLog("warn", "SYSTEM", `[WarEngine] 🚫 ${ticker} SHORT — price=$${shortLivePrice} < $2.00. Penny stock, skipping.`);
            skipped++;
          } else if (shortEodClose > 0 && Math.abs(shortLivePrice - shortEodClose) / shortEodClose > 0.50) {
            // [ShortScan Divergence Guard] — IBKR vs EOD >50%
            dbLog("warn", "SYSTEM", `[WarEngine] ⚠️ ${ticker} SHORT — IBKR $${shortLivePrice} vs EOD $${shortEodClose.toFixed(2)} diverge >50%. Skipping.`);
            skipped++;
          } else {
          // ── SHORT scoring proceeds with validated live price ──────────────
          const bear    = calcBearScore(bars);
          const boost   = await calcMentorBoost(userId, ticker, `BEAR_${bear.tier.replace(/\s/g,'_').toUpperCase()}`, mentorSources);
          // ── Kronos combined scoring (symmetric to LONG; ADR §5.3) ────────────
          const zivStructuralS = Math.min(bear.score + boost.bonus, zivStructuralCap);
          const kAddonS = getKronosAddonFromRow(kronosCache.get(ticker), "short", cfgKv);
          const convictionAddonS = kAddonS.addon;
          const combinedS = Math.min(zivStructuralS + convictionAddonS, 10);
          // STALE/COLD CACHE = pure legacy ZIV-alone behaviour (symmetric to LONG):
          // ONLY zivOnlyFloor, NO combined-gate, NO veto. Never more restrictive than legacy.
          const shortKronosActive = kronosOn && !kAddonS.stale;
          const shortGateFloor = shortKronosActive ? zivStructuralFloor : zivOnlyFloor;
          const final   = combinedS; // alias of combined
          const intel   = await getTickerIntelligence(ticker, bars);

          const shortScan: WarEngineScan = {
            ticker, direction: "short",
            baseScore: bear.score, mentorBonus: boost.bonus, finalScore: final,
            zivStructural: zivStructuralS, convictionAddon: convictionAddonS, combined: combinedS, kronosStale: kAddonS.stale,
            confluence: intel.confluenceScore, liquidity: intel.liquidityScore,
            regime: regime.regime, mentorReasons: boost.reasons,
            action: "SKIP",
            // RC-2: structural-invalidation anchor (support→resistance level retested).
            invalidationLevel: bear.retestLevel ?? null,
            // Ziv Phase 1 — surface weekly-state + zone-status for the candidates table.
            weeklyState: wt.structure,
            zoneStatus: evaluateZoneGate(zones, bars[bars.length - 1].close, "short").inZone ? "in" : "out",
          };

          // LEVER 4(b) — direction-agnostic gates added to SHORT (shorts ADR
          // Decision 1, Option B): explicit weekly-alignment + correlation.
          // NOT added: LONG-confluence and slang-guard — both are bull-biased
          // (momentum-up / "bearish pattern → reject") and would wrongly block
          // valid breakdowns. Precedence mirrors the LONG chain.
          // Weekly-alignment, sign-flipped: LONG blocks when weekly is NOT up
          // (!weeklyAligned); SHORT blocks when weekly IS up/flat (weeklyAligned),
          // i.e. a short requires a negative weekly EMA-50 slope. Reuses the same
          // intel.weeklyAligned SSOT so it cannot drift from the LONG computation.
          if (shortKronosActive && kAddonS.veto) {
            shortScan.action = "BLOCKED"; shortScan.blockReason = kAddonS.reason;
            log.block("KRONOS_VETO", `${ticker} SHORT ${kAddonS.reason}`, { ticker });
          } else if (zivStructuralS < shortGateFloor) {
            shortScan.action = "SKIP"; shortScan.blockReason = `ziv ${zivStructuralS.toFixed(2)} < floor ${shortGateFloor}`;
          } else if (bear.tier === "Bear Breakdown" && !bearBreakdownEnabled && !(volumeConfirmEnabled && confirmVolume(bars, Math.min(...bars.slice(-20).map((b: any) => b.low)), "short").confirmed)) {
            // ── Bear Breakdown kill-switch (§3, mirror of the long Gold Breakout SKIP) ──
            // Chasing extended daily breakdowns is the short-side #1 stop-out cause → SKIP.
            // Ziv Phase 4 (symmetric): a נמ"ס-confirmed breakdown (high volume + healthy candle +
            // close-near-low) is allowed to ENTER. volumeConfirm OFF → byte-identical to today.
            shortScan.action = "SKIP";
            shortScan.blockReason = "[Breakdown OFF] breakdown-chasing disabled (awaits retest or נמ\"ס volume confirmation)";
          } else if (shortKronosActive && combinedS < combinedGate) {
            // Combined-gate ONLY when kronos is fresh. Stale/cold ⇒ skipped (ZIV-alone).
            shortScan.action = "SKIP"; shortScan.blockReason = `combined ${combinedS.toFixed(2)} < gate ${combinedGate}`;
          } else if (regime.breadthPctBelow200 < breadthThreshold) {
            // Explicit short-entry breadth gate (tighten): a SHORT requires WEAK
            // breadth — i.e. ≥ breadthThreshold of the universe trading below its
            // EMA-200. When breadthPctBelow200 < threshold the tape is broad/healthy
            // and shorts are blocked even if the SPY-only regime reads NEUTRAL.
            // Strengthens the regime.shortOk enabler (which lets NEUTRAL shorts
            // through regardless of breadth). LONG entries are unaffected.
            shortScan.action = "BLOCKED";
            shortScan.blockReason = `[ShortGate] breadth ${regime.breadthPctBelow200.toFixed(2)} < ${breadthThreshold} below-EMA200 — shorts blocked (need weak breadth >= threshold)`;
          } else if (shortOpenTickers.has(ticker)) {
            shortScan.action = "BLOCKED"; shortScan.blockReason = "already open short";
          } else if (intel.liquidityScore < MIN_LIQUIDITY_SCORE) {
            shortScan.action = "BLOCKED"; shortScan.blockReason = `liquidity ${intel.liquidityScore.toFixed(1)} < ${MIN_LIQUIDITY_SCORE}`;
          } else if (intel.weeklyAligned) {
            shortScan.action = "BLOCKED"; shortScan.blockReason = "weekly EMA-50 slope not negative";
          } else if (weeklyAnchorEnabled && !evaluateWeeklyGate(wt, "short").pass) {
            // Ziv Phase 1 HARD weekly anchor — short only in a WK-S weekly downtrend (symmetric to LONG).
            shortScan.action = "BLOCKED"; shortScan.blockReason = `weekly-anchor: ${evaluateWeeklyGate(wt, "short").reason}`;
          } else if (zonesGateEnabled && !evaluateZoneGate(zones, bars[bars.length - 1].close, "short").inZone) {
            // Ziv Phase 1 zone gate — price must sit at a supply zone (SKIP: re-qualifies on a pullback).
            shortScan.action = "SKIP"; shortScan.blockReason = "[Zones] price not at a supply zone — awaits pullback";
          } else if (retestV2Enabled && zonesGateEnabled && (() => {
            // Ziv Phase 2 retest gate — symmetric mirror of the LONG retest gate.
            const _zg = evaluateZoneGate(zones, bars[bars.length - 1].close, "short");
            return _zg.zone != null && !evaluateRetestV2({ zone: _zg.zone, direction: "short", priceAtSignal: bars[bars.length - 1].close, isFirstRetest: true }, bars, bear.retestLevel ?? null).valid;
          })()) {
            shortScan.action = "SKIP"; shortScan.blockReason = "[Retest] no valid retest — awaits band hold";
          } else if (cyclePhaseGateEnabled && cyc?.shortGate === "BLOCK") {
            shortScan.action = "BLOCKED"; shortScan.blockReason = cyc.reason;
            log.block("CYC_GATE", `${ticker} SHORT blocked — ${cyc.reason}`, { ticker, code: cyc.code });
          } else {
            // Correlation check — against the OPEN SHORT book only (redundant
            // short exposure), mirroring the LONG correlation gate as the final
            // pre-ENTER gate.
            const newClose = bars.map(b => b.close);
            const correlatedShort = Array.from(shortOpenCloseMap.entries()).find(([, oc]) => calcCorrelation(newClose, oc) > MAX_CORRELATION);
            if (correlatedShort) {
              shortScan.action = "BLOCKED"; shortScan.blockReason = `correlation ${correlatedShort[0]} > ${MAX_CORRELATION}`;
            } else {
              shortScan.action = "ENTER";
            }
          }
          allScans.push(shortScan);
          } // end SHORT price-validated block
        }

      } catch (e) {
        skipped++;
        dbLog("warn", "SYSTEM", `[WarEngine] ${ticker} scan error: ${String(e).slice(0,60)}`);
      }
    }

    // ── 5. Execute entries — sorted by finalScore desc ───────────────────────
    const candidates = allScans
      .filter(s => s.action === "ENTER")
      .sort((a, b) => b.finalScore - a.finalScore);

    const warLiveConfig = await getLiveConfig(userId);
    const dynamicMaxPos      = warLiveConfig?.maxPositions      ?? MAX_WAR_POSITIONS;
    const dynamicMaxLong     = warLiveConfig?.maxLongPositions  ?? 12;
    // Symmetric caps (§5.1): default maxShort to maxLong (12), not the legacy
    // asymmetric 6. The total-book cap + per-ticker exposure + budget governor bound
    // real risk; the per-direction slot count should not pre-bias the book 2:1 long.
    const dynamicMaxShort    = warLiveConfig?.maxShortPositions ?? dynamicMaxLong;

    // ── Leverage-aware capital limits ────────────────────────────────────────
    const { allocatedCapital: maxAllocUsd, isIntraday, multiplier, overnightCap, cashBudget } =
      warLiveConfig ? computeLiveCapital(warLiveConfig) : { allocatedCapital: 50000, isIntraday: true, multiplier: 1, overnightCap: 50000, cashBudget: 50000 };
    const leverageLabel = isIntraday ? `INTRADAY x${multiplier} → $${maxAllocUsd.toFixed(0)}` : `OVERNIGHT x${multiplier} → $${maxAllocUsd.toFixed(0)}`;

    // ── deployedUsd: read LIVE from IBKR gross position value (not DB) ─────────
    // DB livePositions may be stale — IBKR is the single source of truth for capital
    let deployedUsd = 0;
    let ibkrLivePositions: any[] = [];
    try {
      const { ibindRequest } = await import("./routers/ibkrProxy");
      const [acctRes, posRes] = await Promise.all([
        ibindRequest("GET", "/account/summary"),
        ibindRequest("GET", "/positions"),
      ]);
      if (acctRes.ok) {
        const grossVal = (acctRes.body as any)?.summary?.grosspositionvalue?.amount ?? 0;
        deployedUsd = Math.abs(grossVal);
        log.info("WAR_ENGINE", `[Budget] IBKR gross position = $${deployedUsd.toFixed(0)} / cap = $${maxAllocUsd.toFixed(0)}`);
      }
      if (posRes.ok) {
        ibkrLivePositions = ((posRes.body as any)?.positions ?? [])
          .filter((p: any) => p.position !== 0);
      }
    } catch(e) {
      deployedUsd = openPositions.reduce((s, p) => s + (p.allocatedCapital ?? 0), 0);
      log.warn("WAR_ENGINE", `[Budget] IBKR unavailable — falling back to DB deployed=$${deployedUsd.toFixed(0)}`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ⚔️  IRON RULE 1: Dynamic Portfolio Downsizing
    // If deployed > allowedBudget → close weakest ZIV-scored positions first
    // ══════════════════════════════════════════════════════════════════════════
    if (deployedUsd > maxAllocUsd + 1000 && ibkrLivePositions.length > 0) {
      const excess = deployedUsd - maxAllocUsd;
      dbLog("warn", "SYSTEM",
        `[IronRule1] 🔴 OVER BUDGET: deployed=$${deployedUsd.toFixed(0)} cap=$${maxAllocUsd.toFixed(0)} excess=$${excess.toFixed(0)} — starting Active Downsizing`
      );

      // Fetch ZIV scores for open positions from userAssets
      const { userAssets: userAssetsTable } = await import("../drizzle/schema");
      const { inArray } = await import("drizzle-orm");
      const tickers = ibkrLivePositions.map((p: any) => (p.contractDesc ?? "").toUpperCase()).filter(Boolean);
      const assetRows = tickers.length > 0
        ? await db.select({ ticker: userAssetsTable.ticker, score: userAssetsTable.score })
            .from(userAssetsTable).where(inArray(userAssetsTable.ticker, tickers))
        : [];
      const scoreMap = new Map<string, number>();
      for (const a of assetRows) {
        scoreMap.set(a.ticker.toUpperCase(), a.score ?? 0);
      }

      // Sort by ZIV score ASC (weakest first)
      const sorted = [...ibkrLivePositions].sort((a, b) => {
        const tA = (a.contractDesc ?? "").toUpperCase();
        const tB = (b.contractDesc ?? "").toUpperCase();
        return (scoreMap.get(tA) ?? 0) - (scoreMap.get(tB) ?? 0);
      });

      let reduced = 0;
      const { resolveConid, LIVE_ACCOUNT_ID } = await import("./liveOrderExecutor");

      for (const pos of sorted) {
        if (reduced >= excess) break;
        const ticker = (pos.contractDesc ?? "").toUpperCase();
        const posVal = Math.abs(pos.mktValue ?? 0);
        const side   = (pos.position ?? 0) > 0 ? "SELL" : "BUY";
        const qty    = Math.abs(pos.position ?? 0);
        try {
          const conid = await resolveConid(ticker);
          if (!conid) {
            dbLog("warn", "SYSTEM", `[IronRule1] No conid for ${ticker} — skipping`);
            continue;
          }
          const closeRes = await placeMarketableLmtClose({
            accountId: LIVE_ACCOUNT_ID,
            conid,
            ticker,
            side,
            quantity: qty,
            mktPrice: pos.mktPrice,
            mktValue: pos.mktValue,
          });
          if (closeRes.ok) {
            reduced += posVal;
            deployedUsd -= posVal;
            dbLog("info", "SYSTEM",
              `[IronRule1] ✅ Closed ${ticker} mktVal=$${posVal.toFixed(0)} score=${(scoreMap.get(ticker) ?? 0).toFixed(1)} | reduced=$${reduced.toFixed(0)}`
            );
          } else {
            dbLog("warn", "SYSTEM", `[IronRule1] ❌ Failed to close ${ticker}: ${closeRes.error ?? ""}`);
          }
        } catch(closeErr: any) {
          dbLog("warn", "SYSTEM", `[IronRule1] Error closing ${ticker}: ${closeErr.message}`);
        }
      }
      dbLog("info", "SYSTEM", `[IronRule1] Done. deployed now ~$${deployedUsd.toFixed(0)} / cap=$${maxAllocUsd.toFixed(0)}`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ⚔️  IRON RULE 2: 22:30 Overnight Transition (Israel time)
    // If now is between 22:25–22:35 IST and deployed > overnightCap → downsize
    // ══════════════════════════════════════════════════════════════════════════
    {
      const nowIL     = new Date();
      const ilHour    = (nowIL.getUTCHours() + 3) % 24;
      const ilMinute  = nowIL.getUTCMinutes();
      const ilTotal   = ilHour * 60 + ilMinute;
      const IS_OVERNIGHT_WINDOW = ilTotal >= (22 * 60 + 15) && ilTotal <= (22 * 60 + 58); // triggers on 22:20 scan slot

      if (IS_OVERNIGHT_WINDOW && deployedUsd > overnightCap + 1000 && ibkrLivePositions.length > 0) {
        const excessOvr = deployedUsd - overnightCap;
        dbLog("warn", "SYSTEM",
          `[IronRule2] 🌙 OVERNIGHT TRANSITION: deployed=$${deployedUsd.toFixed(0)} overnightCap=$${overnightCap.toFixed(0)} excess=$${excessOvr.toFixed(0)} — downsizing`
        );

        const { userAssets: userAssetsTable2 } = await import("../drizzle/schema");
        const { inArray: inArray2 } = await import("drizzle-orm");
        const tickers2 = ibkrLivePositions.map((p: any) => (p.contractDesc ?? "").toUpperCase()).filter(Boolean);
        const assetRows2 = tickers2.length > 0
          ? await db.select({ ticker: userAssetsTable2.ticker, score: userAssetsTable2.score })
              .from(userAssetsTable2).where(inArray2(userAssetsTable2.ticker, tickers2))
          : [];
        const scoreMap2 = new Map<string, number>();
        for (const a of assetRows2) scoreMap2.set(a.ticker.toUpperCase(), a.score ?? 0);

        const sorted2 = [...ibkrLivePositions].sort((a, b) => {
          const tA = (a.contractDesc ?? "").toUpperCase();
          const tB = (b.contractDesc ?? "").toUpperCase();
          return (scoreMap2.get(tA) ?? 0) - (scoreMap2.get(tB) ?? 0);
        });

        let reducedOvr = 0;
        const { resolveConid: resolveConid2, LIVE_ACCOUNT_ID: ACCT2 } = await import("./liveOrderExecutor");

        for (const pos of sorted2) {
          if (reducedOvr >= excessOvr) break;
          const ticker = (pos.contractDesc ?? "").toUpperCase();
          const posVal = Math.abs(pos.mktValue ?? 0);
          const side   = (pos.position ?? 0) > 0 ? "SELL" : "BUY";
          const qty    = Math.abs(pos.position ?? 0);
          try {
            const conid = await resolveConid2(ticker);
            if (!conid) continue;
            const closeRes2 = await placeMarketableLmtClose({
              accountId: ACCT2,
              conid,
              ticker,
              side,
              quantity: qty,
              mktPrice: pos.mktPrice,
              mktValue: pos.mktValue,
            });
            if (closeRes2.ok) {
              reducedOvr += posVal;
              deployedUsd -= posVal;
              dbLog("info", "SYSTEM",
                `[IronRule2] ✅ Closed ${ticker} mktVal=$${posVal.toFixed(0)} score=${(scoreMap2.get(ticker) ?? 0).toFixed(1)} | reduced=$${reducedOvr.toFixed(0)}`
              );
            } else {
              dbLog("warn", "SYSTEM", `[IronRule2] ❌ Failed to close ${ticker}: ${closeRes2.error ?? "unknown"}`);
            }
          } catch(e2: any) {
            dbLog("warn", "SYSTEM", `[IronRule2] Error closing ${ticker}: ${e2.message}`);
          }
        }
        dbLog("info", "SYSTEM", `[IronRule2] Done. deployed now ~$${deployedUsd.toFixed(0)} / overnightCap=$${overnightCap.toFixed(0)}`);
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ⚔️  IRON RULE 3: Max Positions Enforcement
    // If IBKR has more open positions than maxPositions setting →
    // close weakest ZIV-scored positions until count ≤ maxPositions
    // ══════════════════════════════════════════════════════════════════════════
    const dynMaxPos      = warLiveConfig?.maxPositions ?? 28;
    const dynMaxLong     = warLiveConfig?.maxLongPositions  ?? 12;
    const dynMaxShort    = warLiveConfig?.maxShortPositions ?? dynMaxLong;  // symmetric caps (§5.1)
    const ibkrLongCount  = ibkrLivePositions.filter((p: any) => (p.position ?? 0) > 0).length;
    const ibkrShortCount = ibkrLivePositions.filter((p: any) => (p.position ?? 0) < 0).length;
    // enforce total AND per-direction limits
    const totalExceeded = ibkrLivePositions.length > dynMaxPos;
    const longExceeded  = ibkrLongCount  > dynMaxLong;
    const shortExceeded = ibkrShortCount > dynMaxShort;
    if (totalExceeded || longExceeded || shortExceeded) {
      const excessTotal = Math.max(0, ibkrLivePositions.length - dynMaxPos);
      const excessLong  = Math.max(0, ibkrLongCount  - dynMaxLong);
      const excessShort = Math.max(0, ibkrShortCount - dynMaxShort);
      const excess3     = Math.max(excessTotal, excessLong + excessShort);
      dbLog("warn", "SYSTEM",
        `[IronRule3] 🔴 TOO MANY POSITIONS: ${ibkrLivePositions.length} open > max ${dynMaxPos} — closing ${excess3} weakest`
      );

      const { userAssets: uaT3 } = await import("../drizzle/schema");
      const { inArray: inArray3 } = await import("drizzle-orm");
      const tickers3 = ibkrLivePositions.map((p: any) => (p.contractDesc ?? "").toUpperCase()).filter(Boolean);
      const assetRows3 = tickers3.length > 0
        ? await db.select({ ticker: uaT3.ticker, score: uaT3.score })
            .from(uaT3).where(inArray3(uaT3.ticker, tickers3))
        : [];
      const scoreMap3 = new Map<string, number>();
      for (const a of assetRows3) scoreMap3.set(a.ticker.toUpperCase(), a.score ?? 0);

      // Sort weakest first
      const sorted3 = [...ibkrLivePositions].sort((a, b) => {
        const tA = (a.contractDesc ?? "").toUpperCase();
        const tB = (b.contractDesc ?? "").toUpperCase();
        return (scoreMap3.get(tA) ?? 0) - (scoreMap3.get(tB) ?? 0);
      });

      const { resolveConid: rc3, LIVE_ACCOUNT_ID: ACCT3 } = await import("./liveOrderExecutor");
      let closed3 = 0;

      for (const pos of sorted3) {
        if (closed3 >= excess3) break;
        const ticker = (pos.contractDesc ?? "").toUpperCase();
        const side   = (pos.position ?? 0) > 0 ? "SELL" : "BUY";
        const qty    = Math.abs(pos.position ?? 0);
        const score  = scoreMap3.get(ticker) ?? 0;
        try {
          const conid = await rc3(ticker);
          if (!conid) { dbLog("warn", "SYSTEM", `[IronRule3] No conid for ${ticker}`); continue; }
          const cr3 = await placeMarketableLmtClose({
            accountId: ACCT3,
            conid,
            ticker,
            side,
            quantity: qty,
            mktPrice: pos.mktPrice,
            mktValue: pos.mktValue,
          });
          if (cr3.ok) {
            closed3++;
            dbLog("info", "SYSTEM", `[IronRule3] ✅ Closed ${ticker} score=${score.toFixed(1)} (${closed3}/${excess3})`);
          } else {
            dbLog("warn", "SYSTEM", `[IronRule3] ❌ Failed ${ticker}: ${cr3.error ?? ""}`);
          }
        } catch(e3: any) {
          dbLog("warn", "SYSTEM", `[IronRule3] Error ${ticker}: ${e3.message}`);
        }
      }
      dbLog("info", "SYSTEM", `[IronRule3] Done. closed ${closed3} positions. remaining ~${ibkrLivePositions.length - closed3} / ${dynamicMaxPos}`);
    }

    // currentOpenCount tracks real-time count (openPositions is stale after entries this cycle)
    // ── Ghost Slots (G1-A/B): a ghosted row (slotGhost=1) no longer consumes a slot, so it is
    //    EXCLUDED from the seed counts → a fresh entry may fill the freed slot. INERT when
    //    ghostSlotsEnabled=0: slotCountTowardsSlot honors EVERY row → byte-identical seeds.
    //    NOTE (G1-B): freeing a slot does NOT free margin — the IBKR-gross / budget cap below
    //    (deployedUsd ≥ cap) still binds independently, so a freed slot with no margin headroom
    //    yields no new entry. The slot count is a SEPARATE governor from the capital governor.
    const _slotCountable = (p: any) => rowCountsTowardSlot(p, _ghostOn);
    let currentOpenCount = openPositions.filter(_slotCountable).length;
    // ── BUGFIX (2026-06-22): the "running counters" refactor (~line 800) referenced
    //    runningLong/ShortCount but never DECLARED them → ReferenceError crashed the entry
    //    loop the instant candidates existed (this is why Elsa stopped opening positions).
    //    Declare + seed from current open positions so direction caps count existing + new.
    let runningLongCount  = openPositions.filter((p: any) => p.direction === "long"  && _slotCountable(p)).length;
    let runningShortCount = openPositions.filter((p: any) => p.direction === "short" && _slotCountable(p)).length;

    // ── Structured cycle-start log ────────────────────────────────────────────
    log.info("WAR_ENGINE",
      `Cycle started [${leverageLabel}]. NLV: $${(warLiveConfig?.totalNlv ?? 0).toLocaleString()} | ` +
      `Deployed: $${deployedUsd.toFixed(0)} / $${maxAllocUsd.toFixed(0)} | ` +
      `Open: ${currentOpenCount} / ${dynamicMaxPos} | Cash base: $${(cashBudget ?? 0).toFixed(0)}`,
      { nlv: warLiveConfig?.totalNlv, deployed: deployedUsd, maxAlloc: maxAllocUsd, openCount: currentOpenCount, isIntraday, multiplier, candidates: candidates.length }
    );
    // ── Leverage logged EVERY cycle — IBKR truth (excludes phantom DB positions); DB fallback only if IBKR down ──
    {
      const _nlvLev   = Number(warLiveConfig?.totalNlv) > 0 ? Number(warLiveConfig?.totalNlv) : Math.max(deployedUsd, 1);
      const _useIbkr  = ibkrLivePositions.length > 0;
      const _longUsd  = _useIbkr
        ? ibkrLivePositions.filter((p: any) => (p.position ?? 0) > 0).reduce((s: number, p: any) => s + Math.abs(p.mktValue ?? 0), 0)
        : openPositions.filter((p: any) => p.direction !== "short").reduce((s: number, p: any) => s + (p.allocatedCapital ?? 0), 0);
      const _shortUsd = _useIbkr
        ? ibkrLivePositions.filter((p: any) => (p.position ?? 0) < 0).reduce((s: number, p: any) => s + Math.abs(p.mktValue ?? 0), 0)
        : openPositions.filter((p: any) => p.direction === "short").reduce((s: number, p: any) => s + (p.allocatedCapital ?? 0), 0);
      log.info("WAR_ENGINE",
        `[Leverage] gross ${(deployedUsd / _nlvLev).toFixed(2)}x | long ${(_longUsd / _nlvLev).toFixed(2)}x ($${Math.round(_longUsd/1000)}k) short ${(_shortUsd / _nlvLev).toFixed(2)}x ($${Math.round(_shortUsd/1000)}k) | net ${((_longUsd - _shortUsd) / _nlvLev).toFixed(2)}x [src=${_useIbkr ? "IBKR" : "DB"}]`);
    }

    // ── R2: concentration-cap tallies (flag-gated; INERT at flag=0) ───────────────
    // Seed the CONCURRENT-book counts of (a) already-open live positions for THIS account
    // from broker truth (ibkrLivePositions.contractDesc) — or the DB openPositions rows when
    // IBKR returned nothing — keyed by VolClass (SSOT classifyTicker) and by sector. Each
    // successful entry below increments these so a later candidate in the SAME cycle sees the
    // names opened earlier (true concurrent-book cap, not just per-cycle). Built from the
    // already-loaded `assets` rows (ticker→sector) — no extra DB round-trip. flag=0 ⇒ the maps
    // are never consulted (the in-loop check is gated too), so behavior is byte-identical.
    const _elzaV45OnR2 = isElzaV45LiveEnabled(cfgKv as any);
    // ── Phase-0 Anti-Chase flag (BUILD-spec F5) — read ONCE per cycle, INERT at 0 ──
    // Gates the anti-chase BLOCK in the entry-execution loop below. flag=0 (DEFAULT) ⇒
    // the gate is NEVER consulted → entry admission byte-identical to today. Reuses the
    // SAME cfgKv getLiveConfig snapshot as every other live flag (one source of truth).
    const _intradayWatcherOn = isIntradayWatcherEnabled(cfgKv as any);
    const _tickerSector = new Map<string, string>();
    if (_elzaV45OnR2) {
      for (const a of (assets as any[])) {
        if (a?.ticker && a?.sector) _tickerSector.set(String(a.ticker).toUpperCase(), String(a.sector));
      }
    }
    const _openClassCounts = new Map<VolClass, number>();
    const _openSectorCounts = new Map<string, number>();
    if (_elzaV45OnR2) {
      const _openTickers: string[] = ibkrLivePositions.length > 0
        ? ibkrLivePositions.map((p: any) => String(p.contractDesc ?? "").toUpperCase()).filter(Boolean)
        : openPositions.map((p: any) => String(p.ticker ?? "").toUpperCase()).filter(Boolean);
      for (const t of _openTickers) {
        const cls = classifyTicker(t);
        if (cls !== "OTHER") _openClassCounts.set(cls, (_openClassCounts.get(cls) ?? 0) + 1);
        const sec = _tickerSector.get(t);
        if (sec) _openSectorCounts.set(sec, (_openSectorCounts.get(sec) ?? 0) + 1);
      }
    }

    for (const c of candidates) {
      // ELZA 2.0 — refresh-candidates (scan-only): re-score + persist the forecast,
      // but place NO live orders. The autonomous cycle still handles real entries.
      if (opts?.scanOnly) break;
      // ── R1 cross-pipeline lock (THE WAITER mutual-exclusion) — INERT at waiterEnabled=0 ──
      // The slow War cycle ALSO enters GOLD_RETEST_WAR names (market buy). The SAME ticker
      // could get a Waiter resting LMT AND a War market buy → double-fill / over-size. When
      // the Waiter holds an armed/resting (pending_entry) or open LMT on this ticker, the War
      // cycle MUST skip its retest entry. One ticker, one pipeline. The flag is read FIRST —
      // flag=0 ⇒ no Waiter rows exist and this is a no-op (byte-identical).
      //
      // CROSS-PIPELINE LOCK (R1 gap-close): the Waiter holds the SHARED `entrySlotLock` only
      // around its atomic reserve + pending_entry INSERT (waiterEngine §4). Previously the War
      // cycle read `waiterHoldsRetest` WITHOUT that lock — a same-cycle TOCTOU between this
      // dup-check and the Waiter's insert was possible (only uq_open_ticker saved it at the DB).
      // We now acquire the SAME shared lock (`war:<ticker>`) BEFORE the read and HOLD it through
      // this candidate's retest `tryLiveEntry` transmit, so the Waiter insert and War dup-check
      // are genuinely serialized under one lock. If the lock is already held (the Waiter — or
      // another entry path — is mid-insert THIS instant), we skip this candidate's retest tick
      // and retry next cadence (the contention IS the serialization). The lock is released in
      // the per-candidate `finally` below, on EVERY exit (continue / break / throw). Long-retest
      // route only (finalScore<9) — breakouts/shorts never collide with the Waiter, so they take
      // no lock and stay byte-identical. flag=0 ⇒ this whole block is skipped (no lock at all).
      let _waiterLockHeld = false;
      const _warLockHolder = `war:${String(c.ticker).toUpperCase()}`;
      // BLOCKER-1 FIX: the `try {` now begins BEFORE the lock acquire, so the per-candidate
      // `finally` (which guards `if (_waiterLockHeld) releaseEntrySlot(...)`) also covers the
      // `await import("./waiterEngine")` and the `db.select(...)` below. Previously those two
      // awaits sat OUTSIDE the try — if `db.select` threw (DB hiccup / pool exhaustion) the
      // throw propagated with the shared lock HELD and only `_warRunning` got reset by the
      // outer finally → `_slotEntryBusy` leaked true forever → global entry deadlock until a
      // process restart. With the try moved up, EVERY throw path releases the lock.
      try {
      if ((warLiveConfig as any)?.waiterEnabled === 1 && c.direction === "long" && c.finalScore < 9) {
        if (!tryAcquireEntrySlot(_warLockHolder)) {
          dbLog("info", "SYSTEM", `[Waiter:R1] ⏭ War skip ${c.ticker} retest — entry-slot lock busy (Waiter/other path mid-insert); retry next cycle`);
          continue;
        }
        _waiterLockHeld = true;
        const { waiterHoldsRetest } = await import("./waiterEngine");
        const _waiterRows = await db.select({ ticker: livePositions.ticker, isWaiterEntry: livePositions.isWaiterEntry, status: livePositions.status })
          .from(livePositions)
          .where(and(eq(livePositions.userId, userId), inArray(livePositions.status, ["open", "pending_entry"] as any)));
        if (waiterHoldsRetest(c.ticker, _waiterRows as any)) {
          dbLog("info", "SYSTEM", `[Waiter:R1] ⏭ War skip ${c.ticker} retest — Waiter holds an armed/resting LMT (one ticker, one pipeline)`);
          releaseEntrySlot(_warLockHolder);
          _waiterLockHeld = false;
          continue;
        }
      }
      // ── HTB cooldown: skip names that placed-but-never-filled recently (stop broker spam) ──
      if (isHtbBlocked(c.ticker)) {
        dbLog("info", "SYSTEM", `[HTB] ⏭ skip ${c.ticker} — no-fill cooldown (${htbRemainingMin(c.ticker)}m left)`);
        continue;
      }
      // Hard stop: both position count AND capital budget
      // Use currentOpenCount (updated after each entry) instead of stale openPositions.length
      // ── FIXED (2026-06-22): use running counters — NOT stale openPositions filter ──
      // openPositions is loaded once before the loop and never mutated.
      // Using it for per-iteration counts caused ALL candidates to pass the direction
      // cap check simultaneously, flooding with 11 shorts in one cycle.
      const dirMaxReached = c.direction === "long"
        ? runningLongCount  >= dynamicMaxLong
        : runningShortCount >= dynamicMaxShort;
      const currentLongCount  = runningLongCount;
      const currentShortCount = runningShortCount;
      // ── Deleverage Reserve Gate ──────────────────────────────────────────────
      // Within DELEVERAGE_RESERVE_MINUTES of the 22:30 cutoff, keep 4 slots free
      // so the overnight downsizer can close positions without racing new entries.
      {
        const _now        = new Date();
        const _ilHour     = (_now.getUTCHours() + 3) % 24;
        const _ilMin      = _now.getUTCMinutes();
        const _ilTotal    = _ilHour * 60 + _ilMin;
        const _cutoffStr  = (warLiveConfig as any)?.deleverageCutoffTime ?? "22:30";
        const [_ch, _cm]  = _cutoffStr.split(":").map(Number);
        const _cutoffTotal = _ch * 60 + _cm;
        const _minsLeft   = _cutoffTotal - _ilTotal;
        const _inReserveWindow = _minsLeft >= 0 && _minsLeft <= DELEVERAGE_RESERVE_MINUTES;
        const _effectiveMax    = _inReserveWindow
          ? Math.max(0, dynamicMaxPos - DELEVERAGE_RESERVE_SLOTS)
          : dynamicMaxPos;
        if (_inReserveWindow && currentOpenCount >= _effectiveMax) {
          dbLog("info", "SYSTEM",
            `[DeleverageReserve] 🔒 Reserving ${DELEVERAGE_RESERVE_SLOTS} slots for 22:30 transition ` +
            `(${_minsLeft.toFixed(0)}m left) — open=${currentOpenCount} effectiveCap=${_effectiveMax}/${dynamicMaxPos} — blocking new entries`
          );
          break;
        }
      }

      if (currentOpenCount >= dynamicMaxPos || dirMaxReached) {
        dbLog("info", "SYSTEM", `[WarEngine] 🛑 MAX POSITIONS reached (${currentOpenCount}/${dynamicMaxPos} | long ${currentLongCount}/${dynamicMaxLong} short ${currentShortCount}/${dynamicMaxShort}) — stopping entries`);
        break;
      }
      if (deployedUsd >= maxAllocUsd - 4999) {
        dbLog("info", "SYSTEM", `[WarEngine] 🛑 BUDGET FULL ($${deployedUsd.toFixed(0)}/$${maxAllocUsd.toFixed(0)}) — stopping entries`);
        break;
      }

      try {
        const bars = await fetchBarsForTicker(c.ticker, 420);
        const eodClose = bars?.[bars.length - 1]?.close ?? 0;

        // ── ROOT FIX 2026-06-18: Fetch IBKR LIVE price for position sizing ────────
        // Yahoo bars are EOD / up to 7 days stale — NEVER use for intraday order sizing.
        // We now fetch a live snapshot from IBKR for the entry price, and use Yahoo EOD
        // only as a staleness check / sanity bound.
        let currentPrice = 0;
        try {
          // REPOINT 2026-06-25: the OAuth gateway 404s on /iserver/marketdata/snapshot.
          // Use the working POST /quotes pipeline (fetchIbkrLivePricesBatch) — same IBKR
          // broker-truth source the live-position poller uses; it resolves the conid for a
          // not-yet-open ticker and returns a LivePrice object (use .price). On gateway
          // failure it returns null → currentPrice stays 0 → the SKIP guard below fires.
          const priceMap = await fetchIbkrLivePricesBatch([c.ticker], { skipCache: true });
          const lp = priceMap.get(c.ticker) ?? null;
          // QA fix #2 (2026-06-25): fetchIbkrLivePricesBatch SILENTLY falls back to Yahoo (delayed
          // print) / DB daily close when IBKR can't price the ticker. Accept the price for a LIVE
          // order ONLY when it is real-time IBKR truth (source==='ibkr'); otherwise treat as NO live
          // price (0) so the "refuse to price off stale EOD" SKIP guard below fires.
          const ibkrLive = lp?.source === 'ibkr' ? Number(lp.price ?? 0) : 0;
          if (ibkrLive > 0) {
            currentPrice = ibkrLive;
            log.debug("WAR", `[LivePrice-${c.direction.toUpperCase()}] ${c.ticker} IBKR live=$${ibkrLive} (EOD was $${eodClose.toFixed(2)})`);
          }
        } catch {}

        // BUGFIX 2026-06-24: do NOT price a LIVE order off stale EOD. When the IBKR snapshot is
        // unavailable, the old code fell back to EOD → sent a non-marketable order → IBKR cancelled
        // it → orphan SL/TP brackets → endless "Order cancelled" notifications (NVMI/NFLX/ACHR loop).
        // Refuse the entry this cycle and apply a no-fill cooldown so we don't hammer the snapshot.
        if (currentPrice <= 0) {
          dbLog("warn", "SYSTEM", `[WarEngine] ⏭ ${c.ticker} — no live IBKR snapshot; skipping entry (refusing to price off stale EOD $${eodClose.toFixed(2)})`);
          markHtb(c.ticker);
          continue;
        }

        // ── PRICE GUARDS (per Iron Rule spec 2026-06-18) ──────────────────────────
        if (!currentPrice || isNaN(currentPrice) || currentPrice <= 0) {
          dbLog("warn", "SYSTEM", `[WarEngine] ⚠️ ${c.ticker} — price is NaN/0 (IBKR + EOD both failed). Skipping entry.`);
          continue;
        }
        if (currentPrice < 2.0) {
          dbLog("warn", "SYSTEM", `[WarEngine] 🚫 ${c.ticker} — price=$${currentPrice} < $2.00 (penny stock). Removing from catalog.`);
          try {
            const db = await getDb();
            if (db) {
              const { userAssets: uaTable } = await import("../drizzle/schema");
              await db.update(uaTable).set({ archived: 1 }).where(eq(uaTable.ticker, c.ticker));
            }
          } catch {}
          continue;
        }
        // QA fix #4 (2026-06-25): no bar data → no independent sanity bound for the live price.
        // Refuse the entry rather than submit a live order we cannot cross-check against EOD.
        if (eodClose <= 0) {
          dbLog("warn", "SYSTEM", `[WarEngine] ⏭ ${c.ticker} — no EOD bar data; cannot sanity-bound IBKR live $${currentPrice}. Skipping entry.`);
          continue;
        }
        // Sanity check: IBKR price vs EOD — flag if >50% divergence (possible bad snapshot)
        if (eodClose > 0 && Math.abs(currentPrice - eodClose) / eodClose > 0.50) {
          dbLog("warn", "SYSTEM", `[WarEngine] ⚠️ ${c.ticker} — IBKR live $${currentPrice} vs EOD $${eodClose.toFixed(2)} diverge >50%! Skipping.`);
          continue;
        }
        // ── PHASE-0 ANTI-CHASE HARD GATE (BUILD-spec F5; INERT until elzaIntradayWatcherEnabled=1) ──
        // Pure SUBTRACTION: a LONG whose validated live IBKR price has already run
        // > breakLevel × 1.025 (~2.5% past the prior-day Donchian-20 breakout line) is a
        // CHASED entry — the #1 stop-out cause — so BLOCK it (never widen, never size).
        // breakLevel = donchian20High × 1.005 (same constant the watcher/backtest use).
        // Fires AFTER the live price is source-gated to IBKR truth + sanity-bounded, BEFORE
        // any sizing/SL/tryLiveEntry → a block here is never a naked order. flag=0 (DEFAULT)
        // ⇒ this whole block is skipped → admission byte-identical to today. Long-only;
        // missing/<=0 donchian20High ⇒ no gate (cannot define breakLevel → never blocks).
        if (c.direction === "long" && antiChaseBlocks(currentPrice, c.donchian20High ?? 0, _intradayWatcherOn)) {
          const _breakLevel   = (c.donchian20High as number) * 1.005;
          const _antiChaseMax = _breakLevel * 1.025;
          dbLog("info", "SYSTEM",
            `[AntiChase] 🚫 ${c.ticker} LONG live $${currentPrice.toFixed(2)} > breakLevel×1.025 $${_antiChaseMax.toFixed(2)} ` +
            `(d20H $${(c.donchian20High as number).toFixed(2)} → break $${_breakLevel.toFixed(2)}) — chased breakout, blocking entry`
          );
          continue;
        }
        // ── Ziv Phase 1: authoritative zone re-check against the live IBKR price ─────
        // The scan-loop gate used the EOD close; confirm the live fill price is STILL in
        // the zone before sizing. Pre-tryLiveEntry → a skip here is never a naked order.
        if (zonesGateEnabled) {
          const _zp1 = zivP1Cache.get(c.ticker);
          const _zr = _zp1 ? evaluateZoneGate(_zp1.zones, currentPrice, c.direction) : null;
          if (!_zr || !_zr.inZone) {
            dbLog("info", "SYSTEM", `[Zones] ${c.ticker} live $${currentPrice.toFixed(2)} left ${c.direction === "long" ? "demand" : "supply"} zone — skip`);
            continue;
          }
        }
        const ema50Val = ema50FromBars(bars);
        // ── RC-2: anchor the stop at the trade's STRUCTURAL INVALIDATION ──────────
        // The role-reversed level (broken resistance→support for a long, broken
        // support→resistance for a short) is the line whose break = setup failure.
        // calcEntrySlTp puts the stop JUST PAST it (buffer = max(0.3×ATR, 0.2%)).
        // The level was computed on EOD bars off the SAME structure the scan used;
        // pricing the order off the IBKR live price (currentPrice) keeps the live
        // never-naked-SL / no-stale-price guarantees intact.
        // Ziv Phase 5 — structural TP = nearest OPPOSING zone (supply above for long / demand below
        // for short). null → legacy R-multiple TP (slCalculator floors at 2R either way). Gated OFF.
        let _structTp: number | null = null;
        if (structuralExitsEnabled) {
          const _oppZones = detectZones(bars, { trend: c.direction === "long" ? "down" : "up" });
          if (c.direction === "long") {
            _structTp = _oppZones.filter(z => z.low > currentPrice).sort((a, b) => a.low - b.low)[0]?.low ?? null;
          } else {
            _structTp = _oppZones.filter(z => z.high < currentPrice).sort((a, b) => b.high - a.high)[0]?.high ?? null;
          }
        }
        const entrySlTp = calcEntrySlTp({
          entryPrice: currentPrice,
          ema50: ema50Val,
          bars,
          direction: c.direction,
          invalidationLevel: c.invalidationLevel ?? undefined,
          structuralTpLevel: _structTp,
        });
        // RC-2: NEVER place a fabricated/flat stop. If the structural (or ATR-fallback)
        // stop implies risk > MAX_STRUCTURAL_RISK_PCT, SKIP the entry — do not enter.
        if (entrySlTp.skip) {
          dbLog("info", "SYSTEM",
            `[RC2] ${c.ticker} structural risk too large — skip (${entrySlTp.skipReason ?? ""}; ` +
            `entry $${currentPrice.toFixed(2)} stop $${entrySlTp.stopLoss.toFixed(2)} inval ${c.invalidationLevel != null ? "$" + c.invalidationLevel.toFixed(2) : "n/a"})`
          );
          continue;
        }

        // ── PER-TICKER TOTAL-EXPOSURE CAP (2026-06-25 concentration guard) ─────────
        // The existing maxPositionUsd only sizes a SINGLE new engine entry — it ignores
        // the EXISTING open position for this ticker, so engine adds + external (manual /
        // adoption) adds can stack past the cap (live: NVMI reached 231u ≈ $124k = 1.46×
        // the $85k cap). Before sizing/placing, measure the CURRENT open exposure for this
        // ticker and clamp/skip so existing + new ≤ maxPositionUsd. This cannot stop external
        // manual buys, but it stops the ENGINE from ever adding past the per-ticker cap.
        const _tkr = c.ticker.toUpperCase();
        const _maxPosUsd = (warLiveConfig as any)?.maxPositionUsd ?? 70000;
        // Prefer IBKR broker-truth position value (mktValue is signed; use magnitude).
        const _ibkrPos = ibkrLivePositions.find(
          (p: any) => (p.contractDesc ?? "").toUpperCase() === _tkr
        );
        let existingExposure = 0;
        if (_ibkrPos) {
          existingExposure = Math.abs(_ibkrPos.mktValue ?? 0);
        } else {
          // Fallback: DB livePositions row(s) for this ticker, valued at the live IBKR
          // price already fetched this iteration (currentPrice — source-gated to IBKR truth).
          const _dbUnits = openPositions
            .filter((p: any) => p.ticker.toUpperCase() === _tkr)
            .reduce((s: number, p: any) => s + Math.abs(p.units ?? 0), 0);
          existingExposure = _dbUnits * currentPrice;
        }
        const remainingForTicker = _maxPosUsd - existingExposure;
        const EXPOSURE_FLOOR = 2000; // don't bother adding a sub-$2k sliver
        if (remainingForTicker <= EXPOSURE_FLOOR) {
          dbLog("info", "SYSTEM",
            `[ExposureCap] ${_tkr} already $${Math.round(existingExposure)} ≥ max $${Math.round(_maxPosUsd)} — skipping entry`
          );
          continue;
        }

        // ── INTRA-CYCLE ClusterGuard (2026-06-26) ─────────────────────────────────
        // The SCAN-loop correlation gate only checks each candidate against the
        // PRE-EXISTING open book (shortOpenCloseMap / openCloseMap). On a cold book
        // that map is empty, so the gate is inert and a whole cohort of mutually
        // correlated candidates can ENTER as a cluster in one cycle. Re-check here,
        // INSIDE the execution loop, against the direction-map AS IT GROWS this cycle:
        // each successful entry below records its close series into its direction-map,
        // so every later candidate sees the positions opened EARLIER in this same cycle
        // and a correlated cohort is capped regardless of how empty the book started.
        // Symmetric for LONG and SHORT (Ziv: "everything for long → mirror for short").
        {
          const nc = bars.map(b => b.close);
          const dirMap = c.direction === "long" ? openCloseMap : shortOpenCloseMap;
          const hit = Array.from(dirMap.entries()).find(([, oc]) => calcCorrelation(nc, oc) > MAX_CORRELATION);
          if (hit) {
            dbLog("info", "SYSTEM",
              `[ClusterGuard] ${c.ticker} ${c.direction === "long" ? "LONG" : "SHORT"} corr ${hit[0]} > ${MAX_CORRELATION} — skip`
            );
            continue;
          }
        }

        // ── R2: institutional concentration COUNT caps (flag-gated; INERT at flag=0) ──
        // In ADDITION to ClusterGuard (both must pass): ClusterGuard bounds PAIRWISE return
        // correlation (>0.80) but never enforces a hard theme COUNT cap — four SEMIS each
        // <0.80 pairwise could all enter as a correlated cohort. At 4.0× intraday that
        // concentration is the decision_ledger's #1 lethal risk. Enforce a hard count cap on
        // the VOL_CLASS theme (correlationCap intent: SEMIS 3 / CRYPTO 2 / AI_DATA 3 /
        // NUCLEAR 2 / SPACE 2) and a per-sector cap (MAX_PER_SECTOR=3) over the CONCURRENT
        // book (open positions + this-cycle accepted). flag=0 ⇒ never runs (ClusterGuard-only).
        if (_elzaV45OnR2) {
          const _ccDecision = concentrationCapBlocks(
            c.ticker,
            _tickerSector.get(c.ticker.toUpperCase()),
            _openClassCounts,
            _openSectorCounts,
          );
          if (_ccDecision.blocked) {
            dbLog("info", "SYSTEM",
              `[${_ccDecision.guard}] ${c.ticker} ${c.direction === "long" ? "LONG" : "SHORT"} — ${_ccDecision.reason}`
            );
            continue;
          }
        }

        if (c.direction === "long") {
          // ELZA 2.0 — quality-scaled size: higher signal score → bigger position,
          // linearly within the configured [min,max] band.
          // LEVER 5 — conviction sizing: anchor the sizing floor to the SAME entry
          // gate constant (LONG_ENTRY_MIN_SCORE=7.5), not the stale 8.0 default, so
          // every admitted [7.5,8.0) entry scales by conviction instead of flat-
          // flooring at $20k. Derived from the gate constant so it cannot drift.
          const _minUsd = (warLiveConfig as any)?.minPositionUsd ?? 20000;
          const _maxUsd = (warLiveConfig as any)?.maxPositionUsd ?? 70000;
          // Conviction sizing on the COMBINED score, anchored to the combined gate
          // (8.0) so the sizing band floor tracks the entry gate (DRIFT-3 fix). When
          // kronos is OFF, combined ≤ zivStructuralCap < 8.0 → flat minPositionUsd.
          const _sizeFloor = kronosOn ? combinedGate : zivOnlyFloor;
          const _recommended = recommendedPositionSize(c.combined ?? c.finalScore, _minUsd, _maxUsd, _sizeFloor);
          const remainingBudget = maxAllocUsd - deployedUsd;
          // Clamp the new entry by the per-ticker exposure headroom (existing + new ≤ max).
          // Ziv Phase 3 — 1%-risk sizing (qty=risk/SL-dist) bounded by maxPos/leverage/heat. OFF = legacy.
          let perPosUsd: number;
          // STOP-BASIS PARITY: the EXACT wide-lung stop the share-count was sized off (CV-B
          // path only). Passed into tryLiveEntry so the broker stop + Golden-ladder rValue
          // use this same basis → perShareRisk == rValue. undefined ⇒ tryLiveEntry recomputes.
          let _ladderSizingStop: number | undefined;
          if (_elzaV45OnR2) {
            // ── CV-B — VALIDATED 1%-risk × vixMult sizing (flag=1 ALWAYS, NOT gated on
            // riskSizingEnabled). REPLACES conviction-$ for the v4.5 long path. Mirrors
            // the backtest bit-for-bit: riskDollars = NLV×0.01×vixMult (spyMult=1.0 —
            // live Defense Mode covers SPY, no ×0.5 here); perShareRisk = entry − wideLungSL;
            // shares = floor(riskDollars/perShareRisk); perPosUsd = shares × entry. The
            // size-basis stop is the SAME wideLungSL the broker order is paired with (R1
            // in tryLiveEntry). sizeFraction is INTENTIONALLY NOT consumed (CV-C) — the
            // backtest sizes BOTH tiers at 1%; wiring it would BREAK Live==Backtest.
            // FAIL CLOSED on VIX>35 / non-finite VIX / perShareRisk≤0 → skip (no entry).
            let _sizeStop: number;
            try {
              _sizeStop = elzaWideLungSL(currentPrice, ema50Val, "long");
            } catch (e) {
              dbLog("warn", "SYSTEM", `[VixSize] ${_tkr} wideLungSL threw — failing closed (no entry): ${String(e).slice(0, 80)}`);
              continue;
            }
            const _vs = vixRiskSize({ nlv: Number(warLiveConfig?.totalNlv) || 0, entry: currentPrice, stop: _sizeStop, vix: regime.vixProxy });
            if (_vs.skip) { dbLog("info", "SYSTEM", `[VixSize] ${_tkr} LONG skip — ${_vs.reason}`); continue; }
            // ── SSOT PASS-THROUGH: the EXACT wide-lung stop the share-count was sized off.
            // This is the ONE number — computed ONCE here off (scan currentPrice, 420-bar
            // ema50FromBars) — that the broker bracket SL, the persisted rValue, and the
            // Golden exit ladder all derive from. Threaded into tryLiveEntry below so the
            // executor uses it VERBATIM (no recompute, no second 90-bar ema50). perShareRisk
            // (sizing) == rValue (broker+ladder) becomes an algebraic identity.
            _ladderSizingStop = _sizeStop;
            // Keep ALL existing clamps: maxPositionUsd (via remainingForTicker headroom),
            // remaining budget, per-ticker exposure headroom, and the $5000 min-order floor.
            perPosUsd = Math.min(_vs.perPosUsd, remainingBudget, remainingForTicker);
            dbLog("info", "SYSTEM", `[VixSize] ${_tkr} LONG 1%-risk×${_vs.vixMult} → ${_vs.shares}sh $${Math.round(_vs.perPosUsd)} (clamped $${Math.round(perPosUsd)}, perShareRisk $${_vs.perShareRisk.toFixed(2)})`);
          } else if (riskSizingEnabled) {
            const _rs = computeRiskSizedQty({
              nlv: Number(warLiveConfig?.totalNlv) || 0, entryPrice: currentPrice, slPrice: entrySlTp.stopLoss,
              direction: "long", maxPositionUsd: _maxPosUsd, minOrderUsd: 5000,
              leverageCapUsd: Math.min(remainingBudget, remainingForTicker), openHeatUsd: zivOpenHeatUsd, heatMaxPct: heatMaxPctCfg,
            });
            if (_rs.skip) { dbLog("info", "SYSTEM", `[RiskSize] ${_tkr} skip — ${_rs.reason}`); continue; }
            perPosUsd = _rs.usd;
            dbLog("info", "SYSTEM", `[RiskSize] ${_tkr} LONG 1%-risk $${Math.round(_rs.plannedRiskUsd)} → $${Math.round(_rs.usd)} (heat→${(_rs.heatPctAfter * 100).toFixed(1)}%, ${_rs.reason})`);
          } else {
            perPosUsd = Math.min(Math.max(_recommended, 5000), remainingBudget, remainingForTicker);
          }
          // If the exposure clamp pushed the order under the $5000 min-order floor, SKIP
          // rather than place a sub-floor order.
          if (perPosUsd < 5000) {
            dbLog("info", "SYSTEM",
              `[ExposureCap] ${_tkr} headroom $${Math.round(remainingForTicker)} (existing $${Math.round(existingExposure)} / max $${Math.round(_maxPosUsd)}) < $5000 min-order — skipping entry`
            );
            continue;
          }
          // Ledger-fix: build + log the structural snapshot BEFORE entry, persist it on the row.
          const _routeL = c.finalScore >= 9 ? "GOLD_BREAKOUT_WAR" : "GOLD_RETEST_WAR";
          const _metaL = logZivMeta(c.ticker, "long", currentPrice, _routeL);
          const result = await tryLiveEntry({
            userId,
            ticker: c.ticker,
            direction: "long",
            signal: _routeL,
            zivScore: c.finalScore,
            currentPrice,
            slPrice: entrySlTp.stopLoss,
            tpPrice: entrySlTp.takeProfit,
            positionSizeUsd: perPosUsd,
            entryStructMeta: _metaL,
            // SSOT PASS-THROUGH (flag=1 long only): the EXACT wide-lung stop + its scan
            // entry the share-count was sized off. tryLiveEntry uses these VERBATIM as the
            // broker stop + Golden rValue basis → no broker-hand-off recompute. undefined
            // on every other path (legacy / non-warEngine callers) ⇒ executor recomputes.
            sizingStop: _ladderSizingStop,
            sizingEntryPrice: _ladderSizingStop !== undefined ? currentPrice : undefined,
          });
          if (result.entered) {
            entered++;
            currentOpenCount++; // keep real-time count in sync
            // ── FIXED (2026-06-22): increment direction counters too ──
            if (c.direction === "long")  runningLongCount++;
            else                          runningShortCount++;
            enteredLongThisCycle.add(c.ticker.toUpperCase());
            deployedUsd += perPosUsd; // track running capital
            openCloseMap.set(c.ticker, bars.map(b => b.close));
            if (_elzaV45OnR2) {
              // R2: this entry joins the concurrent book — bump the theme/sector tallies so
              // a later candidate THIS cycle is capped against names opened earlier.
              const _clsL = classifyTicker(c.ticker);
              if (_clsL !== "OTHER") _openClassCounts.set(_clsL, (_openClassCounts.get(_clsL) ?? 0) + 1);
              const _secL = _tickerSector.get(c.ticker.toUpperCase());
              if (_secL) _openSectorCounts.set(_secL, (_openSectorCounts.get(_secL) ?? 0) + 1);
            }
            dbLog("info", "SYSTEM",
              `[WarEngine] ✅ LONG ${c.ticker} @ $${currentPrice.toFixed(2)} score=${c.finalScore.toFixed(2)} ` +
              `[base=${c.baseScore.toFixed(1)} mentor=+${c.mentorBonus.toFixed(2)}] LIVE Elza ` +
              (c.mentorReasons.length ? `Patterns: ${c.mentorReasons.join(" | ")}` : "")
            );
          } else {
            dbLog("warn", "SYSTEM", `[WarEngine] ❌ LONG ${c.ticker} rejected: ${result.reason}`);
          }

        } else {
          // ELZA 2.0 — quality-scaled size: higher signal score → bigger position,
          // linearly within the configured [min,max] band.
          // LEVER 5 — conviction sizing: anchor the sizing floor to SHORT_ENTRY_MIN_SCORE
          // (7.5, the same constant the SHORT gate uses) so [7.5,8.0) shorts scale by
          // conviction instead of flat-flooring at $20k. Derived from the gate constant.
          const _minUsd = (warLiveConfig as any)?.minPositionUsd ?? 20000;
          const _maxUsd = (warLiveConfig as any)?.maxPositionUsd ?? 70000;
          // Conviction sizing on the COMBINED score, anchored to the combined gate
          // (8.0). Kronos OFF → combined ≤ cap < 8.0 → flat minPositionUsd. Symmetric to LONG.
          const _sizeFloor = kronosOn ? combinedGate : zivOnlyFloor;
          const _recommended = recommendedPositionSize(c.combined ?? c.finalScore, _minUsd, _maxUsd, _sizeFloor);
          const remainingBudget = maxAllocUsd - deployedUsd;
          // Clamp the new entry by the per-ticker exposure headroom (existing + new ≤ max).
          // Ziv Phase 3 — 1%-risk sizing (symmetric mirror of LONG). OFF = legacy.
          let perPosUsd: number;
          if (riskSizingEnabled) {
            const _rs = computeRiskSizedQty({
              nlv: Number(warLiveConfig?.totalNlv) || 0, entryPrice: currentPrice, slPrice: entrySlTp.stopLoss,
              direction: "short", maxPositionUsd: _maxPosUsd, minOrderUsd: 5000,
              leverageCapUsd: Math.min(remainingBudget, remainingForTicker), openHeatUsd: zivOpenHeatUsd, heatMaxPct: heatMaxPctCfg,
            });
            if (_rs.skip) { dbLog("info", "SYSTEM", `[RiskSize] ${_tkr} skip — ${_rs.reason}`); continue; }
            perPosUsd = _rs.usd;
            dbLog("info", "SYSTEM", `[RiskSize] ${_tkr} SHORT 1%-risk $${Math.round(_rs.plannedRiskUsd)} → $${Math.round(_rs.usd)} (heat→${(_rs.heatPctAfter * 100).toFixed(1)}%, ${_rs.reason})`);
          } else {
            perPosUsd = Math.min(Math.max(_recommended, 5000), remainingBudget, remainingForTicker);
          }
          // If the exposure clamp pushed the order under the $5000 min-order floor, SKIP
          // rather than place a sub-floor order.
          if (perPosUsd < 5000) {
            dbLog("info", "SYSTEM",
              `[ExposureCap] ${_tkr} headroom $${Math.round(remainingForTicker)} (existing $${Math.round(existingExposure)} / max $${Math.round(_maxPosUsd)}) < $5000 min-order — skipping entry`
            );
            continue;
          }
          // Ledger-fix: build + log the structural snapshot BEFORE entry, persist it on the row.
          const _routeS = c.finalScore >= 9 ? "BEAR_WAR_BREAKDOWN" : "BEAR_WAR_RETEST";
          const _metaS = logZivMeta(c.ticker, "short", currentPrice, _routeS);
          const result = await tryLiveEntry({
            userId,
            ticker: c.ticker,
            direction: "short",
            signal: _routeS,
            zivScore: c.finalScore,
            currentPrice,
            slPrice: entrySlTp.stopLoss,
            tpPrice: entrySlTp.takeProfit,
            positionSizeUsd: perPosUsd,
            entryStructMeta: _metaS,
          });
          if (result.entered) {
            entered++;
            currentOpenCount++;
            runningShortCount++; // ── BUGFIX (2026-06-22): short branch never incremented → dynamicMaxShort cap unenforced (flood risk). Completes the long-only refactor.
            enteredShortThisCycle.add(c.ticker.toUpperCase());
            deployedUsd += perPosUsd;
            // BUGFIX (2026-06-26): SHORT entry must record into the SHORT map, not the
            // LONG openCloseMap — feeds the intra-cycle ClusterGuard for later shorts.
            shortOpenCloseMap.set(c.ticker, bars.map(b => b.close));
            if (_elzaV45OnR2) {
              // R2: symmetric to LONG — concentration is direction-agnostic (a correlated
              // cluster gaps together whether held long or short), so shorts tally too.
              const _clsS = classifyTicker(c.ticker);
              if (_clsS !== "OTHER") _openClassCounts.set(_clsS, (_openClassCounts.get(_clsS) ?? 0) + 1);
              const _secS = _tickerSector.get(c.ticker.toUpperCase());
              if (_secS) _openSectorCounts.set(_secS, (_openSectorCounts.get(_secS) ?? 0) + 1);
            }
            dbLog("info", "SYSTEM",
              `[WarEngine] 🩳 SHORT ${c.ticker} @ $${currentPrice.toFixed(2)} score=${c.finalScore.toFixed(2)} LIVE Elza ` +
              (c.mentorReasons.length ? `Patterns: ${c.mentorReasons.join(" | ")}` : "")
            );
          } else {
            dbLog("warn", "SYSTEM", `[WarEngine] ❌ SHORT ${c.ticker} rejected: ${result.reason}`);
          }
        }
      } catch (e) {
        dbLog("warn", "SYSTEM", `[WarEngine] Entry error ${c.ticker}: ${String(e).slice(0,80)}`);
      }
      } finally {
        // R1 cross-pipeline lock: release the shared entry-slot lock on EVERY exit of this
        // candidate iteration (normal fall-through, continue, break, or thrown error). Only
        // ever held on the long-retest path at waiterEnabled=1 → no-op (byte-identical) at flag=0.
        if (_waiterLockHeld) releaseEntrySlot(_warLockHolder);
      }
    }

    // ── Cycle end summary ─────────────────────────────────────────────────────
    log.info("WAR_ENGINE",
      `Cycle complete. Entered: ${entered} | Open now: ${currentOpenCount} | Budget used: $${deployedUsd.toFixed(0)} / $${maxAllocUsd.toFixed(0)}`,
      { entered, openCount: currentOpenCount, deployedUsd, maxAllocUsd }
    );

    // ── Funnel telemetry (2026-06-25) — MEASURE the entry funnel instead of modeling it.
    // Bucket every scan's blockReason (already computed above) into a per-gate counter,
    // for LONG and SHORT, so the cycle-done log shows WHERE the book is being whittled.
    const classifyGate = (reason?: string): string => {
      if (!reason) return "other";
      if (reason.startsWith("score "))        return "score";
      // Two highest-volume gates: ZIV-conviction floor and combined-conviction floor.
      // These previously fell through to the "cyc" catch-all, inflating cyc and pinning
      // score=0 (the "score " prefix is never emitted) — a real mis-diagnosis of "no buys".
      if (reason.startsWith("ziv "))          return "ziv";
      if (reason.startsWith("combined "))     return "combined";
      if (reason.startsWith("confluence "))   return "confl";
      if (reason.startsWith("liquidity "))    return "liq";
      if (reason.startsWith("weekly EMA-50")) return "weekly";
      if (reason.startsWith("correlation "))  return "corr";
      if (reason.startsWith("already open"))  return "open";
      if (reason.startsWith("signal_bias"))   return "slang";
      if (reason.startsWith("[GoldBreakout OFF]")) return "gbOff";
      if (reason.startsWith("[Breakdown OFF]"))    return "gbOff";
      if (reason.startsWith("[Zones]"))            return "zone";
      if (reason.startsWith("[Retest]"))           return "retest";
      if (reason.startsWith("weekly-anchor:"))     return "wkAnchor";
      // CYC-L1/S1 cycle-phase block — reason text comes from cyc.reason (no fixed prefix)
      return "cyc";
    };
    const tallyFunnel = (dir: "long" | "short") => {
      const f: Record<string, number> = { score: 0, ziv: 0, combined: 0, confl: 0, liq: 0, weekly: 0, cyc: 0, open: 0, corr: 0, slang: 0, gbOff: 0, zone: 0, retest: 0, wkAnchor: 0, other: 0 };
      let enter = 0, scannedDir = 0;
      for (const s of allScans) {
        if (s.direction !== dir) continue;
        scannedDir++;
        if (s.action === "ENTER") { enter++; continue; }
        f[classifyGate(s.blockReason)]++;
      }
      return { f, enter, scannedDir };
    };
    const fl = tallyFunnel("long");
    const fs = tallyFunnel("short");
    dbLog("info", "SYSTEM",
      `[Funnel] LONG scanned=${fl.scannedDir} score=${fl.f.score} ziv=${fl.f.ziv} combined=${fl.f.combined} confl=${fl.f.confl} liq=${fl.f.liq} weekly=${fl.f.weekly} wkA=${fl.f.wkAnchor} zone=${fl.f.zone} retest=${fl.f.retest} cyc=${fl.f.cyc} open=${fl.f.open} corr=${fl.f.corr} slang=${fl.f.slang} gbOff=${fl.f.gbOff} → ENTER=${fl.enter} | SHORT scanned=${fs.scannedDir} score=${fs.f.score} ziv=${fs.f.ziv} combined=${fs.f.combined} liq=${fs.f.liq} weekly=${fs.f.weekly} wkA=${fs.f.wkAnchor} zone=${fs.f.zone} retest=${fs.f.retest} cyc=${fs.f.cyc} open=${fs.f.open} corr=${fs.f.corr} → ENTER=${fs.enter}`
    );

    const heldLongForPreview = new Set<string>([...enteredLongThisCycle]);
    const heldShortForPreview = new Set<string>([...enteredShortThisCycle]);
    for (const p of openPositions) {
      const t = p.ticker.toUpperCase();
      if (p.direction === "short") heldShortForPreview.add(t);
      else heldLongForPreview.add(t);
    }
    for (const p of ibkrLivePositions) {
      const t = ((p as any).contractDesc ?? (p as any).ticker ?? "").toUpperCase();
      if (!t || (p as any).position === 0) continue;
      if ((p as any).position > 0) heldLongForPreview.add(t);
      else heldShortForPreview.add(t);
    }

    const topCandidates = filterOpenFromUpcoming(
      allScans
        .filter(s => s.finalScore >= 6)
        .sort((a, b) => b.finalScore - a.finalScore),
      { heldLong: heldLongForPreview, heldShort: heldShortForPreview },
    ).slice(0, 20);   // owner 2026-06-30: candidate list 10→20

    // ── War Room v4.5 DISPLAY: LONG-ONLY candidates list ──────────────────────────
    // The War Room candidates table shows LONG candidates only. SHORTs are removed
    // from the DISPLAY payload here. ⚠️ DISPLAY-ONLY — short POSITION MANAGEMENT
    // (the live engine managing an open short, e.g. the existing TTD short) is
    // entirely separate and is NOT affected by this filter.
    const topLongCandidates = topCandidates.filter((c: any) => c.direction !== "short");

    // ── Persist top candidates for the War Room "Upcoming Candidates" preview (read by getStatus) ──
    _emit(85, "שומר תוצאות…");
    try {
      const _db = await getDb();
      if (_db) {
        const { systemSettings } = await import("../drizzle/schema");
        const _csMin = (warLiveConfig as any)?.minPositionUsd ?? 20000;
        const _csMax = (warLiveConfig as any)?.maxPositionUsd ?? 70000;
        // ── Kronos DISPLAY enrichment (2026-06-25) ──────────────────────────────────
        // Surface the kronos conviction scores in the candidate data for UI VALIDATION,
        // INDEPENDENT of gating. The per-scan convictionAddon is 0 whenever weight=0 (the
        // read helper snaps it), so for DISPLAY we re-read the cache directly and re-map
        // per-direction here. This shows real addons in DISPLAY mode (kronosComputeEnabled=1,
        // weight=0) where the gate path intentionally sees addon 0. Tiny set (≤10 tickers),
        // never throws (loadKronosConvictionCache returns empty map on failure).
        const _candTickers = topLongCandidates.map((c: any) => String(c.ticker ?? "").toUpperCase());
        const _displayCache = await loadKronosConvictionCache(_candTickers);
        const _staleMin = cfgKv?.kronosStalenessMin ?? 90;
        const items = topLongCandidates.map((c: any) => {
          const dir: TradeDir = c.direction === "short" ? "short" : "long";
          // zivStructural = the ≤7.5 structural leg (falls back to finalScore-derived if absent).
          const ziv = +Number(c.zivStructural ?? c.finalScore ?? 0).toFixed(2);
          // DISPLAY addon: re-map the fresh cache row per-direction (veto → 0), regardless of weight.
          const _row = _displayCache.get(String(c.ticker ?? "").toUpperCase());
          let kronosAddon: number | null = null;
          let kronosComputedAt: string | null = null;
          if (_row && _row.computedAt != null) {
            const _ageMs = Date.now() - new Date(_row.computedAt).getTime();
            const _pct = Number(_row.rawForecastPct);
            const _band = Number(_row.bandWidthPct);
            // Only surface a FRESH row's addon (same staleness window the gate honours).
            if (_ageMs <= _staleMin * 60_000 && Number.isFinite(_pct) && Number.isFinite(_band)) {
              const m = mapKronosAddon(_pct, _band, dir);
              kronosAddon = +(m.veto ? 0 : m.addon).toFixed(2);
              kronosComputedAt = new Date(_row.computedAt).toISOString();
            }
          }
          // combined = ziv + addon when an addon exists, else = ziv (no kronos contribution).
          const combined = +(kronosAddon != null ? ziv + kronosAddon : ziv).toFixed(2);
          // ── War Room v4.5 decision-data (DISPLAY-ONLY) — merged from the scan-loop
          // SSOT cache. Null-safe: if the cache miss (e.g. <50 bars / enrichment fault)
          // we surface neutral zero-readiness defaults so the UI shape never breaks.
          const _v45 = v45CandCache.get(String(c.ticker ?? "").toUpperCase());
          const v45Route: V45CandMeta["route"] =
            _v45?.route ?? (Number(c.finalScore) >= 9 ? "GOLD_BREAKOUT_WAR" : "GOLD_RETEST_WAR");
          const v45Tier = _v45?.tier ?? null;
          const v45Score = _v45?.score ?? {
            base: +Number(c.baseScore ?? 0).toFixed(2),
            subTotal: +Number((Number(c.finalScore ?? 0) - Number(c.baseScore ?? 0))).toFixed(2),
            total: +Number(c.finalScore ?? 0).toFixed(2),
          };
          const distanceToTriggerPct = _v45?.distanceToTriggerPct ?? 0;
          const readinessPct = _v45?.readinessPct ?? 0;
          const v45BlockReason = _v45?.blockReason ?? null;
          const abnormalCycle = _v45?.abnormalCycle ?? false;
          const macroBlocked = _v45?.macroBlocked ?? false;
          return {
            ticker: c.ticker,
            // LONG-ONLY display payload — shorts are filtered out upstream.
            direction: "long",
            route: v45Route,
            tier: v45Tier,
            distanceToTriggerPct,
            readinessPct,
            abnormalCycle,
            macroBlocked,
            // Phase-0 armed-watcher (F3): prior-day Donchian-20 high, persisted so the
            // watcher reads breakLevel = donchian20High × 1.005 with NO new bars fetch.
            donchian20High: c.donchian20High ?? null,
            // THE WAITER (retest resting-LMT): the STRUCTURAL retest level (broken
            // resistance now acting as support — True Retest priorBreakoutLevel, else
            // Role-Reversal level) the resting LMT rests at, + the EMA-50 stop floor.
            // The Waiter ambushes at retestLevel (NOT EMA20×1.005); null ⇒ no Waiter LMT.
            retestLevel: (c as any).invalidationLevel ?? null,
            ema50: (c as any).ema50 ?? null,
            score: +Number(c.finalScore ?? 0).toFixed(2),
            scoreBreakdown: v45Score, // { base, subTotal, total } — SSOT genesisScore
            // ── Kronos conviction scores (DISPLAY/validation; null = no fresh cache row) ──
            ziv,                 // zivStructural (≤7.5 structural leg) — API field name is `ziv`
            kronosAddon,         // 0..2.5 from the cache (this direction), or null if no fresh row
            combined,            // ziv + addon, or = ziv when no addon
            kronosComputedAt,    // cache row timestamp (ISO), or null
            signal: Number(c.finalScore) >= 9 ? "Breakout" : "Retest",
            status: (c.action === "ENTER" && Number(c.finalScore) >= LONG_ENTRY_MIN_SCORE) ? "Approved" : "Pending",
            // ELZA 2.0 — recommended size by signal quality (within [min,max] band).
            // LEVER 5 — LONG sizing floor (same constant the live gate uses) so the
            // preview matches the live size and [7.5,8.0) no longer flat-floors.
            sizeUsd: recommendedPositionSize(
              Number(c.finalScore ?? 0), _csMin, _csMax, LONG_ENTRY_MIN_SCORE,
            ),
            // v4.5 SINGLE binding wall (Hebrew-friendly short form), null when entry-ready.
            blockReason: v45BlockReason,
            // legacy raw near-miss reason kept for back-compat (undefined for ENTER rows).
            blockReasonRaw: c.blockReason ?? undefined,
            // Ziv Phase 1 — weekly-state + zone-status for the candidates table columns.
            weeklyState: c.weeklyState ?? null,
            zoneStatus: c.zoneStatus ?? null,
          };
        });
        const value = JSON.stringify({ ts: Date.now(), items });
        await _db.insert(systemSettings).values({ key: "war_upcoming_signals", value } as any)
          .onDuplicateKeyUpdate({ set: { value } });
      }
    } catch (e) { dbLog("warn", "SYSTEM", `[Upcoming] persist failed: ${String(e).slice(0,80)}`); }

    // ── Persist THIS cycle's participation breadth (read by NEXT cycle's gate, §1.3) ──
    // breadthPctBelow200 = (# universe names below their EMA-200) / (# scored). Cold
    // start (no scored names) → leave the prior persisted value untouched.
    try {
      if (breadthScored > 0) {
        const _bdb = await getDb();
        if (_bdb) {
          const { systemSettings } = await import("../drizzle/schema");
          const _bpct = breadthBelow200Count / breadthScored;
          const _bval = JSON.stringify({
            breadthPctBelow200: +_bpct.toFixed(4),
            below: breadthBelow200Count, scored: breadthScored,
            computedAt: new Date().toISOString(),
          });
          await _bdb.insert(systemSettings).values({ key: "war_breadth", value: _bval } as any)
            .onDuplicateKeyUpdate({ set: { value: _bval } });
        }
      }
    } catch (e) { dbLog("warn", "SYSTEM", `[Breadth] persist failed: ${String(e).slice(0,80)}`); }

    _emit(100, "הושלם");
    dbLog("info", "SYSTEM",
      `[WarEngine] 🏁 Done — scanned=${scanned} entered=${entered} managed=${managed} skipped=${skipped} | regime=${regime.regime} | breadth ${breadthScored > 0 ? ((breadthBelow200Count / breadthScored) * 100).toFixed(0) + "%<200" : "n/a"}`
    );

    return { scanned, entered, managed, skipped, regimeDecision: regimeStr, topCandidates, liveSignals: topCandidates.filter(c => c.action === 'ENTER' && c.finalScore >= LONG_ENTRY_MIN_SCORE).map(c => ({ ticker: c.ticker, direction: c.direction, signal: 'WAR_ENGINE', zivScore: c.finalScore, currentPrice: 0, slPrice: 0, tpPrice: 0, positionSizeUsd: 0 })) };

  } finally {
    _warRunning = false;
  }
}

// ─── Position Management ──────────────────────────────────────────────────────
async function manageOpenPositions(
  userId: number,
  openPositions: typeof livePositions.$inferSelect[],
  db: Awaited<ReturnType<typeof getDb>>,
  config?: typeof liveEngineConfigTable.$inferSelect | null,
): Promise<number> {
  // ── Iron Rule: SL and TP are IBKR-native orders. ──────────────────────────
  // The WarEngine does NOT manage exits — IBKR STP/LMT orders handle that.
  // ibkrSync detects fills and updates DB status.
  // This function ONLY updates DB scores / break-even SL price reference.
  if (!db || openPositions.length === 0) return 0;
  let actions = 0;

  for (const pos of openPositions) {
    try {
      const currentPrice = pos.currentPrice ?? pos.entryPrice;
      const entry  = pos.entryPrice;
      const sl     = pos.currentSl ?? pos.initialSl;
      const isShort = pos.direction === "short";

      const profitR = sl && Math.abs(entry - sl) > 0
        ? (isShort
            ? (entry - currentPrice) / Math.abs(entry - sl)
            : (currentPrice - entry) / Math.abs(entry - sl))
        : 0;

      // ── Break-even: update DB reference SL (informational only) ──────────
      // Note: actual IBKR STP order modification via /orders/{id} modify
      // is NOT done here to avoid excessive API calls. The enforcement agent's
      // broker-push reconciles this DB intent to IBKR. We only own the DB intent.
      // LEVER 4(a) — SHORT parity: a short's break-even moves the stop DOWN as
      // price falls (mirror of the long logic, sign-flipped). LONG → just above
      // entry (entry*1.002); SHORT → just below entry (entry*0.998).
      if (profitR >= BREAKEVEN_TRIGGER_R && (pos.slMovedToBreakEven ?? 0) === 0) {
        const newSl = +(entry * (isShort ? 0.998 : 1.002)).toFixed(2); // BE just beyond entry, direction-aware
        // Monotonicity guard: a break-even stop must only TIGHTEN, never loosen.
        // LONG raises the stop (newSl > existing); SHORT lowers it (newSl < existing).
        const tightens = sl == null
          ? true
          : (isShort ? newSl < sl : newSl > sl);
        if (tightens) {
          await db.update(livePositions).set({
            currentSl: newSl,
            slMovedToBreakEven: 1,
          }).where(eq(livePositions.id, pos.id));
          log.info("WAR_ENGINE",
            `[BreakEven] ${pos.ticker} (${isShort ? "SHORT" : "LONG"}) DB SL updated to $${newSl.toFixed(2)} (${profitR.toFixed(1)}R in profit). Enforcement agent pushes to IBKR STP.`,
            { ticker: pos.ticker, newSl, profitR, isShort, ibkrSlOrderId: pos.ibkrSlOrderId }
          );
          actions++;
        }
      }

      // ── G1-D: Ghost Slots single hook (+1.5R, IBKR-SL broker-verified) ──────────
      // INERT when ghostSlotsEnabled=0 (returns before any broker read / DB write →
      // byte-identical). When ON it re-READS IBKR /orders (G1-A fail-closed) and only
      // then frees the slot (slotGhost=1, countsTowardSlot=0). It does NOT touch the
      // exit ladder (Golden 2.5R / Open-Skies 2R stay separate — LIVE_OPS_OVERLAY) and
      // it never frees margin (G1-B). currentSl reflects the just-applied BE move.
      // Reflect this cycle's BE move in the hook view (the in-memory `pos` is stale after
      // the DB update above). When the BE move already happened on a prior cycle, the DB
      // row already carries slMovedToBreakEven=1 + currentSl@BE, so the hook fires then too.
      const _beView = (profitR >= BREAKEVEN_TRIGGER_R)
        ? { ...(pos as any), slMovedToBreakEven: 1, currentSl: +(entry * (isShort ? 0.998 : 1.002)).toFixed(2) }
        : (pos as any);
      await onBreakevenConfirmed(_beView, config ?? null);

    } catch (e) {
      log.warn("WAR_ENGINE", `Manage error ${pos.ticker}: ${String(e).slice(0,100)}`);
    }
  }
  return actions;
}

// ─── TRPC Endpoint helper ─────────────────────────────────────────────────────
export function getWarEngineStatus() {
  return {
    running:    _warRunning,
    lastCycleAt: _lastWarCycleAt,
    version:    WAR_ENGINE_VERSION,
    elzaRealizedPnl: 0, // populated by insights router from liveTrades
  };
}

