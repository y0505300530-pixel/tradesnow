-- Ghost Slots — G-S0 (BUILD-spec 2026-06-29 ghost-slots-phoenix-protocol §2.3/§6).
-- Pure additive columns + one inert master switch. Default state = OFF / non-ghost,
-- so a position behaves byte-identically to today until ghostSlotsEnabled flips to 1.
--
-- INVARIANT: at ghostSlotsEnabled=0 (DEFAULT) the slot counter, heat recalc and the
-- onBreakevenConfirmed hook all early-return on the flag → runtime byte-identical.
-- Flip to 1 is OWNER-ONLY, after the G-S1 tests pass. Build != arm.
-- NOT registered in meta/_journal.json (matches the inert-toggle convention here).

-- livePositions: ghost accounting (slot-only; never frees margin/exposure).
ALTER TABLE livePositions ADD COLUMN slotGhost        tinyint     NOT NULL DEFAULT 0;
ALTER TABLE livePositions ADD COLUMN countsTowardSlot tinyint     NOT NULL DEFAULT 1;
ALTER TABLE livePositions ADD COLUMN ghostAt          bigint      NULL;
ALTER TABLE livePositions ADD COLUMN ghostStage       varchar(32) NULL;

-- liveEngineConfig: inert master switch (0 = OFF = today's behavior).
ALTER TABLE liveEngineConfig ADD COLUMN ghostSlotsEnabled tinyint NOT NULL DEFAULT 0;
