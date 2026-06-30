import "dotenv/config";
import { sql, eq, and, inArray } from "drizzle-orm";
import { getDb } from "../server/db";
import { livePositions } from "../drizzle/schema";
import { safeInsertLivePosition } from "../server/livePositionsSyncCore";

async function main() {
  const db = await getDb();
  if (!db) throw new Error("no db");

  for (const t of ["AI", "PLTR", "NOW"]) {
    const rows = await db.select({ id: livePositions.id, status: livePositions.status, ticker: livePositions.ticker })
      .from(livePositions)
      .where(and(eq(livePositions.userId, 1), eq(livePositions.ticker, t)));
    console.log(t, rows);
  }

  try {
    await safeInsertLivePosition(db, {
      userId: 1,
      accountId: "U16881054",
      ticker: "ZZTEST",
      companyName: "ZZTEST",
      direction: "short",
      units: 10,
      entryPrice: 100,
      allocatedCapital: 1000,
      currentSl: 110,
      currentTp: 80,
      initialSl: 110,
      initialTp: 80,
      currentPrice: 100,
      signal: "TEST",
      zivScore: 7.9,
      status: "open",
      slProtection: "ibkr",
      originalUnits: 10,
      pyramidDone: 0,
      pyramidUnits: 0,
      rValue: 10,
      isFreeRolled: 0,
    });
    console.log("TEST INSERT OK");
    await db.delete(livePositions).where(eq(livePositions.ticker, "ZZTEST"));
  } catch (e) {
    console.error("TEST INSERT FAIL:", (e as Error).message);
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
