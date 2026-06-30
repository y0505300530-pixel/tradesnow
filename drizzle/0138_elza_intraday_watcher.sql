-- Intraday Armed-Watcher inert master switch (BUILD-spec 2026-06-29, F1).
-- 0 = OFF (DEFAULT): the intraday armed-watcher tick early-returns before any
-- fetch/state-mutation, the tiered cadence stays today's :00/:20/:40 universe
-- cadence, and watcherStatus is null → runtime byte-identical to today.
-- Flip to 1 is OWNER-ONLY, AFTER the §5 backtest arm-gate passes. Build != arm.
-- NOT registered in meta/_journal.json (matches the inert-toggle convention here).
ALTER TABLE liveEngineConfig ADD COLUMN elzaIntradayWatcherEnabled tinyint NOT NULL DEFAULT 0;
