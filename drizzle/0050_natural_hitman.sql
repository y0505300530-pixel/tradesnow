CREATE TABLE `portfolioSnapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`snapshotDate` varchar(16) NOT NULL,
	`totalValue` double NOT NULL,
	`investedValue` double NOT NULL,
	`cashBalance` double NOT NULL,
	`totalCost` double NOT NULL,
	`pnlUsd` double NOT NULL,
	`pnlPct` double NOT NULL,
	`holdingsSnapshot` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `portfolioSnapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `portfolioSnapshots_userId_date_idx` UNIQUE(`userId`,`snapshotDate`)
);
--> statement-breakpoint
CREATE TABLE `priceAlerts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`alertType` enum('sl','tp','custom') NOT NULL,
	`targetPrice` double NOT NULL,
	`direction` enum('below','above') NOT NULL,
	`label` varchar(64),
	`triggered` tinyint NOT NULL DEFAULT 0,
	`triggeredAt` timestamp,
	`triggeredPrice` double,
	`dismissed` tinyint NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `priceAlerts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `priceAlerts_userId_ticker_idx` ON `priceAlerts` (`userId`,`ticker`);