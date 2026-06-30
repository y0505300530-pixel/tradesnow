CREATE TABLE `bulkSessionAnalyses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`bulkSessionId` int NOT NULL,
	`analysisId` int NOT NULL,
	`position` int NOT NULL,
	CONSTRAINT `bulkSessionAnalyses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bulkSessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`totalCount` int NOT NULL,
	`doneCount` int NOT NULL DEFAULT 0,
	`errorCount` int NOT NULL DEFAULT 0,
	`status` enum('pending','processing','done') NOT NULL DEFAULT 'pending',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bulkSessions_id` PRIMARY KEY(`id`)
);
