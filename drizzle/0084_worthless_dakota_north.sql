CREATE TABLE `moneyTransfers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`timestamp` bigint NOT NULL,
	`type` varchar(16) NOT NULL,
	`amount` double NOT NULL,
	`balanceBefore` double,
	`balanceAfter` double,
	`source` varchar(32) DEFAULT 'MANUAL',
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `moneyTransfers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `moneyTransfers_userId_ts_idx` ON `moneyTransfers` (`userId`,`timestamp`);