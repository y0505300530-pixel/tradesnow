
SET @db := DATABASE();
DROP PROCEDURE IF EXISTS _addcol;
DELIMITER //
CREATE PROCEDURE _addcol(IN col VARCHAR(64), IN ddl VARCHAR(255))
BEGIN
  IF (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='livePositions' AND COLUMN_NAME=col)=0 THEN
    SET @s = CONCAT('ALTER TABLE `livePositions` ADD COLUMN ', ddl); PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END//
DELIMITER ;
CALL _addcol('rValue',      '`rValue` DOUBLE NULL');
CALL _addcol('isFreeRolled','`isFreeRolled` TINYINT NOT NULL DEFAULT 0');
CALL _addcol('peakPrice',   '`peakPrice` DOUBLE NULL');
CALL _addcol('atr14',       '`atr14` DOUBLE NULL');
DROP PROCEDURE IF EXISTS _addcol;
UPDATE liveEngineConfig SET deleverageCutoffTime='22:30' WHERE userId=1;
