export interface TaLivePriceEntry {
  price: number | null;
  change?: number | null;
  changePercent?: number | null;
  prevClose?: number | null;
}

export interface TaQuoteBaseline {
  dailyBasePrice?: number | null;
  prevClose?: number | null;
}

/**
 * After TASE RTH, IBKR often returns change=0 with price ≈ prior_close (both today's
 * close). Restore the real session move using the DB baseline (dailyBasePrice or prevClose).
 */
export function enrichTaTodayQuote(
  ticker: string,
  entry: TaLivePriceEntry,
  baseline: TaQuoteBaseline,
): TaLivePriceEntry {
  if (!ticker.toUpperCase().endsWith(".TA")) return entry;
  const price = entry.price;
  if (price == null || price <= 0) return entry;

  const base =
    baseline.dailyBasePrice != null && baseline.dailyBasePrice > 0
      ? baseline.dailyBasePrice
      : baseline.prevClose != null && baseline.prevClose > 0
        ? baseline.prevClose
        : null;
  if (base == null) return entry;

  const ibkrFlat =
    (entry.change == null || entry.change === 0)
    && (entry.changePercent == null || entry.changePercent === 0);
  const stalePrev =
    entry.prevClose != null
    && entry.prevClose > 0
    && Math.abs(price - entry.prevClose) / entry.prevClose < 1e-6;
  const movedFromBase = Math.abs(price - base) / base > 1e-6;

  if ((ibkrFlat || stalePrev) && movedFromBase) {
    const change = price - base;
    return {
      ...entry,
      price,
      prevClose: base,
      change,
      changePercent: (change / base) * 100,
    };
  }
  return entry;
}
