# TradeSnow — Master Open-Items Tracker
**Updated:** 2026-06-25 · **Owner of this doc:** Claude · **Single source of truth — all other lists deprecated.**

Legend: 🔴 critical · 🟠 high · 🟡 medium · ✅ done · ⏳ waiting (market/dependency)
Owners: **C**=Claude (server + live droplet + deploys, SOLE live-order writer) · **X**=Cursor (client/ only) · **B**=Base44 (standalone prototypes only)

---

## A. SERVER / LIVE — owner: Claude

| ID | Item | Pri | Status | Source | Notes |
|----|------|-----|--------|--------|-------|
| A1 | `CLOSED_IBKR_NO_PRICE` writes `realizedPnl=0` (fabricated) | 🔴 | ✅ DEPLOYED | logs-audit #4 | No-price close now sends a LOUD Telegram alert ("אל תסמוך על ה-$0") + auditable reason; journal (A5) excludes these rows from totals/win-rate. |
| A2 | 131 orphan IBKR orders vs ~4 positions | 🔴 | OPEN | logs-audit #5 | Cleanup stale brackets/pending. Broker writes → needs per-action auth. |
| A3 | Engine not trading — entry price from dead `/iserver/marketdata/snapshot` (404) | 🔴 | OPEN | tonight | Repoint to `POST /quotes` in `warEngine.ts` (entry + short-scan ~456) + `executePartial.ts:123`. Needs market open + healthy gateway to verify. |
| A4 | IBIND gateway flakiness / task-queue depth | 🟠 | OPEN | logs-audit #11 | Stabilize `/root/ibind-oauth`. Root of A3 + every flaky read. Infra. |
| A5 | **Trading journal 23:10 (server generator)** — the original request | 🟠 | ✅ DEPLOYED | session start | `tradingJournal.ts` (reads livePositions, filters NO_PRICE + phantoms) + cron 23:10 IST in alertPoller. Verified: real example sent to Telegram. engineDecisionLog (per-candidate, richer) = future v2. |
| A6 | `placeManualOrder` E2E smoke test | 🟠 | ⏳ open | manual-trading | 1-share order at market open; force STALLED; re-submit → confirm echo (no 2nd order). |
| A7 | `manualOrderIdempotency` → DB-backed | 🟠 | OPEN | QA | In-memory map lost on restart (server crashed ×2). Add `manualOrderLock(clientOrderId PK)`. |
| A8 | 3 missing TPs (NET/GOOG/TSM) | 🟡 | ⏳ auto | audit | `liveSlTpEnforcement` places at market open (skips while closed). Verify with `audit:sltp`. |
| A9 | BUG-SSOT-001 — shorts SSOT unification | 🟡 | OPEN | pnl-audit | `positionDisplay.ts`/`positionMath.ts` two models. Architectural. |
| A10 | War Room: don't override mktPrice; SL badge for shorts (BUY) | 🟡 | ✅ client (B9) | pnl-audit P1 | Server enrichment `liveEngine.ts ~263` still optional. |

### Policy (completion worker 25 Jun)
| CR-02 | Live orders admin-only (SECURE default) | 🟠 | ✅ | `placeManualOrder` + `closePosition` + `getExitProgress` → `adminProcedure` |

### ✅ DONE this session (server/live): CANCEL-storm killed · dbLog crash fixed · −$7K explained · all 4 positions SL-protected (MU full) · **adoption keystone fixed (DB rows 0→4)** · `placeManualOrder`+idempotency deployed · `audit-sltp` retry fixed · entry-lock TTL · snapshot-skip-on-no-price · units-reconcile · **A1** P&L=0 loud-alert · **C2** partial-close · **C3** orderId+sl/tp return · **C7** protectedProcedure · **A5** trading journal 23:10 (deployed + example sent). · C1 waived (floor, per owner).

---

## B. CLIENT / UI — owner: Cursor · branch `feat/manual-trading-ux` (NOT merged)

| ID | Item | Pri | Status | Source |
|----|------|-----|--------|--------|
| B1 | Order Event Manager 7-state machine | 🟠 | ✅ | spec §4 |
| B2 | Protection banner after FILLED | 🟠 | ✅ | spec §4.4 |
| B3 | Split DeepAnalysisModal | 🟠 | ✅ | QA |
| B4 | Remove skipProtection | 🟠 | ✅ | QA |
| B5 | Presets grid-cols-3 | 🟡 | ✅ | UX |
| B6 | SL/TP Hebrew placeholders | 🟡 | ✅ | UX |
| B7 | z-index scale | 🟡 | ✅ | spec §3.1 |
| B8 | PWA suppress on trading screens | 🟡 | ✅ | UX |
| B9 | War Room SL badge shorts (BUY) | 🟡 | ✅ | pnl-audit |
| B10 | After A6 E2E passes → merge branch to main | 🟠 | ⏳ blocked by A6 | — |

### ✅ DONE (Cursor): Wave 2 B1-B9 · HI-P5 · ST-04 · ME-03/04 · PF-01/04 · manual trade buttons · hold-to-confirm · STALLED · clientOrderId · command-bar · mobile screenshots.

---

## C. PROTOTYPES — owner: Base44 (standalone only, no repo/IBKR writes)

| ID | Item | Status |
|----|------|--------|
| C1 | Deep Analysis Command Bar prototype | ✅ done |
| C2 | Trading Journal 23:10 prototype | ✅ done (ref for A5) |
| C3 | **NEW:** Prototype the full 7-state OrderEventManager (visual ref for Cursor's B1) | 🆕 assigned |

---

## Dependencies & order
1. **Now (no market needed):** A1 (P&L=0 fix) · A5 (journal) · A7 (DB idempotency) · all of B · C3.
2. **Market open (16:30 IST):** A6 (E2E) → unblocks B10 (merge) · A8 verify · A3 (engine→/quotes) + A4 (gateway).
3. **Architectural / later:** A9 · A2 (orphan cleanup, needs auth).

**Rule:** only Claude writes live IBKR orders / deploys. Cursor=client only. Base44=standalone only.
