/**
 * War-race deferred Armed-entry retry — PURE decision helpers (P1d).
 *
 * Problem (verified on live main): a confirmed Armed-Watcher breakout is routed through
 * `runWarEngineCycle({ manual:true, onlyTicker })`. If that returns a TRANSIENT block — the
 * `_warRunning` latch ("busy") while a universe cycle is mid-flight, or the 30s manual gap
 * ("manual_cooldown") — it returns `entered=0`. The watcher then marks the ticker HELD_5M and
 * NEVER re-fires it (intradayArmedWatcher tick: `prior === "HELD_5M" → continue`), so the
 * breakout is silently lost for the day. These pure helpers drive a bounded, observable retry.
 *
 * INERT unless `warRaceDeferQueueEnabled=1`. Pure + side-effect-free; the intradayArmedWatcher
 * tick is the only stateful caller. Spec: docs/superpowers/specs/2026-07-01-war-race-deferred-armed-queue.md
 */

/**
 * A "transient" block = the cycle did NO scan/entry purely due to timing (the `_warRunning`
 * latch → "busy", or the min-gap cooldown → "cooldown"/"manual_cooldown") — NOT a real
 * rejection (regime off, a cap, the breaker, a gate). Only transient blocks are worth retrying.
 */
export function isTransientBlock(regimeDecision: string): boolean {
  return regimeDecision === "busy" || regimeDecision === "cooldown" || regimeDecision === "manual_cooldown";
}

/**
 * Enqueue a just-fired breakout for retry ONLY when the queue is armed AND the cycle returned a
 * transient block with no entry. A real (terminal) decline — or a successful entry — is not queued.
 */
export function shouldDeferEnqueue(deferOn: boolean, entered: number, regimeDecision: string): boolean {
  return deferOn === true && (entered ?? 0) < 1 && isTransientBlock(regimeDecision);
}

export type DrainAction = "expire" | "success" | "terminal" | "keep";

/**
 * Decide what to do with a queued breakout AFTER a retry attempt (the caller checks TTL first
 * and skips the retry when already expired — `expire` here is the belt-and-suspenders case).
 *   success  → entered ≥ 1 → drop (done).
 *   expire   → past TTL → drop (no stale entry).
 *   terminal → the cycle ran and terminally declined this ticker (already open / gate / regime) → drop.
 *   keep     → still transient-blocked within TTL → retry again next tick.
 */
export function drainDecision(
  nowMs: number, firstSeenMs: number, ttlMs: number, entered: number, regimeDecision: string,
): DrainAction {
  if ((entered ?? 0) >= 1) return "success";
  if (nowMs - firstSeenMs > ttlMs) return "expire";
  if (!isTransientBlock(regimeDecision)) return "terminal";
  return "keep";
}
