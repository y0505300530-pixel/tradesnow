/**
 * fix-3m-history.mjs
 *
 * Corrected 3-month historical equity snapshots (Jan 27 – Apr 27, 2026)
 * Carefully re-read from IBKR chart:
 *   Y-axis: 60K (bottom) → 120K (top)
 *   Chart shape analysis:
 *   Jan 27:  $98,000  (start, ~80% up the chart)
 *   Feb 3:   $100,000 (small bump)
 *   Feb 10:  $88,000  (first dip)
 *   Feb 17:  $83,000  (continued decline)
 *   Feb 24:  $80,000  (low zone)
 *   Mar 3:   $70,000  (absolute low — ~17% from bottom of 60K scale)
 *   Mar 10:  $78,000  (recovery)
 *   Mar 17:  $87,000
 *   Mar 24:  $95,000  (strong rally)
 *   Mar 31:  $103,000 (near peak — NOT 115K, chart shows ~$103K)
 *   Apr 7:   $100,000 (small pullback)
 *   Apr 14:  $76,000  (sharp drop — ~27% from bottom)
 *   Apr 21:  $95,000  (recovery)
 *   Apr 22:  $110,000 (already in DB — skip)
 *   Apr 23:  $99,000  (already in DB — skip)
 *   Apr 24:  $103,000 (already in DB — skip)
 *   Apr 26:  $110,569 (already in DB — skip)
 *   Apr 27:  $110,569 (already in DB — skip)
 *
 * NOTE: The IBKR chart Y-axis goes 60K→120K. The line never exceeds ~$108K
 * before Apr 27. Peak visible is ~$103-105K around Mar 31.
 */

import "dotenv/config";
import mysql from "mysql2/promise";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("DATABASE_URL not set"); process.exit(1); }

const url = new URL(DATABASE_URL);
const conn = await mysql.createConnection({
  host: url.hostname, port: parseInt(url.port || "3306"),
  user: url.username, password: url.password,
  database: url.pathname.slice(1), ssl: { rejectUnauthorized: false },
});

const OWNER_USER_ID = 1;
const SEED = 98000; // Jan 27 starting value

// Corrected anchor points based on careful chart reading
const anchors = [
  ["2026-01-27", 98000],
  ["2026-02-03", 100000],
  ["2026-02-10", 88000],
  ["2026-02-17", 83000],
  ["2026-02-24", 80000],
  ["2026-03-03", 70000],   // absolute low
  ["2026-03-10", 78000],
  ["2026-03-17", 87000],
  ["2026-03-24", 95000],
  ["2026-03-31", 103000],  // peak — NOT 115K
  ["2026-04-07", 100000],
  ["2026-04-14", 76000],   // sharp drop
  ["2026-04-21", 95000],
  // Apr 22-27 already in DB
];

function tradingDaysBetween(startStr, endStr) {
  const days = [];
  const cur = new Date(startStr + "T12:00:00Z");
  const end = new Date(endStr + "T12:00:00Z");
  while (cur <= end) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

function interpolate(anchors) {
  const result = [];
  const seen = new Set();
  for (let i = 0; i < anchors.length - 1; i++) {
    const [d1, v1] = anchors[i];
    const [d2, v2] = anchors[i + 1];
    const days = tradingDaysBetween(d1, d2);
    const n = days.length - 1;
    for (let j = 0; j < days.length; j++) {
      if (seen.has(days[j])) continue;
      seen.add(days[j]);
      const t = n > 0 ? j / n : 0;
      result.push([days[j], Math.round(v1 + (v2 - v1) * t)]);
    }
  }
  return result;
}

const dataPoints = interpolate(anchors);
const skipDates = new Set(["2026-04-22", "2026-04-23", "2026-04-24", "2026-04-25", "2026-04-26", "2026-04-27"]);

console.log(`Generated ${dataPoints.length} data points`);
console.log("First:", dataPoints[0], "Last:", dataPoints[dataPoints.length - 1]);
console.log("Min:", Math.min(...dataPoints.map(d => d[1])), "Max:", Math.max(...dataPoints.map(d => d[1])));

// First delete old incorrect rows (Jan 27 – Apr 21)
await conn.execute(
  `DELETE FROM portfolioSnapshots WHERE userId=? AND snapshotDate >= '2026-01-27' AND snapshotDate <= '2026-04-21'`,
  [OWNER_USER_ID]
);
console.log("Deleted old rows Jan 27 – Apr 21");

let inserted = 0;
for (const [date, totalEquity] of dataPoints) {
  if (skipDates.has(date)) continue;
  const pnlUsd = totalEquity - SEED;
  const pnlPct = (pnlUsd / SEED) * 100;
  await conn.execute(
    `INSERT INTO portfolioSnapshots
      (userId, snapshotDate, totalValue, investedValue, cashBalance, totalCost, pnlUsd, pnlPct, totalEquity, unrealizedPnL, h2Value, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [OWNER_USER_ID, date, totalEquity, totalEquity, 0, SEED, pnlUsd, pnlPct, totalEquity, null, null]
  );
  inserted++;
}

console.log(`✅ Inserted: ${inserted} rows`);

const [rows] = await conn.execute(
  "SELECT snapshotDate, totalEquity FROM portfolioSnapshots WHERE userId=1 ORDER BY snapshotDate"
);
console.log(`Total in DB: ${rows.length}`);
console.log("Range:", rows[0]?.snapshotDate, "→", rows[rows.length - 1]?.snapshotDate);
const values = rows.map(r => Number(r.totalEquity));
console.log("Min:", Math.min(...values), "Max:", Math.max(...values));

await conn.end();
