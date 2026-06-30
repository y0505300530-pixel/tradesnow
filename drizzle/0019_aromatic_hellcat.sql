ALTER TABLE `labTrades` ADD `tightExitError` tinyint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `labTrades` ADD `price10DaysAfterExit` text;--> statement-breakpoint
ALTER TABLE `labTrades` ADD `opportunityGap` text;--> statement-breakpoint
ALTER TABLE `labTrades` ADD `stopLossAdjustment` text;