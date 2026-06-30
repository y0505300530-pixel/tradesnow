# GAP #5 — Weekly Filter + Falling Knife + Consolidation (דשדוש)

**Course:** Focus Trader — שיעור 10 (מגמות), שיעור 13 (אסטרטגיית דשדוש)  
**Engine touchpoints:** `zivEngine.ts` (`weeklyEma50Slope`), `runtimeIntelligence.ts` (regime + `weeklyAligned`), `deepAnalysisMeta.ts` (WK-L/WK-S)  
**Status:** Research complete — spec for `classifyWeeklyTrend()` + consolidation gate  
**Legend:** ✅ implemented (approx) · 📄 course rule · ⚠️ gap / mismatch

---

## 1. Executive summary

| Topic | Ziv (Lessons 10 + 13) | Elza today | Gap |
|-------|----------------------|------------|-----|
| **Weekly bullish** | Rising HH/HL structure on **weekly** chart; primary trend ≥4 months | `weeklyEma50Slope ≥ 0` (absolute $ diff, not %) | ⚠️ Proxy only; no HH/HL count |
| **Weekly bearish** | Falling LH/LL mirror | `shortEngine`: slope `< 0` | ⚠️ Same proxy gap |
| **Consolidation (דשדוש)** | 2 touches upper + 2 touches lower; **no trend = no trend-following entry** | Not detected; flat slope falls through to WATCH | ⚠️ Missing `isConsolidating()` |
| **Falling knife** | Break of **last weekly swing low** (שפל אחרון) on W/M chart | `weeklyEma50Slope < 0` → Tier 1 | ⚠️ No swing-low breach check |

**Elza design choice (approved v1.9):** EMA-50 weekly slope is an **acceptable proxy** for automation — but consolidation and structural break must be added for parity with Ziv's "מגמה מובהקת" and "סכין נופלת".

---

## 2. Timeframe hierarchy 📄

| Layer | Hebrew | English | TF | Role in engine |
|-------|--------|---------|-----|----------------|
| **מגמה ראשית** | Primary trend | **Weekly** or **Monthly** | `W` / `M` | **Gate** — WK-L / WK-S / BLOCK |
| **מגמה משנית** | Secondary trend | Daily | `D` | Retest / zone / CYC gates |
| **מגמה מינורית** | Minor trend | 4H / 1H | `4H` / `1H` | PA confirmation only |

📄 **Lesson 10:** Primary trend is found on weekly/monthly; pivot must be **≥ 4 months** from today.  
📄 Counter-trend moves on lower TFs are **temporary** until primary structure breaks.

**Engine compression rule (current):**

```typescript
// zivEngine.ts — daily bars → pseudo-weekly (every 5th close)
weeklyCloses = closes.filter((_, idx) => idx % 5 === 0);
```

⚠️ This is **not** true ISO-week OHLC aggregation. Spec should use proper weekly bars from `fetchBarsForTicker(ticker, N, '1wk')` when available.

---

## 3. Weekly bullish — exact definition 📄

### 3.1 Ziv structural rules (Lesson 10 PDF)

**מגמת עלייה (uptrend):** סדרה עולה של שיאים ושפלים.

| Rule | Hebrew | English | Strict? |
|------|--------|---------|---------|
| Higher highs | כל שיא גבוה מקודמו | Each swing **high** > prior high | ✅ Yes |
| Higher lows | שפלים עולים (יכולים להיות גם זהים) | Swing **lows** rise; **equal lows allowed** | ≈ Soft |
| Min span | נקודת מפנה ≥ 4 חודשים | Pivot ≥ **4 months** back on W/M | ✅ Yes |
| Classic pattern A | 2 שפלים עולים + 2 שיאים עולים | **2 HL + 2 HH** | 📄 Quiz .3 |
| Classic pattern B | 2 שפלים שלא יורדים + 2 שיאים עולים | **2 flat/rising lows + 2 HH** | 📄 Quiz .3 |
| End of bear → bull | 2 שפלים עולים + 2 שיאים עולים | Same as pattern A | 📄 |

**There is no single integer like "count ≥ 3 HH".** Ziv uses **pairs** of swings (2+2) plus **directional logic** on the **most recent** swings.

### 3.2 WK-L — proposed engine classification ✅ (v1.9 spec)

| Param | Hebrew | English | Value | TF |
|-------|--------|---------|-------|-----|
| `WEEKLY_SLOPE_BULL_MIN_PCT` | שיפוע מינימלי שבועי | Min weekly EMA-50 slope | **> 0.2%** | W |
| `WEEKLY_PRICE_VS_EMA50` | מחיר מעל ממוצע | Close above weekly EMA-50 | `weeklyClose > weeklyEma50` | W |
| `WEEKLY_STRUCTURE_BULL` | מבנה שורי | Last HL > prior HL **and** last HH > prior HH | 2-swing check | W |
| `WEEKLY_PRIMARY_MIN_MONTHS` | עומק מגמה | Distance from pivot low to now | **≥ 4 months** | W/M |

**WK-L = true** when **all** of:

1. `weeklySlopePct > 0.2`  
2. `weeklyClose > weeklyEma50Now`  
3. `weeklyStructureBull === true` (2 HH + 2 HL per §3.1) — **P1 structural upgrade**  
4. `!isConsolidating(weeklyBars)` — see §5  

### 3.3 Weekly bearish — exact definition 📄

**מגמת ירידה:** תמונת ראי של עלייה.

| Pattern | Hebrew | English |
|---------|--------|---------|
| Classic A | 2 שיאים יורדים + 2 שפלים יורדים | **2 LH + 2 LL** |
| Classic B | 2 שיאים שלא עולים + 2 שפלים יורדים | **2 flat/falling highs + 2 LL** |
| Mutation (bear) | 2 שיאים עולים → פרץ ירידות מתחת לשפל אחרון | False rally then breakdown |

### 3.4 WK-S — proposed engine classification ✅ (v1.9 spec)

| Param | Hebrew | English | Value | TF |
|-------|--------|---------|-------|-----|
| `WEEKLY_SLOPE_BEAR_MAX_PCT` | שיפוע דובי מקסימלי | Max weekly slope for short | **< −0.2%** | W |
| `WEEKLY_PRICE_VS_EMA50` | מחיר מתחת ממוצע | Close below weekly EMA-50 | `weeklyClose < weeklyEma50` | W |
| `WEEKLY_STRUCTURE_BEAR` | מבנה דובי | Last LH < prior LH **and** last LL < prior LL | 2-swing check | W |

**WK-S = true** when all of (1)(2)(3) and `!isConsolidating`.

### 3.5 Flat / ambiguous weekly → BLOCK 📄

| State | Hebrew | English | Engine action |
|-------|--------|---------|---------------|
| `|weeklySlopePct| ≤ 0.2%` | שבועי שטוח | Flat weekly EMA slope | **BLOCK** long & short |
| Consolidation | דשדוש | Range 2+2 touches | **BLOCK** trend-following (§5) |
| NEUTRAL regime | מאקרו ניטרלי | SPY NEUTRAL | ⚠️ `longOk` still true today |

📄 **Lesson 10 + alignment v1.9:** דשדוש / מעורפל = **אין כניסה** ללונג מגמתי.

---

## 4. Swing detection for HH/HL (engine algorithm) ⚠️

**TF:** Weekly bars (preferred) or 5-day compressed daily.

```typescript
interface WeeklySwing {
  type: 'high' | 'low';
  price: number;
  barIndex: number;
  date: string;
}

// Pivot: local extrema with left/right confirmation (e.g. 2 bars each side on weekly)
function detectWeeklySwings(bars: WeeklyBar[], lookback = 2): WeeklySwing[]

function weeklyStructureBull(swings: WeeklySwing[]): boolean {
  const highs = swings.filter(s => s.type === 'high').slice(-2);
  const lows  = swings.filter(s => s.type === 'low').slice(-2);
  if (highs.length < 2 || lows.length < 2) return false;
  const hhOk = highs[1].price > highs[0].price;           // last HH > prior HH
  const hlOk = lows[1].price >= lows[0].price;              // last HL >= prior HL (equal OK per L10)
  return hhOk && hlOk;
}

function weeklyStructureBear(swings: WeeklySwing[]): boolean {
  const highs = swings.filter(s => s.type === 'high').slice(-2);
  const lows  = swings.filter(s => s.type === 'low').slice(-2);
  if (highs.length < 2 || lows.length < 2) return false;
  return highs[1].price < highs[0].price && lows[1].price <= lows[0].price;
}
```

| Output | Hebrew | Meaning |
|--------|--------|---------|
| `lastSwingHigh` | שיא אחרון | Most recent weekly swing high |
| `lastSwingLow` | שפל אחרון | Most recent weekly swing low — **falling-knife reference** |
| `priorSwingLow` | שפל קודם | Previous swing low (for HL comparison) |

---

## 5. Consolidation — דשדוש (Lessons 10 + 13) 📄

### 5.1 Identification (course)

| Rule | Hebrew | English | Source |
|------|--------|---------|--------|
| Definition | איזון ביקוש והיצע | Balance of supply/demand | L10, L13 |
| Upper bound | 2 נגיעות באותה רמת מחיר עליונה | **2 touches** at same **resistance** | L10 Q8, L13 |
| Lower bound | 2 נגיעות באותה רמת מחיר תחתונה | **2 touches** at same **support** | L10 Q8, L13 |
| Prior trend bias | מגמה קודמת משפיעה על כיוון פריצה | Prior **primary** trend biases breakout direction | L13 |
| Down bias | מגמת ירידה ראשית → סיכוי לשבירה למטה | Prior downtrend → higher odds of **lower** break | L13 Q13 |
| Up bias | מגמת עלייה ראשית → סיכוי לפריצה למעלה | Prior uptrend → higher odds of **upper** break | L13 |

📄 **Lesson 13** also teaches **range trading** (buy 3rd touch at support, SL below support, TP ≥ 2R).  
**Elza trend engine:** range strategy is **out of scope** — דשדוש = **BLOCK** for WK-L/WK-S gates, not a new entry type.

### 5.2 `isConsolidating()` — proposed engine rule ⚠️

**TF:** Weekly (primary); optional daily for early warning.

| Param | Hebrew | English | Default |
|-------|--------|---------|---------|
| `CONSOL_TOUCH_MIN` | מינימום מגעים לרמה | Min touches per boundary | **2** |
| `CONSOL_LEVEL_TOLERANCE_PCT` | סובלנות רמה | Price equality tolerance | **2.0%** |
| `CONSOL_MIN_BARS` | מינימום נרות בטווח | Min bars inside range | **8** weekly (~2 months) |
| `CONSOL_RANGE_WIDTH_MIN_PCT` | רוחב מינימלי | (high−low)/mid | **5%** |
| `CONSOL_RANGE_WIDTH_MAX_PCT` | רוחב מקסימלי | Avoid whole-year drift | **35%** |

```typescript
function isConsolidating(weeklyBars: Bar[]): {
  consolidating: boolean;
  rangeHigh: number;
  rangeLow: number;
  upperTouches: number;
  lowerTouches: number;
  priorTrend: 'up' | 'down' | 'unknown';
} {
  // 1. Find rangeHigh / rangeLow over lookback (e.g. 26 weekly bars)
  // 2. Count touches: bar.high within tolerance of rangeHigh, bar.low within tolerance of rangeLow
  // 3. consolidating = upperTouches >= 2 && lowerTouches >= 2 && width within min/max
  // 4. priorTrend from structure before range (last 2 swings outside box)
}
```

| Result | Hebrew | Engine |
|--------|--------|--------|
| `consolidating === true` | דשדוש מזוהה | `weeklyBullish = false`, `weeklyBearish = false`, tier cap **≤ Near Entry Watch** |
| Breakout pending | פריצה צפויה לפי מגמה קודמת | Log bias only; **no auto-entry** until WK-L/WK-S after break |

### 5.3 Interaction with regime (`runtimeIntelligence`) 📄

| Macro (`regime`) | Weekly state | Long | Short |
|------------------|--------------|------|-------|
| BULL | WK-L | ✅ | ❌ (`shortOk` false) |
| BULL | דשדוש | ❌ | ❌ |
| NEUTRAL | WK-L | ⚠️ allowed today | ⚠️ if `shortOk` |
| NEUTRAL | דשדוש | ❌ | ❌ |
| BEAR | WK-S | ❌ | ✅ |
| BEAR | דשדוש | ❌ | ❌ |

📄 **Lesson 10:** In NEUTRAL/דשדוש Ziv does **not** chase trend entries — aligns with **BLOCK**.

---

## 6. Falling knife — סכין נופלת 📄

### 6.1 Ziv definition

| Source | Rule | Hebrew |
|--------|------|--------|
| L10 Q16 | Primary **uptrend** ends when price breaks **last swing low** on weekly/monthly | שבירת **רמת השפל האחרונה** בגרף השבועי/חודשי |
| L10 narrative | Counter-trend OK until primary structure breaks | תנועה נגדית **זמנית** כל עוד מבנה ראשי שלם |
| YouTube / methodology | C-points and lows stop rising; "don't touch" | מגמה שבועית יורדת — **לא נוגעים. נגמר הסיפור** |
| L13 Q18 | Broken support → becomes resistance | תמיכה שנשברה → **התנגדות** |

**Falling knife (long context)** = primary weekly uptrend **invalidated**.

### 6.2 Which swing low? 📄

| Reference | Hebrew | Use |
|-----------|--------|-----|
| **`lastSwingLow`** | השפל האחרון במבנה העולה | **Falling-knife trigger** — close **below** this level on **weekly** close |
| `priorSwingLow` | שפל קודם | Used for HL confirmation only — **not** the knife trigger |
| Pivot low (≥4mo) | שפל מפנה רחוק | Defines trend **age**, not intratrend stop |

**Rule (long):**

```
fallingKnife = weeklyClose < lastSwingLow * (1 - FALLING_KNIFE_BUFFER_PCT/100)
```

| Param | Hebrew | English | Value |
|-------|--------|---------|-------|
| `FALLING_KNIFE_BUFFER_PCT` | באפר שבירה | Close confirmation buffer | **0.5%** below last swing low |
| `FALLING_KNIFE_TF` | טיים-פריים | Confirmation candle | **Weekly close** (not intraday wick) |
| `FALLING_KNIFE_SYMMETRY` | שורט | Bear knife = close **above** `lastSwingHigh` | Mirror for WK-S exit |

### 6.3 Engine mapping today vs target

| Signal | Hebrew | `zivEngine.ts` today | Target |
|--------|--------|----------------------|--------|
| Soft bear | שיפוע שלילי | `weeklyEma50Slope < 0` → Tier 1 | Keep as **early warning** |
| Hard knife | שבירת שפל אחרון | ❌ not implemented | **Tier 1 + ZivH FC** |
| Consolidation break down | פריצת דשדוש למטה | ❌ | BLOCK long + optional short watch |

```265:268:server/zivEngine.ts
  } else if (weeklyEma50Slope < 0) {
    baseScore = 3;
    tier = "No Signal";
    reason = `Weekly EMA-50 slope is NEGATIVE (${weeklyEma50Slope.toFixed(2)}). Structural downtrend — wait for trend reversal.`;
```

⚠️ Slope is **absolute price delta** (e.g. `0.24`), not percent — `deepAnalysisMeta` compares to `0.2` as if percent:

```149:150:server/deepAnalysisMeta.ts
  const weeklyBullish = ziv.weeklyEma50Slope > 0.2 && livePrice > ziv.ema50;
  const weeklyBearish = ziv.weeklyEma50Slope < -0.2 && livePrice < ziv.ema50;
```

⚠️ Uses **daily** `ziv.ema50`, not weekly EMA-50 — misaligned with v1.9 WK-L spec.

### 6.4 Weekly trail exit (open long) — `BxU463WI14M`, `zryV1uyM-jg` 📄

**מבדיל מ-falling knife (§6):** falling knife = **חסימת כניסה** לונג חדש; trail exit = **יציאה מפוזיציה פתוחה** במנצחת.

| Rule | Hebrew | English | Value |
|------|--------|---------|-------|
| Trigger | סגירה שבועית מתחת לשפל אחרון | Weekly **close** below `lastSwingLow` | W1 bar |
| vs L37 trail | L37: SL 2% מתחת לשפל שבועי **חדש** (העלאת סטופ) | YouTube: **יציאה מלאה/חלקית** על שבירת שפל אחרון | משלים — לא מחליף |
| Partial | מימוש 50% ב-2R+ או בהתנגדות לפני trail | `SCALE_OUT_SELL_FRAC` | L37 + 📄 |

```typescript
function weeklyTrailExitSignal(weeklyBars: Bar[], lastSwingLow: number): boolean {
  return weeklyBars.at(-1)!.close < lastSwingLow;  // 📄 BxU, zryV1uyM — not intraday wick
}
```

### 6.5 `runtimeIntelligence` regime (macro layer) ✅

SPY weekly slope drives BULL/NEUTRAL/BEAR — **separate** from per-ticker weekly:

```69:77:server/runtimeIntelligence.ts
    if (spyEmaSlope > 0.3 && vixProxy < 25) {
      regime = "BULL";
    } else if (spyEmaSlope < -0.3 || vixProxy > 35) {
      regime = "BEAR";
    } else {
      regime = "NEUTRAL";
```

| Param | Hebrew | English | Value |
|-------|--------|---------|-------|
| `REGIME_SPY_SLOPE_BULL_PCT` | שיפוע SPY שורי | SPY weekly EMA-50 slope | **> 0.3%** |
| `REGIME_SPY_SLOPE_BEAR_PCT` | שיפוע SPY דובי | SPY weekly slope | **< −0.3%** |
| `REGIME_VIX_PROXY_MAX_BULL` | תנודתיות מקס ל-BULL | Realized vol proxy | **< 25%** |
| `REGIME_VIX_PROXY_MIN_BEAR` | תנודתיות מינ ל-BEAR | Vol spike | **> 35%** |

Ticker `weeklyAligned` today: `weeklySlope > -0.005` — ⚠️ **far looser** than WK-L `> 0.2%`.

---

## 7. Unified `classifyWeeklyTrend()` — target API ⚠️

**File:** `server/weeklyTrendEngine.ts` (new) — consumed by `runtimeIntelligence`, `zivEngine`, `warEngine`, `deepAnalysisMeta`.

```typescript
export type WeeklyTrendClass =
  | 'WK-L'           // מגמה שבועית שורית מובהקת
  | 'WK-S'           // מגמה שבועית דובית מובהקת
  | 'CONSOLIDATION'  // דשדוש
  | 'FALLING_KNIFE'  // סכין נופלת (שבירת שפל אחרון)
  | 'RISING_KNIFE'   // סכין עולה (שורט — שבירת שיא אחרון)
  | 'AMBIGUOUS';     // שטוח / לא מספיק נתונים

export interface WeeklyTrendResult {
  class: WeeklyTrendClass;
  weeklyBullish: boolean;   // WK-L only
  weeklyBearish: boolean;   // WK-S only
  weeklySlopePct: number;
  weeklyEma50: number;
  weeklyClose: number;
  lastSwingHigh: number | null;
  lastSwingLow: number | null;
  isConsolidating: boolean;
  fallingKnife: boolean;
  priorTrendBias: 'up' | 'down' | 'unknown';
  reasonHe: string;
  reasonEn: string;
}
```

### 7.1 Decision table

| Priority | Condition | Class | `longOk` gate | `shortOk` gate |
|----------|-----------|-------|---------------|----------------|
| 1 | `weeklyClose < lastSwingLow` (buffer) in prior WK-L | **FALLING_KNIFE** | ❌ | ⚠️ watch only |
| 2 | `weeklyClose > lastSwingHigh` (buffer) in prior WK-S | **RISING_KNIFE** | ⚠️ | ❌ cover |
| 3 | `isConsolidating` | **CONSOLIDATION** | ❌ | ❌ |
| 4 | WK-L rules §3.2 | **WK-L** | ✅ (if regime) | ❌ |
| 5 | WK-S rules §3.4 | **WK-S** | ❌ | ✅ (if regime) |
| 6 | else | **AMBIGUOUS** | ❌ | ❌ |

---

## 8. Parameter sheet (Hebrew + English)

| Param | עברית | English | Value | TF | Status |
|-------|-------|---------|-------|-----|--------|
| `WEEKLY_SLOPE_BULL_MIN_PCT` | שיפוע שבועי מינימלי ללונג | Min weekly EMA-50 slope % for WK-L | 0.2 | W | 📄 v1.9 |
| `WEEKLY_SLOPE_BEAR_MAX_PCT` | שיפוע שבועי מקסימלי לשורט | Max weekly slope % for WK-S | −0.2 | W | 📄 v1.9 |
| `WEEKLY_EMA_PERIOD` | תקופת ממוצע שבועי | Weekly EMA period | 50 | W | ✅ |
| `WEEKLY_SLOPE_LOOKBACK_WEEKS` | השוואת שיפוע | Weeks back for slope | 4 | W | ✅ zivEngine |
| `WEEKLY_PRIMARY_MIN_MONTHS` | גיל מגמה ראשית | Min months from pivot | 4 | W/M | 📄 L10 |
| `WEEKLY_HH_HL_PAIRS` | זוגות שיא/שפל | Swing pairs for structure | 2+2 | W | 📄 L10 |
| `CONSOL_TOUCH_MIN` | מגעים לרמת דשדוש | Touches per boundary | 2 | W | 📄 L10/L13 |
| `CONSOL_LEVEL_TOLERANCE_PCT` | סובלנות מחיר רמה | Level touch tolerance | 2.0 | W | ⚠️ proposed |
| `FALLING_KNIFE_SWING` | נקודת שבירה | Reference swing | **lastSwingLow** | W | 📄 L10 Q16 |
| `FALLING_KNIFE_BUFFER_PCT` | באפר אישור | Break confirmation buffer | 0.5 | W | ⚠️ proposed |
| `WEEKLY_TRAIL_EXIT` | יציאה על שבירת שפל | Exit when W1 close < `lastSwingLow` | true | W | 📄 BxU, zryV1uyM |
| `REGIME_SPY_SLOPE_BULL_PCT` | שיפוע SPY ל-BULL | SPY slope for bull regime | 0.3 | W | ✅ |
| `REGIME_SPY_SLOPE_BEAR_PCT` | שיפוע SPY ל-BEAR | SPY slope for bear regime | −0.3 | W | ✅ |

---

## 9. Implementation checklist

| # | Task | File(s) | Priority |
|---|------|---------|----------|
| 1 | Normalize `weeklySlopePct` (percent, not $) | `zivEngine.ts`, `weeklyTrendEngine.ts` | P0 |
| 2 | Replace `weeklyAligned` with `weeklyBullish` / `weeklyBearish` | `runtimeIntelligence.ts` | P0 |
| 3 | Fix WK-L to use **weekly** EMA-50 + weekly close | `deepAnalysisMeta.ts` | P0 |
| 4 | Add `detectWeeklySwings` + HH/HL pair check | `weeklyTrendEngine.ts` | P1 |
| 5 | Add `isConsolidating` (2+2 touches) | `weeklyTrendEngine.ts` | P1 |
| 6 | Add `fallingKnife` = break `lastSwingLow` | `weeklyTrendEngine.ts`, `zivEngine.ts`, ZivH | P1 |
| 7 | Add `weeklyTrailExit` = W1 close < `lastSwingLow` | `slCalculator.ts`, position mgmt | P1 |
| 8 | War Engine: `!weeklyBullish` → BLOCK long | `warEngine.ts` | P0 |
| 9 | Use true weekly OHLC bars | `marketData.ts` | P2 |

---

## 10. Source index

| ID | Source | URL / path |
|----|--------|------------|
| L10 | סיכום שיעור 10 — מגמות | `cyclestrading-course.com/.../סיכום-שיעור-10-שאלות-ותשובות.pdf` |
| L13 | סיכום שיעור 13 — דשדוש | `cyclestrading-course.com/.../סיכום-שיעור-13-שאלות-ותשובות.pdf` |
| MR | Methodology research v2.3 | `docs/superpowers/specs/2026-06-24-ziv-methodology-research.md` §2.1, §11.1 |
| AG | Alignment guidelines v1.9 | `docs/superpowers/specs/2026-06-19-elza-ziv-alignment-guidelines.md` §WK-L/WK-S |
| ZE | Ziv Engine | `server/zivEngine.ts` |
| RI | Runtime intelligence | `server/runtimeIntelligence.ts` |
| DA | Deep Analysis meta | `server/deepAnalysisMeta.ts` |

---

## 11. Quick answers (parent agent)

**Weekly bullish exact (HH/HL count)?**  
📄 Not "N highs" — need **2 rising highs** (each HH > prior; strict) and **2 rising or equal lows** (HL ≥ prior; equal allowed). On **weekly/monthly**, pivot ≥4 months. Engine proxy: `weeklySlopePct > 0.2%` + `close > weekly EMA-50` (v1.9 WK-L).

**Consolidation (Lesson 13 dashdush)?**  
📄 **2 touches** at upper resistance + **2 touches** at lower support (same levels, ~2% tolerance). Prior primary trend biases breakout direction. Elza: **BLOCK** trend entries; do not implement range-trading bot from L13.

**Falling knife — lower-low below which swing?**  
📄 Below **`lastSwingLow`** (שפל אחרון) on **weekly/monthly close** — not prior HL, not daily swing. Confirms primary uptrend reversal (L10 Q16). Today: ⚠️ only `weeklyEma50Slope < 0` in `zivEngine.ts`.

**Weekly trail exit (winners)?**  
📄 `BxU463WI14M`, `zryV1uyM-jg`: exit review when **weekly close** breaks below **`lastSwingLow`** — complements L37 2% trail under new swing low; not %-TP.
