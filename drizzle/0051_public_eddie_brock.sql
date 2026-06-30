ALTER TABLE `userSettings` ADD `telegramChatId` varchar(64);--> statement-breakpoint
ALTER TABLE `userSettings` ADD `telegramEnabled` tinyint DEFAULT 1 NOT NULL;