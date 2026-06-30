/**
 * PortfolioPerformanceChart
 *
 * Renders the H1 equity curve using REAL IBKR historical NAV data fetched from
 * GET /api/ibind/performance/portfolio?period={period}
 *
 * Period selector: MTD | YTD | 1M | 3M | 6M | 1Y | 5Y  (default: 1Y)
 * Cache: localStorage, 15-minute TTL per period
 * Fallback: if IBKR returns 401 no_active_session → shows "Start Session" prompt
 *
 * Props:
 *   currentEquityValue — live NLV (used for "Update Chart Now" DB snapshot button)
 *   cashBalance        — cash portion
 *   unrealizedPnL      — IBKR unrealized P&L (optional)
 *   h2Value            — H2 portfolio total (optional, for combined view)
 */
import { useMemo, useState, useEffect, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  TrendingUp, TrendingDown, Loader2, BarChart2, Calendar,
  RefreshCw, Wifi, WifiOff, AlertCircle, Info,
} from "lucide-react";
import { toast } from "sonner";

// ─── Constants ────────────────────────────────────────────────────────────────
const SEED_VALUE = 110_000;
const ACCENT = "#6366f1";
const ACCENT_LIGHT = "#818cf8";
const RED = "#ef4444";
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

const PERIODS = ["7D", "MTD", "YTD", "1M", "3M", "6M", "1Y", "5Y"] as const;
type Period = (typeof PERIODS)[number];

/** Map virtual periods to the actual IBKR API period to fetch */
function apiPeriod(p: Period): string {
  if (p === "7D") return "1M";
  return p;
}

/** Minimum expected trading days for a period — used to detect partial data */
const MIN_EXPECTED_DAYS: Record<string, number> = {
  "7D": 5,
  "MTD": 3,
  "YTD": 10,
  "1M": 18,
  "3M": 55,
  "6M": 110,
  "1Y": 220,
  "5Y": 1000,
};

/** When will this period have full data, given the first available date */
function fullDataByDate(period: Period, firstDateStr: string): string | null {
  if (!firstDateStr) return null;
  const first = new Date(firstDateStr + "T12:00:00Z");
  const target = new Date(first);
  if (period === "3M") target.setMonth(target.getMonth() + 3);
  else if (period === "6M") target.setMonth(target.getMonth() + 6);
  else if (period === "1Y") target.setFullYear(target.getFullYear() + 1);
  else if (period === "5Y") target.setFullYear(target.getFullYear() + 5);
  else return null;
  return target.toLocaleDateString("he-IL", { month: "long", year: "numeric" });
}

/** Check if a date string (YYYY-MM-DD) is a weekend (Sat=6, Sun=0) */
function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr + "T12:00:00Z");
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/** Filter chart data to last N trading days (skip weekends) */
function sliceTradingDays(data: { date: string; equity: number }[], tradingDays: number) {
  // Get the last N trading days by counting backwards from today
  const tradingDates = data
    .filter(p => !isWeekend(p.date))
    .slice(-tradingDays);
  if (tradingDates.length === 0) return [];
  const cutoffDate = tradingDates[0].date;
  // Return all non-weekend points from cutoff onwards
  return data.filter(p => p.date >= cutoffDate && !isWeekend(p.date));
}

/** Filter chart data to today only (1D fallback from IBKR — clean date strings only) */
function sliceToday(data: { date: string; equity: number }[], currentEquityValue?: number): { date: string; equity: number }[] {
  const todayStr = new Date().toISOString().slice(0, 10);
  const prevTradingDay = data.filter(p => p.date < todayStr && !isWeekend(p.date));
  const prevPoint = prevTradingDay.length > 0 ? prevTradingDay[prevTradingDay.length - 1] : null;
  if (prevPoint) {
    // Use clean YYYY-MM-DD strings only — no suffixes that break new Date()
    const startPoint = { date: prevPoint.date, equity: prevPoint.equity };
    if (currentEquityValue && currentEquityValue > 0) {
      return [startPoint, { date: todayStr, equity: currentEquityValue }];
    }
    return [startPoint];
  }
  return data.slice(-2);
}

// ─── Cache helpers ────────────────────────────────────────────────────────────
function cacheKey(period: Period) {
  return `ibkr_nav_${period}`;
}

function readCache(period: Period): { date: string; equity: number }[] | null {
  try {
    const raw = localStorage.getItem(cacheKey(period));
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(period: Period, data: { date: string; equity: number }[]) {
  try {
    localStorage.setItem(cacheKey(period), JSON.stringify({ ts: Date.now(), data }));
  } catch {}
}

// ─── Parse IBKR NAV response → chart points ──────────────────────────────────
function parseNavResponse(body: any): { date: string; equity: number }[] {
  // IBKR returns nav under different paths depending on the period:
  // Short periods (1M, MTD, YTD): body.data.nav
  // Longer periods (3M, 6M, 1Y, 5Y): body.nav  OR  body.data.nav
  const nav = body?.data?.nav ?? body?.nav;
  if (!nav) return [];
  const dates: string[] = nav.dates ?? [];
  // navs can be at nav.data[0].navs or nav.navs directly
  const navs: number[] = nav.data?.[0]?.navs ?? nav.navs ?? [];
  if (!dates.length || !navs.length) return [];
  return dates
    .map((d: string, i: number) => {
      // IBKR date format: "20250427" → "2025-04-27"
      const iso = d.length === 8
        ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
        : d; // already ISO format
      const val = navs[i];
      return { date: iso, equity: val };
    })
    .filter(p => p.equity > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function yieldColor(pct: number) {
  if (pct > 0) return "text-[#65A30D]";
  if (pct < 0) return "text-[#FF6B6B]";
  return "text-muted-foreground";
}
function yieldBg(pct: number) {
  if (pct > 0) return "bg-emerald-50 border-emerald-200";
  if (pct < 0) return "bg-red-50 border-red-200";
  return "bg-muted/40 border-border";
}
function formatDate(dateStr: string | undefined | null): string {
  if (!dateStr) return "";
  // Handle both "YYYY-MM-DD" and "YYYY-MM-DD HH:mm" (hourly snapshots)
  const isHourly = dateStr.includes(' ');
  const d = isHourly ? new Date(dateStr.replace(' ', 'T') + ':00Z') : new Date(dateStr + "T12:00:00Z");
  if (isNaN(d.getTime())) return dateStr;
  if (isHourly) return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function formatDateFull(dateStr: string | undefined | null): string {
  if (!dateStr) return "";
  const isHourly = dateStr.includes(' ');
  const d = isHourly ? new Date(dateStr.replace(' ', 'T') + ':00Z') : new Date(dateStr + "T12:00:00Z");
  if (isNaN(d.getTime())) return dateStr;
  if (isHourly) return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function formatUSD(v: number) {
  return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

// ─── Custom Tooltip ───────────────────────────────────────────────────────────
function CustomTooltip({ active, payload, label, seedValue }: any) {
  if (!active || !payload?.length) return null;
  const equity = payload[0]?.value as number;
  if (equity == null || isNaN(equity)) return null;
  const pnl = equity - seedValue;
  const pct = seedValue > 0 ? (pnl / seedValue) * 100 : null;
  return (
    <div className="bg-background border border-border rounded-lg shadow-lg px-3 py-2 text-xs min-w-[150px]">
      <p className="font-semibold text-foreground mb-1">{formatDateFull(label)}</p>
      <p className="font-mono font-bold text-base text-indigo-600">{formatUSD(equity)}</p>
      {pct != null && (
        <p className={`font-mono mt-0.5 ${pct >= 0 ? "text-emerald-600" : "text-red-500"}`}>
          {pct >= 0 ? "+" : ""}{pct.toFixed(2)}% vs start
        </p>
      )}
    </div>
  );
}

// ─── Yield Badge ──────────────────────────────────────────────────────────────
function YieldBadge({ label, pct, icon }: { label: string; pct: number | null; icon: React.ReactNode }) {
  if (pct === null) return (
    <div className="flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl border bg-muted/30 border-border min-w-[80px]">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium flex items-center gap-1">{icon}{label}</span>
      <span className="text-sm font-bold text-muted-foreground">—</span>
    </div>
  );
  return (
    <div className={`flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl border ${yieldBg(pct)} min-w-[80px]`}>
      <span className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium flex items-center gap-1">{icon}{label}</span>
      <span className={`text-sm font-bold font-mono ${yieldColor(pct)}`}>
        {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
      </span>
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────
interface PortfolioPerformanceChartProps {
  currentEquityValue?: number;
  cashBalance?: number;
  unrealizedPnL?: number;
  h2Value?: number;
  portfolioType?: string; // h1 | h2-tase | h2-usa | h2-crypto
}

// ─── Main Component ───────────────────────────────────────────────────────────
export function PortfolioPerformanceChart({
  currentEquityValue,
  cashBalance,
  unrealizedPnL,
  h2Value,
  portfolioType = "h1",
}: PortfolioPerformanceChartProps) {
  const utils = trpc.useUtils();
  const [period, setPeriod] = useState<Period>("7D");
  const [chartData, setChartData] = useState<{ date: string; equity: number }[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noSession, setNoSession] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isStartingSession, setIsStartingSession] = useState(false);
  // ── Fetch IBKR NAV data───────────────────────────────────────────────
  const fetchNav = useCallback(async (p: Period, forceRefresh = false) => {
    // 7D and 1D are virtual periods — we fetch 1M from IBKR and slice client-side.
    // Cache key for both reuses the 1M cache to avoid a redundant API call.
    const cacheP: Period = p === "7D" ? "1M" : p;
    if (!forceRefresh) {
      const cached = readCache(cacheP);
      if (cached && cached.length > 0) {
        if (p === "7D") {
          setChartData(sliceTradingDays(cached, 7));
        } else {
          setChartData(cached);
        }
        setError(null);
        setNoSession(false);
        return;
      }
    }
    setIsLoading(true);
    setError(null);
    setNoSession(false);
    try {
      const resp = await fetch(`/api/ibind/performance/portfolio?period=${apiPeriod(p)}`, {
        credentials: "include",
      });
      const body = await resp.json();
      if (resp.status === 401) {
        const code = body?.error ?? body?.detail ?? "";
        if (code === "no_active_session" || code.includes("session")) {
          setNoSession(true);
        } else {
          setError("Unauthorized — please log in");
        }
        setIsLoading(false);
        return;
      }
      if (!resp.ok) {
        setError(body?.error ?? `Error ${resp.status}`);
        setIsLoading(false);
        return;
      }
      const points = parseNavResponse(body);
      if (points.length === 0) {
        setError("No NAV data returned for this period");
        setIsLoading(false);
        return;
      }
      writeCache(cacheP, points);
      if (p === "7D") {
        setChartData(sliceTradingDays(points, 7));
      } else {
        setChartData(points);
      }
    } catch (e: any) {
      setError(e.message ?? "Network error");
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchNav(period);
  }, [period, fetchNav]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    // Invalidate cache — 7D reuses the 1M cache key
    const cacheP: Period = period === "7D" ? "1M" : period;
    try { localStorage.removeItem(cacheKey(cacheP)); } catch {}
    await fetchNav(period, true);
  };

  // ── Start IBKR session ───────────────────────────────────────────────────
  const handleStartSession = async () => {
    setIsStartingSession(true);
    try {
      const resp = await fetch("/api/ibind/session/start", {
        method: "POST",
        credentials: "include",
      });
      const body = await resp.json();
      if (resp.ok && body?.success) {
        toast.success("IBKR session started — loading data...");
        setNoSession(false);
        await fetchNav(period, true);
      } else {
        toast.error(`Session start failed: ${body?.message ?? resp.status}`);
      }
    } catch (e: any) {
      toast.error(`Session start error: ${e.message}`);
    } finally {
      setIsStartingSession(false);
    }
  };

  // ── DB snapshot update button ────────────────────────────────────────────
  const recordSnapshotMut = trpc.portfolio.recordDailySnapshot.useMutation({
    onSuccess: () => {
      setIsUpdating(false);
      toast.success("גרף DB עודכן עם הערך הנוכחי");
      utils.portfolio.getSnapshotsAll.invalidate();
    },
    onError: (e) => {
      setIsUpdating(false);
      toast.error(`שגיאה בעדכון: ${e.message}`);
    },
  });

  const handleUpdateNow = () => {
    if (!currentEquityValue || currentEquityValue <= 0) {
      toast.error("אין ערך תיק זמין לעדכון");
      return;
    }
    setIsUpdating(true);
    recordSnapshotMut.mutate({
      totalEquity: currentEquityValue,
      cashBalance: cashBalance ?? undefined,
      unrealizedPnL: unrealizedPnL ?? undefined,
      h2Value: h2Value ?? undefined,
      forceUpdate: true,
      portfolioType,
    });
  };

  // ── For H2 portfolios: fetch DB snapshots instead of IBKR NAV ────────────────────────
  const isH2 = portfolioType !== "h1";
  const { data: dbSnapshots } = trpc.portfolio.getSnapshotsAll.useQuery(
    { portfolioType },
    { enabled: isH2, staleTime: 60_000 }
  );

  // Convert DB snapshots to chart points for H2 portfolios, filtered by period
  const h2ChartData = useMemo(() => {
    if (!isH2 || !dbSnapshots || dbSnapshots.length === 0) return [];
    const all = dbSnapshots
      .map(s => ({ date: s.snapshotDate, equity: s.totalValue }))
      .filter(p => p.equity > 0)
      .sort((a, b) => a.date.localeCompare(b.date));

    // Apply period filter
    const now = new Date();
    const cutoff = new Date(now);
    if (period === "7D") cutoff.setDate(now.getDate() - 7);
    else if (period === "MTD") cutoff.setDate(1);
    else if (period === "YTD") { cutoff.setMonth(0); cutoff.setDate(1); }
    else if (period === "1M") cutoff.setMonth(now.getMonth() - 1);
    else if (period === "3M") cutoff.setMonth(now.getMonth() - 3);
    else if (period === "6M") cutoff.setMonth(now.getMonth() - 6);
    else if (period === "1Y") cutoff.setFullYear(now.getFullYear() - 1);
    else if (period === "5Y") cutoff.setFullYear(now.getFullYear() - 5);
    else return all;

    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const filtered = all.filter(p => p.date >= cutoffStr);
    // Always include at least the first point as baseline
    return filtered.length > 0 ? filtered : all.slice(-1);
  }, [isH2, dbSnapshots, period]);

  // ── Add H2 offset to all historical points (H1 only) ────────────────────────
  // For H1: add current H2 value as a fixed offset to IBKR NAV points.
  // For H2 portfolios: use DB snapshots directly (no IBKR data).
  const h2Offset = (!isH2 && h2Value && h2Value > 0) ? h2Value : 0;

  const displayData = useMemo(() => {
    // H2 portfolios: use DB snapshots
    if (isH2) return h2ChartData;
    // H1: IBKR NAV + optional H2 offset
    if (h2Offset === 0) return chartData;
    return chartData.map(p => ({ ...p, equity: p.equity + h2Offset }));
  }, [isH2, h2ChartData, chartData, h2Offset]);

  // ── Derived stats ────────────────────────────────────────────────────────
  const currentEquity = displayData.length > 0 ? displayData[displayData.length - 1].equity : null;
  const seedValue = displayData.length > 0 ? displayData[0].equity : SEED_VALUE;

  const weeklyYield = useMemo(() => {
    if (!displayData.length || currentEquity === null) return null;
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(today.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString().slice(0, 10);
    const candidates = displayData.filter(d => d.date <= weekAgoStr);
    if (!candidates.length) return null;
    const base = candidates[candidates.length - 1].equity;
    return base ? ((currentEquity - base) / base) * 100 : null;
  }, [displayData, currentEquity]);

  const monthlyYield = useMemo(() => {
    if (!displayData.length || currentEquity === null) return null;
    const today = new Date();
    const monthAgo = new Date(today);
    monthAgo.setDate(today.getDate() - 30);
    const monthAgoStr = monthAgo.toISOString().slice(0, 10);
    const candidates = displayData.filter(d => d.date <= monthAgoStr);
    if (!candidates.length) return null;
    const base = candidates[candidates.length - 1].equity;
    return base ? ((currentEquity - base) / base) * 100 : null;
  }, [displayData, currentEquity]);

  const totalReturn = currentEquity !== null ? ((currentEquity - seedValue) / seedValue) * 100 : null;
  const totalPnL = currentEquity !== null ? currentEquity - seedValue : null;

  const yDomain = useMemo(() => {
    if (!displayData.length) return ["auto", "auto"] as [string, string];
    const values = displayData.map(d => d.equity);
    const min = Math.min(...values, seedValue);
    const max = Math.max(...values, seedValue);
    const pad = (max - min) * 0.08 || 5000;
    return [Math.floor((min - pad) / 1000) * 1000, Math.ceil((max + pad) / 1000) * 1000] as [number, number];
  }, [displayData, seedValue]);

  const isPositive = totalReturn !== null && totalReturn >= 0;
  const lastDate = displayData.length > 0 ? displayData[displayData.length - 1].date : null;
  const firstDate = displayData.length > 0 ? displayData[0].date : null;

  // ── Partial data detection ──────────────────────────────────────────────────────────────────────
  const isPartialData = useMemo(() => {
    const minDays = MIN_EXPECTED_DAYS[period];
    if (!minDays || !chartData.length) return false;
    return chartData.length < minDays;
  }, [chartData, period]);

  const fullDataBy = useMemo(() => {
    if (!isPartialData || !firstDate) return null;
    return fullDataByDate(period, firstDate);
  }, [isPartialData, period, firstDate]);

  // ── Render: H2 empty state (no DB snapshots yet) ─────────────────────────
  if (isH2 && h2ChartData.length === 0) {
    return (
      <Card className="border-0 shadow-sm">
        <CardContent className="flex flex-col items-center justify-center py-12 gap-3 text-center">
          <BarChart2 className="h-10 w-10 text-indigo-300" />
          <p className="font-semibold text-foreground">אין נתוני גרף עדיין</p>
          <p className="text-sm text-muted-foreground max-w-xs">
            הגרף יתמלא אוטומטית לאחר שמירת snapshot ראשון.<br />
            לחץ על "שמור snapshot" כדי להתחיל לעקוב.
          </p>
          {currentEquityValue && currentEquityValue > 0 && (
            <button
              onClick={handleUpdateNow}
              disabled={isUpdating}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-60 transition-colors mt-1"
            >
              {isUpdating ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              שמור snapshot ראשון ({formatUSD(currentEquityValue)})
            </button>
          )}
        </CardContent>
      </Card>
    );
  }

  // ── Render: no session (H1 only) ───────────────────────────────────────────
  if (!isH2 && noSession) {
    return (
      <Card className="border-0 shadow-sm">
        <CardContent className="flex flex-col items-center justify-center py-12 gap-3 text-center">
          <WifiOff className="h-10 w-10 text-amber-400" />
          <p className="font-semibold text-foreground">IBKR Session Not Active</p>
          <p className="text-sm text-muted-foreground max-w-xs">
            כדי לטעון נתוני NAV היסטוריים מ-IBKR, צריך session פעיל.
          </p>
          <button
            onClick={handleStartSession}
            disabled={isStartingSession}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-60 transition-colors mt-1"
          >
            {isStartingSession ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wifi className="h-4 w-4" />}
            {isStartingSession ? "מתחבר ל-IBKR..." : "Start IBKR Session"}
          </button>
        </CardContent>
      </Card>
    );
  }

  // ── Render: error (H1 only) ────────────────────────────────────────────────────────
  if (!isH2 && error && !chartData.length) {
    return (
      <Card className="border-0 shadow-sm">
        <CardContent className="flex flex-col items-center justify-center py-12 gap-3 text-center">
          <AlertCircle className="h-10 w-10 text-[#FF6B6B]" />
          <p className="font-semibold text-foreground">שגיאה בטעינת נתוני IBKR</p>
          <p className="text-sm text-muted-foreground font-mono">{error}</p>
          <button
            onClick={handleRefresh}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-100 text-slate-700 text-sm font-semibold hover:bg-slate-200 transition-colors mt-1"
          >
            <RefreshCw className="h-4 w-4" /> נסה שוב
          </button>
        </CardContent>
      </Card>
    );
  }
  // ── Render: loading (H1 only) ────────────────────────────────────────────────────────
  if (!isH2 && isLoading && !chartData.length) {
    return (
      <Card className="border-0 shadow-sm">
        <CardContent className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin mr-2 text-indigo-500" />
          <span className="text-muted-foreground text-sm">Loading IBKR performance data...</span>
        </CardContent>
      </Card>
    );
  }

  // ── Render: chart ────────────────────────────────────────────────────────
  return (
    <Card className="border-0 shadow-md bg-gradient-to-br from-background to-indigo-50/30">
      <CardHeader className="pb-2 pt-5 px-5">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          {/* Left: title + equity */}
          <div>
            <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2 flex-wrap">
              <BarChart2 className="h-4 w-4 text-indigo-500" />
              Portfolio Equity Curve
              {isH2 ? (
                <span className="text-[10px] font-normal text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5 flex items-center gap-1">
                  <BarChart2 className="h-2.5 w-2.5" /> DB Snapshots
                </span>
              ) : (
                <span className="text-[10px] font-normal text-indigo-600 bg-indigo-50 border border-indigo-200 rounded-full px-2 py-0.5 flex items-center gap-1">
                  <Wifi className="h-2.5 w-2.5" /> IBKR Live
                </span>
              )}
              {!isH2 && h2Offset > 0 && (
                <span className="text-[10px] font-normal text-[#2563EB] bg-blue-50 border border-blue-200 rounded-full px-2 py-0.5">
                  H1 + H2 (+{formatUSD(h2Offset)})
                </span>
              )}
            </CardTitle>
            <div className="mt-1 flex items-baseline gap-2 flex-wrap">
              <span className="text-2xl font-bold font-mono text-foreground">
                {currentEquity !== null ? formatUSD(currentEquity) : "—"}
              </span>
              {totalPnL !== null && (
                <span className={`text-sm font-semibold font-mono ${isPositive ? "text-[#65A30D]" : "text-[#FF6B6B]"}`}>
                  ({isPositive ? "+" : ""}{totalReturn?.toFixed(2)}%)
                  {" "}{isPositive ? "+" : ""}{formatUSD(totalPnL)}
                </span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {firstDate ? `Since ${formatDate(firstDate)}` : ""}
              {" · "}Seed: {formatUSD(seedValue)}
              {lastDate && (
                <span className="ml-2 text-muted-foreground/60">· Last: {formatDate(lastDate)}</span>
              )}
            </p>
            <p className="text-[10px] text-muted-foreground/70 mt-0.5">
              NAV ברוטו — כולל הפקדות/משיכות. לביצועי ניהול נקיים: TWR Clean Growth (מסך העברות)
            </p>
          </div>

          {/* Right: period selector + yield badges + refresh */}
          <div className="flex flex-col items-start sm:items-end gap-2">
            {/* Period selector */}
            <div className="flex items-center gap-1 bg-muted/40 rounded-lg p-0.5 border border-border">
              {PERIODS.map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`px-2 py-1 rounded-md text-[11px] font-semibold transition-colors ${
                    period === p
                      ? "bg-indigo-600 text-white shadow-sm"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  }`}
                >
                  {p}
                </button>
              ))}
              <button
                onClick={handleRefresh}
                disabled={isRefreshing || isLoading}
                className="ml-1 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40"
                title="Refresh from IBKR"
              >
                {isRefreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              </button>
            </div>

            {/* Yield badges */}
            <div className="flex items-center gap-2 flex-wrap">
              <YieldBadge label="7-Day" pct={weeklyYield} icon={<Calendar className="h-3 w-3" />} />
              <YieldBadge label="30-Day" pct={monthlyYield} icon={<Calendar className="h-3 w-3" />} />
              <YieldBadge
                label="Total"
                pct={totalReturn}
                icon={isPositive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              />
            </div>

            {/* Update DB snapshot button */}
            {currentEquityValue && currentEquityValue > 0 && (() => {
              const combinedForSnapshot = currentEquityValue + h2Offset;
              return (
                <button
                  onClick={handleUpdateNow}
                  disabled={isUpdating}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-60 bg-slate-100 text-slate-600 hover:bg-slate-200 border border-slate-200"
                  title={`שמור snapshot ב-DB: ${formatUSD(combinedForSnapshot)}${h2Offset > 0 ? ` (H1+H2)` : ''}`}
                >
                  {isUpdating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  שמור snapshot
                  <span className="font-mono opacity-80">({formatUSD(combinedForSnapshot)})</span>
                </button>
              );
            })()}
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-2 pb-4">
        {(isLoading || isRefreshing) && chartData.length > 0 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground px-4 mb-2">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading fresh data...
          </div>
        )}
        {isPartialData && firstDate && (
          <div className="mx-3 mb-3 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-blue-600" />
            <span>
              נתונים זמינים מ-<span className="font-semibold">{formatDateFull(firstDate)}</span> בלבד
              {" — "}החשבון נפתח לאחרונה. הגרף יתמלא אוטומטית עם הזמן.
              {fullDataBy && (
                <span className="text-blue-700 font-medium"> גרף {period} מלא צפוי ב-{fullDataBy}.</span>
              )}
            </span>
          </div>
        )}
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={displayData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={isPositive ? ACCENT : RED} stopOpacity={0.25} />
                <stop offset="95%" stopColor={isPositive ? ACCENT : RED} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={formatDate}
              tick={{ fontSize: 10, fill: "#6B7280" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              minTickGap={60}
            />
            <YAxis
              tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`}
              tick={{ fontSize: 10, fill: "#6B7280" }}
              tickLine={false}
              axisLine={false}
              domain={yDomain}
              width={52}
            />
            <Tooltip content={<CustomTooltip seedValue={seedValue} />} />
            {/* Seed reference line */}
            <ReferenceLine
              y={seedValue}
              stroke={ACCENT_LIGHT}
              strokeDasharray="4 4"
              strokeOpacity={0.6}
              label={{ value: `${formatUSD(seedValue)} start`, position: "insideTopLeft", fontSize: 10, fill: ACCENT_LIGHT }}
            />
            <Area
              type="monotone"
              dataKey="equity"
              stroke={isPositive ? ACCENT : RED}
              strokeWidth={2.5}
              fill="url(#equityGradient)"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: isPositive ? ACCENT : RED }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
