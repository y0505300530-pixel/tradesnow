import { useState, useEffect, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { TickerLink } from "@/components/TickerLink";
import {
  Search, TrendingUp, BookmarkPlus, CheckCircle2,
  Target, ShieldAlert, RefreshCw, Zap, Trash2,
  ArrowUpDown, CalendarDays, BookOpen, Star, Filter,
  ChevronDown, ChevronUp, Info, PlusCircle,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
type WatchlistStock = {
  analysisId: number;
  videoId: string | null;
  videoTitle: string;
  videoDate: string;
  videoDateRaw: number;
  ticker: string;
  companyName: string;
  entryZone: string;
  stopLoss: string;
  strategy: string;
  watchlistStatus: string;
  isWatchlist: boolean;
  zivScore: number | null;
  inCatalog?: boolean;
  mentor?: "cycles_trading" | "micha_stocks";
};

type SortMode = "date" | "score";
type FilterMode = "all" | "watchlist" | "entry_ready" | "not_in_catalog";

const MENTOR_LABEL: Record<string, { name: string; color: string; bg: string }> = {
  cycles_trading: { name: "Ziv", color: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200" },
  micha_stocks:   { name: "Micha", color: "text-blue-700",  bg: "bg-blue-50 border-blue-200" },
};

function scoreColor(score: number | null) {
  if (score == null) return "text-gray-400";
  if (score >= 8.5) return "text-emerald-600 font-bold";
  if (score >= 7)   return "text-yellow-600 font-semibold";
  if (score >= 5)   return "text-orange-500";
  return "text-gray-400";
}

function isEntryReady(stock: WatchlistStock) {
  return stock.entryZone !== "—" && stock.entryZone !== "-" && stock.entryZone.trim().length > 2;
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function WatchlistPage() {
  const [search, setSearch]             = useState("");
  const [filterMode, setFilterMode]     = useState<FilterMode>("all");
  const [sortMode, setSortMode]         = useState<SortMode>("date");
  const [filterMentor, setFilterMentor] = useState<"all" | "cycles_trading" | "micha_stocks">("all");
  const [expanded, setExpanded]         = useState<Set<string>>(new Set());
  const [addedTickers, setAddedTickers] = useState<Set<string>>(new Set());
  const [scanResult, setScanResult]     = useState<{ scanned: number } | null>(null);

  const { data, isLoading, refetch } = trpc.videoManagement.getAllWatchlistStocks.useQuery(
    { limit: 300 },
    { refetchOnWindowFocus: false }
  );

  useEffect(() => { refetch(); }, []);

  const scanScores = trpc.videoManagement.scanWatchlistScores.useMutation({
    onSuccess: (r) => {
      setScanResult({ scanned: r.scanned });
      if (r.scanned > 0) { toast.success(`ציונות חושבו ל-${r.scanned} טיקרים`); refetch(); }
      else toast.info("כל הטיקרים כבר מדורגים");
    },
    onError: (e) => toast.error(`שגיאה: ${e.message}`),
  });

  const addToAssetCatalog = trpc.videoManagement.addToAssetCatalog.useMutation({
    onSuccess: (r) => {
      toast.success(`✅ ${r.ticker} נוסף לקטלוג`);
      setAddedTickers((prev) => new Set([...prev, r.ticker]));
      refetch();
    },
    onError: (e) => toast.error(`שגיאה: ${e.message}`),
  });

  const dismissTicker = trpc.videoManagement.dismissWatchlistTicker.useMutation({
    onSuccess: (r) => { toast.success(`${r.ticker} הוסר`); refetch(); },
    onError:   (e) => toast.error(`שגיאה: ${e.message}`),
  });

  const stocks: WatchlistStock[] = (data?.stocks ?? []) as WatchlistStock[];

  // Stats
  const inCatalog   = stocks.filter(s => addedTickers.has(s.ticker)).length;
  const entryReady  = stocks.filter(isEntryReady).length;
  const watchlistN  = stocks.filter(s => s.isWatchlist).length;

  const filtered = useMemo(() => {
    let list = stocks;
    if (filterMode === "watchlist")   list = list.filter(s => s.isWatchlist);
    if (filterMode === "entry_ready") list = list.filter(isEntryReady);
    if (filterMode === "not_in_catalog") list = list.filter(s => !s.inCatalog);
    if (filterMentor !== "all")       list = list.filter(s => (s.mentor ?? "cycles_trading") === filterMentor);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(s =>
        s.ticker.toLowerCase().includes(q) ||
        s.companyName.toLowerCase().includes(q) ||
        (s.videoTitle ?? "").toLowerCase().includes(q) ||
        s.strategy.toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => {
      if (sortMode === "score") {
        if (a.zivScore == null && b.zivScore == null) return 0;
        if (a.zivScore == null) return 1;
        if (b.zivScore == null) return -1;
        return b.zivScore - a.zivScore;
      }
      return (b.videoDateRaw ?? 0) - (a.videoDateRaw ?? 0);
    });
  }, [stocks, search, filterMode, sortMode, filterMentor]);

  const toggleExpand = (ticker: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(ticker) ? next.delete(ticker) : next.add(ticker);
      return next;
    });

  return (
    <div className="min-h-screen bg-gray-50" dir="rtl">

      {/* ── Header ── */}
      <div className="bg-white border-b border-gray-200 px-6 py-5 sticky top-0 z-10 shadow-sm">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                <BookOpen className="w-5 h-5 text-emerald-600" />
                רשימת מעקב AI — זיו ומיכה
              </h1>
              <p className="text-xs text-gray-500 mt-0.5">
                מניות שחולצו מניתוחי הסרטונים · {stocks.length} ייחודיות ·&nbsp;
                <span className="text-emerald-600 font-medium">{entryReady} עם איתות כניסה</span>
                {" · "}
                <span className="text-amber-600 font-medium">{watchlistN} ברשימת מעקב</span>
              </p>
            </div>

            <div className="flex items-center gap-2">
              {scanResult && (
                <span className="text-xs text-gray-400">סרק {scanResult.scanned} חדשים</span>
              )}
              <Button variant="outline" size="sm" onClick={() => scanScores.mutate({ forceAll: false })}
                disabled={scanScores.isPending} className="gap-1 text-xs text-amber-600 border-amber-200 hover:bg-amber-50">
                {scanScores.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                {scanScores.isPending ? "מחשב…" : "חשב ציונות"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-1 text-xs">
                <RefreshCw className="w-3 h-3" /> רענן
              </Button>
            </div>
          </div>

          {/* ── Filters bar ── */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Search */}
            <div className="relative">
              <Search className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <Input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="חפש טיקר, אסטרטגיה..." className="pr-8 text-sm w-52 h-8" dir="rtl" />
            </div>

            {/* Filter mode */}
            <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
              {([["all","הכל"], ["watchlist","מעקב"], ["entry_ready","כניסה מוכנה"]] as const).map(([v,l]) => (
                <button key={v} onClick={() => setFilterMode(v)}
                  className={`text-xs px-2.5 py-1 rounded-md font-medium transition-all ${filterMode===v ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
                  {l}
                </button>
              ))}
            </div>

            {/* Mentor filter */}
            <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
              {([["all","הכל"], ["cycles_trading","Ziv"], ["micha_stocks","Micha"]] as const).map(([v,l]) => (
                <button key={v} onClick={() => setFilterMentor(v)}
                  className={`text-xs px-2.5 py-1 rounded-md font-medium transition-all ${filterMentor===v ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
                  {l}
                </button>
              ))}
            </div>

            {/* Sort */}
            <button onClick={() => setSortMode(m => m === "date" ? "score" : "date")}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg px-2.5 py-1 bg-white">
              <ArrowUpDown className="w-3 h-3" />
              {sortMode === "date" ? "לפי תאריך" : "לפי ציון"}
            </button>

            <span className="text-xs text-gray-400 mr-auto">{filtered.length} מניות</span>
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div className="max-w-6xl mx-auto px-6 py-5">
        {isLoading ? (
          <div className="flex justify-center py-24 text-gray-400">
            <RefreshCw className="w-5 h-5 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-24 text-gray-400">
            <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">לא נמצאו מניות</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {filtered.map(stock => {
              const mentorInfo = MENTOR_LABEL[stock.mentor ?? "cycles_trading"] ?? MENTOR_LABEL.cycles_trading;
              const isExp = expanded.has(stock.ticker);
              const alreadyAdded = addedTickers.has(stock.ticker);
              const hasEntry = isEntryReady(stock);

              return (
                <div key={stock.ticker}
                  className={`bg-white rounded-xl border shadow-sm transition-all ${hasEntry ? "border-emerald-200" : "border-gray-200"}`}>

                  {/* ── Card Header ── */}
                  <div className="flex items-center gap-3 px-4 py-3">

                    {/* Ticker + mentor badge */}
                    <div className="min-w-0 flex-1 flex items-center gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <TickerLink ticker={stock.ticker}
                            className="font-bold text-base text-gray-900 hover:text-blue-600" />
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${mentorInfo.bg} ${mentorInfo.color}`}>
                            {mentorInfo.name}
                          </span>
                          {!stock.inCatalog && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-700 border border-purple-300" title="מניה זו לא נמצאת בקטלוג המנוע — שקול להוסיף">
                              ⚠️ לא בקטלוג
                            </span>
                          )}
                          {hasEntry && (
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-200 flex items-center gap-0.5">
                              <Target className="w-2.5 h-2.5" /> איתות כניסה
                            </span>
                          )}
                          {stock.isWatchlist && (
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 flex items-center gap-0.5">
                              <Star className="w-2.5 h-2.5" /> מעקב
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5">{stock.companyName}</p>
                      </div>
                    </div>

                    {/* Score */}
                    <div className="text-center w-14">
                      <div className={`text-lg ${scoreColor(stock.zivScore)}`}>
                        {stock.zivScore != null ? stock.zivScore.toFixed(1) : "—"}
                      </div>
                      <div className="text-[10px] text-gray-400">ציון</div>
                    </div>

                    {/* Entry zone preview */}
                    {hasEntry && (
                      <div className="hidden md:block max-w-xs text-xs text-emerald-700 bg-emerald-50 rounded-lg px-3 py-1.5 border border-emerald-100">
                        <span className="font-semibold">כניסה: </span>{stock.entryZone.slice(0, 60)}{stock.entryZone.length > 60 ? "…" : ""}
                      </div>
                    )}

                    {/* Date */}
                    <div className="text-center hidden lg:block w-20">
                      <div className="text-xs text-gray-500">{stock.videoDate}</div>
                      <div className="text-[10px] text-gray-400 truncate max-w-[80px]" title={stock.videoTitle ?? undefined}>
                        {(stock.videoTitle ?? "").slice(0, 18)}{(stock.videoTitle?.length ?? 0) > 18 ? "…" : ""}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1.5">
                      {alreadyAdded ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-600 font-medium px-2 py-1">
                          <CheckCircle2 className="w-3.5 h-3.5" /> בקטלוג
                        </span>
                      ) : (
                        <Button size="sm" variant="outline"
                          onClick={() => addToAssetCatalog.mutate({
                            ticker: stock.ticker,
                            companyName: stock.companyName,
                            label: stock.mentor === "micha_stocks" ? "Micha Watchlist" : "Ziv Watchlist",
                          })}
                          disabled={addToAssetCatalog.isPending}
                          className="gap-1 text-xs h-7 text-blue-600 border-blue-200 hover:bg-blue-50">
                          <PlusCircle className="w-3 h-3" /> הוסף לקטלוג
                        </Button>
                      )}
                      <button onClick={() => toggleExpand(stock.ticker)}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
                        {isExp ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                      <button onClick={() => { if (confirm(`להסיר את ${stock.ticker}?`)) dismissTicker.mutate({ ticker: stock.ticker }); }}
                        className="p-1.5 rounded-lg text-gray-300 hover:text-red-400 hover:bg-red-50 transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* ── Expanded detail ── */}
                  {isExp && (
                    <div className="border-t border-gray-100 px-4 py-3 bg-gray-50 rounded-b-xl grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">

                      {/* Strategy */}
                      <div>
                        <div className="font-semibold text-gray-600 mb-1 flex items-center gap-1">
                          <Info className="w-3 h-3" /> אסטרטגיה
                        </div>
                        <p className="text-gray-700 leading-relaxed">
                          {stock.strategy !== "—" ? stock.strategy : <span className="text-gray-400">לא צוין</span>}
                        </p>
                      </div>

                      {/* Entry zone */}
                      <div>
                        <div className="font-semibold text-gray-600 mb-1 flex items-center gap-1">
                          <Target className="w-3 h-3 text-emerald-600" /> איתות כניסה
                        </div>
                        <p className="text-emerald-700">
                          {stock.entryZone !== "—" ? stock.entryZone : <span className="text-gray-400">לא צוין</span>}
                        </p>
                      </div>

                      {/* Stop loss */}
                      <div>
                        <div className="font-semibold text-gray-600 mb-1 flex items-center gap-1">
                          <ShieldAlert className="w-3 h-3 text-red-500" /> סטופ לוס
                        </div>
                        <p className="text-red-600">
                          {stock.stopLoss !== "—" ? stock.stopLoss : <span className="text-gray-400">לא צוין</span>}
                        </p>
                        {stock.watchlistStatus !== "—" && (
                          <p className="text-blue-600 mt-1.5 italic">{stock.watchlistStatus}</p>
                        )}
                      </div>

                      {/* Source video */}
                      <div className="md:col-span-3 pt-2 border-t border-gray-200 flex items-center gap-2 text-gray-400">
                        <CalendarDays className="w-3 h-3" />
                        <span>מקור: {stock.videoTitle ?? "—"} · {stock.videoDate}</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
