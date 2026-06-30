/**
 * H1H2Dashboard
 *
 * v17.00 — UI Diet:
 *   Removed: Bar Chart, Donut Chart, ILS Header row.
 *   New layout: Vitals → H1/H2 cards → Equity Curve → Top/Bottom 5 → Weight Table.
 *   ALL data fetching and math delegated to usePortfolioAnalytics (SSOT).
 */
import { useState, useMemo, lazy, Suspense } from "react";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
const PortfolioPerformanceChart = lazy(() =>
  import("@/components/PortfolioPerformanceChart").then((m) => ({ default: m.PortfolioPerformanceChart })),
);
import {
  TrendingUp, TrendingDown, DollarSign, BarChart2,
  ArrowUpDown, ArrowUp, ArrowDown, Search,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshControl } from "@/components/RefreshControl";
import { HoldingSectorHeatmap } from "@/components/HoldingSectorHeatmap";
import { usePortfolioAnalytics } from "@/hooks/usePortfolioAnalytics";
import { ShortLiabilityHint } from "@/components/ShortLiabilityHint";
import { isShortPosition } from "@/lib/positionMath";

// ── helpers ───────────────────────────────────────────────────────────────────
function fmt(n: number, decimals = 2) {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtPct(n: number) {
  return (n >= 0 ? "+" : "") + fmt(n, 2) + "%";
}
function fmtSignedUsd(n: number) {
  const abs = fmt(Math.abs(n), 0);
  return n < 0 ? `-$${abs}` : `$${abs}`;
}
function fmtUsd(n: number) {
  return "$" + fmt(Math.abs(n), 0);
}
function fmtPnlUsd(n: number) {
  return (n < 0 ? "-" : "+") + "$" + fmt(Math.abs(n), 0);
}

// ── summary card ─────────────────────────────────────────────────────────────
function SummaryCard({ title, value, sub, icon: Icon, positive }: {
  title: string; value: string; sub?: string; icon: React.ElementType; positive?: boolean;
}) {
  return (
    <div
      className="rounded-xl"
      style={{
        background: 'linear-gradient(135deg, #FFFFFF 0%, #F4F6F8 100%)',
        border: '1px solid rgba(37,99,235,0.30)',
        boxShadow: '0 0 20px rgba(37,99,235,0.08)',
      }}
    >
      <div className="pt-5 pb-4 px-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide mb-1" style={{ color: 'rgba(37,99,235,0.65)' }}>{title}</p>
            <p className={`text-2xl font-bold ${positive === undefined ? 'text-gray-800' : positive ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>{value}</p>
            {sub && <p className={`text-xs mt-1 ${positive === undefined ? 'text-gray-500' : positive ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>{sub}</p>}
          </div>
          <div className={`p-2 rounded-lg ${positive === undefined ? 'bg-gray-100' : positive ? 'bg-emerald-100' : 'bg-red-100'}`}>
            <Icon className={`w-5 h-5 ${positive === undefined ? 'text-gray-500' : positive ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── sortable weight table ─────────────────────────────────────────────────────
type SortKey = "ticker" | "value" | "pnl" | "pnlPct" | "weight" | "todayPnl" | "zivScore";

interface WeightRow {
  ticker: string;
  company: string;
  cost: number;
  value: number;
  units: number;
  pnl: number;
  pnlPct: number;
  todayPnl: number;
  source: string;
  weight: number;
  zivScore: number | null;
}

function WeightTableInline({ rows, totals, totalValue, onTickerClick, onDeepAnalysis }: {
  rows: WeightRow[];
  totals: { totalValue: number; totalCost: number; totalPnl: number; totalPnlPct: number; todayPnl: number | null };
  totalValue: number;
  onTickerClick?: (r: WeightRow) => void;
  onDeepAnalysis?: (ticker: string) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("weight");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const av = a[sortKey] as number | string | null;
      const bv = b[sortKey] as number | string | null;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === "string" ? (av as string).localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [rows, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  function SortIcon({ k }: { k: SortKey }) {
    if (sortKey !== k) return <ArrowUpDown className="w-3 h-3 opacity-40" />;
    return sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />;
  }

  return (
    <div className="rounded-xl overflow-hidden" style={{ background: '#FFFFFF', border: '1px solid rgba(37,99,235,0.15)' }}>
      <div className="px-4 pt-4 pb-2">
        <h3 className="text-sm font-semibold" style={{ color: '#2563EB' }}>משקל פוזיציות בתיק הכולל ({rows.length} מניות ייחודיות)
        </h3>
      </div>
      <div className="p-0">
        <div className="overflow-x-auto" style={{ touchAction: 'pan-y' }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs" style={{ borderColor: 'rgba(37,99,235,0.20)', color: 'rgba(37,99,235,0.65)' }}>
                {([
                  ["ticker",   "מניה"],
                  ["value",    "שווי"],
                  ["pnl",      "P&L $"],
                  ["pnlPct",   "P&L %"],
                  ["weight",   "משקל %"],
                  ["todayPnl", "Today P&L"],
                  ["zivScore", "ZIV H"],
                ] as [SortKey, string][]).map(([k, label]) => (
                  <th key={k} className="text-right py-2 px-3 cursor-pointer hover:text-foreground select-none"
                    style={{ touchAction: 'manipulation', minHeight: '44px' }}
                    onClick={() => handleSort(k)}>
                    <span className="flex items-center justify-end gap-1">{label}<SortIcon k={k} /></span>
                  </th>
                ))}
                <th className="text-right py-2 px-3 text-xs">תיק</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={r.ticker + i} className="border-b" style={{ borderColor: 'rgba(37,99,235,0.12)' }}>
                  <td className="py-2 px-3 font-medium">
                    <div className="flex items-center gap-1 flex-wrap">
                    <button
                      onClick={() => onTickerClick?.(r)}
                      className="text-left hover:underline cursor-pointer transition-colors" style={{ color: '#2563EB' }}
                    >
                      <div className="font-semibold">{r.ticker}</div>
                    </button>
                    {isShortPosition(r.units) && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-600 text-white leading-none">▼ SHORT</span>
                    )}
                    <button
                      onClick={() => onDeepAnalysis?.(r.ticker)}
                      title={`Deep Analysis: ${r.ticker}`}
                      className="p-0.5 rounded hover:bg-blue-100 transition-colors"
                      style={{ color: 'rgba(37,99,235,0.5)' }}
                    >
                      <Search className="w-3 h-3" />
                    </button>
                  </div>
                  </td>
                  <td className="py-2 px-3 font-semibold">
                    <div className={isShortPosition(r.units) ? "text-rose-600" : undefined}>
                      {isShortPosition(r.units) ? fmtSignedUsd(r.value) : fmtUsd(r.value)}
                    </div>
                    <ShortLiabilityHint units={r.units} value={r.value} compact />
                  </td>
                  <td className={`py-2 px-3 font-semibold ${r.pnl >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                    {fmtPnlUsd(r.pnl)}
                  </td>
                  <td className={`py-2 px-3 font-semibold ${r.pnlPct >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                    {fmtPct(r.pnlPct)}
                  </td>
                  <td className="py-2 px-3">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 rounded-full h-1.5 min-w-[40px]" style={{ background: '#E5E7EB' }}>
                        <div className="h-1.5 rounded-full" style={{ background: '#2563EB', width: `${Math.min(r.weight, 100)}%` }} />
                      </div>
                      <span className="text-xs font-medium w-10 text-right">{r.weight.toFixed(1)}%</span>
                    </div>
                  </td>
                  <td className={`py-2 px-3 text-xs ${r.todayPnl >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                    {r.todayPnl !== 0 ? fmtPnlUsd(r.todayPnl) : "—"}
                  </td>
                  <td className="py-2 px-3 text-center">
                    {r.zivScore != null ? (
                      <span className={`inline-block text-xs font-bold px-1.5 py-0.5 rounded ${
                        r.zivScore >= 7 ? 'bg-emerald-50 text-emerald-700' :
                        r.zivScore >= 5 ? 'bg-amber-50 text-amber-700' :
                        'bg-red-50 text-red-600'
                      }`}>{r.zivScore.toFixed(1)}</span>
                    ) : <span className="text-xs" style={{ color: '#9CA3AF' }}>—</span>}
                  </td>
                  <td className="py-2 px-3">
                    <Badge variant="outline" className="text-xs" style={{ borderColor: 'rgba(37,99,235,0.40)', color: '#2563EB' }}>{r.source}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2" style={{ borderColor: 'rgba(37,99,235,0.30)', background: 'rgba(37,99,235,0.05)' }}>
                <td className="py-2 px-3 font-bold">סה"כ</td>
                <td className="py-2 px-3 font-bold">{fmtUsd(totals.totalValue)}</td>
                <td className={`py-2 px-3 font-bold ${totals.totalPnl >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                  {fmtPnlUsd(totals.totalPnl)}
                </td>
                <td className={`py-2 px-3 font-bold ${totals.totalPnlPct >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                  {fmtPct(totals.totalPnlPct)}
                </td>
                <td className="py-2 px-3 font-bold text-xs">100%</td>
                <td className={`py-2 px-3 font-bold text-xs ${totals.todayPnl == null ? 'text-muted-foreground' : totals.todayPnl >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                  {totals.todayPnl != null ? fmtPnlUsd(totals.todayPnl) : "—"}
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────
export default function H1H2Dashboard() {
  const [, navigate] = useLocation();

  // ── SSOT: single hook for ALL data + math ─────────────────────────────────
  const {
    h1Rows: analyticsH1,
    h2Rows: analyticsH2,
    metrics,
    ibkrConnected,
    displayNLV,
    cashBalance,
    isLoading,
    h1PriceMap,
    h2PriceMap,
  } = usePortfolioAnalytics();

  // ── Build display rows from analytics (no math here — just shape mapping) ──
  const h1Rows = useMemo(() =>
    analyticsH1.map(h => ({
      ticker: h.ticker,
      company: h.company ?? h.ticker,
      cost: h.cost,
      value: h.value,
      pnl: h.pnl,
      pnlPct: h.pnlPct,
      todayPnl: h.todayPnl,
      source: "H1" as const,
      zivScore: h.zivScore,
      _id: h.id,
      _buyPrice: h.buyPrice,
      _units: h.units,
      _stopLoss: h.stopLoss,
      _takeProfit: h.takeProfit,
    })),
    [analyticsH1]
  );

  const h2Rows = useMemo(() =>
    analyticsH2.map(h => ({
      ticker: h.ticker,
      company: h.company ?? h.ticker,
      cost: h.cost,
      value: h.value,
      pnl: h.pnl,
      pnlPct: h.pnlPct,
      todayPnl: h.todayPnl,
      source: "H2" as const,
      zivScore: h.zivScore,
      _id: h.id,
      _buyPrice: h.buyPrice,
      _units: h.units,
    })),
    [analyticsH2]
  );

  const combined = useMemo(() => [...h1Rows, ...h2Rows], [h1Rows, h2Rows]);

  // ── Totals — read DIRECTLY from usePortfolioMetrics (SSOT) ────────────────
  const totals = useMemo(() => ({
    totalValue:   metrics.unifiedValue ?? (metrics.h1NLV + metrics.h2TotalValue),
    totalCost:    metrics.h1TotalCost  + metrics.h2TotalCost,
    totalPnl:     metrics.h1TotalPnl   + metrics.h2TotalPnl,
    totalPnlPct:  metrics.unifiedTotalPnlPct,
    todayPnl:     metrics.unifiedTodayPnl,
  }), [metrics]);

  // ── Derived display data ──────────────────────────────────────────────────
  const totalValue = totals.totalValue || 1;

  const sorted = useMemo(() => [...combined].sort((a, b) => b.pnlPct - a.pnlPct), [combined]);
  const topGainers = sorted.slice(0, 5);
  const topLosers  = [...sorted].reverse().slice(0, 5);

  // Merge duplicate tickers (H1+H2 same stock)
  const weightTable: WeightRow[] = useMemo(() => {
    const mergedMap = new Map<string, WeightRow>();
    for (const r of combined) {
      if (mergedMap.has(r.ticker)) {
        const ex = mergedMap.get(r.ticker)!;
        ex.cost     += r.cost;
        ex.value    += r.value;
        ex.pnl      += r.pnl;
        ex.todayPnl += r.todayPnl;
        ex.units    += r._units;
        ex.pnlPct    = ex.cost > 0 ? (ex.pnl / ex.cost) * 100 : 0;
        if (ex.source !== r.source) ex.source = "H1+H2";
        if (r.zivScore != null && (ex.zivScore == null || r.zivScore > ex.zivScore)) {
          ex.zivScore = r.zivScore;
        }
      } else {
        mergedMap.set(r.ticker, { ...r, weight: 0, units: r._units });
      }
    }
    return Array.from(mergedMap.values())
      .map(r => ({ ...r, weight: (r.value / totalValue) * 100 }))
      .sort((a, b) => b.value - a.value);
  }, [combined, totalValue]);

  // ── Loading state ─────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto overflow-x-hidden">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex flex-col leading-none">
            <span className="text-[10px] font-semibold text-[#2563EB] tracking-widest uppercase">TradeSnow</span>
            <h1 className="text-2xl font-bold text-foreground">H1 + H2 Dashboard</h1>
          </div>
          <p className="text-sm mt-0.5" style={{ color: '#4A5568' }}>
            {h1Rows.length} מניות ב-H1 · {h2Rows.length} מניות ב-H2 · {combined.length} סה"כ
            {ibkrConnected && <span className="ml-2 font-medium" style={{ color: '#2563EB' }}>● IBKR Live</span>}
          </p>
        </div>
        <RefreshControl ibkrConnected={ibkrConnected} />
      </div>

      {/* ── Row 1: Top Vitals (Total Value, Total P&L, Today P&L) ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <SummaryCard
          title="שווי כולל"
          value={fmtUsd(totals.totalValue)}
          sub={metrics.unifiedTodayPnl != null ? `שינוי מאתמול: ${fmtPnlUsd(metrics.unifiedTodayPnl)}${metrics.unifiedTodayPct != null ? ` (${metrics.unifiedTodayPct >= 0 ? '+' : ''}${metrics.unifiedTodayPct.toFixed(2)}%)` : ''}` : undefined}
          icon={DollarSign}
          positive={metrics.unifiedTodayPnl != null ? metrics.unifiedTodayPnl >= 0 : undefined}
        />
        <SummaryCard
          title="P&L כולל"
          value={fmtUsd(totals.totalPnl)}
          sub={fmtPct(totals.totalPnlPct)}
          icon={BarChart2}
          positive={totals.totalPnl >= 0}
        />
        <SummaryCard
          title="Today P&L"
          value={metrics.unifiedTodayPnl != null ? fmtUsd(metrics.unifiedTodayPnl) : "—"}
          icon={metrics.unifiedTodayPnl != null && metrics.unifiedTodayPnl >= 0 ? TrendingUp : TrendingDown}
          positive={metrics.unifiedTodayPnl != null ? metrics.unifiedTodayPnl >= 0 : undefined}
        />
      </div>

      {/* ── Row 2: H1 vs H2 summary cards (side by side) ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[
          {
            label: "Holding 1 (H1)",
            color: "blue",
            val: metrics.h1TotalValue,
            cost: metrics.h1TotalCost,
            pnl: metrics.h1TotalPnl,
            pnlPct: metrics.h1TotalPnlPct,
            todayPnl: metrics.h1TodayPnl ?? 0,
            count: h1Rows.length,
          },
          {
            label: "Holding 2 (H2)",
            color: "emerald",
            val: metrics.h2TotalValue,
            cost: metrics.h2TotalCost,
            pnl: metrics.h2TotalPnl,
            pnlPct: metrics.h2TotalPnlPct,
            todayPnl: metrics.h2TodayPnl ?? 0,
            count: h2Rows.length,
          },
        ].map(({ label, color, val, pnl, pnlPct, todayPnl, count }) => {
          const weight = (val / totalValue) * 100;
          const isPos = pnl >= 0;
          return (
            <Card key={label} className={`border border-${color}-200 bg-${color}-50`}>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center justify-between mb-3">
                  <span className="font-semibold text-sm text-foreground">{label}</span>
                  <Badge variant="outline" className="text-xs">{count} מניות · {fmt(weight, 1)}% מהתיק</Badge>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-xs" style={{ color: 'rgba(37,99,235,0.65)' }}>שווי</p>
                    <p className="font-bold text-sm">{fmtUsd(val)}</p>
                  </div>
                  <div>
                    <p className="text-xs" style={{ color: 'rgba(37,99,235,0.65)' }}>P&L</p>
                    <p className={`font-bold text-sm ${isPos ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>{fmtUsd(pnl)} ({fmtPct(pnlPct)})</p>
                  </div>
                  <div>
                    <p className="text-xs" style={{ color: 'rgba(37,99,235,0.65)' }}>Today</p>
                    <p className={`font-bold text-sm ${todayPnl >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>{fmtUsd(todayPnl)}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* ── Sector Heatmap (H1 / H2 USA / H2 TASE) ── */}
      <HoldingSectorHeatmap />

      {/* ── Row 3: Portfolio Equity Curve ── */}
      <Suspense fallback={<Skeleton className="h-64 w-full rounded-xl" />}>
        <PortfolioPerformanceChart
          currentEquityValue={metrics.h1TotalValue > 0 ? metrics.h1TotalValue : undefined}
          cashBalance={cashBalance}
          h2Value={metrics.h2TotalValue > 0 ? metrics.h2TotalValue : undefined}
        />
      </Suspense>

      {/* ── Row 4: Top 5 Gainers / Bottom 5 Losers ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-[#65A30D]" /> Top 5 Gainers
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs" style={{ borderColor: 'rgba(37,99,235,0.20)', color: 'rgba(37,99,235,0.65)' }}>
                  <th className="text-right py-2 px-4">מניה</th>
                  <th className="text-right py-2 px-4">P&L%</th>
                  <th className="text-right py-2 px-4">P&L $</th>
                  <th className="text-right py-2 px-4">תיק</th>
                </tr>
              </thead>
              <tbody>
                {topGainers.map((r, i) => (
                  <tr key={r.ticker + i} className="border-b" style={{ borderColor: 'rgba(37,99,235,0.12)' }}>
                    <td className="py-2 px-4 font-medium">{r.ticker}</td>
                    <td className="py-2 px-4 text-[#65A30D] font-semibold">{fmtPct(r.pnlPct)}</td>
                    <td className="py-2 px-4 text-[#65A30D]">{fmtPnlUsd(r.pnl)}</td>
                    <td className="py-2 px-4"><Badge variant="outline" className="text-xs">{r.source}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <TrendingDown className="w-4 h-4 text-[#FF6B6B]" /> Bottom 5 Losers
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs" style={{ borderColor: 'rgba(37,99,235,0.20)', color: 'rgba(37,99,235,0.65)' }}>
                  <th className="text-right py-2 px-4">מניה</th>
                  <th className="text-right py-2 px-4">P&L%</th>
                  <th className="text-right py-2 px-4">P&L $</th>
                  <th className="text-right py-2 px-4">תיק</th>
                </tr>
              </thead>
              <tbody>
                {topLosers.map((r, i) => (
                  <tr key={r.ticker + i} className="border-b" style={{ borderColor: 'rgba(37,99,235,0.12)' }}>
                    <td className="py-2 px-4 font-medium">{r.ticker}</td>
                    <td className={`py-2 px-4 font-semibold ${r.pnlPct < 0 ? 'text-[#FF6B6B]' : 'text-[#65A30D]'}`}>{fmtPct(r.pnlPct)}</td>
                    <td className={`py-2 px-4 ${r.pnl < 0 ? 'text-[#FF6B6B]' : 'text-[#65A30D]'}`}>{fmtPnlUsd(r.pnl)}</td>
                    <td className="py-2 px-4"><Badge variant="outline" className="text-xs">{r.source}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      {/* ── Row 5: Weight Table (full width) ── */}
      <WeightTableInline
        rows={weightTable}
        totals={totals}
        totalValue={totalValue}
        onTickerClick={(r) => {
          navigate(`/deep-analysis/${encodeURIComponent(r.ticker)}`);
        }}
        onDeepAnalysis={(ticker) => {
          navigate(`/deep-analysis/${encodeURIComponent(ticker)}`);
        }}
      />
    </div>
  );
}
