/**
 * SSE streaming endpoint for Deep Analysis.
 * GET /api/deep-analysis/stream?ticker=X[&buyPrice=N&units=N&currentPrice=N&pnlUsd=N&pnlPct=N&stopLoss=N&takeProfit=N&portfolioSize=N&diaryReason=...&diaryExpectation=...]
 *
 * Protocol:
 *   event: cached   — cache hit, data = full DeepAnalysisResult JSON (instant)
 *   event: meta     — Ziv Engine result + structured data (instant, before LLM call)
 *   event: chunk    — LLM text chunk (streaming)
 *   event: done     — full result JSON (after LLM finishes)
 *   event: error    — error message string
 */
import { Express, Request, Response } from "express";
import { sdk } from "../_core/sdk";
import { calcZivEngineScore } from "../zivEngine";
import { fetchBarsForTicker, fetchLivePrice, fetchIbkrLivePricesBatch } from "../marketData";
import { getDeepAnalysisCache, setDeepAnalysisCache, getPortfolioAccount, getPortfolioHoldings, updatePortfolioHolding } from "../db";
import { ENV } from "../_core/env";
import {
  buildDeepAnalysisMeta,
  buildDeepAnalysisPrompt,
  DEEP_ANALYSIS_SYSTEM_PROMPT,
} from "../deepAnalysisMeta";

const DEEP_ANALYSIS_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function resolveForgeUrl() {
  return ENV.forgeApiUrl && ENV.forgeApiUrl.trim().length > 0
    ? `${ENV.forgeApiUrl.replace(/\/$/, "")}/v1/chat/completions`
    : "https://forge.manus.im/v1/chat/completions";
}

export function registerDeepAnalysisStreamRoute(app: Express) {
  app.get("/api/deep-analysis/stream", async (req: Request, res: Response) => {
    // ── Auth ──────────────────────────────────────────────────────────────────
    let userId: number;
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
      userId = user.id;
    } catch {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // ── Parse query params ────────────────────────────────────────────────────
    const ticker = (req.query.ticker as string ?? "").toUpperCase().trim();
    if (!ticker) { res.status(400).json({ error: "ticker is required" }); return; }

    const buyPrice    = req.query.buyPrice    ? parseFloat(req.query.buyPrice as string)    : undefined;
    const units       = req.query.units       ? parseFloat(req.query.units as string)       : undefined;
    const currentPrice = req.query.currentPrice ? parseFloat(req.query.currentPrice as string) : undefined;
    const pnlUsd      = req.query.pnlUsd      ? parseFloat(req.query.pnlUsd as string)      : undefined;
    const pnlPct      = req.query.pnlPct      ? parseFloat(req.query.pnlPct as string)      : undefined;
    const stopLossIn  = req.query.stopLoss    ? parseFloat(req.query.stopLoss as string)    : undefined;
    const takeProfitIn = req.query.takeProfit ? parseFloat(req.query.takeProfit as string)  : undefined;
    const portfolioSize = req.query.portfolioSize ? parseFloat(req.query.portfolioSize as string) : undefined;
    const diaryReason = req.query.diaryReason as string | undefined;
    const diaryExpectation = req.query.diaryExpectation as string | undefined;

    const hc = (buyPrice != null && units != null && currentPrice != null && pnlUsd != null && pnlPct != null)
      ? { buyPrice, units, currentPrice, pnlUsd, pnlPct, stopLoss: stopLossIn ?? null, takeProfit: takeProfitIn ?? null, diaryReason: diaryReason ?? null, diaryExpectation: diaryExpectation ?? null }
      : null;

    // ── Cache key (round currentPrice to $1 to survive minor SSE price updates) ──
    const today = new Date().toISOString().slice(0, 10);
    const holdingHash = hc
      ? `${Math.round(hc.buyPrice * 100)}_${hc.units}_${Math.round(hc.currentPrice)}`
      : "none";
    const cacheKey = `${today}:${holdingHash}`;

    // ── SSE headers ───────────────────────────────────────────────────────────
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      if (!res.writableEnded) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    // Heartbeat to prevent proxy timeout
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": heartbeat\n\n");
      else clearInterval(heartbeat);
    }, 15_000);

    const finish = () => {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    };

    req.on("close", () => clearInterval(heartbeat));

    try {
      // ── Cache check ───────────────────────────────────────────────────────
      const cached = await getDeepAnalysisCache(ticker, cacheKey);
      if (cached && !cached.isStale) {
        const { getCompanyBriefForUser, briefFields } = await import("../companyBrief");
        const brief = await getCompanyBriefForUser(userId, ticker);
        const cachedResult = cached.result as Record<string, unknown>;
        send("cached", {
          ...cachedResult,
          ...briefFields(brief, ticker, String(cachedResult.company ?? "")),
          fromCache: true,
        });
        finish();
        return;
      }

      // ── Ziv Engine computation ────────────────────────────────────────────
      let totalPortfolioValue = portfolioSize ?? 0;
      if (!totalPortfolioValue) {
        try {
          const [account, holdings] = await Promise.all([
            getPortfolioAccount(userId),
            getPortfolioHoldings(userId),
          ]);
          const holdingsValue = holdings.reduce((sum, h) => sum + (h.currentPrice ?? h.buyPrice) * h.units, 0);
          totalPortfolioValue = holdingsValue + (account?.cashBalance ?? 0);
        } catch { /* non-blocking */ }
      }

      const [bars, live, companyBrief] = await Promise.all([
        fetchBarsForTicker(ticker),
        // SINGLE SOURCE OF TRUTH: prefer the shared IBKR /quotes feed (the same source War Room,
        // Holding 1 and the SSE stream use) so the displayed price + daily match every other
        // screen. Fall back to Yahoo only for tickers IBKR doesn't return (browsing non-held assets).
        (async () => {
          const m = await fetchIbkrLivePricesBatch([ticker]);
          return m.get(ticker) ?? await fetchLivePrice(ticker);
        })(),
        import("../companyBrief").then(({ getCompanyBriefForUser }) => getCompanyBriefForUser(userId, ticker)),
      ]);

      if (!live) { send("error", `No live data for ${ticker}`); finish(); return; }
      if (bars.length < 50) { send("error", `Insufficient price history for ${ticker}`); finish(); return; }

      // ── Israeli stock normalization: Yahoo Finance returns prices in Agorot (1/100 ILS) ──
      // NOTE: bars from DB priceCache are already normalized to ILS (normalizeBarsForTicker was
      // applied during nightlyCacheRefresh). Only divide when bars come directly from Yahoo.
      // We detect this by checking if the last bar close looks like Agorot (> 1000 for typical stocks).
      const isIsraeliStock = ticker.toUpperCase().endsWith(".TA");
      if (isIsraeliStock) {
        const lastClose = bars[bars.length - 1]?.close ?? 0;
        const looksLikeAgorot = lastClose > 500; // ILS prices are typically < 500 for most TASE stocks
        if (looksLikeAgorot) {
          for (const bar of bars) {
            bar.open  = bar.open  / 100;
            bar.high  = bar.high  / 100;
            bar.low   = bar.low   / 100;
            bar.close = bar.close / 100;
          }
          live.price = live.price / 100;
          if (live.prevClose != null) live.prevClose = live.prevClose / 100;
        }
      }
      let ilsRate = 3.60;
      if (isIsraeliStock) {
        try { const { getUsdIlsRate } = await import("../marketData"); ilsRate = await getUsdIlsRate(); } catch {}
      }
      const cs = isIsraeliStock ? "\u20aa" : "$"; // currency symbol

      // ── Penny / Micro-cap Guard ──────────────────────────────────────────
      // Stocks priced below $1 (or < 0.5 ILS) have extreme percentage movements on
      // tiny price changes. Ziv Engine was tuned for mid/large-cap stocks ($5+).
      // Flag these for the AI so it can calibrate its analysis accordingly.
      // live.price is in ILS for TASE (already divided by 100 above)
      // Convert to USD equivalent for penny-stock threshold check
      const safeRate = ilsRate > 0 ? ilsRate : 3.6;
      const ilsToUsdFactor = 1.0 / safeRate;
      const isPennyStock = !isIsraeliStock
        ? live.price < 1.0
        : (live.price * ilsToUsdFactor) < 0.30; // USD equivalent of ILS price
      const isUltraPenny  = live.price < 0.01;
      const pennyWarning  = isPennyStock
        ? isUltraPenny
          ? `⚠️ ULTRA-PENNY STOCK: price $${live.price.toFixed(6)} — Ziv Engine scores are unreliable at this price level. Volume and pattern signals may be noise. This stock is essentially untradeable for standard strategies.`
          : `⚠️ PENNY STOCK: price $${live.price.toFixed(4)} — Ziv Engine score should be interpreted with extra caution. High volatility, low liquidity, wide spreads typical. Standard SL/TP rules may not apply.`
        : null;

      const ziv = calcZivEngineScore(bars);

      const daMeta = await buildDeepAnalysisMeta({
        userId,
        bars,
        livePrice: live.price,
        ziv,
        currencySymbol: cs,
      });

      const { briefFields } = await import("../companyBrief");
      const briefMeta = briefFields(companyBrief, ticker, live.company);
      const metaPayload = {
        ticker,
        company: live.company,
        sector: briefMeta.sector,
        companyDescription: briefMeta.companyDescription,
        price: live.price,
        currency: isIsraeliStock ? "ILS" : "USD",
        currencySymbol: cs,
        changePercent: live.changePercent,
        ema50: ziv.ema50,
        ema200: ziv.ema200,
        donchian20High: ziv.donchian20High,
        weeklyEma50Slope: ziv.weeklyEma50Slope,
        distToEma50Pct: ziv.distToEma50Pct,
        priceAction: ziv.priceAction,
        ...daMeta,
        totalPortfolioValue: totalPortfolioValue > 0 ? totalPortfolioValue : null,
        breakdown: ziv.breakdown ?? null,
        isOverride: ziv.breakdown?.isOverride ?? false,
      };
      send("meta", metaPayload);

      const priceDecimals = isPennyStock ? 6 : 2;
      const prompt = buildDeepAnalysisPrompt({
        ticker,
        meta: daMeta,
        livePrice: live.price,
        ziv,
        holdingContext: hc,
        currencySymbol: cs,
        pennyWarning,
        priceDecimals,
      });

      // ── Stream LLM response ───────────────────────────────────────────────
      const forgeRes = await fetch(resolveForgeUrl(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ENV.forgeApiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          stream: true,
          messages: [
            { role: "system", content: DEEP_ANALYSIS_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          max_tokens: 2048,
        }),
      });

      if (!forgeRes.ok || !forgeRes.body) {
        send("error", `LLM stream failed: ${forgeRes.status}`);
        finish();
        return;
      }

      // Read SSE stream from Forge API
      const reader = forgeRes.body.getReader();
      const decoder = new TextDecoder();
      let fullAiText = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") break;
          try {
            const parsed = JSON.parse(raw);
            const delta = parsed?.choices?.[0]?.delta?.content;
            if (delta) {
              fullAiText += delta;
              send("chunk", delta);
            }
          } catch { /* skip malformed lines */ }
        }
      }

      // ── Parse AI text into structured fields ──────────────────────────────
      // The streaming prompt asks for prose, but we need structured fields for the UI.
      // We'll do a second (cheap) structured extraction pass.
      let aiResult: { recommendation: string; positionRationale: string; risks: string; actionTrigger: string; summary: string };
      try {
        const structureRes = await fetch(resolveForgeUrl(), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${ENV.forgeApiKey}` },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "Extract structured fields from the analysis text. Return only valid JSON. All text fields in Hebrew (עברית)." },
              { role: "user", content: `Extract from this analysis:\n\n${fullAiText}\n\nReturn JSON with: recommendation (HOLD/ADD/REDUCE/EXIT + reason), positionRationale, risks, actionTrigger, summary.` },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "deep_analysis_extract",
                strict: true,
                schema: {
                  type: "object",
                  properties: {
                    recommendation: { type: "string" },
                    positionRationale: { type: "string" },
                    risks: { type: "string" },
                    actionTrigger: { type: "string" },
                    summary: { type: "string" },
                  },
                  required: ["recommendation", "positionRationale", "risks", "actionTrigger", "summary"],
                  additionalProperties: false,
                },
              },
            },
            max_tokens: 2048,
          }),
        });
        const structureJson = await structureRes.json() as { choices?: Array<{ message?: { content?: string } }> };
        aiResult = JSON.parse(String(structureJson?.choices?.[0]?.message?.content ?? "{}"));
      } catch {
        // Fallback: use the full text as summary
        aiResult = { recommendation: "ראה ניתוח", positionRationale: fullAiText, risks: "", actionTrigger: "", summary: fullAiText.slice(0, 300) };
      }

      const freshResult = {
        ...metaPayload,
        ai: aiResult,
        analyzedAt: new Date().toISOString(),
        fromCache: false,
      };

      // Persist SL to holdings DB (non-blocking)
      try {
        const allHoldings = await getPortfolioHoldings(userId);
        const matchingHolding = allHoldings.find(h => h.ticker === ticker);
        if (matchingHolding != null) {
          await updatePortfolioHolding(matchingHolding.id, userId, { stopLoss: daMeta.stopLoss });
        }
      } catch { /* non-blocking */ }

      // Save to cache (non-blocking)
      setDeepAnalysisCache(ticker, cacheKey, freshResult).catch(() => {});

      send("done", freshResult);
      finish();
    } catch (err) {
      send("error", err instanceof Error ? err.message : "Unknown error");
      finish();
    }
  });
}
