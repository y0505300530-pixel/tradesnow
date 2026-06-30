import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  Brain, CheckCircle2, XCircle, Clock, TrendingUp,
  BookOpen, Zap, Star, AlertTriangle, ChevronDown,
  ChevronUp, RefreshCw, BarChart2, Code2, Lightbulb,
  Swords, Activity, Target,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
type Insight = {
  id: number;
  date: string;
  type: "daily_summary"|"market_outlook"|"new_ticker"|"dual_signal"|"pattern_learned"|"code_change";
  status: "pending"|"approved"|"rejected"|"applied";
  title: string;
  body: string;
  ticker: string | null;
  mentor: string | null;
  priority: "critical"|"high"|"medium"|"low";
  codeChangePatch: string | null;
  approvedAt: string | null;
  createdAt: string;
};

type Pattern = {
  id: number;
  mentor: string;
  patternName: string;
  description: string;
  occurrences: number;
  successRate: number | null;
  avgReturn: number | null;
  tickers: string | null;
  lastSeenAt: string;
};

// ─── Config ───────────────────────────────────────────────────────────────────
const TYPE_META: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
  daily_summary:   { icon: <Brain className="w-4 h-4" />,       label: "סיכום יומי",     color: "bg-violet-50 border-violet-200 text-violet-700" },
  market_outlook:  { icon: <TrendingUp className="w-4 h-4" />,  label: "מצב שוק",        color: "bg-blue-50 border-blue-200 text-blue-700" },
  new_ticker:      { icon: <Zap className="w-4 h-4" />,         label: "טיקר חדש",       color: "bg-emerald-50 border-emerald-200 text-emerald-700" },
  dual_signal:     { icon: <Star className="w-4 h-4" />,        label: "Dual Signal ⭐",  color: "bg-amber-50 border-amber-200 text-amber-700" },
  pattern_learned: { icon: <Lightbulb className="w-4 h-4" />,   label: "דפוס חדש",       color: "bg-purple-50 border-purple-200 text-purple-700" },
  code_change:     { icon: <Code2 className="w-4 h-4" />,       label: "שינוי קוד",      color: "bg-red-50 border-red-200 text-red-700" },
};

const PRIORITY_COLOR: Record<string, string> = {
  critical: "bg-red-500",
  high:     "bg-orange-400",
  medium:   "bg-yellow-400",
  low:      "bg-gray-300",
};

const MENTOR_NAME: Record<string, string> = {
  cycles_trading: "Ziv",
  micha_stocks:   "Micha",
  both:           "Ziv + Micha",
};

// ─── Main Page ────────────────────────────────────────────────────────────────

// ── War Engine Status Banner ───────────────────────────────────────────────────
function WarEngineStatus() {
  const { data: status } = trpc.insights.getWarStatus.useQuery(undefined, { refetchInterval: 30_000 });
  const runWar = trpc.insights.runWarEngine.useMutation({
    onSuccess: (r) => {
      toast.success(`✅ מנוע מלחמה: נכנסנו ל-${r.entered} פוזיציות | סרקנו ${r.scanned} מניות`);
    },
    onError: (e) => toast.error(e.message),
  });

  const lastRan = status?.lastCycleAt
    ? new Date(status.lastCycleAt).toLocaleTimeString("he-IL")
    : "לא רץ עדיין";

  return (
    <div className="rounded-xl border border-red-200 bg-gradient-to-r from-red-50 to-orange-50 px-4 py-3 flex items-center gap-3 mb-4">
      <Swords className="w-5 h-5 text-red-600 shrink-0" />
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-red-800">War Engine v1.0</span>
          <span className={`w-2 h-2 rounded-full ${status?.running ? "bg-green-500 animate-pulse" : "bg-gray-400"}`} />
          <span className="text-xs text-red-700">{status?.running ? "רץ עכשיו..." : `ריצה אחרונה: ${lastRan}`}</span>
        </div>
        <p className="text-[11px] text-red-600 mt-0.5">
          LONG + SHORT אוטונומי · ניתוח 162 מניות · Regime Detection · Mentor Patterns · Multi-Timeframe
        </p>
      </div>
      <Button size="sm"
        onClick={() => runWar.mutate()}
        disabled={runWar.isPending || status?.running}
        className="h-7 text-xs gap-1 bg-red-600 hover:bg-red-700 text-white shrink-0">
        {runWar.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Swords className="w-3 h-3" />}
        {runWar.isPending ? "רץ..." : "הרץ עכשיו"}
      </Button>
    </div>
  );
}

export default function AIInsightsPage() {
  const [tab, setTab]             = useState<"pending"|"approved"|"patterns">("pending");
  const [expanded, setExpanded]   = useState<Set<number>>(new Set());
  const [patternMentor, setPatternMentor] = useState<"all"|"cycles_trading"|"micha_stocks">("all");

  const { data: stats, refetch: refetchStats } =
    trpc.insights.getSummaryStats.useQuery(undefined, { refetchInterval: 30_000 });

  const { data: insightsData, isLoading: insightsLoading, refetch: refetchInsights } =
    trpc.insights.list.useQuery(
      { status: tab === "patterns" ? "all" : tab, days: 30 },
      { enabled: tab !== "patterns" }
    );

  const { data: patternsData, isLoading: patternsLoading, refetch: refetchPatterns } =
    trpc.insights.listPatterns.useQuery(
      { mentor: patternMentor },
      { enabled: tab === "patterns" }
    );

  const approve = trpc.insights.approve.useMutation({
    onSuccess: () => { toast.success("אושר!"); refetchInsights(); refetchStats(); },
    onError:   (e) => toast.error(e.message),
  });

  const reject = trpc.insights.reject.useMutation({
    onSuccess: () => { toast.success("נדחה"); refetchInsights(); refetchStats(); },
    onError:   (e) => toast.error(e.message),
  });

  const insights: Insight[] = (insightsData?.insights ?? []) as unknown as Insight[];
  const patterns: Pattern[] = (patternsData?.patterns ?? []) as unknown as Pattern[];

  const toggleExpand = (id: number) =>
    setExpanded(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  return (
    <div className="min-h-screen bg-gray-50" dir="rtl">

      {/* ── Header ── */}
      <div className="bg-white border-b border-gray-200 px-6 py-5 sticky top-0 z-10 shadow-sm">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                <Brain className="w-5 h-5 text-violet-600" />
                AI Insights — מנוע למידה מזיו ומיכה
              </h1>
              <p className="text-xs text-gray-500 mt-0.5">
                הסוכן מנתח כל בוקר ב-7:00 · תובנות שדורשות אישורך מחכות כאן
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => { refetchInsights(); refetchPatterns(); refetchStats(); }}
              className="gap-1 text-xs">
              <RefreshCw className="w-3 h-3" /> רענן
            </Button>
          </div>

          {/* ── Stats bar ── */}
          <div className="grid grid-cols-4 gap-3 mb-4">
            {[
              { label: "ממתינים לאישור", value: stats?.pending ?? 0,  color: "text-orange-600", bg: "bg-orange-50" },
              { label: "אושרו השבוע",   value: stats?.approved ?? 0, color: "text-emerald-600", bg: "bg-emerald-50" },
              { label: "דפוסים נלמדו", value: stats?.patterns ?? 0, color: "text-violet-600", bg: "bg-violet-50" },
              { label: "ריצה אחרונה",  value: stats?.lastRun ? new Date(stats.lastRun).toLocaleDateString("he-IL") : "—", color: "text-gray-600", bg: "bg-gray-50" },
            ].map((s, i) => (
              <div key={i} className={`rounded-xl border border-gray-200 px-4 py-3 ${s.bg}`}>
                <div className={`text-lg font-bold ${s.color}`}>{s.value}</div>
                <div className="text-xs text-gray-500">{s.label}</div>
              </div>
            ))}
          </div>

          {/* ── War Engine Status ── */}
          <WarEngineStatus />

          {/* ── Tabs ── */}
          <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-fit">
            {([
              ["pending",  "ממתינים"],
              ["approved", "אושרו"],
              ["patterns", "דפוסים שנלמדו"],
            ] as const).map(([v, l]) => (
              <button key={v} onClick={() => setTab(v)}
                className={`text-sm px-4 py-1.5 rounded-lg font-medium transition-all ${
                  tab === v ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
                }`}>
                {l}
                {v === "pending" && (stats?.pending ?? 0) > 0 && (
                  <span className="mr-1.5 bg-orange-500 text-white text-[10px] rounded-full px-1.5 py-0.5">
                    {stats?.pending}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div className="max-w-5xl mx-auto px-6 py-5">

        {/* ─── Insights List ─── */}
        {tab !== "patterns" && (
          <>
            {insightsLoading ? (
              <div className="flex justify-center py-20 text-gray-400">
                <RefreshCw className="w-5 h-5 animate-spin" />
              </div>
            ) : insights.length === 0 ? (
              <div className="text-center py-24">
                <Brain className="w-10 h-10 mx-auto mb-3 text-gray-300" />
                <p className="text-sm text-gray-400">
                  {tab === "pending" ? "אין תובנות ממתינות — הסוכן יריץ ב-7:00 הבוקר הבא" : "אין תובנות שאושרו"}
                </p>
              </div>
            ) : (
              <div className="grid gap-3">
                {insights.map(insight => {
                  const meta    = TYPE_META[insight.type] ?? TYPE_META.daily_summary;
                  const isExp   = expanded.has(insight.id);
                  const isPending = insight.status === "pending";

                  return (
                    <div key={insight.id}
                      className={`bg-white rounded-xl border shadow-sm transition-all ${
                        insight.priority === "critical" ? "border-red-300" :
                        insight.priority === "high"     ? "border-orange-200" : "border-gray-200"
                      }`}>

                      <div className="flex items-start gap-3 px-4 py-3">
                        {/* Priority dot */}
                        <div className={`w-2 h-2 rounded-full mt-2 shrink-0 ${PRIORITY_COLOR[insight.priority]}`} />

                        {/* Type badge */}
                        <div className={`shrink-0 flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg border mt-0.5 ${meta.color}`}>
                          {meta.icon} {meta.label}
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-gray-900 text-sm">{insight.title}</span>
                            {insight.ticker && (
                              <span className="text-xs font-bold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
                                {insight.ticker}
                              </span>
                            )}
                            {insight.mentor && (
                              <span className="text-xs text-gray-500">
                                {MENTOR_NAME[insight.mentor] ?? insight.mentor}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {new Date(insight.createdAt).toLocaleString("he-IL")}
                          </p>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1.5 shrink-0">
                          {isPending && (
                            <>
                              <Button size="sm"
                                onClick={() => approve.mutate({ id: insight.id })}
                                disabled={approve.isPending}
                                className="h-7 text-xs gap-1 bg-emerald-600 hover:bg-emerald-700 text-white">
                                <CheckCircle2 className="w-3 h-3" /> אשר
                              </Button>
                              <Button size="sm" variant="outline"
                                onClick={() => reject.mutate({ id: insight.id })}
                                disabled={reject.isPending}
                                className="h-7 text-xs gap-1 text-red-500 border-red-200 hover:bg-red-50">
                                <XCircle className="w-3 h-3" /> דחה
                              </Button>
                            </>
                          )}
                          {!isPending && (
                            <span className={`text-xs font-medium flex items-center gap-1 ${
                              insight.status === "approved" || insight.status === "applied" ? "text-emerald-600" : "text-gray-400"
                            }`}>
                              {insight.status === "approved" || insight.status === "applied"
                                ? <><CheckCircle2 className="w-3 h-3" /> אושר</>
                                : <><XCircle className="w-3 h-3" /> נדחה</>}
                            </span>
                          )}
                          <button onClick={() => toggleExpand(insight.id)}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100">
                            {isExp ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>

                      {/* Expanded body */}
                      {isExp && (
                        <div className="border-t border-gray-100 px-5 py-4 bg-gray-50 rounded-b-xl">
                          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{insight.body}</p>
                          {insight.codeChangePatch && (
                            <div className="mt-3 bg-gray-900 rounded-lg p-3 overflow-x-auto">
                              <pre className="text-xs text-green-400 font-mono">{insight.codeChangePatch}</pre>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* ─── Patterns Library ─── */}
        {tab === "patterns" && (
          <>
            {/* Mentor filter */}
            <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-fit mb-4">
              {([["all","הכל"], ["cycles_trading","Ziv"], ["micha_stocks","Micha"]] as const).map(([v,l]) => (
                <button key={v} onClick={() => setPatternMentor(v)}
                  className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${
                    patternMentor === v ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"
                  }`}>
                  {l}
                </button>
              ))}
            </div>

            {patternsLoading ? (
              <div className="flex justify-center py-20 text-gray-400">
                <RefreshCw className="w-5 h-5 animate-spin" />
              </div>
            ) : patterns.length === 0 ? (
              <div className="text-center py-24">
                <Lightbulb className="w-10 h-10 mx-auto mb-3 text-gray-300" />
                <p className="text-sm text-gray-400">הסוכן ילמד דפוסים אחרי ניתוח מספר סרטונים</p>
              </div>
            ) : (
              <div className="grid gap-3">
                {patterns.map(p => {
                  const tickers: string[] = (() => { try { return JSON.parse(p.tickers ?? "[]"); } catch { return []; } })();
                  const isExp = expanded.has(p.id);
                  const mentorColor = p.mentor === "cycles_trading"
                    ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                    : p.mentor === "micha_stocks"
                    ? "bg-blue-50 border-blue-200 text-blue-700"
                    : "bg-amber-50 border-amber-200 text-amber-700";

                  return (
                    <div key={p.id} className="bg-white rounded-xl border border-gray-200 shadow-sm">
                      <div className="flex items-center gap-3 px-4 py-3">
                        <Lightbulb className="w-4 h-4 text-violet-500 shrink-0" />

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-gray-900 text-sm">{p.patternName}</span>
                            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-lg border ${mentorColor}`}>
                              {MENTOR_NAME[p.mentor] ?? p.mentor}
                            </span>
                            <span className="text-xs text-gray-400">{p.occurrences}× נצפה</span>
                            {p.successRate != null && (
                              <span className={`text-xs font-medium ${p.successRate >= 60 ? "text-emerald-600" : "text-orange-500"}`}>
                                הצלחה: {p.successRate.toFixed(0)}%
                              </span>
                            )}
                            {p.avgReturn != null && (
                              <span className={`text-xs font-medium ${p.avgReturn >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                                תשואה ממוצעת: {p.avgReturn > 0 ? "+" : ""}{p.avgReturn.toFixed(1)}%
                              </span>
                            )}
                          </div>
                          {tickers.length > 0 && (
                            <div className="flex gap-1 flex-wrap mt-1">
                              {tickers.slice(0, 6).map(t => (
                                <span key={t} className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded font-mono">{t}</span>
                              ))}
                              {tickers.length > 6 && <span className="text-[10px] text-gray-400">+{tickers.length - 6}</span>}
                            </div>
                          )}
                        </div>

                        <button onClick={() => toggleExpand(p.id)}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100">
                          {isExp ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                      </div>

                      {isExp && (
                        <div className="border-t border-gray-100 px-5 py-3 bg-gray-50 rounded-b-xl">
                          <p className="text-sm text-gray-700 leading-relaxed">{p.description}</p>
                          <p className="text-xs text-gray-400 mt-2">
                            נצפה לאחרונה: {new Date(p.lastSeenAt).toLocaleDateString("he-IL")}
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
