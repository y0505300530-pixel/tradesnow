CREATE TABLE `ibkrConnectionLog` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`message` text NOT NULL,
	`type` varchar(16) NOT NULL DEFAULT 'info',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ibkrConnectionLog_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ibkrConnectionLog_userId_idx` ON `ibkrConnectionLog` (`userId`);