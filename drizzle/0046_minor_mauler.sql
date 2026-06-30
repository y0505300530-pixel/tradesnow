CREATE TABLE `tvAlerts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(32) NOT NULL,
	`action` varchar(16) NOT NULL,
	`price` double,
	`qty` double,
	`strategy` varchar(128),
	`rawPayload` text,
	`status` enum('received','forwarded_ibkr','ibkr_ok','ibkr_error','ignored') NOT NULL DEFAULT 'received',
	`ibkrOrderId` varchar(64),
	`ibkrError` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `tvAlerts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tvWebhookSettings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`webhookSecret` varchar(64) NOT NULL,
	`autoTradeEnabled` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tvWebhookSettings_id` PRIMARY KEY(`id`),
	CONSTRAINT `tvWebhookSettings_userId_unique` UNIQUE(`userId`)
);
