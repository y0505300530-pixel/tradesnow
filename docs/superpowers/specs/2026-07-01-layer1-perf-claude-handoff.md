# Claude Handoff — Layer 1 Perf (`perf/tier1-safe-wins`)

> **To:** Claude / backhand  
> **From:** Cursor QA (2026-07-01)  
> **Branch:** `perf/tier1-safe-wins` (base `8055243`)  
> **QA plan:** [`2026-07-01-layer1-perf-qa-plan.md`](2026-07-01-layer1-perf-qa-plan.md)

---

## Status: READY FOR YOUR REVIEW + MERGE PR

Cursor applied **one code fix** on the branch (NLV persist threshold). Everything else is your commits + QA verification.

---

## What Cursor fixed (commit pending on branch)

### #1 NLV persist — **was BLOCKER, now fixed**

**Problem:** `$50` gate on `updateLiveConfig({ totalNlv })` while `warEngine` sizes off `getLiveConfig().totalNlv` (DB).

**Fix:** Persist NLV when `|delta| > $0.01` (position writes still dirty-checked). At most 1 NLV write per 4s poll — still ~195→~15 writes/min total win.

**File:** `server/routers/liveEngine.ts` (~706)

---

## What you already did right

| Item | Status |
|------|--------|
| **#4 cache slice** | ✅ **REVERTED** (`85f3528`) — do NOT re-introduce without bar-count equivalence test |
| **#2 indexes** | ✅ SQL + schema mirror — journal `0146` added by Cursor |
| **#3 intel memo** | ✅ Sequential `_getIntel()` — PASS |
| **#6 conid memo** | ✅ Non-null only, TASE before memo — PASS |
| **#7 dirty-check / mentor** | ✅ PASS |

---

## Your checklist before opening PR

```bash
git fetch origin
git checkout perf/tier1-safe-wins
git pull origin perf/tier1-safe-wins   # includes Cursor NLV fix + journal 0146
pnpm check && pnpm build && pnpm test  # expect 553/553
```

### Deploy bundle (owner, off-hours)

1. **Merge PR** to `main` (ff-only, no force)
2. **Apply 0146** on live DB idempotently:
   ```bash
   mysql ... < drizzle/0146_liveposition_hot_indexes.sql
   # or run each CREATE INDEX; ignore "Duplicate key name"
   ```
3. **Never** `drizzle-kit push` on production
4. `/root/deploy-tradesnow.sh`
5. **Belly:** flags=0, OPEN count unchanged, PM2 online

### Post-deploy QA (owner)

- War Room open 2 min → MySQL writes/min on `livePositions` **↓** vs baseline
- `getStatus` payload: prices/P&L match Holdings
- `SELECT totalNlv FROM liveEngineConfig` vs IBKR NetLiquidation: **≤ $1** drift
- `SHOW INDEX FROM livePositions` — 4 new composite indexes

---

## Hard rules (unchanged)

- No force-push `main`
- No arm flags in this PR
- No Layer 2 (#8–#11) in same PR
- canon / `feat/elza-v1-genesis` — do not touch

---

## GO / NO-GO

| Gate | Verdict |
|------|---------|
| #4 reverted | ✅ GO |
| #1 NLV fix | ✅ GO (after Cursor commit on branch) |
| 553 tests | ✅ required |
| 0146 applied with deploy | ✅ required |
| Belly green | ✅ required |

**After belly green → owner may schedule Layer 2 spec. Do NOT arm minR/churn in this PR.**
