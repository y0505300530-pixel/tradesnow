/**
 * TASE ticker resolution — bare symbols like MDTR → MDTR.TA for Yahoo/validation.
 */

export type TaseTickerHints = {
  company?: string;
  entryZone?: string;
  stopLoss?: string;
  strategy?: string;
  catalyst?: string;
};

const TASE_CONTEXT_RE =
  /agorot|אגור|₪|ש[\"']?ח|tase|tel[\s-]?aviv|ישראל|israel|בursa|מדיטר/i;

export function isExplicitTaseTicker(ticker: string): boolean {
  const t = ticker.toUpperCase();
  return t.endsWith(".TA") || t.endsWith(".TLV");
}

export function normalizeBareTicker(raw: string): string {
  return raw.trim().toUpperCase().replace(/\.TLV$/, "").replace(/\.TA$/, "");
}

export function toTaseYahooSymbol(ticker: string): string {
  return `${normalizeBareTicker(ticker)}.TA`;
}

export function hasTaseContextHints(hints?: TaseTickerHints): boolean {
  if (!hints) return false;
  const text = [
    hints.company,
    hints.entryZone,
    hints.stopLoss,
    hints.strategy,
    hints.catalyst,
  ]
    .filter(Boolean)
    .join(" ");
  return TASE_CONTEXT_RE.test(text);
}

/** Sync classification for reports — no network calls */
export function inferTaseTickerSync(ticker: string, hints?: TaseTickerHints): string {
  const upper = ticker.trim().toUpperCase();
  if (upper.endsWith(".TLV")) return upper.replace(/\.TLV$/, ".TA");
  if (upper.endsWith(".TA")) return upper;
  if (hasTaseContextHints(hints)) return toTaseYahooSymbol(upper);
  return upper;
}

export function isTaseMarketTicker(ticker: string, hints?: TaseTickerHints): boolean {
  return isExplicitTaseTicker(ticker) || hasTaseContextHints(hints);
}

/**
 * Resolve catalogue/market symbol — tries bare US bars, then .TA, then hint fallback.
 */
export async function resolveTaseTickerForCatalogue(
  ticker: string,
  hints?: TaseTickerHints,
): Promise<string> {
  const upper = ticker.trim().toUpperCase();
  if (upper.endsWith(".TLV")) return upper.replace(/\.TLV$/, ".TA");
  if (upper.endsWith(".TA")) return upper;

  const { normalizeTickerSymbol, fetchBarsForTicker } = await import("./marketData");
  const aliased = normalizeTickerSymbol(upper);
  if (isExplicitTaseTicker(aliased)) return aliased.replace(/\.TLV$/, ".TA");

  if (hasTaseContextHints(hints)) {
    const hinted = toTaseYahooSymbol(upper);
    const hintedBars = await fetchBarsForTicker(hinted, 5);
    if (hintedBars.length >= 3) return hinted;
    return hinted;
  }

  const bareBars = await fetchBarsForTicker(upper, 5);
  if (bareBars.length >= 3) return upper;

  const taseSym = toTaseYahooSymbol(upper);
  const taseBars = await fetchBarsForTicker(taseSym, 5);
  if (taseBars.length >= 3) return taseSym;

  return upper;
}
