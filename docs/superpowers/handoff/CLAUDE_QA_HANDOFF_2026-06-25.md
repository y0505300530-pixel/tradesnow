# Claude Handoff — QA Sprint Completion (25 Jun 2026)

## תקציר בעברית (למנהל הצ'אט)

**Cursor סיים:** Wave 2 UX (B1–B9), תיקוני QA client, CR-02 (מסחר חי admin-only), CR-03 (2FA על Express ibind), 299/299 טסטים, build + **deploy ל-prod** (`index-NmlKAE2L.js`).

**נשאר ל-Claude:** A2/A3/A4/A6/A7/A8/A9, CR-04/05/08, HI-S1–S6, ניקוי 131 הזמנות יתומות, E2E smoke בשוק פתוח. **אל תמזג ל-main לפני A6.**

---

## Meta

| Field | Value |
|-------|-------|
| **Date** | 2026-06-25 |
| **Branch** | `feat/manual-trading-ux` (NOT merged to `main`) |
| **Production URL** | https://trade-snow2.vip |
| **Deploy status** | 🟢 **Deployed** — `pm2 restart tradesnow-app` online |
| **Prod bundle** | `index-NmlKAE2L.js` (replaces `kRyUiQ5H`) · `TradeManager-DnfA9Eml.js` · `DeepAnalysisModal-C5-TCmnU.js` |
| **IBKR live account** | U16881054 |
| **Ownership** | **Cursor** = `client/` only · **Claude** = server, droplet, live IBKR writes, deploys |

**Source docs:** `QA_GREEN_REPORT_2026-06-25.md` · `QA_FIX_SPRINT_2026-06-25.md` · `2026-06-25-MASTER-OPEN-ITEMS.md` · `QA_FULL_SYSTEM_AUDIT_2026-06-25.md`

---

## What Cursor Completed

### Critical — fixed & deployed

| ID | Item | Evidence |
|----|------|----------|
| **CR-01** | Trade Manager crash (`ibkr is not defined`) | Build + prod deploy; `/trade` 200; no `ibkr is not defined` in bundles |
| **CR-02** | Live orders policy → **admin-only** | `placeManualOrder`, `closePosition`, `getExitProgress` → `adminProcedure` in `server/routers/liveEngine.ts` (~567, 691, 786) |
| **CR-03** | Express `/api/ibind/*` 2FA mirror | `requireAdmin` in `server/routers/ibkrProxy.ts` checks `requiresTwoFactor` + `isSessionVerified` → `403 TOTP_REQUIRED` |
| **CR-07** | War Room popup trap on error | Fixed in branch (`OrderStatusPopup` / `WarRoomLive`) |

**CR-02 policy decision (SECURE default — do not revert without owner sign-off):**

- All live money mutations (`placeManualOrder`, `closePosition`, `getExitProgress`) require **admin role + verified TOTP** (via `adminProcedure` → `protectedProcedure` + `requireAdmin`).
- `skipProtection` removed from server input schema; server **always** places SL/TP on live entries via `tryLiveEntry`.
- Rationale: single live account (U16881054); non-admin users must not place broker orders. If product later needs “verified user” trading, that is a **new** policy decision — not a silent downgrade.

### High — client fixed

| ID | Item | File(s) |
|----|------|---------|
| HI-P5 | Overview footer Today % = `unifiedTodayPct` | portfolio metrics / overview |
| ST-04 | `videoTitle.slice` null guard | `client/src/pages/WatchlistPage.tsx` |
| ME-03 | GlobalNav "כניסה" hidden on `/login` | `client/src/components/GlobalNav.tsx` |
| ME-04 | Quieter command-bar hints (tooltips on SELL/COVER) | command bar components |
| PF-01 | War Room poll 3s → 5s | `WarRoomLive.tsx` (`getStatus`) |
| PF-04 | H1H2 chart lazy load | `Suspense` + dynamic import |

### Wave 2 UX (B1–B9 + UI-01/03) — ✅

| ID | Deliverable | Key files |
|----|-------------|-----------|
| B1 | 7-state Order Event Manager | `client/src/lib/orderEventManager.ts`, `OrderStatusPopup.tsx` |
| B2 | Protection banner after FILLED | verified SL/TP banner from server response |
| B3–B4 | DeepAnalysisModal split; no `skipProtection` | `DeepAnalysisModal.tsx`, subcomponents |
| B5–B6 | Presets `grid-cols-3`; Hebrew SL/TP placeholders | `ManualOrderDialog.tsx` |
| B7 | z-index scale | `client/src/lib/zIndex.ts` |
| B8 | PWA suppress on trading screens | `PWAInstallPrompt.tsx` |
| B9 | SL badge for shorts (BUY side) | `SlTpBadge.tsx` + direction |
| UI-01/03 | BUY/SHORT active states + `returnTo` | `TradeActionGrid.tsx`, `consumeReturnTo` |

### Tests & build

```
npm test  → 299/299 pass (verified 25 Jun 2026, workspace)
npm run build → ✅
```

Notable test fixes: `vitest.setup.ts` test secrets; `portfolioHoldingsSync` — `entryPrice` from `livePositions`.

### Deploy & prod smoke — ✅

| Check | Result |
|-------|--------|
| `GET /`, `/login`, `/trade` | 200 |
| `index.html` → `index-NmlKAE2L.js` | ✅ |
| JS `Content-Type` | `application/javascript` (not SPA HTML fallback) |
| `TradeManager-DnfA9Eml.js` referenced | ✅ |
| `ibkr is not defined` in prod bundles | not found |

---

## What Remains for Claude

### Server / live (MASTER A-items)

| ID | Priority | Item | Notes |
|----|----------|------|-------|
| **A2** | 🔴 | 131 orphan IBKR orders vs ~4 positions | Cleanup stale brackets/pending; broker writes need per-action auth |
| **A3** | 🔴 | Engine not trading — dead `/iserver/marketdata/snapshot` (404) | Repoint to `POST /quotes` in `warEngine.ts` + `executePartial.ts:123`; verify market open + healthy gateway |
| **A4** | 🟠 | IBIND gateway flakiness / task-queue depth | Stabilize `/root/ibind-oauth`; root cause of A3 + flaky reads |
| **A6** | 🟠 | **`placeManualOrder` E2E smoke** | 1-share order at market open; force STALLED; re-submit → echo (no 2nd order) |
| **A7** | 🟠 | `manualOrderIdempotency` → **DB-backed** | Currently in-memory (`server/manualOrderIdempotency.ts`); lost on restart |
| **A8** | 🟡 | 3 missing TPs (NET/GOOG/TSM) | `liveSlTpEnforcement` at market open; verify with `audit:sltp` |
| **A9** | 🟡 | BUG-SSOT-001 — shorts SSOT unification | `positionDisplay.ts` / `positionMath.ts` two models |

### Critical gaps still open (server)

| ID | Item | Location / risk |
|----|------|-----------------|
| **CR-04** | `closePosition` IBKR fallback without `userId` scoping | `liveEngine.ts` ~612–673 — direct IBKR close by ticker when no DB row |
| **CR-05** | UI qty ≠ IBKR qty on entries | `tryLiveEntry` may resize from `$` floor; user approves X, broker gets Y |
| **CR-08** | Orphan orders (same as A2) | 131 stale brackets; SL/TP confusion |

**CR-03 residual check:** Express `requireAdmin` now mirrors tRPC 2FA (verified in repo). Remaining related risk: **HI-S1** — `local:` password users skip TOTP (`twoFactor.ts:109-114`) and can still hit admin routes if role=admin. Confirm this is acceptable or tighten.

### High — server security (HI-S1–S6)

| ID | Item | File |
|----|------|------|
| **HI-S1** | `local:` users bypass TOTP | `server/twoFactor.ts:109-114` |
| **HI-S2** | `shortScan.execute` on `protectedProcedure` + live | `server/routers/shortScan.ts:113` — consider `adminProcedure` |
| **HI-S3** | `priceCache.clearTickerAdmin` | Uses `adminProcedure` (tRPC) — confirm role gate sufficient |
| **HI-S4** | `IBIND_API_SECRET` doubles as internal sync bearer | `ibkrProxy.ts` |
| **HI-S5** | HMAC secret prefix/suffix logged at boot | `server/_core/index.ts` |
| **HI-S6** | Login without dedicated rate limit | `localAuth.ts` |

### Merge gate

| ID | Item | Status |
|----|------|--------|
| **B10** | Merge `feat/manual-trading-ux` → `main` | ⏳ **BLOCKED until A6 passes** |

---

## Gates & Rules

1. **A6 before B10** — No merge to `main` until E2E `placeManualOrder` smoke passes at market open.
2. **Claude owns live orders** — Only Claude writes IBKR orders and runs droplet deploys.
3. **CR-02 is admin-only** — Do not change to `protectedProcedure` without explicit owner approval.
4. **Idempotency** — In-memory guard works for STALLED re-submit in same process; **A7 (DB)** required for restart safety.

---

## E2E Smoke Script Expectations (A6)

Run on droplet with real auth + healthy IBKR gateway during market hours (~16:30 IST).

### Automated (after P0 server fixes)

```bash
cd /root/tradesnow
PLAYWRIGHT_BASE_URL=https://trade-snow2.vip npx playwright test tests/mobile-trading-ux-375.spec.ts
```

### Manual — required checklist

1. **BUY** 1 share (e.g. liquid ticker) — confirm IBKR qty matches UI (not $5K floor resize) — tests **CR-05**
2. **SELL 25%** — confirm only 25% sold (C2 partial close path)
3. **STALLED** — interrupt IBIND ~30s — re-submit same `clientOrderId` → echo, **no duplicate order** — tests **A6** + idempotency
4. **War Room ×** on network error — popup closes / `rejected`, not stuck on "שולח..."
5. **Short position** — COVER active with conid from holding
6. **Mobile 375px** — 4 action buttons in one row at `sm+`

### A6 acceptance criteria (from MASTER)

> 1-share order at market open → force STALLED → re-submit → confirm echo (no 2nd order).

---

## Commands Claude Should Run on Droplet

```bash
# ── Status ──
cd /root/tradesnow
git status && git branch --show-current   # expect feat/manual-trading-ux
pm2 status tradesnow-app
curl -sI https://trade-snow2.vip/trade | head -5

# ── Verify prod bundle ──
curl -s https://trade-snow2.vip/ | grep -o 'index-[^"]*\.js'

# ── Tests & build (pre-merge) ──
npm test
npm run build

# ── Deploy (after server changes) ──
npm run build && pm2 restart tradesnow-app

# ── SL/TP audit (A8) ──
npm run audit:sltp   # or: npx tsx scripts/audit-sltp.ts

# ── Orphan order survey (A2 / CR-08) ──
# Inspect IBKR open orders vs positions — cleanup with per-order auth

# ── Gateway health (A4) ──
# Check /root/ibind-oauth, IBIND relay, task-queue depth
```

---

## Suggested Work Order

### Now (no market required)

1. **A7** — Add `manual_order_lock` table; `ON CONFLICT (client_order_id)` return cached result
2. **CR-04** — Scope or remove IBKR-only `closePosition` fallback
3. **HI-S1, HI-S2** — TOTP policy for `local:` admin; `shortScan.execute` → `adminProcedure`?
4. **HI-S4–S6** — Secret separation, log redaction, login rate limit

### Market open (16:30 IST)

1. **A3 + A4** — Engine quotes + gateway stability
2. **A6** — E2E smoke (checklist above)
3. **A8** — Verify missing TPs placed
4. **B10** — Merge `feat/manual-trading-ux` → `main` **only if A6 green**

### Later

- **A2 / CR-08** — Orphan order cleanup (131 brackets)
- **A9** — Shorts SSOT architecture
- **PF-02/03** — TradeManager size / Catalogue LOC refactor (Cursor backlog)

---

## Key Files for Claude Review

| Priority | Path |
|----------|------|
| 1 | `server/routers/liveEngine.ts` — `placeManualOrder`, `closePosition`, `getExitProgress` |
| 2 | `server/manualOrderIdempotency.ts` — replace with DB (A7) |
| 3 | `server/routers/ibkrProxy.ts` — Express 2FA, IBIND auth |
| 4 | `server/twoFactor.ts` — HI-S1 `local:` bypass |
| 5 | `server/warEngine.ts` — A3 quotes migration |
| 6 | `server/routers/shortScan.ts` — HI-S2 live execute |

**Prior handoff package (UI detail):** `docs/superpowers/handoff/cursor-manual-trading-ux-2026-06-25/README_FOR_CLAUDE.md`

---

## Do NOT

- ❌ Merge `feat/manual-trading-ux` to `main` until **A6 passes**
- ❌ Downgrade CR-02 from `adminProcedure` without owner decision
- ❌ Place live test orders from Cursor workspace (Claude only)
- ❌ Trust in-memory idempotency across `pm2 restart` (A7)

---

*Generated by Cursor QA Completion Worker — 2026-06-25*
