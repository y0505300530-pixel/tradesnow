ALTER TABLE `paperPositions` ADD `peakPrice` double;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `wideLungActive` int DEFAULT 0;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `wideLungActivatedAt` timestamp;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `finalOrderMode` int DEFAULT 0;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `topUpCount` int DEFAULT 0;