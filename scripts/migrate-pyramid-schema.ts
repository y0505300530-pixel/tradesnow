/**
 * Pyramid Engine v1.0 — Data Layer (Rollout Steps 1 & 2)
 *
 * 1. ADD COLUMN × 7 on livePositions (idempotent)
 * 2. BACKFILL originalUnits = units WHERE originalUnits IS NULL
 *
 * Usage:
 *   npx tsx scripts/migrate-pyramid-schema.ts
 *
 * Future (executePyramid.ts — Tier A Naked Window Mandate):
 *   After parent bracket teardown, if re-arm fails within 1_500ms → IOC-sell added
 *   units immediately + CRITICAL Telegram alert. Do not leave add leg unprotected.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";

const ALTERS = [
  "ALTER TABLE livePositions ADD COLUMN originalUnits INT NULL",
  "ALTER TABLE livePositions ADD COLUMN pyramidDone TINYINT NOT NULL DEFAULT 0",
  "ALTER TABLE livePositions ADD COLUMN pyramidUnits INT NOT NULL DEFAULT 0",
  "ALTER TABLE livePositions ADD COLUMN pyramidEntryPrice DOUBLE NULL",
  "ALTER TABLE livePositions ADD COLUMN pyramidSl DOUBLE NULL",
  "ALTER TABLE livePositions ADD COLUMN pyramidAt TIMESTAMP NULL",
  "ALTER TABLE livePositions ADD COLUMN pyramidOrderId VARCHAR(64) NULL",
] as const;

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  console.log("── Pyramid schema migration (Step 1) ──");
  for (const sqlText of ALTERS) {
    try {
      await db.execute(sql.raw(sqlText));
      console.log("OK:", sqlText);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (msg.includes("Duplicate column") || msg.includes("already exists")) {
        console.log("SKIP (exists):", sqlText);
      } else {
        throw e;
      }
    }
  }

  console.log("\n── Backfill originalUnits (Step 2) ──");
  const backfillRes = await db.execute(sql`
    UPDATE livePositions
    SET originalUnits = units
    WHERE originalUnits IS NULL
  `);
  const affected =
    (backfillRes as { affectedRows?: number })?.[0]?.affectedRows
    ?? (backfillRes as { affectedRows?: number })?.affectedRows
    ?? "?";
  console.log(`BACKFILL rows updated: ${affected}`);

  const [verify] = await db.execute(sql`
    SELECT
      COUNT(*) AS totalRows,
      SUM(CASE WHEN originalUnits IS NULL THEN 1 ELSE 0 END) AS nullOriginalUnits,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS openRows,
      SUM(CASE WHEN status = 'open' AND originalUnits IS NOT NULL THEN 1 ELSE 0 END) AS openWithOriginalUnits
    FROM livePositions
  `);
  console.log("\n── Verification ──");
  console.table(verify);

  console.log("\n✅ Pyramid data-layer migration complete");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
