/**
 * insert-3m-history.mjs
 *
 * Inserts 3-month historical equity snapshots (Jan 27 – Apr 27, 2026)
 * based on the IBKR app chart shape.
 *
 * Key anchors from IBKR app:
 *   Jan 27: $98,000 (start of 3M period)
 *   ~Feb 3:  $105,000 (small peak at start)
 *   ~Feb 10: $88,000 (first dip)
 *   ~Feb 17: $83,000 (continued decline)
 *   ~Feb 24: $80,000 (bottom zone)
 *   ~Mar 3:  $78,000 (absolute low ~$65K visible but that's likely intraday)
 *   ~Mar 10: $82,000 (recovery begins)
 *   ~Mar 17: $90,000
 *   ~Mar 24: $105,000 (strong rally)
 *   ~Mar 31: $115,000 (peak ~$115K)
 *   ~Apr 7:  $108,000 (pullback)
 *   ~Apr 14: $88,000 (sharp drop)
 *   ~Apr 21: $95,000 (recovery)
 *   Apr 22:  $110,000 (seed — already in DB, skip)
 *   Apr 23:  $99,000  (already in DB, skip)
 *   Apr 24:  $103,000 (already in DB, skip)
 *   Apr 26:  $110,569 (already in DB, skip)
 *   Apr 27:  $110,569.30 (already in DB, skip)
 *
 * We interpolate daily values between these anchors for trading days only.
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
const SEED = 110000;

// Anchor points: [date, value]
const anchors = [
  ["2026-01-27", 98000],
  ["2026-02-03", 105000],
  ["2026-02-10", 88000],
  ["2026-02-17", 83000],
  ["2026-02-24", 80000],
  ["2026-03-03", 76000],  // low zone
  ["2026-03-10", 82000],
  ["2026-03-17", 90000],
  ["2026-03-24", 105000],
  ["2026-03-31", 115000], // peak
  ["2026-04-07", 108000],
  ["2026-04-14", 88000],  // sharp drop
  ["2026-04-21", 95000],
  // Apr 22-27 already in DB — stop here
];

// Generate all trading days between two dates (Mon-Fri, skip weekends)
function tradingDaysBetween(startStr, endStr) {
  const days = [];
  const start = new Date(startStr + "T12:00:00Z");
  const end = new Date(endStr + "T12:00:00Z");
  const cur = new Date(start);
  while (cur <= end) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) { // not Sunday, not Saturday
      days.push(cur.toISOString().slice(0, 10));
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

// Linear interpolation between anchors
function interpolate(anchors) {
  const result = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const [d1, v1] = anchors[i];
    const [d2, v2] = anchors[i + 1];
    const days = tradingDaysBetween(d1, d2);
    const n = days.length - 1;
    for (let j = 0; j < days.length; j++) {
      const t = n > 0 ? j / n : 0;
      const value = Math.round(v1 + (v2 - v1) * t);
      result.push([days[j], value]);
    }
  }
  // Remove duplicates (last day of segment = first day of next)
  const seen = new Set();
  return result.filter(([d]) => {
    if (seen.has(d)) return false;
    seen.add(d);
    return true;
  });
}

const dataPoints = interpolate(anchors);

// Dates already in DB — skip
const skipDates = new Set(["2026-04-22", "2026-04-23", "2026-04-24", "2026-04-25", "2026-04-26", "2026-04-27"]);

console.log(`Generated ${dataPoints.length} data points`);
console.log("First:", dataPoints[0]);
console.log("Last:", dataPoints[dataPoints.length - 1]);

let inserted = 0, skipped = 0;
for (const [date, totalEquity] of dataPoints) {
  if (skipDates.has(date)) { skipped++; continue; }
  const pnlUsd = totalEquity - SEED;
  const pnlPct = (pnlUsd / SEED) * 100;
  await conn.execute(
    `INSERT INTO portfolioSnapshots
      (userId, snapshotDate, totalValue, investedValue, cashBalance, totalCost, pnlUsd, pnlPct, totalEquity, unrealizedPnL, h2Value, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       totalEquity = VALUES(totalEquity),
       totalValue = VALUES(totalValue),
       pnlUsd = VALUES(pnlUsd),
       pnlPct = VALUES(pnlPct)`,
    [OWNER_USER_ID, date, totalEquity, totalEquity, 0, SEED, pnlUsd, pnlPct, totalEquity, null, null]
  );
  inserted++;
}

console.log(`\n✅ Inserted/updated: ${inserted} rows, skipped: ${skipped}`);

// Verify
const [rows] = await conn.execute(
  "SELECT snapshotDate, totalEquity FROM portfolioSnapshots WHERE userId=1 ORDER BY snapshotDate"
);
console.log(`\nTotal snapshots in DB: ${rows.length}`);
console.log("Range:", rows[0]?.snapshotDate, "→", rows[rows.length - 1]?.snapshotDate);

await conn.end();
