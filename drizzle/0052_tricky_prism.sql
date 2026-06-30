CREATE TABLE `otpCodes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`openId` varchar(64) NOT NULL,
	`code` varchar(8) NOT NULL,
	`pendingToken` varchar(128) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`used` tinyint NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `otpCodes_id` PRIMARY KEY(`id`),
	CONSTRAINT `otpCodes_pendingToken_unique` UNIQUE(`pendingToken`)
);
