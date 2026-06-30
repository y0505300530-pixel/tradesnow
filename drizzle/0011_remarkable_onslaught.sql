CREATE TABLE `labSimulations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(128) NOT NULL DEFAULT 'Simulation',
	`tickers` text NOT NULL,
	`startDate` timestamp NOT NULL,
	`endDate` timestamp NOT NULL,
	`capitalPerTrade` int NOT NULL DEFAULT 10000,
	`status` enum('pending','scanning','running','done','error') NOT NULL DEFAULT 'pending',
	`scanReport` text,
	`equityCurve` text,
	`totalROI` text,
	`totalProfit` text,
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `labSimulations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `labTrades` (
	`id` int AUTO_INCREMENT NOT NULL,
	`simulationId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`entryDate` timestamp,
	`exitDate` timestamp,
	`entryPrice` text,
	`exitPrice` text,
	`stopLoss` text,
	`takeProfit` text,
	`capitalUsed` int NOT NULL DEFAULT 10000,
	`profitLoss` text,
	`roiPct` text,
	`outcome` enum('win','loss','open','skipped') NOT NULL DEFAULT 'open',
	`exitReason` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `labTrades_id` PRIMARY KEY(`id`)
);
