# GitHub setup — TradeSnow sync (2026-06-25)

## 0. מה הקישור ששלחת? (Projects ≠ Repository)

הקישור:

`https://github.com/users/y0505300530-pixel/projects/1/views/1`

זה **לוח GitHub Projects** (משימות / קנבן) תחת המשתמש `y0505300530-pixel` — **לא** כתובת clone של ריפו ולא URL ל-`git remote add origin`.

לחיבור `/root/tradesnow` ל-GitHub צריך אחד מאלה:

- דף ריפו: `https://github.com/y0505300530-pixel/REPO_NAME`
- SSH: `git@github.com:y0505300530-pixel/REPO_NAME.git`
- HTTPS: `https://github.com/y0505300530-pixel/REPO_NAME.git`

### בדיקה אוטומטית (2026-06-25)

| בדיקה | תוצאה |
|--------|--------|
| `gh auth status` / `gh repo list` | **לא זמין** — `gh` לא מותקן בסביבה הזו |
| API ציבורי `GET /users/y0505300530-pixel/repos` | **ריפו ציבורי אחד:** `crm-app` |
| חיפוש מקומי `github.com/y0505300530-pixel` | **אין** התאמות בקוד (רק placeholders `USER` / `ORG` ב-handoff) |

**התאמה ל-TradeSnow:** אין ריפו בשם `tradesnow`, `tradesnow2`, או דומה. `crm-app` הוא פרויקט CRM נפרד — **אל** תחבר אותו כ-`origin` ל-TradeSnow אלא אם זה בכוונה.

### אם אין ריפו מתאים — צור חדש

1. פתח [github.com/new](https://github.com/new) (מחובר כ-`y0505300530-pixel`).
2. **Repository name:** `tradesnow` (או `tradesnow2` אם השם תפוס).
3. **Private** מומלץ לפרויקט מסחרי.
4. **אל** תסמן README / .gitignore / license (יש כבר היסטוריית git מקומית).
5. אחרי יצירה, השתמש ב-URL המדויק מהדף — לדוגמה:

```bash
git remote add origin git@github.com:y0505300530-pixel/tradesnow.git
```

(החלף `tradesnow` בשם שבחרת.) **לא בוצע push** מכאן — דורש אישורך על שם הריפו.

אם כבר יצרת ריפו **פרטי**, ה-API הציבורי לא יראה אותו — שלח את **קישור הדף של הריפו** או את `git@github.com:...` המדויק.

---

מצב נוכחי בבית (`/root/tradesnow`):

- ענף פעיל: `feat/manual-trading-ux` (גם `master` קיים מקומית)
- **אין `git remote`** — הריפו לא מחובר ל-GitHub
- 3 קומיטים אחרונים:
  - `8727935` refactor(client): split DeepAnalysisModal, per-side STALLED, mobile QA
  - `78835a3` fix(client): mint clientOrderId at submit, persist through STALLED
  - `d7a49ef` wip(client): manual trading UX — QA hardening before server merge
- שינויים רבים לא בקומיט (מחיקות paper lab, UX ידני, וכו')

## 1. צור ריפו ב-GitHub (או השתמש בקיים)

1. התחבר ל-[GitHub](https://github.com/new)
2. **New repository** — שם מומלץ: `tradesnow`
3. **אל** תסמן "Add a README" / `.gitignore` / license (כבר יש היסטוריה מקומית)
4. העתק את ה-URL:
   - SSH (מומלץ): `git@github.com:USER/tradesnow.git`
   - HTTPS: `https://github.com/USER/tradesnow.git`

החלף `USER` בשם המשתמש/ארגון שלך.

## 2. חבר remote

```bash
cd /root/tradesnow   # או נתיב המשרד אחרי clone

git remote add origin git@github.com:USER/tradesnow.git
git remote -v
```

אם `origin` כבר קיים בשגיאה:

```bash
git remote set-url origin git@github.com:USER/tradesnow.git
```

## 3. ודא שלא דוחפים סודות (חשוב)

לפני `git add`, בדוק ש-`.gitignore` מכסה:

| נתיב | סטטוס ב-`.gitignore` (2026-06-25) |
|------|-----------------------------------|
| `.env` | מכוסה |
| `secrets/*.json`, `secrets/*.pem` | מכוסה חלקית — קבצים אחרים ב-`secrets/` **עלולים** להיכנס ל-commit |
| `backups/` | **לא** מכוסה — אל תוסיף (`git add` סלקטיבי) |
| `.price-cache/` | **לא** מכוסה — `prices.json` עלול להידחף |

מומלץ להוסיף ל-`.gitignore` (אופציונלי אך מומלץ):

```
backups/
.price-cache/
secrets/
!secrets/.gitkeep
```

(תקן ל-`!secrets/.gitkeep` אם משאירים קובץ שמירה.)

## 4. Stage + commit (אם צריך)

**אל** תריץ `git add .` עיוור — יש `secrets/`, `backups/`, קבצי hash/session, ו-cache.

דוגמה בטוחה:

```bash
cd /root/tradesnow

# עדכון .gitignore אם הוספת שורות למעלה
git add .gitignore

# קוד + דוקומנטציה (התאם לפי הצורך)
git add client/ server/ drizzle/ docs/ package.json pnpm-lock.yaml ecosystem.config.cjs vitest.config.ts tests/ AGENTS.md .env.example

# אל תכלול: secrets/ backups/ .price-cache/ .env gen_hash.* gen_session.* fix_pw.mts place_sltp.ts run_engine.ts schema_export*.sql catalog_kinetic*.csv elza-backtest-results.json

git status -sb

# אם יש שינויים ל-stage:
git commit -m "$(cat <<'COMMIT'
sync: manual trading UX branch for multi-machine Cursor

COMMIT
)"
```

## 5. Push לענף

```bash
git push -u origin feat/manual-trading-ux
```

אם GitHub ריק ורוצים גם `master`:

```bash
git push -u origin master
```

דרושות: מפתח SSH ב-GitHub או `gh auth login` / Personal Access Token ל-HTTPS.

## 6. במשרד (Cursor / מכונה שנייה)

```bash
git clone git@github.com:USER/tradesnow.git
cd tradesnow
git checkout feat/manual-trading-ux
git pull

pnpm install
cp .env.example .env   # מלא ערכים מקומיים — לא מה-repo
```

## 7. סנכרון שוטף

```bash
# לפני עזיבת בית
git add <קבצים רלוונטיים>
git commit -m "..."
git push

# במשרד
git pull
```

## אבחון מהיר

```bash
git remote -v
git status -sb
git branch -a
git log -3 --oneline
```

---

**מקור:** אין URL אמיתי בפרויקט — רק placeholder ב-`CURSOR_OFFICE_SYNC_2026-06-25.md`. החלף `USER/tradesnow` בכתובת הריפו שלך.

---

## 8. ביצוע אוטומטי (2026-06-25 — Cursor agent)

### מה בוצע בהצלחה (מקומי)

| שלב | סטטוס |
|-----|--------|
| `git remote add origin` | **בוצע** — כעת `origin` = `git@github.com:y0505300530-pixel/tradesnow.git` (הוחלף מ-HTTPS אחרי ניסיון push) |
| Stage סלקטיבי (ללא `secrets/`, `backups/`, `.price-cache/`, `node_modules/`) | **בוצע** — 319 קבצים |
| `git diff --cached` בדיקת סודות | **נקי** — אין `secrets/`, `.env`, `backups/`, `.price-cache/` ב-staged |
| Commit | **בוצע** — `1adf7fa` — `sync: QA sprint + manual trading UX (feat/manual-trading-ux)` |

### Push — **נכשל (אימות)**

**HTTPS (ניסיון ראשון):**

```
fatal: could not read Username for 'https://github.com': No such device or address
```

**SSH (אחרי `ssh-keyscan github.com`):**

```
git@github.com: Permission denied (publickey).
fatal: Could not read from remote repository.
```

אין בסביבה זו מפתח SSH רשום ב-GitHub, ואין PAT/`gh auth` ל-HTTPS.

### איך להשלים push (במכונה שלך)

**אופציה A — SSH (מומלץ):**

```bash
ssh-keygen -t ed25519 -C "your-email" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
# הדבק ב-GitHub → Settings → SSH and GPG keys → New SSH key

cd /root/tradesnow
git remote set-url origin git@github.com:y0505300530-pixel/tradesnow.git
git push -u origin feat/manual-trading-ux
git push -u origin master
```

**אופציה B — HTTPS + Personal Access Token:**

```bash
cd /root/tradesnow
git remote set-url origin https://github.com/y0505300530-pixel/tradesnow.git
git push -u origin feat/manual-trading-ux
# Username: y0505300530-pixel
# Password: <PAT עם scope repo> — לא סיסמת GitHub
git push -u origin master
```

יצירת PAT: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained או classic עם `repo`.

### כתובות ענפים (אחרי push מוצלח)

- ריפו: https://github.com/y0505300530-pixel/tradesnow
- ענף עבודה: https://github.com/y0505300530-pixel/tradesnow/tree/feat/manual-trading-ux
- `master`: https://github.com/y0505300530-pixel/tradesnow/tree/master

### Clone במשרד (שורה אחת)

```bash
git clone git@github.com:y0505300530-pixel/tradesnow.git && cd tradesnow && git checkout feat/manual-trading-ux
```

(HTTPS: `git clone https://github.com/y0505300530-pixel/tradesnow.git` — אחרי שהריפו קיבל לפחות push אחד.)

