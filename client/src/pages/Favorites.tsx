/**
 * Favorites Page — v15.24
 * Professional compact table with live IBKR quotes.
 * Follows professional-tables skill rules:
 * - Ticker FIRST (left), bold, large font
 * - Compact rows (py-2 px-3)
 * - Score badges with color coding
 * - Zebra stripes, hover states
 * - Right-aligned numbers, proper sizing
 */
import { useState, useMemo, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw, Upload, Loader2, ArrowUp, ArrowDown, Star } from "lucide-react";
import { toast } from "sonner";

type SortField = "ticker" | "cmp" | "chng" | "chngPct" | "score";
type SortDir = "asc" | "desc";

// ─── ⭐ VIP (SELECTED_TEAM) chip — owner's priority ticker ────────────────────
// Amber, icon + text (never color-alone), ≥11px, wraps cleanly at 375px.
// Matches the War Room ⭐ נבחרת aesthetic. Renders only when ticker ∈ vip set.
function VipChip() {
  return (
    <span
      title="נבחרת — VIP priority ticker (owner's SELECTED_TEAM)"
      aria-label="VIP — SELECTED_TEAM priority ticker"
      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[11px] font-bold tracking-wide whitespace-nowrap bg-amber-100 text-amber-800 border border-amber-300 leading-none"
    >
      <Star className="w-3 h-3 shrink-0 fill-amber-500 text-amber-500" aria-hidden />
      VIP
    </span>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function Favorites() {
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<"usa" | "isr">("usa");
  const [sortField, setSortField] = useState<SortField>("score");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Toggle sort: if same field, flip direction; if new field, set desc (except ticker → asc)
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(prev => prev === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir(field === "ticker" ? "asc" : "desc");
    }
  };

  // Data
  const { data: favData, isLoading } = trpc.favorites.list.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  // Holdings data (for Pos + Unrl P&L)
  const { data: portfolioState } = trpc.portfolio.getState.useQuery(undefined, {
    refetchOnWindowFocus: true,
  });
  const { data: h2Data } = trpc.holding2.list.useQuery(undefined, { refetchOnWindowFocus: true });

  // Build holdings map: ticker → { pos, unrealizedPnl, source }
  const holdingsMap = useMemo(() => {
    const map = new Map<string, { pos: number; pnl: number; source: string }>();
    if (portfolioState?.holdings) {
      for (const h of portfolioState.holdings as any[]) {
        const t = h.ticker.toUpperCase();
        map.set(t, { pos: h.quantity ?? h.shares ?? 0, pnl: h.unrealizedPnl ?? 0, source: "H1" });
        if (t === "GOOG") map.set("GOOGL", { pos: h.quantity ?? h.shares ?? 0, pnl: h.unrealizedPnl ?? 0, source: "H1" });
        if (t === "GOOGL") map.set("GOOG", { pos: h.quantity ?? h.shares ?? 0, pnl: h.unrealizedPnl ?? 0, source: "H1" });
      }
    }
    if (h2Data) {
      for (const h of h2Data as any[]) {
        const t = (h.ticker ?? "").toUpperCase();
        if (!map.has(t)) {
          map.set(t, { pos: h.quantity ?? h.shares ?? 0, pnl: h.unrealizedPnl ?? 0, source: "H2" });
        }
      }
    }
    return map;
  }, [portfolioState, h2Data]);

  // ── ⭐ VIP (SELECTED_TEAM) set — owner's priority tickers ─────────────────────
  // Defensive: backhand exposes `selectedTeam: string[]` (uppercased) on the
  // favorites list query. It may land as a top-level field on the response OR
  // ride on the first row — accept either. Empty/absent ⇒ no ⭐ renders, never crashes.
  const { data: vipList } = trpc.favorites.getSelectedTeam.useQuery(undefined, { staleTime: 60_000 });
  const vip = useMemo(() => {
    const raw =
      (vipList as any) ??
      (favData as any)?.selectedTeam ??
      (Array.isArray(favData) ? (favData[0] as any)?.selectedTeam : undefined) ??
      [];
    return new Set(
      (Array.isArray(raw) ? raw : [])
        .filter((t: any) => t != null)
        .map((t: any) => String(t).toUpperCase()),
    );
  }, [favData, vipList]);

  // Map data
  const allAssets = useMemo(() => {
    if (!favData) return [];
    return (favData as any[]).map((a) => ({
      ticker: a.ticker as string,
      sector: (a.sector ?? "") as string,
      score: a.score != null ? Number(a.score) : null as number | null,
      cmp: a.cmp != null ? Number(a.cmp) : null as number | null,
      dailyChangePercent: a.dailyChangePercent != null ? Number(a.dailyChangePercent) : null as number | null,
    }));
  }, [favData]);

  // Sort function
  const sortAssets = (assets: typeof allAssets) => {
    return [...assets].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "ticker":
          cmp = a.ticker.localeCompare(b.ticker);
          break;
        case "cmp":
          cmp = (a.cmp ?? 0) - (b.cmp ?? 0);
          break;
        case "chng": {
          const aChng = a.cmp != null && a.dailyChangePercent != null
            ? a.cmp - a.cmp / (1 + a.dailyChangePercent / 100) : 0;
          const bChng = b.cmp != null && b.dailyChangePercent != null
            ? b.cmp - b.cmp / (1 + b.dailyChangePercent / 100) : 0;
          cmp = aChng - bChng;
          break;
        }
        case "chngPct":
          cmp = (a.dailyChangePercent ?? 0) - (b.dailyChangePercent ?? 0);
          break;
        case "score":
          cmp = (a.score ?? 0) - (b.score ?? 0);
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  };

  // Split USA / TASE, then sort
  const usaAssets = useMemo(() =>
    sortAssets(allAssets.filter(a => !a.ticker.endsWith(".TA"))),
    [allAssets, sortField, sortDir]
  );
  const taseAssets = useMemo(() =>
    sortAssets(allAssets.filter(a => a.ticker.endsWith(".TA"))),
    [allAssets, sortField, sortDir]
  );

  const activeAssets = activeTab === "usa" ? usaAssets : taseAssets;

  // Mutations
  const [refreshing, setRefreshing] = useState(false);
  const refreshMut = trpc.favorites.refreshQuotes.useMutation({
    onSuccess: (data) => {
      setRefreshing(false);
      utils.favorites.list.invalidate();
      const d = data as any;
      if (d.missing > 0) {
        toast.success(`Updated ${d.updated}/${d.total} prices (${d.missing} unavailable)`);
      } else {
        toast.success(`Updated ${d.updated} prices from IBKR`);
      }
    },
    onError: (e) => {
      setRefreshing(false);
      toast.error(`Error: ${e.message}`);
    },
  });

  // Auto-refresh on mount: fetch live IBKR prices when page loads
  const autoRefreshed = useRef(false);
  useEffect(() => {
    if (!autoRefreshed.current && favData && !isLoading) {
      autoRefreshed.current = true;
      setRefreshing(true);
      refreshMut.mutate();
    }
  }, [favData, isLoading]);

  const [syncing, setSyncing] = useState(false);
  const syncMut = trpc.favorites.syncToIbkr.useMutation({
    onSuccess: (data) => {
      setSyncing(false);
      const d = data as any;
      if (d.usa?.success && d.tase?.success) {
        toast.success(`Synced to IBKR: USA ${d.usa.synced}/${d.usa.total} | ISR ${d.tase.synced}/${d.tase.total}`);
        if (d.usa.missing?.length > 0 || d.tase.missing?.length > 0) {
          const allMissing = [...(d.usa.missing ?? []), ...(d.tase.missing ?? [])];
          toast.info(`Missing conids: ${allMissing.slice(0, 5).join(", ")}${allMissing.length > 5 ? "..." : ""}`);
        }
      } else {
        const errors = [d.usa?.error, d.tase?.error].filter(Boolean).join("; ");
        toast.error(`Sync error: ${errors}`);
      }
    },
    onError: (e) => {
      setSyncing(false);
      toast.error(`Error: ${e.message}`);
    },
  });

  const handleRefresh = () => { setRefreshing(true); refreshMut.mutate(); };
  const handleSync = () => { setSyncing(true); syncMut.mutate(); };

  // ─── Compute daily change in $ ─────────────────────────────────────────────
  function getDailyChange(cmp: number | null, dailyPct: number | null): number | null {
    if (cmp == null || dailyPct == null) return null;
    const prevPrice = cmp / (1 + dailyPct / 100);
    return cmp - prevPrice;
  }

  // ─── Exchange label ─────────────────────────────────────────────────────────
  function getExchange(ticker: string): string {
    if (ticker.endsWith(".TA")) return "TASE";
    return "NASDAQ";
  }

  // ─── Sort indicator ─────────────────────────────────────────────────────────
  function SortIndicator({ field }: { field: SortField }) {
    if (sortField !== field) return null;
    return sortDir === "asc"
      ? <ArrowUp className="inline h-3 w-3 ml-0.5" />
      : <ArrowDown className="inline h-3 w-3 ml-0.5" />;
  }

  // ─── Score badge color ──────────────────────────────────────────────────────
  function getScoreBadgeClass(score: number | null): string {
    if (score == null) return "bg-gray-100 text-gray-500";
    if (score >= 8) return "bg-green-100 text-green-800";
    if (score >= 5) return "bg-amber-100 text-amber-800";
    return "bg-red-100 text-red-800";
  }

  // ─── Loading State ────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex flex-col h-full bg-white">
        <div className="p-4 space-y-2">
          {[...Array(15)].map((_, i) => <Skeleton key={i} className="h-10 w-full bg-gray-100" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-white text-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <h1 className="text-xl font-bold tracking-tight text-gray-900">Favorites</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
            className="text-gray-600 hover:text-gray-900 hover:bg-gray-100 h-8 px-2"
          >
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
          <Button
            size="sm"
            onClick={handleSync}
            disabled={syncing}
            className="gap-1.5 bg-blue-600 hover:bg-blue-700 text-white h-8 px-3 text-xs"
          >
            {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            Sync
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 px-4">
        <button
          onClick={() => setActiveTab("usa")}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "usa"
              ? "border-blue-600 text-blue-600"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          USA ({usaAssets.length})
        </button>
        <button
          onClick={() => setActiveTab("isr")}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "isr"
              ? "border-blue-600 text-blue-600"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          ISR ({taseAssets.length})
        </button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        <table className="w-full max-w-5xl mx-auto">
          {/* Sticky Header */}
          <thead className="sticky top-0 bg-white z-10 border-b border-gray-200">
            <tr>
              <th className="text-left py-2 px-3">
                <button onClick={() => handleSort("ticker")} className={`text-xs uppercase tracking-wide font-semibold hover:text-gray-900 transition-colors ${sortField === "ticker" ? "text-gray-900" : "text-gray-500"}`}>
                  Ticker<SortIndicator field="ticker" />
                </button>
              </th>
              <th className="text-center py-2 px-3 w-[80px]">
                <button onClick={() => handleSort("score")} className={`text-xs uppercase tracking-wide font-semibold hover:text-gray-900 transition-colors ${sortField === "score" ? "text-gray-900" : "text-gray-500"}`}>
                  ↓ Score<SortIndicator field="score" />
                </button>
              </th>
              <th className="text-right py-2 px-3 w-[100px]">
                <button onClick={() => handleSort("cmp")} className={`text-xs uppercase tracking-wide font-semibold hover:text-gray-900 transition-colors ${sortField === "cmp" ? "text-gray-900" : "text-gray-500"}`}>
                  Price<SortIndicator field="cmp" />
                </button>
              </th>
              <th className="text-right py-2 px-3 w-[90px]">
                <button onClick={() => handleSort("chngPct")} className={`text-xs uppercase tracking-wide font-semibold hover:text-gray-900 transition-colors ${sortField === "chngPct" ? "text-gray-900" : "text-gray-500"}`}>
                  % Chg<SortIndicator field="chngPct" />
                </button>
              </th>
              <th className="text-right py-2 px-3 w-[90px]">
                <button onClick={() => handleSort("chng")} className={`text-xs uppercase tracking-wide font-semibold hover:text-gray-900 transition-colors ${sortField === "chng" ? "text-gray-900" : "text-gray-500"}`}>
                  Chng<SortIndicator field="chng" />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {activeAssets.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center py-12 text-gray-400 text-sm">
                  {activeTab === "usa" ? "No USA assets in catalog" : "No Israeli assets in catalog"}
                </td>
              </tr>
            )}
            {activeAssets.map((asset, i) => {
              const holding = holdingsMap.get(asset.ticker.toUpperCase());
              const dailyChange = getDailyChange(asset.cmp, asset.dailyChangePercent);
              const isPositive = (asset.dailyChangePercent ?? 0) > 0;
              const isNegative = (asset.dailyChangePercent ?? 0) < 0;
              const changeColor = isPositive ? "text-green-600" : isNegative ? "text-red-500" : "text-gray-400";

              return (
                <tr
                  key={asset.ticker}
                  className={`border-b border-gray-100 hover:bg-blue-50/60 transition-colors cursor-pointer ${i % 2 === 0 ? "bg-white" : "bg-gray-50/50"}`}
                  onClick={() => navigate(`/dip-analysis?ticker=${encodeURIComponent(asset.ticker.replace(".TA", ""))}`)}
                >
                  {/* Ticker — left, bold, large */}
                  <td className="py-2 px-3 text-left">
                    <div className="flex flex-col">
                      <span className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-base font-semibold text-gray-900">
                          {asset.ticker.replace(".TA", "")}
                        </span>
                        {vip.has(asset.ticker.toUpperCase()) && <VipChip />}
                      </span>
                      <span className="text-[10px] text-gray-400 uppercase leading-tight">
                        {getExchange(asset.ticker)}
                        {holding && holding.pos > 0 && (
                          <span className="ml-1.5 text-blue-500 font-medium">
                            • {holding.source} ({holding.pos})
                          </span>
                        )}
                      </span>
                    </div>
                  </td>
                  {/* Score badge */}
                  <td className="py-2 px-3 text-center">
                    {asset.score != null ? (
                      <span className={`inline-flex items-center justify-center rounded-full px-2.5 py-0.5 text-xs font-bold min-w-[42px] ${getScoreBadgeClass(asset.score)}`}>
                        {asset.score.toFixed(1)}
                      </span>
                    ) : (
                      <span className="text-gray-300 text-xs">—</span>
                    )}
                  </td>
                  {/* Price */}
                  <td className="py-2 px-3 text-right">
                    <span className="text-sm font-medium text-gray-900 tabular-nums">
                      {asset.cmp != null ? asset.cmp.toFixed(2) : "—"}
                    </span>
                  </td>
                  {/* % Change */}
                  <td className="py-2 px-3 text-right">
                    <span className={`text-sm font-semibold tabular-nums ${changeColor}`}>
                      {asset.dailyChangePercent != null
                        ? `${asset.dailyChangePercent >= 0 ? "+" : ""}${asset.dailyChangePercent.toFixed(2)}%`
                        : "—"}
                    </span>
                  </td>
                  {/* Change $ */}
                  <td className="py-2 px-3 text-right">
                    <span className={`text-sm tabular-nums ${changeColor}`}>
                      {dailyChange != null
                        ? `${dailyChange >= 0 ? "+" : ""}${dailyChange.toFixed(2)}`
                        : "—"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
