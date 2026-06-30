CREATE TABLE `hourlySnapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`snapshotTs` bigint NOT NULL,
	`h1Value` double,
	`h2Value` double,
	`combinedValue` double NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `hourlySnapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `hourlySnapshots_userId_ts_idx` UNIQUE(`userId`,`snapshotTs`)
);
