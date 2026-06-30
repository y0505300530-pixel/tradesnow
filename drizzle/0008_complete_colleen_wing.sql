CREATE TABLE `channelVideos` (
	`id` int AUTO_INCREMENT NOT NULL,
	`videoId` varchar(32) NOT NULL,
	`title` text NOT NULL,
	`uploadDate` timestamp NOT NULL,
	`thumbnailUrl` text,
	`duration` int DEFAULT 0,
	`viewCount` int DEFAULT 0,
	`isNew` int NOT NULL DEFAULT 0,
	`analysisId` int,
	`analyzedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `channelVideos_id` PRIMARY KEY(`id`),
	CONSTRAINT `channelVideos_videoId_unique` UNIQUE(`videoId`)
);
