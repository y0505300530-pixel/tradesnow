---
name: tradesnow-loops-review
description: >-
  TradeSnow LOOPS phase 3 — review implementation against spec. Use after build,
  LOOPS review, code review, pre-merge audit, or when user says review phase.
  Triggers on LOOPS review, review, סקור, בדוק לפני merge.
---

# LOOPS — Review

Phase 3 of LOOPS. **Read-only audit** unless user asks to fix findings.

Also apply: `qa-master-persona`, `requesting-code-review`, `tradesnow-qa-trading`.

## Preconditions

- Spec file exists (or waiver documented)
- Build phase reported verification evidence

## Review workflow

1. **Diff against spec** — each AC: PASS / FAIL / PARTIAL
2. **Code review** — correctness, scope creep, iron rules
3. **Domain QA** — trading-specific matrix if orders/P&L/engine
4. **Verdict** — GO / NO-GO / LOOP (back to Build)

## AC checklist

Copy from spec; mark each:

```markdown
| AC | Status | Evidence |
|----|--------|----------|
| AC1 | ✅/❌/🟡 | file:line or test output |
```

## TradeSnow review matrix (add when relevant)

| # | Check |
|---|-------|
| R1 | Spec scope only — no unrelated diff |
| R2 | Live==Backtest not broken (`tradesnow-live-parity`) |
| R3 | Orders: adminProcedure + 2FA path intact |
| R4 | P&L: SSOT not duplicated in client |
| R5 | Tests cover new behavior (not only happy path) |

## Optional deep review

| Trigger | Tool |
|---------|------|
| User asks Bugbot | `review-bugbot` skill → subagent |
| User asks security | `review-security` skill |
| Pre-merge trading | `tradesnow-qa-trading` full matrix |

## Verdict rules

| Verdict | Meaning |
|---------|---------|
| **GO** | All AC ✅, no Critical findings |
| **LOOP** | Critical/High fixable → return to Build |
| **NO-GO** | Spec wrong or parity break → return to Spec |

## Report

Save: `docs/superpowers/handoff/loops-review-YYYY-MM-DD-<topic>.md`

Use qa-master-persona template:

```markdown
# LOOPS Review — [topic]

## Verdict: GO | LOOP | NO-GO

## AC results
...

## Critical Vulnerabilities
...

## Actionable Fixes
...
```

## Exit

- **GO** → user may merge / deploy per their process
- **LOOP** → invoke `tradesnow-loops-build` with fix list
- After 3 LOOP iterations → escalate to user
