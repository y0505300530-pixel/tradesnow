/**
 * analyzeSingle.ts
 * POST /api/portfolio/analyze-single
 *
 * Synchronous endpoint that analyzes a single ticker and returns the result as JSON.
 * Used by the Asset Catalogue when adding a new ticker to immediately show its score.
 */
import { Express, Request, Response } from "express";
import { sdk } from "../_core/sdk";
import { updateUserAssetScore } from "../db";
import { fetchBarsForTicker, fetchLivePrice, getUsdIlsRate } from "../marketData";
import { normalizeBarsForTicker } from "../services/PriceService";
import { calcZivEngineScore } from "../zivEngine";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms)),
  ]);
}

export function registerAnalyzeSingleRoute(app: Express) {
  app.post("/api/portfolio/analyze-single", async (req: Request, res: Response) => {
    // ── Auth ─────────────────────────────────────────────────────────────────
    let userId: number;
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
      userId = user.id;
    } catch {
      res.status(401).json({ error: "Unauthorized" }); return;
    }

    const { ticker: rawTicker } = req.body ?? {};
    if (!rawTicker || typeof rawTicker !== "string") {
      res.status(400).json({ error: "Missing ticker" }); return;
    }

    const ticker = rawTicker.trim().toUpperCase();

    try {
      // Pre-fetch USD/ILS rate if needed
      let ilsRate = 3.60;
      const isIsraeliStock = ticker.endsWith(".TA");
      if (isIsraeliStock) {
        try { ilsRate = await getUsdIlsRate(); } catch { /* use fallback */ }
      }

      // Fetch bars (with 15s timeout)
      const rawBars = await withTimeout(fetchBarsForTicker(ticker, 420), 15000, `fetchBars(${ticker})`);

      if (rawBars.length < 50) {
        res.json({ ok: false, ticker, reason: "insufficient_data", barCount: rawBars.length });
        return;
      }

      // Normalize .TA bars from agorot to USD via PriceService canonical rule
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

      // Fetch live price (best-effort, 5s timeout)
      let liveChangePercent: number | null = null;
      try {
        const live = await withTimeout(fetchLivePrice(ticker), 5000, `livePrice(${ticker})`);
        liveChangePercent = live?.changePercent ?? null;
      } catch { /* ignore */ }

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

      // Return result
      res.json({
        ok: true,
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
        liveChangePercent,
      });

    } catch (err: any) {
      res.status(500).json({ ok: false, ticker, error: err?.message ?? "Unknown error" });
    }
  });
}
