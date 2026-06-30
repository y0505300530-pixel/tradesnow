CREATE TABLE `ibkrConidCache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(32) NOT NULL,
	`conid` int NOT NULL,
	`exchange` varchar(32),
	`currency` varchar(8),
	`assetClass` varchar(16),
	`resolvedAt` bigint NOT NULL,
	CONSTRAINT `ibkrConidCache_id` PRIMARY KEY(`id`),
	CONSTRAINT `ibkrConidCache_symbol_unique` UNIQUE(`symbol`)
);
