# Multi Trading Accounts — Spec (2026-07-01)

## Goal
Run ELZA Live on **multiple IBKR accounts** with separate logins, shared USA catalog (`userId=1`), and per-account War Room + live config.

## Accounts (v1)

| Slug | Label | Gateway | NLV | Leverage | Max pos | Position | minOrderUsd |
|------|-------|---------|-----|----------|---------|----------|-------------|
| `ceo` | CEO ELZA | `:5000` | ~$123k | 1.9× overnight | 12 | up to $85k | $5,000 |
| `dror` | דרור | `:5001` | $20,000 | 1.8× intraday | 8 | ~$5,000 | $4,000 |

- **Duplicates across accounts:** allowed (same ticker in CEO + Dror).
- **Dror engine:** seeded `isEnabled=0` until IBKR account id is wired and QA passes.

## Architecture

```
tradingAccounts ──► ibkrGateways (host/port + env secret keys)
       │
       ├── liveEngineConfig (per account, unique tradingAccountId)
       └── livePositions.tradingAccountId

AsyncLocalStorage (tradingAccountContext) routes ibindRequest → correct gateway
War Engine: runWarEngineAllAccounts() — one cycle per enabled account
```

## Env (Dror gateway)

- `IBIND_API_SECRET_DROR`
- `IBIND_HMAC_SECRET_DROR`
- Gateway base URL: `http://127.0.0.1:5001`

## API

- `tradingAccounts.list` — admin sees all; linked user sees own
- `tradingAccounts.resolve` — bind gateway context
- `tradingAccounts.updateIbkrAccountId` — admin, after account opens
- `liveEngine.getStatus({ accountSlug })` — scoped positions + config

## UI

- `/war-room-live` — admin, account switcher (CEO / Dror / …)
- `/war-room/dror` — Dror scoped view (no global admin controls)

### Scoped viewer nav (linked `tradingAccounts.linkedLocalUserId`, non-admin)

| Surface | Dror |
|---------|------|
| Overview | Holding 1 only (IBKR book via `getStatus`) |
| H1H2 / Transfer Ledger / Knowledge Hub / System Logs | Hidden + route blocked |
| War Room | `/war-room/dror` |

## Migration

`drizzle/0146_multi_trading_accounts.sql` — tables, seed, CEO config link, Dror config, drop `userId` unique on `liveEngineConfig`.

## Rollout

1. Run migration on DB
2. Start Dror IB Gateway on port 5001 + env secrets
3. `updateIbkrAccountId({ slug: 'dror', ibkrAccountId: '…' })`
4. Enable Dror: `liveEngineConfig.isEnabled = 1`
