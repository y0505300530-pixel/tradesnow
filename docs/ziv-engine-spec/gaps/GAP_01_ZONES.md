# Gap #1 — אזורי ביקוש / היצע (Demand / Supply Zones)

**שיעורים:** 11 (תמיכה/התנגדות + קווי מגמה), 12 (לונג/שורט בתמיכה/התנגדות)  
**תאריך מחקר:** 26 יוני 2026  
**מקורות:** PDF רשמי (`סיכום-שיעור-11-שאלות-ותשובות.pdf`, `סיכום-שיעור-12-שאלות-ותשובות.pdf`), `2026-06-24-ziv-methodology-research.md`, `2026-06-19-elza-ziv-alignment-guidelines.md`, `server/routers/tradeManager.ts` (`calcZones`)

## סימוני אמון

| סימון | משמעות |
|--------|---------|
| ✅ | אומת ישירות ב-PDF שיעור 11/12 |
| 📄 | מסמך מחקר/יישור Elza (לא ב-PDF 11–12) |
| ⚠️ | הסקה לאוטומציה — לא מוגדר מפורשות בקורס |
| ❌ | לא נמצא בקורס — דורש החלטת מנוע |

---

## 1. סיכום מנהלים

זיו **לא מגדיר** ב-PDF שיעורים 11–12 אלגוריתם גיאומטרי מדויק (נר יורד אחרון, פתילים בלבד, וכו'). הוא מגדיר **מושגים**:
- תמיכה/התנגדות = **אזורים** (לא קווים)
- חוזק = מספר מגעים + Volume ביצירה + TF גבוה
- במגמת עלייה: כל **שפל** = תמיכה; במגמת ירידה: כל **שיא** = התנגדות
- כניסה: לונג בתמיכה (מגמה עולה), שורט בהתנגדות (מגמה יורדת) — **סבלנות**, חזרה מדויקת
- SL: **מעבר לרמת** התמיכה/התנגדות (מבחן L11 שאלה 12: תשובה א)

**פערים שנשארים לאלגוריתם:** גבולות מספריים מדויקים, `MIN_TOUCHES` מינימלי ל-zone, fresh vs tested, lookback — רובם ⚠️/❌ ומוצעים כהחלטות מנוע למטה.

---

## 2. הגדרות ליבה (שיעור 11)

### 2.1 מהו אזור ביקוש / היצע

| סוג | עברית | הגדרת זיו | `zone_type` |
|-----|--------|-----------|-------------|
| ביקוש | תמיכה | אזור **מתחת** למחיר — ביקוש > היצע → בלימת ירידות | `DEMAND` |
| היצע | התנגדות | אזור **מעל** המחיר — היצע > ביקוש → בלימת עליות | `SUPPLY` |

**במגמת עלייה:** ✅ כל רמת שפל = תמיכה; רמות תמיכה **לא אמורות להישבר** כלפי מטה.  
**במגמת ירידה:** ✅ כל רמת שיא = התנגדות; רמות התנגדות **לא אמורות להיפרץ** כלפי מעלה.

**Confidence:** ✅ (L11 סעיף 1, מבחן שאלות 2–3)

### 2.2 אזור ≠ קו

> "לעיתים תכופות רמות תמיכה והתנגדות הן **אזורים ולא קווים מדויקים**"

| כלל מנוע | פרמטר | ערך מוצע | אמון |
|----------|--------|----------|------|
| ייצוג גיאומטרי | `ZONE_GEOMETRY` | `AREA` (טווח `[low, high]`) | ✅ |
| אסור מנוע קו בודד | `ZONE_SINGLE_PRICE_FORBIDDEN` | `true` | ✅ |

---

## 3. גבולות האזור — אלגוריתם (השאלה המרכזית)

### 3.1 מה הקורס אומר במפורש

| עובדה מ-PDF | השלכה למנוע | אמון |
|-------------|-------------|------|
| אזורים, לא קווים | `zone.low` ו-`zone.high` חובה | ✅ |
| במגמת עלייה כל **שפל** = תמיכה | מקור zone = swing low structure | ✅ |
| חשוב לשים לב ל**תבניות נרות** ליד הרמות | בונוס PA — לא גבול גיאומטרי | ✅ |
| שילוב קו מגמה + S/R מחזיק | `confluenceBonus` | ✅ |
| **אין** "נר יורד אחרון", **אין** כלל פתילים | — | ❌ |

### 3.2 מה הקורס **לא** אומר

| שאלה | סטטוס בקורס |
|------|-------------|
| הנר-היורד-האחרון לפני העלייה? | ❌ לא מוזכר |
| טווח קונסולידציה? | ❌ לא ב-L11–12 (קונסולידציה = שיעור 10/13) |
| קצות פתילים (wicks)? | ❌ לא מוזכר |
| רוחב אזור באחוזים? | ❌ לא מוגדר |

### 3.3 החלטת מנוע מוצעת — שכבות זיהוי

שכבה 1 = **מבנית (תואמת זיו)** — swing lows/highs.  
שכבה 2 = **הרחבה לאזור** — קונסולידציה / ATR (Elza + `calcZones`).  
שכבה 3 = **סינון** — מגעים + Volume.

```
┌─────────────────────────────────────────────────────────┐
│  DEMAND zone (לונג)                                      │
│                                                          │
│  zone.high ─── גבול עליון (גוף/שיא בסיס)                │
│  zone.low  ─── גבול תחתון (שפל מבני / תחתית בסיס)       │
│              SL מעבר ל-zone.low − ATR_buffer             │
└─────────────────────────────────────────────────────────┘
```

#### כלל R1 — מקור מבני (Primary) ✅ + ⚠️

**עברית:** במגמת עלייה, כל **שפל משמעותי** (swing low) על ה-TF הנבחר הוא מועמד לתמיכה. גבולות האזור נגזרים מטווח המחיר סביב אותו שפל.

| פרמטר | שם EN | ערך מוצע | אמון |
|--------|--------|----------|------|
| מקור שפל | `SWING_PIVOT_BARS` | `5` (חלון שמאלה/ימינה, כמו `calcSwingPoints`) | ⚠️ |
| גבול תחתון | `zone.low` | `min(low)` של נרות בחלון השפל ±1 נר | ⚠️ |
| גבול עליון | `zone.high` | `max(close, open)` של אותו בסיס — **לא** רק high של נר בודד | ⚠️ |
| הרחבת פתילים | `ZONE_INCLUDE_WICKS` | `true` — `zone.low = min(low)`, `zone.high = max(high)` בחלון | ⚠️ |

**נימוק:** זיו מגדיר שפלים כתמיכה; פתילים הם חלק מהמחיר בפועל. הקורס לא בוחר בין גוף לפתיל — **הכללת wicks** היא פרקטיקה סטנדרטית, לא ציטוט זיו.

#### כלל R2 — בסיס קונסולידציה (Secondary) ⚠️

**עברית:** אזור ביקוש קלאסי אצל זיו (בסרטונים וב-Elza): מחיר **התכנס** לפני עלייה חדה. זה תואם `calcZones` הקיים.

| פרמטר | שם EN | ערך מוצע | אמון |
|--------|--------|----------|------|
| חלון קונסולידציה | `CONSOLIDATION_WINDOW_BARS` | `11` (±5 נרות) | ⚠️ (`calcZones`: 5) |
| סף טווח | `CONSOLIDATION_MAX_RANGE_PCT` | `0.04` (4%) | ⚠️ (`calcZones`) |
| אישור יציאה (demand) | `BREAKOUT_CONFIRM_PCT` | `0.03` — עלייה ≥3% אחרי הבסיס | ⚠️ (`calcZones`) |
| אישור יציאה (supply) | `BREAKDOWN_CONFIRM_PCT` | `0.03` — ירידה ≥3% אחרי הבסיס | ⚠️ (`calcZones`) |

**לא** "נר יורד אחרון בלבד" — אלא **טווח** שבו המחיר נע בצורה צרה ואז פרץ.

#### כלל R3 — מיזוג מועמדים

| פרמטר | שם EN | ערך מוצע | אמון |
|--------|--------|----------|------|
| מרחק מיזוג | `ZONE_MERGE_DISTANCE_PCT` | `0.01` × CMP (1%) | ⚠️ (`calcZones`) |
| מקסימום zones פעילים | `MAX_ZONES_PER_SIDE` | `3` (הקרובים ביותר למחיר) | ⚠️ (`calcZones`) |

#### כלל R4 — מה **לא** להשתמש כגבול בלבד

| גישה | החלטה | אמון |
|------|--------|------|
| נר יורד אחרון בלבד (ICT-style) | **REJECT** — לא בקורס זיו | ❌ → REJECT |
| קו אופקי בודד (`close` של נר אחד) | **REJECT** — סותר "אזורים" | ✅ |

### 3.4 Pseudocode — `detectZones`

```typescript
type Zone = {
  type: "DEMAND" | "SUPPLY";
  low: number;
  high: number;
  tf: "WEEKLY" | "DAILY";
  source: "SWING" | "CONSOLIDATION" | "MERGED";
  touchCount: number;
  volumeAtFormation: number;
  formedAtBar: number;
  priority: number;
};

function detectZones(bars: OHLCVBar[], tf: TF, trend: Trend): Zone[] {
  const swings = findSwingPivots(bars, SWING_PIVOT_BARS); // lows if BULL, highs if BEAR
  const swingZones = swings.map(p => ({
    low: minLowInWindow(bars, p.index, 1),
    high: maxHighInWindow(bars, p.index, 1),
    source: "SWING",
    formedAtBar: p.index,
    volumeAtFormation: sumVolume(bars, p.index - 2, p.index + 2),
  }));

  const consolZones = [];
  for (let i = CONSOLIDATION_WINDOW_BARS; i < bars.length - CONSOLIDATION_WINDOW_BARS; i++) {
    const w = bars.slice(i - 5, i + 6);
    const rangePct = (maxHigh(w) - minLow(w)) / minLow(w);
    if (rangePct > CONSOLIDATION_MAX_RANGE_PCT) continue;
    const after = bars.slice(i + 6, i + 16);
    if (trend === BULL && maxHigh(after) > maxHigh(w) * (1 + BREAKOUT_CONFIRM_PCT))
      consolZones.push({ low: minLow(w), high: maxHigh(w), source: "CONSOLIDATION", ... });
    if (trend === BEAR && minLow(after) < minLow(w) * (1 - BREAKDOWN_CONFIRM_PCT))
      consolZones.push({ low: minLow(w), high: maxHigh(w), source: "CONSOLIDATION", ... });
  }

  const merged = mergeOverlapping([...swingZones, ...consolZones], ZONE_MERGE_DISTANCE_PCT);
  return merged
    .map(z => ({ ...z, touchCount: countTouches(bars, z), priority: scoreZone(z) }))
    .filter(z => z.touchCount >= MIN_TOUCHES_EFFECTIVE)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, MAX_ZONES_PER_SIDE);
}
```

---

## 4. מגעים (Touches)

### 4.1 מה הקורס אומר

> "ככל שרמה **נבדקת יותר פעמים**, היא נחשבת ל**חזקה יותר**" (L11)

| כלל | פרמטר EN | ערך | אמון |
|-----|----------|-----|------|
| חוזק ∝ מגעים | `ZONE_STRENGTH_TOUCH_WEIGHT` | מונוטוני עולה | ✅ |
| Volume גבוה ביצירה | `ZONE_STRENGTH_VOLUME_WEIGHT` | מונוטוני עולה | ✅ |
| מינימום מגעים ל-zone ב-L11 | — | **לא מוגדר** | ❌ |

### 4.2 `MIN_TOUCHES` — האם ≥2?

| מקור | כלל | רלוונטיות ל-Gap 1 |
|------|-----|-------------------|
| L11 | יותר מגעים = חזק יותר (ללא מינימום) | ✅ |
| L10 (📄) | דשדוש = **2** מגעים למעלה + **2** למטה | 📄 — הקשר דשדוש, לא zone כללי |
| Elza alignment (📄) | demand zone = swing low עם **≥2 מגעים** | 📄 |
| L13 (📄) | כניסה בדשדוש במגע **שלישי** לתמיכה | 📄 — אסטרטגיית range, לא הגדרת zone |

**החלטת מנוע:**

| פרמטר | שם EN | ערך מוצע | אמון |
|--------|--------|----------|------|
| מינימום מגעים לתוקף zone | `MIN_TOUCHES` | `2` | ⚠️ (מסקת L11+L10+Elza; לא מפורש ב-L11) |
| מגע = מה? | `TOUCH_TOLERANCE_PCT` | `0.02` (2%) — מחיר (low/high/close) נכנס לטווח `[zone.low, zone.high]` | ⚠️ |
| מגעים נספרים אחרי יצירה | `TOUCH_COUNT_AFTER_FORMATION` | `true` — לא כולל נר יצירת הבסיס | ⚠️ |

```typescript
function countTouches(bars: OHLCVBar[], zone: Zone, afterBar: number): number {
  let touches = 0;
  for (const b of bars.slice(afterBar)) {
    const overlaps =
      b.low <= zone.high * (1 + TOUCH_TOLERANCE_PCT) &&
      b.high >= zone.low * (1 - TOUCH_TOLERANCE_PCT);
    if (overlaps) touches++;
  }
  return touches;
}
```

### 4.3 האם אזור נחלש אחרי N מגעים?

| ממצא | אמון |
|------|------|
| L11: **יותר** מגעים = **חזק יותר** | ✅ |
| אין אזכור ל"שחיקה" אחרי N מגעים | ❌ |
| שבירת אזור = **ביטול** (לא החלשה הדרגתית) | ✅ (L11 החלפת תפקידים + L12 הנחות יסוד) |

**החלטת מנוע:**

| פרמטר | שם EN | ערך מוצע | אמון |
|--------|--------|----------|------|
| חולשה אחרי N מגעים | `ZONE_DECAY_AFTER_TOUCHES` | `null` — **לא מיישמים** | ✅ (עקבות קורס) |
| ביטול zone | `ZONE_INVALIDATE_ON_CLOSE_BELOW` | לונג: `close < zone.low` (יומי) | ✅ + ⚠️ |
| עדיפות עדיין עולה עם מגעים | `zonePriority += f(touchCount)` | לינארי/לוג עד `MAX_TOUCH_BOOST` | ✅ |

```typescript
function scoreZone(z: Zone): number {
  const touchScore = Math.min(z.touchCount, MAX_TOUCH_BOOST) * ZONE_STRENGTH_TOUCH_WEIGHT;
  const volScore = z.volumeAtFormation / avgVolume(bars) * ZONE_STRENGTH_VOLUME_WEIGHT;
  const tfScore = z.tf === "WEEKLY" ? 2.0 : 1.0; // L11 TF hierarchy
  return touchScore + volScore + tfScore;
}
```

---

## 5. Fresh מול Tested

### 5.1 מה הקורס אומר

| נושא | ממצא | אמון |
|------|------|------|
| "טרי" vs "נבדק" | **לא מוזכר** במונחים אלו | ❌ |
| יותר מגעים = חזק יותר | מרמז: zone **נבדק** = **עדיף** כרמה | ✅ (עקיפות) |
| סבלנות + חזרה **מדויקת** לרמה | L12 שורט/לונג | ✅ |
| לא לרדוף — מחכים למחיר | 📄 מחקר YouTube + alignment | 📄 |

### 5.2 פרשנות למנוע

זיו **לא** מבדיל בין "fresh untested" ל-"tested 5 times" כעדיפות כניסה. ההבחנה הרלוונטית:

| מצב | משמעות | עדיפות כניסה | אמון |
|-----|--------|--------------|------|
| **Untested** (0–1 מגע אחרי יצירה) | עדיין לא הוכחה | נמוך — `WATCH` | ⚠️ |
| **Tested** (≥`MIN_TOUCHES`) | הוכחה מבניתית | גבוה — מועמד `EXECUTE` עם gates נוספים | ⚠️ |
| **Broken** | סגירה מתחת/מעל האזור | `INVALID` — Role Reversal או יציאה | ✅ |

| פרמטר | שם EN | ערך מוצע | אמון |
|--------|--------|----------|------|
| עדיפות zone עם מגעים | `PREFER_TESTED_ZONE` | `true` — `touchCount >= MIN_TOUCHES` | ⚠️ |
| מגע ראשון אחרי יצירה | `FIRST_RETEST_BONUS` | `+0.5` ל-`zonePriority` (ריטסט ראשון לביקוש) | ⚠️ |
| מגע רביעי+ ללא שבירה | `NO_FRESH_PREFERENCE` | אין עונש — עדיין `+touch` לפי L11 | ✅ |

**לא** לאמץ מונחי ICT של "fresh zone only" — סותר את "יותר מגעים = חזק יותר".

---

## 6. Lookback (כמה אחורה מחפשים)

### 6.1 מה הקורס אומר (L11–12)

| נושא | ממצא | אמון |
|------|------|------|
| Lookback מפורש ל-zones | **לא מוגדר** | ❌ |
| TF היררכיה: חודשי > שבועי > יומי | רמות ב-TF גבוה = חזקות יותר | ✅ |
| ניתוח היסטורי חשוב | "לתרגל ולנתח גרפים היסטוריים" | ✅ |

### 6.2 הקשר משיעור 10 (📄 — לא L11 אבל רלוונטי למגמה)

| כלל | ערך | אמון |
|-----|-----|------|
| מגמה ראשית = שבועי/חודשי | נקודת מפנה ≥ **4 חודשים** | 📄 |

### 6.3 החלטת מנוע

| פרמטר | שם EN | ערך מוצע | אמון |
|--------|--------|----------|------|
| זיהוי zones — שבועי | `ZONE_LOOKBACK_WEEKS` | `52` (~12 חודשים) | ⚠️ |
| זיהוי zones — יומי (ביצוע) | `ZONE_LOOKBACK_DAYS` | `126` (~6 חודשים) | ⚠️ (`calcZones` 6mo) |
| גיל מקסימלי ל-zone פעיל | `ZONE_MAX_AGE_DAYS` | `365` — אחרי שנה: `priority × 0.5` | ⚠️ |
| TF לזיהוי מגמה | `ZONE_PRIMARY_TF` | `WEEKLY` | ✅ (L11 היררכיה) |
| TF לטריגר כניסה | `ZONE_ENTRY_TF` | `DAILY` | ⚠️ (L12 מעשי + workflow 37) |

```typescript
const weeklyBars = fetchOHLCV(ticker, "1wk", ZONE_LOOKBACK_WEEKS);
const dailyBars  = fetchOHLCV(ticker, "1d",  ZONE_LOOKBACK_DAYS);

const weeklyZones = detectZones(weeklyBars, "WEEKLY", trend);
const dailyZones  = detectZones(dailyBars,  "DAILY",  trend);

// weekly zone שחופף ל-daily → priority גבוה (TF confluence)
const zones = mergeMultiTF(weeklyZones, dailyZones);
```

---

## 7. כללי כניסה / יציאה מ-L12 (הקשר zones)

| כלל | עברית | פרמטר EN | אמון |
|-----|--------|----------|------|
| לונג רק במגמת עלייה | קנייה ברמת תמיכה | `LONG_AT_DEMAND_IN_UPTREND` | ✅ |
| שורט רק במגמת ירידה | מכירה ברמת התנגדות | `SHORT_AT_SUPPLY_IN_DOWNTREND` | ✅ |
| סבלנות — חזרה מדויקת | לא לרדוף | `ENTRY_REQUIRES_PRICE_IN_ZONE` | ✅ |
| **מרחק מכניסה** | 📄 `VHM3p-mgMIk`: avoid כשמחיר **רחוק** מאזור כניסה (לא pullback לתמיכה) | `DIST_TO_ENTRY_MAX_PCT = 5.0` | 📄 + ⚠️ |
| מחיר בטווח כניסה | בין `zone.low` ל-`zone.high` או עד 2% מעל | `ENTRY_ZONE_TOLERANCE_PCT = 0.02` | 📄 (Elza D1) |
| SL מעבר לרמה | מתחת לתמיכה / מעל להתנגדות | `SL_BEYOND_ZONE = true` | ✅ (L11 מבחן 12א) |
| SL לפי TF + ATR | שבועי 10–25%, יומי 5–10% | `SL_WEEKLY_PCT_RANGE`, `SL_DAILY_PCT_RANGE` | ✅ (L12) |
| SL מבני מועדף | `zone.low − 0.5×ATR14` | `SL_ATR_BUFFER_MULT = 0.5` | 📄 (Elza) |
| R:R מינימום | 1:2 | `MIN_RR = 2.0` | ✅ (L12) |
| סיכון לעסקה | עד 1% תיק | `RISK_PER_TRADE_PCT = 0.01` | ✅ (L12) |

---

## 8. TF היררכיה ו-Role Reversal (L11)

| כלל | פרמטר EN | אמון |
|-----|----------|------|
| חודשי > שבועי > יומי | `TF_HIERARCHY = ["MONTHLY","WEEKLY","DAILY"]` | ✅ |
| שבירה יומית < שבירה שבועית (משמעות) | `DAILY_BREAK_WEAKER_THAN_WEEKLY` | ✅ |
| התנגדות שנפרצה → תמיכה | `ROLE_REVERSAL_BULL` | ✅ |
| תמיכה שנשברה → התנגדות | `ROLE_REVERSAL_BEAR` | ✅ |

**הערה:** Role Reversal הוא **סוג כניסה נפרד** (P0-9) — לא אותו דבר כמו Demand Zone רגיל, אך **אותו מבנה מחיר**.

---

## 9. מצב קוד נוכחי — `calcZones`

```76:99:server/routers/tradeManager.ts
const calcZones = (bars: OHLCVBar[], type: 'demand' | 'resistance', cmp: number): Array<{ low: number; high: number }> => {
  const zones: Array<{ low: number; high: number }> = [];
  const windowSize = 5;
  for (let i = windowSize; i < bars.length - windowSize; i++) {
    const window = bars.slice(i - windowSize, i + windowSize);
    const rangeHigh = Math.max(...window.map((b: OHLCVBar) => b.high));
    const rangeLow = Math.min(...window.map((b: OHLCVBar) => b.low));
    const rangePercent = (rangeHigh - rangeLow) / rangeLow;
    if (rangePercent < 0.04) {
      const afterSlice = bars.slice(i + windowSize, i + windowSize + 10);
      // ... breakout/breakdown 3% confirm
    }
  }
  // dedupe 1%, keep 3 nearest
};
```

| תכונה | `calcZones` היום | זיו L11–12 | פער |
|--------|------------------|------------|-----|
| גיאומטריה | קונסולידציה 4% | אזור + שפלים | חלקי — חסר swing |
| מגעים | ❌ לא נספר | ✅ חוזק | **חסר** |
| Volume ביצירה | ❌ | ✅ | **חסר** |
| TF שבועי | ❌ (6mo יומי בלבד) | ✅ היררכיה | **חסר** |
| lookback | 6 חודשים יומי | לא מוגדר | OK כהתחלה |
| metadata | רק `{low, high}` | priority, touches, tf | **חסר** |

**המלצה:** `demandZoneEngine.ts` — הרחבת `calcZones` + swing pivots + `zonePriority`.

---

## 10. טבלת פרמטרים מלאה (Engine Config)

| פרמטר EN | ערך מוצע | תיאור עברית | אמון |
|----------|----------|-------------|------|
| `ZONE_GEOMETRY` | `AREA` | אזור, לא קו | ✅ |
| `SWING_PIVOT_BARS` | `5` | חלון זיהוי שפל/שיא | ⚠️ |
| `CONSOLIDATION_MAX_RANGE_PCT` | `0.04` | סף קונסולידציה | ⚠️ |
| `BREAKOUT_CONFIRM_PCT` | `0.03` | אישור פריצה מהבסיס | ⚠️ |
| `MIN_TOUCHES` | `2` | מינימום מגעים לתוקף | ⚠️ |
| `TOUCH_TOLERANCE_PCT` | `0.02` | סובלנות מגע | ⚠️ |
| `ZONE_DECAY_AFTER_TOUCHES` | `null` | אין שחיקה — יותר מגעים = חזק | ✅ |
| `ZONE_STRENGTH_TOUCH_WEIGHT` | `1.0` | משקל מגעים | ✅ |
| `ZONE_STRENGTH_VOLUME_WEIGHT` | `0.5` | משקל Volume ביצירה | ✅ |
| `PREFER_TESTED_ZONE` | `true` | העדפת zone עם ≥2 מגעים | ⚠️ |
| `ZONE_LOOKBACK_WEEKS` | `52` | שבועי | ⚠️ |
| `ZONE_LOOKBACK_DAYS` | `126` | יומי | ⚠️ |
| `ZONE_PRIMARY_TF` | `WEEKLY` | זיהוי | ✅ |
| `ZONE_ENTRY_TF` | `DAILY` | כניסה | ⚠️ |
| `MAX_ZONES_PER_SIDE` | `3` | קרובים למחיר | ⚠️ |
| `ENTRY_ZONE_TOLERANCE_PCT` | `0.02` | מחיר ב-zone או ±2% | 📄 |
| `DIST_TO_ENTRY_MAX_PCT` | `5.0` | חסימה אם רחוק מאזור כניסה | 📄 VHM3p + ⚠️ |
| `SL_ATR_BUFFER_MULT` | `0.5` | מתחת zone.low | 📄 |
| `MIN_RR` | `2.0` | R:R מינימום | ✅ |
| `RISK_PER_TRADE_PCT` | `0.01` | 1% תיק | ✅ |

---

## 11. פערים פתוחים (דורש וידאו / שיעור נוסף)

| # | שאלה | סטטוס | פעולה מוצעת |
|---|------|--------|-------------|
| 1 | אלגוריתם גבולות מדויק (נר אחרון? גוף?) | ❌ | שמור שכבה כפולה swing+consolidation ⚠️ |
| 2 | `MIN_TOUCHES` מינימלי מפורש | ❌ | אמץ `2` מ-L10+Elza ⚠️ |
| 3 | fresh vs tested במפורש | ❌ | `PREFER_TESTED` — לא עונש על מגעים רבים ✅ |
| 4 | weakening אחרי N מגעים | ❌ (הקורס אומר ההפך) | אל תיישם decay |
| 5 | lookback מספרי | ❌ | 52w / 126d ⚠️ |
| 6 | ספי Volume מספריים ל-zone | ❌ | יחס ל-MA20 — ראה Gap 4 |
| 7 | `distToEntry` — סף מרחק מכניסה | 📄 VHM3p | `DIST_TO_ENTRY_MAX_PCT = 5%` ⚠️ — align L37 WATCH |

---

## 12. מקורות PDF

```
L11: https://cyclestrading-course.com/wp-content/uploads/2023/01/סיכום-שיעור-11-שאלות-ותשובות.pdf
L12: https://cyclestrading-course.com/wp-content/uploads/2023/01/סיכום-שיעור-12-שאלות-ותשובות.pdf
```

**ציטוטים מפתח (L11):**
- "רמות תמיכה והתנגדות הן **אזורים ולא קווים מדויקים**"
- "ככל שרמה נבדקת יותר פעמים, היא נחשבת לחזקה יותר"
- "רמות שנוצרו במחזורי מסחר גבוהים נחשבות משמעותיות יותר"
- "ככל שהטיים פריים גבוה יותר (חודשי > שבועי > יומי), רמות התמיכה וההתנגדות משמעותיות וחזקות יותר"

**ציטוטים מפתח (L12):**
- "במגמת עלייה, רמת תמיכה אינה אמורה להישבר כלפי מטה"
- "למדנו כיצד לזהות הזדמנויות קנייה על רמות תמיכה במגמת עלייה"
- "חשיבות הסבלנות וההמתנה לחזרה מדויקת לרמות ההתנגדות" (שורט)
- "יחס של לפחות 1:2"

---

*מסמך זה מכסה **Gap #1 בלבד**. השלב הבא: `demandZoneEngine.ts` — מימוש לפי פרמטרים לעיל + אינטגרציה ל-War Engine (P1-1).*
