/**
 * test-ibkr-history.mjs
 * Probes IBKR Client Portal API endpoints for portfolio performance history
 */
import "dotenv/config";
import crypto from "crypto";
import https from "https";

const IBIND_BASE = process.env.IBIND_API_SECRET ? null : null;
// We'll call our own running server instead
const SERVER_BASE = "http://localhost:3000";

async function get(path) {
  const res = await fetch(`${SERVER_BASE}${path}`, {
    headers: { "Accept": "application/json" }
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

// Try IBKR portfolio performance endpoints via our proxy
const endpoints = [
  "/api/ibind/proxy/pa/performance",
  "/api/ibind/proxy/portfolio/performance",
  "/api/ibind/proxy/iserver/account/pnl/partitioned",
  "/api/ibind/proxy/portfolio/accounts",
  "/api/ibind/proxy/pa/summary",
];

console.log("Testing IBKR history endpoints...\n");
for (const ep of endpoints) {
  try {
    const r = await get(ep);
    console.log(`${ep} → ${r.status}`);
    if (r.status === 200) {
      console.log("  RESPONSE:", JSON.stringify(r.body).slice(0, 300));
    }
  } catch (e) {
    console.log(`${ep} → ERROR: ${e.message}`);
  }
}

// Also try the account summary to confirm session is active
console.log("\n--- Account Summary ---");
const summary = await get("/api/ibind/account-summary");
console.log("account-summary status:", summary.status);
if (summary.status === 200) {
  console.log("NLV:", summary.body?.summary?.netLiquidation);
}
