# Dynamic VIP — טבלת עדיפות יומית למועמדים

> **תאריך:** 1 ביולי 2026  
> **סטטוס:** **ACCEPTED** (owner-ratified 2026-07-01, **amendment v2** אותו יום)  
> **מקור-אמת:** Git (`main`) · פריסה רק דרך `/root/deploy-tradesnow.sh`  
> **Handoff לקלוד:** [`2026-07-01-dynamic-vip-claude-handoff.md`](./2026-07-01-dynamic-vip-claude-handoff.md)  
> **קשור:** [`server/selectedTeam.ts`](../../../server/selectedTeam.ts) (**deprecated** כש-dynamic פעיל), [`docs/bugs/2026-07-01-gold-retest-ema50-gate.md`](../../bugs/2026-07-01-gold-retest-ema50-gate.md)

---

## Amendment v2 (owner — אותו יום)

| נושא | v1 (מבוטל) | **v2 (מאושר)** |
|------|------------|----------------|
| תדירות | ראשון 17:00, שבועי | **כל יום 17:00 Asia/Jerusalem** |
| `selected_team` | legacy + מינימום VIP-B | **לא רלוונטי** — מתעלמים לחלוטין כש-`dynamicVipEnabled=1` |
| מקור VIP | מיזוג static + dynamic | **`dynamic_vip` בלבד** (+ pin/demote/snooze ידני) |

---

## Executive Summary

**הבעיה:** מניות חלשות (דוגמה חיה: **MTSI**, **RIOT** — מתחת לממוצע, פוטנציאל נמוך) תופסות **סלוטים + תקציב** בזמן שבשוק יש **פצצות אנרגיה** עם ENTER אמיתי. רשימת `SELECTED_TEAM` הייתה **סטטית** — owner מאשר: **כבר לא רלוונטית**.

**הפתרון:** **טבלה דינמית יומית** — שלוש דרגות (`VIP-A` / `VIP-B` / `BENCH`) שמתעדכנות **כל יום 17:00 IL** לפני pre-RTH. משפיעות על **סדר כניסה, תצוגה, ותעדוף תקציב** — **בלי** לעקוף שערי ENTER.

**עקרון זהב (נשמר):** `Rank boost ≠ gate bypass` — דרגה נמוכה **לא** מבטלת RC2 / gapGuard / sector cap; היא רק משנה **מי מקבל את הסלוט האחרון** כשיש תחרות.

---

## מקרה מנחה (2026-07-01)

| Ticker | תסמין | פעולת owner | מצב מערכת היום |
|--------|--------|-------------|----------------|
| **RIOT** | כניסת `GOLD_RETEST_WAR` מתחת ל-EMA50 ("סכין נופלת") | מכירה ידנית | Snooze 720h (DB) · תיקון Gold Retest ב-`elzaV45Master` (ענף multi-account) |
| **MTSI** | חלשה, מתחת לממוצע, פוטנציאל נמוך | מכירה ידנית | Snooze 720h (DB) |

**לקח:** Snooze הוא **פלסטר ידני**. צריך מנגנון **יומי** שמוריד אוטומטית מניות כאלה ל-`BENCH` **לפני** שהן תופסות סלוט, ומעלה פצצות אנרגיה ל-`VIP-A`.

---

## מטרות

| ID | מטרה |
|----|------|
| G1 | **VIP דינמי** — רענון אוטומטי **כל יום 17:00 IL** (לפני pre-RTH) על כל אוניברס המועמדים |
| G2 | **תעדוף סלוט/תקציב** — `VIP-A` נכנס לפני `VIP-B` לפני `BENCH` בלולאת ה-ENTER (בתנאי שכולם עברו gates) |
| G3 | **שחרור סלוטים** — מניה ב-`BENCH` עם פוזיציה פתוחה: תג רוטציה · לא pyramid · **Phase 2:** exit אוטומטי מואץ (ZIM / Diamond Hands) |
| G4 | **שקיפות** — War Room + קטלוג מציגים דרגה, סיבת דירוג, ותאריך רענון אחרון |
| G5 | **Override של owner** — pin / snooze / demote ידני נשמרים מעל האלגוריתם |

## לא במטרה

| ID | Out of scope | הערה |
|----|----------------|------|
| NG1 | מכירה אוטומטית `BENCH` ב-**Phase 0–1** | **Phase 2 — IN:** exit מואץ (ראה §5.4) |
| NG2 | שינוי `MAX_PER_SECTOR` או עקיפת combinedGate | — |
| NG3 | החלפת מנוע הסריקה / genesisScore | — |
| NG4 | VIP לטיקרים מחוץ לקטלוג USA פעיל | — |

---

## מצב נוכחי (AS-IS) — יוצא משימוש

```
systemSettings.selected_team  →  JSON סטטי (~15 tickers)  ← DEPRECATED (v2)
       ↓
getSelectedTeamSet()  (cache 60s)
       ↓
┌──────────────────────────────────────────────────────────────┐
│ DISPLAY / Armed top-N:  effectiveSortScore += 0.4 (SORT)    │
│ LIVE ENTRY ORDER:       raw finalScore; team = tiebreak ONLY │
└──────────────────────────────────────────────────────────────┘
```

**v2:** כש-`dynamicVipEnabled=1` — **הנתיב למעלה לא רץ**. מקור יחיד: `dynamic_vip`.

**פער שהיה:** רשימה סטטית לא משקפת:
- מחיר מול EMA50 / EMA200
- `kineticScore` (percentile 0–100 ב-`userAssets`)
- חום סקטור (אנרגיה השבוע)
- `finalScore` / readiness מהמחזור האחרון

---

## עיצוב מוצע (TO-BE)

### 1. שלוש דרגות VIP

| דרגה | תווית UI | משמעות | השפעה על מסחר |
|------|----------|--------|----------------|
| **VIP-A** | ⭐⭐ | פצצה — מומנטום + מבנה חזק | **קדימות ראשונה** בלולאת ENTER; +0.6 ל-sort display; Armed top-N |
| **VIP-B** | ⭐ | מועמד תקין | קדימות שנייה; +0.2 sort display (כמו boost מופחת מהיום) |
| **BENCH** | 🪑 | ספסל — חלש / מתחת לממוצע | **אחרון** בלולאת ENTER; **אין** sort boost; **חסימת pyramid**; תג "רוטציה" אם יש פוזיציה |

**גודל יעד (מאושר):** `VIP-A` = עד **12** טיקרים (קבוע, לא קשור ל-`maxPositions`) · `VIP-B` = עד **20** · השאר = `BENCH`.

### 2. קריטריוני דירוג יומי (אלגוריתם v1)

רץ על טיקרים עם `catalogStatus != IPO_INCUBATOR` ו-`kineticScore != null`.

**ניקוד מבני (0–3):**

| נקודה | תנאי |
|-------|------|
| +1 | `close > EMA50` (daily) |
| +1 | `close > EMA200` (daily) |
| +1 | Weekly EMA50 slope > 0 |

**ניקוד מומנטום (0–2):**

| נקודה | תנאי |
|-------|------|
| +1 | `kineticScore >= 70` (percentile עליון) |
| +1 | `finalScore >= 7.5` מהסריקה האחרונה (אם קיים ב-`war_upcoming_signals`) |

**בונוס סקטור חם (0–1):**

| נקודה | תנאי |
|-------|------|
| +1 | סקטור ב-top-3 לפי ממוצע `kineticScore` של חברי הסקטור (אנרגיה, סמיקונדקטורים, …) |

**מיפוי לדרגה:**

```
structural + momentum + sector >= 5  →  VIP-A  (עד 12, לפי סכום נקודות)
structural + momentum + sector >= 3  →  VIP-B  (עד 20)
אחרת OR close < EMA50               →  BENCH
```

**דוגמה:** MTSI/RIOT עם `close < EMA50` → **BENCH** אוטומטית (גם בלי snooze).

### 3. רענון יומי

| פרמטר | ערך |
|--------|-----|
| תזמון | **כל יום 17:00 Asia/Jerusalem** (לפני pre-RTH) |
| טריגר | `alertPoller` cron יומי + `scripts/refresh-dynamic-vip.ts` (CLI / dry-run) |
| אחסון | `systemSettings.dynamic_vip` — JSON עם `dayId` (`YYYY-MM-DD`), `refreshedAt`, `tiers: { "VIP-A": [], "VIP-B": [], "BENCH": [] }`, `scores: { TICKER: 6 }`, `reasons: { TICKER: "below_ema50" }` |
| גיבוי | snapshot קודם ב-`dynamic_vip_prev` לאודיט |

### 4. Override של owner (היחיד מעל האלגוריתם)

| פעולה | מפתח / טבלה | התנהגות |
|--------|-------------|----------|
| **Pin to VIP-A** | `dynamic_vip_pins` | נשאר VIP-A עד ביטול, גם אם אלגוריתם היה מוריד |
| **Demote to BENCH** | `dynamic_vip_demotes` | נשאר BENCH עד ביטול |
| **Snooze** | `snoozedTickers` (קיים) | לא נסרק לכניסה — **חזק מכל tier** |

> **`selected_team` — נמחק (v2).** migration 0149 מסיר את השורה. אין legacy, אין merge.

### 5. אינטגרציה במנוע

#### 5.1 לולאת ENTER (`warEngine.ts` ~L1392)

**היום:** `finalScore desc` → team tiebreak.

**יעד (כש-`dynamicVipEnabled=1`) — מיון דו-שלבי (owner-ratified):**

```text
שלב א — מיון ראשי (תמיד):
  1. finalScore desc
  2. kineticScore desc
  3. ticker asc (tiebreak יציב — אין selected_team)

שלב ב — שבירת שוויון tier (רק אם |scoreA − scoreB| ≤ 0.5):
  tierRank desc   (VIP-A=3, VIP-B=2, BENCH=1)
```

**למה 0.5 ולא "tier תמיד קובע"?** (המלצת הארכיטקט — **מאושרת**)

| גישה | יתרון | חיסרון |
|------|--------|--------|
| tier תמיד קובע | פשוט | VIP-A ב-6.2 יקנה לפני non-VIP ב-8.5 → **שובר** `rank ≠ gate bypass` ומייצר כניסות חלשות |
| **סף 0.5 (נבחר)** | Edge אמיתי (finalScore) שולט; tier מכריע רק כשהמועמדים **שווים מספיק** | דורש טסט אינווריאנט INV-2 |

דוגמה: `VIP-A@7.8` vs `BENCH@7.5` (הפרש 0.3) → **VIP-A** מקבל סלוט.  
`VIP-A@6.2` vs `VIP-B@8.1` (הפרש 1.9) → **VIP-B** מנצח — ה-edge מנצח.

Snoozed מסוננים לפני המיון (כמו היום).

#### 5.2 תצוגה / Armed Watcher

- `effectiveSortScore` משתמש ב-boost לפי דרגה: A=+0.6, B=+0.2, BENCH=0
- `buildArmList`: tiebreak לפי tier (אין selectedTeam)

#### 5.3 תקציב / pyramid

- `pyramidEngine`: SKIP אם `tier === BENCH` (לוג `[Pyramid] BENCH tier — no scale-in`)
- אופציונלי Phase 1: `maxPositionUsd` מופחת 50% ל-BENCH קיימות

#### 5.4 פוזיציות פתוחות

**Phase 0–1:**
- War Room: שורת פוזיציה + תג `🪑 רוטציה מומלצת` אם tier=BENCH
- אין exit אוטומטי — owner מוכר ידנית (כמו MTSI/RIOT)

**Phase 2 — exit אוטומטי BENCH (owner-ratified: כן):**

| מנגנון קיים | התאמה ל-BENCH |
|-------------|----------------|
| **ZIM Protocol** (7 סגירות רצופות מתחת EMA-50) | מופעל גם על BENCH — **ללא** הארכה |
| **Diamond Hands** (5 סגירות מתחת EMA-20) | על BENCH: סף **3** סגירות → EXIT FULL |
| **תנאי arm** | `benchAutoExitEnabled=1` (INERT עד owner) · דגל נפרד מ-`dynamicVipEnabled` |

לוג חובה: `[BENCH_EXIT] {ticker} tier=BENCH reason=zim|diamond_hands`

> מטרה: לשחרר סלוט תוך ימים, לא שבועות — בלי לגעת בפוזיציות VIP-A/B שעוברות את אותם שערים במהירות רגילה.

### 6. Flag (INERT)

```typescript
// systemSettings / liveConfig
dynamicVipEnabled: 0      // default — התנהגות AS-IS (selected_team legacy בלבד)
dynamicVipEnabled: 1      // owner arm — דירוג יומי; selected_team מתעלם
benchAutoExitEnabled: 0   // default — Phase 2 exit כבוי
benchAutoExitEnabled: 1   // owner arm — ZIM/Diamond מואץ על BENCH
```

---

## UI

| מסך | שינוי |
|-----|--------|
| **War Room — מועמדים** | עמודת `VIP` (⭐⭐ / ⭐ / 🪑) + tooltip סיבה |
| **War Room — פוזיציות** | תג רוטציה ל-BENCH |
| **קטלוג** | מיון ברירת מחדל: VIP-A → VIP-B → kineticScore; ⭐ דינמי במקום רשימה סטטית |
| **הגדרות** | פאנל "VIP יומי": רשימה, `dayId`, תאריך רענון, Pin/Demote, snapshot אתמול |

---

## סכימה / מיגרציה

| פריט | פעולה |
|------|--------|
| `systemSettings.dynamic_vip` | JSON — **אין migration 0147** (settings row בלבד) |
| `systemSettings.dynamic_vip_pins` | JSON array |
| `systemSettings.dynamic_vip_demotes` | JSON array |
| `selected_team` | **נמחק** — migration `0149_delete_selected_team.sql` · לא לשחזר seed |

אין שינוי `userAssets` schema ב-Phase 0.

---

## קבצים (מימוש עתידי)

| קובץ | שינוי |
|------|--------|
| `server/dynamicVip.ts` | **חדש** — SSOT: `getVipTier()`, `refreshDailyVip()`, `tierSortKey()` |
| `server/selectedTeam.ts` | **@deprecated** — כש-flag על: delegate ל-`dynamicVip` / Set ריק |
| `server/warEngine.ts` | מיון ENTER + sort display; הסר selectedTeam |
| `server/intradayArmedWatcher.ts` | tiebreak tier בלבד |
| `server/pyramidEngine.ts` | BENCH skip |
| `server/liveEngine.ts` / manage loop | Phase 2: BENCH accelerated ZIM/Diamond |
| `server/alertPoller.ts` | cron **יומי** 17:00 IL |
| `scripts/refresh-dynamic-vip.ts` | CLI ידני + dry-run |
| `server/routers/portfolio.ts` | `getDynamicVip` tRPC |
| `client/.../WarRoomCandidatesTable.tsx` | עמודת tier |
| `server/dynamicVip.test.ts` | **חדש** — דירוג, override, sort invariant |

---

## אינווריאנטים (חובה בטסטים)

| ID | אינווריאנט |
|----|------------|
| INV-1 | `tier` **לא** משנה `action` מ-ENTER ל-SKIP |
| INV-2 | `finalScore` גבוה ב-**>0.5** תמיד מנצח tier נמוך בלולאת ENTER |
| INV-3 | Snooze חזק מכל tier — לא נסרק |
| INV-4 | `VIP-A` count ≤ 12, `VIP-B` ≤ 20 אחרי refresh |
| INV-5 | `dynamicVipEnabled=0` → התנהגות legacy `selected_team` (עד arm) |
| INV-5b | `dynamicVipEnabled=1` → `selected_team` **אפס השפעה** גם אם ticker ברשימה הישנה |
| INV-6 | Pin/Demote של owner שורד **refresh יומי** |
| INV-7 | Phase 2: VIP-A/B **לא** מקבלים Diamond 3-close — רק BENCH |
| INV-8 | `dayId` = תאריך IL של הרענון; `refreshedAt` < 24h אחרי cron |

---

## שערי GO

| ID | קריטריון |
|----|-----------|
| DV-G0 | `pnpm test server/dynamicVip.test.ts` — 100% אינווריאנטים |
| DV-G1 | dry-run על prod DB: MTSI/RIOT → BENCH; ≥3 אנרגיה → VIP-A |
| DV-G2 | יום RTH אחד shadow (`dynamicVipEnabled=0` + לוג diff בלבד) |
| DV-G3 | owner arm `dynamicVipEnabled=1` — אפס כניסות BENCH כשיש VIP-A ENTER בתור |
| DV-G4 | War Room מציג tier + `refreshedAt` |
| DV-G5 | Phase 2: `benchAutoExitEnabled=1` — BENCH עם 3 closes < EMA20 → EXIT (סימולציה ירוקה) |

**פריסה:** רק מחוץ ל-RTH · אחרי merge ל-`main` · `deploy-tradesnow.sh`.

---

## שלבי rollout

| Phase | תוכן | סיכון |
|-------|------|--------|
| **0** | Spec + `refresh-dynamic-vip.ts` dry-run + לוג בלבד | אפס |
| **1** | Sort + UI + flag INERT | נמוך |
| **2** | Pyramid BENCH block + rotation tag + **exit אוטומטי מואץ** (`benchAutoExitEnabled`) | בינוני |
| **3** | Sector-heat bonus מכויל; soft budget cap ל-BENCH | בינוני |

---

## קשר לעבודות פתוחות

| נושא | יחס |
|------|-----|
| Gold Retest EMA50 | משלים — מונע כניסה גיאומטרית רעה; VIP מונע **תעדוף** של שמות חלשים |
| MTSI/RIOT snooze 720h | נשאר עד arm של VIP דינמי; אז אפשר להוריד snooze ולתת ל-BENCH לנהל |
| `perf/tier1-safe-wins` | אין תלות; merge עצמאי |
| P1 War race | תואם — סדר ENTER נכון רק אם הלולאה רצה |

---

## החלטות owner (מאושר 2026-07-01)

| # | שאלה | החלטה |
|---|------|--------|
| 1 | סף תחרות tier | **0.5 נקודות `finalScore`** — מיון ראשי לפי edge; tier שובר שוויון בלבד (המלצת ארכיטקט **מאושרת**) |
| 2 | מכירת BENCH Phase 2 | **כן** — exit אוטומטי מואץ: ZIM רגיל + Diamond **3** closes על BENCH בלבד |
| 3 | גודל VIP-A | **12** קבוע (לא קשור ל-`maxPositions`) |
| 4 | סטטוס spec | **ACCEPTED** — מותר Phase 0 (dry-run) |
| 5 | תדירות (amendment v2) | **יומי 17:00 IL** — לא שבועי |
| 6 | `selected_team` (amendment v2) | **נמחק** — migration 0149 + קוד ריק |

---

## סיכום בשורה

> **VIP דינמי ויומי** — לא רשימת 15 סטטית. כל יום 17:00 IL נקבעות מחדש VIP-A ⭐⭐ / VIP-B ⭐ / BENCH 🪑. `selected_team` הישנה לא משפיעה. מניות חלשות מתחת לממוצע לא יתפסו סלוט כשיש פצצות ב-VIP-A — בלי לשבור `rank boost ≠ gate bypass`.
