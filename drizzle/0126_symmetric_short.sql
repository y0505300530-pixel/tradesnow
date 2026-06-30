ALTER TABLE `liveEngineConfig` ADD `breadthThreshold` double DEFAULT 0.55 NOT NULL;--> statement-breakpoint
ALTER TABLE `liveEngineConfig` ADD `bearBreakdownEnabled` tinyint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `liveEngineConfig` MODIFY COLUMN `maxShortPositions` int DEFAULT 12 NOT NULL;
