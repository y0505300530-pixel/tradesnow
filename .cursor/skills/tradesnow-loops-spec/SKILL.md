---
name: tradesnow-loops-spec
description: >-
  TradeSnow LOOPS phase 1 — write and approve specs. Use when starting LOOPS,
  writing a spec, design doc, requirements, acceptance criteria, or before
  multi-file implementation. Triggers on LOOPS spec, write spec, spec writes,
  מפרט, תכנון.
---

# LOOPS — Spec Writes

Phase 1 of LOOPS. **No code until spec is approved.**

Also apply: `brainstorming` (superpowers) for creative features.

## Workflow

1. **Explore** — read relevant files, `MASTER-OPEN-ITEMS`, existing specs
2. **Clarify** — one question at a time if scope unclear
3. **Draft spec** — use template below
4. **Self-review** — placeholders, contradictions, scope creep
5. **User approval** — explicit OK before Build phase

## Spec template

Save to: `docs/superpowers/specs/YYYY-MM-DD-<topic>.md`

```markdown
# [Title]

**Status:** DRAFT | APPROVED  
**LOOPS phase:** Spec  
**Owner:** [C/X or user]

## Problem
[One paragraph — what hurts today]

## Goal
[Measurable outcome]

## Non-goals
[What we will NOT do]

## Acceptance criteria
- [ ] AC1 — testable
- [ ] AC2 — testable

## Constraints
- Live==Backtest parity if engine: yes/no + note
- Files likely touched: `path/...`
- Iron rules: admin+2FA on orders, never naked, etc.

## Risks
| Risk | Mitigation |

## Open questions
- [ ] ...
```

## TradeSnow spec rules

- **Engine changes:** state parity impact; cite `elzaV45GoldenDNA` or `elzaV45Master` if relevant
- **P&L / dashboards:** name SSOT screen (War Room vs War Report vs Overview)
- **Live orders:** reference `liveOrderExecutor`, `warEngine` — never client-only SL
- **Hebrew UI copy:** note RTL / mobile 375 if UI spec

## Exit gate (Spec → Build)

- [ ] File saved under `docs/superpowers/specs/`
- [ ] Acceptance criteria are testable (not vague)
- [ ] User said **approved** / **GO to build** / equivalent

## Optional: implementation plan

If spec is large (>3 files), after approval invoke `writing-plans` →  
`docs/superpowers/plans/YYYY-MM-DD-<topic>.md`
