/**
 * Replace uq_open_ticker (userId, ticker, status) with uq_active_ticker on a
 * generated column so only one active row per user+ticker is enforced; closed
 * rows no longer block closing pending_entry zombies.
 *
 * Usage:
 *   npx tsx scripts/migrate-uq-active-ticker.ts
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";

async function indexExists(db: Awaited<ReturnType<typeof getDb>>, name: string): Promise<boolean> {
  if (!db) return false;
  const [rows] = await db.execute(sql`
    SELECT COUNT(*) AS c
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'livePositions'
      AND index_name = ${name}
  `);
  const row = (rows as { c: number }[])[0];
  return Number(row?.c ?? 0) > 0;
}

async function columnExists(db: Awaited<ReturnType<typeof getDb>>, name: string): Promise<boolean> {
  if (!db) return false;
  const [rows] = await db.execute(sql`
    SELECT COUNT(*) AS c
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'livePositions'
      AND column_name = ${name}
  `);
  const row = (rows as { c: number }[])[0];
  return Number(row?.c ?? 0) > 0;
}

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  console.log("── migrate-uq-active-ticker ──");

  if (await indexExists(db, "uq_open_ticker")) {
    await db.execute(sql.raw("ALTER TABLE livePositions DROP INDEX uq_open_ticker"));
    console.log("OK: DROP INDEX uq_open_ticker");
  } else {
    console.log("SKIP: uq_open_ticker not present");
  }

  if (!(await columnExists(db, "_activeTickerKey"))) {
    await db.execute(sql.raw(`
      ALTER TABLE livePositions
      ADD COLUMN _activeTickerKey VARCHAR(64) AS (
        IF(status IN ('open','pending_entry','pending_exit','zombie','frozen','pending_halt'),
           CONCAT(userId,'-',ticker),
           NULL)
      ) STORED
    `));
    console.log("OK: ADD COLUMN _activeTickerKey");
  } else {
    console.log("SKIP: _activeTickerKey already exists");
  }

  if (!(await indexExists(db, "uq_active_ticker"))) {
    await db.execute(sql.raw("ALTER TABLE livePositions ADD UNIQUE INDEX uq_active_ticker (_activeTickerKey)"));
    console.log("OK: ADD UNIQUE INDEX uq_active_ticker");
  } else {
    console.log("SKIP: uq_active_ticker already exists");
  }

  const [verify] = await db.execute(sql`
    SELECT index_name, column_name, non_unique
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'livePositions'
      AND index_name IN ('uq_open_ticker', 'uq_active_ticker')
    ORDER BY index_name, seq_in_index
  `);
  console.log("\n── Verification ──");
  console.table(verify);

  console.log("\n✅ migrate-uq-active-ticker complete");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
