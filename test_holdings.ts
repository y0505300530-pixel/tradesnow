import * as dotenv from "dotenv";
dotenv.config();
import { getPortfolioHoldings } from "./server/db";
try {
  const rows = await getPortfolioHoldings(1);
  console.log("Holdings count:", rows.length);
  if (rows.length > 0) console.log("Sample:", JSON.stringify(rows[0]).slice(0, 200));
} catch(e) {
  console.error("ERROR:", String(e));
}
process.exit(0);
