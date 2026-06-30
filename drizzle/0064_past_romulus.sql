CREATE TABLE `deepAnalysisCache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`cacheKey` varchar(64) NOT NULL,
	`result` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `deepAnalysisCache_id` PRIMARY KEY(`id`),
	CONSTRAINT `deepAnalysisCache_key_idx` UNIQUE(`ticker`,`cacheKey`)
);
