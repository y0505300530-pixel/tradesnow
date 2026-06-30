/**
 * Production catalogue loader for backtest harnesses.
 * Mirrors live War Room LONG scan universe from userAssets (not DEFAULT_60_ASSETS).
 *
 * Filters (same as warEngine.ts entry scan):
 *   • USA only — excludes .TA (ISR), -USD crypto, numeric tickers
 *   • Excludes IPO_INCUBATOR (not yet hydrated for live entry)
 *
 * Env: ELZA_CATALOG_USER_ID or CATALOG_USER_ID (default 1).
 */
import { getUserAssets } from "../../server/db";
import { IPO_INCUBATOR } from "../../server/catalogStatus";

export interface ProductionCatalogueAsset {
  ticker: string;
  companyName: string;
  sector: string;
  catalogStatus: string | null;
}

export interface CatalogueLoadStats {
  assets: ProductionCatalogueAsset[];
  rawRows: number;
  usaCount: number;
  skippedIsr: number;
  skippedIpo: number;
}

/** USA equities — matches AssetCatalogue usaAssets + warEngine scan filter. */
export function isUsaCatalogueTicker(ticker: string): boolean {
  const t = ticker.toUpperCase();
  return !t.endsWith(".TA") && !t.endsWith("-USD") && !/^\d/.test(t);
}

export async function loadProductionCatalogueWithStats(): Promise<CatalogueLoadStats> {
  const userId = Number(process.env.ELZA_CATALOG_USER_ID ?? process.env.CATALOG_USER_ID ?? "1");
  const rows = await getUserAssets(userId);
  if (!rows.length) {
    throw new Error(
      `[productionCatalogue] Empty catalogue for userId=${userId}. ` +
      `Populate userAssets in DB (same source as TRADE-SNOW2.VIP War Room).`,
    );
  }

  const seen = new Set<string>();
  const assets: ProductionCatalogueAsset[] = [];
  let skippedIsr = 0;
  let skippedIpo = 0;

  for (const row of rows) {
    const ticker = row.ticker.toUpperCase();
    if (seen.has(ticker)) continue;

    if (!isUsaCatalogueTicker(ticker)) {
      skippedIsr++;
      continue;
    }

    const status = (row as { catalogStatus?: string | null }).catalogStatus ?? null;
    if (status === IPO_INCUBATOR) {
      skippedIpo++;
      continue;
    }

    seen.add(ticker);
    assets.push({
      ticker,
      companyName: row.companyName ?? ticker,
      sector: row.sector ?? "OTHER",
      catalogStatus: status,
    });
  }

  if (!assets.length) {
    throw new Error(
      `[productionCatalogue] No USA scannable assets for userId=${userId} ` +
      `(raw=${rows.length}, skippedIsr=${skippedIsr}, skippedIpo=${skippedIpo}).`,
    );
  }

  return {
    assets,
    rawRows: rows.length,
    usaCount: assets.length,
    skippedIsr,
    skippedIpo,
  };
}

export async function loadProductionCatalogue(): Promise<ProductionCatalogueAsset[]> {
  return (await loadProductionCatalogueWithStats()).assets;
}
