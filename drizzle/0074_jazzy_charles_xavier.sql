CREATE TABLE `localUsers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`email` varchar(320) NOT NULL,
	`passwordHash` varchar(128) NOT NULL,
	`name` varchar(128) NOT NULL,
	`role` enum('user','admin') NOT NULL DEFAULT 'user',
	`isActive` boolean NOT NULL DEFAULT true,
	`linkedUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`lastSignedIn` timestamp,
	CONSTRAINT `localUsers_id` PRIMARY KEY(`id`),
	CONSTRAINT `localUsers_email_unique` UNIQUE(`email`)
);
