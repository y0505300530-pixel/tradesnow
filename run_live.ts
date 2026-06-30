import * as dotenv from "dotenv";
dotenv.config();
import { runWarEngineCycle } from "./server/warEngine";
const r = await runWarEngineCycle(1);
console.log("ENTERED:", r.entered, "SCANNED:", r.scanned, "REGIME:", r.regimeDecision);
process.exit(0);
