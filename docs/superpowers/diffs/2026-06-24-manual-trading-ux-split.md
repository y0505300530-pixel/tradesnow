# Manual Trading UX — Split Review Guide

Review **each file independently** before merge to live money.

## Layer 1 — Isolated primitives (review first)

| File | Lines (approx) | Focus |
|------|----------------|-------|
| `client/src/lib/manualOrderContract.ts` | ~95 | Types, `clientOrderId`, `isValidLivePrice` |
| `client/src/lib/orderFlightRegistry.ts` | ~65 | Per `ticker:side` STALLED blocking |
| `client/src/components/HoldToConfirmButton.tsx` | ~120 | Pointer capture, 600ms fill, keyboard path |
| `client/src/components/TradeActionGrid.tsx` | ~100 | 2×4 grid, per-side block |
| `client/src/components/OrderStatusPopup.tsx` | ~520 | STALLED 25s, no auto-fill |
| `client/src/components/deep-analysis/TradingCommandBar.tsx` | ~120 | Above-fold trading UI |
| `client/src/components/deep-analysis/ManualOrderDialog.tsx` | ~170 | Presets, no skipProtection |
| `client/src/components/deep-analysis/AdvancedDetails.tsx` | ~510 | Accordion metrics |
| `client/src/hooks/usePlaceManualOrder.ts` | ~60 | Hook stub |

## Layer 2 — Integration

| File | Lines | Notes |
|------|-------|-------|
| `client/src/components/DeepAnalysisModal.tsx` | ~1825 | Down from ~2456; orchestration only |
| `client/src/pages/WarRoomLive.tsx` | — | Hold-to-confirm liquidate |

## Mobile QA @ 375px

Dev preview (no auth, mock data): `http://localhost:3001/dev/mobile-trading-preview`

Screenshots: `docs/superpowers/screenshots/mobile-375/`

Playwright spec: `tests/mobile-trading-ux-375.spec.ts` (requires `npx playwright install chromium`)

## Blockers before merge to main

1. Server: `placeManualOrder` + `clientOrderId` idempotency
2. E2E against real procedure with auth
