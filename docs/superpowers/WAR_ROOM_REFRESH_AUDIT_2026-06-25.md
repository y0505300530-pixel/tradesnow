# War Room — Refresh Rate Audit (2026-06-25)

## Summary

User reported stale POS table. Root cause: **client polled every 5s but server price cache was 15s**, so DAILY % / DAILY $ could lag up to 15s. OPENED column empty because IBKR-live rows had `openedAt: null` (not merged from DB).

## Client poll intervals (War Room)

| Query | Interval | Notes |
|-------|----------|-------|
| `liveEngine.getStatus` | **4s** | Was 5s (PF-01). Drives POS table |
| `liveEngine.getAllLiveOrders` | **4s** | Was 5s |
| `liveEngine.getElzaTrades` | 15s | Performance stats |
| `liveEngine.getLastScanStats` | 30s | Scan metadata |
| `liveEngine.getStopNewBuys` | 30s | Toggle state |
| `liveEngine.getLiveCircuitBreaker` | 15s | CB status |
| `liveEngine.getAllowShort` / `getBlockedTickers` | 30s | Config |

War Room does **not** call `useIbkrMarketData` directly — all POS data flows through `getStatus`.

## Related hooks (other pages)

| Hook | Interval (RTH) | Off-hours |
|------|----------------|-----------|
| `useIbkrMarketData` | 3s | 5 min |
| `useIbkrSync` positions/summary | 10s | 5–10 min |
| `useIbkrSync` /pnl | 10s | off |
| `useIbkrSync` IBIND health | 10s | — |

## Server cache TTL

| Layer | TTL | Used by War Room |
|-------|-----|------------------|
| `ibkrCache` default | 30s | Other routes |
| `WAR_ROOM_IBKR_TTL_MS` | **4s** | `/positions`, `/orders`, `/pnl`, `/account/summary` in `getStatus` |
| `fetchIbkrLivePricesBatch` default | 15s | Holdings, Overview |
| `fetchIbkrLivePricesBatch` War Room | **4s** (`maxCacheAgeMs`) | DAILY %, DAILY $ enrichment |
| Manual refresh | `skipCache: true` | Busts IBKR + quote cache |

## What updates each column

| Column | Source |
|--------|--------|
| VALUE, PNL $ | IBKR `/positions` (`mktPrice`, `unrealizedPnl`) — authoritative |
| PNL % | Derived from `unrealizedPnl / costBasis` |
| DAILY %, DAILY $ | IBKR `/quotes` via `fetchIbkrLivePricesBatch` + `enrichPositionDisplay` (mark vs `prevClose`) |
| Account daily (ribbon) | IBKR `/pnl` (`dpl`) with position-sum fallback |
| OPENED | `livePositions.openedAt` from DB (merged into IBKR rows) |

## OPENED column empty (—)

- IBKR `/positions` has no open-date field.
- `getStatus` mapped IBKR rows with `openedAt: null` and only merged SL/TP order IDs from DB.
- **Fix:** merge `openedAt` from `livePositions` for Elza-tracked tickers. Manual/adopted-only positions without DB row still show —.

## PF-01 history

| Version | `getStatus` poll |
|---------|------------------|
| Original | 3s |
| PF-01 (QA sprint) | 5s (mobile perf) |
| This audit | **4s** + aligned server price cache |

## Fixes applied (2026-06-25)

1. Client `getStatus` + orders poll: 5s → **4s**
2. Server `getStatus` price fetch: `maxCacheAgeMs: 4s` (was effective 15s)
3. Manual refresh: `bustCache: true` on refetch
4. OPENED: merge `openedAt` from `livePositions`
5. UI: table header shows last update + poll interval; SYNC box shows real poll (not hardcoded 15s)

## Effective worst-case staleness (after fix)

~**4–8s** (client poll + server IBKR/quote cache), vs ~**15–20s** before.
