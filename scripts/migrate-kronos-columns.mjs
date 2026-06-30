/**
 * Add Kronos columns to userAssets (idempotent).
 * Usage: cd /root/tradesnow && npx tsx scripts/migrate-kronos-columns.mjs
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "../server/db.ts";

const ALTERS = [
  "ALTER TABLE userAssets ADD COLUMN kronosBias DOUBLE NULL",
  "ALTER TABLE userAssets ADD COLUMN kronosDirection VARCHAR(8) NULL",
  "ALTER TABLE userAssets ADD COLUMN kronosBandPct DOUBLE NULL",
  "ALTER TABLE userAssets ADD COLUMN kronosPredPct DOUBLE NULL",
  "ALTER TABLE userAssets ADD COLUMN kronosScannedAt TIMESTAMP NULL",
];

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  for (const sqlText of ALTERS) {
    try {
      await db.execute(sql.raw(sqlText));
      console.log("OK:", sqlText);
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (msg.includes("Duplicate column") || msg.includes("already exists")) {
        console.log("SKIP (exists):", sqlText);
      } else {
        throw e;
      }
    }
  }
  console.log("✅ Kronos columns migration complete");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
