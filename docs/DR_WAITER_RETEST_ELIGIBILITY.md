# Decision Record — The Waiter retest eligibility & ambush SSOT

- **Date:** 2026-06-30
- **Status:** ACCEPTED (owner-ratified)
- **Decider:** owner
- **Supersedes:** the `RETEST_AMBUSH_ABOVE_PCT = 0.02` ambush model (2026-06-30 earlier)

## Context

The realigned G2 backtest (`scripts/waiterBacktest.ts`, mirrors the live engine) produced **0 resting LMTs over 60 days, and 0 over 8.5 months (81 Gold-Retest tier-hits → 0 placements).** Confirmed NOT a backtest bug — the script passes the STRUCTURAL `retestLevel` (not ema20) to `isNearRetestZone`. The zero-fill is a **broken spec**, not noise.

**Root cause — a logical contradiction between two layers (NOT "Ziv selects by EMA50" — that is outdated; Tier 3 already requires `detectTrueRetest`/`detectRoleReversal`, zivEngine.ts:290-300):**

| Layer | What it checks | When it fires |
|---|---|---|
| Ziv / candidate list | a CONFIRMED structural retest — price **at the level** (±2%, 5-candle hold) | usually `live ≈ retestLevel` (0–2% above) |
| Waiter zone + ambush | `live > retestLevel × 1.02` AND `live` in 2%–8% above the level | requires `live > +2%` above the level |

When Ziv confirms the retest, price is typically **not yet >+2%** above the structural level. The LMT sits at +2%; anti-chase requires `live > LMT` → **immediate rejection**. Additionally, `RETEST_AMBUSH_ABOVE_PCT = 0.02` contradicts `trueRetestEngine.LIMIT_ABOVE_PCT = 0.75%` and `FOMO_PCT = 1.5%`.

## Decision

**Option 2 (eligibility = structural execution-window, not tier label) + a SURGICAL parameter alignment from Option 3. NOT Option 1, NOT Option 3-alone.**

- **NOT Option 1 (ambush at EMA):** reverts Ziv P0-3 / `trueRetestEngine`. "Gold Retest" per Ziv = role-reversal / structural level, not "near EMA50." Option 1 reintroduces the old bug under the Waiter name.
- **NOT Option 3-alone (widen the zone):** the problem is a *logical contradiction*, not just "too narrow." Widening the zone to 15% would fill FAILED retests. Widen the **time window** (candidate only while in-band), not the stop.

## Implementation (the team builds this — `evaluateRetestV2` is the SSOT, it already exists)

1. **One ambush-price SSOT.** The Waiter consumes `evaluateRetestV2(...).limitPrice` (trueRetestEngine.ts:57-88 — `level × (1 + 0.75%)`, FOMO-capped at `level × (1 + 1.5%)`). Deprecate the separate `computeAmbushLimit` ×1.02 / `RETEST_AMBUSH_ABOVE_PCT` path (or make it a thin wrapper that delegates to `evaluateRetestV2.limitPrice`). **One reference, structural level.**
2. **Option 2 eligibility.** The Waiter candidate gate is `evaluateRetestV2(...).valid` (in-band ±0.5×ATR + 5-close hold + not-FOMO) — **NOT `tier === "Gold Retest"`**. The War list / UI may still display all Gold-Retest names (↩ column); the Waiter only ARMS the subset that is in the **execution window** vs `retestLevel`.
3. **Anti-chase aligned to FOMO.** Reject only when `live > limitPrice` AND `live > level × 1.015` (the FOMO cap), instead of the +2% rule.

### Parameter table

| Param | Today | Change to |
|---|---|---|
| `RETEST_AMBUSH_ABOVE_PCT` | 2% | **0.75%** (= `LIMIT_ABOVE_PCT`) |
| LMT price | separate `computeAmbushLimit` | **single SSOT** — `evaluateRetestV2.limitPrice` |
| FOMO cap | scattered | **1.5%** above level (`FOMO_PCT`, already in trueRetestEngine) |
| anti-chase | `live > ambush` (+2%) | `live > limitPrice` AND `live ≤ level × 1.015` |

## Verification gate (before any arm)

- **Re-run `waiterBacktest.ts`** with a NEW metric: **fills/session** (not only AvgR). **PASS = >0 LMTs placed over 60 days AND AvgR ≥ 0.**
- Optional: one-day intraday (5m) verification — not a blocker if daily shows fills.
- THEN: INERT deploy → 2 slots → scale. (Per `QA_PLAN_WAITER_V45.md` G3/G4.)

## Do NOT

| Action | Why |
|---|---|
| `waiterEnabled = 1` now | QA proved the system does not trade |
| Option 1 (EMA ambush) | regression vs Ziv P0-3 / trueRetestEngine |
| Option 3 alone (wider zone) | does not fix +2% vs ±2%-confirmation contradiction |
| deploy mid-RTH | discipline |

## QA note

Even with the correct `retestLevel`, the +2% ambush stays a blocker until aligned to 0.75% — the fix is the SSOT switch to `evaluateRetestV2.limitPrice`, not a wider zone. See [[QA_PLAN_WAITER_V45]].
