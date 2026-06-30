CREATE TABLE `paperEquitySnapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`totalEquity` double NOT NULL,
	`snapshotTs` bigint NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `paperEquitySnapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `paperEquitySnapshots_userId_ts_idx` UNIQUE(`userId`,`snapshotTs`)
);
--> statement-breakpoint
CREATE INDEX `paperEquitySnapshots_userId_ts_order_idx` ON `paperEquitySnapshots` (`userId`,`snapshotTs`);