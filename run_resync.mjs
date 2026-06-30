/**
 * One-time script to run nightly SL resync directly.
 * Usage: node --loader tsx run_resync.mjs
 */
import "dotenv/config";
import { runNightlySlResync } from "./server/routers/nightlySlResync.ts";
import { getUserByOpenId } from "./server/db.ts";

async function main() {
  const ownerOpenId = process.env.OWNER_OPEN_ID;
  console.log("Owner Open ID:", ownerOpenId);
  
  let userId = 1; // fallback
  if (ownerOpenId) {
    const owner = await getUserByOpenId(ownerOpenId);
    if (owner?.id) userId = owner.id;
  }
  console.log("Running nightly SL resync for userId:", userId);
  
  // Debug: check specific tickers
  const { getDb } = await import("./server/db.ts");
  const { portfolioHoldings } = await import("./drizzle/schema.ts");
  const { eq } = await import("drizzle-orm");
  const db = await getDb();
  const h1 = await db.select().from(portfolioHoldings).where(eq(portfolioHoldings.userId, userId));
  console.log("\n=== H1 Debug ===");
  for (const h of h1) {
    console.log(`${h.ticker}: buyPrice=${h.buyPrice}, SL=${h.stopLoss}, TP=${h.takeProfit}, units=${h.units}`);
  }
  
  const result = await runNightlySlResync(userId);
  console.log("\nResult:", JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
