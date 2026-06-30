/**
 * ghostSlots.ts — Ghost Slots G-S1 (BUILD-spec 2026-06-29 §2 + Guardrails G1-A..G1-D).
 *
 * Ghost Slots = ELZA *slot accounting* only. When a runner reaches +1.5R AND its
 * stop is BROKER-VERIFIED resting at/through breakeven, the position's dollar risk is
 * ≈0, so it stops consuming one of the 12 ELZA slots — yet it stays fully `open` at
 * IBKR (gross/margin/openTickerSet UNCHANGED). This frees a slot for a fresh entry
 * WITHOUT freeing any margin (slot ≠ margin).
 *
 * ── THE INERT INVARIANT (non-negotiable) ─────────────────────────────────────────
 * `ghostSlotsEnabled` defaults to 0. When 0, `onBreakevenConfirmed()` returns before
 * any broker read or DB write, AND every slot-count / heat helper treats EVERY row as
 * counting (countsTowardSlot honored only when the flag is on). Runtime byte-identical.
 *
 * ── G1-A (broker-truth, FAIL-CLOSED) ─────────────────────────────────────────────
 * A slot is ghosted ONLY after a re-READ of IBKR `/orders` confirms a resting STP at
 * ≈BE price for the FULL position qty — NOT the optimistic return of any "moved the
 * stop" call. If the resting stop is not verified (405 / orphan-cancel / OCA-reject /
 * partial qty / gateway flake) → do NOT ghost; retry next cycle. Same broker-truth the
 * SL-enforcement poller uses (working `/orders` filtered by exit-side + STP type).
 *
 * ── G1-B (margin hermetic) ───────────────────────────────────────────────────────
 * Ghosting sets slotGhost=1, countsTowardSlot=0 — it NEVER touches IBKR gross/margin.
 * A new entry into a freed slot is STILL gated by the existing IBKR-gross / budget cap
 * in warEngine (deployedUsd ≥ cap → no entry). A freed slot with no margin headroom
 * yields NO new entry. (Proven by the unit test.)
 *
 * ── G1-C (heat) ──────────────────────────────────────────────────────────────────
 * `zivOpenHeatUsd` ghost rows contribute 0 planned risk (their stop is at BE).
 *
 * ── G1-D (single hook) ───────────────────────────────────────────────────────────
 * `onBreakevenConfirmed(pos)` is the ONLY entry to ghosting (@ +1.5R). It is NOT folded
 * into goldenExitDecision; Golden SCALE_40 @ 2.5R and Open-Skies 50% @ 2R stay separate
 * (exit-ladder parity is untouched — LIVE_OPS_OVERLAY).
 */

import { getDb } from "./db";
import { livePositions, type LiveEngineConfig } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { ibindRequest } from "./routers/ibkrProxy";
import { log } from "./logger";

/** Protective exit side: SELL for long, BUY for short cover. (Local copy of the
 *  liveSlTpEnforcement helper — kept local to avoid a liveOrderExecutor import cycle.) */
function isExitSide(side: string | undefined, isShort: boolean): boolean {
  const s = (side ?? "").toUpperCase();
  return isShort ? s.startsWith("B") : s.startsWith("S");
}

// +1.5R is the canonical ghost trigger (ADR-G1). Mirrors warEngine BREAKEVEN_TRIGGER_R.
export const GHOST_TRIGGER_R = 1.5;
export const GHOST_STAGE = "FREE_ROLL_1.5R_BE" as const;
/** Broker stop is "at/through BE" if within this fraction of the BE price. */
export const BE_VERIFY_TOLERANCE = 0.005; // 0.5%
/** SL qty must match position qty within this many shares (rounding/partial slack). */
export const BE_VERIFY_QTY_SLACK = 0.5;

// ── Flag reader — same shape/source as every other live flag (one source of truth) ──
export function isGhostSlotsEnabled(config: LiveEngineConfig | null | undefined): boolean {
  return ((config as any)?.ghostSlotsEnabled ?? 0) === 1;
}

// ── PURE: slot accounting ─────────────────────────────────────────────────────────
/**
 * countsTowardSlot — does this DB row consume a slot? When ghost slots are OFF, EVERY
 * open/zombie row counts (today's behavior, byte-identical). When ON, a ghosted row
 * (slotGhost=1 / countsTowardSlot=0) does NOT count. Pure; the caller passes the flag.
 */
export function rowCountsTowardSlot(
  row: { slotGhost?: number | null; countsTowardSlot?: number | null },
  ghostEnabled: boolean,
): boolean {
  if (!ghostEnabled) return true;                       // INERT: flag off ⇒ everything counts
  if ((row.slotGhost ?? 0) === 1) return false;         // ghosted ⇒ slot freed
  return (row.countsTowardSlot ?? 1) === 1;
}

/**
 * slotCounts — active (counted) / ghost / free given a position list, the per-direction
 * cap, and the flag. `free = max(0, maxSlots − active)`. Ghosts never reduce `free`.
 * Used by the slot counter AND surfaced to the War Room (G-S2 contract).
 */
export function slotCounts(
  rows: Array<{ slotGhost?: number | null; countsTowardSlot?: number | null; direction?: string }>,
  maxSlots: number,
  ghostEnabled: boolean,
): { active: number; ghost: number; free: number } {
  let active = 0;
  let ghost = 0;
  for (const r of rows) {
    if (ghostEnabled && (r.slotGhost ?? 0) === 1) { ghost++; continue; }
    if (rowCountsTowardSlot(r, ghostEnabled)) active++;
  }
  return { active, ghost, free: Math.max(0, maxSlots - active) };
}

/**
 * positionPlannedRiskUsd — G1-C. The dollars at risk if THIS position's current stop
 * hits. A ghosted row contributes 0 (its stop is broker-verified at BE → ≈0 risk).
 * When the flag is OFF a ghosted row never exists, so this is byte-identical to the
 * legacy |entry − currentSl| × units reduction.
 */
export function positionPlannedRiskUsd(
  row: { entryPrice?: number | null; currentSl?: number | null; units?: number | null; slotGhost?: number | null },
  ghostEnabled: boolean,
): number {
  if (ghostEnabled && (row.slotGhost ?? 0) === 1) return 0; // ghost ⇒ 0 planned risk
  const entry = Number(row.entryPrice) || 0;
  const sl = Number(row.currentSl) || entry;
  const units = Number(row.units) || 0;
  return Math.abs(entry - sl) * units;
}

// ── PURE: the +1.5R ghost trigger (direction-aware, parity with warEngine) ─────────
/**
 * meetsGhostTrigger — ALL of: +1.5R unrealized, slMovedToBreakEven=1, and currentSl is
 * at/beyond breakeven (long: SL ≥ entry; short: SL ≤ entry). Broker-verification of the
 * resting stop (G1-A) is a SEPARATE async step — this is the cheap local pre-gate.
 * FAIL-CLOSED on degenerate r (entry==SL): returns false (never ghost off /0).
 */
export function meetsGhostTrigger(pos: {
  entryPrice: number; currentSl?: number | null; initialSl?: number | null;
  currentPrice?: number | null; direction: string; slMovedToBreakEven?: number | null;
}): boolean {
  const entry = Number(pos.entryPrice) || 0;
  const sl = Number(pos.currentSl ?? pos.initialSl) || 0;
  const px = Number(pos.currentPrice ?? entry) || 0;
  const isShort = pos.direction === "short";
  const rDist = Math.abs(entry - (Number(pos.initialSl) || sl));
  if (!(entry > 0) || !(rDist > 0)) return false;            // degenerate r ⇒ never ghost
  const profitR = isShort ? (entry - px) / rDist : (px - entry) / rDist;
  if (!(profitR >= GHOST_TRIGGER_R)) return false;
  if ((pos.slMovedToBreakEven ?? 0) !== 1) return false;
  // currentSl must be at/beyond breakeven (the dollar-risk-≈0 condition).
  const atBe = isShort ? sl <= entry * 1.0001 : sl >= entry * 0.9999;
  return atBe;
}

/**
 * verifyRestingStopAtBe — G1-A broker-truth. Re-reads IBKR `/orders` (or accepts an
 * injected order list for tests) and returns true ONLY when a WORKING protective STP on
 * the exit side rests at/through breakeven for the full position qty. ANY uncertainty
 * (gateway not-ok, no matching STP, wrong qty, price not yet at BE) ⇒ false (fail-closed).
 *
 * `injectedOrders` lets the test pass a deterministic order book without a broker call;
 * production passes nothing and we read the live `/orders` book.
 */
export async function verifyRestingStopAtBe(
  pos: { ticker: string; units: number; direction: string; entryPrice: number },
  injectedOrders?: any[] | null,
): Promise<{ verified: boolean; reason: string }> {
  const ticker = pos.ticker.toUpperCase().trim();
  const isShort = pos.direction === "short";
  const units = Math.abs(Number(pos.units) || 0);
  if (!(units > 0)) return { verified: false, reason: "no qty" };
  const bePrice = Number(pos.entryPrice) || 0;
  if (!(bePrice > 0)) return { verified: false, reason: "no entry/BE price" };

  let orders: any[];
  if (injectedOrders != null) {
    orders = injectedOrders;
  } else {
    let res;
    try {
      res = await ibindRequest("GET", "/orders");
    } catch (e: any) {
      return { verified: false, reason: `orders read threw: ${String(e?.message ?? e).slice(0, 60)}` };
    }
    if (!res.ok) return { verified: false, reason: `orders read not-ok (HTTP ${res.status})` };
    orders = (res.body as any)?.orders ?? [];
  }

  const working = orders.filter((o: any) =>
    ["PreSubmitted", "Submitted", "Working"].includes(o.status ?? ""));
  const stops = working.filter((o: any) => {
    const t = (o.description1 ?? o.ticker ?? "").toUpperCase().trim();
    if (t !== ticker) return false;
    if (!isExitSide(o.side, isShort)) return false;
    const ot = String(o.orderType ?? "").toLowerCase();
    return ot === "stp" || ot === "stop" || ot === "trail";
  });
  if (stops.length === 0) return { verified: false, reason: "no resting STP for ticker" };

  for (const o of stops) {
    const qty = Math.abs(parseFloat(o.remainingQuantity ?? o.totalQuantity ?? o.quantity ?? "0"));
    if (Math.abs(qty - units) > BE_VERIFY_QTY_SLACK) continue;       // wrong qty (partial / stale)
    const stopPx = Number(o.stopPrice ?? o.auxPrice ?? o.price ?? 0);
    if (!(stopPx > 0)) continue;
    // At/through BE: long ⇒ stop ≥ BE×(1−tol); short ⇒ stop ≤ BE×(1+tol).
    const atBe = isShort
      ? stopPx <= bePrice * (1 + BE_VERIFY_TOLERANCE)
      : stopPx >= bePrice * (1 - BE_VERIFY_TOLERANCE);
    if (atBe) return { verified: true, reason: `STP qty=${qty} @ $${stopPx.toFixed(2)} ≈ BE $${bePrice.toFixed(2)}` };
  }
  return { verified: false, reason: "resting STP qty/price not at BE" };
}

/**
 * onBreakevenConfirmed — G1-D single hook. Called from the warEngine manage path AFTER
 * the DB break-even move. INERT when ghostSlotsEnabled=0 (returns immediately, no broker
 * read, no write). When ON: pre-gate (meetsGhostTrigger) → broker-truth verify (G1-A) →
 * set slotGhost=1, countsTowardSlot=0, ghostStage. Idempotent (already-ghost ⇒ no-op).
 * NEVER throws into the caller — any error ⇒ no ghost (fail-closed).
 *
 * `deps.injectedOrders` is test-only (deterministic broker book); production omits it.
 */
export async function onBreakevenConfirmed(
  pos: {
    id: number; ticker: string; units: number; direction: string;
    entryPrice: number; currentSl?: number | null; initialSl?: number | null;
    currentPrice?: number | null; slMovedToBreakEven?: number | null;
    slotGhost?: number | null;
  },
  config: LiveEngineConfig | null | undefined,
  deps?: { injectedOrders?: any[] | null; db?: Awaited<ReturnType<typeof getDb>> },
): Promise<{ ghosted: boolean; reason: string }> {
  // ── INERT GATE — flag first, before ANY work. flag=0 ⇒ byte-identical. ──
  if (!isGhostSlotsEnabled(config)) return { ghosted: false, reason: "ghost slots disabled" };
  if ((pos.slotGhost ?? 0) === 1) return { ghosted: false, reason: "already ghost" };

  try {
    if (!meetsGhostTrigger(pos)) return { ghosted: false, reason: "below 1.5R / not at BE" };

    // G1-A broker-truth: ghost ONLY after the resting STP is re-READ and confirmed at BE.
    const v = await verifyRestingStopAtBe(pos, deps?.injectedOrders);
    if (!v.verified) {
      log.info("WAR_ENGINE", `[GhostSlot] ${pos.ticker} NOT ghosted — SL not broker-verified at BE (${v.reason})`);
      return { ghosted: false, reason: `SL not verified: ${v.reason}` };
    }

    const db = deps?.db ?? (await getDb());
    if (!db) return { ghosted: false, reason: "DB unavailable" };
    await db.update(livePositions).set({
      slotGhost: 1,
      countsTowardSlot: 0,
      ghostAt: Date.now(),
      ghostStage: GHOST_STAGE,
    } as any).where(eq(livePositions.id, pos.id));

    log.info("WAR_ENGINE",
      `[GhostSlot] ✅ ${pos.ticker} slot freed (FREE_ROLL_1.5R_BE) — IBKR qty/margin UNCHANGED, ${v.reason}`,
      { ticker: pos.ticker, posId: pos.id });
    return { ghosted: true, reason: v.reason };
  } catch (e) {
    // FAIL-CLOSED: never throw into the manage loop; on any error do NOT ghost.
    log.warn("WAR_ENGINE", `[GhostSlot] ${pos.ticker} hook error (no ghost): ${String(e).slice(0, 100)}`);
    return { ghosted: false, reason: "hook error" };
  }
}
