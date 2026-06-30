import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";
import { getWarEngineStatus } from "../server/warEngine";

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const [row] = await db.execute(sql`
    SELECT \`key\`, LEFT(value, 2000) AS valuePreview, updatedAt
    FROM systemSettings
    WHERE \`key\` = 'war_upcoming_signals'
    LIMIT 1
  `);
  console.log("=== war_upcoming_signals ===");
  console.log(JSON.stringify(row, null, 2));

  const war = getWarEngineStatus();
  console.log("\n=== war engine status ===");
  console.log(JSON.stringify(war, null, 2));

  const [logs] = await db.execute(sql`
    SELECT level, message, createdAt
    FROM systemLogs
    WHERE message LIKE '%WarEngine%' OR message LIKE '%Upcoming%'
    ORDER BY createdAt DESC
    LIMIT 8
  `);
  console.log("\n=== recent war logs ===");
  console.table(logs);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
