/**
 * Logs Router — Elza Live Monitoring
 * Exposes ring buffer, DB logs, and file download endpoints.
 */

import { z } from "zod";
import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import { getRecentLogs, getTodayLogFile, listLogFiles } from "../logger";
import { getPersistentLogs } from "../db";

export const logsRouter = router({

  // ── Ring buffer (in-memory, fast, resets on restart) ────────────────────────
  getRecentLogs: adminProcedure
    .input(z.object({
      level:    z.enum(["DEBUG","INFO","WARN","ERROR","BLOCK"]).optional(),
      category: z.string().optional(),
      limit:    z.number().int().min(1).max(1000).optional(),
    }).optional())
    .query(({ input }) => {
      return getRecentLogs({
        level:    input?.level as any,
        category: input?.category as any,
        limit:    input?.limit ?? 200,
      });
    }),

  // ── Persistent DB logs ───────────────────────────────────────────────────────
  getPersistentLogs: adminProcedure
    .input(z.object({
      level:    z.enum(["critical","error","warn","info"]).optional(),
      category: z.string().optional(),
      limit:    z.number().int().min(1).max(1000).optional(),
    }).optional())
    .query(async ({ input }) => {
      const logs = await getPersistentLogs({
        level:    input?.level,
        category: input?.category,
        limit:    input?.limit ?? 200,
      });
      return logs.map((l) => ({
        ...l,
        createdAt: l.createdAt ? l.createdAt.toISOString() : null,
      }));
    }),

  // ── Elza Live Logs — combined ring + DB filtered for Elza components ─────────
  getElzaLiveLogs: adminProcedure
    .input(z.object({
      level:  z.enum(["ALL","INFO","WARN","ERROR","BLOCK"]).optional(),
      limit:  z.number().int().min(1).max(500).optional(),
      search: z.string().optional(),
    }).optional())
    .query(async ({ input }) => {
      const ELZA_CATEGORIES = [
        "WAR_ENGINE","LIVE_EXEC","IBKR_SYNC","TICKLE",
        "CIRCUIT_BREAKER","GAP_GUARD","SLANG_GUARD","SECTOR_CAP","LIVE_MONITOR",
        "LIVE_EXEC", "IBKR", "ORDER"
      ];

      // From ring buffer
      let ringEntries = getRecentLogs({ limit: 500 })
        .filter(e => ELZA_CATEGORIES.includes(e.category));

      if (input?.level && input.level !== "ALL") {
        const levels = ["INFO","WARN","ERROR","BLOCK"];
        const minIdx = levels.indexOf(input.level);
        ringEntries = ringEntries.filter(e => levels.indexOf(e.level) >= minIdx);
      }
      if (input?.search) {
        const q = input.search.toLowerCase();
        ringEntries = ringEntries.filter(e => e.msg.toLowerCase().includes(q) || JSON.stringify(e.data||{}).toLowerCase().includes(q));
      }

      // From DB
      const dbLogs = await getPersistentLogs({ limit: 500 });
      const dbFiltered = dbLogs
        .filter(l => ELZA_CATEGORIES.includes(l.category))
        .map(l => ({
          ts:       l.createdAt?.toISOString() ?? new Date().toISOString(),
          level:    (l.level === "critical" ? "ERROR" : l.level.toUpperCase()) as any,
          category: l.category as any,
          msg:      l.message,
          data:     l.context ? (() => { try { return JSON.parse(l.context!); } catch { return { raw: l.context }; } })() : undefined,
        }));

      // Merge, deduplicate, sort newest first
      const allEntries = [...ringEntries, ...dbFiltered];
      const seen = new Set<string>();
      const deduped = allEntries.filter(e => {
        const key = `${e.ts}|${e.msg.slice(0,40)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      deduped.sort((a,b) => b.ts.localeCompare(a.ts));

      return deduped.slice(0, input?.limit ?? 200);
    }),

  // ── Download today's log file ────────────────────────────────────────────────
  downloadTodayLog: adminProcedure
    .query(() => {
      const { content, path: filePath } = getTodayLogFile();
      return {
        filename: filePath.split("/").pop() ?? "elza-today.log",
        content,
        lines: content.split("\n").filter(Boolean).length,
      };
    }),

  // ── List available log files ─────────────────────────────────────────────────
  listLogFiles: adminProcedure
    .query(() => listLogFiles()),
});
