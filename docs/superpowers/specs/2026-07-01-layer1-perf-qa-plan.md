# QA Plan — Layer 1 Performance (Safe Mechanical Wins)

> **Date:** 2026-07-01  
> **Status:** DRAFT — execute when Claude's Layer 1 **implementation spec** lands on `main`  
> **Prerequisite spec:** Layer 1 perf implementation (items #1–#7 from read-only audit)  
> **SSOT:** Git `main` · deploy via `/root/deploy-tradesnow.sh` · **no arm flags in this LOOP**

---

## Scope

| In scope | Out of scope |
|----------|--------------|
| #1 getStatus DB write-storm fix | #8 batched short-quote prefetch (Layer 2) |
| #2 migration 0146 composite indexes | #9 entrySlotLock window (Layer 2) |
| #3 getTickerIntelligence dedup | #10 order-time re-verify (Layer 2) |
| #4 bars 90/5 slice from 420 cache | #11 Waiter N+1 hoist (Layer 2) |
| #5 getLiveConfig hoist + breaker SUM | Armed watcher arm (#12 strategy) |
| #6 resolveConid in-memory memo | |
| #7 monitor dirty-check + mentor parse cache | |

**Invariant:** All Layer 1 changes must be **byte-identical at flags=0** on entry/exit paths unless the spec explicitly documents a display-only delta (e.g. `getStatus` payload unchanged, fewer DB writes).

---

## Phase QA-0 — Pre-merge gate (BLOCKER)

Run on branch **before** merge to `main`:

```bash
pnpm check          # 0 TS errors
pnpm build          # exit 0
pnpm test           # full suite — record count (baseline: 553/553 @ 8055243)
```

**Focused suites** (must stay green):

| Suite | Why |
|-------|-----|
| `server/tradeLedger.test.ts` | warReport / stats integrity |
| `server/hardSyncGuard.test.ts` | E2 guard not regressed |
| `server/entryChurnGuard.test.ts` | churn INERT + Phoenix C6 |
| `server/elzaV45LiveWiring.integration.test.ts` | never-naked, CB, EOD |
| `server/liveSafety.test.ts` | brackets |

**Git hygiene:**

- [ ] `git fetch origin && git pull --ff-only origin main` before branch
- [ ] **No** `git push --force` on `main`
- [ ] If `0146_*.sql` present: registered in `drizzle/meta/_journal.json` + row in `drizzle/ORPHAN_MIGRATIONS_APPLIED.md`
- [ ] **No** `drizzle-kit push` on live droplet

---

## Phase QA-1 — Per-item verification

### QA-1.1 — #1 getStatus write-storm (`liveEngine.ts`)

**Risk if wrong:** War Room shows stale/wrong prices vs IBKR Holdings.

| Test | Method | PASS |
|------|--------|------|
| Payload parity | Call `getStatus` twice 10s apart; diff `positions[].currentPrice`, `unrealizedPnl`, `dailyPct` | Same values ± IBKR tick (not zeroed) |
| Write volume | Enable general log / slow query log OR count `UPDATE livePositions` in 60s with War Room open (4s poll) | **Before:** ~N writes (≈ positions × polls/min). **After:** ≈0 writes on steady prices |
| IBKR row path | Open position with `fromIbkr=true` in code path | Displayed price = `/positions` mktPrice, not overwritten by `/quotes` feed |
| Non-IBKR row path | Cache-only ticker (if any) | `currentPrice` + `unrealizedPnl` still update in **response** even if DB write removed/reduced |
| Regression | `pnpm test` — add unit if spec includes dirty-check helper | Green |

**FAIL triggers:** Holdings P&L diverges from War Room; silent `currentPrice=0`; DB still ~195 writes/min unchanged.

---

### QA-1.2 — #2 migration 0146 indexes (`livePositions`)

**Risk if wrong:** Migration lock / duplicate index / wrong column order.

| Test | Method | PASS |
|------|--------|------|
| DDL idempotent | `SHOW INDEX FROM livePositions` on live **after** deploy | New indexes present, no duplicate names |
| EXPLAIN hot paths | `EXPLAIN` on representative queries: `userId+status`, `userId+status+closedAt`, churn ledger window | `type` not `ALL` on large table (or rows examined ↓ vs baseline screenshot) |
| Engine behavior | flags=0, 4 OPEN unchanged | Positions count + tickers identical pre/post |
| Rollback note | Document index names in spec | `DROP INDEX` script exists, untested unless emergency |

**Deploy window:** off-hours preferred (metadata lock on `livePositions`).

---

### QA-1.3 — #3 getTickerIntelligence dedup (`warEngine.ts`)

| Test | Method | PASS |
|------|--------|------|
| Functional parity | One full `runWarEngineCycle` (manual, market closed OK) — compare `scanned`, `topCandidates` hash/tickers | Identical to pre-change run (same day, same universe) |
| Call count | Temporary debug counter or spy in test | ≤1 `getTickerIntelligence` per ticker per cycle |
| Score stability | Same ticker finalScore long+short branches | ±0 (pure function — must not drift) |

---

### QA-1.4 — #4 bars slice from 420 cache (`marketData.ts`, `liveOrderExecutor.ts`)

| Test | Method | PASS |
|------|--------|------|
| Bar count | Log `bars.length` at entry SL calc for known ticker | ≥ min required (60/90 per spec) |
| SL/TP parity | `calcEntrySlTp` output for fixture ticker | Identical pre/post (golden snapshot test if added) |
| Cache miss | Ticker with <60 bars in cache | Graceful skip — no throw, no entry |

---

### QA-1.5 — #5 getLiveConfig hoist + breaker SUM (`warEngine.ts`)

| Test | Method | PASS |
|------|--------|------|
| Config consistency | Log `maxPositions`, `totalNlv` once vs mid-cycle | Single snapshot value used throughout |
| Breaker trip | Mock/integration: daily loss exceeds limit | Cycle aborts same as before (`daily_loss_limit_hit`) |
| Query shape | SQL log: breaker path | `SUM`/aggregate, not full row pull |

---

### QA-1.6 — #6 resolveConid memo (`conidResolver.ts`)

| Test | Method | PASS |
|------|--------|------|
| Cache hit | Two `resolveConid("AAPL")` in same process | Second = no DB round-trip (mock/spy) |
| Correctness | Unknown ticker still fails closed | No wrong conid on cache poison |
| Restart | PM2 restart clears memo (if in-memory only) | Documented — first resolve hits DB again |

**Note:** If memo is cross-request in-process, verify no conid swap across tickers (key = uppercase ticker).

---

### QA-1.7 — #7 monitor dirty-check + mentor parse cache

| Test | Method | PASS |
|------|--------|------|
| SL monitor | `runLiveSlMonitor` with `skipHardSync: true` in test | No redundant `UPDATE` when SL unchanged |
| Mentor boost | Repeated mentor read same session | Single `JSON.parse` per key per TTL |

---

## Phase QA-2 — INERT / byte-identical deploy

**Pre-deploy snapshot (owner or qa):**

```bash
git rev-parse HEAD origin/main   # must match
# DB
SELECT entryChurnGuardEnabled, minRValuePctEnabled, waiterEnabled FROM liveEngineConfig WHERE userId=1;
SELECT COUNT(*) FROM livePositions WHERE status='OPEN';
# 0145 columns still present (4)
```

**Deploy:**

```bash
/root/deploy-tradesnow.sh
```

**Post-deploy belly (5 min):**

| Check | PASS |
|-------|------|
| PM2 `tradesnow-app` online, no crash loop | ✅ |
| flags still 0/0/0 | ✅ |
| OPEN positions = same count/tickers | ✅ |
| Logs: no `ReferenceError`, no schema column errors | ✅ |
| QuotesPoller heartbeat climbing | ✅ |

---

## Phase QA-3 — Observability (optional but recommended)

Capture **before/after** on same off-hours window:

| Metric | How |
|--------|-----|
| `getStatus` DB writes/min | MySQL `SHOW GLOBAL STATUS` / slow log / app counter |
| War cycle wall time | `[WarEngine] Cycle started` → cycle end log delta |
| `runWarEngineCycle` scanned count | Log line unchanged |
| IBKR quote calls/cycle | Count `fetchIbkrLivePricesBatch` in logs if instrumented |

Store screenshots or log excerpts in PR description — not committed secrets.

---

## GO / NO-GO matrix

| Condition | Verdict |
|-----------|---------|
| QA-0 all green | Required for merge |
| QA-1.1 payload parity FAIL | **NO-GO** — display regression |
| QA-1.2 migration fails / lock timeout | **NO-GO** — rollback DDL plan |
| QA-2 OPEN count changed without IBKR reason | **NO-GO** |
| Any flag flipped by migration | **NO-GO** |
| Full suite green + belly green + QA-1.1 PASS | **GO** (Layer 1 only — still no flag arm) |

---

## Execution order (qa arm-gate)

```
1. QA-0 on PR branch
2. QA-1 items in spec order (1 → 7)
3. QA-2 deploy off-hours
4. QA-3 metrics (same day)
5. Owner sign-off → optional Layer 2 spec
```

---

## Handoff to Cursor / backhand

When Claude's implementation spec lands:

1. Re-verify every `file:line` against **current** `main` (line drift expected).
2. Map each spec task → QA-1.x section above.
3. Add new unit tests listed in spec to QA-0 table.
4. Do **not** start Layer 2 in same PR.

---

## Branch: `perf/tier1-safe-wins` (off `8055243`)

**Tip:** `85f3528` — **#4 reverted** (clean 6-item set). `553/553` on branch tip.

### Pre-merge BLOCKERS (from live QA on branch)

| ID | Verdict | Action |
|----|---------|--------|
| **#4** | **BLOCKER (fixed on tip)** | `9af3c8d` violated byte-identical: `slice(-90)` ≠ calendar-window ~69 bars → different SL. **Must stay reverted.** Add regression test: `fetchBarsForTicker(t,90)` bar count matches DB calendar path when 420 cache hot. |
| **#1** | **FIXED** | NLV persist `>$0.01` (was $50 gate). `tier1PerfQa.test.ts` guards regression. |
| **#2** | **APPLIED on droplet** | 4 composite indexes live. Journal `0146` registered. |
| **#3** | **PASS** | `_intelMemo` + `_getIntel()` sequential within ticker loop (`warEngine.ts:961-1256`); no `Promise.all` on branches. |
| **#6** | **PASS** | Only non-null post-`_resolveConidUncached`; TASE validation before memo. |
| **#7** | **PASS** | `tickersUpper` additive on cache object; single consumer `calcMentorBoost`. |

### #1 acceptance test (mandatory before merge)

```sql
-- After 60s War Room open + flat market:
SELECT totalNlv FROM liveEngineConfig WHERE userId=1;
-- Compare to IBKR NetLiquidation; delta must be ≤$50 OR warEngine must not use DB totalNlv for sizing that cycle
```

Log grep: one war cycle — `vixRiskSize` NLV input vs `/account/summary` NLV same minute.

---

*QA plan only — no runtime changes until implementation spec is merged.*
