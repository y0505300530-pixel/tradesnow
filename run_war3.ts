import * as dotenv from "dotenv";
dotenv.config();
import { runWarEngineCycle } from "./server/warEngine";
console.log("🚀 Cycle starting...");
const r = await runWarEngineCycle(1);
console.log("RESULT:", JSON.stringify({ 
  scanned: r.scanned, entered: r.entered, managed: r.managed, regime: r.regimeDecision,
  top: (r.topCandidates||[]).slice(0,8).map(c=>({
    t:c.ticker, d:c.direction, score:c.finalScore.toFixed(1), action:c.action, reason:(c.blockReason||"").slice(0,60)
  }))
}));
