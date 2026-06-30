---
name: tradesnow-qa-trading
description: >-
  TradeSnow trading QA agent. Use before merge or after trading UI bugs. Combines
  qa-master-persona with domain checks: Order Event Manager, SL/TP, IBKR parity,
  mobile 375, build smoke. Triggers on QA trading, smoke test, pre-merge, regression.
---

# TradeSnow QA Trading

Works with `qa-master-persona` when user says QA / בדוק.

## Pre-merge gate

1. `cd /root/tradesnow/client && npm run build` — must pass
2. Grep undefined refs in changed files: `\b(ibkr|state|data)\b` used without definition
3. Route smoke (dev or prod): `/trade`, `/war-room-live` — no ErrorBoundary crash
4. MASTER item status updated

## Trading matrix (add to 5-point QA)

| # | Check |
|---|--------|
| T1 | Order popup: 7 states; REJECTED on API error (not silent close) |
| T2 | `protection.verified` — banner only with server SL/TP |
| T3 | STALLED 25s + IBKR portal link |
| T4 | qty / opposite position warnings (not hard-block wrong side) |
| T5 | Mobile 375 — command bar, manual order, liquidate hold |
| T6 | P&L parity — Trade Manager vs Overview vs War Room header (note drift) |
| T7 | adminProcedure paths — no order from non-admin |

## Report path

`docs/superpowers/handoff/cursor-manual-trading-ux-*/QA_AUDIT_REPORT_YYYY-MM-DD.md`

## Severity

- **Critical** — crash, wrong money, stuck popup, auth bypass
- **High** — misleading SL/TP, qty mismatch live
- **Medium** — visual hierarchy, copy
- **Low** — polish

## Output

Use qa-master-persona template + section **Trading-Specific Findings**.
