-- BUG #2: 12-hour Snooze/Ignore for War Room candidates.
-- snoozedUntil is unix-epoch MILLISECONDS (bigint) — an active snooze is `snoozedUntil > now()`.
-- Snooze affects ENTRY + candidate VISIBILITY only; it NEVER disables exit management on a held position.
CREATE TABLE IF NOT EXISTS `snoozedTickers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `userId` int NOT NULL,
  `ticker` varchar(16) NOT NULL,
  `snoozedUntil` bigint NOT NULL,
  `reason` varchar(255) NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `snoozedTickers_id` PRIMARY KEY(`id`),
  CONSTRAINT `snoozedTickers_userId_ticker_idx` UNIQUE(`userId`,`ticker`)
);
