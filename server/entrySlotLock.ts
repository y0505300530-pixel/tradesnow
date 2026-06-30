/**
 * entrySlotLock.ts — shared in-process reentrancy lock for the THREE entry paths that
 * can each try to fill a freed/open ELZA slot: the war cycle, the Armed-Watcher, and
 * the Phoenix 5m watcher (BUILD-spec 2026-06-29 Phoenix concurrency guardrail).
 *
 * The DB-level guards (uq_open_ticker, the per-ticker liveEntryLock, the phoenixLedger
 * anti-loop) are the AUTHORITATIVE single-fill guarantees. This module is the cheap
 * in-process backstop that stops two cron ticks in the SAME node process from racing
 * into the same freed slot between DB reads (the spec's "must NOT double-fire").
 *
 * It is a try-acquire (never blocks): a caller that cannot acquire simply skips this
 * tick and retries on its next cadence. NOT used when both flags are off (the Phoenix
 * watcher early-returns before ever touching it → byte-identical).
 */

let _slotEntryBusy = false;
let _holder: string | null = null;

/** Try to acquire the shared entry-slot lock. Returns false if already held. */
export function tryAcquireEntrySlot(holder: string): boolean {
  if (_slotEntryBusy) return false;
  _slotEntryBusy = true;
  _holder = holder;
  return true;
}

/** Release the shared entry-slot lock (only the holder, or a forced clear). */
export function releaseEntrySlot(holder: string): void {
  if (_holder === holder || _holder === null) {
    _slotEntryBusy = false;
    _holder = null;
  }
}

/** Diagnostics — current holder (null when free). */
export function entrySlotHolder(): string | null {
  return _holder;
}
