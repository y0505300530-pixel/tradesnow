# GAP #3 — Sizing 1% + R:R (שיעורים 12, 17, 37)

**מסמך:** `GAP_03_SIZING_RR.md`  
**תאריך:** 26 יוני 2026  
**Scope:** Ziv Focus Trader — position sizing, risk unit, R:R gate, portfolio caps  
**מקורות:** שיעור 12 PDF ✅ · שיעור 37 PDF ✅ · שיעור 17 📄 (סיכום מחקר v2.3 — PDF לא נגיש ב-URL ציבורי) · `slCalculator.ts` · מסמכי מתודולוגיה

**מקרא:** ✅ מאומת ישירות · 📄 מסוכם במחקר / לא PDF מלא · ⚠️ פער מול קוד Elza

---

## 1. תמצית מנהלים | Executive summary

| נושא | זיו (קורס) | Elza היום | סטטוס |
|------|------------|-----------|--------|
| **1% ממה?** | **שווי החשבון / ערך התיק** (NLV) — לא מזומן בלבד | Live: סלוט קבוע + conviction USD band | ⚠️ מודל שונה |
| **גודל פוזיציה** | `shares = (NLV×1%) / R` כאשר `R = \|entry − SL\`` | `recommendedPositionSize(score)` + pool/slots | ⚠️ |
| **R:R מינימום** | **1:2** לפני כניסה — בדיקה **מבנית** להתנגדות/תמיכה | `slCalculator`: TP = 2.5–3R (swing) / 5R (intraday); validator רק ≥1:1 | ⚠️ gate 1:2 חסר ב-Live |
| **TP** | התנגדות/שיא הבא; מינימום 2R; **לא** TP קרוב במערכת | Bracket TP מחושב; scale-out 50% @ **2R** | ✅ חלקי (2R scale-out) |
| **מקס פוזיציות** | **15** מניות (שליטה) | 12 לונג + 6 שורט = **18** | ⚠️ |
| **סיכון מצטבר** | משתמע: עד ~15% NLV אם כל ה-SL נתפסים (15×1%) | daily loss breaker, deployed gross cap, correlation | ⚠️ לא 1%-per-slot |

---

## 2. שיעור 12 — תמיכה/התנגדות + גודל עסקה

**מקור:** `docs/lesson-12/pdf-extracted.txt` (PDF רשמי) ✅

### 2.1 כללי זיו (עברית)

| # | כלל | ציטוט / תוכן |
|---|-----|--------------|
| L12-1 | **סיכון לעסקה** | עד **1% משווי החשבון** לכל עסקה |
| L12-2 | **גודל פוזיציה** | נגזר מ-(א) הסכום שמוכנים לסכן מהתיק **ו**(ב) **מרחק SL מנקודת הכניסה** |
| L12-3 | **R:R מינימום** | לפחות **1:2** — לכל $1 סיכון, לפחות $2 רווח פוטנציאלי |
| L12-4 | **TP ראשוני** | לפחות **פי 2** ממרחק ה-SL (מבחן #8 במבחן) |
| L12-5 | **SL לפי TF** | שבועי 10–25%, יומי 5–10%, 4ש 0.5–5%, שעתי 0.5–2% (+ ATR) |
| L12-6 | **ניהול** | SL/TP מוזנים **מראש** — בלי החלטות רגשיות |
| L12-7 | **כלי** | סרגל עסקה ב-TradingView — חישוב גודל לפי תיק וסיכון |

### 2.2 Ziv rules (English)

- Risk **≤ 1% of account value** per trade (quiz answer: B — "up to 1%").
- Position size = f(**risk budget from portfolio**, **stop distance**).
- Minimum reward:risk **1:2** before entry; initial take-profit at least **2×** stop distance.
- Stop placement is timeframe- and ATR-aware (weekly swings are wider % than daily).

---

## 3. שיעור 17 — Risk/Reward + ניהול פוזיציה

**מקור:** `2026-06-24-ziv-methodology-research.md` §11.7 📄  
*(ניסיון fetch ל-PDF ב-`/wp-content/uploads/2023/01/` ו-`/2023/02/` — 404/timeout; תוכן מסוכם מחומרי הקורס שנסרקו ב-v2.2)*

### 3.1 כללי זיו (עברית)

| # | כלל |
|---|-----|
| L17-1 | **יחידת סיכון קבועה:** **1%** מערך התיק — **לא משנים** אחרי רצף רווחים |
| L17-2 | **R:R מינימום 1:2** — **בלי זה לא נכנסים** |
| L17-3 | רווחיות אפשרית גם ב-**win rate < 50%** (מתמטיקת R:R) |
| L17-4 | **ריטסט עדיף על פריצה** ל-R (דוגמת NEO: ריטסט ~77R vs פריצה ~30R) |
| L17-5 | **פארטו 80/20** — 20% העסקאות = 80% הרווח; **לתת לרווחים לרוץ** |
| L17-6 | **Trail** — להעלות SL ככל שהמחיר מתקדם לטובתנו |

### 3.2 Ziv rules (English)

- Fixed **1% portfolio risk unit** — do not increase size after a winning streak.
- **No entry** unless potential reward ≥ **2×** per-share risk (R).
- Favor retest entries (tighter R, larger multiple) over chase breakouts.
- Let winners run; trail stop under rising structure.

### 3.3 דוגמת זיו ל-1% (מחקר ציבורי + שיעור 37)

> "אני לוקח 10,000 ₪. הסטופ 10%. אם הפסדתי 10% = 1,000 ₪ = **1% מהתיק** של 100,000 ₪"

**מסקנה:** 1% = **הפסד מקסימלי לתיק** אם ה-SL נתפס — **לא** 1% מהפוזיציה.

---

## 4. שיעור 37 — workflow + caps

**מקור:** PDF `סדר-פעולות-לאיתור-ביצוע-וניהול-עסקה-1.pdf` (חומרי עזר, `/2023/02/`) ✅

### 4.1 ביצוע — sizing + R:R

| שלב | כלל |
|-----|------|
| כניסה | 0.5–1% **מעל** תמיכה; SL שבועי (שיעור 12) |
| **R:R לפני כניסה** | בגרף שבועי: **אין התנגדות קרובה** שמונעת RR≥1:2 |
| דוגמה | מרחק כניסה→SL = **10%** → רווח פוטנציאלי להתנגדות ≥ **20%**; אחרת **מוותרים** |
| **יחידת סיכון** | גם אם SL = 10% על המניה → **הפסד לתיק = 1% בלבד** (שיעור 17) |
| כמות מניות | "כמות המניות הנכונה" לפי **גודל חשבון ביחס לסטופ וליחידת הסיכון** (מבחן #16) |
| TP במערכת | **לא** TP קרוב — או לא להזין / מחיר **מרוחק** (לא לצאת מוקדם) |

### 4.2 ניהול — R multiples + התנגדות

| כלל | פירוט |
|-----|--------|
| **מינימום לפני סגירה מלאה** | **2 יחידות רווח (2R)** — אלא אם דוחות קרובים |
| **יציאה חלקית** | **50%** ברמת **התנגדות משמעותית** + volume לא עולה בעליות |
| **Trail שבועי** | SL **2%** מתחת לשפל שבועי חדש (L37) |
| **Trail יציאה (YouTube)** | 📄 `BxU463WI14M`, `zryV1uyM-jg`: **סגירה שבועית** מתחת ל**שפל שבועי אחרון** → יציאה (לא TP אחוזי קרוב); תיקון 20–40% במגמה = לגיטימי |
| **מקס פוזיציות** | **לכל היותר 15 מניות** בתיק — "כדי שנוכל לשלוט על הכל" |
| **מסך** | להימנע מצמודות למסך — מונע טעויות רגשיות |

### 4.3 חוקי ברזל — תהליך (`Xeae10txdI8`) 📄

| # | כלל | השפעה על מנוע | אמון |
|---|-----|----------------|------|
| IR-1 | **סטאפ אחד** — "מרוב עצים לא רואים את היער"; ביצוע עקבי על workflow אחד | תיעוד/QA — לא gate מספרי | 📄 |
| IR-2 | **1% NLV** לעסקה — לא 1% מהפוזיציה | `ZIV_RISK_UNIT_PCT = 0.01` | ✅ L17 + 📄 |
| IR-3 | **סבלנות** — מטרה ראשונה להישאר במשחק; מעקב **פעם בשבוע**, לא מסך כל יום | תזמון סקירה / alerts — לא intraday churn | 📄 |
| IR-4 | **מערכת מוגדרת מראש** = פחות מקום לרגש | מאשר gates קיימים (RR, retest, sizing) | 📄 |
| IR-5 | עדיף **FOMO על כניסה** מאשר כאב על פוזיציה רעה | משלים Gap Guard — לא להחזיק עסקה ללא מבנה | 📄 |

### 4.4 מבחן שיעור 37 (אימות)

- שאלה #9 — מינימום לקיחת רווח: **פי 2 מהסיכון** (תשובה **ב**)
- שאלה #14 — סגירה לפני 2R: רק כש**דוחות** קרובים (תשובה **ב**)

---

## 5. נוסחאות מנוע — Engine-ready spec

### 5.1 בסיס — מהו "1%"?

```typescript
/** Ziv canonical — שווי חשבון מסחר (NLV), לא cash בלבד */
type PortfolioBasis = "NLV";  // Net Liquidation Value from broker

const ZIV_RISK_UNIT_PCT = 0.01;  // fixed; do not raise after wins (L17-1)

function riskBudgetUsd(nlv: number): number {
  return nlv * ZIV_RISK_UNIT_PCT;
}
```

| שאלה | תשובה | מקור |
|------|--------|------|
| 1% מ-NLV או cash? | **NLV / שווי החשבון** | L12 "שווי החשבון", L37 "גודל החשבון", תמלול זיו |
| כולל מינוף? | הסיכון הוא **הפסד $ על NLV** — לא notional gross | L37 דוגמת 10% SL על פוזיציה → 1% תיק |
| מטבע | USD (US) / שקל (TASE) — אותה לוגיקה על **ערך תיק** | — |

⚠️ **Elza Live** משתמש ב-`totalNlv` לתקציב (`computeLiveCapital`) אבל **לא** מחשב shares מ-`riskBudget / R`.

---

### 5.2 R (per-share risk)

מקור אמת: `slCalculator.ts` → `rValue` / `EntrySlTpResult.rValue`

```typescript
/** R = per-share dollar risk after SL is finalized (post clamp + tick round) */
function perShareRiskR(
  entry: number,
  stopLoss: number,
  direction: "long" | "short",
): number {
  const raw = direction === "long"
    ? entry - stopLoss
    : stopLoss - entry;
  return Math.max(0, Math.round(raw * 100) / 100);
}
```

**SL** (swing / Ziv-aligned): structural — `swingExtreme20 ± FATTAIL_STRUCT_BUFFER×ATR14` (`calcSwingSlTp`).  
**Clamp:** מרחק SL > 15% מ-entry → clamp ל-15% ואז TP מחושב מחדש (`calcEntrySlTp`).

---

### 5.3 גודל פוזיציה — Ziv formula

```typescript
interface ZivPositionSizeInput {
  nlv: number;
  entry: number;
  stopLoss: number;
  direction: "long" | "short";
  riskUnitPct?: number;  // default 0.01
}

interface ZivPositionSizeResult {
  riskBudgetUsd: number;
  rPerShare: number;
  shares: number;
  positionUsd: number;
  positionPctNlv: number;  // varies with SL width — NOT fixed
}

function calcZivPositionSize(i: ZivPositionSizeInput): ZivPositionSizeResult | null {
  const riskUnit = i.riskUnitPct ?? ZIV_RISK_UNIT_PCT;
  const R = perShareRiskR(i.entry, i.stopLoss, i.direction);
  if (R <= 0 || i.entry <= 0) return null;

  const riskBudgetUsd = i.nlv * riskUnit;
  const shares = Math.floor(riskBudgetUsd / R);
  if (shares < 1) return null;

  const positionUsd = shares * i.entry;
  return {
    riskBudgetUsd,
    rPerShare: R,
    shares,
    positionUsd,
    positionPctNlv: positionUsd / i.nlv,
  };
}
```

**אינטואיציה (עברית):**  
פוזיציה רחבה יותר כשה-SL **צר** (אותו 1% תיק ÷ R קטן = יותר מניות).  
פוזיציה צרה יותר כשה-SL **רחב** (שבועי / מבני).

**דוגמה מספרית (L37):**

| NLV | entry | SL | R | riskBudget (1%) | shares | position $ | loss if SL |
|-----|-------|----|---|-----------------|--------|------------|------------|
| $100,000 | $50 | $45 | $5 | $1,000 | 200 | $10,000 | **$1,000 = 1% NLV** |
| $100,000 | $50 | $40 | $10 | $1,000 | 100 | $5,000 | **$1,000 = 1% NLV** |

---

### 5.4 R:R — מדידה והחלטה

#### A) Gate לפני כניסה (זיו primary — שיעור 37)

```typescript
/** Nearest opposing level (long: resistance above entry) */
function rewardToNearestLevel(
  entry: number,
  opposingLevel: number,  // resistance (long) or support (short)
  direction: "long" | "short",
): number {
  return direction === "long"
    ? Math.max(0, opposingLevel - entry)
    : Math.max(0, entry - opposingLevel);
}

const ZIV_MIN_RR = 2.0;  // 1:2 — L12, L14, L16, L17, L37

function passesZivRRGate(
  entry: number,
  stopLoss: number,
  opposingLevel: number,
  direction: "long" | "short",
): { ok: boolean; rr: number; risk: number; reward: number } {
  const risk = perShareRiskR(entry, stopLoss, direction);
  const reward = rewardToNearestLevel(entry, opposingLevel, direction);
  const rr = risk > 0 ? reward / risk : 0;
  return { ok: rr >= ZIV_MIN_RR, rr, risk, reward };
}
```

**כלל זיו:** אם ההתנגדות הקרובה **לא** מאפשרת `reward ≥ 2×risk` → **SKIP** (לא מתקנים ב-TP מלאכותי).

#### B) TP מחושב (Elza `slCalculator` — proxy)

```typescript
// Swing (default ELSA_TRADING_MODE=swing)
const tpR = weeklyStrongTrend ? SWING_TP_R_STRONG : SWING_TP_R;  // 3.0 or 2.5

takeProfit = direction === "long"
  ? entry + tpR * R
  : entry - tpR * R;

// Intraday
takeProfit = entry ± INTRADAY_TP_R * R;  // 5R
```

| מודל | TP | מתי |
|------|-----|-----|
| **זיו (מבני)** | שיא / **התנגדות הבאה** | תכנון + מימוש חלק שם |
| **זיו (רצפה)** | לפחות **2R** לפני סגירה מלאה | L37, L16 partial @1:2 |
| **Elza bracket** | **2.5R–3R** (swing) / **5R** (intraday) | `calcEntrySlTp` |
| **Elza scale-out** | **50% @ 2R** (`SCALE_OUT_TP1_R = 2.0`) | `freeRollTriggerGain` ✅ |

```typescript
// Scale-out (Elza Approach B — aligned L37)
const SCALE_OUT_TP1_R = 2.0;
const SCALE_OUT_SELL_FRAC = 0.50;

target1Price = entry + directionSign * SCALE_OUT_TP1_R * R;
```

#### C) אימות מינימלי בקוד היום

`tradeOutputValidator.ts` — דורש רק **R:R ≥ 1:1** ⚠️ (לא 1:2).

**המלצת מנוע:** gate כניסה **1:2** (מבני או `tpR ≥ 2`); validator → `reward/risk < 2.0` = BLOCK.

---

### 5.5 מקסימום פוזיציות + תקרות מצטברות

#### זיו (שיעור 37) ✅

```typescript
const ZIV_MAX_POSITIONS = 15;  // total symbols for control
```

אין בקורס נוסחה מפורשת ל-"15% aggregate" — אבל **15 × 1% risk unit** ⇒ סיכון תיאורטי מקסימלי **~15% NLV** אם כל ה-SL נפגעים בו-זמנית.

#### Elza (מפרט v2.0) ⚠️

```typescript
const ELZA_MAX_LONG = 12;
const ELZA_MAX_SHORT = 6;
const ELZA_MAX_TOTAL = 18;  // ≠ Ziv 15

// Slot sizing (NOT 1% risk):
baseUsd = poolRemaining / max(slotsRemaining, 1);
finalUsd = min(baseUsd * sizeMult, maxPositionUsd);
```

**תקרות נוספות Elza (ניהול סיכון — לא מזיו ישירות):**

| תקרה | ערך | קובץ |
|------|------|------|
| Daily loss breaker | `dailyLossLimitUsd` (ברירת מחדל $2,000) | `warEngine.ts` |
| Deployed gross | `gross ≤ allocatedCapital` (Iron Rule 1) | `liveOrderExecutor` |
| Correlation | ≤ 0.80 מול פוזיציה פתוחה | `warEngine.ts` |
| מגזר | ≤3 פוזיציות / 20% NLV (מפרט) | 📄 guidelines — לא אומת ב-live path |
| `maxPositionUsd` / `minPositionUsd` | config (למשל $20k–$70k) | `warEngine` + `liveOrderExecutor` |

#### נוסחת סיכון מצטבר מוצעת (מנוע)

```typescript
/** Sum of per-position risk if all stops hit today */
function aggregateOpenRiskUsd(
  positions: Array<{ shares: number; entry: number; stopLoss: number; direction: "long" | "short" }>,
): number {
  return positions.reduce((sum, p) => {
    const R = perShareRiskR(p.entry, p.stopLoss, p.direction);
    return sum + R * Math.abs(p.shares);
  }, 0);
}

/** Ziv-soft cap: warn/block new entries */
function aggregateRiskGate(nlv: number, openRiskUsd: number): "OK" | "WARN" | "BLOCK" {
  const pct = openRiskUsd / nlv;
  if (pct >= 0.15) return "BLOCK";   // aligns with 15×1% heuristic
  if (pct >= 0.10) return "WARN";
  return "OK";
}
```

---

## 6. מיפוי קוד — `slCalculator.ts` + סביבה

| קבוע / פונקציה | ערך | קשר ל-GAP #3 |
|----------------|------|--------------|
| `SCALE_OUT_TP1_R` | **2.0** | ✅ L37 מינימום 2R / partial |
| `SCALE_OUT_SELL_FRAC` | 0.50 | ✅ L37 50% בהתנגדות |
| `SWING_TP_R` / `STRONG` | 2.5 / 3.0 | 📄 TP bracket > מינימום 2R |
| `INTRADAY_TP_R` | 5.0 | ⚠️ רחוק ממינימום זיו; מצב נפרד |
| `recommendedPositionSize` | score → USD band | ⚠️ לא 1%×R |
| `calcEntrySlTp` → `rValue` | per-share R | ✅ בסיס ל-R:R |
| `freeRollTriggerGain(R)` | `2 * R` | ✅ |

**מימוש ידני (UI/Lab):** `portfolio.ts` `analyzeHoldings` — tier cap % (15/10/7/3) ⚠️ לא זיו.  
`holding2` path: `RISK_PER_TRADE_PCT = 0.02` (2%) + `shares = riskPerTrade/R` — קרוב לנוסחת זיו אך **2%** ולא 1%.

---

## 7. החלטות מנוע מוצעות | Engine decisions

### 7.1 ADOPT (זיו → מנוע)

| ID | החלטה | עדיפות |
|----|--------|--------|
| G3-A1 | `ZIV_RISK_UNIT_PCT = 0.01` על **NLV** | P1 |
| G3-A2 | `calcZivPositionSize()` לפני `tryLiveEntry` (או כ-floor/ceiling לסלוט) | P1 |
| G3-A3 | Gate כניסה **R:R ≥ 2** — מבני (התנגדות) **או** `tpR ≥ 2` | P0 |
| G3-A4 | `tradeOutputValidator` → מינימום **1:2** | P0 |
| G3-A5 | `aggregateOpenRiskUsd` + אזהרה ב-10% / חסימה ב-15% NLV | P2 |

### 7.2 ADAPT (פשרה מאושרת v2.0)

| ID | זיו | Elza | נימוק |
|----|-----|------|--------|
| G3-X1 | 1% risk sizing | סלוט 12/6 + conviction band | אוטומציה — פשטות |
| G3-X2 | מקס **15** פוזיציות | **12+6** | שורטים נפרדים; לשקול `min(15, openTotal)` |
| G3-X3 | TP = התנגדות | bracket 2.5R + **לא** TP קרוב + 50%@2R | Approach B |

### 7.3 REJECT ל-Live (כבר במפרט)

- כפילות: גם סלוט מלא **וגם** 1% risk בלי cap — יוצר פוזיציות ענקיות/זעירות לא עקביות.

---

## 8. זרימת gate מוצעת | Proposed entry pipeline

```
tryLiveEntry candidate
  1. nlv ← broker NLV
  2. entry, SL ← calcEntrySlTp (structural)
  3. R ← rValue
  4. opposingLevel ← demandZoneEngine / Donchian / swing high
  5. IF rewardToLevel / R < 2.0 → BLOCK "RR_BELOW_1_2"
  6. shares_ziv ← floor(nlv * 0.01 / R)
  7. shares_elza ← floor(positionSizeUsd / entry)
  8. shares ← min(shares_ziv, shares_elza)   // ADAPT: respect both caps
  9. IF openPositions >= ZIV_MAX (15) → BLOCK
 10. IF aggregateOpenRisk / nlv >= 0.15 → BLOCK
```

---

## 9. טבלת מקורות

| מקור | נושא | סטטוס |
|------|------|--------|
| `docs/lesson-12/pdf-extracted.txt` | 1%, R:R 1:2, SL by TF | ✅ |
| PDF שיעור 37 (חומרי עזר) | 15 pos, 2R, 50%@התנגדות, RR מבני | ✅ |
| `2026-06-24-ziv-methodology-research.md` §11.4–11.7, §11.14 | שיעורים 12–17, 37 | 📄 |
| `2026-06-19-elza-ziv-alignment-guidelines.md` §ניהול סיכון | סלוט 12/6, REJECT 1% live | 📄 |
| `server/slCalculator.ts` | R, TP, 2R scale-out | ✅ |
| `server/warEngine.ts` | conviction USD sizing | ✅ |
| `server/routers/portfolio.ts` | 2% risk formula (holding2) | ✅ |
| `server/tradeOutputValidator.ts` | RR ≥ 1:1 only | ⚠️ |

---

## 10. פערים פתוחים | Open gaps

1. ⚠️ **שיעור 17 PDF** — לא נסרק ישירות בסשן זה; להשלים מחומרי עזר בפורטל.
2. ⚠️ **Gate 1:2 מבני** — אין `opposingLevel` אחיד ב-War Engine לפני כל כניסה.
3. ⚠️ **15 vs 18** — לאחד קונפיג `maxPositions` עם מגבלת זיו.
4. ⚠️ **Sector 20% NLV** — במפרט אך לא נמצא מימוש ב-`liveOrderExecutor` / `warEngine` entry loop.
5. 📄 **Win-rate math** משיעור 17 — רלוונטי ל-backtest / QA, לא ל-gate בודד.

---

*GAP #3 — מסמך מחקר למנוע. לא משנה קוד. השלב הבא: יישום G3-A3/A4 ב-War Engine + validator.*
