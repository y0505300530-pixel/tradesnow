CREATE TABLE `labExecutionLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`action` varchar(32) NOT NULL,
	`units` int NOT NULL,
	`price` double NOT NULL,
	`sl` double,
	`tp` double,
	`zivScore` double,
	`amount` double NOT NULL,
	`status` varchar(32) NOT NULL,
	`message` text NOT NULL,
	`orderId` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `labExecutionLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `labExecutionLogs_userId_idx` ON `labExecutionLogs` (`userId`);