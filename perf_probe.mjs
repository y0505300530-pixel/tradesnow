/**
 * Performance Probe — tradesnow.vip
 * Measures execution time of key DB queries and API patterns.
 * Run: node perf_probe.mjs
 */
import { createConnection } from "mysql2/promise";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error("DATABASE_URL not set"); process.exit(1); }

function parseDbUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || 3306,
    user: u.username,
    password: u.password,
    database: u.pathname.slice(1).split("?")[0],
    ssl: { rejectUnauthorized: false }, // TiDB Cloud requires SSL
  };
}

async function time(label, fn) {
  const start = performance.now();
  const result = await fn();
  const ms = (performance.now() - start).toFixed(1);
  const rows = Array.isArray(result[0]) ? ` (${result[0].length} rows)` : "";
  const flag = parseFloat(ms) > 200 ? " ⚠️ SLOW" : parseFloat(ms) > 50 ? " 🔶" : "";
  console.log(`  [${ms.padStart(7)}ms] ${label}${rows}${flag}`);
  return result;
}

async function main() {
  const conn = await createConnection({ ...parseDbUrl(DB_URL), multipleStatements: true });
  console.log("\n=== PERFORMANCE PROBE — tradesnow.vip ===\n");

  // ── 1. Table row counts ──────────────────────────────────────────────────
  console.log("── 1. TABLE SIZES ──────────────────────────────────────────");
  const tables = [
    "paperPositions", "paperTrades", "paperEquitySnapshots",
    "priceAlerts", "userAssets", "breakoutScans",
    "portfolioHoldings", "holding2", "hourlySnapshots",
    "labExecutionLogs", "priceCache", "portfolioSnapshots",
    "paperLedger",
  ];
  for (const t of tables) {
    try {
      const [rows] = await conn.execute(`SELECT COUNT(*) as cnt FROM \`${t}\``);
      const cnt = rows[0].cnt;
      console.log(`  ${t.padEnd(28)} ${String(cnt).padStart(8)} rows`);
    } catch (e) {
      console.log(`  ${t.padEnd(28)} ERROR: ${e.message}`);
    }
  }

  // ── 2. Missing index check ───────────────────────────────────────────────
  console.log("\n── 2. INDEX COVERAGE ───────────────────────────────────────");
  const indexChecks = [
    ["paperPositions", ["sessionId"]],
    ["paperTrades", ["sessionId"]],
    ["paperEquitySnapshots", ["sessionId"]],
    ["priceAlerts", ["triggered"]],
    ["priceAlerts", ["dismissed"]],
    ["userAssets", ["archived"]],
  ];
  for (const [table, cols] of indexChecks) {
    const [rows] = await conn.execute(
      `SHOW INDEX FROM \`${table}\` WHERE Column_name IN (${cols.map(c => `'${c}'`).join(",")})`
    );
    const found = rows.map(r => `${r.Key_name}(${r.Column_name})`).join(", ");
    const status = found ? `✅ ${found}` : "❌ MISSING — full table scan!";
    console.log(`  ${table}.${cols.join(",")}:  ${status}`);
  }

  // ── 3. Key query timings ─────────────────────────────────────────────────
  console.log("\n── 3. QUERY TIMINGS ────────────────────────────────────────");

  await time("paperLedger: getOrInitLedger SELECT", () =>
    conn.execute("SELECT * FROM paperLedger WHERE userId = 1 LIMIT 1"));

  await time("paperPositions: open positions (userId+status idx)", () =>
    conn.execute("SELECT * FROM paperPositions WHERE userId = 1 AND status = 'open'"));

  await time("paperPositions: open positions + sessionId (no idx on sessionId)", () =>
    conn.execute("SELECT * FROM paperPositions WHERE userId = 1 AND status = 'open' AND sessionId = 22"));

  await time("paperTrades: all trades session 22 (userId idx only)", () =>
    conn.execute("SELECT * FROM paperTrades WHERE userId = 1 AND sessionId = 22"));

  await time("paperTrades: 30d yield window (closedAt idx)", () =>
    conn.execute("SELECT realizedPnl, closedAt FROM paperTrades WHERE userId = 1 AND sessionId = 22 AND closedAt >= DATE_SUB(NOW(), INTERVAL 30 DAY)"));

  // N+1 pattern in getSessionHistory (5 separate queries for 5 sessions)
  console.log("\n  --- getSessionHistory N+1 pattern (5 separate queries) ---");
  for (const sid of [22, 21, 20, 19, 18]) {
    await time(`  getSessionHistory: session ${sid} (separate query)`, () =>
      conn.execute(`SELECT realizedPnl FROM paperTrades WHERE userId = 1 AND sessionId = ${sid}`));
  }

  // PROPOSED FIX: single GROUP BY
  await time("\n  getSessionHistory: PROPOSED single GROUP BY (replaces 5 queries)", () =>
    conn.execute(`
      SELECT sessionId,
             COUNT(*) as totalTrades,
             SUM(CASE WHEN realizedPnl > 0 THEN 1 ELSE 0 END) as wins,
             SUM(realizedPnl) as totalRealizedPnl
      FROM paperTrades
      WHERE userId = 1
      GROUP BY sessionId
      ORDER BY sessionId DESC
      LIMIT 10
    `));

  await time("priceAlerts: active alerts scan (triggered+dismissed)", () =>
    conn.execute("SELECT id, ticker, alertType FROM priceAlerts WHERE triggered = 0 AND dismissed = 0"));

  await time("userAssets: non-archived catalogue tickers", () =>
    conn.execute("SELECT ticker FROM userAssets WHERE userId = 1 AND archived = 0"));

  await time("paperEquitySnapshots: hasSnapshot check", () =>
    conn.execute("SELECT id FROM paperEquitySnapshots WHERE userId = 1 AND sessionId = 22 AND snapshotTs >= 1747220400000 LIMIT 1"));

  await time("breakoutScans: recent scan check (userId+ticker idx)", () =>
    conn.execute("SELECT id FROM breakoutScans WHERE userId = 1 AND ticker = 'AAPL' AND scannedAt >= DATE_SUB(NOW(), INTERVAL 4 HOUR) LIMIT 1"));

  // ── 4. EXPLAIN plans ────────────────────────────────────────────────────
  console.log("\n── 4. EXPLAIN PLANS (key=NULL means full table scan) ───────");

  const explainQueries = [
    ["paperTrades WHERE userId=1 AND sessionId=22",
     "SELECT * FROM paperTrades WHERE userId = 1 AND sessionId = 22"],
    ["paperPositions WHERE userId=1 AND status='open' AND sessionId=22",
     "SELECT * FROM paperPositions WHERE userId = 1 AND status = 'open' AND sessionId = 22"],
    ["priceAlerts WHERE triggered=0 AND dismissed=0",
     "SELECT id FROM priceAlerts WHERE triggered = 0 AND dismissed = 0"],
    ["paperEquitySnapshots WHERE userId=1 AND sessionId=22 AND snapshotTs>=X",
     "SELECT id FROM paperEquitySnapshots WHERE userId = 1 AND sessionId = 22 AND snapshotTs >= 1747220400000 LIMIT 1"],
  ];
  for (const [label, q] of explainQueries) {
    const [rows] = await conn.execute(`EXPLAIN ${q}`);
    const r = rows[0];
    const warn = r.key === null ? " ⚠️ FULL TABLE SCAN" : "";
    console.log(`\n  EXPLAIN: ${label}`);
    console.log(`    type=${r.type} | key=${r.key ?? "NULL"} | rows_est=${r.rows} | Extra=${r.Extra ?? ""}${warn}`);
  }

  // ── 5. Duplicate index on paperEquitySnapshots ──────────────────────────
  console.log("\n── 5. REDUNDANT INDEXES ────────────────────────────────────");
  const [snapIdxRows] = await conn.execute("SHOW INDEX FROM paperEquitySnapshots");
  console.log("  paperEquitySnapshots indexes:");
  for (const r of snapIdxRows) {
    console.log(`    ${r.Key_name.padEnd(50)} col=${r.Column_name} seq=${r.Seq_in_index} unique=${r.Non_unique === 0}`);
  }

  // ── 6. Payload size estimate ─────────────────────────────────────────────
  console.log("\n── 6. PAYLOAD SIZE ESTIMATES ───────────────────────────────");
  const [tradeRows] = await conn.execute("SELECT * FROM paperTrades WHERE userId = 1 AND sessionId = 22 LIMIT 100");
  const tradeJson = JSON.stringify(tradeRows);
  console.log(`  getVirtualTrades (100 rows): ~${(tradeJson.length / 1024).toFixed(1)} KB`);
  const [posRows] = await conn.execute("SELECT * FROM paperPositions WHERE userId = 1 AND status = 'open'");
  const posJson = JSON.stringify(posRows);
  console.log(`  getVirtualPositions (open): ~${(posJson.length / 1024).toFixed(1)} KB (${posRows.length} positions)`);
  const [alertRows] = await conn.execute("SELECT * FROM priceAlerts WHERE triggered = 0 AND dismissed = 0");
  const alertJson = JSON.stringify(alertRows);
  console.log(`  priceAlerts (active): ~${(alertJson.length / 1024).toFixed(1)} KB (${alertRows.length} alerts)`);
  const [assetRows] = await conn.execute("SELECT * FROM userAssets WHERE userId = 1 AND archived = 0");
  const assetJson = JSON.stringify(assetRows);
  console.log(`  userAssets catalogue: ~${(assetJson.length / 1024).toFixed(1)} KB (${assetRows.length} tickers)`);

  await conn.end();
  console.log("\n=== PROBE COMPLETE ===\n");
}

main().catch(e => { console.error(e); process.exit(1); });
