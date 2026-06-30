CREATE TABLE `paperEntryLock` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`positionId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `paperEntryLock_id` PRIMARY KEY(`id`),
	CONSTRAINT `paperEntryLock_userId_ticker_uniq` UNIQUE(`userId`,`ticker`)
);
