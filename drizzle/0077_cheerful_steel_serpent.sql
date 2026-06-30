CREATE TABLE `orderAuditLog` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`userEmail` varchar(256),
	`ipAddress` varchar(64) NOT NULL,
	`userAgent` varchar(512),
	`ticker` varchar(16) NOT NULL,
	`side` enum('BUY','SELL') NOT NULL,
	`orderType` enum('MKT','LMT','STP') NOT NULL,
	`quantity` varchar(32) NOT NULL,
	`price` varchar(32),
	`stopPrice` varchar(32),
	`ibkrOrderId` varchar(64),
	`status` varchar(64),
	`accountId` varchar(32),
	`createdAt` bigint NOT NULL,
	CONSTRAINT `orderAuditLog_id` PRIMARY KEY(`id`)
);
