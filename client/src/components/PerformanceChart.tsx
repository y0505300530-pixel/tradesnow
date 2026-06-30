/**
 * PerformanceChart — Portfolio P&L performance chart for the Trade Manager.
 * Shows per-holding performance bars and portfolio-level P&L summary.
 */
import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, Cell,
} from "recharts";
import { TrendingUp, TrendingDown, Loader2, BarChart2 } from "lucide-react";

// ─── Colour helpers ───────────────────────────────────────────────────────────
const GREEN = "#10b981";
const RED = "#ef4444";

function pnlColor(pct: number) {
  if (pct >= 10) return GREEN;
  if (pct >= 0) return "#34d399";
  if (pct >= -10) return "#f87171";
  return RED;
}

// ─── Custom Tooltip ───────────────────────────────────────────────────────────
function CustomBarTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-card border border-border rounded-lg shadow-xl p-3 text-xs min-w-[180px]">
      <div className="font-bold text-sm mb-2 font-mono">{d.ticker}</div>
      {d.company && <div className="text-muted-foreground mb-2 truncate max-w-[200px]">{d.company}</div>}
      <div className="space-y-1">
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Buy Price</span>
          <span className="font-mono font-medium">${d.buyPrice?.toFixed(2)}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Current</span>
          <span className="font-mono font-medium">${d.currentPrice?.toFixed(2)}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">P&L $</span>
          <span className={`font-mono font-bold ${d.pnlUsd >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
            {d.pnlUsd >= 0 ? '+' : ''}${d.pnlUsd?.toFixed(0)}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">P&L %</span>
          <span className={`font-mono font-bold ${d.pnlPct >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
            {d.pnlPct >= 0 ? '+' : ''}{d.pnlPct?.toFixed(2)}%
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Units</span>
          <span className="font-mono">{d.units}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Days held</span>
          <span className="font-mono">{d.daysHeld}d</span>
        </div>
        {d.stopLoss && (
          <div className="flex justify-between gap-4 border-t pt-1 mt-1">
            <span className="text-muted-foreground">Stop Loss</span>
            <span className="font-mono text-[#FF6B6B]">${Number(d.stopLoss).toFixed(2)}</span>
          </div>
        )}
        {d.takeProfit && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Take Profit</span>
            <span className="font-mono text-[#65A30D]">${Number(d.takeProfit).toFixed(2)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export function PerformanceChart() {
  const { data: holdingPerf, isLoading } = trpc.performance.getHoldingPerformance.useQuery();

  const chartData = useMemo(() => {
    if (!holdingPerf) return [];
    return holdingPerf.map(h => ({
      ...h,
      pnlPctDisplay: parseFloat(h.pnlPct.toFixed(2)),
    }));
  }, [holdingPerf]);

  // Portfolio summary stats
  const summary = useMemo(() => {
    if (!holdingPerf || holdingPerf.length === 0) return null;
    const totalCost = holdingPerf.reduce((s, h) => s + h.cost, 0);
    const totalValue = holdingPerf.reduce((s, h) => s + h.value, 0);
    const totalPnlUsd = totalValue - totalCost;
    const totalPnlPct = totalCost > 0 ? (totalPnlUsd / totalCost) * 100 : 0;
    const winners = holdingPerf.filter(h => h.pnlPct > 0).length;
    const losers = holdingPerf.filter(h => h.pnlPct < 0).length;
    const bestPerformer = holdingPerf[0]; // already sorted desc
    const worstPerformer = holdingPerf[holdingPerf.length - 1];
    return { totalCost, totalValue, totalPnlUsd, totalPnlPct, winners, losers, bestPerformer, worstPerformer };
  }, [holdingPerf]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin mr-2" />
        Loading performance data...
      </div>
    );
  }

  if (!holdingPerf || holdingPerf.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <BarChart2 className="h-12 w-12 mx-auto mb-3 opacity-20" />
        <p className="font-medium">No holdings to display</p>
        <p className="text-sm mt-1">Add holdings to see performance charts</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 px-3 pb-3 pt-1">
      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="border-0 shadow-sm">
            <CardContent className="pt-3 pb-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Total P&L</p>
              <p className={`text-xl font-bold mt-0.5 ${summary.totalPnlUsd >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                {summary.totalPnlUsd >= 0 ? '+' : ''}${summary.totalPnlUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </p>
              <p className={`text-xs mt-0.5 ${summary.totalPnlPct >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                {summary.totalPnlPct >= 0 ? '+' : ''}{summary.totalPnlPct.toFixed(2)}%
              </p>
            </CardContent>
          </Card>
          <Card className="border-0 shadow-sm">
            <CardContent className="pt-3 pb-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Win Rate</p>
              <p className="text-xl font-bold mt-0.5">
                {holdingPerf.length > 0 ? Math.round(summary.winners / holdingPerf.length * 100) : 0}%
              </p>
              <p className="text-xs mt-0.5 text-muted-foreground">
                {summary.winners}W / {summary.losers}L
              </p>
            </CardContent>
          </Card>
          <Card className="border-0 shadow-sm bg-emerald-50">
            <CardContent className="pt-3 pb-3">
              <p className="text-[10px] text-[#65A30D] uppercase tracking-wide font-medium flex items-center gap-1">
                <TrendingUp className="h-3 w-3" />Best
              </p>
              <p className="text-lg font-bold mt-0.5 text-[#65A30D] font-mono">{summary.bestPerformer.ticker}</p>
              <p className="text-xs mt-0.5 text-[#65A30D] font-medium">
                +{summary.bestPerformer.pnlPct.toFixed(2)}%
              </p>
            </CardContent>
          </Card>
          <Card className="border-0 shadow-sm bg-red-50">
            <CardContent className="pt-3 pb-3">
              <p className="text-[10px] text-red-700 uppercase tracking-wide font-medium flex items-center gap-1">
                <TrendingDown className="h-3 w-3" />Worst
              </p>
              <p className="text-lg font-bold mt-0.5 text-red-700 font-mono">{summary.worstPerformer.ticker}</p>
              <p className="text-xs mt-0.5 text-[#FF6B6B] font-medium">
                {summary.worstPerformer.pnlPct.toFixed(2)}%
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* P&L Bar Chart */}
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-1 pt-2 px-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <BarChart2 className="h-4 w-4 text-[#2563EB]" />
            P&L per Position (%)
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-2 px-3">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
              <XAxis
                dataKey="ticker"
                tick={{ fontSize: 11, fontFamily: "monospace", fontWeight: 600 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={v => `${v}%`}
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                width={45}
              />
              <Tooltip content={<CustomBarTooltip />} />
              <ReferenceLine y={0} stroke="#9ca3af" strokeWidth={1.5} />
              <Bar dataKey="pnlPctDisplay" radius={[4, 4, 0, 0]} maxBarSize={60}>
                {chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={pnlColor(entry.pnlPct)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>


    </div>
  );
}
