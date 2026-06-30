ALTER TABLE `userAssets` ADD `cmp` double;--> statement-breakpoint
ALTER TABLE `userAssets` ADD `ema50` double;--> statement-breakpoint
ALTER TABLE `userAssets` ADD `ema200` double;--> statement-breakpoint
ALTER TABLE `userAssets` ADD `proximityToEma50Pct` double;--> statement-breakpoint
ALTER TABLE `userAssets` ADD `recommendation` varchar(16);--> statement-breakpoint
ALTER TABLE `userAssets` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `userAssets` ADD `tier` varchar(32);--> statement-breakpoint
ALTER TABLE `userAssets` ADD `weeklyEma50Slope` double;--> statement-breakpoint
ALTER TABLE `userAssets` ADD `donchian20High` double;--> statement-breakpoint
ALTER TABLE `userAssets` ADD `priceAction` varchar(32);--> statement-breakpoint
ALTER TABLE `userAssets` ADD `scannedAt` timestamp;