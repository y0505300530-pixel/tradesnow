# Spec — Entry Churn Guard + MIN_R_PCT gate

> **Status:** SPEC ONLY — no code · flag-gated · INERT until arm · **owner-ratified analysis**
> **Date:** 2026-07-01 · **SSOT:** Git `main` · deploy only via `deploy-tradesnow.sh`
> **Source:** 30-Jun analysis (AAPL×3, ZIM×3, GOOGL/AMD EOD trim) + code verification.
> **Supersedes** the earlier `2026-07-01-anti-churn-min-r-spec.md` draft (which mis-named the flag "R1").

## Executive Summary
Two P&L leaks on 30-Jun: (1) **churn** — automated re-entry after a same-day close (AAPL×3, ZIM×3); (2) **scalp geometry** — rValue ≈ 0.11% on an extended mega-cap (stop too tight → not tradeable). Both drove over-budget → EOD forced-cut (GOOGL; AMD trim collateral). High-ROI, small change, direct P&L + margin impact.

## ⚠️ Naming — "R1" is TAKEN (verified `warEngine.ts:1646` = Waiter↔War cross-pipeline lock)
| Feature | flag | log prefix |
|---|---|---|
| Anti-churn | `entryChurnGuardEnabled` | `[ChurnGuard]` |
| Min R% | `minRValuePctEnabled` | `[MinRPct]` |

---

## Feature 1 — Entry Churn Guard
**Verified:** `warEngine.ts:782` "SignalPersistence REMOVED"; `longBlockedTickers` empty. `tryLiveEntry` dedup (`liveOrderExecutor.ts:1071-1074`) = open/pending ONLY → a closed name re-enters. 30-Jun: AAPL closed 15:33 → re-entered 16:03 → 19:03; ZIM manual-close 14:52 → War 15:03 + 18:43.

**Rules (flag=1):**
| # | Rule |
|---|---|
| C1 | **1 automated entry / ticker / Israel calendar day** — count rows where `signal NOT LIKE 'MANUAL_%'` **and** `signal != 'PHOENIX_REENTRY'` (see C6) |
| C2 | **Cooldown 90 min** after any close (`closedAt`) incl. MANUAL_CLOSE / SL / EOD — **except** rows whose *next* entry is `PHOENIX_REENTRY` (see C6) |
| C3 | War loop: skip + log `[ChurnGuard] {ticker} skip: {reason}` BEFORE sizing |
| C4 | Same check in `tryLiveEntry` (War / Armed / LiveEngine) — **NOT** manual (C5) |
| C5 | Manual not blocked in v1 (v2 optional: cooldown for manual too) |
| C6 | **Phoenix carve-out:** when `phoenixProtocolEnabled=1` and `signal === 'PHOENIX_REENTRY'`, **skip ChurnGuard entirely** — `checkPhoenixAntiLoop()` + `phoenixLedger` are the authoritative ≤1/ticker/day + cooldown gate. ChurnGuard must NOT double-block reclaim after a Wide-Lung stop on the same ticker/day. |

**Phoenix interaction (Bugbot 2026-07-01):** ChurnGuard targets **War/Armed churn** (GOLD_RETEST_WAR, etc.), not Phoenix reclaim. With both flags armed, a ticker may have 1 War entry + 1 Phoenix re-entry max — Phoenix ledger owns the latter.

**Data (cache per-cycle in warEngine, like `openTickerSet` — NOT per-candidate query):**

Day boundary SSOT = `israelDateKey()` (`Asia/Jerusalem`) — **same helper as** `phoenixProtocol.ts`, circuit breaker, Armed watcher. **Do NOT use `CURDATE()`** (MySQL session TZ ≠ Israel).

```typescript
// Pseudocode — implement in entryChurnGuard.ts (pure, unit-tested)
import { israelDateKey } from "./phoenixProtocol"; // or shared dateUtil

function openedOnIsraelDay(openedAt: Date, day = israelDateKey()): boolean {
  return israelDateKey(openedAt) === day;
}

// Per-cycle cache (userId, day):
//   churnTickersToday = rows where openedOnIsraelDay(openedAt) && !MANUAL && signal !== 'PHOENIX_REENTRY'
//   cooldownUntil[ticker] = max(closedAt) + 90min for closes today (skip if next path is Phoenix — C6)
```

```sql
-- Illustrative only — prefer JS filter with israelDateKey() in application layer
SELECT ticker, openedAt, signal FROM livePositions
WHERE userId=? AND signal NOT LIKE 'MANUAL_%' AND signal <> 'PHOENIX_REENTRY';
-- then filter openedOnIsraelDay(openedAt) in TS
```
**INERT:** `entryChurnGuardEnabled=0` ⇒ zero DB reads, zero skips, byte-identical.

**Files (future LOOP):** `drizzle/0145_entry_churn_guard.sql` (col default 0) · `server/entryChurnGuard.ts` (NEW pure helpers) · `server/warEngine.ts` (gate) · `server/liveOrderExecutor.ts` (gate, non-manual) · `server/entryChurnGuard.test.ts`.
**GO:** CG-G0 tests green · CG-G1 flag=0 byte-identical · CG-G2 30-Jun replay: AAPL #2/#3 → SKIP · CG-G3 armed RTH day: 0 re-entry churn · **CG-G4** Phoenix: Wide-Lung stop → `PHOENIX_REENTRY` same day **allowed** when ledger permits (ChurnGuard does not block).

---

## Feature 2 — MIN_R_PCT gate
**Verified:** `slCalculator.ts:60` `MAX_STRUCTURAL_RISK_PCT = 0.12` caps risk TOO LARGE (>12%, enforced :489) — **no floor for TOO SMALL.** AAPL: entry $288.35 / stop $286.71 → rValue $0.33 = **0.11%**, `perShareRisk>0` ⇒ passes. Stop = `calcEntrySlTp` buffer `max(0.3×ATR, 0.2%)` past the structural level → tight on an extended name.

**Params:**
| Param | Default | Note |
|---|---|---|
| `MIN_R_VALUE_PCT` | **0.015** (1.5%) | below = skip |
| `minRValuePctEnabled` | **0** | INERT |

Why 1.5%: AAPL 0.11% blocked; NSC ~3.6% ($11.39/$312) passes; PANW blocked separately by RC2 max. (Price-tier variant = v2.)

**Single gate — AFTER `calcEntrySlTp`/`wideLungSL`, BEFORE `vixRiskSize`/`tryLiveEntry`:**
```
rPct = |entry - stop| / entry
if minRValuePctEnabled && rPct < MIN_R_VALUE_PCT → SKIP "[MinRPct] {ticker} r={rPct}% < {MIN}% — not tradeable"
```
Two call paths, SAME executor gate (SSOT): War (`warEngine.ts` post-RC2 ~1865) + `tryLiveEntry` (post-wideLungSL ~1305) — covers War + manual/alert.
**INERT:** `minRValuePctEnabled=0` ⇒ byte-identical.

**Files:** same `0145` migration · `server/slCalculator.ts` (`MIN_R_VALUE_PCT` export) · `server/minRValueGate.ts` (NEW pure `assertMinRValuePct()`) · `server/warEngine.ts` + `server/liveOrderExecutor.ts` (gate) · `server/minRValueGate.test.ts` (AAPL 0.11%→block, NSC 3.6%→pass).
**GO:** MR-G0 tests · MR-G1 flag=0 regression · MR-G2 AAPL replay → SKIP · MR-G3 NSC/PWR/DUK → still ENTER.

---

## Deploy + Arm order
```
1. migration (both flags = 0)   2. pure helpers + tests   3. wire warEngine + tryLiveEntry
4. deploy OFF-HOURS via deploy-tradesnow.sh   5. CG-G1 + MR-G1 regression
6. arm minRValuePctEnabled=1 FIRST (less controversial — only blocks bad geometry)
7. one RTH day monitor   8. arm entryChurnGuardEnabled=1
```
**No arm mid-RTH.**

## 30-Jun replay (expected)
| Trade | ChurnGuard | MinRPct |
|---|---|---|
| AAPL #1 15:23 | — | **SKIP** (0.11%) |
| AAPL #2/#3 | **SKIP** | **SKIP** |
| ZIM #2/#3 (post-close) | **SKIP** | — |
| NSC/PWR/DUK 14:20 | PASS | PASS |
| GOOGL 16:03 | PASS | PASS (r~2%+) |
→ less churn + fewer scalps → less over-budget → **GOOGL likely NOT EOD-cut.**

## NOT in this spec (deliberate)
Deleverage-reserve in tryLiveEntry (P2, hard block 21:50–22:30) · Armed scoped-entry queue (P1 roadmap) · `CLOSED_IBKR_NO_PRICE` sync bug (separate ticket) · manual governance (C5 policy).

## Verdict
Both = highest-ROI fixes from 30-Jun. Arm `minRValuePctEnabled` BEFORE `entryChurnGuardEnabled` (geometry gate is less behavior-changing than the churn ledger). See [[QA_PLAN_WAITER_V45]].
