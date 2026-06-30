ALTER TABLE `breakoutScans` MODIFY COLUMN `signalType` enum('BREAKOUT','RETEST') NOT NULL DEFAULT 'BREAKOUT';--> statement-breakpoint
ALTER TABLE `breakoutScans` ADD `breakoutLevel` double DEFAULT 0;--> statement-breakpoint
ALTER TABLE `breakoutScans` ADD `currentPrice` double DEFAULT 0;