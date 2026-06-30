/**
 * positionMath — short/long aware P&L helpers (SSOT for Holdings UI)
 *
 * IBKR shorts: units < 0. Market value is signed (short = negative liability).
 * Cost basis and return % always use |units| so shorts don't invert denominators.
 */

export function absUnits(units: number): number {
  return Math.abs(units);
}

export function isShortPosition(units: number): boolean {
  return units < 0;
}

/** Signed market value (long +, short −) */
export function positionValue(price: number, units: number): number {
  return price * units;
}

/** Capital deployed — always positive */
export function positionCost(buyPrice: number, units: number): number {
  return buyPrice * absUnits(units);
}

/** Unrealized P&L in dollars */
export function positionTotalPnl(price: number, buyPrice: number, units: number): number {
  const abs = absUnits(units);
  return units < 0 ? (buyPrice - price) * abs : (price - buyPrice) * abs;
}

/** Total return % on capital deployed */
export function positionTotalPct(price: number, buyPrice: number, units: number): number {
  const cost = positionCost(buyPrice, units);
  return cost > 0 ? (positionTotalPnl(price, buyPrice, units) / cost) * 100 : 0;
}

/** Today P&L $ — stock change × signed units (short flips sign automatically) */
export function positionTodayDollarFromChange(change: number, units: number): number {
  return change * units;
}

/**
 * Today P&L % for the POSITION (not raw stock CHG%).
 * Example: stock −4%, short position → +4% on capital at risk.
 */
export function positionTodayPct(
  todayDollar: number,
  prevClose: number,
  units: number,
): number | null {
  const base = prevClose * absUnits(units);
  return base > 0 ? (todayDollar / base) * 100 : null;
}

/** Account-level daily % — use NLV denominator (correct for long+short mix) */
export function accountTodayPct(dailyPnl: number, netLiquidation: number): number | null {
  const prevNlv = netLiquidation - dailyPnl;
  return prevNlv > 0 ? (dailyPnl / prevNlv) * 100 : null;
}

/** Local calendar YYYY-MM-DD (not UTC) — matches UI "today" semantics. */
export function toLocalYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function dateToYmd(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) return toLocalYmd(value);
  return null;
}

/**
 * Position opened today if transactionDate == today, else createdAt == today.
 */
export function isPositionOpenedToday(
  transactionDate?: string | Date | null,
  createdAt?: string | Date | null,
): boolean {
  const today = toLocalYmd(new Date());
  const tx = dateToYmd(transactionDate);
  if (tx === today) return true;
  const created = dateToYmd(createdAt);
  return created === today;
}

/**
 * Today P&L for positions opened today — (currentPrice − entryPrice) × units.
 * Signed units: shorts (units < 0) flip P&L automatically.
 */
export function positionTodayPnlFromEntry(
  currentPrice: number,
  entryPrice: number,
  units: number,
): number {
  return (currentPrice - entryPrice) * units;
}

/** Net portfolio equity at prior close (sum of signed position values) */
export function netEquityAtPrevClose(
  holdings: { units: number; prevClose: number }[],
): number {
  return holdings.reduce((s, h) => s + h.prevClose * h.units, 0);
}
