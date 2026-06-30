import * as dotenv from "dotenv";
dotenv.config({ path: "/root/tradesnow/.env" });
import { runWarEngineCycle } from "../server/warEngine.js";

console.log("🚀 Triggering WarEngine cycle...");
const result = await runWarEngineCycle(1);
console.log(JSON.stringify({ scanned: result.scanned, entered: result.entered, managed: result.managed, regime: result.regimeDecision, topCandidates: result.topCandidates?.slice(0,5) }, null, 2));
process.exit(0);
