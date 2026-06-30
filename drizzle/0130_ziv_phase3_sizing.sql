ALTER TABLE `liveEngineConfig` ADD `riskSizingEnabled` tinyint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `liveEngineConfig` ADD `heatMaxPct` double DEFAULT 0.07 NOT NULL;
