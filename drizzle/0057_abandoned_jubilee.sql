CREATE TABLE `watchlistDismissed` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`dismissedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `watchlistDismissed_id` PRIMARY KEY(`id`),
	CONSTRAINT `watchlistDismissed_userId_ticker_idx` UNIQUE(`userId`,`ticker`)
);
