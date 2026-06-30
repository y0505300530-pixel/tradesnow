/**
 * One-Time Alert Restoration Script
 * ===================================
 * Run once to re-populate all priceAlerts for:
 *   - H1 holdings (portfolioHoldings) → SL + TP via Ziv Engine
 *   - H2 holdings (holding2)          → SL + TP via Ziv Engine
 *   - Asset Catalogue (userAssets)    → Catalogue Entry Alert at current price
 *
 * Usage:
 *   node server/scripts/restoreAlerts.mjs
 *
 * Requires DATABASE_URL in environment (auto-injected in dev/prod).
 */

import { createConnection } from "mysql2/promise";
// Node 22 has native fetch built-in
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("❌ DATABASE_URL not set");
  process.exit(1);
}

// ── Parse DATABASE_URL ─────────────────────────────────────────────────────
function parseDbUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: parseInt(u.port || "3306"),
    user: u.username,
    password: u.password,
    database: u.pathname.replace(/^\//, ""),
    ssl: { rejectUnauthorized: false }, // TiDB Cloud requires SSL
  };
}

// ── Fetch Yahoo Finance bars ───────────────────────────────────────────────
async function fetchBars(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=6mo`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return [];
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return [];
    const timestamps = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const bars = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] != null) bars.push({ close: closes[i] });
    }
    return bars;
  } catch {
    return [];
  }
}

// ── Fetch live price from Yahoo ────────────────────────────────────────────
async function fetchLivePrice(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    const price = result?.meta?.regularMarketPrice ?? null;
    return price;
  } catch {
    return null;
  }
}

// ── EMA calculation ────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// ── SL/TP formula (mirrors slCalculator.ts) ───────────────────────────────
function calcSlTp(buyPrice, ema50) {
  const SL_PCT = 0.08;
  const RR = 2.5;
  const slByPct = buyPrice * (1 - SL_PCT);
  const slByEma = ema50 != null && ema50 < buyPrice ? ema50 : slByPct;
  let stopLoss = Math.max(slByPct, slByEma);
  if (stopLoss >= buyPrice) stopLoss = slByPct;
  const takeProfit = buyPrice + RR * (buyPrice - stopLoss);
  const slSource = ema50 != null && ema50 < buyPrice && ema50 > slByPct ? "EMA-50" : "8% floor";
  return { stopLoss, takeProfit, slSource };
}

// ── Upsert alert in DB ─────────────────────────────────────────────────────
async function upsertAlert(conn, userId, ticker, alertType, targetPrice, direction, label) {
  const upper = ticker.toUpperCase();
  const [existing] = await conn.execute(
    "SELECT id FROM priceAlerts WHERE userId=? AND ticker=? AND alertType=? AND dismissed=0 LIMIT 1",
    [userId, upper, alertType]
  );
  if (existing.length > 0) {
    await conn.execute(
      "UPDATE priceAlerts SET targetPrice=?, direction=?, label=?, triggered=0, triggeredAt=NULL, triggeredPrice=NULL WHERE id=?",
      [targetPrice, direction, label, existing[0].id]
    );
    return "updated";
  } else {
    await conn.execute(
      "INSERT INTO priceAlerts (userId, ticker, alertType, targetPrice, direction, label) VALUES (?,?,?,?,?,?)",
      [userId, upper, alertType, targetPrice, direction, label]
    );
    return "created";
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const conn = await createConnection({ ...parseDbUrl(DB_URL), multipleStatements: false });
  console.log("✅ Connected to DB");

  // Get all users
  const [users] = await conn.execute("SELECT id, openId FROM users LIMIT 50");
  console.log(`👥 Found ${users.length} user(s)`);

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalErrors = 0;

  for (const user of users) {
    const userId = user.id;
    console.log(`\n── User ${userId} ──────────────────────────────`);

    // ── H1 Holdings ──────────────────────────────────────────────────────
    const [h1] = await conn.execute(
      "SELECT ticker, buyPrice FROM portfolioHoldings WHERE userId=? AND units != 0",
      [userId]
    );
    console.log(`  H1: ${h1.length} active holdings`);

    for (const h of h1) {
      try {
        const bars = await fetchBars(h.ticker);
        const closes = bars.map(b => b.close);
        const ema50 = calcEMA(closes, 50);
        const { stopLoss, takeProfit, slSource } = calcSlTp(Number(h.buyPrice), ema50);

        const r1 = await upsertAlert(conn, userId, h.ticker, "sl", stopLoss, "below", "Stop Loss");
        const r2 = await upsertAlert(conn, userId, h.ticker, "tp", takeProfit, "above", "Take Profit");
        if (r1 === "created" || r2 === "created") totalCreated++;
        else totalUpdated++;
        console.log(`    ✅ H1 ${h.ticker}: SL=$${stopLoss.toFixed(2)} TP=$${takeProfit.toFixed(2)} [${slSource}] (SL:${r1}, TP:${r2})`);
      } catch (err) {
        console.error(`    ❌ H1 ${h.ticker}: ${err.message}`);
        totalErrors++;
      }
      await new Promise(r => setTimeout(r, 300)); // rate-limit
    }

    // ── H2 Holdings ──────────────────────────────────────────────────────
    const [h2] = await conn.execute(
      "SELECT ticker, buyPrice FROM holding2 WHERE userId=? AND units != 0",
      [userId]
    );
    console.log(`  H2: ${h2.length} active holdings`);

    for (const h of h2) {
      try {
        const bars = await fetchBars(h.ticker);
        const closes = bars.map(b => b.close);
        const ema50 = calcEMA(closes, 50);
        const { stopLoss, takeProfit, slSource } = calcSlTp(Number(h.buyPrice), ema50);

        const r1 = await upsertAlert(conn, userId, h.ticker, "sl", stopLoss, "below", "Stop Loss");
        const r2 = await upsertAlert(conn, userId, h.ticker, "tp", takeProfit, "above", "Take Profit");
        if (r1 === "created" || r2 === "created") totalCreated++;
        else totalUpdated++;
        console.log(`    ✅ H2 ${h.ticker}: SL=$${stopLoss.toFixed(2)} TP=$${takeProfit.toFixed(2)} [${slSource}] (SL:${r1}, TP:${r2})`);
      } catch (err) {
        console.error(`    ❌ H2 ${h.ticker}: ${err.message}`);
        totalErrors++;
      }
      await new Promise(r => setTimeout(r, 300));
    }

    // ── Asset Catalogue ───────────────────────────────────────────────────
    const [catalogue] = await conn.execute(
      "SELECT ticker, cmp FROM userAssets WHERE userId=? AND (archived IS NULL OR archived=0) LIMIT 100",
      [userId]
    );
    console.log(`  Catalogue: ${catalogue.length} assets`);

    for (const a of catalogue) {
      try {
        // Use cmp (current market price) from DB if available, else fetch live
        let price = a.cmp ? Number(a.cmp) : null;
        if (!price || price <= 0) {
          price = await fetchLivePrice(a.ticker);
        }
        if (!price || price <= 0) { console.log(`    ⏭ ${a.ticker}: no price`); continue; }
        const r = await upsertAlert(conn, userId, a.ticker, "custom", price, "below", "Catalogue Entry Alert");
        if (r === "created") totalCreated++;
        else totalUpdated++;
        console.log(`    ✅ Catalogue ${a.ticker}: entry alert @ $${price.toFixed(2)} (${r})`);
      } catch (err) {
        console.error(`    ❌ Catalogue ${a.ticker}: ${err.message}`);
        totalErrors++;
      }
      await new Promise(r => setTimeout(r, 100));
    }
  }

  await conn.end();
  console.log(`\n════════════════════════════════════════`);
  console.log(`✅ Done — Created: ${totalCreated}, Updated: ${totalUpdated}, Errors: ${totalErrors}`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
