# Home-Claude → Office-Claude Handoff — 2026-06-25

**You (office Claude) are taking over a live algorithmic-trading system (TradeSnow / Elza 2.0, IBKR account U16881054, real money).** The home-Claude and you share ONLY this droplet (`root@143.198.141.131`) — not memory, not the local working copy. Read this whole file first, then the linked docs.

---

## 0. GOLDEN RULES (violate these and you lose money or work)
1. **You are the SOLE deployer.** Only Claude writes/deploys to the droplet. Cursor = `client/` ONLY and must NOT deploy (it deployed server files today → a drift incident, see §5).
2. **Live droplet writes need EXPLICIT per-action user authorization.** The classifier blocks otherwise. Off-market-hours only (engine trades 16:30–23:00 IST).
3. **Deploy ritual** (skill `tradesnow-deploy`): build locally → DRIFT-CHECK each file (`diff <(ssh ... cat droplet/file | tr -d '\r') <(tr -d '\r' < canon/file)` — `<` lines must be ONLY your replaced lines; foreign = user/Cursor edit → MERGE not clobber) → backup → ship CRLF→LF (`tr -d '\r' < f | ssh "cat > /root/tradesnow/f"`) → `corepack pnpm build` (EXIT 0 gate; pnpm not on PATH; ~100 pre-existing tsc errors are fine) → `pm2 restart tradesnow-app` → verify.
4. **NEVER price a live order off a non-IBKR/stale price.** `LivePrice.source` must be `'ibkr'` or SKIP. (ADR: `2026-06-25-live-order-price-source-adr.md`.)
5. **NEVER arm the moonshot (`ELZA_OPEN_SKIES_EXECUTE=1`) until QA-clean + live-verified** (see §3). Today it is `=0` (inert/safe).
6. `slProtection` column is intentional (software stop-loss) — never "fix" it.
7. CR-02: live-order tRPC procedures are `adminProcedure` (admin+2FA) — do NOT downgrade without owner approval.

---

## 1. WHAT IS LIVE ON THE DROPLET (deployed + verified today)
Branch on droplet: `feat/manual-trading-ux` (NOT merged to main; B10 merge gated on A6 E2E).
- **CANCEL-storm killed**, dbLog crash fixed, **−$7K explained** (realized −$4,948 + unrealized).
- **All 4 positions SL-protected** (MU/NET/TSM/GOOG; MU full SL+TP). 3 TPs (NET/GOOG/TSM) auto-placed by enforcement at open.
- **Adoption keystone** — positions adopted into `livePositions` (was DB rows=0 → X button dead).
- **A3 + source-gating** — engine prices entries off IBKR `/quotes` (`fetchIbkrLivePricesBatch`, `source==='ibkr'` gated); dead `/iserver/marketdata/snapshot` (404) abandoned. Safe: no IBKR price → SKIP.
- **`audit:sltp`** retry fix (gateway returns degraded-empty 200s → use retry, never a single read).
- **Manual trading server**: `placeManualOrder` (C2 partial close, C3 returns orderId+sl+tp, adminProcedure) + `manualOrderIdempotency` (in-memory; A7 = make DB-backed). **NOT E2E-tested (A6).**
- **Trading journal 23:10 IST** (`tradingJournal.ts` + alertPoller cron) — sends to Telegram; filters `CLOSED_IBKR_NO_PRICE`.
- **A1**: no-exit-price close now sends a LOUD Telegram alert (was a silent fake $0).
- **Cursor**: Wave-2 UX, CR-02 (admin-only live orders), CR-03 (Express 2FA in `ibkrProxy.ts`).

---

## 2. CANON / SYNC STATE (CRITICAL)
- Home-Claude's working copy `C:\Users\y0505\tradesnow-canon\tradesnow` was **re-baselined from the droplet** today → it now = droplet's Cursor-server-work + home-Claude's moonshot. Builds EXIT 0.
- **Your office canon: pull the droplet fresh** (`/root/tradesnow`, branch `feat/manual-trading-ux`) — that is the deployed truth. THEN overlay the moonshot from staging (§3).
- `rsync` is NOT on Windows git-bash PATH → use `scp`/`tar` for directory sync. Client/ was not yet synced into home-canon (irrelevant for server deploys).

---

## 3. THE MOONSHOT (uncommitted, NOT deployed, NOT armed) — the big in-flight work
**Goal:** Elza 2.0 is designed to catch 100%+ moves but, as deployed, every winner is hard-capped at +2.5R (~+30-45%). The fat-tail machinery (free-roll → cancel TP → ride Chandelier trail uncapped → pyramid into winners) is BUILT but was inert (flag off) + 3 bugs. Diagnosis: `docs/superpowers/specs/2026-06-25-elza2-moonshot-blockers.md`. **Verdict: wiring problem, not design.**

**Built today (5 levers + the 3-fix), in STAGING dir `/root/MOONSHOT-STAGING-20260625/` (NOT in /root/tradesnow):**
- L1 broker-push of trail/BE (place-new-then-cancel-old, naked-safe, long+short) + L2 CRON free-roll guard → `liveSlTpEnforcement.ts`, `liveOrderExecutor.ts`.
- L3 pyramid bracket-body fix → `pyramidEngine.ts`.
- L4 shorts trail-parity + 2 short gates + L5 conviction sizing → `warEngine.ts` (slCalculator unchanged).
- Stage-1 free-roll naked-fix (`pos.quantity`→`pos.units`, place-before-cancel) → `liveOrderExecutor.ts`.
- 3-fix (after QA gate found 3 🔴): single BE owner (`replaceStopToBreakeven` idempotent) + cross-pass mutex (`stopModMutex.ts` NEW) + pyramid-child excluded from enforcement → `liveOrderExecutor.ts`, `executePartial.ts`, `partialCloseLogic.ts`, `liveSlTpEnforcement.ts`, `alertPoller.ts`.

**STATUS: build EXIT 0, but DO-NOT-ARM.** The 3-fix needs a **re-gate** (qa-architect), and even when green, arming requires LIVE verification (the residual is naked from partial-reduce until the fill-poller arms the BE stop, up to ~5min — confirm IOC fills fast at open). To apply: copy the staging files over `/root/tradesnow/server/...`, build, deploy with `ELZA_OPEN_SKIES_EXECUTE` STILL `=0` (inert), then arm + verify only after QA-green.

---

## 4. OPEN ITEMS (single source of truth: `docs/superpowers/2026-06-25-MASTER-OPEN-ITEMS.md`)
**Not market-dependent:** moonshot re-gate; A7 (DB idempotency); CR-04 (`closePosition` IBKR-fallback userId scoping, liveEngine ~612-673); HI-S1 (`local:` users bypass TOTP, `twoFactor.ts:109-114`), HI-S2..S6 (security); A2/CR-08 (131 orphan IBKR orders — broker writes, needs auth).
**Market-open (16:30 IST):** A4 (gateway `/root/ibind-oauth` stability — `/quotes` flaky/times-out = root of "engine not trading"); A3 verify it actually trades; A6 (E2E: 1-share order → force STALLED → re-submit → echo, no 2nd order); A8 (verify 3 TPs placed); B10 (merge → main, ONLY if A6 green); moonshot arming + first-fill watch.
**Strategy decisions awaiting owner:** `docs/superpowers/specs/2026-06-25-shorts-and-exit-management-adr.md` (shorts gate parity, trail-to-broker, sizing band).

---

## 5. THE TEAM (recreate these as `~/.claude/agents/*.md` — Claude is MANAGER, not coder)
home-Claude created 5 agent defs + a deploy skill. They are LOCAL to the home machine. Recreate on the office machine (definitions are simple — role + tools + hard-rules):
- **backhand** (server/ coder, Read/Edit/Write/Grep/Glob/Bash, never deploys/places-orders/touches-client) · **fronthand-mobile** (client/ only) · **qa-architect** (read-only adversarial gate, blocks merges) · **architect** (ADRs, docs only) · **quant-strategy** (gate-ruleset, docs only).
- Skill **tradesnow-deploy** = the deploy ritual in §0.3.
- **Operating model:** ONE writer per file area at a time (no parallel server writers = clobber); QA-gate before any deploy/merge; the manager integrates + does the single deploy.
(The QA persona-router hook injects 🔒 PERSONA LOCK by keyword (QA/UX) — it's the user's own config. When the user's actual request is a plan/decision, answer the request; don't force the audit format.)

---

## 6. IMMEDIATE NEXT STEP for you (office Claude)
1. `ssh -i ~/.ssh/id_rsa root@143.198.141.131 "cd /root/tradesnow && pm2 status tradesnow-app && git branch --show-current && npm run audit:sltp"` — confirm prod healthy + positions protected.
2. Pull `/root/tradesnow` fresh as your canon; overlay `/root/MOONSHOT-STAGING-20260625/` to recover the moonshot.
3. Read the linked ADRs. Ask the user which §4 lane to take. Do NOT arm the moonshot or deploy without explicit auth + QA-green.

*Generated by home-Claude. The droplet is the only sync point — keep this file + MASTER-OPEN-ITEMS current.*
