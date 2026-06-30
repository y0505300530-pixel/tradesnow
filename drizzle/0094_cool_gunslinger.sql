CREATE TABLE `paperLedger` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`availableCash` double NOT NULL DEFAULT 100000,
	`initialCapital` double NOT NULL DEFAULT 100000,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `paperLedger_id` PRIMARY KEY(`id`),
	CONSTRAINT `paperLedger_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `paperPositions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`companyName` varchar(128),
	`signal` varchar(32) NOT NULL,
	`zivScore` double,
	`units` int NOT NULL,
	`entryPrice` double NOT NULL,
	`rawEntryPrice` double NOT NULL,
	`allocatedCapital` double NOT NULL,
	`initialSl` double NOT NULL,
	`initialTp` double NOT NULL,
	`currentSl` double NOT NULL,
	`currentTp` double NOT NULL,
	`currentPrice` double,
	`unrealizedPnl` double DEFAULT 0,
	`unrealizedPnlPct` double DEFAULT 0,
	`zivHScore` double,
	`status` varchar(16) NOT NULL DEFAULT 'open',
	`openedAt` timestamp NOT NULL DEFAULT (now()),
	`closedAt` timestamp,
	CONSTRAINT `paperPositions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `paperTrades` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`positionId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`signal` varchar(32) NOT NULL,
	`zivScore` double,
	`units` int NOT NULL,
	`entryPrice` double NOT NULL,
	`exitPrice` double NOT NULL,
	`allocatedCapital` double NOT NULL,
	`realizedPnl` double NOT NULL,
	`realizedPnlPct` double NOT NULL,
	`exitReason` varchar(16) NOT NULL,
	`openedAt` timestamp NOT NULL,
	`closedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `paperTrades_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `paperLedger_userId_idx` ON `paperLedger` (`userId`);--> statement-breakpoint
CREATE INDEX `paperPositions_userId_idx` ON `paperPositions` (`userId`);--> statement-breakpoint
CREATE INDEX `paperPositions_status_idx` ON `paperPositions` (`status`);--> statement-breakpoint
CREATE INDEX `paperPositions_userId_status_idx` ON `paperPositions` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `paperTrades_userId_idx` ON `paperTrades` (`userId`);--> statement-breakpoint
CREATE INDEX `paperTrades_closedAt_idx` ON `paperTrades` (`closedAt`);