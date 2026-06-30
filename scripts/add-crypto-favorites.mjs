#!/usr/bin/env node
import "dotenv/config";
import { upsertUserAsset, getUserAssets } from "../server/db.ts";
import { swrInvalidate } from "../server/swrCache.ts";

const ADD = [
  { ticker: "RIOT", companyName: "Riot Platforms", sector: "Crypto / Fin", sortOrder: 220 },
  { ticker: "MP",   companyName: "MP Materials",   sector: "Industrials",  sortOrder: 221 },
  { ticker: "HUT",  companyName: "Hut 8 Mining", sector: "Crypto / Fin", sortOrder: 222 },
];

const userId = 1;
const existing = await getUserAssets(userId);
const have = new Set(existing.filter((a) => !a.archived).map((a) => a.ticker.toUpperCase()));

for (const a of ADD) {
  if (have.has(a.ticker)) {
    console.log(`= ${a.ticker} already active`);
    continue;
  }
  await upsertUserAsset(userId, a.ticker, {
    companyName: a.companyName,
    sector: a.sector,
    exchange: "US",
    sortOrder: a.sortOrder,
  });
  console.log(`+ ${a.ticker} (${a.sector})`);
}

swrInvalidate(`portfolio:catalogue:${userId}`);
const after = await getUserAssets(userId);
const n = new Set(
  after.filter((a) => !a.ticker.endsWith(".TA") && !a.archived).map((a) => a.ticker),
).size;
console.log(`Active US tickers: ${n}`);
