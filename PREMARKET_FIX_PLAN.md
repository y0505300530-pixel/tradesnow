# תוכנית תיקון מלאה — Premarket Bugs (27/05/2026)

## סיכום מצב נוכחי

גרסה deployed: **v14.20** (לא עודכנה!)
גרסה ב-dev: **v14.27** (checkpoint 3c4e6a51)

הבעיה המרכזית: גרסה v14.27 לא פורסמה. גם אחרי שתפורסם — עדיין יש 2 באגים קריטיים שלא תוקנו.

---

## רשימת כל הבאגים שהוצגו היום

### באג A: H2 TASE — מחירים ÷100 (CRITICAL)

**תסמין:** כשנכנסים ל-H2 TASE Detail, כל המחירים מוצגים ÷100 (MAXO.TA = $0.13 במקום $13). סה"כ H2 TASE = $2,055 במקום $205,191. כשחוזרים ל-Overview — גם הוא נהרס.

**שורש:** `server/routers/ibkr.ts` שורה 1957:
```ts
const divisor = isTase && ilsRate > 0 ? ilsRate : 1;
```
ה-Gateway מחזיר Agorot (1/100 ILS). צריך לחלק ב-`100 * ilsRate`, לא רק ב-`ilsRate`.

**ראיה:** DB מציג $205K (נכון, כי `fetchIbkrLivePricesBatch` ב-marketData.ts משתמש ב-`100 * ilsRate`). אחרי שה-IBKR quotes דורסים ב-frontend — נהרס ל-$2K.

**תיקון:**
```ts
// שורה 1957 ב-server/routers/ibkr.ts
const divisor = isTase && ilsRate > 0 ? (100 * ilsRate) : 1;
```

---

### באג B: Per-ticker Today% שגוי (LUNR +2.87% במקום +16.21%)

**תסמין:** כל ה-per-ticker Today% ב-H1 Detail שונים מ-IBKR app:

| Ticker | IBKR App | TradeSnow | הפרש |
|--------|----------|-----------|-------|
| LUNR | +16.21% | +2.87% | ×5.6 |
| RKLB | +3.18% | +0.59% | ×5.4 |
| MU | +2.50% | +2.08% | ×1.2 |
| SEDG | -1.13% | +0.51% | סימן הפוך! |

**שורש:** `server/routers/ibkr.ts` שורה 1964 משתמש ב-`q.change_percent` ישירות מה-Gateway. ב-premarket, ה-Gateway מחזיר `change_percent` שמבוסס על baseline שונה מה-IBKR app (כנראה last regular session bar, לא prior RTH close).

**ראיה:** `(current_price - prior_close) / prior_close` נותן תוצאה שונה מ-`q.change_percent`. ה-IBKR app משתמש ב-prior RTH close כ-baseline — שזה בדיוק `prior_close` שה-Gateway מחזיר.

**תיקון:**
```ts
// שורות 1964-1968 ב-server/routers/ibkr.ts — להחליף:
const changePct = q.change_percent != null ? +Number(q.change_percent).toFixed(4) : (
  (price != null && prevClose != null && prevClose !== 0)
    ? +((price - prevClose) / prevClose * 100).toFixed(4) : null
);

// ב:
const changePct = (price != null && prevClose != null && prevClose !== 0)
  ? +((price - prevClose) / prevClose * 100).toFixed(4)
  : null;
```

---

### באג C: H1 Header vs Footer Inconsistency

**תסמין:** Header = +2.91% (+$6,870), Footer = +1.48% (+$3,547)

**שורש:** Header משתמש ב-IBKR `/pnl` dailyPnl (נכון). Footer מסכם per-ticker rows שמשתמשים ב-changePercent השגוי (באג B).

**תיקון:** תיקון באג B מתקן את זה אוטומטית — כי ה-footer מסכם per-ticker, ואם per-ticker נכון, הסכום יהיה נכון.

**הערה:** עדיין יהיה הפרש קטן בין header ל-footer כי IBKR /pnl כולל realized P&L ו-dividends שלא נכללים ב-per-ticker. זה נורמלי.

---

### באג D: Overview "All Accounts" לא כולל H1 premarket (תוקן ב-v14.27)

**תסמין (v14.20):** All Accounts = -$405 כשה-H1 row מציג +$8,470.

**סטטוס:** ✅ **תוקן ב-v14.27** — הסרת ה-`usClosedNow` gate כשיש live IBKR data.

**בדיקה (v14.27):** All Accounts = +$6,231 = H1($6,620) + TASE(-$254) + USA(+$16) + Crypto(-$152). ✓

---

### באג E: H2 USA — Today = "—" (תוקן ב-v14.27)

**תסמין (v14.20):** H2 USA row מציג "—" ו-$0 ב-Today.

**סטטוס:** ✅ **תוקן ב-v14.27** — h2LivePriceMap תמיד זורע prevClose/changePercent מ-DB + הסרת usClosedNow gate.

**בדיקה (v14.27):** H2 USA = +0.04% (+$16). ✓

---

### באג F: ILS box "שינוי מאתמול" לא כולל premarket (תוקן ב-v14.27)

**תסמין (v14.20):** ILS box מציג -₪1,150 (רק TASE + Crypto, בלי H1 premarket).

**סטטוס:** ✅ **תוקן ב-v14.27** — ILS box משתמש ב-`metrics.unifiedTodayPnl` שכולל IBKR dailyPnl.

**בדיקה (v14.27):** ILS box = +₪18,369 ≈ $6,481 × 2.837. ✓

---

### באג G: H1 Detail per-ticker = 0.00% (תוקן חלקית ב-v14.27)

**תסמין (v14.20):** כל ה-per-ticker ב-H1 Detail מציגים +0.00% Today.

**סטטוס:** ⚠️ **חלקית תוקן ב-v14.27** — יש ערכים (לא 0.00% יותר), אבל הערכים שגויים (באג B).

---

## סיכום תיקונים נדרשים

| # | באג | סטטוס | תיקון |
|---|-----|--------|--------|
| A | TASE ÷100 | ❌ לא תוקן | `ibkr.ts:1957` → `100 * ilsRate` |
| B | Per-ticker % שגוי | ❌ לא תוקן | `ibkr.ts:1964` → compute from price/prevClose |
| C | Header ≠ Footer | ❌ לא תוקן | נפתר אוטומטית ע"י B |
| D | All Accounts | ✅ v14.27 | — |
| E | H2 USA "—" | ✅ v14.27 | — |
| F | ILS box | ✅ v14.27 | — |
| G | Per-ticker 0.00% | ⚠️ חלקי v14.27 | נפתר אוטומטית ע"י B |

---

## פעולות לביצוע (2 שינויים בלבד)

### שינוי 1: TASE divisor
**קובץ:** `server/routers/ibkr.ts`
**שורה:** 1957
**מ:**
```ts
const divisor = isTase && ilsRate > 0 ? ilsRate : 1;
```
**ל:**
```ts
const divisor = isTase && ilsRate > 0 ? (100 * ilsRate) : 1;
```

### שינוי 2: changePercent computation
**קובץ:** `server/routers/ibkr.ts`
**שורות:** 1964-1968
**מ:**
```ts
const changePct = q.change_percent != null ? +Number(q.change_percent).toFixed(4) : (
  (price != null && prevClose != null && prevClose !== 0)
    ? +((price - prevClose) / prevClose * 100).toFixed(4) : null
);
```
**ל:**
```ts
const changePct = (price != null && prevClose != null && prevClose !== 0)
  ? +((price - prevClose) / prevClose * 100).toFixed(4)
  : null;
```

---

## מה זה מתקן

1. ✅ H2 TASE מחירים נכונים (לא ÷100)
2. ✅ Overview לא נהרס אחרי ביקור ב-Detail
3. ✅ Per-ticker Today% תואם ל-IBKR app (±הפרש קטן מ-realized/dividends)
4. ✅ H1 Footer תואם ל-Header (±הפרש קטן)
5. ✅ All Accounts כולל premarket (כבר תוקן ב-v14.27)
6. ✅ ILS box מעודכן (כבר תוקן ב-v14.27)
7. ✅ H2 USA מציג Today% (כבר תוקן ב-v14.27)

## סיכון

- **שינוי 1 (TASE divisor):** אם ה-Gateway מחזיר ILS (לא Agorot) — המחירים יהיו ×100 גדולים מדי. אבל הראיה ברורה (DB=$205K, quotes=$2K). סיכון נמוך.
- **שינוי 2 (changePercent):** אם `prior_close` מה-Gateway שונה מ-RTH close — ה-% לא יתאים 100% ל-IBKR app. אבל יהיה הרבה יותר קרוב מהמצב הנוכחי. סיכון נמוך.

## אחרי התיקון

- עדכון version ל-v14.28
- Publish
- בדיקה ב-premarket למחרת (04:00+ ET)
