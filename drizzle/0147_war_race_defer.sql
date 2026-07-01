-- War-race deferred Armed-entry retry (P1d, 2026-07-01) — INERT BY DEFAULT.
-- Additive only. Apply idempotently (catch "Duplicate column name"). Never drizzle-kit push on live.
-- 0 = OFF (default): a transient-blocked Armed breakout is logged + dropped as today (byte-identical).
-- 1 = arm: park it and re-attempt via the same runWarEngineCycle until it enters / terminally declines / TTL.
ALTER TABLE `liveEngineConfig` ADD COLUMN `warRaceDeferQueueEnabled` tinyint NOT NULL DEFAULT 0;
ALTER TABLE `liveEngineConfig` ADD COLUMN `warRaceDeferTtlSec` int NOT NULL DEFAULT 120;
