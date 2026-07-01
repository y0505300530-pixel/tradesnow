-- 0143 THE WAITER — Retest Resting-Limit System (2026-06-30) — INERT BY DEFAULT
--
-- The Waiter places a MANAGED resting LMT buy at a retest's EMA-20 ambush level
-- (entryLimit = EMA20 × 1.005), sized at the SAME 1%-risk × wideLungSL as every
-- other Elza entry, with the structural STP attached (bracket). It fills passively
-- when price pulls back to support; on fill it becomes a normal v4.5-managed `open`
-- position (Golden exit ladder, unchanged). ONLY the entry MECHANISM changes.
--
-- ── THE INERT INVARIANT (non-negotiable) ─────────────────────────────────────────
-- waiterEnabled defaults to 0. When 0: the Waiter tick early-returns before ANY
-- candidate load / order / DB write / extra fetch; the war cycle's R1 skip is a no-op;
-- ibkrSync's Waiter reconcile is a no-op. → runtime byte-identical to today. The owner
-- arms it later (a SEPARATE action) after the retest-sleeve backtest. Build != arm.
--
-- ── Budget (spec §3) ─────────────────────────────────────────────────────────────
-- waiterNlvPct (0.30) is a HARD SUB-CAP *within* the shared Elza deployment budget +
-- the live _optimisticBP ledger — NOT a separate additive sleeve. Both bounds must hold.
-- maxRetestSlots (8) bounds the # of concurrent resting/open retests (the 30% sleeve is
-- the harder bound). A resting LMT is a committed slot (livePositions pending_entry,
-- countsTowardSlot — already present).

ALTER TABLE liveEngineConfig ADD COLUMN waiterEnabled tinyint NOT NULL DEFAULT 0;
ALTER TABLE liveEngineConfig ADD COLUMN maxRetestSlots int NOT NULL DEFAULT 8;
ALTER TABLE liveEngineConfig ADD COLUMN waiterNlvPct double NOT NULL DEFAULT 0.30;

-- livePositions: Waiter resting-LMT lifecycle markers (all nullable / default 0 →
-- existing rows + the flag-off path are byte-identical). countsTowardSlot /
-- pending_entry / ibkrEntryOrderId already exist and are reused.
ALTER TABLE livePositions ADD COLUMN isWaiterEntry tinyint NOT NULL DEFAULT 0;       -- 1 = a Waiter retest resting LMT
ALTER TABLE livePositions ADD COLUMN waiterEmaAtPlace double;                         -- EMA-20 used to compute the resting limit (R2 drift re-quote basis)
ALTER TABLE livePositions ADD COLUMN waiterStage varchar(24);                         -- 'RESTING' | 'FILLED_ARMING' | 'MANAGED'
