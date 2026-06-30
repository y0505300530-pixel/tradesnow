---
name: tradesnow-security
description: >-
  TradeSnow security review bridge. Use before merge on auth, 2FA, orders, secrets.
  Loads review-security skill and trading-specific checks. Triggers on security,
  auth audit, 2FA, secrets, pre-merge security.
---

# TradeSnow Security Agent

## Primary skill

Use Cursor skill: `review-security` → launch **Security Review** subagent (`security-review`, `readonly: true`).

Add trading-specific checklist below to the prompt.

## Trading security checklist

| # | Check | Where |
|---|--------|-------|
| S1 | Live orders only `adminProcedure` | `server/routers/ibkr.ts`, liveEngine |
| S2 | `protectedProcedure` inherits 2FA | `server/_core/trpc.ts` |
| S3 | Client cannot call IBIND gateway directly for orders | client uses tRPC only |
| S4 | No secrets in client bundle or `.project-config` | grep keys in client/ |
| S5 | `JWT_SECRET` ≥ 32 chars in prod | `validateEnv` |
| S6 | Idempotency on manual orders (A7) | `manualOrderLock` |
| S7 | Fail-closed on missing price for closes | warEngine, liveOrderExecutor |

## When to run

- Before **B10** merge to main
- After any change to `auth`, `ibkr`, `placeManualOrder`, `RequireVerified`
- User prompt: "security review"

## Output

P0/P1 findings format from `review-security` subagent:

```markdown
## Security Review — TradeSnow

### P0 (ship blockers)
...

### P1 (fix before merge)
...

### Trading-specific (S1-S7)
...
```

## Dispatch

Orchestrator runs Security **in parallel with QA** when paths don't overlap (readonly).
