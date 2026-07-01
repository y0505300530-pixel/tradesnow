# TradeSnow — System Architect Audit & Improvement Plan

> **Date:** 2026-07-01  
> **Status:** ✅ **Phase 0 COMPLETE** (2026-07-01) · Phoenix C6 shipped · **553 tests green** · CI on `main`  
> **Recovery tag:** `v2026.07.01-phase0` — annotated baseline after Phase 0 ship (churn C6 + CI + P0 fixes)  
> **SSOT:** Git `main` · deploy via `/root/deploy-tradesnow.sh`  
> **Related:** [`2026-06-30-elza-priority-roadmap-spec.md`](2026-06-30-elza-priority-roadmap-spec.md), [`2026-07-01-entry-churn-min-r-spec.md`](2026-07-01-entry-churn-min-r-spec.md), [`../../QA_PLAN_WAITER_V45.md`](../../QA_PLAN_WAITER_V45.md), [`../../drizzle/ORPHAN_MIGRATIONS_APPLIED.md`](../../drizzle/ORPHAN_MIGRATIONS_APPLIED.md)

---

## Executive Summary

TradeSnow is a **production-grade live engine** with never-naked, circuit breaker, EOD deleverage, and flag-gated rollout (**553 vitest tests**, build green, GitHub CI on `main`). **Money leaks on 30-Jun** trace to three axes — not one bug:

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
| `pnpm test` | **553/553 pass** |
| `pnpm build` | ✅ pass |
| God files | `warEngine.ts` 2468 LOC · `liveOrderExecutor.ts` 3128 LOC |
| CI | ✅ `.github/workflows/ci.yml` — pnpm install, build, test on push/PR to `main` |
| Modules without dedicated tests | warEngine, liveOrderExecutor, ibkrSync, alertPoller, pyramidEngine |

---

## Critical — Ship Blockers (P0)

### Live execution

| ID | Issue | Path | Fix |
|----|-------|------|-----|
| E1 | Armed Watcher enters **wrong ticker** (full war cycle, no `onlyTicker`) | `intradayArmedWatcher.ts` | ✅ **FIXED** — `onlyTicker` scoped `runWarEngineCycle` |
| E2 | HardSync marks **mass zombie** on empty IBKR response (no disappearance guard) | `liveOrderExecutor.ts` | ✅ **FIXED** — mass-disappearance guard (mirror ibkrSync) |
| E3 | Anti-churn **removed** — same-day re-entry after close | `warEngine.ts:782-800` | ✅ **SHIPPED INERT** (`entryChurnGuardEnabled`) + **Phoenix C6 bypass** (`shouldBypassChurnForPhoenix`) |
| E4 | **MIN_R_PCT** missing — 0.11% rValue passes RC2 max-only gate | `slCalculator.ts`, AAPL 30-Jun | ✅ **SHIPPED INERT** (`minRValuePctEnabled`) |
| E5 | Pyramid: IBKR fill, **DB insert fail** → SL/TP qty mismatch | `pyramidEngine.ts:268`, NSC 30-Jun | Atomic insert + schema verify |
| E6 | `CLOSED_IBKR_NO_PRICE` → `realizedPnl=0` | `ibkrSync.ts:273-274` | Recover fill price before close |

### Platform / schema

| ID | Issue | Path | Fix |
|----|-------|------|-----|
| P1 | Waiter columns in SQL + code, **missing from `schema.ts`** | `0143_waiter.sql`, `waiterEngine.ts` | Reconcile Drizzle schema |
| P2 | Phoenix ledger **three incompatible definitions** | `0139_*`, `0140`, `schema.ts` | Pick one SSOT |
| P3 | Drizzle journal stops at **0133** — 0134–0144 orphan SQL | `drizzle/meta/_journal.json` | ✅ **REGISTERED** — metadata only; see `ORPHAN_MIGRATIONS_APPLIED.md` |
| P4 | `warReport` includes RECONCILE P&L; `computeStats` excludes | `liveEngine.ts` | ✅ **FIXED** — `isExcludedFromStats()` unified |
| P5 | `closePosition` **IBKR-only fallback** bypasses engine guards | `liveEngine.ts` | ✅ **FIXED** — tracked row required |
| P6 | `LIVE_ACCOUNT_ID = "U16881054"` hardcoded | multiple | ✅ **FIXED** — `ENV.ibkrLiveAccountId` via `liveOrderExecutor` |
| P7 | `ibkrSync` missing `reconcileWaiterPositions` hook | `ibkrSync.ts` | ✅ **FIXED** — flag-gated hook wired |

### Tests (merge blockers per QA constitution)

| Test | Cause | Status |
|------|-------|--------|
| `waiterEngine.test.ts` INERT invariant | `ibkrSync.ts` lacks `reconcileWaiterPositions` | ✅ fixed (P7) |
| `ibkrAuth.test.ts` closePosition | Hebrew message / contract drift | ✅ fixed |

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

### Phase 0 — Stabilize (week 1, OFF-HOURS) ✅ COMPLETE

1. ✅ Fix 2 failing tests + wire `reconcileWaiterPositions`
2. Schema SSOT: Waiter + Phoenix + journal 0134–0144 (metadata registered; runtime reconcile pending)
3. ✅ Fix `warReport` RECONCILE filter
4. ✅ Unify `LIVE_ACCOUNT_ID`
5. ✅ Ship E1 (Armed scope) + E2 (HardSync guard)
6. ✅ Phoenix C6 churn bypass (`isPhoenixReentrySignal`, `shouldBypassChurnForPhoenix`, CG-G4)
7. ✅ GitHub CI workflow (`.github/workflows/ci.yml`)
8. ✅ `pnpm test` → **553/553** · recovery tag `v2026.07.01-phase0`

### Phase 1 — Money leaks (week 1–2)

1. `minRValuePctEnabled` (arm first)
2. `entryChurnGuardEnabled`
3. P1 War race + Armed deferred queue
4. `warEngine.race.test.ts`

### Phase 2 — Integrity (week 2–3)

Exit price recovery · pyramid atomic · deleverage reserve in `tryLiveEntry` · DB manual idempotency

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
| P0 | E2 HardSync guard + journal 0134–0145 | ✅ shipped |
| P0 | 2 tests + ibkrSync hook + E1 + P4/P5/P6 | ✅ shipped |
| P1a | MIN_R_PCT (INERT, await arm) | 🔴🔴🔴 |
| P1b | Churn Guard (INERT, await arm) + Phoenix C6 | ✅ shipped (INERT; arm after min-R) |
| P1c | Armed scope + HardSync guard | ✅ shipped |
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
- [x] `pnpm test` 553/553 pre-deploy (Phase 0 gate)

---

## Subagent Audit Sources (2026-07-01)

Consolidated from parallel read-only audits: War/Live execution hot path, DB/schema/API/UI, test suite smoke, security review (diff scope).

---

*Spec only — no runtime code. Implementation via LOOP + owner arm gates.*
