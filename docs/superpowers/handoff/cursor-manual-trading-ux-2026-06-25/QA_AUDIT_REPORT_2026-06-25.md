# QA Audit Report — Manual Trading UX

**תאריך:** 25 ביוני 2026  
**בודק:** Cursor (Lead QA)  
**יעד:** Claude בדרופלט — merge שרת + תיקונים לפני production  
**Branch:** `feat/manual-trading-ux`  
**Spec:** `2026-06-24-manual-trading-ux-spec.md` v1.1  
**Build:** `npm run build` ✅ (client, 25 Jun 2026)  
**בדיקות ריצה:** קוד + dev server `:3001` + מסלול `/dev/mobile-trading-preview` (ללא auth מלא בדפדפן אוטומטי)

---

## Executive Summary

**לא לשחרר ל-production.** יש פערים כספיים בין מה שה-UI מציג לבין מה שהשרת שולח, מלכודות popup ב-War Room, וסטייה מהספק בכפתורי מסחר.  
שכבת ה-UI (`client/`) מבנית — אבל **חסימת merge היא השרת** + תיקוני P0 ב-client לפני E2E חי.

| אזור | מובייל (375px) | דסקטופ (≥1280px) | סטטוס |
|------|----------------|------------------|--------|
| Login / Auth | בעיות layout + PWA | OK יחסית | 🔴 |
| Deep Analysis — Command Bar | grid 2×2, hints רועשים | grid 4 עמודות | 🟡 |
| Manual Order Dialog | presets חסרים, אין אזהרת SL ריק | אותו דבר | 🔴 |
| Order Status Popup | STALLED OK; שגיאה נסגרת | אותו דבר | 🔴 |
| War Room — חיסול × | hold OK; מקלדת + dialog כפול | טבלה רחבה OK | 🔴 |
| ניווט `returnTo` | לא עובד | לא עובד | 🟡 |
| DEV preview `/dev/mobile-trading-preview` | עטוף ב-GlobalNav — לא מבודד | — | 🟡 |

---

## Critical Vulnerabilities

### C1 — כמות ב-UI ≠ כמות ב-IBKR (כניסות)

- **Severity:** Critical  
- **Risk:** המשתמש מאשר 50 מניות; השרת מחשב מחדש לפי `tryLiveEntry` (רצפת $5K, caps, תקציב, duplicate guard).  
- **Evidence:** `liveEngine.ts:732` — `positionSizeUsd: input.quantity * px` → `tryLiveEntry` מחשב `rawQty` מחדש. Popup מציג `input.quantity`.

### C2 — מכירה חלקית = שקר ב-UI

- **Severity:** Critical  
- **Risk:** Presets 10/25/50% ב-`ManualOrderDialog` מעדכנים `mktQty`, אבל `placeManualOrder` close קורא `executeLiveSell` **ללא qty** → תמיד 100%.  
- **Evidence:** `ManualOrderDialog.tsx:111-125`, `liveEngine.ts:753`, `liveOrderExecutor.ts` (full units).

### C3 — `orderId: null` תמיד מהשרת

- **Severity:** Critical  
- **Risk:** אין polling `getOrderStatus`; popup עובר ל-STALLED אחרי 25s גם כשהפקודה בוצעה.  
- **Evidence:** `liveEngine.ts:736,755` — `orderId: null` hardcoded.

### C4 — שגיאת שליחה סוגרת popup (לא REJECTED)

- **Severity:** High  
- **Risk:** כשל רשת / FORBIDDEN — toast בלבד, אין מצב "נדחה" ב-Order Event Manager.  
- **Evidence:** `DeepAnalysisModal.tsx:351-356` — `setOrderPopupOpen(false)` + `clearFlight`.

### C5 — War Room: מלכודת popup על שגיאה

- **Severity:** Critical  
- **Risk:** `onMutate` פותח popup עם `quantity: 0`, `trackPositionClose`. `onError` לא סוגר. `OrderStatusPopup` חוסם dismiss כש-`trackPositionClose && pending` (`267-268`). משתמש תקוע ב"שולח...".  
- **Evidence:** `WarRoomLive.tsx:861-903`, `OrderStatusPopup.tsx:267-268`.

### C6 — פוזיציית שורט לא מזוהה כש-`conid` כבר קיים

- **Severity:** High  
- **Risk:** fetch ל-`/api/ibind/positions` רץ רק כש-`!conid || conid <= 0`. מ-Holding עם conid — `shortUnits` נשאר 0 → COVER מושבת, SHORT state שגוי.  
- **Evidence:** `DeepAnalysisModal.tsx:428-450`, `278-281`.

### C7 — `adminProcedure` על כל מסחר ידני

- **Severity:** High (לפי מדיניות מוצר)  
- **Risk:** Deep Analysis = `RequireVerified`; `placeManualOrder` / `closePosition` / `getExitProgress` = `adminProcedure`. משתמש מאומת לא-admin → FORBIDDEN.  
- **Evidence:** `App.tsx:154-158`, `liveEngine.ts:560,684,763`.

### C8 — סגירה דורשת שורה ב-`livePositions`

- **Severity:** High  
- **Risk:** פוזיציה ב-IBKR בלבד → `NOT_FOUND` "לא מנוהל ב-livePositions". `closePosition` (War Room) יש לו fallback; `placeManualOrder` close — לא.  
- **Evidence:** `liveEngine.ts:739-752` vs `closePosition` ~605-668.

### C9 — `tryLiveEntry` חוסם הוספה ללונג קיים

- **Severity:** Medium-High  
- **Risk:** Spec: BUY = open **or add**. duplicate ticker → `entered: false`.  
- **Evidence:** `liveOrderExecutor.ts:213-217`.

---

## מסכים — ממצאי UI (מובייל + דסקטופ)

### 1. Login (`/login`)

| # | ממצא | Viewport | חומרה |
|---|------|----------|--------|
| L1 | תמונות CDN (`cloudfront`) — broken בחלק מהסביבות; placeholder "Now" / "TS" | מובייל | Medium |
| L2 | באנר PWA "התקן את TS" חופף לתחתית הטופס — תוכן נחתך | מובייל | Medium |
| L3 | אייקון עין בשדה סיסמה חופף placeholder "סיסמה" | מובייל | Low |
| L4 | GlobalNav מציג "כניסה" גם בעמוד login | שניהם | Low |

**הערה:** לא חלק מ-manual-trading spec — אבל חוסם QA E2E ללא credentials.

---

### 2. Deep Analysis (`/deep-analysis/:ticker`, `DeepAnalysisModal`)

| # | ממצא | מובייל | דסקטופ | Spec |
|---|------|--------|--------|------|
| DA1 | BUY/SHORT **מושבתים** כשיש פוזיציה הפוכה — spec: כפתור פעיל + אזהרה בדיאלוג | ✓ | ✓ | §1.1 |
| DA2 | כפתורי מסחר **נעלמים** כש-IBKR disconnected — spec: disabled + tooltip | ✓ | ✓ | §1.1 |
| DA3 | רמזים (hints) מוצגים כ**פסקאות מתחת ל-grid** — לא tooltip per-button; רעש ב-375px | ✓ | פחות | §1.1 |
| DA4 | "חזרה" — טקסט מוסתר `< sm` (חץ בלבד) | ✓ | OK | §3.1 |
| DA5 | PREV/NEXT + ✕ צפופים ב-header ימני | ✓ | OK | §3 |
| DA6 | `returnTo` נשמר ב-War Room אך **לא נצרך** ב-`handleClose` | ✓ | ✓ | §3.2 |
| DA7 | UI כפול למסחר (TradingCommandBar + admin panel) | ✓ | ✓ | §5.4 |
| DA8 | My Position / Entry-SL-TP בתוך accordion — לא מעל הקפל | ✓ | ✓ | §5 |
| DA9 | אין אזהרת "ללא SL/TP" לפני שליחה (במיוחד שורט) | ✓ | ✓ | §1.3 |
| DA10 | `maxPositionUsd` קשיח $25K — לא מ-config | ✓ | ✓ | §1.3 |
| DA11 | טקסט "אין כניסה עירומה" סותר spec (שורט ללא SL מותר אחרי אזהרה) | ✓ | ✓ | §1.3 |
| DA12 | preset $15K חסר; sell presets $ חסרים | ✓ | ✓ | §5.1-5.2 |
| DA13 | preset מציג `$5K` בלבד — לא shares + ~$ | ✓ | ✓ | §5.1 |

---

### 3. Manual Order Dialog

| # | ממצא | מובייל | דסקטופ |
|---|------|--------|--------|
| MO1 | grid presets קנייה: `grid-cols-2` → 2 שורות ב-375px | ✓ | 5 עמודות |
| MO2 | `min-h-[44px]` על inputs — עומד ב-touch target | ✓ | ✓ |
| MO3 | `zIndex: 9999` — מכסה header (מכוון) | ✓ | ✓ |
| MO4 | אין validation על SL/TP ריק לפני submit | ✓ | ✓ |

---

### 4. Order Status Popup

| # | ממצא | מובייל | דסקטופ | Spec |
|---|------|--------|--------|------|
| OS1 | STALLED אחרי 25s — **לא** מסמן filled אוטומטית | ✓ | ✓ | §4 ✅ |
| OS2 | CTA יחיד "סגור / בדוק ב-IBKR" ב-STALLED | ✓ | ✓ | §4 ✅ |
| OS3 | `clientOrderId` מוצג — טוב ל-debug | ✓ | ✓ | — |
| OS4 | אין מצב machine מלא (INIT→SUBMITTING→…) | ✓ | ✓ | §4.1 |
| OS5 | אין "הצב SL/TP" / "נסה שוב" אחרי fill | ✓ | ✓ | §4.3-4.4 |
| OS6 | dismiss חסום ב-exit pending — גורם למלכודת C5 | ✓ | ✓ | — |

---

### 5. War Room Live (`/war-room-live`)

| # | ממצא | מובייל | דסקטופ | Spec |
|---|------|--------|--------|------|
| WR1 | Hold-to-confirm 600ms על × — **עובד** (pointer capture) | ✓ | ✓ | work-split ✅ |
| WR2 | Enter/Space → `AlertDialog` נוסף — **סותר** one-click / hold בלבד | ✓ | ✓ | §2.2 |
| WR3 | שגיאת `closePosition` — popup תקוע (C5) | ✓ | ✓ | §2 |
| WR4 | `onSuccess` כש-`!data.success` — toast בלבד, popup נשאר | ✓ | ✓ | §2 |
| WR5 | `RequireAdmin` — לא רלוונטי לרוב המשתמשים | — | ✓ | — |

---

### 6. DEV Preview (`/dev/mobile-trading-preview`)

| # | ממצא |
|---|------|
| DV1 | מסלול public ב-`App.tsx:71-73` אך עטוף ב-`RootLayout` + `GlobalNav` — לא מדמה full-screen modal |
| DV2 | `submitDisabled={false}` תמיד — לא משקף validation אמיתי |
| DV3 | שימושי ל-screenshots mock בלבד |

---

## Actionable Fixes

### P0 — Claude (שרת, דרופלט)

#### 1. כמות מדויקת + partial close

```ts
// liveEngine.placeManualOrder — OPEN: העבר quantity ישירות ל-bracket, לא רק positionSizeUsd
// CLOSE: העבר input.quantity ל-executeLiveSell (חדש: partialQty?: number)
```

#### 2. החזר `orderId` אמיתי

```ts
return done({
  success: res.entered,
  orderId: res.orderId ?? null, // לא null קבוע
  ...
});
```

#### 3. `protectedProcedure` + idempotency `clientOrderId`

```ts
placeManualOrder: protectedProcedure  // לא adminProcedure
closePosition: protectedProcedure
getExitProgress: protectedProcedure
```

#### 4. Close ללא livePositions — fallback כמו `closePosition`

#### 5. `tryLiveEntry` — אפשר `MANUAL_ADD` כשכבר יש לונג

---

### P0 — Cursor (client, אחרי merge שרת)

#### 6. War Room — שחרור popup על שגיאה

```ts
// WarRoomLive.tsx closeP.onError + onSuccess !success
setOrderPopupData(prev => prev ? {
  ...prev,
  ibkrMessage: msg,
  // set synthetic rejected state OR close with onCloseWithOutcome('rejected')
} : null);
// או: setOrderPopupOpen(false) + toast
```

#### 7. Deep Analysis — שגיאה → REJECTED ב-popup, לא סגירה

```ts
// DeepAnalysisModal submitManualOrder catch:
setOrderPopupData(prev => prev ? { ...prev, ibkrMessage: msg } : null);
// OrderStatusPopup: prop forceStatus="rejected" או orderId sentinel
```

#### 8. תמיד fetch IBKR positions כשמחובר (גם עם conid)

```ts
// DeepAnalysisModal.tsx:428 — הסר תנאי (!conid || conid <= 0)
if (ibindOk && ticker) { fetch("/api/ibind/positions") ... }
```

#### 9. TradeActionGrid — אזהרה בדיאלוג, לא disable על opposite position

```ts
// הסר shortUnits > 0 מ-disabled של BUY, longUnits > 0 מ-disabled של SHORT
// הוסף אזהרה ב-ManualOrderDialog כשיש פוזיציה הפוכה
```

---

### P1 — Spec alignment

| Fix | קובץ |
|-----|------|
| `consumeReturnTo()` ב-`handleClose` | `DeepAnalysisModal.tsx` |
| `saveReturnTo` מ-Catalogue / Trade Manager | entry points |
| preset $15K + sell $ presets | `ManualOrderDialog.tsx` |
| `maxPositionUsd` מ-`liveEngine.getConfig` | `ManualOrderDialog.tsx` |
| אזהרת SL/TP ריק לפני submit | `ManualOrderDialog.tsx` |
| הסר duplicate admin trade panel | `DeepAnalysisModal.tsx:1294+` |
| War Room: הסר AlertDialog מקלדת או תעד כחריג | `WarRoomLive.tsx:1859` |
| Login: הסתר PWA על `/login`; תקן overlap עין | `PWAInstallPrompt.tsx`, `LoginPage.tsx` |
| DEV preview: `layout={false}` בלי GlobalNav | `App.tsx` או route wrapper |

---

## בדיקות מומלצות ל-Claude (E2E אחרי תיקון)

```bash
# דרופלט — עם auth אמיתי + IBKR paper/live מבוקר
PLAYWRIGHT_BASE_URL=https://tradesnow.vip npx playwright test tests/mobile-trading-ux-375.spec.ts

# ידני — חובה
# 1. BUY 10 shares AAPL — וודא qty ב-IBKR = 10 (לא $5K floor)
# 2. SELL 25% — וודא רק 25% נמכר
# 3. STALLED — נתק IBIND 30s — אין double-submit; clientOrderId dedupe
# 4. War Room × — שגיאת רשת — popup נסגר / rejected
# 5. Short position — COVER פעיל עם conid מ-Holding
# 6. מובייל 375px — 4 כפתורים בשורה אחת @ sm+
```

---

## קבצים לסקירה (סדר עדיפות)

1. `server/routers/liveEngine.ts` — `placeManualOrder`, `closePosition`  
2. `server/liveOrderExecutor.ts` — qty, duplicate, partial sell  
3. `client/src/components/DeepAnalysisModal.tsx` — submit + positions  
4. `client/src/pages/WarRoomLive.tsx` — liquidate error paths  
5. `client/src/components/TradeActionGrid.tsx` + `ManualOrderDialog.tsx`  
6. `client/src/components/OrderStatusPopup.tsx`  

---

## נספח — מה עובד (לא לשבור)

- `clientOrderId` נוצר ב-**submit** (לא בפתיחת דיאלוג)  
- STALLED per `ticker:side` ב-`orderFlightRegistry`  
- Hold-to-confirm 600ms + pointer capture  
- `grid-cols-2 sm:grid-cols-4` על כפתורי מסחר  
- SHORT עם `border-dashed border-amber`  
- אין `skipProtection` ב-UI  
- `npm run build` עובר  

---

**מסקנה:** Merge ל-main רק אחרי P0 שרת (qty, orderId, permissions, partial close) + P0 client (popup traps, position SSOT).  
UI layer מוכן ל-~70% מהספק; **20% כספי מסוכן**, **10% ניווט/פריסה**.
