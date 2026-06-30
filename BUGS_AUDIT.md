# Bug Audit — tradesnow.vip v18.98 — May 11, 2026

## 🔴 Critical Bugs

### 1. Overview — H2 Crypto שווי שגוי
- **תיאור:** Overview מציג H2 Crypto = $5,394 (3 positions)
- **אבל** ב-Trade Manager H2 Crypto = $83,757 (3 positions: ETH-USD, BTC-USD, XRP-USD)
- **סיבה:** Overview מחשב H2 Crypto רק לפי מחירים של Yahoo Finance ב-USD, אבל H2 Crypto כולל גם Crypto שמחושב אחרת
- **השפעה:** All Accounts מציג $373,352 במקום ~$451,644 (כפי שמוצג ב-Trade Manager)
- **ILS:** ₪1,087,015 במקום ₪1,314,963

### 2. Breakout Scanner — כפילויות בכרטיסיות
- **תיאור:** אותה מניה (SNDK, MU) מופיעה עשרות פעמים בדף Gold Breakout
- **סיבה:** הסריקה שומרת כל סריקה כרשומה חדשה ב-DB ולא מחליפה את הישנה
- **השפעה:** 100 כרטיסיות מתוכן 32 בתיק — רובן כפילויות של SNDK ו-MU

### 3. Telegram Monitor (News) — תקוע על "טוען פידים..."
- **תיאור:** דף ניטור חדשות נשאר על spinner ולא טוען תוכן
- **השפעה:** הדף לא שמיש

### 4. Asset Catalogue — מציג 0 assets
- **תיאור:** הדף נטען עם 0 assets בטבלה (skeleton rows ריקות)
- **ייתכן:** בעיית טעינה ראשונית, הנתונים לא נטענים אוטומטית

## 🟡 Medium Bugs

### 5. H1 Today P&L — מציג "—" ו-0 במקום ערך
- **תיאור:** ב-Overview, Holding 1 מציג Today = "—" ו-0 בעמודת Today $
- **אבל** ב-Trade Manager H1 Today P&L = -$270
- **השפעה:** נתון לא עקבי בין הדפים

### 6. History — כמה סרטונים עם status "error" ו-"processing"
- **תיאור:** 3 סרטונים עם status "error", 1 עם "processing" (מ-4/26/2026 — תקוע)
- **השפעה:** סרטונים תקועים לא מנוקים אוטומטית

### 7. Settings — System Logs מציגים "empty" לכולם
- **תיאור:** כל 4 קבצי הלוג מציגים "empty" גם אחרי Refresh
- **ייתכן:** הלוגים לא נכתבים בפרודקשן

### 8. Breakout Scanner — "0 Retest זהב" בסטטיסטיקות
- **תיאור:** הסטטיסטיקה מציגה "0 Retest זהב (30י')" למרות שיש Tab של Retest
- **השפעה:** מבלבל

## 🟢 Minor Issues

### 9. Mobile Bottom Nav — צבע טקסט כהה מדי
- **תיאור:** בנייד, הטקסט של כפתורי הניווט התחתון כהה מדי (כמעט שחור על רקע כהה)
- **נראה ב:** Screenshots של Bottom Nav

### 10. Overview — IBKR Live progress bar "0/34"
- **תיאור:** מציג "0/34" בזמן טעינה — יכול לבלבל משתמשים

### 11. /tools → 404 (כבר תוקן בסשן הזה)

### 12. /alerts — Telegram לא-אדמין (כבר תוקן בסשן הזה)
