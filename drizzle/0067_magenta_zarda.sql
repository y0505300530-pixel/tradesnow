ALTER TABLE `tradingDiary` ADD `closePrice` double;--> statement-breakpoint
ALTER TABLE `tradingDiary` ADD `closedAt` timestamp;--> statement-breakpoint
ALTER TABLE `tradingDiary` ADD `pnlUsd` double;--> statement-breakpoint
ALTER TABLE `tradingDiary` ADD `pnlPct` double;--> statement-breakpoint
ALTER TABLE `tradingDiary` ADD `postMortem` text;--> statement-breakpoint
ALTER TABLE `tradingDiary` ADD `diaryStatus` enum('open','closed') DEFAULT 'open' NOT NULL;