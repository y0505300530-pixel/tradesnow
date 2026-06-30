-- 0122_clumsy_pride — Kronos Conviction Scoring (entry-conviction addon path).
-- NOTE: drizzle-kit generate produced spurious CREATE/ALTER statements for tables
-- (liveEngineConfig, livePositions, liveTrades, liveEntryLock, mentorPatterns,
-- agentInsights) that already exist LIVE but were created out-of-band and never
-- captured in the journal snapshots before 0122. Those are NOT this migration's
-- intent and would fail with "table already exists" on the live DB. This file is
-- trimmed to the ACTUAL kronos delta only; the 0122 snapshot remains the full,
-- correct baseline so future generates diff cleanly from here on.
CREATE TABLE `kronosConvictionCache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`direction` varchar(8) NOT NULL,
	`addon` double NOT NULL DEFAULT 0,
	`rawForecastPct` double,
	`bandWidthPct` double,
	`computedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `kronosConvictionCache_id` PRIMARY KEY(`id`),
	CONSTRAINT `kronos_conv_ticker_idx` UNIQUE(`ticker`)
);
--> statement-breakpoint
ALTER TABLE `liveEngineConfig` ADD `kronosConvictionWeight` double DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `liveEngineConfig` ADD `zivStructuralCap` double DEFAULT 7.5 NOT NULL;--> statement-breakpoint
ALTER TABLE `liveEngineConfig` ADD `zivStructuralFloor` double DEFAULT 6.5 NOT NULL;--> statement-breakpoint
ALTER TABLE `liveEngineConfig` ADD `zivOnlyFloor` double DEFAULT 6.8 NOT NULL;--> statement-breakpoint
ALTER TABLE `liveEngineConfig` ADD `combinedGate` double DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE `liveEngineConfig` ADD `degradedGate` double DEFAULT 6.8 NOT NULL;--> statement-breakpoint
ALTER TABLE `liveEngineConfig` ADD `kronosStalenessMin` int DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE `liveEngineConfig` ADD `kronosUniverseSize` int DEFAULT 25 NOT NULL;
