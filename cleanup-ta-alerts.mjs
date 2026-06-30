/**
 * One-time cleanup: delete ALL price alerts for .TA tickers where targetPrice > 500
 * (these were created with agorot values instead of USD — all statuses)
 */
import { createConnection } from "mysql2/promise";

const db = await createConnection(process.env.DATABASE_URL);

// Count before
const [[{ total }]] = await db.execute(
  `SELECT COUNT(*) as total FROM priceAlerts WHERE ticker LIKE '%.TA' AND targetPrice > 500`
);
console.log(`\nFound ${total} .TA alerts with target > $500 (all statuses)`);

// Delete ALL .TA alerts with absurd target prices (> $500 = clearly in agorot)
const [result] = await db.execute(
  `DELETE FROM priceAlerts WHERE ticker LIKE '%.TA' AND targetPrice > 500`
);
console.log(`✅ Deleted ${result.affectedRows} stale .TA alert(s) with target > $500`);

// Show what remains
const [remaining] = await db.execute(
  `SELECT id, ticker, targetPrice, label, triggered, dismissed FROM priceAlerts WHERE ticker LIKE '%.TA' ORDER BY ticker`
);
console.log(`\n=== Remaining .TA alerts (${remaining.length}) ===`);
for (const row of remaining) {
  const status = row.triggered ? "TRIGGERED" : row.dismissed ? "DISMISSED" : "ACTIVE";
  console.log(`  [${status}] ${row.ticker} | target=$${Number(row.targetPrice).toFixed(2)} | ${row.label}`);
}

await db.end();
