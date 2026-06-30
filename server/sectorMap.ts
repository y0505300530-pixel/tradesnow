/**
 * sectorMap.ts — Shared sector lookup (avoids circular dependency between paperLabEngine and paperSync)
 */
import { getDb } from "./db";
import { userAssets } from "../drizzle/schema";

const _sectorMap = new Map<string, string>();

export async function loadSectorMap(): Promise<void> {
  try {
    const dbConn = await getDb();
    if (!dbConn) return;
    const assets = await dbConn.select({ ticker: userAssets.ticker, sector: userAssets.sector }).from(userAssets);
    for (const a of assets) {
      if (a.ticker && a.sector) {
        _sectorMap.set(a.ticker.toUpperCase(), a.sector);
      }
    }
    if (_sectorMap.size > 0) {
      console.log(`[Sector] Loaded ${_sectorMap.size} ticker->sector mappings from DB`);
    }
  } catch { /* non-fatal */ }
}

/** Get sector for a ticker from the in-memory map */
export function getSectorForTicker(ticker: string): string | undefined {
  return _sectorMap.get(ticker.toUpperCase());
}

// Delay sector load to allow DB connection to initialize
setTimeout(() => loadSectorMap(), 5000);
