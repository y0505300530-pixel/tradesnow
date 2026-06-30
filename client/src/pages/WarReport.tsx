// client/src/pages/WarReport.tsx
// War Report — TODAY-FIRST, real-time closed-trade view over trpc.liveEngine.warReport.
// Today's realized P&L is the single focal point; "מה קרה היום" lists trades that
// closed today; all-time stats are demoted into a collapsed accordion with a
// tabbed (route/weekly/zone) breakdown so nothing is crammed 3-up on a phone.
// Mobile-first (≥375px), ≥44px touch targets, ≥11px text, WCAG-AA tones,
// color + icon/label (never color-only). Hebrew RTL. Read-only; no mutations.
import React, { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  Loader2, TrendingUp, TrendingDown, ArrowUpRight, ArrowDownRight,
  ChevronDown, Minus,
} from "lucide-react";

// ── Shapes mirror server/tradeLedger.ts (consumed, not re-declared on the wire) ──
interface LedgerStats {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  totalPnl: number;
  avgR: number;
  expectancyR: number;
  medianHoldDays: number | null;
}

// ── Formatters (null/NaN-safe; signed $ keeps the minus inside the symbol) ──
function fmt$(n?: number | null, dec = 0): string {
  if (n == null || isNaN(n) || !isFinite(n)) return "—";
  const abs = Math.abs(n);
  const s =
    abs >= 1e6 ? `${(abs / 1e6).toFixed(1)}M`
    : abs >= 1000 ? `${(abs / 1000).toFixed(1)}k`
    : abs.toFixed(dec);
  return `${n < 0 ? "-$" : "$"}${s}`;
}
// Signed $ that always shows the leading +/- (used for the day hero + cards).
function fmt$Signed(n?: number | null, dec = 0): string {
  if (n == null || isNaN(n) || !isFinite(n)) return "—";
  const abs = Math.abs(n);
  const s =
    abs >= 1e6 ? `${(abs / 1e6).toFixed(1)}M`
    : abs >= 1000 ? `${(abs / 1000).toFixed(1)}k`
    : abs.toFixed(dec);
  return `${n < 0 ? "−" : "+"}$${s}`;
}
function fmtPctRaw(n?: number | null, dec = 1): string {
  if (n == null || isNaN(n) || !isFinite(n)) return "—";
  return `${n.toFixed(dec)}%`;
}
function fmtR(n?: number | null, dec = 2): string {
  if (n == null || isNaN(n) || !isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(dec)}R`;
}
function fmtDays(n?: number | null, dec = 1): string {
  if (n == null || isNaN(n) || !isFinite(n)) return "—";
  return `${n.toFixed(dec)}`;
}
function fmtPrice(n?: number | null): string {
  if (n == null || isNaN(n) || !isFinite(n)) return "—";
  return n.toFixed(2);
}
// HH:MM (local) from an epoch-ms timestamp.
function fmtTime(ms?: number | null): string {
  if (ms == null || isNaN(ms) || !isFinite(ms)) return "—";
  const d = new Date(ms);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", hour12: false });
}

// ── Local-calendar "today" test (matches what the trader sees on the clock) ──
function isToday(ms?: number | null): boolean {
  if (ms == null || isNaN(ms) || !isFinite(ms)) return false;
  const d = new Date(ms);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

// WCAG-AA tones — readable green/red, never neon. Neutral slate for missing/flat.
const POS = "text-green-700";
const NEG = "text-red-600";
function pnlTone(n?: number | null): string {
  if (n == null || isNaN(n)) return "text-slate-500";
  if (n === 0) return "text-slate-500";
  return n > 0 ? POS : NEG;
}
function winRateTone(rate: number): string {
  if (rate >= 55) return "text-green-700";
  if (rate >= 45) return "text-amber-600";
  return "text-red-600";
}

// Direction-aware P&L trend icon — paired with sign+color (color-blind safe).
function PnlIcon({ n, className }: { n?: number | null; className?: string }) {
  if (n == null || isNaN(n) || n === 0) return <Minus className={className} aria-hidden />;
  return n > 0
    ? <TrendingUp className={className} aria-hidden />
    : <TrendingDown className={className} aria-hidden />;
}

// ── Header KPI tile (used in the demoted all-time section) ──
function Kpi({ label, value, sub, tone }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string;
}) {
  return (
    <div className="px-3 py-3 min-w-0 flex flex-col">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 truncate">{label}</div>
      <div className={cn("text-2xl font-bold font-mono tabular-nums leading-tight mt-0.5", tone ?? "text-slate-900")}>
        {value}
      </div>
      {sub != null && <div className="text-[11px] font-mono text-slate-500 mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

// ── Grouped stats table (route / weekly / zone), sorted by trades desc ──
function StatGroupTable({ label, data }: {
  label: string; data: Record<string, LedgerStats>;
}) {
  const entries = useMemo(
    () => Object.entries(data ?? {}).sort((a, b) => b[1].trades - a[1].trades),
    [data],
  );
  if (entries.length === 0) {
    return <div className="px-4 py-6 text-[13px] text-slate-500 text-center">אין נתונים</div>;
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-start text-[11px]">{label}</TableHead>
            <TableHead className="text-end text-[11px]">עסקאות</TableHead>
            <TableHead className="text-end text-[11px]">הצלחה</TableHead>
            <TableHead className="text-end text-[11px]">avg R</TableHead>
            <TableHead className="text-end text-[11px]">תשואה $</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map(([name, s]) => (
            <TableRow key={name}>
              <TableCell className="text-start font-medium text-[13px] max-w-[140px] truncate" title={name}>{name}</TableCell>
              <TableCell className="text-end font-mono tabular-nums text-[13px]">{s.trades}</TableCell>
              <TableCell className={cn("text-end font-mono tabular-nums text-[13px] font-semibold", winRateTone(s.winRatePct))}>
                {fmtPctRaw(s.winRatePct)}
              </TableCell>
              <TableCell className={cn("text-end font-mono tabular-nums text-[13px]", pnlTone(s.avgR))}>
                {fmtR(s.avgR)}
              </TableCell>
              <TableCell className={cn("text-end font-mono tabular-nums text-[13px] font-semibold", pnlTone(s.totalPnl))}>
                {fmt$(s.totalPnl)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Direction badge — icon + text (never color-only) ──
function DirBadge({ dir }: { dir: "long" | "short" }) {
  const isLong = dir === "long";
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 px-1.5 py-0.5 text-[11px] font-semibold",
        isLong ? "border-green-700/40 text-green-800" : "border-red-500/50 text-red-700",
      )}
    >
      {isLong ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
      {isLong ? "לונג" : "שורט"}
    </Badge>
  );
}

// Row shape we actually read off `data.rows` (subset of server LedgerRow).
type Row = {
  ticker: string;
  direction: "long" | "short";
  route: string;
  entryPrice: number;
  exitPrice: number | null;
  realizedPnl: number | null;
  realizedR: number | null;
  exitReason: string | null;
  holdDays: number | null;
  weeklyState: string | null;
  zoneStatus: string | null;
  openedAt: number;
  closedAt: number | null;
};

export default function WarReport() {
  const { data, isLoading, isError, error, refetch, isRefetching } =
    trpc.liveEngine.warReport.useQuery(undefined, {
      // Real-time: a sale shows within ~10s even with the tab in the background.
      refetchInterval: 10_000,
      refetchIntervalInBackground: true,
      staleTime: 0,
    });

  // ── Loading ──
  if (isLoading) {
    return (
      <div dir="rtl" className="flex flex-col items-center justify-center min-h-[60vh] gap-3 p-6 text-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
        <div className="text-sm text-slate-500">טוען דוח קרב…</div>
      </div>
    );
  }

  // ── Error (inline reason — no tooltip; touch has no hover) ──
  if (isError) {
    return (
      <div dir="rtl" className="flex flex-col items-center justify-center min-h-[60vh] gap-3 p-6 text-center">
        <div className="text-lg font-bold text-red-600">שגיאה בטעינת דוח הקרב</div>
        <div className="text-[13px] text-slate-500 font-mono max-w-md break-words">{error?.message ?? "שגיאה לא ידועה"}</div>
        <button
          onClick={() => refetch()}
          className="min-h-11 px-5 rounded-md bg-slate-700 text-white text-sm font-semibold active:bg-slate-800"
        >
          נסה שוב
        </button>
      </div>
    );
  }

  const overall = data?.overall;
  const rows = (data?.rows ?? []) as Row[];
  const droppedCount = data?.droppedCount ?? 0;
  const pnl = data?.pnl ?? { daily: 0, weekly: 0, sinceInception: 0 };
  const trades = overall?.trades ?? 0;

  // ── Today's closed trades (the primary list), newest first ──
  // Plain computation (not useMemo): the early loading/error returns above mean
  // hooks here would break the rules-of-hooks call-order invariant.
  // EVERY real position that closed today — straight from the server's `todayClosed`
  // (includes no-price closes where P&L is unknown; excludes only never-filled phantoms).
  // Falls back to the local filter over `rows` if the server hasn't shipped todayClosed yet.
  const todayRows = ((data?.todayClosed as Row[] | undefined)
    ?? rows.filter((r) => r.closedAt != null && isToday(r.closedAt)))
    .slice()
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const todayWins = todayRows.filter((r) => r.realizedPnl != null && r.realizedPnl > 0).length;
  const todayLosses = todayRows.filter((r) => r.realizedPnl != null && r.realizedPnl < 0).length;

  const median = overall?.medianHoldDays ?? null;
  // Yardstick: the engine's intended hold band is 1–10 trading days.
  const inBand = median != null && median >= 1 && median <= 10;

  return (
    <div dir="rtl" className="max-w-4xl mx-auto px-3 sm:px-4 py-4 space-y-5">
      {/* Title + freshness */}
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-slate-900">דוח קרב</h1>
        <button
          onClick={() => refetch()}
          disabled={isRefetching}
          className="min-h-11 min-w-11 px-3 rounded-md border border-slate-300 text-slate-600 text-[13px] font-semibold active:bg-slate-100 disabled:opacity-50 flex items-center justify-center gap-1.5"
          aria-label="רענן עכשיו"
        >
          {isRefetching ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          רענן
        </button>
      </div>

      {/* ═══════════ TODAY HERO — the single focal point ═══════════ */}
      <Card className="overflow-hidden border-slate-300 shadow-sm">
        <CardContent className="p-0">
          <div className="flex flex-col items-center justify-center px-4 py-7 text-center">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">
              רווח / הפסד היום
            </div>
            <div
              className={cn(
                "mt-2 flex items-center gap-2 font-mono font-bold tabular-nums tracking-tight",
                "text-5xl sm:text-6xl",
                pnlTone(pnl.daily),
              )}
            >
              <PnlIcon n={pnl.daily} className="w-9 h-9 sm:w-11 sm:h-11" />
              <span>{fmt$Signed(pnl.daily)}</span>
            </div>
            {/* Sub-line: today's closed-trade count + W/L */}
            <div className="mt-3 flex items-center gap-2 text-[13px] font-mono text-slate-600">
              <span className="font-semibold text-slate-800">{todayRows.length}</span>
              <span>עסקאות נסגרו היום</span>
              {todayRows.length > 0 && (
                <span className="text-slate-400">·</span>
              )}
              {todayRows.length > 0 && (
                <span>
                  <span className="font-semibold text-green-700">{todayWins}W</span>
                  {" / "}
                  <span className="font-semibold text-red-600">{todayLosses}L</span>
                </span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ═══════════ מה קרה היום — today's closed trades (PRIMARY) ═══════════ */}
      <Card className="overflow-hidden">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">מה קרה היום</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {todayRows.length === 0 ? (
            <div className="px-4 py-10 flex flex-col items-center gap-2 text-center">
              <div className="text-3xl" aria-hidden>🕊️</div>
              <div className="text-[14px] font-semibold text-slate-600">עדיין לא נסגרו עסקאות היום</div>
              <div className="text-[11px] text-slate-400 font-mono">העמוד מתעדכן אוטומטית כל ~10 שניות</div>
            </div>
          ) : (
            <>
              {/* MOBILE: stacked cards (≥44px), critical data first */}
              <div className="md:hidden divide-y divide-slate-100">
                {todayRows.map((r, i) => (
                  <div
                    key={`tm-${r.ticker}-${r.closedAt}-${i}`}
                    className={cn(
                      "px-4 py-3 min-h-[44px]",
                      r.realizedPnl == null || r.realizedPnl === 0 ? ""
                        : r.realizedPnl > 0 ? "bg-green-50/40" : "bg-red-50/40",
                    )}
                  >
                    {/* Row 1: ticker + dir + signed $ */}
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-[16px] text-slate-900">{r.ticker || "—"}</span>
                      <DirBadge dir={r.direction} />
                      {r.realizedPnl == null ? (
                        <span className="ms-auto inline-flex items-center rounded-md bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 text-[12px] font-semibold whitespace-nowrap">P&L לא ידוע</span>
                      ) : (
                        <span className={cn("ms-auto flex items-center gap-1 font-mono tabular-nums text-[16px] font-bold", pnlTone(r.realizedPnl))}>
                          <PnlIcon n={r.realizedPnl} className="w-4 h-4" />
                          {fmt$Signed(r.realizedPnl)}
                        </span>
                      )}
                    </div>
                    {/* Row 2: entry→exit · R · time · exitReason */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[11px] font-mono">
                      <span className="text-slate-500 tabular-nums">
                        {fmtPrice(r.entryPrice)} <span className="text-slate-400">←</span> {fmtPrice(r.exitPrice)}
                      </span>
                      <span className="text-slate-500">
                        R <span className={cn("font-semibold", pnlTone(r.realizedR))}>{r.realizedR == null ? "—" : fmtR(r.realizedR)}</span>
                      </span>
                      <span className="text-slate-500 tabular-nums">{fmtTime(r.closedAt)}</span>
                      <span className="ms-auto text-slate-500 max-w-[140px] truncate" title={r.exitReason ?? "—"}>
                        {r.exitReason ?? "—"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* DESKTOP: clean table */}
              <div className="hidden md:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-start text-[11px]">טיקר</TableHead>
                      <TableHead className="text-start text-[11px]">כיוון</TableHead>
                      <TableHead className="text-end text-[11px]">כניסה→יציאה</TableHead>
                      <TableHead className="text-end text-[11px]">תשואה $</TableHead>
                      <TableHead className="text-end text-[11px]">R</TableHead>
                      <TableHead className="text-start text-[11px]">סיבת יציאה</TableHead>
                      <TableHead className="text-end text-[11px]">שעה</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {todayRows.map((r, i) => (
                      <TableRow key={`td-${r.ticker}-${r.closedAt}-${i}`}>
                        <TableCell className="text-start font-mono font-bold text-[14px]">{r.ticker || "—"}</TableCell>
                        <TableCell className="text-start"><DirBadge dir={r.direction} /></TableCell>
                        <TableCell className="text-end font-mono tabular-nums text-[13px] text-slate-600">
                          {fmtPrice(r.entryPrice)} ← {fmtPrice(r.exitPrice)}
                        </TableCell>
                        <TableCell className={cn("text-end font-mono tabular-nums text-[14px] font-bold", pnlTone(r.realizedPnl))}>
                          {r.realizedPnl == null ? (
                            <span className="inline-flex items-center rounded-md bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap">לא ידוע</span>
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              <PnlIcon n={r.realizedPnl} className="w-3.5 h-3.5" />
                              {fmt$Signed(r.realizedPnl)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className={cn("text-end font-mono tabular-nums text-[13px]", pnlTone(r.realizedR))}>
                          {r.realizedR == null ? "—" : fmtR(r.realizedR)}
                        </TableCell>
                        <TableCell className="text-start text-[11px] text-slate-500 max-w-[160px] truncate" title={r.exitReason ?? "—"}>
                          {r.exitReason ?? "—"}
                        </TableCell>
                        <TableCell className="text-end font-mono tabular-nums text-[13px] text-slate-600">
                          {fmtTime(r.closedAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ═══════════ P&L strip: daily / weekly / since-inception ═══════════ */}
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="grid grid-cols-3 divide-x divide-slate-200">
            {([
              ["יומי", pnl.daily],
              ["שבועי", pnl.weekly],
              ["מאז ההתחלה", pnl.sinceInception],
            ] as const).map(([label, val]) => (
              <div key={label} className="px-2 py-3 flex flex-col items-center text-center min-w-0">
                <div className="text-[12px] font-semibold text-slate-500">{label}</div>
                <div className={cn("mt-1 flex items-center gap-1 text-[17px] font-bold font-mono tabular-nums", pnlTone(val))}>
                  <PnlIcon n={val} className="w-3.5 h-3.5" />
                  {fmt$Signed(val)}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ═══════════ All-time — DEMOTED, collapsed by default ═══════════ */}
      <details className="group rounded-lg border border-slate-200 bg-white overflow-hidden">
        <summary className="flex items-center justify-between gap-2 px-4 py-3 min-h-[44px] cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden active:bg-slate-50">
          <span className="text-[14px] font-semibold text-slate-700">סטטיסטיקה כוללת (כל הזמן)</span>
          <span className="flex items-center gap-2 text-[11px] font-mono text-slate-400">
            {trades > 0 && <span>{trades} עסקאות</span>}
            <ChevronDown className="w-4 h-4 transition-transform group-open:rotate-180" aria-hidden />
          </span>
        </summary>

        <div className="border-t border-slate-200 p-3 sm:p-4 space-y-4">
          {trades === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
              <div className="text-3xl" aria-hidden>⚔️</div>
              <div className="text-[14px] font-semibold text-slate-600">אין עדיין עסקאות סגורות למדידה</div>
            </div>
          ) : (
            <>
              {/* Win-rate hero (demoted to inside the accordion) */}
              <Card className="overflow-hidden">
                <CardContent className="p-0">
                  <div className="flex flex-col items-center justify-center py-4 border-b border-slate-200 bg-slate-50/60">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">אחוז הצלחה</div>
                    <div className={cn("text-4xl font-bold font-mono tabular-nums tracking-tight mt-1", winRateTone(overall!.winRatePct))}>
                      {fmtPctRaw(overall!.winRatePct)}
                    </div>
                    <div className="text-[11px] font-mono text-slate-500 mt-1">
                      {overall!.wins}W · {overall!.losses}L · {trades} עסקאות
                    </div>
                  </div>
                  <div className="grid grid-cols-2 divide-x divide-y divide-slate-200">
                    <Kpi
                      label="תוחלת (R)"
                      value={<span className={pnlTone(overall!.expectancyR)}>{fmtR(overall!.expectancyR)}</span>}
                      sub={`avg ${fmtR(overall!.avgR)}`}
                    />
                    <Kpi
                      label="תשואה כוללת"
                      value={
                        <span className={cn("inline-flex items-center gap-1", pnlTone(overall!.totalPnl))}>
                          <PnlIcon n={overall!.totalPnl} className="w-4 h-4" />
                          {fmt$(overall!.totalPnl)}
                        </span>
                      }
                      sub="מצטבר"
                    />
                    <Kpi
                      label="ימי-החזקה (חציון)"
                      value={<span className={inBand ? "text-slate-900" : "text-amber-600"}>{fmtDays(median)}</span>}
                      sub={inBand ? "בטווח 1–10 ימים ✓" : "מחוץ לטווח 1–10 ימים"}
                    />
                    <Kpi
                      label="עסקאות"
                      value={trades}
                      sub={droppedCount > 0 ? `${droppedCount} סוננו` : "כולן נמדדו"}
                    />
                  </div>
                </CardContent>
              </Card>

              {/* Tabbed breakdown — one table at a time (no 3-up cramming) */}
              <Card className="overflow-hidden">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">פילוח</CardTitle>
                </CardHeader>
                <CardContent className="px-0 pb-0">
                  <Tabs defaultValue="route" dir="rtl" className="w-full">
                    <div className="px-3 sm:px-4">
                      <TabsList className="w-full">
                        <TabsTrigger value="route" className="min-h-9">מסלול</TabsTrigger>
                        <TabsTrigger value="weekly" className="min-h-9">שבועי</TabsTrigger>
                        <TabsTrigger value="zone" className="min-h-9">אזור</TabsTrigger>
                      </TabsList>
                    </div>
                    <TabsContent value="route" className="mt-2">
                      <StatGroupTable label="מסלול" data={data!.byRoute} />
                    </TabsContent>
                    <TabsContent value="weekly" className="mt-2">
                      <StatGroupTable label="שבועי" data={data!.byWeekly} />
                    </TabsContent>
                    <TabsContent value="zone" className="mt-2">
                      <StatGroupTable label="אזור" data={data!.byZone} />
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>

              {/* Full recent-trades ledger (all-time reference) */}
              <Card className="overflow-hidden">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">עסקאות אחרונות</CardTitle>
                </CardHeader>
                <CardContent className="px-0 pb-0">
                  {/* MOBILE: card view */}
                  <div className="md:hidden divide-y divide-slate-100">
                    {rows.map((r, i) => (
                      <div
                        key={`m-${r.ticker}-${r.closedAt ?? r.openedAt}-${i}`}
                        className={cn(
                          "px-4 py-3",
                          r.realizedPnl == null || r.realizedPnl === 0 ? ""
                            : r.realizedPnl > 0 ? "bg-green-50/30" : "bg-red-50/30",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-[15px] text-slate-900">{r.ticker || "—"}</span>
                          <DirBadge dir={r.direction} />
                          <span className={cn("ms-auto flex items-center gap-1 font-mono tabular-nums text-[15px] font-bold", pnlTone(r.realizedPnl))}>
                            <PnlIcon n={r.realizedPnl} className="w-3.5 h-3.5" />
                            {fmt$Signed(r.realizedPnl)}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-1.5 text-[11px] font-mono">
                          <span className="text-slate-500">
                            R <span className={cn("font-semibold", pnlTone(r.realizedR))}>{r.realizedR == null ? "—" : fmtR(r.realizedR)}</span>
                          </span>
                          <span className="text-slate-500">
                            ימים <span className="font-semibold text-slate-700">{fmtDays(r.holdDays)}</span>
                          </span>
                          <span className="ms-auto text-slate-500 max-w-[150px] truncate" title={r.exitReason ?? "—"}>
                            {r.exitReason ?? "—"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* DESKTOP: full table */}
                  <div className="hidden md:block overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-start text-[11px]">טיקר</TableHead>
                          <TableHead className="text-start text-[11px]">כיוון</TableHead>
                          <TableHead className="text-start text-[11px]">מסלול</TableHead>
                          <TableHead className="text-start text-[11px]">שבועי</TableHead>
                          <TableHead className="text-start text-[11px]">אזור</TableHead>
                          <TableHead className="text-end text-[11px]">תשואה $</TableHead>
                          <TableHead className="text-end text-[11px]">R</TableHead>
                          <TableHead className="text-end text-[11px]">ימים</TableHead>
                          <TableHead className="text-start text-[11px]">סיבת יציאה</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((r, i) => (
                          <TableRow key={`${r.ticker}-${r.closedAt ?? r.openedAt}-${i}`}>
                            <TableCell className="text-start font-mono font-semibold text-[13px]">{r.ticker || "—"}</TableCell>
                            <TableCell className="text-start"><DirBadge dir={r.direction} /></TableCell>
                            <TableCell className="text-start text-[13px] max-w-[100px] truncate" title={r.route}>{r.route}</TableCell>
                            <TableCell className="text-start text-[13px] max-w-[100px] truncate" title={r.weeklyState ?? "—"}>{r.weeklyState ?? "—"}</TableCell>
                            <TableCell className="text-start text-[13px] max-w-[100px] truncate" title={r.zoneStatus ?? "—"}>{r.zoneStatus ?? "—"}</TableCell>
                            <TableCell className={cn("text-end font-mono tabular-nums text-[13px] font-semibold", pnlTone(r.realizedPnl))}>
                              {fmt$Signed(r.realizedPnl)}
                            </TableCell>
                            <TableCell className={cn("text-end font-mono tabular-nums text-[13px]", pnlTone(r.realizedR))}>
                              {r.realizedR == null ? "—" : fmtR(r.realizedR)}
                            </TableCell>
                            <TableCell className="text-end font-mono tabular-nums text-[13px] text-slate-600">
                              {fmtDays(r.holdDays)}
                            </TableCell>
                            <TableCell className="text-start text-[11px] text-slate-500 max-w-[120px] truncate" title={r.exitReason ?? "—"}>
                              {r.exitReason ?? "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>

              {/* Dropped note */}
              {droppedCount > 0 && (
                <div className="text-[11px] text-slate-400 font-mono text-center">
                  {droppedCount} רשומות סוננו מהמדידה (פאנטום ללא מילוי / סגירה ללא מחיר).
                </div>
              )}
            </>
          )}
        </div>
      </details>
    </div>
  );
}
