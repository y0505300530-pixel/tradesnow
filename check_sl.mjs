import "dotenv/config";
import { getDb } from "./server/db.ts";
import { portfolioHoldings } from "./drizzle/schema.ts";
import { eq } from "drizzle-orm";

async function main() {
  const db = await getDb();
  const rows = await db.select({
    ticker: portfolioHoldings.ticker,
    buyPrice: portfolioHoldings.buyPrice,
    stopLoss: portfolioHoldings.stopLoss,
    takeProfit: portfolioHoldings.takeProfit,
    units: portfolioHoldings.units,
  }).from(portfolioHoldings).where(eq(portfolioHoldings.userId, 1));
  
  const active = rows.filter(r => Number(r.units) > 0);
  console.log("\n=== H1 Holdings SL/TP Status ===\n");
  for (const r of active) {
    console.log(`${r.ticker.padEnd(8)} | Buy: $${Number(r.buyPrice).toFixed(2).padStart(8)} | SL: ${r.stopLoss != null ? '$' + Number(r.stopLoss).toFixed(2) : 'NULL'.padStart(8)} | TP: ${r.takeProfit != null ? '$' + Number(r.takeProfit).toFixed(2) : 'NULL'.padStart(8)}`);
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
