import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { useFullPortfolioRefresh } from "@/hooks/useFullPortfolioRefresh";
import { LastUpdateRefreshButton } from "@/components/LastUpdateRefreshButton";
import { HoldToConfirmButton } from "@/components/HoldToConfirmButton";
import { toastMutationError } from "@/lib/mutationErrors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Loader2, RefreshCw, Zap, Skull, Activity, ArrowUp, ArrowDown, ChevronsUpDown,
  Shield, Ban, CheckCircle2, TrendingUp, TrendingDown, Wifi, WifiOff, Clock, Play, Radar, AlertTriangle, BellOff
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Link } from "wouter";
import { DeepAnalysisModal } from "@/components/DeepAnalysisModal";
import { WarRoomCandidatesTable } from "@/components/war-room/WarRoomCandidatesTable";
import { WarRoomCockpit } from "@/components/war-room/WarRoomCockpit";
import { OrderStatusPopup } from "@/components/OrderStatusPopup";
import {
  RefreshCandidatesButton, RunWarRoomButton, CycleProgressStrip, useCycleProgress,
  CycleSummaryPanel, DeepAnalysisV45Modal, type CycleSummary,
} from "@/components/war-room/WarRoomCycleControls";

// ── Error Boundary — prevents white-screen on any render error ──────────────
import { Component, ErrorInfo } from "react";
class WarRoomErrorBoundary extends Component<{children: React.ReactNode},{hasError: boolean, msg: string}> {
  state = { hasError: false, msg: "" };
  static getDerivedStateFromError(e: Error) { return { hasError: true, msg: e.message }; }
  componentDidCatch(e: Error, info: ErrorInfo) { console.error("[WarRoom] Render error:", e, info); }
  render() {
    if (this.state.hasError) return (
      <div className="flex flex-col items-center justify-center h-screen gap-4 p-8 text-center">
        <div className="text-4xl">⚠️</div>
        <div className="text-lg font-bold text-red-600">War Room נתקל בשגיאה</div>
        <div className="text-sm text-gray-500 font-mono max-w-md">{this.state.msg}</div>
        <button className="px-4 py-2 bg-blue-600 text-white rounded" onClick={() => window.location.reload()}>רענן</button>
      </div>
    );
    return this.props.children;
  }
}

function fmt$(n?: number | null, dec = 0) {
  if (n == null || isNaN(n) || !isFinite(n)) return "—";
  const abs = Math.abs(n);
  const s = abs >= 1e6 ? `${(abs/1e6).toFixed(1)}M` : abs >= 1000 ? `${(abs/1000).toFixed(1)}k` : abs.toFixed(dec);
  return `${n < 0 ? "-$" : "$"}${s}`;
}
function fmtPct(n?: number | null, dec = 2) {
  if (n == null || isNaN(n) || !isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(dec)}%`;
}
function fmtDate(d?: string | null) {
  if (!d) return "—";
  const dt = new Date(d);
  return `${String(dt.getDate()).padStart(2,"0")}.${String(dt.getMonth()+1).padStart(2,"0")}, ${String(dt.getHours()).padStart(2,"0")}:${String(dt.getMinutes()).padStart(2,"0")}`;
}
function fmtTime(d?: Date | null) {
  if (!d) return "—";
  return d.toLocaleTimeString("en-US", { hour:"2-digit", minute:"2-digit", second:"2-digit", hour12: false });
}

function isLiveMarketOpen() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const d = et.getDay(), h = et.getHours(), m = et.getMinutes();
  if (d === 0 || d === 6) return false;
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

type ColKey = "num"|"ticker"|"value"|"dailyPct"|"dailyUsd"|"pnlPct"|"pnlUsd"|"sl"|"tp"|"health"|"sector"|"opened";
type SDir = "asc"|"desc";

const COLS: {key:ColKey; label:string; right?:boolean; noSort?:boolean}[] = [
  {key:"num",      label:"#",       right:true, noSort:true},
  {key:"ticker",   label:"TICKER"},
  {key:"value",    label:"VALUE",   right:true},
  {key:"dailyPct", label:"DAILY %", right:true},
  {key:"dailyUsd", label:"DAILY $", right:true},
  {key:"pnlPct",   label:"PNL %",   right:true},
  {key:"pnlUsd",   label:"PNL $",   right:true},
  {key:"sl",       label:"SL",      right:true, noSort:true},
  {key:"tp",       label:"TP",      right:true, noSort:true},
  {key:"health",   label:"HEALTH",  right:true},
  {key:"sector",   label:"SECTOR",  noSort:true},
  {key:"opened",   label:"OPENED",  right:true},
];

const ORDER_TABS = [
  {key:"POS",  label:"POS"},
  {key:"SL",   label:"SL"},
  {key:"TP",   label:"TP"},
  {key:"PEND", label:"PEND"},
  {key:"FILL", label:"FILL"},
  {key:"CANC", label:"CANC"},
] as const;
type OrderTab = typeof ORDER_TABS[number]["key"];

/** Client poll + displayed sync interval (PF-01: was 3s→5s, now 4s aligned with server IBKR TTL) */
const WAR_ROOM_POLL_MS = 4_000;

function SortIco({d}:{d?:SDir|null}) {
  if (d==="asc")  return <ArrowUp   className="w-3 h-3 ml-1 shrink-0 text-primary"/>;
  if (d==="desc") return <ArrowDown className="w-3 h-3 ml-1 shrink-0 text-primary"/>;
  return <ChevronsUpDown className="w-3 h-3 ml-1 shrink-0 opacity-40"/>;
}

// ── FlickerCell: Bloomberg-style tick flash on value change ──────────────────
function FlickerCell({ value, fmt, className }: {
  value: number | null | undefined;
  fmt: (v: number) => string;
  className?: string;
}) {
  const prev = useRef<number | null | undefined>(value);
  const [flash, setFlash] = useState<"up"|"down"|null>(null);
  useEffect(() => {
    if (value == null || prev.current == null) { prev.current = value; return; }
    if (value > prev.current) setFlash("up");
    else if (value < prev.current) setFlash("down");
    prev.current = value;
    const id = setTimeout(() => setFlash(null), 600);
    return () => clearTimeout(id);
  }, [value]);
  return (
    <span className={cn(
      "font-mono font-bold tabular-nums transition-colors duration-150",
      flash === "up"   && "text-green-600",
      flash === "down" && "text-red-500",
      className
    )}>
      {value == null ? "—" : fmt(value)}
    </span>
  );
}

// ── SkeletonVal: prevents layout shift during loading ────────────────────────
function SkeletonVal({ isLoading, value, className }: {
  isLoading: boolean; value: React.ReactNode; className?: string;
}) {
  if (isLoading) return (
    <span className={cn("inline-block h-4 w-16 rounded bg-gray-200 animate-pulse align-middle", className)}/>
  );
  return <span className={className}>{value}</span>;
}

import { SlTpBadge, isPositionSlTpCovered } from "@/components/war-room/SlTpBadge";
function SyncStatusBox({ lastFetch, isLoading, pollSec }:{ lastFetch:Date|null; isLoading:boolean; pollSec:number }) {
  const secAgo = lastFetch ? Math.floor((Date.now() - lastFetch.getTime()) / 1000) : null;
  const synced = secAgo != null && secAgo < pollSec * 2;
  return (
    <div className="flex flex-col gap-1.5 w-full h-full">
      <div className={WR_CTRL_LABEL}>SYNC</div>
      <div className="flex items-center gap-2">
        {isLoading ? <Loader2 className="w-4 h-4 text-violet-500 animate-spin"/> :
          synced ? <Wifi className="w-4 h-4 text-green-700"/> : <WifiOff className="w-4 h-4 text-amber-600"/>}
        <span className={cn("text-sm font-bold uppercase tracking-wide",
          synced ? WR_CTRL_POS_DARK : "text-amber-700")}>
          {isLoading ? "SYNCING…" : synced ? "SYNC ✓" : "STALE"}
        </span>
      </div>
      <div className="flex items-center gap-1.5 text-xs font-mono text-slate-500">
        <Clock className="w-3.5 h-3.5"/>
        <span>{lastFetch ? fmtTime(lastFetch) : "—"}</span>
      </div>
      {secAgo != null && (
        <div className={cn("text-xs font-mono font-semibold", synced ? WR_CTRL_POS : "text-amber-600")}>
          {secAgo}s ago · poll {pollSec}s
        </div>
      )}
    </div>
  );
}

// ── ElzaPerfBox ────────────────────────────────────────────────────────────────
function ElzaPerfBox({ positions, elzaData, monthlyRealizedPnl }:{ positions:any[]; elzaData:any; monthlyRealizedPnl:number }) {
  const unreal  = positions.reduce((s,p) => s + (p.pnl ?? 0), 0);
  const real    = monthlyRealizedPnl;  // monthly (June 1+) from DB
  const alloc   = positions.reduce((s,p) => s + Math.abs(p.value ?? 0), 0);
  const retPct  = alloc > 0 ? (unreal / alloc) * 100 : null;
  const winners = positions.filter(p => (p.pnl ?? 0) > 0).length;
  const losers  = positions.filter(p => (p.pnl ?? 0) < 0).length;
  return (
    <div className="w-full h-full">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={WR_CTRL_LABEL}>⚡ ELZA RETURNS</span>
        <span className="ms-auto text-xs text-slate-400 font-mono">{positions.length} pos</span>
      </div>
      <div className={cn("text-xl font-bold font-mono tabular-nums", unreal >= 0 ? WR_CTRL_POS_DARK : "text-red-600")}>
        {fmt$(unreal)}
      </div>
      <div className={cn("text-xs font-mono mt-0.5", retPct != null ? (retPct >= 0 ? WR_CTRL_POS : "text-red-600") : "text-slate-500")}>
        {retPct != null ? fmtPct(retPct) : "—"} unrealized
      </div>
      <div className="mt-2 pt-2 border-t border-slate-200 flex flex-wrap gap-x-3 gap-y-0.5 text-xs font-mono">
        <span className={WR_CTRL_POS}>✓ {winners} up</span>
        <span className="text-red-600">✗ {losers} down</span>
        {real !== 0 && <span className={cn("ms-auto font-semibold", real >= 0 ? WR_CTRL_POS_DARK : "text-red-600")}>רווח יוני: {fmt$(real)}</span>}
      </div>
    </div>
  );
}


// ── MaxPositionsBox ──────────────────────────────────────────────────────────
// ── MaxPositionsBox ──────────────────────────────────────────────────────────
function MaxPositionsBox({ maxLong, maxShort, setMaxLong, setMaxShort, onSave }:
  { maxLong: number; maxShort: number; setMaxLong: (v: number) => void; setMaxShort: (v: number) => void; onSave: (l: number, s: number) => void }) {
  const [saved, setSaved] = useState(false);
  const handleSave = () => {
    onSave(maxLong, maxShort);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };
  return (
    <div className="flex flex-col gap-2 w-full h-full">
      <div className={WR_CTRL_LABEL}>מקס׳ פוזיציות</div>
      <div className="flex items-center justify-center gap-4">
        <div className="flex flex-col items-center">
          <span className={cn("text-xs font-semibold mb-1", WR_CTRL_POS)}>📈 לונג</span>
          <input
            type="number" min={1} max={50} step={1} value={maxLong}
            onChange={e => setMaxLong(Math.min(50, Math.max(1, parseInt(e.target.value) || 1)))}
            onBlur={handleSave}
            onKeyDown={e => { if (e.key === "Enter") handleSave(); }}
            className={cn("w-16 text-center text-2xl font-black font-mono tabular-nums bg-white border-2 rounded-lg px-1 py-1.5 focus:outline-none focus:ring-2", WR_CTRL_POS_BORDER)}
          />
        </div>
        <div className="flex flex-col items-center">
          <span className="text-xs text-red-600 font-semibold mb-1">📉 שורט</span>
          <input
            type="number" min={0} max={20} step={1} value={maxShort}
            onChange={e => setMaxShort(Math.min(20, Math.max(0, parseInt(e.target.value) || 0)))}
            onBlur={handleSave}
            onKeyDown={e => { if (e.key === "Enter") handleSave(); }}
            className="w-16 text-center text-2xl font-black font-mono tabular-nums bg-white border-2 border-red-500 rounded-lg px-1 py-1.5 focus:outline-none focus:ring-2 focus:ring-red-400/30"
          />
        </div>
      </div>
      <div className="text-xs text-amber-700 font-mono leading-tight">⚔️ חוק ברזל — יאכף בכל סייקל</div>
      <button
        onClick={handleSave}
        className={cn("mt-auto min-h-8 text-xs font-semibold rounded-md px-3 py-1.5 transition-colors",
          saved ? cn(WR_CTRL_POS_BG, "text-white") : "bg-slate-700 hover:bg-slate-800 text-white")}
      >
        {saved ? "✓ נשמר!" : "שמור"}
      </button>
    </div>
  );
}
// ── LeverageBox ──────────────────────────────────────────────────────────────
function LeverageBox({ intradayLev, overnightLev, setIntradayLev, setOvernightLev, onSave }:
  { intradayLev: number; overnightLev: number;
    setIntradayLev: (v: number) => void; setOvernightLev: (v: number) => void;
    onSave: (intraday: number, overnight: number) => void }) {
  const [saved, setSaved] = useState(false);
  const handleSave = () => {
    onSave(intradayLev, overnightLev);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };
  return (
    <div className="flex flex-col gap-2 w-full h-full">
      <div className={WR_CTRL_LABEL}>מינוף</div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500 w-16 shrink-0">שעות מסחר</span>
        <input
          type="number" min={1} max={3.9} step={0.1} value={intradayLev}
          onChange={e => setIntradayLev(Math.min(3.9, Math.max(1, parseFloat(e.target.value) || 1)))}
          onBlur={handleSave}
          onKeyDown={e => { if (e.key === "Enter") handleSave(); }}
          className="w-16 text-center text-base font-bold font-mono tabular-nums bg-white border border-slate-300 rounded-md px-1 py-1 focus:outline-none focus:ring-2 focus:ring-slate-400/30"
        />
        <span className="text-xs text-slate-400">/ 3.9x</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500 w-16 shrink-0">לילה</span>
        <input
          type="number" min={1} max={1.9} step={0.1} value={overnightLev}
          onChange={e => setOvernightLev(Math.min(1.9, Math.max(1, parseFloat(e.target.value) || 1)))}
          onBlur={handleSave}
          onKeyDown={e => { if (e.key === "Enter") handleSave(); }}
          className="w-16 text-center text-base font-bold font-mono tabular-nums bg-white border border-slate-300 rounded-md px-1 py-1 focus:outline-none focus:ring-2 focus:ring-slate-400/30"
        />
        <span className="text-xs text-slate-400">/ 1.9x</span>
      </div>
      <button
        onClick={handleSave}
        className={cn("mt-auto min-h-8 text-xs font-semibold rounded-md px-3 py-1.5 transition-colors",
          saved ? cn(WR_CTRL_POS_BG, "text-white") : "bg-slate-700 hover:bg-slate-800 text-white")}
      >
        {saved ? "✓ נשמר!" : "שמור"}
      </button>
    </div>
  );
}

// ── AllocationBox ─────────────────────────────────────────────────────────────
function AllocationBox({ nlv, allocPct, setAllocPct, minPosUsd, setMinPosUsd, maxPosUsd, setMaxPosUsd, onSave, dirty }:
  { nlv:number; allocPct:number; setAllocPct:(v:number)=>void;
    minPosUsd:number; setMinPosUsd:(v:number)=>void;
    maxPosUsd:number; setMaxPosUsd:(v:number)=>void;
    onSave:()=>void; dirty:boolean }) {
  const [saved, setSaved] = useState(false);
  const handleSave = () => { onSave(); setSaved(true); setTimeout(() => setSaved(false), 2500); };
  const fmtK = (v: number) => v >= 1000 ? `$${(v/1000).toFixed(0)}k` : `$${v.toFixed(0)}`;
  return (
    <div className="flex flex-col gap-2 w-full h-full">
      <div className={WR_CTRL_LABEL}>גודל פוזיציה</div>
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-slate-500 w-14 shrink-0">הקצאה</span>
        <input
          type="number" min={1} max={100} step={1} value={allocPct}
          onChange={e => setAllocPct(Number(e.target.value))}
          onKeyDown={e => { if (e.key === "Enter") handleSave(); }}
          className="w-14 text-center text-base font-bold font-mono tabular-nums text-slate-800 bg-white border border-slate-300 rounded-lg px-1 py-1 focus:outline-none focus:ring-2 focus:ring-slate-400/30"
        />
        <span className="text-sm font-bold text-slate-600">%</span>
        <span className="text-xs text-slate-500 font-mono">{fmtK(nlv * allocPct / 100)}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-slate-500 w-14 shrink-0">מינימום</span>
        <span className="text-xs text-slate-500 font-bold">$</span>
        <input
          type="number" min={100} step={500} value={minPosUsd}
          onChange={e => setMinPosUsd(Number(e.target.value))}
          onKeyDown={e => { if (e.key === "Enter") handleSave(); }}
          className="w-20 text-center text-sm font-bold font-mono tabular-nums text-slate-800 bg-white border border-slate-300 rounded-lg px-1 py-1 focus:outline-none focus:ring-2 focus:ring-slate-400/30"
        />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-slate-500 w-14 shrink-0">מקסימום</span>
        <span className="text-xs text-slate-500 font-bold">$</span>
        <input
          type="number" min={100} step={500} value={maxPosUsd}
          onChange={e => setMaxPosUsd(Number(e.target.value))}
          onKeyDown={e => { if (e.key === "Enter") handleSave(); }}
          className="w-20 text-center text-sm font-bold font-mono tabular-nums text-slate-800 bg-white border border-slate-300 rounded-lg px-1 py-1 focus:outline-none focus:ring-2 focus:ring-slate-400/30"
        />
      </div>
      <button
        onClick={handleSave}
        className={cn("mt-auto min-h-8 text-xs font-semibold rounded-md px-3 py-1.5 transition-colors",
          saved ? cn(WR_CTRL_POS_BG, "text-white") : "bg-slate-700 hover:bg-slate-800 text-white")}
      >
        {saved ? "✓ נשמר!" : "שמור"}
      </button>
    </div>
  );
}

function protectionFromResponse(data: {
  sl?: number | null;
  tp?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
} | null | undefined) {
  const serverSl = data?.sl ?? data?.stopLoss;
  const serverTp = data?.tp ?? data?.takeProfit;
  const hasVerifiedProtection =
    serverSl != null && serverTp != null && serverSl > 0 && serverTp > 0;
  return hasVerifiedProtection
    ? { stopLoss: serverSl, takeProfit: serverTp, verified: true as const }
    : undefined;
}

// ── SlTpSyncBox ────────────────────────────────────────────────────────────────
function SlTpSyncBox({ positions, ibkrOrders, onSyncDone }:{
  positions: any[];
  ibkrOrders: Record<string, unknown>[];
  onSyncDone: () => void;
}) {
  const syncMut = trpc.liveEngine.syncSlTp.useMutation({
    onSuccess: (res:any) => {
      const parts: string[] = [];
      if (res.orphansCancelled > 0) parts.push(`נוקו ${res.orphansCancelled} פקודות יתומות`);
      if (res.placed > 0)           parts.push(`הונחו ${res.placed} הגנות חדשות`);
      if (res.qtyFixed > 0)         parts.push(`תוקנו ${res.qtyFixed} כמויות`);
      if (res.alreadyOk > 0)        parts.push(`${res.alreadyOk} פוזיציות תקינות`);
      if (res.failed > 0) {
        const failDetails = (res.details ?? [])
          .filter((d: string) => d.includes("FAIL"))
          .map((d: string) => d.split(":")[1] ?? d)
          .filter(Boolean);
        const failTickers = [...new Set(failDetails)].join(", ");
        parts.push(`⚠️ ${res.failed} שגיאות${failTickers ? ` (${failTickers})` : ""}`);
      }
      const msg = parts.length > 0
        ? `הסנכרון הסתיים: ${parts.join(', ')}.`
        : `הסנכרון הסתיים — הכל תקין ✅`;
      if (res.failed > 0) toast.error(msg);
      else toast.success(msg);
      onSyncDone();
    },
    onError: (e:any) => toast.error(`Sync נכשל: ${e.message}`),
  });

  const missingTp = positions.filter(
    (p) => !isPositionSlTpCovered(p, ibkrOrders, "TP"),
  ).length;
  const missingSl = positions.filter(
    (p) => !isPositionSlTpCovered(p, ibkrOrders, "SL"),
  ).length;
  const missingAny = missingTp + missingSl;
  const allOk = positions.length > 0 && missingAny === 0;

  return (
    <div className="flex flex-col gap-2 w-full h-full">
      <div className="flex items-center gap-2">
        <Shield className={cn("w-4 h-4 shrink-0", allOk ? WR_CTRL_POS : "text-red-600")}/>
        <span className={cn("text-xs font-semibold uppercase tracking-wider",
          allOk ? WR_CTRL_POS_DARK : "text-red-700")}>SL/TP GUARD</span>
      </div>
      <div className={cn("text-sm font-medium leading-snug", allOk ? "text-slate-600" : "text-red-700")}>
        {positions.length === 0 ? "אין פוזיציות" :
          allOk ? "כל הפוזיציות מכוסות ✅" :
          missingTp > 0 && missingSl > 0 ? `${missingSl} חסר SL · ${missingTp} חסר TP` :
          missingTp > 0 ? `${missingTp} חסרות TP` : `${missingSl} חסרות SL`}
      </div>
      <Button size="sm" variant="outline"
        className={cn("mt-auto min-h-9 text-xs font-semibold px-3",
          allOk ? "border-green-700/40 text-green-800 hover:bg-green-50" : "border-red-400 text-red-700 hover:bg-red-50")}
        onClick={() => syncMut.mutate()} disabled={syncMut.isPending}>
        {syncMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin me-1.5"/> : null}
        סנכרן SL/TP
      </Button>
    </div>
  );
}

// ── BuyingPowerStrip ───────────────────────────────────────────────────────────
function BuyingPowerStrip({ summ, alloc }:{ summ:any; alloc:number }) {
  const intra = summ?.intradayCap ?? 0;
  const night = summ?.overnightCap ?? 0;
  const deployed = summ?.totalHolding ?? 0;
  if (!intra) return null;
  const usedPct = Math.min(100, (deployed / intra) * 100);
  return (
    <div className="px-4 sm:px-6 py-2 border-t border-slate-200 bg-slate-50/40">
      <div className="flex items-center gap-3 flex-wrap text-[10px] font-mono text-slate-500">
        <span>Deployed <b className="text-slate-800">{fmt$(deployed)}</b></span>
        <span className="text-slate-300">|</span>
        <span>Intraday <b className="text-slate-700">{fmt$(intra)}</b></span>
        <span className="text-slate-300">|</span>
        <span>Overnight <b className="text-slate-700">{fmt$(night)}</b></span>
        <div className="flex-1 min-w-[80px] bg-slate-200 rounded-full h-1 ml-1">
          <div className={cn("h-1 rounded-full transition-all",
            usedPct > 90 ? "bg-red-600" : "bg-slate-600")}
            style={{width:`${usedPct}%`}}/>
        </div>
        <span className={cn("font-semibold tabular-nums", usedPct > 90 ? "text-red-600" : "text-slate-600")}>
          {usedPct.toFixed(0)}%
        </span>
      </div>
    </div>
  );
}

/** War Room positions grid — readable P&L greens/reds (not brand #65A30D). */
const WR_PNL_POS = "text-green-700";   // #15803d
const WR_PNL_NEG = "text-red-600";     // #dc2626
const WR_HEALTH_GOOD = "text-green-800"; // #166534

/** Bottom control panel — institutional hierarchy (no neon emerald). */
const WR_CTRL_LABEL = "text-xs font-semibold uppercase tracking-wider text-slate-500";
const WR_CTRL_POS = "text-green-700";
const WR_CTRL_POS_DARK = "text-green-800";
const WR_CTRL_POS_BORDER = "border-green-700 focus:ring-green-600/30";
const WR_CTRL_POS_BG = "bg-green-700 hover:bg-green-800";
const WR_CTRL_WIDGET = "p-3 min-h-[148px] flex flex-col";

function pnlTone(n: number) {
  return n >= 0 ? WR_PNL_POS : WR_PNL_NEG;
}

// Null-aware P&L tone: a MISSING value is neutral slate, never a false red/green.
function pnlToneN(n: number | null | undefined) {
  if (n == null) return "text-slate-500";
  return n >= 0 ? WR_PNL_POS : WR_PNL_NEG;
}

function healthTone(score: number) {
  if (score >= 7) return WR_HEALTH_GOOD;
  if (score >= 4) return "text-amber-600";
  return WR_PNL_NEG;
}

function winRateTone(rate: number) {
  if (rate >= 55) return "text-green-600";
  if (rate >= 45) return "text-amber-600";
  return "text-red-600";
}

const HE_MONTHS_SHORT = ["ינו", "פבר", "מרץ", "אפר", "מאי", "יונ", "יול", "אוג", "ספט", "אוק", "נוב", "דצמ"];

// ── WarRoomMetricsRibbon — terminal-style hierarchy, Daily P&L hero ───────────
function WarRoomMetricsRibbon({
  isLoading,
  grand,
  gPct,
  dailyPnl,
  dailyPct,
  realized,
  nlv,
  alloc,
  allocPctLive,
  cashElza,
  leverageRatio,
  marginCash,
  leverageNet,
  leverageLong,
  leverageShort,
  monthlyStartNlv,
  rowsCount,
  monthlyWinStats,
  elzaV45LiveEnabled,
  intradayMultiplier,
  zivRotationFlushEnabled,
}: {
  isLoading: boolean;
  grand: number;
  gPct: number;
  dailyPnl: number;
  dailyPct: number;
  realized: number;
  nlv: number;
  alloc: number;
  allocPctLive: number;
  cashElza: number;
  leverageRatio: number;
  marginCash: number;
  leverageNet: number;
  leverageLong: number;
  leverageShort: number;
  monthlyStartNlv: number;
  rowsCount: number;
  monthlyWinStats?: {
    winners: number;
    losers: number;
    breakeven: number;
    total: number;
    winRate: number;
  };
  elzaV45LiveEnabled: number;
  intradayMultiplier: number;
  zivRotationFlushEnabled: number;
}) {
  const now = new Date();
  const monthShort = HE_MONTHS_SHORT[now.getMonth()];
  const monthStartLabel = `מ-1/${now.getMonth() + 1}`;
  const winStats = monthlyWinStats ?? { winners: 0, losers: 0, breakeven: 0, total: 0, winRate: 0 };
  const winSub = winStats.total > 0
    ? `${winStats.winners}W · ${winStats.losers}L${winStats.breakeven > 0 ? ` · ${winStats.breakeven}BE` : ""}`
    : "אין סגירות";

  // Engine-State pill — armed (v4.5) vs inert (legacy); dot+TEXT, not color-alone
  const engineArmed = elzaV45LiveEnabled === 1;
  const flushOn = zivRotationFlushEnabled === 1;
  const EnginePill = () => (
    <div
      role="status"
      dir="rtl"
      className="mt-2 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider tabular-nums leading-none"
      style={engineArmed
        ? { borderColor: "#65A30D", backgroundColor: "rgba(101,163,13,0.08)", color: "#3F6212" }
        : { borderColor: "#CBD5E1", backgroundColor: "rgba(100,116,139,0.06)", color: "#475569" }}
    >
      <span
        className={cn("inline-block w-2 h-2 rounded-full shrink-0", engineArmed ? "bg-[#65A30D]" : "border border-slate-400")}
        aria-hidden="true"
      />
      <span>{engineArmed ? `v4.5 חמוש · ${intradayMultiplier}×` : "INERT · Legacy"}</span>
      {flushOn && (
        <span className="ml-0.5 rounded-sm bg-indigo-100 px-1 py-0.5 text-[9px] font-semibold text-indigo-700 normal-case tracking-normal">+Flush</span>
      )}
    </div>
  );

  const secondary = [
    { label: "P&L חודשי", val: fmt$(grand), sub: `${fmtPct(gPct)} | ${monthStartLabel}`, tone: pnlTone(grand) },
    { label: "REALIZED", val: fmt$(realized), sub: `closed ${winStats.total} · ${monthShort}`, tone: pnlTone(realized) },
    { label: "NLV", val: fmt$(nlv), sub: "net liq", tone: "text-slate-900" },
    { label: "ALLOCATED", val: fmt$(alloc), sub: alloc > 0 ? `${allocPctLive.toFixed(0)}% NLV` : "0 פוזיציות", tone: "text-slate-900" },
    { label: "CASH ELZA", val: fmt$(cashElza), sub: rowsCount === 0 ? "budget פנוי" : "to deploy", tone: "text-slate-900" },
    { label: "LEVERAGE", val: `${leverageRatio.toFixed(2)}×${leverageRatio >= 2.0 ? " סיכון" : leverageRatio >= 1.5 ? " MID" : ""}`, sub: `L ${leverageLong.toFixed(2)}× · S ${leverageShort.toFixed(2)}×`, tone: leverageRatio >= 2.0 ? "text-[#FF6B6B]" : leverageRatio >= 1.5 ? "text-amber-500" : "text-[#65A30D]" },
  ];

  const MetricCell = ({ label, val, sub, tone, className }: {
    label: string; val: string; sub: string; tone: string; className?: string;
  }) => (
    <div className={cn("px-4 py-2.5 min-w-0", className)}>
      <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500 truncate">{label}</div>
      <div className={cn("text-sm font-medium font-mono tabular-nums leading-tight mt-0.5", tone)}>
        {isLoading && val === "…" ? <span className="inline-block h-5 w-16 rounded bg-slate-200 animate-pulse"/> : val}
      </div>
      <div className="text-[10px] font-mono text-slate-500 mt-0.5 truncate">{sub}</div>
    </div>
  );

  return (
    <div className="bg-white border-b border-slate-200">
      {/* Mobile: hero first, then compact grid */}
      <div className="sm:hidden">
        <div className="flex flex-col items-center justify-center py-4 px-4 border-b border-slate-200 bg-slate-50/60">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Daily P&L</div>
          <div className={cn("text-4xl font-bold font-mono tabular-nums tracking-tight mt-1", pnlTone(dailyPnl))}>
            {isLoading ? <span className="inline-block h-10 w-28 rounded bg-slate-200 animate-pulse"/> : fmt$(dailyPnl)}
          </div>
          <div className={cn("text-sm font-mono tabular-nums mt-0.5", pnlTone(dailyPnl))}>
            {dailyPct >= 0 ? "+" : ""}{dailyPct.toFixed(2)}%
          </div>
          <EnginePill/>
        </div>
        <div className="grid grid-cols-2 divide-x divide-y divide-slate-200">
          <MetricCell label="אחוז הצלחה" val={isLoading ? "…" : `${winStats.winRate}%`} sub={winSub} tone={winRateTone(winStats.winRate)} />
          {secondary.map((m) => (
            <MetricCell key={m.label} label={m.label} val={m.val} sub={m.sub} tone={m.tone} />
          ))}
        </div>
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-200 bg-slate-50/40 text-[10px]">
          <span className="font-medium uppercase tracking-wider text-slate-500">סיכום הון</span>
          <div className="flex items-center gap-4 font-mono tabular-nums">
            <span className="text-slate-500">1.6 <b className="text-slate-800">{fmt$(monthlyStartNlv)}</b></span>
            <span className="text-slate-500">היום <b className="text-slate-800">{fmt$(nlv)}</b></span>
            <span className={pnlTone(grand)}><b>{grand >= 0 ? "+" : ""}{fmt$(grand)}</b></span>
          </div>
        </div>
      </div>

      {/* Desktop: flanking secondary metrics + center hero */}
      <div className="hidden sm:flex items-stretch min-h-[92px]">
        <div className="flex divide-x divide-slate-200 shrink-0">
          <MetricCell label={secondary[0].label} val={secondary[0].val} sub={secondary[0].sub} tone={secondary[0].tone} className="min-w-[118px]"/>
          <MetricCell label={secondary[1].label} val={secondary[1].val} sub={secondary[1].sub} tone={secondary[1].tone} className="min-w-[108px]"/>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-6 border-x border-slate-200 bg-slate-50/50 min-w-[200px]">
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Daily P&L</div>
          <div className={cn("text-[2.75rem] leading-none font-bold font-mono tabular-nums tracking-tight mt-1", pnlTone(dailyPnl))}>
            {isLoading ? <span className="inline-block h-11 w-36 rounded bg-slate-200 animate-pulse"/> : fmt$(dailyPnl)}
          </div>
          <div className={cn("text-sm font-mono tabular-nums mt-1", pnlTone(dailyPnl))}>
            {dailyPct >= 0 ? "+" : ""}{dailyPct.toFixed(2)}%
          </div>
          <EnginePill/>
        </div>

        {/* מינוף — gross leverage with long/short split (server-computed each poll & logged each engine cycle) */}
        <div className="shrink-0 flex flex-col items-center justify-center px-5 border-r border-slate-200 min-w-[124px]">
          <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">מינוף</div>
          <div className={cn("flex items-baseline justify-center gap-1.5 text-2xl font-bold font-mono tabular-nums leading-tight mt-1",
            leverageRatio >= 2.0 ? "text-[#FF6B6B]" : leverageRatio >= 1.5 ? "text-amber-500" : "text-[#65A30D]")}>
            {isLoading ? <span className="inline-block h-8 w-16 rounded bg-slate-200 animate-pulse"/> : <>
              <span>{`${leverageRatio.toFixed(2)}×`}</span>
              {leverageRatio >= 2.0
                ? <span className="text-[10px] font-semibold uppercase tracking-wide">סיכון</span>
                : leverageRatio >= 1.5
                ? <span className="text-[10px] font-semibold uppercase tracking-wide">MID</span>
                : null}
            </>}
          </div>
          <div className="text-[10px] font-mono text-slate-500 mt-1 text-center leading-tight">
            L {leverageLong.toFixed(2)}× · S {leverageShort.toFixed(2)}×
          </div>
        </div>

        <div className="shrink-0 flex flex-col items-center justify-center px-5 border-r border-slate-200 min-w-[120px]">
          <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">אחוז הצלחה</div>
          <div className={cn("text-2xl font-bold font-mono tabular-nums leading-tight mt-1", winRateTone(winStats.winRate))}>
            {isLoading ? <span className="inline-block h-8 w-16 rounded bg-slate-200 animate-pulse"/> : `${winStats.winRate}%`}
          </div>
          <div className="text-[10px] font-mono text-slate-500 mt-1 text-center leading-tight">{winSub}</div>
        </div>

        <div className="flex divide-x divide-slate-200 shrink-0">
          <MetricCell label={secondary[2].label} val={secondary[2].val} sub={secondary[2].sub} tone={secondary[2].tone} className="min-w-[96px]"/>
          <MetricCell label={secondary[3].label} val={secondary[3].val} sub={secondary[3].sub} tone={secondary[3].tone} className="min-w-[108px]"/>
          <MetricCell label={secondary[4].label} val={secondary[4].val} sub={secondary[4].sub} tone={secondary[4].tone} className="min-w-[108px]"/>
        </div>

        <div className="w-[128px] shrink-0 border-l border-slate-200 px-4 py-2.5 flex flex-col justify-center">
          <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500 mb-2">סיכום הון</div>
          <div className="space-y-1.5 font-mono tabular-nums">
            <div className="flex justify-between gap-2 text-[10px]">
              <span className="text-slate-500">הון 1.6</span>
              <span className="font-semibold text-slate-800">{fmt$(monthlyStartNlv)}</span>
            </div>
            <div className="flex justify-between gap-2 text-[10px]">
              <span className="text-slate-500">הון היום</span>
              <span className="font-semibold text-slate-800">{fmt$(nlv)}</span>
            </div>
            <div className="flex justify-between gap-2 text-[10px] pt-1 border-t border-slate-200">
              <span className="text-slate-500">PNL</span>
              <span className={cn("font-bold", pnlTone(grand))}>{grand >= 0 ? "+" : ""}{fmt$(grand)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


// ── MonthlyStatsBox ────────────────────────────────────────────────────────────
function MonthlyStatsBox({ stats, ibkrMtdPnl }: { stats: any; ibkrMtdPnl: number }) {
  if (!stats) return null;
  const winColor = stats.winRate >= 55 ? "text-emerald-600" : stats.winRate >= 45 ? "text-amber-600" : "text-red-500";
  const pnlColor = ibkrMtdPnl >= 0 ? "text-emerald-600" : "text-red-500";
  return (
    <div className="flex flex-col gap-2 w-full h-full">
      <div className="text-[10px] font-bold uppercase tracking-widest text-gray-800 mb-1">📊 סטטיסטיקה חודשית</div>
      {/* Win Rate — big */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-blue-400 font-semibold">Win Rate</span>
        <span className={`text-3xl font-black font-mono ${winColor}`}>{stats.winRate}%</span>
      </div>
      {/* Trade counts */}
      <div className="flex items-center gap-2 text-xs font-mono font-bold flex-wrap">
        <span className="text-gray-500">{stats.total} עסקאות</span>
        <span className="text-emerald-600">✅ {stats.winners}</span>
        <span className="text-red-500">❌ {stats.losers}</span>
        {(stats.breakeven ?? 0) > 0 && (
          <span className="text-slate-500">⬜ {stats.breakeven}</span>
        )}
      </div>
      {/* Monthly P&L — from IBKR NAV (currentNlv - startNAV May31) */}
      <div className="border-t border-blue-200 pt-2 flex items-center justify-between">
        <span className="text-xs text-gray-500 font-semibold">P&L יוני</span>
        <span className={`text-xl font-black font-mono ${pnlColor}`}>
          {ibkrMtdPnl >= 0 ? "+" : ""}${Math.round(ibkrMtdPnl).toLocaleString()}
        </span>
      </div>
    </div>
  );
}

// ── Isolated clock — renders independently, no page re-render every second ──
function HeaderClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const israel = now.toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const utc    = now.toLocaleTimeString("en-GB", { timeZone: "UTC",            hour: "2-digit", minute: "2-digit" });
  return <span className="text-xs font-mono text-slate-400">{israel} IL / {utc} UTC</span>;
}


// ── SnoozeButton — 12h re-entry freeze (≥44px). For an OPEN position the title
//    clarifies it does NOT cancel SL/TP; it only blocks Elza re-entry on this ticker.
function SnoozeButton({ ticker, onSnooze, held }: {
  ticker: string;
  onSnooze: (t: string) => void;
  held?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label="הקפא ל-12 שעות"
      title={held
        ? "הקפא כניסה מחדש ל-12 שעות — אינו מבטל SL/TP ואינו סוגר את הפוזיציה"
        : "הקפא ל-12 שעות — חוסם כניסה ומסתיר מהרשימה"}
      onClick={(e) => { e.stopPropagation(); onSnooze(ticker); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); }}
      className="inline-flex items-center justify-center w-11 h-11 rounded-lg border border-slate-200 text-slate-400 hover:text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 transition-colors shrink-0"
    >
      <BellOff className="w-4 h-4" />
    </button>
  );
}

// ── GhostChip (G-S2) — shows on a position row whose slot has been freed at +1.5R BE.
//    Sign + text (not color-alone). Position is NOT closed — exposure stays live at BE,
//    SL/TP keep running. Matches the snooze/badge chip styling already on the row.
function GhostChip() {
  return (
    <span
      role="status"
      title="הסלוט שוחרר לכניסה חדשה; הפוזיציה רצה ב-BE, SL/TP ממשיכים"
      className="inline-flex items-center gap-1 rounded-full border border-violet-300 bg-violet-50 px-1.5 py-0.5 text-[11px] font-mono font-semibold text-violet-700 leading-none shrink-0"
    >
      <span aria-hidden="true">👻</span>
      <span>GHOST</span>
    </span>
  );
}

// ── SlotsBreakdownChip (G-S2) — active / ghost / free split next to the slot count.
//    active = countsTowardSlot=1 (and not ghost) ; ghost = slotGhost=1 ; free = cap − active.
//    Falls back gracefully: with no ghost rows it still renders, and the single
//    "N/cap" count in the Positions tab is untouched.
function SlotsBreakdownChip({ active, ghost, free }: { active: number; ghost: number; free: number }) {
  return (
    <span
      dir="rtl"
      title="תפוס = סופר לסלוט · ghost = סלוט שוחרר (פוזיציה רצה ב-BE) · פנוי = זמין לכניסה"
      className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-mono leading-none shrink-0"
    >
      <span className="font-semibold text-slate-700">{active} תפוס</span>
      {ghost > 0 && (
        <>
          <span className="text-slate-300" aria-hidden="true">·</span>
          <span className="font-semibold text-violet-700">👻 {ghost} ghost</span>
        </>
      )}
      <span className="text-slate-300" aria-hidden="true">·</span>
      <span className="font-semibold text-emerald-700">{free} פנוי</span>
    </span>
  );
}

// Wrapped by error boundary in App.tsx or below
type WarRoomLiveProps = {
  /** Trading book slug: ceo | dror | … */
  accountSlug?: string;
  /** Non-admin scoped view (hide global admin controls). */
  isAccountScoped?: boolean;
};

export default function WarRoomLive({
  accountSlug = "ceo",
  isAccountScoped = false,
}: WarRoomLiveProps = {}) {
  const { refreshAll, refreshing: portfolioRefreshing, lastUpdated, setLastUpdated } = useFullPortfolioRefresh();
  const [sortCol, setSortCol] = useState<ColKey>("pnlUsd");
  const [sortDir, setSortDir] = useState<SDir>("desc");
  const [orderTab, setOrderTab] = useState<OrderTab>("POS");
  // mainTab removed — positions is the only tab (Logs → Settings > System Logs)
  const [closingId, setClosingId] = useState<number|null>(null);
  const [liquidateConfirm, setLiquidateConfirm] = useState<{ id: number; ticker: string } | null>(null);
  const [orderPopupOpen, setOrderPopupOpen] = useState(false);
  const [orderPopupData, setOrderPopupData] = useState<{
    orderId: string | null;
    ticker: string;
    side: "BUY" | "SELL";
    quantity: number;
    orderType: string;
    sentAt: Date;
    ibkrMessage?: string | null;
    intentLabel?: string | null;
    immediateStatus?: "success" | "failed" | null;
    trackPositionClose?: boolean;
    protection?: { stopLoss?: number | null; takeProfit?: number | null; verified?: boolean } | null;
  } | null>(null);
  const [analysisTicker, setAnalysisTicker] = useState<string|null>(null);
  const openDeepAnalysis = useCallback((t: string) => {
    try { sessionStorage.setItem("da_returnTo", window.location.pathname + window.location.search); } catch { /* ignore */ }
    setAnalysisTicker(t);
  }, []);
  // ── New War Room cycle UI state (additive) ────────────────────────────────────
  const [v45Ticker, setV45Ticker]           = useState<string|null>(null);   // Deep Analysis v4.5 modal
  const [snoozedTickers, setSnoozedTickers] = useState<Set<string>>(() => new Set()); // 12h re-entry freeze (client-side hide)
  const [summaryPanelOpen, setSummaryPanelOpen] = useState(false);           // side-panel/drawer
  const [cycleSummaryData, setCycleSummaryData] = useState<CycleSummary|null>(null);
  const [manualCycleRunning, setManualCycleRunning] = useState(false);       // RUN WAR ROOM in flight
  const [allocPct, setAllocPct]     = useState(50);
  const [minPosUsd, setMinPosUsd]   = useState<number>(2000);
  const [maxPosUsd, setMaxPosUsd]   = useState<number>(25000);
  const [dirty, setDirty]           = useState(false);
  const [intradayLev, setIntradayLev]   = useState(3.9);
  const [maxPos2,   setMaxPos2]             = useState(12);
  const [maxLong2,  setMaxLong2]            = useState(12);
  const [maxShort2, setMaxShort2]           = useState(6);
  const [overnightLev, setOvernightLev] = useState(1.9);
  const cfgInitialized = useRef(false);
  const [lastFetch, setLastFetch] = useState<Date|null>(null);
  const [engineOnOptimistic, setEngineOnOptimistic] = useState<boolean|null>(null);
  const [activeSlug, setActiveSlug] = useState(accountSlug);
  useEffect(() => { setActiveSlug(accountSlug); }, [accountSlug]);
  const querySlug = isAccountScoped ? accountSlug : activeSlug;
  const { data: tradingAccounts } = trpc.tradingAccounts.list.useQuery(undefined, {
    enabled: !isAccountScoped,
  });
  // ── Data queries ────────────────────────────────────────────────────────────
  const { data, refetch, isLoading } = trpc.liveEngine.getStatus.useQuery(
    { accountSlug: querySlug },
    {
    refetchInterval: WAR_ROOM_POLL_MS, refetchIntervalInBackground: false,
    staleTime: 0,
  });
  // Live clock tick — drives FlickerCells without extra requests
  useEffect(() => {
    if (data) {
      const d = new Date();
      setLastFetch(d);
      setLastUpdated(d);
      setEngineOnOptimistic(null);
    }
  }, [data, setLastUpdated]);

  async function handleWarRoomRefresh() {
    await Promise.allSettled([
      refreshAll({ warRoom: true, silent: true }),
      refetch({ bustCache: true }),
    ]);
    const d = new Date();
    setLastFetch(d);
    setLastUpdated(d);
    toast.success("נתוני חדר מלחמה עודכנו");
  }

  // ── 12h Snooze — optimistic client hide + best-effort server freeze (contract: snooze.snooze) ──
  const snoozeMut = (trpc as any).snooze?.snooze?.useMutation?.({
    onError: (e: any) => toastMutationError(e, "ההקפאה נכשלה"),
    onSettled: () => refetch(),
  });
  const snoozeTicker = useCallback((ticker: string) => {
    setSnoozedTickers(prev => { const n = new Set(prev); n.add(ticker); return n; });
    try {
      snoozeMut?.mutate?.({ ticker, hours: 12 });
      toast.success(`${ticker} הוקפא ל-12 שעות`);
    } catch (e: any) {
      toastMutationError(e, "ההקפאה נכשלה");
    }
  }, [snoozeMut]);

  const { data: elzaData } = trpc.liveEngine.getElzaTrades.useQuery(undefined, { refetchInterval: 15000 });
  const { data: lastScan } = trpc.liveEngine.getLastScanStats.useQuery(undefined, { refetchInterval: 30_000 });

  // ── Live cycle progress (manual OR auto) — polls getCycleProgress ~1s while active ──
  const cycleProgress = useCycleProgress(manualCycleRunning);
  const cycleIsRunning = cycleProgress.running || manualCycleRunning;
  // On finish (running → false), pull getCycleSummary and open the side panel.
  const prevRunningRef = useRef(false);
  const cycleSummaryQuery = (trpc as any).liveEngine.getCycleSummary.useQuery(undefined, {
    enabled: false, retry: false,
  });
  useEffect(() => {
    if (prevRunningRef.current && !cycleProgress.running) {
      // cycle just finished — fetch summary + reveal panel
      cycleSummaryQuery.refetch().then((r: any) => {
        if (r?.data) { setCycleSummaryData(r.data as CycleSummary); setSummaryPanelOpen(true); }
      }).catch(() => { /* pre-merge: summary not yet available */ });
    }
    prevRunningRef.current = cycleProgress.running;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycleProgress.running]);

  // Pull IBKR orders for ALL tabs (POS/SL/TP/PEND/FILL/CANC)
  // ── Unified orders query — 1 request, client-side filtering (6→1 req, 20s→5s) ──
  const { data: allOrdersRaw } = trpc.liveEngine.getAllLiveOrders.useQuery(undefined, { refetchInterval: WAR_ROOM_POLL_MS });
  const allOrders = allOrdersRaw ?? [];

  // Client-side tab filtering (same logic as server had)
  const ordersAll  = allOrders;
  const ordersSL   = allOrders.filter(o => { const t = o.orderType; const st = o.status; const isActive = st === "PreSubmitted" || st === "Submitted"; return (t === "STP" || t === "STOP" || t.startsWith("STOP") || t.startsWith("TRAIL")) && isActive; });
  const ordersTP   = allOrders.filter(o => { const t = o.orderType; const st = o.status; const isActive = st === "PreSubmitted" || st === "Submitted"; return (t === "LMT" || t === "LIMIT") && isActive; });
  const ordersPEND = allOrders.filter(o => { const st = o.status; return st === "PreSubmitted" || st === "Submitted"; });
  const ordersFILL = allOrders.filter(o => { const st = o.status; return st === "Filled" || st === "PartiallyFilled"; });
  const ordersCANC = allOrders.filter(o => { const st = o.status; return st === "Cancelled" || st === "Inactive"; });

  // ── Mutations ────────────────────────────────────────────────────────────────
  const requestActionToken = trpc.liveEngine.requestActionToken.useMutation();

  const runDestructiveAction = useCallback(async (
    action: "emergency_exit" | "stop_buy" | "engine_off",
    run: (confirmToken: string) => void,
  ) => {
    try {
      const { confirmToken } = await requestActionToken.mutateAsync({ action });
      run(confirmToken);
    } catch (err) {
      toastMutationError(err, "Confirmation failed");
    }
  }, [requestActionToken]);

  // Refresh "Upcoming Candidates" now handled by <RefreshCandidatesButton/> (Feature 1).
  const updCfg   = trpc.liveEngine.updateConfig.useMutation({ onSuccess: () => refetch() });
  const closeP   = trpc.liveEngine.closePosition.useMutation({
    onMutate: (variables) => {
      const t = (variables.ticker ?? "").toUpperCase();
      if (!t) return;
      setOrderPopupData({
        orderId: null,
        ticker: t,
        side: "SELL",
        quantity: 0,
        orderType: "LMT",
        sentAt: new Date(),
        ibkrMessage: "שולח פקודת חיסול מהיר ל-IBKR...",
        intentLabel: "חיסול מהיר 100%",
        trackPositionClose: true,
      });
      setOrderPopupOpen(true);
    },
    onSuccess: (data, variables) => {
      setClosingId(null);
      const ticker = (variables.ticker ?? orderPopupData?.ticker ?? "").toUpperCase();
      if (data?.success) {
        const qty = (data as { quantity?: number }).quantity ?? 0;
        setOrderPopupData({
          orderId: (data as { orderId?: string | null }).orderId ?? null,
          ticker,
          side: ((data as { side?: string }).side ?? "SELL") as "BUY" | "SELL",
          quantity: qty,
          orderType: (data as { orderType?: string }).orderType ?? "LMT",
          sentAt: new Date(),
          ibkrMessage: data.reason ?? null,
          intentLabel: "חיסול מהיר 100%",
          trackPositionClose: true,
          protection: protectionFromResponse(data as { sl?: number; tp?: number; stopLoss?: number; takeProfit?: number }),
        });
        setOrderPopupOpen(true);
      } else {
        setOrderPopupData({
          orderId: null,
          ticker,
          side: "SELL",
          quantity: 0,
          orderType: "LMT",
          sentAt: new Date(),
          ibkrMessage: data?.reason ?? "מכירה נכשלה",
          intentLabel: "חיסול מהיר 100%",
          immediateStatus: "failed",
          trackPositionClose: false,
        });
        setOrderPopupOpen(true);
        refetch();
      }
    },
    onError:   (e, variables) => {
      setClosingId(null);
      const msg = e.message.includes("Unexpected token") || e.message.includes("<html")
        ? "שגיאת תקשורת עם השרת — נסה שוב בעוד כמה שניות"
        : e.message;
      const fallbackTicker = (variables?.ticker ?? "").toUpperCase();
      setOrderPopupData((prev) => ({
        orderId: null,
        ticker: prev?.ticker || fallbackTicker,
        side: "SELL",
        quantity: prev?.quantity ?? 0,
        orderType: prev?.orderType ?? "LMT",
        sentAt: prev?.sentAt ?? new Date(),
        ibkrMessage: msg,
        intentLabel: prev?.intentLabel ?? "חיסול מהיר 100%",
        immediateStatus: "failed",
        trackPositionClose: false,
      }));
      setOrderPopupOpen(true);
    },
  });
  const liquidatePosition = useCallback((positionId: number, ticker: string) => {
    setClosingId(positionId);
    closeP.mutate({ ticker });
  }, [closeP]);

  const requestLiquidateConfirm = useCallback((id: number, ticker: string) => {
    if (orderPopupOpen) {
      toast.error("יש פקודה פתוחה — בדוק ב-IBKR לפני שליחה חוזרת");
      return;
    }
    setLiquidateConfirm({ id, ticker });
  }, [orderPopupOpen]);
  const exitAll  = trpc.liveEngine.emergencyExit.useMutation({
    onSuccess: () => { refetch(); toast.success("Emergency exit sent"); },
    onError:   (e) => toastMutationError(e, "Emergency exit failed"),
  });
  const pauseBuy = trpc.liveEngine.pauseBuying.useMutation({ onSuccess: () => refetch() });
  const [cycleRunning, setCycleRunning] = useState(false);
  const runCycle = trpc.insights.runWarEngine.useMutation({
    onMutate: () => setCycleRunning(true),
    onSuccess: (res: any) => {
      setCycleRunning(false);
      const regime = res?.regimeDecision ?? res?.regime ?? "—";
      const scanned = res?.scanned ?? 0;
      const entered = res?.entered ?? 0;
      if (scanned === 0 && (regime === "busy" || regime === "cooldown" || regime === "manual_cooldown")) {
        toast.info(
          regime === "busy"
            ? "⏳ סייקל כבר רץ ברקע — המתן לסיום המחזור האוטומטי"
            : regime === "manual_cooldown"
            ? "⏳ המתן 30 שניות בין הרצות ידניות"
            : "⏳ cooldown 20 דק׳ — המחזור האחרון כבר רץ; המועמדים בטבלה מעודכנים",
        );
      } else {
        toast.success(`✅ סייקל הושלם — נסרקו ${scanned} נכסים | כניסות: ${entered} | רג'ים: ${regime}`);
      }
      refetch();
    },
    onError: (e: any) => { setCycleRunning(false); toast.error("שגיאה בהרצת סייקל: " + e.message); },
  });

  // ── Stop New Buys ────────────────────────────────────────────────────────
  const { data: stopBuysData, refetch: refetchStopBuys } = trpc.liveEngine.getStopNewBuys.useQuery(undefined, {
    refetchInterval: 30000,
  });
  const buysStopped = stopBuysData?.stopped ?? false;
  const [buyStopOptimistic, setBuyStopOptimistic] = useState<boolean|null>(null);
  const effectiveBuysStopped = buyStopOptimistic !== null ? buyStopOptimistic : buysStopped;
  const toggleStopBuys = trpc.liveEngine.setStopNewBuys.useMutation({
    onSuccess: () => { setBuyStopOptimistic(null); refetchStopBuys(); },
    onError:   (e) => { setBuyStopOptimistic(null); toastMutationError(e, "Stop buys failed"); },
  });

  // Circuit Breaker + Short Trading — for bottom control panel
  const { data: cb }    = trpc.liveEngine.getLiveCircuitBreaker.useQuery(undefined, { refetchInterval: 15000 });
  const { data: short } = trpc.liveEngine.getAllowShort.useQuery(undefined, { refetchInterval: 30000 });
  const { data: blk }   = trpc.liveEngine.getBlockedTickers.useQuery(undefined, { refetchInterval: 30000 });
  const setShort = trpc.liveEngine.setAllowShort.useMutation({ onSuccess: () => refetch() });


  // ── Derived state ────────────────────────────────────────────────────────────
  const cfg      = data?.config;
  const summ     = data?.summary;
  const rawPos   = data?.positions ?? [];
  const engineOn = (cfg?.isEnabled ?? 0) === 1;
  const effectiveEngineOn = engineOnOptimistic !== null ? engineOnOptimistic : engineOn;
  const maxPos   = cfg?.maxPositions ?? 12;
  const nlv      = summ?.liveNlv ?? cfg?.totalNlv ?? 0;
  const ibkrConnected = (data as { ibkrConnected?: boolean | null })?.ibkrConnected ?? null;
  const ibkrSessionActive = (data as { ibkrSessionActive?: boolean | null })?.ibkrSessionActive ?? null;
  const brokerageStealGrace = (data as { brokerageStealGrace?: boolean })?.brokerageStealGrace ?? false;
  const brokerageStealGraceRemainingSec = (data as { brokerageStealGraceRemainingSec?: number })?.brokerageStealGraceRemainingSec ?? 0;
  const dbFallbackCount = (data as { dbFallbackCount?: number })?.dbFallbackCount ?? 0;
  const ibkrMarketOpen = (data as { ibkrMarketOpen?: boolean })?.ibkrMarketOpen ?? false;
  const allIbkrOrders: any[] = ordersAll ?? [];

  // Sync allocPct from config
  // Sync all config fields from DB on load/refetch
  // Sync config values from DB — only on first successful load
  useEffect(() => {
    if (!cfg || cfgInitialized.current) return;
    cfgInitialized.current = true;
    setAllocPct(cfg.allocatedPct ?? 50);
    setIntradayLev(cfg.intradayMultiplier ?? 3.9);
    setOvernightLev(cfg.overnightMultiplier ?? 1.9);
    setMinPosUsd((cfg as any).minPositionUsd ?? 2000);
    setMaxPosUsd((cfg as any).maxPositionUsd ?? 25000);
    setMaxPos2(cfg.maxPositions ?? 12);
    setMaxLong2((cfg as any).maxLongPositions  ?? 12);
    setMaxShort2((cfg as any).maxShortPositions ?? 6);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg]);

  // Build rows
  const rows = useMemo(() => rawPos.map(p => {
    const liveCurr = (p as any).currentPrice;
    const fromIbkr = (p as any).signal === "IBKR_LIVE";
    const curr  = liveCurr ?? p.entryPrice;
    const stale = liveCurr == null || !fromIbkr;
    const value = (p as any).marketValueSigned ?? (p.direction === "short" ? -curr * p.units : curr * p.units);
    const pnlUsd= (p as any).unrealizedPnl ?? null;
    // pnlPct: prefer broker-authoritative unrealizedPnl (already correctly signed) over a client recompute; guard /0.
    const costBasis = (p.entryPrice ?? 0) * Math.abs(p.units ?? 0);
    const pnlPct= stale ? null
      : (pnlUsd != null && costBasis > 0)
        ? (pnlUsd / costBasis) * 100
        : (p.entryPrice > 0 ? (((curr - p.entryPrice) / p.entryPrice) * 100) * (p.direction === "short" ? -1 : 1) : null);
    const dailyPctPosition = (p as any).dailyPctPosition ?? null;
    const dailyPnlUsd = (p as any).dailyPnlUsd ?? null;
    const absValue = Math.abs(value);
    return {
      id: p.id, ticker: p.ticker, direction: p.direction,
      units: p.units, entry: p.entryPrice, curr, value, absValue,
      pnlUsd, stale,
      pnlPct,
      dailyPct: dailyPctPosition,
      dailyUsd: dailyPnlUsd,
      sl: p.currentSl != null ? Number(p.currentSl) : null, tp: p.currentTp != null ? Number(p.currentTp) : null,
      sector: (p as any).sector ?? null,
      zivHScore: (p as any).zivHScore ?? null,
      zivHTier: (p as any).zivHTier ?? null,
      zivHPhase: (p as any).zivHPhase ?? null,
      zivHSlDistance: (p as any).zivHSlDistance ?? null,
      zivHSuggestedAction: (p as any).zivHSuggestedAction ?? null,
      zivEngineScore: (p as any).zivEngineScore ?? null,
      zivH: (p as any).zivH ?? null,
      opened: p.openedAt?.toString() ?? null,
      pnl: pnlUsd,
      ibkrTpOrderId: p.ibkrTpOrderId ?? null,
      ibkrSlOrderId: (p as any).ibkrSlOrderId ?? null,
      // Ghost Slots (G-S2): freed slot, exposure still live at BE. Optional-chained —
      // safe whether or not backhand's getStatus fields have landed.
      slotGhost: (p as any).slotGhost ?? 0,
      countsTowardSlot: (p as any).countsTowardSlot ?? 1,
    };
  }), [rawPos]);

  const analysisRow = useMemo(
    () => (analysisTicker ? rows.find((r) => r.ticker === analysisTicker) ?? null : null),
    [analysisTicker, rows],
  );

  // Sort
  const sorted = useMemo(() => [...rows]
    .filter((r) => !snoozedTickers.has(r.ticker))
    .sort((a,b) => {
    const mul = sortDir === "asc" ? 1 : -1;
    const av = a[sortCol as keyof typeof a] as any;
    const bv = b[sortCol as keyof typeof b] as any;
    if (av == null && bv == null) return 0;
    if (av == null) return 1; if (bv == null) return -1;
    if (typeof av === "string") return mul * av.localeCompare(bv);
    return mul * (av - bv);
  }), [rows, sortCol, sortDir, snoozedTickers]);

  function doSort(col: ColKey) {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("desc"); }
  }

  // Summary row — gross exposure (long + |short|), not signed net (IBKR totalHolding SSOT)
  const sumGrossVal    = summ?.totalHolding ?? rows.reduce((s, r) => s + r.absValue, 0);
  const sumAvgVal      = rows.length > 0 ? rows.reduce((s, r) => s + r.absValue, 0) / rows.length : 0;
  const sumTotalPnlUsd = rows.reduce((s,r) => s + (r.pnlUsd ?? 0), 0);
  const sumAvgPnlPct   = rows.length > 0 ? rows.reduce((s,r) => s + (r.pnlPct ?? 0), 0) / rows.length : 0;
  const sumTotalDailyUsd = rows.reduce((s,r) => s + (r.dailyUsd ?? 0), 0);
  const sumAvgDailyPct = rows.length > 0 && rows.some(r => r.dailyPct != null)
    ? rows.reduce((s,r) => s + (r.dailyPct ?? 0), 0) / rows.filter(r => r.dailyPct != null).length
    : 0;
  const sumAvgDailyUsd = rows.length > 0 ? sumTotalDailyUsd / rows.length : 0;
  // Account daily (IBKR /pnl) — SSOT for summary row; row sum is open-positions only.
  const accountDailyUsd = summ?.dailyPnlUsd ?? sumTotalDailyUsd;
  const accountDailyPct = summ?.dailyPnlPct ?? sumAvgDailyPct;

  // Summary stats
  const unreal  = rows.reduce((s,r) => s + (r.pnlUsd ?? 0), 0);
  const real    = (elzaData as any)?.totalRealizedPnl ?? 0;
  // Monthly P&L — IBKR NAV based (currentNlv - startOfMonthNlv)
  const monthlyStartNlv = summ?.monthlyStartNlv ?? summ?.totalNlv ?? 0;
  const grand   = summ?.liveNlv != null ? summ.liveNlv - monthlyStartNlv : 0;  // MTD P&L from IBKR (0 while loading)
  const grandPct = monthlyStartNlv > 0 ? (grand / monthlyStartNlv) * 100 : 0;
  const alloc   = summ?.totalHolding ?? 0; // M-02: show $0 when no open positions (no fallback to budget)
  const allocPctLive = nlv > 0 ? (alloc / nlv) * 100 : 0;
  const gPct    = grandPct;
  const pendCount = (ordersPEND?.length ?? 0);
  const staleRowCount = rows.filter(r => r.stale).length;

  // ── Slots breakdown (G-S2): active / ghost / free ──────────────────────────
  // Prefer engine aggregate counts if backhand exposes them; else derive per-position.
  // Graceful when fields absent: ghostSlots=0 → no breakdown chip, single count stays.
  const slotCap = maxLong2 + maxShort2;
  const ghostSlots =
    (data as any)?.ghostSlots ??
    rows.filter(r => Number((r as any).slotGhost) === 1).length;
  const activeSlots =
    (data as any)?.activeSlots ??
    rows.filter(r => Number((r as any).slotGhost) !== 1 && Number((r as any).countsTowardSlot) !== 0).length;
  const freeSlots = Math.max(0, slotCap - activeSlots);
  const hasGhostData = rows.some(r => (r as any).slotGhost != null) || (data as any)?.ghostSlots != null;
  const syncLive = ibkrConnected !== false && ibkrSessionActive !== false
    && !brokerageStealGrace && dbFallbackCount === 0 && staleRowCount === 0;
  const syncDegraded = !syncLive && ibkrConnected !== false;

  // Orders display by tab
  const displayOrders: any[] = orderTab === "SL" ? (ordersSL ?? [])
    : orderTab === "TP"   ? (ordersTP   ?? [])
    : orderTab === "PEND" ? (ordersPEND ?? [])
    : orderTab === "FILL" ? (ordersFILL ?? [])
    : orderTab === "CANC" ? (ordersCANC ?? [])
    : [];

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <WarRoomErrorBoundary>
    <div className="min-h-screen bg-[#F4F6F8] text-foreground" dir="ltr">

      {/* HEADER */}
      <header className="sticky top-0 z-30 bg-white border-b px-3 sm:px-6 py-2 shadow-sm">
        {/* ── Responsive: 2-row mobile / 1-row desktop ── */}
        <div className="flex items-center justify-between gap-2">
          {/* Title */}
          <div className="flex items-center gap-2 min-w-0">
            <Shield className="w-4 h-4 text-gray-700 shrink-0"/>
            <span className="font-bold text-sm sm:text-base tracking-tight whitespace-nowrap">חדר מלחמה</span>
            {(data as any)?.account?.label && (
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
                {(data as any).account.label}
              </span>
            )}
            {!isAccountScoped && (tradingAccounts?.length ?? 0) > 1 && (
              <select
                className="text-xs font-bold border rounded-md px-2 py-1 bg-white"
                value={activeSlug}
                onChange={(e) => setActiveSlug(e.target.value)}
                aria-label="Trading account"
              >
                {tradingAccounts!.map((a) => (
                  <option key={a.slug} value={a.slug}>{a.label}</option>
                ))}
              </select>
            )}
            <span className="hidden md:inline text-[11px] text-gray-500 font-medium">• בקרה בזמן אמת</span>
          </div>
          {/* Sync indicator */}
          <div className="flex items-center gap-1.5 shrink-0">
            <span className={cn(
              "w-2 h-2 rounded-full shrink-0",
              isLoading ? "bg-amber-400 animate-pulse"
              : syncLive ? "bg-emerald-500"
              : ibkrConnected === false ? "bg-red-500 animate-pulse"
              : "bg-amber-500 animate-pulse",
            )}/>
            <span className={cn(
              "text-xs font-bold",
              isLoading ? "text-amber-600"
              : syncLive ? "text-emerald-600"
              : ibkrConnected === false ? "text-red-600"
              : "text-amber-600",
            )}>
              {isLoading ? "SYNC…" : syncLive ? "SYNC" : ibkrConnected === false ? "OFFLINE" : "DEGRADED"}
            </span>
            <span className="hidden lg:inline"><HeaderClock /></span>
          </div>
          {/* Buttons */}
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="outline"
              size="sm"
              className="h-10 px-2 sm:px-3 text-[11px] font-bold border-emerald-400 text-emerald-700 hover:bg-emerald-50 gap-1"
              onClick={() => runCycle.mutate()}
              disabled={cycleRunning}
              title="הרץ סייקל WarEngine עכשיו"
            >
              {cycleRunning ? <Loader2 className="w-3 h-3 animate-spin"/> : <Play className="w-3 h-3"/>}
              <span className="hidden sm:inline">{cycleRunning ? "רץ…" : "RUN"}</span>
            </Button>
            <LastUpdateRefreshButton
              onRefresh={handleWarRoomRefresh}
              refreshing={portfolioRefreshing || isLoading}
              lastUpdated={lastUpdated ?? lastFetch}
            />
          </div>
        </div>
        {/* Row 2 mobile: Period chip */}
        <div className="flex items-center gap-2 sm:hidden mt-1">
          <div className="flex items-center gap-1.5 bg-gray-100 rounded-lg px-2.5 py-1 text-xs font-semibold text-gray-600">
            <span>📅 החודש הנוכחי</span>
          </div>
        </div>
      </header>

      {ibkrConnected === false && (
        <div className="sticky top-0 z-40 min-h-[44px] flex items-center gap-2 px-4 py-2 bg-red-600 text-white text-sm font-semibold">
          <WifiOff className="w-4 h-4 animate-pulse shrink-0" />
          <span>IBKR מנותק — אין סנכרון פוזיציות בזמן אמת</span>
          <span className="ml-auto text-[11px] opacity-80">
            {ibkrMarketOpen ? "שוק פתוח — נדרשת פעולה" : "שוק סגור — יסונכרן עם פתיחה"}
          </span>
        </div>
      )}

      {ibkrConnected !== false && syncDegraded && (
        <div className="sticky top-0 z-40 min-h-[44px] flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 bg-amber-500 text-white text-sm font-semibold">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>
            {brokerageStealGrace
              ? `IBKR Mobile פעיל — חלון grace (${Math.max(0, brokerageStealGraceRemainingSec)}s) · מחירים עלולים להיות לא מעודכנים`
              : ibkrSessionActive === false
                ? "סשן IBKR לא פעיל — מחירים מ-DB/היסטוריה"
                : dbFallbackCount > 0
                  ? `פוזיציות מ-DB (${dbFallbackCount}) — IBKR positions ריק`
                  : staleRowCount > 0
                    ? `מחירים לא מאומתים ב-${staleRowCount} פוזיציות`
                    : "סנכרון מחירים מוגבל — בדוק IBKR"}
          </span>
          <span className="ml-auto text-[11px] opacity-90">סגור IBKR במובייל לשחזור מיידי</span>
        </div>
      )}

      {/* LIVE CYCLE PROGRESS — visible whenever a scan/cycle runs (manual or auto) */}
      <CycleProgressStrip progress={cycleProgress} />

      {/* LEVERAGE COCKPIT — safety-critical: LIVE GROSS + Intraday Power Dial + TRIM-to-1.9× */}
      <WarRoomCockpit data={data} isLoading={isLoading} />

      {/* METRICS RIBBON — Daily P&L hero, terminal hierarchy */}
      <WarRoomMetricsRibbon
        isLoading={isLoading}
        grand={grand}
        gPct={gPct}
        dailyPnl={summ?.dailyPnlUsd ?? 0}
        dailyPct={summ?.dailyPnlPct ?? 0}
        realized={real}
        nlv={summ?.liveNlv ?? nlv}
        alloc={alloc}
        allocPctLive={allocPctLive}
        cashElza={summ?.elzaCashBalance ?? 0}
        leverageRatio={(summ as any)?.leverage?.gross ?? (summ?.liveNlv && summ?.totalHolding ? +(summ.totalHolding / summ.liveNlv) : 1)}
        marginCash={summ?.liveNlv && summ?.totalHolding ? Math.max(0, summ.totalHolding - summ.liveNlv) : 0}
        leverageNet={(summ as any)?.leverage?.net ?? 0}
        leverageLong={(summ as any)?.leverage?.longX ?? 0}
        leverageShort={(summ as any)?.leverage?.shortX ?? 0}
        monthlyStartNlv={monthlyStartNlv}
        rowsCount={rows.length}
        monthlyWinStats={(elzaData as any)?.monthlyWinStats}
        elzaV45LiveEnabled={(cfg as any)?.elzaV45LiveEnabled ?? 0}
        intradayMultiplier={(cfg as any)?.intradayMultiplier ?? intradayLev}
        zivRotationFlushEnabled={(cfg as any)?.zivRotationFlushEnabled ?? 0}
      />
      <BuyingPowerStrip summ={summ} alloc={alloc}/>

      {/* MAIN LAYOUT — full width, table first */}
      <div className="px-3 sm:px-6 py-4">
        <div className="max-w-[1600px] mx-auto">
          <div className="w-full">

            {/* Tab bar — Positions + last engine scan / logs link */}
            <div className="flex items-center gap-2 mb-3 overflow-x-auto pb-1" style={{scrollbarWidth:"none"}}>
              <button
                className="px-4 py-1.5 rounded-full text-sm font-semibold bg-gray-900 text-white whitespace-nowrap shrink-0">
                Positions ({rows.length}/{maxLong2 + maxShort2})
              </button>
              {hasGhostData && (
                <SlotsBreakdownChip active={activeSlots} ghost={ghostSlots} free={freeSlots} />
              )}
              <span className="text-[11px] text-gray-500 font-mono whitespace-nowrap shrink-0 hidden sm:inline">
                עודכן: {lastFetch ? fmtTime(lastFetch) : "—"} · כל {WAR_ROOM_POLL_MS / 1000}s
              </span>
              {lastScan && (
                <span className="text-[11px] text-gray-500 whitespace-nowrap shrink-0 hidden sm:inline">
                  סריקה אחרונה: {lastScan.scanned} נכסים · {lastScan.entered} כניסות · {lastScan.regime}
                  {lastScan.at && ` · ${new Date(lastScan.at).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}`}
                </span>
              )}
              <Link href="/logs" className="ms-auto text-[11px] font-semibold text-[#2563EB] hover:underline whitespace-nowrap shrink-0 min-h-[44px] flex items-center px-2">
                לוגים →
              </Link>
            </div>

            {/* POSITIONS TAB */}
            <>
                {/* Order sub-tabs */}
                <div className="flex items-center gap-1.5 mb-3 overflow-x-auto pb-1" style={{scrollbarWidth:"none"}}>
                  {ORDER_TABS.map(t => {
                  const tabCount = t.key === "POS"  ? rows.length
                    : t.key === "SL"   ? allIbkrOrders.filter((o:any) => { const tp = (o.orderType??"").toUpperCase(); return (tp==="STP"||tp==="STOP"||tp.startsWith("STOP")||tp.startsWith("TRAIL")) && (o.status==="Submitted"||o.status==="PreSubmitted"); }).length
                    : t.key === "TP"   ? allIbkrOrders.filter((o:any) => { const tp = (o.orderType??"").toUpperCase(); return (tp==="LMT"||tp==="LIMIT") && (o.status==="Submitted"||o.status==="PreSubmitted"); }).length
                    : t.key === "PEND" ? allIbkrOrders.filter((o:any) => o.status==="Submitted"||o.status==="PreSubmitted").length
                    : t.key === "FILL" ? allIbkrOrders.filter((o:any) => o.status==="Filled"||o.status==="PartiallyFilled").length
                    : t.key === "CANC" ? allIbkrOrders.filter((o:any) => o.status==="Cancelled"||o.status==="Inactive").length
                    : 0;
                  return (
                    <button key={t.key} onClick={() => setOrderTab(t.key)}
                      className={cn("px-3 py-2.5 min-h-[44px] flex items-center rounded-full text-xs font-bold border transition-colors whitespace-nowrap shrink-0 flex items-center gap-1",
                        orderTab === t.key
                          ? t.key==="POS"  ? "bg-violet-600 text-white border-violet-600"
                          : t.key==="SL"   ? "bg-red-500 text-white border-red-500"
                          : t.key==="TP"   ? "bg-emerald-500 text-white border-emerald-500"
                          : t.key==="PEND" ? "bg-amber-500 text-white border-amber-500"
                          : "bg-gray-900 text-white border-gray-900"
                          : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50")}>
                      {t.label}
                      {tabCount > 0 && (
                        <span className={cn("text-[9px] font-bold rounded-full px-1 min-w-[16px] text-center leading-tight",
                          orderTab === t.key ? "bg-white/30 text-white" : "bg-gray-100 text-gray-600")}>
                          {tabCount}
                        </span>
                      )}
                    </button>
                  );
                })}
                </div>

                {/* Orders view (non-POS tabs) */}
                {orderTab !== "POS" && (
                  <div className="rounded-xl border border-gray-200 overflow-hidden bg-white shadow-sm mb-3">
                    {displayOrders.length === 0
                      ? <div className="py-10 text-center text-sm text-muted-foreground">אין פקודות {orderTab}</div>
                      : <div className="overflow-x-auto">
                          <Table>
                            <TableHeader>
                              <TableRow className="bg-[#F4F6F8]">
                                {["Ticker","Side","Type","Qty","Price","Status"].map(h => (
                                  <TableHead key={h} className="text-xs font-bold uppercase text-slate-500 whitespace-nowrap px-3">{h}</TableHead>
                                ))}
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {displayOrders.map((o:any, i:number) => (
                                <TableRow key={i} className="border-b border-gray-100">
                                  <TableCell className="py-2.5 pl-3 font-mono font-bold text-sm">{o.ticker}</TableCell>
                                  <TableCell className="py-2.5">
                                    <Badge variant="outline" className={cn("text-[10px] font-mono",
                                      (o.side??"").startsWith("B") ? "text-emerald-600 border-emerald-200" : "text-red-600 border-red-200")}>
                                      {o.side}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="py-2.5 text-xs font-mono text-muted-foreground">{o.orderType}</TableCell>
                                  <TableCell className="py-2.5 text-right pr-3 font-mono text-sm">{o.qty}</TableCell>
                                  <TableCell className="py-2.5 text-right pr-3 font-mono text-sm">{o.price != null ? fmt$(parseFloat(o.price),2) : "MKT"}</TableCell>
                                  <TableCell className="py-2.5 text-xs text-muted-foreground">{o.status}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                    }
                  </div>
                )}

                {/* Positions */}
                <div className="rounded-xl border border-gray-200 overflow-hidden bg-white shadow-sm">
                  {isLoading
                    ? <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground">
                        <Loader2 className="w-5 h-5 animate-spin"/><span>טוען...</span>
                      </div>
                    : rows.length === 0
                    ? <div className="flex flex-col items-center py-16 gap-3">
                        <Activity className="w-10 h-10 text-muted-foreground/20"/>
                        <p className="text-base font-semibold text-muted-foreground">אין פוזיציות פעילות</p>
                        <p className="text-sm text-muted-foreground/50">{engineOn ? "Engine פעיל — ממתין לסיגנל" : "Engine כבוי"}</p>
                      </div>
                    : <>
                          {/* MOBILE: card view */}
                          <div className="md:hidden divide-y divide-gray-100">
                            {sorted.map((r,idx) => (
                              <div key={r.id} className={cn("px-4 py-3", r.pnlUsd < 0 ? "bg-red-50/20" : r.pnlUsd > 0 ? "bg-emerald-50/10" : "")}>
                                <div className="flex items-center flex-wrap gap-2 mb-1.5">
                                  <span className="text-[11px] font-mono text-gray-800 w-5">{idx+1}</span>
                                  {r.direction==="short" ? <TrendingDown className="w-3.5 h-3.5 text-red-500 shrink-0"/> : <TrendingUp className="w-3.5 h-3.5 text-emerald-500 shrink-0"/>}
                                  <span className="font-mono font-bold text-base cursor-pointer hover:text-blue-600 hover:underline transition-colors" onClick={()=>openDeepAnalysis(r.ticker)}>{r.ticker}</span>{r.stale && <span title="stale - no live tick" className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"/>}
                                  <Badge variant="outline" className={cn("text-[11px] font-mono",
                                    r.direction==="short"?"border-red-200 text-red-600 bg-red-50":"border-emerald-200 text-emerald-600 bg-emerald-50")}>
                                    {r.direction.toUpperCase()}
                                  </Badge>
                                  {r.zivHScore != null && (
                                    <span title={`ZIV H · ${r.zivHPhase ?? "—"}`} className={cn("text-sm font-bold ml-1", healthTone(r.zivHScore))}>
                                      ❤ {r.zivHScore.toFixed(1)}
                                    </span>
                                  )}
                                  {Number((r as any).slotGhost) === 1 && <GhostChip />}
                                  <div className="flex-1"/>
                                  <SnoozeButton ticker={r.ticker} onSnooze={snoozeTicker} held />
                                  <HoldToConfirmButton
                                    title="חיסול מהיר 100% — החזק 0.6 שניות"
                                    className="w-11 h-11 border border-red-200 text-red-500 hover:bg-red-500 hover:text-white"
                                    disabled={orderPopupOpen}
                                    loading={closingId === r.id}
                                    onConfirm={() => liquidatePosition(r.id, r.ticker)}
                                    onKeyboardConfirm={() => requestLiquidateConfirm(r.id, r.ticker)}
                                  >
                                    <span className="text-base font-bold leading-none">×</span>
                                  </HoldToConfirmButton>
                                </div>
                                <div className="grid grid-cols-5 gap-1 text-center">
                                  {[
                                    {l:"Value", v:fmt$(r.absValue), c:""},
                                    {l:"Daily %",  v:fmtPct(r.dailyPct,1), c:pnlToneN(r.dailyPct)},
                                    {l:"Daily $",  v:fmt$(r.dailyUsd),    c:pnlToneN(r.dailyUsd)},
                                    {l:"PNL%",   v:fmtPct(r.pnlPct,1),  c:pnlToneN(r.pnlPct)},
                                    {l:"PNL $",  v:fmt$(r.pnlUsd),       c:pnlToneN(r.pnlUsd)},
                                  ].map(cell => (
                                    <div key={cell.l} className="bg-gray-50 rounded-lg py-1.5">
                                      <div className="text-[10px] text-slate-500 uppercase font-semibold">{cell.l}</div>
                                      <div className={cn("text-sm font-bold font-mono", cell.c)}>{cell.v}</div>
                                    </div>
                                  ))}
                                </div>
                                <div className="flex items-center gap-3 mt-1.5 text-[10px] font-mono">
                                  <div className="flex items-center gap-1">
                                    <SlTpBadge label="SL" ibkrOrders={allIbkrOrders} ticker={r.ticker} units={r.units} type="SL" ibkrOrderId={(r as any).ibkrSlOrderId} direction={(r as any).direction}/>
                                    {r.sl!=null && <span className="text-xs font-mono text-slate-600">{fmt$(r.sl,2)}</span>}
                                  </div>
                                  <div className="flex items-center gap-1">
                                    <SlTpBadge label="TP" ibkrOrders={allIbkrOrders} ticker={r.ticker} units={r.units} type="TP" ibkrOrderId={(r as any).ibkrTpOrderId} direction={(r as any).direction}/>
                                    {r.tp!=null && <span className="text-xs font-mono text-slate-600">{fmt$(r.tp,2)}</span>}
                                  </div>
                                  <span className="ml-auto text-slate-500 truncate max-w-[80px]">{r.sector??""}</span>
                                </div>
                                <div className="text-[10px] font-semibold text-gray-700 font-mono mt-0.5">
                                  {r.units}×{fmt$(r.curr,2)}
                                  {Math.abs(r.entry - r.curr) > 0.005 && (
                                    <span className="text-slate-500 font-normal"> · avg {fmt$(r.entry,2)}</span>
                                  )}
                                  {r.opened && <span className="text-slate-500 font-normal"> · {fmtDate(r.opened)}</span>}
                                </div>
                              </div>
                            ))}
                            {rows.length > 0 && (
                              <div className="px-4 py-3 bg-gray-50 border-t-2 border-gray-200">
                                <div className="grid grid-cols-3 gap-2 text-center">
                                  <div><div className="text-[10px] font-semibold text-gray-700 uppercase font-semibold">Total Value</div><div className="text-sm font-bold font-mono">{fmt$(sumGrossVal)}</div></div>
                                  <div><div className="text-[10px] font-semibold text-gray-700 uppercase font-semibold">Total P&L</div><div className={cn("text-base font-bold font-mono",sumTotalPnlUsd>=0?WR_PNL_POS:WR_PNL_NEG)}>{fmt$(sumTotalPnlUsd)}</div></div>
                                  <div><div className="text-[10px] font-semibold text-gray-700 uppercase font-semibold">Daily P&L</div><div className={cn("text-base font-bold font-mono",accountDailyPct>=0?WR_PNL_POS:WR_PNL_NEG)}>{fmtPct(accountDailyPct,1)}</div></div>
                                </div>
                              </div>
                            )}
                          </div>

                          {/* DESKTOP: table view */}
                          <div className="hidden md:block overflow-x-auto">
                            <Table>
                              <TableHeader>
                                <TableRow className="bg-[#F4F6F8] border-b border-gray-200 select-none hover:bg-[#F4F6F8]">
                                  {COLS.map(c => (
                                    <TableHead key={c.key} onClick={() => !c.noSort && doSort(c.key)}
                                      className={cn("py-2 text-xs font-bold uppercase tracking-wide text-slate-500 whitespace-nowrap border-r border-gray-100 last:border-r-0",
                                        !c.noSort && "cursor-pointer hover:text-gray-700",
                                        c.right ? "text-right pr-3" : "pl-3",
                                        c.key==="num" && "w-8 text-center px-1")}>
                                      <span className="inline-flex items-center">
                                        {c.label}
                                        {!c.noSort && <SortIco d={sortCol===c.key?sortDir:null}/>}
                                      </span>
                                    </TableHead>
                                  ))}
                                  <TableHead className="w-10"/>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {sorted.map((r,idx) => (
                                  <TableRow key={r.id} className={cn("hover:bg-blue-50/30 border-b border-gray-100",
                                    r.pnlUsd<0?"bg-red-50/10":r.pnlUsd>0?"bg-emerald-50/5":"")}>
                                    <TableCell className="py-2 text-center px-1 border-r border-gray-100 w-8">
                                      <span className="text-[11px] font-mono text-gray-800 font-semibold">{idx+1}</span>
                                    </TableCell>
                                    <TableCell className="py-2 pl-3 border-r border-gray-100">
                                      <div className="flex items-center flex-wrap gap-1.5">
                                        {r.direction==="short"?<TrendingDown className="w-3 h-3 text-red-500"/>:<TrendingUp className="w-3 h-3 text-emerald-500"/>}
                                        <span className="font-mono font-bold text-sm cursor-pointer hover:text-blue-600 hover:underline transition-colors" onClick={()=>openDeepAnalysis(r.ticker)}>{r.ticker}</span>
                                        <Badge variant="outline" className={cn("text-[11px] font-mono ml-1",
                                          r.direction==="short"?"border-red-200 text-red-600 bg-red-50":"border-emerald-200 text-emerald-600 bg-emerald-50")}>
                                          {r.direction.toUpperCase()}
                                        </Badge>
                                        {Number((r as any).slotGhost) === 1 && <GhostChip />}
                                      </div>
                                      <div className="text-[11px] text-muted-foreground font-mono">
                                        {r.units}×<FlickerCell value={r.curr} fmt={v=>fmt$(v,2)} className="inline"/>
                                        {Math.abs(r.entry - r.curr) > 0.005 && (
                                          <span className="text-slate-400"> · avg {fmt$(r.entry,2)}</span>
                                        )}
                                      </div>
                                    </TableCell>
                                    <TableCell className="py-2 text-right pr-3 border-r border-gray-100">
                                      <FlickerCell value={r.absValue} fmt={v=>fmt$(v)} className="text-sm"/>
                                      <div className="text-[11px] text-muted-foreground font-mono flex items-center justify-end gap-1">
                                        {r.stale && <span title="stale - no live tick" className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"/>}
                                        {r.direction === "short" && <span className="text-red-500 text-[10px] font-semibold">SHORT</span>}
                                      </div>
                                    </TableCell>
                                    <TableCell className="py-2 text-right pr-3 border-r border-gray-100">
                                      <FlickerCell value={r.dailyPct} fmt={v=>fmtPct(v)} className={cn("text-base",pnlToneN(r.dailyPct))}/>
                                    </TableCell>
                                    <TableCell className="py-2 text-right pr-3 border-r border-gray-100">
                                      <FlickerCell value={r.dailyUsd} fmt={v=>fmt$(v)} className={cn("text-base",pnlToneN(r.dailyUsd))}/>
                                    </TableCell>
                                    <TableCell className="py-2 text-right pr-3 border-r border-gray-100">
                                      <FlickerCell value={r.pnlPct} fmt={v=>fmtPct(v)} className={cn("text-base",pnlToneN(r.pnlPct))}/>
                                    </TableCell>
                                    <TableCell className="py-2 text-right pr-3 border-r border-gray-100">
                                      <FlickerCell value={r.pnlUsd} fmt={v=>fmt$(v)} className={cn("text-base",pnlToneN(r.pnlUsd))}/>
                                    </TableCell>
                                    <TableCell className="py-2 text-right pr-3 border-r border-gray-100">
                                      <SlTpBadge label="SL" ibkrOrders={allIbkrOrders} ticker={r.ticker} units={r.units} type="SL" ibkrOrderId={(r as any).ibkrSlOrderId} direction={(r as any).direction}/>
                                      {r.sl!=null&&<div className="text-xs font-mono font-medium text-slate-600">{fmt$(r.sl,2)}</div>}
                                    </TableCell>
                                    <TableCell className="py-2 text-right pr-3 border-r border-gray-100">
                                      <SlTpBadge label="TP" ibkrOrders={allIbkrOrders} ticker={r.ticker} units={r.units} type="TP" ibkrOrderId={(r as any).ibkrTpOrderId} direction={(r as any).direction}/>
                                      {r.tp!=null&&<div className="text-xs font-mono font-medium text-slate-600">{fmt$(r.tp,2)}</div>}
                                    </TableCell>
                                    <TableCell className="py-2 text-right pr-3 border-r border-gray-100">
                                      {r.zivHScore!=null
                                        ? <span title={r.zivHTier ?? undefined} className={cn("font-mono font-bold text-base", healthTone(r.zivHScore))}>{r.zivHScore.toFixed(1)}</span>
                                        : <span className="text-gray-300 text-xs">—</span>}
                                    </TableCell>
                                    <TableCell className="py-2 pl-3 border-r border-gray-100">
                                      <span className="text-[11px] text-muted-foreground">{r.sector??""}</span>
                                    </TableCell>
                                    <TableCell className="py-2 text-right pr-3 border-r border-gray-100">
                                      <span className="text-xs text-muted-foreground font-mono">{fmtDate(r.opened)}</span>
                                    </TableCell>
                                    <TableCell className="py-2 pr-2">
                                      <div className="flex items-center justify-end gap-1">
                                        <SnoozeButton ticker={r.ticker} onSnooze={snoozeTicker} held />
                                        <HoldToConfirmButton
                                          title="חיסול מהיר 100% — החזק 0.6 שניות"
                                          className="w-11 h-11 border border-red-200 text-red-500 hover:bg-red-500 hover:text-white"
                                          disabled={orderPopupOpen}
                                          loading={closingId === r.id}
                                          onConfirm={() => liquidatePosition(r.id, r.ticker)}
                                          onKeyboardConfirm={() => requestLiquidateConfirm(r.id, r.ticker)}
                                        >
                                          <span className="text-base font-bold leading-none">×</span>
                                        </HoldToConfirmButton>
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                ))}
                                {rows.length > 0 && (
                                  <TableRow className="bg-gray-50/80 border-t-2 border-gray-200">
                                    <TableCell className="py-2 px-1 border-r border-gray-200 text-center"><span className="text-[9px] font-bold text-slate-500">Σ</span></TableCell>
                                    <TableCell className="py-2 pl-3 border-r border-gray-200"><span className="text-[10px] font-bold text-gray-600 uppercase tracking-wide">SUMMARY</span></TableCell>
                                    <TableCell className="py-2 text-right pr-3 border-r border-gray-200">
                                      <div className="text-xs font-bold font-mono text-gray-800">{fmt$(sumGrossVal)}</div>
                                      <div className="text-[10px] font-semibold text-gray-700 font-mono">avg {fmt$(sumAvgVal)}</div>
                                    </TableCell>
                                    <TableCell className="py-2 text-right pr-3 border-r border-gray-200">
                                      <span className={cn("text-sm font-bold font-mono",accountDailyPct>=0?WR_PNL_POS:WR_PNL_NEG)}>{fmtPct(accountDailyPct)}</span>
                                    </TableCell>
                                    <TableCell className="py-2 text-right pr-3 border-r border-gray-200">
                                      <span className={cn("text-sm font-bold font-mono",accountDailyUsd>=0?WR_PNL_POS:WR_PNL_NEG)}>{fmt$(accountDailyUsd)}</span>
                                    </TableCell>
                                    <TableCell className="py-2 text-right pr-3 border-r border-gray-200">
                                      <span className={cn("text-sm font-bold font-mono",sumTotalPnlUsd>=0?WR_PNL_POS:WR_PNL_NEG)}>{fmt$(sumTotalPnlUsd)}</span>
                                    </TableCell>
                                    <TableCell className="border-r border-gray-200" colSpan={5}/>
                                    <TableCell/>
                                  </TableRow>
                                )}
                              </TableBody>
                            </Table>
                          </div>
                        </>
                  }
                </div>

                {/* ── Candidates (v4.5, LONG-only) — next-scan forecast, refreshes each 20-min cycle ──
                    Rebuilt to consume the v4.5 contract: readinessPct / distanceToTriggerPct /
                    blockReason / abnormalCycle / macroBlocked / score{base,subTotal,total}.
                    Whole-row → Deep Analysis v4.5 (setV45Ticker → deepAnalysisV45 modal). */}
                {orderTab === "POS" && (
                  <div className="mt-3">
                    <WarRoomCandidatesTable
                      candidates={((data as any)?.upcomingSignals ?? []).filter((c: any) => !snoozedTickers.has(c?.ticker))}
                      onTickerClick={(t) => setV45Ticker(t)}
                      onSnooze={(t) => snoozeTicker(t)}
                      watcherStatusMap={(data as any)?.summary?.watcherStatus}
                      selectedTeam={(data as any)?.selectedTeam}
                      openPositionTickers={((data as any)?.positions ?? []).map((p: any) => p?.ticker)}
                      headerExtra={
                        <>
                          <span className="hidden sm:inline text-[10px] font-mono text-slate-400">
                            {(data as any)?.upcomingSignalsTs
                              ? `עודכן ${new Date((data as any).upcomingSignalsTs).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
                              : "מתעדכן כל 20 דק׳"}
                          </span>
                          {/* Feature 1 — Refresh Candidates (contract: refreshCandidates → invalidate table) */}
                          <RefreshCandidatesButton onRefreshed={() => refetch()} />
                          {/* Feature 2 — RUN WAR ROOM (scan-only; distinct from live-fire) */}
                          <RunWarRoomButton
                            running={cycleIsRunning}
                            onStarted={() => setManualCycleRunning(true)}
                            onFinished={(r) => {
                              setManualCycleRunning(false);
                              refetch();
                              const s = r?.summary;
                              if (s) {
                                setCycleSummaryData({
                                  errors: s.errors ?? [],
                                  successes: (s.actions ?? []).length ? s.actions : (s.wouldEnter ?? []).map((w: any) => `${w.ticker} · ${w.route ?? ""} · ${w.score ?? ""}`),
                                  actions: s.actions ?? [],
                                  finishedAt: r?.finishedAt ?? new Date().toISOString(),
                                });
                                setSummaryPanelOpen(true);
                              }
                            }}
                          />
                        </>
                      }
                    />
                  </div>
                )}
              </>


          </div>
        </div>
      </div>


      {/* BOTTOM CONTROL PANEL */}
      <div className="mx-3 sm:mx-6 mt-4 mb-6 rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">

        {/* Top label */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-100 bg-gray-50">
          <span className="text-sm font-bold uppercase tracking-widest text-slate-600">⚙️ לוח בקרה</span>
          <span className="ms-auto text-xs text-slate-400 font-mono">settings · guards · engine</span>
        </div>

        {/* Row 1 — Config boxes */}
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 border-b border-gray-100 divide-x divide-y md:divide-y-0 divide-gray-100">

          {/* גודל פוזיציה */}
          <div className={WR_CTRL_WIDGET}>
            <AllocationBox
              nlv={nlv}
              allocPct={allocPct} setAllocPct={v => { setAllocPct(v); setDirty(true); }}
              minPosUsd={minPosUsd} setMinPosUsd={v => { setMinPosUsd(v); setDirty(true); }}
              maxPosUsd={maxPosUsd} setMaxPosUsd={v => { setMaxPosUsd(v); setDirty(true); }}
              dirty={dirty}
              onSave={() => {
                updCfg.mutate({ allocatedPct: allocPct, minPositionUsd: minPosUsd, maxPositionUsd: maxPosUsd });
                setTimeout(() => setDirty(false), 2000);
              }}
            />
          </div>

          {/* מקס׳ פוזיציות */}
          <div className={WR_CTRL_WIDGET}>
            <MaxPositionsBox
              maxLong={maxLong2}
              maxShort={maxShort2}
              setMaxLong={setMaxLong2}
              setMaxShort={setMaxShort2}
              onSave={(l, s) => {
                updCfg.mutate(
                  { maxPositions: l + s, maxLongPositions: l, maxShortPositions: s },
                  { onSuccess: () => toast.success(`מקס׳ לונג: ${l} | שורט: ${s} ⚔️`) }
                );
              }}
            />
          </div>

          {/* Daily Operations — entries used vs daily cap (read-only gauge) */}
          <div className={WR_CTRL_WIDGET}>
            <div className={cn(WR_CTRL_LABEL, "mb-1")}>פעולות יומיות</div>
            {(() => {
              const used = (data as any)?.summary?.entriesToday ?? 0;
              const cap = (data as any)?.summary?.maxDailyOrders ?? 50;
              const pct = cap > 0 ? used / cap : 0;
              const tone = pct >= 1 ? "text-red-600" : pct >= 0.7 ? "text-amber-600" : WR_CTRL_POS_DARK;
              const bar = pct >= 1 ? "bg-red-600" : pct >= 0.7 ? "bg-amber-500" : "bg-green-700";
              return (
                <>
                  <div className="flex items-baseline gap-1.5 font-mono">
                    <span className={cn("text-2xl font-black tabular-nums", tone)}>{used}</span>
                    <span className="text-base text-slate-500">/ {cap}</span>
                    <span className="text-xs text-slate-400 ms-auto">New Entries</span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-200 overflow-hidden mt-1">
                    <div className={cn("h-full rounded-full transition-all", bar)} style={{ width: `${Math.min(100, pct * 100)}%` }} />
                  </div>
                  {pct >= 1 && <div className="text-xs font-semibold text-red-600 mt-1">⏸ מכסה — כניסות מושהות, ניהול פעיל</div>}
                </>
              );
            })()}
          </div>

          {/* מינוף */}
          <div className={WR_CTRL_WIDGET}>
            <LeverageBox
              intradayLev={intradayLev} overnightLev={overnightLev}
              setIntradayLev={setIntradayLev} setOvernightLev={setOvernightLev}
              onSave={(intraday, overnight) => {
                updCfg.mutate(
                  { intradayMultiplier: intraday, overnightMultiplier: overnight },
                  { onSuccess: () => toast.success("מינוף עודכן ✓  שעות מסחר: ×" + intraday + "  |  לילה: ×" + overnight) }
                );
              }}
            />
          </div>

          {/* SL/TP GUARD */}
          <div className={WR_CTRL_WIDGET}>
            <SlTpSyncBox positions={rows} ibkrOrders={allIbkrOrders} onSyncDone={refetch}/>
          </div>

          {/* CIRCUIT BREAKER */}
          <div className={WR_CTRL_WIDGET}>
            <div className={cn(WR_CTRL_LABEL, "flex items-center gap-2")}>
              {cb?.active
                ? <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse inline-block shrink-0"/>
                : <span className="w-2.5 h-2.5 rounded-full bg-green-700 inline-block shrink-0"/>}
              CIRCUIT BREAKER
            </div>
            {cb ? (
              <div className="flex flex-col gap-1.5 text-sm font-mono mt-1">
                <div className="flex justify-between gap-3">
                  <span className="text-xs text-slate-500 uppercase">Cap</span>
                  <span className="font-bold text-slate-900 tabular-nums">{fmt$(cb.currentCap)}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-xs text-slate-500 uppercase">Deployed</span>
                  <span className={cn("font-bold tabular-nums", cb.active ? "text-red-600" : "text-slate-900")}>
                    {fmt$(cb.totalDeployed)}
                  </span>
                </div>
                {cb.active && (
                  <div className="text-xs font-semibold text-red-700 bg-red-50 rounded-md px-2 py-1.5">
                    ⚠️ OVER LIMIT +{cb.drawdownPct.toFixed(1)}%
                  </div>
                )}
                <div className="text-xs text-slate-500 mt-auto">
                  {cb.isIntraday ? `Intraday ×${cb.multiplier}` : `Overnight ×${cb.multiplier}`}
                </div>
              </div>
            ) : <div className="text-sm text-slate-500">Loading…</div>}
          </div>

          {/* SHORT TRADING */}
          <div className={WR_CTRL_WIDGET}>
            <div className={WR_CTRL_LABEL}>SHORT TRADING</div>
            <div className="flex items-center justify-between gap-3 mt-1">
              <span className="text-sm font-semibold text-slate-700">Allow Short</span>
              <button
                onClick={() => setShort.mutate({ enabled: !short?.enabled })}
                disabled={setShort.isPending}
                className={cn(
                  "relative inline-flex h-7 w-12 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-violet-400/40",
                  short?.enabled ? "bg-violet-600" : "bg-slate-300"
                )}>
                <span className={cn(
                  "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
                  short?.enabled ? "translate-x-6" : "translate-x-1"
                )}/>
              </button>
            </div>
            {blk && blk.length > 0 && (
              <div className="mt-auto pt-1">
                <div className="text-xs text-slate-500 font-semibold uppercase mb-1">חסומים ({blk.length})</div>
                <div className="flex flex-wrap gap-1">
                  {blk.slice(0,5).map((b:any,i:number) => (
                    <span key={i} className="text-xs bg-red-50 text-red-600 font-mono px-1.5 py-0.5 rounded">{b.ticker}</span>
                  ))}
                  {blk.length > 5 && <span className="text-xs text-slate-500">+{blk.length-5}</span>}
                </div>
              </div>
            )}
          </div>

          {/* SYNC + ELZA RETURNS */}
          <div className={cn(WR_CTRL_WIDGET, "col-span-2 md:col-span-1")}>
            <SyncStatusBox lastFetch={lastFetch} isLoading={isLoading} pollSec={WAR_ROOM_POLL_MS / 1000}/>
            <div className="mt-2 pt-2 border-t border-slate-200 flex-1">
              <ElzaPerfBox positions={rows} elzaData={elzaData} monthlyRealizedPnl={summ?.allTimeRealizedPnl ?? 0}/>
            </div>
          </div>

        </div>

        {/* Row 2 — Action buttons */}
        <div className="flex flex-wrap items-center gap-3 px-4 py-4 bg-gray-50/80">
          <span className={cn(WR_CTRL_LABEL, "me-1")}>מנוע</span>

          {/* ENGINE ON/OFF — hold-to-confirm when turning OFF */}
          {effectiveEngineOn ? (
            <HoldToConfirmButton
              className={cn("min-h-12 h-12 px-6 text-sm font-bold rounded-full text-white", WR_CTRL_POS_BG)}
              onConfirm={() => {
                setEngineOnOptimistic(false);
                void runDestructiveAction("engine_off", (confirmToken) => {
                  updCfg.mutate(
                    { isEnabled: 0, confirmToken },
                    {
                      onSuccess: () => { setEngineOnOptimistic(null); refetch(); },
                      onError: (e) => { setEngineOnOptimistic(null); toastMutationError(e, "Engine stop failed"); },
                    },
                  );
                });
              }}
              loading={updCfg.isPending}
              disabled={updCfg.isPending}
            >
              <Zap className="w-4 h-4 me-1.5" />
              ENGINE ON
            </HoldToConfirmButton>
          ) : (
            <Button
              className="min-h-12 h-12 px-6 text-sm font-bold rounded-full bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                setEngineOnOptimistic(true);
                updCfg.mutate({ isEnabled: 1 }, {
                  onSuccess: () => { setEngineOnOptimistic(null); refetch(); },
                  onError: (e) => { setEngineOnOptimistic(null); toastMutationError(e, "Engine start failed"); },
                });
              }}
              disabled={updCfg.isPending}
            >
              {updCfg.isPending ? <Loader2 className="w-4 h-4 animate-spin me-1.5" /> : <Zap className="w-4 h-4 me-1.5" />}
              ENGINE OFF
            </Button>
          )}
          <Button
            className={cn("min-h-12 h-12 px-6 text-sm font-bold rounded-full",
              effectiveEngineOn ? "bg-red-600 hover:bg-red-700 text-white" : cn(WR_CTRL_POS_BG, "text-white"))}
            onClick={() => {
              const willPause = effectiveEngineOn;
              setEngineOnOptimistic(!willPause);
              pauseBuy.mutate({ paused: willPause }, {
                onSuccess: () => { setEngineOnOptimistic(null); refetch(); },
                onError: () => setEngineOnOptimistic(null)
              });
            }} disabled={pauseBuy.isPending}>
            {pauseBuy.isPending ? <Loader2 className="w-4 h-4 animate-spin me-1.5"/> : <span className="w-2.5 h-2.5 rounded-full bg-white/80 me-1.5 inline-block"/>}
            {effectiveEngineOn ? "Full Stop" : "המשך"}
          </Button>

          {/* STOP BUY — hold-to-confirm when enabling stop */}
          {!effectiveBuysStopped ? (
            <HoldToConfirmButton
              className="min-h-12 h-12 px-6 text-sm font-bold rounded-full bg-amber-600 hover:bg-amber-700 text-white"
              onConfirm={() => {
                setBuyStopOptimistic(true);
                void runDestructiveAction("stop_buy", (confirmToken) => {
                  toggleStopBuys.mutate({ stopped: true, confirmToken });
                });
              }}
              loading={toggleStopBuys.isPending}
              disabled={toggleStopBuys.isPending}
            >
              <Ban className="w-4 h-4 me-1.5" />
              STOP BUY
            </HoldToConfirmButton>
          ) : (
            <Button
              className="min-h-12 h-12 px-6 text-sm font-bold rounded-full bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                setBuyStopOptimistic(false);
                toggleStopBuys.mutate({ stopped: false });
              }}
              disabled={toggleStopBuys.isPending}
            >
              {toggleStopBuys.isPending ? <Loader2 className="w-4 h-4 animate-spin me-1.5" /> : <Ban className="w-4 h-4 me-1.5" />}
              🔴 STOP BUY ON
            </Button>
          )}

          <div className="hidden sm:block w-px h-8 bg-gray-200 mx-1"/>

          {/* Emergency Exit — admin global war room only */}
          {!isAccountScoped && (
          <HoldToConfirmButton
            className="min-h-12 h-12 px-6 text-sm font-bold rounded-full border-2 border-red-400 text-red-700 hover:bg-red-600 hover:text-white hover:border-red-600 bg-white"
            ringClassName="text-red-500"
            onConfirm={() => {
              void runDestructiveAction("emergency_exit", (confirmToken) => {
                exitAll.mutate({ confirmToken });
              });
            }}
            loading={exitAll.isPending}
            disabled={exitAll.isPending}
          >
            <span className="me-1.5">💥</span>
            Emergency Exit
          </HoldToConfirmButton>
          )}
        </div>
      </div>

      {/* FOOTER */}
      <div className="text-center pb-6 pt-2">
        <p className="text-xs font-mono text-muted-foreground/50">
          ELZA v1.0 · IBKR {cfg?.accountId || "—"} · MAX {maxPos} POS · SL SOFTWARE-SIDE · DELEVERAGE 22:30
        </p>
      </div>

      {/* ── Deep Analysis Modal ─────────────────────────────── */}
      <DeepAnalysisModal
        ticker={analysisTicker}
        open={analysisTicker !== null}
        onClose={() => setAnalysisTicker(null)}
        navList={sorted.map(r => r.ticker)}
        onNavigate={(t) => setAnalysisTicker(t)}
        holdingContext={analysisRow ? {
          buyPrice: analysisRow.entry,
          units: analysisRow.units,
          currentPrice: analysisRow.curr,
          pnlUsd: analysisRow.pnlUsd ?? 0,
          pnlPct: analysisRow.pnlPct ?? 0,
          stopLoss: analysisRow.sl,
          takeProfit: analysisRow.tp,
        } : undefined}
        prefetchedZivH={analysisRow?.zivH ?? null}
      />

      {/* Feature 5 — Deep Analysis v4.5 (engine verdict) — opened from candidate tickers */}
      <DeepAnalysisV45Modal
        ticker={v45Ticker}
        open={v45Ticker !== null}
        onClose={() => setV45Ticker(null)}
      />

      {/* Feature 4 — Cycle event summary side-panel / drawer */}
      <CycleSummaryPanel
        open={summaryPanelOpen}
        onClose={() => setSummaryPanelOpen(false)}
        summary={cycleSummaryData}
      />

      {orderPopupOpen && orderPopupData && (
        <OrderStatusPopup
          open={orderPopupOpen}
          onClose={() => { setOrderPopupOpen(false); setOrderPopupData(null); refetch(); }}
          orderId={orderPopupData.orderId}
          ticker={orderPopupData.ticker}
          side={orderPopupData.side}
          quantity={orderPopupData.quantity}
          orderType={orderPopupData.orderType}
          sentAt={orderPopupData.sentAt}
          ibkrMessage={orderPopupData.ibkrMessage}
          intentLabel={orderPopupData.intentLabel}
          immediateStatus={orderPopupData.immediateStatus}
          trackPositionClose={orderPopupData.trackPositionClose ?? false}
          protection={orderPopupData.protection}
          onComplete={() => { toast.success(`${orderPopupData.ticker} נסגר — הנייר הוסר`); refetch(); }}
        />
      )}

      <AlertDialog open={!!liquidateConfirm} onOpenChange={(o) => { if (!o) setLiquidateConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>אישור חיסול {liquidateConfirm?.ticker}</AlertDialogTitle>
            <AlertDialogDescription className="text-[11px] leading-snug">
              חיסול מהיר 100% — פעולה בלתי הפיכה. Enter נבחר נתיב אישור זה (ללא החזקה).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-[44px]">ביטול</AlertDialogCancel>
            <AlertDialogAction
              className="min-h-[44px] bg-red-600 hover:bg-red-700"
              onClick={() => {
                if (liquidateConfirm) liquidatePosition(liquidateConfirm.id, liquidateConfirm.ticker);
                setLiquidateConfirm(null);
              }}
            >
              אשר חיסול
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </WarRoomErrorBoundary>
  );
}
