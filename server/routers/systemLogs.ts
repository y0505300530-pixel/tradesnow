import { Express, Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import { sdk } from "../_core/sdk";
import { ENV } from "../_core/env";
import { getRecentLogs } from "../logger";
import { getPersistentLogs, getPersistentLogStats } from "../db";

// ─── Log file definitions ─────────────────────────────────────────────────────
const LOG_DIR = path.join(process.cwd(), ".manus-logs");

const LOG_FILES: Record<string, { file: string; label: string; description: string }> = {
  server: {
    file: "devserver.log",
    label: "Server Log",
    description: "Dev server startup, Vite HMR, Express warnings",
  },
  browser: {
    file: "browserConsole.log",
    label: "Browser Console",
    description: "Client-side console.log/warn/error with stack traces",
  },
  network: {
    file: "networkRequests.log",
    label: "Network Requests",
    description: "HTTP requests (fetch/XHR) with URL, status, duration",
  },
  activity: {
    file: "sessionReplay.log",
    label: "Activity / Session",
    description: "User interaction events (clicks, focus, navigation)",
  },
};

// ─── Admin-only middleware ────────────────────────────────────────────────────
async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user || user.role !== "admin") {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    return next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}

// ─── Helper: read last N lines of a file ─────────────────────────────────────
function readLastLines(filePath: string, maxBytes = 512 * 1024): string {
  if (!fs.existsSync(filePath)) return "";
  const stat = fs.statSync(filePath);
  const size = stat.size;
  if (size === 0) return "";
  const readSize = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(readSize);
  const fd = fs.openSync(filePath, "r");
  fs.readSync(fd, buffer, 0, readSize, size - readSize);
  fs.closeSync(fd);
  return buffer.toString("utf8");
}

// ─── Debug logs endpoint (LOG_SECRET env auth, no user session needed) ────────
function isValidLogSecret(key: string | undefined): boolean {
  const secret = ENV.logSecret.trim();
  if (!secret) return false;
  return typeof key === "string" && key === secret;
}

// ─── Register routes ──────────────────────────────────────────────────────────
export function registerSystemLogsRoute(app: Express) {
  // Debug endpoint — accessible with LOG_SECRET only
  app.get("/api/debug-logs", (req: Request, res: Response) => {
    const key = req.query.key as string;
    if (!isValidLogSecret(key)) {
      res.status(403).json({ error: "Invalid key" });
      return;
    }
    const level = req.query.level as string | undefined;
    const category = req.query.category as string | undefined;
    const limit = parseInt(req.query.limit as string || "200", 10);
    const source = req.query.source as string || "memory"; // "memory" or "db"

    if (source === "db") {
      getPersistentLogs({ level: level as any, category, limit })
        .then(logs => res.json({ ok: true, count: logs.length, logs }))
        .catch(err => res.status(500).json({ error: String(err) }));
      return;
    }

    // In-memory ring buffer
    const logs = getRecentLogs({ level: level as any, category: category as any, limit });
    res.json({ ok: true, count: logs.length, logs });
  });

  // Debug endpoint — raw server log file (last 500KB)
  app.get("/api/debug-logs/server", (req: Request, res: Response) => {
    const key = req.query.key as string;
    if (!isValidLogSecret(key)) {
      res.status(403).json({ error: "Invalid key" });
      return;
    }
    const filePath = path.join(LOG_DIR, "devserver.log");
    const content = readLastLines(filePath, 500 * 1024);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(content || "(empty)");
  });

  // All system-log routes require admin authentication
  app.use("/api/system-logs", requireAdmin);

  // GET /api/system-logs/list — returns metadata about available logs
  app.get("/api/system-logs/list", async (_req: Request, res: Response) => {
    const result = Object.entries(LOG_FILES).map(([key, meta]) => {
      const filePath = path.join(LOG_DIR, meta.file);
      let size = 0;
      let lastModified: string | null = null;
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        size = stat.size;
        lastModified = stat.mtime.toISOString();
      }
      return {
        key,
        label: meta.label,
        description: meta.description,
        file: meta.file,
        size,
        lastModified,
        available: size > 0,
      };
    });

    const dbStats = await getPersistentLogStats();
    result.unshift({
      key: "persistent",
      label: "Persistent Logs (DB)",
      description: "Server-side logs stored in MySQL — available in production",
      file: "system_logs table",
      size: dbStats.count,
      lastModified: dbStats.lastModified,
      available: dbStats.count > 0,
    });

    res.json(result);
  });

  // GET /api/system-logs/preview/:key — returns last ~100KB of a log as text
  app.get("/api/system-logs/preview/:key", async (req: Request, res: Response) => {
    const { key } = req.params;
    if (key === "persistent") {
      const logs = await getPersistentLogs({ limit: 500 });
      const content = logs
        .slice()
        .reverse()
        .map((l) => {
          const ts = l.createdAt ? new Date(l.createdAt).toISOString() : "?";
          const ctx = l.context ? ` ${l.context}` : "";
          return `[${ts}] [${l.level}] [${l.category}] ${l.message}${ctx}`;
        })
        .join("\n");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.send(content || "(empty)");
      return;
    }
    const meta = LOG_FILES[key];
    if (!meta) {
      res.status(404).json({ error: "Unknown log key" });
      return;
    }
    const filePath = path.join(LOG_DIR, meta.file);
    const content = readLastLines(filePath, 100 * 1024); // last 100KB
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(content || "(empty)");
  });

  // GET /api/system-logs/download/:key — streams full log file as download
  app.get("/api/system-logs/download/:key", async (req: Request, res: Response) => {
    const { key } = req.params;
    if (key === "persistent") {
      const logs = await getPersistentLogs({ limit: 5000 });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const content = logs
        .slice()
        .reverse()
        .map((l) => {
          const ts = l.createdAt ? new Date(l.createdAt).toISOString() : "?";
          const stack = l.stack ? `\n  stack: ${l.stack}` : "";
          const ctx = l.context ? `\n  context: ${l.context}` : "";
          return `[${ts}] [${l.level}] [${l.category}] ${l.message}${ctx}${stack}`;
        })
        .join("\n\n");
      res.setHeader("Content-Disposition", `attachment; filename="persistent-logs-${timestamp}.txt"`);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.send(content || "(empty)");
      return;
    }
    const meta = LOG_FILES[key];
    if (!meta) {
      res.status(404).json({ error: "Unknown log key" });
      return;
    }
    const filePath = path.join(LOG_DIR, meta.file);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Log file not found" });
      return;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `${key}-${timestamp}.log`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    fs.createReadStream(filePath).pipe(res);
  });

  // GET /api/system-logs/download-all — streams a combined zip-like text bundle
  app.get("/api/system-logs/download-all", async (_req: Request, res: Response) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    res.setHeader("Content-Disposition", `attachment; filename="system-logs-${timestamp}.txt"`);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");

    let combined = `=== System Logs Export ===\nGenerated: ${new Date().toISOString()}\n\n`;

    const dbLogs = await getPersistentLogs({ limit: 2000 });
    combined += `\n${"=".repeat(60)}\n`;
    combined += `LOG: Persistent Logs (DB)\n`;
    combined += `File: system_logs table\n`;
    combined += `Description: Server-side logs stored in MySQL\n`;
    combined += `${"=".repeat(60)}\n\n`;
    combined += dbLogs
      .slice()
      .reverse()
      .map((l) => {
        const ts = l.createdAt ? new Date(l.createdAt).toISOString() : "?";
        return `[${ts}] [${l.level}] [${l.category}] ${l.message}`;
      })
      .join("\n") || "(empty)";
    combined += "\n";

    for (const [key, meta] of Object.entries(LOG_FILES)) {
      const filePath = path.join(LOG_DIR, meta.file);
      const content = readLastLines(filePath, 200 * 1024);
      combined += `\n${"=".repeat(60)}\n`;
      combined += `LOG: ${meta.label} (${key})\n`;
      combined += `File: ${meta.file}\n`;
      combined += `Description: ${meta.description}\n`;
      combined += `${"=".repeat(60)}\n\n`;
      combined += content || "(empty)\n";
      combined += "\n";
    }
    res.send(combined);
  });
}
