/**
 * test-ibkr-perf3.ts
 * Try pa/performance with POST body and also prime iserver/accounts first
 */
import "dotenv/config";
import { ibindRequest } from "./server/routers/ibkrProxy";

const ACCOUNT_ID = "U16881054";

async function main() {
  // First prime the session
  console.log("Priming session...");
  const prime = await ibindRequest("GET", "/api/proxy/iserver/accounts");
  console.log("prime:", prime.status, JSON.stringify(prime.body).slice(0, 200));

  // Try POST to pa/performance
  console.log("\n--- POST pa/performance ---");
  const r1 = await ibindRequest("POST", "/api/proxy/pa/performance", {
    acctIds: [ACCOUNT_ID],
    freq: "D",
  });
  console.log(`POST pa/performance → ${r1.status}`);
  console.log("body:", JSON.stringify(r1.body).slice(0, 600));

  // Try POST pa/summary
  console.log("\n--- POST pa/summary ---");
  const r2 = await ibindRequest("POST", "/api/proxy/pa/summary", {
    acctIds: [ACCOUNT_ID],
  });
  console.log(`POST pa/summary → ${r2.status}`);
  console.log("body:", JSON.stringify(r2.body).slice(0, 600));

  // Try iserver/account/pnl/partitioned after prime
  console.log("\n--- iserver pnl/partitioned ---");
  const r3 = await ibindRequest("GET", "/api/proxy/iserver/account/pnl/partitioned");
  console.log(`pnl/partitioned → ${r3.status}`);
  console.log("body:", JSON.stringify(r3.body).slice(0, 600));

  // Try portfolio/positions/{accountId}
  console.log("\n--- portfolio positions ---");
  const r4 = await ibindRequest("GET", `/api/proxy/portfolio/${ACCOUNT_ID}/positions/0`);
  console.log(`portfolio positions → ${r4.status}`);
  console.log("body:", JSON.stringify(r4.body).slice(0, 400));

  // Try account ledger (has daily P&L)
  console.log("\n--- account ledger ---");
  const r5 = await ibindRequest("GET", `/api/proxy/account/U16881054/ledger`);
  console.log(`ledger → ${r5.status}`);
  console.log("body:", JSON.stringify(r5.body).slice(0, 400));

  // Try portfolio/tickers
  console.log("\n--- iserver/marketdata/history for SPY (test) ---");
  const r6 = await ibindRequest("GET", `/api/proxy/iserver/marketdata/history?conid=756733&period=3M&bar=1d`);
  console.log(`marketdata history → ${r6.status}`);
  console.log("body:", JSON.stringify(r6.body).slice(0, 400));
}

main().catch(console.error);
