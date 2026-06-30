ALTER TABLE `paperPositions` ADD `atr14AtEntry` double;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `ema50AtEntry` double;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `equityAtEntry` double;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `rsiAtEntry` double;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `distFromEma20AtEntryPct` double;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `relativeVolumeAtEntry` double;--> statement-breakpoint
ALTER TABLE `paperPositions` ADD `ema50SlopeAtEntry` double;--> statement-breakpoint
ALTER TABLE `paperTrades` ADD `rsiAtEntry` double;--> statement-breakpoint
ALTER TABLE `paperTrades` ADD `distFromEma20AtEntryPct` double;--> statement-breakpoint
ALTER TABLE `paperTrades` ADD `relativeVolumeAtEntry` double;--> statement-breakpoint
ALTER TABLE `paperTrades` ADD `ema50SlopeAtEntry` double;--> statement-breakpoint
ALTER TABLE `paperTrades` ADD `rsiAtExit` double;--> statement-breakpoint
ALTER TABLE `paperTrades` ADD `atr14AtExit` double;--> statement-breakpoint
ALTER TABLE `paperTrades` ADD `ema50AtExit` double;--> statement-breakpoint
ALTER TABLE `paperTrades` ADD `distFromEma20AtExitPct` double;--> statement-breakpoint
ALTER TABLE `paperTrades` ADD `relativeVolumeAtExit` double;