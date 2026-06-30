import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";

async function main() {
  const db = await getDb();
  if (!db) throw new Error("no db");

  const today = new Date().toISOString().split("T")[0];

  const [shortOpens] = await db.execute(sql`
    SELECT ticker, direction, \`signal\`, zivScore, entryPrice, openedAt, status
    FROM livePositions
    WHERE direction = 'short' AND DATE(openedAt) = ${today}
    ORDER BY openedAt DESC
  `);
  console.log("=== SHORT opens today ===");
  console.table(shortOpens);

  const [shortLogs] = await db.execute(sql`
    SELECT createdAt, level, LEFT(message, 220) AS msg
    FROM systemLogs
    WHERE DATE(createdAt) = CURDATE()
      AND (message LIKE '%SHORT%' OR message LIKE '%BifurcatedGovernor%' OR message LIKE '%short%')
    ORDER BY createdAt DESC
    LIMIT 25
  `);
  console.log("\n=== SHORT-related logs today ===");
  console.table(shortLogs);

  const [entryRejects] = await db.execute(sql`
    SELECT createdAt, LEFT(message, 220) AS msg
    FROM systemLogs
    WHERE DATE(createdAt) = CURDATE()
      AND message LIKE '%SHORT%'
      AND (message LIKE '%rejected%' OR message LIKE '%blocked%' OR message LIKE '%❌%' OR message LIKE '%skipping%')
    ORDER BY createdAt DESC
    LIMIT 20
  `);
  console.log("\n=== SHORT rejects/blocks today ===");
  console.table(entryRejects);

  const [upcoming] = await db.execute(sql`
    SELECT value FROM systemSettings WHERE \`key\` = 'war_upcoming_signals' LIMIT 1
  `);
  const parsed = JSON.parse((upcoming as any)[0]?.value ?? "{}");
  const shorts = (parsed.items ?? []).filter((i: any) => i.direction === "short");
  console.log("\n=== Current upcoming SHORT candidates ===");
  console.table(shorts);

  const [regimeLogs] = await db.execute(sql`
    SELECT createdAt, LEFT(message, 180) AS msg
    FROM systemLogs
    WHERE DATE(createdAt) = CURDATE() AND message LIKE '%Regime:%'
    ORDER BY createdAt DESC LIMIT 5
  `);
  console.log("\n=== Regime today ===");
  console.table(regimeLogs);

  const [capLogs] = await db.execute(sql`
    SELECT createdAt, LEFT(message, 200) AS msg
    FROM systemLogs
    WHERE DATE(createdAt) = CURDATE()
      AND (message LIKE '%DailyEntryCap%' OR message LIKE '%BUDGET FULL%' OR message LIKE '%MAX POSITIONS%')
    ORDER BY createdAt DESC LIMIT 10
  `);
  console.log("\n=== Cap / budget blocks today ===");
  console.table(capLogs);

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
