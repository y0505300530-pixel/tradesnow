/**
 * ShortLiabilityHint — Hebrew copy for IBKR short positions (units < 0).
 * Liability = |signed market value| — shares owed to the broker.
 */
import { cn } from "@/lib/utils";
import { isShortPosition } from "@/lib/positionMath";

export function shortLiabilityUsd(value: number, units: number): number | null {
  if (!isShortPosition(units)) return null;
  return Math.abs(value);
}

export function aggregateShortLiability(
  items: { units: number; value: number }[],
): { count: number; total: number } {
  let count = 0;
  let total = 0;
  for (const item of items) {
    const liability = shortLiabilityUsd(item.value, item.units);
    if (liability != null) {
      count += 1;
      total += liability;
    }
  }
  return { count, total };
}

function fmtUsdLiability(v: number): string {
  return `$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export interface ShortLiabilityHintProps {
  units: number;
  value: number;
  /** Smaller inline hint (rows) vs subtitle block */
  compact?: boolean;
  /** Show "חשיפת שורט" under signed negative value */
  showValueLabel?: boolean;
  className?: string;
}

/** Per-row hint under value column */
export function ShortLiabilityHint({
  units,
  value,
  compact = false,
  showValueLabel = false,
  className,
}: ShortLiabilityHintProps) {
  if (!isShortPosition(units)) return null;

  return (
    <div
      className={cn("text-rose-600", compact ? "text-[10px] leading-tight" : "text-xs", className)}
      dir="rtl"
      title="פוזיציית שורט — חייבות להחזיר מניות לברוקר"
    >
      {showValueLabel && (
        <div className={cn("font-medium", compact ? "text-[9px]" : "text-[10px]")}>חשיפת שורט</div>
      )}
      <span>חייבות לברוקר</span>
    </div>
  );
}

/** Footer / card summary for multiple shorts */
export function ShortLiabilitySummary({
  count,
  total,
  className,
  prefix = "התחייבות שורט לברוקר",
}: {
  count: number;
  total: number;
  className?: string;
  /** e.g. "שורטים: X התחייבות לברוקר" vs "התחייבות שורט לברוקר" */
  prefix?: string;
}) {
  if (count <= 0 || total <= 0) return null;

  return (
    <div
      className={cn("text-xs text-rose-600 font-medium", className)}
      dir="rtl"
      title="סכום חשיפת השורט — מניות שחייבים להחזיר לברוקר"
    >
      {prefix}: −{fmtUsdLiability(total)}
    </div>
  );
}

/** Overview H1 row sublabel + optional count badge */
export function ShortLiabilityRowBadge({
  count,
  className,
}: {
  count: number;
  className?: string;
}) {
  if (count <= 0) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 mt-0.5", className)} dir="rtl">
      <span className="text-[10px] text-rose-600 leading-tight">כולל שורט — חייבות לברוקר</span>
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-100 text-rose-700 leading-none">
        {count} שורט
      </span>
    </div>
  );
}
