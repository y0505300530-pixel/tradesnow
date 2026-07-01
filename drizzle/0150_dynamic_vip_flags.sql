-- Dynamic VIP engine flags (Phase 1, 2026-07-01) — INERT BY DEFAULT.
-- Additive; apply idempotently (catch "Duplicate column name"); never drizzle-kit push on live.
-- dynamicVipEnabled=1 → the war ENTER sort uses the daily tier as a ≤0.5 tiebreak + pyramid skips
--   BENCH scale-ins. 0 = byte-identical to today. benchAutoExitEnabled = Phase 2 (accelerated BENCH exit).
ALTER TABLE `liveEngineConfig` ADD COLUMN `dynamicVipEnabled` tinyint NOT NULL DEFAULT 0;
ALTER TABLE `liveEngineConfig` ADD COLUMN `benchAutoExitEnabled` tinyint NOT NULL DEFAULT 0;
