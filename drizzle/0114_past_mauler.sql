CREATE TABLE `analyses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`videoUrl` text NOT NULL,
	`videoId` varchar(32) NOT NULL,
	`videoTitle` text,
	`channelName` text,
	`thumbnailUrl` text,
	`publishDate` timestamp,
	`transcript` text,
	`analysisResult` text,
	`status` enum('pending','processing','done','error') NOT NULL DEFAULT 'pending',
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `analyses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `breakoutScans` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`companyName` varchar(128),
	`price` double NOT NULL,
	`donchian20High` double,
	`ema50` double,
	`zivScore` double,
	`tier` varchar(32),
	`volumeRatio` double,
	`breakoutPct` double,
	`signalType` varchar(16) NOT NULL DEFAULT 'BREAKOUT',
	`retestLevel` double,
	`breakoutLevel` double DEFAULT 0,
	`currentPrice` double DEFAULT 0,
	`alertSent` tinyint DEFAULT 0,
	`scannedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `breakoutScans_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bulkSessionAnalyses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`bulkSessionId` int NOT NULL,
	`analysisId` int NOT NULL,
	`position` int NOT NULL,
	CONSTRAINT `bulkSessionAnalyses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bulkSessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`totalCount` int NOT NULL,
	`doneCount` int NOT NULL DEFAULT 0,
	`errorCount` int NOT NULL DEFAULT 0,
	`status` enum('pending','processing','done') NOT NULL DEFAULT 'pending',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bulkSessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `capitalEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`type` enum('deposit','withdrawal','buy','sell') NOT NULL,
	`amount` double NOT NULL,
	`ticker` varchar(16),
	`units` double,
	`pricePerUnit` double,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `capitalEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `channelVideos` (
	`id` int AUTO_INCREMENT NOT NULL,
	`videoId` varchar(32) NOT NULL,
	`mentor` enum('cycles_trading','micha_stocks') NOT NULL DEFAULT 'cycles_trading',
	`title` text NOT NULL,
	`uploadDate` timestamp NOT NULL,
	`thumbnailUrl` text,
	`duration` int DEFAULT 0,
	`viewCount` int DEFAULT 0,
	`isNew` int NOT NULL DEFAULT 0,
	`analysisId` int,
	`analyzedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `channelVideos_id` PRIMARY KEY(`id`),
	CONSTRAINT `channelVideos_videoId_unique` UNIQUE(`videoId`)
);
--> statement-breakpoint
CREATE TABLE `deepAnalysisCache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`cacheKey` varchar(64) NOT NULL,
	`result` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `deepAnalysisCache_id` PRIMARY KEY(`id`),
	CONSTRAINT `deepAnalysisCache_key_idx` UNIQUE(`ticker`,`cacheKey`)
);
--> statement-breakpoint
CREATE TABLE `engineChatHistory` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`role` varchar(16) NOT NULL,
	`text` text NOT NULL,
	`updatedSL` varchar(32),
	`updatedTP` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `engineChatHistory_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `holding2` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`company` text,
	`buyPrice` double NOT NULL,
	`units` double NOT NULL,
	`currentPrice` double,
	`prevClose` double,
	`dailyChangePercent` double,
	`priceUpdatedAt` timestamp,
	`zivScore` double,
	`stopLoss` double,
	`takeProfit` double,
	`slMode` varchar(32),
	`tpMode` varchar(32),
	`dailyBasePrice` double,
	`dailyBaseTs` bigint,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `holding2_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `hourlySnapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`snapshotTs` bigint NOT NULL,
	`h1Value` double,
	`h2Value` double,
	`combinedValue` double NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `hourlySnapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `hourlySnapshots_userId_ts_idx` UNIQUE(`userId`,`snapshotTs`)
);
--> statement-breakpoint
CREATE TABLE `ibkrConidCache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(32) NOT NULL,
	`conid` int NOT NULL,
	`exchange` varchar(32),
	`currency` varchar(8),
	`assetClass` varchar(16),
	`resolvedAt` bigint NOT NULL,
	CONSTRAINT `ibkrConidCache_id` PRIMARY KEY(`id`),
	CONSTRAINT `ibkrConidCache_symbol_unique` UNIQUE(`symbol`)
);
--> statement-breakpoint
CREATE TABLE `ibkrConnectionLog` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`message` text NOT NULL,
	`type` varchar(16) NOT NULL DEFAULT 'info',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ibkrConnectionLog_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ibkrSettings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`gatewayUrl` varchar(255) NOT NULL DEFAULT 'https://localhost:5000',
	`accountId` varchar(32),
	`accountType` enum('paper','live') DEFAULT 'paper',
	`sessionCookie` text,
	`lastConnectedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ibkrSettings_id` PRIMARY KEY(`id`),
	CONSTRAINT `ibkrSettings_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `journalEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`eventType` enum('buy','sell','sl_order','tp_order','bracket_order','sync','price_alert','note') NOT NULL,
	`ticker` varchar(16),
	`company` text,
	`units` double,
	`price` double,
	`stopLoss` double,
	`takeProfit` double,
	`orderId` varchar(64),
	`notes` text,
	`metadata` text,
	`eventAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `journalEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `knowledgeBase` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`result` text,
	`analysisCount` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `knowledgeBase_id` PRIMARY KEY(`id`),
	CONSTRAINT `knowledgeBase_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `labDailyLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`simulationId` int NOT NULL,
	`date` varchar(16) NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`action` varchar(64) NOT NULL,
	`detail` text,
	`totalWallet` text,
	`runningRoi` text,
	`monkeyValue` text,
	`strategyAlpha` text,
	`profitMissed` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `labDailyLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `labExecutionLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`action` varchar(32) NOT NULL,
	`units` int NOT NULL,
	`price` double NOT NULL,
	`sl` double,
	`tp` double,
	`zivScore` double,
	`amount` double NOT NULL,
	`status` varchar(32) NOT NULL,
	`message` text NOT NULL,
	`orderId` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `labExecutionLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `labSimulations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(128) NOT NULL DEFAULT 'Simulation',
	`tickers` text NOT NULL,
	`startDate` timestamp NOT NULL,
	`endDate` timestamp NOT NULL,
	`capitalPerTrade` int NOT NULL DEFAULT 10000,
	`tickerCapitals` text,
	`status` enum('pending','scanning','running','done','error') NOT NULL DEFAULT 'pending',
	`scanReport` mediumtext,
	`equityCurve` text,
	`totalROI` text,
	`totalProfit` text,
	`finalWallet` text,
	`monkeyValue` text,
	`profitMissed` text,
	`simVersion` varchar(32),
	`systemCodeVersion` varchar(16),
	`errorMessage` text,
	`benchmarkData` text,
	`lessonsLearned` text,
	`minZivScore` int DEFAULT 4,
	`targetAlphaMonthly` int DEFAULT 15,
	`partialLockGainThreshold` int DEFAULT 50,
	`riskLevel` int DEFAULT 5,
	`maxSinglePositionPct` int DEFAULT 20,
	`checkpointDayIdx` int DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `labSimulations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `labTrades` (
	`id` int AUTO_INCREMENT NOT NULL,
	`simulationId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`entryDate` timestamp,
	`exitDate` timestamp,
	`entryPrice` text,
	`exitPrice` text,
	`stopLoss` text,
	`takeProfit` text,
	`capitalUsed` int NOT NULL DEFAULT 10000,
	`startingBalance` text,
	`endingBalance` text,
	`profitLoss` text,
	`roiPct` text,
	`outcome` enum('win','loss','open','skipped') NOT NULL DEFAULT 'open',
	`exitReason` varchar(32),
	`entryReasoning` text,
	`exitReasoning` text,
	`target1Price` text,
	`partialTpHit` tinyint NOT NULL DEFAULT 0,
	`partialTpDate` timestamp,
	`realizedProfit` text,
	`remainingExposure` text,
	`runnersRoi` text,
	`target1Roi` text,
	`direction` enum('long','short') NOT NULL DEFAULT 'long',
	`buyHoldRoi` text,
	`alpha` text,
	`opportunityCost` text,
	`tightExitError` tinyint NOT NULL DEFAULT 0,
	`price10DaysAfterExit` text,
	`opportunityGap` text,
	`stopLossAdjustment` text,
	`zivFormation` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `labTrades_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `llmScanCache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`dateKey` varchar(16) NOT NULL,
	`priceKey` varchar(16) NOT NULL,
	`result` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `llmScanCache_id` PRIMARY KEY(`id`),
	CONSTRAINT `llmScanCache_key_idx` UNIQUE(`ticker`,`dateKey`,`priceKey`)
);
--> statement-breakpoint
CREATE TABLE `localUsers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`email` varchar(320) NOT NULL,
	`passwordHash` varchar(128) NOT NULL,
	`name` varchar(128) NOT NULL,
	`role` enum('user','admin') NOT NULL DEFAULT 'user',
	`isActive` boolean NOT NULL DEFAULT true,
	`linkedUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`lastSignedIn` timestamp,
	`telegramChatId` varchar(64),
	CONSTRAINT `localUsers_id` PRIMARY KEY(`id`),
	CONSTRAINT `localUsers_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `masterKnowledge` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`technicalRules` text,
	`activeSignals` text,
	`learningStatus` text,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `masterKnowledge_id` PRIMARY KEY(`id`),
	CONSTRAINT `masterKnowledge_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `moneyTransfers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`timestamp` bigint NOT NULL,
	`type` varchar(16) NOT NULL,
	`amount` double NOT NULL,
	`balanceBefore` double,
	`balanceAfter` double,
	`source` varchar(32) DEFAULT 'MANUAL',
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `moneyTransfers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `orderAuditLog` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`userEmail` varchar(256),
	`ipAddress` varchar(64) NOT NULL,
	`userAgent` varchar(512),
	`ticker` varchar(16) NOT NULL,
	`side` enum('BUY','SELL') NOT NULL,
	`orderType` enum('MKT','LMT','STP') NOT NULL,
	`quantity` varchar(32) NOT NULL,
	`price` varchar(32),
	`stopPrice` varchar(32),
	`ibkrOrderId` varchar(64),
	`status` varchar(64),
	`accountId` varchar(32),
	`createdAt` bigint NOT NULL,
	CONSTRAINT `orderAuditLog_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `otpCodes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`openId` varchar(64) NOT NULL,
	`code` varchar(8) NOT NULL,
	`pendingToken` varchar(128) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`used` tinyint NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `otpCodes_id` PRIMARY KEY(`id`),
	CONSTRAINT `otpCodes_pendingToken_unique` UNIQUE(`pendingToken`)
);
--> statement-breakpoint
CREATE TABLE `paperEntryLock` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`positionId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `paperEntryLock_id` PRIMARY KEY(`id`),
	CONSTRAINT `paperEntryLock_userId_ticker_uniq` UNIQUE(`userId`,`ticker`)
);
--> statement-breakpoint
CREATE TABLE `paperEquitySnapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`totalEquity` double NOT NULL,
	`snapshotTs` bigint NOT NULL,
	`sessionId` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `paperEquitySnapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `paperEquitySnapshots_userId_ts_idx` UNIQUE(`userId`,`snapshotTs`)
);
--> statement-breakpoint
CREATE TABLE `paperLedger` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`availableCash` double NOT NULL DEFAULT 100000,
	`initialCapital` double NOT NULL DEFAULT 100000,
	`sessionId` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `paperLedger_id` PRIMARY KEY(`id`),
	CONSTRAINT `paperLedger_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `paperPenaltyBox` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`activatedAt` timestamp NOT NULL DEFAULT (now()),
	`expiresAt` timestamp NOT NULL,
	`slHitCount` int NOT NULL DEFAULT 2,
	`sessionId` int NOT NULL DEFAULT 1,
	CONSTRAINT `paperPenaltyBox_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `paperPositions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`companyName` varchar(128),
	`signal` varchar(32) NOT NULL,
	`zivScore` double,
	`units` int NOT NULL,
	`entryPrice` double NOT NULL,
	`rawEntryPrice` double NOT NULL,
	`allocatedCapital` double NOT NULL,
	`initialSl` double NOT NULL,
	`initialTp` double NOT NULL,
	`currentSl` double NOT NULL,
	`currentTp` double NOT NULL,
	`currentPrice` double,
	`unrealizedPnl` double DEFAULT 0,
	`unrealizedPnlPct` double DEFAULT 0,
	`zivHScore` double,
	`slHitCount` int DEFAULT 0,
	`positionSizeUsd` double DEFAULT 5000,
	`profitLockTriggered` int DEFAULT 0,
	`peakPrice` double,
	`wideLungActive` int DEFAULT 0,
	`wideLungActivatedAt` timestamp,
	`finalOrderMode` int DEFAULT 0,
	`topUpCount` int DEFAULT 0,
	`isColdStrategy` int DEFAULT 0,
	`isParkingLot` int DEFAULT 0,
	`isJoinTheMove` int DEFAULT 0,
	`isDonchianBreakout` int DEFAULT 0,
	`gannNextTightenDay` int,
	`partialTpHit` int DEFAULT 0,
	`slMovedToBreakEven` int DEFAULT 0,
	`target1Price` double,
	`remainingUnits` int,
	`partialRealizedPnl` double DEFAULT 0,
	`extremeMomentumMode` int DEFAULT 0,
	`slowGrindCount` int DEFAULT 0,
	`riskLevel` int DEFAULT 5,
	`status` varchar(16) NOT NULL DEFAULT 'open',
	`sessionId` int NOT NULL DEFAULT 1,
	`exchange` varchar(8) NOT NULL DEFAULT 'US',
	`openedAt` timestamp NOT NULL DEFAULT (now()),
	`closedAt` timestamp,
	CONSTRAINT `paperPositions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `paperReentryWatch` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`exitPrice` double NOT NULL,
	`exitReason` varchar(32) NOT NULL,
	`exitDate` timestamp NOT NULL,
	`candlesAboveExitPrice` int DEFAULT 0,
	`snapBackEligible` int DEFAULT 0,
	`recoveryChecked` int DEFAULT 0,
	`reentryExecuted` int DEFAULT 0,
	`sessionId` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `paperReentryWatch_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `paperTickerWallet` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`totalPnl` double NOT NULL DEFAULT 0,
	`tradeCount` int NOT NULL DEFAULT 0,
	`winCount` int NOT NULL DEFAULT 0,
	`lossCount` int NOT NULL DEFAULT 0,
	`lastTradeAt` timestamp,
	`sessionId` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `paperTickerWallet_id` PRIMARY KEY(`id`),
	CONSTRAINT `paperTickerWallet_userId_ticker_session_uniq` UNIQUE(`userId`,`ticker`,`sessionId`)
);
--> statement-breakpoint
CREATE TABLE `paperTightExitAudit` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`exitPrice` double NOT NULL,
	`postExitHighPrice` double,
	`postExitGainPct` double DEFAULT 0,
	`slWidenMultiplier` double DEFAULT 1,
	`sessionId` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `paperTightExitAudit_id` PRIMARY KEY(`id`),
	CONSTRAINT `paperTightExitAudit_userId_ticker_session_uniq` UNIQUE(`userId`,`ticker`,`sessionId`)
);
--> statement-breakpoint
CREATE TABLE `paperTrades` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`positionId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`signal` varchar(32) NOT NULL,
	`zivScore` double,
	`zivHAtEntry` double,
	`zivHAtExit` double,
	`atr14AtEntry` double,
	`ema50AtEntry` double,
	`units` int NOT NULL,
	`entryPrice` double NOT NULL,
	`exitPrice` double NOT NULL,
	`initialSl` double,
	`initialTp` double,
	`finalSl` double,
	`finalTp` double,
	`rrRatio` double,
	`allocatedCapital` double NOT NULL,
	`equityAtEntry` double,
	`realizedPnl` double NOT NULL,
	`realizedPnlPct` double NOT NULL,
	`holdTimeMinutes` int,
	`exitReason` varchar(32) NOT NULL,
	`executionSlippage` double DEFAULT 0,
	`gapExecution` tinyint DEFAULT 0,
	`sessionId` int NOT NULL DEFAULT 1,
	`openedAt` timestamp NOT NULL,
	`closedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `paperTrades_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `parkingLotConfig` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`weight` double NOT NULL,
	`enabled` tinyint NOT NULL DEFAULT 1,
	`sortOrder` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `parkingLotConfig_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `portfolioAccounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`totalCapital` double NOT NULL DEFAULT 0,
	`cashBalance` double NOT NULL DEFAULT 0,
	`currency` varchar(8) NOT NULL DEFAULT 'USD',
	`lastKnownNLV` double,
	`lastKnownNetLiquidation` double,
	`lastKnownCash` double,
	`lastKnownTodayPnl` double,
	`lastKnownNLVAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `portfolioAccounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `portfolioAccounts_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `portfolioAnalysis` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`result` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `portfolioAnalysis_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `portfolioChatMessages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`role` enum('user','assistant') NOT NULL,
	`content` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `portfolioChatMessages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `portfolioHoldings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`company` text,
	`buyPrice` double NOT NULL,
	`units` double NOT NULL,
	`currentPrice` double,
	`dailyChangePercent` double,
	`priceUpdatedAt` timestamp,
	`transactionDate` date,
	`zivScore` double,
	`stopLoss` double,
	`takeProfit` double,
	`positionSizePct` double,
	`peakPrice` double,
	`entryTier` varchar(32),
	`buyScore` double,
	`notes` text,
	`ibkrUnrealizedPnl` double,
	`conid` int,
	`ibkrSlOrderId` varchar(32),
	`ibkrSlOrderQty` double,
	`ibkrTpOrderId` varchar(32),
	`ibkrTpOrderQty` double,
	`slMode` varchar(32),
	`tpMode` varchar(32),
	`dailyBasePrice` double,
	`dailyBaseTs` bigint,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `portfolioHoldings_id` PRIMARY KEY(`id`),
	CONSTRAINT `portfolioHoldings_userId_ticker_idx` UNIQUE(`userId`,`ticker`)
);
--> statement-breakpoint
CREATE TABLE `portfolioSnapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`snapshotDate` varchar(16) NOT NULL,
	`portfolioType` varchar(16) NOT NULL DEFAULT 'h1',
	`totalValue` double NOT NULL,
	`investedValue` double NOT NULL,
	`cashBalance` double NOT NULL,
	`totalCost` double NOT NULL,
	`pnlUsd` double NOT NULL,
	`pnlPct` double NOT NULL,
	`totalEquity` double,
	`unrealizedPnL` double,
	`h2Value` double,
	`holdingsSnapshot` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `portfolioSnapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `portfolioSnapshots_userId_date_portfolio_idx` UNIQUE(`userId`,`snapshotDate`,`portfolioType`)
);
--> statement-breakpoint
CREATE TABLE `priceAlerts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`alertType` enum('sl','tp','custom') NOT NULL,
	`targetPrice` double NOT NULL,
	`direction` enum('below','above') NOT NULL,
	`label` varchar(64),
	`triggered` tinyint NOT NULL DEFAULT 0,
	`triggeredAt` timestamp,
	`triggeredPrice` double,
	`dismissed` tinyint NOT NULL DEFAULT 0,
	`zivScore` double,
	`archivedAt` timestamp,
	`lastAlertSentAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `priceAlerts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `priceCache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`date` varchar(16) NOT NULL,
	`open` double NOT NULL,
	`high` double NOT NULL,
	`low` double NOT NULL,
	`close` double NOT NULL,
	`volume` bigint NOT NULL DEFAULT 0,
	`fetchedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `priceCache_id` PRIMARY KEY(`id`),
	CONSTRAINT `priceCache_ticker_date_idx` UNIQUE(`ticker`,`date`)
);
--> statement-breakpoint
CREATE TABLE `priceCacheBlob` (
	`id` int AUTO_INCREMENT NOT NULL,
	`data` longtext NOT NULL,
	`tickerCount` int NOT NULL DEFAULT 0,
	`totalBars` int NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `priceCacheBlob_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `proficiencyMatrix` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`topic` varchar(128) NOT NULL,
	`level` int NOT NULL DEFAULT 1,
	`updateLog` text,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `proficiencyMatrix_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `systemLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`level` enum('critical','error','warn','info') NOT NULL,
	`category` varchar(32) NOT NULL,
	`message` text NOT NULL,
	`stack` text,
	`context` text,
	`instanceId` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `systemLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `systemSettings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`key` varchar(128) NOT NULL,
	`value` text NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `systemSettings_id` PRIMARY KEY(`id`),
	CONSTRAINT `systemSettings_key_unique` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `telegramMonitorGroups` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`groupHandle` varchar(128) NOT NULL,
	`displayName` varchar(128),
	`isActive` boolean NOT NULL DEFAULT true,
	`lastCheckedAt` bigint,
	`lastMessageId` bigint,
	`createdAt` bigint NOT NULL,
	CONSTRAINT `telegramMonitorGroups_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `telegramMonitorMessages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`groupId` int NOT NULL,
	`groupHandle` varchar(128) NOT NULL,
	`messageId` bigint NOT NULL,
	`messageText` text NOT NULL,
	`messageDate` bigint NOT NULL,
	`senderName` varchar(128),
	`category` varchar(64),
	`ticker` varchar(20),
	`upside` varchar(64),
	`summary` text,
	`isRelevant` boolean NOT NULL DEFAULT false,
	`capturedAt` bigint NOT NULL,
	CONSTRAINT `telegramMonitorMessages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tradePositions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`company` text,
	`aiEntry` text,
	`aiStopLoss` text,
	`aiTakeProfit` text,
	`aiLogic` text,
	`aiLogicDetail` text,
	`aiConfidence` varchar(16),
	`userEntry` text,
	`userStopLoss` text,
	`userTakeProfit` text,
	`userNotes` text,
	`target1Price` text,
	`realizedProfit` text,
	`remainingExposure` text,
	`status` enum('watching','active','closed') NOT NULL DEFAULT 'watching',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tradePositions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tradingDiary` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`company` text,
	`units` double NOT NULL,
	`buyPrice` double NOT NULL,
	`stopLoss` double,
	`takeProfit` double,
	`reason` text,
	`expectations` text,
	`closePrice` double,
	`closedAt` timestamp,
	`pnlUsd` double,
	`pnlPct` double,
	`postMortem` text,
	`diaryStatus` enum('open','closed') NOT NULL DEFAULT 'open',
	`addedAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tradingDiary_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tvAlerts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(32) NOT NULL,
	`action` varchar(16) NOT NULL,
	`price` double,
	`qty` double,
	`strategy` varchar(128),
	`rawPayload` text,
	`status` enum('received','forwarded_ibkr','ibkr_ok','ibkr_error','ignored') NOT NULL DEFAULT 'received',
	`ibkrOrderId` varchar(64),
	`ibkrError` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `tvAlerts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tvWebhookSettings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`webhookSecret` varchar(64) NOT NULL,
	`autoTradeEnabled` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tvWebhookSettings_id` PRIMARY KEY(`id`),
	CONSTRAINT `tvWebhookSettings_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `userAssets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`exchange` varchar(8) NOT NULL DEFAULT 'US',
	`companyName` varchar(128) NOT NULL,
	`sector` varchar(64) NOT NULL,
	`score` double,
	`label` varchar(64),
	`dailyChangePercent` double,
	`sortOrder` int NOT NULL DEFAULT 0,
	`cmp` double,
	`ema50` double,
	`ema200` double,
	`proximityToEma50Pct` double,
	`recommendation` varchar(16),
	`reason` text,
	`tier` varchar(32),
	`weeklyEma50Slope` double,
	`donchian20High` double,
	`priceAction` varchar(32),
	`recommendedBuyPrice` double,
	`recommendedStopLoss` double,
	`hotSignal` tinyint DEFAULT 0,
	`scannedAt` timestamp,
	`archived` tinyint NOT NULL DEFAULT 0,
	`archivedAt` timestamp,
	`profitPotential` double,
	`note` text,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `userAssets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `userSettings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`tradingviewWebhookUrl` text,
	`tradingviewApiKey` text,
	`platform` varchar(64) NOT NULL DEFAULT 'tradingview',
	`startingBalance` int NOT NULL DEFAULT 10000,
	`riskPerTrade` int NOT NULL DEFAULT 2,
	`stopLossBuffer` int NOT NULL DEFAULT 0,
	`telegramChatId` varchar(64),
	`telegramEnabled` tinyint NOT NULL DEFAULT 1,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `userSettings_id` PRIMARY KEY(`id`),
	CONSTRAINT `userSettings_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `watchlistDismissed` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`dismissedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `watchlistDismissed_id` PRIMARY KEY(`id`),
	CONSTRAINT `watchlistDismissed_userId_ticker_idx` UNIQUE(`userId`,`ticker`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `totpSecret` varchar(64);--> statement-breakpoint
CREATE INDEX `breakoutScans_userId_idx` ON `breakoutScans` (`userId`);--> statement-breakpoint
CREATE INDEX `breakoutScans_userId_ticker_idx` ON `breakoutScans` (`userId`,`ticker`);--> statement-breakpoint
CREATE INDEX `breakoutScans_scannedAt_idx` ON `breakoutScans` (`scannedAt`);--> statement-breakpoint
CREATE INDEX `engineChat_userId_ticker_idx` ON `engineChatHistory` (`userId`,`ticker`);--> statement-breakpoint
CREATE INDEX `holding2_userId_ticker_idx` ON `holding2` (`userId`,`ticker`);--> statement-breakpoint
CREATE INDEX `ibkrConnectionLog_userId_idx` ON `ibkrConnectionLog` (`userId`);--> statement-breakpoint
CREATE INDEX `journalEvents_userId_idx` ON `journalEvents` (`userId`);--> statement-breakpoint
CREATE INDEX `journalEvents_userId_ticker_idx` ON `journalEvents` (`userId`,`ticker`);--> statement-breakpoint
CREATE INDEX `labDailyLogs_simulationId_idx` ON `labDailyLogs` (`simulationId`);--> statement-breakpoint
CREATE INDEX `labDailyLogs_date_idx` ON `labDailyLogs` (`date`);--> statement-breakpoint
CREATE INDEX `labExecutionLogs_userId_idx` ON `labExecutionLogs` (`userId`);--> statement-breakpoint
CREATE INDEX `labTrades_simulationId_idx` ON `labTrades` (`simulationId`);--> statement-breakpoint
CREATE INDEX `labTrades_ticker_idx` ON `labTrades` (`ticker`);--> statement-breakpoint
CREATE INDEX `moneyTransfers_userId_ts_idx` ON `moneyTransfers` (`userId`,`timestamp`);--> statement-breakpoint
CREATE INDEX `orderAuditLog_userId_idx` ON `orderAuditLog` (`userId`);--> statement-breakpoint
CREATE INDEX `orderAuditLog_createdAt_idx` ON `orderAuditLog` (`createdAt`);--> statement-breakpoint
CREATE INDEX `orderAuditLog_userId_createdAt_idx` ON `orderAuditLog` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `paperEquitySnapshots_sessionId_idx` ON `paperEquitySnapshots` (`sessionId`);--> statement-breakpoint
CREATE INDEX `paperEquitySnapshots_userId_sessionId_idx` ON `paperEquitySnapshots` (`userId`,`sessionId`);--> statement-breakpoint
CREATE INDEX `paperLedger_userId_idx` ON `paperLedger` (`userId`);--> statement-breakpoint
CREATE INDEX `paperPenaltyBox_userId_ticker_idx` ON `paperPenaltyBox` (`userId`,`ticker`);--> statement-breakpoint
CREATE INDEX `paperPenaltyBox_expiresAt_idx` ON `paperPenaltyBox` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `paperPositions_userId_idx` ON `paperPositions` (`userId`);--> statement-breakpoint
CREATE INDEX `paperPositions_status_idx` ON `paperPositions` (`status`);--> statement-breakpoint
CREATE INDEX `paperPositions_userId_status_idx` ON `paperPositions` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `paperPositions_sessionId_idx` ON `paperPositions` (`sessionId`);--> statement-breakpoint
CREATE INDEX `paperPositions_userId_sessionId_status_idx` ON `paperPositions` (`userId`,`sessionId`,`status`);--> statement-breakpoint
CREATE INDEX `paperReentryWatch_userId_ticker_session_idx` ON `paperReentryWatch` (`userId`,`ticker`,`sessionId`);--> statement-breakpoint
CREATE INDEX `paperTrades_userId_idx` ON `paperTrades` (`userId`);--> statement-breakpoint
CREATE INDEX `paperTrades_closedAt_idx` ON `paperTrades` (`closedAt`);--> statement-breakpoint
CREATE INDEX `paperTrades_sessionId_idx` ON `paperTrades` (`sessionId`);--> statement-breakpoint
CREATE INDEX `paperTrades_userId_sessionId_idx` ON `paperTrades` (`userId`,`sessionId`);--> statement-breakpoint
CREATE INDEX `portfolioChat_userId_idx` ON `portfolioChatMessages` (`userId`);--> statement-breakpoint
CREATE INDEX `priceAlerts_userId_ticker_idx` ON `priceAlerts` (`userId`,`ticker`);--> statement-breakpoint
CREATE INDEX `priceAlerts_triggered_dismissed_idx` ON `priceAlerts` (`triggered`,`dismissed`);--> statement-breakpoint
CREATE INDEX `priceAlerts_userId_triggered_dismissed_idx` ON `priceAlerts` (`userId`,`triggered`,`dismissed`);--> statement-breakpoint
CREATE INDEX `systemLogs_level_idx` ON `systemLogs` (`level`);--> statement-breakpoint
CREATE INDEX `systemLogs_category_idx` ON `systemLogs` (`category`);--> statement-breakpoint
CREATE INDEX `systemLogs_createdAt_idx` ON `systemLogs` (`createdAt`);--> statement-breakpoint
CREATE INDEX `tradingDiary_userId_idx` ON `tradingDiary` (`userId`);--> statement-breakpoint
CREATE INDEX `userAssets_userId_idx` ON `userAssets` (`userId`);--> statement-breakpoint
CREATE INDEX `userAssets_userId_archived_idx` ON `userAssets` (`userId`,`archived`);