/** One-off: BE exitReason breakdown. Run: npx tsx scripts/query-be-breakdown.ts */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";

async function main() {
  const db = await getDb();
  if (!db) {
    console.error("DB unavailable");
    process.exit(1);
  }

  const [rows] = await db.execute(sql`
    SELECT exitReason, count(*) as count, avg(realizedPnl) as avgPnl
    FROM livePositions
    WHERE (realizedPnl = 0 OR realizedPnl IS NULL)
      AND status = 'closed'
    GROUP BY exitReason
    ORDER BY count DESC
  `);

  console.log("=== BE by exitReason ===");
  console.table(rows);

  const [tot] = await db.execute(sql`
    SELECT count(*) as totalBE,
      sum(CASE WHEN realizedPnl IS NULL THEN 1 ELSE 0 END) as nullPnl,
      sum(CASE WHEN realizedPnl = 0 THEN 1 ELSE 0 END) as zeroPnl,
      sum(COALESCE(partialRealizedPnl, 0)) as totalPartialOnBE
    FROM livePositions
    WHERE (realizedPnl = 0 OR realizedPnl IS NULL) AND status = 'closed'
  `);

  console.log("\n=== BE totals ===");
  console.table(tot);

  const [partial] = await db.execute(sql`
    SELECT count(*) as beWithPartialProfit,
      sum(COALESCE(partialRealizedPnl, 0)) as sumPartialHidden
    FROM livePositions
    WHERE (realizedPnl = 0 OR realizedPnl IS NULL)
      AND status = 'closed'
      AND COALESCE(partialRealizedPnl, 0) > 0
  `);

  console.log("\n=== BE rows with partialRealizedPnl > 0 ===");
  console.table(partial);

  const [month] = await db.execute(sql`
    SELECT exitReason, count(*) as count
    FROM livePositions
    WHERE (realizedPnl = 0 OR realizedPnl IS NULL)
      AND status = 'closed'
      AND closedAt >= DATE_FORMAT(NOW(), '%Y-%m-01')
    GROUP BY exitReason
    ORDER BY count DESC
  `);

  console.log("\n=== BE this month only ===");
  console.table(month);

  const [sample] = await db.execute(sql`
    SELECT ticker, exitReason, realizedPnl, entryPrice, exitPrice, units,
           DATE_FORMAT(openedAt, '%Y-%m-%d') as opened,
           DATE_FORMAT(closedAt, '%Y-%m-%d') as closed
    FROM livePositions
    WHERE (realizedPnl = 0 OR realizedPnl IS NULL) AND status = 'closed'
    ORDER BY closedAt DESC
    LIMIT 15
  `);

  console.log("\n=== Sample BE rows ===");
  console.table(sample);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
