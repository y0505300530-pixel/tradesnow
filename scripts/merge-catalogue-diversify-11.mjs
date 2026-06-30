/**
 * Add 11 USA catalogue tickers for sector diversity → 125 total.
 * Usage: cd /root/tradesnow && npx tsx scripts/merge-catalogue-diversify-11.mjs
 */
import "dotenv/config";
import { getUserByOpenId, getUserAssets, upsertUserAsset } from "../server/db.ts";
import { swrInvalidate } from "../server/swrCache.ts";

const NEW_ASSETS = [
  { ticker: "JPM",  companyName: "JPMorgan Chase",          sector: "Finance",        sortOrder: 203 },
  { ticker: "MA",   companyName: "Mastercard",              sector: "Finance",        sortOrder: 204 },
  { ticker: "CAT",  companyName: "Caterpillar",             sector: "Industrials",    sortOrder: 205 },
  { ticker: "BA",   companyName: "Boeing",                  sector: "Defense",        sortOrder: 206 },
  { ticker: "GD",   companyName: "General Dynamics",        sector: "Defense",        sortOrder: 207 },
  { ticker: "JOBY", companyName: "Joby Aviation",           sector: "Space",          sortOrder: 208 },
  { ticker: "ENPH", companyName: "Enphase Energy",          sector: "Energy",         sortOrder: 209 },
  { ticker: "MDB",  companyName: "MongoDB",                 sector: "SaaS",           sortOrder: 210 },
  { ticker: "NVO",  companyName: "Novo Nordisk",            sector: "Healthcare",     sortOrder: 211 },
  { ticker: "SE",   companyName: "Sea Limited",             sector: "E-Commerce",     sortOrder: 212 },
  { ticker: "DIS",  companyName: "Walt Disney",             sector: "Media",          sortOrder: 213 },
];

async function resolveOwnerUserId() {
  const ownerOpenId = process.env.OWNER_OPEN_ID;
  if (ownerOpenId) {
    const owner = await getUserByOpenId(ownerOpenId);
    if (owner?.id) return owner.id;
  }
  return 1;
}

async function main() {
  const userId = await resolveOwnerUserId();
  const existing = await getUserAssets(userId);
  const have = new Set(existing.map((a) => a.ticker.toUpperCase()));
  let added = 0;

  console.log(`Owner userId: ${userId} | current distinct US: ${have.size}`);
  for (const asset of NEW_ASSETS) {
    if (have.has(asset.ticker)) {
      console.log(`  = ${asset.ticker} skip`);
      continue;
    }
    await upsertUserAsset(userId, asset.ticker, {
      companyName: asset.companyName,
      sector: asset.sector,
      exchange: "US",
      sortOrder: asset.sortOrder,
    });
    console.log(`  + ${asset.ticker} (${asset.sector})`);
    added++;
  }

  swrInvalidate(`portfolio:catalogue:${userId}`);
  const after = await getUserAssets(userId);
  const distinctUs = new Set(
    after.filter((a) => !a.ticker.endsWith(".TA") && !a.archived).map((a) => a.ticker),
  ).size;
  console.log(`\nAdded ${added} → ${distinctUs} distinct US tickers`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
