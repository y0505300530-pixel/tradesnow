---
name: tradesnow-design
description: >-
  TradeSnow design agent bridge. Delegates to ui-ux-master-persona for trading
  UI audits. Use for design, UX audit, friction, hierarchy before UI implementation.
  Triggers on design, UX audit, friction, hierarchy (project context).
---

# TradeSnow Design Agent

## Primary skill

**Always load first:** `ui-ux-master-persona` (`~/.cursor/skills/ui-ux-master-persona/SKILL.md`)

This skill adds **TradeSnow-specific** design context on top.

## Trading UI surfaces (priority order)

1. War Room LIVE — P&L header, position table, Elza status
2. Deep Analysis — command bar, ManualOrderDialog, liquidate hold
3. OrderStatusPopup — 7-state stepper, protection banner hierarchy
4. Trade Manager — CapitalSummaryCards, holdings density
5. Login / mobile nav

## TradeSnow design tokens

- Institutional light: white cards, blue accent `#2563EB` / `#4F46E5`
- P&L green `#65A30D` / red `#FF6B6B` — not neon
- z-index: header 40 < dialog 50 < order event 60 < toast 70
- Mobile @375 — no horizontal scroll; 44px touch on trade CTAs

## When Orchestrator dispatches Design

- **Before** large UI implementation (parallel with Architect optional)
- **After** QA reports friction (not crash bugs)
- Subagent: main chat or `generalPurpose` readonly with screenshots

## Output

Use ui-ux-master-persona template:
- **Friction Points & Flaws**
- **Actionable UI Patches** (copy-paste Tailwind/JSX)

Optional: save to `docs/superpowers/handoff/.../UX_AUDIT_YYYY-MM-DD.md`

## Handoff to Frontend / Mobile

Design does not merge code unless user asks. Patches go to:
- **Frontend** — component logic + layout
- **Mobile** — breakpoints, touch, PWA
