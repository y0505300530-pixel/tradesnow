import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { portfolioHoldings } from './drizzle/schema.ts';
import { eq } from 'drizzle-orm';

const conn = await mysql.createConnection(process.env.DATABASE_URL);
const db = drizzle(conn);
const rows = await db.select({
  ticker: portfolioHoldings.ticker,
  units: portfolioHoldings.units,
  buyPrice: portfolioHoldings.buyPrice,
  currentPrice: portfolioHoldings.currentPrice,
  dailyChangePercent: portfolioHoldings.dailyChangePercent,
}).from(portfolioHoldings).where(eq(portfolioHoldings.userId, 1));

const active = rows.filter(r => (r.units ?? 0) > 0);
console.table(active.map(r => ({
  ticker: r.ticker,
  units: r.units,
  buyPrice: Number(r.buyPrice).toFixed(2),
  currentPrice: Number(r.currentPrice).toFixed(2),
  dailyChg: r.dailyChangePercent != null ? Number(r.dailyChangePercent).toFixed(4) + '%' : 'null',
  value: (Number(r.currentPrice ?? r.buyPrice) * Number(r.units)).toFixed(0),
})));
await conn.end();
