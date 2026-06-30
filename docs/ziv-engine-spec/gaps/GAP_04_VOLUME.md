# GAP #4 — Volume / נמ"ס (Lessons 16, 18)

**Status:** Research complete — thresholds specified for engine implementation  
**Sources:** שיעור 16 (פריצה), שיעור 18 (מחזורי מסחר), `docs/superpowers/specs/2026-06-24-ziv-methodology-research.md` (v2.3), `docs/superpowers/specs/2026-06-19-elza-ziv-alignment-guidelines.md`, `server/zivEngine.ts`, `server/cyclePhaseEngine.ts`, `server/warEngine.ts`, `server/breakoutScanner.ts`  
**PDFs:** Lessons 16/18 PDFs are **not** in the repo; rules below are extracted from methodology v2.3 §11.6–11.8 (course summaries + user-approved Elza mapping).

---

## 1. Executive summary

Ziv treats **volume as the story** — not a bonus score. Lesson 18 defines *trading cycles* as **volume behavior** (distinct from Gann time cycles). Lesson 16 defines **נמ"ס** as the minimum quality bar for **breakout entries** when no retest is available.

| Question | Answer | Confidence |
|----------|--------|------------|
| High-volume breakout threshold | **≥ 1.5×** 20-day average on the **breakout bar** (gate); **≥ 2.0×** for EMA-200 override only | BO2 adopted v2.3; 2× is code-only override |
| Dry volume on retest | **< 0.85** (5-day avg ÷ 20-day avg) during pullback toward structure | ⚠️ RECOMMENDED_DEFAULT — course qualitative, Elza quantified |
| High volume on declines (warning) | **> 1.5×** when price is falling (CYC-S1 short block); **> 1.0×** soft warning at demand for new longs | High: CYC-S1 implemented; long warning: ⚠️ RECOMMENDED_DEFAULT |
| נמ"ס definition | Healthy candle + high breakout-bar volume + close near high — all three required | נ+מ quantified below; ס: ⚠️ RECOMMENDED_DEFAULT |

---

## 2. Canonical metric: `volumeRatio`

### 2.1 Two formulas in codebase (GAP — must unify)

| Module | Formula | Use case |
|--------|---------|----------|
| `zivEngine.ts`, `cyclePhaseEngine.ts`, `shortEngine.ts` | `avg(volume[-5:]) / avg(volume[-20:])` | Rolling momentum / cycle gates / scoring |
| `breakoutScanner.ts` | `volume[last bar] / avg(volume[-20:])` | Breakout alert on **event day** |

**Spec decision:**

| Context | Formula | Rationale |
|---------|---------|-----------|
| **Breakout / נמ"ס / BO2** | `breakoutVolRatio = lastBar.volume / avgVol20` | Ziv: "מחזור גבוה **בנר הפריצה**" — single event bar |
| **Retest dry-up / D3 / R5** | `pullbackVolRatio = avgVol5 / avgVol20` | Ziv: volume **contracts over the pullback**, not one bar |
| **CYC-L1 / CYC-S1** | `avgVol5 / avgVol20` (keep) | Matches `cyclePhaseEngine.ts` — multi-day regime |

Export both from a shared helper (e.g. `volumeMetrics.ts`) to avoid silent drift.

### 2.2 Baseline window

**20 trading days** for average volume — consistent across all engines today.  
⚠️ Course does not specify window; 20d Donchian alignment is the Elza convention.

---

## 3. High-volume breakout — × average?

### 3.1 Course (Lesson 16)

- Breakout is **secondary** to retest (smaller SL, better R:R).
- When breakout is allowed: **נמ"ס** must pass + primary trend up + volume **expands on advances** (לונג).
- Alert zone: **±2%** beyond prior high/low (watch, not auto-entry).

### 3.2 Methodology v2.3 / Elza gates

| Layer | Threshold | Constant | Notes |
|-------|-----------|----------|-------|
| Scanner **detection** (watchlist) | ≥ **1.2×** | `VOLUME_RATIO_MIN` | `breakoutScanner.ts` — fires alerts early |
| **BO2 gate** (EXECUTE) | ≥ **1.5×** | `BREAKOUT_MIN_VOLUME_RATIO` | Alignment guidelines §Gold Breakout — **adopted P0** |
| **Bear BD2** (symmetry) | ≥ **1.5×** | `BREAKDOWN_MIN_VOLUME_RATIO` | Above `shortEngine` detect at 1.3× |
| **Ziv decimal bonus** | 1.2 / 1.5 / 2.0 | scoring tiers | Not a gate — sub-score only |
| **EMA-200 breakout override** | ≥ **2.0×** (5d/20d) | `zivEngine` `isBreakoutOverride` | Recovery breakouts below EMA-200 — elevated risk, not full Gold tier |

**Answer:** Use **1.5× breakout-bar vs 20d avg** for Gold Breakout EXECUTE (BO2). **Not** 2× for normal breakouts — 2× is override-only.

```typescript
// BO2 + נמ"ס "מ"
const breakoutVolRatio = lastBar.volume / avgVol20;
const bo2Pass = breakoutVolRatio >= 1.5;
```

### 3.3 Rationale for 1.5×

- Course: "מחזורי מסחר גבוהים בפריצה" — qualitative, no number.
- v2.3 gap list explicitly flagged missing numeric threshold; Elza adopted **1.5×** as operational default (between scanner 1.2× and override 2.0×).
- 1.5× ≈ +50% participation vs normal — filters flat-volume false breaks without requiring climax volume.

---

## 4. Dry volume on retest — threshold

### 4.1 Course (Lessons 14 context + 18)

- Uptrend correction: volume **contracts** = healthy (profit-taking, not distribution).
- Retest entry: expect **dry** volume on the pullback toward broken resistance / demand.
- K4 (methodology): *"ונצפה שמחזורי המסחר יבשים"* on retest.

### 4.2 Spec threshold

| Rule | Threshold | Formula |
|------|-----------|---------|
| **Dry pullback (positive)** | `pullbackVolRatio < 0.85` | `avgVol5 / avgVol20` |
| **Gate (retest / demand)** | Same — **required** for R5, D3, S3 | BLOCK if ≥ 0.85 during approach |
| **Confluence only** | 0.85–1.0 | No bonus; neutral |
| **Wet pullback (negative)** | ≥ 1.0 | Distribution risk — downgrade / WATCH |

**⚠️ RECOMMENDED_DEFAULT: 0.85**

**Rationale:**

- 15% below 20d average over 5 days = visibly "quiet" on chart without requiring extreme dryness.
- Symmetric to CYC-L1 block at `< 0.85` on **rising** price — same ratio, opposite direction semantics.
- v2.3 + alignment guidelines unanimous on `0.85`; **not** stated numerically in course PDFs.

### 4.3 Implementation note

Measure dry-up on the **pullback leg** (price moving toward `retestLevel` / zone), not on the original breakout bar. Optional refinement:

```typescript
// Pullback leg: last 3–5 bars where close < prior 5-bar high AND dist to level decreasing
const pullbackVolRatio = avg(volume[pullbackBars]) / avgVol20;
const dryRetest = pullbackVolRatio < 0.85;
```

**Today:** `volumeRatio < 0.85` is **documented** as gate (P1-3) but **not enforced** in `warEngine.ts` for retest/demand — only CYC-L1 uses low volume (different context).

---

## 5. High volume on declines — warning threshold

### 5.1 Course (Lesson 18)

| Pattern | Ziv meaning |
|---------|-------------|
| New high + **lower** volume than prior high | Weakness — buyers exhausted (CYC-L1 narrative) |
| Uptrend correction + **contracting** volume | Healthy |
| Declines with **expanding** volume vs advances | Warning — distribution / sellers active |
| New low + **lower** volume | Short exhaustion — possible reversal |
| New low + **higher** volume | Trend confirmation (short-friendly) |

### 5.2 Engine mapping

| Signal | Condition | Threshold | Action |
|--------|-----------|-----------|--------|
| **CYC-L1** (long BLOCK) | `priceRising && pullbackVolRatio < 0.85` | < 0.85 | BLOCK long — false breakout |
| **CYC-S1** (short BLOCK) | `!priceRising && pullbackVolRatio > HIGH_VOL` | **> 1.5** | BLOCK short — bear trap / capitulation |
| **Long entry warning** (demand / retest) | Price **falling** toward zone + elevated volume | **> 1.0** soft, **> 1.5** hard | Soft: WATCH; Hard: BLOCK (distribution into support) |
| **Open long EXIT review** | Hold long + down day + `pullbackVolRatio > 1.5` at demand | > 1.5 | ZivH penalty / EXIT review (K5) |

**CYC-S1:** `HIGH_VOL_RATIO = 1.5` — implemented in `cyclePhaseEngine.ts`, wired in `warEngine.ts`.

**⚠️ RECOMMENDED_DEFAULT for long-side decline warning:**

| Tier | Threshold | Rationale |
|------|-----------|-----------|
| Soft warning | `> 1.0` (5d/20d) while `priceRising === false` | Any above-average volume on red days near support |
| Hard block (new long) | `> 1.5` | Matches CYC-S1 symmetry + "מחזורי מסחר יותר גבוהים בירידות" |

Course gives **no number** — 1.5× hard block is Elza default aligned with BO2/BD2.

### 5.3 Peak-to-peak volume (Lesson 18 — not yet coded)

Ziv also compares **volume at swing high N vs N-1** ("שיא חדש + נפח נמוך יותר"). This is **separate** from `volumeRatio`:

```typescript
// Optional P2: swingHighVolumeDivergence
const volAtHigh0 = volumeAtPivot(high0);
const volAtHigh1 = volumeAtPivot(high1);
const bearishVolDivergence = high0.price > high1.price && volAtHigh0 < volAtHigh1;
```

Defer to P2; CYC-L1 proxy covers the same intent on daily bars.

---

## 6. נמ"ס — definition & quantification

**נמ"ס** = **נ**ר בריא + **מ**חזור גבוה + **ס**גירה קרובה לגבוה  
Source: שיעור 16 — gate for breakout when retest is unavailable. Mapped to **BO2–BO4** in v2.3 (BO2 = volume leg).

All three are **AND** — missing one → no breakout EXECUTE (WATCH only).

### 6.1 נ — נר בריא (healthy candle above level)

**Course:** "מחצית+ מעל הרמה" — at least half the candle **above** the broken resistance.

**⚠️ RECOMMENDED_DEFAULT:**

```typescript
const level = donchian20High; // or prior resistance / breakoutLevel
const range = Math.max(bar.high - bar.low, 1e-9);
const bodyLow = Math.min(bar.open, bar.close);

// Half+ of candle range above level
const healthyN = (bodyLow - level) / range >= 0.50
              && bar.close > level
              && bar.close > bar.open; // bullish or strong close (see engulf exception)
```

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `HEALTHY_CANDLE_MIN_ABOVE` | **0.50** (50% of range above level) | Literal "מחצית+" |
| Direction | `close > level` | Must actually break, not just wick |
| Color | `close >= open` preferred | Bearish marubozu through level fails נ |

**Exception:** Bullish engulfing on breakout day can pass נ even if prior bar was red — use `max(bodyLow, prevBodyLow)` for level test.

### 6.2 מ — מחזור גבוה (high volume on breakout bar)

**Course:** high volume **on the breakout candle**.

```typescript
const breakoutVolRatio = bar.volume / avgVol20;
const healthyM = breakoutVolRatio >= 1.5; // same as BO2
```

| Parameter | Value | Notes |
|-----------|-------|-------|
| `NAMS_MIN_BREAKOUT_VOLUME` | **1.5×** | Single bar / 20d avg — **not** 5d/20d |
| Strong | **2.0×** | Optional tier boost; equals override threshold |

### 6.3 ס — סגירה קרובה לגבוה (close near high)

**Course:** close near the high of the candle — buyer control into the close.

**⚠️ RECOMMENDED_DEFAULT** (course gives no %):

```typescript
const closePosition = (bar.close - bar.low) / range; // 0 = at low, 1 = at high
const healthyS = closePosition >= 0.75;
// equivalent: upper wick ≤ 25% of range
const upperWickRatio = (bar.high - bar.close) / range;
const healthyS_alt = upperWickRatio <= 0.25;
```

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `CLOSE_NEAR_HIGH_MIN` | **0.75** | Close in top 25% of range — standard "strong close" |
| Upper wick cap | **≤ 25%** of range | Equivalent formulation |

### 6.4 נמ"ס composite

```typescript
export function passesNAMS(bar: Bar, level: number, avgVol20: number): {
  pass: boolean;
  n: boolean; m: boolean; s: boolean;
  breakoutVolRatio: number;
} {
  const range = Math.max(bar.high - bar.low, 1e-9);
  const bodyLow = Math.min(bar.open, bar.close);
  const n = bodyLow > level && (bodyLow - level) / range >= 0.50 && bar.close > bar.open;
  const breakoutVolRatio = avgVol20 > 0 ? (bar.volume ?? 0) / avgVol20 : 0;
  const m = breakoutVolRatio >= 1.5;
  const s = (bar.close - bar.low) / range >= 0.75;
  return { pass: n && m && s, n, m, s, breakoutVolRatio };
}
```

Wire to **BO2–BO4** bundle: נמ"ס + `!isLowCycle` (BO5) + `close ≤ level × 1.02` (BO3 anti-chase).

---

## 7. Liquidity floor (Lesson 18 — related)

| Market | Course minimum | Elza today | Target |
|--------|----------------|------------|--------|
| US | **1M shares/day** avg | `catalogueEligibility` **200K**; `zivEngine` illiquid **10K** | Align scanner/catalogue to **1M** (v2.3 P1) |
| TASE | **500K ₪/day** | 10K units in `catalogueEligibility` | Verify ₪ not shares |

Separate from `volumeRatio` but part of Lesson 18 volume doctrine.

---

## 8. Implementation status

| Rule | Spec | Code today | Gap |
|------|------|------------|-----|
| `volumeRatio` 5d/20d | Canonical for cycle/retest | `zivEngine`, `cyclePhaseEngine` | ✅ |
| Breakout bar vol | 1.5× for BO2/נמ"ס | Scanner uses 1.2× + **wrong formula** (last/20d OK, threshold low) | ⚠️ Raise to 1.5; add נמ"ס |
| Dry retest < 0.85 | Gate R5/D3 | Sub-score only in `zivEngine`; **no war gate** | ❌ P1-3 |
| CYC-L1 | rise + vol < 0.85 | `cyclePhaseEngine` + `warEngine` | ✅ |
| CYC-S1 | drop + vol > 1.5 | `cyclePhaseEngine` + `warEngine` | ✅ |
| נמ"ס נ+ס | Quantified above | **Not implemented** | ❌ P0 — `namsEngine.ts` or BO module |
| BO1–BO7 bundle | v2.3 | War still score-based entry | ❌ Partial |
| Peak volume divergence | Lesson 18 | Not coded | P2 |

---

## 9. Constants table (SSOT for implementation)

| Constant | Value | Source | Used for |
|----------|-------|--------|----------|
| `VOL_AVG_WINDOW` | 20 | Code convention | All ratios |
| `VOL_SHORT_WINDOW` | 5 | Code convention | Pullback / cycle |
| `VOLUME_RATIO_MIN_SCAN` | 1.2 | Alignment §appendix | Scanner watch only |
| `BREAKOUT_MIN_VOLUME_RATIO` | **1.5** | BO2 / BD2 / נמ"ס מ | EXECUTE gates |
| `BREAKOUT_OVERRIDE_VOLUME` | 2.0 | `zivEngine` v2.2 | Below EMA-200 override |
| `VOLUME_DRY_PULLBACK` | **0.85** | v2.3 / D3 / R5 | Retest & demand confirmation |
| `HIGH_VOL_RATIO` | **1.5** | `cyclePhaseEngine` CYC-S1 | Decline + high vol |
| `VOLUME_DECLINE_WARN_SOFT` | **1.0** | ⚠️ RECOMMENDED_DEFAULT | Long warning near support |
| `VOLUME_DECLINE_WARN_HARD` | **1.5** | ⚠️ RECOMMENDED_DEFAULT | Block new long at demand |
| `HEALTHY_CANDLE_MIN_ABOVE` | **0.50** | ⚠️ RECOMMENDED_DEFAULT | נמ"ס נ |
| `CLOSE_NEAR_HIGH_MIN` | **0.75** | ⚠️ RECOMMENDED_DEFAULT | נמ"ס ס |
| `BREAKOUT_CHASE_MAX` | 2% | Lesson 16 / BO3 | Anti-FOMO |
| `MIN_AVG_VOLUME_US` | 1_000_000 | Lesson 18 | Catalogue / scan |
| `MIN_AVG_VOLUME_TASE_ILS` | 500_000 | Lesson 18 | Catalogue / scan |

---

## 10. Decision log

| ID | Decision | Confidence |
|----|----------|------------|
| G4-1 | Breakout EXECUTE volume = **1.5×** breakout bar / 20d avg | **Adopted** v2.3 |
| G4-2 | Dry retest = **< 0.85** 5d/20d on pullback | **Adopted** v2.3 (numeric default) |
| G4-3 | Decline high-volume hard warning = **> 1.5** | **Adopted** via CYC-S1; extend to long demand |
| G4-4 | נמ"ס מ = same as BO2 (1.5× event bar) | **Adopted** |
| G4-5 | נמ"ס נ = 50% range above level | ⚠️ RECOMMENDED_DEFAULT |
| G4-6 | נמ"ס ס = close in top 25% of range | ⚠️ RECOMMENDED_DEFAULT |
| G4-7 | Unify `volumeRatio` formulas per context | **Required** before BO gates ship |
| G4-8 | 2.0× reserved for EMA-200 override, not standard BO | Code + spec aligned |
| G4-9 | **Head & Shoulders** — P2 warning only (vol shrinks on rise, expands on drop) | 📄 `ZeT5NIR8a-g` — לא gate כניסה |

---

## 12. Head & Shoulders — P2 warning (`ZeT5NIR8a-g`) 📄

| Rule | Spec | Action |
|------|------|--------|
| Pattern | ראש וכתפיים = **אזהרת היפוך מגמה** | **P2 bonus/penalty** — never entry gate |
| Volume signature | נפח **מתכווץ** בעלייה (כתף ימין / ראש), **גבוה** בירידה | Downgrade score / `logicBadge: "H&S warning"` |
| vs CYC-L1 | CYC-L1 = שיא+נפח נמוך יומי; H&S = תבנית מבנית מלאה | שכבות נפרדות — H&S P2 only |

```typescript
// P2 — confluence / warning layer only
const HNS_IS_GATE = false;  // 📄 ZeT5NIR8a-g
```

---

## 11. References

```181:185:server/zivEngine.ts
  // ── Volume momentum (last 5 days avg vs 20-day avg) ──
  const volumes = bars.map(b => b.volume ?? 0);
  const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const avgVol5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const volumeRatio = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;
```

```23:26:server/cyclePhaseEngine.ts
/** Spec §3.2: volumeRatio < 0.85 = dry/low volume. */
export const LOW_VOL_RATIO = 0.85;
/** ELZA assumption (confirm with owner): elevated volume for bear-trap detection. */
export const HIGH_VOL_RATIO = 1.5;
```

```247:251:server/breakoutScanner.ts
      // Volume ratio: last 1 day vs 20-day avg
      const volumes = bars.map(b => b.volume ?? 0);
      const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
      const lastVol = volumes[volumes.length - 1] ?? 0;
      const volumeRatio = avgVol20 > 0 ? lastVol / avgVol20 : 1;
```

Methodology v2.3 §11.6 (שיעור 16): נמ"ס = נר בריא (מחצית+ מעל הרמה) + מחזור גבוה בנר הפריצה + סגירה קרובה לגבוה.  
Methodology v2.3 §11.8 (שיעור 18): volume expands on trend legs, contracts on healthy corrections; new extreme on **lower** volume = exhaustion.

---

*Gap #4 closes the numeric ambiguity flagged in methodology v2.3 §10 ("Volume threshold"). Implementation target: `namsEngine.ts` + `volumeMetrics.ts` + BO/R/D gates in `warEngine.ts`.*
