#!/usr/bin/env node
/**
 * Remove duplicate breakoutScans rows — keeps latest per (userId, ticker, signalType).
 *
 *   node scripts/cleanup-breakout-dupes.mjs           # dry-run (default)
 *   node scripts/cleanup-breakout-dupes.mjs --apply   # delete duplicates
 */
import "dotenv/config";
import mysql from "mysql2/promise";

const APPLY = process.argv.includes("--apply");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const conn = await mysql.createConnection(url);

async function stats(label) {
  const [total] = await conn.execute("SELECT COUNT(*) AS n FROM breakoutScans");
  const [dupes] = await conn.execute(`
    SELECT COUNT(*) AS dupe_groups, COALESCE(SUM(cnt - 1), 0) AS rows_to_delete
    FROM (
      SELECT userId, ticker, signalType, COUNT(*) AS cnt
      FROM breakoutScans
      GROUP BY userId, ticker, signalType
      HAVING cnt > 1
    ) d
  `);
  console.log(`\n[${label}]`);
  console.log(`  Total rows:        ${total[0].n}`);
  console.log(`  Duplicate groups:  ${dupes[0].dupe_groups}`);
  console.log(`  Rows to delete:    ${dupes[0].rows_to_delete}`);
  console.log(`  Rows after cleanup: ${total[0].n - dupes[0].rows_to_delete}`);
}

await stats("BEFORE");

const [top] = await conn.execute(`
  SELECT ticker, signalType, COUNT(*) AS cnt
  FROM breakoutScans
  GROUP BY userId, ticker, signalType
  HAVING cnt > 1
  ORDER BY cnt DESC
  LIMIT 8
`);
if (top.length > 0) {
  console.log("\nTop duplicate groups:");
  console.table(top);
}

if (!APPLY) {
  console.log("\nDry-run only. Re-run with --apply to delete duplicates.");
  await conn.end();
  process.exit(0);
}

console.log("\nDeleting duplicates (keeping latest id per userId+ticker+signalType)...");

const [result] = await conn.execute(`
  DELETE bs FROM breakoutScans bs
  INNER JOIN (
    SELECT id FROM (
      SELECT bs2.id
      FROM breakoutScans bs2
      INNER JOIN (
        SELECT userId, ticker, signalType, MAX(id) AS keep_id
        FROM breakoutScans
        GROUP BY userId, ticker, signalType
      ) kept
        ON bs2.userId = kept.userId
       AND bs2.ticker = kept.ticker
       AND bs2.signalType = kept.signalType
      WHERE bs2.id <> kept.keep_id
    ) doomed
  ) del ON bs.id = del.id
`);

console.log(`Deleted ${result.affectedRows} rows.`);
await stats("AFTER");
await conn.end();
