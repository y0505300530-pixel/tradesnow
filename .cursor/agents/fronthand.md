# Fronthand — Client Dev (סוכן קוקפיט)

**כינוי:** Fronthand | Client Dev | Frontend  
**סקיל:** `tradesnow-frontend-dev`  
**מודל מומלץ:** Codex / Composer

## תחום בלעדי

```
client/src/**
client/public/**
shared/**          # רק אם נדרש לטיפוסים
```

**אסור:** `server/**`, `drizzle/**`

## אחריות

- War Room / Cockpit: `WarRoomLive.tsx`, `WarRoomCandidatesTable.tsx`
- ניתוח עמוק: `DeepAnalysisModal.tsx`, `OrderStatusPopup.tsx`
- Trade Manager, Overview, hooks (`usePortfolioMetrics`, tRPC consumers)
- UI gates: 2FA redirect, admin-only actions (לא לשבור auth)

## לפני "סיום"

```bash
cd /root/tradesnow && pnpm build
```

## תבנית Task

```
Full Repository Path: /root/tradesnow
Agent: Fronthand (Client Dev)
Skill: tradesnow-frontend-dev
Scope: ONLY client/** — NEVER server/
Task: [משימה ספציפית]
Acceptance: pnpm build; no undefined refs in changed files
Return: diff summary + screenshots if UI
```

## שיתוף עם Fronthand-mobile

- Fronthand = לוגיקה + דסקטופ + קומפוננטות
- Fronthand-mobile = @375, PWA, touch, safe-area — **אותם קבצים**, ממוקד responsive
