/**
 * IBKR Gateway Proxy — IBIND only
 *
 * All IBKR operations go through the IBIND OAuth 1.0a server at 143.198.141.131.
 * iBeam has been removed. IBIND handles session management, order placement, and data retrieval.
 *
 * Routes:
 *   GET  /api/ibind/health          → IBIND health + session status
 *   POST /api/ibind/session/start   → Start IBKR session + prime /iserver/accounts
 *   POST /api/ibind/order           → Place order (MKT/STP/LMT)
 *   GET  /api/ibind/positions       → Live IBKR positions
 *   GET  /api/ibind/orders          → Live open orders
 *   GET  /api/ibind/account-summary → Account balance info
 */

import { Express, Request, Response, NextFunction } from "express";
import http from "http";
import { log } from "../logger";
import { ENV } from "../_core/env";
import crypto from "crypto";
import { sdk } from "../_core/sdk";
import { autoFillConids } from "../autoFillConids";
import { getSystemSetting } from "../db";
import { COOKIE_NAME } from "@shared/const";
import { isSessionVerified, requiresTwoFactor } from "../twoFactor";

/** True when the TCP peer is localhost — uses socket address only (not X-Forwarded-For). */
function isLocalSocketRequest(req: Request): boolean {
  const addr = req.socket?.remoteAddress ?? "";
  return addr.includes("127.0.0.1") || addr === "::1" || addr.endsWith("::1");
}

/** In-memory cache for manual disconnect flag (avoids DB query on every request) */
let ibindManuallyDisconnected = false;

/** Refresh the in-memory disconnect flag from DB */
export async function refreshIbindDisconnectFlag(): Promise<boolean> {
  const val = await getSystemSetting("isIbindManuallyDisconnected");
  ibindManuallyDisconnected = val === "true";
  return ibindManuallyDisconnected;
}

/** Check if IBIND is manually disconnected (in-memory, fast) */
export function isIbindManuallyDisconnected(): boolean {
  return ibindManuallyDisconnected;
}

/** Set the in-memory disconnect flag directly (called from procedures) */
export function setIbindDisconnectedFlag(val: boolean): void {
  ibindManuallyDisconnected = val;
}

/** Middleware: only allow admin users to access IBIND proxy routes */
async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user || user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    // Mirror tRPC context gate: owner/admin sessions requiring TOTP must be verified.
    if (requiresTwoFactor(user.openId)) {
      const sessionToken = req.cookies?.[COOKIE_NAME];
      const verified = sessionToken ? await isSessionVerified(sessionToken) : false;
      if (!verified) {
        return res.status(403).json({ error: "TOTP_REQUIRED" });
      }
    }

    return next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

/** Middleware: allow any authenticated user (admin or regular user) */
async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    return next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

// ── IBIND server — OAuth 1.0a bridge (HTTP + Bearer auth + HMAC-SHA256) ──────
// URL: http://35.237.64.218:80 (nginx relay on cloud PC → 143.198.141.131:80)
// The DigitalOcean droplet (143.198.141.131) only allows port 80 from the cloud PC (35.237.64.218).
// Cloud Run cannot reach 143.198.141.131:80 directly, so we relay through the cloud PC.
// Auth: Authorization: Bearer <IBIND_API_SECRET>  +  HMAC-SHA256 request signing
const IBIND_HOST = process.env.IBIND_HOST_OVERRIDE ?? "35.237.64.218";
const IBIND_PORT = parseInt(process.env.IBIND_PORT_OVERRIDE ?? "80", 10);

/**
 * Build HMAC-SHA256 signing headers for an IBIND request.
 *
 * Signature string: `${timestamp}:${nonce}:${rawBodyBytes}`
 *   - timestamp: unix seconds as string
 *   - nonce: 16 random bytes as 32-char lowercase hex
 *   - rawBodyBytes: exact UTF-8 bytes of the JSON body (empty Buffer for GET/no-body)
 */
function signRequest(
  hmacSecret: string,
  bodyBuf: Buffer
): { timestamp: string; nonce: string; signature: string } {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const prefix = Buffer.from(`${timestamp}:${nonce}:`, "utf-8");
  const msg = Buffer.concat([prefix, bodyBuf]);
  const signature = crypto.createHmac("sha256", hmacSecret).update(msg).digest("hex");
  return { timestamp, nonce, signature };
}

/** HMAC error codes returned by the IBIND server on 401 */
const HMAC_RETRY_CODES = new Set([
  "hmac_missing_headers",
  "hmac_bad_timestamp",
  "hmac_timestamp_out_of_window",
  "hmac_nonce_replay",
  "hmac_bad_signature",
]);

/**
 * Make an HTTP request to the IBIND server.
 * Every request is signed with HMAC-SHA256 (X-Timestamp / X-Nonce / X-Signature)
 * AND carries Authorization: Bearer <IBIND_API_SECRET> (defense in depth).
 * On a 401 HMAC error the request is retried ONCE with a fresh timestamp+nonce.
 * Timeout is 35s to allow for the OAuth 1.0a handshake with IBKR.
 */
export function ibindRequest(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<{ ok: boolean; status: number; body: unknown }> {
  // Guard: if IBIND is manually disconnected, reject immediately
  if (ibindManuallyDisconnected) {
    return Promise.resolve({ ok: false, status: 503, body: { error: "IBIND manually disconnected" } });
  }

  const bearerSecret = ENV.ibindApiSecret;
  if (!bearerSecret) {
    return Promise.reject(new Error("IBIND_API_SECRET is not configured"));
  }

  const hmacSecret = ENV.ibindHmacSecret;
  if (!hmacSecret) {
    return Promise.reject(new Error(
      `[IBIND] IBIND_HMAC_SECRET is not loaded in this process. ` +
      `ENV.ibindHmacSecret='${hmacSecret}' (length=${hmacSecret?.length ?? 0}). ` +
      `Check that the secret is saved in the Secrets UI and the server was restarted after saving.`
    ));
  }

  const bodyBuf: Buffer =
    body !== undefined
      ? Buffer.from(JSON.stringify(body), "utf-8")
      : Buffer.alloc(0);

  function doRequest(attempt: number): Promise<{ ok: boolean; status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const { timestamp, nonce, signature } = signRequest(hmacSecret, bodyBuf);
      const headers: Record<string, string | number> = {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${bearerSecret}`,
        "X-Timestamp": timestamp,
        "X-Nonce": nonce,
        "X-Signature": signature,
        ...(extraHeaders ?? {}),
      };

      if (bodyBuf.length > 0) {
        headers["Content-Length"] = bodyBuf.length;
      }

      const options: http.RequestOptions = {
        hostname: IBIND_HOST,
        port: IBIND_PORT,
        path,
        method: method.toUpperCase(),
        headers,
      };

      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          let parsed: unknown = {};
          try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }

          const status = res.statusCode ?? 500;
          if (
            status === 401 &&
            attempt === 0 &&
            hmacSecret &&
            typeof parsed === "object" &&
            parsed !== null &&
            HMAC_RETRY_CODES.has((parsed as Record<string, string>).error ?? "")
          ) {
            log.warn("IBKR", "[IBIND] HMAC 401 — retrying with fresh timestamp+nonce", {
              error: (parsed as Record<string, string>).error,
            });
            doRequest(1).then(resolve).catch(reject);
            return;
          }

          resolve({ ok: status < 400, status, body: parsed });
        });
      });

      // Timeout: 5s for fast ops (quotes/positions/health), 15s for watchlist+order ops, 30s for stock lookup, 40s for session/start (OAuth flow)
      // Order ops (/orders/*) get 15s because IBKR order ACK can exceed 5s at the 16:30 open (slow gateway) → false timeout → missed entry.
      const isSlowOp = path === '/session/start' || path === '/session/stop';
      const isStockLookup = path.startsWith('/trsrv/stocks');
      const isQuotesOp = path === '/quotes';
      const isPositionsOp = path === '/positions' || path === '/pnl' || path === '/account/summary';
      const isWatchlistOp = path.includes('/watchlist');
      const isOrderOp = path.startsWith('/orders/');
      const timeoutMs = isSlowOp ? 40_000
        : isStockLookup || isQuotesOp ? 30_000
        : isPositionsOp || isWatchlistOp || isOrderOp ? 15_000
        : 5_000;
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new Error(`IBIND request timed out after ${timeoutMs / 1000}s`));
      });
      req.on("error", reject);
      if (bodyBuf.length > 0) req.write(bodyBuf);
      req.end();
    });
  }

  return doRequest(0);
}

// ── Route registration ────────────────────────────────────────────────────────

/**
 * Re-prime the IBKR session context when IBKR returns "Please query /accounts first".
 *
 * The IBIND server's POST /session/start calls receive_brokerage_accounts() internally,
 * which is the only way to re-prime the context. There is NO standalone /accounts endpoint
 * on the IBIND server — only the passthrough /api/proxy/iserver/accounts.
 *
 * When the IBKR Client Portal Gateway loses its context (e.g. after idle time), calling
 * POST /session/start again re-establishes it. This is safe and idempotent.
 */
export async function primeAccountsIfNeeded(): Promise<void> {
  try {
    // First try the passthrough (fastest, no side-effects)
    const r = await ibindRequest("GET", "/api/proxy/iserver/accounts");
    log.info("PROXY", "primeAccountsIfNeeded: passthrough /iserver/accounts", { ok: r.ok, status: r.status });
    if (r.ok) return;
  } catch (err: any) {
    log.warn("PROXY", "primeAccountsIfNeeded: passthrough failed", { error: err.message });
  }
  // Fallback: re-run session/start which calls receive_brokerage_accounts() internally
  try {
    const r = await ibindRequest("POST", "/session/start");
    log.info("PROXY", "primeAccountsIfNeeded: session/start re-primed", { ok: r.ok, status: r.status });
  } catch (err: any) {
    log.warn("PROXY", "primeAccountsIfNeeded: session/start fallback failed", { error: err.message });
  }
}

export function registerIbkrProxyRoute(app: Express) {
  // Apply admin-only guard to most /api/ibind/* routes
  // Exception: order placement and conid resolution are available to all authenticated users
  app.use("/api/ibind", requireAdmin);
  // Override: allow authenticated (non-admin) users to place orders and resolve conids
  // These routes are registered BEFORE the admin guard catches them via specific path matching
  // Note: the app.use above applies to ALL /api/ibind/* — we override per-route below via requireAuth
  // The tRPC layer (protectedProcedure) handles the auth for order procedures — no extra Express guard needed

  /**
   * GET /api/ibind/health
   * Returns IBIND server health + session status.
   */
  app.get("/api/ibind/health", async (_req: Request, res: Response) => {
    // Fast timeout: health check must respond within 3s so the UI never hangs.
    // ibindRequest now has a 5s timeout, but we want to respond faster.
    const healthTimeout = setTimeout(() => {
      if (!res.headersSent) {
        res.status(502).json({ status: "error", session_active: false, error: "IBIND health check timed out" });
      }
    }, 3000);
    try {
      const { ok, status, body } = await ibindRequest("GET", "/health");
      clearTimeout(healthTimeout);
      if (res.headersSent) return; // already sent by timeout
      log.debug("PROXY", "IBIND health check", { ok, status });
      return res.status(status).json(body);
    } catch (err: any) {
      clearTimeout(healthTimeout);
      if (res.headersSent) return;
      log.warn("PROXY", "IBIND health check failed", { error: err.message });
      return res.status(502).json({ status: "error", session_active: false, error: err.message });
    }
  });

  /**
   * POST /api/ibind/session/start
   * Establishes IBKR session via IBIND OAuth 1.0a — can take up to 30s.
   * CRITICAL: awaits /iserver/accounts prime before returning so all subsequent
   * order calls find the session context already primed.
   */
  app.post("/api/ibind/session/start", async (_req: Request, res: Response) => {
    try {
      log.info("PROXY", "IBIND: Starting IBKR session");
      const { ok, status, body } = await ibindRequest("POST", "/session/start");
      log.info("PROXY", "IBIND: Session start result", { ok, status, body: JSON.stringify(body).slice(0, 200) });
      // Note: IBIND's session/start already calls receive_brokerage_accounts() internally.
      // No manual priming needed here.
      // Auto-fill missing conids in the background (fire-and-forget)
      if (ok) autoFillConids().catch(() => {});
      return res.status(status).json(body);
    } catch (err: any) {
      log.error("PROXY", "IBIND: Session start failed", { error: err.message });
      return res.status(502).json({ success: false, session_active: false, message: err.message });
    }
  });

  /**
   * POST /api/ibind/order
   * Place an order via IBIND.
   * Body: { account_id, ticker, side, order_type, quantity, stop_price?, limit_price? }
   */
  app.post("/api/ibind/order", async (req: Request, res: Response) => {
    try {
      const { account_id, ticker, side, order_type, quantity, stop_price, limit_price } = req.body;
      if (!account_id || !ticker || !side || !order_type || !quantity) {
        return res.status(400).json({ success: false, message: "Missing required fields: account_id, ticker, side, order_type, quantity" });
      }
      log.info("PROXY", "IBIND: Placing order", { ticker, side, order_type, quantity });
      const { ok, status, body } = await ibindRequest("POST", "/order", {
        account_id,
        ticker,
        side,
        order_type,
        quantity,
        ...(stop_price !== undefined ? { stop_price } : {}),
        ...(limit_price !== undefined ? { limit_price } : {}),
      });
      log.info("PROXY", "IBIND: Order result", { ok, status, body: JSON.stringify(body).slice(0, 300) });
      return res.status(status).json(body);
    } catch (err: any) {
      log.error("PROXY", "IBIND: Order placement failed", { error: err.message });
      return res.status(502).json({ success: false, message: `IBIND order failed: ${err.message}` });
    }
  });

  /**
   * GET /api/ibind/positions
   * Returns live IBKR positions via IBIND.
   */
  app.get("/api/ibind/positions", async (_req: Request, res: Response) => {
    try {
      const r = await ibindRequest("GET", "/positions");
      log.debug("PROXY", "IBIND positions", { ok: r.ok, status: r.status });
      return res.status(r.status).json(r.body);
    } catch (err: any) {
      log.error("PROXY", "IBIND positions failed", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/ibind/trades
   * Returns today's executions from IBKR with commission data.
   * Uses /iserver/account/trades (no accountId needed — returns all for session).
   */
  app.get("/api/ibind/trades", async (_req: Request, res: Response) => {
    try {
      const r = await ibindRequest("GET", "/api/proxy/iserver/account/trades");
      if (!r.ok) return res.status(r.status).json(r.body);
      const allTrades: any[] = (r.body as any[]) ?? [];
      // Filter to today (trade_time format: "YYYYMMDD-HH:MM:SS")
      const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // "20260617"
      const todayTrades = allTrades.filter(t => String(t.trade_time ?? "").startsWith(todayStr));
      const totalCommission = todayTrades.reduce((s, t) => s + Math.abs(parseFloat(t.commission ?? "0") || 0), 0);
      const totalVolume = todayTrades.reduce((s, t) => s + Math.abs(parseFloat(t.net_amount ?? "0") || 0), 0);
      return res.status(200).json({
        success: true,
        today: todayStr,
        totalTrades: todayTrades.length,
        totalCommission: Math.round(totalCommission * 100) / 100,
        totalVolume: Math.round(totalVolume * 100) / 100,
        trades: todayTrades,
      });
    } catch (err: any) {
      log.error("PROXY", "IBIND trades failed", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/ibind/orders
   * Returns live open orders via IBIND.
   *
   * If IBKR returns "Please query /accounts first", the session context has been lost.
   * We re-prime by calling GET /api/proxy/iserver/accounts (passthrough) or POST /session/start
   * as fallback, then retry /orders once.
   */
  app.get("/api/ibind/orders", async (_req: Request, res: Response) => {
    try {
      let r = await ibindRequest("GET", "/orders");
      log.debug("PROXY", "IBIND orders", { ok: r.ok, status: r.status });

      // Detect "Please query /accounts first" in any field of the error body
      const b = r.body as Record<string, any>;
      const errStr = JSON.stringify(b ?? "");
      const needsPrime = !r.ok && errStr.includes("Please query /accounts first");

      if (needsPrime) {
        log.info("PROXY", "IBIND orders: session context lost — re-priming and retrying");
        await primeAccountsIfNeeded();
        await new Promise(resolve => setTimeout(resolve, 800));
        r = await ibindRequest("GET", "/orders");
        log.info("PROXY", "IBIND orders: retry after re-prime", { ok: r.ok, status: r.status });
      }

      return res.status(r.status).json(r.body);
    } catch (err: any) {
      log.error("PROXY", "IBIND orders failed", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/ibind/account-summary
   * Returns account balance info via IBIND.
   */
  app.get("/api/ibind/account-summary", async (_req: Request, res: Response) => {
    try {
      const r = await ibindRequest("GET", "/account/summary");
      log.debug("PROXY", "IBIND account-summary", { ok: r.ok, status: r.status });
      return res.status(r.status).json(r.body);
    } catch (err: any) {
      log.error("PROXY", "IBIND account-summary failed", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/ibind/pnl
   * Calls IBKR /pnl/partitioned (via IBIND /pnl).
   * Raw IBKR shape: { upnl: { "U1234567.Core": { dpl, upl, nl, el, mv, rowType } } }
   * We normalise to flat: { daily_pnl, unrealized_pnl, net_liquidation, market_value, excess_liquidity, account_id, partitions, raw }
   */
  app.get("/api/ibind/pnl", async (_req: Request, res: Response) => {
    try {
      const r = await ibindRequest("GET", "/pnl");
      log.debug("PROXY", "IBIND pnl", { ok: r.ok, status: r.status });
      if (!r.ok || !r.body) {
        return res.status(r.status).json(r.body);
      }
      // Parse partitioned PnL response:
      // { upnl: { "<accountId>.Core": { dpl, upl, nl, el, mv } } }
      const raw = r.body as Record<string, any>;
      const partitions: Record<string, any> = raw.upnl ?? {};
      const keys = Object.keys(partitions);
      // Sum across all partitions (handles multi-segment accounts)
      let daily_pnl = 0;
      let unrealized_pnl = 0;
      let net_liquidation = 0;
      let market_value = 0;
      let excess_liquidity = 0;
      let account_id: string | null = null;
      for (const key of keys) {
        const p = partitions[key];
        if (typeof p.dpl === "number") daily_pnl += p.dpl;
        if (typeof p.upl === "number") unrealized_pnl += p.upl;
        if (typeof p.nl  === "number") net_liquidation += p.nl;
        if (typeof p.mv  === "number") market_value += p.mv;
        if (typeof p.el  === "number") excess_liquidity += p.el;
        if (!account_id) account_id = key.split(".")[0];
      }
      log.info("PROXY", "IBIND pnl parsed", { daily_pnl, unrealized_pnl, net_liquidation, market_value, excess_liquidity, account_id, keys });
      return res.status(200).json({
        daily_pnl,
        unrealized_pnl,
        net_liquidation,
        market_value,
        excess_liquidity,
        account_id,
        partitions,
        raw,
      });
    } catch (err: any) {
      log.error("PROXY", "IBIND pnl failed", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/ibind/quotes
   * Get live market data (price + daily change) for arbitrary symbols.
   * Proxies to IBIND /quotes which uses /trsrv/stocks + /iserver/marketdata/snapshot.
   * Body: { symbols: string[], exchange_hint?: string }
   * Response: { success, quotes: [{symbol, conid, last_price, change, change_percent, prior_close, delayed}], unresolved }
   */
  app.post("/api/ibind/quotes", async (req: Request, res: Response) => {
    try {
      const { symbols, conids, fields, exchange_hint } = req.body || {};
      if (!symbols && !conids) {
        return res.status(400).json({ error: 'bad_request', message: 'Provide symbols[] or conids[]' });
      }
      const r = await ibindRequest("POST", "/quotes", { symbols, conids, fields, exchange_hint });
      log.debug("PROXY", "IBIND quotes", { ok: r.ok, status: r.status, symbolCount: (symbols ?? conids ?? []).length });
      return res.status(r.status).json(r.body);
    } catch (err: any) {
      log.error("PROXY", "IBIND quotes failed", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/ibind/performance/portfolio?period=1Y
   * Returns IBKR historical NAV data for the Portfolio Equity Curve.
   * period: MTD | YTD | 1M | 3M | 6M | 1Y | 5Y
   * On 401 no_active_session → client should POST /api/ibind/session/start first.
   */
  const VALID_PERIODS = new Set(["MTD", "YTD", "1M", "3M", "6M", "1Y", "5Y"]);
  app.get("/api/ibind/performance/portfolio", async (req: Request, res: Response) => {
    try {
      const period = (req.query.period as string) || "1Y";
      if (!VALID_PERIODS.has(period)) {
        return res.status(400).json({
          error: "bad_period",
          allowed: Array.from(VALID_PERIODS),
        });
      }
      const r = await ibindRequest("GET", `/performance/portfolio?period=${period}`);
      log.debug("PROXY", "IBIND performance/portfolio", { ok: r.ok, status: r.status, period });
      return res.status(r.status).json(r.body);
    } catch (err: any) {
      log.error("PROXY", "IBIND performance/portfolio failed", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Internal War Engine Trigger (localhost only) ─────────────────────────
  app.post("/api/internal/war-engine/trigger", async (req: Request, res: Response) => {
    if (!isLocalSocketRequest(req)) {
      return res.status(403).json({ error: "forbidden" });
    }
    try {
      const { runWarEngineCycle } = await import("../warEngine");
      const result = await runWarEngineCycle(1);
      return res.json({ ok: true, scanned: result.scanned, entered: result.entered, regime: result.regimeDecision });
    } catch (e: any) {
      return res.status(500).json({ error: (e as Error).message });
    }
  });
  // ── Deleverage EOD endpoint (called by cron at 22:15 Israel) ───────────────
  app.post("/api/internal/deleverage", async (req: Request, res: Response) => {
    if (!isLocalSocketRequest(req)) {
      return res.status(403).json({ error: "forbidden" });
    }
    try {
      const { runDeleveragingCycle } = await import("../liveOrderExecutor");
      const result = await runDeleveragingCycle(1);
      return res.json({ ok: true, trimmed: result.trimmed, failed: result.failed,
        uvBefore: result.uvBeforeUsd, uvAfter: result.uvAfterUsd });
    } catch (e: any) {
      return res.status(500).json({ error: (e as Error).message });
    }
  });

  // Manual IBKR position sync trigger
  app.post("/api/internal/ibkr-sync", async (req: Request, res: Response) => {
    const bearer = (req.headers["authorization"] ?? "").replace("Bearer ", "").trim();
    if (bearer !== process.env.IBIND_API_SECRET) {
      return res.status(403).json({ error: "forbidden" });
    }
    try {
      const { runIbkrPositionSync } = await import("../ibkrPositionSync");
      const result = await runIbkrPositionSync(1);
      return res.json({ ok: true, ...result });
    } catch (e: any) {
      return res.status(500).json({ error: (e as Error).message });
    }
  });

}

