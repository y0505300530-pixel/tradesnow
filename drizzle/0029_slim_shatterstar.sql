CREATE TABLE `llmScanCache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`dateKey` varchar(16) NOT NULL,
	`priceKey` varchar(16) NOT NULL,
	`result` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `llmScanCache_id` PRIMARY KEY(`id`),
	CONSTRAINT `llmScanCache_key_idx` UNIQUE(`ticker`,`dateKey`,`priceKey`)
);
--> statement-breakpoint
CREATE INDEX `labDailyLogs_simulationId_idx` ON `labDailyLogs` (`simulationId`);--> statement-breakpoint
CREATE INDEX `labDailyLogs_date_idx` ON `labDailyLogs` (`date`);--> statement-breakpoint
CREATE INDEX `labTrades_simulationId_idx` ON `labTrades` (`simulationId`);--> statement-breakpoint
CREATE INDEX `labTrades_ticker_idx` ON `labTrades` (`ticker`);