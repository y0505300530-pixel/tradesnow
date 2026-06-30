CREATE TABLE `tradingDiary` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`company` text,
	`units` double NOT NULL,
	`buyPrice` double NOT NULL,
	`stopLoss` double,
	`takeProfit` double,
	`reason` text,
	`expectations` text,
	`addedAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tradingDiary_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `tradingDiary_userId_idx` ON `tradingDiary` (`userId`);