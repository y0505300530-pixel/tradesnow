CREATE TABLE `userAssets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`companyName` varchar(128) NOT NULL,
	`sector` varchar(64) NOT NULL,
	`score` int,
	`label` varchar(64),
	`sortOrder` int NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `userAssets_id` PRIMARY KEY(`id`)
);
