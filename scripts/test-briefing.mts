/**
 * Dry-run script for the Market Open Briefing.
 * Run: npx tsx scripts/test-briefing.mts TASE
 */
import { runMarketOpenBriefing } from "../server/routers/marketOpenBriefing.js";

const session = (process.argv[2] ?? "TASE") as "TASE" | "US";
console.log(`[DRY RUN] Starting ${session} briefing...`);

try {
  const result = await runMarketOpenBriefing(session);
  console.log("[DRY RUN] Result:", result);
} catch (e) {
  console.error("[DRY RUN] Error:", e);
  process.exit(1);
}
