CREATE TABLE `telegramMonitorGroups` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`groupHandle` varchar(128) NOT NULL,
	`displayName` varchar(128),
	`isActive` boolean NOT NULL DEFAULT true,
	`lastCheckedAt` bigint,
	`lastMessageId` bigint,
	`createdAt` bigint NOT NULL,
	CONSTRAINT `telegramMonitorGroups_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `telegramMonitorMessages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`groupId` int NOT NULL,
	`groupHandle` varchar(128) NOT NULL,
	`messageId` bigint NOT NULL,
	`messageText` text NOT NULL,
	`messageDate` bigint NOT NULL,
	`senderName` varchar(128),
	`category` varchar(64),
	`ticker` varchar(20),
	`upside` varchar(64),
	`summary` text,
	`isRelevant` boolean NOT NULL DEFAULT false,
	`capturedAt` bigint NOT NULL,
	CONSTRAINT `telegramMonitorMessages_id` PRIMARY KEY(`id`)
);
