CREATE TABLE `journalEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`eventType` enum('buy','sell','sl_order','tp_order','bracket_order','sync','price_alert','note') NOT NULL,
	`ticker` varchar(16),
	`company` text,
	`units` double,
	`price` double,
	`stopLoss` double,
	`takeProfit` double,
	`orderId` varchar(64),
	`notes` text,
	`metadata` text,
	`eventAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `journalEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `portfolioChatMessages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`role` enum('user','assistant') NOT NULL,
	`content` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `portfolioChatMessages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `journalEvents_userId_idx` ON `journalEvents` (`userId`);--> statement-breakpoint
CREATE INDEX `journalEvents_userId_ticker_idx` ON `journalEvents` (`userId`,`ticker`);--> statement-breakpoint
CREATE INDEX `portfolioChat_userId_idx` ON `portfolioChatMessages` (`userId`);