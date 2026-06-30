import { useState, useMemo, useEffect, useRef } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { decodeHtmlEntities } from "@shared/htmlEntities";
import { YoutubeThumbnail } from "@/components/YoutubeThumbnail";
import {
  RefreshCw,
  Search,
  ExternalLink,
  PlayCircle,
  CheckCircle2,
  Clock,
  Loader2,
  Download,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  TrendingUp,
  BarChart2,
  FileText,
  X,
  AlertCircle,
  Info,
  Zap,
  BookmarkPlus,
  PlusCircle,
  XCircle,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type MentorKey = "cycles_trading" | "micha_stocks";

function displayTitle(title: string): string {
  return decodeHtmlEntities(title);
}

interface ChannelVideo {
  id: number;
  videoId: string;
  mentor: MentorKey;
  title: string;
  uploadDate: Date | string;
  thumbnailUrl?: string | null;
  duration?: number | null;
  viewCount?: number | null;
  isNew: boolean;
  analysisId?: number | null;
  analyzedAt?: Date | string | null;
  analysisStatus?: string | null;
  watchlistCount?: number | null;
}

interface WatchlistRow {
  ticker: string;
  company: string;
  strategy: string;
  entry_zone: string;
  stop_loss: string;
  catalyst: string;
  tradingview_alert: string;
  watchlist: string;
  normalizedTicker?: string;
  market?: "USA" | "TASE";
  inCatalogue?: boolean;
  sector?: string | null;
  companyDescription?: string | null;
  eligibility?: {
    priceOk: boolean | null;
    volumeOk: boolean | null;
    price: number | null;
    avgVolume20: number | null;
    minPrice: number;
    minVolume: number;
    currencySymbol: string;
    suitable: boolean;
  } | null;
}

const MENTORS: Record<MentorKey, { label: string; handle: string; icon: React.ReactNode; color: string }> = {
  cycles_trading: {
    label: "Ziv Hakshurian – Cycles Trading",
    handle: "@cyclestrading",
    icon: <TrendingUp className="w-4 h-4" />,
    color: "blue",
  },
  micha_stocks: {
    label: "Micha.Stocks",
    handle: "@Micha.Stocks",
    icon: <BarChart2 className="w-4 h-4" />,
    color: "purple",
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = new Date(d);
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function formatDuration(secs: number | null | undefined): string {
  if (!secs) return "";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatViews(n: number | null | undefined): string {
  if (!n) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M views`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K views`;
  return `${n} views`;
}

// ─── Hebrew Translation Helper ───────────────────────────────────────────────

/**
 * Translates common English trading phrases to Hebrew.
 * Used for analyses that were generated before the Hebrew prompt was deployed.
 * New analyses (post-prompt update) will already be in Hebrew.
 */
function translateToHebrew(text: string): string {
  if (!text || text === "—") return text;
  // If already contains Hebrew characters, return as-is
  if (/[\u0590-\u05FF]/.test(text)) return text;

  const replacements: [RegExp | string, string][] = [
    // Strategy types
    [/Bull Trend Pullback to EMA(\d+)/gi, "משיכה לאחור ל-EMA$1 במגמת עלייה"],
    [/Bull Trend Pullback/gi, "משיכה לאחור במגמת עלייה"],
    [/Breakout above resistance zone/gi, "פריצה מעל אזור התנגדות"],
    [/Breakout above resistance/gi, "פריצה מעל התנגדות"],
    [/Wait for pullback to previous resistance \(now support\) zone after breakout/gi, "המתנה למשיכה לאחור לאזור תמיכה לאחר פריצה"],
    [/Wait for pullback to previous resistance \(now support\) zone/gi, "המתנה למשיכה לאחור לאזור תמיכה"],
    [/Wait for pullback to support/gi, "המתנה למשיכה לאחור לתמיכה"],
    [/Wait for pullback/gi, "המתנה למשיכה לאחור"],
    [/Demand zone entry/gi, "כניסה לאזור ביקוש"],
    [/Join the move.*momentum/gi, "הצטרפות לתנועה — מומנטום"],
    [/Join the move/gi, "הצטרפות לתנועה"],
    [/High Risk\/Reward setup/gi, "הגדרת סיכון/תשואה גבוהה"],
    [/Watching for base breakout/gi, "עוקב אחר פריצת בסיס"],
    [/Watching for breakout/gi, "עוקב אחר פריצה"],
    [/Watching for pullback/gi, "עוקב אחר משיכה לאחור"],
    // Entry zone patterns
    [/pullback to EMA(\d+)/gi, "משיכה לאחור ל-EMA$1"],
    [/pullback to support/gi, "משיכה לאחור לתמיכה"],
    [/demand zone/gi, "אזור ביקוש"],
    [/resistance zone/gi, "אזור התנגדות"],
    [/support zone/gi, "אזור תמיכה"],
    [/Breakout above/gi, "פריצה מעל"],
    [/After close above/gi, "לאחר סגירה מעל"],
    [/On pullback to/gi, "במשיכה לאחור ל-"],
    // Stop loss patterns
    [/Below EMA(\d+)/gi, "מתחת ל-EMA$1"],
    [/Below support zone at/gi, "מתחת לאזור תמיכה ב-"],
    [/Below support/gi, "מתחת לתמיכה"],
    [/Below the demand zone/gi, "מתחת לאזור הביקוש"],
    [/Strictly below/gi, "בהחלט מתחת ל-"],
    [/Below/gi, "מתחת ל-"],
    // Watchlist status
    [/Added to watchlist.*waiting for pullback/gi, "הוסף לרשימת מעקב — ממתין למשיכה לאחור"],
    [/Added to watchlist/gi, "הוסף לרשימת מעקב"],
    [/Watching for breakout above/gi, "עוקב אחר פריצה מעל"],
    [/On radar for next week/gi, "על הרדאר לשבוע הבא"],
    [/Entered position/gi, "נכנס לפוזיציה"],
    [/Watching for pullback/gi, "עוקב אחר משיכה לאחור"],
    // Catalyst patterns
    [/revenue jump/gi, "קפיצת הכנסות"],
    [/revenue growth/gi, "צמיחת הכנסות"],
    [/earnings beat/gi, "הכנסות עלו על הציפיות"],
    [/Strong earnings/gi, "דוחות חזקים"],
    [/Breaking out of/gi, "פריצה מ-"],
    [/Breaking out/gi, "פריצה"],
    [/AI chip demand/gi, "ביקוש לשבבי AI"],
    [/Defense contracts/gi, "חוזים ביטחוניים"],
    [/net profit increase/gi, "עלייה ברווח נקי"],
    [/Increased trading volume/gi, "עלייה בנפח מסחר"],
    [/Strong revenue growth/gi, "צמיחת הכנסות חזקה"],
    [/Large volume spikes/gi, "קפיצות נפח גדולות"],
    [/all-time highs/gi, "שיאים היסטוריים"],
    [/ATH/g, "שיא היסטורי"],
    // Alert patterns
    [/Alert set at/gi, "התראה הוגדרה ב-"],
    [/resistance/gi, "התנגדות"],
    [/support/gi, "תמיכה"],
  ];

  let result = text;
  for (const [pattern, replacement] of replacements) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ─── Report table by market ───────────────────────────────────────────────────

function formatVolume(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return Math.round(n).toLocaleString();
}

function EligibilityCheck({
  ok,
  label,
  detail,
}: {
  ok: boolean | null;
  label: string;
  detail?: string;
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs leading-tight" title={detail}>
      {ok === true ? (
        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
      ) : ok === false ? (
        <XCircle className="w-4 h-4 text-red-500 shrink-0" />
      ) : (
        <span className="w-4 h-4 text-center text-slate-300 shrink-0">?</span>
      )}
      <span className={ok === true ? "text-emerald-800 font-medium" : ok === false ? "text-red-700" : "text-slate-400"}>
        {label}
      </span>
      {detail && (
        <span className="text-slate-500 font-mono text-[11px]">{detail}</span>
      )}
    </div>
  );
}

function EligibilityCell({ row }: { row: WatchlistRow }) {
  const e = row.eligibility;
  if (!e) {
    return <span className="text-xs text-slate-400">טוען…</span>;
  }

  const priceDetail = e.price != null
    ? `${e.currencySymbol}${e.price < 0.01 ? e.price.toFixed(4) : e.price.toFixed(2)}`
    : undefined;
  const volDetail = e.avgVolume20 != null
    ? `${formatVolume(e.avgVolume20)}/יום`
    : undefined;

  return (
    <div className={`space-y-1.5 rounded-lg px-2 py-1.5 ${e.suitable ? "bg-emerald-50/80" : ""}`}>
      <EligibilityCheck
        ok={e.priceOk}
        label="מחיר"
        detail={priceDetail}
      />
      <EligibilityCheck
        ok={e.volumeOk}
        label="נפח"
        detail={volDetail}
      />
      {e.suitable && (
        <span className="inline-block text-[10px] font-bold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
          מתאים ✓
        </span>
      )}
    </div>
  );
}

function ReportMarketTable({
  title,
  badgeClass,
  rows,
  addedTickers,
  onAdd,
  addingTicker,
}: {
  title: string;
  badgeClass: string;
  rows: WatchlistRow[];
  addedTickers: Set<string>;
  onAdd: (row: WatchlistRow) => void;
  addingTicker: string | null;
}) {
  if (rows.length === 0) return null;

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-2.5">
        <span className={`text-sm font-bold px-3 py-1 rounded-lg border ${badgeClass}`}>
          {title}
        </span>
        <span className="text-sm text-gray-500">{rows.length} מניות</span>
        <span className="text-[11px] text-slate-400 mr-auto">
          תנאי סף: מחיר ≥ $2 / ₪2 · נפח 20י ≥ 200K (USA) / 10K (TASE)
        </span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 shadow-sm bg-white">
        <table className="w-full min-w-[1280px] text-sm" dir="rtl">
          <thead>
            <tr className="bg-slate-800 text-white">
              <th className="w-9 px-2 py-2.5 text-center text-xs font-semibold">#</th>
              <th className="w-[72px] px-2 py-2.5 text-right text-xs font-semibold whitespace-nowrap">טיקר</th>
              <th className="w-[130px] px-2 py-2.5 text-right text-xs font-semibold">חברה</th>
              <th className="w-[110px] px-2 py-2.5 text-right text-xs font-semibold">מתאים לנו?</th>
              <th className="w-[52px] px-2 py-2.5 text-center text-xs font-semibold">קטלוג</th>
              <th className="w-[280px] px-3 py-2.5 text-right text-xs font-semibold">סקטור / פעילות</th>
              <th className="px-3 py-2.5 text-right text-xs font-semibold">אסטרטגיה / קטליזטור</th>
              <th className="w-[120px] px-2 py-2.5 text-right text-xs font-semibold">סטופ לוס</th>
              <th className="w-[80px] px-2 py-2.5 text-center text-xs font-semibold">פעולה</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, i) => {
              const tickerKey = (row.normalizedTicker ?? row.ticker).toUpperCase();
              const inCatalogue = row.inCatalogue || addedTickers.has(tickerKey);
              return (
                <tr key={`${tickerKey}-${i}`} className="hover:bg-blue-50/50 align-top">
                  <td className="text-center px-2 py-2 text-xs font-bold text-slate-400">{i + 1}</td>
                  <td className="px-2 py-2">
                    <span className="inline-flex items-center px-2.5 py-1 rounded-md bg-blue-600 text-white text-sm font-bold tracking-wide">
                      {row.normalizedTicker ?? row.ticker}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-slate-700 text-sm font-medium leading-snug">
                    {row.company !== "—" ? row.company : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-2 py-2">
                    <EligibilityCell row={row} />
                  </td>
                  <td className="px-2 py-2 text-center">
                    {inCatalogue ? (
                      <span className="inline-flex items-center gap-0.5 text-xs font-semibold text-emerald-700">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {row.sector ? (
                      <span className="inline-block mb-1 text-xs font-semibold text-indigo-800 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-200">
                        {row.sector}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">סקטור לא ידוע</span>
                    )}
                    {row.companyDescription ? (
                      <p className="text-slate-700 text-sm leading-relaxed mt-1">{row.companyDescription}</p>
                    ) : (
                      <p className="text-slate-400 text-xs mt-1 italic">תיאור עסקי לא זמין</p>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-700 text-sm leading-relaxed">
                    {row.strategy !== "—" && (
                      <p className="font-semibold text-slate-800 mb-1">{translateToHebrew(row.strategy)}</p>
                    )}
                    {row.catalyst !== "—" && (
                      <p className="text-slate-600">{translateToHebrew(row.catalyst)}</p>
                    )}
                    {row.watchlist !== "—" && (
                      <p className="text-blue-600 mt-1 text-xs italic">{translateToHebrew(row.watchlist)}</p>
                    )}
                    {row.strategy === "—" && row.catalyst === "—" && row.watchlist === "—" && (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    {row.stop_loss !== "—" ? (
                      <span className="text-red-600 font-semibold text-sm leading-snug">
                        {translateToHebrew(row.stop_loss)}
                      </span>
                    ) : (
                      <span className="text-slate-300 text-sm">—</span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-center">
                    {inCatalogue ? (
                      <span className="text-xs text-emerald-600 font-medium">✓</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onAdd(row)}
                        disabled={addingTicker === tickerKey}
                        className="text-xs h-8 px-2.5 text-blue-700 border-blue-300 hover:bg-blue-50"
                      >
                        {addingTicker === tickerKey ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <><PlusCircle className="w-3.5 h-3.5 ml-1" /> הוסף</>
                        )}
                      </Button>
                    )}
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

// ─── Watchlist Report Modal ────────────────────────────────────────────────────

function WatchlistReportModal({
  analysisId,
  videoTitle,
  videoDate,
  onClose,
}: {
  analysisId: number;
  videoTitle: string;
  videoDate: string;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const { data, isLoading, error } = trpc.videoManagement.getWatchlistReport.useQuery(
    { analysisId },
    { refetchOnWindowFocus: false }
  );

  const reAnalyze = trpc.videoManagement.reAnalyze.useMutation({
    onSuccess: (result) => {
      toast.success(`ניתוח מחדש הושלם! נמצאו ${result.rowCount} מניות.`);
      utils.videoManagement.getWatchlistReport.invalidate({ analysisId });
    },
    onError: (err) => toast.error(`ניתוח מחדש נכשל: ${err.message}`),
  });

  const [addedTickers, setAddedTickers] = useState<Set<string>>(new Set());
  const [addingTicker, setAddingTicker] = useState<string | null>(null);

  const addToCatalog = trpc.videoManagement.addToAssetCatalog.useMutation({
    onSuccess: (r) => {
      toast.success(`${r.ticker} נוסף לקטלוג`);
      setAddedTickers((prev) => new Set([...prev, r.ticker]));
      setAddingTicker(null);
      utils.videoManagement.getWatchlistReport.invalidate({ analysisId });
    },
    onError: (err) => {
      toast.error(err.message);
      setAddingTicker(null);
    },
  });

  const rows: WatchlistRow[] = data?.rows ?? [];
  const allRows: WatchlistRow[] = data?.allRows ?? rows;
  const generalNotes = data?.general_notes ?? "";
  const [showOnlyWatchlist, setShowOnlyWatchlist] = useState(false);

  const hasFilteredRows = rows.length > 0;
  const displayRows = (showOnlyWatchlist && hasFilteredRows) ? rows : allRows;

  const usaRows = useMemo(() => displayRows.filter((r) => r.market !== "TASE"), [displayRows]);
  const taseRows = useMemo(() => displayRows.filter((r) => r.market === "TASE"), [displayRows]);

  const handleAddToCatalog = (row: WatchlistRow) => {
    const ticker = row.normalizedTicker ?? row.ticker;
    setAddingTicker(ticker.toUpperCase());
    addToCatalog.mutate({
      ticker,
      companyName: row.company !== "—" ? row.company : ticker,
      sector: row.market === "TASE" ? "TASE" : "מניות",
      label: "Ziv Watchlist",
      entryZone: row.entry_zone !== "—" ? row.entry_zone : undefined,
      stopLoss: row.stop_loss !== "—" ? row.stop_loss : undefined,
      strategy: row.strategy !== "—" ? row.strategy : undefined,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-white/50 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-[min(1500px,98vw)] max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
          <div className="flex-1 min-w-0 pr-4">
            <div className="flex items-center gap-2 mb-1">
              <FileText className="w-5 h-5 text-[#2563EB] shrink-0" />
              <span className="text-xs font-semibold text-[#2563EB] uppercase tracking-wide">דוח רשימת מעקב</span>
            </div>
            <h2 className="text-base font-bold text-gray-900 line-clamp-2 leading-snug">{videoTitle || "ניתוח סרטון"}</h2>
            <p className="text-sm text-gray-500 mt-0.5">סרטון: {videoDate}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {isLoading && (
            <div className="flex items-center justify-center py-16 gap-3 text-gray-400">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">טוען דוח רשימת מעקב…</span>
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center py-16 gap-3 text-[#FF6B6B]">
              <AlertCircle className="w-5 h-5" />
              <span className="text-sm">שגיאה בטעינת הדוח: {error.message}</span>
            </div>
          )}

          {!isLoading && !error && (
            <>
              {/* Toggle + Re-analyze */}
              <div className="px-6 pt-4 pb-0 flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3">
                  {allRows.length > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">מציג:</span>
                      <button
                        onClick={() => setShowOnlyWatchlist(false)}
                        className={`text-xs px-2 py-0.5 rounded-md font-medium transition-colors ${
                          !showOnlyWatchlist
                            ? "bg-blue-100 text-blue-700 border border-blue-200"
                            : "text-gray-400 hover:text-gray-600"
                        }`}
                      >
                        כל המניות ({allRows.length})
                      </button>
                      {hasFilteredRows && (
                        <button
                          onClick={() => setShowOnlyWatchlist(true)}
                          className={`text-xs px-2 py-0.5 rounded-md font-medium transition-colors ${
                            showOnlyWatchlist
                              ? "bg-emerald-50 text-emerald-700 border border-emerald-300"
                              : "text-gray-400 hover:text-gray-600"
                          }`}
                        >
                          רשימת מעקב בלבד ({rows.length})
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => reAnalyze.mutate({ analysisId })}
                  disabled={reAnalyze.isPending}
                  className="text-xs h-7 px-3 text-[#2563EB] border-purple-200 hover:bg-purple-50 shrink-0"
                >
                  {reAnalyze.isPending ? (
                    <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> מנתח מחדש…</>
                  ) : (
                    <><RefreshCw className="w-3 h-3 mr-1" /> נתח מחדש עם AI חדש</>
                  )}
                </Button>
              </div>

              {/* Table */}
              {displayRows.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-gray-400 gap-3">
                  <Info className="w-8 h-8" />
                  <p className="text-sm font-medium">לא נמצאו מניות בניתוח זה</p>
                  <p className="text-xs text-gray-400 text-center max-w-xs">הסרטון נותח עם גרסת AI ישנה. לחץ על "נתח מחדש עם AI חדש" כדי לחלץ מניות עם ה-prompt המשופר.</p>
                  <Button
                    size="sm"
                    onClick={() => reAnalyze.mutate({ analysisId })}
                    disabled={reAnalyze.isPending}
                    className="mt-2 bg-purple-600 hover:bg-purple-700 text-white text-xs"
                  >
                    {reAnalyze.isPending ? (
                      <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> מנתח מחדש…</>
                    ) : (
                      <><RefreshCw className="w-3 h-3 mr-1" /> נתח מחדש עם AI חדש</>
                    )}
                  </Button>
                </div>
              ) : (
                <div className="px-4 sm:px-5 py-3">
                  <ReportMarketTable
                    title="🇺🇸 USA"
                    badgeClass="bg-blue-50 text-blue-700 border-blue-200"
                    rows={usaRows}
                    addedTickers={addedTickers}
                    onAdd={handleAddToCatalog}
                    addingTicker={addingTicker}
                  />
                  <ReportMarketTable
                    title="🇮🇱 TASE"
                    badgeClass="bg-indigo-50 text-indigo-700 border-indigo-200"
                    rows={taseRows}
                    addedTickers={addedTickers}
                    onAdd={handleAddToCatalog}
                    addingTicker={addingTicker}
                  />
                </div>
              )}

              {/* General Notes */}
              {generalNotes && generalNotes !== "—" && (
                <div className="px-6 pb-6">
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Info className="w-4 h-4 text-amber-600" />
                      <span className="text-xs font-semibold text-amber-400 uppercase tracking-wide">הערות שוק כלליות</span>
                    </div>
                    <p className="text-sm text-amber-900 leading-relaxed">{generalNotes}</p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-100 bg-gray-50 flex items-center justify-between">
          <span className="text-xs text-gray-400">
            {!isLoading && displayRows.length > 0 && (
              <>
                {displayRows.length} מניות · USA {usaRows.length} · TASE {taseRows.length}
                {hasFilteredRows && showOnlyWatchlist && ` · רשימת מעקב ${rows.length}`}
              </>
            )}
          </span>
          <div className="flex items-center gap-2">
            {data && (
              <Link href={`/analyze?id=${analysisId}`}>
                <Button variant="outline" size="sm" className="text-xs h-7 text-[#2563EB] border-blue-200 hover:bg-blue-50">
                  <ExternalLink className="w-3 h-3 mr-1" />
                  ניתוח מלא
                </Button>
              </Link>
            )}
            <Button variant="outline" size="sm" className="text-xs h-7" onClick={onClose}>
              סגור
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

export default function VideoManagement() {
  const [activeMentor, setActiveMentor] = useState<MentorKey>("cycles_trading");

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* ── Page Header ── */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Video Management</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Track and analyze videos from your trading mentors
          </p>
        </div>

        {/* ── Mentor Tabs ── */}
        <div className="flex gap-2 mb-6 border-b border-gray-200">
          {(Object.entries(MENTORS) as [MentorKey, typeof MENTORS[MentorKey]][]).map(([key, mentor]) => (
            <button
              key={key}
              onClick={() => setActiveMentor(key)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
                activeMentor === key
                  ? key === "cycles_trading"
                    ? "border-blue-600 text-blue-700"
                    : "border-purple-600 text-[#2563EB]"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              {mentor.icon}
              <span className="hidden sm:inline">{mentor.label}</span>
              <span className="sm:hidden">{key === "cycles_trading" ? "Cycles" : "Micha"}</span>
            </button>
          ))}
        </div>

        {/* ── Channel Panel ── */}
        <ChannelPanel key={activeMentor} mentor={activeMentor} />
      </div>
    </div>
  );
}

// ─── Channel Panel ────────────────────────────────────────────────────────────

function ChannelPanel({ mentor }: { mentor: MentorKey }) {
  const mentorInfo = MENTORS[mentor];
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [sendingVideoId, setSendingVideoId] = useState<string | null>(null);
  const [reportModal, setReportModal] = useState<{ analysisId: number; videoTitle: string; videoDate: string } | null>(null);
  // Track videos currently being processed: videoId -> analysisId
  const [processingVideos, setProcessingVideos] = useState<Record<string, number>>({});

  // Fetch paginated list from DB
  const { data, isLoading, refetch } = trpc.videoManagement.list.useQuery(
    { limit: PAGE_SIZE, offset: page * PAGE_SIZE, mentor },
    { refetchOnWindowFocus: false }
  );

  // Mutations
  const fetchAll = trpc.videoManagement.fetchAll.useMutation({
    onSuccess: (result) => {
      toast.success(`Channel synced! Fetched ${result.fetched} videos across ${result.pages} pages. Total: ${result.total}.`);
      refetch();
    },
    onError: (err) => toast.error(`Sync failed: ${err.message}`),
  });

  const syncNew = trpc.videoManagement.syncNew.useMutation({
    onSuccess: (result) => {
      if (result.newVideos > 0) {
        toast.success(`${result.newVideos} new video(s) found! ${result.recentCount} recent in last 3 days.`);
      } else {
        toast("No new videos — channel is up to date.");
      }
      refetch();
    },
    onError: (err) => toast.error(`Sync failed: ${err.message}`),
  });

  const sendToAnalyze = trpc.videoManagement.sendToAnalyze.useMutation({
    onSuccess: (result, variables) => {
      toast.success(`ניתוח #${result.analysisId} התחיל!`);
      setSendingVideoId(null);
      setProcessingVideos((prev) => ({ ...prev, [variables.videoId]: result.analysisId }));
    },
    onError: (err) => {
      toast.error(`ניתוח נכשל: ${err.message}`);
      setSendingVideoId(null);
    },
  });

  // Client-side search filter
  const videos: ChannelVideo[] = (data?.videos ?? []) as ChannelVideo[];
  const total = data?.total ?? 0;

  const filtered = useMemo(() => {
    if (!search.trim()) return videos;
    const q = search.toLowerCase();
    return videos.filter((v) => v.title.toLowerCase().includes(q));
  }, [videos, search]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const isEmpty = total === 0;
  const accentColor = mentor === "cycles_trading" ? "blue" : "purple";

  return (
    <>
      {/* ── Watchlist Report Modal ── */}
      {reportModal && (
        <WatchlistReportModal
          analysisId={reportModal.analysisId}
          videoTitle={reportModal.videoTitle}
          videoDate={reportModal.videoDate}
          onClose={() => setReportModal(null)}
        />
      )}

      {/* ── Panel Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-medium text-${accentColor}-700 bg-${accentColor}-50 px-2.5 py-1 rounded-full border border-${accentColor}-200`}>
            {mentorInfo.handle}
          </span>
          <span className="text-sm text-gray-500">{total.toLocaleString()} videos</span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {isEmpty && (
            <Button
              onClick={() => fetchAll.mutate({ mentor })}
              disabled={fetchAll.isPending}
              className={`bg-${accentColor}-600 hover:bg-${accentColor}-700 text-white`}
            >
              {fetchAll.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Fetching all videos…</>
              ) : (
                <><Download className="w-4 h-4 mr-2" /> Load All Videos</>
              )}
            </Button>
          )}

          <Button
            variant="outline"
            onClick={() => syncNew.mutate({ mentor })}
            disabled={syncNew.isPending}
          >
            {syncNew.isPending ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Checking…</>
            ) : (
              <><RefreshCw className="w-4 h-4 mr-2" /> Check for New Videos</>
            )}
          </Button>

          {!isEmpty && (
            <Button
              variant="outline"
              onClick={() => fetchAll.mutate({ mentor })}
              disabled={fetchAll.isPending}
              title="Re-fetch all videos from channel"
            >
              {fetchAll.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
            </Button>
          )}
        </div>
      </div>

      {/* ── Search ── */}
      {!isEmpty && (
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input
            placeholder="Search by title, ticker, or keyword…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            className="pl-9 bg-white border-gray-200"
          />
        </div>
      )}

      {/* ── Empty state ── */}
      {isEmpty && !isLoading && !fetchAll.isPending && (
        <div className="text-center py-24 bg-white rounded-xl border border-gray-200">
          <PlayCircle className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-gray-700 mb-2">No videos loaded yet</h2>
          <p className="text-sm text-gray-500 mb-6">
            Click <strong>Load All Videos</strong> to fetch the full {mentorInfo.handle} channel library.
            This runs once and takes about 30–60 seconds for 700+ videos.
          </p>
          <Button
            onClick={() => fetchAll.mutate({ mentor })}
            disabled={fetchAll.isPending}
            className="bg-[#2563EB] hover:bg-blue-700 text-white"
          >
            <Download className="w-4 h-4 mr-2" /> Load All Videos
          </Button>
        </div>
      )}

      {/* ── Loading skeleton ── */}
      {(isLoading || fetchAll.isPending) && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="p-4 border-b border-gray-100 bg-gray-50">
            <div className="h-4 bg-gray-200 rounded w-48 animate-pulse" />
          </div>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3 border-b border-gray-100">
              <div className="w-20 h-12 bg-gray-200 rounded animate-pulse flex-shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-3 bg-gray-200 rounded w-3/4 animate-pulse" />
                <div className="h-3 bg-gray-100 rounded w-1/4 animate-pulse" />
              </div>
              <div className="w-20 h-6 bg-gray-200 rounded animate-pulse" />
            </div>
          ))}
        </div>
      )}

      {/* ── Table ── */}
      {!isLoading && !isEmpty && (
        <>
          <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
            {/* Table header */}
            <div className="grid grid-cols-[auto_1fr_140px_120px_100px_220px] min-w-[800px] gap-0 border-b border-gray-200 bg-gray-50 px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              <div className="w-24 mr-4">Thumbnail</div>
              <div>Video Title</div>
              <div className="text-center">Upload Date</div>
              <div className="text-center">Status</div>
              <div className="text-center">ניירות ערך</div>
              <div className="text-center">Action</div>
            </div>

            {/* Rows */}
            {filtered.length === 0 ? (
              <div className="text-center py-12 text-gray-400">
                No videos match "<strong>{search}</strong>"
              </div>
            ) : (
              filtered.map((video) => {
                const processingAnalysisId =
                  processingVideos[video.videoId] ??
                  (video.analysisStatus === "processing" && video.analysisId
                    ? video.analysisId
                    : undefined);
                if (processingAnalysisId) {
                  return (
                    <ProcessingVideoRow
                      key={video.videoId}
                      video={video}
                      analysisId={processingAnalysisId}
                      onFinished={(success, errorMessage) => {
                        setProcessingVideos((prev) => {
                          const next = { ...prev };
                          delete next[video.videoId];
                          return next;
                        });
                        refetch();
                        if (success) {
                          toast.success(`ניתוח הסתיים! לחץ על Report לצפייה בדוח`);
                        } else {
                          toast.error(errorMessage ?? "ניתוח נכשל");
                        }
                      }}
                    />
                  );
                }
                return (
                  <VideoRow
                    key={video.videoId}
                    video={video}
                    isSending={sendingVideoId === video.videoId}
                    onSendToAnalyze={() => {
                      setSendingVideoId(video.videoId);
                      sendToAnalyze.mutate({ videoId: video.videoId });
                    }}
                    onViewReport={() => {
                      if (video.analysisId) {
                        setReportModal({
                          analysisId: video.analysisId,
                          videoTitle: video.title,
                          videoDate: formatDate(video.uploadDate),
                        });
                      }
                    }}
                    watchlistCount={(video as ChannelVideo).watchlistCount ?? null}
                  />
                );
              })
            )}
          </div>

          {/* ── Pagination ── */}
          {!search && totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 text-sm text-gray-500">
              <span>
                Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total.toLocaleString()} videos
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <span className="px-2">Page {page + 1} / {totalPages}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

// ─── Video Row ────────────────────────────────────────────────────────────────

// ─── Progress helpers ────────────────────────────────────────────────────────

function parseProgress(errorMessage: string | null | undefined): { pct: number; action: string } | null {
  if (!errorMessage || !errorMessage.startsWith("progress:")) return null;
  const parts = errorMessage.split(":");
  // format: progress:stageN:pct:action text
  const pct = parseInt(parts[2] ?? "0", 10);
  const action = parts.slice(3).join(":");
  return { pct: isNaN(pct) ? 0 : pct, action };
}

function ProgressBar({ pct, action }: { pct: number; action: string }) {
  return (
    <div className="w-full mt-1.5">
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[10px] text-[#2563EB] font-medium truncate max-w-[200px]">{action}</span>
        <span className="text-[10px] text-[#2563EB] font-bold ml-1">{pct}%</span>
      </div>
      <div className="h-1 bg-blue-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-[#2563EB] rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ─── Processing Row (polls status every 3s) ───────────────────────────────────

function ProcessingVideoRow({
  video,
  analysisId,
  onFinished,
}: {
  video: ChannelVideo;
  analysisId: number;
  onFinished: (success: boolean, errorMessage?: string) => void;
}) {
  const { data: statusData } = trpc.analyze.status.useQuery(
    { analysisId },
    { refetchInterval: 3000, refetchOnWindowFocus: true }
  );

  const prevStatus = useRef<string | null>(null);
  useEffect(() => {
    const status = statusData?.status;
    if (!status || status === prevStatus.current) return;
    if (status === "done") {
      prevStatus.current = "done";
      onFinished(true);
    } else if (status === "error") {
      prevStatus.current = "error";
      onFinished(false, statusData?.errorMessage ?? "ניתוח נכשל");
    } else {
      prevStatus.current = status;
    }
  }, [statusData?.status, statusData?.errorMessage, onFinished]);

  const progress = parseProgress(statusData?.errorMessage);
  const youtubeUrl = `https://www.youtube.com/watch?v=${video.videoId}`;

  return (
    <div className="grid grid-cols-[auto_1fr_140px_120px_100px_220px] min-w-[800px] gap-0 items-center px-4 py-3 border-b border-blue-100 bg-blue-50/40 transition-colors">
      {/* Thumbnail */}
      <div className="w-24 mr-4 flex-shrink-0">
        <a href={youtubeUrl} target="_blank" rel="noopener noreferrer">
          <YoutubeThumbnail
            videoId={video.videoId}
            thumbnailUrl={video.thumbnailUrl}
            alt={displayTitle(video.title)}
            className="w-24 h-14 rounded-md border border-blue-200"
            imgClassName="w-24 h-14 object-cover rounded-md border border-blue-200 opacity-70"
          />
        </a>
      </div>
      {/* Title + Progress */}
      <div className="min-w-0 pr-4">
        <a href={youtubeUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-gray-700 line-clamp-1 leading-snug">
          {displayTitle(video.title)}
          <ExternalLink className="inline w-3 h-3 ml-1 opacity-40" />
        </a>
        {progress ? (
          <ProgressBar pct={progress.pct} action={progress.action} />
        ) : (
          <div className="flex items-center gap-1 mt-1">
            <Loader2 className="w-3 h-3 text-[#2563EB] animate-spin" />
            <span className="text-[10px] text-[#2563EB]">מאתחל ניתוח...</span>
          </div>
        )}
      </div>
      {/* Upload Date */}
      <div className="text-center text-sm text-gray-500">{formatDate(video.uploadDate)}</div>
      {/* Status */}
      <div className="flex justify-center">
        <Badge className="bg-blue-100 text-blue-700 border-0 gap-1">
          <Loader2 className="w-3 h-3 animate-spin" />
          מנתח...
        </Badge>
      </div>
      {/* Watchlist Count */}
      <div className="flex justify-center">
        <span className="text-xs text-gray-200">—</span>
      </div>
      {/* Action */}
      <div className="flex justify-center">
        <Button size="sm" disabled className="text-xs h-7 px-3 bg-blue-300 text-white cursor-not-allowed">
          <Loader2 className="w-3 h-3 mr-1 animate-spin" /> מנתח...
        </Button>
      </div>
    </div>
  );
}

function VideoRow({
  video,
  isSending,
  onSendToAnalyze,
  onViewReport,
  watchlistCount,
}: {
  video: ChannelVideo;
  isSending: boolean;
  onSendToAnalyze: () => void;
  onViewReport: () => void;
  watchlistCount: number | null;
}) {
  const isDone = video.analysisStatus === "done";
  const isFailed = video.analysisStatus === "error";
  const youtubeUrl = `https://www.youtube.com/watch?v=${video.videoId}`;

  return (
    <div className="grid grid-cols-[auto_1fr_140px_120px_100px_220px] min-w-[800px] gap-0 items-center px-4 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors">
      {/* Thumbnail */}
      <div className="w-24 mr-4 flex-shrink-0">
        <a href={youtubeUrl} target="_blank" rel="noopener noreferrer">
          <YoutubeThumbnail
            videoId={video.videoId}
            thumbnailUrl={video.thumbnailUrl}
            alt={displayTitle(video.title)}
            className="w-24 h-14 rounded-md border border-gray-200"
            imgClassName="w-24 h-14 object-cover rounded-md border border-gray-200 hover:opacity-80 transition-opacity"
          />
        </a>
      </div>

      {/* Title */}
      <div className="min-w-0 pr-4">
        <div className="flex items-center gap-2 flex-wrap">
          {video.isNew && (
            <Badge className="bg-blue-100 text-blue-700 border-0 text-[10px] px-1.5 py-0 font-semibold shrink-0">
              NEW
            </Badge>
          )}
          <a
            href={youtubeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-gray-800 hover:text-[#2563EB] line-clamp-2 leading-snug"
          >
            {displayTitle(video.title)}
            <ExternalLink className="inline w-3 h-3 ml-1 opacity-40" />
          </a>
        </div>
        <div className="flex items-center gap-2 mt-1 text-xs text-gray-400">
          {video.duration ? <span>{formatDuration(video.duration)}</span> : null}
          {video.viewCount ? <span>· {formatViews(video.viewCount)}</span> : null}
        </div>
      </div>

      {/* Upload Date */}
      <div className="text-center text-sm text-gray-600">
        {formatDate(video.uploadDate)}
      </div>

      {/* Status */}
      <div className="flex justify-center">
        {isDone ? (
          <Badge className="bg-emerald-50 text-emerald-700 border-0 gap-1">
            <CheckCircle2 className="w-3 h-3" />
            Analyzed
          </Badge>
        ) : isFailed ? (
          <Badge className="bg-red-50 text-red-700 border-0 gap-1">
            <AlertCircle className="w-3 h-3" />
            נכשל
          </Badge>
        ) : (
          <Badge className="bg-gray-100 text-gray-500 border-0 gap-1">
            <Clock className="w-3 h-3" />
            Pending
          </Badge>
        )}
      </div>

      {/* Watchlist Count */}
      <div className="flex justify-center">
        {isDone && watchlistCount != null ? (
          watchlistCount > 0 ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-700 border border-blue-200">
              <TrendingUp className="w-3 h-3" />
              {watchlistCount}
            </span>
          ) : (
            <span className="text-xs text-gray-300">—</span>
          )
        ) : (
          <span className="text-xs text-gray-200">—</span>
        )}
      </div>

      {/* Action */}
      <div className="flex justify-center gap-1.5 flex-wrap">
        {isDone && (
          <Button
            size="sm"
            onClick={onViewReport}
            className="text-xs h-7 px-2.5 bg-[#65A30D] hover:bg-[#17a87e] text-white"
          >
            <FileText className="w-3 h-3 mr-1" />
            דוח
          </Button>
        )}
        <Button
          size="sm"
          onClick={onSendToAnalyze}
          disabled={isSending}
          className={`text-xs h-7 px-3 ${
            isDone || isFailed
              ? "bg-orange-500 hover:bg-orange-600 text-white"
              : "bg-[#2563EB] hover:bg-blue-700 text-white"
          }`}
          title={isDone || isFailed ? "נתח מחדש" : "שלח לניתוח"}
        >
          {isSending ? (
            <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> שולח…</>
          ) : isDone || isFailed ? (
            <><RefreshCw className="w-3 h-3 mr-1" /> נתח מחדש</>
          ) : (
            <><Sparkles className="w-3 h-3 mr-1" /> שלח לניתוח</>
          )}
        </Button>
      </div>
    </div>
  );
}
