/**
 * priceStream.ts
 * GET /api/prices/stream?tickers=AAPL,MSFT,...
 *
 * Server-Sent Events endpoint that pushes live prices every ~15 s during
 * trading hours (NYSE + TASE) and every 5 min outside of trading hours.
 *
 * Authentication: reads the session cookie via sdk.authenticateRequest,
 * identical to the pattern used in labStream.ts.
 *
 * Event format:
 *   data: {"ticker":"AAPL","price":182.5,"change":-0.3,"changePercent":-0.16,"isExtendedHours":false}
 *
 * The client hook (usePriceStream) injects these directly into the React Query
 * cache via queryClient.setQueryData, so no HTTP re-fetch is triggered.
 */
import { Express, Request, Response } from "express";
import { sdk } from "../_core/sdk";
import { fetchIbkrLivePricesBatch } from "../marketData";
import { isTaseClosedToday } from "../utils/marketHours";

// ── Trading hours helpers ──────────────────────────────────────────────────────

/**
 * Returns true if NYSE (NASDAQ) is currently open.
 * NYSE: Mon–Fri 09:30–16:00 ET (UTC-5 winter / UTC-4 summer)
 */
function isNasdaqOpen(): boolean {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const month = now.getUTCMonth(); // 0-based
  // DST: second Sunday of March → first Sunday of November (approx month 2–10)
  const etOffsetHours = month >= 2 && month <= 10 ? 4 : 5;
  const etMinutes = (now.getUTCHours() - etOffsetHours) * 60 + now.getUTCMinutes();
  return etMinutes >= 9 * 60 + 30 && etMinutes < 16 * 60;
}

/**
 * Returns true if NYSE pre-market or after-hours session is active.
 * Pre-market:  04:00–09:30 ET
 * After-hours: 16:00–20:00 ET
 */
function isNasdaqExtended(): boolean {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const month = now.getUTCMonth();
  const etOffsetHours = month >= 2 && month <= 10 ? 4 : 5;
  const etMinutes = (now.getUTCHours() - etOffsetHours) * 60 + now.getUTCMinutes();
  // Pre-market: 04:00–09:30, After-hours: 16:00–20:00
  return (etMinutes >= 4 * 60 && etMinutes < 9 * 60 + 30) ||
         (etMinutes >= 16 * 60 && etMinutes < 20 * 60);
}

/**
 * Returns true if TASE (Tel Aviv Stock Exchange) is currently open.
 * TASE: Mon–Thu 10:00–17:30, Fri 10:00–14:30 Israel Time (UTC+3).
 * Closed: Sat, Sun.
 */
function isTaseOpen(): boolean {
  const now = new Date();
  const ilMs = now.getTime() + 3 * 3600 * 1000;
  const il = new Date(ilMs);
  const day = il.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false; // Sat, Sun closed
  const ilMinutes = il.getUTCHours() * 60 + il.getUTCMinutes();
  const open = 10 * 60; // 10:00
  const close = day === 5 ? 14 * 60 + 30 : 17 * 60 + 30; // Fri 14:30, Mon-Thu 17:30
  return ilMinutes >= open && ilMinutes < close;
}

/** Returns true if either exchange is currently open. */
function isAnyMarketOpen(): boolean {
  return isNasdaqOpen() || isTaseOpen();
}

/**
 * Three-tier polling interval:
 *   60 s  — regular trading hours (NYSE or TASE open)
 *   60 s  — pre-market / after-hours (NYSE extended session)
 *   5 min — market fully closed (nights, weekends)
 */
function getPollIntervalMs(): number {
  if (isAnyMarketOpen()) return 10_000;
  if (isNasdaqExtended()) return 10_000;
  return 5 * 60_000;
}

// ── Route registration ─────────────────────────────────────────────────────────

export function registerPriceStreamRoute(app: Express) {
  app.get("/api/prices/stream", async (req: Request, res: Response) => {
    // ── 1. Authenticate ──────────────────────────────────────────────────────
    let userId: number;
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      userId = user.id;
    } catch {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // ── 2. Parse tickers ─────────────────────────────────────────────────────
    const raw = typeof req.query.tickers === "string" ? req.query.tickers : "";
    const tickers = raw
      .split(",")
      .map(t => t.trim().toUpperCase())
      .filter(t => t.length > 0 && t.length <= 10)
      .slice(0, 100); // safety cap

    if (tickers.length === 0) {
      res.status(400).json({ error: "No valid tickers provided" });
      return;
    }

    // ── 3. SSE headers ───────────────────────────────────────────────────────
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable nginx/proxy buffering
    res.flushHeaders();

    // ── 4. Helpers ───────────────────────────────────────────────────────────
    let closed = false;

    const sendPrices = async () => {
      if (closed || res.writableEnded) return;
      try {
        const priceMap = await fetchIbkrLivePricesBatch(tickers);
        const taseNoSessionToday = isTaseClosedToday();
        for (const ticker of tickers) {
          if (closed || res.writableEnded) break;
          const live = priceMap.get(ticker);
          const isTaTicker = ticker.endsWith('.TA');
          const zeroChange = isTaTicker && taseNoSessionToday;
          const payload = {
            ticker,
            price: live?.price ?? null,
            change: zeroChange ? 0 : (live?.change ?? null),
            changePercent: zeroChange ? 0 : (live?.changePercent ?? null),
            prevClose: live?.prevClose ?? null,
            isExtendedHours: live?.isExtendedHours ?? false,
          };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      } catch {
        // Swallow fetch errors — client will reconnect via EventSource auto-retry
      }
    };

    // ── 5. Initial push (immediate) ──────────────────────────────────────────
    await sendPrices();

    // ── 6. Heartbeat every 20 s to keep proxy connections alive ─────────────
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(`: heartbeat\n\n`);
      } else {
        clearInterval(heartbeat);
      }
    }, 20_000);

    // ── 7. Adaptive polling loop ─────────────────────────────────────────────
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const schedulePoll = () => {
      if (closed) return;
      const delay = getPollIntervalMs();
      pollTimer = setTimeout(async () => {
        await sendPrices();
        schedulePoll(); // re-schedule with fresh interval
      }, delay);
    };

    schedulePoll();

    // ── 8. Cleanup on client disconnect ─────────────────────────────────────
    req.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      if (pollTimer) clearTimeout(pollTimer);
    });

    // Suppress unused variable warning — userId is captured for future
    // per-user rate-limiting or audit logging.
    void userId;
  });
}
