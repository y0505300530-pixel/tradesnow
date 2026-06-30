# Deep Analysis — יישור עם מתודולוגיית זיו ומפרט Elza

**מסמך:** `2026-06-19-deep-analysis-ziv-alignment.md`  
**גרסה:** 1.1  
**תאריך:** 19 ביוני 2026  
**קהל יעד:** מפתחי Deep Analysis (UI + LLM prompts)  
**סטטוס:** מפרט יישום — ללא קוד  
**מסמך אב:** [`2026-06-19-elza-ziv-alignment-guidelines.md`](./2026-06-19-elza-ziv-alignment-guidelines.md) v1.9

---

## מטרה

Deep Analysis הוא **ממשק אנושי** לניתוח טיקר בודד (מודל, דף `/dip-analysis`, SSE stream). הוא חייב לספר **את אותו סיפור** כמו War Engine — במיוחד **מחזורי מסחר** — ולא להמליץ על כניסות ש-Elza תחסום אוטומטית.

### עקרון מנחה

> **מחזורי המסחר מספרים את הסיפור** — לפני ציון, tier, או המלצת כניסה, הניתוח חייב לזהות: מאקרו (regime), מיקום במחזור (נמוך/גבוה), ואירוע (עלייה/ירידה/ריטסט).

---

## רכיבים בקוד (היום)

| רכיב | קובץ | תפקיד |
|------|------|--------|
| SSE stream + prompt | `server/routers/deepAnalysisStream.ts` | meta מ-Ziv Engine + LLM streaming |
| tRPC mutation | `server/routers/portfolio.ts` → `analyzeAsset` | אותו prompt logic (יש לסנכרן) |
| UI מודל | `client/src/components/DeepAnalysisModal.tsx` | תצוגה + IBKR actions |
| דף עצמאי | `client/src/pages/DeepAnalysisPage.tsx` | `/dip-analysis` |
| ציון מנוע | `server/zivEngine.ts` | `calcZivEngineScore` — מקור נתונים |

**פער היום:** ה-prompt מזכיר tiers (Gold Breakout / Retest) אבל **לא** מחזורי נמוך/גבוה ולא את שני חוקי זיו המרכזיים.

---

## חוקי זיו שחייבים להופיע בכל ניתוח

### לונג

| חוק | תורה | מה Deep Analysis אומר למשתמש |
|-----|------|------------------------------|
| **CYC-L1** | עליות במחזורים נמוכים = **פריצת שווא** | "המניה במחזור נמוך — העלייה הזו כנראה פריצת שווא. **אין כניסת לונג.**" |
| **CYC-L2** | ירידות במחזורים נמוכים (במיוחד בביקוש) = **קונים נגמרו** | "ירידה בביקוש = כשל קונים והיפוך מגמה. **אין לונג חדש**; שקול יציאה אם מחזיקים." |

### שורט (סימטריה)

| חוק | תורה | מה Deep Analysis אומר |
|-----|------|------------------------|
| **CYC-S1** | ירידות במחזורים גבוהים = **שבירת שווא** | "ירידה מורחבת = bear trap אפשרי. **אין שורט.**" |
| **CYC-S2** | עליות במחזורים גבוהים (במיוחד בהיצע) = **מוכרים נגמרו** | "עלייה בהיצע = היפוך. **אין שורט חדש**; שקול cover." |

### הגדרות (זהות למפרט Elza)

| מושג | פרוקסי |
|------|--------|
| מחזור נמוך | `close ≤ EMA-50` או demand zone או `distToEma50Pct ≤ 3%` או חצי תחתון Donchian 20d |
| מחזור גבוה | `distToEma50Pct > 5%` או supply zone או `RSI > 60` או חצי עליון Donchian 20d |
| עלייה/ירידה חדה | `|dailyChange| > 1.5%` |

---

## מבנה ניתוח חובה (סדר סיפור)

כל Deep Analysis (כניסה חדשה **או** ניהול פוזיציה) חייב לעבור בסדר הזה:

1. **מאקרו** — BULL / NEUTRAL / BEAR (מ-SP `regime`)
2. **מגמה שבועית מובהקת** — WK-L (לונג) / WK-S (שורט): שיפוע >0.2% / <-0.2% + מחיר מעל/מתחת EMA-50 שבועי
3. **מיקום במחזור** — נמוך / בינוני / גבוה + הסבר במשפט אחד
4. **אירוע אחרון** — עלייה / ירידה / ריטסט / פריצה / שבירה
5. **החלת חוק מחזור** — CYC-L1/L2/S1/S2 אם רלוונטי → **חסימה מפורשת**
6. **ציון Ziv + tier** — רק **אחרי** שלבים 1–5
7. **המלצה** — ENTER / WAIT / REJECT / EXIT (עברית)
8. **מספרים** — SL מנוע, TP, גודל סלוט (אם רלוונטי)

אם שלב 4 מפעיל חסימה — **אסור** להמליץ ENTER גם אם tier = Gold Breakout.

---

## עדכון Prompt (מוצע)

### שדות חדשים ב-meta (לפני LLM)

חישוב ב-`deepAnalysisStream.ts` / `analyzeAsset`:

```typescript
interface CyclePhaseMeta {
  phase: "LOW" | "MID" | "HIGH";
  isLowCycle: boolean;
  isHighCycle: boolean;
  cycleEvent: "RISE" | "FALL" | "FLAT" | "RETEST" | "BREAKOUT" | "BREAKDOWN";
  cycleBlock: "CYC-L1" | "CYC-L2" | "CYC-S1" | "CYC-S2" | null;
  cycleNarrativeHe: string; // משפט עברית מוכן ל-LLM
}
```

שלח ב-`event: meta` יחד עם Ziv score.

### טקסט להוספה ל-prompt (כניסה חדשה)

```
ZIV CYCLE RULES (חובה — לפני המלצת כניסה):
1. מחזור נמוך + עלייה/פריצה = פריצת שווא → אין לונג (CYC-L1)
2. מחזור נמוך + ירידה בביקוש = קונים נגמרו, היפוך מגמה → אין לונג (CYC-L2)
3. מחזור גבוה + ירידה/שבירה = שבירת שווא → אין שורט (CYC-S1)
4. מחזור גבוה + עלייה בהיצע = מוכרים נגמרו → אין שורט (CYC-S2)

CYCLE PHASE NOW:
- phase: {LOW|MID|HIGH}
- event: {cycleEvent}
- block: {cycleBlock or "none"}
- narrative: {cycleNarrativeHe}

אם block ≠ none — recommendation חייב להיות WAIT או REJECT (לונג) / אין שורט — גם אם Ziv tier גבוה.
```

### טקסט להוספה (פוזיציה קיימת)

```
ZIV CYCLE RULES FOR HOLDINGS:
- אם CYC-L2 (ירידה בביקוש) על פוזיציה לונג → שקול EXIT או הידוק SL — לא "החזק"
- אם CYC-L1 (עלייה במחזור נמוך אחרי כניסה) → אזהרה: פריצת שווא — שקול יציאה מהירה
- סימטריה לשורט: CYC-S2 → cover; CYC-S1 → אל תוסיף לשורט
```

### החלפת ZIV METHODOLOGY RULES (ישן → חדש)

**הסר** (לא מספיק):
```
- Tier 4: Enter at market...
- Tier 3: Enter at EMA-50 zone...
```

**החלף ב:**
```
ZIV METHODOLOGY (מסונכרן עם Elza War Engine v1.9):
1. זהה מגמה שבועית מובהקת (WK-L/WK-S) לפני tier
2. זהה מחזור (נמוך/גבוה) לפני tier
3. החל CYC-L1/L2/S1/S2 — חסימה קודמת ל-tier
3. Tier 4 Gold Breakout: רק אם isLowCycle=false + BO gates (BULL, נפח, לא FOMO)
4. Tier 3 Gold Retest: רק True Retest לרמת מבנה — לא EMA בלבד
5. Demand Zone: רק עם נפח יבש במשיכה; CYC-L2 חוסם ירידה שוברת ביקוש
6. אין FOMO — Gap Guard 1.5% מעל recommendedBuyPrice
```

---

## תצוגה ב-UI (מוצע)

| אלמנט | מיקום | תוכן |
|--------|-------|------|
| **Cycle Badge** | מעל Ziv score | `מחזור נמוך` / `מחזור גבוה` / `בינוני` |
| **Cycle Block Alert** | אדום אם `cycleBlock` | "פריצת שווא — מחזור נמוך + עלייה" |
| **סיפור מחזור** | פסקה ראשונה ב-AI summary | 2–3 משפטים עברית |
| **התאמה ל-Elza** | שורת סטטוס | "Elza: WATCH (CYC-L1)" / "Elza: EXECUTE" |

---

## מה **לא** לעשות ב-Deep Analysis

| ❌ | סיבה |
|----|------|
| המלצת לונג על Gold Breakout במחזור נמוך | סותר CYC-L1 + BO5 |
| "היכנס ב-EMA-50" בלי רמת מבנה | סותר True Retest gate |
| התעלמות מ-`signal_bias=REJECTED` ממנטור | Hebrew Slang Guard |
| Sector Rotation כגורם החלטה | נחתך מהמפרט |
| positionSizePct 15% מ-NLV | הוחלף בסלוט 12/6 — הצג `computeSlotSize` אם יש portfolio |

---

## סנכרון קבצים (יישום)

| # | משימה | קבצים |
|---|--------|--------|
| DA-1 | `classifyCyclePhase()` משותף עם War Engine | `cyclePhaseEngine.ts` (חדש) |
| DA-2 | הוספת `cyclePhase` ל-meta SSE | `deepAnalysisStream.ts` |
| DA-3 | עדכון prompt כניסה + holdings | `deepAnalysisStream.ts`, `portfolio.ts` |
| DA-4 | Cycle Badge + Block Alert ב-UI | `DeepAnalysisModal.tsx`, `DeepAnalysisPage.tsx` |
| DA-5 | בדיקות: ticker במחזור נמוך + breakout → recommendation ≠ ENTER | tests |

**תלות:** P0-8 במפרט Elza (`cyclePhaseEngine.ts`) — **אותה פונקציה** ל-War ול-Deep Analysis.

---

## דוגמאות פלט (עברית)

### דוגמה 1 — פריצת שווא (CYC-L1)

> **מחזור:** נמוך — המחיר מתחת ל-EMA-50 ובתחתית טווח 20 יום.  
> **אירוע:** עלייה 2.1% היום עם נפח מוגבר.  
> **חוק זיו:** עלייה במחזור נמוך = פריצת שווא.  
> **המלצה:** **אין כניסה** — המתן לריטסט אמיתי לרמה או לאישור מבני. Elza: WATCH (CYC-L1).

### דוגמה 2 — כשל ביקוש (CYC-L2)

> **מחזור:** נמוך — מגע באזור ביקוש $142–$145.  
> **אירוע:** ירידה 1.8% עם סגירה מתחת לתחתית האזור.  
> **חוק זיו:** ירידה בביקוש = קונים נגמרו, היפוך מגמה.  
> **המלצה:** **יציאה** מפוזיציה קיימת / **אין לונג חדש**. שקול שורט אם משטר BEAR.

---

## עקביות עם מפרט Elza

| נושא Elza | Deep Analysis |
|-----------|---------------|
| CYC-L1/L2/S1/S2 | אותה לוגיקה, אותם ספים |
| WK-L / WK-S | שבועי מובהק — חסימה לפני ENTER |
| True Retest ≠ EMA | prompt + tier הסבר |
| **Role Reversal** | חובה להסביר היפוך תפקיד (התנגדות→תמיכה) — P0 |
| Gold Breakout EXECUTE | רק אם `!isLowCycle` + BO gates |
| סלוט 12/6 | הצג גודל מסלוט, לא % NLV |
| Sector Rotation | לא מוזכר — נחתך מהמפרט |
| מגבלת מגזר | אופציונלי בהקשר portfolio (3 pos / 20%) |
| ציטוטי זיו במחזור | חובה בפסקת סיפור ראשונה |

---

## החלטות מאושרות (סנכרון עם מפרט Elza)

| נושא | החלטה |
|------|--------|
| מחזור נמוך + עלייה | פריצת שווא — CYC-L1 — **אין ENTER** |
| שבועי לא מובהק | `|slope| ≤ 0.2%` או מחיר בצד הלא נכון של EMA-50w — **אין ENTER** |
| מחזור נמוך + ירידה בביקוש | קונים נגמרו — CYC-L2 — **אין ENTER / שקול EXIT** |
| שורט | סימטריה: CYC-S1 / CYC-S2 |
| Sector Rotation | לא בשימוש |
| **Role Reversal** | P0 — ליבת תורה, לא אופציונלי |
| גודל פוזיציה | סלוט 12/6 — לא positionSizePct |

---

*מסמך זה משלים את מפרט Elza v1.9. שינויי prompt/UI ב-PR נפרד אחרי אישור מפרט.*
