/**
 * ScoreBadge — Ziv Engine Score display badge
 *
 * Extracted from TradeManager.tsx as part of the modular refactoring (Step 3).
 * Displays a color-coded badge for a numeric Ziv Engine score (0–10).
 */

export function ScoreBadge({ score }: { score: number | null }) {
  if (score === null || score === undefined)
    return <span className="text-muted-foreground text-xs">—</span>;

  const bg =
    score >= 8
      ? "bg-emerald-50 text-emerald-700 border-emerald-300"
      : score >= 6
      ? "bg-blue-100 text-blue-700 border-blue-200"
      : score >= 4
      ? "bg-amber-50 text-amber-700 border-amber-300"
      : "bg-red-50 text-red-700 border-red-300";

  // Always show 2 decimal places (e.g. 8.47, 9.00)
  const display = typeof score === "number" ? score.toFixed(2) : score;

  return (
    <span
      className={`inline-flex items-center justify-center min-w-[3rem] h-6 px-1.5 rounded text-xs font-bold border ${bg}`}
    >
      {display}
    </span>
  );
}
