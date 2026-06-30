CREATE TABLE `proficiencyMatrix` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`topic` varchar(128) NOT NULL,
	`level` int NOT NULL DEFAULT 1,
	`updateLog` text,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `proficiencyMatrix_id` PRIMARY KEY(`id`)
);
