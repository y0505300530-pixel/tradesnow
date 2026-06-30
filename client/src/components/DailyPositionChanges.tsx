/**
 * DailyPositionChangesSection — Collapsible section showing today's position changes
 * (opened, closed, increased, reduced) detected during IBKR sync.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Activity, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const changeTypeLabel: Record<string, string> = {
  opened: "➕ Opened",
  closed: "❌ Closed",
  increased: "⬆️ Increased",
  reduced: "⬇️ Reduced",
};

const changeTypeColor: Record<string, string> = {
  opened: "text-[#2563EB]",
  closed: "text-[#FF6B6B]",
  increased: "text-[#65A30D]",
  reduced: "text-[#F59E0B]",
};

export function DailyPositionChangesSection() {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading } = trpc.portfolio.getDailyPositionChanges.useQuery(
    {},
    { staleTime: 30_000, refetchInterval: 60_000 }
  );

  const changes = data?.changes ?? [];

  const totalRealized = changes.reduce((sum, c) => sum + (c.realizedPnl ?? 0), 0);
  const hasRealized = changes.some(c => c.realizedPnl != null && c.realizedPnl !== 0);

  return (
    <div className="mx-2 mt-4">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl border border-[#2563EB]/30 bg-white shadow-sm hover:shadow-md transition-all"
      >
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-[#2563EB]" />
          <span className="font-semibold text-sm text-gray-800">
            שינויי היום
          </span>
          {changes.length > 0 && (
            <span className="bg-[#2563EB] text-white text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
              {changes.length}
            </span>
          )}
          {hasRealized && (
            <span className={cn(
              "text-xs font-semibold ml-1",
              totalRealized >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"
            )}>
              P&L: {totalRealized >= 0 ? "+" : ""}
              ${Math.abs(totalRealized).toLocaleString("en-US", { maximumFractionDigits: 0 })}
            </span>
          )}
        </div>
        <ChevronDown className={cn(
          "w-4 h-4 text-gray-400 transition-transform",
          expanded && "rotate-180"
        )} />
      </button>

      {expanded && (
        <div className="mt-2 rounded-xl border border-[#2563EB]/20 bg-white shadow-sm overflow-hidden">
          {isLoading ? (
            <div className="px-4 py-6 text-center text-sm text-gray-400">Loading...</div>
          ) : changes.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-gray-400">
              אין שינויים היום
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {changes.map((c) => (
                <div key={c.id} className="px-3 py-2.5 flex items-center gap-3">
                  {/* Change type badge */}
                  <div className={cn(
                    "text-xs font-bold whitespace-nowrap min-w-[80px]",
                    changeTypeColor[c.changeType] ?? "text-gray-600"
                  )}>
                    {changeTypeLabel[c.changeType] ?? c.changeType}
                  </div>

                  {/* Ticker */}
                  <div className="font-bold text-sm text-gray-800 min-w-[60px]">
                    {c.ticker}
                  </div>

                  {/* Units change */}
                  <div className="flex-1 text-xs text-gray-500">
                    {c.unitsBefore.toFixed(0)} → {c.unitsAfter.toFixed(0)}
                    <span className={cn(
                      "ml-1 font-semibold",
                      c.unitsDelta > 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"
                    )}>
                      ({c.unitsDelta > 0 ? "+" : ""}{c.unitsDelta.toFixed(0)})
                    </span>
                  </div>

                  {/* Price at change */}
                  {c.marketPriceAtChange != null && (
                    <div className="text-xs text-gray-400">
                      @${c.marketPriceAtChange.toFixed(2)}
                    </div>
                  )}

                  {/* Realized P&L */}
                  {c.realizedPnl != null && c.realizedPnl !== 0 && (
                    <div className={cn(
                      "text-xs font-semibold min-w-[60px] text-right",
                      c.realizedPnl >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"
                    )}>
                      {c.realizedPnl >= 0 ? "+" : ""}${Math.abs(c.realizedPnl).toLocaleString("en-US", { maximumFractionDigits: 0 })}
                    </div>
                  )}

                  {/* Time */}
                  <div className="text-[10px] text-gray-300 whitespace-nowrap">
                    {new Date(c.detectedAt).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
