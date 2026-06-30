/**
 * War Room — Cycle Controls (ADDITIVE, client-only).
 *
 * Bundles the 5 new War Room features built against `trpc.liveEngine`:
 *   1. RefreshCandidatesButton  → refreshCandidates mutation
 *   2. RunWarRoomButton         → runManualCycle mutation (SCAN-ONLY, no live fire)
 *   3. CycleProgressStrip       → polls getCycleProgress (running/pct/phase)
 *   4. CycleSummaryPanel        → drawer(mobile)/side-panel(desktop) of Errors/Successes/Actions
 *   5. DeepAnalysisV45Modal     → deepAnalysisV45 query — engine verdict (score/tier/gates/macro)
 *
 * Backend procedures are consumed via a typed-escape (`anyLiveEngine`) so this
 * client compiles standalone while backhand merges the server side in parallel.
 * No invented endpoints — exactly the contract names. Adapts to small field drift.
 *
 * Mobile-first 375px · ≥44px touch · WCAG (icon+TEXT, never color-alone) · RTL Hebrew.
 * Every overlay has an ALWAYS-VISIBLE sticky ✕ (≥44px) at the top-end on 375px + desktop.
 */
import React, { useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Loader2, RefreshCw, Radar, X, AlertTriangle, CheckCircle2, Zap,
  ShieldAlert, ShieldCheck, Gauge, TrendingUp, TrendingDown, Activity, Ban,
  Microscope,
} from "lucide-react";

/** Typed-escape: bind to backhand's procedures at runtime; compile standalone now. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyLE = () => (trpc as any).liveEngine;

// ── Shared contract shapes (mirror the spec; tolerant of small drift) ────────────
export type CycleProgress = { running: boolean; pct: number; phase: string };
export type GateFired = { ticker?: string; gate: string; reason?: string; passed?: boolean };
export type CycleSummary = {
  errors?: string[];
  successes?: string[];
  actions?: string[];
  finishedAt?: string | null;
};
export type DeepV45 = {
  ticker: string;
  score?: { base?: number; subTotal?: number; total?: number };
  tier?: string | null;
  route?: string | null;
  passedGate?: boolean;
  gatesFired?: { gate: string; passed: boolean; reason?: string }[];
  macro?: { spy?: number; spyEma50?: number; regime?: string; vix?: number; vixBand?: string };
  rejectionReasons?: string[];
};

// ════════════════════════════════════════════════════════════════════════════════
// 1. REFRESH CANDIDATES BUTTON
// ════════════════════════════════════════════════════════════════════════════════
export function RefreshCandidatesButton({ onRefreshed }: { onRefreshed?: () => void }) {
  const mut = anyLE().refreshCandidates.useMutation({
    // contract: { ok, count, scannedAt } — tolerate { scanned } drift too
    onSuccess: (r: any) => {
      const n = r?.count ?? r?.scanned ?? 0;
      toast.success(`מועמדים עודכנו — נסרקו ${n} מניות`);
      onRefreshed?.();
    },
    onError: (e: any) => toast.error(`רענון נכשל: ${e?.message ?? "שגיאה"}`),
  });
  return (
    <Button
      size="sm"
      variant="outline"
      dir="rtl"
      className="min-h-[44px] h-11 px-3 text-xs font-bold gap-1.5 border-indigo-200 text-indigo-600 hover:bg-indigo-50 whitespace-nowrap"
      onClick={() => mut.mutate()}
      disabled={mut.isPending}
      title="רענון מועמדים — סריקה מחדש (STATUS/SIGNAL/SCORE), ללא פתיחת פוזיציות"
    >
      {mut.isPending
        ? <><Loader2 className="w-4 h-4 animate-spin" /> מרענן…</>
        : <><RefreshCw className="w-4 h-4" /> 🔄 רענן מועמדים</>}
    </Button>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// 2. RUN WAR ROOM BUTTON  (scan-only — visually distinct from live-fire)
// ════════════════════════════════════════════════════════════════════════════════
export function RunWarRoomButton({
  running,
  onStarted,
  onFinished,
}: {
  running: boolean;
  onStarted?: () => void;
  onFinished?: (summary?: any) => void;
}) {
  const mut = anyLE().runManualCycle.useMutation({
    onMutate: () => onStarted?.(),
    onSuccess: (r: any) => {
      const s = r?.summary ?? {};
      const found = s?.candidatesFound ?? 0;
      const would = Array.isArray(s?.wouldEnter) ? s.wouldEnter.length : 0;
      toast.success(`סריקה הושלמה — ${found} מועמדים · ${would} כניסות פוטנציאליות (ללא פקודות חיות)`);
      onFinished?.(r);
    },
    onError: (e: any) => {
      toast.error(`סריקה נכשלה: ${e?.message ?? "שגיאה"}`);
      onFinished?.();
    },
  });
  const busy = running || mut.isPending;
  return (
    <Button
      dir="rtl"
      // SCAN action — slate/indigo with Radar, deliberately NOT the green/red live-fire palette
      className={cn(
        "min-h-[48px] h-12 px-5 text-sm font-bold rounded-full gap-2 whitespace-nowrap",
        "bg-indigo-600 hover:bg-indigo-700 text-white border-2 border-indigo-700",
        busy && "opacity-90",
      )}
      onClick={() => mut.mutate()}
      disabled={busy}
      title="הרצת סריקת חדר מלחמה — סריקה בלבד, ללא פתיחת פוזיציות חיות"
    >
      {busy
        ? <><Loader2 className="w-4 h-4 animate-spin" /> סורק…</>
        : <><Radar className="w-4 h-4" /> RUN WAR ROOM (סריקה)</>}
    </Button>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// 3. LIVE CYCLE PROGRESS STRIP  (manual OR auto — driven by getCycleProgress poll)
// ════════════════════════════════════════════════════════════════════════════════
/** Returns the live progress + a `running` flag the parent can use to gate the strip. */
export function useCycleProgress(active: boolean): CycleProgress {
  const q = anyLE().getCycleProgress.useQuery(undefined, {
    refetchInterval: active ? 1000 : 5000,
    refetchIntervalInBackground: false,
    // tolerate the procedure not yet existing on the server (pre-merge): keep last good
    retry: false,
  });
  const d = q.data as CycleProgress | undefined;
  return {
    running: !!d?.running,
    pct: typeof d?.pct === "number" ? Math.max(0, Math.min(100, d.pct)) : 0,
    phase: d?.phase ?? "",
  };
}

export function CycleProgressStrip({ progress }: { progress: CycleProgress }) {
  if (!progress.running) return null;
  const pct = progress.pct;
  return (
    <div
      dir="rtl"
      role="status"
      aria-live="polite"
      className="sticky top-0 z-20 px-3 sm:px-6 py-2.5 bg-indigo-50 border-b border-indigo-200"
    >
      <div className="max-w-[1600px] mx-auto flex items-center gap-3">
        <Radar className="w-4 h-4 text-indigo-600 animate-pulse shrink-0" />
        <span className="text-xs sm:text-sm font-bold text-indigo-800 whitespace-nowrap shrink-0">
          סייקל רץ
        </span>
        <span className="text-xs font-mono text-indigo-700 truncate min-w-0 flex-1">
          {progress.phase || "מעבד…"}
        </span>
        <div className="hidden xs:flex sm:flex flex-1 min-w-[60px] max-w-[320px] h-2 rounded-full bg-indigo-200 overflow-hidden">
          <div
            className="h-full rounded-full bg-indigo-600 transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-sm font-mono font-black tabular-nums text-indigo-800 shrink-0 w-12 text-end">
          {pct.toFixed(0)}%
        </span>
      </div>
      {/* Mobile-only full-width bar (the inline bar is hidden < sm) */}
      <div className="sm:hidden mt-2 h-2 rounded-full bg-indigo-200 overflow-hidden">
        <div className="h-full rounded-full bg-indigo-600 transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// 4. CYCLE SUMMARY PANEL  (drawer on mobile / side panel on desktop)
//    🔴 Always-visible sticky ✕ (≥44px) in BOTH layouts.
// ════════════════════════════════════════════════════════════════════════════════
function SummarySection({
  title, icon: Icon, tone, items, emptyLabel,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: { text: string; bg: string; border: string; chip: string };
  items: string[];
  emptyLabel: string;
}) {
  return (
    <section className="rounded-xl border bg-white overflow-hidden" style={{ borderColor: "var(--border)" }}>
      <header className={cn("flex items-center gap-2 px-3 py-2 border-b", tone.bg, tone.border)}>
        <Icon className={cn("w-4 h-4 shrink-0", tone.text)} />
        <span className={cn("text-sm font-bold", tone.text)}>{title}</span>
        <span className={cn("ms-auto text-xs font-mono font-bold rounded-full px-2 py-0.5", tone.chip)}>
          {items.length}
        </span>
      </header>
      <div className="divide-y divide-gray-100">
        {items.length === 0
          ? <div className="px-3 py-3 text-xs text-slate-400">{emptyLabel}</div>
          : items.map((it, i) => (
            <div key={i} className="flex items-start gap-2 px-3 py-2.5">
              <Icon className={cn("w-3.5 h-3.5 mt-0.5 shrink-0", tone.text)} />
              <span className="text-xs font-mono text-slate-700 break-words min-w-0">{it}</span>
            </div>
          ))}
      </div>
    </section>
  );
}

export function CycleSummaryPanel({
  open,
  onClose,
  summary,
}: {
  open: boolean;
  onClose: () => void;
  summary: CycleSummary | null;
}) {
  // Esc to close (desktop keyboard)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const errors = summary?.errors ?? [];
  const successes = summary?.successes ?? [];
  const actions = summary?.actions ?? [];

  return (
    <div className="fixed inset-0 z-[60] flex" dir="rtl">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} aria-hidden="true" />
      {/* Panel: full-height drawer pinned to the inline-end (RTL → left edge) */}
      <aside
        role="dialog"
        aria-label="סיכום סייקל"
        className={cn(
          "relative ms-auto h-full bg-[#F4F6F8] shadow-2xl flex flex-col",
          "w-full sm:max-w-md", // mobile: full-width drawer; desktop: side panel
        )}
      >
        {/* Sticky header with ALWAYS-VISIBLE ≥44px close */}
        <header className="sticky top-0 z-10 flex items-center gap-2 px-3 py-2.5 bg-white border-b border-gray-200 shrink-0">
          <Gauge className="w-4 h-4 text-slate-700 shrink-0" />
          <span className="text-sm font-bold text-slate-800">סיכום סייקל מנוע</span>
          {summary?.finishedAt && (
            <span className="text-[11px] font-mono text-slate-400 truncate">
              {new Date(summary.finishedAt).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="סגור"
            className="ms-auto min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          <SummarySection
            title="שגיאות"
            icon={AlertTriangle}
            tone={{ text: "text-red-700", bg: "bg-red-50", border: "border-red-200", chip: "bg-red-100 text-red-700" }}
            items={errors}
            emptyLabel="אין שגיאות ✓"
          />
          <SummarySection
            title="הצלחות"
            icon={CheckCircle2}
            tone={{ text: "text-green-700", bg: "bg-green-50", border: "border-green-200", chip: "bg-green-100 text-green-700" }}
            items={successes}
            emptyLabel="אין הצלחות מתועדות"
          />
          <SummarySection
            title="פעולות"
            icon={Zap}
            tone={{ text: "text-indigo-700", bg: "bg-indigo-50", border: "border-indigo-200", chip: "bg-indigo-100 text-indigo-700" }}
            items={actions}
            emptyLabel="לא בוצעו פעולות"
          />
        </div>

        {/* Sticky footer close — second always-reachable dismiss on long lists */}
        <footer className="sticky bottom-0 z-10 p-3 bg-white border-t border-gray-200 shrink-0">
          <Button onClick={onClose} className="w-full min-h-[44px] h-11 rounded-full bg-slate-800 hover:bg-slate-900 text-white font-bold gap-1.5">
            <X className="w-4 h-4" /> סגור
          </Button>
        </footer>
      </aside>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// 5. DEEP ANALYSIS v4.5 MODAL  (engine verdict — score/tier/route/gates/macro)
//    🔴 Always-visible sticky ✕ (≥44px) at the top-end. v4.5-only fields.
// ════════════════════════════════════════════════════════════════════════════════
function num(v: any, dec = 2): string {
  return v == null || isNaN(Number(v)) ? "—" : Number(v).toFixed(dec);
}

export function DeepAnalysisV45Modal({
  ticker,
  open,
  onClose,
}: {
  ticker: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Navigate to the existing standalone Deep Analysis page for the SAME ticker.
  // Route + nav convention mirror TickerLink.tsx: /deep-analysis/:ticker (wouter).
  const openDeepAnalysis = () => {
    if (!ticker) return;
    onClose();
    navigate(`/deep-analysis/${encodeURIComponent(ticker)}`);
  };

  const q = anyLE().deepAnalysisV45.useQuery(
    { ticker: ticker ?? "" },
    { enabled: open && !!ticker, retry: false, staleTime: 30_000 },
  );
  const d = q.data as DeepV45 | undefined;
  const loading = q.isLoading || q.isFetching;
  const errMsg = (q.error as any)?.message as string | undefined;

  const passed = d?.passedGate === true;
  const gates = useMemo(() => d?.gatesFired ?? [], [d]);

  if (!open || !ticker) return null;

  return (
    <div className="fixed inset-0 z-[60] flex" dir="rtl">
      <div className="absolute inset-0 bg-white/60 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full md:mx-auto md:max-w-[680px] md:my-6 h-full md:h-auto md:max-h-[90vh] flex flex-col bg-[#F4F6F8] md:rounded-2xl shadow-2xl overflow-hidden">
        {/* Sticky header — ALWAYS-VISIBLE ≥44px close */}
        <header className="sticky top-0 z-10 flex items-center gap-2 px-3 sm:px-5 py-2.5 bg-white border-b border-gray-200 shrink-0">
          <Zap className="w-4 h-4 text-indigo-600 shrink-0" />
          <span className="text-sm sm:text-base font-bold text-slate-800">ניתוח מנוע v4.5</span>
          <span className="font-mono font-black text-sm text-slate-900">{ticker}</span>
          {/* Verdict pill — icon + TEXT (never color-alone) */}
          {!loading && !errMsg && d && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold",
                passed ? "border-green-300 bg-green-50 text-green-700" : "border-red-300 bg-red-50 text-red-700",
              )}
            >
              {passed ? <ShieldCheck className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />}
              {passed ? "עבר שער" : "נדחה"}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="סגור"
            className="ms-auto min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-3 sm:p-5 space-y-4">
          {loading && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Loader2 className="w-7 h-7 animate-spin text-indigo-500" />
              <span className="text-sm text-slate-500">טוען ניתוח מנוע עבור {ticker}…</span>
            </div>
          )}

          {!loading && errMsg && (
            <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
              <AlertTriangle className="w-7 h-7 text-amber-500" />
              <span className="text-sm font-semibold text-slate-700">לא ניתן לטעון ניתוח v4.5</span>
              <span className="text-xs font-mono text-slate-400 max-w-sm break-words">{errMsg}</span>
            </div>
          )}

          {!loading && !errMsg && d && (
            <>
              {/* Score — base / sub / total (exact engine numbers) */}
              <section className="rounded-xl border border-gray-200 bg-white p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Activity className="w-4 h-4 text-indigo-600" />
                  <span className="text-sm font-bold text-slate-800">ניקוד מנוע</span>
                  {d.tier && <span className="ms-auto text-xs font-bold rounded-full bg-indigo-100 text-indigo-700 px-2 py-0.5">TIER {d.tier}</span>}
                  {d.route && <span className="text-xs font-bold rounded-full bg-slate-100 text-slate-600 px-2 py-0.5">{d.route}</span>}
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  {[
                    { l: "BASE", v: num(d.score?.base), tone: "text-slate-700" },
                    { l: "SUB-TOTAL", v: num(d.score?.subTotal), tone: "text-slate-700" },
                    { l: "TOTAL", v: num(d.score?.total), tone: "text-indigo-700" },
                  ].map((c) => (
                    <div key={c.l} className="bg-slate-50 rounded-lg py-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{c.l}</div>
                      <div className={cn("text-xl font-black font-mono tabular-nums", c.tone)}>{c.v}</div>
                    </div>
                  ))}
                </div>
              </section>

              {/* Gates — DEFENSE / VIX / score / EMA200 / wideLung — pass/fail + reason */}
              <section className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 bg-[#F4F6F8]">
                  <ShieldAlert className="w-4 h-4 text-slate-600" />
                  <span className="text-sm font-bold text-slate-800">שערים (Gates)</span>
                  <span className="ms-auto text-xs font-mono text-slate-400">{gates.length}</span>
                </div>
                <div className="divide-y divide-gray-100">
                  {gates.length === 0
                    ? <div className="px-3 py-3 text-xs text-slate-400">אין נתוני שערים</div>
                    : gates.map((g, i) => (
                      <div key={i} className="flex items-start gap-2 px-3 py-2.5">
                        {g.passed
                          ? <CheckCircle2 className="w-4 h-4 mt-0.5 text-green-600 shrink-0" />
                          : <Ban className="w-4 h-4 mt-0.5 text-red-600 shrink-0" />}
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold font-mono text-slate-800">{g.gate}</span>
                            <span className={cn("text-[10px] font-bold uppercase", g.passed ? "text-green-700" : "text-red-700")}>
                              {g.passed ? "PASS" : "FAIL"}
                            </span>
                          </div>
                          {g.reason && <div className="text-[11px] font-mono text-slate-500 break-words">{g.reason}</div>}
                        </div>
                      </div>
                    ))}
                </div>
              </section>

              {/* Macro walls — SPY vs EMA-50 · VIX band · regime */}
              {d.macro && (
                <section className="rounded-xl border border-gray-200 bg-white p-3">
                  <div className="flex items-center gap-2 mb-2">
                    {(d.macro.spy != null && d.macro.spyEma50 != null && d.macro.spy >= d.macro.spyEma50)
                      ? <TrendingUp className="w-4 h-4 text-green-600" />
                      : <TrendingDown className="w-4 h-4 text-red-600" />}
                    <span className="text-sm font-bold text-slate-800">קירות מאקרו</span>
                    {d.macro.regime && (
                      <span className="ms-auto text-xs font-bold rounded-full bg-slate-100 text-slate-600 px-2 py-0.5 uppercase">
                        {d.macro.regime}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-slate-50 rounded-lg p-2.5">
                      <div className="text-[10px] font-semibold uppercase text-slate-500">SPY vs EMA-50</div>
                      <div className="font-mono font-bold text-sm text-slate-800 tabular-nums">
                        {num(d.macro.spy)} / {num(d.macro.spyEma50)}
                      </div>
                      <div className={cn("text-[11px] font-bold",
                        (d.macro.spy != null && d.macro.spyEma50 != null && d.macro.spy >= d.macro.spyEma50)
                          ? "text-green-700" : "text-red-700")}>
                        {(d.macro.spy != null && d.macro.spyEma50 != null && d.macro.spy >= d.macro.spyEma50)
                          ? "↑ מעל EMA-50" : "↓ מתחת EMA-50"}
                      </div>
                    </div>
                    <div className="bg-slate-50 rounded-lg p-2.5">
                      <div className="text-[10px] font-semibold uppercase text-slate-500">VIX</div>
                      <div className="font-mono font-bold text-sm text-slate-800 tabular-nums">{num(d.macro.vix, 1)}</div>
                      {d.macro.vixBand && (
                        <div className="text-[11px] font-bold text-slate-600 uppercase">{d.macro.vixBand}</div>
                      )}
                    </div>
                  </div>
                </section>
              )}

              {/* Rejection reasons */}
              {(d.rejectionReasons?.length ?? 0) > 0 && (
                <section className="rounded-xl border border-red-200 bg-red-50 p-3">
                  <div className="flex items-center gap-2 mb-1.5">
                    <Ban className="w-4 h-4 text-red-600" />
                    <span className="text-sm font-bold text-red-700">סיבות דחייה</span>
                  </div>
                  <ul className="space-y-1.5">
                    {d.rejectionReasons!.map((r, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs font-mono text-red-700">
                        <span className="mt-1 w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
                        <span className="break-words min-w-0">{r}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>

        {/* Sticky footer — primary DEEP ANALYSIS (distinct indigo) + reachable close.
            Stacked full-width on 375px; ≥44px touch targets; icon+TEXT (never color-alone). */}
        <footer className="sticky bottom-0 z-10 p-3 bg-white border-t border-gray-200 shrink-0 flex flex-col sm:flex-row-reverse gap-2">
          <Button
            onClick={openDeepAnalysis}
            disabled={!ticker}
            title={`ניתוח מעמיק עבור ${ticker ?? ""} — דף ניתוח מלא`}
            className="w-full sm:flex-1 min-h-[48px] h-12 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold gap-1.5 border-2 border-indigo-700"
          >
            <Microscope className="w-4 h-4" /> ניתוח מעמיק (DEEP ANALYSIS)
          </Button>
          <Button onClick={onClose} className="w-full sm:flex-1 min-h-[44px] h-11 rounded-full bg-slate-800 hover:bg-slate-900 text-white font-bold gap-1.5">
            <X className="w-4 h-4" /> סגור
          </Button>
        </footer>
      </div>
    </div>
  );
}
