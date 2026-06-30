require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  
  const [h1] = await conn.execute(`
    SELECT ticker, buyPrice, units, stopLoss, takeProfit 
    FROM portfolioHoldings 
    WHERE units > 0 
    ORDER BY ticker
  `);
  console.log("=== H1 Holdings ===");
  console.table(h1);

  const [h2] = await conn.execute(`
    SELECT ticker, buyPrice, units, stopLoss, takeProfit 
    FROM holding2 
    WHERE units > 0 
    ORDER BY ticker
  `);
  console.log("\n=== H2 Holdings ===");
  console.table(h2);

  const [alerts] = await conn.execute(`
    SELECT ticker, alertType, targetPrice, triggered, direction
    FROM priceAlerts 
    WHERE dismissed = 0 AND archivedAt IS NULL
    ORDER BY ticker, alertType
  `);
  console.log("\n=== Active Price Alerts ===");
  console.table(alerts);

  await conn.end();
}
main().catch(e => { console.error(e); process.exit(1); });
