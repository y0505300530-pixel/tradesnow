import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProgressState {
  stage: string;       // "stage1" | "stage2" | "stage3" | "stage4" | "stage5"
  pct: number;         // 0–100
  action: string;      // human-readable action description
  status: string;      // "processing" | "done" | "error" | "pending"
  errorMessage?: string | null;
}

// ─── Parse progress code from errorMessage ───────────────────────────────────

export function parseProgressCode(errorMessage: string | null | undefined, status: string): ProgressState {
  if (status === "done") {
    return { stage: "stage5", pct: 100, action: "Report delivered to the Customer.", status: "done" };
  }
  if (status === "error") {
    const msg = errorMessage?.startsWith("error:") ? errorMessage.slice(6) : (errorMessage ?? "An error occurred.");
    return { stage: "stage1", pct: 0, action: msg, status: "error" };
  }
  if (status === "pending") {
    return { stage: "stage1", pct: 0, action: "Queued — waiting to start...", status: "pending" };
  }

  if (errorMessage?.startsWith("progress:")) {
    const parts = errorMessage.split(":");
    const stage = parts[1] ?? "stage1";
    const pct = parseInt(parts[2] ?? "0", 10);
    const action = parts.slice(3).join(":");
    return { stage, pct, action, status: "processing" };
  }

  const legacyMap: Record<string, ProgressState> = {
    "step:metadata":            { stage: "stage1", pct: 8,  action: "Extracting raw video metadata...", status: "processing" },
    "step:transcript":          { stage: "stage1", pct: 15, action: "Locating caption tracks...", status: "processing" },
    "step:transcript_fallback": { stage: "stage1", pct: 17, action: "Activating Supadata fallback...", status: "processing" },
    "step:analysis":            { stage: "stage3", pct: 50, action: "Running AI analysis...", status: "processing" },
  };
  if (errorMessage && legacyMap[errorMessage]) return legacyMap[errorMessage];

  return { stage: "stage1", pct: 0, action: "Initializing...", status: "processing" };
}

// ─── Stage metadata ───────────────────────────────────────────────────────────

const STAGES = [
  { id: "stage1", label: "Data Acquisition",   heLabel: "איסוף נתונים",    range: [0, 20]  },
  { id: "stage2", label: "Tech Filtering",     heLabel: "סינון טכני",      range: [21, 40] },
  { id: "stage3", label: "Logic Synthesis",    heLabel: "סינתזה לוגית",   range: [41, 70] },
  { id: "stage4", label: "Knowledge Update",   heLabel: "עדכון בסיס ידע",  range: [71, 90] },
  { id: "stage5", label: "Final Delivery",     heLabel: "דוח סופי",       range: [91, 100] },
];

function getStageIndex(stageId: string): number {
  return STAGES.findIndex((s) => s.id === stageId);
}

// ─── Animated fill bar ────────────────────────────────────────────────────────

function FillBar({ pct, status }: { pct: number; status: string }) {
  const [displayed, setDisplayed] = useState(pct);

  useEffect(() => {
    const timer = setTimeout(() => setDisplayed(pct), 50);
    return () => clearTimeout(timer);
  }, [pct]);

  const isError = status === "error";
  const isDone  = status === "done";

  return (
    <div className="relative w-full h-7 rounded bg-gray-100 border border-gray-300 overflow-hidden font-mono text-xs">
      {/* Filled portion */}
      <div
        className={cn(
          "absolute inset-y-0 left-0 transition-all duration-700 ease-out",
          isError ? "bg-red-200" : isDone ? "bg-emerald-200" : "bg-blue-200"
        )}
        style={{ width: `${displayed}%` }}
      />
      {/* Scanline shimmer */}
      {!isError && !isDone && (
        <div
          className="absolute inset-y-0 w-16 bg-gradient-to-r from-transparent via-white/60 to-transparent animate-shimmer"
          style={{ left: `calc(${displayed}% - 2rem)` }}
        />
      )}
      {/* Block characters overlay */}
      <div className="absolute inset-0 flex items-center px-2 gap-0 select-none pointer-events-none">
        <BlockBar pct={displayed} total={28} isError={isError} isDone={isDone} />
        <span className={cn(
          "ml-3 font-bold tabular-nums",
          isError ? "text-[#FF6B6B]" : isDone ? "text-[#65A30D]" : "text-[#2563EB]"
        )}>
          {isDone ? "100" : Math.round(displayed)}%
        </span>
      </div>
    </div>
  );
}

function BlockBar({ pct, total, isError, isDone }: { pct: number; total: number; isError: boolean; isDone: boolean }) {
  const filled = Math.round((pct / 100) * total);
  const blocks = Array.from({ length: total }, (_, i) => i < filled);
  return (
    <span className="tracking-tight">
      {blocks.map((f, i) => (
        <span
          key={i}
          className={cn(
            f
              ? isError
                ? "text-[#FF6B6B]"
                : isDone
                ? "text-[#65A30D]"
                : "text-[#2563EB]"
              : "text-gray-300"
          )}
        >
          {f ? "█" : "░"}
        </span>
      ))}
    </span>
  );
}

// ─── Stage breadcrumb ─────────────────────────────────────────────────────────

function StageBreadcrumb({ currentStageId, status }: { currentStageId: string; status: string }) {
  const currentIdx = getStageIndex(currentStageId);
  const isDone = status === "done";
  const isError = status === "error";

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {STAGES.map((stage, idx) => {
        const isActive  = stage.id === currentStageId && !isDone && !isError;
        const isPast    = idx < currentIdx || isDone;
        const isFuture  = idx > currentIdx && !isDone;

        return (
          <div key={stage.id} className="flex items-center gap-1">
            <div
              className={cn(
                "text-[10px] font-mono px-2 py-0.5 rounded border transition-all duration-300 text-center",
                isActive  && "bg-blue-50 border-[#2563EB] text-[#2563EB] shadow-sm",
                isPast    && "bg-emerald-50 border-emerald-300 text-[#65A30D]",
                isFuture  && "bg-transparent border-gray-200 text-gray-400",
                isError && stage.id === currentStageId && "bg-red-50 border-red-300 text-[#FF6B6B]",
              )}
            >
              <div>{isPast && !isActive ? "✓ " : isActive ? "⟳ " : "  "}{stage.label}</div>
              <div className="text-[9px] opacity-60" dir="rtl">{stage.heLabel}</div>
            </div>
            {idx < STAGES.length - 1 && (
              <span className={cn("text-[10px] font-mono", isPast ? "text-[#65A30D]" : "text-gray-300")}>
                →
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface InstallProgressBarProps {
  errorMessage?: string | null;
  status: string;
  videoTitle?: string | null;
  className?: string;
}

export function InstallProgressBar({ errorMessage, status, videoTitle, className }: InstallProgressBarProps) {
  const progress = parseProgressCode(errorMessage, status);
  const isDone  = status === "done";
  const isError = status === "error";
  const isPending = status === "pending";

  const tickerMatch = progress.action.match(/\$([A-Z]{1,6})/);
  const currentTask = tickerMatch ? progress.action : progress.action;

  return (
    <div className={cn("rounded-lg border border-gray-200 bg-white p-4 font-mono space-y-3 shadow-sm", className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={cn(
            "inline-block w-2 h-2 rounded-full",
            isPending ? "bg-amber-400 animate-pulse" :
            isError   ? "bg-red-500" :
            isDone    ? "bg-emerald-500" :
                        "bg-[#2563EB] animate-pulse"
          )} />
          <span className="text-[11px] text-gray-500 uppercase tracking-widest font-semibold">
            {isPending ? "QUEUED" : isError ? "ERROR" : isDone ? "COMPLETE" : "PROCESSING"}
          </span>
        </div>
        {videoTitle && (
          <span className="text-[10px] text-gray-400 truncate max-w-[200px]" title={videoTitle}>
            {videoTitle}
          </span>
        )}
      </div>

      {/* Stage breadcrumb */}
      {!isPending && <StageBreadcrumb currentStageId={progress.stage} status={status} />}

      {/* Progress bar */}
      <FillBar pct={isDone ? 100 : isPending ? 0 : progress.pct} status={status} />

      {/* Current action */}
      <div className={cn(
        "text-[11px] leading-relaxed",
        isError ? "text-[#FF6B6B]" : isDone ? "text-[#65A30D]" : "text-gray-500"
      )}>
        <span className={cn(
          "font-bold mr-1",
          isError ? "text-[#FF6B6B]" : isDone ? "text-[#65A30D]" : "text-[#2563EB]"
        )}>
          {isError ? "ERROR:" : isDone ? "DONE:" : "CURRENT TASK:"}
        </span>
        {currentTask}
      </div>
    </div>
  );
}
