import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";

async function main() {
  const db = await getDb();
  if (!db) throw new Error("no db");
  const [rows] = await db.execute(sql`
    SELECT LENGTH(message) as len, message FROM systemLogs
    WHERE message LIKE '%Entry error AI%'
    ORDER BY createdAt DESC LIMIT 1
  `);
  const r = (rows as { len: number; message: string }[])[0];
  console.log("len:", r?.len);
  console.log(r?.message ?? "none");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
