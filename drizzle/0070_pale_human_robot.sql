CREATE TABLE `holding2` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`company` text,
	`buyPrice` double NOT NULL,
	`units` double NOT NULL,
	`currentPrice` double,
	`dailyChangePercent` double,
	`priceUpdatedAt` timestamp,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `holding2_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `holding2_userId_ticker_idx` ON `holding2` (`userId`,`ticker`);