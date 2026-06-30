import * as dotenv from "dotenv";
dotenv.config();
import { runWarEngineCycle } from "./server/warEngine";
console.log("🔥 FINAL CYCLE");
const r = await runWarEngineCycle(1);
console.log("ENTERED:", r.entered, "SCANNED:", r.scanned);
process.exit(0);
