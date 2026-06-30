-- Ghost Slots + Phoenix Protocol v1.1 (BUILD Loop 2, 2026-06-29).
-- Feature flags default OFF — flip only after unit/integration gate passes.
-- NOT registered in meta/_journal.json (matches inert-toggle convention).

-- ── Ghost slot accounting on live positions ───────────────────────────────────
ALTER TABLE livePositions ADD COLUMN slotGhost tinyint NOT NULL DEFAULT 0;
ALTER TABLE livePositions ADD COLUMN countsTowardSlot tinyint NOT NULL DEFAULT 1;
ALTER TABLE livePositions ADD COLUMN ghostAt timestamp NULL;
ALTER TABLE livePositions ADD COLUMN ghostStage varchar(32) NULL;
ALTER TABLE livePositions ADD COLUMN phoenixGeneration tinyint NOT NULL DEFAULT 0;
ALTER TABLE livePositions ADD COLUMN originPosId int NULL;

-- ── Live engine feature flags ─────────────────────────────────────────────────
ALTER TABLE liveEngineConfig ADD COLUMN ghostSlotsEnabled tinyint NOT NULL DEFAULT 0;
ALTER TABLE liveEngineConfig ADD COLUMN phoenixProtocolEnabled tinyint NOT NULL DEFAULT 0;
ALTER TABLE liveEngineConfig ADD COLUMN phoenixMaxPerDay int NOT NULL DEFAULT 3;
ALTER TABLE liveEngineConfig ADD COLUMN phoenix5mPollSec int NOT NULL DEFAULT 60;
ALTER TABLE liveEngineConfig ADD COLUMN phoenixQtyCapMult double NOT NULL DEFAULT 1.25;

-- ── Phoenix re-entry ledger ─────────────────────────────────────────────────────
CREATE TABLE phoenixLedger (
  id int AUTO_INCREMENT PRIMARY KEY,
  userId int NOT NULL,
  ticker varchar(16) NOT NULL,
  originPositionId int NOT NULL,
  tradeDate varchar(16) NOT NULL,
  entryRoute varchar(32) NOT NULL,
  breakoutLine double NOT NULL,
  stopPrice double NOT NULL,
  initialSl double NOT NULL,
  originQty int NOT NULL,
  stopCloseAt timestamp NOT NULL,
  status enum('eligible','triggered','expired','blocked') NOT NULL DEFAULT 'eligible',
  reclaimPrice double NULL,
  phoenixQty int NULL,
  plannedRiskUsd double NULL,
  phoenixPositionId int NULL,
  blockReason varchar(128) NULL,
  attemptsToday int NOT NULL DEFAULT 0,
  lastAttemptAt timestamp NULL,
  createdAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX phoenixLedger_userId_tradeDate_idx (userId, tradeDate),
  INDEX phoenixLedger_status_idx (status),
  INDEX phoenixLedger_ticker_tradeDate_idx (ticker, tradeDate)
);
