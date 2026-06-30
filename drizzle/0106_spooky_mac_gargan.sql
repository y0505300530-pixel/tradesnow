CREATE TABLE `paperPenaltyBox` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`activatedAt` timestamp NOT NULL DEFAULT (now()),
	`expiresAt` timestamp NOT NULL,
	`slHitCount` int NOT NULL DEFAULT 2,
	`sessionId` int NOT NULL DEFAULT 1,
	CONSTRAINT `paperPenaltyBox_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `paperPenaltyBox_userId_ticker_idx` ON `paperPenaltyBox` (`userId`,`ticker`);--> statement-breakpoint
CREATE INDEX `paperPenaltyBox_expiresAt_idx` ON `paperPenaltyBox` (`expiresAt`);