ALTER TABLE `portfolioAccounts` MODIFY COLUMN `lastKnownNLV` double;--> statement-breakpoint
ALTER TABLE `portfolioAccounts` MODIFY COLUMN `lastKnownCash` double;--> statement-breakpoint
ALTER TABLE `portfolioAccounts` MODIFY COLUMN `lastKnownTodayPnl` double;--> statement-breakpoint
ALTER TABLE `portfolioAccounts` MODIFY COLUMN `lastKnownNLVAt` timestamp;--> statement-breakpoint
ALTER TABLE `portfolioHoldings` ADD `ibkrSlOrderId` varchar(32);--> statement-breakpoint
ALTER TABLE `portfolioHoldings` ADD `ibkrSlOrderQty` double;--> statement-breakpoint
ALTER TABLE `portfolioHoldings` ADD `ibkrTpOrderId` varchar(32);--> statement-breakpoint
ALTER TABLE `portfolioHoldings` ADD `ibkrTpOrderQty` double;