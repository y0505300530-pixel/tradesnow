/**
 * positionDisplay — server SSOT for position-level price / daily P&L display.
 *
 * Model: direction + abs(units) — matches livePositions / War Room.
 * Formulas mirror client positionMath.ts (signed units = short ? -abs : +abs).
 */

export type PositionDirection = "long" | "short";

export function signedUnits(direction: PositionDirection, units: number): number {
  const abs = Math.abs(units);
  return direction === "short" ? -abs : abs;
}

/** Signed market value (long +, short −) */
export function signedMarketValue(
  direction: PositionDirection,
  units: number,
  markPrice: number,
): number {
  return markPrice * signedUnits(direction, units);
}

/** Today P&L $ — stock change × signed units */
export function positionDailyPnlUsd(
  direction: PositionDirection,
  units: number,
  opts: {
    dailyChange?: number | null;
    markPrice?: number | null;
    prevClose?: number | null;
    dailyPctStock?: number | null;
  },
): number | null {
  const signed = signedUnits(direction, units);
  if (opts.dailyChange != null) {
    return opts.dailyChange * signed;
  }
  const mark = opts.markPrice ?? 0;
  const prev = opts.prevClose ?? 0;
  if (mark > 0 && prev > 0) {
    return (mark - prev) * signed;
  }
  if (opts.dailyPctStock != null && opts.dailyPctStock !== 0 && mark > 0) {
    const prevEst = mark / (1 + opts.dailyPctStock / 100);
    return (mark - prevEst) * signed;
  }
  return null;
}

/** Today P&L % for the position (not raw stock CHG%) */
export function positionDailyPct(
  dailyPnlUsd: number | null,
  prevClose: number | null | undefined,
  direction: PositionDirection,
  units: number,
): number | null {
  if (dailyPnlUsd == null) return null;
  const base = (prevClose ?? 0) * Math.abs(units);
  return base > 0 ? +((dailyPnlUsd / base) * 100).toFixed(2) : null;
}

export function enrichPositionDisplay(pos: {
  direction: PositionDirection;
  units: number;
  entryPrice?: number;
  currentPrice?: number | null;
  dailyChange?: number | null;
  dailyPct?: number | null;
  prevClose?: number | null;
  mktValue?: number | null;
}): {
  marketValueSigned: number;
  dailyPnlUsd: number | null;
  dailyPctPosition: number | null;
  dailyPctStock: number | null;
} {
  const mark = pos.currentPrice ?? 0;
  const prevClose = pos.prevClose ?? null;
  const stockPct =
    pos.dailyPct != null
      ? pos.dailyPct
      : mark > 0 && prevClose && prevClose > 0
        ? +(((mark - prevClose) / prevClose) * 100).toFixed(2)
        : null;

  const marketValueSigned =
    pos.mktValue != null && pos.mktValue !== 0
      ? pos.mktValue
      : mark > 0
        ? signedMarketValue(pos.direction, pos.units, mark)
        : 0;

  const dailyPnlUsd = positionDailyPnlUsd(pos.direction, pos.units, {
    dailyChange: pos.dailyChange,
    markPrice: mark,
    prevClose,
    dailyPctStock: stockPct,
  });
  const dailyPctPosition = positionDailyPct(dailyPnlUsd, prevClose, pos.direction, pos.units);

  return {
    marketValueSigned,
    dailyPnlUsd,
    dailyPctPosition,
    dailyPctStock: stockPct,
  };
}
