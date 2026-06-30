/**
 * slotCounter.ts — Ghost-aware ELZA slot accounting (pure helpers + DB query).
 * LIVE_OPS_OVERLAY: ghost rows stay in openTickerSet but do not consume slots.
 */

export interface SlotCountablePosition {
  direction?: string | null;
  status?: string | null;
  slotGhost?: number | null;
  countsTowardSlot?: number | null;
}

/** True when this open row consumes an ELZA slot (active, not ghost). */
export function countsAsSlot(pos: SlotCountablePosition): boolean {
  const st = pos.status ?? "open";
  if (!["open", "pending_entry", "zombie"].includes(st)) return false;
  if ((pos.countsTowardSlot ?? 1) === 0) return false;
  if ((pos.slotGhost ?? 0) === 1) return false;
  return true;
}

export function isGhostPosition(pos: SlotCountablePosition): boolean {
  return (pos.slotGhost ?? 0) === 1 || (pos.countsTowardSlot ?? 1) === 0;
}

export interface SlotCountResult {
  long: number;
  short: number;
  ghost: number;
  active: number;
  /** max − active (caller passes maxPositions). */
  free: number;
}

export function countSlotsFromPositions(
  positions: SlotCountablePosition[],
  maxPositions = 12,
): SlotCountResult {
  let long = 0;
  let short = 0;
  let ghost = 0;
  for (const p of positions) {
    const st = p.status ?? "open";
    if (!["open", "pending_entry", "zombie"].includes(st)) continue;
    if (isGhostPosition(p)) {
      ghost++;
      continue;
    }
    if (!countsAsSlot(p)) continue;
    if (p.direction === "short") short++;
    else long++;
  }
  const active = long + short;
  return { long, short, ghost, active, free: Math.max(0, maxPositions - active) };
}

/** Planned open risk ($ at SL). Ghost @ BE verified → 0 heat contribution. */
export function positionHeatUsd(pos: {
  entryPrice?: number | null;
  currentSl?: number | null;
  initialSl?: number | null;
  units?: number | null;
  slotGhost?: number | null;
  countsTowardSlot?: number | null;
}): number {
  if (isGhostPosition(pos)) return 0;
  const entry = Number(pos.entryPrice) || 0;
  const sl = Number(pos.currentSl ?? pos.initialSl ?? entry) || entry;
  const units = Number(pos.units) || 0;
  return Math.abs(entry - sl) * units;
}

/** Patch applied on any position close — clears ghost flags. */
export const GHOST_CLEAR_ON_CLOSE = {
  slotGhost: 0,
  countsTowardSlot: 1,
  ghostAt: null,
  ghostStage: null,
} as const;
