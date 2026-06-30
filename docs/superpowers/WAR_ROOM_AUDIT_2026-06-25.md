# War Room Audit — 2026-06-25

> **Scope:** Protection status, iron rules (חוקי ברזל), logging, security, order flow, P&L/display.  
> **Auditor:** QA / War Room subagent `7c2fc840` — verified and patched in Agent mode.

---

## Executive Summary

| אזור | סטטוס | הערה |
|------|--------|------|
| **הגנה (SL/TP)** | 🟡 PARTIAL | שרת חזק; UI מטעה תוקן ב-`SlTpSyncBox` (G1 ✅) |
| **חוקי ברזל** | 🟢 PASS (שרת) / 🟡 PARTIAL (UI) | אכיפה ב-`warEngine` + `liveOrderExecutor`; Software-SL fallback |
| **לוגים** | 🟢 PASS | `dbLog` + System Logs; War Room snippet + לינק (G7 ✅) |
| **אבטחה** | 🟢 PASS | `runWarEngine` → `adminProcedure` (G2 ✅); `/logs` → `RequireAdmin` (G6 ✅) |
| **Order flow** | 🟡 PARTIAL | `protection` prop ב-War Room popup (G4 ✅); כניסות דרך Deep Analysis נפרד |
| **P&L** | 🟢 PASS | SSOT מוגדר; שורת סיכום ≠ סכום שורות (מכוון) |

---

## Remediation Status (2026-06-25)

| Gap | חומרה | סטטוס | תיקון |
|-----|--------|--------|--------|
| **G1** | P1 | ✅ FIXED | `SlTpSyncBox` משתמש ב-`isPositionSlTpCovered` (IBKR orders + DB fallback) |
| **G2** | P1 | ✅ FIXED | `insights.runWarEngine` → `adminProcedure` |
| **G3** | P2 | ✅ FIXED | `getStatus` slMap/tpMap: `isExitSide` לפי direction |
| **G4** | P2 | ✅ FIXED | War Room `OrderStatusPopup` מקבל `protection` מתגובת close/entry |
| **G5** | P3 | ✅ FIXED | `getStatus`: מזג `ibkrSlOrderId`/`ibkrTpOrderId` מ-DB |
| **G6** | P3 | ✅ FIXED | `/logs` route → `RequireAdmin` |
| **G7** | P3 | ✅ FIXED | War Room: snippet `getLastScanStats` + לינק `/logs` |

---

## 1. Protection Matrix

| פריט | מיקום | סטטוס | פירוט |
|------|--------|--------|--------|
| `skipProtection` הוסר | קוד TS/TSX | **PASS** | אין התאמות בקוד — רק בתיעוד ישן |
| Bracket entry (SL+TP IBKR) | `liveOrderExecutor.tryLiveEntry` | **PASS** | OCA bracket; abort אם אין SL |
| `placeManualOrder` תמיד מגן | `liveEngine.ts` L686-745 | **PASS** | `tryLiveEntry` בלי דגל skip |
| באנר "מוגן" אחרי FILLED | `OrderStatusPopup` | **PASS** | War Room מעביר `protection` (G4); חיסול עם `trackPositionClose` לא מציג באנר |
| `SlTpBadge` בשורות | `WarRoomLive` + `SlTpBadge.tsx` | **PASS** | משווה ל-IBKR orders; תומך short=BUY |
| `SlTpSyncBox` / SL/TP GUARD | `WarRoomLive` | **PASS** (post-G1) | בודק כיסוי SL+TP דרך orders חיים, לא רק `ibkrTpOrderId` |
| סנכרון SL/TP ידני | `liveEngine.syncSlTp` → `liveSlTpEnforcement` | **PASS** | CRON + כפתור; מטפל ב-short cover |
| Software SL fallback | `liveOrderExecutor.runLiveSlMonitor` | **PARTIAL** | יציאה תוכנתית אם SL חסר ב-IBKR — גיבוי, לא native בלבד |
| `getStatus` SL/TP מחירים | `liveEngine.getStatus` L132-155 | **PASS** | `isExitSide` לפי long/short (G3 ✅) |
| `ibkrSlOrderId` בשורות | `getStatus` IBKR map | **PASS** | ממוזג מ-DB (G5 ✅); `SlTpBadge` + live orders |

---

## 2. Iron Rules Table

| # | כלל | איפה נאכף | ניתן לעקוף? | סטטוס |
|---|-----|-----------|-------------|--------|
| 1 | תקציב / downsizing | `warEngine.ts` IronRule1 | רק אם IBKR down + אין positions | **PASS** |
| 2 | מעבר לילה 22:30 IST | `warEngine.ts` IronRule2 | אותו דבר | **PASS** |
| 3 | מקס פוזיציות | `warEngine.ts` IronRule3 | סגירה weakest score | **PASS** |
| 4 | Daily loss breaker | `warEngine.ts` L136-211 | fail-closed על שגיאת בדיקה | **PASS** |
| 5 | Max daily orders | `warEngine.ts` L215-261 | pause entries בלבד | **PASS** |
| 6 | Marketable LMT (לא MKT) | `liveMarketOrder`, `executeLiveSell` | לא בנתיב הרגיל | **PASS** |
| 7 | SL/TP native IBKR | `tryLiveEntry` bracket | Software-SL ב-monitor | **PARTIAL** |
| 8 | מחיר חי לכניסה | `warEngine` price guards L886-922 | skip entry, לא fail-open | **PASS** |
| 9 | Penny stock < $2 | `warEngine` L901-910 | archive ticker | **PASS** |
| 10 | `protection.verified` רק מהשרת | `OrderStatusPopup` L134-139 | War Room מעביר מ-response (G4) | **PASS** |

**Client vs Server:** כל הכללים הקריטיים לכסף — **שרת בלבד**. Client: `HoldToConfirmButton`, `RequireAdmin`, `RequireVerified` — שכבות UX בלבד.

---

## 3. Logging Matrix

| אירוע | מה נרשם | איפה | משתמש רואה? |
|-------|---------|------|-------------|
| WarEngine cycle start/end | `[WarEngine]` / `[IronRuleN]` | `dbLog` → `systemLogs` | Settings → System Logs / `getLastScanStats` |
| כניסה/דחייה | `[WarEngine] ✅/❌` | `dbLog` | כן (SYSTEM) |
| Bracket / sell | `log.info("LIVE_EXEC", ...)` | קובץ לוג + ring | `/logs` (admin API) |
| closePosition | `log.info("LIVE_EXEC", "closePosition...")` | כן | admin |
| SL/TP enforcement | `liveSlTpEnforcement` details | `log` + toast ב-UI | toast + logs |
| War Room UI errors | `console.error("[WarRoom]")` | console בלבד | לא |
| טאב לוגים ב-War Room | — | הוסר | L717: "Logs → Settings > System Logs" |

**סטטוס:** **PASS** לריצות מנוע; **PASS** לנראות מ-War Room (G7: snippet + לינק לוגים).

---

## 4. Security

| שכבה | מימוש | סטטוס |
|------|--------|--------|
| Route `/war-room-live` | `RequireAdmin` + `RequireVerified` | **PASS** |
| 2FA | `protectedProcedure` / `adminProcedure` → `needs2fa` | **PASS** |
| `liveEngine.*` mutations/queries | `adminProcedure` | **PASS** |
| Destructive actions | `requestActionToken` + `confirmToken` | **PASS** |
| `insights.runWarEngine` | `adminProcedure` | **PASS** (G2 ✅) |
| `/logs` page | `RequireAdmin` + `RequireVerified`; API = `adminProcedure` | **PASS** (G6 ✅) |
| Engine ON ללא token | `updateConfig isEnabled:1` | **PASS** (מכוון) |

---

## 5. Order Flow

| פריט | סטטוס | פירוט |
|------|--------|--------|
| 7-state popup | **PASS** | `orderEventManager` phases |
| Close + tracking | **PASS** | `trackPositionClose` + `getExitProgress` 2s poll |
| Failed dismiss | **PASS** | `immediateStatus: "failed"` → `rejected` |
| Stalled 25s | **PASS** | `STALLED_MS`; כפתור IBKR portal |
| Duplicate order guard | **PASS** | `orderPopupOpen` חוסם liquidate |
| Polling entry | **PASS** | `getOrderStatus` 3s |
| Protection after fill | **PASS** (post-G4) | `protection` prop; כניסות עיקריות ב-`DeepAnalysisModal` |

---

## 6. P&L / Display

| מטריקה | מקור | עקביות |
|--------|------|--------|
| Daily P&L (hero) | `summ.dailyPnlUsd` מ-IBKR `/pnl` | **PASS** SSOT |
| שורת סיכום Daily | `accountDailyUsd = summ.dailyPnlUsd ?? sum rows` | **PASS** עם fallback |
| Unrealized שורות | IBKR `unrealizedPnl` | **PASS** BUG-WR-003 fix |
| Monthly P&L | `liveNlv - monthlyStartNlv` | **PASS** |
| סכום שורות vs header Daily | שורות = open positions בלבד | **PARTIAL** (מכוון) |
| Leverage | server-computed `summary.leverage` | **PASS** |

---

## קבצים מרכזיים

- `client/src/pages/WarRoomLive.tsx`
- `client/src/components/OrderStatusPopup.tsx`
- `client/src/components/war-room/SlTpBadge.tsx`
- `server/routers/liveEngine.ts`
- `server/routers/insights.ts`
- `server/liveOrderExecutor.ts`
- `server/warEngine.ts`
- `server/liveSlTpEnforcement.ts`

---

## Top 5 Findings (מקורי)

1. **הגנה בשרת — חזקה:** `skipProtection` הוסר; `tryLiveEntry` שולח bracket IBKR.
2. **SL/TP GUARD מטעה — תוקן (G1):** `SlTpSyncBox` בודק כיסוי מ-orders חיים.
3. **באנר "מוגן" — תוקן (G4):** War Room מעביר `protection` ל-popup.
4. **חור אבטחה RUN cycle — תוקן (G2):** `runWarEngine` = `adminProcedure`.
5. **חוקי ברזל + לוגים — PASS עם סייגים:** Software-SL fallback; לוגים לא ב-War Room UI.

---

*Generated: 2026-06-25 · Patches: G1–G7 · Tests: `server/slTpCoverage.test.ts`, `server/authHardening.test.ts`, `server/ibkrAuth.test.ts`*
