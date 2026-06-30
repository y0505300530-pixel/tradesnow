/**
 * LastUpdateRefreshButton — unified refresh + LAST UPDATE timestamp
 */
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatLastUpdate } from "@/lib/formatLastUpdate";

interface Props {
  onRefresh: () => void | Promise<void>;
  refreshing?: boolean;
  lastUpdated: Date | null;
  className?: string;
  /** vertical stack for narrow headers */
  compact?: boolean;
}

export function LastUpdateRefreshButton({
  onRefresh,
  refreshing = false,
  lastUpdated,
  className,
  compact = false,
}: Props) {
  return (
    <div className={cn("flex items-center gap-2 shrink-0", className)}>
      <div className={cn("text-right leading-tight", compact ? "hidden sm:block" : "")}>
        <div className="text-[9px] font-semibold uppercase tracking-wider text-gray-400">
          Last Update
        </div>
        <div className="text-[11px] font-mono tabular-nums text-gray-600 whitespace-nowrap">
          {formatLastUpdate(lastUpdated)}
        </div>
      </div>
      <button
        type="button"
        onClick={() => void onRefresh()}
        disabled={refreshing}
        className={cn(
          "p-2 rounded-full transition-colors text-[#2563EB]",
          "hover:bg-[#2563EB]/15 disabled:opacity-50 disabled:cursor-not-allowed",
        )}
        aria-label="Refresh prices"
        title="רענן מחירים לכל התיקים"
      >
        <RefreshCw className={cn("w-5 h-5", refreshing && "animate-spin")} />
      </button>
    </div>
  );
}
