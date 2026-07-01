# BUG: portfolioHoldings stale after livePositions close

**Reported:** 2026-07-01  
**Severity:** Medium (UI shows inflated holdings total)

## Symptoms

- War Room / holdings UI showed **~$382k** while open `livePositions` summed **~$298k**.
- **PANW** and **PWR** appeared in `portfolioHoldings` after `livePositions` were marked `closed`.
- User perceived incorrect exposure after sells.

## Root cause

1. `ibkrSync` closed `livePositions` when IBKR qty=0 but **did not** delete matching `portfolioHoldings` rows (`source=elza`).
2. `syncFromIbkr` only removed holdings with `source='ibkr'`, not Elza-mirrored rows with no open live row.
3. Elza closes (`CLOSED_IBKR_NO_PRICE`, manual sync) left ghost rows until next full IBKR frontend sync.

## Fix

- `portfolioHoldingsSync.ts`: `removePortfolioHoldingForTicker`, `pruneStalePortfolioHoldings`.
- `ibkrSync.ts`: call remove on every close path; prune stale rows end-of-cycle.
- `routers/ibkr.ts`: `syncFromIbkr` removes Elza rows absent from IBKR when no open `livePosition` remains.

## Verification

1. Close a position at IBKR → within 60s `portfolioHoldings` row for ticker is gone.
2. Holdings total ≈ sum of open `livePositions` notional (no closed tickers).
