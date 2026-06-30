CREATE TABLE `systemLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`level` enum('critical','error','warn','info') NOT NULL,
	`category` varchar(32) NOT NULL,
	`message` text NOT NULL,
	`stack` text,
	`context` text,
	`instanceId` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `systemLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `systemLogs_level_idx` ON `systemLogs` (`level`);--> statement-breakpoint
CREATE INDEX `systemLogs_category_idx` ON `systemLogs` (`category`);--> statement-breakpoint
CREATE INDEX `systemLogs_createdAt_idx` ON `systemLogs` (`createdAt`);