# BUG: H2 TASE Today shows +0.00% after market close (weekday evening)

**Reported:** 2026-07-01 19:07 IL — Overview H2 TASE Today +$0 while DB had real session moves  
**Severity:** High (wrong daily P&L display)

## Symptoms

- **Holding 1** Today ~+3% (US open) — OK
- **H2 TASE** Today **+0.00% (+$0)** with 17 positions — wrong
- DB `holding2` had valid `prevClose`, `dailyChangePercent`, `dailyBasePrice` (expected ~**+$728 / +0.32%**)

## Root cause

1. `portfolio.ts` `getLivePrices` and `priceStream.ts` used **`isTaseClosed()`** (outside RTH hours) to force `change=0` for all `.TA` tickers.
2. At **19:07 weekday** TASE RTH is over → server zeroed `change` / `changePercent`.
3. `computeTodayPnl` Priority 1: `change != null` → `0 * units` → never reached `prevClose`.
4. Overview fix `2a1eb19` could not help — poisoned API data arrived first.

**Naming bug:** comment said "holiday/weekend" but code used **any after-hours**.

## Fix (2026-07-01)

| File | Change |
|------|--------|
| `server/utils/marketHours.ts` | `isTaseClosedToday()` — Sat/Sun/holiday only |
| `server/routers/portfolio.ts` | `zeroChange` only when `isTaseClosedToday()` |
| `server/routers/priceStream.ts` | same |
| `client/src/hooks/usePortfolioMetrics.ts` | `computeTodayPnl`: if `change===0` but `price≠prevClose`, use prevClose; H2 skip aligned with Overview |
| `client/src/hooks/usePortfolioAnalytics.ts` | same baseline logic for .TA |

## Verification

1. Weekday **19:00–23:00 IL** — Overview H2 TASE Today ≈ sum of `(price−prevClose)×units` from DB (not $0).
2. **Saturday** — H2 TASE Today shows `—` or 0 without stale Friday bleed (no baseline).
3. `pnpm test server/utils/marketHours.taseToday.test.ts`
