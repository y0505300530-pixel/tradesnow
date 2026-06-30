ALTER TABLE `breakoutScans` ADD `signalType` varchar(16) DEFAULT 'BREAKOUT' NOT NULL;--> statement-breakpoint
ALTER TABLE `breakoutScans` ADD `retestLevel` double;