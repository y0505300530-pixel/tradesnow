CREATE TABLE `breakoutScans` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`companyName` varchar(128),
	`price` double NOT NULL,
	`donchian20High` double,
	`ema50` double,
	`zivScore` double,
	`tier` varchar(32),
	`volumeRatio` double,
	`breakoutPct` double,
	`alertSent` tinyint DEFAULT 0,
	`scannedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `breakoutScans_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `breakoutScans_userId_idx` ON `breakoutScans` (`userId`);--> statement-breakpoint
CREATE INDEX `breakoutScans_userId_ticker_idx` ON `breakoutScans` (`userId`,`ticker`);--> statement-breakpoint
CREATE INDEX `breakoutScans_scannedAt_idx` ON `breakoutScans` (`scannedAt`);