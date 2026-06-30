# GAP #6 — Fibonacci / פיבונאצ'י (Lesson 15)

**Status:** Research complete — **confluence bonus spec only** (not entry gate)  
**Sources:** שיעור 15 PDF (`סיכום-שיעור-15-שאלות-ותשובות.pdf`, נקרא 26/6/2026), `docs/superpowers/specs/2026-06-24-ziv-methodology-research.md` §11.3, `docs/superpowers/specs/2026-06-19-elza-ziv-alignment-guidelines.md` החלטה **#13** (v2.3), YouTube `3iqhYB8VNz0` (מחזק בלבד)  
**Scope:** `zivEngine` / confluence scoring — **לא** gate, **לא** TP, **לא** כשל שוק (זה GAP נפרד / ZivH)

---

## 1. Executive summary

| Question | Answer | Confidence |
|----------|--------|------------|
| Exact levels? | **38.2%, 50%, 61.8%** (לא 100%, לא 78.6% בקורס) | ✅ PDF שיעור 15 + מבחן שאלה 9 |
| Drawn from where? | **שפל → שיא של המהלך האחרון** במגמה **משנית** נגדית לראשית | ✅ PDF + מבחן שאלה 7 (תשובה ד) |
| Bonus or gate? | **BONUS ONLY** — confluence; לא חוסם כניסה | ✅ החלטה #13 + שיעור 15 |
| Golden zone? | **אין מונח "golden zone"** בקורס; "יחס הזהב" = המתמטיקה של 61.8%/38.2% | ✅ PDF — ❌ לא אזור מסחר נפרד |
| TP? | **לא** — פיבו לתיקון/אזורי עניין, לא יעד רווח | ✅ PDF + שיעור 37 |
| שילוב חובה? | **S/R היסטורי** (אזור תמיכה/התנגדות) — לא כניסה מפיבו בלבד | ✅ PDF + YouTube v2.3 |

**Implementation priority:** **P2** (`zivEngine` confluence bonus — alignment v2.0, לא ממומש)

---

## 2. מה הקורס אומר (שיעור 15)

### 2.1 שימוש עיקרי

פיבונאצ'י מיועד לניתוח **מגמה משנית נגדית** למגמה ראשית — למשל ירידה (תיקון) בתוך מגמת עלייה ראשית, או עלייה בתוך מגמת ירידה.

| נושא | כלל זיו | אמון |
|------|---------|------|
| הקשר | תיקון טכני = תנועה **נגד** המגמה השולטת, מימוש רווחים בריא | ✅ |
| סרגל פיבו | כלי לזיהוי תמיכה/התנגדות **אפשריות** בתיקון | ✅ מבחן שאלה 8 (תשובה ג) |
| ארגז כלים | "מתווסף לארגז הכלים" — לשלב עם תמיכה/התנגדות | ✅ |
| לא מנבא | לא מבטיח עצירה; "מסייע בזיהוי" (מבחן 17 — לא תשובה ג) | ✅ |

### 2.2 רמות מדויקות — `FIB_LEVELS`

הסרגל מציג **שלוש רמות בלבד**:

| Level | Hebrew | Role in course |
|-------|--------|----------------|
| **0.382** | 38.2% | יחס פיבו (מספר ÷ המספר שאחריו השני) — קצה רדוד של תיקון בריא |
| **0.500** | 50% | אמצע המהלך — רמה שלישית מפורשת בסרגל |
| **0.618** | 61.8% | "יחס הזהב" — קצה עמוק של תיקון בריא |

```typescript
export const FIB_LEVELS = [0.382, 0.5, 0.618] as const;
```

**לא בקורס:** 23.6%, 78.6%, 100% כרמות מסחר (100% מופיע במבחן כתשובה **שגויה** לשאלה 9).

**אמון:** ✅ PDF עמ' 6 + מבחן שאלות 3, 6, 9

### 2.3 תיקון בריא — `FIB_HEALTHY_BAND`

| Rule | Spec | אמון |
|------|------|------|
| טווח תיקון בריא | **38.2% – 61.8%** מסך **המהלך** (לא מהשיא/שפל המוחלט) | ✅ |
| דוגמה בקורס | $150→$200 ($50 range); 38.2% retracement = $19 מ-$50 → מחיר ~$181 | ✅ |
| מבחן שאלה 6 | תשובה נכונה: בין **38% ל-62%** מהמהלך הקודם | ✅ |

```typescript
export const FIB_HEALTHY_MIN = 0.382;
export const FIB_HEALTHY_MAX = 0.618;
```

**מחוץ לטווח:** תיקון <38.2% = רדוד מדי (פולבק); >61.8% = עמוק מדי ל"בריא" — **אין בונוס פיבו** (לא חוסם כניסה).

### 2.4 מאיפה מותחים את הסרגל — `FIB_ANCHOR`

| Direction | Anchor A | Anchor B | Formula |
|-----------|----------|----------|---------|
| **לונג** (תיקון במגמת עלייה ראשית) | שפל המהלך האחרון | שיא המהלך האחרון | `level = high - (high-low) × ratio` |
| **שורט** (תיקון במגמת ירידה ראשית) | שיא המהלך האחרון | שפל המהלך האחרון | `level = low + (high-low) × ratio` |

**הגדרת "המהלך האחרון" (מבחן שאלה 7 — תשובה ד):**

> מהשפל האחרון **במגמה המשנית** עד לשיא האחרון (לונג).

**לא נכון בקורס (תשובות שגויות במבחן):**

- ❌ מהשיא האחרון עד המחיר הנוכחי  
- ❌ מהשפל האחרון עד המחיר הנוכחי  
- ❌ מתחילת המגמה הראשית  

**Engine anchor (⚠️ RECOMMENDED_DEFAULT):**

```typescript
// Analysis TF: weekly (Elza swing); fallback daily for shorter corrections
type FibLeg = { swingLow: number; swingHigh: number; direction: 'UP' | 'DOWN' };

function lastImpulseLeg(bars: Bar[], direction: 'UP' | 'DOWN'): FibLeg {
  // Last completed impulse against primary trend:
  // UP leg for long fib (pullback in bull primary)
  // DOWN leg for short fib (bounce in bear primary)
  // Use most recent swing pair: prior swing low → swing high (or inverse for short)
}
```

| Parameter | Value | אמון |
|-----------|-------|------|
| `FIB_ANALYSIS_TF` | `weekly` (primary); `daily` for pullback 2–5d | ⚠️ — סוגי תיקון ב-PDF, לא TF מפורש לסרגל |
| `FIB_SWING_LOOKBACK_BARS` | 52 weekly / 126 daily | ⚠️ Elza convention — לא בקורס |

**אמון מיקום סרגל:** ✅ PDF מפורש; ⚠️ אלגוריתם swing = Elza default

### 2.5 סוגי תיקון (הקשר זמן — לא רמות פיבו)

| Type | Depth / duration | TF לניתוח | אמון |
|------|------------------|-----------|------|
| **Pullback** | 2–5 ימים, אחוזים בודדים | יומי / תוך-יומי | ✅ |
| **Correction** | 8–10%, עד חודש | יומי + שבועי | ✅ |
| **Retracement** | 10–25%, שבועות–חודשים | **שבועי** | ✅ |

אלה **סיווג תיקון**, לא פרמטרי gate — משמשים להחלטה על איזה גרף לחשב `lastImpulseLeg`.

---

## 3. Golden zone — האם קיים בקורס?

| Term | In course? | Meaning |
|------|------------|---------|
| **"יחס הזהב"** | ✅ | המתמטיקה: 61.8% (מספר÷הבא), 38.2% (מספר÷הבא אחריו) |
| **"Golden zone"** (אזור 50–61.8% כמונח מסחר) | ❌ | **לא מופיע** ב-PDF שיעור 15 |
| **עדיפות 61.8% על 50%** | ⚠️ | מחקר v2.3 / החלטה 8 מציעים בונוס חזק יותר ב-61.8% — **לא מצוטט במפורש ב-PDF** |

**Spec decision:** אל תיצור gate בשם `golden_zone`. אם רוצים שכבת בונוס — השתמש ב-`FIB_HEALTHY_BAND` (38.2–61.8%) + קרבה ל-S/R; אופציונלי `FIB_LEVEL_WEIGHT[0.618] > FIB_LEVEL_WEIGHT[0.5]` כ-⚠️ Elza default.

---

## 4. Bonus vs gate — החלטה #13

### 4.1 מה מאושר

| Rule | Hebrew | English param | אמון |
|------|--------|---------------|------|
| לא gate כניסה | פיבו לבדו ≠ אות קנייה/מכירה | `FIB_IS_GATE = false` | ✅ החלטה #13 |
| לא TP | לא יעד רווח ראשי | `FIB_IS_TP = false` | ✅ שיעור 15 + 37 |
| בונוס confluence | תיקון 38.2–61.8% **+** חפיפה ל-S/R | `fibConfluenceBonus` | ✅ החלטה #13 |
| שילוב Volume | YouTube v2.3: פיבו + S/R + Volume | optional third term | 📄 YouTube — לא ב-PDF 15 |

**עקרון ליבה (alignment v2.0 §16):**

> פיבונאצ'י = confluence, לא TP — תיקון בריא 38.2%–61.8% **+** חפיפה ל-S/R = בונוס ציון; לא gate חובה לכניסה.

### 4.2 מה **לא** בשטח GAP זה

| Topic | Decision | Module |
|-------|----------|--------|
| **כשל שוק** (Market Failure) | ADOPT — ZivH penalty / BLOCK לונג | החלטה #10 — **לא** בונוס פיבו |
| חסימת כניסה בלי פיבו | REJECT | — |
| כניסה רק כי מחיר ב-61.8% | REJECT | — |

---

## 5. Engine rules — `fibConfluenceBonus`

### 5.1 Preconditions (all must pass for any bonus)

| # | Condition | Param | אמון |
|---|-----------|-------|------|
| 1 | מגמה ראשית שבועית תואמת כיוון העסקה (WK-L / WK-S קיים) | `weeklyTrendOk` | 📄 שיעור 10 + workflow |
| 2 | מחיר/אזור כניסה כבר עבר gate מבני (ריטסט / ביקוש / RR / BO) | existing gates | 📄 alignment |
| 3 | תיקון נוכחי נמדד ב-**FIB_HEALTHY_BAND** על `lastImpulseLeg` | `inHealthyRetrace` | ✅ |
| 4 | **חפיפה** בין רמת פיבו לאזור S/R פעיל | `fibOverlapsSR` | ✅ PDF "שילוב עם תמיכה והתנגדות" |

### 5.2 Overlap definition

```typescript
export const FIB_SR_TOLERANCE_PCT = 2.0; // ⚠️ RECOMMENDED_DEFAULT — align w/ retest ±2%

function fibOverlapsSR(
  fibPrice: number,
  zone: { low: number; high: number },
  tolerancePct = FIB_SR_TOLERANCE_PCT,
): boolean {
  const pad = fibPrice * (tolerancePct / 100);
  const expanded = { low: zone.low - pad, high: zone.high + pad };
  return fibPrice >= expanded.low && fibPrice <= expanded.high;
}
```

**אמון:** ⚠️ 2% — לא בקורס; Elza משתמש ב-±2% בריטסט (`trueRetestEngine`)

### 5.3 Scoring (additive — never blocking)

```typescript
const FIB_LEVEL_WEIGHT: Record<number, number> = {
  0.382: 0.15,
  0.5:   0.25,
  0.618: 0.35, // ⚠️ slightly higher — decision #8 hint, not PDF literal
};

const FIB_BASE_BONUS = 0.3;      // any healthy-band + SR overlap
const FIB_MAX_BONUS  = 0.8;      // cap on ziv score contribution

function calcFibConfluenceBonus(ctx: {
  entryPrice: number;
  impulseLeg: FibLeg;
  demandOrSupplyZone: { low: number; high: number };
  direction: 'LONG' | 'SHORT';
}): number {
  if (!ctx.impulseLeg) return 0;

  const { swingLow, swingHigh } = ctx.impulseLeg;
  const range = swingHigh - swingLow;
  if (range <= 0) return 0;

  const retracePct =
    ctx.direction === 'LONG'
      ? (swingHigh - ctx.entryPrice) / range
      : (ctx.entryPrice - swingLow) / range;

  if (retracePct < FIB_HEALTHY_MIN || retracePct > FIB_HEALTHY_MAX) return 0;

  let bonus = 0;
  for (const level of FIB_LEVELS) {
    const fibPrice =
      ctx.direction === 'LONG'
        ? swingHigh - range * level
        : swingLow + range * level;

    if (fibOverlapsSR(fibPrice, ctx.demandOrSupplyZone)) {
      bonus = Math.max(bonus, FIB_BASE_BONUS + FIB_LEVEL_WEIGHT[level]);
    }
  }

  return Math.min(bonus, FIB_MAX_BONUS);
}
```

| Output | Apply to | Notes |
|--------|----------|-------|
| `fibConfluenceBonus` | `zivEngine` score after tier gates | P2 — לא משנה `tryLiveEntry` pass/fail |
| `logicBadge: "Fibonacci"` | Deep Analysis / trade UI only when bonus > 0 | קיים ב-`trade.ts` prompt |

**אמון ציונים:** ⚠️ RECOMMENDED_DEFAULT — הקורס לא נותן מספרי נקודות

### 5.4 Flow position (gates order)

```
… → Entry-type gates (D/R/V/P/BO/BD) → … → Confluence layer → fibConfluenceBonus
```

פיבו **אחרי** gates מבניים — לעולם לא לפני WK-L / ריטסט / ביקוש.

---

## 6. סימטריה שורט

| לונג | שורט |
|------|------|
| מגמה ראשית עולה; תיקון משני **יורד** | מגמה ראשית יורדת; תיקון משני **עולה** |
| סרגל: שפל → שיא של המהלך העולה האחרון | סרגל: שיא → שפל של המהלך היורד האחרון |
| בונוס כשמחיר בתיקון 38.2–61.8% **וגם** אזור **היצע** / התנגדות | אותו עיקרון עם אזור ביקוש בהיצע |

**אמון:** ✅ PDF מזכיר לונג ושורט; כיוון סרגל — ⚠️ הסקה סימטרית (טקסט מפרט לונג)

---

## 7. Master parameter table

| Parameter | Value | Unit | Source | אמון |
|-----------|-------|------|--------|------|
| `FIB_LEVELS` | [0.382, 0.5, 0.618] | ratio | L15 PDF + quiz 9 | ✅ |
| `FIB_HEALTHY_MIN` | 0.382 | ratio | L15 PDF | ✅ |
| `FIB_HEALTHY_MAX` | 0.618 | ratio | L15 PDF | ✅ |
| `FIB_IS_GATE` | false | bool | Decision #13 | ✅ |
| `FIB_IS_TP` | false | bool | L15 + L37 | ✅ |
| `FIB_ANCHOR_LONG` | swingLow → swingHigh | price | L15 PDF + quiz 7d | ✅ |
| `FIB_ANCHOR_SHORT` | swingHigh → swingLow | price | ⚠️ symmetric | ⚠️ |
| `FIB_ANALYSIS_TF` | weekly (default) | TF | L15 correction types | ⚠️ |
| `FIB_SR_TOLERANCE_PCT` | 2.0 | % | Elza retest convention | ⚠️ |
| `FIB_BASE_BONUS` | 0.3 | score pts | Elza P2 default | ⚠️ |
| `FIB_MAX_BONUS` | 0.8 | score pts | Elza P2 default | ⚠️ |
| `FIB_LEVEL_WEIGHT[0.618]` | 0.35 | score pts | Decision #8 hint | ⚠️ |

---

## 8. Open questions / לא בקורס

| Item | Status |
|------|--------|
| אלגוריתם swing אוטומטי ל"המהלך האחרון" | ⚠️ צריך התאמה ל-`swingExtreme20` / pivot detection |
| בונוס Volume + פיבו יחד | 📄 YouTube בלבד — P2 אופציונלי |
| כשל שוק (לא חידוש שיא אחרי תיקון לפיבו) | ✅ בקורס — מיושם ב-**ZivH**, לא כאן |
| האם 50% שווה ל-61.8% בבונוס | ⚠️ PDF שווה ברמות; Elza נותן משקל גבוה יותר ל-61.8% |

---

## 9. Source traceability

| Rule ID | Description | Primary source |
|---------|-------------|----------------|
| FIB-01 | Levels 38.2/50/61.8 | L15 PDF p.6, quiz 9 |
| FIB-02 | Healthy band 38.2–61.8% of move | L15 PDF p.6, quiz 6 |
| FIB-03 | Anchor low→high last move | L15 PDF p.6, quiz 7d |
| FIB-04 | Secondary trend context | L15 PDF p.6 opening |
| FIB-05 | Combine with S/R, not standalone | L15 PDF p.6 closing |
| FIB-06 | Bonus only, not gate | Alignment #13, research §11.3 |
| FIB-07 | Not TP | L15 + L37 workflow |
| FIB-08 | No "golden zone" trading term | L15 PDF — term absent |

**YouTube v3.1 (GAP_06 scope):** אין תרומה ישירה — H&S (`ZeT5NIR8a-g`) → GAP_04 P2.

**PDF URL:**

`https://cyclestrading-course.com/wp-content/uploads/2023/01/%D7%A1%D7%99%D7%9B%D7%95%D7%9D-%D7%A9%D7%99%D7%A2%D7%95%D7%A8-15-%D7%A9%D7%90%D7%9C%D7%95%D7%AA-%D7%95%D7%AA%D7%A9%D7%95%D7%91%D7%95%D7%AA.pdf`

---

*GAP #6 — confluence bonus only. Merge into `GAPS_RESEARCH_SPEC.md` by orchestrator.*
