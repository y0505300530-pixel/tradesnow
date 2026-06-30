CREATE TABLE `sectorConfig` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`sectorName` varchar(64) NOT NULL,
	`isEnabled` tinyint NOT NULL DEFAULT 1,
	`tickers` json NOT NULL,
	`displayOrder` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sectorConfig_id` PRIMARY KEY(`id`),
	CONSTRAINT `sectorConfig_userId_sectorName_idx` UNIQUE(`userId`,`sectorName`)
);
--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `lmtSlippagePct` double DEFAULT 3 NOT NULL;--> statement-breakpoint
CREATE INDEX `sectorConfig_userId_idx` ON `sectorConfig` (`userId`);