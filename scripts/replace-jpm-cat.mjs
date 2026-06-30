#!/usr/bin/env node
/**
 * Archive JPM + CAT, replace with BX + HON, add DE + CACI → 125 active US tickers.
 * Usage: npx tsx scripts/replace-jpm-cat.mjs
 */
import "dotenv/config";
import { getUserByOpenId, getUserAssets, upsertUserAsset, archiveUserAssets } from "../server/db.ts";
import { swrInvalidate } from "../server/swrCache.ts";

const REMOVE = ["JPM", "CAT"];
const ADD = [
  { ticker: "BX",   companyName: "Blackstone",           sector: "Finance",      sortOrder: 216 },
  { ticker: "HON",  companyName: "Honeywell",            sector: "Industrials",  sortOrder: 217 },
  { ticker: "DE",   companyName: "Deere & Co.",          sector: "Industrials",  sortOrder: 218 },
  { ticker: "CACI", companyName: "CACI International",   sector: "Defense Tech", sortOrder: 219 },
];

async function resolveOwnerUserId() {
  if (process.env.OWNER_OPEN_ID) {
    const owner = await getUserByOpenId(process.env.OWNER_OPEN_ID);
    if (owner?.id) return owner.id;
  }
  return 1;
}

async function main() {
  const userId = await resolveOwnerUserId();
  await archiveUserAssets(userId, REMOVE);
  console.log(`Archived: ${REMOVE.join(", ")}`);

  const existing = await getUserAssets(userId);
  const have = new Set(existing.filter((a) => !a.archived).map((a) => a.ticker.toUpperCase()));

  for (const asset of ADD) {
    if (have.has(asset.ticker)) {
      console.log(`  = ${asset.ticker} already active`);
      continue;
    }
    await upsertUserAsset(userId, asset.ticker, {
      companyName: asset.companyName,
      sector: asset.sector,
      exchange: "US",
      sortOrder: asset.sortOrder,
    });
    console.log(`  + ${asset.ticker} (${asset.sector})`);
  }

  swrInvalidate(`portfolio:catalogue:${userId}`);
  const after = await getUserAssets(userId);
  const distinctUs = new Set(
    after.filter((a) => !a.ticker.endsWith(".TA") && !a.archived).map((a) => a.ticker),
  ).size;
  console.log(`\nActive distinct US tickers: ${distinctUs}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
