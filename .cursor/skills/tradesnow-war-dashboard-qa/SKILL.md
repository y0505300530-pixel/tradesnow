---
name: tradesnow-war-dashboard-qa
description: >-
  TradeSnow War Room and War Report QA. Use when auditing war-room-live,
  war-report, win-rate, Daily P&L ribbon, liquidate X, RECONCILE P&L pollution,
  isExcludedFromStats, or dashboard numbers disagree. Triggers on War Room, War
  Report, win-rate, חדר מלחמה, דוח קרב, P&L dashboard.
---

# War Room + War Report QA

Works with `qa-master-persona` + `tradesnow-qa-trading`.

## Scope split

| Surface | Path | Backend |
|---------|------|---------|
| War Room Live | `client/src/pages/WarRoomLive.tsx` | `liveEngine.getStatus`, `closePosition`, `getElzaTrades` |
| War Report | `client/src/pages/WarReport.tsx` | `liveEngine.warReport` → `server/tradeLedger.ts` |

**These are reporting/ops layers** — bugs here do **not** block elzaV45 engine flip unless they cause wrong **order** actions.

## War Room matrix

| # | Check | File hints |
|---|-------|------------|
| W1 | Daily P&L SSOT = `summ.dailyPnlUsd` from IBKR | `WarRoomLive.tsx` ribbon |
| W2 | Refresh busts IBKR cache (not no-op `refetch({bustCache})`) | `handleWarRoomRefresh` |
| W3 | Liquidate X: hold-to-confirm + popup on error (not silent) | `closeP`, `OrderStatusPopup` |
| W4 | `ibkrConnected === false` → **red banner** visible | compare `.bgpoll_135632` backup |
| W5 | SlTpBadge: long=SELL SL, short=BUY cover | `slTpCoverage.test.ts` |
| W6 | Partial close: `await partialDeps(userId)` | `liveEngine.ts` ~821 |
| W7 | `getElzaTrades` win-rate uses same rules as War Report | see W8 |

## War Report matrix

| # | Check | File hints |
|---|-------|------------|
| R1 | Phantom/no-price/reconcile **excluded from stats AND P&L sums** | `isExcludedFromStats` everywhere in `warReport` |
| R2 | Win-rate denominator = decided (wins+losses), not including BE | `computeStats` in `tradeLedger.ts` |
| R3 | BE threshold = $1 (`classifyTradeOutcome`) | `livePnlStats.ts` |
| R4 | `partialRealizedPnl` included in totals | `toLedgerRow`, `getElzaTrades` |
| R5 | `droppedCount` matches all filtered rows | pre-filter vs `computeStats` |

Run: `npx vitest run server/tradeLedger.test.ts`

## Known backlog (verified 2026-06-28)

- **R1 drift:** `LEDGER_DROP_REASONS` omits RECONCILE in P&L loop — KPI vs win-rate disagree
- **W7 drift:** `getElzaTrades` counts BE in denominator, skips phantom filter
- **W4:** IBKR disconnect banner missing in active WarRoomLive
- **W6 fixed:** `await partialDeps(userId)` present
- **Close path:** IBKR-only fallback still at `liveEngine.ts:664-716` — test contract mismatch, ops risk

## Tests

```bash
npx vitest run server/tradeLedger.test.ts server/slTpCoverage.test.ts server/ibkrAuth.test.ts
# Playwright (needs creds + server):
PLAYWRIGHT_BASE_URL=https://trade-snow2.vip npx playwright test tests/05-full-qa-pages.spec.ts -g "War Room"
```

## Severity for flip

- **Flip blocker:** auth bypass, liquidate sends wrong qty, crash on open
- **Not flip blocker:** win-rate mismatch, RECONCILE in P&L strip, missing banner

## Output

Add section **War Dashboard Findings** to QA report with W1–W7 / R1–R5 table.
