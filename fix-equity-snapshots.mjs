/**
 * fix-equity-snapshots.mjs
 *
 * Fixes the portfolioSnapshots table:
 * 1. Deletes bad snapshots (Apr 22-27 with doubled h2Value)
 * 2. Inserts correct historical data points:
 *    - Apr 22 = $110,000 (seed)
 *    - Apr 23 = $99,000
 *    - Apr 24 = $103,000
 *    - Apr 26 = $110,569
 * 3. Apr 27 (today) will be set by clicking "עדכן גרף" in the UI with real IBKR NLV
 *
 * Run: node fix-equity-snapshots.mjs
 */

import "dotenv/config";
import mysql from "mysql2/promise";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

// Parse DATABASE_URL (mysql://user:pass@host:port/db)
const url = new URL(DATABASE_URL);
const connection = await mysql.createConnection({
  host: url.hostname,
  port: parseInt(url.port || "3306"),
  user: url.username,
  password: url.password,
  database: url.pathname.slice(1),
  ssl: { rejectUnauthorized: false },
});

console.log("Connected to DB");

// ── Step 1: Show current snapshots ───────────────────────────────────────────
const [existing] = await connection.execute(
  "SELECT id, userId, snapshotDate, totalEquity, h2Value, totalValue FROM portfolioSnapshots ORDER BY snapshotDate"
);
console.log("\nExisting snapshots:");
console.table(existing);

// ── Step 2: Determine owner userId ───────────────────────────────────────────
const [users] = await connection.execute(
  "SELECT id, openId, name FROM users ORDER BY id LIMIT 5"
);
console.log("\nUsers:");
console.table(users);

// Use userId=1 (owner) — adjust if needed
const OWNER_USER_ID = 1;

// ── Step 3: Delete existing snapshots for Apr 22-27 ──────────────────────────
const datesToDelete = ["2026-04-22", "2026-04-23", "2026-04-24", "2026-04-25", "2026-04-26", "2026-04-27"];
for (const date of datesToDelete) {
  const [result] = await connection.execute(
    "DELETE FROM portfolioSnapshots WHERE userId = ? AND snapshotDate = ?",
    [OWNER_USER_ID, date]
  );
  console.log(`Deleted ${result.affectedRows} row(s) for ${date}`);
}

// ── Step 4: Insert correct historical snapshots ───────────────────────────────
// Format: [snapshotDate, totalEquity (H1 NLV), h2Value, totalValue]
// totalValue = totalEquity + h2Value (for chart: h1 + h2)
const snapshots = [
  { date: "2026-04-22", totalEquity: 110000, h2Value: 0 },   // seed day
  { date: "2026-04-23", totalEquity: 99000,  h2Value: 0 },   // user-provided
  { date: "2026-04-24", totalEquity: 103000, h2Value: 0 },   // user-provided
  // Apr 25 — skipped (no data provided, will appear as gap)
  { date: "2026-04-26", totalEquity: 110569, h2Value: 0 },   // user-provided
];

for (const s of snapshots) {
  const totalValue = s.totalEquity + s.h2Value;
  await connection.execute(
    `INSERT INTO portfolioSnapshots
      (userId, snapshotDate, totalValue, investedValue, cashBalance, totalCost, pnlUsd, pnlPct, totalEquity, unrealizedPnL, h2Value, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       totalEquity = VALUES(totalEquity),
       h2Value = VALUES(h2Value),
       totalValue = VALUES(totalValue),
       investedValue = VALUES(investedValue)`,
    [
      OWNER_USER_ID,
      s.date,
      totalValue,
      totalValue,   // investedValue
      0,            // cashBalance
      110000,       // totalCost (seed)
      totalValue - 110000,  // pnlUsd
      ((totalValue - 110000) / 110000) * 100,  // pnlPct
      s.totalEquity,
      null,         // unrealizedPnL
      s.h2Value || null,
    ]
  );
  console.log(`Inserted snapshot: ${s.date} → totalEquity=$${s.totalEquity.toLocaleString()}, h2Value=$${s.h2Value}`);
}

// ── Step 5: Verify ────────────────────────────────────────────────────────────
const [final] = await connection.execute(
  "SELECT id, userId, snapshotDate, totalEquity, h2Value, totalValue, pnlPct FROM portfolioSnapshots ORDER BY snapshotDate"
);
console.log("\nFinal snapshots:");
console.table(final);

await connection.end();
console.log("\nDone! ✅");
console.log("Now click 'עדכן גרף' in Trade Manager to add today's (Apr 27) real IBKR NLV.");
