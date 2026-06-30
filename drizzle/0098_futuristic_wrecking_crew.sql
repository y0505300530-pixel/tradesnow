ALTER TABLE `paperEquitySnapshots` ADD `sessionId` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `paperLedger` ADD `sessionId` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `sessionId` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `paperTrades` ADD `sessionId` int DEFAULT 1 NOT NULL;