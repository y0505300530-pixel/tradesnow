# תוכנית QA — TradeSnow / Elza v4.5 + Waiter

> **חוקת ה-QA הרשמית** של המערכת (owner-ratified 2026-06-30). אין GO על קוד שלא עבר את השערים כאן.
> מקור-אמת: Git. מקור-אמת למספרים: IBKR. כל merge/deploy כפוף לפרק "מטריצת GO / NO-GO".

**מטרה:** לוודא ששינויי קוד (Waiter, War, UI, deploy) לא שוברים מסחר חי, ושכל pipeline חדש עובר מ-INERT → 2 slots → scale בצורה מדידה.

**עקרונות:**
- **Git = SSOT** — אין QA על קוד שלא עבר `commit → push → deploy-tradesnow.sh`
- **IBKR = SSOT למספרים** — כל בדיקת פוזיציה/פקודה מאומתת מול ברוקר, לא רק DB
- **Flag-gated rollout** — `waiterEnabled=0` חייב להיות byte-identical לפני arm
- **אין deploy באמצע RTH** לפיצ'רים שמשדרים פקודות

---

## שלב 0 — Gate לפני כל merge (CI מקומי)

| # | פקודה | Pass criteria |
|---|--------|---------------|
| 0.1 | `pnpm check` | 0 שגיאות TypeScript |
| 0.2 | `pnpm build` | build נקי |
| 0.3 | `pnpm test` | כל vitest ירוק |
| 0.4 | `pnpm test server/waiterEngine.test.ts` | Waiter safety core |
| 0.5 | `pnpm test server/adversarialQaV45.test.ts` | parity gaps **מתועדים** (לא surprise ב-live) |
| 0.6 | `pnpm test server/elzaV45LiveWiring.integration.test.ts` | CB, never-naked, halt, EOD |
| 0.7 | `pnpm test server/liveSafety.test.ts server/slTpCoverage.test.ts` | brackets + safety |
| 0.8 | `pnpm test server/optimisticBuyingPower.test.ts` | ledger תקציב משותף |

**חסימת merge** אם אחד מאלה נכשל.

---

## שלב 1 — Waiter (THE WAITER) — בדיקות אוטומטיות

כבר קיימות ב-`server/waiterEngine.test.ts`. מטריצה:

| סעיף spec | מה נבדק | סוג |
|-----------|---------|-----|
| INERT | `waiterEnabled=0` → early-return ראשון, אפס DB/order | unit + regex |
| §2 Ambush | `retestLevel × 1.02`, לא EMA20 ישן | unit |
| §2 Stop | `computeRetestStop` + wideLungSL bound | unit |
| §3 Sub-cap 30% | `subCapAllows` + optimistic BP | unit |
| §3b maxPositionUsd | concentration blocker | unit |
| §4 Slot guard | `freeRetestSlots`, `countsTowardSlot=1` | unit |
| §5 Falling knife | 5m מתחת לסטופ → cancel | unit |
| R1 Dedup | `waiterHoldsRetest` → War skip | unit + source gate |
| R2 Re-quote | drift >0.5%, לא chase למעלה | unit |
| R4 Naked fill | STP לא מאושר → flatten | unit + reconcile |

### חסרים — לבנות לפני arm

| ID | בדיקה | למה |
|----|--------|-----|
| W-INT-1 | Integration mock: `runWaiterTick` → LMT sent → `pending_entry` row | end-to-end ללא IBKR |
| W-INT-2 | Fill mock → bracket STP → status `open` | R3/R4 |
| W-INT-3 | War + Waiter same ticker concurrent → רק אחד נכנס | race |
| W-BT-1 | `scripts/waiterBacktest.ts` 60 יום | **GO/NO-GO לפני arm** — AvgR > 0 |

**⚠️ חובה:** לוודא ש-`waiterBacktest.ts` מיושר עם `waiterEngine.ts` (retestLevel×1.02, לא EMA20×1.005 ישן בכותרת הסקריפט).

---

## שלב 2 — War Engine + Armed Watcher

| ID | תרחיש | איך לבדוק | Pass |
|----|--------|-----------|------|
| WAR-1 | מחזור INTRADAY רגיל | לוגים: funnel ENTER > 0 → לוג per-ticker (RC2/VixSize) | לא `entered=0` ב-1ms |
| WAR-2 | Race `Already running` | שני cycles חופפים | השני skip, הראשון מסיים עם לוגים |
| WAR-3 | R1 עם Waiter=1 | ticker עם LMT ממתינה | War **לא** market-buy retest |
| WAR-4 | RC2 >12% | ASML-class | `SKIP` מפורש בלוג |
| WAR-5 | VIX >35 | סימולציה/mock | block כניסות |
| WAR-6 | sizing 1% | כניסה חדשה | notional ≈ `$NLV×0.01 / stop%` (~$30K @ $122K NLV) |
| ARM-1 | arm 4% | Armed Watcher | top-10 breakout, מרחק ≤4% מקו |
| ARM-2 | Retest ב-Armed | ticker `GOLD_RETEST_WAR` | **לא** נורה מ-Armed (breakout בלבד) |
| ARM-3 | FIRED | breakout cross + RVOL | כניסה או alert מפורש |

**אין unit tests ל-`intradayArmedWatcher`** — זה gap. מינימום: smoke script או test אחד על top-N selection + arm threshold.

---

## שלב 3 — UI / Front-hand

| ID | מסך | בדיקה | Pass |
|----|------|--------|------|
| UI-1 | War Room — Candidates | עמודת סוג איתות | 🚀 Breakout / ↩ Retest מ-`route` |
| UI-2 | נגישות | icon + טקסט, לא צבע בלבד | WCAG basic |
| UI-3 | מובייל 375px | `tests/mobile-trading-ux-375.spec.ts` | אין overflow |
| UI-4 | Playwright מלא | `pnpm test:e2e` | health, auth, navigation |

קובץ מפתח: `client/src/components/war-room/WarRoomCandidatesTable.tsx`

---

## שלב 4 — Deploy & Git SSOT

| ID | בדיקה | Pass |
|----|--------|------|
| DEP-1 | uncommitted changes על שרת | `deploy-tradesnow.sh` **נכשל** עם הודעה |
| DEP-2 | deploy נקי | `git pull --ff-only` → build → pm2 restart |
| DEP-3 | rev match | לוג deploy = `git rev-parse --short HEAD` על שרת = GitHub main |
| DEP-4 | `waiterEnabled=0` אחרי deploy | אפס LMT ממתינות חדשות, אפס שינוי ב-War behavior |

---

## שלב 5 — Paper / INERT על שרת (אחרי סגירה)

**סדר חובה:**

```
1. deploy עם waiterEnabled=0
2. וידוא byte-identical (יום מלא או לפחות 3 מחזורי War)
3. deploy עם waiterEnabled=1 אבל maxRetestSlots=0 (אם קיים) או arm ידני ל-2 slots בלבד
4. יום paper / 2 slots
5. scale ל-10 slots / 30% sub-cap
```

### צ'קליסט יומי (INERT)

- [ ] `pm2 logs tradesnow-app` — אין ERROR חוזר
- [ ] Circuit breaker — NLV תקין (לא stale)
- [ ] IBKR positions = DB positions (לכל ticker פתוח)
- [ ] כל פוזיציה open — STP+TP resting ב-IBKR (`audit:sltp`)
- [ ] אין orphan orders (סקריפט `qa-check.mjs` / `/orders`)
- [ ] Optimistic BP לא שלילי

### צ'קליסט Waiter (אחרי arm)

- [ ] `WAITER_ARM` / `WAITER_FILL` / `WAITER_CANCEL_KNIFE` בלוגים
- [ ] `pending_entry` + `isWaiterEntry=1` ב-DB
- [ ] LMT ב-IBKR תואם `retestLevel×1.02`
- [ ] על fill: STP wideLungSL מאושר תוך 25s (R4)
- [ ] falling knife: 5m close מתחת לסטופ → LMT בוטל
- [ ] EOD: כל LMT ממתינות בוטלו (DAY tif)
- [ ] War לא קנה market על אותו ticker בזמן LMT פעילה

---

## שלב 6 — Position sizing & Adoption

| ID | תרחיש | Expected |
|----|--------|----------|
| SZ-1 | כניסת War חדשה | ~$30K notional @ 1% risk |
| SZ-2 | PANW/RIVN adopted | **לא** resized — נשאר גודל IBKR |
| SZ-3 | ZIM units reconcile | DB units = IBKR units אחרי sync |
| SZ-4 | pyramid | `pyramidDone=0` עד trigger — אין add אוטומטי |

---

## שלב 7 — Regression ידוע (לא לשכוח)

מתועד ב-`adversarialQaV45.test.ts`:

| Gap | Live היום | Golden spec |
|-----|-----------|-------------|
| SL mode | swing structural | Wide Lung intraday |
| Scale-out | 2.0R / 50% | 2.5R / 40% |

**QA לא מסמן GO** על "parity מלא" עד שאלה ירוקים או מתועדים כ-accepted risk.

---

## מטריצת GO / NO-GO

| Gate | תנאי | Blocker? |
|------|------|----------|
| G0 | `pnpm test` + `pnpm build` | ✅ כן |
| G1 | `waiterEnabled=0` deploy ללא שינוי behavior | ✅ כן |
| G2 | `waiterBacktest` 60d AvgR ≥ 0 | ✅ כן לפני arm |
| G3 | W-INT-1..3 (integration) | ✅ כן לפני arm |
| G4 | 2 slots live יום אחד — 0 naked, 0 double-fill | ✅ כן לפני scale |
| G5 | WAR-1 (race fix) — מחזור עם לוגים מלאים | 🟠 high |
| G6 | UI signal column על prod | 🟡 medium |

---

## סדר ביצוע מומלץ (ספרינט QA)

| יום | משימה |
|-----|--------|
| **D0** (היום, אחרי סגירה) | G0 + deploy INERT + DEP-1..4 |
| **D1** | הרצת `waiterBacktest` + תיקון alignment אם צריך |
| **D2** | כתיבת W-INT-1..3 + ARM smoke test |
| **D3** | deploy INERT prod, צ'קליסט יומי מלא |
| **D4** | arm `waiterEnabled=1`, **2 slots** בלבד |
| **D5** | ניתוח fills/cancels → scale ל-10 או NO-GO |

---

## פקודות מהירות (copy-paste)

```bash
# Gate מלא
pnpm check && pnpm build && pnpm test

# Waiter בלבד
pnpm test server/waiterEngine.test.ts

# Live wiring
pnpm test server/elzaV45LiveWiring.integration.test.ts

# Backtest GO/NO-GO
node --import tsx --env-file=.env scripts/waiterBacktest.ts

# SL/TP audit על שרת
pnpm audit:sltp

# E2E
pnpm test:e2e

# Deploy SSOT (על השרת)
ssh root@143.198.141.131 'cd /root/tradesnow && ./deploy-tradesnow.sh --inert-check'
```

---

## Critical Vulnerabilities (לטפל לפני arm)

1. **War race** — מחזור מסתיים ב-1ms בלי לוג ביצוע (חשוד מ-`Already running`)
2. **אין tests ל-Armed Watcher** — 60% מה-pipeline המהיר לא מכוסה אוטומטית
3. **Backtest / engine drift** — כותרת `waiterBacktest.ts` עדיין מזכירה EMA20×1.005
4. **Adopted positions** (PANW $95K) — עוקפים `maxPositionUsd`; לא באג Waiter אבל מעוות heat

---
---

# נספח-בודק (Reviewer's Addendum) — מאומת מול ה-repo, 2026-06-30 ערב

הסטטוס האמיתי של החוקה מול הקוד החי, נכון לרגע ההזרקה. **זו אינה דעה — כל שורה אומתה בריצה.**

## ✅ מה אומת כקיים
- **כל 5 קבצי-ה-gate (0.5–0.8) קיימים:** `adversarialQaV45.test.ts` (135), `elzaV45LiveWiring.integration.test.ts` (992), `liveSafety.test.ts` (52), `slTpCoverage.test.ts` (49), `optimisticBuyingPower.test.ts` (115).
- **כל פקודות ה-npm קיימות:** `check`=`tsc --noEmit`, `test`=`vitest run`, `test:e2e`=`playwright test`, `audit:sltp`=`scripts/audit-sltp.ts`.
- **G0 רץ:** build EXIT 0; tests **693/702**.
- **G1 (waiterEnabled=0 byte-identical):** הוכח + פרוס היום.

## 🔴 ממצאים פתוחים שנתפסו בסבב הראשון (מתוקנים/בתיקון)
1. **`deploy-tradesnow.sh` לא היה קיים** — עמוד-השדרה של שלב 4. **נבנה היום** (git ff-only, dirty-tree refusal, build-gate, rev-match, `--inert-check`). מונע את באג-ה-truncation שקרה ב-hand-deploy (cat over SSH נחתך).
2. **`waiterBacktest.ts` יושר + הורץ — ו-G2 חשף ממצא חוסם 🔴🔴.** הסקריפט יושר ל-`retestLevel×1.02` (קורא `ziv.retestLevel` ישירות, בדיוק כמו המנוע החי). **תוצאה על 60 יום (וגם 8.5 חודשים): 0 round-trips, 0 LMT הונחו** (81 tier-hits → 0 הנחות). **שורש:** שני שערי-הכניסה **סותרים בפועל** — `isNearRetestZone` דורש `live ≤ retestLevel×1.08`, anti-chase דורש `live > retestLevel×1.02`, אבל ה-Ziv בוחר את ה-tier "Gold Retest" לפי **קרבה ל-EMA50** (≤3%), reference שונה מהרמה המבנית שה-LMT יושב עליה. המחיר כמעט אף פעם לא נוחת ברצועת ה-2%–8%-מעל-התמיכה-המבנית. **משמעות: The Waiter כפי שנבנה מניח אפס אורדרים — arming = no-op.** **זו החלטת-מוצר (להתאים את בסיס-הבחירה לבסיס-האמבוש), לא תיקון-קוד.** **G2 = GO ניווני (AvgR=0 על 0 עסקאות) = למעשה NO-GO / INCONCLUSIVE.** חוסם arm עד הכרעה.
3. **4 טסטים RED מהשינויים של 2026-06-30** (חוב-בדיקות, אפס הגנה): `antiChaseBlocks` (פוּנה ל-1.035), `classifyCrossState` (ARM_PROXIMITY 1%→4%), `is5mHoldConfirmed` (RVOL 1.5→1.2). **בתיקון.**
4. **אי-עקביות בקוד anti-chase:** `warEngine.ts:319` = ×1.035 אבל `warEngine.ts:1760` (funnel) **עדיין ×1.025**. השינוי לא הוחל בכל המקומות. **בתיקון (יישור ל-1.035).**
5. **Vuln#1 מאומת:** מחזור-המלחמה ב-cooldown (`warEngine.ts:410-416`) חוזר **בשקט מוחלט** — cooldown ישן יכול לבלוע פריצה מאומתת של Armed-Watcher בלי לוג. **תיקון: שורת-לוג (בתהליך).**
6. **Vuln#2 מתוקן-עובדתית:** ל-`intradayArmedWatcher` **יש** טסט (14 cases) — אבל RED + חסר כיסוי קריטי (top-N cap, ARM-2 short-exclusion, SHADOW branch, state-machine→`runWarEngineCycle`). הקביעה "אין tests" בתוכנית — **לא מדויקת; יש, אבל סטייל ולא שלם.**

## 🟡 חוב טכני (לא חוסם, לתעד)
- **47 שגיאות `tsc`** — רובן pre-existing; ה-build (esbuild) מתעלם. כמה בקבצי-UI שנגענו היום (`WarRoomCandidatesTable` property `status`, `WarRoomLive`). לנקות לפני ש-`pnpm check` (G0.1) יהפוך ל-blocker אמיתי.
- **טסטים env-תלויים** (IBIND/SUPADATA/HMAC) נכשלים מקומית, עוברים על השרת. צריך `skipIf(!env)` כדי ש-G0 ירוץ נקי מקומית (בתיקון).

## עדכון מצב-Waiter (קריטי לחוקה)
The Waiter **מפורק (`waiterEnabled=0`)** מאז 2026-06-30 ערב, אחרי תיקון רמת-ה-retest (אורב ב-`retestLevel×1.02` = פריצה→תמיכה, לא EMA20). **G2 + G3 + הסבב הנוכחי חייבים להיות ירוקים לפני arm.** ה-flag הוא owner-only.
