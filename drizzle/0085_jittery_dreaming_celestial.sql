ALTER TABLE `portfolioSnapshots` DROP INDEX `portfolioSnapshots_userId_date_idx`;--> statement-breakpoint
ALTER TABLE `portfolioSnapshots` ADD `portfolioType` varchar(16) DEFAULT 'h1' NOT NULL;--> statement-breakpoint
ALTER TABLE `portfolioSnapshots` ADD CONSTRAINT `portfolioSnapshots_userId_date_portfolio_idx` UNIQUE(`userId`,`snapshotDate`,`portfolioType`);