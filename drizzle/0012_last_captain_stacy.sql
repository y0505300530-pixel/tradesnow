CREATE TABLE `labDailyLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`simulationId` int NOT NULL,
	`date` varchar(16) NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`action` varchar(64) NOT NULL,
	`detail` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `labDailyLogs_id` PRIMARY KEY(`id`)
);
