# QA Audit Report — TradeSnow2 Full System

**תאריך:** 25 ביוני 2026  
**יעד:** https://trade-snow2.vip (trade-snow2.com) — **כל המערכת**  
**בודק:** Cursor Orchestrator + QA / Security / Routes / P&L subagents  
**Build מקומי:** `npm run build` ✅  
**Production smoke:** `/login` @375 — OK; `/trade` — **ReferenceError `ibkr is not defined`** (עד deploy תיקון CapitalSummaryCards)

---

## Executive Summary

| אזור | סטטוס | ממצאים עיקריים |
|------|--------|----------------|
| **🔴 Critical** | לא לשחרר בלי תיקון | Crash `/trade`, אבטחת מסחר חי, P&L שקרי בטבלאות |
| **🟠 High** | לפני merge B10 | 2FA gap, P&L drift בין מסכים, popup traps |
| **🟡 Medium** | שבוע 1–2 | מובייל, perf, JSON.parse crashes |
| **🟢 Low** | backlog | polish, copy, lazy-load |

**ספירה:** 🔴 8 · 🟠 14 · 🟡 18 · 🟢 12

---

## 🔴 Critical — חובה לפני production מלא

| ID | ממצא | איפה | סיכון |
|----|------|------|--------|
| **CR-01** | **Trade Manager קורס** — `ReferenceError: ibkr is not defined` | `CapitalSummaryCards.tsx:171` | כל `/trade` — white screen |
| **CR-02** | **מסחר חי לכל משתמש מאומת** — `placeManualOrder` / `closePosition` על `protectedProcedure` | `liveEngine.ts:561,685` | כסף אמיתי לא רק admin |
| **CR-03** | **Express `/api/ibind/order` בלי 2FA** — `requireAdmin` בודק role בלבד | `ibkrProxy.ts:52-62` | admin JWT ללא TOTP → פקודות |
| **CR-04** | **closePosition fallback IBKR** בלי בדיקת userId | `liveEngine.ts:606-673` | סגירת פוזיציות על חשבון משותף |
| **CR-05** | **כמות UI ≠ IBKR** (כניסות) — `tryLiveEntry` מחשב qty מחדש | `liveEngine.ts` + popup | משתמש מאשר X, נשלח Y |
| **CR-06** | **מכירה חלקית = 100% בשרת** (אם C2 לא deployed) | `ManualOrderDialog` + `executeLiveSell` | preset 25% שולח הכל |
| **CR-07** | **War Room popup trap** על שגיאה — `trackPositionClose` חוסם dismiss | `WarRoomLive.tsx` + `OrderStatusPopup` | תקוע ב"שולח..." |
| **CR-08** | **131 orphan IBKR orders** | MASTER A2 | brackets יתומים, בלבול SL/TP |

### CR-01 — תיקון (מוכן ב-repo, לא ב-prod)

```ts
// CapitalSummaryCards.tsx — summaryIsLive + ibkrTodayPnl (לא ibkr)
const h1TodaySource = portfolioMetrics != null && summaryIsLive && ibkrTodayPnl != null
  ? "IBKR /pnl" : priceSource;
```

**Deploy:** `npm run build && pm2 restart tradesnow-app`

---

## 🟠 High — לפני merge / מסחר יומי

### אבטחה

| ID | ממצא | קובץ |
|----|------|------|
| **HI-S1** | משתמשי `local:` ללא TOTP יכולים לסחור | `twoFactor.ts:109-114` |
| **HI-S2** | `shortScan.execute` — `protectedProcedure` + live | `shortScan.ts:113` |
| **HI-S3** | `priceCache.clearTickerAdmin` — אין בדיקת admin | `priceCache.ts:219` |
| **HI-S4** | `IBIND_API_SECRET` = גם internal sync bearer | `ibkrProxy.ts:556` |
| **HI-S5** | HMAC secret prefix/suffix בלוג boot | `index.ts:260` |
| **HI-S6** | Login ללא rate limit ייעודי | `localAuth.ts` |

### פונקציונליות מסחר

| ID | ממצא | סטטוס |
|----|------|--------|
| **HI-T1** | `orderId: null` / polling — STALLED מטעה | C3 deployed — לאמת ב-E2E A6 |
| **HI-T2** | שגיאת submit סוגרת popup (לא REJECTED) | תוקן ב-branch — לאמת |
| **HI-T3** | SHORT לא מזוהה כש-conid קיים | תוקן ב-branch — לאמת |
| **HI-T4** | `adminProcedure` על ibkr.ts vs `protected` על liveEngine | מדיניות מוצר — להחליט |
| **HI-T5** | סגירה דורשת שורה ב-livePositions | `NOT_FOUND` על IBKR-only |
| **HI-T6** | Engine לא סוחר — snapshot 404 | MASTER A3 |
| **HI-T7** | Idempotency in-memory — אובד ב-restart | MASTER A7 |

### P&L / SSOT (מספרים שונים בין מסכים)

| ID | ממצא | מסכים |
|----|------|--------|
| **HI-P1** | H1H2Dashboard — H1 מ-DB בלי overlay IBKR | vs Trade Manager |
| **HI-P2** | שורות Today בטבלה ≠ כרטיס Today (change×units vs `/pnl`) | Trade Manager |
| **HI-P3** | H1H2 footer סוכם שורות, כרטיס מציג IBKR account | H1H2 |
| **HI-P4** | Overview `isAdmin = true` קשיח | `PortfolioOverview.tsx:113` |
| **HI-P5** | Overview footer Today % ≠ unifiedTodayPct | Overview |
| **HI-P6** | War Room — שורות vs header (מכוון חלקית) | War Room |

### Auth / Routes

| ID | ממצא |
|----|------|
| **HI-A1** | `/war-room-live`, `/ibkr-account` — `RequireAdmin` בלי `RequireVerified` |
| **HI-A2** | Admin Trade Manager — כל העמוד חסום בלי IBIND session |

---

## 🟡 Medium — מובייל + UI + יציבות

### מובייל (@375)

| ID | ממצא | מסך |
|----|------|-----|
| **ME-01** | PWA "התקן" חופף טופס login | `/login` |
| **ME-02** | עין סיסמה חופפת placeholder | `/login` |
| **ME-03** | GlobalNav "כניסה" גם ב-login | `/login` |
| **ME-04** | Command bar hints רועשים מתחת grid | Deep Analysis |
| **ME-05** | PREV/NEXT/✕ צפופים ב-header | Deep Analysis |
| **ME-06** | War Room טבלה רחבה — scroll אופקי | War Room |
| **ME-07** | z-index — nav drawer vs dialogs (B7) | גלובלי |
| **ME-08** | Stepper Order popup — dots only < sm | תוקן ב-branch |

### UI / UX (Spec manual-trading)

| ID | ממצא | Spec |
|----|------|------|
| **UI-01** | BUY/SHORT disabled במקום active+warning | §1.1 |
| **UI-02** | כפתורים נעלמים כש-IBKR down (לא disabled+tooltip) | §1.1 |
| **UI-03** | `returnTo` נשמר, לא נצרך ב-close | §3.2 |
| **UI-04** | UI כפול למסחר (command bar + admin panel) | §5.4 |
| **UI-05** | preset $15K חסר; grid-cols-3 (B5) | §5.1 |
| **UI-06** | B2 protection banner — verified only | §4.4 |
| **UI-07** | B9 SL badge shorts (BUY side) | pnl-audit |

### יציבות / Crash

| ID | ממצא | קובץ |
|----|------|------|
| **ST-01** | `JSON.parse` ללא try/catch | `Home.tsx:85,253` |
| **ST-02** | `JSON.parse` על expand לוג | `LogsPage.tsx` |
| **ST-03** | `dailyReview.*.map` ללא `?? []` | `AnalysisSection.tsx` |
| **ST-04** | `videoTitle.slice` אם null | `WatchlistPage` |

### ביצועים

| ID | ממצא |
|----|------|
| **PF-01** | War Room — poll 3s/5s — כבד במובייל |
| **PF-02** | Trade Manager ~240KB chunk |
| **PF-03** | Asset Catalogue ~2410 LOC |
| **PF-04** | H1H2 — `PortfolioPerformanceChart` לא lazy |

---

## 🟢 Low — שיפורים

| ID | שיפור |
|----|--------|
| **LO-01** | CDN תמונות login broken בחלק מהסביבות |
| **LO-02** | TradingView — אין `onerror` על script |
| **LO-03** | JWT TTL שנה — לקצר |
| **LO-04** | `appId` לא מאומת ב-JWT |
| **LO-05** | Debug logs `?key=LOG_SECRET` ב-URL |
| **LO-06** | TradingView webhook secret ב-URL |
| **LO-07** | Lazy-load charts ב-H1H2 / PortfolioDetail |
| **LO-08** | Split DeepAnalysisModal (B3) |
| **LO-09** | B6 placeholder SL/TP עברית |
| **LO-10** | ErrorBoundary per heavy page |
| **LO-11** | Throttle polls when tab hidden |
| **LO-12** | ADR מסמך SSOT P&L (Architect) |

---

## מטריצת מסכים (Production)

| מסך | נתיב | Auth | מובייל | Prod smoke | הערה |
|-----|------|------|--------|------------|------|
| Login | `/login` | Public | 🟡 | ✅ טופס | PWA overlap |
| Trade Manager | `/trade` | Verified | — | 🔴 **CRASH** | CR-01 |
| War Room | `/war-room-live` | Admin | 🟡 | לא נבדק (auth) | HI-T7, PF-01 |
| Overview | `/overview` | Verified | 🟡 | לא נבדק | HI-P4,P5 |
| H1H2 | `/h1h2` | Verified | 🟡 | — | HI-P1,P3 |
| Catalogue | `/catalogue` | Verified | 🟡 | — | PF-03 |
| Deep Analysis | `/deep-analysis/:t` | Verified | 🟡 | — | UI-01..06 |
| Settings | `/settings` | Verified | OK | — | |
| Breakout | `/breakout` | Verified | OK | — | dedup ✅ |
| Splash | `/splash` | Verified | OK | — | → overview |
| IBKR Account | `/ibkr-account` | Admin | — | — | HI-A1 |

---

## תוכנית עבודה מומלצת (סדר ביצוע)

### היום (P0)

1. **Deploy CR-01** — CapitalSummaryCards fix → `/trade` חי
2. **החלטת מדיניות CR-02** — admin-only live vs כל verified user
3. **HI-S1 + HI-S3** — 2FA על ibind Express + clearTickerAdmin

### השבוע (P1)

4. **HI-P1..P3** — שורות Today → `computeTodayPnl` בלבד; IBKR overlay ב-H1H2
5. **ST-01..03** — JSON.parse + dailyReview guards
6. **HI-A1** — `RequireVerified` בתוך admin routes
7. **A6 E2E** — market open → B10 merge

### שבוע 2 (P2)

8. Mobile ME-01..07, UI spec B1-B9
9. A3 engine quotes, A7 DB idempotency, A2 orphan cleanup
10. Perf PF-01..04

---

## Actionable Fixes — Top 5

### 1. Deploy Trade Manager crash (CR-01)
```bash
cd /root/tradesnow && npm run build && pm2 restart tradesnow-app
```

### 2. Guard dailyReview (ST-03)
```tsx
{(dailyReview.holdingActions ?? []).map(...)}
{(dailyReview.alerts ?? []).length}
{dailyReview.sensitivity?.sectorExposure?.map(...) ?? null}
```

### 3. Overview isAdmin (HI-P4)
```tsx
const { user } = useAuth();
const isAdmin = user?.role === "admin";
```

### 4. Row Today SSOT (HI-P2)
```tsx
// HoldingsSection — use computeTodayPnl from usePortfolioMetrics export
todayPnl={computeTodayPnl(h.units, h.buyPrice, ...)}
```

### 5. Express 2FA mirror (CR-03)
```ts
// requireAdmin in ibkrProxy — reject if needs2fa (mirror createContext)
```

---

## קישורים

- MASTER: `docs/superpowers/2026-06-25-MASTER-OPEN-ITEMS.md`
- Manual UX QA (25 Jun): `docs/superpowers/handoff/.../QA_AUDIT_REPORT_2026-06-25.md`
- Spec: `docs/superpowers/specs/2026-06-24-manual-trading-ux-spec.md`

**Gate לשחרור:** CR-01 deployed · 0 Critical QA · A6 ✅ · B10 merge
