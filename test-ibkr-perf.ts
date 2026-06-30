/**
 * test-ibkr-perf.ts
 * Server-side probe for IBKR portfolio performance history endpoints
 * Run: npx tsx test-ibkr-perf.ts
 */
import "dotenv/config";
import { ibindRequest } from "./server/routers/ibkrProxy";

const endpoints = [
  // IBKR Client Portal API performance endpoints
  { method: "GET", path: "/api/proxy/pa/performance" },
  { method: "GET", path: "/api/proxy/pa/summary" },
  { method: "GET", path: "/api/proxy/portfolio/performance" },
  { method: "GET", path: "/api/proxy/iserver/account/pnl/partitioned" },
  // Try with account ID
  { method: "GET", path: "/api/proxy/portfolio/accounts" },
];

async function main() {
  console.log("Probing IBKR performance history endpoints...\n");

  for (const ep of endpoints) {
    try {
      const r = await ibindRequest(ep.method, ep.path);
      console.log(`${ep.method} ${ep.path} → ${r.status}`);
      if (r.status === 200) {
        const body = JSON.stringify(r.body);
        console.log("  ✅ RESPONSE:", body.slice(0, 400));
        console.log();
      } else {
        console.log("  body:", JSON.stringify(r.body).slice(0, 200));
      }
    } catch (e: any) {
      console.log(`${ep.method} ${ep.path} → ERROR: ${e.message}`);
    }
  }

  // Get account ID first, then try account-specific endpoints
  console.log("\n--- Getting account ID ---");
  try {
    const accounts = await ibindRequest("GET", "/api/proxy/iserver/accounts");
    console.log("accounts:", JSON.stringify(accounts.body).slice(0, 300));

    const body = accounts.body as any;
    const accountId = body?.accounts?.[0] || body?.selectedAccount;
    if (accountId) {
      console.log(`\nAccount ID: ${accountId}`);
      // Try account-specific performance
      const perf = await ibindRequest("GET", `/api/proxy/pa/performance?acctIds=${accountId}&freq=D`);
      console.log(`pa/performance?acctIds=${accountId}&freq=D → ${perf.status}`);
      if (perf.status === 200) {
        console.log("  ✅ PERFORMANCE DATA:", JSON.stringify(perf.body).slice(0, 600));
      } else {
        console.log("  body:", JSON.stringify(perf.body).slice(0, 300));
      }

      // Try pnl partitioned
      const pnl = await ibindRequest("GET", `/api/proxy/iserver/account/${accountId}/pnl/partitioned`);
      console.log(`pnl/partitioned → ${pnl.status}:`, JSON.stringify(pnl.body).slice(0, 300));
    }
  } catch (e: any) {
    console.log("accounts error:", e.message);
  }
}

main().catch(console.error);
