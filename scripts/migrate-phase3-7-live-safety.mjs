#!/usr/bin/env node
/**
 * Phase 3–7 DB migration — run against YOUR database only:
 *   node scripts/migrate-phase3-7-live-safety.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const conn = await mysql.createConnection(url);

const statements = [
  `ALTER TABLE liveEngineConfig
     ADD COLUMN IF NOT EXISTS dailyLossEnabled TINYINT NOT NULL DEFAULT 1,
     ADD COLUMN IF NOT EXISTS dailyLossLimitUsd DOUBLE NOT NULL DEFAULT 2000`,
  `CREATE TABLE IF NOT EXISTS liveEntryLock (
     id INT AUTO_INCREMENT PRIMARY KEY,
     userId INT NOT NULL,
     ticker VARCHAR(16) NOT NULL,
     positionId INT NULL,
     createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     UNIQUE KEY liveEntryLock_userId_ticker_uniq (userId, ticker)
   )`,
  `ALTER TABLE livePositions
     ADD COLUMN IF NOT EXISTS slProtection VARCHAR(16) NOT NULL DEFAULT 'ibkr',
     ADD COLUMN IF NOT EXISTS requestedQty INT NULL,
     ADD COLUMN IF NOT EXISTS filledQty INT DEFAULT 0,
     ADD COLUMN IF NOT EXISTS remainingQty INT DEFAULT 0,
     ADD COLUMN IF NOT EXISTS ibkrAvgCost DOUBLE NULL,
     ADD COLUMN IF NOT EXISTS ibkrUnits INT NULL,
     ADD COLUMN IF NOT EXISTS corporateActionFrozen TINYINT DEFAULT 0`,
  `ALTER TABLE livePositions
     MODIFY COLUMN status ENUM('open','closed','pending_exit','pending_entry','zombie','frozen','pending_halt') NOT NULL DEFAULT 'open'`,
  // Fix legacy tinyint slProtection → varchar (code expects 'ibkr' | 'software')
  `ALTER TABLE livePositions
     MODIFY COLUMN slProtection VARCHAR(16) NOT NULL DEFAULT 'ibkr'`,
];

for (const sql of statements) {
  try {
    await conn.execute(sql);
    console.log("OK:", sql.split("\n")[0].slice(0, 80));
  } catch (e) {
    // TiDB/MySQL variants — try without IF NOT EXISTS for older servers
    const fallback = sql
      .replace(/ADD COLUMN IF NOT EXISTS/g, "ADD COLUMN")
      .replace(/CREATE TABLE IF NOT EXISTS/g, "CREATE TABLE");
    try {
      await conn.execute(fallback);
      console.log("OK (fallback):", fallback.split("\n")[0].slice(0, 80));
    } catch (e2) {
      if (String(e2.message).includes("Duplicate column") || String(e2.message).includes("already exists")) {
        console.log("SKIP (exists):", sql.split("\n")[0].slice(0, 60));
      } else {
        console.warn("WARN:", e2.message);
      }
    }
  }
}

await conn.end();
console.log("Migration complete.");
