# Claude Handoff — Dynamic VIP (עדכון owner)

> **מאת:** Cursor (אפיון) · **ל:** Claude (commit + מימוש)  
> **תאריך:** 2026-07-01 (עדכון שני באותו יום)  
> **Spec SSOT:** [`2026-07-01-dynamic-vip-weekly-priority-spec.md`](./2026-07-01-dynamic-vip-weekly-priority-spec.md) — **קרא את § Amendment לפני קוד**

---

## מה לעשות

1. **Commit** את שני קבצי האפיון ל-`main` (או ענף `feat/dynamic-vip`):
   - `docs/superpowers/specs/2026-07-01-dynamic-vip-weekly-priority-spec.md`
   - `docs/superpowers/specs/2026-07-01-dynamic-vip-claude-handoff.md` (הקובץ הזה)

2. **מימוש** לפי האפיון המעודכן — Phase 0 קודם (dry-run + לוג).

---

## עדכון owner (חובה — מחליף סעיפים ישנים)

### A. תדירות: **יומי**, לא שבועי

| לפני (v1) | אחרי (v2 — מאושר) |
|-----------|-------------------|
| ראשון 17:00 IL, פעם בשבוע | **כל יום 17:00 Asia/Jerusalem** (לפני pre-RTH) |
| `weekId` ב-JSON | `dayId` — `YYYY-MM-DD` |

**סיבה:** פצצות אנרגיה משתנות יום-יום; רענון שבועי מאוחר מדי.

**Cron:** `alertPoller` — `0 17 * * *` TZ=Asia/Jerusalem (או equivalent בקוד הקיים).

---

### B. `selected_team` — **נמחק (owner 2026-07-01)**

Owner: *"זה סתם בלאגן — תמחוק את שלי."*

| פעולה | סטטוס |
|--------|--------|
| `DELETE FROM systemSettings WHERE key='selected_team'` | migration **0149** |
| `DEFAULT_SELECTED_TEAM` בקוד | `[]` — לא seed מחדש |
| `seedSelectedTeam()` | no-op |
| `getSelectedTeamSet()` | מחזיר **Set ריק** (עד dynamic VIP) |
| UI ⭐ מ-`getSelectedTeam` | **אין** — עד `dynamic_vip` Phase 1 |

---

### C. איך נבחרות פצצות (VIP-A ⭐⭐) — לתיעוד ב-commit message

```
1. אוניברס: קטלוג USA, catalogStatus != IPO_INCUBATOR, kineticScore != null
2. קשיח: close < EMA50 → BENCH (מיד)
3. ניקוד 0–6: מבנה (EMA50/200, WK slope) + מומנטום (kinetic≥70, final≥7.5) + סקטור top-3
4. ≥5 נקודות → מועמד VIP-A; ≥3 → VIP-B; אחרת BENCH
5. VIP-A = top 12 לפי סכום נקודות (tie: kineticScore desc)
6. VIP-B = עד 20 הבאים (≥3 נקודות, לא ב-VIP-A)
```

Override ידני בלבד: `dynamic_vip_pins`, `dynamic_vip_demotes`, `snoozedTickers`.

---

### D. מה נשאר מהאישור הקודם (לא השתנה)

- סף tier tiebreak: **0.5** `finalScore`
- VIP-A cap: **12**
- Phase 2 BENCH exit: **כן** (`benchAutoExitEnabled`)
- `rank boost ≠ gate bypass`

---

## שינויי קוד צפויים (רמזים)

| קובץ | שינוי |
|------|--------|
| `server/dynamicVip.ts` | `refreshDailyVip()` לא weekly |
| `server/selectedTeam.ts` | `@deprecated` — כש `dynamicVipEnabled` → no-op / delegate |
| `server/warEngine.ts` | הסר `selectedTeam` tiebreak; השתמש ב-tier + kinetic |
| `server/intradayArmedWatcher.ts` | tiebreak tier בלבד |
| `client/AssetCatalogue.tsx` | `vip` מ-`getDynamicVip` לא `getSelectedTeam` |
| `server/alertPoller.ts` | cron יומי 17:00 IL |

---

## בדיקות לעדכן

- **INV-5 (מעודכן):** `dynamicVipEnabled=1` → `selected_team` **לא משפיע** על sort (גם אם הטיקר ב-DEFAULT)
- **INV-8 (חדש):** אחרי refresh יומי, `refreshedAt` בתוך 24h; `dayId` = היום IL
- **INV-6:** Pin/Demote שורד **refresh יומי**

---

## לא לעשות

- ~~לא למחוק migration `0144_selected_team_seed.sql`~~ — 0144 נשאר בהיסטוריית Git; **0149 מוחק את השורה ב-live**
- לא לעשות deploy mid-RTH
- לא `drizzle-kit push` על live

---

## פקודות מוצעות

```bash
git add docs/superpowers/specs/2026-07-01-dynamic-vip-weekly-priority-spec.md \
        docs/superpowers/specs/2026-07-01-dynamic-vip-claude-handoff.md
git commit -m "$(cat <<'EOF'
docs: dynamic VIP daily refresh + deprecate static selected_team

Owner amendment: VIP tiers refresh daily at 17:00 IL; selected_team
is no longer used when dynamicVipEnabled=1. Handoff for Phase 0 impl.
EOF
)"
```

אחרי Phase 0 dry-run — PR נפרד ל-`server/dynamicVip.ts`.
