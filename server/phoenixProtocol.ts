/**
 * phoenixProtocol.ts — Phoenix Protocol P-S0/P-S1 (BUILD-spec 2026-06-29 §3 + ADRs P1-P3).
 *
 * Phoenix = a same-day lifecycle EXCEPTION. When a Gold-Breakout / FULL-break entry is
 * stopped out by a true Wide-Lung stop, then reclaims the frozen breakout line on a 5m
 * close intraday, the protocol allows EXACTLY ONE re-entry — sized as a brand-new 1%-risk
 * position (vixRiskSize) off the live reclaim entry + a fresh wide-lung stop, capped at
 * originQty × phoenixQtyCapMult so a tight reclaim stop cannot blow the size up.
 *
 * ── THE INERT INVARIANT (non-negotiable) ─────────────────────────────────────────
 * `phoenixProtocolEnabled` defaults to 0. When 0:
 *   • writePhoenixEligibility() returns before any DB write (no ledger row ever appears).
 *   • runPhoenixWatcherTick() returns before any fetch/DB read/order.
 * → runtime byte-identical to today, and the Phoenix watcher is NEVER on the war-20m scan.
 *
 * ── ANTI-LOOP = DB-PERSISTED (non-negotiable) ────────────────────────────────────
 * Every anti-loop guard is read from `phoenixLedger` (NOT in-memory) because the engine
 * restarts constantly; an in-memory counter would reset → unbounded re-entries:
 *   ≤1 / ticker / day, ≤3 / account / day, 30-min cooldown after a phoenix stop, and
 *   BLOCKED while a ghost is open on the same ticker. Checked ATOMICALLY before the order.
 *
 * ── SIZING GUARD (non-negotiable) ────────────────────────────────────────────────
 * qty ≤ originQty × phoenixQtyCapMult(1.25); reject a degenerate entry==stop
 * (perShareRisk ≈ 0) — no /0, no ∞-qty. The cap binds BEFORE the order.
 *
 * ── CONCURRENCY ──────────────────────────────────────────────────────────────────
 * The watcher acquires the SHARED entrySlotLock so it cannot double-fire into the same
 * freed slot as the war cycle / Armed-Watcher.
 */

import { getDb } from "./db";
import { phoenixLedger, livePositions, type LiveEngineConfig } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { vixRiskSize, wideLungSL } from "./engine/elzaV45Master";
import { ema50FromBars } from "./slCalculator";
import { getLiveConfig, tryLiveEntry } from "./liveOrderExecutor";
import { fetchIntradayBarsForTicker, filterRegularSession, type IntradayBar } from "./intradayMarketData";
import { fetchBarsForTicker, fetchIbkrLivePricesBatch } from "./marketData";
import { tryAcquireEntrySlot, releaseEntrySlot } from "./entrySlotLock";
import { getMarketRegime } from "./runtimeIntelligence";
import { dbLog } from "./persistentLogger";
import { log } from "./logger";

// ── Constants (spec §3.2/§3.3/§3.4, pinned + backtestable) ───────────────────────
/** P1: only these origin signals may arm Phoenix (ADR-P3 FULL break only). */
export const PHOENIX_ELIGIBLE_SIGNALS = new Set(["GOLD_BREAKOUT_WAR", "ARMED_FULL_BREAK"]);
/** P3: a true Wide-Lung stop closed at/below initialSl × this (long) / above × (2−this) (short). */
export const WIDE_LUNG_STOP_MULT = 1.002;
/** breakoutLine = donchian20High × 0.995 (frozen at origin, P4). */
export const BREAKOUT_LINE_MULT = 0.995;
/** 30-min cooldown after a phoenix stop (ms). */
export const PHOENIX_COOLDOWN_MS = 30 * 60_000;
/** Cached 5m bars TTL (ADR-P2) — rate-limit safe. */
export const PHOENIX_BAR_TTL_MS = 60_000;

// ── Flag reader — same shape/source as every other live flag ─────────────────────
export function isPhoenixEnabled(config: LiveEngineConfig | null | undefined): boolean {
  return ((config as any)?.phoenixProtocolEnabled ?? 0) === 1;
}

/** Israel-time YYYY-MM-DD date key (per-day anti-loop key; matches the watcher reset). */
export function israelDateKey(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// ── PURE: Wide-Lung-stop eligibility (P2/P3) ─────────────────────────────────────
/**
 * isPhoenixWideLungStop — was THIS close a true Wide-Lung stop on an eligible breakout?
 * P1 signal ∈ eligible set, P2 exitReason a STOP (not manual/TP), P3 exitPrice within
 * 0.2% of the initial structural stop. Direction-aware. Pure; FAIL-CLOSED on bad inputs.
 */
export function isPhoenixWideLungStop(pos: {
  signal?: string | null; direction?: string | null; exitReason?: string | null;
  exitPrice?: number | null; initialSl?: number | null;
}): boolean {
  const sig = String(pos.signal ?? "").toUpperCase();
  if (!PHOENIX_ELIGIBLE_SIGNALS.has(sig)) return false;
  const reason = String(pos.exitReason ?? "").toUpperCase();
  // P2: a STOP exit only — never a TP, manual close, or P&L-UNKNOWN/cancel.
  if (!(reason.includes("SL") || reason.includes("STOP"))) return false;
  if (reason.includes("NO_PRICE") || reason.includes("MANUAL")) return false;
  const exit = Number(pos.exitPrice) || 0;
  const initSl = Number(pos.initialSl) || 0;
  if (!(exit > 0) || !(initSl > 0)) return false;
  const isShort = pos.direction === "short";
  // P3: true wide-lung — stopped at/through the initial structural stop (not a tighter exit).
  return isShort
    ? exit >= initSl * (2 - WIDE_LUNG_STOP_MULT)
    : exit <= initSl * WIDE_LUNG_STOP_MULT;
}

// ── PURE: 5m reclaim (P4) ────────────────────────────────────────────────────────
/**
 * is5mReclaimAbove — the last closed 5m RTH bar of the current session closes ABOVE
 * the frozen breakoutLine (long) / BELOW (short). FAIL-CLOSED: missing bars / no
 * session bars ⇒ false. Mirrors the armed-watcher's is5mHoldConfirmed structure.
 */
export function is5mReclaimAbove(
  bars: IntradayBar[],
  breakoutLine: number,
  isShort: boolean,
): { reclaimed: boolean; reclaimClose: number | null; reason: string } {
  if (!(breakoutLine > 0)) return { reclaimed: false, reclaimClose: null, reason: "no breakoutLine" };
  const rth = filterRegularSession(bars);
  if (!rth.length) return { reclaimed: false, reclaimClose: null, reason: "no 5m bars" };
  const sessions = [...new Set(rth.map((b) => b.date))].sort();
  const today = sessions[sessions.length - 1];
  const todayBars = rth.filter((b) => b.date === today);
  if (!todayBars.length) return { reclaimed: false, reclaimClose: null, reason: "no session bars" };
  const lastClose = todayBars[todayBars.length - 1].close;
  const ok = isShort ? lastClose < breakoutLine : lastClose > breakoutLine;
  if (!ok) {
    return { reclaimed: false, reclaimClose: lastClose, reason: `5m close ${lastClose.toFixed(2)} not reclaimed vs ${breakoutLine.toFixed(2)}` };
  }
  return { reclaimed: true, reclaimClose: lastClose, reason: `5m close ${lastClose.toFixed(2)} reclaimed ${breakoutLine.toFixed(2)}` };
}

// ── PURE: sizing (ADR-P1 1%-recalc + origin-qty cap) ─────────────────────────────
export interface PhoenixSizeInput {
  nlv: number;
  entry: number;          // live reclaim close
  stop: number;           // fresh wide-lung stop off the reclaim entry
  vix: number;
  originQty: number;      // the stopped origin's filled qty
  qtyCapMult: number;     // phoenixQtyCapMult (1.25)
  direction: "long" | "short";
}
export interface PhoenixSizeResult {
  skip: boolean;
  reason: string;
  qty: number;
  perPosUsd: number;
  plannedRiskUsd: number;
  capped: boolean;
}

/**
 * computePhoenixSize — 1%-recalc via the AUTHORITATIVE vixRiskSize, then HARD-CAP qty at
 * originQty × qtyCapMult. The cap binds BEFORE any order. vixRiskSize FAILS CLOSED on
 * perShareRisk ≤ 0 (entry==stop) / VIX block / bad nlv — so a degenerate reclaim can
 * NEVER produce a /0 or ∞ qty. Pure. Symmetric long/short (vixRiskSize is long-form;
 * for short we sign-flip entry/stop so perShareRisk = stop − entry stays positive).
 */
export function computePhoenixSize(i: PhoenixSizeInput): PhoenixSizeResult {
  if (!(i.originQty > 0)) {
    return { skip: true, reason: "origin qty ≤ 0", qty: 0, perPosUsd: 0, plannedRiskUsd: 0, capped: false };
  }
  // vixRiskSize computes perShareRisk = entry − stop (long form). For a short, the live
  // risk is stop − entry; pass the magnitudes so the same formula yields positive risk.
  const longEntry = i.direction === "long" ? i.entry : i.stop;
  const longStop = i.direction === "long" ? i.stop : i.entry;
  const sized = vixRiskSize({ nlv: i.nlv, entry: longEntry, stop: longStop, vix: i.vix });
  if (sized.skip || !(sized.shares > 0)) {
    return { skip: true, reason: sized.reason || "vixRiskSize skip", qty: 0, perPosUsd: 0, plannedRiskUsd: 0, capped: false };
  }
  const capQty = Math.floor(i.originQty * i.qtyCapMult);
  let qty = sized.shares;
  let capped = false;
  if (qty > capQty) { qty = capQty; capped = true; }
  if (!(qty > 0)) {
    return { skip: true, reason: "capped to 0", qty: 0, perPosUsd: 0, plannedRiskUsd: 0, capped: true };
  }
  const perShareRisk = Math.abs(i.entry - i.stop);
  return {
    skip: false,
    reason: capped ? `capped to origin×${i.qtyCapMult}` : sized.reason,
    qty,
    perPosUsd: +(qty * i.entry).toFixed(2),
    plannedRiskUsd: +(qty * perShareRisk).toFixed(2),
    capped,
  };
}

// ── DB anti-loop (P6 — ALL reads from phoenixLedger; atomic pre-order check) ──────
/**
 * checkPhoenixAntiLoop — returns { allowed, reason } given TODAY's ledger rows for the
 * account + ticker, the per-day cap, and the set of tickers with a ghost open now.
 * PURE (the caller fetches the rows so this is unit-testable across a "restart"):
 *   • ≤1 / ticker / day      (any non-blocked ledger row for ticker today ⇒ done)
 *   • ≤maxPerDay / account   (count of re-entered/stopped rows today)
 *   • 30-min cooldown        (cooldownUntil in the future ⇒ blocked)
 *   • ghost open same ticker ⇒ blocked
 */
export function checkPhoenixAntiLoop(args: {
  ticker: string;
  ledgerToday: Array<{ ticker: string; status: string; cooldownUntil?: number | null }>;
  maxPerDay: number;
  ghostOpenTickers: Set<string>;
  now?: number;
}): { allowed: boolean; reason: string } {
  const sym = args.ticker.toUpperCase();
  const now = args.now ?? Date.now();

  if (args.ghostOpenTickers.has(sym)) {
    return { allowed: false, reason: "ghost open on ticker — blocked" };
  }
  // Per-ticker / day: a re-entry already happened (reentered/stopped) ⇒ ticker done.
  const tickerRows = args.ledgerToday.filter((r) => r.ticker.toUpperCase() === sym);
  if (tickerRows.some((r) => r.status === "reentered" || r.status === "stopped")) {
    return { allowed: false, reason: "ticker already re-entered today (≤1/ticker/day)" };
  }
  // 30-min cooldown after a phoenix stop on this ticker.
  const inCooldown = tickerRows.some((r) => (r.cooldownUntil ?? 0) > now);
  if (inCooldown) return { allowed: false, reason: "30-min cooldown active" };
  // Account / day cap: count distinct re-entries fired today.
  const firedToday = args.ledgerToday.filter((r) => r.status === "reentered" || r.status === "stopped").length;
  if (firedToday >= args.maxPerDay) {
    return { allowed: false, reason: `account daily cap reached (${firedToday}/${args.maxPerDay})` };
  }
  return { allowed: true, reason: "ok" };
}

// ── P-S0: eligibility write on a Wide-Lung-SL close (gated) ───────────────────────
/**
 * writePhoenixEligibility — call from the close-detect path when a position closes.
 * INERT when phoenixProtocolEnabled=0 (returns before any DB write). When ON and the
 * close is a Phoenix-eligible Wide-Lung stop, inserts ONE `eligible` ledger row (frozen
 * breakoutLine from the origin's prior-day Donchian20-high × 0.995). Never throws.
 */
export async function writePhoenixEligibility(
  pos: {
    id: number; userId: number; ticker: string; signal?: string | null;
    direction?: string | null; exitReason?: string | null; exitPrice?: number | null;
    initialSl?: number | null;
  },
  config: LiveEngineConfig | null | undefined,
  deps?: { db?: Awaited<ReturnType<typeof getDb>>; breakoutLine?: number },
): Promise<{ written: boolean; reason: string }> {
  if (!isPhoenixEnabled(config)) return { written: false, reason: "phoenix disabled" };
  try {
    if (!isPhoenixWideLungStop(pos)) return { written: false, reason: "not a wide-lung breakout stop" };
    const db = deps?.db ?? (await getDb());
    if (!db) return { written: false, reason: "DB unavailable" };

    // Freeze breakoutLine = donchian20High × 0.995 from the origin's recent daily bars.
    let breakoutLine = deps?.breakoutLine ?? 0;
    if (!(breakoutLine > 0)) {
      try {
        const bars = await fetchBarsForTicker(pos.ticker, 30);
        const highs = bars.slice(-20).map((b: any) => Number(b.high) || 0).filter((h: number) => h > 0);
        if (highs.length) breakoutLine = +(Math.max(...highs) * BREAKOUT_LINE_MULT).toFixed(2);
      } catch { /* breakoutLine stays 0 → cannot reclaim → harmless eligible-but-never-fires */ }
    }
    if (!(breakoutLine > 0)) return { written: false, reason: "no breakoutLine (cannot freeze)" };

    const tradeDate = israelDateKey();
    // Idempotent: don't double-write an eligible row for the same origin position.
    const existing = await db.select().from(phoenixLedger)
      .where(and(eq(phoenixLedger.originPosId, pos.id), eq(phoenixLedger.tradeDate, tradeDate)))
      .limit(1);
    if (existing.length) return { written: false, reason: "ledger row already exists" };

    const ts = Date.now();
    await db.insert(phoenixLedger).values({
      userId: pos.userId,
      originPosId: pos.id,
      ticker: pos.ticker.toUpperCase(),
      tradeDate,
      breakoutLine,
      stopPrice: Number(pos.initialSl) || 0,
      status: "eligible",
      createdAt: ts,
      updatedAt: ts,
    } as any);
    dbLog("info", "SYSTEM", `[Phoenix] eligible: ${pos.ticker} wide-lung stop → armed for 5m reclaim above $${breakoutLine.toFixed(2)}`);
    return { written: true, reason: `eligible @ breakoutLine $${breakoutLine.toFixed(2)}` };
  } catch (e) {
    log.warn("LIVE_EXEC", `[Phoenix] eligibility write error ${pos.ticker}: ${String(e).slice(0, 100)}`);
    return { written: false, reason: "write error" };
  }
}

// ── P-S0b: cooldown writer on a Phoenix-CHILD stop-out (gated) ────────────────────
/**
 * writePhoenixChildStopped — call from the close-detect path when a position closes.
 * INERT when phoenixProtocolEnabled=0 (returns before any DB write). When ON, and the
 * closing position is a Phoenix CHILD (phoenixGeneration=1) that STOPPED OUT, it flips
 * that lineage's today ledger row to status='stopped' and sets cooldownUntil = now +
 * PHOENIX_COOLDOWN_MS — closing the arm-loop the anti-loop READS but nothing WROTE.
 * Idempotent and best-effort; never throws.
 */
export async function writePhoenixChildStopped(
  pos: {
    id: number; userId: number; ticker: string;
    phoenixGeneration?: number | null; originPosId?: number | null; exitReason?: string | null;
  },
  config: LiveEngineConfig | null | undefined,
  deps?: { db?: Awaited<ReturnType<typeof getDb>> },
): Promise<{ written: boolean; reason: string }> {
  if (!isPhoenixEnabled(config)) return { written: false, reason: "phoenix disabled" };
  if ((pos.phoenixGeneration ?? 0) !== 1) return { written: false, reason: "not a phoenix child" };
  const reason = String(pos.exitReason ?? "");
  // Only a genuine stop-out arms the cooldown (a TP / manual close should not).
  if (!(reason.includes("SL") || reason.includes("STOP"))) return { written: false, reason: "not a stop-out" };
  try {
    const db = deps?.db ?? (await getDb());
    if (!db) return { written: false, reason: "DB unavailable" };
    // A phoenix child ALWAYS carries originPosId (set at re-entry, tryLiveEntry below). That is
    // the lineage key for its ledger row (originPosId + tradeDate, idempotently ≤1 row). We do
    // NOT fall back to reenteredPosId — the re-entry update never persists it, so a fallback
    // there would match zero rows and SILENTLY fail to arm the cooldown (qa-architect #2).
    if (!(pos.originPosId && pos.originPosId > 0)) {
      log.warn("LIVE_EXEC", `[Phoenix] child stop-out for ${pos.ticker} has no originPosId — cannot arm cooldown`);
      return { written: false, reason: "phoenix child missing originPosId" };
    }
    const tradeDate = israelDateKey();
    const now = Date.now();
    const cooldownUntil = now + PHOENIX_COOLDOWN_MS;
    await db.update(phoenixLedger)
      .set({ status: "stopped", cooldownUntil, updatedAt: now })
      .where(and(eq(phoenixLedger.originPosId, pos.originPosId), eq(phoenixLedger.tradeDate, tradeDate)));
    dbLog("info", "SYSTEM",
      `[Phoenix] child stop-out: ${pos.ticker} → status=stopped, cooldown ${Math.round(PHOENIX_COOLDOWN_MS / 60_000)}min (anti-loop armed)`);
    return { written: true, reason: `stopped + cooldown ${Math.round(PHOENIX_COOLDOWN_MS / 60_000)}min` };
  } catch (e) {
    log.warn("LIVE_EXEC", `[Phoenix] child-stopped write error ${pos.ticker}: ${String(e).slice(0, 100)}`);
    return { written: false, reason: "write error" };
  }
}

// ── P-S1: the isolated 5m watcher (NOT in the war-20m scan) ───────────────────────
const _lastBarFetchAt = new Map<string, number>();   // ticker → last 5m fetch epoch ms
let _phoenixTickRunning = false;                       // module-local reentrancy

async function fetchReclaimBars(ticker: string): Promise<IntradayBar[] | null> {
  const now = Date.now();
  const last = _lastBarFetchAt.get(ticker) ?? 0;
  if (now - last < PHOENIX_BAR_TTL_MS) return null;    // ADR-P2 cache TTL
  _lastBarFetchAt.set(ticker, now);
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 5 * 86400_000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const bars = await fetchIntradayBarsForTicker(ticker, "5m", fmt(start), fmt(end));
    return bars.length ? bars : null;
  } catch {
    return null;                                       // throw / 503 → fail-closed
  }
}

/**
 * runPhoenixWatcherTick — the isolated 60s tick. INERT-FIRST: reads the flag at the TOP
 * and RETURNS IMMEDIATELY when off. FAIL-CLOSED throughout: any missing data, gateway
 * flake, or anti-loop block → no entry. Acquires the shared entrySlotLock so it never
 * double-fires with the war cycle / Armed-Watcher. Never throws into the scheduler.
 */
export async function runPhoenixWatcherTick(userId: number): Promise<void> {
  let config: Awaited<ReturnType<typeof getLiveConfig>> = null;
  try {
    config = await getLiveConfig(userId);
  } catch {
    return;
  }
  if (!isPhoenixEnabled(config)) return;               // ← THE inert early-return
  if (_phoenixTickRunning) return;
  _phoenixTickRunning = true;
  try {
    const db = await getDb();
    if (!db) return;
    const tradeDate = israelDateKey();

    // Eligible candidates today (the ONLY input; NOT a 147-ticker scan).
    const eligible = await db.select().from(phoenixLedger)
      .where(and(
        eq(phoenixLedger.userId, userId),
        eq(phoenixLedger.tradeDate, tradeDate),
        eq(phoenixLedger.status, "eligible"),
      ));
    if (!eligible.length) return;

    // Today's full ledger + ghost-open tickers for the atomic anti-loop check.
    const ledgerToday = await db.select().from(phoenixLedger)
      .where(and(eq(phoenixLedger.userId, userId), eq(phoenixLedger.tradeDate, tradeDate)));
    const openRows = await db.select().from(livePositions)
      .where(and(eq(livePositions.userId, userId), eq(livePositions.status, "open")));
    const ghostOpenTickers = new Set(
      openRows.filter((r: any) => (r.slotGhost ?? 0) === 1).map((r: any) => String(r.ticker).toUpperCase()));
    const maxPerDay = Number((config as any)?.phoenixMaxPerDay ?? 3);
    const capMult = Number((config as any)?.phoenixQtyCapMult ?? 1.25);

    // Live quotes for the eligible names (broker-truth only; reuse the 60s cache).
    let priceMap: Map<string, any>;
    try {
      priceMap = (await fetchIbkrLivePricesBatch(eligible.map((e: any) => e.ticker))) as any;
    } catch {
      return;                                          // quote read failed → fail-closed
    }

    // VIX from the live regime (same source as the war cycle's sizing).
    let vix = NaN;
    try { vix = (await getMarketRegime() as any)?.vixProxy ?? NaN; } catch { vix = NaN; }

    for (const row of eligible as any[]) {
      const sym = String(row.ticker).toUpperCase();
      const isShort = false; // ADR-P3 / P1: FULL-break long only (no PRE_BREAK, no short v1).

      // ATOMIC anti-loop check (DB-persisted; survives restart).
      const gate = checkPhoenixAntiLoop({ ticker: sym, ledgerToday, maxPerDay, ghostOpenTickers });
      if (!gate.allowed) {
        dbLog("info", "SYSTEM", `[Phoenix] ${sym} blocked — ${gate.reason}`);
        continue;
      }

      // Broker-truth live price.
      const lp = priceMap.get(sym) ?? null;
      const live = lp && lp.source === "ibkr" ? Number(lp.price ?? 0) : 0;
      if (!(live > 0)) continue;                       // no live price → never price off stale EOD

      // 5m reclaim confirm (cached bars, fail-closed).
      const bars = await fetchReclaimBars(sym);
      if (!bars) continue;
      const reclaim = is5mReclaimAbove(bars, Number(row.breakoutLine), isShort);
      if (!reclaim.reclaimed) continue;

      // Fresh wide-lung stop off the reclaim entry (live), 1%-recalc sizing + origin cap.
      let ema50 = NaN;
      try { ema50 = ema50FromBars(await fetchBarsForTicker(sym, 420)); } catch { ema50 = NaN; }
      let stop: number;
      try { stop = wideLungSL(live, ema50, "long"); } catch { continue; } // fail-closed (no garbage stop)

      const originQty = await originFilledQty(db, row.originPosId);
      const nlv = Number((config as any)?.totalNlv ?? 0);
      const sized = computePhoenixSize({
        nlv, entry: live, stop, vix, originQty, qtyCapMult: capMult, direction: "long",
      });
      if (sized.skip) {
        dbLog("info", "SYSTEM", `[Phoenix] ${sym} sized-out — ${sized.reason}`);
        continue;
      }

      // ── Concurrency: acquire the shared slot lock; if held, retry next tick. ──
      if (!tryAcquireEntrySlot(`phoenix:${sym}`)) {
        dbLog("info", "SYSTEM", `[Phoenix] ${sym} slot lock busy — retry next tick`);
        continue;
      }
      try {
        // Re-check the gate under the lock right before the order (atomicity vs. a race).
        const ledgerNow = await db.select().from(phoenixLedger)
          .where(and(eq(phoenixLedger.userId, userId), eq(phoenixLedger.tradeDate, tradeDate)));
        const gate2 = checkPhoenixAntiLoop({ ticker: sym, ledgerToday: ledgerNow, maxPerDay, ghostOpenTickers });
        if (!gate2.allowed) { dbLog("info", "SYSTEM", `[Phoenix] ${sym} blocked under lock — ${gate2.reason}`); continue; }

        const ts = Date.now();
        // Mark intent FIRST so a crash mid-order cannot loop (status=reentered counts
        // against the daily cap and the per-ticker rule on the next tick).
        await db.update(phoenixLedger).set({
          status: "reentered", reclaimPrice: reclaim.reclaimClose ?? null,
          phoenixQty: sized.qty, plannedRiskUsd: sized.plannedRiskUsd, updatedAt: ts,
        } as any).where(eq(phoenixLedger.id, row.id));

        const res = await tryLiveEntry({
          userId,
          ticker: sym,
          direction: "long",
          signal: "PHOENIX_REENTRY",
          zivScore: 9.0,
          currentPrice: live,
          slPrice: stop,
          tpPrice: 0,                          // tryLiveEntry recomputes the Golden ladder TP
          positionSizeUsd: sized.perPosUsd,
          sizingStop: stop,                    // STOP-BASIS PARITY: size+broker stop are identical
          sizingEntryPrice: live,
          phoenixGeneration: 1,                // lineage: this is a phoenix child
          originPosId: row.originPosId,
        });
        dbLog("info", "SYSTEM",
          `[Phoenix] ${sym} re-entry → entered=${res.entered} qty≈${sized.qty} (${sized.reason}) reason="${res.reason}"`);
        if (!res.entered) {
          // entry rejected (cap/market/dup) → leave status=reentered to BURN the daily slot
          // for this ticker today (anti-loop is conservative: one ATTEMPT per ticker/day).
        }
        break;                                 // ONE phoenix entry attempt per tick.
      } finally {
        releaseEntrySlot(`phoenix:${sym}`);
      }
    }
  } catch (e) {
    dbLog("warn", "SYSTEM", `[Phoenix] tick error: ${String(e).slice(0, 120)}`);
  } finally {
    _phoenixTickRunning = false;
  }
}

/** Origin filled qty for the qty cap. 0 (→ size-skip) if the row is gone. */
async function originFilledQty(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, originPosId: number): Promise<number> {
  try {
    const rows = await db.select().from(livePositions).where(eq(livePositions.id, originPosId)).limit(1);
    const r = rows[0] as any;
    if (!r) return 0;
    return Math.abs(Number(r.filledQty ?? r.units ?? 0)) || 0;
  } catch {
    return 0;
  }
}
