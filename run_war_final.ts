import * as dotenv from "dotenv";
dotenv.config();
import { runWarEngineCycle } from "./server/warEngine";
console.log("🚀 WAR CYCLE STARTING...");
const r = await runWarEngineCycle(1);
console.log("===RESULT===", JSON.stringify({ 
  scanned: r.scanned, entered: r.entered, managed: r.managed, regime: r.regimeDecision,
  top: (r.topCandidates||[]).filter(c=>c.finalScore>=6).slice(0,8).map(c=>({
    t:c.ticker, score:c.finalScore.toFixed(1), action:c.action, reason:(c.blockReason||"OK").slice(0,70)
  }))
}));
process.exit(0);
