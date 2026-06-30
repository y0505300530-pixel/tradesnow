/**
 * analyzeStream.ts
 * POST /api/portfolio/analyze-stream
 *
 * Server-Sent Events endpoint that processes each catalogue asset one-by-one
 * and emits a result event immediately after each ticker is scored.
 * This replaces the blocking analyzeAssetList mutation for the "Analyze All" button.
 *
 * Event types:
 *   { type: "start",    total: number }
 *   { type: "result",   ticker, zivScore, tier, recommendation, cmp, ema50, recommendedBuyPrice, recommendedStopLoss, reason, progress: { done, total, pct } }
 *   { type: "skip",     ticker, reason, progress: { done, total, pct } }
 *   { type: "done",     totalScanned, skippedTickers, analyzedAt }
 *   { type: "error",    message }
 */
import { Express, Request, Response } from "express";
import { sdk } from "../_core/sdk";
import { getUserAssets, updateUserAssetScore } from "../db";
import { fetchBarsForTicker, fetchLivePrice, getUsdIlsRate } from "../marketData";
import { normalizeBarsForTicker } from "../services/PriceService";
import { calcZivEngineScore } from "../zivEngine";

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms)),
  ]);
}

export function registerAnalyzeStreamRoute(app: Express) {
  app.post("/api/portfolio/analyze-stream", async (req: Request, res: Response) => {
    // ── Auth ─────────────────────────────────────────────────────────────────
    let userId: number;
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
      userId = user.id;
    } catch {
      res.status(401).json({ error: "Unauthorized" }); return;
    }

    // ── SSE headers ──────────────────────────────────────────────────────────
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (data: object) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    };

    // Heartbeat to prevent proxy timeout
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(`: heartbeat\n\n`);
      else clearInterval(heartbeat);
    }, 15000);

    let aborted = false;
    req.on("close", () => { aborted = true; clearInterval(heartbeat); });

    try {
      // ── Load assets ──────────────────────────────────────────────────────
      const userAssets = await getUserAssets(userId);
      const tickers = (userAssets ?? [])
        .map((a: any) => a.ticker)
        .filter((t: string) => t && t.length > 0);

      if (tickers.length === 0) {
        send({ type: "done", totalScanned: 0, skippedTickers: [], analyzedAt: new Date().toISOString() });
        res.end();
        return;
      }

      send({ type: "start", total: tickers.length });

      // Pre-fetch USD/ILS rate once
      let ilsRate = 3.60;
      const hasTa = tickers.some((t: string) => t.toUpperCase().endsWith(".TA"));
      if (hasTa) {
        try { ilsRate = await getUsdIlsRate(); } catch { /* use fallback */ }
      }

      let done = 0;
      const skippedTickers: string[] = [];

      for (let i = 0; i < tickers.length; i++) {
        if (aborted) break;

        const ticker = tickers[i].toUpperCase();
        done++;
        const pct = Math.round((done / tickers.length) * 100);
        const progress = { done, total: tickers.length, pct };

        try {
          // Fetch bars for this ticker (with 15s timeout to prevent stream stall)
          const rawBars = await withTimeout(fetchBarsForTicker(ticker, 420), 15000, `fetchBars(${ticker})`);

          if (rawBars.length < 50) {
            skippedTickers.push(ticker);
            send({ type: "skip", ticker, reason: "insufficient_data", progress });
            // Small delay to avoid rate limiting
            if (i > 0 && i % 3 === 0) await sleep(300);
            continue;
          }

          // Normalize .TA bars from agorot to USD via PriceService canonical rule (fixes 100x bug)
          const isIsraeliStock = ticker.endsWith(".TA");
          const bars = normalizeBarsForTicker(rawBars, ticker, ilsRate);

          // Run ZIV Engine
          const ziv = calcZivEngineScore(bars);
          const score = ziv.score;

          const recommendation = ziv.tier === "Gold Breakout" ? "STRONG BUY"
            : ziv.tier === "Gold Retest" ? "BUY"
            : ziv.tier === "Near Entry Watch" ? "WATCH" : "AVOID";

          // Recommended buy price
          let recommendedBuyPrice: number;
          if (ziv.tier === "Gold Breakout") {
            recommendedBuyPrice = parseFloat(ziv.price.toFixed(2));
          } else if (ziv.tier === "Gold Retest") {
            recommendedBuyPrice = parseFloat(ziv.ema50.toFixed(2));
          } else {
            recommendedBuyPrice = parseFloat((ziv.ema50 * 0.99).toFixed(2));
          }

          // Stop loss
          const last14 = bars.slice(-14);
          const atr14 = last14.reduce((sum, bar, idx) => {
            const prevClose = idx > 0 ? last14[idx - 1].close : bar.close;
            const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
            return sum + tr;
          }, 0) / 14;
          const atrStopLoss = parseFloat((recommendedBuyPrice - atr14 * 1.5).toFixed(2));
          const emaStopLoss = parseFloat((ziv.ema50 * 0.97).toFixed(2));
          const rawStop = Math.min(atrStopLoss, emaStopLoss);
          const minStop = parseFloat((recommendedBuyPrice * 0.995).toFixed(2));
          const recommendedStopLoss = Math.min(rawStop, minStop);

          // Hot signal
          const hotSignal = (
            (ziv.tier === "Gold Breakout" || ziv.tier === "Gold Retest") &&
            ziv.price > ziv.ema200 &&
            ziv.weeklyEma50Slope > 0
          ) ? 1 : 0;

          // Fetch live price (non-blocking, best-effort, 5s timeout)
          let liveChangePercent: number | null = null;
          try {
            const live = await withTimeout(fetchLivePrice(ticker), 5000, `livePrice(${ticker})`);
            liveChangePercent = live?.changePercent ?? null;
          } catch { /* ignore timeout or error */ }

          // Persist to DB
          await updateUserAssetScore(userId, ticker, score, liveChangePercent, {
            cmp: ziv.price,
            ema50: ziv.ema50,
            ema200: ziv.ema200,
            proximityToEma50Pct: ziv.distToEma50Pct,
            recommendation,
            reason: ziv.reason,
            tier: ziv.tier,
            weeklyEma50Slope: ziv.weeklyEma50Slope,
            donchian20High: ziv.donchian20High,
            priceAction: ziv.priceAction ?? undefined,
            recommendedBuyPrice,
            recommendedStopLoss,
            hotSignal,
          });

          // Emit result immediately
          send({
            type: "result",
            ticker,
            zivScore: score,
            tier: ziv.tier,
            recommendation,
            cmp: parseFloat(ziv.price.toFixed(2)),
            ema50: parseFloat(ziv.ema50.toFixed(2)),
            ema200: parseFloat(ziv.ema200.toFixed(2)),
            proximityToEma50Pct: parseFloat(ziv.distToEma50Pct.toFixed(1)),
            weeklyEma50Slope: parseFloat(ziv.weeklyEma50Slope.toFixed(3)),
            donchian20High: parseFloat(ziv.donchian20High.toFixed(2)),
            priceAction: ziv.priceAction,
            reason: ziv.reason,
            recommendedBuyPrice: parseFloat(recommendedBuyPrice.toFixed(2)),
            recommendedStopLoss: parseFloat(recommendedStopLoss.toFixed(2)),
            hotSignal,
            progress,
          });

        } catch (err: any) {
          skippedTickers.push(ticker);
          send({ type: "skip", ticker, reason: err?.message ?? "error", progress });
        }

        // Rate limiting delay: every 3 tickers
        if (i > 0 && i % 3 === 0) {
          await sleep(tickers.length > 20 ? 500 : 300);
        }
      }

      // Final done event
      send({
        type: "done",
        totalScanned: done - skippedTickers.length,
        skippedTickers,
        analyzedAt: new Date().toISOString(),
      });

    } catch (err: any) {
      send({ type: "error", message: err?.message ?? "Unknown error" });
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  });
}
