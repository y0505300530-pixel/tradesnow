# Spec — Performance: DB / Compute / Latency (Tier 1 safe wins + Tier 2/3 backlog)

> **Status:** SPEC ONLY — no code · **SSOT:** Git `main` · deploy via `deploy-tradesnow.sh`
> **Date:** 2026-07-01 · **Source:** 3 parallel READ-ONLY audits (DB / Compute / Latency) on the war-cycle + live-executor + client hot paths.
> **⚠️ Cursor was editing the repo in parallel when this was authored — every `file:line` below MUST be re-verified against live `main` before any change.**

## Executive Summary
Three independent audits converged on the same shape: **the war-cycle scan loop is already well-hoisted** (~15–28 DB round-trips total, no per-ticker DB reads — do NOT refactor it). The real waste is elsewhere. **Tier 1** = pure/additive wins with **zero trading-behavior change** (no flag needed, safe to ship after Cursor lands). **Tier 2** = higher-value but touches the order path / IBKR budget → INERT-gated, qa-architect + shadow before arm. **Tier 3** = owner arming decision, machinery already built.

Two findings surfaced in **two audits independently** (high confidence): the `getStatus` write-storm (#1) and the `resolveConid` in-process memo (#6).

---

## Tier 1 — Safe mechanical wins (pure/additive · LOW risk · no order path · no flag required)

| # | Fix | Evidence (re-verify vs live main) | Win | Effort | Verification (belly-check) |
|---|-----|-----------------------------------|-----|--------|----------------------------|
| **1** ⭐ | Stop `getStatus` writing `livePositions` on every ~4s poll — dirty-check or move persistence to the 5-min SL monitor (which already writes price at `liveOrderExecutor.ts:2354`). `currentPrice` is display data already returned in the response payload. | `server/routers/liveEngine.ts:605-607,612-614` (per-position `currentPrice`/`unrealizedPnl` UPDATE) + `:681` `updateLiveConfig(totalNlv)`; client 4s poll `client/src/pages/WarRoomLive.tsx:107,866` | **~195 writes/min → ~0** (~11,700/hr). Two audits flagged it. | S | War Room open: DB writes/min on `livePositions` drop to monitor cadence; displayed prices unchanged; SL exits still correct (they use in-memory `currentTickPrice`, not the DB row). |
| **2** | Add composite indexes on `livePositions` — **new migration 0146, additive only** (mirror in `schema.ts`). | `drizzle/schema.ts:1459-1461` has only 3 single-col idx (`userId`,`status`,`ticker`); hot predicates are `userId+status`, `userId+status+closedAt`, `userId+openedAt`, `userId+ticker+status` | Speeds **every** hot query in the engine. Pure/additive — indexes never change behavior. | M | `EXPLAIN` on the hot queries shows the composite index used (not a filtered single-col scan); cycle time flat-or-faster; **run off-hours** (brief lock on a large table). |
| **3** | Compute `getTickerIntelligence(ticker, bars)` **once** per ticker, above the long/short branches (deterministic when `bars` passed — no I/O). | `server/warEngine.ts:1018` (LONG) + `:1248` (SHORT) — identical inputs → identical output | ~½ intelligence compute for every dual-eligible ticker × ~150 × cycle | S | Output byte-identical (deterministic); candidate scores unchanged vs baseline cycle. |
| **4** | `fetchBarsForTicker(t, N<420)` first checks the in-memory 420-bar cache and slices `-N` (the DB path already slices at the same place); today only `days===420` uses the memory cache. | `server/marketData.ts:350-354,378,443`; callers `liveOrderExecutor.ts:1180 (5d)`,`:1255 (90d)` per entry | Saves 2–4 DB queries per entry (superset already hot in RAM) | S | SL/TP math identical (same tail bars); verify `.TA`/agorot normalization preserved (a cached 420 series is already normalized → slice is safe). |
| **5** | Hoist one `getLiveConfig` to the top, pass `cfgKv` down; delete the 4 redundant re-reads. Bound the 2 daily SELECTs: breaker → `SUM(realizedPnl)` (no full rows), open-count → `.limit()`. | `warEngine.ts:475,555,630,1363` (dup config reads) · `:484` (full-row daily-loss SELECT) · `:562` (open-today, no limit) | ~4 round-trips/cycle; O(today) not O(history) on a growing table | S | Same breaker/gate decisions vs baseline; row counts/logs unchanged. |
| **6** ⭐ | In-process `Map<ticker,conid>` (or short-TTL LRU) in front of the DB read in `resolveConid` (conids are effectively immutable). Keep the TASE-exchange validation in the memo key. | `server/conidResolver.ts:55-96`; hot at `liveOrderExecutor.ts:1371` (entry path), monitor/exit loops, `warEngine.ts:1440,1513` | Removes a DB round-trip from the confirmed-entry critical path + every management loop. Two audits flagged it. | S | Resolved conids identical to DB values; no mis-route; entry path one hop shorter. |
| **7** | (a) monitor per-position price/PnL UPDATE → dirty-check (skip unchanged rows). (b) Pre-parse `p.tickers` once in the mentor pattern cache instead of `JSON.parse` per pattern per call. | `liveOrderExecutor.ts:2354-2356` · `mentorScoreBoost.ts:73` | micro, pure (5-min + per-scan) | S | Behavior-identical; fewer writes/allocations. |

**All of Tier 1 is byte-identical in trading behavior** (pure refactors) or additive (indexes). No flag strictly required; #1 and #2 may optionally be flag/rollout-gated for a conservative A/B.

### Migration 0146 (proposed — additive, NEVER replay/edit 0145)
```sql
-- 0146_liveposition_hot_indexes.sql  (metadata-only; run off-hours)
CREATE INDEX livePositions_userId_status_idx           ON livePositions (userId, status);
CREATE INDEX livePositions_userId_status_closedAt_idx  ON livePositions (userId, status, closedAt);
CREATE INDEX livePositions_userId_openedAt_idx         ON livePositions (userId, openedAt);
CREATE INDEX livePositions_userId_ticker_status_idx    ON livePositions (userId, ticker, status);
```
Mirror in `drizzle/schema.ts` `(t)=>({…})`. Apply idempotently (catch "Duplicate key name"); register in `_journal.json` (see audit-plan P3 — journal is behind, 0134–0145 orphaned). **Do NOT `drizzle-kit push` on live.**

---

## Tier 2 — Higher value, touches order path / IBKR budget (INERT-gated · qa-architect + shadow before arm)

| # | Fix | Evidence | Win | Risk |
|---|-----|----------|-----|------|
| **8** | Pre-fetch short-eligible live prices in batched `/quotes` calls (50/call) before the scan loop → Map; drop the ~150 serial per-ticker `skipCache` calls. Keep the execution-time price revalidation intact. | `warEngine.ts:1208` (1/ticker, `skipCache`) vs `marketData.ts:595` (`BATCH_SIZE=50` used everywhere else) | **Largest wall-clock win** (kills ~150 serial IBKR round-trips) | HIGH — feeds short-entry pricing → flag `scanBatchPrefetchEnabled` default off |
| **9** | Narrow the global `entrySlotLock` hold window (mirror the Waiter: acquire → reserve/insert `pending_entry` → release, then `tryLiveEntry` outside the lock; the `uq_open_ticker` + reservation row is the authoritative single-fill guard). Or key the lock per-ticker. | `entrySlotLock.ts:16`; held `warEngine.ts:1720-2229` across the order transmit; cross-blocks Waiter+Phoenix | Removes cross-pipeline stalls | HIGH — order path / single-fill invariant. **INERT today** (`waiterEnabled=0`) → fix **before** arming Waiter, with qa re-proving the TOCTOU |
| **10** | Order-time re-verify reads the QuotesPoller in-memory tick (1.5s cadence, age-gated) first, falls back to live `/quotes` only when stale; run the two guard fetches with `Promise.all`. | `liveOrderExecutor.ts:1160` (re-verify), `:1180` (5-bar EOD guard) | 1–2 fewer blocking calls on the entry critical path | HIGH — staleness guard; preserve exact block conditions `:1168-1186`; flag default off |
| **11** | Hoist the per-candidate Waiter read to the pre-scan `openTickerSet` (ticker→isWaiterEntry map, O(1) lookup). | `warEngine.ts:1726` (read inside candidate loop) | Kills a flag-gated N+1 | LOW — **INERT today** (`waiterEnabled=0`); fix before arming Waiter |

---

## Tier 3 — Owner arming decision (machinery already built, not a code fix)

**Reaction latency:** the war cycle only fires at :00/:20/:40 → **up to ~19 min** from a confirmed breakout to `tryLiveEntry` (`alertPoller.ts:1199-1238`). The fix is already in-tree and flag-gated: `intradayArmedWatcher` (60s tick, routes through the **same** validated `runWarEngineCycle`, `elzaIntradayWatcherEnabled=0`, shadow mode present). This is **roadmap #1/#4** — arm the watcher after a shadow day; do NOT shorten the 20-min war cadence directly.

---

## Sequencing
1. **Tier 1 as one package** (pure/additive, zero trading-behavior change) — **#1 first** (highest volume, two-audit consensus), indexes (#2) off-hours. Ship after Cursor lands, via branch → PR → owner merge → `deploy-tradesnow.sh` → belly-check.
2. **Tier 2** only after qa-architect (+ shadow for #8/#10); **#9/#11 before** arming the Waiter.
3. **Tier 3** owner decision (roadmap).

## Discipline
- **Re-verify every `file:line` against live `main`** — Cursor edited in parallel.
- No parallel branch off `main` until Cursor's work lands; then rebase Tier-1 branch on the new HEAD.
- Indexes / any migration = **new file 0146+, additive, off-hours, never a replay of 0145.**
- Nothing in Tier 1 changes trading behavior. Tier 2 items that touch the order path stay INERT + shadow-validated. See [[QA_PLAN_WAITER_V45]], [[dev-roadmap-roi]], [[2026-07-01-system-architect-audit-plan]].
