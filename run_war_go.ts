import * as dotenv from "dotenv";
dotenv.config();
import { runWarEngineCycle } from "./server/warEngine";
import { tryLiveEntry } from "./server/liveOrderExecutor";
console.log("🚀 FULL WAR CYCLE...");
const r = await runWarEngineCycle(1);
const top = (r.topCandidates||[]).filter((c:any)=>c.action==="ENTER").slice(0,5);
console.log("SCANNED:", r.scanned, "ENTERED:", r.entered, "REGIME:", r.regimeDecision);
console.log("TOP CANDIDATES:", JSON.stringify(top.map((c:any)=>({t:c.ticker,score:c.finalScore.toFixed(1),action:c.action}))));
if (r.entered === 0 && top.length > 0) {
  console.log("Trying direct tryLiveEntry for top ticker:", top[0].ticker);
  const res = await tryLiveEntry({ userId:1, ticker:top[0].ticker, direction:"long", signal:"WAR_ENGINE_MANUAL", zivScore:top[0].finalScore, currentPrice:0, slPrice:0, tpPrice:0, positionSizeUsd:0 });
  console.log("Direct entry result:", JSON.stringify(res));
}
process.exit(0);
