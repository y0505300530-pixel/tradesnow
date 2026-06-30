# Cursor Office Sync — TradeSnow (25 Jun 2026)

**מטרה:** מעבר מ-Cursor על ה-droplet ל-Cursor במשרד (מחשב אחר, ללא סנכרון workspace).  
**נתיב SSOT על השרת:** `/root/tradesnow`  
**ענף עבודה:** `feat/manual-trading-ux`  
**פרוד:** כבר deployed על ה-droplet — https://trade-snow2.vip (`pm2`: `tradesnow-app`)

---

## מצב Git (נלכד 25 Jun 2026)

| שדה | ערך |
|-----|-----|
| **Branch** | `feat/manual-trading-ux` (HEAD `8727935`) |
| **Remote** | **אין** `origin` — רק repo מקומי על ה-droplet |
| **מול `master`** | 3 commits על הענף (מעל `d8e41e1`) |
| **Upstream / unpushed** | אין tracking — אין push אפשרי בלי להוסיף remote |
| **Working tree** | **לא נקי** — ~139 tracked changes + ~158 untracked (סה״כ ~297 שורות ב-`git status`) |
| **סטטיסטיקה** | `git diff --stat HEAD` → 139 קבצים, +6761 / −44682 (כולל הסרת Paper/Trading Lab) |

### Commits על הענף (לא ב-master)

```
8727935 refactor(client): split DeepAnalysisModal, per-side STALLED, mobile QA
78835a3 fix(client): mint clientOrderId at submit, persist through STALLED
d7a49ef wip(client): manual trading UX — QA hardening before server merge
```

### Gate חשוב

**אל תמזגו ל-`main` / `master` עד ש-A6 (E2E `placeManualOrder`) עובר.** ראו `docs/superpowers/2026-06-25-MASTER-OPEN-ITEMS.md` (B10 חסום על A6).

---

## אפשרויות סנכרון (מדורג)

1. **Git push/pull (הכי טוב)** — רק אם מוסיפים remote (GitHub/GitLab) ודוחפים את הענף. אז במשרד: `git clone` + `git checkout feat/manual-trading-ux` + `git pull`.
2. **אותו droplet ב-SSH (מומלץ כרגע)** — שני ה-Cursors עורכים את **אותו** `/root/tradesnow` על השרת (Remote-SSH ב-Cursor). אין סכנת fork בין מחשבים.
3. **Cursor Cloud / repo משותף** — אם תוגדר ענן או remote מאוחר יותר; לא מוגדר היום.

**מקור אמת כיום:** ה-droplet ב-`/root/tradesnow` (hostname בדיקה: `IBRK`). אין remote = **אין גיבוי Git מחוץ לשרת** עד שתגדירו אחד.

---

## לפני שיוצאים מהמכונה הזו (droplet / Cursor נוכחי)

### אם יש (או תוסיפו) remote ב-GitHub

**אל תעלו סודות:** `.env`, `secrets/`, `backups/*.sql`, קבצי `.env.bak*`, סיסמאות ב-`gen_hash.*` / `fix_pw.mts`, וכל דבר עם credentials.

```bash
cd /root/tradesnow
git status -sb
git branch

# אופציונלי: הוספת remote (החלף URL)
# git remote add origin git@github.com:ORG/tradesnow.git

# stage רק מה שבטוח (דוגמה — התאימו לפי צורך)
git add AGENTS.md docs/superpowers/ client/ server/ drizzle/ package.json pnpm-lock.yaml vitest.config.ts vitest.setup.ts tests/
# אל תעשו: git add secrets/ .env backups/

git commit -m "$(cat <<'EOF'
feat: manual trading UX QA sprint — client Wave 2 + live safety server

EOF
)"

git push -u origin feat/manual-trading-ux
```

### בלי remote (מצב נוכחי) — חובה לפחות commit מקומי על השרת

כך שלא תאבדו עבודה אם משהו ידרוס את ה-working tree:

```bash
cd /root/tradesnow
git add -A
# לפני commit: בטלו staging לסודות אם נכנסו:
# git reset HEAD secrets/ .env .env.example  # שמרו .env.example אם רוצים
git status
git commit -m "wip: QA sprint snapshot 2026-06-25 before office handoff"
```

**אז במשרד:** התחברו SSH לאותו שרת ופתחו `/root/tradesnow` — אין צורך ב-pull ממקום אחר.

### SSH לדוגמה (התאימו host/user)

```bash
ssh root@<DROPLET_IP_OR_HOSTNAME>
cd /root/tradesnow && git status -sb && git log -3 --oneline
```

---

## Cursor במשרד (סשן חדש)

### קראו קודם

1. `docs/superpowers/handoff/CLAUDE_QA_HANDOFF_2026-06-25.md`
2. `docs/superpowers/QA_GREEN_REPORT_2026-06-25.md`
3. `AGENTS.md`

### חיבור לפרויקט

- **מומלץ:** Cursor → Remote SSH → פתחו `/root/tradesnow`, ענף `feat/manual-trading-ux`.
- **אם הוספתם remote:** `git fetch && git checkout feat/manual-trading-ux && git pull`.

### כללים

- **לא** merge ל-`main`/`master` עד A6 (ראו MASTER open items).
- פרוד כבר רץ על ה-droplet; deploy נוסף רק אחרי build/tests מודעים.
- בעלות: Cursor = בעיקר `client/`; שרת/IBKR/live writes = לפי `AGENTS.md` ו-handoff ל-Claude.

---

## קבצים מרכזיים — ספרינט QA (docs + code)

### מסמכים (25 Jun)

| קובץ | תפקיד |
|------|--------|
| `docs/superpowers/QA_GREEN_REPORT_2026-06-25.md` | סטטוס GREEN + prod smoke |
| `docs/superpowers/QA_FIX_SPRINT_2026-06-25.md` | רשימת תיקונים |
| `docs/superpowers/QA_FULL_SYSTEM_AUDIT_2026-06-25.md` | אודיט מערכת |
| `docs/superpowers/2026-06-25-MASTER-OPEN-ITEMS.md` | A-items, gates (A6, B10) |
| `docs/superpowers/handoff/CLAUDE_QA_HANDOFF_2026-06-25.md` | מסירה ל-Claude |
| `docs/superpowers/specs/2026-06-24-manual-trading-ux-spec.md` | spec UX |
| `docs/superpowers/AGENT-DISPATCH-GUIDE.md` | dispatch סוכנים |
| `AGENTS.md` | roster סוכנים |

### Client (Wave 2 / QA)

- `client/src/lib/orderEventManager.ts` — B1, 7 מצבי הזמנה
- `client/src/components/OrderStatusPopup.tsx` — STALLED / echo
- `client/src/components/DeepAnalysisModal.tsx` + `client/src/components/deep-analysis/*` — פיצול מודאל, SL/TP
- `client/src/components/deep-analysis/ManualOrderDialog.tsx` — presets, עברית
- `client/src/lib/zIndex.ts`, `client/src/lib/mutationErrors.ts`
- `client/src/pages/WarRoomLive.tsx`, `client/src/pages/TradeManager.tsx` + sections
- `client/src/components/GlobalNav.tsx`, `client/src/components/PWAInstallPrompt.tsx`

### Server (live safety + ניקוי lab — **רבים uncommitted**)

- `server/routers/liveEngine.ts` — CR-02 `adminProcedure`
- `server/routers/ibkrProxy.ts` — CR-03 2FA
- `server/manualOrderIdempotency.ts` — idempotency (A7: DB עדיין פתוח)
- `server/liveSlTpEnforcement.ts`, `server/liveOrderExecutor.ts`
- `server/warEngine.ts`, `server/executePartial.ts` — A3 snapshot→quotes
- הסרות: `server/paperLab*`, `server/routers/paperLab.ts`, `server/routers/tradingLab.ts`, דפי `TradingLab` ב-client

### בדיקות

- `vitest.setup.ts`, `server/portfolioHoldingsSync.test.ts`, סדרת `server/liveSafety.test.ts` ועוד — **299/299** לפי QA report

---

## עבודה לא committed — המלצה לפני יציאה

יש **שינויי עבודה מקומיים גדולים** שלא ב-3 ה-commits האחרונים. לפני מעבר למשרד:

1. הריצו **commit מקומי** על ה-droplet (פקודות למעלה), או
2. הוסיפו **remote** ו-**push** את `feat/manual-trading-ux`.

### קטגוריות ב-`git status` (לא לכלול ב-commit ציבורי)

| אל תעלו | דוגמאות |
|---------|---------|
| סודות | `secrets/`, `.env`, `.env.bak*` |
| גיבויי DB | `backups/userAssets_*.sql`, `schema_export_*.sql` |
| זמני / MCP | `.playwright-mcp/`, `*.predeploy_*`, `WarRoomLive.tsx.*fix*` |
| cache מחירים (אופציונלי) | `.price-cache/prices.json` |

### קבצים חדשים חשובים ל-stage (אם עושים commit סלקטיבי)

`AGENTS.md`, `docs/superpowers/**`, `client/src/lib/orderEventManager.ts`, `client/src/components/deep-analysis/`, `server/manualOrderIdempotency.ts`, `server/liveSlTpEnforcement.ts`, `tests/*.spec.ts`, `vitest.setup.ts`

### שינויים tracked עיקריים (מדגם)

`client/src/components/DeepAnalysisModal.tsx`, `OrderStatusPopup.tsx`, `GlobalNav.tsx`, `PortfolioOverview.tsx`, `server/routers/liveEngine.ts`, `server/routers/portfolio.ts`, `server/warEngine.ts`, `drizzle/schema.ts`, `ecosystem.config.cjs`, `package.json`

---

## One-liner prompt — הדביקו ב-Cursor במשרד

```
TradeSnow office handoff 2026-06-25: workspace /root/tradesnow on droplet (or git pull feat/manual-trading-ux if remote exists). Read docs/superpowers/handoff/CLAUDE_QA_HANDOFF_2026-06-25.md, docs/superpowers/QA_GREEN_REPORT_2026-06-25.md, AGENTS.md. Branch feat/manual-trading-ux; prod already deployed at https://trade-snow2.vip. Do NOT merge main until A6 E2E placeManualOrder passes. Continue from docs/superpowers/2026-06-25-MASTER-OPEN-ITEMS.md; Cursor owns client/, respect admin-only live orders (CR-02).
```

---

## תקציר בעברית למנהל הצ'אט (Orchestrator)

**מצב:** ענף `feat/manual-trading-ux`, 3 commits מעל master, **אין git remote**, **~297 קבצים** בסטטוס (עבודת QA + הסרת Paper Lab לא שמורה ב-git מעבר ל-commits הקיימים). **פרוד על ה-droplet כבר ירוק.**

**פקודות להריץ עכשיו לפני יציאה למשרד:**

```bash
cd /root/tradesnow
git status -sb | head -20
git commit -am "wip: QA sprint snapshot 2026-06-25 office handoff" 2>/dev/null || true
# אם נכשל כי יש untracked — השתמשו ב:
git add AGENTS.md docs/superpowers/ client/ server/ drizzle/ package.json pnpm-lock.yaml vitest.config.ts vitest.setup.ts tests/
git reset HEAD secrets/ .env backups/ 2>/dev/null; git status
git commit -m "wip: QA sprint snapshot 2026-06-25 office handoff"
```

**אם יש GitHub:** הוסיפו `git remote add origin <URL>` ואז `git push -u origin feat/manual-trading-ux` (בלי `secrets/` ו-`.env`).

**במשרד:** Cursor Remote-SSH ל-`/root/tradesnow` **או** clone + pull אותו ענף. קראו את שלושת קבצי ההקשר למעלה. **לא למזג main עד A6.**

---

*נוצר אוטומטית לסנכרון משרד — 2026-06-25*
