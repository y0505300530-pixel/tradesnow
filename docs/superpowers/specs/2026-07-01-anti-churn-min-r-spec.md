# Spec — Anti-Churn (R1 same-day dedup) + MIN_R_PCT gate

> **Date:** 2026-07-01 · **Status:** DRAFT (owner-ratified analysis) · **SSOT:** Git `main`
> **Related:** [`docs/QA_PLAN_WAITER_V45.md`](../../QA_PLAN_WAITER_V45.md) · roadmap P1
> **Rollout:** both changes **flag-gated, default 0 → byte-identical** until owner arm.

## Goal
Stop two money-leaks proven on 2026-06-30: (1) War re-enters a name it already closed the SAME day with no cooldown (AAPL ×3 → −$245 + churn), and (2) a candidate whose structural stop is razor-thin (AAPL r ≈ $0.33 = **0.11%** of price) becomes a 0.1% scalp, not a swing. Both fed over-budget → EOD forced-deleverage of GOOGL.

## Evidence (verified in code)
- **No same-day re-entry block:** `warEngine.ts:782` — "SignalPersistence REMOVED"; `closedLongToday`/`longBlockedTickers` are empty sets (dead). `tryLiveEntry` dedup (`liveOrderExecutor.ts:1071-1074`) blocks only OPEN/pending — a CLOSED name re-enters freely.
- **No MIN_R floor:** `liveOrderExecutor.ts` skips only `rValue <= 0` (`:1294`, `:1959`) — a 0.11%-of-price stop passes because it is >0. The structural stop sits "JUST PAST" the level (buffer `max(0.3×ATR, 0.2%)`, `warEngine.ts:1840`) → tight on an extended name.

---

## Change 1 — R1 anti-churn (same-day re-entry ledger + cooldown)
**Flag:** `antiChurnEnabled` (tinyint, default 0). When 0 → no-op, byte-identical.

**Rule (when 1):**
- **≤ 1 War entry per ticker per trading day** (per direction). After a same-day CLOSE (any reason) the ticker is blocked for the rest of the RTH day from a NEW War entry.
- **Cooldown after MANUAL_CLOSE / SL:** `CHURN_COOLDOWN_MIN` (default 90; range 60–120) — no War re-entry on that ticker for N minutes after a manual close or stop-out (anti-revenge).
- Source of truth: rebuild `closedLongToday`/`closedShortToday` (+ a `lastCloseAt` map) from `livePositions` where `closedAt >= startOfRthDay(userId)` — the same pattern as Phoenix anti-loop. Mirror for SHORT.
- Enforcement point: in the war cycle candidate loop (`warEngine.ts` ~L782 region) populate `longBlockedTickers`/`shortBlockedTickers` from the ledger; a blocked ticker logs `[AntiChurn] {ticker} blocked — closed today / cooldown {mins}m` and is skipped BEFORE `tryLiveEntry`.
- **Waiter interaction:** the Waiter (retest LMT) is NOT churn — it is the *managed* re-entry path. Anti-churn applies to the War MARKET re-entry only. A Waiter resting LMT on a name closed today is allowed (it is a different, gated pipeline). Confirm no double-block with R1 lock.

**Files:** `server/warEngine.ts` (ledger + block), `drizzle/` (add `antiChurnEnabled` + `churnCooldownMin` to `liveEngineConfig`), `server/warEngine.test.ts` (ledger blocks a same-day-closed ticker; cooldown expiry; INERT at flag=0; Waiter path unaffected).

## Change 2 — MIN_R_PCT gate (skip razor-thin stops)
**Flag/param:** `minRPct` (double, default 0 = OFF; target 0.015 = 1.5%). When 0 → no-op.

**Rule (when >0):** in `tryLiveEntry`, right after the structural `rValue` is computed and the existing `rValue <= 0` skip (`liveOrderExecutor.ts:~1294`), add:
```ts
const rPct = rValue / effectiveEntry;                 // fraction of price
if (minRPct > 0 && rPct < minRPct) {
  log.warn("LIVE_EXEC", `[MinR] ${ticker} rPct ${(rPct*100).toFixed(2)}% < ${(minRPct*100).toFixed(1)}% floor — SKIP (scalp geometry, not a swing)`);
  return { entered: false, reason: `rPct ${(rPct*100).toFixed(2)}% below MIN_R_PCT ${(minRPct*100).toFixed(1)}%` };
}
```
- Applies to BOTH War and MANUAL entries (both funnel through `tryLiveEntry`) — a manual button-press on a 0.1%-r name is skipped too.
- Rationale: AAPL @ $288 / stop $286.71 → rPct 0.57% < 1.5% ⇒ SKIP. A real swing (r ≥ 1.5%) passes. Complements RC2 (which caps the MAX distance / anti-chase); MIN_R caps the MIN stop distance.

**Files:** `server/liveOrderExecutor.ts` (the gate), `drizzle/` (`minRPct` on `liveEngineConfig`), `server/liveOrderExecutor` test or `sizingEngine.test.ts` (r<floor → skip; r≥floor → pass; minRPct=0 → no-op / byte-identical).

---

## INERT rollout + GO gates
- Both flags default **0** ⇒ `pnpm test` byte-identical; deploy INERT; verify no behavior change over ≥3 War cycles.
- **G0:** `pnpm build` + new tests green.
- **G1 (inert):** flags=0 → an RTH day identical to baseline (same entries as before).
- **G2 (arm anti-churn):** `antiChurnEnabled=1` → an RTH day with **0 same-day War re-entries** on a closed ticker; the AAPL-3x pattern cannot recur.
- **G3 (arm min-R):** `minRPct=0.015` → 0 new entries with rPct<1.5% (log shows `[MinR] SKIP`); confirm we are not over-filtering legitimate swings (watch the entry count vs baseline).

## NOT in this spec (P2 follow-ups, separate)
- Deleverage-reserve window hard-block inside `tryLiveEntry` (21:50–22:30, incl. manual) — item #3.
- `CLOSED_IBKR_NO_PRICE` exit-price reconcile — item #4.
- Manual-order governance (required `reason` / audit) — item #5.

## Do NOT
- Do not touch Ziv score / RC2 / sizing / route.
- Do not block the Waiter retest pipeline (it is the managed re-entry, not churn).
- Do not deploy mid-RTH (engine-behavior change; after close or INERT only).
