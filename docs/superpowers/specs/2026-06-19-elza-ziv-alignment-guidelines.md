# אוסף הנחיות — יישור Elza עם מתודולוגיית זיו הקשוריאן

**מסמך:** `2026-06-19-elza-ziv-alignment-guidelines.md`  
**גרסה:** 3.1  
**תאריך:** 26 ביוני 2026  
**קהל יעד:** מפתחי מנוע Elza / War Engine / Ziv Engine / Short Engine  
**סטטוס:** מפרט יישום מאושר — **מסמך בלבד; קוד ממתין**

### היסטוריית גרסאות

| גרסה | תאריך | שינוי עיקרי |
|------|--------|-------------|
| 1.5 | 19.06.2026 | סלוט קבוע 12/6; Gold/Bear Breakdown EXECUTE |
| 1.6 | 19.06.2026 | מחזורי מסחר (CYC-L1/L2/S1/S2); Sector Rotation נחתך |
| 1.7 | 19.06.2026 | נספח מפת פרמטרים; קישור Deep Analysis; החלטות מאושרות |
| 1.8 | 19.06.2026 | **Role Reversal → P0** (ליבת תורה); הבחנה מ-Retest/Zone |
| 1.9 | 19.06.2026 | **מגמה שבועית מובהקת** — gate מחמיר לונג+שורט |
| 2.0 | 24.06.2026 | אישור מחקר v2.3 (14/14); YouTube RSI/פיבו/MA; SCALE_OUT **2R**; Approach B |
| **3.1** | **26.06.2026** | **קטלוג YouTube מלא** (18 סרטונים); אישור #12–#14; trail שבועי; 50%@2R; Gap Guard מ-eTVqi — **ללא שינוי קוד** |

---

## 📎 נספח v3.1 — קטלוג YouTube מלא (26 יוני 2026)

**קטלוג:** [`docs/ziv-engine-spec/YOUTUBE_CATALOG.md`](../../ziv-engine-spec/YOUTUBE_CATALOG.md)  
**Traceability:** [`docs/ziv-engine-spec/LESSON_SOURCES.md`](../../ziv-engine-spec/LESSON_SOURCES.md) — טבלת `videoId` → GAP/rule  
**מחקר:** [`2026-06-24-ziv-methodology-research.md`](./2026-06-24-ziv-methodology-research.md) §14

**סטטוס יישום:** תיעוד בלבד — **אין שינויי קוד ב-v3.1**. פרמטרים מאושרים ממתינים ל-P0/P1 כב-v2.0.

### החלטות מאושרות — אישור חוזר מ-18 סרטוני YouTube

| # | החלטה | מקור YouTube עיקרי | סטטוס v3.1 |
|---|--------|-------------------|------------|
| **12** | RSI — confluence בלבד; מגמה שבועית קודמת; לא לחסום RSI>70 במגמת עלייה | `F8-Hi9wYxSs`, `FwQgQvb9QlU` | ✅ **מאושר** — ADAPT P2; לא ממומש |
| **13** | פיבו 38.2%–61.8% + S/R = בונוס confluence; לא gate / לא TP | `3iqhYB8VNz0` | ✅ **מאושר** — ADAPT; לא ממומש |
| **14** | MA/EMA — תמיכה להחלטה; **לעולם לא** gate כניסה/יציאה עצמאי | `paOvSBYcH6M` | ✅ **מאושר**; לא ממומש |

### כללים מחוזקים מסדרת "מאות אחוזים" (BxU + zryV1uyM-jg)

| כלל | תיאור | מקור | קוד היום |
|-----|--------|------|----------|
| **Trail שבועי** | יציאה בסגירה שבועית מתחת ל**שפל שבועי אחרון** (לא %-TP) | `BxU463WI14M`, `zryV1uyM-jg` | ⚠️ `slCalculator` — trail מבני; weekly exit **לא ממומש** |
| **50%@2R** | מימוש חלקי **50%** ב-2R+ או בהתנגדות משמעותית (ללא נפח עולה) | `BxU463WI14M`, `zryV1uyM-jg`, `PEe_L73vGMI` | ⚠️ `SCALE_OUT_TP1_R = 2.0` מאושר v2.0 — **קוד עדיין 1.5R** |
| **מעקב שבועי** | לא מסך כל היום; בדיקה פעם בשבוע | `BxU463WI14M`, `zryV1uyM-jg`, `Xeae10txdI8` | — (תהליך / UI) |

### Gap Guard — מקור eTVqi

סרטון [`eTVqiCxolTY`](https://www.youtube.com/watch?v=eTVqiCxolTY) ("פומו הורס תיק") מחזק את כלל **אין FOMO** (עקרון 5):

| תובנה מ-YouTube | פרמטר alignment | מימוש |
|-----------------|-----------------|--------|
| לא לרדוף מניה שעלתה 100–600% בלי תיקון | `MAX_ENTRY_DEVIATION` 1.5% | `paperLabEngine` בלבד — P0-6 להרחבה ל-Live |
| גרף > חדשות / כתבות | Hebrew Slang Guard + mentor REJECTED | חלקי |
| כניסה מועדפת: תיקון לביקוש, לא רדיפה | Post-rally filter + Gap Guard | P1-4 פורמלי |

**מקורות נוספים ל-Gap Guard:** `lx_6phsV_qA` (5 טעויות), `VHM3p-mgMIk` (avoid רחוק מכניסה), `nI37JAmj9Eg` (לא בשיא).

---

## 📎 נספח מחקר — Research Addendum (24 יוני 2026)

**מסמך מחקר מלא:** [`2026-06-24-ziv-methodology-research.md`](./2026-06-24-ziv-methodology-research.md) **v2.3 — ✅ 14/14 אושר**

### החלטות מאושרות (v2.2 + v2.3)

| # | החלטה | סטטוס |
|---|--------|--------|
| 1–11 | ליבה: ריטסט, BO+נמ"ס, 2R+trail, CYC, ZivH, פיבו ADAPT, Gann REJECT, וכו' | ✅ v2.2 |
| **12** | RSI — confluence בלבד, מגמה שבועית קודמת | ✅ **ADAPT P2** |
| **13** | פיבו 38.2%–61.8% + S/R = בונוס confluence | ✅ **ADAPT** |
| **14** | MA/EMA — לעולם לא gate כניסה/יציאה עצמאי | ✅ **אושר** |

### ממצאים מרכזיים — סטטוס יישום

| ממצא | השפעה על v2.0 | סטטוס |
|------|--------------|-------|
| True Retest + 5 נרות | P0-3 | ✅ מאושר — **לא ממומש** |
| Role Reversal | P0-9 | ✅ מאושר — **לא ממומש** |
| TP = **Approach B** (2R מינימום + trail מבני) | `slCalculator` | ✅ מאושר — **לשנות SCALE_OUT ל-2R** |
| ZivH + weekly ב-Force-Close | פאזה 3 | ✅ מאושר — **לא ממומש** |
| RSI / פיבו / MA (YouTube v2.3) | בונוס confluence P2 | ✅ מאושר — **לא ממומש** |
| marketScan: 1M vol, 300M cap | `marketScan.ts` | ✅ מאושר — **לא ממומש** |

### מקורות שנסרקו (24.6.2026 + 26.6.2026)

- YouTube `@cyclestrading` — תמלול סרטון 26.5.2026 (28 דק', AEP/AMD/PLTR/CBOE)
- **v2.3 (24.6.2026):** 6 סרטוני YouTube נוספים (Gemini) — RSI, פיבו, MA, scale-out, פסיכולוגיה — ראו [`2026-06-24-ziv-methodology-research.md`](./2026-06-24-ziv-methodology-research.md) סעיף 12
- **v3.1 (26.6.2026):** קטלוג מלא **18 סרטונים** — [`YOUTUBE_CATALOG.md`](../../ziv-engine-spec/YOUTUBE_CATALOG.md); מיפוי traceability ב-[`LESSON_SOURCES.md`](../../ziv-engine-spec/LESSON_SOURCES.md)
- `cyclestrading.com` + `c-trading.co.il` — סילבוס קורס (37 שיעורים)
- Instagram — ❌ לא נגיש
- תוכן קורס תשלומי — ✅ חלקי (PDF שיעורים 8, 10–18, 30, 31, 37)

---

### מסמכים קשורים

| מסמך | תפקיד |
|------|--------|
| [`YOUTUBE_CATALOG.md`](../../ziv-engine-spec/YOUTUBE_CATALOG.md) | קטלוג 18 סרטונים + סדרות + מיפוי GAP |
| [`LESSON_SOURCES.md`](../../ziv-engine-spec/LESSON_SOURCES.md) | PDF שיעורים + YouTube `videoId` → GAP/rule |
| [`2026-06-19-deep-analysis-ziv-alignment.md`](./2026-06-19-deep-analysis-ziv-alignment.md) | יישור Deep Analysis (prompts + UI) עם אותה תורה |

---

## מטרה ועקרונות

### מטרה

ליישר את מנוע המסחר האוטונומי **Elza** (War Engine + `liveOrderExecutor`) עם עקרונות המסחר של **זיו הקשוריאן** — "התורה" — כך שכניסות אוטומטיות יתבצעו רק במבנים שזיו מלמד, ולא על פרוקסי טכני שגוי (כגון קרבה ל-EMA בלבד).

### הבדל מזיו: מנהלי מערכת, לא סוחרים ידניים

זיו מלמד סוחרים אנושיים: התראה → מעקב → כניסה ידנית. **Elza אינה עותק של זה.**

אנחנו **מנהלי מערכת מסחר**: המנוע מבצע `tryLiveEntry` אוטומטית על מבני כניסה (ריטסט, ביקוש, פריצה, שבירה) כשעוברים gates. Telegram = לוג תפעולי.

### גישה מאושרת: Approach B — Automated Dual Path

| סוג איתות | מצב פנימי | פעולה |
|-----------|-----------|--------|
| **Gold Breakout** / פריצת מבנה עם נפח | `EXECUTE` | gates מחמירים; גודל סלוט ×0.70 |
| **Bear Breakdown** / שבירת תמיכה עם נפח | `EXECUTE` | gates מחמירים; גודל סלוט ×0.70 |
| **True Retest** / ריטסט אמיתי לרמת פריצה | `EXECUTE` | **`tryLiveEntry` אוטומטי** |
| **Demand Zone touch** / מגע באזור ביקוש | `EXECUTE` | **`tryLiveEntry` אוטומטי** |
| **Role Reversal** / היפוך תפקיד | `EXECUTE` | **`tryLiveEntry` אוטומטי** |
| **Bullish PA at support** / נר אישור בביקוש | `EXECUTE` (גודל 75%) | כניסה אוטומטית מוקטנת אם PA בתוך zone/retest |

### עקרונות ליבה ("התורה")

1. **זיו הוא מקור האמת** — כל gate חדש חייב להיות ניתן לנימוק במונחי זיו (אזור ביקוש, ריטסט, מבנה, נפח), לא רק בציון מספרי.
2. **ריטסט אמיתי ≠ קרבה ל-EMA-50** — `distToEma50Pct ≤ 3%` (כיום ב-`zivEngine.ts`) הוא **תנאי צפייה**, לא כניסה. כניסה דורשת מגע ברמת מבנה (פריצה קודמת, swing low, או אזור ביקוש מחושב).
3. **Gold Breakout = EXECUTE מותנה** — פריצה עם נפח בזמן אמת (כמו Bear Breakdown); gates BO1–BO7 + גודל מוקטן. עדיפות ל-True Retest כששניהם מתאימים.
4. **נפח יורד במשיכה** — במשיכה לתמיכה/ריטסט, `volumeRatio < 0.85` הוא אישור חיובי. פריצה עם נפח גבוה **מאושרת לכניסה** (BO2) — לא חסימת FOMO אוטומטית.
5. **אין FOMO** — חסימת כניסה אם המחיר עלה >1.5% מעל `recommendedBuyPrice` / רמת הכניסה (Gap Guard קיים ב-`paperLabEngine.ts`; להרחיב ל-Live).
6. **תמיכה היסטורית / היפוך תפקיד** — תמיכה שעמדה במבחן ≥2 מגעים הופכת לרמת כניסה; שבירת תמיכה = **יציאה / REJECT**, לא "המתנה".
7. **שבירת תמיכה = יציאה** — אם מחיר סוגר מתחת לרמת הביקוש/SL המבני → `REJECT` לכניסות חדשות, `EXIT` לפוזיציות פתוחות.
8. **שורטים נשמרים ומתפשטים** — לוגיקת שורט היא **מראה הפוכה** של זיו לשוק דובי; לא למחוק `shortEngine.ts` / `shortGuard.ts`.
9. **סימטריה במומנטום** — Gold Breakout ו-Bear Breakdown: `EXECUTE` + gates; גודל **70%** מסלוט רגיל.
10. **עדיפות כניסה** — אם ticker מתאים לכמה סוגים: **True Retest > Role Reversal > Demand Zone > Breakout/Breakdown**. מומנטום רק כשאין מבנה טוב יותר.
11. **מחזורי מסחר מספרים את הסיפור** — לפני כל כניסה: באיזה שלב במחזור המניה? עלייה במחזור נמוך = פריצת שווא; ירידה במחזור נמוך (במיוחד בביקוש) = קונים נגמרו והיפוך מגמה. **סימטריה מלאה לשורט** במחזור גבוה.
12. **Sector Rotation — לא בשימוש** — זיו לא בונה על "לרדוף מגזר חם". **מגבלת מגזר** (3 פוזיציות / 20% NLV) נשארת לניהול סיכון תיק בלבד.
13. **היפוך תפקיד (Role Reversal) = ליבה, לא אופציה** — רמה שהפכה מתנגדות לתמיכה (או להפך בשורט) היא אחד מעמודי התורה של זיו. **P0 חובה** — לא לדחות לשלב מאוחר.
14. **הגרף השבועי קודם — מגמה מובהקת** — לונג רק כשהשבועי **שורי מובהק**; שורט רק כשהשבועי **דובי מובהק**. שבועי שטוח או מעורפל = **אין כניסה**.
15. **RSI = confluence, לא gate** (v2.3 #12) — במגמת עלייה שבועית: **לא** לחסום כניסה על RSI>70; בונוס ציון כש-RSI<30 בתיקון לביקוש. RSI לבדו ≠ אות קנייה/מכירה.
16. **פיבונאצ'י = confluence, לא TP** (v2.3 #13) — תיקון בריא 38.2%–61.8% **+** חפיפה ל-S/R = בונוס ציון; לא gate חובה לכניסה.
17. **MA/EMA = תמיכה להחלטה, לא טריגר** (v2.3 #14) — מחזק: אין כניסה מ-`distToEma50` בלבד; אין יציאות מבוססות EMA (REJECT EMA exits).

### מיפוי לקוד קיים

| רכיב | קובץ | תפקיד |
|------|------|--------|
| ציון לונג | `server/zivEngine.ts` | Tier + ציון 1–10 |
| ציון שורט | `server/shortEngine.ts` | Bear Breakdown / Retest / Weak Bear |
| סריקה + ביצוע | `server/warEngine.ts` | מחזור 20 דק', gates, `tryLiveEntry` |
| ביצוע הזמנות | `server/liveOrderExecutor.ts` | gates סופיים, SL/TP, גודל פוזיציה |
| סורק פריצות | `server/breakoutScanner.ts` | BREAKOUT + RETEST → DB `breakoutScans` |
| מנטור / וידאו | `server/routers/analyze.ts` | `SYSTEM_PROMPT`, `signal_bias`, Hebrew Slang Guard |
| SL/TP | `server/slCalculator.ts` | מבני; גודל פוזיציה — סלוט קבוע (לא 1% risk) |
| משטר שוק | `server/runtimeIntelligence.ts` | BULL/NEUTRAL/BEAR → `longOk` / `shortOk` |
| מחזור מניה | `cyclePhaseEngine.ts` (חדש) | CYC-L1/L2/S1/S2 — משותף War + Deep Analysis |
| היפוך תפקיד | `roleReversalEngine.ts` (חדש) | זיהוי V1–V6 / BR1–BR4 — לונג + שורט |
| Deep Analysis | `deepAnalysisStream.ts`, `portfolio.ts` | ראה `2026-06-19-deep-analysis-ziv-alignment.md` |

---

## מצב מנוע: אוטומטי כברירת מחדל

**ברירת מחדל:** `isEnabled=1` → Elza פועלת **אוטומטית**. אין `engineMode` מרכזי של ALERT_ONLY / SEMI.

### מה המנוע עושה

| שלב | פעולה |
|-----|--------|
| סריקה (כל 20 ד') | מחשב ציון, gates, סוג כניסה |
| `phase=WATCH` | Near Watch / EMA בלבד (ללא רמה) → שמירה ב-DB, **דילוג על `tryLiveEntry`** |
| `phase=EXECUTE` | Demand / True Retest / Role Reversal / PA / **Gold Breakout** / **Bear Breakdown** → **`tryLiveEntry`** |
| לוג תפעולי | Telegram + `war_upcoming_signals` — תיעוד לכל מחזור, לא החלטת כניסה |

### Kill switch (מנהלי מערכת בלבד)

| דגל | שימוש |
|-----|--------|
| `isEnabled=0` | עצירת כל כניסות — תחזוקה / אירוע חריג |
| `pauseEntries` (אופציונלי) | המשך ניהול פוזיציות, בלי כניסות חדשות |
| Daily loss breaker | קיים — עצירה אוטומטית |

**לא נדרש:** מצב "התראה בלבד" כזרימת עבודה. מנהל המערכת לא אמור לקנות ידנית במקום Elza.

---

## מחזורי מסחר — לוגיקת זיו (ליבת הסיפור)

זיו מלמד ש**מחזורי המסחר מספרים את הסיפור** — לא רק ציון מספרי. Elza חייבת לזהות **באיזה שלב במחזור** נמצאת המניה לפני כל כניסה, יציאה, או דחייה.

### שכבות מחזור

```
┌─────────────────────────────────────────────────────────────┐
│  מאקרו — איפה השוק במחזור? (regime)                         │
│  SPY שבועי + תנודתיות → BULL / NEUTRAL / BEAR               │
│  קובע: longOk / shortOk                                     │
├─────────────────────────────────────────────────────────────┤
│  מניה שבועית — מגמה מובהקת? (WK-L / WK-S)                   │
│  לונג: שיפוע >0.2% + מחיר מעל EMA-50 שבועי                  │
│  שורט: שיפוע <-0.2% + מחיר מתחת EMA-50 שבועי                │
├─────────────────────────────────────────────────────────────┤
│  מניה יומית — מעל/מתחת EMA-200 → פאזה שורית / דובית         │
├─────────────────────────────────────────────────────────────┤
│  מיקום במחזור — נמוך / גבוה (הליבה של זיו)                 │
│  מחזור נמוך: ביקוש, בסיס, מתחת/ליד EMA-50                   │
│  מחזור גבוה: היצע, מורחב, מעל EMA-50 ב-5%+                  │
├─────────────────────────────────────────────────────────────┤
│  אירוע — מה קורה עכשיו בתוך השלב?                           │
│  עלייה / ירידה / ריטסט / פריצה / שבירה                      │
└─────────────────────────────────────────────────────────────┘
```

### הגדרה טכנית: מחזור נמוך / מחזור גבוה

| מושג | הגדרה (לונג) | פרוקסי בקוד (מוצע) |
|------|--------------|-------------------|
| **מחזור נמוך** | המניה בבסיס / ביקוש — לפני markup מאושר | `close ≤ EMA-50` **או** מגע demand zone **או** `distToEma50Pct ≤ 3%` **או** מחיר בחצי התחתון של טווח Donchian 20d |
| **מחזור גבוה** | המניה מורחבת / ליד היצע — לפני markdown מאושר | `distToEma50Pct > 5%` **או** מגע supply zone **או** `RSI > 60` **או** מחיר בחצי העליון של טווח Donchian 20d |

> **הערה:** מאקרו BULL/BEAR (regime) הוא מחזור **שוק**; מחזור נמוך/גבוה הוא מחזור **מניה** בתוך המבנה. שניהם נדרשים.

### שני חוקי זיו המרכזיים (לונג)

#### חוק 1: עליות במחזורים נמוכים = פריצת שווא

**תורה (זיו):** "עליות במחזורים נמוכים — פריצת שווא."

כשהמניה עדיין במחזור נמוך (בסיס, ביקוש, מתחת EMA) — **עלייה חדה או פריצה** היא כמעט תמיד **פריצת שווא**, לא כניסת לונג.

| תנאי | פעולה Elza |
|------|------------|
| `isLowCycle = true` **ו** עלייה חדה (`dailyChange > 1.5%` **או** `close ≥ donchian20High × 0.995`) | **BLOCK לונג** — `phase=WATCH`, איתות `FALSE_BREAKOUT_CYCLE` |
| מנטור / וידאו מזכיר "פריצת שווא" / "מלכודת שווא" | **REJECTED** — Hebrew Slang Guard |
| Gold Breakout זוהה אבל `isLowCycle` | BO5 + **CYC-L1** — לא `tryLiveEntry` |

**סימטריה לשורט (חוק 1 הפוך):** ירידה חדה **במחזור גבוה** (ליד היצע, מורחב) = **שבירת שווא / Bear Trap** → BLOCK שורט, `FALSE_BREAKDOWN_CYCLE`.

#### חוק 2: ירידות במחזורים נמוכים = קונים נגמרו → היפוך מגמה

**תורה (זיו):** "ירידות במחזורים נמוכים מספרים לנו שנגמרו הקונים ואנחנו בהיפוך מגמה — בעיקר בנקודת ביקוש."

כשהמניה במחזור נמוך ו**יורדת** — במיוחד **בנקודת ביקוש** — זה אומר שהקונים נגמרו והמגמה מתהפכת. **לא** לכניסת לונג; לשקול יציאה מפוזיציה קיימת.

| תנאי | פעולה Elza |
|------|------------|
| `isLowCycle = true` **ו** `dailyChange < -1%` **ו** מגע/שבירת demand zone | **BLOCK לונג חדש** — `REJECT` / `phase=WATCH` |
| פוזיציה לונג פתוחה באותו ticker | **EXIT review** — `calcZivHScore` + שבירת מבנה מתחת ל-zone |
| תמיכה/ביקוש נשברו עם נפח | מועמד **שורט** — Bear Breakdown / Bear Retest (אם `shortOk`) |

**סימטריה לשורט (חוק 2 הפוך):** עלייה **במחזור גבוה** ליד היצע = מוכרים נגמרו → היפוך לעלייה. **BLOCK שורט חדש**; לשקול cover לשורט פתוח.

### Gates מחזור (חובה לפני כל EXECUTE)

| Gate | כיוון | תנאי חסימה | איתות |
|------|-------|------------|--------|
| **CYC-L1** | לונג | מחזור נמוך + עלייה/פריצה | `FALSE_BREAKOUT_CYCLE` |
| **CYC-L2** | לונג | מחזור נמוך + ירידה בביקוש | `DEMAND_FAILURE_CYCLE` |
| **CYC-S1** | שורט | מחזור גבוה + ירידה/שבירה | `FALSE_BREAKDOWN_CYCLE` |
| **CYC-S2** | שורט | מחזור גבוה + עלייה בהיצע | `SUPPLY_FAILURE_CYCLE` |

**מימוש מוצע:** `cyclePhaseEngine.ts` (פונקציה `classifyCyclePhase(ticker, bars)`) → נקרא מ-`warEngine.ts` ו-`liveOrderExecutor.ts` לפני `tryLiveEntry`.

### קשר לסוגי כניסה קיימים

| סוג כניסה | שלב מחזור מתאים | חוק מחזור |
|-----------|-----------------|-----------|
| Demand Zone touch | מחזור נמוך — **ירידה** עם נפח יבש | CYC-L2 חוסם אם ירידה חדה שוברת zone |
| True Retest | אחרי markup — ריטסט **לרמת פריצה מתועדת** | CYC-L1 לא חל (מחזור אמצע, לא basement) |
| **Role Reversal** | אחרי **היפוך תפקיד** מפורש — ריטסט לרמה היסטורית | CYC-L1 לא חל אם היפוך אושר; CYC-L2 אם ריטסט נכשל |
| Gold Breakout | תחילת markup — **לא** מחזור נמוך | CYC-L1 חוסם breakout מ-basement |
| Bear Breakdown | מחזור גבוה → markdown | CYC-S1 חוסם breakdown מ-ceiling trap |
| Bear Retest | תמיכה שבורה כהתנגדות | CYC-S2 רלוונטי ליד supply |

### מה **לא** חלק מהמודל

| פריט | החלטה | קבצים להסרה/ניקוי (יישום) |
|------|--------|---------------------------|
| Sector Rotation (סריקה 5, marketScan) | **נחתך לגמרי** | `marketScan.ts`, `AssetCatalogue.tsx`, כותרת `runtimeIntelligence.ts` |
| momentumVelocity כמדד עצמאי | **ממוזג** ל-confluence | לא gate, לא שדה UI |
| positionSizePct (15% NLV) | **מוחלף** ב-`computeSlotSize` | `warEngine.ts`, `liveOrderExecutor.ts` |
| מגבלת מגזר (3 pos / 20% NLV) | **נשאר** | `warEngine.ts` — ניהול סיכון בלבד |

---

## מגמה שבועית — gate מובהק (זיו: "הגרף השבועי קודם")

### רקע — מה היה vs מה משתנה

| | היום בקוד | v1.9 (מאושר) |
|--|-----------|--------------|
| **לונג** | `weeklyAligned`: שיפוע `> -0.5%` (שטוח עובר) | **מובהק שורי** — שני תנאים |
| **שורט** | רק בתוך `shortEngine` scoring; **אין gate ב-war** | **מובהק דובי** — gate חובה ב-war |

### הגדרה טכנית (מניה — גרף שבועי)

דחיסת נרות יומיים לשבועיים (כל 5 ימים), חישוב EMA-50 שבועי:

```typescript
weeklySlopePct = (weeklyEma50Now - weeklyEma50Prev) / weeklyEma50Prev * 100
weeklyClose    = close של הנר השבועי האחרון
```

| Gate | כיוון | תנאי (כולם חובה) | איתות חסימה |
|------|-------|-------------------|-------------|
| **WK-L** | לונג | `weeklySlopePct > 0.2%` **ו** `weeklyClose > weeklyEma50Now` | `WEEKLY_NOT_BULLISH` |
| **WK-S** | שורט | `weeklySlopePct < -0.2%` **ו** `weeklyClose < weeklyEma50Now` | `WEEKLY_NOT_BEARISH` |

> **0.2%** = מגמה **מובהקת**, לא "לא שלילי". שבועי שטוח (`|slope| ≤ 0.2%`) → **BLOCK** לשני הכיוונים.

### מימוש

| קובץ | שינוי |
|------|--------|
| `runtimeIntelligence.ts` | החלף `weeklyAligned` ב-`weeklyBullish` / `weeklyBearish` (`classifyWeeklyTrend(bars)`) |
| `warEngine.ts` | לונג: `!weeklyBullish` → BLOCK; שורט: `!weeklyBearish` → BLOCK |
| `zivEngine.ts` | Tier 3+ דורש `weeklyBullish`; slope ≤ 0.2% → No Signal |
| `shortEngine.ts` | Bear tiers דורשים `weeklyBearish` (לא רק `slope < 0`) |
| Deep Analysis | חובה לציין מגמה שבועית לפני המלצה |

**הערה:** gate שבועי **בנוסף** ל-`regime` (SPY מאקרו) — שניהם חובה. מאקרו BULL + מניה שבועית חלשה = **אין לונג**.

### מטריצת סוג איתות × פעולה

| סוג איתות | `phase` | `tryLiveEntry` |
|-----------|---------|----------------|
| Demand Zone touch | EXECUTE | ✅ |
| True Retest (רמת מבנה) | EXECUTE | ✅ |
| Role Reversal | EXECUTE | ✅ |
| Bullish PA בביקוש (בתוך zone/retest) | EXECUTE | ✅ סלוט ×0.75 |
| Gold Breakout | EXECUTE | ✅ BULL + BO1–BO7; סלוט ×0.70 |
| Gold Retest (EMA בלבד, ללא רמה) | WATCH | ❌ |
| Bear Breakdown | EXECUTE | ✅ BEAR + BD1–BD7; סלוט ×0.70 |
| Bear Retest (תמיכה שבורה) | EXECUTE | ✅ ב-BEAR — עדיפות על Breakdown |
| Weak Bear / Near Watch | WATCH | ❌ |

---

## חוקי LONG — ארבעת סוגי הכניסה + Gates

### סוג 1: מגע באזור ביקוש (Demand Zone Touch)

**הגדרה זיו:** אזור שבו המחיר התכנס לפני עלייה חדה — swing low עם לפחות 2 מגעים, או אזור שחושב ב-`tradeManager.ts` (`calcZones`).

**תנאי כניסה (כולם חובה):**

| # | תנאי | סף | מימוש מוצע |
|---|------|-----|------------|
| D1 | מחיר בתוך אזור ביקוש | מחיר בין `zone.low` ל-`zone.high`, או ≤2% מעל `zone.high` | חדש: `demandZoneEngine.ts` או שימוש ב-`calcZones` |
| D2 | מגמה ראשית שורית | `close > EMA-200` **ו** `weeklyBullish` (WK-L) | `runtimeIntelligence.ts` |
| D3 | נפח יורד במשיכה | `volumeRatio < 0.85` (5d/20d) | `zivEngine.ts` — הפוך ל-gate חובה |
| D4 | לא בשיא מורחב | `distToEma50Pct ≤ 8%` **או** מחיר בתוך zone (לא "רודף") | חסום אם >8% מעל EMA-50 בלי מגע zone |
| D5 | ציון Ziv | `finalScore ≥ 8.0` (כולל mentor boost) | `warEngine.ts` `LONG_ENTRY_MIN_SCORE` |
| D6 | מנטור לא REJECTED | `signal_bias ≠ REJECTED` | `warEngine.ts` + `analyze.ts` |
| D7 | מבנה לא שבור | אין סגירה מתחת ל-`zone.low` ב-3 הנרות האחרונים | חדש |

**איתות:** `BULL_DEMAND_ZONE`  
**SL:** מתחת ל-`zone.low − 0.5×ATR14` (מבני, `slCalculator` swing mode)  
**סיגנל War היום:** ממופה ל-`GOLD_RETEST_WAR` — **יש לפצל** לסיגנל נפרד.

---

### סוג 2: ריטסט אמיתי (True Retest — לא EMA בלבד)

**הגדרה זיו:** חזרה לרמת פריצה קודמת (Donchian / breakout level מ-`breakoutScans`) בטווח ±2%, עם החזקה מעל הרמה.

**תנאי כניסה:**

| # | תנאי | סף | מימוש |
|---|------|-----|--------|
| R1 | קיימת פריצה מתועדת | רשומת `BREAKOUT` ב-`breakoutScans` ב-30 הימים האחרונים | `breakoutScanner.ts` `getRecentBreakoutLevel` |
| R2 | מגע ברמה | `|price − retestLevel| / retestLevel ≤ 2%` | `breakoutScanner.ts` (RETEST detection) |
| R3 | החזקה מעל רמה | `close ≥ retestLevel × 0.998` **ו** `close > EMA-50` | קיים חלקית — להקשיח |
| R4 | **לא** כניסה על EMA בלבד | אם R1 נכשל → **אין כניסה** גם אם `distToEma50Pct ≤ 3%` | **שינוי קריטי** מול `zivEngine` Tier 3 |
| R5 | נפח יורד במשיכה | `volumeRatio < 0.85` | חדש כ-gate |
| R6 | נר אישור (אחד מהבאים) | Hammer / Inside Bar / Bullish Engulfing **או** סגירה ירוקה מעל רמה | `zivEngine` `priceAction` |
| R7 | ציון | `tier = Gold Retest` **ו** `finalScore ≥ 8.0` | warEngine |
| R8 | Confluence | `confluenceScore ≥ 4.5` | `runtimeIntelligence.ts` |
| R8b | מגמה שבועית | `weeklyBullish` (WK-L) | `runtimeIntelligence.ts` |

**איתות:** `GOLD_TRUE_RETEST` (להפריד מ-`GOLD_RETEST_WAR`)  
**מצב:** EXECUTE אוטומטי.

**הערה ליישום:** היום `zivEngine` מעלה ל-Tier 3 "Gold Retest" על קרבה ל-EMA-50 בלבד — **יש לשנות** כך ש-Tier 3 יידרש `priorBreakoutLevel` או `demandZoneTouch`; קרבה ל-EMA ללא רמה → `Near Entry Watch` (`phase=WATCH`, ללא כניסה).

---

### סוג 3: היפוך תפקיד (Role Reversal) — **P0, ליבת תורה**

**סטטוס:** חשוב מאוד — **לא** לדחות. אחד מעמודי המסחר של זיו לצד ביקוש וריטסט.

**הגדרה זיו:** התנגדות שנפרצה כלפי מעלה **נבדקת מחדש כתמיכה**; או תמיכה שנשברה **נבדקת מחדש כהתנגדות** (שורט). הרמה **שינתה תפקיד** — לא רק "קרוב ל-EMA".

#### הבחנה מסוגי כניסה אחרים

| סוג | מתי | דוגמה |
|-----|-----|--------|
| **Demand Zone** | אזור ביקוש (swing low, 2+ מגעים) — **בלי** פריצה קודמת של רמה | מגע ב-$142–$145 |
| **True Retest** | חזרה ל**רמת פריצה מתועדת** (`breakoutScans`, Donchian) | פריצה ב-$100 → ריטסט ל-$100 |
| **Role Reversal** | רמה **היסטורית** שהוכחה כהתנגדות/תמיכה, **הפכה תפקיד**, ונבדקת שוב | $95 הייתה תקרה חודשים → פריצה → ריטסט ל-$95 כרצפה |
| **Gold Breakout** | כניסה **על** הפריצה, לא על הריטסט | נכנסים בנר הפריצה |

> **עדיפות כניסה (לונג):** True Retest > **Role Reversal** > Demand Zone > Gold Breakout (כשמתאימים לאותו ticker).

**תנאי כניסה (כולם חובה):**

| # | תנאי | סף | מימוש |
|---|------|-----|--------|
| V1 | זיהוי רמת היפוך | מחיר היה מתחת לרמה ≥5 נרות, פרץ מעליה, נסגר מעליה | `roleReversalEngine.ts` |
| V2 | ריטסט ראשון/שני לרמה | מגע ±2% לרמה + סגירה מעל (לונג) | `roleReversalEngine.ts` |
| V3 | נפח יורד בריטסט | `volumeRatio < 0.85` | `zivEngine.ts` |
| V4 | מגמה שבועית מובהקת | `weeklyBullish` (WK-L) | `runtimeIntelligence.ts` |
| V5 | ציון | `finalScore ≥ 8.0` | `warEngine.ts` |
| V6 | מנטור | אין `REJECTED` / "פריצת שווא" / "מלכודת שווא" | Hebrew Slang Guard |
| V7 | מחזור | **לא** CYC-L1 (היפוך כבר אושר); **כן** CYC-L2 אם ירידה שוברת מתחת לרמה | `cyclePhaseEngine.ts` |

**איתות:** `BULL_ROLE_REVERSAL`  
**`phase`:** EXECUTE  
**גודל:** סלוט מלא (×1.0) — מבנה איכותי כמו Retest  
**SL:** מתחת לרמת ההיפוך − `0.5×ATR14` (מבני, `slCalculator`).

**מימוש:** `roleReversalEngine.ts` — `detectBullRoleReversal(bars) → { level, confirmed, retestTouch }`; נקרא מ-`warEngine.ts` לפני `tryLiveEntry`.

---

### סוג 4: אישור מחיר בביקוש (Bullish PA at Support)

**הגדרה זיו:** Hammer / Inside Bar / Engulfing **בתוך** אזור ביקוש או בריטסט אמיתי — לא באוויר.

**תנאי כניסה:**

| # | תנאי | סף |
|---|------|-----|
| P1 | PA מזוהה | `priceAction ∈ {Hammer, Inside Bar, Bullish Engulfing}` | `zivEngine.ts` |
| P2 | הקשר מבני | PA מתרחש **בתוך** D1 או R2 (לא לבד) |
| P3 | מגמה | `close > EMA-200` |
| P4 | MACD | `histogram ≥ 0` (מונע "סכין נופלת") | `paperLabEngine` MACD Gate — להעתיק ל-Live |
| P5 | הקשר מבני | PA בתוך D1 או R2 — גודל 75% | `warEngine.ts` |

**איתות:** `BULL_PA_CONFIRM`  
**הקטנת גודל:** סלוט ×0.75.

---

### סוג 5: Gold Breakout — EXECUTE מותנה (מומנטום בזמן אמת)

**רציונל:** בשוק שורי (`BULL`), פריצת התנגדות עם נפח יכולה לתפוס את רוב המהלך. Elza סוחרת בזמן אמת — כניסה על הפריצה מותרת, עם gates מחמירים וגודל מוקטן (מראה ל-Bear Breakdown).

**תנאי זיהוי בסיס:**

- `close ≥ donchian20High × 0.995`
- `close > EMA-50` ו-`close > EMA-200`
- `weeklyBullish` (WK-L) — שיפוע שבועי >0.2% + מחיר מעל EMA-50 שבועי
- `volumeRatio ≥ 1.2` (סורק) / `≥ 2.0` (override ב-`zivEngine`)

**Gates נוספים ל-Breakout בלבד (כולם חובה):**

| # | תנאי | סף | הערה |
|---|------|-----|------|
| BO1 | משטר שוק | `regime = BULL` (לא NEUTRAL) | מומנטום רק בשוק שורי מובהק |
| BO2 | נפח מוגבר | `volumeRatio ≥ 1.5` | מעל סף הזיהוי 1.2 |
| BO3 | לא רודף | `close ≤ donchian20High × 1.02` | כניסה על הפריצה, לא אחרי +5% |
| BO4 | ציון | `finalScore ≥ 8.0` (breakout ≥9 מועדף) | סף גבוה |
| BO5 | אין bull trap / מחזור | לא ירד >2% מהשיא ב-24h **ו** `isLowCycle = false` | CYC-L1: breakout מ-basement = פריצת שווא |
| BO6 | עדיפות retest | אין `GOLD_TRUE_RETEST` פעיל לאותו ticker | Retest > Breakout |
| BO7 | מנטור | `signal_bias ≠ REJECTED` | Hebrew Slang Guard |

**פעולה:**

1. רשום ב-`breakoutScans` כ-`BREAKOUT`.
2. `phase=EXECUTE` → `tryLiveEntry` עם איתות `GOLD_BREAKOUT_ENTRY`.
3. גודל: סלוט לונג ×0.70.

**SL:** מתחת לרמת הפריצה − `0.5×ATR14` (מבני).

**שינוי מול היום:** `warEngine.ts` נכנס על `score ≥ 9` בלי BO gates — **להחליף** ב-BO1–BO7 + `computeSlotSize`.

---

### Gates גלובליים ללונג (War Engine + Live Executor)

רשימה מאוחדת לכל סוגי הלונג — חל על `runWarEngineCycle` ו-`tryLiveEntry`:

| Gate | מיקום היום | כלל | פעולה אם נכשל |
|------|------------|------|----------------|
| משטר שוק | `runtimeIntelligence` | `longOk` (לא BEAR) | דלג על סריקת לונג |
| ציון מינימום | `warEngine` | `finalScore ≥ 8.0` | SKIP |
| Confluence | `warEngine` | `≥ 4.5` | BLOCKED |
| נזילות | `warEngine` | `liquidityScore ≥ 2.0` | BLOCKED |
| יישור שבועי לונג | `warEngine` | `weeklyBullish` (WK-L) | BLOCKED |
| יישור שבועי שורט | `warEngine` | `weeklyBearish` (WK-S) | BLOCKED |
| מתאם | `warEngine` | correlation ≤ 0.80 | BLOCKED |
| מגזר | `warEngine` | ≤3 פוזיציות / 20% הון למגזר | BLOCKED |
| כפילות | `liveOrderExecutor` | אין פוזיציה פתוחה באותו ticker | BLOCKED |
| מחיר חי | `warEngine` / `liveOrderExecutor` | IBKR live; divergence ≤20–50% | SKIP |
| Penny | `warEngine` | מחיר ≥ $2 | SKIP + ארכוב |
| Hebrew Slang Guard | `warEngine` | `signal_bias ≠ REJECTED` | BLOCKED |
| סוג כניסה | **חדש** | Breakout רק עם BO1–BO7; retest/zone ללא BO | BLOCKED |
| True Retest | **חדש** | R1+R2 או D1 | BLOCKED |
| נפח משיכה | **חדש** | `volumeRatio < 0.85` לכניסות ריטסט/zone | BLOCKED |
| Gap / FOMO | `paperLabEngine` | deviation ≤1.5% מ-entry zone | BLOCKED — להרחיב ל-Live |
| MACD | `paperLabEngine` | histogram ≥ 0 לריטסט | BLOCKED — להרחיב ל-Live |
| IPO_INCUBATOR | `liveOrderExecutor` | `blocksElzaEntry` | BLOCKED |
| Daily loss breaker | `warEngine` | הפסד יומי < limit | עצור מנוע |
| Max daily orders | `warEngine` | entries < cap | PAUSE entries |
| מחיר שוק | `liveOrderExecutor` | 16:30–23:00 IST | BLOCKED |

---

## חוקי SHORT — מראה זיו לשוק דובי

עקרון: כל חוק לונג הופך לשורט כשהמבנה דובי. שורטים **רק** כש-`regime.shortOk` (לא BULL).

### סוגי כניסה שורט (מראה ל-4 הלונג)

| לונג (זיו) | שורט (מראה) | Tier ב-`shortEngine` |
|------------|-------------|----------------------|
| Demand Zone | **Supply Zone** — מגע בהיצע + דחייה | חדש: `Bear Supply` |
| True Retest לתמיכה | **Retest של תמיכה שבורה כהתנגדות** | `Bear Retest` (להרחיב) |
| Role Reversal (תמיכה) | **התנגדות שבורה כהיצע** | חדש: `Bear Role Reversal` |
| Bearish PA בהיצע | **Shooting Star / Bearish Engulfing** באזור היצע | EXECUTE (75% גודל) |
| Bear Breakdown (מומנטום) | **שבירת תמיכה + נפח** | `Bear Breakdown` — EXECUTE מותנה (מראה ל-Gold Breakout) |

### סוג 1: אזור היצע (Supply Zone Touch)

| # | תנאי | סף |
|---|------|-----|
| S1 | מחיר בתוך supply zone (swing high consolidation) | ±2% |
| S2 | מגמה דובית | `close < EMA-200` **ו** `weeklyBearish` (WK-S) |
| S3 | נפח יורד בעלייה למגע | `volumeRatio < 0.85` על המשיכה כלפי ה-zone |
| S4 | דחייה | High נגע ב-zone, Close מתחת ל-mid-zone |
| S5 | ציון | `finalScore ≥ 7.5` (`SHORT_ENTRY_MIN_SCORE`) |

**איתות:** `BEAR_SUPPLY_ZONE`

---

### סוג 2: ריטסט לתמיכה שבורה (Broken Support as Resistance)

**הגדרה זיו:** תמיכה קריטית נפרצה; המחיר עולה לבדוק אותה מלמטה ונדחה.

| # | תנאי | סף | מימוש |
|---|------|-----|--------|
| SR1 | תמיכה שבורה מתועדת | שבירת Donchian low / swing low ב-30 יום | חדש: `breakdownScans` (מראה ל-breakoutScans) |
| SR2 | ריטסט | High ≥ `brokenLevel × 0.98`, Close < `brokenLevel` | להרחיב `detectBearRetest` |
| SR3 | אישור ב-3 נרות | כמו היום | `shortEngine.ts` |
| SR4 | מתחת EMA-200 | חובה | קיים |
| SR5 | ציון | `Bear Retest`, score ≥ 7.5 | קיים |

**שינוי מול היום:** `detectBearRetest` בודק רק EMA-50 — **יש להוסיף** בדיקת `brokenSupportLevel` מ-DB. EMA retest ללא תמיכה שבורה → `phase=WATCH`.

**איתות:** `BEAR_TRUE_RETEST` (להפריד מ-`BEAR_WAR_RETEST`)

---

### סוג 3: היפוך תפקיד דובי (Bear Role Reversal) — **P0, ליבת תורה**

**הגדרה:** תמיכה שנשברה כלפי מטה → נבדקת מלמעלה כ**התנגדות חדשה**; ריטסט נכשל = שורט.

| # | תנאי | סף | מימוש |
|---|------|-----|--------|
| BR1 | תמיכה שבורה | מחיר היה מעל רמה ≥5 נרות, נפל מתחתיה, נסגר מתחת | `roleReversalEngine.ts` |
| BR2 | ריטסט נכשל | High מגיע לרמה ±2%, Close מתחת לרמה | `roleReversalEngine.ts` |
| BR3 | מגמה שבועית מובהקת | `weeklyBearish` (WK-S) | `runtimeIntelligence.ts` |
| BR4 | ציון | `finalScore ≥ 7.5` | `warEngine.ts` |
| BR5 | מחזור | **לא** CYC-S1 אם שבירה אושרה; **כן** CYC-S2 אם עלייה מעל רמה (כשל שורט) | `cyclePhaseEngine.ts` |
| BR6 | shortGuard + מנטור | earnings, HTB; `signal_bias` לא חוסם שורט | קיים |

**איתות:** `BEAR_ROLE_REVERSAL`  
**`phase`:** EXECUTE (ב-BEAR; עדיפות על Breakdown כששניהם פעילים)  
**גודל:** סלוט מלא (×1.0)  
**SL:** מעל רמת ההיפוך + `0.5×ATR14`.

---

### סוג 4: Bear Breakdown — EXECUTE מותנה (מומנטום בזמן אמת)

**רציונל:** בשוק דובי (`BEAR`), שבירת תמיכה עם נפח יכולה לתפוס את רוב המהלך. Elza סוחרת בזמן אמת — breakdown מותר, מראה ל-Gold Breakout בלונג.

**תנאי זיהוי בסיס (מ-`shortEngine`):**

- `close < EMA-200`
- `close ≤ donchian20Low × 1.005`
- `weeklyBearish` (WK-S) — שיפוע שבועי <-0.2% + מחיר מתחת EMA-50 שבועי
- `volumeRatio ≥ 1.3`

**Gates נוספים ל-Breakdown בלבד (כולם חובה):**

| # | תנאי | סף | הערה |
|---|------|-----|------|
| BD1 | משטר שוק | `regime = BEAR` (לא NEUTRAL) | מומנטום רק בשוק דובי מובהק |
| BD2 | נפח מוגבר | `volumeRatio ≥ 1.5` | מעל הסף הרגיל 1.3 |
| BD3 | לא מורחב | `close ≤ donchian20Low × 1.02` | לא לרדוף אחרי הנר |
| BD4 | ציון | `finalScore ≥ 8.0` (לא 7.5) | סף גבוה יותר מ-retest |
| BD5 | אין bear trap | לא עלה >2% מהשפל ב-24h | מניעת bounce חד |
| BD6 | עדיפות retest | אין `BEAR_TRUE_RETEST` פעיל לאותו ticker | Retest > Breakdown |
| BD7 | shortGuard | earnings, dividend, HTB — כרגיל | קיים |

**פעולה:**

1. רשום ב-`breakdownScans` כ-`BREAKDOWN`.
2. `phase=EXECUTE` → `tryLiveEntry` עם איתות `BEAR_BREAKDOWN_ENTRY`.
3. גודל: סלוט שורט ×0.70.

**SL:** מעל `brokenLevel + 0.5×ATR14` (מבני).

**שינוי מול היום:** `warEngine.ts` ~979 נכנס על `score ≥ 9` בלי gates — **להחליף** ב-BD1–BD7 + `computeSlotSize`.

---

### Gates גלובליים לשורט

| Gate | מיקום | כלל |
|------|--------|------|
| משטר | `runtimeIntelligence` | `shortOk` (לא BULL) |
| ציון | `warEngine` | `≥ 7.5` |
| מחיר חי | `warEngine` | IBKR snapshot, penny, divergence |
| מגזר | `warEngine` | cap שורט למגזר |
| Dividend | `shortGuard.ts` | לא 2 ימים לפני Ex-Div |
| Earnings | `shortGuard.ts` | לא ±3 ימים מ-earnings |
| HTB | `htbBlocklist.ts` | cooldown אם no-fill |
| Squeeze exit | `shortGuard.ts` | יציאה אם +3% נגד |
| סוג כניסה | **חדש** | Breakdown רק עם BD1–BD7; Retest/Supply ללא BD |
| מגמה שבועית שורט | `warEngine` | `weeklyBearish` (WK-S) | BLOCKED |
| עדיפות retest | **חדש** | אם גם Retest וגם Breakdown — כניסה כ-Retest בלבד |

**גודל פוזיציה שורט:** סלוט שורט = `shortPool / slotsRemaining`; breakdown ×0.70.

---

## מכונת מצבים SIGNAL vs EXECUTE

### מטרה

להפריד בין **זיהוי איתות** (סריקה, ציון, רישום WATCH) לבין **ביצוע הזמנה** (`tryLiveEntry` → IBKR). זהו מנגנון פנימי — לא זרימת עבודה ידנית.

### מצבים

```
┌─────────────┐     scan      ┌─────────────┐
│   IDLE      │──────────────►│  SCANNING   │
└─────────────┘               └──────┬──────┘
                                     │
                     ┌───────────────┼───────────────┐
                     ▼               ▼               ▼
              ┌──────────┐   ┌──────────────┐  ┌──────────┐
              │ SIGNAL   │   │ SIGNAL_WATCH │  │  SKIP    │
              │ _QUALIFIED│   │ (Breakout)   │  │          │
              └────┬─────┘   └──────┬───────┘  └──────────┘
                   │                │
                   │                │ WATCH — DB + לוג
                   ▼                ▼
              ┌─────────────┐  ┌─────────────┐
              │  EXECUTE    │  │   WATCH     │
              │  PENDING    │  │  (מחזור הבא)│
              └──────┬──────┘  └─────────────┘
                     │
            tryLiveEntry OK?
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
   ┌──────────┐           ┌──────────┐
   │ EXECUTED │           │ REJECTED │
   └──────────┘           └──────────┘
```

### שדות מומלצים ב-`WarEngineScan` / DB

```typescript
interface ElzaSignalRecord {
  ticker: string;
  direction: "long" | "short";
  entryType: "DEMAND_ZONE" | "TRUE_RETEST" | "ROLE_REVERSAL" | "PA_CONFIRM"
           | "BREAKOUT_WATCH" | "BREAKDOWN_WATCH";
  phase: "WATCH" | "EXECUTE" | "REJECTED";
  zivScore: number;
  structuralLevel: number;      // רמת ריטסט / zone
  volumeRatio: number;
  blockReason?: string;
}
```

### כללי מעבר

| מ- | ל- | טריגר |
|----|-----|--------|
| SCANNING | SIGNAL_QUALIFIED | עבר gates מבניים + ציון → מוכן ל-EXECUTE |
| SCANNING | SIGNAL_WATCH | Near Watch / EMA בלבד → `phase=WATCH` |
| SCANNING | SIGNAL_QUALIFIED | Gold Breakout עם BO1–BO7 → `phase=EXECUTE` |
| SCANNING | SIGNAL_QUALIFIED | Bear Breakdown עם BD1–BD7 → `phase=EXECUTE` |
| SIGNAL_QUALIFIED | EXECUTE_PENDING | תמיד (אם `isEnabled=1`) |
| SIGNAL_WATCH | WATCH (DB) | שמירה; מחזור הבא בודק ריטסט |
| EXECUTE_PENDING | EXECUTED | `tryLiveEntry.entered=true` |
| EXECUTE_PENDING | REJECTED | כל gate ב-liveOrderExecutor |
| SIGNAL_QUALIFIED | REJECTED | תמיכה נשברה לפני ביצוע |

### תדירות

- סריקה: כל 20 דקות (`WAR_MIN_GAP_MS`) — ללא שינוי.
- `breakoutScanner`: כל 30 דקות — מזין רמות לריטסט.
- ביצוע: באותו מחזור War, **אחרי** שלב SIGNAL, רק למועמדים ב-`phase=EXECUTE`.

---

## אינטגרציה breakoutScans + Demand Zones

### זרימת נתונים

```
breakoutScanner (30m)
       │
       ▼
breakoutScans table ──► retestLevel, donchian20High, signalType
       │
       ├─► War Engine: True Retest gate (R1, R2)
       ├─► Ziv Engine: tier override (לא Gold Retest בלי רשומה)
       └─► Telegram / war_upcoming_signals (WATCH)

tradeManager.calcZones / portfolio analyze
       │
       ▼
demandZones[] per ticker ──► cache ב-userAssets או טבלה חדשה structuralLevels
       │
       └─► War Engine: Demand Zone gate (D1)
```

### כללי סנכרון

1. **Breakout מתועד** — רישום ב-`breakoutScans`; אם BO1–BO7 → `EXECUTE`, אחרת מעקב לריטסט.
2. **ריטסט מזוהה בסורק** — עדכן `breakoutScans` ל-`RETEST`; War Engine רשאי לקדם ל-`SIGNAL_QUALIFIED`.
3. **Demand zone** — חשב פעם ביום (או בעת analyze) ושמור ב-DB; בסריקה 20 דקות רק בדוק מרחק מחיר.
4. **עדיפות** — אם גם zone וגם retest מתאימים, העדף **ריטסט לרמת פריצה** (חזק יותר במתודולוגיית זיו).
5. **dedup** — שמור `DEDUP_HOURS=24` מ-`breakoutScanner.ts` להתראות; כניסה לא מוגבלת ב-dedup אך כן ב-cooldown ticker.

### שינוי ב-breakoutScanner

- הוסף `action: "WATCH" | "ENTRY_CANDIDATE"` בשדה חדש — לא לשנות `signalType`.
- פריצה → `action=ENTRY_CANDIDATE` אם BO gates; אחרת מעקב לריטסט.
- ריטסט + PA → `action=ENTRY_CANDIDATE`.

---

## ניהול סיכון והקצאת הון

### הבעיה היום (3 מודלים סותרים)

| מקור | נוסחה היום | בעיה |
|------|------------|------|
| `warEngine.ts` | `totalNlv × positionSizePct` (למשל 15%!) | עסקה אחת ענקית — לא מתאים ל-12 פוזיציות |
| `computeLiveCapital` | `allocatedCapital / maxPositions` | legacy — לא 12+6 נפרד |

**תוצאה:** גודל עסקה לא צפוי, תקרת פוזיציות ב-`liveOrderExecutor` בודקת `maxPositions` כולל ולא לונג/שורט בנפרד.

### מגבלות תיק (מאושר)

| כיוון | מקסימום פוזיציות | שדה config |
|--------|-------------------|------------|
| לונג | **12** | `maxLongPositions` |
| שורט | **6** | `maxShortPositions` |
| סה"כ | 18 | `maxPositions` = 12+6 (legacy sync) |

`warEngine` כבר אוכף 12/6 במחזור. **`liveOrderExecutor` חייב לעדכן** — ספירה לפי `direction`, לא `openPos.length` כולל.

---

### מודל מאושר: סלוט קבוע (אפשרות א)

שתי שרוולים (לונג / שורט). **כל עסקה חדשה מקבלת חלק שווה ממה שנשאר בשרוול** — בלי 1% risk, בלי `capitalAllocator`.

#### שלב 1 — תקציב ברוטו

```
cashBudget      = NLV × (allocatedPct / 100)
deployableGross = cashBudget × multiplier        // intraday 3.9 / overnight 1.9
                  (מוגבל ב-Iron Rule 1)
```

#### שלב 2 — שרוולים (12 : 6)

```
longPool  = deployableGross × (12 / 18)   // 66.67%
shortPool = deployableGross × (6 / 18)    // 33.33%
```

דוגמה: NLV=$120k, allocatedPct=40%, ×3.9 → deployableGross≈$187k  
→ longPool≈$125k · shortPool≈$62k

#### שלב 3 — גודל לעסקה (הנוסחה המרכזית)

```
slotsRemaining = maxLong − openLongs     // או maxShort − openShorts
poolRemaining  = longPool − deployedLongUsd   // או shortPool

baseUsd = poolRemaining / max(slotsRemaining, 1)

finalUsd = min(
  baseUsd × sizeMult,
  maxPositionUsd
)
finalUsd = max(finalUsd, minPositionUsd)
```

| סוג כניסה | `sizeMult` |
|-----------|------------|
| לונג — retest / zone / reversal | 1.0 |
| לונג — PA confirm | 0.75 |
| לונג — Gold Breakout | 0.70 |
| שורט — retest / supply / reversal | 1.0 |
| שורט — Bear Breakdown | 0.70 |

**דוגמה:** 8 לונג פתוחים, longPool=$125k, deployed=$80k → poolRemaining=$45k, slotsRemaining=4 → **baseUsd=$11,250** לעסקה הבאה.

**עקרון:** פשוט, צפוי, מתאים ל-12+6. SL/TP עדיין מ-`calcEntrySlTp` — רק **גודל הפוזיציה** לא תלוי במרחק ל-SL.

#### שלב 4 — בדיקות לפני `tryLiveEntry`

| # | בדיקה |
|---|--------|
| C1 | `openLongs < 12` / `openShorts < 6` |
| C2 | `deployedLong + finalUsd ≤ longPool` |
| C3 | `deployedGross + finalUsd ≤ deployableGross` |
| C4 | `finalUsd ≥ minPositionUsd` |

---

### מימוש בקוד (יעד)

| קובץ | שינוי |
|------|--------|
| `liveOrderExecutor.ts` | `computeSlotSize({ direction, entryType, config, openCounts, deployed })` — פונקציה פנימית, לא מודול נפרד |
| `warEngine.ts` | **הסר** `totalNlv × positionSizePct`; קרא ל-`computeSlotSize` |
| `liveOrderExecutor.ts` | caps 12/6 לפי `direction` |

**לא בשימוש ב-Live:** כלל 1% risk מ-`portfolio.ts` (נשאר לניתוח ידני / UI בלבד).

---

### SL / TP (ללא שינוי)

| כיוון | מיקום SL | מקור |
|--------|----------|------|
| לונג | `min(zone.low, swingLow20) − 0.5×ATR14` | `slCalculator` swing |
| לונג (intraday) | `max(8% below, EMA50×0.99, 2×ATR)` | `calcIntradaySlTp` |
| שורט | `max(zone.high, swingHigh20) + 0.5×ATR14` | `calcSwingSlTp` short |
| שורט (intraday) | `min(8% above, entry+2×ATR)` | קיים |

**חוק זיו:** SL תמיד **מתחת לרמת הביקוש** (לונג) / **מעל רמת ההיצע** (שורט).

**TP (Approach B — מאושר):** מינימום **2R** לפני סגירה מלאה; trail מבני מתחת שפלים שבועיים; יציאה חלקית **50% ב-2R** (`SCALE_OUT_TP1_R = 2.0`). אין TP אחוזי קרוב.

### פילטר Post-Rally (אין FOMO)

**הגדרה:** לא נכנסים אחרי רALLY חד ללא משיכה.

| תנאי חסימה | סף | פעולה |
|------------|-----|--------|
| מרחק מ-EMA-50 | `distToEma50Pct > 8%` **ולא** מגע zone/retest | `phase=WATCH` |
| עלייה 5 ימים | `(close − close₋₅) / close₋₅ > 12%` **ולא** volume dry-up | BLOCK entry |
| RSI קיצון ללא breakout hold | `RSI > 80` ו-`entryType ≠ TRUE_RETEST` | BLOCK (FOMO guard) — **לא** לחסום RSI>70 במגמת עלייה (עקרון 15) |
| Gap מעל entry zone | `> 1.5%` | Gap Guard — BLOCK |

**נפח יורד במשיכה** (מאשר כניסה):

- `volumeRatio < 0.85` AND מחיר מתקרב לרמה מבנית → **מגביר** עדיפות, לא חוסם לבדו.

### Cash Buffer (חיץ מזומן)

**מקור:** `computeLiveCapital` — `cashBudget` vs `allocatedCapital` (מינוף).

| כלל | ערך | מיקום |
|------|------|--------|
| מינוף אינטראדיי | ×3.9 (ברירת מחדל) | `liveEngineConfig.intradayMultiplier` |
| מינוף לילה | ×1.9 | `overnightMultiplier` |
| מעבר לילה | 22:30 IST — Iron Rule 2 | `warEngine.ts` |
| רזרבה לדה-לוורג' | 4 slots ב-40 דקות לפני cutoff | `DELEVERAGE_RESERVE_SLOTS` |
| תקרת deployed | `grossPositionValue ≤ allocatedCapital` | Iron Rule 1 |
| מינימום לעסקה | $5,000 | `tryLiveEntry` |
| מקסימום יומי | `maxDailyOrders` | config |

**הנחיה:** שמור לפחות **10% מ-`cashBudget`** לא צמוד בכל עת (חדש) — אם `remainingCash < 10%`, PAUSE entries.

### יציאה — שבירת תמיכה

| אירוע | פעולה לונג | פעולה שורט |
|--------|------------|------------|
| סגירה מתחת ל-zone/SL מבני | EXIT (IBKR STP) | — |
| סגירה מעל supply/SL | — | EXIT |
| `signal_bias` → REJECTED | אל תוסיף; שקול reduce | שקול cover |
| ZivH < 4 (FC threshold) | Force-Close review | סימטרי ב-`zivEngine` calcZivHScore |

---

## מנטור / וידאו Integration

### מקורות

| מקור | שדות | שימוש במנוע |
|------|------|-------------|
| `analyze.ts` SYSTEM_PROMPT | `signal_bias`, `mentor_confidence`, `entry_zone` | gates + boost |
| `mentorPatterns` | דפוסים שנלמדו | `mentorScoreBoost.ts` +0 עד +2 |
| `userAssets` | `recommendedBuyPrice`, `recommendedStopLoss`, `mentorSources` | Gap Guard, SL |
| Hebrew Slang Guard | REJECTED / SHORT / WATCH | חסימת לונג |

### מיפוי signal_bias → מנוע

| signal_bias | השפעה על לונג | השפעה על שורט |
|-------------|----------------|----------------|
| LONG | מותר אם gates עברו | N/A |
| SHORT | BLOCK לונג | מותר אם gates שורט |
| WATCH | `phase=WATCH` — מעקב, לא כניסה | `phase=WATCH` |
| REJECTED | BLOCK + `mentor_confidence=1` | לא כניסה לונג |

### מילון עברית קריטי (מ-SYSTEM_PROMPT)

חייבים לחסום לונג אוטומטי:

- **פריצת שווא** (= CYC-L1: עלייה במחזור נמוך), מלכודת שווא, איסוף מתוח, הפצה, שיא שווא
- אזור הפצה, ממש על הסטופ, לא נוגע בזה
- **תמיכה שבורה** (= CYC-L2 במחזור נמוך בביקוש → REJECT לונג / שורט)

### mentor_confidence → עדיפות ביצוע (לא אישור ידני)

| confidence | השפעה |
|------------|--------|
| 5 | עדיפות גבוהה בדירוג מועמדים באותו מחזור |
| 4 | רגיל — gates מבניים קובעים |
| 3 | רגיל |
| 2 | דורש ציון Ziv גבוה יותר (+0.5) |
| 1 | IGNORE (REJECTED) |

**לא:** כפתור אישור ב-Telegram. המנוע מבצע או לא — לפי gates.

### Dual Signal (Ziv + Micha)

- `calcMentorBoost` — `isDualSignal` כשגם דפוס וגם ticker תואמים.
- בונוס מקסימלי +2.0 — **לא** מבטל gates מבניים.

### וידאו → catalog

1. `analyzeVideoDirectly` / `analyzeTranscript` → JSON rows.
2. עדכון `userAssets`: `signalBias`, `score`, `recommendedBuyPrice`.
3. War Engine קורא `signalBias` בכל סריקה (קיים).

---

## מה נשאר כמו היום vs מה משתנה

| נושא | נשאר כמו היום | משתנה (Approach B) |
|------|----------------|---------------------|
| תדירות מחזור War (20 דק) | ✅ | — |
| ציון Ziv Engine (tiers, sub-score) | ✅ בסיס | Tier 3 דורש רמה מבנית |
| משטר שוק BULL/BEAR | ✅ | — |
| Gates: confluence, liquidity, correlation, sector cap | ✅ | — |
| Gates מחזור CYC-L1/L2/S1/S2 | — | ✅ חדש — ליבת זיו |
| Gates שבועיים WK-L / WK-S | `weeklyAligned` רופף (לונג בלבד) | ✅ מגמה מובהקת לונג+שורט |
| Sector Rotation (סריקה / בונוס) | הוזכר ב-runtimeIntelligence | ❌ נחתך לגמרי |
| Iron Rules 1–3 (budget, overnight, max pos) | ✅ | + long/short pools; 12/6 ב-executor |
| Daily loss breaker | ✅ | — |
| `breakoutScanner` רישום DB | ✅ | פריצה → EXECUTE אם BO gates |
| `tryLiveEntry` + IBKR bracket | ✅ | qty מ-`computeSlotSize` |
| Short engine + shortGuard | ✅ | Breakdown → EXECUTE מותנה; retest מורחב |
| Hebrew Slang Guard | ✅ | — |
| mentorScoreBoost | ✅ | מיפוי סיגנלים חדשים |
| **כניסה על Gold Breakout** | score≥9 בלי gates | ✅ EXECUTE ב-BULL + BO1–BO7, סלוט ×0.70 |
| **כניסה על Bear Breakdown** | score≥9 בלי gates | EXECUTE + BD1–BD7; סלוט ×0.70 |
| **Gold Retest = קרבה ל-EMA** | Tier 3 היום | ❌ דורש ריטסט אמיתי |
| **Role Reversal** | לא מיושם | ✅ P0-9 — `roleReversalEngine.ts` לונג+שורט |
| **Bear Retest = EMA-50 בלבד** | קיים | ❌ דורש תמיכה שבורה |
| **phase WATCH vs EXECUTE** | לא מפורש | ✅ מכונת מצבים פנימית |
| **ALERT_ONLY / SEMI modes** | לא קיים | ❌ לא נדרש — אוטומציה מלאה |
| **Demand zone gate** | רק ב-Trading Lab | ✅ War Engine |
| **MACD / Gap Guard ב-Live** | רק Paper | ✅ liveOrderExecutor |
| **נפח יורד כחובה** | בונוס בלבד | ✅ gate לריטסט/zone |
| **Post-rally filter** | חלקי (8% EMA) | ✅ פורמלי |
| סיגנלים `GOLD_BREAKOUT_WAR` | קיים | → `GOLD_BREAKOUT_ENTRY` + BO gates |
| **גודל עסקה** | `NLV×positionSizePct` ב-warEngine | סלוט קבוע (`poolRemaining / slotsRemaining`) |
| גודל שורט | 50% אחיד / % מ-NLV | אותו מודל סלוט; breakdown ×0.70 |

---

## עדיפויות יישום P0 / P1 / P2

### P0 — חובה לפני מסחר אוטומטי aligned (שבוע 1–2)

| # | משימה | קבצים | תוצר |
|---|--------|--------|------|
| P0-1 | Gold Breakout + Bear Breakdown → EXECUTE מותנה | `warEngine.ts` | BO1–BO7 / BD1–BD7 |
| P0-1b | עדיפות Retest > Breakout/Breakdown | `warEngine.ts` | BO6 / BD6 |
| P0-2 | מכונת מצבים `phase` WATCH/EXECUTE | `warEngine.ts`, DB | ללא `engineMode` — אוטומטי כברירת מחדל |
| P0-3 | True Retest gate — דורש `breakoutScans.RETEST` או רמה | `warEngine.ts`, `zivEngine.ts` | לא כניסה על EMA בלבד |
| P0-4 | חסום לונג כש-`signal_bias=REJECTED` | כבר קיים — וודא ב-live | בדיקת integration |
| P0-5 | `computeSlotSize` — סלוט קבוע 12/6 | `liveOrderExecutor.ts`, `warEngine.ts` | בלי מודול נפרד |
| P0-5b | long/short caps ב-`tryLiveEntry` | `liveOrderExecutor.ts` | לא `maxPositions` כולל |
| P0-6 | העתק Gap Guard + MACD gate ל-`tryLiveEntry` | `liveOrderExecutor.ts` | מניעת FOMO |
| P0-7 | הפרדת סיגנלים: `_WATCH` vs `_ENTRY` | `warEngine.ts`, `livePositions.signal` | traceability |
| P0-8 | Gates מחזור CYC-L1/L2/S1/S2 | `cyclePhaseEngine.ts`, `warEngine.ts`, `liveOrderExecutor.ts` | פריצת שווא / כשל ביקוש |
| P0-9 | **Role Reversal** — זיהוי + כניסה (לונג V1–V7 + שורט BR1–BR6) | `roleReversalEngine.ts`, `warEngine.ts` | `BULL_ROLE_REVERSAL` / `BEAR_ROLE_REVERSAL` |
| P0-10 | **מגמה שבועית מובהקת** WK-L / WK-S | `runtimeIntelligence.ts`, `warEngine.ts`, `zivEngine.ts`, `shortEngine.ts` | החלפת `weeklyAligned` הרופף |

### P1 — שלמות מתודולוגיה (שבוע 3–4)

| # | משימה | קבצים |
|---|--------|--------|
| P1-1 | מודול demand/supply zones לסריקה | `demandZoneEngine.ts` או שימוש ב-`tradeManager.calcZones` |
| P1-2 | הרחבת Bear Retest לתמיכה שבורה | `shortEngine.ts`, `breakdownScans` table |
| P1-3 | נפח יורד כ-gate (`volumeRatio < 0.85`) | `warEngine.ts` |
| P1-4 | Post-rally filter פורמלי | `warEngine.ts` |
| P1-5 | position sizing — הסר `positionSizePct` מ-war path | `warEngine.ts`, `liveOrderExecutor.ts` |
| P1-6 | `phase` ב-`WarEngineScan` + persistence | `warEngine.ts`, DB |
| P1-7 | לוג תפעולי Telegram (WATCH/EXECUTE/REJECT) | `telegramWebhook.ts` |
| P1-8 | עדכון `mentorScoreBoost` SIGNAL_PATTERN_MAP | `mentorScoreBoost.ts` |
| P1-9 | Deep Analysis — cycle phase + prompts | ראה `2026-06-19-deep-analysis-ziv-alignment.md` |
| P1-10 | הסרת Sector Rotation (סריקה + UI + הערות) | `marketScan.ts`, `AssetCatalogue.tsx`, `runtimeIntelligence.ts` |

### P2 — ליטוש ותצוגה (שבוע 5+)

| # | משימה | קבצים |
|---|--------|--------|
| P2-1 | `BULL_PA_CONFIRM` עם 75% size (אוטומטי) | `warEngine.ts` |
| P2-2 | cash buffer 10% gate | `liveOrderExecutor.ts` |
| P2-3 | War Room UI — הצגת `entryType` + `phase` | client |
| P2-4 | בדיקות אינטגרציה: retest + role reversal | tests |
| P2-5 | תיעוד mentor patterns חדשים ב-learnPatterns | `learnPatterns.ts` |
| P2-6 | TASE war scan — אותם gates ב-ILS | `runWarEngineTase` |

---

## נספח: ספי מספריים (Reference)

| פרמטר | ערך | הערה |
|--------|------|------|
| `LONG_ENTRY_MIN_SCORE` | 8.0 | `warEngine.ts` |
| `SHORT_ENTRY_MIN_SCORE` | 7.5 | `warEngine.ts` |
| `MIN_CONFLUENCE` | 4.5 | |
| `MIN_LIQUIDITY_SCORE` | 2.0 | |
| `MAX_CORRELATION` | 0.80 | |
| `RETEST_TOLERANCE_PCT` | 2.0% | `breakoutScanner.ts` — גם Role Reversal V2/BR2 |
| `BREAKOUT_LOOKBACK_DAYS` | 30 | |
| `VOLUME_RATIO_MIN` (breakout detect) | 1.2 | |
| `VOLUME_DRY_PULLBACK` | < 0.85 | gate חדש |
| `MAX_ENTRY_DEVIATION` | 1.5% | Gap Guard |
| `EMA_EXTENDED_BLOCK` | > 8% מעל EMA-50 | post-rally |
| `MAX_LONG_POSITIONS` | 12 | `maxLongPositions` |
| `MAX_SHORT_POSITIONS` | 6 | `maxShortPositions` |
| `SLOT_RATIO` | 12:6 (2:1) | חלוקת pools |
| `PER_SLOT_BASE` | poolRemaining / slotsRemaining | נוסחה מרכזית |
| `SIZE_MULT_PA` | 0.75 | |
| `SIZE_MULT_MOMENTUM` | 0.70 | breakout + breakdown |
| `BREAKDOWN_MIN_VOLUME_RATIO` | 1.5 | מעל 1.3 הרגיל |
| `ENTRY_MULT_BREAKOUT` | 0.70 | לונג breakout (= SIZE_MULT_MOMENTUM) |
| `LONG_POOL_PCT` | 12/18 ≈ 66.67% | |
| `SHORT_POOL_PCT` | 6/18 ≈ 33.33% | |
| `BREAKOUT_REGIME` | BULL בלבד | לא NEUTRAL |
| `BREAKDOWN_REGIME` | BEAR בלבד | לא NEUTRAL |
| `BREAKOUT_MIN_SCORE` | 8.0 | |
| `BULL_TRAP_DROP_PCT` | 2% ב-24h | חסימת breakout |
| `BREAKDOWN_MIN_SCORE` | 8.0 | מעל 7.5 של retest |
| `BEAR_TRAP_BOUNCE_PCT` | 2% ב-24h | חסימת breakdown |
| `LOW_CYCLE_EMA_DIST_PCT` | ≤ 3% | זיהוי מחזור נמוך |
| `HIGH_CYCLE_EMA_DIST_PCT` | > 5% | זיהוי מחזור גבוה |
| `CYCLE_SHARP_MOVE_PCT` | 1.5% יומי | עלייה/ירידה "חדה" |
| `WEEKLY_SLOPE_BULL_MIN_PCT` | 0.2% | WK-L — שיפוע שבועי מינימלי ללונג |
| `WEEKLY_SLOPE_BEAR_MAX_PCT` | -0.2% | WK-S — שיפוע שבועי מקסימלי לשורט |
| `WEEKLY_PRICE_VS_EMA50` | מעל/מתחת | לונג: close>EMA50w; שורט: close<EMA50w |
| `PENNY_MIN` | $2.00 | |
| `WAR_CYCLE_GAP` | 20 דקות | |

---

## נספח: מפת פרמטרים — אלזה ישנה (קיצוץ מאושר)

גישה **א' — ליבה + מחזורים**: שומרים מה שמשרת את זיו וניהול תיק; קוצצים כפילויות, מתים, ו-Rotation.

### שמור (חיוני)

| פרמטר | קובץ | תפקיד |
|--------|------|--------|
| משטר שוק BULL/NEUTRAL/BEAR | `runtimeIntelligence.ts` | מחזור מאקרו — `longOk` / `shortOk` |
| ציון Ziv / Bear + tiers | `zivEngine.ts`, `shortEngine.ts` | ליבת סינון |
| Weekly bullish/bearish | `runtimeIntelligence.ts` | זיו: שבועי מובהק (WK-L/WK-S) |
| Confluence ≥4.5 (לונג) | `warEngine.ts` | multi-TF |
| Liquidity ≥2.0 | `warEngine.ts` | נזילות |
| Correlation ≤0.80 | `warEngine.ts` | גיוון תיק |
| מגבלת מגזר 3 / 20% NLV | `warEngine.ts` | סיכון — **לא** rotation |
| Mentor boost + REJECTED | `mentorScoreBoost.ts`, `analyze.ts` | Hebrew Slang Guard |
| Iron Rules 1–3 | `warEngine.ts`, `liveOrderExecutor.ts` | תקציב, לילה, הפסד יומי |
| shortGuard | `shortGuard.ts` | earnings, div, squeeze |
| ZivH | `zivEngine.ts` | יציאות / בריאות פוזיציה |
| Gap Guard 1.5% | `paperLabEngine.ts` → Live | FOMO — P0-6 |
| MACD histogram ≥0 (PA) | `paperLabEngine.ts` → Live | סכין נופלת — P0-6 |
| Gates מחזור CYC-* | `cyclePhaseEngine.ts` (חדש) | ליבת זיו |

### נחתך

| פרמטר | סיבה | פעולה |
|--------|------|--------|
| **Sector Rotation** | לא בתורת זיו; לא מיושם במנוע | P1-10 |
| **positionSizePct** | הוחלף בסלוט 12/6 | P1-5 |
| **capitalAllocator / 1% risk ב-Live** | נדחה — סלוט קבוע בלבד | לא ליישם |
| **momentumVelocity כ-gate/UI** | רק feed ל-confluence | הסר שדה מוצג; שמור חישוב פנימי |
| **ALERT_ONLY / SEMI modes** | Elza = אוטומטי מלא | לא לבנות |

### ממתין ליישום בקוד (מאושר v2.0)

| פרמטר | מצב היום | יעד | עדיפות |
|--------|----------|-----|--------|
| True Retest (לא EMA בלבד) | Tier 3 על EMA | P0-3 | P0 |
| Demand zone gate | Paper/Lab | P1-1 | P1 |
| **Role Reversal** | לא מיושם | **P0-9** | P0 |
| **SCALE_OUT 2R** | 1.5R | `SCALE_OUT_TP1_R = 2.0` | P0 |
| **CYC-L1/L2 gates** | חלקי | War Engine | P0 |
| **marketScan** 1M vol + 300M cap | 500K | `marketScan.ts` | P1 |
| RSI confluence bonus | לא קיים | `zivEngine` P2 | P2 |
| Fib 38.2–61.8% + S/R bonus | לא קיים | `zivEngine` P2 | P2 |
| ZivH + weekly Force-Close | חלקי | פאזה 3 | P1 |

### סדר עדיפות gates (לפני `tryLiveEntry`)

```
1. Kill switch (isEnabled, daily loss)
2. Regime (longOk / shortOk) — מאקרו SPY
3. Weekly trend (WK-L / WK-S)              ← מגמה שבועית מובהקת
4. Cycle phase (CYC-L1/L2/S1/S2)
5. signal_bias REJECTED / Hebrew Guard
6. Entry-type gates (D/R/V/P/BO/BD)
7. Confluence, liquidity, correlation, sector cap
8. Gap Guard, MACD (PA בלבד)
9. computeSlotSize + long/short caps
```

---

## נספח: זרימת החלטה לונג (תמצית)

```
סריקת ticker
    → regime.longOk?
    → weeklyBullish (WK-L)? → BLOCK אם לא
    → classifyCyclePhase → CYC-L1/L2? → WATCH/REJECT
    → calcZivEngineScore + mentorBoost
    → האם BREAKOUT (donchian + volume)?
         כן → BO1–BO7? → EXECUTE (סלוט ×0.70) או SKIP
    → האם מגע demand zone OR true retest OR role reversal?
         לא → phase=WATCH או SKIP
         כן → volume dry-up? PA? gates?
    → roleReversalEngine: V1–V7 / BR1–BR6?
         כן → tryLiveEntry (BULL_ROLE_REVERSAL / BEAR_ROLE_REVERSAL)
    → isEnabled=1?
         כן → tryLiveEntry (signal=GOLD_TRUE_RETEST / BULL_DEMAND / ...)
         לא → REJECTED (kill switch)
```

---

## נספח: זרימת החלטה שורט (תמצית)

```
סריקת ticker
    → regime.shortOk? (לא BULL)
    → weeklyBearish (WK-S)? → BLOCK אם לא
    → classifyCyclePhase → CYC-S1/S2? → WATCH/REJECT
    → calcShortEngineScore
    → האם BEAR_TRUE_RETEST או Supply?
         כן → phase=EXECUTE (עדיפות) → tryLiveEntry (computeSlotSize)
    → האם BREAKDOWN (donchian low + volume)?
         לא → phase=WATCH או SKIP
         כן → BD1–BD7?
              כן → phase=EXECUTE → tryLiveEntry (סלוט ×0.70)
              לא → phase=WATCH
```

---

*מסמך זה הוא מפרט יישום. שינויי קוד יבוצעו ב-PR נפרדים לפי עדיפויות P0→P2.*
