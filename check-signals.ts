import { getDb } from "./server/db";
import { paperPositions } from "./drizzle/schema";
import { eq } from "drizzle-orm";

async function main() {
  const db = await getDb();
  if (!db) { console.log("No DB"); return; }
  const rows = await db.select().from(paperPositions).where(eq(paperPositions.status, "open"));
  for (const r of rows) {
    console.log(`${r.ticker} | signal=${(r as any).signal} | status=${r.status} | created=${r.createdAt}`);
  }
  process.exit(0);
}
main();
