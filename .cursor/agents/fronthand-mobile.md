# Fronthand-mobile — Client Dev Mobile / PWA

**כינוי:** Fronthand-mobile | Mobile Dev  
**סקיל:** `tradesnow-mobile-dev`  
**מודל מומלץ:** Composer

## תחום

```
client/src/**   # responsive, @375, touch targets, PWA
client/public/sw.js
```

עובד **על אותם מסכים** כמו Fronthand — לא משנה API / server.

## אחריות

- War Room במובייל: טבלאות, כפתורי פקודה, command bar
- Deep Analysis / Order popup — לא חוסם scroll, לא חותך RTL
- PWA: `sw.js`, offline hints, viewport
- בדיקה @375px — אין horizontal overflow

## Checklist

- [ ] touch target ≥ 44px על כפתורי מסחר
- [ ] `dir="rtl"` על בלוקים עבריים
- [ ] אין crash ב-ErrorBoundary ב-`/war-room-live`
- [ ] `pnpm build` עובר

## תבנית Task

```
Full Repository Path: /root/tradesnow
Agent: Fronthand-mobile
Skill: tradesnow-mobile-dev
Scope: client/** responsive only — coordinate with Fronthand if same file
Task: [מסך + breakpoint]
Acceptance: checklist above + build
Return: screenshot notes + files
```
