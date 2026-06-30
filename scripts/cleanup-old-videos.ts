#!/usr/bin/env npx tsx
/**
 * Manual video cleanup (same logic as monthly cron).
 *
 *   npx tsx scripts/cleanup-old-videos.ts           # dry-run
 *   npx tsx scripts/cleanup-old-videos.ts --apply   # delete
 *   npx tsx scripts/cleanup-old-videos.ts --days 30 --apply
 */
import "dotenv/config";
import { runVideoCleanup, VIDEO_CLEANUP_DEFAULT_DAYS } from "../server/videoCleanup";

const APPLY = process.argv.includes("--apply");
const daysArg = process.argv.find((a, i) => process.argv[i - 1] === "--days");
const DAYS = daysArg ? parseInt(daysArg, 10) : VIDEO_CLEANUP_DEFAULT_DAYS;

if (!Number.isFinite(DAYS) || DAYS < 1) {
  console.error("Invalid --days value");
  process.exit(1);
}

console.log(`\n=== Cleanup videos older than ${DAYS} days ===\n`);

const result = await runVideoCleanup({ days: DAYS, dryRun: !APPLY });

console.log("Result:", result);

if (!APPLY) {
  console.log("\nDry-run only. Re-run with --apply to delete.");
}
