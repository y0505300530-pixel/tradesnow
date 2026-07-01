# BUG: Position exceeds maxPositionUsd per ticker

**Reported:** 2026-07-01  
**Example:** PANW ~$139.6k with `maxPositionUsd` = $85,000  
**Severity:** High (concentration / risk limit breach)

## Symptoms

War Room shows a single-ticker notional well above the configured **מקסימום** ($85k) in לוח בקרה → גודל פוזיציה.

## Root causes

1. **`pyramidEngine` bypasses `tryLiveEntry`** — scale-in (+50% units) placed via direct `ibindRequest("/orders/bracket")` with **no `maxPositionUsd` check**. A $~85k entry + pyramid ≈ $127k+ (e.g. 267u + 134u = 401u).
2. **`tryLiveEntry` sizing** allowed `perPositionSize * 1.5` before clamp — unnecessary headroom above cap (removed).
3. **IBKR adoption / manual external buys** can still exceed cap (documented limitation); engine paths must not add past cap.

## Fix

- Shared helpers: `resolveMaxPositionUsd`, `capQtyToPerTickerNotional` in `liveOrderExecutor.ts`
- `pyramidEngine`: clamp or skip scale-in when `existing + add > maxPositionUsd`
- `tryLiveEntry`: use shared cap helper; drop 1.5× per-position bump

## Verification

```bash
npm test -- server/positionCap.test.ts
```

Manual: with max $85k and open PANW near cap, pyramid cycle must log skip/cap — not add shares.
