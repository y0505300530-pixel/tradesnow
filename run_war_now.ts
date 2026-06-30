
import { runWarEngineCycle } from "./server/warEngine";
async function main() {
  try {
    const r = await runWarEngineCycle(1);
    console.log("WAR_RESULT:" + JSON.stringify({
      scanned: r.scanned,
      entered: r.entered,
      regime: r.regimeDecision,
      top: (r.topCandidates||[]).slice(0,5).map((c:any)=>c.ticker+":"+c.finalScore.toFixed(1)+":"+c.action+":"+c.direction)
    }));
  } catch(e: any) {
    console.error("WAR_ERROR:" + e.message);
  }
  process.exit(0);
}
main();
