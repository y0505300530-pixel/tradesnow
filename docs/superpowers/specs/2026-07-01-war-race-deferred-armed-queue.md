# Spec — War Race: deferred Armed-entry retry ("a cycle that buys in time")

> **Status:** SPEC ONLY — no code · flag-gated INERT · **SSOT:** Git `main` · Date: 2026-07-01
> **Grounded in live `main` 8055243** (post-Cursor Phase 0 — line numbers verified via read-only SSH, NOT stale audit).

## Goal
A confirmed Armed-Watcher breakout must never be silently lost to a **transient** `busy`/`cooldown` return from `runWarEngineCycle` — retry it (bounded, observable, idempotent) until it enters or a short TTL expires.

## Why / success criterion
What's **already fixed** on 8055243 (do NOT re-do): Vuln#1's cooldown-skip log is live (`warEngine.ts:435–448`); `onlyTicker` entry-scope exists (Cursor E1, `warEngine.ts:414`); the Armed Watcher already routes through `runWarEngineCycle(userId, { manual:true, onlyTicker })` (`intradayArmedWatcher.ts:403`) → the **30s** manual gap, not the 20-min one.

The **remaining hole**: that call can return `entered=0` because of a **transient block** — the `_warRunning` latch (`warEngine.ts:431`, "busy") when a ~150-ticker auto cycle (`alertPoller.ts:1222`) is mid-flight, or the 30s `manual_cooldown` (`warEngine.ts:437`). Today that outcome is **logged** (`intradayArmedWatcher.ts:404`) **but not retried** — the breakout is dropped. The 60s state machine (`_state: Map<ticker,WatcherState>`, states `ARMED|CROSSED|HELD_5M|BLOCKED`) may or may not re-fire depending on edge-vs-level trigger; this spec makes the retry **explicit, bounded, and testable** rather than relying on that.

**Done =** in a forced busy collision, a confirmed breakout ends `entered=1` (not 0); entered **exactly once** (dedup); a breakout still blocked past TTL logs an **explicit expiry** (not a silent drop). Zero duplicate brackets.

## File map
- `server/intradayArmedWatcher.ts` *(modify)* — (a) on a transient-block return, enqueue `{ ticker, breakLevel, firstSeenMs }` into a bounded in-process `_deferredArmed` map instead of moving on; (b) at the **top of each tick**, drain `_deferredArmed` FIRST — retry each via the same `runWarEngineCycle({ manual:true, onlyTicker })`; clear an entry when `entered≥1`, or the position is already open/pending (dedup), or `now-firstSeenMs > TTL`. All flag-gated.
- `server/warEngine.ts` *(modify, minimal)* — add `export function isTransientBlock(regimeDecision: string): boolean` (true for `"busy" | "cooldown" | "manual_cooldown"`). No behavior change; the return already carries `regimeDecision`.
- `drizzle/0147_war_race_defer.sql` *(create)* — `ALTER liveEngineConfig ADD warRaceDeferQueueEnabled tinyint NOT NULL DEFAULT 0`, `ADD warRaceDeferTtlSec int NOT NULL DEFAULT 120`. Additive, INERT.
- `drizzle/schema.ts` *(modify)* — mirror the 2 columns.
- `server/warEngine.race.test.ts` *(create)* — race/queue tests (below).

## Interfaces
- `warEngine.ts`: `export function isTransientBlock(regimeDecision: string): boolean`
- `intradayArmedWatcher.ts` (internal): `const _deferredArmed = new Map<string, { breakLevel: number; firstSeenMs: number }>()`; drain runs at tick top when `warRaceDeferQueueEnabled===1`; `TTL = warRaceDeferTtlSec * 1000`.

## Rollout (INERT)
NEW flag `warRaceDeferQueueEnabled` (tinyint default **0**). At 0: **no enqueue, no drain** → the watcher fires-once-and-logs exactly as today → **byte-identical**. `warRaceDeferTtlSec` default 120. Migration 0147 (additive; apply idempotently, catch "Duplicate column"; never `drizzle-kit push`). Owner-only arm; build ≠ arm. **Layered under `elzaIntradayWatcherEnabled`** (already =1) — this is a second, independent switch.

## Parity / safety
- The retry re-invokes the **SAME** `runWarEngineCycle({ manual:true, onlyTicker })` — same 1%-risk / wideLungSL sizing, never-naked SSOT stop, ClusterGuard, exposure/dir caps, duplicate-bracket dedup, single `tryLiveEntry`, **anti-chase F5** live-price re-validation. **NO new order path, NO new sizing.**
- **Duplicate-entry safety:** idempotent — `tryLiveEntry`'s open+pending dedup blocks a 2nd bracket; the drain also clears on open/pending. **TTL** bounds staleness; **anti-chase F5** rejects a breakout that ran too far by execution time.
- **Only transient blocks enqueue.** A real gate rejection (regime off, cap hit, churn/minR, etc. — any non-transient `regimeDecision`) is NOT enqueued → the gate is respected, not bypassed.
- **Fail-closed:** any throw in enqueue/drain → clear that entry + log; never loop, never break the tick (mirrors the existing `finally { _watcherTickRunning=false }`).
- CB / never-naked / HALT / EOD / Flush / NaN-fail-closed / SSOT-stop: **unaffected** (retry = re-invocation of the already-guarded cycle).
- **Live==Backtest:** the queue is an intraday orchestration path the daily backtest doesn't model (N/A); the ENTRY it produces is identical to a normal war entry (same sizing/gates), so entry-parity holds.

## Test plan (`warEngine.race.test.ts`)
1. **INERT (flag=0):** a `busy`/`cooldown` return does NOT enqueue; watcher behaves byte-identical (fire once, no retry).
2. **Transient retry (flag=1):** first fire → `busy` → enqueued; next tick drains → cycle called again with same `onlyTicker` → `entered=1` → cleared.
3. **Dedup:** retry when the position already opened → drain clears with NO second entry / no dup bracket.
4. **Terminal rejection not enqueued:** return with a real gate `regimeDecision` → NOT enqueued.
5. **TTL expiry:** enqueued breakout not entered within `warRaceDeferTtlSec` → drain logs explicit expiry + clears (no stale fire).
6. **Fail-closed:** drain throws → entry cleared + logged, tick continues.
7. **`isTransientBlock` unit:** busy/cooldown/manual_cooldown → true; any gate reason → false.

## Non-goals
- Does NOT change the 20-min auto cadence or the gap constants.
- Does NOT remove/parallelize the `_warRunning` latch (we RETRY around it, not remove it — removing it risks double-entry).
- Does NOT touch sizing, stops, gates, or the order path.
- Does NOT add a persistent (DB) queue — in-process only (a breakout older than TTL isn't worth firing; a process restart = fresh watcher, correct).
- Does NOT address #4 bars perf or Tier-2 items.

**Ready to build? → `build`**
