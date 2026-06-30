ALTER TABLE `portfolioAccounts` ADD `lastKnownNLV` double DEFAULT null;--> statement-breakpoint
ALTER TABLE `portfolioAccounts` ADD `lastKnownCash` double DEFAULT null;--> statement-breakpoint
ALTER TABLE `portfolioAccounts` ADD `lastKnownTodayPnl` double DEFAULT null;--> statement-breakpoint
ALTER TABLE `portfolioAccounts` ADD `lastKnownNLVAt` timestamp DEFAULT null;