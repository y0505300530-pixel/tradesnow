# Live session changelog — 2026-07-01

Branch: `feat/multi-trading-accounts`  
Production: `pm2 tradesnow-app` from `/root/tradesnow/dist/index.js`

## Already committed (earlier today)

| Commit | Summary |
|--------|---------|
| `1d7e353` | War Room leverage Cockpit ↔ מינוף panel sync; `accountSlug` on `updateConfig` |
| `ed71867` | `maxPositionUsd` enforced on pyramid scale-in |
| `dff84b3` | Manual buy allowed on open ticker (skip duplicate-ticker block) |
| `cc446ad` | Manual add-on UPDATEs existing `livePositions` row (`uq_active_ticker`) |
| `2b4809b` | Manual pending LMT returns success + Hebrew pending message |
| `f4aa980` | `pending_entry` kept while IBKR bracket rests; manual LMT 1% cross |
| `fad736a`+ | Dror multi-account: IBIND2 `:5002`, catalog `catalogUserId`, dormant provisioning |

Bug write-ups: `2026-07-01-war-room-leverage-desync.md`, `2026-07-01-max-position-usd-breach.md`

## This commit batch (uncommitted → documented here)

### RC2 cap 14%

- `server/slCalculator.ts` — `MAX_STRUCTURAL_RISK_PCT = 0.14`
- Engine mirrors: `elzaV45Golden.ts`, `elzaV5Short.ts`, `elzaV5Bloodhound.ts`
- Doc: `2026-07-01-rc2-threshold-14pct.md`

### Gold Retest EMA50 gate

- `server/engine/elzaV45Master.ts` — retest only when price **above** EMA50 (≤3% premium)
- Doc: `2026-07-01-gold-retest-ema50-gate.md`

### portfolioHoldings stale sync

- `server/portfolioHoldingsSync.ts` — remove + prune helpers
- `server/ibkrSync.ts` — cleanup on close + end-of-cycle prune
- `server/routers/ibkr.ts` — Elza row removal when no open live + not at IBKR
- Doc: `2026-07-01-portfolio-holdings-stale-sync.md`

### Multi-account UX / safety

- `client/src/components/GlobalNav.tsx` — Settings menu for scoped viewers (`showSettings`)
- `client/src/hooks/useTradingViewerContext.ts` — expose `showSettings`
- `server/routers/tradingAccounts.ts` — `showSettings: true` for linked viewers
- `server/tradingAccounts.ts` — `Number(linkedLocalUserId)` coercion (MySQL string drift)
- `scripts/provision-dror-dormant.ts` — disable Dror engine by `userId` OR `tradingAccountId`

### Scripts (ops)

- `scripts/verify-dror-ibind2.ts` — IBIND2 gateway smoke test
- `scripts/verify-dror-getstatus.ts` — scoped `getStatus` verification
- `scripts/generate-dror-report.ts` — Dror portfolio report generator

## Not in git (generated artifacts)

- `reports/dror-elza-portfolio-report.{html,pdf}`
- `client/public/reports/` — static copies if present

## DB ops (not migrations)

- `snoozedTickers`: MTSI, RIOT — 720h snooze (`owner: not interested in auto Gold Retest`)
