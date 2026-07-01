-- Multi trading accounts: separate IBKR logins, shared catalog, per-account Live config.
-- CEO (slug=ceo) migrates from existing liveEngineConfig row.

CREATE TABLE IF NOT EXISTS `ibkrGateways` (
  `id` int NOT NULL AUTO_INCREMENT,
  `slug` varchar(32) NOT NULL,
  `label` varchar(64) NOT NULL,
  `baseUrl` varchar(255) NOT NULL DEFAULT 'http://127.0.0.1:5000',
  `apiSecretEnvKey` varchar(64) DEFAULT NULL,
  `hmacSecretEnvKey` varchar(64) DEFAULT NULL,
  `isActive` tinyint NOT NULL DEFAULT 1,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ibkrGateways_slug_idx` (`slug`)
);

CREATE TABLE IF NOT EXISTS `tradingAccounts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `slug` varchar(32) NOT NULL,
  `label` varchar(64) NOT NULL,
  `gatewayId` int NOT NULL,
  `ibkrAccountId` varchar(32) NOT NULL DEFAULT '',
  `ownerUserId` int NOT NULL DEFAULT 1,
  `catalogUserId` int NOT NULL DEFAULT 1,
  `linkedLocalUserId` int DEFAULT NULL,
  `sortOrder` int NOT NULL DEFAULT 0,
  `isActive` tinyint NOT NULL DEFAULT 1,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `tradingAccounts_slug_idx` (`slug`),
  KEY `tradingAccounts_gatewayId_idx` (`gatewayId`)
);

ALTER TABLE `liveEngineConfig`
  ADD COLUMN `tradingAccountId` int DEFAULT NULL AFTER `userId`,
  ADD COLUMN `minOrderUsd` double NOT NULL DEFAULT 5000 AFTER `minPositionUsd`;

ALTER TABLE `livePositions`
  ADD COLUMN `tradingAccountId` int DEFAULT NULL AFTER `userId`;

-- Seed CEO gateway (default env secrets)
INSERT INTO `ibkrGateways` (`slug`, `label`, `baseUrl`, `apiSecretEnvKey`, `hmacSecretEnvKey`, `isActive`)
SELECT 'ceo', 'CEO ELZA', 'http://127.0.0.1:5000', 'IBIND_API_SECRET', 'IBIND_HMAC_SECRET', 1
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `ibkrGateways` WHERE `slug` = 'ceo');

-- Seed Dror gateway (separate login — configure env + ibkrAccountId after account opens)
INSERT INTO `ibkrGateways` (`slug`, `label`, `baseUrl`, `apiSecretEnvKey`, `hmacSecretEnvKey`, `isActive`)
SELECT 'dror', 'דרור', 'http://127.0.0.1:5002', 'IBIND_API_SECRET_DROR', 'IBIND_HMAC_SECRET_DROR', 1
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `ibkrGateways` WHERE `slug` = 'dror');

INSERT INTO `tradingAccounts` (`slug`, `label`, `gatewayId`, `ibkrAccountId`, `ownerUserId`, `catalogUserId`, `sortOrder`, `isActive`)
SELECT 'ceo', 'CEO ELZA', g.id, '', 1, 1, 1, 1
FROM `ibkrGateways` g WHERE g.slug = 'ceo'
  AND NOT EXISTS (SELECT 1 FROM `tradingAccounts` WHERE `slug` = 'ceo');

INSERT INTO `tradingAccounts` (`slug`, `label`, `gatewayId`, `ibkrAccountId`, `ownerUserId`, `catalogUserId`, `sortOrder`, `isActive`)
SELECT 'dror', 'דרור', g.id, '', 1, 1, 2, 1
FROM `ibkrGateways` g WHERE g.slug = 'dror'
  AND NOT EXISTS (SELECT 1 FROM `tradingAccounts` WHERE `slug` = 'dror');

-- Link existing CEO liveEngineConfig → tradingAccount ceo
UPDATE `liveEngineConfig` lec
JOIN `tradingAccounts` ta ON ta.slug = 'ceo'
SET lec.`tradingAccountId` = ta.id
WHERE lec.`tradingAccountId` IS NULL AND lec.`userId` = 1;

-- Allow multiple liveEngineConfig rows (CEO + Dror share catalog userId=1) — MUST precede Dror INSERT
ALTER TABLE `liveEngineConfig` DROP INDEX `liveEngineConfig_userId_unique`;

-- Dror live config: $20k, 8 slots, ~$5k/position, 1.8× leverage (DORMANT: isEnabled=0)
INSERT INTO `liveEngineConfig` (
  `userId`, `tradingAccountId`, `isEnabled`, `allocatedPct`, `maxPositions`, `maxLongPositions`, `maxShortPositions`,
  `positionSizePct`, `accountId`, `totalNlv`, `minPositionUsd`, `maxPositionUsd`, `minOrderUsd`,
  `intradayMultiplier`, `overnightMultiplier`, `dailyLossLimitUsd`, `elzaV45LiveEnabled`
)
SELECT
  1, ta.id, 0, 100, 8, 8, 0,
  12.5, '', 20000, 4000, 5000, 4000,
  1.8, 1.2, 400, 0
FROM `tradingAccounts` ta
WHERE ta.slug = 'dror'
  AND NOT EXISTS (
    SELECT 1 FROM `liveEngineConfig` lec WHERE lec.`tradingAccountId` = ta.id
  );

CREATE UNIQUE INDEX `liveEngineConfig_tradingAccountId_idx` ON `liveEngineConfig` (`tradingAccountId`);

-- Backfill CEO positions to trading account
UPDATE `livePositions` lp
JOIN `tradingAccounts` ta ON ta.slug = 'ceo'
SET lp.`tradingAccountId` = ta.id
WHERE lp.`tradingAccountId` IS NULL;
