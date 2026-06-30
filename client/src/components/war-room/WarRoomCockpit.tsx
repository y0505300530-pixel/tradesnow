import React, { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { toastMutationError } from "@/lib/mutationErrors";
import { Gauge, Zap, Moon, ShieldAlert, Loader2, Wallet, AlertTriangle, TrendingUp, TrendingDown } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// War Room — "Cyborg Mode" leverage cockpit. ONE source of truth for both dials.
// Safety-critical readouts pinned to the TOP of the War Room:
//   1) LIVE GROSS (big, color-coded, against 4.0× ceiling)
//   2) Intraday Power Dial  (0–4×  → liveEngine.updateConfig intradayMultiplier)
//   3) Overnight Dial       (0–2×  → liveEngine.updateConfig overnightMultiplier)
//   4) TRIM TO {overnight}× (OVERNIGHT) — 2-tap armed destructive button
//
// SURGICAL / ADDITIVE: self-contained component. Does not touch existing WarRoomLive
// code paths. All new contract fields are optional-chained so the page never crashes
// if the backend hasn't shipped them yet.
// ─────────────────────────────────────────────────────────────────────────────

const GROSS_CEILING = 4.0;
const OVERNIGHT_CEILING = 2.0;
const DEFAULT_OVERNIGHT = 1.9;

// Zone thresholds shared by GROSS + DIALS: green ≤1.9× · amber 1.9–3.0× · red >3.0×.
function levZone(x: number): "green" | "amber" | "red" {
  if (x > 3.0) return "red";
  if (x > 1.9) return "amber";
  return "green";
}
const ZONE_TEXT = {
  green: "text-green-700",
  amber: "text-amber-600",
  red: "text-red-600",
} as const;
const ZONE_BAR = {
  green: "bg-green-600",
  amber: "bg-amber-500",
  red: "bg-red-600",
} as const;
const ZONE_LABEL = {
  green: "SAFE",
  amber: "ELEVATED",
  red: "CEILING RISK",
} as const;

function fmtX(n?: number | null): string {
  if (n == null || isNaN(n) || !isFinite(n)) return "—";
  return `${n.toFixed(1)}x`;
}

// $ formatter for wallet readouts — compact, no decimals, thousands grouped.
function fmtUsd(n?: number | null): string {
  if (n == null || isNaN(Number(n)) || !isFinite(Number(n))) return "—";
  return `$${Math.round(Number(n)).toLocaleString("en-US")}`;
}

// Read live-liquidity money state. ALL fields optional-chained — render "—" pre-ship.
//   nlv            ← summary.liveGross.nlv  → summary.liveNlv
//   buyingPower    ← summary.buyingPower    (NEW field backhand is adding)
//   availableFunds ← summary.availableFunds (optional)
function readWallet(data: any) {
  const s = data?.summary ?? {};
  const num = (...vals: any[]) => {
    for (const v of vals) {
      const n = Number(v);
      if (v != null && !isNaN(n) && isFinite(n)) return n;
    }
    return null;
  };
  return {
    nlv: num(s?.liveGross?.nlv, s?.liveNlv),
    buyingPower: num(s?.buyingPower),
    availableFunds: num(s?.availableFunds),
  };
}

// Read Daily P&L — SAME source the metrics ribbon reads (summary.dailyPnlUsd /
// summary.dailyPnlPct). Both optional-chained so the cell renders "—" pre-data.
function readDailyPnl(data: any) {
  const s = data?.summary ?? {};
  const num = (...vals: any[]) => {
    for (const v of vals) {
      const n = Number(v);
      if (v != null && !isNaN(n) && isFinite(n)) return n;
    }
    return null;
  };
  return {
    usd: num(s?.dailyPnlUsd, s?.pnl?.daily, s?.dailyPnl),
    pct: num(s?.dailyPnlPct, s?.dailyPct),
  };
}

// Read holdings $$ summary — total gross deployed (long + |short|) and per-holding
// average. Prefers summary.totalHolding (IBKR SSOT, same as the ribbon footer); falls
// back to long+short USD, then to summing |position value|. Count from positions[].
function readHoldingsSummary(data: any) {
  const s = data?.summary ?? {};
  const lev = s?.leverage ?? {};
  const lg = s?.liveGross ?? {};
  const num = (...vals: any[]) => {
    for (const v of vals) {
      const n = Number(v);
      if (v != null && !isNaN(n) && isFinite(n)) return n;
    }
    return null;
  };
  const positions: any[] = Array.isArray(data?.positions) ? data.positions : [];
  const longUsd = num(lev.longUsd, lg.longUsd);
  const shortUsd = num(lev.shortUsd, lg.shortUsd);
  const fromLongShort =
    longUsd != null || shortUsd != null
      ? (longUsd ?? 0) + Math.abs(shortUsd ?? 0)
      : null;
  const fromPositions = positions.length
    ? positions.reduce((acc, p) => {
        const v = Number(p?.value);
        return acc + (v != null && !isNaN(v) && isFinite(v) ? Math.abs(v) : 0);
      }, 0)
    : null;
  const total = num(s?.totalHolding, s?.liveGross?.grossUsd, fromLongShort, fromPositions);
  const count = num(s?.openCount, positions.length || null);
  const avg = total != null && count != null && count > 0 ? total / count : null;
  return { total, count, avg };
}

// Read gross/long/short/net/nlv. Preferred source is the backend's purpose-built
// summary.liveGross block; falls back to the older summary.leverage shape, then to a
// flat top-level shape — all optional-chained so nothing crashes pre-ship.
function readLeverage(data: any) {
  const lg = data?.summary?.liveGross ?? {};
  const lev = data?.summary?.leverage ?? {};
  const flat = data ?? {};
  const num = (...vals: any[]) => {
    for (const v of vals) {
      const n = Number(v);
      if (v != null && !isNaN(n) && isFinite(n)) return n;
    }
    return null;
  };
  return {
    grossX: num(lg.grossX, lev.gross, flat.grossX),
    longX: num(lg.longX, lev.longX, flat.longX),
    shortX: num(lg.shortX, lev.shortX, flat.shortX),
    netX: num(lg.netX, lev.net, flat.netX),
    nlv: num(lg.nlv, data?.summary?.liveNlv, flat.nlv),
  };
}

// ── 1) LIVE GROSS ────────────────────────────────────────────────────────────
function LiveGrossPanel({ data, isLoading }: { data: any; isLoading: boolean }) {
  const { grossX, longX, shortX } = readLeverage(data);
  const zone = grossX != null ? levZone(grossX) : "green";
  const pct = grossX != null ? Math.min(100, (grossX / GROSS_CEILING) * 100) : 0;
  return (
    <div className="flex flex-col rounded-xl border-2 border-slate-200 bg-white px-4 py-3">
      <div className="flex items-center gap-1.5">
        <Gauge className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
          Live Gross
        </span>
        {grossX != null && (
          <span
            className={cn(
              "ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
              zone === "red"
                ? "bg-red-100 text-red-700"
                : zone === "amber"
                  ? "bg-amber-100 text-amber-700"
                  : "bg-green-100 text-green-700",
            )}
          >
            {ZONE_LABEL[zone]}
          </span>
        )}
      </div>

      <div className="mt-1 flex items-baseline gap-2">
        <span
          className={cn(
            "font-mono text-5xl font-black leading-none tabular-nums",
            ZONE_TEXT[zone],
          )}
        >
          {isLoading && grossX == null ? (
            <span className="inline-block h-10 w-24 animate-pulse rounded bg-slate-200" />
          ) : (
            fmtX(grossX)
          )}
        </span>
        <span className="font-mono text-base font-semibold text-slate-400">
          / {GROSS_CEILING.toFixed(1)}x
        </span>
      </div>

      {/* thin ceiling bar — current gross vs 4.0× hard cap */}
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className={cn("h-full rounded-full transition-all duration-300", ZONE_BAR[zone])}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-1.5 flex items-center justify-between font-mono text-[11px] text-slate-500">
        <span>
          L <b className="text-green-700">{fmtX(longX)}</b>
        </span>
        <span>
          S <b className="text-red-600">{fmtX(shortX)}</b>
        </span>
        <span className="text-slate-400">ceiling {GROSS_CEILING.toFixed(1)}x</span>
      </div>
    </div>
  );
}

// ── 2/3) Reusable Power Dial — one source of truth for both intraday & overnight ──
// `ceiling` only changes the zone-bar denominator + the max-tick label; the green/
// amber/red zone discipline is identical (levZone) across both dials.
function PowerDial({
  icon,
  title,
  configValue,
  defaultValue,
  ceiling,
  ticks,
  commitKey,
  caption,
  isLoading,
}: {
  icon: React.ReactNode;
  title: string;
  configValue: number | null | undefined;
  defaultValue: number;
  ceiling: number;
  ticks: number[];
  commitKey: "intradayMultiplier" | "overnightMultiplier";
  caption: React.ReactNode;
  isLoading: boolean;
}) {
  const [val, setVal] = useState<number>(configValue ?? defaultValue);
  const initialized = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommitted = useRef<number | null>(null);

  // Initialize once from config, then let the user drive.
  useEffect(() => {
    if (initialized.current) return;
    if (configValue == null) return;
    initialized.current = true;
    setVal(configValue);
    lastCommitted.current = configValue;
  }, [configValue]);

  const updCfg = trpc.liveEngine.updateConfig.useMutation({
    onError: (e: any) => toastMutationError(e, "עדכון מינוף נכשל"),
  });

  const commit = useCallback(
    (next: number) => {
      const clamped = Math.min(ceiling, Math.max(0, next));
      if (lastCommitted.current != null && Math.abs(lastCommitted.current - clamped) < 0.001) return;
      lastCommitted.current = clamped;
      // Backend accepts intraday [0,4.0] / overnight [0,2.0] (optional-chained mutate).
      (updCfg as any)?.mutate?.({ [commitKey]: clamped });
    },
    [updCfg, ceiling, commitKey],
  );

  const onSlide = (next: number) => {
    setVal(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => commit(next), 350);
  };

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const zone = levZone(val);
  const isPaused = val < 0.05;
  return (
    <div className="flex flex-col rounded-xl border-2 border-slate-200 bg-white px-4 py-3">
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-slate-500" aria-hidden="true">{icon}</span>
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
          {title}
        </span>
        {updCfg.isPending && (
          <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin text-slate-400" aria-hidden="true" />
        )}
        <span
          className={cn(
            "ml-auto font-mono text-3xl font-black leading-none tabular-nums",
            isPaused ? "text-slate-400" : ZONE_TEXT[zone],
          )}
        >
          {isLoading && configValue == null ? (
            <span className="inline-block h-7 w-16 animate-pulse rounded bg-slate-200" />
          ) : (
            `${val.toFixed(1)}x`
          )}
        </span>
      </div>

      <input
        type="range"
        min={0}
        max={ceiling}
        step={0.1}
        value={val}
        aria-label={`${title} multiplier`}
        onChange={(e) => onSlide(parseFloat(e.target.value))}
        onMouseUp={() => commit(val)}
        onTouchEnd={() => commit(val)}
        onBlur={() => commit(val)}
        className={cn(
          "mt-3 h-3 w-full cursor-pointer appearance-none rounded-full bg-gradient-to-r from-slate-400 via-amber-400 to-red-500",
          "accent-slate-900 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:w-6",
          "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full",
          "[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-slate-900 [&::-webkit-slider-thumb]:bg-white",
          "[&::-webkit-slider-thumb]:shadow-md",
          "[&::-moz-range-thumb]:h-6 [&::-moz-range-thumb]:w-6 [&::-moz-range-thumb]:rounded-full",
          "[&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-slate-900 [&::-moz-range-thumb]:bg-white",
        )}
      />
      <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-400">
        {ticks.map((t, i) => (
          <span key={i}>{t.toFixed(1)}x</span>
        ))}
      </div>

      <p className="mt-1.5 text-[11px] leading-snug text-slate-500">{caption}</p>
    </div>
  );
}

// ── 4) TRIM TO {overnight}× (OVERNIGHT) — 2-tap armed destructive button ──────
function TrimToOvernightButton({ data, overnight }: { data: any; overnight: number }) {
  const [armed, setArmed] = useState(false);
  const disarmRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { grossX } = readLeverage(data);
  const alreadySafe = grossX != null && grossX <= overnight;
  const targetLabel = fmtX(overnight);

  // Mutation may not be shipped yet — optional chaining so the page never crashes
  // before the backend ships `liveEngine.manualTrimToOvernight`.
  const trimMut = (trpc as any)?.liveEngine?.manualTrimToOvernight?.useMutation?.({
    onSuccess: (res: any) => {
      const trimmed = res?.trimmed ?? 0;
      const from = res?.fromGrossX != null ? fmtX(res.fromGrossX) : "—";
      const to = res?.toGrossX != null ? fmtX(res.toGrossX) : targetLabel;
      toast.success(`${trimmed} positions trimmed: ${from}→${to}`);
    },
    onError: (e: any) => toastMutationError(e, "TRIM נכשל"),
  });
  const isPending = !!trimMut?.isPending;

  const disarm = useCallback(() => {
    setArmed(false);
    if (disarmRef.current) clearTimeout(disarmRef.current);
  }, []);

  useEffect(() => () => {
    if (disarmRef.current) clearTimeout(disarmRef.current);
  }, []);

  const handleClick = () => {
    if (isPending) return;
    if (!armed) {
      // First tap → ARM. Auto-disarm after 3s so a stray tap can never flatten the book.
      setArmed(true);
      if (disarmRef.current) clearTimeout(disarmRef.current);
      disarmRef.current = setTimeout(() => setArmed(false), 3000);
      return;
    }
    // Second tap within the window → FIRE (places REAL sell orders).
    disarm();
    if (trimMut?.mutate) {
      trimMut.mutate();
    } else {
      toast.error("TRIM אינו זמין עדיין (backend)");
    }
  };

  // SUBTLE ghost button — auto-width, red-600 text on a thin red-300 outline.
  // Safety UNCHANGED: 2-tap arm→confirm, 3s auto-disarm, isPending guard. ≥44px tall.
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending}
      aria-label={`Trim to ${targetLabel} overnight — press twice to confirm`}
      title={
        armed
          ? `Confirm within 3s — flattens weakest-first to ${targetLabel}. Places REAL sell orders.`
          : alreadySafe
            ? `Already ≤${targetLabel} — overnight-safe.`
            : `Flattens weakest-first to ${targetLabel} overnight cap. Two-tap guarded.`
      }
      className={cn(
        "inline-flex min-h-[44px] max-w-fit items-center justify-center gap-1.5 rounded-lg border px-3 py-2",
        "text-[11px] font-semibold transition-colors focus:outline-none focus-visible:ring-2",
        isPending
          ? "cursor-wait border-red-300 bg-red-50 text-red-600"
          : armed
            ? "border-red-400 bg-red-50 text-red-700 focus-visible:ring-red-300"
            : "border-red-300 bg-transparent text-red-600 hover:bg-red-50 focus-visible:ring-red-300",
      )}
    >
      {isPending ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          <span>Trimming…</span>
        </>
      ) : armed ? (
        <>
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Tap again to confirm — to {targetLabel}</span>
        </>
      ) : (
        <>
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Trim to {targetLabel} (overnight)</span>
        </>
      )}
    </button>
  );
}

// ── Daily P&L — cockpit top-LEFT cell. Big color-coded $ + % beneath. ────────
// Same source as the metrics ribbon (summary.dailyPnlUsd / dailyPnlPct). Color is
// reinforced with a trend icon + sign so meaning is never color-alone (WCAG).
function DailyPnlPanel({ data, isLoading }: { data: any; isLoading: boolean }) {
  const { usd, pct } = readDailyPnl(data);
  const up = (usd ?? 0) >= 0;
  const tone = usd == null ? "text-slate-300" : up ? "text-green-700" : "text-red-600";
  const TrendIcon = up ? TrendingUp : TrendingDown;
  return (
    <div
      dir="rtl"
      className="flex flex-col rounded-xl border-2 border-slate-200 bg-white px-4 py-3"
    >
      <div className="flex items-center gap-1.5">
        <TrendIcon className={cn("h-4 w-4 shrink-0", usd == null ? "text-slate-400" : tone)} aria-hidden="true" />
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
          P&amp;L יומי
        </span>
      </div>

      <div className="mt-1 flex flex-col">
        <span className={cn("font-mono text-4xl font-black leading-none tabular-nums", tone)}>
          {isLoading && usd == null ? (
            <span className="inline-block h-9 w-28 animate-pulse rounded bg-slate-200" />
          ) : (
            <>
              {usd != null && up ? "+" : ""}
              {fmtUsd(usd)}
            </>
          )}
        </span>
        <span className={cn("mt-1 font-mono text-sm font-semibold tabular-nums", tone)}>
          {pct == null ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}
        </span>
      </div>
    </div>
  );
}

// ── Live Wallet readout — money state that "hits the eye" ────────────────────
// NLV (שווי תיק) + cash (מזומן זמין) + buying power (כוח קנייה זמין, moved in from
// the old middle cell). Big mono $. Secondary lines optional-chained → hidden pre-data.
function LiveWalletPanel({ data, isLoading }: { data: any; isLoading: boolean }) {
  const { nlv, buyingPower, availableFunds } = readWallet(data);
  const skel = (w: string) => (
    <span className={cn("inline-block h-7 animate-pulse rounded bg-slate-200", w)} />
  );
  return (
    <div
      dir="rtl"
      className="flex flex-col rounded-xl border-2 border-slate-200 bg-white px-4 py-3"
    >
      <div className="flex items-center gap-1.5">
        <Wallet className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
          Live Wallet
        </span>
      </div>

      <div className="mt-2 flex flex-col">
        <span className="text-[11px] font-semibold text-slate-500">שווי תיק</span>
        <span className="font-mono text-2xl font-black leading-tight tabular-nums text-slate-800">
          {isLoading && nlv == null ? skel("w-20") : fmtUsd(nlv)}
        </span>
      </div>

      {availableFunds != null && (
        <div className="mt-1.5 flex items-center justify-between border-t border-slate-100 pt-1.5 font-mono text-[11px] text-slate-500">
          <span>מזומן זמין</span>
          <b className="text-slate-700">{fmtUsd(availableFunds)}</b>
        </div>
      )}

      {/* Buying power — promoted out of its own cell into the wallet. Green = available
          firepower. Optional-chained → hidden pre-data so nothing is lost. */}
      {buyingPower != null && (
        <div className="mt-1.5 flex items-center justify-between border-t border-slate-100 pt-1.5 font-mono text-[11px] text-slate-500">
          <span>כוח קנייה זמין</span>
          <b className="text-green-700">{fmtUsd(buyingPower)}</b>
        </div>
      )}
    </div>
  );
}

// ── Holdings SUMMARY cell — cockpit top-MIDDLE. Σ-footer style, promoted prominent. ──
// Total holdings value BIG + secondary "{N} פוזיציות · ממוצע $X". Same reader the
// wallet footer used (readHoldingsSummary). All optional-chained → "—" pre-data.
function HoldingsSummaryPanel({ data, isLoading }: { data: any; isLoading: boolean }) {
  const { total, count, avg } = readHoldingsSummary(data);
  return (
    <div
      dir="rtl"
      className="flex flex-col rounded-xl border-2 border-slate-200 bg-white px-4 py-3"
    >
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 font-mono text-base font-black leading-none text-slate-500" aria-hidden="true">Σ</span>
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
          Σ החזקות
        </span>
      </div>

      <div className="mt-1 flex flex-col">
        <span
          className={cn(
            "font-mono text-4xl font-black leading-none tabular-nums",
            total == null ? "text-slate-300" : "text-slate-800",
          )}
        >
          {isLoading && total == null ? (
            <span className="inline-block h-9 w-28 animate-pulse rounded bg-slate-200" />
          ) : (
            fmtUsd(total)
          )}
        </span>
        <span className="mt-1 font-mono text-[11px] font-semibold tabular-nums text-slate-500">
          {count == null ? (
            "—"
          ) : (
            <>
              {count} פוזיציות
              {avg != null && <span className="text-slate-400"> · ממוצע {fmtUsd(avg)}</span>}
            </>
          )}
        </span>
      </div>
    </div>
  );
}

// ── OVER-ALLOCATION RISK banner ──────────────────────────────────────────────
// Σ planned$ of near-ready candidates (readinessPct ≥ 90) vs Available Margin.
// Renders NOTHING unless buyingPower is known AND planned > available (no false alarm).
const READY_THRESHOLD = 90;
function OverAllocationBanner({ data }: { data: any }) {
  const { buyingPower } = readWallet(data);
  // buyingPower not shipped yet → never alarm.
  if (buyingPower == null || buyingPower <= 0) return null;

  const candidates: any[] = Array.isArray(data?.upcomingSignals) ? data.upcomingSignals : [];
  const plannedOf = (c: any) => {
    const v = c?.sizeUsd ?? c?.plannedUsd ?? c?.positionSizeUsd;
    const n = Number(v);
    return v != null && !isNaN(n) && isFinite(n) ? n : 0;
  };
  const plannedSum = candidates
    .filter((c) => Number(c?.readinessPct) >= READY_THRESHOLD)
    .reduce((acc, c) => acc + plannedOf(c), 0);

  if (!(plannedSum > buyingPower)) return null;

  // SUBTLE chip — no pulse, no gradient, no border-2. Quiet muted-amber.
  return (
    <span
      dir="rtl"
      role="status"
      className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] leading-snug text-amber-700"
    >
      <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" aria-hidden="true" />
      <span>
        over-allocation · {fmtUsd(plannedSum)} מתוכנן מול {fmtUsd(buyingPower)} זמין
      </span>
    </span>
  );
}

// ── Cockpit shell ────────────────────────────────────────────────────────────
export function WarRoomCockpit({
  data,
  isLoading,
}: {
  data: any;
  isLoading: boolean;
}) {
  const intradayConfig =
    data?.config?.intradayMultiplier ?? data?.intradayMultiplier ?? null;
  const overnightConfig =
    data?.config?.overnightMultiplier ?? data?.overnightMultiplier ?? null;
  // Live overnight value for the TRIM target (falls back to default when unset).
  const overnightTarget = overnightConfig ?? DEFAULT_OVERNIGHT;

  return (
    <section
      aria-label="Leverage cockpit"
      dir="ltr"
      className="border-b border-slate-200 bg-slate-50/70 px-3 py-3 sm:px-6"
    >
      {/* Money state first — TOP ROW left→right: P&L יומי · Σ החזקות · LIVE WALLET.
          375px: single-column stack (Daily P&L → holdings summary → wallet). */}
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <DailyPnlPanel data={data} isLoading={isLoading} />
        <HoldingsSummaryPanel data={data} isLoading={isLoading} />
        <LiveWalletPanel data={data} isLoading={isLoading} />
      </div>

      {/* GROSS + DIALS are the most safety-critical → dominant. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <LiveGrossPanel data={data} isLoading={isLoading} />
        {/* Both dials, one source of truth — intraday above, overnight directly below. */}
        <div className="flex flex-col gap-3">
          <PowerDial
            icon={<Zap className="h-4 w-4" />}
            title="Intraday Power"
            configValue={intradayConfig}
            defaultValue={DEFAULT_OVERNIGHT}
            ceiling={GROSS_CEILING}
            ticks={[0, 1.9, 4.0]}
            commitKey="intradayMultiplier"
            isLoading={isLoading}
            caption={
              <>
                <b className="text-slate-700">INTRADAY POWER</b> — sizing leverage for{" "}
                <b className="text-slate-700">NEW entries</b> (risk stays 1%).{" "}
                <b className="text-slate-700">0 = PAUSE</b> (no new entries).
              </>
            }
          />
          <PowerDial
            icon={<Moon className="h-4 w-4" />}
            title="Overnight"
            configValue={overnightConfig}
            defaultValue={DEFAULT_OVERNIGHT}
            ceiling={OVERNIGHT_CEILING}
            ticks={[0, 1.0, 2.0]}
            commitKey="overnightMultiplier"
            isLoading={isLoading}
            caption={
              <>
                <b className="text-slate-700">OVERNIGHT</b> — gross cap held into the close{" "}
                <span className="text-slate-400">(ceiling {OVERNIGHT_CEILING.toFixed(1)}x)</span>.
              </>
            }
          />
        </div>
      </div>
      {/* Quiet, secondary footer: over-alloc chip (self-hides) + subtle Trim button.
          Wraps on 375px; over-alloc on the left, Trim on the right. */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <OverAllocationBanner data={data} />
        <div className="ml-auto">
          <TrimToOvernightButton data={data} overnight={overnightTarget} />
        </div>
      </div>
    </section>
  );
}

export default WarRoomCockpit;
