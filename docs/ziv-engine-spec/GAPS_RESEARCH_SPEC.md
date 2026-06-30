# Ziv Engine — Gap Research Spec

**תאריך:** 26 יוני 2026  
**מטרה:** מענה מלא ל-6 פערי ידע לקידוד Ziv Engine  
**מקורות:** PDFs קורס Focus Trader (שיעורים 8–18, 30, 37) + מחקר Elza v2.3 + קוד קיים  
**מסמך מקורות:** [`LESSON_SOURCES.md`](./LESSON_SOURCES.md)

---

## Executive Summary

| Gap | כלל מנוע מרכזי (תמצית) | מקור עיקרי | אמון |
|-----|------------------------|------------|------|
| **1** Demand/Supply zones | אזור = טווח מחיר; חוזק ∝ מגעים + נפח ביצירה; שפלים במגמת עלייה | L11 | ✅ |
| **2** Retest | 5 נרות **אחרי פריצה** (אותו TF); כניסה ב-Limit; R:R≥1:2; FOMO 1.5% = Elza | L14, L37 | ✅ + ⚠️ |
| **3** Sizing + R:R | 1% **ערך תיק**; `qty = risk_usd / SL_distance`; TP מינימום 2R או התנגדות | L12, L17, L37 | ✅ |
| **4** Volume / נמ"ס | נפח פריצה > קודם; תיקון = נפח מתכווץ; שיא+נפח נמוך = אזהרה | L16, L18 | ✅ (+ ⚠️ מכפילים) |
| **5** Weekly + falling knife | מגמה ראשית שבועית; שבירת **שפל אחרון** = סכין נופלת; **trail יציאה** בסגירה שבועית מתחת לשפל | L10 + 📄 BxU, zryV1uyM | ✅ + 📄 |
| **6** Fibonacci | 38.2/50/61.8% משפל→שיא מהלך; **בונוס בלבד**, לא gate | L15 | ✅ |

### ספירת כללים (סה"כ 55 כללי מנוע מפורטים)

| אמון | כמות | % |
|------|------|---|
| ✅ verified (PDF) | **32** | 58% |
| 📄 YouTube / מחקר v3.1 (לא PDF) | **7** | 13% |
| ⚠️ inferred / RECOMMENDED_DEFAULT / Elza ADAPT | **14** | 25% |
| ❌ not in course | **2** | 4% |

**+8 מ-YouTube v3.1 (26/6):** trail שבועי יציאה, `distToEntry`, H&S P2, גרף>חדשות, 4× חוקי ברזל Xeae (1% כבר ב-GAP_3). פירוט: [`YOUTUBE_CATALOG.md`](./YOUTUBE_CATALOG.md) · מחקר §14.4.

**+7 מ-YouTube P0 batch (26/6):** `gnqz24XJUoM` (WK-L/s falling knife), `wm47UxvWH6Q` (שבועי>יומי), `PXJJx9sMu8w` (watchlist+ריטסט), `jTsqfjyn3Zo` (fib extensions scale-out), `TjJBlBdUR24` (MA confluence), `q3Hu3BWVOQM` (המתנה+נפח), `MH-RcExGAAc` (1% NLV ממונף — docs). פירוט: [`YOUTUBE_CATALOG.md`](./YOUTUBE_CATALOG.md) §5–11.

---

## Gap 1: Demand/Supply Zones (Lessons 11–12)

### שאלות → תשובות

| שאלה | תשובה | אמון |
|------|--------|------|
| **איך זיו מגדיר zone אלגוריתמית?** | זיו **לא** נותן pseudocode. הוא מגדיר **אזור מחיר** (לא קו) שבו ביקוש/היצע עצרו את המחיר — במגמת עלייה כל **שפל** הוא תמיכה; בדשדוש — טווח עם **2 מגעים למעלה + 2 למטה** (L10, L13). Elza משלימה: `calcZones` = רצף נרות עם טווח <4% ואז תנועה >3% (consolidation→impulse). | ✅ מושג / ⚠️ אלגוריתם |
| **גבולות zone בדיוק איפה?** | **טווח** `zone.low`–`zone.high` של אזור התכנסות / שפל מבני — **לא** פתיל בודד ולא EMA. SL **מעבר** לרמת התמיכה (L11 מבחן 12). Elza: `min(swingLow, zone.low) − 0.5×ATR14`. | ✅ |
| **כמה מגעים = תקף? ≥2?** | הקורס אומר **מונוטוני**: יותר מגעים = חזק יותר (L11). **מינימום מפורש:** דשדוש = **2+2** מגעים (L10, L13); כניסה בדשדוש בתמיכה = **מגע שלישי** (L13). אין סף "≥2" כללי לכל S/R ב-L11 — Elza מאמצת `MIN_TOUCHES = 2` כסף מעשי. | ✅ (2+2, מגע 3) / ⚠️ (≥2 כללי) |
| **האם zone נחלש אחרי N מגעים?** | **לא.** להפך — יותר בדיקות = **חזק יותר** עד שבירה. חולשה = **שבירת האזור**, לא מספר מגעים. | ✅ |
| **Fresh vs tested — העדפה?** | **לא מוזכר** בקורס. מסקנה: מגע ראשון/שני לרמה **אחרי** פריצה = ריטסט (L14) — זה "בדיקה" רצויה, לא חולשה. | ❌ → ⚠️ prefer `retest_touch_count ≤ 2` for entry quality score |
| **Lookback כמה אחורה?** | **לא מוגדר** בקורס. Elza: `RETEST_LOOKBACK = 30` ימים; `calcZones` על 6 חודשי נתונים; מגמה ראשית ≥4 חודשים (L10). | ❌ → ⚠️ `ZONE_LOOKBACK_DAYS = 126` |
| **מרחק מכניסה — מתי avoid?** | 📄 YouTube `VHM3p-mgMIk`: לא לקנות כשהמחיר **רחוק מאזור כניסה** ברור (דוגמאות: WDC, POLI, ZETA = avoid); מועמדים טובים = pullback לתמיכה במגמה. | 📄 + ⚠️ `DIST_TO_ENTRY_MAX_PCT` |

### Proposed engine rules (pseudocode)

```typescript
// ─── Zone detection (demand) ─────────────────────────────────────
interface DemandZone {
  low: number;
  high: number;
  touchCount: number;
  volumeAtFormation: number;  // avg vol in consolidation window
  timeframe: "weekly" | "daily";
  source: "swing_low" | "consolidation" | "role_reversal";
}

const ZONE_MIN_TOUCHES_CONSOLIDATION = 2;  // per side (L10/L13) ✅
const ZONE_ENTRY_TOUCH_CONSOLIDATION = 3;  // 3rd touch to support (L13) ✅
const ZONE_MAX_RANGE_PCT = 4.0;            // Elza calcZones ⚠️
const ZONE_IMPULSE_MIN_PCT = 3.0;          // move after base ⚠️
const ZONE_PRIORITY_WEIGHT_TOUCHES = 1.0;  // more touches → higher ✅
const ZONE_PRIORITY_WEIGHT_VOLUME = 0.5;   // high vol at formation ✅

function detectDemandZones(bars: Bar[], tf: "weekly" | "daily"): DemandZone[] {
  // 1. Swing lows in uptrend (each low = support per L11) ✅
  // 2. Consolidation boxes: range < ZONE_MAX_RANGE_PCT, then impulse > ZONE_IMPULSE_MIN_PCT ⚠️
  // 3. Role-reversal level from broken resistance (L11 §4) ✅
  // Dedupe overlapping zones; rank by touchCount + volumeAtFormation
}

function isPriceInZone(price: number, zone: DemandZone, bufferPct = 2.0): boolean {
  return price >= zone.low * (1 - bufferPct/100)
      && price <= zone.high * (1 + bufferPct/100);
}

// SL: beyond zone (L11) ✅
const SL_BUFFER_ATR_MULT = 0.5;  // Elza slCalculator ⚠️
// sl = zone.low - SL_BUFFER_ATR_MULT * atr14
```

### מימוש קיים vs פער

| פרמטר | קוד היום | פער |
|--------|----------|-----|
| `calcZones` | `tradeManager.ts` — consolidation heuristic | לא ב-War Engine |
| `demandZoneEngine` | לא קיים | P1 — צריך שער D1 |
| חוזק מגעים | לא מחושב | P1 `zonePriority` |

### Open questions

1. האם לאחד `calcZones` עם swing pivots (lookback 5) ל-zone אחד? — **המלצה:** שכבה אחת `demandZoneEngine` עם מקורות מרובים.
2. האם weekly zone גובר על daily? — **כן** per L11 TF hierarchy ✅.

---

## Gap 2: Retest Mechanics (Lesson 14)

### שאלות → תשובות

| שאלה | תשובה | אמון |
|------|--------|------|
| **"5 candles after breakout" — 5 נרות של מה?** | **5 נרות באותו timeframe של הגרף** שבו נבדקת הפריצה — יומי = 5 ימים, שבועי = 5 שבועות (L14 §2). **לא** 5 נרות דשדוש. המשמעות: **אישור שהפריצה אמיתית** לפני שמחכים לריטסט. | ✅ |
| **מה מאשר שהריטסט מחזיק?** | (א) פריצה אושרה ב-5 נרות; (ב) מחיר חוזר לרמה שנפרצה (±סבילות); (ג) מחיר **מחזיק מעל** הרמה (שפל חדש / סגירה מעל); (ד) כניסה ב-**Limit** לא ב-market (L14 מבחן 16). נר אישור (Hammer/Engulf) — 📄 Elza, לא ב-PDF 14. | ✅ + ⚠️ |
| **FOMO 1.5% — מדוד מאיפה?** | **לא בקורס.** Elza: `GAP_GUARD_PCT = 1.5%` מעל `signalPrice` / רמת כניסה (`gapGuard.ts`). L37: כניסה **0.5–1% מעל** תמיכה (מותר), התראה **2% לפני** כניסה, **5%** לצפייה — אלו לא חסימת FOMO. | ⚠️ Elza |
| **Limit בדיוק באיזה מחיר?** | `entry = support_level × (1 + ENTRY_OFFSET_PCT)` כאשר `ENTRY_OFFSET_PCT ∈ [0.005, 0.01]` (L37). בדשדוש: limit **מעט לפני** התמיכה כדי לא לפספס (L13). ריטסט לרמת פריצה: limit **באזור הרמה** (±`RETEST_TOLERANCE_PCT`). | ✅ |

### Proposed engine rules

```typescript
const RETEST_CONFIRM_CANDLES = 5;        // L14 ✅ — same TF as chart
const RETEST_TOLERANCE_PCT = 2.0;          // Elza/trueRetestEngine ✅ (derived)
const RETEST_LOOKBACK_DAYS = 30;           // ⚠️ RECOMMENDED_DEFAULT
const ENTRY_OFFSET_PCT_MIN = 0.5;          // L37 ✅
const ENTRY_OFFSET_PCT_MAX = 1.0;          // L37 ✅
const GAP_GUARD_PCT = 1.5;                 // ⚠️ Elza only — block chase above entry
const ORDER_TYPE_RETEST = "LIMIT";         // L14 ✅

function confirmBreakout(bars: Bar[], level: number, tf: TF): boolean {
  const postBreak = barsAfterCloseAbove(level);
  return postBreak.length >= RETEST_CONFIRM_CANDLES
      && postBreak.every(b => b.close >= level * (1 - RETEST_TOLERANCE_PCT/100));
}

function retestEntryPrice(level: number, side: "long"): number {
  // Long at broken resistance-now-support:
  return level * (1 + ENTRY_OFFSET_PCT_MIN/100);  // L37: slightly above support
}

function passesGapGuard(signalPrice: number, livePrice: number): boolean {
  return ((livePrice - signalPrice) / signalPrice) * 100 <= GAP_GUARD_PCT;
}

// distToEntry — VHM3p-mgMIk 📄 + ⚠️ threshold
const DIST_TO_ENTRY_MAX_PCT = 5.0;  // align L37 WATCH_ALERT; block if price not in/near zone

function passesDistToEntry(livePrice: number, zone: { low: number; high: number }): boolean {
  const mid = (zone.low + zone.high) / 2;
  const distPct = Math.abs(livePrice - mid) / mid * 100;
  return distPct <= DIST_TO_ENTRY_MAX_PCT;
}

// Chart > news — eTVqiCxolTY 📄 (psychology gate, not numeric)
// BLOCK entry driven by headlines/FOMO without pullback to demand; TSLA -72% on news example
```

### מימוש קיים

```16:18:server/trueRetestEngine.ts
export const RETEST_LOOKBACK = 30;
export const RETEST_TOLERANCE_PCT = 2.0;
export const RETEST_CONFIRM_CANDLES = 5;
```

`zivEngine.ts` — Tier 3 דורש `detectTrueRetest` או `detectRoleReversal` ✅ (P0-3 ממומש).

### Open questions

1. האם 5 הנרות חייבים להישאר **מעל** הרמה או רק להתקיים **אחרי** הפריצה לפני הריטסט? — PDF: "לאחר פריצה" + אישור איכות; Elza מחמיר: 5 **סגירות** מעל floor ✅ מומלץ.
2. שבועי vs יומי לריטסט — מגמה ראשית **שבועי** (L14); אישור כניסה יומי (נפח יבש) per תמלול YouTube 📄.

---

## Gap 3: Sizing 1% + R:R (Lesson 17)

### שאלות → תשובות

| שאלה | תשובה | אמון |
|------|--------|------|
| **1% של מה?** | **1% מערך התיק (portfolio value / NLV)** — לא מזומן פנוי בלבד (L17). דוגמה: תיק $10,000 → יחידת סיכון $100. | ✅ |
| **נוסחת position size** | `risk_usd = portfolio_value × 0.01`; `shares = floor(risk_usd / |entry − stop_loss|)` (L12, L14, L17). אם SL נפגע → הפסד = בדיוק יחידת הסיכון. | ✅ |
| **R:R ≥ 1:2 — איך נמדד?** | `reward_distance / risk_distance ≥ 2` כאשר `risk_distance = |entry − SL|`, `reward_distance` = מרחק ל-**התנגדות/שיא הבא** (מבני, L37) **או** מינימום `2 × risk_distance` (L12, L14, L17). **לא** TP קבוע 2R בלבד אם יש התנגדות קרובה יותר — אז **לא נכנסים** (L37 דוגמה 10% SL → צריך 20% פוטנציאל). | ✅ |
| **מקס פוזיציות / סיכון מצטבר?** | L37: **מקס 15 מניות** בתיק. אין כלל מפורש ל-"מקס 5% תיק סיכון פתוח" — תיאורטית 15×1% = 15% אם כולן ב-SL (לא ריאלי). Elza: 12 לונג + 6 שורט slots — **ADAPT**, לא זיו ישיר. | ✅ (15) / ⚠️ (aggregate) |
| **חוקי ברזל (תהליך)** | 📄 `Xeae10txdI8`: (1) **סטאפ אחד** — ביצוע עקבי; (2) 1% NLV — מאושר L17; (3) **סבלנות** — מעקב שבועי, לא מסך יומי; (4) **מערכת מוגדרת** מראש; (5) עדיף FOMO על כניסה מאשר כאב על פוזיציה רעה | 📄 (1,3–5); ✅ (2) |

### Proposed engine rules

```typescript
const RISK_UNIT_PCT = 0.01;              // L17 ✅ — fixed, never increase after wins
const MIN_RR = 2.0;                        // L12/L17 ✅ — reward >= 2 * risk
const MAX_CONCURRENT_POSITIONS = 15;       // L37 ✅
const SCALE_OUT_TP1_R = 2.0;               // L37 partial at 2R ✅ (Elza slCalculator)
const SCALE_OUT_SELL_FRAC = 0.50;          // L37 ✅
// Weekly trail exit — BxU, zryV1uyM-jg 📄 (complements L37 trail; exit on structure, not %-TP)
const WEEKLY_TRAIL_EXIT_ON_SWING_LOW = true;  // full/partial exit when W1 close < lastSwingLow

function calcPositionSize(portfolioNlv: number, entry: number, stopLoss: number): number {
  const riskUsd = portfolioNlv * RISK_UNIT_PCT;
  const riskPerShare = Math.abs(entry - stopLoss);
  if (riskPerShare <= 0) return 0;
  return Math.floor(riskUsd / riskPerShare);
}

function calcTakeProfit(entry: number, stopLoss: number, nextResistance: number): number {
  const r = Math.abs(entry - stopLoss);
  const minTp = entry + MIN_RR * r;  // long
  const structuralTp = nextResistance;
  // Gate: skip trade if structuralTp < minTp (L37)
  return Math.max(minTp, structuralTp);  // Approach B: at least 2R, prefer structure
}
```

### מימוש קיים vs פער

| | זיו | Elza Live |
|--|-----|-----------|
| Sizing | 1% risk-based | **Slot pool** 12/6 ⚠️ ADAPT |
| `SCALE_OUT_TP1_R` | 2R (L37) | `slCalculator.ts` = **2.0** ✅ |
| `MIN_RR` gate | לפני כניסה | War Engine — חלקי |

### Open questions

1. האם לאפשר Elza slot + cap 1% risk per trade במקביל? — **המלצה:** שכבת `maxRiskUsd` מעל slot.
2. תיק TASE ב-₪ — אותה לוגיקה 1% מערך תיק ✅.

---

## Gap 4: Volume / נמ"ס (Lessons 16, 18)

### שאלות → תשובות

| שאלה | תשובה | אמון |
|------|--------|------|
| **"High volume" בפריצה = כמה × ממוצע?** | L16: נפח נר הפריצה **גבוה מהנרות שקדמו** (יחסי). L18: שיא חדש צריך נפח **גבוה מהשיא הקודם** (השוואה לשיא קודם, לא MA20). **אין** 1.5× או 2× בקורס. | ✅ יחסי / ❌ מכפילה |
| **"Dry volume" בריטסט** | L18: בתיקון במגמת עלייה נפח **חייב להתכווץ** (מימוש רווחים בריא). אין סף 0.85 — Elza: `volumeRatio = avg(vol5)/avg(vol20) < 0.85` ⚠️. | ✅ איכותני / ⚠️ מספרי |
| **נפח גבוה בירידות = אזהרה** | L18: שפל חדש **אמור** נפח גבוה; שפל+נפח **נמוך** = מוכרים מתוששים → היפוך אפשרי. ירידה עם נפח גבוה במגמת עלייה (תיקון) = **לא** אזהרה — להפך תיקון צריך נפח נמוך. אזהרה לונג: **שיא** חדש בנפח **נמוך** מהשיא הקודם. | ✅ |
| **ראש וכתפיים** | 📄 `ZeT5NIR8a-g`: תבנית **היפוך מגמה** — נפח **מתכווץ** בעלייה, **גבוה** בירידה. **P2 אזהרה בלבד** — לא gate כניסה (כמו פיבו). | 📄 |

### נמ"ס (L16) — gate לפריצה

| אות | כלל | אמון |
|-----|------|------|
| **נ** | נר בריא: ≥**50%** גוף הנר מעל (לונג) / מתחת (שורט) לרמה | ✅ |
| **מ** | מחזור גבוה בנר הפריצה vs נרות קודמים | ✅ |
| **ס** | סגירה קרובה לגבוה (לונג) / לשפל (שורט) | ✅ |

### Proposed engine rules

```typescript
// ─── Breakout (נמ"ס) ─────────────────────────────────────────────
function passesNemes(bar: Bar, level: number, priorBars: Bar[], side: "long"): boolean {
  const bodyAbove = side === "long"
    ? (Math.min(bar.open, bar.close) - level) / (bar.high - bar.low) >= 0.5  // half above ✅
    : (level - Math.max(bar.open, bar.close)) / (bar.high - bar.low) >= 0.5;
  const volOk = bar.volume > Math.max(...priorBars.map(b => b.volume ?? 0));  // ✅
  const closeNearExtreme = side === "long"
    ? (bar.high - bar.close) / (bar.high - bar.low) < 0.25   // ⚠️ RECOMMENDED_DEFAULT
    : (bar.close - bar.low) / (bar.high - bar.low) < 0.25;
  return bodyAbove && volOk && closeNearExtreme;
}

// ─── Volume cycle (L18) ──────────────────────────────────────────
const VOLUME_RATIO_DRY = 0.85;       // ⚠️ Elza — pullback confirmation
const VOLUME_RATIO_HIGH = 1.5;       // ⚠️ Elza — breakout / CYC-S1
const MIN_AVG_VOLUME_US = 1_000_000;  // L18 ✅ shares/day
const MIN_AVG_VOLUME_TASE_ILS = 500_000; // L18 ✅ ₪/day

function volumeRatio5vs20(bars: Bar[]): number {
  const v5 = avg(bars.slice(-5).map(b => b.volume));
  const v20 = avg(bars.slice(-20).map(b => b.volume));
  return v20 > 0 ? v5 / v20 : 1;
}

// CYC-L1: new high + vol < prior high vol → weakness ✅ L18
function isVolumeDivergenceAtHigh(bars: Bar[]): boolean { /* compare last 2 swing highs */ }
```

### מימוש קיים

`cyclePhaseEngine.ts`: `LOW_VOL_RATIO = 0.85`, `HIGH_VOL_RATIO = 1.5` ⚠️  
`breakoutScanner.ts`: `VOLUME_RATIO_MIN = 1.2` detect, BO2 `≥ 1.5` ⚠️

### Open questions

1. האם לאמץ מכפילה 1.5× כ-Elza או להישאר יחסי לנר קודם בלבד? — **המלצה:** שני שכבות — נמ"ס (יחסי) **וחובה**; בונוס אם `vol > 1.5× MA20`.
2. `avg(vol5)/avg(vol20)` vs נפח נר בודד בפריצה — L16/L18 משתמשים בשניהם; שמור שניהם.

---

## Gap 5: Weekly Filter + Falling Knife (Lessons 10, 13)

### שאלות → תשובות

| שאלה | תשובה | אמון |
|------|--------|------|
| **Weekly bullish/bearish בדיוק?** | **מגמת עלייה ראשית:** סדרה של שיאים עולים + שפלים עולים (או 2 שפלים עולים + 2 שיאים עולים) על גרף **שבועי/חודשי** (L10). **דשדוש:** 2 מגעים ברמה עליונה + 2 בתחתונה — **אין כניסת מגמה** (L10, L14 מבחן 3: ריטסט רק במגמה ראשית עולה). Elza proxy: `weeklySlopePct > 0.2%` + `close > EMA50w` ⚠️. | ✅ מבני / ⚠️ EMA |
| **זיהוי consolidation (L13)?** | L13 מרחיב L10: **2 נגיעות** באותה רמת מחיר עליונה + **2** בתחתונה; מגמה קודמת משפיעה על כיוון הפריצה הצפוי; כניסה לונג בתמיכה במגע **שלישי**; עסקאות דשדוש לריטסט — **רק בקצוות** (L14 Q19). | ✅ |
| **"Falling knife" — מתי מבנה שבועי נשבר?** | שבירת **שפל אחרון** במגמת עלייה ראשית (שבועי/חודשי) = שינוי מגמה ראשית → **לא נוגעים בלונג** (L10 §שינוי מגמה; YouTube "סכין נופלת" 📄). לא "שפל יומי" בלבד. | ✅ שבועי / ⚠️ מינוח "סכין" |
| **Trail יציאה שבועי (מנצחות)** | 📄 `BxU463WI14M`, `zryV1uyM-jg`, `gnqz24XJUoM`: יציאה כש**סגירה שבועית** מתחת ל**שפל שבועי אחרון** — לא TP אחוזי קרוב; מימוש 50% ב-2R+ או בהתנגדות. משלים L37 trail 2% מתחת לשפל. | 📄 |
| **שבועי לפני יומי** | 📄 `wm47UxvWH6Q`, `gnqz24XJUoM`: מגמה/אזורים מ-**W1**; יומי לתזמון כניסה בלבד כשמחיר נוגע באזור שבועי | 📄 |

### Proposed engine rules

```typescript
const PRIMARY_TF = "weekly";
const PRIMARY_TURNING_POINT_MIN_MONTHS = 4;  // L10 ✅

type PrimaryTrend = "BULL" | "BEAR" | "CONSOLIDATION" | "UNKNOWN";

function classifyPrimaryTrend(weeklyBars: Bar[]): PrimaryTrend {
  const highs = swingHighs(weeklyBars);
  const lows = swingLows(weeklyBars);
  if (isHigherHighsHigherLows(highs, lows)) return "BULL";       // L10 ✅
  if (isLowerHighsLowerLows(highs, lows)) return "BEAR";
  if (hasTwoTouches(highs, 2) && hasTwoTouches(lows, 2)) return "CONSOLIDATION"; // L10/L13 ✅
  return "UNKNOWN";
}

function isFallingKnife(weeklyBars: Bar[], lastSwingLow: number): boolean {
  const close = weeklyBars.at(-1)!.close;
  return close < lastSwingLow;  // broke last weekly swing low → primary trend broken ✅ L10
}

// Weekly trail EXIT (open long) — BxU, zryV1uyM-jg, gnqz24XJUoM 📄
function weeklyTrailExitSignal(weeklyBars: Bar[], lastSwingLow: number): boolean {
  return weeklyBars.at(-1)!.close < lastSwingLow;  // W1 close below last swing low → exit review
}

// Weekly anchor: demand zones + trend from W1; D1 only for fill timing 📄 wm47UxvWH6Q
const WEEKLY_ANCHOR_ENTRY = true;  // structural gates use weekly; daily subordinate

// Breakout trust: hold N weeks above broken resistance before trusting 📄 PXJJx9sMu8w
const BREAKOUT_HOLD_WEEKS = 4;  // ⚠️ RECOMMENDED_DEFAULT (RDDT case: 4–5w)

// Elza WK-L proxy (when structural parse unavailable) ⚠️
const WEEKLY_SLOPE_BULL_MIN_PCT = 0.2;
const WEEKLY_SLOPE_BEAR_MAX_PCT = -0.2;

function weeklyBullishProxy(weeklyBars: Bar[]): boolean {
  return weeklyEma50Slope(weeklyBars) > WEEKLY_SLOPE_BULL_MIN_PCT
      && weeklyClose(weeklyBars) > weeklyEma50(weeklyBars);
}
```

### Gate matrix

| מצב שבועי | לונג | שורט |
|-----------|------|------|
| BULL (HH/HL) | ✅ מותר (אם שאר gates) | ❌ |
| BEAR (LH/LL) | ❌ falling knife | ✅ |
| CONSOLIDATION | ❌ / רק קצוות דשדוש (L13/14) | ❌ |
| UNKNOWN | ❌ | ❌ |

### Open questions

1. האם `CONSOLIDATION` חוסם לחלוטין או רק מצמצם ל-range trades? — L14: ריטסט דורש מגמה ראשית — **חסום** לריטסט; L13: range OK בקצוות בלבד.

---

## Gap 6: Fibonacci (Lesson 15)

### שאלות → תשובות

| שאלה | תשובה | אמון |
|------|--------|------|
| **רמות מדויקות?** | **38.2%, 50%, 61.8%** (L15). יחסי זהב: 61.8% = מספר/הבא, 38.2% = מספר/שני אחריו. | ✅ |
| **נמתח מאיפה?** | משפל לשיא **של המהלך האחרון** (מגמה משנית נגדית) — לא מהשיא/שפל מוחלטים (L15). | ✅ |
| **בונוס או gate?** | **בונוס / confluence בלבד** — "מתווסף לארגז הכלים", לשלב עם S/R (L15). **לא** gate כניסה. **לא** TP ראשי (L37: TP מבני/trail). | ✅ |
| **Extensions (ATH)** | 📄 `jTsqfjyn3Zo`: Trend-Based Fib **Extension** — רמות **1.0, 1.272, 1.618, 2.0, 2.618** ל**מימוש חלקי / הידוק SL** במנצחת בשיא; **לא** gate כניסה | 📄 |
| **Golden zone?** | תיקון בריא **38.2%–61.8%** = האזור המקביל ל-"golden zone" — לא נקרא כך בקורס. | ✅ (טווח) / ⚠️ (שם) |
| **כשל שוק** | תיקון לפיבו אך מחיר **לא עובר שיא קודם** (לונג) → שינוי מגמה אפשרי — penalty / BLOCK (L15). | ✅ |

### Proposed engine rules

```typescript
const FIB_LEVELS = [0.382, 0.50, 0.618];
const FIB_HEALTHY_MIN = 0.382;   // L15 ✅
const FIB_HEALTHY_MAX = 0.618;   // L15 ✅
const FIB_CONFLUENCE_TOLERANCE_PCT = 2.0;  // ⚠️ align with RETEST_TOLERANCE

// Extensions (jTsqfjyn3Zo 📄) — PARTIAL_EXIT_ONLY, never entry gate
const FIB_EXTENSION_LEVELS = [1.0, 1.272, 1.618, 2.0, 2.618];
const FIB_EXTENSION_PARTIAL_EXIT_ONLY = true;

function calcFibLevels(swingLow: number, swingHigh: number): Record<string, number> {
  const range = swingHigh - swingLow;
  return { "38.2": swingHigh - range * 0.382, "50": swingHigh - range * 0.5, "61.8": swingHigh - range * 0.618 };
}

function fibConfluenceBonus(price: number, zone: DemandZone, fibLevels: number[]): number {
  // BONUS_ONLY — never block entry ✅
  let bonus = 0;
  for (const fib of fibLevels) {
    if (Math.abs(price - fib) / fib * 100 <= FIB_CONFLUENCE_TOLERANCE_PCT
        && isPriceInZone(price, zone)) bonus += 0.5;
  }
  return Math.min(bonus, 1.0);
}

// Market failure (L15) ✅
function isMarketFailureLong(pullbackLow: number, priorHigh: number, priceFailedToBreakHigh: boolean): boolean {
  return priceFailedToBreakHigh; // corrected but no new HH
}
```

### Torah confirmation

> פיבו = **בונוס בלבד** per החלטה 8 (מחקר v2.3 מאושר). אין gate כניסה. אין TP אחוזי מפיבו.

---

## Master Parameter Table

| Parameter | Value | Unit | Source | Conf |
|-----------|-------|------|--------|------|
| `RISK_UNIT_PCT` | 1.0 | % of portfolio NLV | L17 | ✅ |
| `MIN_RR` | 2.0 | reward/risk | L12, L14, L17 | ✅ |
| `RETEST_CONFIRM_CANDLES` | 5 | bars (same TF) | L14 | ✅ |
| `RETEST_TOLERANCE_PCT` | 2.0 | % | Elza/trueRetest | ⚠️ |
| `RETEST_LOOKBACK_DAYS` | 30 | days | Elza | ⚠️ |
| `ENTRY_OFFSET_PCT` | 0.5–1.0 | % above support | L37 | ✅ |
| `GAP_GUARD_PCT` | 1.5 | % above entry zone | Elza | ⚠️ |
| `DIST_TO_ENTRY_MAX_PCT` | 5.0 | % from zone mid | VHM3p 📄 | ⚠️ |
| `CHART_OVER_NEWS` | true | block headline-chase entries | eTVqi 📄 | 📄 |
| `WEEKLY_TRAIL_EXIT` | W1 close < lastSwingLow | exit signal | BxU, zryV1uyM, gnqz24 📄 | 📄 |
| `WEEKLY_ANCHOR_ENTRY` | true | W1 zones/trend; D1 timing only | wm47UxvWH6Q 📄 | 📄 |
| `BREAKOUT_HOLD_WEEKS` | 4 | weeks above resistance | PXJJx9sMu8w 📄 | ⚠️ |
| `FIB_EXTENSION_LEVELS` | 1.0, 1.272, 1.618, 2.0, 2.618 | scale-out hints | jTsqfjyn3Zo 📄 | 📄 |
| `FIB_EXTENSION_PARTIAL_EXIT_ONLY` | true | not entry gate | jTsqfjyn3Zo 📄 | 📄 |
| `MA_AS_ENTRY_GATE` | false | MA confluence only | TjJBlBdUR24 📄 | 📄 |
| `HNS_P2_WARNING_ONLY` | true | reversal pattern = warn | ZeT5NIR8a-g 📄 | 📄 |
| `ORDER_TYPE_RETEST` | LIMIT | — | L14 | ✅ |
| `ZONE_MIN_TOUCHES` | 2 | per side (range) | L10, L13 | ✅ |
| `ZONE_ENTRY_TOUCH` | 3 | at support | L13 | ✅ |
| `ZONE_MAX_RANGE_PCT` | 4.0 | % consolidation | Elza calcZones | ⚠️ |
| `SL_WEEKLY_PCT_RANGE` | 10–25 | % | L12 | ✅ |
| `SL_DAILY_PCT_RANGE` | 5–10 | % | L12 | ✅ |
| `SL_ATR_BUFFER_MULT` | 0.5 | × ATR14 | Elza | ⚠️ |
| `VOLUME_RATIO_DRY` | 0.85 | 5d/20d | Elza | ⚠️ |
| `VOLUME_RATIO_HIGH` | 1.5 | 5d/20d | Elza | ⚠️ |
| `MIN_AVG_VOLUME_US` | 1,000,000 | shares/day | L18 | ✅ |
| `MIN_AVG_VOLUME_TASE` | 500,000 | ₪/day | L18 | ✅ |
| `BREAKOUT_ALERT_PCT` | 2.0 | % above high | L16 | ✅ |
| `NEMES_MIN_BODY_PCT` | 50 | % of candle above level | L16 | ✅ |
| `PRIMARY_TURNING_POINT_MIN` | 4 | months | L10 | ✅ |
| `MAX_POSITIONS` | 15 | tickers | L37 | ✅ |
| `SCALE_OUT_TP1_R` | 2.0 | R | L37 | ✅ |
| `SCALE_OUT_SELL_FRAC` | 0.50 | fraction | L37 | ✅ |
| `FIB_LEVELS` | 38.2, 50, 61.8 | % of move | L15 | ✅ |
| `FIB_HEALTHY_RANGE` | 38.2–61.8 | % retrace | L15 | ✅ |
| `WEEKLY_SLOPE_BULL_MIN_PCT` | 0.2 | % | Elza WK-L | ⚠️ |
| `WATCH_ALERT_PCT` | 5.0 | % from entry | L37 | ✅ |
| `PRE_ENTRY_ALERT_PCT` | 2.0 | % from entry | L37 | ✅ |

---

## Implementation Priority (P0/P1/P2) for Elza

### P0 — חובה לפני כניסות aligned

| ID | משימה | קובץ | כלל זיו |
|----|--------|------|---------|
| P0-1 | True Retest — 5 נרות + רמה (לא EMA) | `trueRetestEngine.ts` ✅ | L14 |
| P0-2 | Role Reversal | `roleReversalEngine.ts` ✅ | L11 |
| P0-3 | Gap Guard 1.5% ב-Live | `liveOrderExecutor.ts` | ⚠️ Elza |
| P0-4 | MIN_RR 2.0 gate לפני `tryLiveEntry` | `warEngine.ts` | L17 |
| P0-5 | WK-L structural / proxy | `runtimeIntelligence.ts` | L10 |
| P0-6 | נמ"ס לפריצה | `warEngine.ts` BO gates | L16 |
| P0-7 | Falling knife — BLOCK לונג | `warEngine.ts` | L10 |

### P1 — שלמות zones + volume

| ID | משימה | כלל |
|----|--------|------|
| P1-1 | `demandZoneEngine` — touch count + vol | L11 |
| P1-2 | `volumeRatio < 0.85` gate לריטסט | L18 + ⚠️ |
| P1-3 | `SCALE_OUT` 2R אימות ב-production | L37 |
| P1-4 | נזילות 1M US | L18 |
| P1-5 | `zonePriority` scoring | L11 |

### P2 — confluence

| ID | משימה | כלל |
|----|--------|------|
| P2-1 | Fib confluence bonus | L15 |
| P2-2 | RSI oversold bonus (לא gate) | YouTube |
| P2-3 | Market failure penalty | L15 |
| P2-4 | קו מגמה 3 מגעים — bonus | L11 |
| P2-5 | Head & Shoulders — P2 warning (vol divergence) | ZeT5NIR8a-g 📄 |
| P2-6 | Fib extension scale-out hints (1.0/1.618) | jTsqfjyn3Zo 📄 |
| P2-7 | MA far-from-price avoid (mean reversion) | TjJBlBdUR24 📄 |
| P1-6 | `distToEntry` filter — avoid far from zone | VHM3p 📄 |
| P1-7 | Weekly trail exit on W1 close < swing low | BxU, zryV1uyM 📄 |

---

## נספח: סיכום מימוש קוד (26 יוני 2026)

| מודול | מצב | הערה |
|--------|------|------|
| `trueRetestEngine.ts` | ✅ 5 נרות, 2%, 30d lookback | תואם L14 |
| `roleReversalEngine.ts` | ✅ V1/V2 | תואם L11 |
| `zivEngine.ts` Tier 3 | ✅ דורש structural retest | P0-3 done |
| `gapGuard.ts` | ✅ 1.5% | ⚠️ לא בקורס |
| `cyclePhaseEngine.ts` | ✅ 0.85/1.5 | ⚠️ מכפילים Elza |
| `calcZones` | ⚠️ קיים, לא ב-War | P1 |
| `slCalculator` SCALE_OUT 2R | ✅ | L37 |
| Slot sizing 12/6 | ⚠️ | לא 1% זיו — ADAPT |
| `demandZoneEngine` | ❌ חסר | P1 |
| Fib engine | ❌ חסר | P2 |
| נמ"ס breakout validator | ❌ חלקי | P0 |

---

*נוצר לקידוד Ziv Engine. לכללים עם ⚠️ — סמן `RECOMMENDED_DEFAULT` בקוד עד אישור משתמש.*
