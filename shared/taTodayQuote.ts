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

export interface TaQuotePersistInput {
  price: number;
  prevClose: number | null;
  changePercent: number | null;
}

export interface TaQuotePersistBaseline extends TaQuoteBaseline {
  /** Stored DB prevClose — used when preserving session % against flat IBKR */
  prevCloseDb?: number | null;
  dailyChangePercent?: number | null;
}

/** Server-side: derive prevClose + dailyChangePercent for holding2 DB persist. */
export function resolveTaQuotePersist(
  ticker: string,
  input: TaQuotePersistInput,
  baseline: TaQuotePersistBaseline,
): { prevClose: number | null; changePercent: number | null } {
  if (!ticker.toUpperCase().endsWith(".TA")) {
    return { prevClose: input.prevClose, changePercent: input.changePercent };
  }

  const change =
    input.changePercent != null && input.price > 0
      ? input.price - input.price / (1 + input.changePercent / 100)
      : input.prevClose != null
        ? input.price - input.prevClose
        : null;

  const enriched = enrichTaTodayQuote(
    ticker,
    {
      price: input.price,
      change,
      changePercent: input.changePercent,
      prevClose: input.prevClose,
    },
    baseline,
  );

  const ibkrFlat =
    (input.changePercent == null || input.changePercent === 0)
    && input.prevClose != null
    && input.prevClose > 0
    && Math.abs(input.price - input.prevClose) / input.prevClose < 1e-6;

  if (
    ibkrFlat
    && (enriched.changePercent == null || enriched.changePercent === 0)
    && baseline.dailyChangePercent != null
    && baseline.dailyChangePercent !== 0
  ) {
    return {
      prevClose: baseline.prevCloseDb ?? baseline.prevClose ?? input.prevClose,
      changePercent: baseline.dailyChangePercent,
    };
  }

  return {
    prevClose: enriched.prevClose ?? input.prevClose,
    changePercent:
      enriched.changePercent != null
        ? +enriched.changePercent.toFixed(4)
        : input.changePercent,
  };
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
