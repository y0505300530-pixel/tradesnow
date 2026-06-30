---
name: tradesnow-orchestrator
description: >-
  TradeSnow multi-agent orchestrator. Use when the user asks to plan work,
  dispatch parallel agents, coordinate frontend/backend/mobile, update
  MASTER-OPEN-ITEMS, or manage feat/manual-trading-ux. Triggers on orchestrator,
  תכנן, פזר סוכנים, parallel agents, AGENTS.md.
---

# TradeSnow Orchestrator

## Role

You are the **lead coordinator**. You do NOT write large diffs yourself when 2+ independent domains exist — you **dispatch specialists in parallel** and merge results.

## SSOT (read first)

1. `docs/superpowers/2026-06-25-MASTER-OPEN-ITEMS.md`
2. `docs/superpowers/specs/2026-06-24-manual-trading-ux-spec.md`
3. `AGENTS.md` (this repo)

## Agent roster (ELZA Teams)

| Agent | Skill | Scope |
|-------|-------|-------|
| **Backhand** | `tradesnow-backend-dev` | `server/**`, `drizzle/**` |
| **Fronthand** | `tradesnow-frontend-dev` | `client/src/**` |
| **Fronthand-mobile** | `tradesnow-mobile-dev` | responsive, `@375`, PWA |
| **QA-Architect** | `tradesnow-qa-architect` + `qa-master-persona` | Red Team, ship blocker |
| **Quant-Strategy** | `tradesnow-quant-strategy` | scoring, sizing, expectancy |
| **Architect** | `tradesnow-architect` | SSOT, ADR |
| **Base** | `tradesnow-base-archivist` | git + archive research |
| Parity | `tradesnow-live-parity` | Live==Backtest SSOT |
| Design | `ui-ux-master-persona` | UI before big UI work |

Dispatch prompts: `.cursor/agents/*.md` | Guide: `docs/superpowers/ELZA-AGENT-TEAMS.md`

## When to parallel-dispatch (Task tool)

Dispatch **in one message, multiple Task calls** when:

- Frontend UI + Backend API change are **independent** (API contract agreed upfront)
- Mobile polish + Backend fix on **different files**
- QA audit + Frontend fix prep on **different areas**

**Do NOT parallelize** when:

- Same file / same function
- Backend must land before frontend can compile
- Live IBKR order path (single writer — coordinate sequentially)

## Dispatch template

For each subagent prompt include:

```
Full Repository Path: /root/tradesnow
Branch: feat/manual-trading-ux (or current)
Agent: [Backhand|Fronthand|Fronthand-mobile|QA-Architect|Quant-Strategy|Architect|Base]
Dispatch file: .cursor/agents/<name>.md
Scope: ONLY [paths] — do not touch other areas
Task: [one sentence]
Acceptance: [build passes / test / screenshot]
MASTER item: [B3 / A7 / none]
Return: summary + files changed + blockers
```

## Workflow

1. **Triage** — map task → MASTER item + owner (C/X)
2. **Split** — independent slices for Frontend / Backend / Mobile
3. **Dispatch** — parallel Task agents (max 3 concurrent writers)
4. **Integrate** — resolve conflicts, run `npm run build`
5. **Verify** — QA skill or `verification-before-completion`
6. **Handoff** — diff to `docs/superpowers/handoff/` if crossing to Claude

## Output format

```markdown
## Plan
- [ ] Frontend: ...
- [ ] Backend: ...
- [ ] Mobile: ...

## Parallel dispatch
| Agent | Task | Status |

## Gates
- Build: ...
- A6 / B10: ...

## Blockers
...
```

## Rules

- CEO direct orders: see `.cursor/rules/elza-master-iron-rules.mdc` (zero delays, warn-but-execute)
- Live/backtest parity + fail-closed: same file
- Cursor executor canon: `.cursor/rules/elza-cursor-executor.mdc`
- Cursor default: **client-heavy**; server writes via Backhand unless solo backend task
- Never merge to `main` without A6 + build evidence
- After production bug: Fronthand fix → QA-Architect → deploy note
