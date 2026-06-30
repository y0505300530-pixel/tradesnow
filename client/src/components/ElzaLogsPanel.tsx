import React, { useState, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Download, RefreshCw, Terminal, ChevronDown, ChevronUp,
  AlertTriangle, Info, XCircle, ShieldAlert, Search, Filter
} from "lucide-react";

type LogLevel = "INFO" | "WARN" | "ERROR" | "BLOCK" | "DEBUG";
type LogEntry = {
  ts: string;
  level: LogLevel;
  category: string;
  msg: string;
  data?: Record<string, unknown>;
};

const LEVEL_CONFIG: Record<string, { color: string; badge: string; icon: React.ReactNode }> = {
  INFO:  { color: "text-cyan-300",   badge: "bg-cyan-900/60 text-cyan-300 border-cyan-700",   icon: <Info className="w-3 h-3" /> },
  WARN:  { color: "text-yellow-300", badge: "bg-yellow-900/60 text-yellow-300 border-yellow-700", icon: <AlertTriangle className="w-3 h-3" /> },
  ERROR: { color: "text-red-400",    badge: "bg-red-900/60 text-red-300 border-red-700",       icon: <XCircle className="w-3 h-3" /> },
  BLOCK: { color: "text-orange-400", badge: "bg-orange-900/60 text-orange-300 border-orange-700", icon: <ShieldAlert className="w-3 h-3" /> },
  DEBUG: { color: "text-gray-500",   badge: "bg-gray-800 text-gray-400 border-gray-700",       icon: <Info className="w-3 h-3" /> },
};

const CATEGORY_COLORS: Record<string, string> = {
  WAR_ENGINE:      "text-purple-400",
  LIVE_EXEC:       "text-green-400",
  IBKR_SYNC:       "text-blue-400",
  TICKLE:          "text-sky-400",
  CIRCUIT_BREAKER: "text-red-500",
  GAP_GUARD:       "text-amber-400",
  SLANG_GUARD:     "text-pink-400",
  SECTOR_CAP:      "text-indigo-400",
  LIVE_MONITOR:    "text-teal-400",
  IBKR:            "text-blue-300",
  ORDER:           "text-orange-400",
};

function formatTs(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) +
      "." + String(d.getMilliseconds()).padStart(3, "0");
  } catch { return ts.slice(11, 23); }
}

function formatLogLine(entry: LogEntry): string {
  const d = new Date(entry.ts);
  const date = d.toISOString().replace("T", " ").slice(0, 23);
  const lvl  = entry.level.padEnd(8);
  const cat  = entry.category.padEnd(16);
  const ctx  = entry.data ? ` | ${JSON.stringify(entry.data)}` : "";
  return `[${date}] [${lvl}] [${cat}] -> ${entry.msg}${ctx}`;
}

interface Props {
  compact?: boolean;
}

export default function ElzaLogsPanel({ compact = false }: Props) {
  const [levelFilter, setLevelFilter] = useState<"ALL" | "INFO" | "WARN" | "ERROR" | "BLOCK">("ALL");
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [liveRefresh, setLiveRefresh] = useState(true);
  const terminalRef = useRef<HTMLDivElement>(null);

  const { data: logs = [], refetch, isFetching } = trpc.logs.getElzaLiveLogs.useQuery(
    { level: levelFilter, limit: 200, search: search || undefined },
    { refetchInterval: liveRefresh ? 8000 : false }
  );

  const { data: downloadData } = trpc.logs.downloadTodayLog.useQuery(undefined, { enabled: false });

  const downloadMutation = trpc.logs.downloadTodayLog.useQuery(undefined, {
    enabled: false,
    staleTime: 0,
  });

  useEffect(() => {
    if (autoScroll && terminalRef.current) {
      terminalRef.current.scrollTop = 0; // newest at top
    }
  }, [logs, autoScroll]);

  const handleDownload = async () => {
    const result = await downloadMutation.refetch();
    if (result.data) {
      const blob = new Blob([result.data.content], { type: "text/plain" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = result.data.filename;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const levelCounts = logs.reduce((acc, l) => {
    acc[l.level] = (acc[l.level] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const hasDanger = (levelCounts["ERROR"] || 0) + (levelCounts["BLOCK"] || 0) > 0;

  return (
    <div className={`flex flex-col ${compact ? "h-[500px]" : "h-[680px]"} bg-[#0d0d12] rounded-xl border ${hasDanger ? "border-red-900/50" : "border-gray-800"} overflow-hidden font-mono`}>

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800 bg-[#111118]">
        <div className="flex items-center gap-2.5">
          <Terminal className="w-4 h-4 text-green-500" />
          <span className="text-sm font-semibold text-gray-200">Elza Live Logs</span>
          <span className="text-[10px] text-gray-600 font-sans">
            {logs.length} entries
          </span>
          {hasDanger && (
            <Badge className="text-[9px] bg-red-900/60 text-red-300 border border-red-700 px-1.5 py-0 font-sans">
              ⚠ {(levelCounts["ERROR"] || 0)} ERR / {(levelCounts["BLOCK"] || 0)} BLK
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {/* Level filter */}
          <div className="flex gap-1 text-[10px]">
            {(["ALL","INFO","WARN","ERROR","BLOCK"] as const).map(lvl => (
              <button key={lvl}
                onClick={() => setLevelFilter(lvl)}
                className={`px-1.5 py-0.5 rounded border font-sans transition-colors ${
                  levelFilter === lvl
                    ? (lvl === "ERROR" ? "bg-red-900/80 border-red-700 text-red-300"
                     : lvl === "WARN"  ? "bg-yellow-900/80 border-yellow-700 text-yellow-300"
                     : lvl === "BLOCK" ? "bg-orange-900/80 border-orange-700 text-orange-300"
                     : "bg-gray-700 border-gray-500 text-gray-200")
                    : "bg-transparent border-gray-800 text-gray-600 hover:border-gray-600"
                }`}>
                {lvl}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-600" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="search..."
              className="bg-[#0d0d12] border border-gray-800 rounded text-[10px] text-gray-400 pl-5 pr-2 py-0.5 w-28 focus:outline-none focus:border-gray-600 font-sans"
            />
          </div>

          <button
            onClick={() => setLiveRefresh(v => !v)}
            className={`text-[10px] px-1.5 py-0.5 rounded border font-sans transition-colors ${
              liveRefresh ? "bg-green-900/60 border-green-700 text-green-400" : "bg-transparent border-gray-700 text-gray-600"
            }`}>
            {liveRefresh ? "● LIVE" : "PAUSED"}
          </button>

          <button
            onClick={() => setAutoScroll(v => !v)}
            className="text-gray-600 hover:text-gray-400 transition-colors"
            title={autoScroll ? "Auto-scroll ON" : "Auto-scroll OFF"}>
            {autoScroll ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          </button>

          <button onClick={() => refetch()} disabled={isFetching}
            className="text-gray-600 hover:text-gray-400 transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin text-blue-500" : ""}`} />
          </button>

          <button onClick={handleDownload}
            className="flex items-center gap-1 text-[10px] font-sans px-2 py-0.5 rounded bg-blue-900/60 border border-blue-800 text-blue-300 hover:bg-blue-900/80 transition-colors">
            <Download className="w-3 h-3" />
            <span>.log</span>
          </button>
        </div>
      </div>

      {/* ── Stats bar ── */}
      <div className="flex items-center gap-3 px-4 py-1.5 bg-[#0d0d12] border-b border-gray-900 text-[10px] font-sans">
        {Object.entries(levelCounts).map(([lvl, cnt]) => (
          <span key={lvl} className={`${LEVEL_CONFIG[lvl]?.color ?? "text-gray-400"}`}>
            {lvl}: {cnt}
          </span>
        ))}
        {logs.length === 0 && !isFetching && (
          <span className="text-gray-700 italic">No logs yet for this session — engine hasn't run or logs cleared.</span>
        )}
      </div>

      {/* ── Terminal ── */}
      <div ref={terminalRef} className="flex-1 overflow-y-auto px-2 py-1 space-y-0.5 scroll-smooth">
        {logs.map((entry, idx) => {
          const cfg = LEVEL_CONFIG[entry.level] ?? LEVEL_CONFIG.INFO;
          const catColor = CATEGORY_COLORS[entry.category] ?? "text-gray-400";
          const isExpanded = expandedRow === idx;
          const hasData = entry.data && Object.keys(entry.data).length > 0;

          return (
            <div key={idx}
              onClick={() => hasData ? setExpandedRow(isExpanded ? null : idx) : undefined}
              className={`flex gap-2 items-start px-1.5 py-0.5 rounded text-[11px] leading-relaxed transition-colors ${
                entry.level === "ERROR" ? "bg-red-950/20 hover:bg-red-950/30" :
                entry.level === "BLOCK" ? "bg-orange-950/20 hover:bg-orange-950/30" :
                entry.level === "WARN"  ? "bg-yellow-950/10 hover:bg-yellow-950/20" :
                "hover:bg-white/5"
              } ${hasData ? "cursor-pointer" : ""}`}>

              {/* Timestamp */}
              <span className="text-gray-600 shrink-0 tabular-nums">{formatTs(entry.ts)}</span>

              {/* Level badge */}
              <span className={`inline-flex items-center gap-0.5 px-1 rounded border text-[9px] shrink-0 ${cfg.badge}`}>
                {cfg.icon}{entry.level}
              </span>

              {/* Category */}
              <span className={`${catColor} shrink-0 text-[10px] w-24 truncate`}>[{entry.category}]</span>

              {/* Message */}
              <span className={`${cfg.color} flex-1 break-all`}>
                {entry.msg}
                {hasData && !isExpanded && (
                  <ChevronDown className="inline w-3 h-3 ml-1 text-gray-600" />
                )}
              </span>
            </div>
          );
        })}

        {/* Expanded row */}
        {expandedRow !== null && logs[expandedRow]?.data && (
          <div className="mx-1 my-0.5 p-2 bg-gray-900/80 border border-gray-700 rounded text-[10px] text-green-300 overflow-x-auto">
            <pre className="whitespace-pre-wrap break-all">
              {JSON.stringify(logs[expandedRow].data, null, 2)}
            </pre>
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      <div className="px-4 py-1.5 border-t border-gray-900 bg-[#0d0d12] text-[9px] text-gray-700 font-sans flex justify-between">
        <span>Format: [TIMESTAMP] [LEVEL] [COMPONENT] → Message | Context</span>
        <span>{new Date().toLocaleTimeString()} — {liveRefresh ? "live" : "paused"}</span>
      </div>
    </div>
  );
}
