ALTER TABLE `labTrades` ADD `target1Price` text;--> statement-breakpoint
ALTER TABLE `labTrades` ADD `partialTpHit` tinyint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `labTrades` ADD `partialTpDate` timestamp;--> statement-breakpoint
ALTER TABLE `labTrades` ADD `realizedProfit` text;--> statement-breakpoint
ALTER TABLE `labTrades` ADD `remainingExposure` text;--> statement-breakpoint
ALTER TABLE `labTrades` ADD `runnersRoi` text;--> statement-breakpoint
ALTER TABLE `labTrades` ADD `target1Roi` text;--> statement-breakpoint
ALTER TABLE `tradePositions` ADD `target1Price` text;--> statement-breakpoint
ALTER TABLE `tradePositions` ADD `realizedProfit` text;--> statement-breakpoint
ALTER TABLE `tradePositions` ADD `remainingExposure` text;