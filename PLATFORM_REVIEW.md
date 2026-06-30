# סקירת פלטפורמה — tradesnow.vip
**גרסה נוכחית | עודכן: מרץ 2026**

---

## תמצית מנהלים

tradesnow.vip היא פלטפורמת מסחר אישית מלאה, בנויה על React 19 + TypeScript + tRPC + PostgreSQL (MySQL/TiDB), ומאוחסנת ב-Manus. הפלטפורמה משלבת ניתוח וידאו מ-YouTube, מנוע ציונות Ziv קנייני, ניהול תיק השקעות, מעקב Watchlist, מעבדת סימולציות, התראות מחיר עם Telegram, ואינטגרציה עם TradingView — הכל תחת קורת גג אחת.

---

## 1. ארכיטקטורה טכנית

| שכבה | טכנולוגיה |
|------|-----------|
| Frontend | React 19, TypeScript, Vite, TanStack Query (tRPC), Tailwind CSS 4, shadcn/ui |
| Backend | Node.js, Express 4, tRPC 11, Drizzle ORM |
| מסד נתונים | MySQL/TiDB (27 טבלאות) |
| אחסון קבצים | S3 (Manus Storage) |
| APIs חיצוניים | Yahoo Finance (מחירים), Telegram Bot API, TradingView Widgets, Supadata (YouTube) |
| אימות | Manus OAuth (JWT sessions) |
| בדיקות | Vitest — **311 בדיקות עוברות, 0 שגיאות TypeScript** |

---

## 2. דפים ומסכים

### 2.1 Landing Page (`/`)
דף כניסה ציבורי עם תיאור הפלטפורמה וכפתור כניסה.

### 2.2 Home / Dashboard (`/landing`)
לוח בקרה ראשי עם סקירה מהירה של מצב התיק.

### 2.3 Trade Manager (`/trade`)
**מרכז ניהול התיק** — הדף המרכזי ביותר בפלטפורמה.

| תכונה | פרטים |
|-------|--------|
| טבלת Holdings | מניות בתיק עם מחיר נוכחי (pre-market/AH), % Today, P&L, Ziv Score, Action |
| עמודת Stop Loss | ערכי SL עם עריכה inline ישירה בטבלה |
| עמודת Take Profit | ערכי TP עם עריכה inline ישירה בטבלה |
| שורת סיכום | ערך תיק כולל, שינוי יומי ממושקל, P&L כולל, ממוצע Ziv Score, Cost Basis |
| לוגיקת Action | HOLD STRONG/ADD (≥8), HOLD (≥7), WATCH (≥5), CONSIDER EXIT (<5), EXIT (Trash/ZIM) |
| Trading Diary | יומן עסקאות מתקפל, מוסיף פוזיציות לתיק |
| Performance Chart | גרף P&L (bar chart) + עוגת הקצאת תיק |
| Deep Analysis Modal | ניתוח מעמיק עם TradingView chart + רמות מפתח (Buy, SL, EMA-50, EMA-200) |
| Quick Buy Dialog | קנייה מהירה עם מחיר מומלץ, SL, מספר מניות, עלות כוללת |

### 2.4 Asset Catalogue (`/catalogue`)
**קטלוג נכסים** — רשימת 60 המניות הנבחרות.

| תכונה | פרטים |
|-------|--------|
| ציון Ziv | מוצג לכל מניה עם ScoreBadge צבעוני |
| עמודת "בתיק" | סימן ✓ ירוק אם המניה כבר בתיק |
| כפתור "קנה" | פותח Quick Buy Dialog מולא מראש |
| Analyze All | מריץ את מנוע Ziv על כל המניות (batch עם throttling) |
| Daily Review | סקירה יומית מתקפלת עם המלצות AI |
| Archive | ארכיון מניות מוסרות עם אפשרות שחזור |
| מיון | לפי ציון Ziv מגבוה לנמוך |

### 2.5 Watchlist (`/watchlist`)
רשימת מעקב אישית.

| תכונה | פרטים |
|-------|--------|
| עמודת Ziv Score | ציון לכל מניה ב-Watchlist |
| כפתור "חשב ציונות" | מריץ Ziv Engine על כל המניות ללא ציון (batch של 5) |
| מיון | לפי ציון מגבוה לנמוך |
| רענון אוטומטי | בטעינת הדף |

### 2.6 Price Alerts (`/alerts`)
**מערכת התראות מחיר** עם אינטגרציית Telegram.

| תכונה | פרטים |
|-------|--------|
| יצירת התראות | SL / TP / Custom לכל מניה |
| סנכרון אוטומטי | SL/TP מ-Holdings יוצרים התראות אוטומטית |
| Poller | בדיקה כל 30 דקות בשרת |
| Telegram | שליחת הודעה כשמחיר מגיע ליעד |
| "Check Now" | בדיקה ידנית מיידית |
| Daily Summary | סיכום יומי ב-09:00 (שעון ישראל) |
| מניעת כפילויות | `triggered=1` לפני שליחה + `pollerRunning` lock |

### 2.7 Trading Lab (`/lab`)
**מעבדת סימולציות** — בדיקת אסטרטגיות על נתונים היסטוריים.

| תכונה | פרטים |
|-------|--------|
| סימולציות | הרצת backtest על מניות מהקטלוג |
| Triple Simulation | סימולציה משולשת (`/lab/triple`) |
| ביצועים | cache 30 שניות בשרת, שאילתות ללא JSON כבד |
| Lab Reports | דוחות מפורטים לכל סימולציה |

### 2.8 Video Management (`/videos`)
**ניהול וידאו YouTube** — הלב המקורי של הפלטפורמה.

| תכונה | פרטים |
|-------|--------|
| הזנת URL | קישור YouTube → תמלול אוטומטי |
| Supadata API | תמלול transcript |
| ניתוח AI | מחלץ מידע מסחרי מובנה מהתמלול |
| היסטוריה | שמירת כל הניתוחים |

### 2.9 Knowledge Base (`/knowledge`) ו-Master Knowledge (`/master`)
בסיסי ידע לניהול מידע מסחרי ועקרונות אסטרטגיה.

### 2.10 Settings (`/settings`)
הגדרות משתמש כולל TradingView, Telegram, IBKR.

### 2.11 TradingView (`/tradingview`)
דף TradingView מלא עם widgets מוטמעים.

---

## 3. מנוע Ziv — לב הפלטפורמה

מנוע הציונות הקנייני (`server/zivEngine.ts`) מחשב ציון 0–10 לכל מניה:

| רכיב | תיאור |
|------|--------|
| EMA-50 / EMA-200 | חישוב ממוצעים נעים (2 שנות נתונים) |
| Weekly EMA-50 Slope | מגמה שבועית |
| Donchian 20 | שיא 20 ימים (breakout detection) |
| RSI (14) | מדד כוח יחסי |
| Price Action | Hammer, Inside Bar, Bullish Engulfing |
| Volume | נפח מסחר יחסי |

**Tiers (רמות):**

| ציון | Tier | פעולה |
|------|------|--------|
| 9–10 | Prime Breakout | HOLD STRONG / ADD |
| 8–8.99 | Prime Breakout | HOLD STRONG / ADD |
| 7–7.99 | Pullback Setup | HOLD |
| 5–6.99 | Neutral | WATCH |
| 3–4.99 | Neutral/Trash | CONSIDER EXIT |
| <3 | Trash / ZIM | EXIT |

---

## 4. מסד הנתונים — 27 טבלאות

| טבלה | תפקיד |
|------|--------|
| `portfolioHoldings` | פוזיציות פתוחות בתיק (מחיר קנייה, יחידות, SL, TP, Ziv Score) |
| `userAssets` | קטלוג 60 המניות עם ציונות וסריקה |
| `priceAlerts` | התראות מחיר (SL/TP/Custom) עם סטטוס triggered |
| `labSimulations` | סימולציות Lab |
| `labTrades` | עסקאות בתוך סימולציות |
| `labDailyLogs` | לוגים יומיים של סימולציות |
| `analyses` | ניתוחי YouTube שמורים |
| `knowledgeBase` | בסיס ידע |
| `masterKnowledge` | ידע מאסטר |
| `tradingDiary` | יומן עסקאות |
| `portfolioAnalysis` | תוצאות ניתוח תיק |
| `portfolioSnapshots` | snapshots יומיים לגרף ביצועים |
| `capitalEvents` | הפקדות/משיכות |
| `tvAlerts` | התראות TradingView |
| `tvWebhookSettings` | הגדרות Webhook TradingView |
| `priceCache` | cache מחירים היסטוריים |
| `llmScanCache` | cache תוצאות LLM |
| `userSettings` | הגדרות משתמש (Telegram, etc.) |
| `ibkrSettings` | הגדרות IBKR |
| `channelVideos` | וידאו YouTube |
| `bulkSessions` | סשנים של ניתוח bulk |
| `bulkSessionAnalyses` | ניתוחים בתוך bulk session |
| `parkingLotConfig` | הגדרות Parking Lot |
| `portfolioAccounts` | חשבונות תיק |
| `proficiencyMatrix` | מטריצת מיומנות |
| `tradePositions` | פוזיציות מסחר |
| `users` | משתמשים |

---

## 5. אינטגרציות חיצוניות

### 5.1 Yahoo Finance
מחירים בזמן אמת כולל **pre-market ו-after-hours** — מסונכרן עם IBKR. חישוב `% Today` = (מחיר נוכחי − סגירה אחרונה) / סגירה אחרונה.

### 5.2 Telegram Bot (`@PollyGray_Blitzzbot`)
- התראות SL/TP אוטומטיות כשמחיר מגיע ליעד
- סיכום יומי ב-09:00 עם כל הפוזיציות
- כפתור "Check Now" לבדיקה ידנית
- הגנה מפני כפילויות (lock + triggered flag)

### 5.3 TradingView
- Widgets מוטמעים בדף TradingView
- גרף בתוך Deep Analysis Modal עם annotations (Buy, SL, EMA-50, EMA-200)
- Webhook support לקבלת התראות מ-TradingView

### 5.4 Supadata / YouTube
- תמלול transcript אוטומטי מ-YouTube URL
- ניתוח AI לחילוץ מידע מסחרי מובנה

---

## 6. מה עדיין בתכנון (TODO)

| פיצ'ר | סטטוס |
|-------|--------|
| תפריט Telegram אינטראקטיבי (`/holdings`, `/alerts`, `/summary`) | ממתין לפיתוח |
| Market Scan button | ממתין לבירור |
| TradingView Webhooks מלא | חלקי |
| CSV Export להולדינגס | ממתין |
| היסטוריית התראות | ממתין |
| זמן Daily Summary ניתן להגדרה | ממתין |
| פילטר Holdings לפי Action | ממתין |

---

## 7. מצב בדיקות

הפלטפורמה כוללת **311 בדיקות Vitest** ב-7 קבצי test:

| קובץ | תוכן |
|------|------|
| `analyze.test.ts` | מנוע Ziv — ציונות, tiers, decimal precision |
| `trade.test.ts` | לוגיקת עסקאות |
| `tradingLab.test.ts` | סימולציות Lab |
| `ibkr.test.ts` | IBKR integration |
| `progress.test.ts` | מעקב התקדמות |
| `v12_06_fixes.test.ts` | regression tests לתיקונים |
| `auth.logout.test.ts` | אימות ו-logout |

---

## 8. סיכום

הפלטפורמה בשלה ופונקציונלית. כל הפיצ'רים המרכזיים פועלים: ניתוח YouTube, מנוע Ziv, ניהול תיק עם pre-market prices, התראות Telegram, סימולציות Lab, ו-TradingView. הצעד הבא המוסכם הוא הוספת **תפריט אינטראקטיבי בבוט Telegram** עם פקודות `/holdings`, `/alerts`, ו-`/summary`.
