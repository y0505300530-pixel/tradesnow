# דוח השוואה מלא: Paper Trading Lab מול Trading Lab (המעבדה הישנה)

**תאריך:** 16 במאי 2026  
**מטרה:** זיהוי כל הפערים בין שתי המעבדות והמלצות לשדרוג Paper Trading Lab

---

## 1. סקירה כללית

**Trading Lab (המעבדה הישנה)** היא סימולציה היסטורית (backtest) שרצה על נתוני עבר. היא מריצה LLM scan על כל טיקר, מחשבת אינדיקטורים טכניים מלאים (EMA, RSI, ATR, Donchian, Gann), ומנהלת פורטפוליו וירטואלי עם מנגנוני כניסה ויציאה מתוחכמים מאוד. גרסה נוכחית: ~v12.06 / v1.200+.

**Paper Trading Lab** היא מעבדה בזמן אמת (forward-test) שפועלת כבורסה וירטואלית עצמאית. היא מקבלת סיגנלים מה-Ziv Scanner (userAssets), מבצעת כניסות ויציאות אוטומטיות על בסיס מחירים חיים, ומנהלת $100K הון וירטואלי. גרסה נוכחית: v20.71.

---

## 2. טבלת השוואה ראשית — ניהול פוזיציות ויציאות

| פיצ'ר | Trading Lab (ישנה) | Paper Trading Lab | פער |
|--------|-------------------|-------------------|-----|
| **Anti-Stop Hunt (EOD-Only SL)** | SL נבדק רק על Close יומי. Wick שפורץ SL אבל סוגר מעל — מתעלם. | SL נבדק על מחיר חי (real-time). כל נגיעה ב-SL מפעילה יציאה. | **חסר** — Paper Lab חשוף ל-Stop Hunts |
| **Minimum Hold Period (3 ימים)** | SL קפוא ל-3 ימי מסחר ראשונים. חריגה: ירידה >8% מכניסה = יציאת חירום. | אין תקופת החזקה מינימלית. SL פעיל מרגע הכניסה. | **חסר** |
| **Catastrophe Stop** | יציאה מיידית אם מחיר יורד >10% מ-Open (15% ל-FOM, 20% ל-Core). גם 2×ATR מתחת ל-SL. Cold Strategy פטורה. | אין Catastrophe Stop. | **חסר** |
| **Partial TP (Target 1 = 50%)** | כשמחיר מגיע ל-50% מהדרך ל-TP → מוכר 50% מהפוזיציה, מעביר SL ל-Break-Even. | **Partial Profit Lock** — כשמחיר מגיע ל-50% מהדרך ל-TP → מוכר 40% ומעביר SL ל-Break-Even. | **קיים** (שונה מעט: 40% במקום 50%) |
| **Wide Lung Mode** | מופעל ב-+5% רווח. מבטל TP קבוע, עובר ל-EMA-20 trailing בלבד. | אין Wide Lung Mode. | **חסר** |
| **Winner's Leash (15% מהשיא)** | ב-Final Order Mode: אם מחיר יורד 15% מהשיא → יציאה. | אין Winner's Leash. | **חסר** |
| **EMA-10 / EMA-20 Trailing Stop** | 2 ימים רצופים מתחת ל-Daily EMA-10 (Final Order) / EMA-20 (רגיל) → יציאה. | אין EMA trailing. SL/TP דינמיים דרך calcDynamicSlTp. | **חסר** (מנגנון שונה) |
| **ZIM Protocol (Core Holdings)** | 3 ימי Weekly EMA-200 structural death + 12% Hard Support Buffer. Diamond Hands. | אין ZIM Protocol. | **חסר** |
| **Extreme Momentum Mode** | RSI>60 + מעל EMA-50 + slope חיובי → EMA-8 trail במקום EMA-20. | אין. | **חסר** |
| **Parking Lot ATR Trailing** | 1.5×ATR(14) trailing stop ל-ETFs (QQQ/SMH/BIL). Ratchet — רק עולה. | אין Parking Lot. | **חסר** |
| **Gann Date SL Tighten** | בתאריכי Gann cycle → SL מתהדק לפי מבנה הבר. | אין. | **חסר** |
| **Higher Low / Lower High Trail** | SL עוקב אחרי Higher Lows (long) מ-30 ברים אחרונים. | אין. | **חסר** |
| **Gap-Aware Execution** | אם Open פורץ SL/TP → מילוי ב-Open (לא ב-SL/TP). | **קיים** — אותה לוגיקה. | ✅ קיים |
| **Exit Slippage** | אין slippage מפורש בסימולציה. | 0.1% slippage על כניסה ויציאה + $2.50 עמלה. | Paper Lab **טוב יותר** (ריאליסטי יותר) |
| **Ziv Health Force-Close** | אין (הסימולציה לא מחשבת ZivH בזמן אמת). | ZivH < 4.0 + מחיר ≥75% לכיוון SL → סגירה. V-Shape Grace 3 דקות. | Paper Lab **טוב יותר** |

---

## 3. טבלת השוואה — מנגנוני כניסה

| פיצ'ר | Trading Lab (ישנה) | Paper Trading Lab | פער |
|--------|-------------------|-------------------|-----|
| **LLM AI Scan** | סריקת LLM מלאה לכל טיקר (aiScanTicker) — מחזירה confidence, strategy, entryZone, SL, TP. | אין LLM scan. כניסה מבוססת על Ziv Scanner (userAssets) — tier + score. | **שונה** — Paper Lab מסתמך על סיגנלים קיימים |
| **Donchian Breakout** | מחיר פורץ Donchian-20 High + volume > 1.5× ממוצע → כניסה. | אין Donchian Breakout ספציפי. "Gold Breakout" מגיע מה-scanner. | **חלקי** |
| **Join the Move** | מחיר >10% מעל EMA-50 + שיא 52 שבועות → כניסה עם 5% trailing stop. | אין. | **חסר** |
| **Proximity Entry** | מחיר בטווח 4% מ-EMA-50 + slope חיובי → כניסה. | אין. כניסה רק על סיגנלים מ-scanner. | **חסר** |
| **Cold Strategy** | RSI<30 + מעל EMA-200 → mean-reversion trade. מקס 2 פוזיציות, 5% הון. | אין. | **חסר** |
| **Primary Trend Filter** | חייב EMA-50 slope חיובי + מחיר מעל EMA-50 (עם חריגות). | אין — כניסה על כל סיגנל Gold/Breakout Override. | **חסר** |
| **Bear Market Recovery** | מחיר > EMA-200×1.02 + RSI<50 + נר ירוק → חריגה מ-Trend Filter. | אין. | **חסר** |
| **Early Recovery Mode** | מחיר מעל EMA-200 + EMA-50 slope עולה (גם אם מתחת ל-EMA-50). | אין. | **חסר** |
| **EMA-50 Extension Cap (7%)** | חוסם כניסה כשמחיר >7% מעל EMA-50 (למעט JTM/Donchian). | אין. | **חסר** |
| **EMA-50 Slope Guard** | slope שלילי + כניסת Proximity → חסימה. | אין. | **חסר** |
| **Entry Trigger Gate** | Pullback-in-Bull-Trend דורש trigger ספציפי (Donchian/EMA-10 cross/RSI<40). | אין. | **חסר** |
| **Active Trader Mode** | 0 פוזיציות פתוחות → מקבל medium confidence. | אין (אין confidence system). | **חסר** |
| **Retest Entry** | מחיר חוזר לאזור breakout (±3%) תוך 30 יום → כניסה שנייה. | אין. | **חסר** |
| **FOMO Re-Entry** | שיא 3 ימים חדש אחרי יציאה → cooldown מתבטל, כניסה מחדש. | אין. | **חסר** |
| **3-Day Rule Re-Entry** | מחיר סוגר מעל מחיר יציאה 3 ימים רצופים → כניסה מחדש. | אין. | **חסר** |
| **Phoenix Re-Entry** | אחרי ZIM Protocol exit → כניסה מחדש כשמחיר > EMA-200 + EMA-50 slope חיובי. | אין. | **חסר** |
| **UTP v4.0 Immediate Recovery** | מחיר סוגר מעל מחיר יציאה תוך 5 ימים → כניסה מיידית. | אין. | **חסר** |

---

## 4. טבלת השוואה — ניהול הון ופורטפוליו

| פיצ'ר | Trading Lab (ישנה) | Paper Trading Lab | פער |
|--------|-------------------|-------------------|-----|
| **Tier-Based Position Sizing** | Hot (Ziv 9-10): 20% / Tier-1 (7-8): 10% / Tier-2 (5-6): 5% / Tier-3 (≤4): skip. | Gold Breakout Ziv 8-10: 7% / Ziv 6-7: 5% / Gold Retest 8-10: 5% / Retest 6-7: 3.5% / Override: 2.5%. | **שונה** — Paper Lab שמרני יותר |
| **Conviction Top-Up (Pyramid)** | מוסיף הון לפוזיציה החזקה ביותר (score ≥55). עד 90% מההון. | אין. | **חסר** |
| **Idle Cash Overflow** | אם מזומן >40% מהפורטפוליו → מפזר לפוזיציות עם score ≥70. | אין. | **חסר** |
| **Underperformer Capital Stripping** | מוריד הון מפוזיציות חלשות ומעביר לחזקות. | אין. | **חסר** |
| **Liquidity Override** | אם אין מזומן ל-Tier-1 → סוגר פוזיציה חלשה כדי לשחרר הון. | אין. | **חסר** |
| **Liquidity Hierarchy (Alpha Attack)** | מחסל פוזיציות עם alpha שלילי (מפסידות ל-Monkey) כדי לממן כניסות חדשות. | אין. | **חסר** |
| **Proven Elephant Multiplier** | טיקר עם cumROI>30% + יציאה מוצלחת → הקצאה כפולה. | אין. | **חסר** |
| **Risk Level Scaling** | רמת סיכון 1-10 משנה אחוזי הקצאה (Conservative → Aggressive). | אין. | **חסר** |
| **Portfolio Concentration Cap** | מקסימום 75% deployed (80% ל-Tier-1). חוסם כניסות חדשות. | מקסימום 95% deployed (100% ל-Gold Breakout score ≥9). | **קיים** (שונה) |
| **Daily Tier-1 Throttle** | מקסימום 3 כניסות Tier-1 ביום. | אין הגבלה יומית. | **חסר** |
| **Max Open Positions** | אין הגבלה מפורשת (מוגבל ע"י הון). | 20 פוזיציות מקסימום. | Paper Lab **מגביל** |
| **VIX Filter** | VIXY > $18 → הקצאה ×0.5. VIXY > $25 → חסימת כניסות. | אין. | **חסר** |
| **Correlation Brake** | Tech/Growth > 40% מהפורטפוליו → חסימת כניסות Tech חדשות. | אין. | **חסר** |
| **Bear Market Filter** | QQQ מתחת ל-EMA-50 → Defensive Mode, הקצאה מקסימלית 15%. | אין. | **חסר** |
| **Equity Curve Trailing Stop** | Equity 15%+ מתחת ל-ATH → חסימת כניסות חדשות. | אין (יש Circuit Breaker ב-20%). | **חלקי** |
| **Red Alert** | Realized equity 20%+ מתחת ל-ATH → חסימת כל הכניסות. | Circuit Breaker ב-20% drawdown. | ✅ **קיים** (שם שונה) |
| **Parking Lot (Multi-Asset)** | מזומן >40% + אין Tier-1 → מפזר ל-QQQ/SMH/RSP/GLD/BIL. | אין. | **חסר** |

---

## 5. טבלת השוואה — מנגנוני הגנה ו-Anti-Churn

| פיצ'ר | Trading Lab (ישנה) | Paper Trading Lab | פער |
|--------|-------------------|-------------------|-----|
| **Anti-Churn Penalty Box** | 2 SL hits ב-14 יום → חסימה ל-5 ימים (in-memory). | 2 SL hits ב-14 יום → חסימה ל-5 ימים (DB-persisted). | ✅ **קיים** (Paper Lab טוב יותר — שורד restart) |
| **Cooldown After Exit** | cooldown קבוע (משתנה לפי סוג). | SL: 30 דקות / Force-Close: 90 דקות / TP: 15 דקות. | ✅ **קיים** |
| **Daily Blacklist** | אין (cooldown מבוסס ימים). | אין כניסה מחדש באותו יום אחרי יציאה. | Paper Lab **טוב יותר** |
| **Tight Exit Error SL Widening** | אם יציאה קודמת הייתה מוקדמת (מחיר +5% אחרי 10 ימים) → SL מורחב +2%. | אין. | **חסר** |
| **Ziv Score Gate** | Ziv ≤3 → חסימת כניסה (למעט Core/Breakout). | Ziv < 6.0 → חסימת Breakout Override. Ziv < 7.5 → חסימת Gold. | ✅ **קיים** (שונה) |
| **Dynamic MANDATORY_CORE** | כל יום מחשב מחדש אילו טיקרים הם Core (Ziv ≥6). | אין — אין מושג של Core Holdings. | **חסר** |
| **Ziv Blocked Re-Injection** | טיקרים שנחסמו בתחילת הסימולציה → נבדקים מחדש כל יום. | לא רלוונטי (אין סימולציה). | N/A |
| **Portfolio Heat Warning** | 60%+ פוזיציות פגעו ב-EMA-20 ב-5 ימים → חסימת כניסות. | אין. | **חסר** |

---

## 6. טבלת השוואה — אסטרטגיות מיוחדות

| פיצ'ר | Trading Lab (ישנה) | Paper Trading Lab | פער |
|--------|-------------------|-------------------|-----|
| **Final Order Mode** | High/Medium confidence → TP מושבת, יציאה רק ב-EMA-10 (2 ימים) או Winner's Leash 15%. | אין. | **חסר** |
| **Core Holding Mode** | ZIM/MU + טיקרים עם Ziv ≥6 → ZIM Protocol, Diamond Hands. | אין. | **חסר** |
| **Cold Strategy** | RSI<30 mean-reversion. מקס 2 פוזיציות, 30 ימים, TP +12%, SL -10%. | אין. | **חסר** |
| **Slow Grind Mode** | Tier-3 פוזיציות עם הקצאה קטנה. | אין. | **חסר** |
| **Alpha Attack Mode** | מחסל פוזיציות עם alpha שלילי כדי לממן כניסות חזקות. | אין. | **חסר** |
| **Short Selling** | תמיכה מלאה ב-Short (bearish divergence + RSI>60 + מתחת ל-EMA-50). | אין — Long בלבד. | **חסר** |

---

## 7. טבלת השוואה — תשתית טכנית

| פיצ'ר | Trading Lab (ישנה) | Paper Trading Lab | פער |
|--------|-------------------|-------------------|-----|
| **מקור נתונים** | נתונים היסטוריים (allPrices) — precomputed. | מחירים חיים (fetchLivePrice/fetchLivePricesBatch). | **שונה** — Paper Lab בזמן אמת |
| **Precomputed Indicators** | EMA-20/50/200, RSI-14, ATR-14, Donchian-20, High-52w — O(1) lookup. | מחשב ATR-14 בכניסה. ZivH score בכל cycle. | Paper Lab **פחות אינדיקטורים** |
| **LLM Integration** | aiScanTicker — LLM מלא לכל טיקר (strategy, confidence, entry zone). | אין LLM — מסתמך על Ziv Scanner. | **שונה** |
| **Monkey Benchmark** | Buy & Hold benchmark לכל טיקר + Alpha calculation. | אין. | **חסר** |
| **Equity Snapshots** | equityCurve array בזיכרון. | DB-persisted hourly + midnight snapshots. | Paper Lab **טוב יותר** |
| **Commission Model** | אין עמלות. | $2.50 per execution + 0.1% slippage. | Paper Lab **ריאליסטי יותר** |
| **TASE Support** | אין (US stocks בלבד). | תמיכה מלאה ב-TASE (.TA) + המרת ILA→USD. | Paper Lab **טוב יותר** |
| **Market Hours Guard** | אין (סימולציה היסטורית). | בדיקת שעות מסחר US + TASE לכניסות ויציאות. | Paper Lab **טוב יותר** |
| **Concurrent Instance Guard** | אין (single-threaded simulation). | Mutex + DB entry lock + 5-min duplicate check. | Paper Lab **טוב יותר** |
| **Session Management** | אין (run once). | sessionId — reset lab מתחיל session חדש. | Paper Lab **טוב יותר** |

---

## 8. סיכום פערים קריטיים — מה חסר ב-Paper Trading Lab

### פערים ברמה גבוהה (High Priority — משפיעים ישירות על ביצועים):

1. **Anti-Stop Hunt (EOD-Only SL)** — Paper Lab חשוף ל-stop hunts כי SL נבדק בזמן אמת
2. **Minimum Hold Period (3 ימים)** — פוזיציות נסגרות מוקדם מדי
3. **Wide Lung Mode** — רווחים נחתכים ב-TP קבוע במקום לרוץ עם EMA-20
4. **Winner's Leash** — אין הגנה מ-drawdown גדול בפוזיציות מנצחות
5. **Final Order Mode** — אין מצב "תן לזה לרוץ" לסיגנלים חזקים
6. **Conviction Top-Up (Pyramid)** — לא מגדיל פוזיציות מנצחות
7. **Primary Trend Filter** — נכנס לפוזיציות גם כשהטרנד שלילי

### פערים ברמה בינונית (Medium Priority):

8. **Catastrophe Stop** — אין הגנה מקריסה פתאומית
9. **Cold Strategy** — לא מנצל חודשים "קרים" עם mean-reversion
10. **Liquidity Override** — לא מפנה הון לטובת סיגנלים חזקים
11. **VIX Filter** — לא מפחית חשיפה בתנודתיות גבוהה
12. **Correlation Brake** — לא מגביל ריכוז סקטוריאלי
13. **Bear Market Filter** — לא עובר למצב הגנתי כשהשוק יורד
14. **Join the Move** — מפספס מנהיגי שוק ב-52-week high
15. **Re-Entry Mechanisms** — אין FOMO/3-Day Rule/Phoenix/Immediate Recovery

### פערים ברמה נמוכה (Nice to Have):

16. **Short Selling** — אין אפשרות לשורט
17. **Monkey Benchmark** — אין השוואה ל-Buy & Hold
18. **Gann Date SL Tighten** — פיצ'ר נישה
19. **Slow Grind Mode** — פוזיציות Tier-3 קטנות
20. **Alpha Attack Mode** — ניהול הון מתקדם

---

## 9. מה Paper Trading Lab עושה **טוב יותר** מהמעבדה הישנה

| פיצ'ר | הסבר |
|--------|-------|
| **ריאליזם** | עמלות ($2.50), slippage (0.1%), שעות מסחר — מדמה מסחר אמיתי |
| **Ziv Health Force-Close** | מנגנון יציאה חכם שלא קיים בסימולציה |
| **V-Shape Grace** | 3 דקות חסד לפני Force-Close — מונע יציאה על flash crash |
| **Daily Blacklist** | מונע כניסה מחדש באותו יום — Anti-Churn חזק |
| **DB-Persisted Penalty Box** | שורד restart (בניגוד ל-in-memory של המעבדה הישנה) |
| **TASE Support** | תמיכה בבורסת תל אביב |
| **Equity Snapshots** | snapshots שעתיים + חצות ב-DB — לא נאבדים |
| **Concurrent Safety** | mutex + DB locks — מונע כפילויות |
| **SPY Beta Context** | SPY day-start price לחישוב beta בזמן אמת |
| **Partial Profit Lock** | 40% lock + SL to break-even — ניהול סיכון חכם |

---

## 10. המלצות לשדרוג Paper Trading Lab

בהתבסס על הניתוח, אלה הפיצ'רים המומלצים לשדרוג **לפי סדר עדיפות**:

### שלב 1 — "אזור מסחר סופר" (הגנות קריטיות):
1. **Anti-Stop Hunt** — SL נבדק רק על Close (או לפחות על 5-min candle close)
2. **Minimum Hold Period** — 3 שעות מינימום (או X ברים) לפני שSL פעיל
3. **Primary Trend Filter** — חסימת כניסות כשEMA-50 slope שלילי
4. **Catastrophe Stop** — יציאה מיידית בירידה >10% מ-Open

### שלב 2 — "תן לרווחים לרוץ":
5. **Wide Lung Mode** — ב-+5% רווח: TP מושבת, trailing על EMA-20
6. **Winner's Leash** — 15% drawdown מהשיא = יציאה
7. **Final Order Mode** — סיגנלים חזקים (Ziv ≥9) → רק EMA trailing, בלי TP קבוע

### שלב 3 — "ניהול הון חכם":
8. **Conviction Top-Up** — הגדלת פוזיציות מנצחות
9. **Liquidity Override** — סגירת חלשות לטובת חזקות
10. **VIX Filter** — הפחתת חשיפה בתנודתיות גבוהה
11. **Correlation Brake** — הגבלת ריכוז סקטוריאלי

### שלב 4 — "כניסות חכמות":
12. **Join the Move** — כניסה למנהיגי שוק ב-52-week high
13. **Re-Entry Mechanisms** — FOMO + 3-Day Rule + Immediate Recovery
14. **Cold Strategy** — mean-reversion בחודשים קרים
15. **Bear Market Filter** — מצב הגנתי אוטומטי

---

> **שורה תחתונה:** Paper Trading Lab היא מעבדה ריאליסטית מצוינת עם תשתית חזקה (slippage, commissions, market hours, DB persistence), אבל חסרים לה מנגנוני ניהול פוזיציות מתקדמים שהמעבדה הישנה פיתחה לאורך עשרות גרסאות. השדרוג העיקרי הנדרש הוא בצד היציאות (Anti-Stop Hunt, Wide Lung, Winner's Leash) ובצד ניהול ההון (Trend Filter, Conviction Top-Up, VIX Filter).
