# TradeSnow — Agent Dispatch Guide

ראה גם: [`AGENTS.md`](../../AGENTS.md) — טבלה מלאה.

---

## כל הסוכנים בקצרה

| # | סוכן | פקודה | סקיל |
|---|------|--------|------|
| 1 | Orchestrator | `תכנן ופזר` | `tradesnow-orchestrator` |
| 2 | Client Dev | `@frontend` | `tradesnow-frontend-dev` |
| 3 | Backend Dev | `@backend` | `tradesnow-backend-dev` |
| 4 | Mobile Dev | `@mobile @375` | `tradesnow-mobile-dev` |
| 5 | QA Trading | `QA תבדוק` | `qa-master-persona` + `tradesnow-qa-trading` |
| 6 | Design | `UX audit` | `tradesnow-design` |
| 7 | Architect | `ארכיטקט SSOT` | `tradesnow-architect` |
| 8 | Security | `security review` | `tradesnow-security` |
| 9 | Deploy/Smoke | `smoke / deploy` | `tradesnow-deploy-smoke` |
| 10 | Server Liaison | `handoff לקלוד` | `tradesnow-server-liaison` |

---

## דוגמאות dispatch

### פיצ'ר full-stack מהיר
```
תכנן ופזר במקביל:
- @backend: procedure portfolio.getX
- @frontend: מסך שצורך getX
- @mobile: @375 על אותו מסך
אחרי: smoke + QA
```

### לפני merge B10
```
1. Architect: אין כפילות P&L
2. QA תבדוק /trade /war-room-live
3. security review
4. smoke build
5. אם A6 עבר — merge
```

### תיקון production crash
```
@frontend: ReferenceError ב-X
QA: regression /trade
smoke: trade-snow2.vip/trade
```

### שינוי server → production
```
@backend: [שינוי]
handoff לקלוד + עדכון MASTER A-item
```

---

## מודלים מומלצים (Task tool)

| סוכן | `model` ב-Task (אם נתמך) |
|------|---------------------------|
| Client / Backend code | `gpt-5.3-codex` או Composer |
| QA / Architect | `claude-4.6-sonnet-medium-thinking` |
| Architect מורכב | `claude-opus-4-8-thinking-high` |
| Mobile / smoke | `composer-2.5-fast` |

---

## פלטים — איפה נשמרים

| סוכן | נתיב |
|------|------|
| QA | `docs/superpowers/handoff/.../QA_AUDIT_*.md` |
| UX | `docs/superpowers/handoff/.../UX_AUDIT_*.md` |
| ADR | `docs/superpowers/adr/` |
| Smoke | `docs/superpowers/handoff/smoke-*.md` |
| Claude | `docs/superpowers/handoff/.../README_FOR_CLAUDE.md` |
| Diffs | `docs/superpowers/handoff/.../diffs/*.diff` |
