ALTER TABLE `paperTrades` MODIFY COLUMN `exitReason` varchar(32) NOT NULL;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `slHitCount` int DEFAULT 0;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `positionSizeUsd` double DEFAULT 5000;