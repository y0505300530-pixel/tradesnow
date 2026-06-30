# QA Audit Report — War Room E2E
**תאריך:** 26 יוני 2026 | **Build:** ✅ עבר (21.95s) | **מבדק:** קוד-סטטי + trace מלא

---

## Critical Vulnerabilities

### [Critical-1] `frozenReason` + `haltPendingExitSide` — Schema Drift
- **קבצים:** `corporateActionSync.ts:108`, `partialFillMonitor.ts:136,214,247`, `drizzle/schema.ts:1355`
- **Risk:** שני פילדים משמשים ב-code אך חסרים מ-Drizzle schema — Drizzle ישמיט אותם ב-INSERT בשקט
- **תיקון:** הוסף ל-`drizzle/schema.ts` בtabלת livePositions:
```ts
frozenReason:        varchar("frozenReason", { length: 127 }),
haltPendingExitSide: varchar("haltPendingExitSide", { length: 8 }),
```
ולאחר מכן: migration.

### [Critical-2] Partial Fill מחליף SL/TP ב-3%/6% hardcoded
- **קובץ:** `partialFillMonitor.ts:73-76`
- **Risk:** כל partial fill מחליף את ה-ATR-based SL/TP במספרים שרירותיים
- **תיקון:**
```ts
const newSl = pos.currentSl ?? (isShort ? entryPx * (1 + slPct) : entryPx * (1 - slPct));
const newTp = pos.currentTp ?? (isShort ? entryPx * (1 - tpPct) : entryPx * (1 + tpPct));
```

### [Critical-3] Halt Recovery שולח `conid: 0` → IBKR rejects
- **קובץ:** `partialFillMonitor.ts:229`
- **Risk:** פוזיציה נשארת פתוחה ללא הגנה לאחר halt
- **תיקון:**
```ts
const { resolveConid } = await import("./conidResolver");
const conid = await resolveConid(pos.ticker);
if (!conid) { log.error(...); continue; }
// use conid instead of 0
```

### [Critical-4] Break-Even SL לא נשלח ל-IBKR broker
- **קובץ:** `warEngine.ts:1654` + `liveSlTpEnforcement.ts`
- **Risk:** IBKR STP נשאר ב-initialSl גם כש-profitR ≥ 1.5R — ב-gap down יכול להיפגע בהפסד מלא
- **תיקון:** הוסף `pushBreakEvenStopToBroker` ב-manageOpenPositions (copy מ-pushTrailStopToBroker)

---

## High Findings

### [High-5] DailyLossBreaker מתעלם מ-unrealized losses
- **קובץ:** `warEngine.ts:183`
- **תיקון:** הוסף unrealized P&L לסכום: `openPositions.reduce((s, p) => s + (p.unrealizedPnl < 0 ? Math.abs(p.unrealizedPnl) : 0), 0)`

### [High-6] IronRules לא מעדכנים DB status אחרי close
- **קובץ:** `warEngine.ts:881,951,1029`
- **תיקון:** אחרי `closeRes.ok`: `await db.update(livePositions).set({ status: "pending_exit" }).where(...)`

### [High-7] gapGuard בודק IBKR vs IBKR, לא vs structural zone
- **קובץ:** `liveOrderExecutor.ts:338`
- **פרוט:** `currentPrice` ו-`resolvedEntry` שניהם IBKR-fresh — gap guard לא מגן מ-gap מרמה מבנית

### [High-8] Route label שגוי ב-entryStructMeta
- **קובץ:** `warEngine.ts:1341`
- **תיקון:** השתמש ב-`ziv.tier` ולא ב-`finalScore >= 9`

### [High-9] Enforcement fallback SL/TP 4%/8% ללא DB row
- **קובץ:** `liveSlTpEnforcement.ts:246-251`
- **תיקון:** `if (!dbRow) { log.warn(...); continue; }`

---

## Medium Findings

| # | קובץ | ממצא |
|---|------|------|
| 10 | `routers/marketScan.ts` | marketScan לא מחובר לcatalog (hardcoded universes) |
| 11 | `zombieRecoveryMonitor.ts:13` | userId hardcoded = 1 |
| 12 | `liveOrderExecutor.ts:274` | Math.max floor יכול לחרוג מ-remaining budget |
| 13 | `routers/favorites.ts:24` | Random watchlist ID — no collision guard |

---

## Build Result
```
✅ npm run build — PASSED (21.95s, 0 errors)
WarRoomLive: 100.37 kB gzip: 22.28 kB
```

## P0 — לפני market open הבא
תיקון 1, 2, 3 — כל אחד מסוגל להשאיר פוזיציה ב-IBKR ללא SL תקני.
