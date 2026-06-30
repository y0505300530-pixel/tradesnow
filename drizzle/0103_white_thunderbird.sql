DROP INDEX `paperEquitySnapshots_userId_ts_order_idx` ON `paperEquitySnapshots`;--> statement-breakpoint
CREATE INDEX `paperEquitySnapshots_sessionId_idx` ON `paperEquitySnapshots` (`sessionId`);--> statement-breakpoint
CREATE INDEX `paperEquitySnapshots_userId_sessionId_idx` ON `paperEquitySnapshots` (`userId`,`sessionId`);--> statement-breakpoint
CREATE INDEX `paperPositions_sessionId_idx` ON `paperPositions` (`sessionId`);--> statement-breakpoint
CREATE INDEX `paperPositions_userId_sessionId_status_idx` ON `paperPositions` (`userId`,`sessionId`,`status`);--> statement-breakpoint
CREATE INDEX `paperTrades_sessionId_idx` ON `paperTrades` (`sessionId`);--> statement-breakpoint
CREATE INDEX `paperTrades_userId_sessionId_idx` ON `paperTrades` (`userId`,`sessionId`);--> statement-breakpoint
CREATE INDEX `priceAlerts_triggered_dismissed_idx` ON `priceAlerts` (`triggered`,`dismissed`);--> statement-breakpoint
CREATE INDEX `priceAlerts_userId_triggered_dismissed_idx` ON `priceAlerts` (`userId`,`triggered`,`dismissed`);--> statement-breakpoint
CREATE INDEX `userAssets_userId_idx` ON `userAssets` (`userId`);--> statement-breakpoint
CREATE INDEX `userAssets_userId_archived_idx` ON `userAssets` (`userId`,`archived`);