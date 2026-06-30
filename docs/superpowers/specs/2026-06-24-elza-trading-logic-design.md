# Elza — לוגיקת מסחר מלאה (מסונתז)

**מסמך:** `2026-06-24-elza-trading-logic-design.md`  
**תאריך:** 24 יוני 2026  
**גרסה:** 1.0  
**סטטוס:** **לבדיקה / QA** — מסמך מאוחד לפני יישום בקוד  
**קהל:** בודק, מפתח, מנהל מערכת

### מסמכי מקור

| מסמך | גרסה | תפקיד |
|------|------|--------|
| [`2026-06-24-ziv-methodology-research.md`](./2026-06-24-ziv-methodology-research.md) | v2.3 | מחקר זיו + 14 החלטות מאושרות |
| [`2026-06-19-elza-ziv-alignment-guidelines.md`](./2026-06-19-elza-ziv-alignment-guidelines.md) | v2.0 | מפרט יישום מנוע (gates, קבצים) |
| [`2026-06-19-deep-analysis-ziv-alignment.md`](./2026-06-19-deep-analysis-ziv-alignment.md) | v1.1 | יישור Deep Analysis (prompt/UI) |

---

## 1. מטרה

מסמך **אחד** שמתאר את לוגיקת המסחר המלאה של Elza — מבוססת על מתודולוגיית זיו חקשוריאן (Focus Trader / Cycles Trading), עם שכבות Elza הייחודיות (ZIV SCORE, ZivH, אוטומציה, סלוט).

**לא מסמך קוד.** ליישום — ראה `alignment-guidelines` v2.0.

---

## 2. פילוסופיה

| זיו (אנושי) | Elza (אוטומטי) |
|-------------|----------------|
| התראה → מעקב → כניסה ידנית | `tryLiveEntry` אוטומטי כשעוברים gates |
| גרף **שבועי**, סבלנות שבועות | Swing — מחזיקים עד שבירת מבנה |
| 1% סיכון לעסקה (חישוב ידני) | **סלוט קבוע 12/6** |
| אין ZIV SCORE / HEALTH | **המצאת Elza** — שכבת ניהול |

**עקרון על:** כל כניסה חייבת נימוק במונחי זיו — **מבנה, ריטסט, ביקוש, נפח** — לא פרוקסי טכני (EMA בלבד).

---

## 3. משפך החלטה — 6 שכבות

```
שכבה 1  מאקרו (SPY regime)     → BULL / NEUTRAL / BEAR → longOk / shortOk
שכבה 2  מגמה שבועית (WK)       → WK-L (לונג) / WK-S (שורט) — שטוח = אין כניסה
שכבה 3  מחזור מניה + Volume    → CYC-L1/L2/S1/S2
שכבה 4  מבנה מחיר              → S/R, True Retest, Role Reversal, Demand Zone
שכבה 5  אישורים                 → R:R ≥1:2, Gap Guard, נמ"ס (BO), earnings guard
שכבה 6  ZIV SCORE (Elza)        → ≥8.0 לביצוע (אחרי שכבות 1–5)
         ↓
         EXECUTE | WATCH | REJECT
```

### 3.1 מגמה שבועית (פילטר ראשון)

**לונג:** C-points ושפלים עולים (proxy: WK-L — שיפוע EMA-50 שבועי >0.2% + מחיר מעל).  
**שורט:** WK-S — שיפוע <-0.2% + מחיר מתחת.  
**דשדוש:** **אין כניסה** — "סכין נופלת, לא נוגעים".

### 3.2 מחזורי מסחר = Volume (לא Gann)

| חוק | לונג | שורט |
|-----|------|------|
| **CYC-L1** | עלייה במחזור **נמוך** = פריצת שווא → **BLOCK** | — |
| **CYC-L2** | ירידה במחזור נמוך **בביקוש** = קונים נגמרו → **BLOCK / EXIT** | — |
| **CYC-S1** | — | ירידה במחזור **גבוה** = bear trap → **BLOCK** |
| **CYC-S2** | — | עלייה במחזור גבוה **בהיצע** = מוכרים נגמרו → **BLOCK / COVER** |

**אישור חיובי:** `volumeRatio < 0.85` בתיקון לביקוש/ריטסט.  
**אזהרה:** נפח גבוה בירידות; שיא חדש עם נפח נמוך יותר (CYC-L1).

**הגדרות proxy:**

| מושג | פרוקסי |
|------|--------|
| מחזור נמוך | `close ≤ EMA-50` או demand zone או `distToEma50Pct ≤ 3%` או חצי תחתון Donchian 20d |
| מחזור גבוה | `distToEma50Pct > 5%` או supply zone או `RSI > 60` או חצי עליון Donchian 20d |

---

## 4. כניסה — סוגי איתות

### 4.1 עדיפות

```
True Retest  >  Role Reversal  >  Demand Zone  >  Breakout/Breakdown
```

### 4.2 טבלת איתותים

| סוג | תנאי | גודל סלוט | עדיפות |
|-----|------|-----------|--------|
| **True Retest** | פריצה → חזרה לרמת מבנה + **5 נרות** אישור | 100% | **P0** |
| **Role Reversal** | התנגדות→תמיכה (או להפך בשורט) | 100% | **P0** |
| **Demand Zone** | מגע בביקוש + נפח יבש + ≥2 מגעים | 100% | P1 |
| **Bullish PA** | נר אישור בתוך zone/retest + MACD≥0 | 75% | P1 |
| **Gold Breakout** | פריצה + נמ"ס (BO1–BO7) + `!isLowCycle` | 70% | P0 |
| **Bear Breakdown** | שבירה + נפח (BD1–BD7) | 70% | P0 |

### 4.3 חסימות כניסה (אסור)

| חסימה | סיבה |
|--------|------|
| קנייה בפריצה (FOMO) | "לא רודפים — מחכים לריטסט" |
| כניסה מ-EMA proximity בלבד | דורש `priorBreakoutLevel` או zone |
| Gap >1.5% מעל entry zone | Gap Guard |
| כניסה ביום דוחות | earnings ±3d |
| RSI>70 כחסימה במגמת עלייה | זיו מתעלם מ-overbought בשורי |
| CYC-L1/L2 (לונג) / CYC-S1/S2 (שורט) | מחזורי Volume |
| שבועי לא מובהק | WK-L / WK-S נכשל |
| Gann / דוח חודשי | **REJECT** |

---

## 5. יציאה — Approach B (מאושר)

```
כניסה
  → SL מבני: min(zone.low, swingLow20) − 0.5×ATR14 (לונג)
  → הגעה ל-+2R → מימוש 50% (SCALE_OUT_TP1_R = 2.0)
  → יתרה: trail מתחת שפלים שבועיים (לא EMA)
  → שבירת מבנה / ZivH<4 + weekly שבור → Force-Close review
  → EXIT מלא
```

| נושא | החלטה |
|------|--------|
| TP אחוזי קרוב | **לא** |
| יציאות מבוססות EMA | **REJECT** |
| מינימום רווח לפני סגירה מלאה | **2R** |
| Phase 4 (21+ ימים) | Chandelier בלבד; ZivH = dead capital detector |

---

## 6. Confluence — בונוסים (לא gates)

| כלי | שימוש | עדיפות |
|-----|--------|--------|
| **פיבונאצ'י** | תיקון 38.2%–61.8% + S/R = בונוס ציון | ADAPT (#13) |
| **RSI** | במגמת עלייה: RSI<30 בתיקון = בונוס; לא חוסם >70 | ADAPT P2 (#12) |
| **MA/EMA** | מאשר מבנה — לעולם לא gate עצמאי | אושר (#14) |
| **MACD** | histogram ≥0 בכניסה — תוספת Elza | קיים |

---

## 7. ZIV SCORE vs ZivH

| | ZIV Engine (כניסה) | ZivH (החזקה) |
|--|-------------------|--------------|
| **בקורס זיו** | ❌ לא קיים | ❌ לא קיים |
| **תפקיד Elza** | סיכום gates → tier 1–10 | דופק פוזיציה פתוחה |
| **סף** | ≥ **8.0** לביצוע | FC review < **4** |
| **כלל** | **אחרי** שכבות 1–5, לא במקומן | **לא** כניסה; ניהול החזקה בלבד |
| **Phase 4** | — | אין force-close — Chandelier שולט |

---

## 8. Workflow איתור → ביצוע (שיעור 37)

1. **סורק** — Finviz/TV: volume >1M, cap >300M, 40–50 מניות מעקב  
2. **ניתוח שבועי** — מגמה + S/R + ריטסט אפשרי  
3. **התראות TV** (ידני) — 5% מרמת כניסה  
4. **ניתוח מחודש** — Volume + confluence (RSI/פיבו/MA)  
5. **Elza EXECUTE** — `tryLiveEntry`  
6. **ניהול** — trail שבועי, 50%@2R, יומן מסחר  

**סורק ≠ החלטה** — `marketScan` = מועמדים בלבד.

---

## 9. Deep Analysis — אותה תורה

סדר חובה בכל ניתוח:

1. מאקרו → 2. שבועי → 3. מחזור → 4. אירוע → 5. CYC block? → 6. ציון → 7. המלצה

**אם CYC-L1 פעיל — אסור ENTER** גם אם tier=Gold Breakout.

---

## 10. מה לא בשיטה

| נושא | סטטוס |
|------|--------|
| Gann דוח חודשי / מחזורי זמן | ❌ REJECT (#9) |
| Gann box/fan/timing | ⏸️ P2 deferred |
| Sector Rotation כאסטרטגיה | ❌ נחתך |
| ZIM / Diamond Hands | ❌ REJECT |
| Fibonacci כ-TP gate | ❌ ADAPT בלבד |
| positionSizePct 1% | ❌ → סלוט 12/6 |

---

## 11. 14 החלטות מאושרות (סיכום)

| # | החלטה | סטטוס |
|---|--------|--------|
| 1 | True Retest + 5 נרות | ✅ P0 |
| 2 | Gold Breakout + נמ"ס | ✅ P0 |
| 3 | Approach B — 2R + trail מבני | ✅ |
| 4 | יציאה חלקית 50% ב-2R | ✅ |
| 5 | REJECT EMA exits | ✅ |
| 6 | Volume CYC gates | ✅ |
| 7 | ZivH + weekly ב-Force-Close | ✅ |
| 8 | Fibonacci ADAPT | ✅ |
| 9 | Gann REJECT | ✅ |
| 10 | Market Failure | ✅ |
| 11 | חוזק אזור (מגעים+Volume) | ✅ P1 |
| 12 | RSI confluence P2 | ✅ |
| 13 | פיבו 38.2–61.8% + S/R | ✅ |
| 14 | MA לא gate עצמאי | ✅ |

---

## 12. מצב יישום בקוד (24/6/2026)

| פריט | מאושר | ממומש? |
|------|--------|--------|
| True Retest (לא EMA) | ✅ | ❌ P0 |
| Role Reversal | ✅ | ❌ P0 |
| SCALE_OUT 2R | ✅ | ❌ (1.5R היום) |
| CYC gates מלאים | ✅ | ⚠️ חלקי |
| REJECT EMA exits | ✅ | ⚠️ לוודא |
| marketScan 1M/300M | ✅ | ❌ |
| RSI/Fib bonus | ✅ | ❌ P2 |
| Deep Analysis cycle | ✅ | ❌ |
| ZIV≥8.0 + ZivH | ✅ | ✅ קיים |

---

## 13. קבצי קוד רלוונטיים (ליישום)

| קובץ | שינוי צפוי |
|------|------------|
| `server/warEngine.ts` | P0-3, P0-9, CYC, Gap Guard |
| `server/zivEngine.ts` | True Retest ≠ EMA; confluence bonuses |
| `server/slCalculator.ts` | SCALE_OUT 2R; REJECT EMA trail |
| `server/routers/marketScan.ts` | 1M vol, 300M cap |
| `server/cyclePhaseEngine.ts` | CYC משותף War + DA |
| `server/roleReversalEngine.ts` | P0-9 |
| `server/routers/deepAnalysisStream.ts` | cycle narrative ב-prompt |
| `server/utils/zivHealth.ts` | weekly ב-FC |

---

## 14. מקורות מחקר

- קורס Focus Trader — PDF שיעורים 8, 10–18, 30, 31, 37  
- YouTube `@cyclestrading` — ניתוח 26.5.2026 + 6 סרטוני מתודולוגיה (v2.3)  
- Gann שיעורים 32–33 — **לא נכלל** (REJECT)

---

*מסמך זה מיועד לבדיקה. לאחר אישור QA — מעבר לתוכנית יישום (`writing-plans`) ואז קוד.*
