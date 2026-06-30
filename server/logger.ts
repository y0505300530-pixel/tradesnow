/**
 * Centralized Structured Logger — TradeSnow2 Elza Edition
 *
 * Format: [YYYY-MM-DD HH:MM:SS.mmm] [LEVEL    ] [COMPONENT] -> Message | {JSON}
 * Levels: DEBUG < INFO < WARN < ERROR < BLOCK
 * Persists to: systemLogs DB (all levels) + /tmp/elza-{date}.log (daily file)
 */

import * as fs from "fs";
import * as path from "path";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "BLOCK";
export type LogCategory =
  | "IBKR"
  | "DB"
  | "AUTH"
  | "ORDER"
  | "TELEGRAM"
  | "ANALYSIS"
  | "SYSTEM"
  | "PROXY"
  | "SCAN"
  | "PAPER_IBKR"
  | "PAPER_EXEC"
  | "LIVE_EXEC"
  | "MANUAL_ORDER"
  | "FILL_POLLER"
  | "WAR_ENGINE"
  | "IBKR_SYNC"
  | "TICKLE"
  | "CIRCUIT_BREAKER"
  | "GAP_GUARD"
  | "SLANG_GUARD"
  | "SECTOR_CAP"
  | "LIVE_MONITOR"
  | "KRONOS_VETO"
  | "PYRAMID"
  | "CYC_GATE"
  | "WAR"
  | "CORP_ACTION"
  | "DELEVERAGE_CRON"
  | "HALT"
  | "JOURNAL"
  | "PARTIAL_FILL"
  | "SL_TP_ENFORCEMENT"
  | "THROTTLE"
  | "VIDEO_CLEANUP"
  | "VIDEO_CLEANUP_CRON"
  | "ZOMBIE_RECOVERY";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  category: LogCategory;
  msg: string;
  data?: Record<string, unknown>;
}

/** Mask an IBKR account id for logging (never log the raw U-number into render-visible fields). */
export const maskAcct = (a?: string | null): string | null | undefined =>
  a ? `${a.slice(0, 2)}***${a.slice(-2)}` : a;

// In-memory ring buffer — last 1000 entries
const RING_SIZE = 1000;
const ring: LogEntry[] = [];

// ── Daily log file ────────────────────────────────────────────────────────────
const LOG_DIR = "/tmp/elza-logs";
try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function getDailyLogPath(): string {
  const d = new Date();
  const dateStr = d.toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `elza-${dateStr}.log`);
}

function formatLogLine(entry: LogEntry): string {
  // [YYYY-MM-DD HH:MM:SS.mmm] [LEVEL    ] [COMPONENT      ] -> Message | {JSON}
  const d = new Date(entry.ts);
  const date = d.toISOString().replace("T", " ").slice(0, 23);
  const lvl  = entry.level.padEnd(8);
  const cat  = entry.category.padEnd(16);
  const ctx  = entry.data ? ` | ${JSON.stringify(entry.data)}` : "";
  return `[${date}] [${lvl}] [${cat}] -> ${entry.msg}${ctx}`;
}

// Lazy DB import to avoid circular deps
let _dbLog: ((level: string, cat: string, msg: string, ctx?: unknown) => void) | null = null;
export function setDbLogger(fn: (level: string, cat: string, msg: string, ctx?: unknown) => void) {
  _dbLog = fn;
}

function emit(level: LogLevel, category: LogCategory, msg: string, data?: Record<string, unknown>) {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    category,
    msg,
    ...(data && Object.keys(data).length > 0 ? { data } : {}),
  };

  const line = formatLogLine(entry);

  // stdout
  console.log(line);

  // daily file — async, non-blocking
  try {
    fs.appendFileSync(getDailyLogPath(), line + "\n");
  } catch {}

  // ring buffer
  if (ring.length >= RING_SIZE) ring.shift();
  ring.push(entry);

  // DB persist (WARN/ERROR/BLOCK always; INFO for key categories)
  if (_dbLog && level !== "DEBUG") {
    const shouldPersist =
      level === "ERROR" || level === "WARN" || level === "BLOCK" ||
      (level === "INFO" && ["WAR_ENGINE", "LIVE_EXEC", "IBKR_SYNC", "TICKLE", "CIRCUIT_BREAKER", "LIVE_MONITOR"].includes(category));
    if (shouldPersist) {
      try {
        const dbLevel = level === "BLOCK" ? "warn" : level.toLowerCase() as any;
        _dbLog(dbLevel, category, msg, data);
      } catch {}
    }
  }
}

export const log = {
  debug: (category: LogCategory, msg: string, data?: Record<string, unknown>) => emit("DEBUG", category, msg, data),
  info:  (category: LogCategory, msg: string, data?: Record<string, unknown>) => emit("INFO",  category, msg, data),
  warn:  (category: LogCategory, msg: string, data?: Record<string, unknown>) => emit("WARN",  category, msg, data),
  error: (category: LogCategory, msg: string, data?: Record<string, unknown>) => emit("ERROR", category, msg, data),
  block: (category: LogCategory, msg: string, data?: Record<string, unknown>) => emit("BLOCK", category, msg, data),
};

/** Returns recent log entries from ring buffer, newest first */
export function getRecentLogs(opts?: {
  level?: LogLevel | "INFO" | "WARN" | "ERROR";
  category?: LogCategory;
  limit?: number;
}): LogEntry[] {
  let entries = [...ring].reverse();
  if (opts?.level) {
    const levels: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR", "BLOCK"];
    const minIdx = levels.indexOf(opts.level as LogLevel);
    if (minIdx >= 0) entries = entries.filter((e) => levels.indexOf(e.level) >= minIdx);
  }
  if (opts?.category) {
    entries = entries.filter((e) => e.category === opts.category);
  }
  return entries.slice(0, opts?.limit ?? 200);
}

/** Returns today's full log file content */
export function getLogRingEntries(): typeof ring { return [...ring]; }

export function getTodayLogFile(): { path: string; content: string } {
  const p = getDailyLogPath();
  try {
    const content = fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
    return { path: p, content };
  } catch {
    return { path: p, content: "" };
  }
}

/** List available log files (last 7 days) */
export function listLogFiles(): { date: string; path: string; sizeKb: number }[] {
  try {
    return fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith("elza-") && f.endsWith(".log"))
      .map(f => {
        const fp = path.join(LOG_DIR, f);
        const stat = fs.statSync(fp);
        return { date: f.replace("elza-","").replace(".log",""), path: fp, sizeKb: Math.round(stat.size/1024) };
      })
      .sort((a,b) => b.date.localeCompare(a.date))
      .slice(0, 7);
  } catch { return []; }
}
