/**
 * War Room — CANDIDATES table (v4.5, LONG-only).
 *
 * Consumes the v4.5 candidates contract surfaced on `getStatus().upcomingSignals`:
 *   { ticker, route, tier, score:{base,subTotal,total},
 *     distanceToTriggerPct (signed), readinessPct (0-100),
 *     blockReason (string|null), abnormalCycle, macroBlocked }
 *
 * The payload is LONG-ONLY — no SHORT rows render here. Field access is defensive
 * (the table degrades gracefully if backhand lands the contract incrementally:
 *  `score` may still arrive as a bare number, `blockReason` may be `undefined`).
 *
 * Clarity-under-load priority (the eye lands here first, in order):
 *   ticker → מוכנות% (readiness bar) → מרחק-לטריגר (signed) → סיבת-חסימה (block badge)
 *
 * The WHOLE ROW is a ≥44px keyboard-accessible button → opens Deep Analysis v4.5.
 * Mobile-first 375px (card list), desktop table ≥md. RTL. WCAG: sign + icon + text,
 * never color-alone.
 */
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { AlertTriangle, BellOff, CheckCircle2, ChevronLeft, CornerDownLeft, Radar, Rocket, ShieldAlert, Star } from "lucide-react";

// Authoritative live watcher map + open-position tickers come from getStatus():
//   data.summary.watcherStatus  →  Record<ticker, "ARMED"|"CROSSED"|"HELD_5M"|"BLOCKED"|...>
//   data.positions              →  open/pending positions (ticker carries step 6 "נכנס")
// Both optional — the meter degrades to the per-row `watcherStatus` + live-price/status
// derivation when they're absent, so it always shows *something* pre-watcher-data.
export type WatcherStatusMap = Record<string, string | null | undefined> | undefined | null;

// ── v4.5 candidate contract (LONG-only) ───────────────────────────────────────
export type WarRoomCandidate = {
  ticker: string;
  route?: string | null;
  tier?: string | null;
  /** Short signal label from the contract: "Breakout" | "Retest" (optional). */
  signal?: string | null;
  /** v4.5 score object — may degrade to a bare number from the legacy contract. */
  score?: { base?: number; subTotal?: number; total?: number } | number | null;
  /** Signed % distance to trigger. Negative = below trigger, ≥0 = at/above. */
  distanceToTriggerPct?: number | null;
  /** 0-100 entry readiness. */
  readinessPct?: number | null;
  /** WHY this candidate isn't firing. null/undefined ⇒ entry-ready. */
  blockReason?: string | null;
  abnormalCycle?: boolean;
  macroBlocked?: boolean;
  /**
   * Intraday Armed-Watcher state (F7). Rides on the existing getStatus payload.
   * Optional / null ⇒ render NO chip. Matches backhand contract EXACTLY:
   *   "ARMED" | "CROSSED" | "HELD_5M" | "HOT_LIST" | null
   */
  watcherStatus?: "ARMED" | "CROSSED" | "HELD_5M" | "HOT_LIST" | null;
  /**
   * Planned $ to allocate to this candidate's entry (conviction-estimate from
   * `recommendedPositionSize`). null/undefined/0 ⇒ render "—".
   */
  sizeUsd?: number | null;
  // legacy display field still tolerated for the score fallback.
  total?: number | null;
};

export type WarRoomCandidatesTableProps = {
  candidates?: WarRoomCandidate[];
  /** Whole-row → Deep Analysis v4.5 modal. */
  onTickerClick?: (ticker: string) => void;
  /** Per-row "X" → snooze re-entry 12h + hide row. stopPropagation so it never opens Deep Analysis. */
  onSnooze?: (ticker: string) => void;
  /** Header right-side slot (refresh / run buttons / freshness pill). */
  headerExtra?: React.ReactNode;
  /**
   * Authoritative live watcher map from getStatus(): { [ticker]: "ARMED"|"CROSSED"|… }.
   * Optional — the readiness meter falls back to each row's own `watcherStatus`.
   */
  watcherStatusMap?: WatcherStatusMap;
  /**
   * Tickers with an OPEN/PENDING position (from getStatus().positions) → readiness 6/6 "נכנס".
   * Optional — accepts an array or a Set; absent ⇒ rung 6 relies on watcherStatus only.
   */
  openPositionTickers?: string[] | Set<string> | null;
  /**
   * Owner's "נבחרת" (Selected Team) — the priority tickers from getStatus().selectedTeam.
   * Optional — absent ⇒ no ⭐ chip renders (auto-lights-up once backhand lands the field).
   * Accepts an array of tickers (case-insensitive).
   */
  selectedTeam?: string[] | null;
  className?: string;
};

// ── helpers ───────────────────────────────────────────────────────────────────
const num = (v: any): number | null =>
  v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);

/** Total score from the v4.5 object, with legacy bare-number / `total` fallbacks. */
function scoreTotal(c: WarRoomCandidate): number | null {
  if (c.score && typeof c.score === "object") return num((c.score as any).total);
  if (typeof c.score === "number") return c.score;
  return num(c.total);
}
function scoreTone(s: number | null) {
  if (s === null) return "text-slate-400";
  return s >= 9 ? "text-amber-700" : s >= 7 ? "text-amber-600" : "text-slate-500";
}

/** Clean integer-dollar money: $20,000. Falsy/zero/NaN ⇒ "—" (defensive). */
function fmtUsd(v: any): string {
  const n = num(v);
  if (n === null || n === 0) return "—";
  return `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
}

/** Is this candidate entry-ready (no block of any kind)? */
function isReady(c: WarRoomCandidate): boolean {
  return !c.blockReason && !c.abnormalCycle && !c.macroBlocked;
}

// ── Signal type (Breakout vs Retest) — color + icon + text, never color-alone ──
// Prefer the explicit `signal` short-label; fall back to deriving from route/tier.
// Unknown/null ⇒ null ⇒ renders a muted "—".
type SignalKind = "BREAKOUT" | "RETEST";
function signalKind(c: WarRoomCandidate): SignalKind | null {
  const sig = String(c.signal ?? "").trim().toLowerCase();
  if (sig === "breakout") return "BREAKOUT";
  if (sig === "retest") return "RETEST";
  const route = String(c.route ?? "").toUpperCase();
  if (route === "GOLD_BREAKOUT_WAR") return "BREAKOUT";
  if (route === "GOLD_RETEST_WAR") return "RETEST";
  const tier = String(c.tier ?? "").toLowerCase();
  if (/breakout|פריצה/.test(tier)) return "BREAKOUT";
  if (/retest/.test(tier)) return "RETEST";
  return null;
}

const SIGNAL_META: Record<SignalKind, { label: string; className: string; icon: React.ReactNode; title: string }> = {
  BREAKOUT: {
    label: "פריצה",
    className: "border-blue-300 bg-blue-50 text-blue-800",
    icon: <Rocket className="w-3 h-3 shrink-0" aria-hidden />,
    title: "פריצה — Gold Breakout",
  },
  RETEST: {
    label: "Retest",
    className: "border-amber-300 bg-amber-50 text-amber-800",
    icon: <CornerDownLeft className="w-3 h-3 shrink-0" aria-hidden />,
    title: "Retest — Gold Retest",
  },
};

function SignalTypeBadge({ candidate, compact }: { candidate: WarRoomCandidate; compact?: boolean }) {
  const kind = signalKind(candidate);
  if (!kind) return <span className="text-slate-300 text-[11px]" title="סוג איתות לא ידוע">—</span>;
  const m = SIGNAL_META[kind];
  return (
    <Badge
      title={m.title}
      aria-label={m.title}
      className={cn(
        "px-1.5 py-0.5 min-h-[20px] text-[11px] font-bold tracking-wide gap-1 whitespace-nowrap",
        m.className,
      )}
    >
      {m.icon}
      {m.label}
    </Badge>
  );
}

// ── ⭐ נבחרת (Selected Team) chip — owner's priority ticker ─────────────────────
// Gold/amber, icon + text (never color-alone), ≥11px, wraps cleanly at 375px.
// Renders nothing unless the ticker is in the owner's selectedTeam set.
function SelectedTeamChip() {
  return (
    <Badge
      title="נבחרת — טיקר עדיפות של הבעלים"
      aria-label="נבחרת — טיקר עדיפות של הבעלים"
      className="px-1.5 py-0.5 min-h-[20px] text-[11px] font-bold tracking-wide gap-1 whitespace-nowrap bg-amber-100 text-amber-800 border border-amber-300 hover:bg-amber-100"
    >
      <Star className="w-3 h-3 shrink-0 fill-amber-500 text-amber-500" aria-hidden />
      נבחרת
    </Badge>
  );
}

// Map a raw blockReason / flag → a prominent, color+icon+text badge (WCAG AA).
type BadgeMeta = { label: string; className: string; icon: React.ReactNode; title?: string };
function blockBadge(c: WarRoomCandidate): BadgeMeta {
  // entry-ready: green "עובר ✓" — passes all gates, eligible for entry.
  if (isReady(c)) {
    return {
      label: "עובר ✓",
      title: "עובר את כל השערים — זכאי לכניסה (כניסה בפועל כפופה לבדיקות-סיכון בלולאת הכניסה)",
      className: "bg-green-700 text-white border-0 hover:bg-green-700",
      icon: <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />,
    };
  }
  const raw = String(c.blockReason ?? "").trim();
  const lc = raw.toLowerCase();

  // Macro / defense — the loudest wall (red).
  if (c.macroBlocked || /defense|vix|macro|circuit|breaker|guard/.test(lc)) {
    const label =
      /vix/.test(lc) ? raw.toUpperCase() :
      /defense/.test(lc) ? "DEFENSE" :
      c.macroBlocked ? "MACRO" : raw.toUpperCase() || "MACRO";
    return {
      label,
      title: raw || "חסם מאקרו / הגנה",
      className: "bg-red-600 text-white border-0 hover:bg-red-600",
      icon: <ShieldAlert className="w-3.5 h-3.5 shrink-0" />,
    };
  }

  // Abnormal cycle — amber warning.
  if (c.abnormalCycle || /abnormal|cycle|מחזור/.test(lc)) {
    return {
      label: "מחזור חריג",
      title: raw || "מחזור חריג",
      className: "border-amber-300 bg-amber-50 text-amber-800",
      icon: <AlertTriangle className="w-3.5 h-3.5 shrink-0" />,
    };
  }

  // Any other named block — amber, surface the raw reason verbatim.
  return {
    label: raw || "חסום",
    title: raw || "חסום",
    className: "border-amber-300 bg-amber-50 text-amber-800",
    icon: <ShieldAlert className="w-3.5 h-3.5 shrink-0" />,
  };
}

// ── 6-STEP READINESS LADDER (breakout pipeline) — the "N/6" meter ──────────────
// Replaces the old lagging/ambiguous Intraday-Watcher STATE chip (ARMED/CROSSED/
// אושר) AND the "עובר ✓" state badge — the owner found them ambiguous. The watcher
// status is now consumed as one rung of the ladder rather than a free-floating chip.
// Computes the highest rung reached.
// watcherStatus (per-row, or the authoritative summary map) drives rungs 3–5/6;
// status / live-price derivation is the pre-watcher fallback so it never shows blank.
type LadderRung = {
  step: number;               // 0..6 — highest rung reached
  blocked: boolean;           // anti-chase wall → render "✕ חסום" instead of N/6
  label: string;              // Hebrew name of the current rung
};
const RUNG_LABELS = ["—", "מועמד", "מאושר", "חמוש", "חצה", "אושר", "נכנס"];

/** Resolve the authoritative watcher status for a ticker: summary-map first, row fallback. */
function resolveWatcher(c: WarRoomCandidate, map?: WatcherStatusMap): string | null {
  const t = String(c?.ticker ?? "").toUpperCase();
  const fromMap = map?.[t] ?? map?.[String(c?.ticker ?? "")];
  return String(fromMap ?? c?.watcherStatus ?? "").toUpperCase() || null;
}

function readinessLadder(
  c: WarRoomCandidate,
  opts?: { watcherMap?: WatcherStatusMap; openTickers?: Set<string> },
): LadderRung {
  const ws = resolveWatcher(c, opts?.watcherMap);
  if (ws === "BLOCKED") return { step: 0, blocked: true, label: "חסום" };

  // live-price / donchian fallback (only when those fields ride on the row) ──────
  const live = num((c as any)?.live ?? (c as any)?.livePrice ?? (c as any)?.currentPrice);
  const don20H = num((c as any)?.donchian20High ?? (c as any)?.don20H);
  const trigger = don20H === null ? null : don20H * 1.005;
  const t = String(c?.ticker ?? "").toUpperCase();
  const hasPosition = !!opts?.openTickers?.has(t);

  // 6/6 נכנס — an open/pending position exists, or watcher says entered.
  if (hasPosition || ws === "ENTERED" || ws === "FILLED" || ws === "ENTERED_5M") {
    return { step: 6, blocked: false, label: RUNG_LABELS[6] };
  }
  // 5/6 אושר — HELD / confirmed 5m.
  if (ws === "HELD_5M") return { step: 5, blocked: false, label: RUNG_LABELS[5] };
  // 4/6 חצה — CROSSED (watcher) or live at/above trigger.
  if (ws === "CROSSED" || (live !== null && trigger !== null && live >= trigger)) {
    return { step: 4, blocked: false, label: RUNG_LABELS[4] };
  }
  // 3/6 חמוש — ARMED (watcher) or live within ~4% below the trigger.
  if (
    ws === "ARMED" ||
    (live !== null && trigger !== null && live >= trigger * 0.96 && live < trigger)
  ) {
    return { step: 3, blocked: false, label: RUNG_LABELS[3] };
  }
  // 2/6 מאושר — passed quality/regime gates.
  if (String(c?.status ?? "").trim().toLowerCase() === "approved") {
    return { step: 2, blocked: false, label: RUNG_LABELS[2] };
  }
  // 1/6 מועמד — the row exists.
  return { step: 1, blocked: false, label: RUNG_LABELS[1] };
}

// Pip + N/6 colors by rung: 1–2 slate, 3–4 amber, 5 orange, 6 green-bold.
function rungTone(step: number): { pip: string; text: string } {
  if (step >= 6) return { pip: "bg-green-600", text: "text-green-700" };
  if (step === 5) return { pip: "bg-orange-500", text: "text-orange-600" };
  if (step >= 3) return { pip: "bg-amber-500", text: "text-amber-600" };
  return { pip: "bg-slate-400", text: "text-slate-500" };
}

/** The "small diagram": 6 pips filled up to `step` + an N/6 label. color+number+pips. */
function ReadinessMeter({
  candidate,
  watcherMap,
  openTickers,
  compact,
}: {
  candidate: WarRoomCandidate;
  watcherMap?: WatcherStatusMap;
  openTickers?: Set<string>;
  compact?: boolean;
}) {
  const r = readinessLadder(candidate, { watcherMap, openTickers });

  if (r.blocked) {
    return (
      <span
        title="חסום — anti-chase (המחיר רץ מהר מדי מהטריגר)"
        aria-label="חסום — anti-chase"
        className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-red-50 px-1.5 py-0.5 min-h-[20px] text-[11px] font-bold text-red-700 whitespace-nowrap"
      >
        <span aria-hidden>✕</span>
        חסום
      </span>
    );
  }

  const tone = rungTone(r.step);
  const ready = r.step >= 6;
  const title = `${r.step}/6 · ${r.label}`;
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap"
      title={title}
      aria-label={`מוכנות ${r.step} מתוך 6 — ${r.label}`}
    >
      <span className="flex items-center gap-[2px]" aria-hidden>
        {Array.from({ length: 6 }).map((_, idx) => (
          <span
            key={idx}
            className={cn(
              "rounded-[1px] transition-colors",
              compact ? "w-[5px] h-[11px]" : "w-1.5 h-3.5",
              idx < r.step ? tone.pip : "bg-slate-200",
            )}
          />
        ))}
      </span>
      <span className={cn("font-mono font-bold tabular-nums text-[11px]", tone.text, ready && "text-[12px]")}>
        {r.step}/6
      </span>
      {ready ? (
        <span className="font-bold text-[11px] text-green-700">מוכן!</span>
      ) : (
        <span className={cn("text-[11px] font-medium", tone.text, compact && "hidden")}>{r.label}</span>
      )}
    </span>
  );
}

// ── readiness progress bar (0-100, bar color by level, number ALWAYS shown) ────
function ReadinessBar({ pct, compact }: { pct: number | null; compact?: boolean }) {
  const v = pct === null ? null : Math.max(0, Math.min(100, pct));
  const filled = v ?? 0;
  const tone =
    v === null ? "bg-slate-300" :
    v >= 80 ? "bg-green-600" :
    v >= 50 ? "bg-amber-500" :
    "bg-slate-400";
  return (
    <div className={cn("flex items-center gap-2", compact ? "w-full" : "min-w-[120px]")}>
      <div
        className="relative h-2 flex-1 rounded-full bg-slate-200 overflow-hidden"
        role="progressbar"
        aria-valuenow={v ?? 0}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="מוכנות לכניסה"
      >
        <div className={cn("h-full rounded-full transition-all", tone)} style={{ width: `${filled}%` }} />
      </div>
      <span className="text-[11px] font-mono font-bold tabular-nums text-slate-700 shrink-0 w-10 text-right">
        {v === null ? "—" : `${Math.round(v)}%`}
      </span>
    </div>
  );
}

// ── signed distance-to-trigger (sign+number primary, color secondary) ──────────
function DistanceToTrigger({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-slate-300 text-sm">—</span>;
  // negative → below trigger (red); zero/positive → at/above trigger (green).
  const below = pct < 0;
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  const txt = `${sign}${Math.abs(pct).toFixed(1)}%`;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 font-mono font-bold tabular-nums text-sm whitespace-nowrap",
        below ? "text-red-600" : "text-green-700",
      )}
      title={below ? "מתחת לטריגר" : "בטריגר / מעליו"}
    >
      {txt}
    </span>
  );
}

// ── daily % change (TODAY) — sign+number primary, color secondary (WCAG AA) ─────
// Reads the LIVE-PRICE daily-change off the candidate, tolerating whichever field
// backhand threads onto the upcomingSignals payload (same source the portfolio uses:
// the live-price feed's changePercent / DB dailyChangePercent). null ⇒ graceful "—".
function candidateDailyChangePct(c: WarRoomCandidate): number | null {
  const a = c as any;
  return num(
    a?.changePercent ??
      a?.dailyChangePercent ??
      a?.dayChangePct ??
      a?.dailyChangePct ??
      a?.changePct ??
      a?.pctChange ??
      a?.todayPct ??
      a?.dayChange,
  );
}

function DailyChange({ pct }: { pct: number | null }) {
  if (pct === null)
    return (
      <span className="text-slate-300 text-sm" title="שינוי יומי לא זמין">
        —
      </span>
    );
  const down = pct < 0;
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  const txt = `${sign}${Math.abs(pct).toFixed(2)}%`;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 font-mono font-bold tabular-nums text-sm whitespace-nowrap",
        down ? "text-red-600" : "text-green-700",
      )}
      title={down ? "ירידה מאז סגירת אתמול" : "עלייה מאז סגירת אתמול"}
    >
      {txt}
    </span>
  );
}

// ── 12h snooze "X" — ≥44px, stopPropagation so it never opens Deep Analysis ─────
function SnoozeIconButton({ ticker, onSnooze }: { ticker: string; onSnooze: (t: string) => void }) {
  return (
    <button
      type="button"
      aria-label="הקפא ל-12 שעות"
      title="הקפא ל-12 שעות — חוסם כניסה ומסתיר מהרשימה"
      onClick={(e) => { e.stopPropagation(); onSnooze(ticker); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); }}
      className="inline-flex items-center justify-center w-11 h-11 rounded-lg border border-slate-200 text-slate-400 hover:text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 transition-colors shrink-0"
    >
      <BellOff className="w-4 h-4" />
    </button>
  );
}

export function WarRoomCandidatesTable({
  candidates = [],
  onTickerClick,
  onSnooze,
  headerExtra,
  watcherStatusMap,
  openPositionTickers,
  selectedTeam,
  className,
}: WarRoomCandidatesTableProps) {
  // Owner's "נבחרת" priority set — uppercase, defensive. Falls back to a `selectedTeam`
  // field threaded onto the candidates payload, so the ⭐ chip auto-lights-up whether
  // backhand surfaces it as a top-level prop or rides it on the rows. Empty ⇒ no chip.
  const selectedTeamSet = new Set(
    (selectedTeam ?? (candidates as any)?.selectedTeam ?? [])
      .filter((t: any) => t != null)
      .map((t: any) => String(t).toUpperCase()),
  );
  const inSelectedTeam = (c: WarRoomCandidate): boolean =>
    selectedTeamSet.has(String(c?.ticker ?? "").toUpperCase()) ||
    (c as any)?.inSelectedTeam === true ||
    (c as any)?.selectedTeam === true;

  // Normalise open-position tickers → uppercase Set (accepts array | Set | null).
  const openTickers = new Set(
    (Array.isArray(openPositionTickers)
      ? openPositionTickers
      : openPositionTickers
        ? Array.from(openPositionTickers)
        : []
    ).map((t) => String(t ?? "").toUpperCase()),
  );
  // LONG-ONLY: hard filter — never render a short row even if one slips into the payload.
  const longs = candidates.filter(
    (c) => !("direction" in (c as any)) || (c as any).direction !== "short",
  );
  const ready = longs.filter((c) => isReady(c)).length;
  const walled = longs.length - ready;

  const open = (t: string) => onTickerClick?.(t);
  const rowKeyHandler = (t: string) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open(t);
    }
  };

  return (
    <div className={cn("rounded-xl border border-gray-200 overflow-hidden bg-white shadow-sm", className)} dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-gray-100 bg-[#F4F6F8]">
        <div className="flex items-center gap-2 min-w-0">
          <Radar className="w-4 h-4 text-indigo-500 shrink-0" />
          <span className="text-sm font-bold text-slate-800 truncate">מועמדים קרובים</span>
          <span className="text-[11px] font-mono text-slate-400 shrink-0">top {longs.length}</span>
          <span className="text-[11px] font-bold text-green-700 shrink-0 hidden sm:inline">{ready} מוכנים</span>
          <span className="text-slate-300 hidden sm:inline">·</span>
          <span className="text-[11px] font-bold text-amber-700 shrink-0 hidden sm:inline">{walled} חסומים</span>
        </div>
        {headerExtra ? <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">{headerExtra}</div> : null}
      </div>

      {longs.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">אין מועמדים — ממתין לסריקה הבאה</div>
      ) : (
        <>
          {/* ── DESKTOP (≥md) ── */}
          <div className="hidden md:block overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-[#F4F6F8] border-b border-gray-200 select-none hover:bg-[#F4F6F8]">
                  {[
                    { h: "#", w: "w-8" },
                    { h: "מניה", w: "" },
                    { h: "סוג", w: "w-[88px]" },
                    { h: "מוכנות (N/6)", w: "min-w-[150px]", accent: true },
                    { h: "מוכנות לכניסה (%)", w: "min-w-[160px]" },
                    { h: "מרחק לטריגר", w: "" },
                    { h: "שינוי יומי %", w: "min-w-[96px]" },
                    { h: "סיבת חסימה", w: "min-w-[120px]" },
                    { h: "ציון", w: "" },
                    { h: "סכום מתוכנן ($)", w: "" },
                  ].map(({ h, w, accent }) => (
                    <TableHead
                      key={h}
                      className={cn(
                        "py-2 text-xs font-bold uppercase tracking-wide whitespace-nowrap px-3 text-right",
                        accent ? "text-indigo-600" : "text-slate-500",
                        w,
                      )}
                    >
                      {h}
                    </TableHead>
                  ))}
                  {onSnooze ? <TableHead className="w-12 px-2" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {longs.map((c, i) => {
                  const bm = blockBadge(c);
                  const st = scoreTotal(c);
                  return (
                    <TableRow
                      key={c.ticker + i}
                      role="button"
                      tabIndex={0}
                      aria-label={`ניתוח עומק ${c.ticker}`}
                      onClick={() => open(c.ticker)}
                      onKeyDown={rowKeyHandler(c.ticker)}
                      className={cn(
                        "group cursor-pointer border-b border-gray-100 transition-colors",
                        "hover:bg-blue-50/40 focus:bg-blue-50/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-inset",
                        isReady(c) && "bg-emerald-50/30",
                      )}
                    >
                      <TableCell className="py-3 px-3 text-sm font-mono text-slate-400">{i + 1}</TableCell>
                      <TableCell className="py-3 px-3">
                        <span className="inline-flex items-center gap-1.5 flex-wrap font-mono font-bold text-base text-slate-900 group-hover:text-blue-700 group-hover:underline">
                          {c.ticker}
                          <ChevronLeft className="w-4 h-4 text-slate-300 group-hover:text-blue-500" />
                          {inSelectedTeam(c) ? <SelectedTeamChip /> : null}
                        </span>
                        {c.tier ? (
                          <span className="block text-[11px] text-slate-400 font-medium mt-0.5">{c.tier}</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="py-3 px-3">
                        <SignalTypeBadge candidate={c} />
                      </TableCell>
                      <TableCell className="py-3 px-3">
                        <ReadinessMeter
                          candidate={c}
                          watcherMap={watcherStatusMap}
                          openTickers={openTickers}
                        />
                      </TableCell>
                      <TableCell className="py-3 px-3">
                        <ReadinessBar pct={num(c.readinessPct)} />
                      </TableCell>
                      <TableCell className="py-3 px-3">
                        <DistanceToTrigger pct={num(c.distanceToTriggerPct)} />
                      </TableCell>
                      <TableCell className="py-3 px-3">
                        <DailyChange pct={candidateDailyChangePct(c)} />
                      </TableCell>
                      <TableCell className="py-3 px-3">
                        {isReady(c) ? (
                          <span className="text-slate-300 text-[11px]" title="אין חסם">—</span>
                        ) : (
                          <Badge
                            title={bm.title}
                            className={cn(
                              "px-2.5 py-1 min-h-[28px] text-xs font-bold tracking-wide gap-1.5 whitespace-nowrap",
                              bm.className,
                            )}
                          >
                            {bm.icon}
                            {bm.label}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="py-3 px-3">
                        <span className={cn("font-mono font-semibold text-base tabular-nums", scoreTone(st))}>
                          {st === null ? "—" : st.toFixed(2)}
                        </span>
                        <span className="text-sm text-slate-400 mr-0.5">/10</span>
                      </TableCell>
                      <TableCell className="py-3 px-3">
                        <span
                          className={cn(
                            "font-mono font-semibold text-sm tabular-nums whitespace-nowrap",
                            num(c.sizeUsd) ? "text-slate-700" : "text-slate-300",
                          )}
                          title="סכום מתוכנן להקצאה לכניסה זו"
                        >
                          {fmtUsd(c.sizeUsd)}
                        </span>
                      </TableCell>
                      {onSnooze ? (
                        <TableCell className="py-3 px-2 text-center">
                          <SnoozeIconButton ticker={c.ticker} onSnooze={onSnooze} />
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* ── MOBILE (<md) — 375px card list, whole card is the ≥44px tap target ── */}
          <div className="md:hidden divide-y divide-gray-100">
            {longs.map((c, i) => {
              const bm = blockBadge(c);
              const st = scoreTotal(c);
              return (
                <div
                  key={c.ticker + i}
                  role="button"
                  tabIndex={0}
                  aria-label={`ניתוח עומק ${c.ticker}`}
                  onClick={() => open(c.ticker)}
                  onKeyDown={rowKeyHandler(c.ticker)}
                  className={cn(
                    "min-h-[44px] px-4 py-3 cursor-pointer transition-colors active:bg-blue-50/60",
                    "hover:bg-blue-50/40 focus:bg-blue-50/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-inset",
                    isReady(c) ? "bg-emerald-50/30" : "bg-white",
                  )}
                >
                  {/* Row 1 — ticker (+tier) ............ score + block badge */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                      <span className="text-[11px] font-mono text-slate-400 shrink-0">{i + 1}</span>
                      <span className="font-mono font-bold text-base text-slate-900 shrink-0">{c.ticker}</span>
                      <ChevronLeft className="w-4 h-4 text-slate-300 shrink-0" />
                      {inSelectedTeam(c) ? <span className="shrink-0"><SelectedTeamChip /></span> : null}
                      <span className="shrink-0"><SignalTypeBadge candidate={c} compact /></span>
                      {c.tier ? <span className="text-[11px] text-slate-400 truncate">{c.tier}</span> : null}
                    </div>
                    <span className="shrink-0 font-mono font-semibold text-base tabular-nums">
                      <span className={scoreTone(st)}>{st === null ? "—" : st.toFixed(2)}</span>
                      <span className="text-xs text-slate-400">/10</span>
                    </span>
                  </div>

                  {/* Row 2 — readiness LADDER (N/6 meter — the prominent indicator) */}
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-[11px] text-slate-500 shrink-0 w-14">מוכנות</span>
                    <ReadinessMeter
                      candidate={c}
                      watcherMap={watcherStatusMap}
                      openTickers={openTickers}
                    />
                  </div>

                  {/* Row 3 — readiness % bar (full width) */}
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-[11px] text-slate-400 shrink-0 w-14">% מוכנות</span>
                    <ReadinessBar pct={num(c.readinessPct)} compact />
                  </div>

                  {/* Row 4 — distance-to-trigger (+ planned size) + block badge */}
                  <div className="flex items-center justify-between gap-2 mt-2">
                    <span className="inline-flex items-center gap-2 min-w-0 flex-wrap">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-[11px] text-slate-500">לטריגר</span>
                        <DistanceToTrigger pct={num(c.distanceToTriggerPct)} />
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-[11px] text-slate-500">יומי</span>
                        <DailyChange pct={candidateDailyChangePct(c)} />
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-[11px] text-slate-500">מתוכנן</span>
                        <span
                          className={cn(
                            "font-mono font-semibold text-[11px] tabular-nums whitespace-nowrap",
                            num(c.sizeUsd) ? "text-slate-700" : "text-slate-300",
                          )}
                        >
                          {fmtUsd(c.sizeUsd)}
                        </span>
                      </span>
                    </span>
                    <span className="inline-flex items-center gap-1 shrink-0 flex-wrap justify-end">
                      {isReady(c) ? null : (
                        <Badge
                          title={bm.title}
                          className={cn(
                            "px-2.5 py-1 min-h-[28px] text-[11px] font-bold tracking-wide gap-1.5 whitespace-nowrap",
                            bm.className,
                          )}
                        >
                          {bm.icon}
                          {bm.label}
                        </Badge>
                      )}
                      {onSnooze ? <SnoozeIconButton ticker={c.ticker} onSnooze={onSnooze} /> : null}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
