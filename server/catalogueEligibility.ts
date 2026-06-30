import type { TaseTickerHints } from "./taseTickerResolve";

export type CatalogueEligibility = {
  priceOk: boolean | null;
  volumeOk: boolean | null;
  price: number | null;
  avgVolume20: number | null;
  minPrice: number;
  minVolume: number;
  currencySymbol: string;
  /** Both price and volume pass catalogue thresholds */
  suitable: boolean;
};

export function getCatalogueThresholds(isTase: boolean) {
  return {
    minPrice: 2.0,
    minVolume: isTase ? 10_000 : 200_000,
    currencySymbol: isTase ? "₪" : "$",
  };
}

export async function evaluateCatalogueEligibility(
  ticker: string,
  hints?: TaseTickerHints,
): Promise<CatalogueEligibility> {
  const { resolveTaseTickerForCatalogue } = await import("./taseTickerResolve");
  const resolved = await resolveTaseTickerForCatalogue(ticker, hints);
  const isTase = resolved.endsWith(".TA");
  const { minPrice, minVolume, currencySymbol } = getCatalogueThresholds(isTase);

  const unknown: CatalogueEligibility = {
    priceOk: null,
    volumeOk: null,
    price: null,
    avgVolume20: null,
    minPrice,
    minVolume,
    currencySymbol,
    suitable: false,
  };

  try {
    const { fetchBarsForTicker } = await import("./marketData");
    const bars = await fetchBarsForTicker(resolved, 30);
    if (bars.length < 3) return unknown;

    const lastPrice = bars[bars.length - 1].close;
    const avgVol = bars.slice(-20).reduce((s, b) => s + (b.volume ?? 0), 0) / Math.min(20, bars.length);

    const priceOk = lastPrice >= minPrice;
    const volumeOk = avgVol <= 0 || avgVol >= minVolume;

    return {
      priceOk,
      volumeOk,
      price: lastPrice,
      avgVolume20: avgVol,
      minPrice,
      minVolume,
      currencySymbol,
      suitable: priceOk && volumeOk,
    };
  } catch {
    return unknown;
  }
}

export async function evaluateCatalogueEligibilityBatch(
  items: Array<{ ticker: string; hints?: TaseTickerHints }>,
): Promise<Map<string, CatalogueEligibility>> {
  const out = new Map<string, CatalogueEligibility>();
  const BATCH = 4;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    await Promise.all(batch.map(async ({ ticker, hints }) => {
      const key = ticker.toUpperCase();
      const result = await evaluateCatalogueEligibility(ticker, hints);
      out.set(key, result);
    }));
  }
  return out;
}
