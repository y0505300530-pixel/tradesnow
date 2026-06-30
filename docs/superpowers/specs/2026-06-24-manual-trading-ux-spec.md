# מסמך אפיון — מסחר ידני, חיסול פוזיציה, ושיפור Deep Analysis

**מסמך:** `2026-06-24-manual-trading-ux-spec.md`  
**גרסה:** 1.1  
**תאריך:** 24 ביוני 2026  
**מבקש:** סוחר עצמאי (Holding 1 + War Room + IBKR Live)  
**סטטוס:** מפרט דרישות — **החלטות מאושרות**, ממתין ליישום  
**קשור ל:** `DeepAnalysisModal.tsx`, `WarRoomLive.tsx`, `OrderStatusPopup.tsx`, `liveEngine.closePosition`

---

## תקציר מנהלים

המשתמש מבקש שליטה ידנית מלאה במסחר (לונג ושורט), תיקון כפתור חיסול פוזיציה ב-War Room, שיפור ניווט וסגירה ב-Deep Analysis, וחלון ניהול אירוע אחיד לכל פקודה מול IBKR — כולל עדכון כמויות ו-SL/TP אחרי ביצוע.

המערכת כבר מכילה רכיבים רלוונטיים (`OrderStatusPopup`, `IBKROrderDialog`, `closePosition`, `executeShortLive`) אך הם לא מחוברים בצורה עקבית, וה-UI מגביל פעולות שלא צריכות להיות מוגבלות לסוחר עצמאי.

---

## עקרון מנחה

> **הסוחר הוא בעל ההחלטה.** המערכת מציעה ניתוח וציונים — אך לא חוסמת כפתורי מסחר ידני כשהחיבור ל-IBKR תקין.  
> War Engine / Elza ממשיכים לפעול אוטונומית; המסחר הידני הוא ערוץ נפרד עם אותו pipeline ביצוע ואותו חלון סטטוס.

---

## דרישה 1 — מסחר ידני: קנייה / מכירה לונג ושורט

### מה המשתמש מבקש

כסוחר עצמאי, לפעמים להכניס פקודות ידנית:
- **קניית לונג** (פתיחה או הוספה)
- **מכירת לונג** (הפחתה או סגירה)
- **פתיחת שורט** (מכירה בחסר)
- **כיסוי שורט** (קנייה לסגירה)

**כל הכפתורים צריכים להיות זמינים** כש-IBKR מחובר ויש `conid` לטיקר — ללא תלות ב:
- ציון War Engine (WATCH / ENTER)
- קיום holding ב-DB
- Regime NEUTRAL / BULL / BEAR
- `Allow Short` (הגדרה זו תישאר רלוונטית רק למנוע האוטומטי)

### מצב נוכחי (פערים)

| מסך | מה קיים | מה חסר / שגוי |
|-----|---------|----------------|
| **Deep Analysis** | `BUY` + `SELL` | `SELL` = סגירת לונג בלבד; אין `SHORT`; אין `COVER` |
| **Deep Analysis** | `SELL` מושבת אם `!holdingContext?.units` | משתמש ללא holding לא יכול למכור — נכון; אבל גם לא יכול לשורט |
| **Bear Scanner** | `SHORT` בלחיצה אחת | מבודד ממסך הניתוח הראשי |
| **War Room** | אין כניסה ידנית | רק חיסול (X) |
| **Holding 1** | מכירה חלקית / מלאה | ללא שורט |

### אפיון יעד

#### 1.1 כפתורי פעולה ב-Deep Analysis (בראש המסך, ליד הגרף)

| כפתור | צבע | פעולה | תנאי הפעלה |
|-------|-----|-------|------------|
| **BUY** | ירוק | פתיחת/הוספת לונג | `ibkrConnected && conid > 0` |
| **SELL** | אדום | הפחתה/סגירת לונג | `ibkrConnected && conid > 0 && longUnits > 0` |
| **SHORT** | כתום/אדום כהה | פתיחת שורט | `ibkrConnected && conid > 0` |
| **COVER** | כחול | כיסוי שורט | `ibkrConnected && conid > 0 && shortUnits > 0` |

**הערות:**
- אם אין פוזיציה — `SELL` ו-`COVER` מוצגים אך **מושבתים עם tooltip** ("אין פוזיציית לונג" / "אין פוזיציית שורט") — לא נעלמים.
- `BUY` ו-`SHORT` **תמיד פעילים** כש-IBKR מחובר (בכפוף לאזהרת סיכון, לא חסימה).
- כיוון הפוזיציה נקבע מ-IBKR positions (SSOT) עם fallback ל-H1 DB.

#### 1.2 API / Backend

| פעולה | מימוש מוצע |
|-------|------------|
| BUY לונג | קיים: `ibkr.placeMarketOrder` / `tryLiveEntry` עם `direction: "long"` |
| SELL לונג | קיים: `ibkr.placeMarketOrder` side=SELL / `executeLiveSell` |
| SHORT | קיים: `shortScan.executeShort` → `tryLiveEntry({ direction: "short" })` — לחשוף גם מ-Deep Analysis |
| COVER שורט | קיים חלקית: `executeLiveSell` על פוזיציית short (side=BUY) — לוודא תמיכה מלאה |

**דרישה:** endpoint אחיד `liveEngine.placeManualOrder` (או הרחבת `placeMarketOrder`) עם:
```ts
{ ticker, side: "BUY"|"SELL", intent: "open_long"|"close_long"|"open_short"|"close_short", quantity, orderType?, slippagePct?, sl?, tp? }
```
שמבצע את הלוגיקה הנכונה ומחזיר `{ orderId, ticker, side, quantity, orderType }` לחלון הסטטוס.

#### 1.3 אזהרות ואישור (לא חסימות)

**החלטה מאושרת:** אין חסימה אוטומטית — רק **אזהרה + בקשת אישור** לפני שליחה.

לפני כל שליחה ידנית — dialog אישור עם:
- טיקר, כיוון, כמות, שווי משוער $
- SL/TP **מוצעים** מהמנוע (ניתנים לעריכה — **לא חובה** למלא)
- אזהרה אם War Score < 7: "המנוע ממליץ להמתין — אתה פועל ידנית"
- אזהרה אם **אין SL/TP** (במיוחד בשורט): "פוזיציה ללא הגנה — האם להמשיך?"
- אזהרה אם **שווי הפוזיציה > `maxPositionUsd`**: "חריגה ממגבלת גודל מומלצת ($X) — האם להמשיך?" (**הזהרה בלבד, לא חסימה**)

כפתורי האישור: **אשר ושלח ל-IBKR** / **ביטול**

**שורט ללא SL/TP:** מותר — לאחר אזהרה מפורשת ואישור המשתמש. המערכת תציע SL/TP ברירת מחדל אך לא תחסום שליחה אם השדות ריקים.

#### 1.4 קריטריוני קבלה

- [ ] מטיקר ללא holding — ניתן ללחוץ BUY ו-SHORT ולשלוח ל-IBKR
- [ ] מטיקר עם לונג — SELL פעיל; SHORT מציג אזהרה "כבר יש לונג"
- [ ] מטיקר עם שורט — COVER פעיל; BUY מציג אזהרה "כבר יש שורט"
- [ ] אין תלות ב-`getAllowShort` לפעולות ידניות
- [ ] שורט ללא SL/TP — אזהרה + אישור, לא חסימה
- [ ] חריגה מ-`maxPositionUsd` — אזהרה בלבד, לא חסימה
- [ ] כל פעולה פותחת את חלון ניהול האירוע (דרישה 4)

---

## דרישה 2 — כפתור X חיסול פוזיציה ב-War Room לא עובד

### מה המשתמש מדווח

כפתור **X** (עמודת חיסול) בטבלת הפוזיציות ב-War Room — "מעולם לא עושה את עבודתו", לא קורה כלום.

### מצב נוכחי בקוד

```
WarRoomLive.tsx:1236, 1354
  onClick → closeP.mutate({ ticker })
  closeP = trpc.liveEngine.closePosition

liveEngine.ts:557
  closePosition: adminProcedure  ← דורש הרשאת admin
  → executeLiveSell (DB) או fallback IBKR-only

onSuccess → OrderStatusPopup עם trackPositionClose
onError → toast.error
```

### שורשי בעיה אפשריים (לאבחון)

| # | בעיה | סימפטום למשתמש |
|---|------|----------------|
| A | `adminProcedure` — משתמש לא-admin | שגיאת הרשאה / שקט (toast שלא נראה) |
| B | `executeLiveSell` נכשל ללא `success: true` | toast "מכירה נכשלה" בלי popup |
| C | פוזיציה ב-IBKR אבל לא ב-`livePositions` | fallback IBKR-only — עלול להיכשל על conid/orders |
| D | `orderPopupOpen` נשאר true | כפתור X מושבת (`disabled={orderPopupOpen}`) |
| E | `getExitProgress` לא מגיע ל-`done` | popup תקוע על "ממתין..." |
| F | אין dialog אישור — לחיצה שקטה עד תגובת שרת | תחושה ש"לא קורה כלום" |

### אפיון יעד — תיקון

#### 2.1 הרשאות
- `closePosition` ו-`getExitProgress` → **`protectedProcedure`** (כל משתמש מאומת עם חשבון IBKR)
- שמירת `adminProcedure` רק לפעולות מערכת (emergency exit, engine off)

#### 2.2 UX — חיסול מהיר (החלטה מאושרת)

**עקרון:** לחיצה אחת על X = **חיסול מיידי 100%** של הפוזיציה. ללא dialog ביניים, ללא בחירת אחוז.

זרימה:
1. **לחיצה על X** → שליחה **מיידית** של פקודת סגירה מלאה (100% units) ל-IBKR
2. **במקביל** — פתיחת `OrderStatusPopup` במצב "שולח..." (תוך ≤300ms)
3. polling `getExitProgress` עד `done`
4. בסיום: toast "חוסל" + רענון טבלה + ביטול bracket SL/TP יתום + עדכון H1

**אין** מסך אישור נפרד לפני השליחה — המשתמש מאשר את הפעולה בלחיצה על X עצמו.  
**כן** — tooltip על הכפתור: "חיסול מהיר — 100% מהפוזיציה".

הפחתה חלקית (10%/25%/50%) תישאר רק ב-Deep Analysis / Holding 1 — לא ב-War Room.

#### 2.3 Backend
- לוודא `executeLiveSell` מחזיר תמיד `orderId` גם ב-partial
- אם IBKR-only path — ליצור/לעדכן רשומת `livePositions` ל-`pending_exit`
- לוג מפורש: `[MANUAL_CLOSE] ticker=... userId=... result=...`

#### 2.4 קריטריוני קבלה

- [ ] לחיצה אחת על X שולחת חיסול 100% **ללא** dialog ביניים
- [ ] popup סטטוס נפתח מיד (גם לפני תשובת IBKR)
- [ ] פוזיציה נעלמת מטבלת War Room אחרי מילוי מלא
- [ ] H1 holdings מתעדכן (units=0 או סגירה)
- [ ] bracket SL/TP ב-IBKR מבוטלים
- [ ] עובד גם לפוזיציות short (cover = BUY)

---

## דרישה 3 — כפתור סגירה (X) ברור ב-Deep Analysis

### מה המשתמש מדווח

כשחלון Deep Analysis פתוח — לעיתים אין **X ברור** לסגירה וחזרה למסך הקודם.

### מצב נוכחי

- **מודל (overlay):** יש X ב-header (שורה 908–913) + לחיצה על backdrop
- **דף מלא (`/deep-analysis/:ticker`, `pageMode`):** אין backdrop; X קיים ב-header אך:
  - על מובייל עלול להידחק על ידי PREV/NEXT
  - אין טקסט "סגור" / "חזרה"
  - `z-index` של dialogs פנימיים (SL/TP/MKT) עלול לכסות את ה-header

### אפיון יעד

#### 3.1 Header קבוע (sticky)

```
[← חזרה]  Deep Analysis: CLS — Celestica     [PREV] 3/12 [NEXT]  [✕]
```

- כפתור **"← חזרה"** (שמאל) — תמיד גלוי, גם במובייל
- כפתור **✕** (ימין) — גדול יותר (min 44×44px), `aria-label="סגור"`
- רקע header: `sticky top-0 z-[70]` — מעל תוכן הגלילה, מתחת ל-dialogs פעילים

#### 3.2 ניווט חזרה — זכירת מסך קודם (החלטה מאושרת)

בפתיחת Deep Analysis (מודל או דף) — לשמור **`returnTo`**:
- מסך המקור (path מלא), למשל `/war-room`, `/catalogue`, `/trade-manager`
- אופציונלי: state נוסף (טאב, פילטר, scroll position)

בסגירה (`← חזרה` / `✕` / `Escape`):
1. אם יש `returnTo` — ניווט אליו
2. אחרת — `window.history.back()`
3. fallback — `/catalogue`

מימוש מוצע: query `?from=/war-room` או state ב-sessionStorage בעת פתיחה.

#### 3.3 מקלדת
- `Escape` → סגירה (כבר קיים ב-Dialog; לוודא גם ב-pageMode)

#### 3.4 קריטריוני קבלה

- [ ] במובייל ובדסקטופ — כפתור סגירה נראה ללא גלילה
- [ ] סגירה מחזירה **תמיד** למסך שממנו נפתח הניתוח (War Room / Catalogue / Holding וכו')
- [ ] סגירה עוצרת SSE stream (קיים — לוודא)

---

## דרישה 4 — חלון ניהול אירוע מול IBKR (Order Event Manager)

### מה המשתמש מבקש

בכל קנייה/מכירה ידנית (וגם בחיסול מ-War Room) — חלון שמראה:
- סטטוס הפקודה מול IBKR בזמן אמת
- מה נקנה/נמכר, כמה יחידות, באיזה סכום
- אישור הוראה / עדכון הוראה (מחיר)
- האם ההוראה בוצעה
- אפשרות לסגור את החלון
- **אחרי ביצוע:** עדכון כמויות חדשות + SL/TP

### מצב נוכחי

| מקור | רכיב | מצב |
|------|------|-----|
| War Room X | `OrderStatusPopup` + `trackPositionClose` | קיים — אך לא נפתח אם close נכשל |
| Deep Analysis MKT | `OrderStatusPopup` **ללא** `trackPositionClose` | אין מעקב עדכון holdings |
| Deep Analysis SL/TP | toast בלבד | אין popup |
| Trade Manager | `OrderStatusPopup` | חלקי |

### אפיון יעד — `OrderEventManager` (הרחבת `OrderStatusPopup`)

#### 4.1 שלבי תצוגה (state machine)

```
INIT → SUBMITTING → PENDING → PARTIAL_FILL → FILLED → SYNCING_DB → COMPLETE
                  ↘ REJECTED / CANCELLED → CLOSED
```

#### 4.2 שדות בחלון

| שדה | דוגמה |
|-----|--------|
| טיקר + כיוון | `CLS · קניית לונג` |
| כמות מבוקשת / מבוצעת | `42 / 42 מניות` |
| מחיר ממוצע | `$377.12` |
| שווי כולל | `$15,839` |
| Order ID | `12345678` |
| סטטוס IBKR | `Submitted` → `Filled` |
| הודעת IBKR | טקסט מהברוקר |
| SL / TP חדשים | אחרי מילוי — "מציב SL $325 / TP $420..." |

#### 4.3 כפתורים לפי שלב

| שלב | כפתורים |
|-----|---------|
| PENDING (LMT) | **עדכן מחיר** · **בטל הוראה** |
| PENDING (MKT) | **בטל** (אם אפשר) |
| FILLED | **הצב SL/TP** (אם חסר) · **סיום** |
| COMPLETE | **סיום** |
| REJECTED | **נסה שוב** · **סגור** |

#### 4.4 אחרי FILLED — סנכרון אוטומטי

1. `ibkrSync` / `reconcileHoldingFromLivePosition` — עדכון units ב-H1
2. אם כניסה חדשה — הצבת bracket SL+TP (מהניתוח או מהמשתמש)
3. אם סגירה מלאה — ביטול brackets + סגירת שורה ב-DB
4. אם הפחתה חלקית — עדכון units + התאמת כמות SL/TP ב-IBKR
5. `invalidate` על: `portfolio.getState`, `liveEngine.getStatus`, orders

#### 4.5 שימוש חוזר

אותו רכיב נקרא מ:
- Deep Analysis (BUY / SELL / SHORT / COVER)
- War Room (X חיסול)
- Holding 1 (מכירה מהירה)
- Bear Scanner (SHORT)

#### 4.6 קריטריוני קבלה

- [ ] כל פעולת מסחר ידנית פותחת את החלון תוך 300ms מהלחיצה
- [ ] סטטוס מתעדכן כל 2–3 שניות עד סיום
- [ ] אחרי FILLED — holdings ו-SL/TP מסונכרנים תוך 30 שניות
- [ ] ניתן לסגור החלון אחרי COMPLETE; לא ניתן לסגור באמצע (אלא ביטול מפורש)
- [ ] חיסול מ-War Room משתמש באותו חלון עם `intent: close`

---

## דרישה 5 — ארגון מחדש של מסך Deep Analysis

### מה המשתמש מבקש

- **פחות רעש** — מדדים טכניים שלא מעניינים (RSI breakdown, 8 תאי ZIV breakdown, וכו') — להסתיר או לקפל
- **גרף למעלה** — יחד עם כפתורי קנייה/מכירה
- **קנייה:** כפתורי סכום מהיר — להוסיף **$30,000** ו-**$40,000** (קיים היום: $5K/$10K/$15K/$20K)
- **מכירה:** כפתורי סכום מהיר **$5K / $10K / $20K** + אחוזים **10% / 25% / 50% / 100%** (קיים היום: Full/Half/30%/10% — ללא סכומי $)

### מצב נוכחי — סדר תצוגה (כשיש result)

1. Header (מחיר, ציון, BUY/SELL, AI recommendation)
2. My Position (אם holding)
3. ZIV H Health (מפורט מאוד)
4. AI Analysis sections
5. War Engine Panel
6. Technical indicators grid
7. ZIV Breakdown 8 cells
8. Entry/SL/TP cards
9. **TradingView Chart** (שורה ~1539 — נמוך מדי)
10. IBKR execution panel (כפול ל-header)
11. Chat

### אפיון יעד — Layout חדש

```
┌─────────────────────────────────────────────────────────────┐
│ STICKY HEADER: [← חזרה]  CLS · Celestica          [✕]      │
├─────────────────────────────────────────────────────────────┤
│ ROW 1 — Trading Command Bar (תמיד גלוי בראש)               │
│  מחיר · שינוי יומי │ Ziv Score │ [BUY][SELL][SHORT][COVER]│
│  War Engine badge (WATCH/ENTER) │ IBKR ● connected        │
├─────────────────────────────────────────────────────────────┤
│ ROW 2 — TRADINGVIEW CHART (גובה 360–420px)                 │
│  + AnalysisLevelsLegend (SL/TP/Entry על הגרף)              │
├─────────────────────────────────────────────────────────────┤
│ ROW 3 — AI Summary (קומפקטי, 4 שורות מקס)                  │
│  המלצה · סיכונים · טריגר כניסה                             │
├─────────────────────────────────────────────────────────────┤
│ ROW 4 — My Position (רק אם holding) — שורה אחת קומפקטית    │
├─────────────────────────────────────────────────────────────┤
│ ROW 5 — Entry / SL / TP (כרטיסים) + IBKR LMT/STP buttons   │
├─────────────────────────────────────────────────────────────┤
│ ▼ פרטים מתקדמים (מקופל כברירת מחדל)                        │
│   · ZIV Breakdown · ZIV H · War Engine מלא · מדדים טכניים  │
├─────────────────────────────────────────────────────────────┤
│ Chat (אופציונלי — מקופל)                                   │
└─────────────────────────────────────────────────────────────┘
```

### 5.1 כפתורי סכום מהיר — קנייה (BUY)

| כפתור | סכום |
|--------|------|
| $5K | 5,000 |
| $10K | 10,000 |
| $15K | 15,000 |
| $20K | 20,000 |
| **$30K** | **30,000** *(חדש)* |
| **$40K** | **40,000** *(חדש)* |

חישוב: `qty = floor(amount / livePrice)`, מינימום 1 מניה.  
תצוגה: `{label}` + `{qty} shares` + `~${amount}`.

Grid: `grid-cols-3` או `grid-cols-6` עם scroll אופקי במובייל.

### 5.2 כפתורי מכירה (SELL / COVER)

**שתי שורות:**

**אחוזים מהפוזיציה:**
| 10% | 25% | 50% | 100% |

**סכום בדולרים** (מחושב לכמות מניות הקרובה):
| $5K | $10K | $20K |

חישוב סכום: `qty = min(positionUnits, max(1, round(amount / livePrice)))`.

החלפת 30%/Half הנוכחיים ב-25% לפי בקשת המשתמש.

### 5.3 הסתרת מידע "רעש"

להעביר ל-accordion **"פרטים מתקדמים"** (סגור כברירת מחדל):
- ZIV Score Breakdown (8 תאים)
- RSI, Volume Ratio, ATR, Weekly Slope grid
- ZIV H indicators grid מלא
- War Engine panel מלא (להשאיר badge קומפקטי בשורה 1)

### 5.4 קריטריוני קבלה

- [ ] גרף + כפתורי מסחר נראים **ללא גלילה** ב-viewport 1080p
- [ ] כפתורי $30K/$40K בקנייה עובדים
- [ ] כפתורי $5K/$10K/$20K + 10/25/50/100% במכירה עובדים
- [ ] "פרטים מתקדמים" מקופל בפתיחה ראשונה
- [ ] אין כפילות של פאנל IBKR (איחוד ל-Trading Command Bar)

---

## תלויות וסדר יישום מוצע

| שלב | נושא | עדיפות | הערכת מאמץ |
|-----|------|--------|------------|
| **P0** | תיקון `closePosition` + חיסול מהיר + popup (דרישות 2+4) | קריטי | 1–2 ימים |
| **P0** | הרחבת `OrderStatusPopup` → sync SL/TP (דרישה 4) | קריטי | 1–2 ימים |
| **P1** | כפתורי SHORT/COVER + endpoint אחיד (דרישה 1) | גבוה | 2–3 ימים |
| **P1** | Header סגירה ברור (דרישה 3) | גבוה | 0.5 יום |
| **P2** | Layout חדש Deep Analysis (דרישה 5) | בינוני | 2–3 ימים |
| **P2** | כפתורי סכום $30K/$40K + מכירה ב-$ (דרישה 5) | בינוני | 0.5 יום |

---

## קבצים לשינוי (יישום עתידי)

| קובץ | שינוי |
|------|-------|
| `client/src/components/DeepAnalysisModal.tsx` | Layout, כפתורים, presets |
| `client/src/components/OrderStatusPopup.tsx` | הרחבה ל-Order Event Manager |
| `client/src/pages/WarRoomLive.tsx` | אישור חיסול, תיקון disabled state |
| `server/routers/liveEngine.ts` | `protectedProcedure`, `placeManualOrder` |
| `server/liveOrderExecutor.ts` | תמיכה ב-manual short/cover |
| `server/routers/shortScan.ts` | חשיפת executeShort ל-Deep Analysis |
| `server/ibkrSync.ts` | post-trade reconcile + SL/TP |

---

---

## חלוקת עבודה רב-סוכנית (24/06/2026)

### Cursor (UI בלבד — `client/`)
- יישום Layout, כפתורי BUY/SELL/SHORT/COVER, presets, `returnTo`, `OrderEventManager` UI
- **hold-to-confirm 600ms** לחיסול ב-War Room
- חיבור ל-`placeManualOrder` / `closePosition` / `getExitProgress` לפי חוזה tRPC מ-Claude
- **אסור:** `server/`, פריסה, שליחת הזמנות לייב U16881054

### Base44 (פרוטוטיפ נפרד)
- מוקאפ ויזואלי ל-Trading Command Bar + Layout — רפרנס ל-Cursor
- **אסור:** גישה ל-repo tradesnow, כתיבות broker

### Claude (Backend + פריסה)
- `placeManualOrder`, `closePosition` ownership, short/cover, reconcile, `NO_PRICE=$0`
- פרסום חוזה tRPC, אינטגרציה, QA, **פריסה יחידה לדרופלט**

### קבצי עזר Cursor (מחוץ לשלושה הראשיים)
- `client/src/lib/manualOrderContract.ts` — טיפוסי חוזה
- `client/src/hooks/usePlaceManualOrder.ts` — גשר עד merge של Claude
- `client/src/components/HoldToConfirmButton.tsx` — hold 600ms

---

## החלטות מאושרות (24/06/2026)

| # | נושא | החלטה |
|---|------|--------|
| 1 | שורט / מסחר ללא SL/TP | **אזהרה + בקשת אישור** — לא חסימה. SL/TP מוצעים אך אופציונליים |
| 2 | כפתור X ב-War Room | **חיסול מהיר** — לחיצה אחת, 100% מיידי, בלי dialog ביניים |
| 3 | סגירת Deep Analysis | **לזכור מסך קודם** — חזרה למקור הפתיחה (`returnTo`) |
| 4 | מגבלת `maxPositionUsd` | **להזהיר בלבד** — לא לחסום שליחה ידנית |

---

## אישור

| תפקיד | שם | תאריך | אישור |
|-------|-----|-------|-------|
| סוחר / מבקש | | 24/06/2026 | ☑ החלטות 1–4 |
| פיתוח | | | ☐ ממתין ליישום |

---

*נוצר מתוך בקשת משתמש ב-24/06/2026 — מסחר ידני, תיקון חיסול War Room, סגירת Deep Analysis, ניהול אירוע IBKR, וארגון מחדש של המסך.*
