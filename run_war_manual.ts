import * as dotenv from "dotenv";
dotenv.config();
import { runWarEngineCycle } from "./server/warEngine";
const r = await runWarEngineCycle(1);
console.log("RESULT:", JSON.stringify({ 
  scanned: r.scanned, entered: r.entered, managed: r.managed, regime: r.regimeDecision,
  top: (r.topCandidates||[]).slice(0,10).map(c=>({
    t:c.ticker, d:c.direction, score:c.finalScore.toFixed(1), action:c.action, reason:(c.blockReason||"").slice(0,60)
  }))
}));
