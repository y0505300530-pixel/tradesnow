# Decision Record — WAITER-ZIV-SSOT (one gate, like Ziv)

- **Date:** 2026-06-30 (night)
- **Status:** ACCEPTED (owner-ratified)
- **Decider:** owner
- **Supersedes:** `DR_WAITER_RETEST_ELIGIBILITY.md` (d8ba179) — that DR chose `evaluateRetestV2.valid` as the Waiter eligibility gate. **That was wrong** — it is a THIRD gate Ziv does not teach, and it produced 0 fills.

## Context — we invented a gate Ziv never defines

The Option-2 backtest (committed eccf880) still produced **0 LMTs**: all 9 Gold-Retest tier-hits dropped at `evaluateRetestV2.valid === false`. The earlier read ("structural retests are rare on daily bars") is **wrong**. Evidence (verified in code):

- **War ALREADY enters the same retests** — `warEngine.ts:241` routes `tier === "Gold Retest" → "GOLD_RETEST_WAR"`; NSC and DUK in the live book are retest entries. **The signal is not rare.**
- The Waiter shows 0 only because we layered `evaluateRetestV2` (±0.5×ATR band, trueRetestEngine.ts:24/52) + `detectZones`→`evaluateZoneGate` + `isNearRetestZone` (2–8% band) **on top of** what Ziv already defines in `detectTrueRetest` + `gapGuard`.

Per Ziv (lesson 14, 37; `docs/ziv-engine-spec/gaps/GAP_02_RETEST.md`):
- Retest is the **primary** entry route ("don't chase, wait"), not breakout. 10–15 names on a watchlist; a pullback to demand in an uptrend is **routine**.
- Entry = **LMT 0.5%–1% above the broken level** (`priorBreakoutLevel × 1.0075`).
- Zone = **±2% around the structural level** (`RETEST_TOLERANCE_PCT`, GAP_02:100,105 → `level × 0.98` floor) — NOT a separate ATR band.
- FOMO = **gapGuard 1.5%** measured against `priorBreakoutLevel` (GAP_02:68-78), not market price.
- EMA = **context, not a gate** (lesson 14: "MA for the support decision, not a gate").

| Ziv / GAP_02 (`detectTrueRetest` + `gapGuard`) | What we wrongly built into the Waiter |
|---|---|
| structural level (`priorBreakoutLevel`) | + zone edge from `detectZones` |
| ±2% touch of the level | + ±0.5×ATR band |
| 5-close hold on the level | + 5-close hold on a *different* band |
| LMT = level × 1.0075 | + `valid === false` almost always |

**Result:** a name can be Gold Retest (Ziv ✓) and the Waiter says no (artificial gate ✗).

## Decision

**WAITER-ZIV-SSOT — one gate, the SAME one War uses.**

> **The Waiter = the same signal as a War Retest, just entered with a resting LMT instead of a market order.**

### Remove (the invented layer)
- ❌ `evaluateRetestV2.valid` as the Waiter ARM condition
- ❌ `detectZones` → `evaluateZoneGate` in the Waiter path
- ❌ `isNearRetestZone` (2–8% above structural level) as a separate gate
- ❌ any EMA20 fallback

### In its place — Waiter candidate = ALL of (GAP_02, RT-rules)
1. `tier === "Gold Retest"` (zivEngine — `detectTrueRetest` or role-reversal)
2. `retestLevel != null` (= `priorBreakoutLevel`)
3. `weeklyBullish === true` (existing)
4. `live > ema50` (RT-08 — daily uptrend; EMA as **context**, not gate)
5. `distPct = |live − retestLevel| / retestLevel × 100` ; **`distPct ≤ 2.0`** (RT-03 — touch/approaching the zone)
6. `live ≥ retestLevel × 0.98` (RT-04 — not broken below the floor)
7. gapGuard: `(live − retestLevel) / retestLevel × 100 ≤ 1.5` (EX-03 — not FOMO)
8. (optional) `distPct ≤ 5.0` (EX-07 — not too far from the zone)

No `valid`, no ATR band, no zone engine.

### LMT price (lesson 37)
```
limitPrice = retestLevel × 1.0075          // 0.75% above the broken level — single SSOT
anti-chase (Ziv FOMO): if live > retestLevel × 1.015 → SKIP
limitPrice ≥ live is OK — the ambush waits for the bounce above the level ("buy the bonus")
```
**Stop:** `stop = max(retestLevel × 0.99, wideLungSL(entry, ema50, "long"))` (parity).
**Size:** `vixRiskSize` — 1% NLV (unchanged).

### Frequency (what the owner asked)
| Param | Value | Why |
|---|---|---|
| scan | every 60s | not one daily bar |
| top-N | 10–15 | like Ziv's watchlist |
| early ARM | when `distPct ≤ 5%` AND FOMO not blocking | ambush before the touch (lesson 37: alert ~2% before) |
| FILL | LMT rests until touch / EOD / falling-knife | passive |

### Files
| File | Change |
|---|---|
| `server/waiterEngine.ts` | `placeNewRestingLimits` — new gate; `computeAmbushLimit(retestLevel)` only (drop evaluateRetestV2) |
| `scripts/waiterBacktest.ts` | same gate — remove `evaluateRetestV2` |
| `server/waiterEngine.test.ts` | tests to the Ziv SSOT |
| `server/warEngine.ts` | R1 dedup stays; ensure `retestLevel` is threaded |

**Do NOT touch:** sizing, slot guard, 30% sub-cap, falling-knife, R4 never-naked — all stay.

## GO gate (before any arm)
```
fills_60d  > 0
fills_8mo  > 0
avgR ≥ 0   (desired, not blocking)
```
If still 0 → the problem is in `detectTrueRetest` / the universe, **not** the Waiter.

## Before / after
| Before | After |
|---|---|
| "Gold Retest + 4 extra gates from zonesEngine" | "Gold Retest + ±2% touch + FOMO 1.5% → LMT" |
| rare signal (0 LMT) | same frequency as War retest — with a LMT |

## Bottom line
We were not missing Ziv — **we added a gate he does not have.** Ziv does not hunt rarity; he hunts a **pullback to a structural level in an uptrend** — which happens often. The Waiter must follow **GAP_02 / `detectTrueRetest` only**, no `evaluateRetestV2`. See [[DR_WAITER_RETEST_ELIGIBILITY]] (superseded), [[QA_PLAN_WAITER_V45]].
