---
name: tradesnow-pre-open-flip
description: >-
  TradeSnow pre-market open and elzaV45 flip checklist. Use before market open,
  before setting elzaV45LiveEnabled=1, deployment freeze lift, Monday flip, or
  when user asks pre-flight, NO-GO, GO, owner flip. Triggers on flip, פתיחה,
  pre-open, elzaV45LiveEnabled, market open, חוגה.
---

# TradeSnow Pre-Open / Flip Checklist

## Authority

- **Flip `elzaV45LiveEnabled=1`:** owner-only. QA documents; QA does not flip.
- **Tonight default:** NO-GO to flip — flags stay 0 unless owner explicitly decides.

Also apply: `tradesnow-live-parity`, `qa-master-persona`, `tradesnow-deploy-smoke`.

## Phase 1 — DB state (run on droplet)

```sql
SELECT userId, isEnabled, elzaV45LiveEnabled, structuralExitsEnabled,
       riskSizingEnabled, goldBreakoutEnabled, zivRotationFlushEnabled,
       dailyLossEnabled, totalNlv, maxPositionUsd
FROM liveEngineConfig;

SHOW COLUMNS FROM liveEngineConfig LIKE 'elzaV45LiveEnabled';
SHOW COLUMNS FROM liveEngineConfig LIKE 'structuralExitsEnabled';
```

Expected pre-flip: `elzaV45LiveEnabled=0`, `zivRotationFlushEnabled=0`.

## Phase 2 — Automated gates

```bash
cd /root/tradesnow
npm run build
npx vitest run server/adversarialQaV45.test.ts server/slCalculator.test.ts server/tradeLedger.test.ts
npx vitest run server/ibkrAuth.test.ts   # note known test-debt on closePosition contract
```

## Phase 3 — Live smoke (market hours)

| # | Check | Pass |
|---|-------|------|
| P1 | `getStatus` → `ibkrConnected: true`, `ibkrSessionActive: true` | |
| P2 | War Room Daily P&L updates (not frozen 5.0k) | |
| P3 | A6 idempotency — same `clientOrderId` echoes, no duplicate order | |
| P4 | Open positions each have IBKR SL (SlTpBadge green) | |
| P5 | If flag=1: log shows `[VixSize]` / `[GoldenSSOT]` on first entry | |

## Phase 4 — Flip decision matrix

| Condition | Verdict |
|-----------|---------|
| Engine parity verified + owner approves | GO to flip |
| Any engine change since last parity sign-off | Re-run adversarial QA |
| Reporting-only bugs (#4/#5 War Report) open | GO for flip **if owner accepts** — does not block orders |
| IBKR-only close fallback (`liveEngine.ts:664`) open | Backlog — not flip blocker |

## Phase 5 — Post-flip (first 30 min)

1. Watch `pm2 logs tradesnow-app --lines 100` for `[VIXGuard]`, `[NEVER-NAKED]`, bracket errors
2. Confirm position count ≤ 12 long slots
3. Confirm no naked positions in IBKR `/positions` without SL
4. **Do not** re-enable `goldBreakoutEnabled` expecting it to block v4.5 breakouts — it does not apply on SSOT path

## Report template

```markdown
# Pre-Open Report — YYYY-MM-DD

## DB flags snapshot
[paste SELECT result]

## Tests: X/Y green

## Smoke: P1–P5

## Flip recommendation: GO / NO-GO

## Owner action required
- [ ] Explicit flip authorization
```

Save: `docs/superpowers/handoff/pre-open-YYYY-MM-DD.md`
