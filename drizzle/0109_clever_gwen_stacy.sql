CREATE TABLE `paperReentryWatch` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`exitPrice` double NOT NULL,
	`exitReason` varchar(32) NOT NULL,
	`exitDate` timestamp NOT NULL,
	`candlesAboveExitPrice` int DEFAULT 0,
	`snapBackEligible` int DEFAULT 0,
	`recoveryChecked` int DEFAULT 0,
	`reentryExecuted` int DEFAULT 0,
	`sessionId` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `paperReentryWatch_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `paperTickerWallet` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`totalPnl` double NOT NULL DEFAULT 0,
	`tradeCount` int NOT NULL DEFAULT 0,
	`winCount` int NOT NULL DEFAULT 0,
	`lossCount` int NOT NULL DEFAULT 0,
	`lastTradeAt` timestamp,
	`sessionId` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `paperTickerWallet_id` PRIMARY KEY(`id`),
	CONSTRAINT `paperTickerWallet_userId_ticker_session_uniq` UNIQUE(`userId`,`ticker`,`sessionId`)
);
--> statement-breakpoint
CREATE TABLE `paperTightExitAudit` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`exitPrice` double NOT NULL,
	`postExitHighPrice` double,
	`postExitGainPct` double DEFAULT 0,
	`slWidenMultiplier` double DEFAULT 1,
	`sessionId` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `paperTightExitAudit_id` PRIMARY KEY(`id`),
	CONSTRAINT `paperTightExitAudit_userId_ticker_session_uniq` UNIQUE(`userId`,`ticker`,`sessionId`)
);
--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `partialTpHit` int DEFAULT 0;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `slMovedToBreakEven` int DEFAULT 0;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `target1Price` double;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `remainingUnits` int;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `partialRealizedPnl` double DEFAULT 0;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `extremeMomentumMode` int DEFAULT 0;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `slowGrindCount` int DEFAULT 0;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `riskLevel` int DEFAULT 5;--> statement-breakpoint
CREATE INDEX `paperReentryWatch_userId_ticker_session_idx` ON `paperReentryWatch` (`userId`,`ticker`,`sessionId`);