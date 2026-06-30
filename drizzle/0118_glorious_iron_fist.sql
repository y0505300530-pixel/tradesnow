ALTER TABLE `paperPositions` ADD `mfePriceHigh` double;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `maePriceLow` double;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `spyPriceAtEntry` double;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `sector` varchar(64);--> statement-breakpoint
ALTER TABLE `paperTrades` ADD `mfePriceHigh` double;--> statement-breakpoint
ALTER TABLE `paperTrades` ADD `maePriceLow` double;--> statement-breakpoint
ALTER TABLE `paperTrades` ADD `spyPriceAtEntry` double;--> statement-breakpoint
ALTER TABLE `paperTrades` ADD `sector` varchar(64);