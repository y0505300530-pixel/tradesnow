ALTER TABLE `userAssets` ADD `archived` tinyint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `userAssets` ADD `archivedAt` timestamp;