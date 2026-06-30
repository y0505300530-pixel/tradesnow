CREATE TABLE `capitalEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`type` enum('deposit','withdrawal','buy','sell') NOT NULL,
	`amount` double NOT NULL,
	`ticker` varchar(16),
	`units` double,
	`pricePerUnit` double,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `capitalEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `portfolioAccounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`totalCapital` double NOT NULL DEFAULT 0,
	`cashBalance` double NOT NULL DEFAULT 0,
	`currency` varchar(8) NOT NULL DEFAULT 'USD',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `portfolioAccounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `portfolioAccounts_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `portfolioAnalysis` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`result` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `portfolioAnalysis_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `portfolioHoldings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`company` text,
	`buyPrice` double NOT NULL,
	`units` double NOT NULL,
	`currentPrice` double,
	`priceUpdatedAt` timestamp,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `portfolioHoldings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `portfolioHoldings_userId_ticker_idx` ON `portfolioHoldings` (`userId`,`ticker`);