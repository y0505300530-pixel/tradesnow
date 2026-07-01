# TradeSnow — System Architect Audit & Improvement Plan

> **Date:** 2026-07-01  
> **Status:** ACCEPTED (advisor-ratified) · **SSOT:** Git `main` · deploy via `/root/deploy-tradesnow.sh`  
> **Related:** [`2026-06-30-elza-priority-roadmap-spec.md`](2026-06-30-elza-priority-roadmap-spec.md), [`2026-07-01-entry-churn-min-r-spec.md`](2026-07-01-entry-churn-min-r-spec.md), [`../../QA_PLAN_WAITER_V45.md`](../../QA_PLAN_WAITER_V45.md)

---

## Executive Summary

TradeSnow is a **production-grade live engine** with never-naked, circuit breaker, EOD deleverage, and flag-gated rollout (515 vitest tests, build green). **Money leaks on 30-Jun** trace to three axes — not one bug:

| Axis | Root cause | Evidence |
|------|------------|----------|
| **Orchestration** | War race, Armed → wrong ticker, HardSync mass-zombie | logs 30-Jun, `intradayArmedWatcher.ts:399` |
| **Policy** | anti-churn removed, MIN_R% missing, triple stop paths | `warEngine.ts:782`, AAPL rValue 0.11% |
| **Platform** | schema/journal drift, warReport P&L leak, hardcoded account ID | `drizzle/meta/_journal.json` ends 0133 |

**Verdict:** Safe but inconsistent. Phase 0 ship-blockers before any new arm.

---

## Health Snapshot (2026-07-01)

| Metric | Value |
|--------|-------|
| `pnpm test` | 513/515 pass (2 stale invariant tests) |
| `pnpm build` | ✅ pass |
| God files | `warEngine.ts` 2468 LOC · `liveOrderExecutor.ts` 3128 LOC |
| CI | **None** — no `.github/workflows` |
| Modules without dedicated tests | warEngine, liveOrderExecutor, ibkrSync, alertPoller, pyramidEngine |

---

## Critical — Ship Blockers (P0)

### Live execution

| ID | Issue | Path | Fix |
|----|-------|------|-----|
| E1 | Armed Watcher enters **wrong ticker** (full war cycle, no `onlyTicker`) | `intradayArmedWatcher.ts:399-405` | Scoped entry or direct `tryLiveEntry` |
| E2 | HardSync marks **mass zombie** on empty IBKR response (no disappearance guard) | `liveOrderExecutor.ts:2228-2241` | Mirror `ibkrSync.ts:182-189` guard |
| E3 | Anti-churn **removed** — same-day re-entry after close | `warEngine.ts:782-800` | `entryChurnGuardEnabled` — see churn spec |
| E4 | **MIN_R_PCT** missing — 0.11% rValue passes RC2 max-only gate | `slCalculator.ts`, AAPL 30-Jun | `minRValuePctEnabled` — see churn spec |
| E5 | Pyramid: IBKR fill, **DB insert fail** → SL/TP qty mismatch | `pyramidEngine.ts:268`, NSC 30-Jun | Atomic insert + schema verify |
| E6 | `CLOSED_IBKR_NO_PRICE` → `realizedPnl=0` | `ibkrSync.ts:273-274` | Recover fill price before close |

### Platform / schema

| ID | Issue | Path | Fix |
|----|-------|------|-----|
| P1 | Waiter columns in SQL + code, **missing from `schema.ts`** | `0143_waiter.sql`, `waiterEngine.ts` | Reconcile Drizzle schema |
| P2 | Phoenix ledger **three incompatible definitions** | `0139_*`, `0140`, `schema.ts` | Pick one SSOT |
| P3 | Drizzle journal stops at **0133** — 0134–0144 orphan SQL | `drizzle/meta/_journal.json` | Register migrations |
| P4 | `warReport` includes RECONCILE P&L; `computeStats` excludes | `liveEngine.ts:~1764` | Unified `isExcludedFromStats()` |
| P5 | `closePosition` **IBKR-only fallback** bypasses engine guards | `liveEngine.ts:~1119` | Gate behind confirm token or remove |
| P6 | Hardcoded `LIVE_ACCOUNT_ID = "U16881054"` | `ibkrSync.ts`, `ibkrPositionSync.ts` | `ENV.ibkrLiveAccountId` everywhere |
| P7 | `ibkrSync` missing `reconcileWaiterPositions` hook | `waiterEngine.test.ts:76` | Wire flag-gated hook |

### Tests (merge blockers per QA constitution)

| Test | Cause |
|------|-------|
| `waiterEngine.test.ts` INERT invariant | `ibkrSync.ts` lacks `reconcileWaiterPositions` |
| `ibkrAuth.test.ts` closePosition | Hebrew message / contract drift |

---

## High Priority (P1)

| ID | Issue | Effort |
|----|-------|--------|
| H1 | War race — `analyze` + `war` fire-and-forget parallel | M — P1 roadmap |
| H2 | Deleverage reserve slot-only; manual bypasses 21:50 window | S |
| H3 | Manual idempotency in-memory only | M |
| H4 | `getElzaTrades` / `getWarStatus` bypass ledger filters | S |
| H5 | `getStatus` writes DB every 4s poll | M |
| H6 | Global `entrySlotLock` serializes all tickers | M |
| H7 | Live ≠ backtest parity (2R/50% vs Golden 2.5R/40%) | L |
| H8 | Optimistic BP fail-open on cold start | S |

---

## Security Summary

**Good:** all `liveEngine` mutations on `adminProcedure`; confirm tokens on emergency/stop-buy.

**Gaps:** `manualTrimToOvernight` optional confirm token; War Room route not admin-gated in UI (API safe); `closePosition` IBKR fallback.

**Current diff (spec + migration only):** no new exploit paths.

---

## Phased Plan

### Phase 0 — Stabilize (week 1, OFF-HOURS)

1. Fix 2 failing tests + wire `reconcileWaiterPositions`
2. Schema SSOT: Waiter + Phoenix + journal 0134–0144
3. Fix `warReport` RECONCILE filter
4. Unify `LIVE_ACCOUNT_ID`
5. Ship E1 (Armed scope) + E2 (HardSync guard)
6. `pnpm test` → 515/515

### Phase 1 — Money leaks (week 1–2)

1. `minRValuePctEnabled` (arm first)
2. `entryChurnGuardEnabled`
3. P1 War race + Armed deferred queue
4. `warEngine.race.test.ts`

### Phase 2 — Integrity (week 2–3)

Exit price recovery · pyramid atomic · deleverage reserve in `tryLiveEntry` · DB manual idempotency · CI workflow

### Phase 3 — Waiter G2 (P2 roadmap)

5m backtest → shadow → 2-slot arm (after Phase 0.7)

### Phase 4 — Observability

`warEngineStatus` · daily post-RTH audit · orphan order cleanup

### Phase 5 — Architecture (ongoing)

Split god files · `entryGuards.ts` SSOT · short SSOT unification

---

## ROI Matrix

| Priority | Item | ROI |
|----------|------|-----|
| P0 | 2 tests + schema drift | merge blocked |
| P1a | MIN_R_PCT | 🔴🔴🔴 |
| P1b | Churn Guard | 🔴🔴🔴 |
| P1c | Armed scope + HardSync guard | 🔴🔴 |
| P1d | War race | 🔴🔴 |
| P2 | Platform P1–P7 | 🟠🟠 |
| P3 | Golden parity | 🟢 |

---

## Definition of Done — Healthy RTH Day

- [ ] Zero `ENTER>0 && entered=0` in <100ms
- [ ] Zero same-ticker re-entry same day (post churn arm)
- [ ] Zero entries with r/entry < 1.5% (post min-R arm)
- [ ] Zero `CLOSED_IBKR_NO_PRICE` without Telegram reconcile
- [ ] EOD excess < $20K before 22:00 IST
- [ ] IBKR positions = DB ± reconcile log
- [ ] `pnpm test` 515/515 pre-deploy

---

## Subagent Audit Sources (2026-07-01)

Consolidated from parallel read-only audits: War/Live execution hot path, DB/schema/API/UI, test suite smoke, security review (diff scope).

---

*Spec only — no runtime code. Implementation via LOOP + owner arm gates.*
