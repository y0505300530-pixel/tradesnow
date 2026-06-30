CREATE TABLE `ibkrSettings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`gatewayUrl` varchar(255) NOT NULL DEFAULT 'https://localhost:5000',
	`accountId` varchar(32),
	`accountType` enum('paper','live') DEFAULT 'paper',
	`lastConnectedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ibkrSettings_id` PRIMARY KEY(`id`),
	CONSTRAINT `ibkrSettings_userId_unique` UNIQUE(`userId`)
);
