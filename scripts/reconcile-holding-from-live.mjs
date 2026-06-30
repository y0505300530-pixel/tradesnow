#!/usr/bin/env node
/**
 * Reconcile portfolioHoldings for an Elza live position from livePositions.
 *
 * Usage:
 *   npx tsx scripts/reconcile-holding-from-live.mjs ENTG
 *   npx tsx scripts/reconcile-holding-from-live.mjs ENTG --userId=1
 */
import "dotenv/config";
import { getDb } from "../server/db.ts";
import { reconcileHoldingFromLivePosition } from "../server/portfolioHoldingsSync.ts";

const ticker = (process.argv[2] ?? "ENTG").toUpperCase();
const userIdArg = process.argv.find((a) => a.startsWith("--userId="));
const userId = userIdArg ? Number(userIdArg.split("=")[1]) : 1;

async function main() {
  const db = await getDb();
  if (!db) {
    console.error("Database unavailable");
    process.exit(1);
  }

  const result = await reconcileHoldingFromLivePosition(db, userId, ticker);
  if (!result.updated) {
    console.error(`No update for ${ticker}: ${result.reason ?? "unknown"}`);
    process.exit(1);
  }

  console.log(`✅ Reconciled ${ticker} (userId=${userId})`);
  if (result.before) {
    console.log("Before:", JSON.stringify(result.before, null, 2));
  }
  console.log("After:", JSON.stringify(result.after, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
