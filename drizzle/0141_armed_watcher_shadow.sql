-- 0141 Armed-Watcher SHADOW MODE (2026-06-30)
-- When elzaIntradayWatcherShadow=1 (and elzaIntradayWatcherEnabled=0), the intraday
-- Armed-Watcher runs its full ARM→CROSS→HELD_5M detection and LOGS the would-be entries
-- for forward validation, but places NO order and never calls the war-engine cycle.
-- Default 0 ⇒ byte-identical to today. Owner flips to 1 to collect shadow data, then to
-- elzaIntradayWatcherEnabled=1 once the would-be-entry log validates the intraday cross.
ALTER TABLE liveEngineConfig ADD COLUMN elzaIntradayWatcherShadow tinyint NOT NULL DEFAULT 0;
