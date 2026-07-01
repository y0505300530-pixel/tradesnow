/**
 * Asset Catalogue Page — v1.189
 * Single unified table: checkboxes + all scan columns merged.
 */
import { useState, useMemo, useEffect, useCallback, useRef, memo } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Loader2, Zap, ArrowRightLeft, TrendingUp, Search,
  ChevronsUpDown, ChevronUp, ChevronDown,
  Trash2, Plus, CheckSquare, Square, Archive, RotateCcw, ChevronRight, ShoppingCart,
  BookmarkPlus, CheckCircle2, RefreshCw, BellPlus, X, Star,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ScoreBadge, TierBadge } from "@/components/DeepAnalysisModal";
import { RefreshControl } from "@/components/RefreshControl";
import { useAuth } from "@/_core/hooks/useAuth";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type SortDir = "asc" | "desc" | null;

function useSortableTable<T extends Record<string, any>>(rows: T[], defaultCol?: keyof T, defaultDir: SortDir = "desc") {
  const [sortCol, setSortCol] = useState<keyof T | null>(defaultCol ?? null);
  const [sortDir, setSortDir] = useState<SortDir>(defaultCol ? defaultDir : null);

  const handleSort = useCallback((col: keyof T) => {
    setSortCol(prev => {
      if (prev === col) {
        setSortDir(d => d === "desc" ? "asc" : d === "asc" ? null : "desc");
        return col;
      }
      setSortDir("desc");
      return col;
    });
  }, []);

  const sorted = useMemo(() => {
    if (!sortCol || !sortDir) return rows;
    return [...rows].sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol];
      if (av == null) return 1;
      if (bv == null) return -1;
      // Booleans: treat true=1, false=0 for numeric comparison
      const na = typeof av === "boolean" ? (av ? 1 : 0) : av;
      const nb = typeof bv === "boolean" ? (bv ? 1 : 0) : bv;
      const cmp = typeof na === "number" && typeof nb === "number"
        ? na - nb
        : String(na).localeCompare(String(nb));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [rows, sortCol, sortDir]);

  return { sorted, sortCol, sortDir, handleSort };
}

function SortIcon({ col, sortCol, sortDir }: { col: string; sortCol: string | null; sortDir: SortDir }) {
  if (sortCol !== col) return <ChevronsUpDown className="h-3 w-3 ml-1 text-muted-foreground opacity-50 inline" />;
  if (sortDir === "asc") return <ChevronUp className="h-3 w-3 ml-1 text-[#2563EB] inline" />;
  if (sortDir === "desc") return <ChevronDown className="h-3 w-3 ml-1 text-[#2563EB] inline" />;
  return <ChevronsUpDown className="h-3 w-3 ml-1 text-muted-foreground opacity-50 inline" />;
}

// ─── Catalogue Score (Ziv + Kronos composite) ───────────────────────────────
function CatalogueScoreCell({
  ticker,
  zivScore,
  compositeScore,
  kronosBias,
  kronosDirection,
}: {
  ticker: string;
  zivScore: number | null;
  compositeScore: number | null;
  kronosBias: number | null;
  kronosDirection: string | null;
}) {
  const display = compositeScore ?? zivScore;
  const tip = kronosBias != null && zivScore != null
    ? `Ziv ${zivScore.toFixed(1)} + Kronos ${kronosBias >= 0 ? "+" : ""}${kronosBias.toFixed(1)} = ${(display ?? 0).toFixed(1)}`
    : "Ziv score (Kronos pending)";
  return (
    <div className="flex flex-col items-center gap-0.5" title={tip}>
      <ZivBreakdownPopover ticker={ticker} score={display} />
      {kronosBias != null && (
        <span className={cn(
          "text-[9px] font-semibold",
          kronosDirection === "UP" ? "text-[#65A30D]" : kronosDirection === "DOWN" ? "text-[#FF6B6B]" : "text-muted-foreground",
        )}>
          {kronosDirection === "UP" ? "▲" : kronosDirection === "DOWN" ? "▼" : "—"} K{Math.abs(kronosBias).toFixed(1)}
        </span>
      )}
    </div>
  );
}

// ─── ZIV Breakdown Popover ──────────────────────────────────────────────────
function ZivBreakdownPopover({ ticker, score }: { ticker: string; score: number | null }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = trpc.portfolio.getQuickStats.useQuery(
    { ticker },
    { enabled: open, staleTime: 60_000 }
  );
  const bd = (data as any)?.breakdown;

  const components = [
    { label: "RSI", key: "rsi", max: 0.20, desc: "Momentum" },
    { label: "Volume", key: "volume", max: 0.20, desc: "Confirmation" },
    { label: "Proximity", key: "proximity", max: 0.20, desc: "Entry quality" },
    { label: "Golden Cross", key: "goldenCross", max: 0.15, desc: "EMA-20>EMA-50" },
    { label: "52W High", key: "high52w", max: 0.15, desc: "Near peak" },
    { label: "ATR Coil", key: "atrContraction", max: 0.09, desc: "Pre-breakout" },
    { label: "Trend Str.", key: "trendStrength", max: 0.20, desc: "Slope+bars" },
    { label: "Profit Pot.", key: "profitPotential", max: 0.20, desc: "Upside room" },
  ];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="cursor-pointer hover:opacity-80 transition-opacity"
          title="לחץ לפירוט ZIV Score"
        >
          {score != null ? <ScoreBadge score={score} /> : (
            <span className="text-muted-foreground text-xs px-2 py-0.5 rounded bg-slate-100 border border-slate-200" title="Not enough price history for scoring (< 50 bars)">
              N/A
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" side="left" align="start">
        <div className="flex items-center gap-1.5 mb-2">
          <Zap className="h-3.5 w-3.5 text-amber-500" />
          <span className="text-xs font-semibold">{ticker} — ZIV Score Breakdown</span>
          {bd && (
            <span className="ml-auto text-[10px] text-muted-foreground font-mono">v2.2 · +{bd.total?.toFixed(2) ?? '—'}</span>
          )}
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center py-4 gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> טוען...
          </div>
        ) : !bd ? (
          <p className="text-xs text-muted-foreground text-center py-3">אין נתוני Breakdown</p>
        ) : (
          <div className="grid grid-cols-4 gap-1">
            {components.map((item) => {
              const value = bd[item.key] ?? 0;
              const pct = item.max > 0 ? (value / item.max) * 100 : 0;
              const barColor = pct >= 80 ? "bg-emerald-500" : pct >= 50 ? "bg-blue-400" : pct >= 20 ? "bg-amber-400" : "bg-red-300";
              return (
                <div key={item.key} className="bg-muted/30 border rounded p-1.5">
                  <div className="text-[9px] text-muted-foreground font-medium truncate">{item.label}</div>
                  <div className="font-mono font-bold text-[10px] mt-0.5">
                    {value.toFixed(2)}<span className="text-muted-foreground font-normal">/{item.max.toFixed(2)}</span>
                  </div>
                  <div className="mt-0.5 h-1 bg-muted rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                  </div>
                  <div className="text-[8px] text-muted-foreground mt-0.5">{item.desc}</div>
                </div>
              );
            })}
          </div>
        )}
        {bd?.isOverride && (
          <div className="mt-2 flex items-center gap-1 text-[10px] text-amber-600 bg-amber-50 rounded px-2 py-1">
            <Zap className="h-3 w-3" /> ⚡ Gold Breakout Override — EMA-200 bypassed (High Volume)
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ─── ⭐ VIP (SELECTED_TEAM) chip — owner's priority ticker ────────────────────
// Amber, icon + text (never color-alone), ≥11px, wraps cleanly at 375px.
// Matches the War Room ⭐ נבחרת aesthetic. Renders only when ticker ∈ vip set.
function VipChip() {
  return (
    <span
      title="נבחרת — VIP priority ticker (owner's SELECTED_TEAM)"
      aria-label="VIP — SELECTED_TEAM priority ticker"
      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[11px] font-bold tracking-wide whitespace-nowrap bg-amber-100 text-amber-800 border border-amber-300"
    >
      <Star className="w-3 h-3 shrink-0 fill-amber-500 text-amber-500" aria-hidden />
      VIP
    </span>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function AssetCatalogue() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [priceRefreshedAt, setPriceRefreshedAt] = useState<Date | null>(null);
  const [filterText, setFilterText] = useState("");
  const [sectorFilter, setSectorFilter] = useState<string>("All");

  // DB data
  const { data: catalogueDbData, isLoading: catalogueLoading, isError: catalogueError, error: catalogueErrorObj, refetch: refetchCatalogue } = trpc.portfolio.getCatalogueWithScores.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 120_000,
    gcTime: 300_000,
    retry: 1,
  });
  const catalogueReady = catalogueDbData !== undefined;
  const catalogueInitialLoad = catalogueLoading && !catalogueDbData;

  // Merge DB data into a single flat row shape
  const allAssets = useMemo(() => {
    if (!catalogueDbData) return [];
    return (catalogueDbData as any[]).map((a) => ({
      ticker: a.ticker as string,
      company: (a.company ?? "") as string,
      sector: (a.sector ?? "") as string,
      zivScore: a.score != null ? Number(a.score) : null as number | null,
      compositeScore: a.compositeScore != null ? Number(a.compositeScore) : (a.score != null ? Number(a.score) : null),
      kronosBias: a.kronosBias != null ? Number(a.kronosBias) : null,
      kronosDirection: (a.kronosDirection ?? null) as string | null,
      kronosBandPct: a.kronosBandPct != null ? Number(a.kronosBandPct) : null,
      tier: (a.tier ?? null) as string | null,
      recommendation: (a.recommendation ?? null) as string | null,
      cmp: a.cmp != null ? Number(a.cmp) : null as number | null,
      ema50: a.ema50 != null ? Number(a.ema50) : null as number | null,
      ema200: a.ema200 != null ? Number(a.ema200) : null as number | null,
      dailyChangePercent: a.dailyChangePercent != null ? Number(a.dailyChangePercent) : null as number | null,
      recommendedBuyPrice: a.recommendedBuyPrice != null ? Number(a.recommendedBuyPrice) : null as number | null,
      recommendedStopLoss: a.recommendedStopLoss != null ? Number(a.recommendedStopLoss) : null as number | null,
      hotSignal: a.hotSignal === true || a.hotSignal === 1,
      scannedAt: a.scannedAt ?? null,
      profitPotential: a.profitPotential != null ? Number(a.profitPotential) : null as number | null,
      note: (a.note ?? null) as string | null,
      catalogStatus: (a.catalogStatus ?? null) as string | null,
      kineticScore: a.kineticScore != null ? Number(a.kineticScore) : null,
    }));
  }, [catalogueDbData]);

  // ── Multi-select ──────────────────────────────────────────────────────────
  const [selectedTickers, setSelectedTickers] = useState<Set<string>>(new Set());

  const toggleSelect = useCallback((ticker: string) => {
    setSelectedTickers(prev => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker); else next.add(ticker);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (selectedTickers.size === allAssets.length) setSelectedTickers(new Set());
    else setSelectedTickers(new Set(allAssets.map(a => a.ticker)));
  }, [allAssets, selectedTickers.size]);

  const allSelected = allAssets.length > 0 && selectedTickers.size === allAssets.length;
  const someSelected = selectedTickers.size > 0 && !allSelected;

  // ── Bulk delete ───────────────────────────────────────────────────────────
  const bulkDeleteMut = trpc.assetCatalogue.bulkDeleteUserAssets.useMutation({
    onSuccess: (data, variables) => {
      toast.success(`Deleted ${data.deleted} asset${data.deleted !== 1 ? "s" : ""}`);
      setSelectedTickers(prev => {
        const next = new Set(prev);
        variables.tickers.forEach(t => next.delete(t));
        return next;
      });
      // Force immediate refetch to update the table (fixes delete-not-disappearing bug)
      refetchCatalogue();
    },
    onError: (e) => toast.error(e.message),
  });

  const handleBulkDelete = () => {
    const tickers = Array.from(selectedTickers);
    if (!window.confirm(`Delete ${tickers.length} asset${tickers.length !== 1 ? "s" : ""}?\n\n${tickers.join(", ")}`)) return;
    bulkDeleteMut.mutate({ tickers });
  };

  // ── Archive ───────────────────────────────────────────────────────────────
  const [archivePanelOpen, setArchivePanelOpen] = useState(false);
  const archiveMut = trpc.portfolio.archiveAssets.useMutation({
    onSuccess: (data) => {
      toast.success(`${data.count} נכס${data.count !== 1 ? "ים" : ""} הועברו לארכיון`);
      setSelectedTickers(new Set());
      utils.portfolio.getCatalogueWithScores.invalidate();
      utils.portfolio.getArchivedAssets.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const restoreMut = trpc.portfolio.restoreAssets.useMutation({
    onSuccess: (data) => {
      toast.success(`${data.count} נכס${data.count !== 1 ? "ים" : ""} שוחזרו`);
      utils.portfolio.getCatalogueWithScores.invalidate();
      utils.portfolio.getArchivedAssets.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const deleteFromArchiveMut = trpc.portfolio.bulkDeleteAssets.useMutation({
    onSuccess: (data) => {
      toast.success(`${data.count} נכס${data.count !== 1 ? "ים" : ""} נמחקו לצמיתות`);
      utils.portfolio.getArchivedAssets.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const archivedQuery = trpc.portfolio.getArchivedAssets.useQuery(undefined, { enabled: archivePanelOpen });

  const handleArchiveSelected = () => {
    const tickers = Array.from(selectedTickers);
    if (!window.confirm(`העבר ${tickers.length} נכס${tickers.length !== 1 ? "ים" : ""} לארכיון?\n\n${tickers.join(", ")}`)) return;
    archiveMut.mutate({ tickers });
  };

  // ── Quick Buy Dialog ──────────────────────────────────────────────────────────────
  const [buyDialog, setBuyDialog] = useState<{
    ticker: string;
    recommendedBuyPrice: number | null;
    recommendedStopLoss: number | null;
    cmp: number | null;
  } | null>(null);
  const [buyUnits, setBuyUnits] = useState("");
  const [buyPrice, setBuyPrice] = useState("");

  const addHoldingMut = trpc.portfolio.addHolding.useMutation({
    onSuccess: () => {
      toast.success(`נוסף לתיק בהצלחה!`);
      setBuyDialog(null);
      setBuyUnits("");
      setBuyPrice("");
    },
    onError: (e) => toast.error(e.message),
  });

  const handleOpenBuyDialog = (r: { ticker: string; recommendedBuyPrice: number | null; recommendedStopLoss: number | null; cmp: number | null }) => {
    setBuyDialog(r);
    setBuyPrice(r.recommendedBuyPrice != null ? r.recommendedBuyPrice.toFixed(2) : r.cmp != null ? r.cmp.toFixed(2) : "");
    setBuyUnits("");
  };

  const handleConfirmBuy = () => {
    if (!buyDialog) return;
    const units = parseFloat(buyUnits);
    const price = parseFloat(buyPrice);
    if (!units || units <= 0) { toast.error("אנא הכנס כמות תקינה"); return; }
    if (!price || price <= 0) { toast.error("אנא הכנס מחיר תקין"); return; }
    addHoldingMut.mutate({
      ticker: buyDialog.ticker,
      buyPrice: price,
      units,
      notes: buyDialog.recommendedStopLoss != null ? `SL: $${buyDialog.recommendedStopLoss.toFixed(2)}` : undefined,
    });
  };

  // ── Fast-add row ──────────────────────────────────────────────────────────
  const [fastAddTicker, setFastAddTicker] = useState("");
  const [fastAddCompany, setFastAddCompany] = useState("");
  const fastAddRef = useRef<HTMLInputElement>(null);
  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const [autocompleteQuery, setAutocompleteQuery] = useState("");
  const autocompleteRef = useRef<HTMLDivElement>(null);
  // Debounce: only fire search after 300ms of no typing
  useEffect(() => {
    const t = setTimeout(() => setAutocompleteQuery(fastAddTicker.trim()), 300);
    return () => clearTimeout(t);
  }, [fastAddTicker]);
  const tickerSearchQuery = trpc.searchTicker.useQuery(
    { q: autocompleteQuery },
    { enabled: autocompleteQuery.length >= 1, staleTime: 30_000 }
  );
  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (autocompleteRef.current && !autocompleteRef.current.contains(e.target as Node)) {
        setAutocompleteOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ── Auto-analyze single ticker after add ─────────────────────────────────
  const [analyzingSingleTicker, setAnalyzingSingleTicker] = useState<string | null>(null);

  const runAnalyzeSingle = async (ticker: string) => {
    setAnalyzingSingleTicker(ticker);
    try {
      const res = await fetch("/api/portfolio/analyze-single", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker }),
      });
      const data = await res.json();
      if (data.ok) {
        toast.success(`✓ ${ticker} — ZIV ${data.zivScore?.toFixed(1)} (${data.tier})`);
        refetchCatalogue();
      } else {
        toast.warning(`${ticker}: ${data.reason || data.error || "ניתוח נכשל"}`);
      }
    } catch (err: any) {
      toast.error(`שגיאה בניתוח ${ticker}: ${err?.message}`);
    } finally {
      setAnalyzingSingleTicker(null);
    }
  };

  const addAssetMut = trpc.assetCatalogue.addUserAsset.useMutation({
    onSuccess: (_data, variables) => {
      const ticker = variables.ticker.toUpperCase();
      toast.success(`✓ ${ticker} נוסף — מריץ ניתוח...`);
      setFastAddTicker(""); setFastAddCompany("");
      // Preserve scroll position during invalidate to prevent page jump
      const scrollY = window.scrollY;
      refetchCatalogue().then(() => {
        requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: 'instant' }));
      });
      fastAddRef.current?.focus();
      // Auto-analyze the newly added ticker
      runAnalyzeSingle(ticker);
    },
    onError: (e) => {
      // Show validation errors with a longer duration so user can read them
      const isValidation = e.message.startsWith("❌");
      toast.error(e.message, { duration: isValidation ? 7000 : 4000 });
    },
  });

  const handleFastAdd = () => {
    const ticker = fastAddTicker.trim().toUpperCase();
    if (!ticker) { toast.error("Enter a ticker symbol"); return; }
    if (allAssets.some(a => a.ticker === ticker)) { toast.error(`${ticker} already in catalogue`); return; }
    addAssetMut.mutate({ ticker, companyName: fastAddCompany.trim(), sector: "Custom" });
  };

  // ── Inline edit: profitPotential + note ─────────────────────────────────
  const [editingCell, setEditingCell] = useState<{ ticker: string; field: "profitPotential" | "note" } | null>(null);
  const [editValue, setEditValue] = useState("");
  const updateAssetMetaMut = trpc.assetCatalogue.updateAssetMeta.useMutation({
    onSuccess: () => {
      setEditingCell(null);
      utils.portfolio.getCatalogueWithScores.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const commitEdit = (ticker: string, field: "profitPotential" | "note") => {
    if (field === "profitPotential") {
      const val = parseFloat(editValue);
      updateAssetMetaMut.mutate({ ticker, profitPotential: isNaN(val) ? null : val });
    } else {
      updateAssetMetaMut.mutate({ ticker, note: editValue.trim() || null });
    }
  };

  const [tableCollapsed, setTableCollapsed] = useState(false);

  // ── Refresh prices only (fast, no ZIV scan) ─────────────────────────────
  const [refreshingPrices, setRefreshingPrices] = useState(false);
  const [silentPriceRefresh, setSilentPriceRefresh] = useState(false);
  const refreshPricesMut = trpc.portfolio.refreshCataloguePrices.useMutation({
    onSuccess: (data) => {
      setRefreshingPrices(false);
      setPriceRefreshedAt(new Date());
      // Background refetch only — invalidate() caused constant full-page flicker
      void refetchCatalogue();
      if (!silentPriceRefresh) {
        toast.success(`עודכנו מחירים ל-${(data as any).updated ?? 0} נכסים`);
      }
      setSilentPriceRefresh(false);
    },
    onError: (e) => { toast.error(e.message); setRefreshingPrices(false); setSilentPriceRefresh(false); },
  });

  // ── Admin: Refresh all users' catalogue scores ──────────────────────────────────────────────────────
  const adminRefreshAllMut = trpc.portfolio.adminRefreshAllCatalogueScores.useMutation({
    onSuccess: (data) => {
      utils.portfolio.getCatalogueWithScores.invalidate();
      toast.success(`עודכנו ${(data as any).updated ?? 0} נכסים ל-${(data as any).users ?? 0} משתמשים`);
    },
    onError: (e) => toast.error(e.message),
  });
  // ── Admin: Copy catalogue to specific user ──────────────────────────────────
  const [selectedCopyUserId, setSelectedCopyUserId] = useState<number | null>(null);
  const localUsersQuery = trpc.localUsers.list.useQuery(undefined, { enabled: isAdmin });
  const adminCopyMut = trpc.portfolio.adminCopyCatalogueToUser.useMutation({
    onSuccess: (data) => {
      toast.success(`נוספו ${(data as any).added ?? 0} מניות מתוך ${(data as any).total ?? 0} למשתמש`);
    },
    onError: (e) => toast.error(e.message),
  });

  // ── Load Alerts from Catalogue (ZIV >= 8) ────────────────────────────────────────────────────────
  const loadAlertsMut = trpc.priceAlerts.loadAlertsFromCatalogue.useMutation({
    onSuccess: (data) => {
      const d = data as any;
      if (d.created === 0) {
        toast.info(`אין מניות חדשות — ${d.skipped ?? 0} כבר קיימות`);
      } else {
        toast.success(`נוצרו ${d.created} איתותים מתוך ${d.created + d.skipped} מניות`);
      }
    },
    onError: (e) => toast.error(e.message),
  });

  // ── Analyze all (SSE streaming) ─────────────────────────────────────────────
  const [analyzingAssets, setAnalyzingAssets] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState(0);
  const [analyzeMessage, setAnalyzeMessage] = useState("");
  const [analyzeDone, setAnalyzeDone] = useState(0);
  const [analyzeTotal, setAnalyzeTotal] = useState(0);
  const analyzeAbortRef = useRef<(() => void) | null>(null);

  const runAnalyzeStream = async () => {
    setAnalyzingAssets(true);
    setAnalyzeProgress(0);
    setAnalyzeMessage("מתחיל סריקה...");
    setAnalyzeDone(0);
    setAnalyzeTotal(0);
    let aborted = false;
    const controller = new AbortController();
    analyzeAbortRef.current = () => { aborted = true; controller.abort(); };

    try {
      const res = await fetch("/api/portfolio/analyze-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      });
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream");
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done || aborted) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === "start") {
              setAnalyzeTotal(ev.total);
              setAnalyzeMessage(`סורק ${ev.total} נכסים...`);
            } else if (ev.type === "result" || ev.type === "skip") {
              setAnalyzeDone(ev.progress.done);
              setAnalyzeTotal(ev.progress.total);
              setAnalyzeProgress(ev.progress.pct);
              setAnalyzeMessage(
                ev.type === "result"
                  ? `${ev.ticker} — ZIV ${ev.zivScore?.toFixed(1)} (${ev.tier})`
                  : `${ev.ticker} — דילוג (אין מספיק נתונים)`
              );
              // Optimistically update the row in the table without full refetch
              if (ev.type === "result") {
                refetchCatalogue();
              }
            } else if (ev.type === "done") {
              setAnalyzeProgress(100);
              setAnalyzeMessage(`הסריקה הושלמה — ${ev.totalScanned} נכסים נסרקו`);
              setLastRefreshed(new Date());
              utils.portfolio.getCatalogueWithScores.invalidate();
              toast.success(`✓ נסרקו ${ev.totalScanned} נכסים — ציוני ZIV עודכנו`);
              if (ev.skippedTickers?.length > 0) {
                toast.warning(
                  `⚠️ ${ev.skippedTickers.length} טיקר${ev.skippedTickers.length > 1 ? 'ים' : ''} דולגו: ${ev.skippedTickers.join(', ')}`,
                  { duration: 12000 }
                );
              }
              setTimeout(() => setAnalyzingAssets(false), 1500);
            } else if (ev.type === "error") {
              toast.error(`שגיאה: ${ev.message}`);
              setAnalyzingAssets(false);
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch (err: any) {
      if (!aborted) toast.error(`שגיאה בסריקה: ${err?.message}`);
      setAnalyzingAssets(false);
    }
  };

  // ── Market Scan (5 strategies, SSE streaming) ────────────────────────────
  type ScanCandidate = {
    ticker: string; companyName: string; score: number; tier: string;
    reason: string; meetsEntry: boolean; entryZone: string; stopLoss: string;
    takeProfit: string; price: number; sector: string; volume: number;
  };
  const SCAN_TYPES = [
    { id: "finviz",   label: "Finviz Screener",   desc: "Non-Tech · RSI 40-60 · Volume >500K · Momentum",     color: "border-purple-400 text-[#2563EB] hover:bg-purple-50" },
    { id: "tvscreen", label: "TradingView Screen", desc: "EMA50>EMA200 · RSI 50-70 · Low volatility · Orderly", color: "border-[#2563EB] text-blue-700 hover:bg-blue-50" },
    { id: "whale",    label: "Whale Wisdom",       desc: "Berkshire · Bridgewater · Top hedge fund holdings",   color: "border-indigo-400 text-indigo-700 hover:bg-indigo-50" },
    { id: "ibd",      label: "IBD RS Rating",      desc: "RS vs SPY >85th pct · Near 52-week high · Growth",   color: "border-amber-400 text-amber-400 hover:bg-amber-100" },
    { id: "sector",   label: "Sector Rotation",    desc: "סקטורים מובילים 30י · Top stocks per sector",                color: "border-emerald-600 text-emerald-700 hover:bg-emerald-50" },
  ];
  const [activeScanType, setActiveScanType] = useState<string | null>(null);
  const [findingMarket, setFindingMarket] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanMessage, setScanMessage] = useState("");
  const [marketReplacements, setMarketReplacements] = useState<ScanCandidate[] | null>(null);
  const [activeScanLabel, setActiveScanLabel] = useState("");
  const scanAbortRef = useRef<(() => void) | null>(null);

  // Track which scan sources each ticker was found in
  const [scanSources, setScanSources] = useState<Record<string, string[]>>({});

  const runMarketScan = useCallback(async () => {
    if (findingMarket) return;
    setActiveScanType("all");
    setActiveScanLabel("Scan All");
    setFindingMarket(true);
    setScanProgress(0);
    setScanMessage("מריץ את כל הסריקות במקביל...");
    setMarketReplacements(null);
    setScanSources({});
    let aborted = false;
    const controllers = SCAN_TYPES.map(() => new AbortController());
    scanAbortRef.current = () => { aborted = true; controllers.forEach(c => c.abort()); };

    // Accumulate results from all scan types
    const allResults: Map<string, ScanCandidate & { sources: string[] }> = new Map();
    let completedScans = 0;

    const runOneScan = async (scan: typeof SCAN_TYPES[0], controller: AbortController) => {
      try {
        const res = await fetch("/api/market-scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scanType: scan.id, topN: 15 }),
          signal: controller.signal,
        });
        const reader = res.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done || aborted) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.results) {
                for (const c of ev.results as ScanCandidate[]) {
                  if (c.score < 7) continue;
                  const existing = allResults.get(c.ticker);
                  if (existing) {
                    if (!existing.sources.includes(scan.label)) existing.sources.push(scan.label);
                    if (c.score > existing.score) allResults.set(c.ticker, { ...c, sources: existing.sources });
                  } else {
                    allResults.set(c.ticker, { ...c, sources: [scan.label] });
                  }
                }
              }
            } catch { /* skip malformed */ }
          }
        }
      } catch (err: any) {
        if (!aborted) console.warn(`Scan ${scan.id} failed:`, err?.message);
      } finally {
        completedScans++;
        const pct = Math.round((completedScans / SCAN_TYPES.length) * 90);
        setScanProgress(pct);
        setScanMessage(`הושלמו ${completedScans}/${SCAN_TYPES.length} סריקות...`);
      }
    };

    await Promise.all(SCAN_TYPES.map((scan, i) => runOneScan(scan, controllers[i])));

    if (!aborted) {
      // Sort by score desc, take top 15
      const merged = Array.from(allResults.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, 15);
      const sourcesMap: Record<string, string[]> = {};
      merged.forEach(c => { sourcesMap[c.ticker] = c.sources; });
      setMarketReplacements(merged);
      setScanSources(sourcesMap);
      setScanProgress(100);
      setFindingMarket(false);
      const good = merged.filter(c => c.meetsEntry).length;
      toast.success(`Scan All: נמצאו ${merged.length} נכסים עם ציון ≥7 (${good} עם כניסה)`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findingMarket]);


  // Set lastRefreshed on mount
  useEffect(() => {
    setLastRefreshed(new Date());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-refresh prices when catalogue data loads and scannedAt is stale (> 30 min)
  // This fixes 0% dailyChangePercent when last scan ran while market was closed
  const [autoRefreshDone, setAutoRefreshDone] = useState(false);
  useEffect(() => {
    if (autoRefreshDone) return;
    if (!catalogueDbData) return;
    const data = catalogueDbData as any[];
    if (data.length === 0) { setAutoRefreshDone(true); return; }
    const mostRecent = data.reduce((latest: any, a: any) => {
      if (!a.scannedAt) return latest;
      if (!latest) return a;
      return new Date(a.scannedAt) > new Date(latest.scannedAt) ? a : latest;
    }, null);
    const isStale = !mostRecent?.scannedAt ||
      (Date.now() - new Date(mostRecent.scannedAt).getTime()) > 30 * 60 * 1000;
    setAutoRefreshDone(true);
    if (isStale) {
      setSilentPriceRefresh(true);
      refreshPricesMut.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogueDbData]);

  // ── Retest Watchlist ─────────────────────────────────────────────────────────────────────────────────
  const [retestResults, setRetestResults] = useState<{
    ticker: string; company: string; breakoutPrice: number; breakoutDate: string;
    currentPrice: number; retestZoneLow: number; retestZoneHigh: number;
    inRetestZone: boolean; distToRetestZonePct: number; zivScore: number;
    signal: "IN_ZONE" | "APPROACHING" | "ABOVE_ZONE";
  }[] | null>(null);
  const [scanningRetest, setScanningRetest] = useState(false);
  const retestMut = trpc.portfolio.getRetestWatchlist.useMutation({
    onSuccess: (data) => {
      setRetestResults(data.watchlist);
      setScanningRetest(false);
      const inZone = data.watchlist.filter(w => w.signal === "IN_ZONE").length;
      const approaching = data.watchlist.filter(w => w.signal === "APPROACHING").length;
      if (data.watchlist.length === 0) {
        toast.info(`Scanned ${data.scannedCount} assets — no confirmed breakouts in last 30 days.`);
      } else if (inZone > 0) {
        toast.success(`🔁 ${inZone} ticker${inZone > 1 ? 's' : ''} IN Retest Zone! ${approaching > 0 ? `+${approaching} approaching.` : ''}`);
      } else {
        toast.info(`${approaching} ticker${approaching > 1 ? 's' : ''} approaching Retest Zone. Scanned ${data.scannedCount} assets.`);
      }
    },
    onError: (e) => { toast.error(e.message); setScanningRetest(false); },
  });

  const isAnyBusy = analyzingAssets || findingMarket || scanningRetest || refreshingPrices || bulkDeleteMut.isPending || addAssetMut.isPending;

  // ── Holdings tickers (for "בתיק" indicator) ─────────────────────────────
  const { data: portfolioState } = trpc.portfolio.getState.useQuery(undefined, {
    refetchOnWindowFocus: true,
  });
  const { data: h2Data } = trpc.holding2.list.useQuery(undefined, { refetchOnWindowFocus: true });
  const h2Tickers = useMemo(() => {
    if (!h2Data) return new Set<string>();
    const tickers = new Set<string>();
    for (const h of h2Data as any[]) {
      const t = (h as any).ticker.toUpperCase();
      tickers.add(t);
      // Alias GOOG <-> GOOGL (same company, two share classes)
      if (t === "GOOG") tickers.add("GOOGL");
      if (t === "GOOGL") tickers.add("GOOG");
      // Alias BRK variants
      if (t === "BRK.B") tickers.add("BRK/B");
      if (t === "BRK/B") tickers.add("BRK.B");
      if (t === "BRK.A") tickers.add("BRK/A");
      if (t === "BRK/A") tickers.add("BRK.A");
    }
    return tickers;
  }, [h2Data]);
  const holdingTickers = useMemo(() => {
    if (!portfolioState?.holdings) return new Set<string>();
    const tickers = new Set<string>();
    for (const h of portfolioState.holdings as any[]) {
      const t = h.ticker.toUpperCase();
      tickers.add(t);
      // Alias GOOG <-> GOOGL (same company, two share classes)
      if (t === "GOOG") tickers.add("GOOGL");
      if (t === "GOOGL") tickers.add("GOOG");
      // Alias BRK variants
      if (t === "BRK.B") tickers.add("BRK/B");
      if (t === "BRK/B") tickers.add("BRK.B");
      if (t === "BRK.A") tickers.add("BRK/A");
      if (t === "BRK/A") tickers.add("BRK.A");
    }
    return tickers;
  }, [portfolioState]);

  // ── ZIV H Health scores (for portfolio tickers) ──────────────────────────
  const { data: zivHScores } = trpc.portfolio.getZivHScores.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const { data: zivHScoresH2 } = trpc.portfolio.getZivHScoresH2.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  // Build ticker-keyed maps for quick lookup
  const zivHByTicker = useMemo(() => {
    const m: Record<string, any> = {};
    if (zivHScores) for (const s of zivHScores as any[]) m[(s as any).ticker.toUpperCase()] = s;
    return m;
  }, [zivHScores]);
  const zivHByTickerH2 = useMemo(() => {
    const m: Record<string, any> = {};
    if (zivHScoresH2) for (const s of zivHScoresH2 as any[]) m[(s as any).ticker.toUpperCase()] = s;
    return m;
  }, [zivHScoresH2]);

  // ── Active signals from Master Knowledge (for ✓ indicator) ─────────────────
  const { data: mkData } = trpc.masterKnowledge.get.useQuery(undefined, { staleTime: 60_000 });
  const signalTickers = useMemo(() => {
    if (!mkData?.Active_Signals) return new Set<string>();
    return new Set(
      (mkData.Active_Signals as Array<{ ticker: string; status?: string }>)
        .filter(s => s.status !== "closed")
        .map(s => s.ticker.toUpperCase())
    );
  }, [mkData]);

  // ── ⭐ VIP (SELECTED_TEAM) set — owner's priority tickers ─────────────────────
  // Defensive: backhand exposes `selectedTeam: string[]` (uppercased) on the
  // catalogue query. It may land as a top-level field on the response OR ride
  // on the first row — accept either. Empty/absent ⇒ no ⭐ renders, never crashes.
  const { data: vipList } = trpc.portfolio.getSelectedTeam.useQuery(undefined, { staleTime: 60_000 });
  const vip = useMemo(() => {
    const raw =
      (vipList as any) ??
      (catalogueDbData as any)?.selectedTeam ??
      (Array.isArray(catalogueDbData) ? (catalogueDbData[0] as any)?.selectedTeam : undefined) ??
      [];
    return new Set(
      (Array.isArray(raw) ? raw : [])
        .filter((t: any) => t != null)
        .map((t: any) => String(t).toUpperCase()),
    );
  }, [catalogueDbData, vipList]);

  // ── Active Price Alerts (for ✓ checkmark in catalogue) ──────────────────────
  const { data: activeAlertsData } = trpc.priceAlerts.getAll.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const activeAlertTickers = useMemo(() => {
    if (!activeAlertsData) return new Set<string>();
    const alertsArr = (activeAlertsData as any)?.alerts ?? (Array.isArray(activeAlertsData) ? activeAlertsData : []);
    return new Set(
      (alertsArr as any[])
        .filter((a: any) => !a.triggered && !a.dismissed && !a.archived)
        .map((a: any) => (a.ticker as string).toUpperCase())
    );
  }, [activeAlertsData]);

  // ── Add Alert dialog (opened from Buy Price click) ────────────────────────────
  const [addAlertDialog, setAddAlertDialog] = useState<{
    ticker: string; price: string;
  } | null>(null);
  const [alertDirection, setAlertDirection] = useState<"below" | "above">("below");
  const [alertLabel, setAlertLabel] = useState("");
  const createAlertMut = trpc.priceAlerts.create.useMutation({
    onSuccess: () => {
      toast.success(`✅ התראה נוצרה עבור ${addAlertDialog?.ticker}`);
      setAddAlertDialog(null);
      utils.priceAlerts.getAll.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  function handleOpenAddAlertDialog(r: { ticker: string; recommendedBuyPrice: number | null; cmp: number | null }) {
    const price = r.recommendedBuyPrice ?? r.cmp ?? 0;
    setAddAlertDialog({ ticker: r.ticker, price: price > 0 ? price.toFixed(2) : "" });
    setAlertDirection("below");
    setAlertLabel("");
  }

  // ── Add Signal dialog (opened from Buy Price click) ──────────────────────────
  const [signalDialog, setSignalDialog] = useState<{
    ticker: string; company: string; entry: string;
    stopLoss: string; takeProfit: string; catalyst: string; zivScore: number;
  } | null>(null);

  const addSignalMut = trpc.masterKnowledge.addSignal.useMutation({
    onSuccess: () => {
      toast.success(`✅ איתות ${signalDialog?.ticker} נוסף לאיתותים פעילים`);
      setSignalDialog(null);
      utils.masterKnowledge.get.invalidate();
    },
    onError: (e) => toast.error(`שגיאה: ${e.message}`),
  });

  function handleOpenSignalDialog(r: { ticker: string; company?: string | null; recommendedBuyPrice: number | null; recommendedStopLoss: number | null; zivScore: number | null; cmp: number | null }) {
    const entry = r.recommendedBuyPrice ?? r.cmp ?? 0;
    const sl = r.recommendedStopLoss ?? 0;
    const tp = entry > 0 ? (entry * 1.15) : 0;
    setSignalDialog({
      ticker: r.ticker,
      company: r.company ?? r.ticker,
      entry: entry.toFixed(2),
      stopLoss: sl > 0 ? sl.toFixed(2) : "",
      takeProfit: tp > 0 ? tp.toFixed(2) : "",
      catalyst: r.zivScore != null ? `Ziv Score ${r.zivScore}/10` : "",
      zivScore: r.zivScore ?? 0,
    });
  }

  function confirmAddSignal() {
    if (!signalDialog) return;
    addSignalMut.mutate({
      ticker: signalDialog.ticker,
      company: signalDialog.company,
      entry: signalDialog.entry ? `$${signalDialog.entry}` : "",
      stopLoss: signalDialog.stopLoss ? `$${signalDialog.stopLoss}` : "",
      takeProfit: signalDialog.takeProfit ? `$${signalDialog.takeProfit}` : "",
      catalyst: signalDialog.catalyst,
      source: "Asset Catalogue",
      signalDate: new Date().toISOString().split("T")[0],
      zivScore: signalDialog.zivScore,
    });
  }

  //  // ── Unified table sort (default: zivScore desc) ───────────────────────
  const { sorted: sortedAllAssets, sortCol, sortDir, handleSort } = useSortableTable(allAssets, 'compositeScore', 'desc');

  // ── Quick filter (client-side by ticker/company + sector) ──────────────────────────────
  const sortedAssets = useMemo(() => {
    let filtered = sortedAllAssets;
    if (sectorFilter !== "All") {
      filtered = filtered.filter(a => a.sector === sectorFilter);
    }
    if (filterText.trim()) {
      const q = filterText.trim().toLowerCase();
      filtered = filtered.filter(a =>
        a.ticker.toLowerCase().includes(q) ||
        (a.company && a.company.toLowerCase().includes(q))
      );
    }
    return filtered;
  }, [sortedAllAssets, filterText, sectorFilter]);

  // ── Extract unique sectors from USA assets for filter buttons ──────────────────
  const usaSectors = useMemo(() => {
    const sectors = new Set<string>();
    for (const a of sortedAllAssets) {
      if (!a.ticker.endsWith('.TA') && a.sector) sectors.add(a.sector);
    }
    return Array.from(sectors).sort();
  }, [sortedAllAssets]);

  // ── Split into USA / ISR ─────────────────────────────────────────────────────
  const usaAssets = useMemo(() => sortedAssets.filter(a => !a.ticker.endsWith('.TA')), [sortedAssets]);
  const isrAssets = useMemo(() => sortedAssets.filter(a => a.ticker.endsWith('.TA')), [sortedAssets]);

  const TH = ({ col, label, align = "left" }: { col: string; label: string; align?: "left" | "center" | "right" }) => (
    <TableHead
      className={`text-xs font-semibold cursor-pointer select-none hover:bg-muted/40 whitespace-nowrap ${align === "center" ? "text-center" : align === "right" ? "text-right" : ""}`}
      style={{ touchAction: 'manipulation', minHeight: '44px' }}
      onClick={() => handleSort(col as any)}
    >
      {label}
      <SortIcon col={col} sortCol={sortCol as string | null} sortDir={sortDir} />
    </TableHead>
  );

  return (
    <div className="container py-6 space-y-5 max-w-7xl overflow-x-hidden">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Zap className="h-5 w-5 text-[#2563EB]" />
            Asset Catalogue
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {catalogueInitialLoad ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                טוען קטלוג...
              </span>
            ) : (
              <>{allAssets.length} assets</>
            )}
            {priceRefreshedAt && (
              <span className="ml-2 text-[#65A30D] font-medium">
                · מחירים עודכנו {priceRefreshedAt.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            )}
            {lastRefreshed && (
              <span className="ml-2 text-[#2563EB]">
                · scan {lastRefreshed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
          </p>
        </div>
        {selectedTickers.size > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-blue-700 bg-blue-50 border border-blue-300 rounded-full px-2.5 py-1">
              {selectedTickers.size} נבחרו
            </span>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 border-amber-400 text-amber-400 hover:bg-amber-100"
              onClick={handleArchiveSelected}
              disabled={archiveMut.isPending}
            >
              {archiveMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
              ארכיון נבחרים
            </Button>
          </div>
        )}
      </div>

      {catalogueError && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-sm text-red-800">
            שגיאה בטעינת הקטלוג: {catalogueErrorObj?.message ?? "לא ידוע"}
          </p>
          <Button variant="outline" size="sm" className="gap-1.5 border-red-300" onClick={() => refetchCatalogue()}>
            <RefreshCw className="h-3.5 w-3.5" />
            נסה שוב
          </Button>
        </div>
      )}

      {/* Action buttons */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {/* Unified IBKR Refresh Control */}
        <div className="flex flex-col gap-1 justify-center">
          <RefreshControl ibkrConnected={true} />
          <p className="text-[10px] text-center text-muted-foreground">עדכון מחיר מ-IBKR בלבד</p>
        </div>
        <div className="flex flex-col gap-1">
          <Button
            className="w-full py-5 text-sm font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-md"
            onClick={() => runAnalyzeStream()}
            disabled={isAnyBusy}
          >
            {analyzingAssets
              ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />{analyzeProgress > 0 ? `${analyzeProgress}%` : 'Scanning...'}</>
              : <><Zap className="h-4 w-4 mr-2" />Analyze All</>}
          </Button>
          <p className="text-[10px] text-center text-muted-foreground">סורק את כל הנכסים ומעדכן ציוני Ziv</p>
        </div>

        {/* Single Scan All button */}
        <div className="flex flex-col gap-1">
          <Button
            variant="outline"
            className={`w-full py-5 text-sm font-semibold border-2 border-violet-400 text-violet-700 hover:bg-violet-50 shadow-sm ${findingMarket ? "opacity-80" : ""}`}
            onClick={() => runMarketScan()}
            disabled={isAnyBusy}
          >
            {findingMarket
              ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Scanning {scanProgress}%...</>
              : <><Search className="h-4 w-4 mr-2" />Scan All</>}
          </Button>
          <p className="text-[10px] text-center text-muted-foreground">Finviz · TradingView · Whale · IBD · Sector · ציון ≥7</p>
        </div>

        <div className="flex flex-col gap-1">
          <Button
            variant="outline"
            className="w-full py-5 text-sm font-semibold border-2 border-cyan-400 text-cyan-700 hover:bg-cyan-50 shadow-sm"
            onClick={() => { setScanningRetest(true); setRetestResults(null); retestMut.mutate(); }}
            disabled={isAnyBusy}
          >
            {scanningRetest ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Scanning...</> : <><TrendingUp className="h-4 w-4 mr-2" />Retest Watchlist</>}
          </Button>
          <p className="text-[10px] text-center text-muted-foreground">מזהה breakouts שחזרו לאזור הכניסה מתוך רשימת הנכסים</p>
        </div>

        {/* Load Alerts from Catalogue */}
        <div className="flex flex-col gap-1">
          <Button
            className="w-full py-5 text-sm font-semibold bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-700 hover:to-orange-700 shadow-md text-white"
            onClick={() => loadAlertsMut.mutate()}
            disabled={loadAlertsMut.isPending}
          >
            {loadAlertsMut.isPending
              ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />יוצר איתותים...</>
              : <><BellPlus className="h-4 w-4 mr-2" />טען איתותים</>}
          </Button>
          <p className="text-[10px] text-center text-muted-foreground">🔥 Gold Breakout • 🔄 Gold Retest • 📍 Near Entry Watch</p>
        </div>

        {/* Admin only: Refresh ZIV scores for ALL users */}
        {isAdmin && (
          <div className="flex flex-col gap-1">
            <Button
              className="w-full py-5 text-sm font-semibold bg-gradient-to-r from-purple-700 to-violet-700 hover:from-purple-800 hover:to-violet-800 shadow-md text-white"
              onClick={() => adminRefreshAllMut.mutate()}
              disabled={adminRefreshAllMut.isPending}
            >
              {adminRefreshAllMut.isPending
                ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />מעדכן כלל...</>
                : <><RefreshCw className="h-4 w-4 mr-2" />Refresh All Users</>}
            </Button>
            <p className="text-[10px] text-center text-muted-foreground">עדכן ZIV לכל המשתמשים (מנהלים בלבד)</p>
          </div>
        )}
        {/* Admin only: Copy catalogue to specific user */}
        {isAdmin && (
          <div className="flex flex-col gap-1">
            <select
              className="w-full rounded-md border border-gray-200 bg-white text-gray-700 text-xs px-2 py-2 mb-1"
              value={selectedCopyUserId ?? ""}
              onChange={e => setSelectedCopyUserId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">בחר משתמש...</option>
              {(localUsersQuery.data ?? []).filter((u: any) => u.linkedUserId).map((u: any) => (
                <option key={u.id} value={u.linkedUserId}>{u.name} ({u.email})</option>
              ))}
            </select>
            <Button
              className="w-full py-5 text-sm font-semibold bg-gradient-to-r from-emerald-700 to-teal-700 hover:from-emerald-800 hover:to-teal-800 shadow-md text-white"
              onClick={() => selectedCopyUserId && adminCopyMut.mutate({ targetUserId: selectedCopyUserId })}
              disabled={adminCopyMut.isPending || !selectedCopyUserId}
            >
              {adminCopyMut.isPending
                ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />מעתיק...</>
                : <><BookmarkPlus className="h-4 w-4 mr-2" />העתק קטלוג למשתמש</>}
            </Button>
            <p className="text-[10px] text-center text-muted-foreground">העתק כל 153 המניות למשתמש נבחר</p>
          </div>
        )}

      </div>

      {/* Progress — only for non-market-scan operations */}
      {(analyzingAssets || scanningRetest) && (
        <p className="text-center text-sm text-muted-foreground animate-pulse">
          {analyzingAssets && "Scanning all catalogue assets (30–60s)..."}
          {scanningRetest && "Scanning asset list for retest opportunities (15–30s)..."}
        </p>
      )}

      {/* ── Retest Watchlist Results ── */}
      {retestResults && (
        <Card className="border shadow-sm border-cyan-200">
          <CardHeader className="pb-2 pt-4 px-5 bg-cyan-50/40">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-cyan-600" />
              Retest Watchlist
              <Badge variant="outline" className="text-xs bg-cyan-50 text-cyan-700 border-cyan-200">
                {retestResults.length} breakout{retestResults.length !== 1 ? 's' : ''} found
              </Badge>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs ml-auto text-muted-foreground" onClick={() => setRetestResults(null)}>✕ Close</Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {retestResults.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No confirmed breakouts found in the last 30 days.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-cyan-50/30">
                      <TableHead className="text-xs font-semibold">Ticker</TableHead>
                      <TableHead className="text-xs font-semibold">Signal</TableHead>
                      <TableHead className="text-xs font-semibold">Breakout Price</TableHead>
                      <TableHead className="text-xs font-semibold">Retest Zone</TableHead>
                      <TableHead className="text-xs font-semibold">Current Price</TableHead>
                      <TableHead className="text-center text-xs font-semibold">Ziv Score</TableHead>
                      <TableHead className="text-xs font-semibold">Dist to Zone</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {retestResults.map((r, i) => (
                      <TableRow key={i} className={r.inRetestZone ? "bg-cyan-50" : ""}>
                        <TableCell>
                          <button className="text-[#2563EB] hover:underline font-mono font-bold text-sm" onClick={() => navigate(`/deep-analysis/${encodeURIComponent(r.ticker)}`)}>{r.ticker}</button>
                          <div className="text-xs text-muted-foreground">Broke out {r.breakoutDate}</div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-xs font-semibold ${
                            r.signal === "IN_ZONE" ? "bg-cyan-50 text-cyan-700 border-cyan-300 animate-pulse" :
                            r.signal === "APPROACHING" ? "bg-amber-50 text-amber-700 border-amber-700" :
                            "bg-gray-50/40 text-slate-400 border-slate-600"
                          }`}>
                            {r.signal === "IN_ZONE" ? "🎯 IN ZONE" : r.signal === "APPROACHING" ? "⚡ APPROACHING" : "↑ ABOVE ZONE"}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-sm">${r.breakoutPrice.toFixed(2)}</TableCell>
                        <TableCell className="text-xs">
                          <span className="text-[#65A30D]">${r.retestZoneLow.toFixed(2)}</span>
                          <span className="text-muted-foreground"> – </span>
                          <span className="text-[#65A30D]">${r.retestZoneHigh.toFixed(2)}</span>
                        </TableCell>
                        <TableCell className="font-mono text-sm font-semibold">${r.currentPrice.toFixed(2)}</TableCell>
                        <TableCell className="text-center"><ScoreBadge score={r.zivScore} /></TableCell>
                        <TableCell className="text-xs">
                          {r.inRetestZone ? (
                            <span className="text-cyan-700 font-semibold">In zone ✓</span>
                          ) : (
                            <span className="text-muted-foreground">{r.distToRetestZonePct.toFixed(1)}% away</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Analyze All Progress Bar ── */}
      {analyzingAssets && (
        <Card className="border shadow-sm border-indigo-200 bg-indigo-50">
          <CardContent className="py-4 px-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-indigo-700 flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Analyze All — ZIV Engine
              </span>
              <span className="text-sm font-bold text-indigo-700">
                {analyzeDone > 0 ? `${analyzeDone}/${analyzeTotal}` : ''} {analyzeProgress}%
              </span>
            </div>
            <div className="w-full bg-indigo-200 rounded-full h-3 overflow-hidden">
              <div
                className="h-3 rounded-full bg-gradient-to-r from-indigo-400 to-blue-500 transition-all duration-300 ease-out"
                style={{ width: `${analyzeProgress}%` }}
              />
            </div>
            <p className="text-xs text-[#2563EB] mt-2 truncate">{analyzeMessage}</p>
            <button
              className="mt-2 text-xs text-[#FF6B6B] hover:underline"
              onClick={() => { analyzeAbortRef.current?.(); setAnalyzingAssets(false); setAnalyzeProgress(0); }}
            >
              בטל סריקה
            </button>
          </CardContent>
        </Card>
      )}

      {/* ── Market Scan Progress Bar ── */}
      {findingMarket && (
        <Card className="border shadow-sm border-blue-200 bg-blue-50">
          <CardContent className="py-4 px-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-blue-700 flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {activeScanLabel}
              </span>
              <span className="text-sm font-bold text-blue-700">{scanProgress}%</span>
            </div>
            {/* Progress bar */}
            <div className="w-full bg-blue-200 rounded-full h-3 overflow-hidden">
              <div
                className="h-3 rounded-full bg-gradient-to-r from-blue-400 to-indigo-500 transition-all duration-500 ease-out"
                style={{ width: `${scanProgress}%` }}
              />
            </div>
            <p className="text-xs text-[#2563EB] mt-2 truncate">{scanMessage}</p>
            <button
              className="mt-2 text-xs text-[#FF6B6B] hover:underline"
              onClick={() => { scanAbortRef.current?.(); setFindingMarket(false); setScanProgress(0); }}
            >
              בטל סריקה
            </button>
          </CardContent>
        </Card>
      )}

      {/* ── Market Scan Results — shown ABOVE the asset table ── */}
      {marketReplacements && marketReplacements.length > 0 && (
        <Card className="border shadow-sm border-purple-200">
          <CardHeader className="pb-2 pt-4 px-5 bg-purple-50/50">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Search className="h-4 w-4 text-purple-500" />
              {activeScanLabel} — תוצאות
              <span className="text-xs font-normal text-muted-foreground">
                {marketReplacements.length} נכסים · ציון ≥7 · ללא נכסים קיימים בקטלוג
              </span>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs ml-auto text-muted-foreground" onClick={() => setMarketReplacements(null)}>✕ Close</Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-purple-50/30">
                    <TableHead className="text-xs font-semibold">#</TableHead>
                    <TableHead className="text-xs font-semibold">Ticker</TableHead>
                    <TableHead className="text-xs font-semibold">Company</TableHead>
                    <TableHead className="text-xs font-semibold">Sources</TableHead>
                    <TableHead className="text-xs font-semibold text-center">Score</TableHead>
                    <TableHead className="text-xs font-semibold">Tier</TableHead>
                    <TableHead className="text-xs font-semibold text-center">Entry?</TableHead>
                    <TableHead className="text-xs font-semibold">Entry Zone</TableHead>
                    <TableHead className="text-xs font-semibold">SL</TableHead>
                    <TableHead className="text-xs font-semibold">TP</TableHead>
                    <TableHead className="text-xs font-semibold">Price</TableHead>
                    <TableHead className="w-16" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {marketReplacements.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={12} className="text-center text-sm text-muted-foreground py-6">
                        לא נמצאו נכסים עם ציון ≥7 בסריקה זו. נסה סריקה אחרת.
                      </TableCell>
                    </TableRow>
                  )}
                  {marketReplacements.map((c, i) => (
                    <TableRow key={i} className={cn("hover:bg-muted/20", c.meetsEntry ? "bg-emerald-50/60" : "")}>
                      <TableCell className="text-xs text-muted-foreground font-mono">{i + 1}</TableCell>
                      <TableCell className="font-mono font-bold text-xs">
                        <button className="text-[#2563EB] hover:underline font-mono font-bold text-xs" onClick={() => navigate(`/deep-analysis/${encodeURIComponent(c.ticker)}`)}>
                          {c.ticker}
                        </button>
                      </TableCell>
                      <TableCell className="text-xs max-w-[120px] truncate">{c.companyName}</TableCell>
                      <TableCell className="text-xs">
                        <div className="flex flex-wrap gap-0.5">
                          {(scanSources[c.ticker] ?? []).map(src => (
                            <span key={src} className="inline-block px-1 py-0.5 rounded text-[9px] font-medium bg-violet-100 text-violet-700 border border-violet-200 whitespace-nowrap">{src}</span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center gap-1">
                          <ScoreBadge score={c.score} />
                          {c.score != null && c.score >= 6 && c.score < 7 && c.tier === "Gold Breakout" && (
                            <span title="Gold Breakout Override — volume >2x, below EMA-200" className="text-[10px] font-bold px-1 py-0.5 bg-orange-100 text-orange-700 border border-orange-300 rounded cursor-help">⚡</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell><TierBadge tier={c.tier as any} /></TableCell>
                      <TableCell className="text-center">
                        {c.meetsEntry ? <span className="text-[#65A30D] font-bold text-xs">✓ YES</span> : <span className="text-muted-foreground text-xs">—</span>}
                      </TableCell>
                      <TableCell className="text-xs font-mono text-amber-600">{c.entryZone || "—"}</TableCell>
                      <TableCell className="text-xs font-mono text-[#FF6B6B]">{c.stopLoss || "—"}</TableCell>
                      <TableCell className="text-xs font-mono text-green-700">{c.takeProfit || "—"}</TableCell>
                      <TableCell className="text-xs font-mono font-semibold">
                        {c.price != null ? `$${Number(c.price).toFixed(2)}` : "—"}
                      </TableCell>
                      <TableCell className="px-2">
                        <Button
                          size="sm" variant="outline"
                          className="h-6 px-2 text-[10px] gap-1 border-[#17a87e] text-emerald-700 hover:bg-emerald-100"
                          onClick={() => addAssetMut.mutate({ ticker: c.ticker, companyName: c.companyName, sector: c.sector ?? "Market Scan" })}
                          disabled={addAssetMut.isPending || allAssets.some(a => a.ticker === c.ticker)}
                        >
                          {allAssets.some(a => a.ticker === c.ticker) ? "In list" : <><Plus className="h-2.5 w-2.5" />Add</>}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Search & Collapse Controls (shared) ── */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-2 pt-4 px-5">
          <CardTitle className="text-sm font-semibold flex items-center gap-2 flex-wrap">
            <Zap className="h-4 w-4 text-[#2563EB]" />
            Asset List
            <span className="text-xs font-normal text-muted-foreground ml-1">{allAssets.length} assets</span>
            <Button
              variant="ghost" size="sm"
              className="h-6 px-2 text-xs gap-1 ml-auto text-muted-foreground hover:text-foreground"
              onClick={() => setTableCollapsed(c => !c)}
            >
              {tableCollapsed ? <><ChevronDown className="h-3.5 w-3.5" /> הרחב</> : <><ChevronUp className="h-3.5 w-3.5" /> כווץ</>}
            </Button>
            {selectedTickers.size > 0 && (
              <>
                <span className="text-xs text-[#2563EB] font-medium">· {selectedTickers.size} selected</span>
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-muted-foreground ml-auto" onClick={() => setSelectedTickers(new Set())}>
                  Clear selection
                </Button>
              </>
            )}
          </CardTitle>
          {/* ── Quick Search Filter ── */}
          <div className="mt-2 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="חיפוש לפי טיקר או שם חברה..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              className="w-full pl-9 pr-8 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
            />
            {filterText && (
              <button
                onClick={() => setFilterText("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {filterText && (
            <p className="text-xs text-muted-foreground mt-1">{sortedAssets.length} תוצאות ({usaAssets.length} USA, {isrAssets.length} ISR)</p>
          )}
        </CardHeader>
      </Card>

      {/* ── Sector Quick Filters ── */}
      {!tableCollapsed && usaSectors.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-1">
          <button
            onClick={() => setSectorFilter("All")}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
              sectorFilter === "All"
                ? "bg-[#2563EB] text-white border-[#2563EB] shadow-sm"
                : "bg-background text-muted-foreground border-border hover:bg-muted/40 hover:text-foreground"
            }`}
          >
            All ({sortedAllAssets.filter(a => !a.ticker.endsWith('.TA')).length})
          </button>
          {usaSectors.map(sector => {
            const count = sortedAllAssets.filter(a => !a.ticker.endsWith('.TA') && a.sector === sector).length;
            return (
              <button
                key={sector}
                onClick={() => setSectorFilter(prev => prev === sector ? "All" : sector)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                  sectorFilter === sector
                    ? "bg-[#2563EB] text-white border-[#2563EB] shadow-sm"
                    : "bg-background text-muted-foreground border-border hover:bg-muted/40 hover:text-foreground"
                }`}
              >
                {sector} ({count})
              </button>
            );
          })}
        </div>
      )}

      {/* ── 🇺🇸 USA Table ── */}
      {!tableCollapsed && (
      <Card className="border shadow-sm">
        <CardHeader className="pb-1 pt-3 px-5">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <span>🇺🇸</span> USA
            <span className="text-xs font-normal text-muted-foreground ml-1">
              {catalogueInitialLoad ? "טוען..." : `${usaAssets.length} assets`}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {/* ── Mobile Card View (< 768px) ── */}
          <div className="md:hidden divide-y divide-border">
            {catalogueInitialLoad ? (
              [...Array(6)].map((_, i) => (
                <div key={i} className="p-3 space-y-2">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              ))
            ) : usaAssets.map((r, i) => (
              <div key={r.ticker} className={`p-3 ${i % 2 === 0 ? "bg-card" : "bg-background"}`}>
                {/* Row 1: Ticker + Portfolio badges + Score + Signal */}
                <div className="flex items-center gap-2 mb-1.5">
                  <button
                    className="font-mono font-bold text-sm text-[#2563EB] hover:underline"
                    onClick={() => navigate(`/deep-analysis/${encodeURIComponent(r.ticker)}`)}
                  >
                    {r.ticker}
                  </button>
                  {vip.has(r.ticker.toUpperCase()) && <VipChip />}
                  {holdingTickers.has(r.ticker.toUpperCase()) && (
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold border border-emerald-400">H1</span>
                  )}
                  {h2Tickers.has(r.ticker.toUpperCase()) && (
                    <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-md bg-blue-600 text-white text-[10px] font-bold shadow-sm">H2</span>
                  )}
                  {r.hotSignal && <span className="text-base">🔥</span>}
                  {r.catalogStatus === "IPO_INCUBATOR" && (
                    <Badge variant="outline" className="text-[10px] font-bold bg-amber-50 text-amber-800 border-amber-300 px-1.5 py-0">
                      IPO
                    </Badge>
                  )}
                  {r.catalogStatus === "DATA_BLIP_BYPASS" && (
                    <Badge variant="outline" className="text-[10px] font-bold bg-slate-50 text-slate-600 border-slate-300 px-1.5 py-0">
                      DATA
                    </Badge>
                  )}
                  <div className="ml-auto flex items-center gap-1.5">
                    {r.recommendation ? (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold ${
                        r.recommendation === "STRONG BUY" ? "bg-[#65A30D] text-white" :
                        r.recommendation === "BUY" ? "bg-[#2563EB] text-white" :
                        r.recommendation === "WATCH" ? "bg-amber-500 text-white" :
                        "bg-[#FF6B6B] text-white"
                      }`}>{r.recommendation}</span>
                    ) : null}
                    {activeAlertTickers.has(r.ticker.toUpperCase()) && (
                      <CheckCircle2 className="h-4 w-4 text-[#2563EB]" />
                    )}
                  </div>
                </div>
                {/* Row 2: Company + Tier */}
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-xs text-muted-foreground truncate flex-1">{r.company || "—"}</span>
                  {r.tier && <TierBadge tier={r.tier as any} />}
                  <span className="text-xs font-bold text-muted-foreground">Score: {r.zivScore ?? "—"}</span>
                </div>
                {/* Row 3: Price + Daily % + Buy Price */}
                <div className="flex items-center gap-3 text-xs">
                  <span className="font-mono">{r.cmp != null ? `${r.ticker.endsWith(".TA") ? "₪" : "$"}${r.cmp.toFixed(2)}` : "—"}</span>
                  {r.dailyChangePercent != null && (
                    <span className={`font-mono font-semibold ${
                      r.dailyChangePercent > 0 ? "text-[#65A30D]" : r.dailyChangePercent < 0 ? "text-[#FF6B6B]" : ""
                    }`}>
                      {r.dailyChangePercent >= 0 ? "+" : ""}{r.dailyChangePercent.toFixed(2)}%
                    </span>
                  )}
                  {r.recommendedBuyPrice != null && (
                    <button
                      className="ml-auto flex items-center gap-1 text-[#65A30D] font-semibold font-mono min-h-[44px] px-2"
                      onClick={() => handleOpenAddAlertDialog(r)}
                    >
                      <BellPlus className="h-3.5 w-3.5" />
                      {r.ticker.endsWith(".TA") ? "₪" : "$"}{r.recommendedBuyPrice.toFixed(2)}
                    </button>
                  )}
                </div>
              </div>
            ))}
            {catalogueReady && usaAssets.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">אין נכסים אמריקאיים ברשימה</div>
            )}
          </div>
          {/* ── Desktop Table View (≥ 768px) ── */}
          <div className="hidden md:block overflow-x-auto" style={{ touchAction: 'pan-y', maxHeight: '70vh', overflowY: 'auto' }}>
            <Table className="min-w-[860px]">
              <TableHeader>
                <TableRow className="bg-muted/20">
                  {/* Select-all checkbox */}
                  <TableHead className="w-10 text-center px-3">
                    <button onClick={toggleSelectAll} className="text-muted-foreground hover:text-foreground transition-colors" title={allSelected ? "Deselect all" : "Select all"}>
                      {allSelected ? <CheckSquare className="h-4 w-4 text-[#2563EB]" /> : someSelected ? <CheckSquare className="h-4 w-4 text-blue-300" /> : <Square className="h-4 w-4" />}
                    </button>
                  </TableHead>
                  <TH col="ticker" label="Ticker" />
                  <TH col="sector" label="Sector" />
                  <TableHead className="w-12 text-center text-xs font-semibold">בתיק</TableHead>
                  <TH col="compositeScore" label="Score" align="center" />
                  <TH col="tier" label="Tier" />
                  <TH col="cmp" label="Price" align="right" />
                  <TH col="recommendedBuyPrice" label="Buy Price" align="right" />
                  <TH col="dailyChangePercent" label="Daily %" align="right" />
                  <TH col="hotSignal" label="🔥" align="center" />
                  <TableHead className="w-8 text-center text-xs font-semibold" title="איתות פעיל">✓</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
                {/* ── Top Fast-Add Row ── */}
                <TableRow className="bg-muted/10 border-b-2 border-dashed border-border/60">
                  <TableCell className="text-center px-3 py-2">
                    <Plus className="h-4 w-4 text-muted-foreground mx-auto" />
                  </TableCell>
                  <TableCell className="py-2" colSpan={2}>
                    <div ref={autocompleteRef} className="relative flex items-center gap-2">
                      <Input
                        placeholder="TICKER or company name..."
                        value={fastAddTicker}
                        onChange={(e) => {
                          setFastAddTicker(e.target.value.toUpperCase());
                          setAutocompleteOpen(true);
                        }}
                        onFocus={() => fastAddTicker.length >= 1 && setAutocompleteOpen(true)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { setAutocompleteOpen(false); handleFastAdd(); }
                          if (e.key === "Escape") setAutocompleteOpen(false);
                        }}
                        className="h-7 text-xs font-mono w-56 uppercase"
                        maxLength={30}
                        autoComplete="off"
                      />
                      {autocompleteOpen && (tickerSearchQuery.data?.results?.length ?? 0) > 0 && (
                        <div className="absolute top-8 left-0 z-50 w-80 bg-popover border border-border rounded-lg shadow-lg overflow-hidden">
                          {tickerSearchQuery.data!.results.map((r) => (
                            <button
                              key={r.symbol}
                              type="button"
                              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                setFastAddTicker(r.symbol);
                                setFastAddCompany(r.name);
                                setAutocompleteOpen(false);
                                setTimeout(() => handleFastAdd(), 50);
                              }}
                            >
                              <span className="font-mono text-xs font-bold text-foreground w-16 shrink-0">{r.symbol}</span>
                              <span className="text-xs text-muted-foreground truncate flex-1">{r.name}</span>
                              <span className="text-[10px] text-muted-foreground/60 shrink-0">{r.exchange}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell colSpan={8} className="py-2">
                    {analyzingSingleTicker && (
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        מנתח {analyzingSingleTicker}...
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="py-2 px-2">
                    <Button
                      size="sm"
                      className="h-7 px-3 text-xs gap-1"
                      onClick={handleFastAdd}
                      disabled={addAssetMut.isPending || !fastAddTicker.trim()}
                    >
                      {addAssetMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                      Add
                    </Button>
                  </TableCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {catalogueInitialLoad ? (
                  [...Array(10)].map((_, i) => (
                    <TableRow key={i} className={i % 2 === 0 ? "bg-card" : "bg-background"}>
                      <TableCell className="px-3"><Skeleton className="h-4 w-4 rounded" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-14" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-4 mx-auto" /></TableCell>
                      <TableCell><Skeleton className="h-3 w-28" /></TableCell>
                      <TableCell className="text-center"><Skeleton className="h-5 w-8 mx-auto rounded-full" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                      <TableCell className="text-right"><Skeleton className="h-4 w-14 ml-auto" /></TableCell>
                      <TableCell className="text-right"><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                      <TableCell />
                      <TableCell />
                      <TableCell />
                      <TableCell />
                    </TableRow>
                  ))
                ) : null}
                {catalogueReady && usaAssets.map((r, i) => {
                  const isSelected = selectedTickers.has(r.ticker);
                  return (
                    <TableRow
                      key={r.ticker}
                      className={`group hover:bg-muted/20 transition-colors ${isSelected ? "bg-blue-100 hover:bg-blue-200" : i % 2 === 0 ? "bg-card" : "bg-background"}`}
                    >
                      <TableCell className="text-center px-3">
                        <button onClick={() => toggleSelect(r.ticker)} className="text-muted-foreground hover:text-[#2563EB] transition-colors">
                          {isSelected ? <CheckSquare className="h-4 w-4 text-[#2563EB]" /> : <Square className="h-4 w-4" />}
                        </button>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <button className="text-[#2563EB] hover:underline font-mono font-bold text-xs" onClick={() => navigate(`/deep-analysis/${encodeURIComponent(r.ticker)}`)}>
                            {r.ticker}
                          </button>
                          {vip.has(r.ticker.toUpperCase()) && <VipChip />}
                        </div>
                      </TableCell>
                      {/* Sector Badge */}
                      <TableCell>
                        {(() => {
                          const sectorLabel = r.ticker.endsWith(".TA") ? "TASE" : r.sector;
                          return sectorLabel ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-700 border border-slate-200 whitespace-nowrap">
                              {sectorLabel}
                            </span>
                          ) : <span className="text-muted-foreground text-xs">—</span>;
                        })()}
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center gap-1">
                          {holdingTickers.has(r.ticker.toUpperCase()) && (
                            <span title="קיים בתיק 1" className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold border border-emerald-400">H1</span>
                          )}
                          {h2Tickers.has(r.ticker.toUpperCase()) && (
                            <span title="קיים בתיק שני (H2 TASE)" className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-md bg-blue-600 text-white text-[10px] font-bold shadow-sm">H2</span>
                          )}
                          {!holdingTickers.has(r.ticker.toUpperCase()) && !h2Tickers.has(r.ticker.toUpperCase()) && (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <CatalogueScoreCell
                          ticker={r.ticker}
                          zivScore={r.zivScore}
                          compositeScore={r.compositeScore}
                          kronosBias={r.kronosBias}
                          kronosDirection={r.kronosDirection}
                        />
                      </TableCell>
                      <TableCell>
                        {r.tier ? <TierBadge tier={r.tier as any} /> : <span className="text-muted-foreground text-xs">—</span>}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">{r.cmp != null ? `${r.ticker.endsWith(".TA") ? "₪" : "$"}${r.cmp.toFixed(2)}` : "—"}</TableCell>
                      {/* Buy Price + Distance to Entry */}
                      <TableCell className="text-right">
                        {r.recommendedBuyPrice != null ? (
                          <div className="flex flex-col items-end gap-0.5">
                            <button
                              className="hover:underline hover:text-emerald-900 transition-colors cursor-pointer flex items-center gap-1 font-mono text-xs text-[#65A30D] font-semibold"
                              title="לחץ להוספת Price Alert"
                              onClick={() => handleOpenAddAlertDialog(r)}
                            >
                              <BellPlus className="h-3 w-3 opacity-60" />
                              {r.ticker.endsWith(".TA") ? "₪" : "$"}{r.recommendedBuyPrice.toFixed(2)}
                            </button>
                            {r.cmp != null && r.recommendedBuyPrice != null && r.recommendedBuyPrice > 0 && (() => {
                              const dist = ((r.cmp - r.recommendedBuyPrice) / r.recommendedBuyPrice) * 100;
                              if (Math.abs(dist) < 0.1) return <span className="text-[10px] font-bold text-[#65A30D]">Triggered</span>;
                              return (
                                <span className={`text-[10px] font-mono font-semibold ${dist > 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"}`}>
                                  {dist > 0 ? "+" : ""}{dist.toFixed(1)}%
                                </span>
                              );
                            })()}
                          </div>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </TableCell>
                      <TableCell className={`text-right font-mono text-xs ${(r.dailyChangePercent ?? 0) > 0 ? "text-[#65A30D]" : (r.dailyChangePercent ?? 0) < 0 ? "text-[#FF6B6B]" : ""}`}>
                        {r.dailyChangePercent != null ? `${r.dailyChangePercent >= 0 ? "+" : ""}${r.dailyChangePercent.toFixed(2)}%` : "—"}
                      </TableCell>
                      <TableCell className="text-center">
                        {r.hotSignal ? <span title="כל תנאי הכניסה מתקיימים" className="text-lg cursor-default select-none">🔥</span> : <span className="text-muted-foreground text-xs">—</span>}
                      </TableCell>
                      {/* Signal checkmark — active Price Alert */}
                      <TableCell className="text-center">
                        {activeAlertTickers.has(r.ticker.toUpperCase()) ? (
                          <span title="יש התראת מחיר פעילה" className="flex justify-center">
                            <CheckCircle2 className="h-4 w-4 text-[#2563EB]" />
                          </span>
                        ) : signalTickers.has(r.ticker.toUpperCase()) ? (
                          <span title="יש איתות פעיל ב-Master Knowledge" className="flex justify-center">
                            <CheckCircle2 className="h-4 w-4 text-[#65A30D]" />
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </TableCell>
                      <TableCell className="px-2">
                        <div className="flex items-center gap-1.5">
                          <button
                            className="opacity-0 group-hover:opacity-100 text-[#65A30D] hover:text-emerald-800 transition-all"
                            title="קנה והוסף לתיק"
                            onClick={() => handleOpenBuyDialog({ ticker: r.ticker, recommendedBuyPrice: r.recommendedBuyPrice, recommendedStopLoss: r.recommendedStopLoss, cmp: r.cmp })}
                          >
                            <ShoppingCart className="h-3.5 w-3.5" />
                          </button>
                          <button
                            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-amber-500 transition-all"
                            title="העבר לארכיון"
                            onClick={() => { if (!window.confirm(`העבר ${r.ticker} לארכיון?`)) return; archiveMut.mutate({ tickers: [r.ticker] }); }}
                          >
                            <Archive className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}

              </TableBody>
              <tfoot>
                {/* ── Fast-Add Row ── */}
                <tr className="bg-muted/10 border-t-2 border-dashed border-border/60">
                  <td className="text-center px-3 py-2">
                    <Plus className="h-4 w-4 text-muted-foreground mx-auto" />
                  </td>
                  <td className="py-2" colSpan={2}>
                    {/* Autocomplete wrapper */}
                    <div ref={autocompleteRef} className="relative flex items-center gap-2">
                      <Input
                        ref={fastAddRef}
                        placeholder="TICKER or company name..."
                        value={fastAddTicker}
                        onChange={(e) => {
                          setFastAddTicker(e.target.value.toUpperCase());
                          setAutocompleteOpen(true);
                        }}
                        onFocus={() => fastAddTicker.length >= 1 && setAutocompleteOpen(true)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { setAutocompleteOpen(false); handleFastAdd(); }
                          if (e.key === "Escape") setAutocompleteOpen(false);
                        }}
                        className="h-7 text-xs font-mono w-56 uppercase"
                        maxLength={30}
                        autoComplete="off"
                      />
                      {/* Dropdown */}
                      {autocompleteOpen && (tickerSearchQuery.data?.results?.length ?? 0) > 0 && (
                        <div className="absolute top-8 left-0 z-50 w-80 bg-popover border border-border rounded-lg shadow-lg overflow-hidden">
                          {tickerSearchQuery.data!.results.map((r) => (
                            <button
                              key={r.symbol}
                              type="button"
                              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                setFastAddTicker(r.symbol);
                                setFastAddCompany(r.name);
                                setAutocompleteOpen(false);
                                setTimeout(() => handleFastAdd(), 50);
                              }}
                            >
                              <span className="font-mono text-xs font-bold text-foreground w-16 shrink-0">{r.symbol}</span>
                              <span className="text-xs text-muted-foreground truncate flex-1">{r.name}</span>
                              <span className="text-[10px] text-muted-foreground/60 shrink-0">{r.exchange}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </td>
                  <td colSpan={8} />
                  <td className="py-2 px-2">
                    <Button
                      size="sm"
                      className="h-7 px-3 text-xs gap-1"
                      onClick={handleFastAdd}
                      disabled={addAssetMut.isPending || !fastAddTicker.trim()}
                    >
                      {addAssetMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                      Add
                    </Button>
                  </td>
                </tr>
              </tfoot>
            </Table>
          </div>
        </CardContent>
      </Card>
      )}

      {/* ── 🇮🇱 ISR Table ── */}
      {!tableCollapsed && (
      <Card className="border shadow-sm">
        <CardHeader className="pb-1 pt-3 px-5">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <span>🇮🇱</span> ISR
            <span className="text-xs font-normal text-muted-foreground ml-1">
              {catalogueInitialLoad ? "טוען..." : `${isrAssets.length} assets`}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {/* ── Mobile Card View (< 768px) ── */}
          <div className="md:hidden divide-y divide-border">
            {catalogueInitialLoad ? (
              [...Array(4)].map((_, i) => (
                <div key={i} className="p-3 space-y-2">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              ))
            ) : isrAssets.map((r, i) => (
              <div key={r.ticker} className={`p-3 ${i % 2 === 0 ? "bg-card" : "bg-background"}`}>
                {/* Row 1: Ticker + Portfolio badges + Score + Signal */}
                <div className="flex items-center gap-2 mb-1.5">
                  <button
                    className="font-mono font-bold text-sm text-[#2563EB] hover:underline"
                    onClick={() => navigate(`/deep-analysis/${encodeURIComponent(r.ticker)}`)}
                  >
                    {r.ticker}
                  </button>
                  {vip.has(r.ticker.toUpperCase()) && <VipChip />}
                  {holdingTickers.has(r.ticker.toUpperCase()) && (
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold border border-emerald-400">H1</span>
                  )}
                  {h2Tickers.has(r.ticker.toUpperCase()) && (
                    <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-md bg-blue-600 text-white text-[10px] font-bold shadow-sm">H2</span>
                  )}
                  {r.hotSignal && <span className="text-base">🔥</span>}
                  {r.catalogStatus === "IPO_INCUBATOR" && (
                    <Badge variant="outline" className="text-[10px] font-bold bg-amber-50 text-amber-800 border-amber-300 px-1.5 py-0">
                      IPO
                    </Badge>
                  )}
                  {r.catalogStatus === "DATA_BLIP_BYPASS" && (
                    <Badge variant="outline" className="text-[10px] font-bold bg-slate-50 text-slate-600 border-slate-300 px-1.5 py-0">
                      DATA
                    </Badge>
                  )}
                  <div className="ml-auto flex items-center gap-1.5">
                    {r.recommendation ? (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold ${
                        r.recommendation === "STRONG BUY" ? "bg-[#65A30D] text-white" :
                        r.recommendation === "BUY" ? "bg-[#2563EB] text-white" :
                        r.recommendation === "WATCH" ? "bg-amber-500 text-white" :
                        "bg-[#FF6B6B] text-white"
                      }`}>{r.recommendation}</span>
                    ) : null}
                    {activeAlertTickers.has(r.ticker.toUpperCase()) && (
                      <CheckCircle2 className="h-4 w-4 text-[#2563EB]" />
                    )}
                  </div>
                </div>
                {/* Row 2: Company + Tier */}
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-xs text-muted-foreground truncate flex-1">{r.company || "—"}</span>
                  {r.tier && <TierBadge tier={r.tier as any} />}
                  <span className="text-xs font-bold text-muted-foreground">Score: {r.zivScore ?? "—"}</span>
                </div>
                {/* Row 3: Price + Daily % + Buy Price */}
                <div className="flex items-center gap-3 text-xs">
                  <span className="font-mono">{r.cmp != null ? `${r.ticker.endsWith(".TA") ? "₪" : "$"}${r.cmp.toFixed(2)}` : "—"}</span>
                  {r.dailyChangePercent != null && (
                    <span className={`font-mono font-semibold ${
                      r.dailyChangePercent > 0 ? "text-[#65A30D]" : r.dailyChangePercent < 0 ? "text-[#FF6B6B]" : ""
                    }`}>
                      {r.dailyChangePercent >= 0 ? "+" : ""}{r.dailyChangePercent.toFixed(2)}%
                    </span>
                  )}
                  {r.recommendedBuyPrice != null && (
                    <button
                      className="ml-auto flex items-center gap-1 text-[#65A30D] font-semibold font-mono min-h-[44px] px-2"
                      onClick={() => handleOpenAddAlertDialog(r)}
                    >
                      <BellPlus className="h-3.5 w-3.5" />
                      {r.ticker.endsWith(".TA") ? "₪" : "$"}{r.recommendedBuyPrice.toFixed(2)}
                    </button>
                  )}
                </div>
              </div>
            ))}
            {catalogueReady && isrAssets.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">אין נכסים ישראליים ברשימה</div>
            )}
          </div>
          {/* ── Desktop Table View (≥ 768px) ── */}
          <div className="hidden md:block overflow-x-auto" style={{ touchAction: 'pan-y', maxHeight: '70vh', overflowY: 'auto' }}>
            <Table className="min-w-[860px]">
              <TableHeader>
                <TableRow className="bg-muted/20">
                  {/* Select-all checkbox */}
                  <TableHead className="w-10 text-center px-3">
                    <button onClick={toggleSelectAll} className="text-muted-foreground hover:text-foreground transition-colors" title={allSelected ? "Deselect all" : "Select all"}>
                      {allSelected ? <CheckSquare className="h-4 w-4 text-[#2563EB]" /> : someSelected ? <CheckSquare className="h-4 w-4 text-blue-300" /> : <Square className="h-4 w-4" />}
                    </button>
                  </TableHead>
                  <TH col="ticker" label="Ticker" />
                  <TH col="sector" label="Sector" />
                  <TableHead className="w-12 text-center text-xs font-semibold">בתיק</TableHead>
                  <TH col="compositeScore" label="Score" align="center" />
                  <TH col="tier" label="Tier" />
                  <TH col="cmp" label="Price" align="right" />
                  <TH col="recommendedBuyPrice" label="Buy Price" align="right" />
                  <TH col="dailyChangePercent" label="Daily %" align="right" />
                  <TH col="hotSignal" label="🔥" align="center" />
                  <TableHead className="w-8 text-center text-xs font-semibold" title="איתות פעיל">✓</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {catalogueInitialLoad ? (
                  [...Array(5)].map((_, i) => (
                    <TableRow key={i} className={i % 2 === 0 ? "bg-card" : "bg-background"}>
                      <TableCell className="px-3"><Skeleton className="h-4 w-4 rounded" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-14" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-4 mx-auto" /></TableCell>
                      <TableCell><Skeleton className="h-3 w-28" /></TableCell>
                      <TableCell className="text-center"><Skeleton className="h-5 w-8 mx-auto rounded-full" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                      <TableCell className="text-right"><Skeleton className="h-4 w-14 ml-auto" /></TableCell>
                      <TableCell className="text-right"><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                      <TableCell />
                      <TableCell />
                      <TableCell />
                      <TableCell />
                    </TableRow>
                  ))
                ) : null}
                {catalogueReady && isrAssets.map((r, i) => {
                  const isSelected = selectedTickers.has(r.ticker);
                  return (
                    <TableRow
                      key={r.ticker}
                      className={`group hover:bg-muted/20 transition-colors ${isSelected ? "bg-blue-100 hover:bg-blue-200" : i % 2 === 0 ? "bg-card" : "bg-background"}`}
                    >
                      <TableCell className="text-center px-3">
                        <button onClick={() => toggleSelect(r.ticker)} className="text-muted-foreground hover:text-[#2563EB] transition-colors">
                          {isSelected ? <CheckSquare className="h-4 w-4 text-[#2563EB]" /> : <Square className="h-4 w-4" />}
                        </button>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <button className="text-[#2563EB] hover:underline font-mono font-bold text-xs" onClick={() => navigate(`/deep-analysis/${encodeURIComponent(r.ticker)}`)}>
                            {r.ticker}
                          </button>
                          {vip.has(r.ticker.toUpperCase()) && <VipChip />}
                        </div>
                      </TableCell>
                      {/* Sector Badge */}
                      <TableCell>
                        {(() => {
                          const sectorLabel = r.ticker.endsWith(".TA") ? "TASE" : r.sector;
                          return sectorLabel ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-700 border border-slate-200 whitespace-nowrap">
                              {sectorLabel}
                            </span>
                          ) : <span className="text-muted-foreground text-xs">—</span>;
                        })()}
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center gap-1">
                          {holdingTickers.has(r.ticker.toUpperCase()) && (
                            <span title="קיים בתיק 1" className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold border border-emerald-400">H1</span>
                          )}
                          {h2Tickers.has(r.ticker.toUpperCase()) && (
                            <span title="קיים בתיק שני (H2 TASE)" className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-md bg-blue-600 text-white text-[10px] font-bold shadow-sm">H2</span>
                          )}
                          {!holdingTickers.has(r.ticker.toUpperCase()) && !h2Tickers.has(r.ticker.toUpperCase()) && (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <CatalogueScoreCell
                          ticker={r.ticker}
                          zivScore={r.zivScore}
                          compositeScore={r.compositeScore}
                          kronosBias={r.kronosBias}
                          kronosDirection={r.kronosDirection}
                        />
                      </TableCell>
                      <TableCell>
                        {r.tier ? <TierBadge tier={r.tier as any} /> : <span className="text-muted-foreground text-xs">—</span>}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">{r.cmp != null ? `${r.ticker.endsWith(".TA") ? "₪" : "$"}${r.cmp.toFixed(2)}` : "—"}</TableCell>
                      {/* Buy Price + Distance to Entry */}
                      <TableCell className="text-right">
                        {r.recommendedBuyPrice != null ? (
                          <div className="flex flex-col items-end gap-0.5">
                            <button
                              className="hover:underline hover:text-emerald-900 transition-colors cursor-pointer flex items-center gap-1 font-mono text-xs text-[#65A30D] font-semibold"
                              title="לחץ להוספת Price Alert"
                              onClick={() => handleOpenAddAlertDialog(r)}
                            >
                              <BellPlus className="h-3 w-3 opacity-60" />
                              {r.ticker.endsWith(".TA") ? "₪" : "$"}{r.recommendedBuyPrice.toFixed(2)}
                            </button>
                            {r.cmp != null && r.recommendedBuyPrice != null && r.recommendedBuyPrice > 0 && (() => {
                              const dist = ((r.cmp - r.recommendedBuyPrice) / r.recommendedBuyPrice) * 100;
                              if (Math.abs(dist) < 0.1) return <span className="text-[10px] font-bold text-[#65A30D]">Triggered</span>;
                              return (
                                <span className={`text-[10px] font-mono font-semibold ${dist > 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"}`}>
                                  {dist > 0 ? "+" : ""}{dist.toFixed(1)}%
                                </span>
                              );
                            })()}
                          </div>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </TableCell>
                      <TableCell className={`text-right font-mono text-xs ${(r.dailyChangePercent ?? 0) > 0 ? "text-[#65A30D]" : (r.dailyChangePercent ?? 0) < 0 ? "text-[#FF6B6B]" : ""}`}>
                        {r.dailyChangePercent != null ? `${r.dailyChangePercent >= 0 ? "+" : ""}${r.dailyChangePercent.toFixed(2)}%` : "—"}
                      </TableCell>
                      <TableCell className="text-center">
                        {r.hotSignal ? <span title="כל תנאי הכניסה מתקיימים" className="text-lg cursor-default select-none">🔥</span> : <span className="text-muted-foreground text-xs">—</span>}
                      </TableCell>
                      {/* Signal checkmark — active Price Alert */}
                      <TableCell className="text-center">
                        {activeAlertTickers.has(r.ticker.toUpperCase()) ? (
                          <span title="יש התראת מחיר פעילה" className="flex justify-center">
                            <CheckCircle2 className="h-4 w-4 text-[#2563EB]" />
                          </span>
                        ) : signalTickers.has(r.ticker.toUpperCase()) ? (
                          <span title="יש איתות פעיל ב-Master Knowledge" className="flex justify-center">
                            <CheckCircle2 className="h-4 w-4 text-[#65A30D]" />
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </TableCell>
                      <TableCell className="px-2">
                        <div className="flex items-center gap-1.5">
                          <button
                            className="opacity-0 group-hover:opacity-100 text-[#65A30D] hover:text-emerald-800 transition-all"
                            title="קנה והוסף לתיק"
                            onClick={() => handleOpenBuyDialog({ ticker: r.ticker, recommendedBuyPrice: r.recommendedBuyPrice, recommendedStopLoss: r.recommendedStopLoss, cmp: r.cmp })}
                          >
                            <ShoppingCart className="h-3.5 w-3.5" />
                          </button>
                          <button
                            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-amber-500 transition-all"
                            title="העבר לארכיון"
                            onClick={() => { if (!window.confirm(`העבר ${r.ticker} לארכיון?`)) return; archiveMut.mutate({ tickers: [r.ticker] }); }}
                          >
                            <Archive className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}

              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
      )}

      {/* ── Quick Buy Dialog ── */}
      <Dialog open={!!buyDialog} onOpenChange={(o) => { if (!o) { setBuyDialog(null); setBuyUnits(""); setBuyPrice(""); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[#65A30D]">
              <ShoppingCart className="h-5 w-5" />
              קנה {buyDialog?.ticker}
            </DialogTitle>
          </DialogHeader>
          {buyDialog && (
            <div className="space-y-4 py-2">
              {/* Info row */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="bg-muted/40 rounded-lg p-3 text-center">
                  <p className="text-xs text-muted-foreground mb-1">מחיר שוק</p>
                  <p className="font-mono font-bold">{buyDialog.cmp != null ? `$${buyDialog.cmp.toFixed(2)}` : "—"}</p>
                </div>
                <div className="bg-red-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-muted-foreground mb-1">Stop Loss מומלץ</p>
                  <p className="font-mono font-bold text-[#FF6B6B]">{buyDialog.recommendedStopLoss != null ? `$${buyDialog.recommendedStopLoss.toFixed(2)}` : "—"}</p>
                </div>
              </div>
              {/* Price input */}
              <div className="space-y-1.5">
                <Label htmlFor="buy-price">מחיר קנייה ($)</Label>
                <Input
                  id="buy-price"
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder="0.00"
                  value={buyPrice}
                  onChange={(e) => setBuyPrice(e.target.value)}
                  className="font-mono"
                  autoFocus
                />
                {buyDialog.recommendedBuyPrice != null && (
                  <p className="text-xs text-[#65A30D]">מחיר כניסה מומלץ: ${buyDialog.recommendedBuyPrice.toFixed(2)}</p>
                )}
              </div>
              {/* Units input */}
              <div className="space-y-1.5">
                <Label htmlFor="buy-units">כמות מניות</Label>
                <Input
                  id="buy-units"
                  type="number"
                  step="1"
                  min="1"
                  placeholder="0"
                  value={buyUnits}
                  onChange={(e) => setBuyUnits(e.target.value)}
                  className="font-mono"
                  onKeyDown={(e) => { if (e.key === "Enter") handleConfirmBuy(); }}
                />
                {buyPrice && buyUnits && parseFloat(buyPrice) > 0 && parseFloat(buyUnits) > 0 && (
                  <p className="text-xs text-muted-foreground">
                    סה"כ: ${(parseFloat(buyPrice) * parseFloat(buyUnits)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                )}
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setBuyDialog(null); setBuyUnits(""); setBuyPrice(""); }}>ביטול</Button>
            <Button
              className="bg-[#65A30D] hover:bg-[#17a87e] text-white gap-1.5"
              onClick={handleConfirmBuy}
              disabled={addHoldingMut.isPending || !buyUnits || !buyPrice}
            >
              {addHoldingMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />}
              אשר קנייה
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* ── Add Signal Dialog (opened from Buy Price click) ── */}
      <Dialog open={!!signalDialog} onOpenChange={(o) => { if (!o) setSignalDialog(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BookmarkPlus className="h-5 w-5 text-[#65A30D]" />
              הוסף איתות פעיל {signalDialog?.ticker}
            </DialogTitle>
          </DialogHeader>
          {signalDialog && (
            <div className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">טיקר</Label>
                  <Input value={signalDialog.ticker} readOnly className="font-mono font-bold text-sm bg-muted" />
                </div>
                <div>
                  <Label className="text-xs">ציון ZIV</Label>
                  <Input
                    type="number" step="0.1" min="0" max="10"
                    value={signalDialog.zivScore}
                    onChange={(e) => setSignalDialog(d => d ? { ...d, zivScore: parseFloat(e.target.value) || 0 } : d)}
                    className="font-mono text-sm"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs">מחיר כניסה ($)</Label>
                  <Input
                    type="number" step="0.01"
                    value={signalDialog.entry}
                    onChange={(e) => setSignalDialog(d => d ? { ...d, entry: e.target.value } : d)}
                    className="font-mono text-sm text-[#65A30D] font-semibold"
                  />
                </div>
                <div>
                  <Label className="text-xs">Stop Loss ($)</Label>
                  <Input
                    type="number" step="0.01"
                    value={signalDialog.stopLoss}
                    onChange={(e) => setSignalDialog(d => d ? { ...d, stopLoss: e.target.value } : d)}
                    className="font-mono text-sm text-[#FF6B6B] font-semibold"
                  />
                </div>
                <div>
                  <Label className="text-xs">Take Profit ($)</Label>
                  <Input
                    type="number" step="0.01"
                    value={signalDialog.takeProfit}
                    onChange={(e) => setSignalDialog(d => d ? { ...d, takeProfit: e.target.value } : d)}
                    className="font-mono text-sm text-[#2563EB] font-semibold"
                  />
                </div>
              </div>
              <div>
                <Label className="text-xs">קטליסט / סיבה</Label>
                <Textarea
                  rows={3}
                  value={signalDialog.catalyst}
                  onChange={(e) => setSignalDialog(d => d ? { ...d, catalyst: e.target.value } : d)}
                  className="text-xs resize-none"
                  placeholder="סיבת הכניסה..."
                />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setSignalDialog(null)}>ביטול</Button>
            <Button
              onClick={confirmAddSignal}
              disabled={addSignalMut.isPending}
              className="bg-[#65A30D] hover:bg-[#17a87e] text-white"
            >
              {addSignalMut.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <BookmarkPlus className="h-4 w-4 mr-1" />}
              שמור איתות
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Add Alert Dialog (opened from Buy Price click) ── */}
      <Dialog open={!!addAlertDialog} onOpenChange={(o) => { if (!o) setAddAlertDialog(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <BellPlus className="h-4 w-4 text-[#2563EB]" />
              הוסף Price Alert — {addAlertDialog?.ticker}
            </DialogTitle>
          </DialogHeader>
          {addAlertDialog && (
            <div className="space-y-3 py-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground">מחיר יעד</label>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-sm text-muted-foreground">$</span>
                  <input
                    type="number"
                    step="0.01"
                    value={addAlertDialog.price}
                    onChange={(e) => setAddAlertDialog(d => d ? { ...d, price: e.target.value } : d)}
                    className="flex-1 border border-border rounded-md px-3 py-1.5 text-sm font-mono bg-background"
                    placeholder="0.00"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">כיוון</label>
                <div className="flex gap-2 mt-1">
                  <button
                    onClick={() => setAlertDirection("below")}
                    className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-colors ${
                      alertDirection === "below"
                        ? "bg-red-50 border-red-400 text-red-700"
                        : "border-border text-muted-foreground hover:bg-muted/30"
                    }`}
                  >
                    ▼ מתחת למחיר
                  </button>
                  <button
                    onClick={() => setAlertDirection("above")}
                    className={`flex-1 py-1.5 rounded-md text-xs font-semibold border transition-colors ${
                      alertDirection === "above"
                        ? "bg-emerald-50 border-emerald-400 text-emerald-700"
                        : "border-border text-muted-foreground hover:bg-muted/30"
                    }`}
                  >
                    ▲ מעל למחיר
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">תווית (אופציונלי)</label>
                <input
                  type="text"
                  value={alertLabel}
                  onChange={(e) => setAlertLabel(e.target.value)}
                  placeholder="למשל: Buy Zone, Support Level..."
                  className="w-full mt-1 border border-border rounded-md px-3 py-1.5 text-sm bg-background"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAddAlertDialog(null)}>ביטול</Button>
            <Button
              size="sm"
              className="gap-1.5"
              disabled={!addAlertDialog?.price || createAlertMut.isPending}
              onClick={() => {
                if (!addAlertDialog?.price) return;
                createAlertMut.mutate({
                  ticker: addAlertDialog.ticker,
                  alertType: "custom",
                  targetPrice: parseFloat(addAlertDialog.price),
                  direction: alertDirection,
                  label: alertLabel || `${addAlertDialog.ticker} התראה`,
                });
              }}
            >
              {createAlertMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BellPlus className="h-3.5 w-3.5" />}
              צור התראה
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Archive Panel */}
      <Card className="border shadow-sm">
        <CardHeader
          className="pb-2 pt-4 px-5 cursor-pointer select-none"
          onClick={() => setArchivePanelOpen(v => !v)}
        >
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Archive className="h-4 w-4 text-amber-500" />
            ארכיון נכסים ישנים
            {archivedQuery.data && archivedQuery.data.length > 0 && (
              <span className="ml-1 text-xs bg-amber-50 text-amber-700 rounded-full px-2 py-0.5">{archivedQuery.data.length}</span>
            )}
            <ChevronRight className={`h-4 w-4 ml-auto text-muted-foreground transition-transform ${archivePanelOpen ? "rotate-90" : ""}`} />
          </CardTitle>
        </CardHeader>
        {archivePanelOpen && (
          <CardContent className="px-5 pb-5">
            {archivedQuery.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <Loader2 className="h-4 w-4 animate-spin" /> טוען ארכיון...
              </div>
            ) : !archivedQuery.data || archivedQuery.data.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">הארכיון ריק — שלח ניירות לארכיון כדי לשמור אותם כאן.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-right w-16">Ticker</TableHead>
                      <TableHead className="text-right">חברה</TableHead>
                      <TableHead className="text-right">סקטור</TableHead>
                      <TableHead className="text-right w-16">ציון</TableHead>
                      <TableHead className="text-right w-28">תאריך ארכיון</TableHead>
                      <TableHead className="text-right w-32">פעולות</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {archivedQuery.data.map((a) => (
                      <TableRow key={a.ticker} className="hover:bg-muted/20">
                        <TableCell className="font-mono font-bold text-sm">{a.ticker}</TableCell>
                        <TableCell className="text-sm">{a.company}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{a.sector}</TableCell>
                        <TableCell>
                          {a.score != null ? (
                            <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${a.score >= 8 ? "bg-emerald-50 text-emerald-700" : a.score >= 6 ? "bg-blue-50 text-blue-700" : a.score >= 4 ? "bg-amber-50 text-amber-700" : "bg-red-50 text-red-600"}`}>
                              {a.score}
                            </span>
                          ) : <span className="text-xs text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {a.archivedAt ? new Date(a.archivedAt).toLocaleDateString("he-IL") : "—"}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs gap-1 border-green-400 text-green-700 hover:bg-green-50"
                              onClick={() => restoreMut.mutate({ tickers: [a.ticker] })}
                              disabled={restoreMut.isPending}
                            >
                              <RotateCcw className="h-3 w-3" /> שחזר
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs gap-1 text-red-600 hover:text-red-700 hover:bg-red-100"
                              onClick={() => { if (!window.confirm(`מחק ${a.ticker} לצמיתות?`)) return; deleteFromArchiveMut.mutate({ tickers: [a.ticker] }); }}
                              disabled={deleteFromArchiveMut.isPending}
                            >
                              <Trash2 className="h-3 w-3" /> מחק
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  );
}

