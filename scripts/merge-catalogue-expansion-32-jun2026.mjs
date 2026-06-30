/**
 * Add 32 recommended USA catalogue tickers (Jun 2026 expansion).
 * Usage: cd /root/tradesnow && npx tsx scripts/merge-catalogue-expansion-32-jun2026.mjs
 */
import "dotenv/config";
import { getUserByOpenId, getUserAssets, upsertUserAsset } from "../server/db.ts";
import { swrInvalidate } from "../server/swrCache.ts";

const NEW_ASSETS = [
  { ticker: "OKLO", companyName: "Oklo",                    sector: "Nuclear",        sortOrder: 183 },
  { ticker: "SMR",  companyName: "NuScale Power",           sector: "Nuclear",        sortOrder: 184 },
  { ticker: "UUUU", companyName: "Energy Fuels",            sector: "Nuclear",        sortOrder: 185 },
  { ticker: "CORZ", companyName: "Core Scientific",         sector: "Crypto / Fin",   sortOrder: 186 },
  { ticker: "HUT",  companyName: "Hut 8",                   sector: "Crypto / Fin",   sortOrder: 187 },
  { ticker: "WULF", companyName: "TeraWulf",                sector: "Crypto / Fin",   sortOrder: 188 },
  { ticker: "AVAV", companyName: "AeroVironment",           sector: "Defense Tech",   sortOrder: 189 },
  { ticker: "BWXT", companyName: "BWX Technologies",        sector: "Defense Tech",   sortOrder: 190 },
  { ticker: "RCAT", companyName: "Red Cat Holdings",        sector: "Defense Tech",   sortOrder: 191 },
  { ticker: "LSCC", companyName: "Lattice Semiconductor",   sector: "Semiconductors", sortOrder: 192 },
  { ticker: "NXPI", companyName: "NXP Semiconductors",      sector: "Semiconductors", sortOrder: 193 },
  { ticker: "AMBA", companyName: "Ambarella",               sector: "Semiconductors", sortOrder: 194 },
  { ticker: "VKTX", companyName: "Viking Therapeutics",     sector: "Healthcare",     sortOrder: 195 },
  { ticker: "ALNY", companyName: "Alnylam Pharmaceuticals", sector: "Healthcare",     sortOrder: 196 },
  { ticker: "IOVA", companyName: "Iovance Biotherapeutics", sector: "Healthcare",     sortOrder: 197 },
  { ticker: "ROIV", companyName: "Roivant Sciences",        sector: "Healthcare",     sortOrder: 198 },
  { ticker: "TEM",  companyName: "Tempus AI",               sector: "Healthcare",     sortOrder: 199 },
  { ticker: "TWST", companyName: "Twist Bioscience",        sector: "Healthcare",     sortOrder: 200 },
  { ticker: "SYM",  companyName: "Symbotic",                sector: "AI / Data",      sortOrder: 201 },
  { ticker: "RBRK", companyName: "Rubrik",                  sector: "AI / Data",      sortOrder: 202 },
  { ticker: "DV",   companyName: "DoubleVerify",            sector: "AI / Data",      sortOrder: 203 },
  { ticker: "RDW",  companyName: "Redwire",                 sector: "Space",          sortOrder: 204 },
  { ticker: "IRDM", companyName: "Iridium Communications",sector: "Space",          sortOrder: 205 },
  { ticker: "PENN", companyName: "PENN Entertainment",      sector: "Media",          sortOrder: 206 },
  { ticker: "GENI", companyName: "Genius Sports",           sector: "Media",          sortOrder: 207 },
  { ticker: "FOUR", companyName: "Shift4 Payments",           sector: "Fintech",        sortOrder: 208 },
  { ticker: "GLBE", companyName: "Global-e Online",         sector: "Fintech",        sortOrder: 209 },
  { ticker: "LC",   companyName: "LendingClub",             sector: "Fintech",        sortOrder: 210 },
  { ticker: "STRL", companyName: "Sterling Infrastructure", sector: "Industrials",    sortOrder: 211 },
  { ticker: "FIX",  companyName: "Comfort Systems USA",     sector: "Industrials",    sortOrder: 212 },
  { ticker: "GLOB", companyName: "Globant",                 sector: "Technology",     sortOrder: 213 },
  { ticker: "VFS",  companyName: "VinFast Auto",            sector: "EV / Auto",      sortOrder: 214 },
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
