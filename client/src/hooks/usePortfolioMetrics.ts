/**
 * usePortfolioMetrics — Single Source of Truth for all portfolio math
 *
 * This hook centralizes every portfolio calculation so that ALL UI components
 * (CapitalSummaryCards, HoldingsSection, H1H2Dashboard, TradeManager header)
 * show identical numbers that update atomically on every 60s SSE pulse.
 *
 * Design decisions:
 *   - H1 value  = Σ(livePrice × units) — grossPositionValue is NOT used (includes margin debt)
 *   - H1 NLV    = IBKR netLiquidation when connected, else H1 value + cash
 *   - H2 value  = Σ(ibkrPrice ?? yahooPrice ?? dbCurrentPrice ?? buyPrice × units)  — IBKR first when connected
 *   - Unified   = H1 NLV + H2 value  (consistent everywhere)
 *   - Today P&L = (currentPrice − prevClose) × units for overnight positions
 *                 Opened today: (currentPrice − entryPrice) × units — no prevClose
 *                 Falls back to Yahoo `change` field, then changePercent, then DB dailyChangePercent
 *   - Total P&L = currentValue − costBasis
 */

import { useMemo } from "react";
import { isTaseClosedToday, isUsMarketClosedNow, isUsWeekendOrHoliday } from "@/lib/marketStatus";
import {
  accountTodayPct,
  isPositionOpenedToday,
  positionTodayPnlFromEntry,
} from "@/lib/positionMath";

// ── Input types ────────────────────────────────────────────────────────────────

export interface H1Holding {
  ticker: string;
  units: number;
  buyPrice: number;
  currentPrice: number | null;
  dailyChangePercent?: number | null;
  /** 23:30 Israel time baseline price — authoritative "Today" baseline */
  dailyBasePrice?: number | null;
  /** Unix ms timestamp of the 23:30 snapshot */
  dailyBaseTs?: number | null;
  /** ISO string or Date — used to detect stale DB dailyChangePercent */
  priceUpdatedAt?: string | Date | null;
  /** IBKR unrealized P&L — uses actual fill avgCost, most accurate for intraday positions */
  ibkrUnrealizedPnl?: number | null;
  /** ISO date string YYYY-MM-DD — when position was opened (null = legacy/overnight) */
  transactionDate?: string | Date | null;
  /** Row created timestamp — fallback when transactionDate is null */
  createdAt?: string | Date | null;
}

export interface H2Holding {
  ticker: string;
  units: number;
  buyPrice: number;
  currentPrice: number | null;
  prevClose?: number | null;
  dailyChangePercent?: number | null;
  /** 23:30 Israel time baseline price — authoritative "Today" baseline */
  dailyBasePrice?: number | null;
  /** Unix ms timestamp of the 23:30 snapshot */
  dailyBaseTs?: number | null;
  /** ISO string or Date — used to detect stale DB dailyChangePercent */
  priceUpdatedAt?: string | Date | null;
  /** ISO date string YYYY-MM-DD — when position was opened */
  transactionDate?: string | Date | null;
  createdAt?: string | Date | null;
}

export interface LivePriceEntry {
  price: number | null;
  change?: number | null;
  changePercent?: number | null;
  prevClose?: number | null;
}

export interface IbkrAccountState {
  /** IBKR gross position value (sum of all positions at market price) */
  grossPositionValue?: number | null;
  /** IBKR net liquidation value (equity after margin) */
  netLiquidation?: number | null;
  /** IBKR today P&L (dailyPnL field) */
  dailyPnl?: number | null;
  /** IBKR total cash */
  totalCash?: number | null;
  /** Whether IBKR is currently live-connected */
  isLive?: boolean;
}

export interface PortfolioMetricsInput {
  h1Holdings: H1Holding[];
  h2Holdings: H2Holding[];
  h1LivePriceMap: Record<string, LivePriceEntry>;
  h2LivePriceMap: Record<string, LivePriceEntry>;
  ibkr?: IbkrAccountState | null;
  /** Cash balance from IBKR or DB fallback */
  cashBalance?: number;
}

// ── Output types ───────────────────────────────────────────────────────────────

export interface PortfolioMetrics {
  // H1
  h1TotalValue: number;
  h1TotalCost: number;
  h1TotalPnl: number;
  h1TotalPnlPct: number;
  /** null when IBKR is live but dailyPnl not yet available — show "—" in UI */
  h1TodayPnl: number | null;
  h1TodayPct: number | null;
  h1NLV: number;           // Net Liquidation Value (IBKR NLV or h1TotalValue + cash)
  h1Cash: number;
  h1Count: number;

  // H2
  h2TotalValue: number;
  h2TotalCost: number;
  h2TotalPnl: number;
  h2TotalPnlPct: number;
  h2TodayPnl: number | null;
  h2TodayPct: number | null;
  h2Count: number;

  // Unified (H1 NLV + H2)
  unifiedValue: number;
  /** null when IBKR is live but dailyPnl not yet available */
  unifiedTodayPnl: number | null;
  unifiedTodayPct: number | null;
  unifiedTotalPnl: number;
  unifiedTotalCost: number;
  unifiedTotalPnlPct: number;
}

// ── Helper: compute today P&L for a single position ─────────────────────────────────────────
// DUMB FRONTEND: backend PriceService already computed the correct change.
// Priority 1: live.change (from PriceService — correct for all market states)
// Priority 2: prevClose-based fallback (if live.change is null but prevClose available)
// Priority 3: DB-cached daily change percent
/** Returns true if the DB price was updated today (local calendar day). */
function isPriceUpdatedToday(priceUpdatedAt: string | Date | null | undefined): boolean {
  if (!priceUpdatedAt) return false;
  const updated = new Date(priceUpdatedAt);
  const today = new Date();
  return updated.getFullYear() === today.getFullYear()
    && updated.getMonth() === today.getMonth()
    && updated.getDate() === today.getDate();
}

function computeTodayPnl(
  units: number,
  buyPrice: number,
  currentPrice: number | null,
  live: LivePriceEntry | undefined,
  dbDailyChangePct: number | null | undefined,
  priceUpdatedAt?: string | Date | null,
  dailyBasePrice?: number | null,
  dailyBaseTs?: number | null,
  _ibkrUnrealizedPnl?: number | null,
  transactionDate?: string | Date | null,
  createdAt?: string | Date | null,
): number {
  const price = live?.price ?? currentPrice ?? buyPrice;

  // Entry-price override: positions opened today never use prevClose
  if (isPositionOpenedToday(transactionDate, createdAt)) {
    return positionTodayPnlFromEntry(price, buyPrice, units);
  }

  // Priority 1: IBKR live change $ — most accurate (0 is valid on a flat day)
  if (live?.change != null) {
    if (live.change !== 0) return live.change * units;
    // change=0 after TASE close may be server-stale; trust prevClose when price moved
    if (live.price != null && live.prevClose != null && live.prevClose > 0 && live.price !== live.prevClose) {
      return (live.price - live.prevClose) * units;
    }
    return 0;
  }
  // Priority 2: prevClose-based (when IBKR provides explicit prevClose)
  if (live?.price != null && live.prevClose != null && live.prevClose > 0) {
    return (live.price - live.prevClose) * units;
  }
  // Priority 3: changePercent — correctly captures overnight gaps (e.g. ENTG +15% gap)
  // dailyBasePrice snapshot at 23:30 IL can miss pre-market moves already baked in
  if (live?.changePercent != null && live.changePercent !== 0 && price > 0) {
    const prevCloseFromPct = price / (1 + live.changePercent / 100);
    return (price - prevCloseFromPct) * units;
  }
  // Priority 4: dailyBasePrice fallback — skip when IBKR quotes provide prevClose
  if (dailyBasePrice != null && dailyBasePrice > 0 && price > 0 && !live?.prevClose) {
    const snapshotAge = dailyBaseTs ? Date.now() - dailyBaseTs : Infinity;
    if (snapshotAge < 26 * 3600 * 1000) {
      return (price - dailyBasePrice) * units;
    }
  }
  // Priority 4: DB-cached daily change percent — ONLY if updated today (not stale)
  // If priceUpdatedAt is from a previous day (e.g. last Friday), the dailyChangePercent
  // is stale and must NOT be used, otherwise it shows Friday's change on Monday.
  if (dbDailyChangePct != null && dbDailyChangePct !== 0 && price > 0
      && isPriceUpdatedToday(priceUpdatedAt)) {
    const prevCloseEst = price / (1 + dbDailyChangePct / 100);
    return (price - prevCloseEst) * units;
  }
  return 0;
}

/** Exported for PortfolioOverview groupMetrics — keep in sync with hook. */
export { computeTodayPnl };

// ── Main hook ─────────────────────────────────────────────────────────────────

export function usePortfolioMetrics({
  h1Holdings,
  h2Holdings,
  h1LivePriceMap,
  h2LivePriceMap,
  ibkr,
  cashBalance = 0,
}: PortfolioMetricsInput): PortfolioMetrics {
  return useMemo(() => {
    // ── Market state detection ────────────────────────────────────────────────
    const usClosedNow = isUsMarketClosedNow();

    // ── H1 ──────────────────────────────────────────────────────────────────
    const h1Active = h1Holdings.filter(h => h.units !== 0);

    let h1TotalValue = 0;
    let h1TotalCost = 0;
    let h1TodayPnl = 0;

    for (const h of h1Active) {
      const live = h1LivePriceMap[h.ticker];
      const price = live?.price ?? h.currentPrice ?? h.buyPrice;
      const absUnits = Math.abs(h.units);
      // SHORT: value is negative (liability), LONG: value is positive
      h1TotalValue += price * h.units;
      // Cost: for LONG = what you paid; for SHORT = what you received (both positive for P&L calc)
      h1TotalCost  += h.buyPrice * absUnits;
      // H1 is all US stocks — skip Today PnL when US market is fully closed AND no live IBKR data.
      // If IBKR returns valid change data (after-hours/futures), show it regardless of market state.
      const hasLiveData = (live?.change != null && live.change !== 0)
        || (live?.changePercent != null && live.changePercent !== 0)
        || (live?.price != null && live.prevClose != null && live.prevClose > 0 && live.price !== live.prevClose);
      if (!usClosedNow || hasLiveData) {
        h1TodayPnl   += computeTodayPnl(h.units, h.buyPrice, h.currentPrice, live, h.dailyChangePercent, h.priceUpdatedAt, h.dailyBasePrice, h.dailyBaseTs, h.ibkrUnrealizedPnl, h.transactionDate, h.createdAt);
      }
    }

    // h1TotalValue now reflects net market value: longs positive, shorts negative
    const h1ValueDisplay = h1TotalValue;

    // P&L: for shorts, profit when price drops; for longs, profit when price rises
    const h1TotalPnl = h1Active.reduce((s, h) => {
      const live = h1LivePriceMap[h.ticker];
      const price = live?.price ?? h.currentPrice ?? h.buyPrice;
      const absUnits = Math.abs(h.units);
      const cost = h.buyPrice * absUnits;
      const val = price * absUnits;
      return s + (h.units < 0 ? cost - val : val - cost);
    }, 0);
    const h1TotalPnlPct = h1TotalCost > 0 ? (h1TotalPnl / h1TotalCost) * 100 : 0;

    // Today P&L for H1:
    //   Use sum-of-rows with dailyBasePrice as the single source of truth.
    //   dailyBasePrice is saved at 23:30 Israel (after US market close) and provides
    //   a reliable baseline for Today% calculation regardless of IBKR Gateway stale prior_close.
    const hasH1LivePrices = Object.keys(h1LivePriceMap).length > 0;
    // Account daily = IBKR /pnl when live (includes realized + commissions — matches IBKR mobile).
    // Per-ticker row sum (h1TodayPnl) is for table breakdown only.
    const h1TodayPnlFinal: number | null = (ibkr?.isLive || hasH1LivePrices)
      ? (ibkr?.isLive && ibkr.dailyPnl != null
          ? ibkr.dailyPnl
          : hasH1LivePrices
            ? h1TodayPnl
            : (ibkr?.dailyPnl ?? null))
      : null;
    // Account-level daily %: NLV denominator (correct for long+short mix).
    // Net exposure value understates equity when shorts are large → inflated %.
    const h1TodayPct: number | null = h1TodayPnlFinal != null
      ? (ibkr?.netLiquidation != null
          ? accountTodayPct(h1TodayPnlFinal, ibkr.netLiquidation)
          : (() => {
              const prevEquity = h1ValueDisplay - h1TodayPnlFinal;
              return Math.abs(prevEquity) > 0 ? (h1TodayPnlFinal / Math.abs(prevEquity)) * 100 : null;
            })())
      : null;

    // NLV: IBKR netLiquidation when live, else h1ValueDisplay + cash
    const h1NLV = ibkr?.isLive && ibkr.netLiquidation != null
      ? ibkr.netLiquidation
      : h1ValueDisplay + cashBalance;

    const h1Cash = ibkr?.isLive && ibkr.totalCash != null
      ? ibkr.totalCash
      : cashBalance;

    // ── H2 ──────────────────────────────────────────────────────────────────
    const h2Active = h2Holdings.filter(h => h.units !== 0);

    let h2TotalValue = 0;
    let h2TotalCost  = 0;
    let h2TodayPnl   = 0;

    const taseClosedNow = isTaseClosedToday();
    for (const h of h2Active) {
      const live = h2LivePriceMap[h.ticker];
      // ALWAYS prefer live price (IBKR when connected, else Yahoo SSE) — never fall back to stale DB currentPrice for value
      const price = live?.price ?? h.currentPrice ?? h.buyPrice;
      const absUnits = Math.abs(h.units);
      h2TotalValue += price * absUnits;
      h2TotalCost  += h.buyPrice * absUnits;
      // Skip today PnL based on market state:
      // - .TA tickers: on Sat/Sun/holiday skip only when no daily baseline
      // - US tickers: skip when US market fully closed AND no live IBKR data
      const isTaTicker = h.ticker.toUpperCase().endsWith('.TA');
      const isCryptoTicker = h.ticker.toUpperCase().endsWith('-USD');
      if (isTaTicker && taseClosedNow) {
        const hasDailyBaseline =
          live?.change != null
          || (live?.prevClose != null && live.prevClose > 0)
          || (live?.changePercent != null && live.changePercent !== 0)
          || (h.dailyBasePrice != null && h.dailyBasePrice > 0);
        if (!hasDailyBaseline) continue;
      }
      if (!isTaTicker && !isCryptoTicker && usClosedNow) {
        // Only skip if there's no live IBKR data for this ticker
        const hasLiveData = (live?.change != null && live.change !== 0)
          || (live?.changePercent != null && live.changePercent !== 0)
          || (live?.price != null && live.prevClose != null && live.prevClose > 0 && live.price !== live.prevClose);
        if (!hasLiveData) continue;
      }
      h2TodayPnl   += computeTodayPnl(h.units, h.buyPrice, h.currentPrice, live, h.dailyChangePercent, h.priceUpdatedAt, h.dailyBasePrice, h.dailyBaseTs, undefined, h.transactionDate, h.createdAt);
    }

    // P&L: for shorts, profit when price drops; for longs, profit when price rises
    const h2TotalPnl = h2Active.reduce((s, h) => {
      const live = h2LivePriceMap[h.ticker];
      const price = live?.price ?? h.currentPrice ?? h.buyPrice;
      const absUnits = Math.abs(h.units);
      const cost = h.buyPrice * absUnits;
      const val = price * absUnits;
      return s + (h.units < 0 ? cost - val : val - cost);
    }, 0);
    const h2TotalPnlPct = h2TotalCost > 0 ? (h2TotalPnl / h2TotalCost) * 100 : 0;
    // H2 has no IBKR dailyPnl — use Yahoo prevClose-based. Return null if no live prices.
    const h2TodayPnlFinal: number | null = Object.keys(h2LivePriceMap).length > 0 ? h2TodayPnl : null;
    const h2PrevEquity = h2TodayPnlFinal != null ? h2TotalValue - h2TodayPnlFinal : h2TotalValue;
    const h2TodayPct: number | null = h2TodayPnlFinal != null && h2PrevEquity > 0
      ? (h2TodayPnlFinal / h2PrevEquity) * 100
      : null;

    // ── Unified ─────────────────────────────────────────────────────────────
    // Definition: H1 NLV + H2 Total Value
    // This is the most accurate "real wealth" number:
    //   - H1 NLV = IBKR net liquidation (positions − margin/loans + cash)
    //   - H2 = fully invested, no margin
    const unifiedValue       = h1NLV + h2TotalValue;
    // Unified today P&L: null if either component is null (IBKR connected but no dailyPnl)
    const unifiedTodayPnl: number | null =
      h1TodayPnlFinal != null && h2TodayPnlFinal != null
        ? h1TodayPnlFinal + h2TodayPnlFinal
        : h1TodayPnlFinal != null
          ? h1TodayPnlFinal
          : null;
    const unifiedPrevEquity = unifiedTodayPnl != null ? unifiedValue - unifiedTodayPnl : unifiedValue;
    const unifiedTodayPct: number | null = unifiedTodayPnl != null && unifiedPrevEquity > 0
      ? (unifiedTodayPnl / unifiedPrevEquity) * 100
      : null;
    const unifiedTotalCost   = h1TotalCost + h2TotalCost;
    const unifiedTotalPnl    = h1TotalPnl + h2TotalPnl;
    const unifiedTotalPnlPct = unifiedTotalCost > 0 ? (unifiedTotalPnl / unifiedTotalCost) * 100 : 0;

    return {
      h1TotalValue: h1ValueDisplay,
      h1TotalCost,
      h1TotalPnl,
      h1TotalPnlPct,
      h1TodayPnl: h1TodayPnlFinal,
      h1TodayPct,
      h1NLV,
      h1Cash,
      h1Count: h1Active.length,

      h2TotalValue,
      h2TotalCost,
      h2TotalPnl,
      h2TotalPnlPct,
      h2TodayPnl: h2TodayPnlFinal,
      h2TodayPct,
      h2Count: h2Active.length,

      unifiedValue,
      unifiedTodayPnl,
      unifiedTodayPct,
      unifiedTotalPnl,
      unifiedTotalCost,
      unifiedTotalPnlPct,
    };
  }, [h1Holdings, h2Holdings, h1LivePriceMap, h2LivePriceMap, ibkr, cashBalance]);
}
