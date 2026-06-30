/**
 * test-ibkr-perf2.ts
 * Probe IBKR pa/performance with account ID U16881054
 */
import "dotenv/config";
import { ibindRequest } from "./server/routers/ibkrProxy";

const ACCOUNT_ID = "U16881054";

async function main() {
  console.log(`Testing pa/performance for account ${ACCOUNT_ID}\n`);

  // Try different freq values: D=daily, W=weekly, M=monthly
  const freqs = ["D", "W", "M"];
  for (const freq of freqs) {
    const r = await ibindRequest("GET", `/api/proxy/pa/performance?acctIds=${ACCOUNT_ID}&freq=${freq}`);
    console.log(`pa/performance?freq=${freq} → ${r.status}`);
    if (r.status === 200) {
      console.log("  ✅ DATA:", JSON.stringify(r.body).slice(0, 800));
    } else {
      console.log("  body:", JSON.stringify(r.body).slice(0, 300));
    }
    console.log();
  }

  // Also try pa/summary
  const summary = await ibindRequest("GET", `/api/proxy/pa/summary?acctIds=${ACCOUNT_ID}`);
  console.log(`pa/summary → ${summary.status}`);
  if (summary.status === 200) {
    console.log("  ✅ SUMMARY:", JSON.stringify(summary.body).slice(0, 600));
  } else {
    console.log("  body:", JSON.stringify(summary.body).slice(0, 300));
  }

  // Try portfolio/{accountId}/performance
  const portfolioPerf = await ibindRequest("GET", `/api/proxy/portfolio/${ACCOUNT_ID}/performance`);
  console.log(`\nportfolio/${ACCOUNT_ID}/performance → ${portfolioPerf.status}`);
  if (portfolioPerf.status === 200) {
    console.log("  ✅ DATA:", JSON.stringify(portfolioPerf.body).slice(0, 600));
  } else {
    console.log("  body:", JSON.stringify(portfolioPerf.body).slice(0, 300));
  }

  // Try iserver/account/pnl/partitioned with session prime first
  const pnl = await ibindRequest("GET", `/api/proxy/iserver/account/pnl/partitioned`);
  console.log(`\niserver/account/pnl/partitioned → ${pnl.status}`);
  if (pnl.status === 200) {
    console.log("  ✅ PNL:", JSON.stringify(pnl.body).slice(0, 600));
  } else {
    console.log("  body:", JSON.stringify(pnl.body).slice(0, 300));
  }
}

main().catch(console.error);
