/** Total realized P&L for a closed live position (final leg + any prior partial). */
export function totalClosedPnl(pos: {
  realizedPnl?: number | null;
  partialRealizedPnl?: number | null;
}): number {
  return (pos.realizedPnl ?? 0) + (pos.partialRealizedPnl ?? 0);
}

/** Final-leg P&L from exit fill (excludes prior partialRealizedPnl). */
export function finalLegPnl(
  direction: "long" | "short",
  entryPrice: number,
  exitPrice: number,
  units: number,
): number {
  return direction === "long"
    ? (exitPrice - entryPrice) * units
    : (entryPrice - exitPrice) * units;
}

/** $1 noise floor — avoids rounding / stale-price false BE buckets. */
export const BE_PNL_THRESHOLD_USD = 1;

export type TradeOutcome = "win" | "loss" | "breakeven";

export function classifyTradeOutcome(
  totalPnl: number,
  thresholdUsd = BE_PNL_THRESHOLD_USD,
): TradeOutcome {
  if (totalPnl > thresholdUsd) return "win";
  if (totalPnl < -thresholdUsd) return "loss";
  return "breakeven";
}

export function computeMonthlyWinStats(
  closed: Array<{ realizedPnl?: number | null; partialRealizedPnl?: number | null }>,
): {
  winners: number;
  losers: number;
  breakeven: number;
  total: number;
  decided: number;
  winRate: number;
} {
  let winners = 0;
  let losers = 0;
  let breakeven = 0;

  for (const p of closed) {
    const outcome = classifyTradeOutcome(totalClosedPnl(p));
    if (outcome === "win") winners++;
    else if (outcome === "loss") losers++;
    else breakeven++;
  }

  const total = closed.length;
  const decided = winners + losers;
  const winRate = decided > 0 ? Math.round((winners / decided) * 100) : 0;

  return { winners, losers, breakeven, total, decided, winRate };
}
