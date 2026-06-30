// server/stopModMutex.ts
// QA FIX #2 — single in-process mutex guarding ALL stop cancel+replace passes.
//
// Two CRONs fire on ~5-min intervals and BOTH cancel+replace the resting protective
// stop and BOTH write livePositions.ibkrSlOrderId for the same row:
//   - runLiveSlMonitor          (alertPoller off-slot tick)   — Open Skies free-roll / Chandelier trail
//   - runLiveSlTpEnforcement    (alertPoller SL/TP CRON tick)  — qty-fix + SL-drift replace
// With no shared lock they interleave: A places a new stop and writes its id, B (holding
// a stale read) cancels A's brand-new stop and writes B's id → last-writer-wins leaves an
// ORPHANED resting order and a DB id that may point at a cancelled order.
//
// This module is a per-userId in-flight flag in ONE shared module that both paths import,
// so only one stop-modifying pass runs at a time. The loser SKIPS this cycle (it is a
// ~5-min CRON; the work is reattempted on the next tick) rather than queueing — queueing
// could let a long-stale plan execute against state the winner just changed.
//
// Naked-safety is unaffected: each path still does place-before-cancel internally; the
// mutex only prevents two such round-trips from racing the same row concurrently.

const _inFlight = new Set<number>();

/**
 * Run `fn` while holding the per-user stop-modification lock. If the lock is already
 * held for `userId`, returns { ran: false } immediately WITHOUT running `fn` (caller
 * should treat this as "another stop pass is active — skip this cycle").
 */
export async function withStopModLock<T>(
  userId: number,
  who: string,
  fn: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false }> {
  if (_inFlight.has(userId)) {
    return { ran: false };
  }
  _inFlight.add(userId);
  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    _inFlight.delete(userId);
  }
}

/** Test/inspection helper. */
export function isStopModLocked(userId: number): boolean {
  return _inFlight.has(userId);
}
