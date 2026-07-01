# Multi Trading Accounts — Team Rollout (Dormant First)

**Principle:** CEO live trading on `:5000` is **untouched**. Dror stack is built **asleep** until explicit go-live approval.

## Phase 0 — Dormant infrastructure (NOW)

| Owner | Task | Status |
|-------|------|--------|
| **Backend** | Migration `0146` — `ibkrGateways`, `tradingAccounts`, per-book `liveEngineConfig` | Code ✅ / DB via script |
| **Backend** | `tradingAccountContext` + scoped `getStatus` / `livePositions` | ✅ |
| **Backend** | `alertPoller` → **CEO cycle only**; Dror `isEnabled=0` | ✅ |
| **Backend** | `provision-dror-dormant.ts` — user + link, no engine | ✅ |
| **Frontend** | `/war-room/dror`, scoped nav, Overview Holding 1 only | ✅ |
| **Ops** | Run `npm run provision:dror-dormant` on server DB | Pending |
| **Ops** | Deploy branch `feat/multi-trading-accounts` (read-only UI) | Pending |

**CEO impact:** None — no second gateway, no Dror orders, no poller change.

## Phase 1 — Dror login QA (read-only)

| Owner | Task |
|-------|------|
| **QA** | Dror logs in → Overview shows only his Holding 1 (empty OK) |
| **QA** | Dror cannot see H1H2, transfers, knowledge, logs |
| **QA** | Admin Overview still CEO-only; Dror only via War Room switcher |
| **CEO** | Confirm War Room switcher shows Dror book (IBKR empty until Gateway) |

## Phase 2 — Dror IBKR Gateway (still dormant engine)

| Owner | Task |
|-------|------|
| **Ops** | IB Gateway `:5001`, `IBIND_API_SECRET_DROR`, `IBIND_HMAC_SECRET_DROR` |
| **Admin** | `tradingAccounts.updateIbkrAccountId({ slug:'dror', ibkrAccountId })` |
| **QA** | Dror War Room + Overview show live positions from **his** login only |

**Still:** `isEnabled=0` — no autonomous entries for Dror.

## Phase 3 — Go-live Dror engine (CEO explicit approval only)

| Gate | Action |
|------|--------|
| 1 | `liveEngineConfig.isEnabled = 1` for Dror |
| 2 | `MULTI_ACCOUNT_LIVE_ENABLED=1` |
| 3 | Smoke: CEO cycle unchanged; Dror cycle separate |

## Dror temporary login

Provision script writes `secrets/dror-dormant-login.txt` (gitignored):

```bash
npm run provision:dror-dormant
# optional fixed password:
DROR_TEMP_PASSWORD='YourTempPass123' npm run provision:dror-dormant
```

Default email: `dror@trade-snow2.vip`  
Login URL: `https://trade-snow2.vip/login`
