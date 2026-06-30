# Handoff Cursor → Claude — Manual Trading UX

**תאריך:** 25 ביוני 2026  
**Branch:** `feat/manual-trading-ux` (לא merged ל-main)  
**חשבון IBKR חי:** U16881054  
**גבולות Cursor:** `client/` בלבד · אפס הזמנות חיות · אפס פריסה

> **עדכון QA (25 Jun):** דוח handoff מעודכן — [`../CLAUDE_QA_HANDOFF_2026-06-25.md`](../CLAUDE_QA_HANDOFF_2026-06-25.md)  
> (Wave 2 deployed, CR-02 admin-only, 299/299 tests, A6/B10 gates)

---

## תקציר ל-Claude

Cursor סיים את שכבת ה-UI למסחר ידני לפי  
`2026-06-24-manual-trading-ux-spec.md`.  
**השרת שלך חוסם merge** — `liveEngine.placeManualOrder` עדיין לא קיים ב-AppRouter.

הסיכון הכספי #1 שזוהה ב-QA: **הזמנה כפולה אחרי STALLED**.  
ה-UI מוכן עם `clientOrderId` + חסימה per `ticker:side`; **חובה** idempotency בשרת.

---

## Commits ב-branch (3 רלוונטיים)

```
8727935 refactor(client): split DeepAnalysisModal, per-side STALLED, mobile QA
78835a3 fix(client): mint clientOrderId at submit, persist through STALLED
d7a49ef wip(client): manual trading UX — QA hardening before server merge
```

---

## מה Cursor בנה (client/)

### רכיבים חדשים (לסקור קודם)

| קובץ | תפקיד |
|------|--------|
| `client/src/lib/manualOrderContract.ts` | טיפוסים, `clientOrderId`, `isValidLivePrice` |
| `client/src/lib/orderFlightRegistry.ts` | STALLED/inflight per `TICKER:BUY` / `TICKER:SELL` |
| `client/src/components/HoldToConfirmButton.tsx` | hold 600ms, pointer capture, Enter→dialog |
| `client/src/components/TradeActionGrid.tsx` | grid 2×4, SHORT dashed amber, `blockedBuy`/`blockedSell` |
| `client/src/components/OrderStatusPopup.tsx` | STALLED 25s, טקסט "ייתכן שבוצע", כפתור IBKR בלבד |
| `client/src/components/deep-analysis/TradingCommandBar.tsx` | מחיר + grid + גרף |
| `client/src/components/deep-analysis/ManualOrderDialog.tsx` | presets, ללא `skipProtection` |
| `client/src/components/deep-analysis/AdvancedDetails.tsx` | אקורדיון מדדים |
| `client/src/hooks/usePlaceManualOrder.ts` | גשר tRPC |

### אינטגרציה

| קובץ | שורות (בערך) |
|------|----------------|
| `DeepAnalysisModal.tsx` | ~1825 (ירד מ-~2456) |
| `WarRoomLive.tsx` | hold-to-confirm חיסול + AlertDialog מקלדת |

### החלטות UX שמומשו

- Presets קנייה: **$5K / $10K / $20K / $30K / $40K**
- Presets מכירה: **10% / 25% / 50% / 100%**
- **אין `skipProtection` ב-UI** — השרת תמיד מגן על כניסה חיה
- `clientOrderId` נוצר ב-**submit** (לא בפתיחת דיאלוג), נשמר ב-STALLED
- חסימה **per ticker+side** — STALLED ב-AAPL:SELL לא חוסם MSFT:BUY

---

## חוזה שרת נדרש — `placeManualOrder`

### Input (tRPC)

```ts
z.object({
  ticker: z.string(),
  side: z.enum(["BUY", "SELL"]),
  intent: z.enum(["open_long", "close_long", "open_short", "close_short"]),
  quantity: z.number().positive(),
  clientOrderId: z.string().uuid(), // חובה — idempotency
  orderType: z.enum(["MKT", "LMT"]).optional(),
  slippagePct: z.number().optional(),
  sl: z.number().nullable().optional(),
  tp: z.number().nullable().optional(),
})
```

### Output

```ts
{
  success: boolean;
  orderId: string | null;
  ticker: string;
  side: "BUY" | "SELL";
  quantity: number;
  orderType: string;
  reason?: string | null;
  ibkrMessage?: string | null;
  clientOrderId?: string | null;
}
```

### Idempotency (קריטי)

```sql
-- דוגמה
INSERT INTO manual_order_lock (client_order_id, ...) VALUES (?, ...)
ON CONFLICT (client_order_id) DO NOTHING;
-- אם קיים → החזר אותה תוצאה מה-DB, אל תשגר שוב ל-IBKR
```

מפתח UI: `beginFlight(ticker, side)` ב-`orderFlightRegistry.ts`.

### הגנת SL/TP

- UI **לא** שולח `skipProtection`
- אחרי fill — השרת מציב SL/TP (כמו `liveSlTpEnforcement` הקיים)
- כניסה חיה לעולם לא "עירומה"

---

## גם נדרש מ-Claude (לא Cursor)

| פריט | הערה |
|------|------|
| `placeManualOrder` ב-`liveEngine` router | `protectedProcedure` |
| `closePosition` + `getExitProgress` | מ-`adminProcedure` → `protectedProcedure` |
| E2E עם UI אמיתי | אחרי merge שרת |

---

## QA מובייל 375px + דוח מלא (25 Jun)

**דוח QA לדרופלט:** [`QA_AUDIT_REPORT_2026-06-25.md`](./QA_AUDIT_REPORT_2026-06-25.md)  
מובייל + דסקטופ · 9 Critical · P0 שרת + P0 client · **לא לשחרר**

צילומים בתיקייה `screenshots-mobile-375/`:

1. `01-command-bar-375.png` — grid + helpers
2. `02-manual-order-dialog-375.png` — presets + הודעת הגנת שרת
3. `03-liquidate-hold-375.png` — per-side stalled banner

Preview מקומי (DEV): `/dev/mobile-trading-preview`  
`?dialog=buy` — פותח דיאלוג בלי לחיצה

---

## סקירת קוד מומלצת

1. קרא `2026-06-24-manual-trading-ux-split.md`
2. סקור `diffs/feat-manual-trading-ux-client.diff` לפי שכבות (לא blob אחד)
3. מימוש שרת + idempotency
4. merge `feat/manual-trading-ux` אחרי E2E — **לא** ישר ל-main

---

## קבצים בחבילה זו

```
README_FOR_CLAUDE.md          ← מסמך זה
QA_AUDIT_REPORT_2026-06-25.md ← דוח QA מובייל+דסקטופ
2026-06-24-manual-trading-ux-spec.md
2026-06-24-manual-trading-ux-split.md
COMMITS.txt
diffs/feat-manual-trading-ux-client.diff
screenshots-mobile-375/*.png
```

---

## שאלות פתוחות לסנכרון

1. האם `manual_order_lock` ב-MySQL או Redis?
2. האם `closePosition` צריך גם `clientOrderId`?
3. מי מפריס לדרופלט אחרי merge?

— Cursor Agent, TradeSnow Elza 2.0
