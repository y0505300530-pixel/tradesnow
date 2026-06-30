CREATE TABLE `engineChatHistory` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`role` varchar(16) NOT NULL,
	`text` text NOT NULL,
	`updatedSL` varchar(32),
	`updatedTP` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `engineChatHistory_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `engineChat_userId_ticker_idx` ON `engineChatHistory` (`userId`,`ticker`);