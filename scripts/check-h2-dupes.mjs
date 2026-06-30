import { createConnection } from "mysql2/promise";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "../.env") });

const conn = await createConnection(process.env.DATABASE_URL);

const [rows] = await conn.execute(
  "SELECT ticker, userId, COUNT(*) as cnt FROM holding2 GROUP BY ticker, userId HAVING cnt > 1 ORDER BY cnt DESC LIMIT 20"
);
console.log("Duplicate tickers in holding2:");
console.table(rows);

const [allRows] = await conn.execute(
  "SELECT id, ticker, units, buyPrice, userId FROM holding2 WHERE units > 0 ORDER BY ticker, id LIMIT 50"
);
console.log("\nAll active holding2 rows:");
console.table(allRows);

await conn.end();
