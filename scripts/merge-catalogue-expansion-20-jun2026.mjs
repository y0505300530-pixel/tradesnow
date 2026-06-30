/**
 * Add 20 recommended USA catalogue tickers (Jun 2026 expansion).
 * Usage: cd /root/tradesnow && npx tsx scripts/merge-catalogue-expansion-20-jun2026.mjs
 */
import "dotenv/config";
import { getUserByOpenId, getUserAssets, upsertUserAsset } from "../server/db.ts";
import { swrInvalidate } from "../server/swrCache.ts";

const NEW_ASSETS = [
  { ticker: "SMCI", companyName: "Super Micro Computer",    sector: "Semiconductors",  sortOrder: 183 },
  { ticker: "NBIS", companyName: "Nebius Group",            sector: "AI / Data",       sortOrder: 184 },
  { ticker: "DELL", companyName: "Dell Technologies",       sector: "AI / Data",       sortOrder: 185 },
  { ticker: "APLD", companyName: "Applied Digital",         sector: "AI / Data",       sortOrder: 186 },
  { ticker: "IREN", companyName: "Iris Energy",             sector: "AI / Data",       sortOrder: 187 },
  { ticker: "PWR",  companyName: "Quanta Services",         sector: "Energy & AI Infra", sortOrder: 188 },
  { ticker: "SNDK", companyName: "Sandisk",                 sector: "Semiconductors",  sortOrder: 189 },
  { ticker: "STX",  companyName: "Seagate Technology",      sector: "Semiconductors",  sortOrder: 190 },
  { ticker: "ON",   companyName: "ON Semiconductor",        sector: "Semiconductors",  sortOrder: 191 },
  { ticker: "MPWR", companyName: "Monolithic Power Systems", sector: "Semiconductors", sortOrder: 192 },
  { ticker: "INTC", companyName: "Intel",                   sector: "Semiconductors",  sortOrder: 193 },
  { ticker: "ZS",   companyName: "Zscaler",                 sector: "Cybersecurity",   sortOrder: 194 },
  { ticker: "OKTA", companyName: "Okta",                    sector: "Cybersecurity",   sortOrder: 195 },
  { ticker: "LMT",  companyName: "Lockheed Martin",         sector: "Defense",         sortOrder: 196 },
  { ticker: "KTOS", companyName: "Kratos Defense",          sector: "Defense Tech",    sortOrder: 197 },
  { ticker: "ACHR", companyName: "Archer Aviation",         sector: "Space",           sortOrder: 198 },
  { ticker: "ASTS", companyName: "AST SpaceMobile",         sector: "Space",           sortOrder: 199 },
  { ticker: "LEU",  companyName: "Centrus Energy",          sector: "Nuclear",         sortOrder: 200 },
  { ticker: "FSLR", companyName: "First Solar",             sector: "Energy",          sortOrder: 201 },
  { ticker: "GLW",  companyName: "Corning",                 sector: "AI / Data",       sortOrder: 202 },
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
  console.log(`Owner userId: ${userId}`);
  console.log(`Adding ${NEW_ASSETS.length} tickers...\n`);

  const existing = await getUserAssets(userId);
  const have = new Set(existing.map((a) => a.ticker.toUpperCase()));
  let added = 0;
  let skipped = 0;

  for (const asset of NEW_ASSETS) {
    if (have.has(asset.ticker)) {
      console.log(`  = ${asset.ticker} already in catalogue`);
      skipped++;
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
  const usCount = after.filter((a) => !a.ticker.endsWith(".TA") && !a.archived).length;
  const distinctUs = new Set(after.filter((a) => !a.ticker.endsWith(".TA") && !a.archived).map((a) => a.ticker)).size;

  console.log(`\nDone: added=${added}, skipped=${skipped}`);
  console.log(`Catalogue: ${distinctUs} distinct US tickers (${usCount} rows)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
