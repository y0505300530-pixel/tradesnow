# דוח שדרוג: Trading Lab (ישנה) ← Paper Trading Lab (חדשה)

**תאריך:** 16 במאי 2026  
**מטרה:** לעדכן את חוקי המעבדה הישנה (Trading Lab) לפי החוקים החדשים של Paper Trading Lab, ולחבר את מקור הטיקרים ל-Asset Catalog.

---

## חלק א׳: מצב נוכחי — מה קיים בכל מעבדה

### Trading Lab (ישנה) — v12.06
| תחום | מה קיים |
|-------|---------|
| **סוג** | סימולציה היסטורית (backtesting) על נתוני OHLCV יומיים |
| **מקור טיקרים** | המשתמש מזין ידנית רשימת טיקרים בכל סימולציה |
| **הון התחלתי** | $10,000 לכל טיקר (configurable) עם Master Fund משותף |
| **כניסה** | LLM scan → Ziv Score → Tier system (1/2/3) + Donchian breakout + Join The Move |
| **יציאות** | SL, TP, Wide Lung (EMA-20), Winner's Leash (15-25%), Catastrophe Stop (25%), ZIM Protocol |
| **ניהול הון** | Conviction Top-Up, Idle Cash Overflow, Parking Lot, Cold Strategy |
| **הגנות** | Anti-Stop Hunt (EMA-50 slope), Circuit Breaker (20% drawdown), RSI caps |
| **מיוחד** | ZIM Protocol (Core Holdings), Diamond Hands, Partial Profit Lock, Alpha Mode |

### Paper Trading Lab — v20.82
| תחום | מה קיים |
|-------|---------|
| **סוג** | מסחר וירטואלי חי (forward-testing) עם מחירים בזמן אמת |
| **מקור טיקרים** | Asset Catalog (userAssets) — כל המניות הפעילות בקטלוג |
| **הון התחלתי** | $100,000 virtual ledger |
| **כניסה** | Ziv Score + Signal classification (Gold Breakout/Retest/Override) + Dynamic sizing |
| **יציאות** | Anti-Stop Hunt (candle close), Min Hold (3h), Catastrophe (10%), Wide Lung, Winner's Leash, Ziv Health |
| **ניהול הון** | Conviction Top-Up, Liquidity Override, VIX Filter, Trend Filter (EMA-50) |
| **הגנות** | Circuit Breaker, Daily Blacklist, Cooldowns, Penalty Box |
| **מיוחד** | Final Order Mode (Ziv≥9), Partial Profit Lock, Slippage + Commissions |

---

## חלק ב׳: פערים — מה חסר במעבדה הישנה (ומה צריך לעדכן)

### פיצ'רים שקיימים ב-Paper Lab ו**חסרים** ב-Trading Lab:

| # | פיצ'ר | תיאור | עדיפות |
|---|--------|--------|--------|
| 1 | **Anti-Stop Hunt (Candle Close SL)** | SL נבדק רק על Close של נר ולא על High/Low intraday | High |
| 2 | **Minimum Hold Period (3h)** | SL + ZivH מושבתים 3 שעות אחרי כניסה | High |
| 3 | **Catastrophe Stop (10%)** | ירידה 10% מ-Entry = יציאה מיידית (המעבדה הישנה משתמשת ב-25% רק ל-ZIM Core) | High |
| 4 | **VIX Volatility Filter** | VIX>25 = הפחתת גודל 30%, VIX>35 = חסימת כניסות | High |
| 5 | **Liquidity Override** | סגירת פוזיציה חלשה (>2 ימים, ±1%) כדי לממן כניסה חזקה | Medium |
| 6 | **Daily Blacklist** | אין כניסה מחדש לאותו טיקר באותו יום | Medium |
| 7 | **Slippage + Commissions** | 0.1% slippage + $2.50 commission per execution | Medium |
| 8 | **Final Order Mode (Ziv≥9)** | ביטול TP מהכניסה, רק EMA trailing | Medium |
| 9 | **Dynamic Position Sizing** | Conviction-weighted sizing לפי Realized Equity | Medium |
| 10 | **Penalty Box** | 2 SL hits ב-14 יום → חסימת טיקר ל-5 ימים | Low |

### פיצ'רים שקיימים ב-Trading Lab ו**חסרים** ב-Paper Lab (כבר מתועדים):

| # | פיצ'ר | תיאור |
|---|--------|--------|
| 1 | ZIM Protocol (Core Holdings) | Diamond Hands, Weekly EMA-200, Horizontal Support |
| 2 | Cold Strategy | RSI oversold contrarian entries |
| 3 | Parking Lot Mode | ETF rotation when cash idle |
| 4 | Alpha Mode Engine | Safe Haven / Alpha Attack dynamic switching |
| 5 | LLM-based AI Scan | Full LLM analysis per ticker before entry |
| 6 | Gann Date Rule | SL tightening on Gann cycle dates |
| 7 | Idle Cash Overflow | Deploy excess cash >40% into winning positions |

> **הערה:** הפיצ'רים שחסרים ב-Paper Lab לא חלק מהמשימה הנוכחית — המשימה היא לעדכן את **המעבדה הישנה** לפי Paper Lab.

---

## חלק ג׳: משימה 2+3 — חיבור Asset Catalog כמקור טיקרים

### מצב נוכחי:
- **Trading Lab:** המשתמש מזין ידנית רשימת טיקרים בכל סימולציה חדשה
- **Asset Catalog (userAssets):** 218 טיקרים ייחודיים (163 US + 55 TASE), 1,379 רשומות (כולל כפילויות מרובות משתמשים)

### תוכנית שינוי:
1. **הוספת כפתור "Load from Catalog"** ב-UI של Trading Lab — טוען את כל הטיקרים מה-Asset Catalog של המשתמש
2. **כל הטיקרים מסומנים כ-active** (משתתפים בסימולציה) כברירת מחדל
3. **המשתמש יכול לבטל סימון** של טיקרים ספציפיים לפני הרצת הסימולציה
4. **טבלת tickers נפרדת לא נדרשת** — הטיקרים נשלפים ישירות מ-userAssets

---

## חלק ד׳: תוכנית פעולה מפורטת

### שלב 1: עדכון חוקי Exit במעבדה הישנה
**קבצים שישתנו:** `server/routers/tradingLab.ts`

| שינוי | פירוט |
|-------|--------|
| Anti-Stop Hunt | SL ייבדק רק על `bar.close` (לא על `bar.low`) |
| Minimum Hold | 3 ימי מסחר ראשונים: SL + trailing disabled (Catastrophe bypasses) |
| Catastrophe Stop 10% | הוספת בדיקה: `(entryPrice - bar.close) / entryPrice >= 0.10` → exit מיידי |
| Daily Blacklist | Map של טיקרים שיצאו היום → חסימת כניסה מחדש באותו יום |

### שלב 2: עדכון חוקי Entry במעבדה הישנה
**קבצים שישתנו:** `server/routers/tradingLab.ts`

| שינוי | פירוט |
|-------|--------|
| VIX Filter | לפני entry loop: fetch VIX, אם >25 הפחתת גודל 30%, אם >35 חסימה |
| Liquidity Override | אם אין מזומן + סיגנל חזק → סגירת פוזיציה חלשה |
| Final Order Mode | Ziv≥9 → TP disabled, רק EMA-20 trailing |

### שלב 3: הוספת Slippage + Commissions
**קבצים שישתנו:** `server/routers/tradingLab.ts`

| שינוי | פירוט |
|-------|--------|
| Entry Slippage | `entryPrice *= 1.001` (0.1% penalty) |
| Exit Slippage | `exitPrice *= 0.999` (0.1% penalty) |
| Commission | `$2.50` per execution (entry + exit = $5.00 per round trip) |

### שלב 4: חיבור Asset Catalog
**קבצים שישתנו:** `server/routers/tradingLab.ts`, `client/src/pages/TradingLab.tsx`

| שינוי | פירוט |
|-------|--------|
| Backend | endpoint חדש `getAssetCatalogTickers` — מחזיר כל הטיקרים מ-userAssets |
| Frontend | כפתור "Load from Catalog" שטוען את כל הטיקרים, כולם מסומנים |
| Validation | סינון TASE tickers (המעבדה עובדת רק עם US) |

### קבצים שלא ישתנו:
- `drizzle/schema.ts` — אין טבלאות חדשות
- `server/paperLabEngine.ts` — לא נוגע
- `server/slCalculator.ts`, `server/zivEngine.ts` — לא נוגע

---

## סיכום — 3 המשימות

| # | משימה | סטטוס |
|---|--------|--------|
| 1 | דוח השוואה + תוכנית שדרוג | ✅ מוכן — ממתין לאישור |
| 2 | חיבור Asset Catalog כמקור טיקרים | 📋 מתוכנן — ממתין לאישור |
| 3 | העתקת כל המניות מהקטלוג + סימון להשתתפות | 📋 מתוכנן — ממתין לאישור |
