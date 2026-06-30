/**
 * Add catalogStatus + kineticScore; set SPCX/CYBR edge-case statuses.
 * Usage: npx tsx scripts/migrate-catalog-status.mjs
 */
import "dotenv/config";
import { sql, eq, and } from "drizzle-orm";
import { getDb } from "../server/db.ts";
import { userAssets } from "../drizzle/schema.ts";

const ALTERS = [
  "ALTER TABLE userAssets ADD COLUMN catalogStatus VARCHAR(32) NULL",
  "ALTER TABLE userAssets ADD COLUMN kineticScore DOUBLE NULL",
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

  const USER_ID = 1;
  await db.update(userAssets)
    .set({ catalogStatus: "IPO_INCUBATOR", kineticScore: null })
    .where(and(eq(userAssets.userId, USER_ID), eq(userAssets.ticker, "SPCX")));
  console.log("SPCX → IPO_INCUBATOR, kineticScore=null");

  await db.update(userAssets)
    .set({ catalogStatus: "DATA_BLIP_BYPASS", kineticScore: null })
    .where(and(eq(userAssets.userId, USER_ID), eq(userAssets.ticker, "CYBR")));
  console.log("CYBR → DATA_BLIP_BYPASS, kineticScore=null");

  console.log("✅ catalogStatus migration complete");
}

main().catch(e => { console.error(e); process.exit(1); });
