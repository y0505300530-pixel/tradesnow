---
name: tradesnow-deploy-smoke
description: >-
  TradeSnow deploy and smoke-test agent. Use for npm run build, pm2 health,
  playwright, route smoke /trade /war-room-live, market-open E2E A6 checklist.
  Triggers on deploy, smoke, E2E, market open, pm2, verification.
---

# TradeSnow Deploy / Smoke Agent

## Subagent

Use `shell` for commands; `cursor-ide-browser` for route smoke when available.

Also apply: `verification-before-completion` (superpowers).

## Pre-deploy checklist

```bash
cd /root/tradesnow/client && npm run build
cd /root/tradesnow && npm run build   # if full stack
```

Record exit code + last lines in report.

## Route smoke (post-deploy)

| Route | Pass criteria |
|-------|----------------|
| `/trade` | No ErrorBoundary; "Trade Manager" or holdings visible |
| `/war-room-live` | War Room loads |
| `/login` | Form renders |
| `/overview` | Cards render |

Production: `https://trade-snow2.vip/trade`

## Health (server — droplet)

```bash
curl -s -o /dev/null -w "%{http_code}" https://trade-snow2.vip/
pm2 status tradesnow-app   # on droplet only
curl -s http://127.0.0.1:5000/health  # IBIND — droplet only
```

## A6 — Market-open E2E (MASTER gate)

**Owner:** Claude on droplet · Cursor documents + verifies client side.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Admin + 2FA logged in | — |
| 2 | `placeManualOrder` 1 share liquid name | orderId returned |
| 3 | Order Event popup | submitting → filled |
| 4 | Wait 25s without fill update | STALLED + IBKR link |
| 5 | Re-submit same intent | idempotent — no 2nd live order |
| 6 | `protection.verified` | SL/TP banner when server returns |

Unblocks **B10** merge when ✅.

## Playwright (if available)

```bash
PLAYWRIGHT_BASE_URL=https://trade-snow2.vip npx playwright test tests/mobile-trading-ux-375.spec.ts
```

## Output template

```markdown
# Deploy / Smoke Report — YYYY-MM-DD

## Build
- client: ✅/❌
- server: ✅/❌

## Routes
| Route | Status | Notes |

## A6 E2E
- Status: ⏳ / ✅ / ❌
- Evidence: [orderId, screenshot, log]

## Recommendation
- [ ] Safe to merge B10
- [ ] Needs fix: ...
```

Save: `docs/superpowers/handoff/smoke-YYYY-MM-DD.md`

## Who deploys

| Action | Agent |
|--------|-------|
| Build in repo | Deploy/Smoke (Cursor) |
| `pm2 restart` on prod | Server Liaison / user / Claude |
