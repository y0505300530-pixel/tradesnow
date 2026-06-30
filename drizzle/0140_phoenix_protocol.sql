-- Phoenix Protocol — P-S0 (BUILD-spec 2026-06-29 ghost-slots-phoenix-protocol §3.6/§6).
-- New ledger table (anti-loop SSOT) + additive livePositions lineage columns + inert
-- master switch and tunables. Default state = OFF, so no eligibility row is ever written
-- and no re-entry is ever attempted until phoenixProtocolEnabled flips to 1.
--
-- INVARIANT: at phoenixProtocolEnabled=0 (DEFAULT) the Wide-Lung eligibility write and
-- the 5m watcher both early-return on the flag → runtime byte-identical to today.
-- The anti-loop counters live HERE (DB), NOT in memory — the engine restarts constantly;
-- an in-memory counter would reset and re-enable unlimited re-entries. Owner-only flip.
-- NOT registered in meta/_journal.json (matches the inert-toggle convention here).

CREATE TABLE phoenixLedger (
  id              int          NOT NULL AUTO_INCREMENT,
  userId          int          NOT NULL,
  originPosId     int          NOT NULL,            -- livePositions.id of the stopped origin
  ticker          varchar(16)  NOT NULL,
  tradeDate       varchar(10)  NOT NULL,            -- Israel-time YYYY-MM-DD (per-day anti-loop key)
  breakoutLine    double       NOT NULL,            -- frozen donchian20High × 0.995 at origin
  stopPrice       double       NOT NULL,            -- the wide-lung stop that was hit
  reclaimPrice    double       NULL,                -- 5m reclaim close that armed re-entry
  status          varchar(16)  NOT NULL DEFAULT 'eligible', -- eligible|reentered|stopped|expired|blocked
  phoenixQty      int          NULL,                -- shares the re-entry actually sized to
  plannedRiskUsd  double       NULL,                -- qty × |entry-stop| at re-entry (heat=0 until filled)
  reenteredPosId  int          NULL,                -- livePositions.id of the phoenix child
  cooldownUntil   bigint       NULL,               -- epoch ms; 30-min cooldown after a phoenix stop
  createdAt       bigint       NOT NULL,
  updatedAt       bigint       NOT NULL,
  PRIMARY KEY (id),
  KEY phoenixLedger_user_date_idx (userId, tradeDate),
  KEY phoenixLedger_ticker_idx (ticker),
  KEY phoenixLedger_status_idx (status)
);

-- livePositions: Phoenix lineage (0 = origin/normal; 1 = phoenix child).
ALTER TABLE livePositions ADD COLUMN phoenixGeneration tinyint NOT NULL DEFAULT 0;
ALTER TABLE livePositions ADD COLUMN originPosId       int     NULL;

-- liveEngineConfig: inert master switch + tunables (all owner-flippable live).
ALTER TABLE liveEngineConfig ADD COLUMN phoenixProtocolEnabled tinyint NOT NULL DEFAULT 0;
ALTER TABLE liveEngineConfig ADD COLUMN phoenixMaxPerDay        int     NOT NULL DEFAULT 3;
ALTER TABLE liveEngineConfig ADD COLUMN phoenix5mPollSec        int     NOT NULL DEFAULT 60;
ALTER TABLE liveEngineConfig ADD COLUMN phoenixQtyCapMult       double  NOT NULL DEFAULT 1.25;
