ALTER TABLE `paperTrades` ADD `executionSlippage` double DEFAULT 0;--> statement-breakpoint
ALTER TABLE `paperTrades` ADD `gapExecution` tinyint DEFAULT 0;