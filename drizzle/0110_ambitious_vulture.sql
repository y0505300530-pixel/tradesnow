CREATE TABLE `priceCacheBlob` (
	`id` int AUTO_INCREMENT NOT NULL,
	`data` longtext NOT NULL,
	`tickerCount` int NOT NULL DEFAULT 0,
	`totalBars` int NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `priceCacheBlob_id` PRIMARY KEY(`id`)
);
