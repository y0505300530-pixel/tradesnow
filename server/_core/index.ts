import "dotenv/config";
import { validateEnv } from "./env";
validateEnv();
import express from "express";
import compression from "compression";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { registerIbkrProxyRoute } from "../routers/ibkrProxy";
import { registerSystemLogsRoute } from "../routers/systemLogs";
import { registerTelegramWebhookRoute, registerBotCommands, setTelegramWebhook } from "../routers/telegramWebhook";
import { registerMarketScanRoute } from "../routers/marketScan";
import { registerPriceStreamRoute } from "../routers/priceStream";
import { registerDeepAnalysisStreamRoute } from "../routers/deepAnalysisStream";
import { registerTwoFactorRoutes } from "../twoFactor";
import { registerLocalAuthRoutes } from "../routers/localAuth";
import { registerMorningBriefingRoute } from "../routers/morningBriefing";
import { registerMarketOpenBriefingRoute } from "../routers/marketOpenBriefing";
import { registerEndOfDaySummaryRoute } from "../routers/endOfDaySummary";
import { registerWeeklySummaryRoute } from "../routers/weeklySummary";
import { registerHourlySnapshotRoute } from "../routers/hourlySnapshotScheduled";
import { registerSlCheckRoute } from "../routers/slCheckScheduled";
import { registerNightlySlResyncRoute } from "../routers/nightlySlResync";
import { registerNightlyCacheRefreshRoute } from "../routers/nightlyCacheRefresh";
import { registerAnalyzeStreamRoute } from "../routers/analyzeStream";
import { registerAnalyzeSingleRoute } from "../routers/analyzeSingle";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { resetStuckAnalyses, resetStuckSimulations } from "../db";
import { startAlertPoller } from "../alertPoller";
import { startDeleverageCron } from "../deleverageCron";
import { startZombieRecoveryMonitor } from "../zombieRecoveryMonitor";
import { startVideoCleanupCron } from "../videoCleanupCron";
import { startIbkrSessionMonitor } from "../ibkrSessionMonitor";
import { startIbkrHeartbeat } from "../ibkrCache";
import { startIbkrQuotesPoller } from "../services/ibkrQuotesPoller";
// IBKR sync: single path via alertPoller runIbkrSync (5 min) — avoids duplicate 60s scheduler
import { refreshIbindDisconnectFlag } from "../routers/ibkrProxy";
import { dbLog, flushPersistentLogs } from "../persistentLogger";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Trust the first proxy (Manus reverse proxy) so req.protocol reflects https
  app.set("trust proxy", 1);

  // ── Security headers (helmet in dev; nginx sets them in production) ───────
  if (process.env.NODE_ENV !== "production") {
    app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
              "'self'",
              "'unsafe-inline'",   // Vite HMR in dev; tightened in prod via nonce if needed
              "https://accounts.google.com",
              "https://s3.tradingview.com",
              "https://www.tradingview.com",
            ],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "blob:", "https:"],
            connectSrc: [
              "'self'",
            // Google Fonts (fetch/connect path — stylesheet path already allowed via style-src/font-src)
            "https://fonts.googleapis.com",
            "https://fonts.gstatic.com",
              "https://trade-snow2.vip",
              "https://www.trade-snow2.vip",
              "https://api.manus.im",
              "wss://trade-snow2.vip",
              "wss://www.trade-snow2.vip",
              // ws://localhost:* removed — Vite dev-only, not needed in production
              // wss://localhost:* removed — dev-only
            ],
            frameSrc: ["'self'", "blob:", "https://s3.tradingview.com", "https://www.tradingview.com", "https://*.tradingview.com"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            upgradeInsecureRequests: [],
          },
        },
        // HSTS: 1 year, include subdomains
        strictTransportSecurity: {
          maxAge: 31536000,
          includeSubDomains: true,
        },
        // Prevent clickjacking
        frameguard: { action: "deny" },
        // Don't leak referrer to external sites
        referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      })
    );
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────
  // General API rate limit: 300 req/min per IP
  const generalApiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please slow down." },
  });
  app.use("/api", generalApiLimiter);

  // Strict rate limit for order endpoints: 30 req/min per IP
  const orderLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Order rate limit exceeded. Max 30 order requests per minute." },
  });
  app.use("/api/ibind/order", orderLimiter);
  app.use("/api/trpc/ibkr.placeMarketOrder", orderLimiter);
  app.use("/api/trpc/ibkr.placeSTPOrder", orderLimiter);
  app.use("/api/trpc/ibkr.placeLMTOrder", orderLimiter);
  app.use("/api/trpc/ibkr.placeStopLossIbind", orderLimiter);
  app.use("/api/trpc/ibkr.placeTakeProfitIbind", orderLimiter);

  // ── Brotli/gzip compression — reduces JSON payload by 70-80% ────────────────
  // Skips SSE streams (Content-Type: text/event-stream) to avoid buffering issues.
  app.use(compression({
    filter: (req, res) => {
      const ct = res.getHeader("Content-Type");
      if (typeof ct === "string" && ct.includes("text/event-stream")) return false;
      return compression.filter(req, res);
    },
    level: 6, // balanced: good compression ratio without excessive CPU
    threshold: 1024, // only compress responses > 1KB
  }));

  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // Parse cookies so req.cookies is populated for all routes
  app.use(cookieParser());
  // Storage proxy — serves /manus-storage/* assets via signed URLs
  registerStorageProxy(app);
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
  // IBKR Gateway proxy — bypasses CORS for external Gateway URLs
  registerIbkrProxyRoute(app);
  // System logs download endpoint
  registerSystemLogsRoute(app);
  // Telegram bot webhook — receives commands (/holdings, /alerts, /summary, /help)
  registerTelegramWebhookRoute(app);
  // Market Scan SSE streaming — 5 scan strategies with progress
  registerMarketScanRoute(app);
  // Live price SSE stream — adaptive polling (15 s during market hours, 5 min off-hours)
  registerPriceStreamRoute(app);
  // Deep Analysis SSE stream — instant meta + LLM text streaming
  registerDeepAnalysisStreamRoute(app);
  // Telegram 2FA — OTP verify + resend endpoints
  registerTwoFactorRoutes(app);
  // Local email/password auth (non-Manus users)
  registerLocalAuthRoutes(app);
  // Morning Briefing scheduled endpoint — POST /api/scheduled/morning-briefing
  registerMorningBriefingRoute(app);
  // Market Open Action Briefing — POST /api/scheduled/market-open-briefing
  registerMarketOpenBriefingRoute(app);
  registerEndOfDaySummaryRoute(app);
  registerWeeklySummaryRoute(app);
  // Hourly NLV snapshot — POST /api/scheduled/hourly-snapshot
  registerHourlySnapshotRoute(app);
  // 15-min SL/TP check — POST /api/scheduled/sl-check
  registerSlCheckRoute(app);
  // Nightly SL re-sync from Ziv Engine — POST /api/scheduled/nightly-sl-resync
  registerNightlySlResyncRoute(app);
  // Nightly price cache refresh — POST /api/scheduled/refresh-cache
  registerNightlyCacheRefreshRoute(app);
  // Analyse All SSE stream — POST /api/portfolio/analyze-stream
  registerAnalyzeStreamRoute(app);
  // Analyze single ticker — POST /api/portfolio/analyze-single
  registerAnalyzeSingleRoute(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
      // Allow httpBatchLink methodOverride POST for large query inputs (e.g. getIbkrQuotes)
      allowMethodOverride: true,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    // Log startup to persistent DB
    dbLog("info", "SYSTEM", `Server started on port ${port}`, {
      context: { nodeEnv: process.env.NODE_ENV, port },
    });
    // Clean up any simulations that were left in 'running' state from a previous
    // server crash or restart. This prevents them from being permanently stuck.
    resetStuckSimulations().catch((e) => {
      console.warn("[Startup] Could not reset stuck simulations:", e);
      dbLog("error", "SYSTEM", `Startup: resetStuckSimulations failed: ${e instanceof Error ? e.message : String(e)}`, {
        stack: e instanceof Error ? e.stack : undefined,
      });
    });
    resetStuckAnalyses().catch((e) => {
      console.warn("[Startup] Could not reset stuck analyses:", e);
      dbLog("error", "SYSTEM", `Startup: resetStuckAnalyses failed: ${e instanceof Error ? e.message : String(e)}`, {
        stack: e instanceof Error ? e.stack : undefined,
      });
    });
    // Start price alert polling (every 30 min, sends Telegram when SL/TP hit)
    startAlertPoller();
    startDeleverageCron();
    startZombieRecoveryMonitor();
    startVideoCleanupCron();
    // Start IBKR session monitor (every 60s, sends Telegram when session expires)
    startIbkrSessionMonitor();
    // Load IBIND manual disconnect flag from DB into memory
    refreshIbindDisconnectFlag().catch((e) => console.warn("[Startup] refreshIbindDisconnectFlag failed:", e));
    // Start IBKR heartbeat (POST /tickle every 5 min to keep session alive)
    startIbkrHeartbeat();
    // REST quote poller — feeds shared live price cache for Open Skies / SL monitor
    startIbkrQuotesPoller();
    // runIbkrSync in alertPoller (5 min) — do not also start startIbkrSyncScheduler (was duplicate 60s path)
    // HMAC secret diagnostic — logs on every startup so we can verify the secret is loaded
    const hmacSecret = process.env.IBIND_HMAC_SECRET ?? "";
    console.log(`[HMAC] secret_set=${!!hmacSecret} length=${hmacSecret.length} prefix=${hmacSecret.slice(0, 8)} suffix=${hmacSecret.slice(-8)}`);
    // Register Telegram bot commands (shows in bot menu)
    registerBotCommands();
    // Set Telegram webhook URL — use the deployed domain
    const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
    if (webhookUrl) {
      setTelegramWebhook(`${webhookUrl}/api/telegram/webhook`);
    } else {
      // Auto-detect from known production domain
      const prodDomain = "https://trade-snow2.vip";
      setTelegramWebhook(`${prodDomain}/api/telegram/webhook`);
    }
  });
}

// ── Global Exception Handlers ─────────────────────────────────────────────────
// Catch unhandled rejections and uncaught exceptions, log to DB before dying.
process.on("unhandledRejection", (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  dbLog("critical", "SYSTEM", `Unhandled Rejection: ${err.message}`, {
    stack: err.stack,
    context: { type: "unhandledRejection" },
  });
  console.error("[FATAL] Unhandled Rejection:", err);
});

process.on("uncaughtException", async (err: Error) => {
  dbLog("critical", "SYSTEM", `Uncaught Exception: ${err.message}`, {
    stack: err.stack,
    context: { type: "uncaughtException" },
  });
  console.error("[FATAL] Uncaught Exception:", err);
  // Give 2 seconds for the DB flush to complete before dying
  await flushPersistentLogs();
  await new Promise((r) => setTimeout(r, 2000));
  process.exit(1);
});

process.on("SIGTERM", async () => {
  dbLog("info", "SYSTEM", "SIGTERM received — shutting down gracefully");
  await flushPersistentLogs();
  process.exit(0);
});

startServer().catch(console.error);
