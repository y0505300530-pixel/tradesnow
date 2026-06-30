CREATE TABLE `dailyPositionChanges` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`date` varchar(16) NOT NULL,
	`changeType` enum('opened','closed','increased','reduced') NOT NULL,
	`unitsBefore` double NOT NULL DEFAULT 0,
	`unitsAfter` double NOT NULL DEFAULT 0,
	`unitsDelta` double NOT NULL DEFAULT 0,
	`avgPriceBefore` double,
	`avgPriceAfter` double,
	`marketPriceAtChange` double,
	`realizedPnl` double,
	`detectedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `dailyPositionChanges_id` PRIMARY KEY(`id`),
	CONSTRAINT `dailyPositionChanges_userId_ticker_date_idx` UNIQUE(`userId`,`ticker`,`date`)
);
--> statement-breakpoint
CREATE INDEX `dailyPositionChanges_userId_date_idx` ON `dailyPositionChanges` (`userId`,`date`);