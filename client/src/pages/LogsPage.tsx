import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RefreshCw, Database, Cpu } from "lucide-react";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
type LogCategory = "IBKR" | "DB" | "AUTH" | "ORDER" | "TELEGRAM" | "ANALYSIS" | "SYSTEM" | "PROXY" | "SCAN";

const LEVEL_COLORS: Record<LogLevel, string> = {
  DEBUG: "bg-gray-100 text-gray-700",
  INFO:  "bg-blue-100 text-blue-700",
  WARN:  "bg-yellow-100 text-yellow-800",
  ERROR: "bg-red-50 text-red-700",
};

const PERSISTENT_LEVEL_COLORS: Record<string, string> = {
  critical: "bg-red-200 text-red-900 font-bold",
  error: "bg-red-50 text-red-700",
  warn: "bg-yellow-100 text-yellow-800",
  info: "bg-blue-100 text-blue-700",
};

const CATEGORY_COLORS: Record<LogCategory, string> = {
  IBKR:     "bg-indigo-100 text-indigo-700",
  DB:       "bg-[rgba(37,99,235,0.15)] text-[#2563EB]",
  AUTH:     "bg-green-100 text-green-700",
  ORDER:    "bg-orange-100 text-orange-700",
  TELEGRAM: "bg-sky-100 text-sky-700",
  ANALYSIS: "bg-teal-100 text-teal-700",
  SYSTEM:   "bg-gray-100 text-gray-600",
  PROXY:    "bg-pink-100 text-pink-700",
  SCAN:     "bg-emerald-100 text-emerald-700",
};

const ALL_LEVELS: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"];
const ALL_CATEGORIES: LogCategory[] = ["IBKR", "DB", "AUTH", "ORDER", "TELEGRAM", "ANALYSIS", "SYSTEM", "PROXY", "SCAN"];
const PERSISTENT_LEVELS = ["critical", "error", "warn", "info"] as const;
const PERSISTENT_CATEGORIES = ["SCAN", "SIM", "IBKR", "DB", "SYSTEM", "PAPER", "ALERTS", "AUTH", "PROXY", "ORDER"] as const;

type TabType = "ring" | "persistent";

export default function LogsPage() {
  const [tab, setTab] = useState<TabType>("persistent");
  const [level, setLevel] = useState<LogLevel | "ALL">("ALL");
  const [category, setCategory] = useState<LogCategory | "ALL">("ALL");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [pLevel, setPLevel] = useState<string>("ALL");
  const [pCategory, setPCategory] = useState<string>("ALL");
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  // Ring buffer logs
  const { data: logs = [], refetch, isFetching } = trpc.logs.getRecentLogs.useQuery(
    {
      level: level !== "ALL" ? level : undefined,
      category: category !== "ALL" ? category : undefined,
      limit: 200,
    },
    {
      refetchInterval: autoRefresh && tab === "ring" ? 10_000 : false,
      enabled: tab === "ring",
    }
  );

  // Persistent DB logs
  const { data: persistentLogs = [], refetch: refetchPersistent, isFetching: isFetchingPersistent } = trpc.logs.getPersistentLogs.useQuery(
    {
      level: pLevel !== "ALL" ? pLevel as any : undefined,
      category: pCategory !== "ALL" ? pCategory : undefined,
      limit: 200,
    },
    {
      refetchInterval: autoRefresh && tab === "persistent" ? 15_000 : false,
      enabled: tab === "persistent",
    }
  );

  const handleRefresh = () => {
    if (tab === "ring") refetch();
    else refetchPersistent();
  };

  const currentFetching = tab === "ring" ? isFetching : isFetchingPersistent;

  return (
    <div className="p-6 max-w-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">System Logs</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {tab === "ring"
              ? `Ring buffer: ${logs.length} entries (dies with instance)`
              : `Persistent DB: ${persistentLogs.length} entries (survives restarts)`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={currentFetching}
            className="gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${currentFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            variant={autoRefresh ? "default" : "outline"}
            size="sm"
            onClick={() => setAutoRefresh(v => !v)}
          >
            {autoRefresh ? "Auto ✓" : "Auto"}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-200">
        <button
          onClick={() => setTab("persistent")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "persistent"
              ? "border-red-500 text-red-700"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          <Database className="h-3.5 w-3.5" />
          Persistent Logs (DB)
        </button>
        <button
          onClick={() => setTab("ring")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "ring"
              ? "border-blue-500 text-blue-700"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          <Cpu className="h-3.5 w-3.5" />
          Ring Buffer (Instance)
        </button>
      </div>

      {/* Filters */}
      {tab === "ring" ? (
        <div className="flex gap-3 mb-4">
          <div className="w-36">
            <Select value={level} onValueChange={(v) => setLevel(v as LogLevel | "ALL")}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="Level" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Levels</SelectItem>
                {ALL_LEVELS.map(l => (
                  <SelectItem key={l} value={l}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-40">
            <Select value={category} onValueChange={(v) => setCategory(v as LogCategory | "ALL")}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Categories</SelectItem>
                {ALL_CATEGORIES.map(c => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : (
        <div className="flex gap-3 mb-4">
          <div className="w-36">
            <Select value={pLevel} onValueChange={setPLevel}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="Level" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Levels</SelectItem>
                {PERSISTENT_LEVELS.map(l => (
                  <SelectItem key={l} value={l}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-40">
            <Select value={pCategory} onValueChange={setPCategory}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Categories</SelectItem>
                {PERSISTENT_CATEGORIES.map(c => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {/* Logs table */}
      {tab === "ring" ? (
        <RingBufferTable logs={logs} />
      ) : (
        <PersistentLogsTable logs={persistentLogs} expandedRow={expandedRow} setExpandedRow={setExpandedRow} />
      )}
    </div>
  );
}

function RingBufferTable({ logs }: { logs: any[] }) {
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap w-44">Time</th>
              <th className="text-left px-3 py-2 font-medium text-gray-600 w-20">Level</th>
              <th className="text-left px-3 py-2 font-medium text-gray-600 w-24">Category</th>
              <th className="text-left px-3 py-2 font-medium text-gray-600">Message</th>
              <th className="text-left px-3 py-2 font-medium text-gray-600 w-64">Data</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {logs.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-gray-400">
                  No log entries found (ring buffer is empty — instance just started)
                </td>
              </tr>
            ) : (
              logs.map((entry, i) => (
                <tr
                  key={i}
                  className={`hover:bg-gray-50 ${entry.level === "ERROR" ? "bg-red-50" : entry.level === "WARN" ? "bg-yellow-50/40" : ""}`}
                >
                  <td className="px-3 py-1.5 font-mono text-xs text-gray-500 whitespace-nowrap">
                    {new Date(entry.ts).toLocaleString("en-US", {
                      month: "2-digit", day: "2-digit",
                      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
                    })}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold ${LEVEL_COLORS[entry.level as LogLevel] ?? "bg-gray-100 text-gray-600"}`}>
                      {entry.level}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${CATEGORY_COLORS[entry.category as LogCategory] ?? "bg-gray-100 text-gray-600"}`}>
                      {entry.category}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-gray-800 font-medium">
                    {entry.msg}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-gray-500 max-w-xs truncate">
                    {entry.data ? JSON.stringify(entry.data) : ""}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {logs.length > 0 && (
        <p className="text-xs text-gray-400 px-3 py-2 border-t border-gray-100">
          Showing {logs.length} entries from in-memory ring buffer (max 500)
        </p>
      )}
    </div>
  );
}

function PersistentLogsTable({ logs, expandedRow, setExpandedRow }: {
  logs: any[];
  expandedRow: number | null;
  setExpandedRow: (id: number | null) => void;
}) {
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap w-44">Time</th>
              <th className="text-left px-3 py-2 font-medium text-gray-600 w-20">Level</th>
              <th className="text-left px-3 py-2 font-medium text-gray-600 w-24">Category</th>
              <th className="text-left px-3 py-2 font-medium text-gray-600">Message</th>
              <th className="text-left px-3 py-2 font-medium text-gray-600 w-28">Instance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {logs.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-gray-400">
                  No persistent log entries found — system is healthy
                </td>
              </tr>
            ) : (
              logs.map((entry) => (
                <>
                  <tr
                    key={entry.id}
                    onClick={() => setExpandedRow(expandedRow === entry.id ? null : entry.id)}
                    className={`hover:bg-gray-50 cursor-pointer ${
                      entry.level === "critical" ? "bg-red-100" :
                      entry.level === "error" ? "bg-red-50" :
                      entry.level === "warn" ? "bg-yellow-50/40" : ""
                    }`}
                  >
                    <td className="px-3 py-1.5 font-mono text-xs text-gray-500 whitespace-nowrap">
                      {entry.createdAt ? new Date(entry.createdAt).toLocaleString("en-US", {
                        month: "2-digit", day: "2-digit",
                        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
                      }) : "—"}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold ${PERSISTENT_LEVEL_COLORS[entry.level] ?? "bg-gray-100 text-gray-600"}`}>
                        {entry.level.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${CATEGORY_COLORS[entry.category as LogCategory] ?? "bg-gray-100 text-gray-600"}`}>
                        {entry.category}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-gray-800 font-medium">
                      {entry.message}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs text-gray-400">
                      {entry.instanceId?.slice(0, 12) ?? "—"}
                    </td>
                  </tr>
                  {expandedRow === entry.id && (
                    <tr key={`${entry.id}-detail`}>
                      <td colSpan={5} className="px-4 py-3 bg-gray-50 border-t border-gray-200">
                        {entry.stack && (
                          <div className="mb-2">
                            <span className="text-xs font-semibold text-gray-600 block mb-1">Stack Trace:</span>
                            <pre className="text-xs text-red-700 bg-red-50 p-2 rounded overflow-x-auto max-h-48 whitespace-pre-wrap">
                              {entry.stack}
                            </pre>
                          </div>
                        )}
                        {entry.context && (
                          <div>
                            <span className="text-xs font-semibold text-gray-600 block mb-1">Context:</span>
                            <pre className="text-xs text-gray-700 bg-gray-100 p-2 rounded overflow-x-auto max-h-32 whitespace-pre-wrap">
                              {(() => {
                                try {
                                  return JSON.stringify(JSON.parse(entry.context), null, 2);
                                } catch {
                                  return entry.context;
                                }
                              })()}
                            </pre>
                          </div>
                        )}
                        {!entry.stack && !entry.context && (
                          <span className="text-xs text-gray-400">No additional details</span>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))
            )}
          </tbody>
        </table>
      </div>
      {logs.length > 0 && (
        <p className="text-xs text-gray-400 px-3 py-2 border-t border-gray-100">
          Showing {logs.length} persistent entries from DB — click a row to expand stack trace
        </p>
      )}
    </div>
  );
}
