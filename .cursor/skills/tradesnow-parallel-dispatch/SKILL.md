---
name: tradesnow-parallel-dispatch
description: >-
  Launch multiple TradeSnow code-writing agents in parallel for speed. Use when
  user wants parallel agents, multiple developers, מהירות, efficiency, or 2+
  independent code tasks. Read tradesnow-orchestrator first.
---

# Parallel Code Writers — TradeSnow

## When to use

User says: "פזר סוכנים", "במקביל", "frontend + backend", "מהירות", "parallel".

## Pattern (Orchestrator)

**One message → multiple Task tool calls** with `subagent_type: generalPurpose` or `explore`:

| Parallel OK | Sequential required |
|-------------|---------------------|
| Frontend component + Backend router (contract defined) | Backend API shape unknown → Backend first |
| Mobile CSS + Frontend logic different files | Same file edit |
| QA audit (readonly) + Frontend fix different areas | Live order E2E |
| Explore codebase + Frontend implementation | DB migration + code using new columns |

## Agent prompts (copy pattern)

### Backhand (Backend)
```
Agent: Backhand | Skill: tradesnow-backend-dev
Scope: server/** only
```

### Fronthand (Client)
```
Agent: Fronthand | Skill: tradesnow-frontend-dev
Scope: client/** only
```

### Fronthand-mobile
```
Agent: Fronthand-mobile | Skill: tradesnow-mobile-dev
Scope: client/** @375 responsive
```

## Max concurrency

- **3 writers** at once (Frontend + Backend + Mobile)
- **+1 QA** readonly in parallel if not blocking writers

## Merge protocol

1. Wait for all agents
2. If conflict on same file → Orchestrator resolves manually
3. Single `npm run build` after merge
4. Optional QA pass

## Speed anti-patterns

- One mega-agent for full feature
- Skipping build between parallel merges
- Frontend guessing API without Backend contract
