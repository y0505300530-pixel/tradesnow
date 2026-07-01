-- 0145 ENTRY CHURN GUARD + MIN_R_PCT gate (2026-07-01) — INERT BY DEFAULT
--
-- Two P&L leaks from the 30-Jun analysis, each behind its own flag (default 0):
--   (1) Entry Churn Guard — an automated re-entry after a same-day close (AAPL×3,
--       ZIM×3) burned budget → EOD forced-cut. C1: ≤1 automated entry / ticker /
--       Israel calendar day; C2: a 90-minute cooldown after ANY close (incl.
--       MANUAL_CLOSE / SL / EOD). The Waiter retest pipeline is EXEMPT (it is the
--       MANAGED re-entry, not churn).
--   (2) MIN_R_PCT gate — an extended mega-cap whose structural stop is so tight the
--       rValue is ~0.11% of entry (AAPL 288.35 / 286.71) is a scalp, not a trade.
--       RC-2's MAX_STRUCTURAL_RISK_PCT (0.12) caps risk TOO LARGE; this is the
--       missing MIN floor (rPct < minRValuePct → not tradeable).
--
-- ── THE INERT INVARIANT (non-negotiable) ─────────────────────────────────────────
-- Both flags default to 0. When entryChurnGuardEnabled=0: warEngine builds NO churn
-- ledger (zero extra DB reads) and blocks nothing; tryLiveEntry's churn check is a
-- no-op → runtime byte-identical. When minRValuePctEnabled=0 (or minRValuePct<=0):
-- the geometry gate is skipped → runtime byte-identical. The owner arms each flag
-- LATER (a SEPARATE action) after regression. Build != arm.

ALTER TABLE liveEngineConfig ADD COLUMN entryChurnGuardEnabled tinyint NOT NULL DEFAULT 0;
ALTER TABLE liveEngineConfig ADD COLUMN churnCooldownMin int NOT NULL DEFAULT 90;
ALTER TABLE liveEngineConfig ADD COLUMN minRValuePctEnabled tinyint NOT NULL DEFAULT 0;
ALTER TABLE liveEngineConfig ADD COLUMN minRValuePct double NOT NULL DEFAULT 0.015;
