/**
 * RefreshControl — Unified IBKR Refresh Button + Last Updated Timestamp
 *
 * Displays:
 *  - A "Refresh Prices" button with loading spinner
 *  - "Last Updated: HH:MM:SS" label (updates every second via live clock)
 *  - "IBKR live" source badge
 *
 * When clicked, triggers a simultaneous refresh of ALL IBKR quote queries
 * (H1, H2, Catalogue) via IbkrRefreshContext.
 *
 * Usage:
 *   <RefreshControl ibkrConnected={ibkrConnected} />
 */

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIbkrRefresh } from "@/contexts/IbkrRefreshContext";
import { cn } from "@/lib/utils";

interface RefreshControlProps {
  ibkrConnected: boolean;
  className?: string;
  /** compact: show only icon + time, no full label */
  compact?: boolean;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function RefreshControl({ ibkrConnected, className, compact = false }: RefreshControlProps) {
  const { lastUpdated, isRefreshing, triggerRefresh } = useIbkrRefresh();
  const [, setTick] = useState(0);

  // Tick every second so the "X seconds ago" display stays live
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const timeLabel = lastUpdated ? formatTime(lastUpdated) : null;

  if (!ibkrConnected) return null;

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Button
        variant="outline"
        size="sm"
        onClick={() => triggerRefresh()}
        disabled={isRefreshing}
        className="h-7 px-2 text-xs gap-1.5 border-emerald-500/30 text-[#65A30D] hover:text-emerald-300 hover:bg-emerald-500/10"
      >
        <RefreshCw
          className={cn("h-3 w-3", isRefreshing && "animate-spin")}
        />
        {!compact && (isRefreshing ? "מרענן..." : "רענן מחירים")}
      </Button>

      {timeLabel && (
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {compact ? timeLabel : `עודכן: ${timeLabel}`}
        </span>
      )}
    </div>
  );
}
