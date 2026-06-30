
process.env.IBIND_API_SECRET    = "aee22a0c56f42bef66ed28e4578c801b5a8b8cbd98533069bf07af1d936d4b6e";
process.env.IBIND_HMAC_SECRET   = "8151b1efb9077518be7c099c8bb10df190677700c6f714fbbe7e1a7317464e72";
process.env.IBIND_HOST_OVERRIDE = "127.0.0.1";
process.env.IBIND_PORT_OVERRIDE = "5000";

import { runWarEngineCycle } from "./server/warEngine";

const result = await runWarEngineCycle(1);
console.log("SCANNED:", result.scanned);
console.log("ENTERED:", result.entered);
console.log("SKIPPED:", result.skipped);
console.log("REGIME:", result.regimeDecision);
if (result.topCandidates?.length) {
  for (const c of result.topCandidates.slice(0,10)) {
    console.log(`  ${c.ticker} ${c.direction} score=${c.score?.toFixed?.(1)} action=${c.action} why=${c.blockReason ?? "ok"}`);
  }
} else {
  console.log("  no candidates");
}
