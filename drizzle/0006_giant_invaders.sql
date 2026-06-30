CREATE TABLE `userSettings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`tradingviewWebhookUrl` text,
	`tradingviewApiKey` text,
	`platform` varchar(64) NOT NULL DEFAULT 'tradingview',
	`startingBalance` int NOT NULL DEFAULT 10000,
	`riskPerTrade` int NOT NULL DEFAULT 2,
	`stopLossBuffer` int NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `userSettings_id` PRIMARY KEY(`id`),
	CONSTRAINT `userSettings_userId_unique` UNIQUE(`userId`)
);
