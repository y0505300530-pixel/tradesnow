/**
 * Persistent Logger — writes critical errors directly to the systemLogs DB table.
 *
 * Unlike the ring buffer logger (which dies with the Cloud Run instance),
 * these logs survive instance termination and provide a permanent audit trail.
 *
 * Usage:
 *   import { dbLog } from "./persistentLogger";
 *   dbLog("critical", "SCAN", "Scan crashed mid-flight", { simId: 123, stack: err.stack });
 *
 * Batches writes every 3 seconds to avoid overwhelming the DB during error storms.
 * Falls back to console.error if DB is unavailable.
 */

import { getDb } from "./db";
import { systemLogs } from "../drizzle/schema";
import { log } from "./logger";

export type PersistentLogLevel = "critical" | "error" | "warn" | "info";
export type PersistentLogCategory =
  | "SCAN" | "SIM" | "IBKR" | "DB" | "SYSTEM"
  | "PAPER" | "ALERTS" | "AUTH" | "PROXY" | "ORDER"
  // live-trading categories that emit() forwards into the persistent store
  | "HALT" | "SL_TP_ENFORCEMENT" | "PARTIAL_FILL" | "WAR_ENGINE"
  | "LIVE_EXEC" | "ZOMBIE_RECOVERY" | "CIRCUIT_BREAKER" | "LIVE_MONITOR";

interface PendingLog {
  level: PersistentLogLevel;
  category: PersistentLogCategory;
  message: string;
  stack?: string;
  context?: string;
  instanceId: string;
}

// Unique per Cloud Run instance — survives for the lifetime of the process
const INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Batch buffer — flushed every 3 seconds
const pendingLogs: PendingLog[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

function startFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(flushToDb, 3000);
  // Don't keep the process alive just for logging
  if (flushTimer.unref) flushTimer.unref();
}

async function flushToDb() {
  if (pendingLogs.length === 0) return;
  const batch = pendingLogs.splice(0, 50); // max 50 per flush
  try {
    const db = await getDb();
    if (!db) {
      // DB not available — dump to console as fallback
      for (const entry of batch) {
        console.error(`[PersistentLog:${entry.level}:${entry.category}] ${entry.message} ${entry.stack ?? ""}`);
      }
      return;
    }
    await db.insert(systemLogs).values(
      batch.map((entry) => ({
        level: entry.level,
        category: entry.category,
        message: entry.message,
        stack: entry.stack ?? null,
        context: entry.context ?? null,
        instanceId: entry.instanceId,
      }))
    );
  } catch (err) {
    // Last resort — console
    console.error("[PersistentLogger] Failed to flush to DB:", err);
    for (const entry of batch) {
      console.error(`[PersistentLog:FALLBACK:${entry.level}:${entry.category}] ${entry.message}`);
    }
  }
}

/**
 * Write a log entry to the persistent DB table.
 * Also emits to the ring buffer logger for immediate visibility.
 *
 * @param level - critical | error | warn | info
 * @param category - SCAN | SIM | IBKR | DB | SYSTEM | PAPER | ALERTS | AUTH | PROXY | ORDER
 * @param message - Human-readable description
 * @param opts - Optional: stack trace, context object with variables
 */
export function dbLog(
  level: PersistentLogLevel,
  category: PersistentLogCategory,
  message: string,
  opts?: { stack?: string; context?: Record<string, unknown> }
) {
  // Also emit to ring buffer for immediate in-memory visibility
  const ringLevel = level === "critical" ? "ERROR" : level.toUpperCase() as "ERROR" | "WARN" | "INFO";
  const data = opts?.context ? { ...opts.context, ...(opts.stack ? { _stack: opts.stack.split("\n").slice(0, 5).join(" | ") } : {}) } : undefined;
  log[ringLevel === "ERROR" ? "error" : ringLevel === "WARN" ? "warn" : "info"](
    category as any,
    `[DB] ${message}`,
    data
  );

  // Queue for persistent DB write
  pendingLogs.push({
    level,
    category,
    message,
    stack: opts?.stack,
    context: opts?.context ? JSON.stringify(opts.context) : undefined,
    instanceId: INSTANCE_ID,
  });

  startFlushTimer();

  // For critical errors, flush immediately (don't wait 3s)
  if (level === "critical") {
    flushToDb().catch(() => {});
  }
}

/**
 * Flush all pending logs immediately. Call before process exit.
 */
export async function flushPersistentLogs() {
  await flushToDb();
}

/**
 * Get the current instance ID (useful for correlating logs).
 */
export function getInstanceId(): string {
  return INSTANCE_ID;
}
