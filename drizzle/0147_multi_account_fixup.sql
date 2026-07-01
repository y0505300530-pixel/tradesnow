-- Idempotent fix if 0146 partially applied (Dror INSERT failed on userId unique).
ALTER TABLE `liveEngineConfig` DROP INDEX `liveEngineConfig_userId_unique`;

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
