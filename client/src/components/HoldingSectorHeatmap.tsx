import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

const SECTOR_ICONS: Record<string, string> = {
  "Mag 7": "🏛️", "Chips & Hardware": "🔧", "Software, Cloud & Cyber": "☁️",
  "AI / Data": "🤖", "Crypto / Fin": "₿", "Finance": "🏦", "Healthcare": "💊",
  "EV / Auto": "🚗", "Space": "🚀", "Defense Tech": "🛡️", "Quantum": "⚛️",
  "Nuclear": "☢️", "Energy": "⚡", "Industrials": "🏗️", "Defense": "🎖️",
  "Media": "🎬", "Social Media": "📱", "Cybersecurity": "🔒", "SaaS": "💻",
  "E-Commerce": "🛒", "Technology": "💡", "Shipping": "🚢", "EdTech": "📚",
  "Ad Tech": "📣", "Fintech": "💳", "TASE": "🇮🇱", "Other": "📊",
};

function getHeatColors(avgPct: number) {
  if (avgPct > 1.5) return { bg: "bg-emerald-100", border: "border-emerald-400", text: "text-emerald-800" };
  if (avgPct > 0.3) return { bg: "bg-green-50", border: "border-green-300", text: "text-green-700" };
  if (avgPct > -0.3) return { bg: "bg-gray-50", border: "border-gray-200", text: "text-gray-700" };
  if (avgPct > -1.5) return { bg: "bg-red-50", border: "border-red-300", text: "text-red-700" };
  return { bg: "bg-red-100", border: "border-red-400", text: "text-red-800" };
}

function formatHeatPnl(n: number): string {
  const prefix = n >= 0 ? "+$" : "-$";
  return `${prefix}${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function SectorRow({
  title,
  sectors,
}: {
  title: string;
  sectors: Array<{ sector: string; totalPnl: number; totalValue: number; avgDailyPct: number; positionCount: number }>;
}) {
  if (!sectors || sectors.length === 0) return null;
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{title}</span>
        <span className="text-[9px] text-gray-400">{sectors.reduce((s, x) => s + x.positionCount, 0)} positions</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5">
        {sectors.map((s) => {
          const icon = SECTOR_ICONS[s.sector] || "📊";
          const colors = getHeatColors(s.avgDailyPct);
          return (
            <div
              key={s.sector}
              className={cn("rounded-lg border p-2 text-left transition-all", colors.bg, colors.border)}
            >
              <div className="flex items-center gap-1 mb-0.5">
                <span className="text-xs">{icon}</span>
                <span className={cn("text-[10px] font-bold truncate", colors.text)}>{s.sector}</span>
              </div>
              <div className="text-[9px] text-gray-500 font-mono">{s.positionCount} pos</div>
              <div className={cn(
                "text-[10px] font-bold font-mono",
                s.totalPnl >= 0 ? "text-emerald-600" : "text-red-600",
              )}>
                {formatHeatPnl(s.totalPnl)}
              </div>
              {s.avgDailyPct !== 0 && (
                <div className={cn(
                  "text-[8px] font-bold font-mono mt-0.5 inline-block px-1 py-0.5 rounded",
                  s.avgDailyPct >= 0 ? "bg-emerald-200/60 text-emerald-700" : "bg-red-200/60 text-red-700",
                )}>
                  {s.avgDailyPct >= 0 ? "+" : ""}{s.avgDailyPct.toFixed(1)}%
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function HoldingSectorHeatmap({ className }: { className?: string }) {
  const { data, isLoading } = trpc.sectorConfig.getHoldingSectorHeatmap.useQuery(undefined, {
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  if (isLoading) {
    return (
      <div className={cn("rounded-xl border border-border/50 bg-card p-4", className)}>
        <div className="h-32 rounded-lg bg-secondary animate-pulse" />
      </div>
    );
  }

  if (!data) return null;

  const hasData = (data.h1.length > 0 || data.h2Usa.length > 0 || data.h2Tase.length > 0);
  if (!hasData) return null;

  return (
    <div className={cn("rounded-xl border border-border/50 bg-card p-4", className)}>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm font-bold text-foreground">Sector Heatmap</span>
        <span className="text-[10px] text-muted-foreground">by holding</span>
      </div>
      <SectorRow title="Holding 1" sectors={data.h1} />
      <SectorRow title="H2 USA" sectors={data.h2Usa} />
      <SectorRow title="H2 TASE" sectors={data.h2Tase} />
    </div>
  );
}
