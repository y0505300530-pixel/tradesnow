/**
 * Ticker Alias Map — handles renamed, relisted, or IBKR-problematic tickers.
 *
 * When IBKR /trsrv/stocks returns 404 for a symbol, we try:
 * 1. Check this alias map for a known alternative symbol
 * 2. Try multiple exchange variants (SMART, NYSE, NASDAQ)
 * 3. Fall back to "unavailable on IBKR" gracefully
 *
 * Maintenance: add entries here when a ticker is renamed, relisted, or
 * when IBKR uses a different symbol than Yahoo Finance.
 */

export interface TickerAlias {
  /** The canonical symbol to try with IBKR instead */
  ibkrSymbol: string;
  /** Human-readable reason for the alias */
  reason: string;
  /** If we know the conid directly, skip the API call entirely */
  knownConid?: number;
}

/**
 * Map of Yahoo Finance ticker → IBKR resolution hint.
 * Key: ticker as stored in our DB (uppercase).
 */
export const TICKER_ALIASES: Record<string, TickerAlias> = {
  // SanDisk was acquired by Western Digital in 2016 (SNDK delisted).
  // In February 2026, Western Digital spun off SanDisk as a new public company
  // under the same SNDK ticker on NASDAQ. IBKR may have a stale/missing entry.
  // If IBKR still returns 404, the conid needs to be resolved manually.
  "SNDK": {
    ibkrSymbol: "SNDK",
    reason: "SanDisk re-listed Feb 2026 after WDC spin-off — IBKR conid may be stale",
  },

  // SolarEdge is an Israeli company (registered in Israel) trading on NASDAQ.
  // Some brokers restrict trading due to Israeli tax treaty issues.
  // IBKR may list it under a different exchange or require specific routing.
  "SEDG": {
    ibkrSymbol: "SEDG",
    reason: "Israeli company on NASDAQ — may require SMART routing or manual conid",
  },

  // Terminal X (TRX) on TASE — IBKR resolves "TRX" to AMEX stock, not TASE
  // Must use explicit symbol lookup to get TASE listing
  "TRX.TA": {
    ibkrSymbol: "TRX",
    reason: "TRX on TASE conflicts with AMEX TRX — needs exchange_hint=TASE",
  },
  "TRX": {
    ibkrSymbol: "TRX",
    reason: "TRX on TASE conflicts with AMEX TRX — needs exchange_hint=TASE",
  },

  // Energean plc trades on TASE under symbol ENOG (not ENERGEAN)
  // IBKR uses ENOG as the symbol for the TASE listing
  "ENERGEAN.TA": {
    ibkrSymbol: "ENOG",
    reason: "Energean on TASE is listed as ENOG, not ENERGEAN",
  },
  "ENERGEAN": {
    ibkrSymbol: "ENOG",
    reason: "Energean on TASE is listed as ENOG, not ENERGEAN",
  },

  // Dell Technologies — IBKR /trsrv/stocks sometimes fails to resolve DELL
  // conid 265768 is the NYSE-listed Dell Technologies Inc (Class C)
  "DELL": {
    ibkrSymbol: "DELL",
    reason: "Dell Technologies — IBKR search may fail, using known conid",
    knownConid: 265768,
  },

  // Nike Inc — Yahoo Finance uses NIKE but IBKR uses NKE
  "NIKE": {
    ibkrSymbol: "NKE",
    reason: "Nike Inc trades as NKE on NYSE — Yahoo uses NIKE",
    knownConid: 10291,
  },
};

/**
 * Exchange variants to try when the primary symbol lookup fails.
 * IBKR /trsrv/stocks accepts exchange-qualified symbols.
 */
export const EXCHANGE_VARIANTS = ["SMART", "NASDAQ", "NYSE", "ARCA", "BATS"];

/**
 * Returns the IBKR symbol to use for a given ticker.
 * Returns null if no alias exists (caller should use stripped symbol).
 */
export function resolveIbkrSymbol(ticker: string): string | null {
  const alias = TICKER_ALIASES[ticker.toUpperCase()];
  return alias?.ibkrSymbol ?? null;
}

/**
 * Returns a known conid if we have one hardcoded, otherwise null.
 */
export function getKnownConid(ticker: string): number | null {
  return TICKER_ALIASES[ticker.toUpperCase()]?.knownConid ?? null;
}

/**
 * Returns the reason a ticker is aliased, for display in the UI.
 */
export function getAliasReason(ticker: string): string | null {
  return TICKER_ALIASES[ticker.toUpperCase()]?.reason ?? null;
}
