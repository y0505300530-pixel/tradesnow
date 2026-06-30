/**
 * One-time: merge 20 new USA catalogue tickers into owner (and all users with catalogues).
 * Usage: cd /root/tradesnow && npx tsx scripts/merge-catalogue-expansion.mjs
 */
import "dotenv/config";
import { getUserByOpenId, getUserAssets, upsertUserAsset } from "../server/db.ts";

const NEW_ASSETS = [
  { ticker: "AMAT", companyName: "Applied Materials",       sector: "Semiconductors", sortOrder: 163 },
  { ticker: "TTMI", companyName: "TTM Technologies",        sector: "Semiconductors", sortOrder: 164 },
  { ticker: "GEV",  companyName: "GE Vernova",              sector: "Energy",         sortOrder: 165 },
  { ticker: "ASML", companyName: "ASML Holding",            sector: "Semiconductors", sortOrder: 166 },
  { ticker: "TER",  companyName: "Teradyne",                sector: "Semiconductors", sortOrder: 167 },
  { ticker: "ENTG", companyName: "Entegris",                sector: "Semiconductors", sortOrder: 168 },
  { ticker: "CCJ",  companyName: "Cameco",                  sector: "Nuclear",        sortOrder: 169 },
  { ticker: "ETN",  companyName: "Eaton Corporation",       sector: "Industrials",    sortOrder: 170 },
  { ticker: "ANET", companyName: "Arista Networks",         sector: "AI / Data",      sortOrder: 171 },
  { ticker: "VRT",  companyName: "Vertiv Holdings",         sector: "AI / Data",      sortOrder: 172 },
  { ticker: "TTWO", companyName: "Take-Two Interactive",    sector: "Media",          sortOrder: 173 },
  { ticker: "XYZ",  companyName: "Block Inc.",              sector: "Fintech",        sortOrder: 174 },
  { ticker: "CRSP", companyName: "CRISPR Therapeutics",     sector: "Healthcare",     sortOrder: 175 },
  { ticker: "COHR", companyName: "Coherent Corp.",          sector: "Semiconductors", sortOrder: 176 },
  { ticker: "RMBS", companyName: "Rambus",                  sector: "Semiconductors", sortOrder: 177 },
  { ticker: "CYBR", companyName: "CyberArk Software",       sector: "Cybersecurity",  sortOrder: 178 },
  { ticker: "NU",   companyName: "Nu Holdings",             sector: "Fintech",        sortOrder: 179 },
  { ticker: "TOST", companyName: "Toast Inc.",              sector: "Fintech",        sortOrder: 180 },
  { ticker: "URI",  companyName: "United Rentals",          sector: "Industrials",    sortOrder: 181 },
  { ticker: "MELI", companyName: "MercadoLibre",            sector: "E-Commerce",     sortOrder: 182 },
];

async function resolveOwnerUserId() {
  const ownerOpenId = process.env.OWNER_OPEN_ID;
  if (ownerOpenId) {
    const owner = await getUserByOpenId(ownerOpenId);
    if (owner?.id) return owner.id;
  }
  return 1;
}

async function mergeForUser(userId) {
  const existing = await getUserAssets(userId);
  if (!existing?.length) {
    console.log(`  userId=${userId}: empty catalogue — skip (will seed from DEFAULT on first load)`);
    return { added: 0, skipped: NEW_ASSETS.length };
  }

  const have = new Set(existing.map((a) => a.ticker.toUpperCase()));
  let added = 0;
  let skipped = 0;

  for (const asset of NEW_ASSETS) {
    if (have.has(asset.ticker)) {
      skipped++;
      continue;
    }
    await upsertUserAsset(userId, asset.ticker, {
      companyName: asset.companyName,
      sector: asset.sector,
      exchange: "US",
      sortOrder: asset.sortOrder,
    });
    added++;
    console.log(`  + ${asset.ticker} → userId=${userId}`);
  }

  return { added, skipped };
}

async function main() {
  const ownerUserId = await resolveOwnerUserId();
  console.log(`Owner userId: ${ownerUserId}`);
  console.log(`Merging ${NEW_ASSETS.length} new tickers...\n`);

  const ownerResult = await mergeForUser(ownerUserId);
  console.log(`\nOwner summary: added=${ownerResult.added}, already had=${ownerResult.skipped}`);

  const assetsAfter = await getUserAssets(ownerUserId);
  const usCount = assetsAfter.filter((a) => !a.ticker.endsWith(".TA")).length;
  console.log(`Owner catalogue now: ${assetsAfter.length} total (${usCount} US)`);

  const tickers = NEW_ASSETS.map((a) => a.ticker);
  const missing = tickers.filter(
    (t) => !assetsAfter.some((a) => a.ticker.toUpperCase() === t),
  );
  if (missing.length) {
    console.error("ERROR: still missing after merge:", missing.join(", "));
    process.exit(1);
  }
  console.log("\n✅ All 20 expansion tickers present in owner catalogue.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
