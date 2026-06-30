/**
 * gapGuard.ts — ELZA 2.0 P0-6. "Don't chase a gap."
 *
 * If the live price has gapped more than GAP_GUARD_PCT beyond the intended entry
 * zone (the signal price Ziv/War Engine planned to enter at), abort the entry —
 * we trade retests/structure, not gaps. Pure (unit-testable); the live executor
 * calls isGapChase() right before constructing the order.
 *
 * (Re-implemented in Live for ELZA 2.0 — the original lived in paperLabEngine,
 * which was deleted in the De-Dinosaur refactor.)
 */

export const GAP_GUARD_PCT = 1.5;

/** Signed % the live price sits above/below the entry zone (signal). */
export function gapPctFromEntryZone(signalPrice: number, livePrice: number): number {
  return signalPrice > 0 ? ((livePrice - signalPrice) / signalPrice) * 100 : 0;
}

/**
 * True when entering would CHASE a gap:
 *  - long  : live gapped > +maxGapPct above the entry zone
 *  - short : live gapped > maxGapPct below the entry zone
 * Returns false when there is no valid signal price (gap unknowable → don't block here).
 */
export function isGapChase(
  direction: "long" | "short",
  signalPrice: number,
  livePrice: number,
  maxGapPct: number = GAP_GUARD_PCT,
): boolean {
  if (!(signalPrice > 0)) return false;
  const gap = gapPctFromEntryZone(signalPrice, livePrice);
  return (direction === "long" && gap > maxGapPct) || (direction === "short" && gap < -maxGapPct);
}
