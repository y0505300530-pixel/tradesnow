CREATE TABLE `masterKnowledge` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`technicalRules` text,
	`activeSignals` text,
	`learningStatus` text,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `masterKnowledge_id` PRIMARY KEY(`id`),
	CONSTRAINT `masterKnowledge_userId_unique` UNIQUE(`userId`)
);
