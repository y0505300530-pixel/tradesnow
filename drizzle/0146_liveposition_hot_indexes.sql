-- Tier-1 perf (2026-07-01): composite indexes on livePositions hot predicates.
-- ADDITIVE ONLY — no data change, no behavior change; just query speed. Run off-hours
-- (brief online DDL lock on a large table). Apply idempotently (catch "Duplicate key name").
-- NEVER replay/edit an earlier migration; this is a new file registered after 0145.
CREATE INDEX `livePositions_userId_status_idx`           ON `livePositions` (`userId`, `status`);
CREATE INDEX `livePositions_userId_status_closedAt_idx`  ON `livePositions` (`userId`, `status`, `closedAt`);
CREATE INDEX `livePositions_userId_openedAt_idx`         ON `livePositions` (`userId`, `openedAt`);
CREATE INDEX `livePositions_userId_ticker_status_idx`    ON `livePositions` (`userId`, `ticker`, `status`);
