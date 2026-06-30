ALTER TABLE `labTrades` ADD `direction` enum('long','short') DEFAULT 'long' NOT NULL;--> statement-breakpoint
ALTER TABLE `labTrades` ADD `buyHoldRoi` text;--> statement-breakpoint
ALTER TABLE `labTrades` ADD `alpha` text;--> statement-breakpoint
ALTER TABLE `labTrades` ADD `opportunityCost` text;