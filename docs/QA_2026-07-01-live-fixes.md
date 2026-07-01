# תוכנית QA — תיקוני 2026-07-01 (Live Session)

> **תאריך הכנה:** 2026-07-01  
> **סטטוס:** 🟡 **ממתין לאות GO** מה-owner — אל תתחילו לפני deploy מאושר  
> **ענף מומלץ לבדיקה:** `feat/multi-trading-accounts` @ `a2455ca` (+ docs על `main` @ `743545d`)  
> **פריסה:** רק `/root/deploy-tradesnow.sh` · **לא** mid-RTH לשינויים שמשפיעים על כניסות  
> **חוקת בסיס:** [`QA_PLAN_WAITER_V45.md`](./QA_PLAN_WAITER_V45.md) — IBKR = SSOT למספרים

---

## Executive Summary

| אזור | מה תוקן | חומרה | אוטומטי |
|------|---------|--------|---------|
| **A** | Gold Retest — רק מעל EMA50 | 🔴 High | חלקי |
| **B** | RC2 cap 12% → 14% | 🟠 Medium | ✅ |
| **C** | `portfolioHoldings` stale אחרי סגירה | 🟠 Medium | חלקי |
| **D** | `maxPositionUsd` על pyramid | 🔴 High | ✅ |
| **E** | War Room מינוף ↔ Cockpit sync | 🔴 High | ידני |
| **F** | מסחר ידני (add-on, pending LMT) | 🟠 Medium | חלקי |
| **G** | Multi-account Dror (dormant) | 🟡 Low | סקריפטים |
| **H** | Phase 0 regression | — | ✅ |

| **I** | H2 TASE Today after 17:30 (weekday) | 🔴 High | ✅ |

### מחוץ לסקופ QA הזה

| נושא | סיבה |
|------|------|
| **Dynamic VIP** (`dynamic_vip`) | **אפיון בלבד** על `main` — אין קוד מימוש · אין arm |
| **`selected_team` מחיקה (0149)** | **לא ב-commit** — עדיין לא בפרוד |
| **`perf/tier1-safe-wins`** | ענף נפרד — QA בנספח אם ימוזג לפני GO |
| **War race deferred queue** | INERT@0 — לא בפרוד |

---

## 0. Pre-flight (חובה לפני כל בדיקה)

| ID | בדיקה | איך | Pass |
|----|--------|-----|------|
| PF-0 | Owner אישר GO | — | ☐ |
| PF-1 | Deploy מהענף הנכון | `git rev-parse HEAD` ≈ `a2455ca` או merge ל-`main` | ☐ |
| PF-2 | `pm2` רץ | `pm2 status tradesnow-app` | ☐ |
| PF-3 | אוטומטי ירוק | `pnpm test` — מינימום 553+ pass | ☐ |
| PF-4 | Build | `pnpm build` pass | ☐ |
| PF-5 | IBKR מחובר (CEO `:5000`) | War Room — סטטוס ירוק | ☐ |
| PF-6 | Snooze פעיל | DB: MTSI, RIOT ב-`snoozedTickers` 720h | ☐ |
| PF-7 | דגלים INERT | `entryChurnGuardEnabled=0`, `minRValuePctEnabled=0` (אלא אם owner אמר אחרת) | ☐ |

**פקודות אוטומטיות ממוקדות:**

```bash
cd /root/tradesnow
pnpm test server/positionCap.test.ts
pnpm test server/minRValueGate.test.ts
pnpm test server/selectedTeam.test.ts
```

---

## A — Gold Retest / EMA50 (RIOT, MTSI)

**מקור:** [`docs/bugs/2026-07-01-gold-retest-ema50-gate.md`](./bugs/2026-07-01-gold-retest-ema50-gate.md)  
**קובץ:** `server/engine/elzaV45Master.ts` (`genesisScore`)

| ID | תרחיש | צעדים | תוצאה צפויה | Pass |
|----|--------|--------|-------------|------|
| A-1 | מניה **מתחת** EMA50 | סריקת War / Analyze לטיקר עם close < EMA50 (בטווח 3% מתחת) | **אין** `GOLD_RETEST` / **אין** ENTER מסיבה זו | ☐ |
| A-2 | מניה **1–3% מעל** EMA50 | טיקר מעל EMA200 + WK slope חיובי + מרחק תקין מעל EMA50 | Gold Retest **עדיין זכאי** (אם שאר gates עוברים) | ☐ |
| A-3 | MTSI / RIOT | War Room מועמדים | **לא מופיעים** (snooze 720h) | ☐ |
| A-4 | לוג | מחזור War עם ENTER=0 על טיקר מתחת EMA50 | אין `GOLD_RETEST_WAR` בלוג לגיאומטריה מתחת EMA50 | ☐ |

**נכשל אם:** כניסה אוטומטית לטיקר מתחת EMA50 תחת תווית Gold Retest.

---

## B — RC2 structural risk 14%

**מקור:** [`docs/bugs/2026-07-01-rc2-threshold-14pct.md`](./bugs/2026-07-01-rc2-threshold-14pct.md)  
**קבצים:** `server/slCalculator.ts`, mirrors ב-`elzaV45Golden`, `elzaV5*`

| ID | תרחיש | Risk % | 12% (ישן) | 14% (חדש) | Pass |
|----|--------|--------|-----------|-----------|------|
| B-1 | ENPH | ~13.5% | blocked | **pass** (אם שאר gates OK) | ☐ |
| B-2 | NVMI | ~12.3% | blocked | **pass** | ☐ |
| B-3 | IONQ | ~14.3% | blocked | **blocked** | ☐ |
| B-4 | PANW | ~30% | blocked | **blocked** | ☐ |

**איך לאמת:** לוג War `[RC2]` / SKIP reason — risk% מוצג. השוואה לחישוב `(entry−stop)/entry`.

**נכשל אם:** risk 13–14% נחסם; או risk >14% עובר.

---

## C — portfolioHoldings stale sync

**מקור:** [`docs/bugs/2026-07-01-portfolio-holdings-stale-sync.md`](./bugs/2026-07-01-portfolio-holdings-stale-sync.md)

| ID | תרחיש | צעדים | תוצאה צפויה | Pass |
|----|--------|--------|-------------|------|
| C-1 | סגירה ב-IBKR | סגור פוזיציה בברוקר (או סימולציה מסונכרנת) | תוך **≤60s**: שורת `portfolioHoldings` לטיקר **נמחקת** | ☐ |
| C-2 | סכום holdings | השווה סכום holdings UI לסכום `livePositions` פתוחות | **אין** טיקרים סגורים (למשל PANW/PWR ישנים) | ☐ |
| C-3 | Elza close | סגירה דרך מנוע (`CLOSED_IBKR_NO_PRICE` / sync) | אין ghost row ב-holdings | ☐ |
| C-4 | Regression | טיקר פתוח ב-IBKR + live | שורת holdings **קיימת** ומסונכרנת | ☐ |

**SQL מהיר (QA עם גישת DB):**

```sql
-- טיקרים ב-holdings בלי live פתוחה
SELECT ph.ticker FROM portfolioHoldings ph
LEFT JOIN livePositions lp ON lp.ticker = ph.ticker AND lp.status = 'open'
WHERE lp.id IS NULL AND ph.source IN ('elza','ibkr');
-- צפוי: 0 שורות (או רק ידני מוסבר)
```

---

## D — maxPositionUsd / pyramid cap

**מקור:** [`docs/bugs/2026-07-01-max-position-usd-breach.md`](./bugs/2026-07-01-max-position-usd-breach.md)

| ID | תרחיש | צעדים | תוצאה צפויה | Pass |
|----|--------|--------|-------------|------|
| D-1 | אוטומטי | `pnpm test server/positionCap.test.ts` | כל הטסטים ירוקים | ☐ |
| D-2 | Pyramid ליד תקרה | פוזיציה ~$80k+, `maxPositionUsd=$85k`, מחזור pyramid | לוג **skip/cap** — **לא** מוסיף מעל cap | ☐ |
| D-3 | כניסה חדשה | War ENTER עם notional גבוה | qty מקוצץ לפני שליחה ל-IBKR | ☐ |
| D-4 | PANW regression | אם PANW עדיין פתוח מעל $85k | **לא** מוסיפים pyramid; תיעוד: adoption ידני/היסטורי | ☐ |

**נכשל אם:** pyramid מגדיל notional מעל `maxPositionUsd` דרך המנוע.

---

## E — War Room leverage sync (Cockpit ↔ מינוף)

**מקור:** [`docs/bugs/2026-07-01-war-room-leverage-desync.md`](./bugs/2026-07-01-war-room-leverage-desync.md)

| ID | תרחיש | צעדים | תוצאה צפויה | Pass |
|----|--------|--------|-------------|------|
| E-1 | Cockpit → תחתון | שנה INTRADAY POWER ב-Cockpit → שמור | פאנל **מינוף** למטה מציג **אותו ערך** תוך poll אחד | ☐ |
| E-2 | תחתון → Cockpit | שנה **מינוף שעות מסחר** בפאנל תחתון | Cockpit dials **תואמים** | ☐ |
| E-3 | Overnight range | גרור overnight ל-**2.0×** | נשמר 2.0 (לא נחתך ל-1.9) | ☐ |
| E-4 | Refresh | F5 אחרי שמירה | ערכים נטענים מ-`getStatus().config` — לא state ישן | ☐ |
| E-5 | CEO only | `/war-room` (ללא dror) | שינוי נשמר ל-CEO `liveEngineConfig` | ☐ |

---

## F — מסחר ידני (Manual)

**Commits:** `dff84b3` … `f4aa980`

| ID | תרחיש | צעדים | תוצאה צפויה | Pass |
|----|--------|--------|-------------|------|
| F-1 | Add-on לטיקר פתוח | קנה עוד מניות על פוזיציה קיימת | **שורה אחת** ב-`livePositions` (UPDATE, לא duplicate) | ☐ |
| F-2 | Pending LMT | שלח LMT ידני מחוץ ל-1% | הודעת **הצלחה + pending בעברית** — לא "נדחה" | ☐ |
| F-3 | Bracket resting | LMT ממתין + bracket ב-IBKR | סטטוס `pending_entry` **נשמר** עד מילוי/ביטול | ☐ |
| F-4 | מילוי LMT | מחיר חוצה 1% | כניסה מתקבלת; שורת live מתעדכנת | ☐ |

---

## G — Multi-account / Dror (dormant — read-only)

**מקור:** [`docs/superpowers/specs/2026-07-01-multi-trading-accounts-TEAM.md`](./superpowers/specs/2026-07-01-multi-trading-accounts-TEAM.md)

| ID | תרחיש | Pass |
|----|--------|------|
| G-1 | CEO מחזור אוטומטי **ללא שינוי** (poller רק CEO) | ☐ |
| G-2 | Dror `isEnabled=0` — **אין** כניסות אוטומטיות לספר Dror | ☐ |
| G-3 | Admin Overview — **רק** CEO; Dror דרך switcher בלבד | ☐ |
| G-4 | Dror login → Overview Holding 1 בלבד; **אין** H1H2 / knowledge / logs | ☐ |
| G-5 | `/war-room/dror` — getStatus scoped; שינוי מינוף **לא** נוגע ב-CEO | ☐ |
| G-6 | קטלוג Dror — 157 USA (`catalogUserId`) | ☐ |

**סקריפטים (Ops / QA):**

```bash
npx tsx scripts/verify-dror-ibind2.ts    # רק אם gateway :5002 עלה
npx tsx scripts/verify-dror-getstatus.ts
```

---

## H — Phase 0 regression (כבר על `main`)

| ID | בדיקה | Pass |
|----|--------|------|
| H-1 | Armed Watcher — `onlyTicker` scope (לא קונה טיקר אחר) | ☐ |
| H-2 | HardSync — לא mass-zombie על תגובת IBKR ריקה | ☐ |
| H-3 | `closePosition` — דורש שורת live (לא IBKR-only fallback) | ☐ |
| H-4 | warReport — RECONCILE מסונן מסטטיסטיקות | ☐ |
| H-5 | `pnpm test` מלא | ☐ |

---

## נספח — perf/tier1-safe-wins (רק אם ממוזג)

**ענף:** `perf/tier1-safe-wins` @ `dfa1549`

| ID | בדיקה | Pass |
|----|--------|------|
| P-1 | `pnpm test server/tier1PerfQa.test.ts` | ☐ |
| P-2 | NLV persist >$0.01 — `warEngine` sizing תואם DB | ☐ |
| P-3 | `fetchBarsForTicker` days=90 — מספר bars **לא** השתנה (invariant) | ☐ |
| P-4 | migration 0146 indexes קיימים ב-live | ☐ |

---

## I — H2 TASE Today אחרי סגירה (17:30+)

**מקור:** [`docs/bugs/2026-07-01-h2-tase-today-zero.md`](./bugs/2026-07-01-h2-tase-today-zero.md)

| ID | תרחיש | תוצאה צפויה | Pass |
|----|--------|-------------|------|
| I-1 | יום חול **19:00–23:00 IL** — Overview H2 TASE | Today **≠ $0** (≈ sum prevClose מה-DB) | ☐ |
| I-2 | שבת — Overview H2 TASE | Today `—` או 0 (לא נתוני שישי) | ☐ |
| I-3 | `pnpm test server/utils/marketHours.taseToday.test.ts` | ירוק | ☐ |

---

## טבלת סיכום לדיווח

| אזור | סה"כ | Pass | Fail | Blocked | הערות |
|------|------|------|------|---------|--------|
| Pre-flight | 8 | | | | |
| A Gold Retest | 4 | | | | |
| B RC2 14% | 4 | | | | |
| C Holdings | 4 | | | | |
| D Position cap | 4 | | | | |
| E Leverage sync | 5 | | | | |
| F Manual | 4 | | | | |
| G Dror | 6 | | | | |
| H Phase 0 | 5 | | | | |
| I H2 TASE Today | 3 | | | | |

**ממצא חוסם (BLOCKER):** כל Fail ב-A, D, E בזמן RTH פעיל.

---

## GO / NO-GO

| תנאי | נדרש |
|------|------|
| PF-0 עד PF-5 | **כולם Pass** |
| אזורים A + D + E | **אפס Fail** |
| שאר אזורים | אפס BLOCKER; Fail מותר עם ticket |

**חתימות:**

| תפקיד | שם | תאריך | GO / NO-GO |
|--------|-----|--------|------------|
| QA Lead | | | |
| Owner | | | |

---

## קישורים

- Changelog: [`docs/bugs/2026-07-01-live-session-changelog.md`](./bugs/2026-07-01-live-session-changelog.md)
- Dynamic VIP (לא לבדיקה): [`docs/superpowers/specs/2026-07-01-dynamic-vip-weekly-priority-spec.md`](./superpowers/specs/2026-07-01-dynamic-vip-weekly-priority-spec.md)
