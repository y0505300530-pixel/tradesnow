CREATE TABLE `priceCache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`date` varchar(16) NOT NULL,
	`open` double NOT NULL,
	`high` double NOT NULL,
	`low` double NOT NULL,
	`close` double NOT NULL,
	`volume` bigint NOT NULL DEFAULT 0,
	`fetchedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `priceCache_id` PRIMARY KEY(`id`),
	CONSTRAINT `priceCache_ticker_date_idx` UNIQUE(`ticker`,`date`)
);
