---
name: tradesnow-loops
description: >-
  TradeSnow LOOPS workflow orchestrator — Spec → Build → Review cycle. Use when
  the user says LOOPS, loop, spec-build-review, or starts a new feature with
  structured phases. Routes to tradesnow-loops-spec, -build, -review skills.
---

# TradeSnow LOOPS

**LOOPS** = repeat until done: **Spec → Build → Review**.

## When to use

- New feature, refactor, or bugfix that touches more than one file
- User says: LOOPS, `/loops`, spec-build-review, "start a loop"
- Before merge or live flip — run at least one full loop

## The cycle

```
┌─────────┐     ┌─────────┐     ┌─────────┐
│  SPEC   │ ──► │  BUILD  │ ──► │ REVIEW  │
└─────────┘     └─────────┘     └────┬────┘
     ▲                               │
     └──────── fix / refine ─────────┘
```

| Phase | Skill | Exit gate |
|-------|-------|-----------|
| 1 Spec | `tradesnow-loops-spec` | Written spec + user OK |
| 2 Build | `tradesnow-loops-build` | build + tests green (evidence) |
| 3 Review | `tradesnow-loops-review` | No Critical blockers |

**Do not skip Spec for multi-file work.** One-line fixes may go Build → Review only.

## Routing

| User intent | Start at |
|-------------|----------|
| "LOOPS: add X" / new feature | **Spec** |
| Spec already approved | **Build** |
| Code done, "review this" | **Review** |
| Review found Critical issues | **Build** (then Review again) |

## TradeSnow overlays (always consider)

| Change touches… | Also apply |
|-----------------|------------|
| Live engine / elzaV45 | `tradesnow-live-parity` |
| War Room / War Report | `tradesnow-war-dashboard-qa` |
| Pre-flip / market open | `tradesnow-pre-open-flip` |
| UI | `ui-ux-master-persona` when user says UI/UX |
| QA audit | `qa-master-persona` |

## Artifacts (SSOT paths)

| Artifact | Path |
|----------|------|
| Spec | `docs/superpowers/specs/YYYY-MM-DD-<topic>.md` |
| Plan (optional) | `docs/superpowers/plans/YYYY-MM-DD-<topic>.md` |
| Review report | `docs/superpowers/handoff/loops-review-YYYY-MM-DD-<topic>.md` |

## Loop termination

Stop when: Review = GO (no Critical) **and** verification evidence attached.

Max iterations: 3 full loops — then escalate to user with open blockers.
