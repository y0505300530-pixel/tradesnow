# אימות Google Drive — TradeSnow

סביבת Cursor לא מגיעה עם OAuth ל-Gmail. שתי דרכים נתמכות:

## אופציה A — Service Account (מומלץ לאוטומציה)

1. פתח [Google Cloud Console](https://console.cloud.google.com/)
2. פרויקט חדש או קיים → **APIs & Services** → **Enable APIs** → חפש **Google Drive API** → Enable
3. **IAM & Admin** → **Service Accounts** → **Create**
4. לחץ על החשבון → **Keys** → **Add key** → **JSON** → שמור את הקובץ
5. העתק לשרת:
   ```bash
   mkdir -p /root/tradesnow/secrets
   # העלה את הקובץ ל:
   # /root/tradesnow/secrets/google-service-account.json
   ```
6. ב-Drive (Y0505300530@GMAIL.COM) — שתף את תיקיית היעד עם `client_email` מה-JSON (הרשאת **Editor**)
7. הרץ:
   ```bash
   cd /root/tradesnow
   chmod +x scripts/gdrive-setup.sh scripts/gdrive-upload-handoff.sh
   ./scripts/gdrive-setup.sh   # בחר 1
   ./scripts/gdrive-upload-handoff.sh
   ```

## אופציה B — OAuth מהמחשב שלך

אם אין לך GCP / Service Account:

1. התקן rclone במחשב המקומי: https://rclone.org/install/
2. הרץ:
   ```bash
   rclone authorize drive
   ```
3. התחבר עם `Y0505300530@GMAIL.COM` בדפדפן
4. העתק את ה-JSON ש-rclone מדפיס
5. בשרת Cursor:
   ```bash
   ./scripts/gdrive-setup.sh   # בחר 2 → הדבק את ה-JSON
   ./scripts/gdrive-upload-handoff.sh
   ```

## משתני סביבה (אופציונלי)

```bash
GDRIVE_REMOTE_NAME=tradesnow-gdrive
GDRIVE_HANDOFF_FOLDER=TradeSnow/Manual Trading UX
GDRIVE_SERVICE_ACCOUNT_FILE=/root/tradesnow/secrets/google-service-account.json
```

## אבטחה

- **אל תעלה** `secrets/` או `~/.config/rclone/` ל-git
- Service Account JSON = מפתח רגיש — רק בתיקיית `secrets/` (ב-gitignore)

## מה מועלה

תיקיית handoff: `docs/superpowers/handoff/cursor-manual-trading-ux-2026-06-25/`  
+ ZIP באותו שם — ל-Claude / Base44.
