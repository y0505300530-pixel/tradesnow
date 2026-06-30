import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, publicProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { knowledgeBaseRouter, proficiencyRouter } from "./routers/knowledgeBase";
import { masterKnowledgeRouter } from "./routers/masterKnowledge";
import { tradeRouter } from "./routers/trade";
import { settingsRouter } from "./routers/settings";
import { tradeManagerRouter } from "./routers/tradeManager";
import { videoManagementRouter } from "./routers/videoManagement";
import { insightsRouter } from "./routers/insights";
import { portfolioRouter } from "./routers/portfolio";
import { ibkrRouter } from "./routers/ibkr";
import { performanceRouter } from "./routers/performance";
import { hourlySnapshotsRouter } from "./routers/hourlySnapshots";
import { logsRouter } from "./routers/logs";
import { holding2Router } from "./routers/holding2";
import { localUsersRouter } from "./routers/localUsers";
import { telegramMonitorRouter } from "./routers/telegramMonitor";
import { liveEngineRouter } from "./routers/liveEngine";
import { sectorConfigRouter } from "./routers/sectorConfig";
import { moneyTransfersRouter } from "./routers/moneyTransfers";
import { splashRouter } from "./routers/splash";
import { analyzePositionRouter } from "./routers/analyzePosition";
import { favoritesRouter } from "./routers/favorites";
import { assetCatalogueRouter } from "./routers/assetCatalogue";
import { analyzeRouter } from "./routers/analyze";
import { priceAlertsRouter } from "./routers/priceAlerts";
import { snoozeRouter } from "./routers/snooze";
import { getUsdIlsRate } from "./marketData";
import { runDailyBasePriceSnapshot } from "./alertPoller";

export const appRouter = router({
  system: systemRouter,

  /** Admin: force-refresh dailyBasePrice from Yahoo Finance RTH close */
  forceBaselineRefresh: adminProcedure.mutation(async () => {
    await runDailyBasePriceSnapshot();
    return { success: true, message: "dailyBasePrice updated from Yahoo Finance RTH close" };
  }),

  auth: router({
    me: publicProcedure.query(opts => {
      if (!opts.ctx.user) return null;
      return { ...opts.ctx.user, needs2fa: opts.ctx.needs2fa };
    }),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  knowledgeBase: knowledgeBaseRouter,
  proficiency: proficiencyRouter,
  masterKnowledge: masterKnowledgeRouter,
  trade: tradeRouter,
  tradeManager: tradeManagerRouter,
  settings: settingsRouter,
  videoManagement: videoManagementRouter,
  insights:         insightsRouter,
  portfolio: portfolioRouter,
  ibkr: ibkrRouter,
  performance: performanceRouter,
  hourlySnapshots: hourlySnapshotsRouter,
  logs: logsRouter,
  holding2: holding2Router,
  localUsers: localUsersRouter,
  telegramMonitor: telegramMonitorRouter,
  liveEngine: liveEngineRouter,
  sectorConfig: sectorConfigRouter,
  moneyTransfers: moneyTransfersRouter,
  splash: splashRouter,
  analyzePosition: analyzePositionRouter,
  favorites: favoritesRouter,
  assetCatalogue: assetCatalogueRouter,
  analyze: analyzeRouter,
  priceAlerts: priceAlertsRouter,
  snooze: snoozeRouter,

  /** USD/ILS exchange rate — cached 5min, fallback 3.60 */
  forex: router({
    getRate: publicProcedure.query(async () => {
      const rate = await getUsdIlsRate();
      return { usdIls: rate };
    }),
    /** FX P&L: returns BOI representative rate (today vs yesterday) and % change.
     *  Primary: Bank of Israel API (official daily representative rate + % change).
     *  Fallback: Yahoo Finance 5d daily chart via callDataApi. */
    getFxPnl24h: publicProcedure.query(async () => {
      const nullResult = { currentRate: null, prevRate: null, changePct: null };
      try {
        // ── FX PnL uses BOI representative rate (official daily rate) ──
        // BOI returns: currentExchangeRate (today's representative) + currentChange (% vs yesterday)
        // prevRate = currentRate / (1 + currentChange/100)
        let currentRate: number | null = null;
        let prevRate: number | null = null;

        try {
          const boiRes = await fetch(
            "https://www.boi.org.il/PublicApi/GetExchangeRates",
            {
              signal: AbortSignal.timeout(6000),
              headers: { "Accept": "application/json" },
            }
          );
          if (boiRes.ok) {
            const boiData = await boiRes.json();
            const rates = boiData?.exchangeRates ?? boiData?.ExchangeRates ?? [];
            const usdEntry = rates.find((r: any) => (r.key ?? r.Key) === "USD");
            if (usdEntry) {
              const boiRate = usdEntry.currentExchangeRate ?? usdEntry.CurrentExchangeRate;
              const boiChange = usdEntry.currentChange ?? usdEntry.CurrentChange; // % change from yesterday
              if (boiRate && boiRate > 1 && boiRate < 10) {
                currentRate = boiRate;
                // Derive yesterday's representative rate from % change
                if (typeof boiChange === "number" && boiChange !== 0) {
                  prevRate = boiRate / (1 + boiChange / 100);
                }
              }
            }
          }
        } catch { /* BOI failed, try Yahoo as fallback */ }

        // Fallback: if BOI failed, use Yahoo daily chart for prevRate (2s strict timeout)
        if (!currentRate || !prevRate) {
          try {
            const { callDataApi } = await import("./_core/dataApi");
            // ⚠️ 2s timeout — Yahoo must not block the Event Loop
            const apiResult = await Promise.race([
              callDataApi("YahooFinance/get_stock_chart", {
                query: { symbol: "USDILS=X", interval: "1d", range: "5d" },
              }),
              new Promise((_, reject) => setTimeout(() => reject(new Error("Yahoo ILS timeout")), 2000)),
            ]) as any;
            const r0 = apiResult?.chart?.result?.[0];
            if (r0) {
              const closes: number[] = r0?.indicators?.quote?.[0]?.close ?? [];
              const validCloses = closes.filter((v: any): v is number => v != null && typeof v === "number" && v > 0);
              if (!prevRate && validCloses.length >= 2) {
                prevRate = validCloses[validCloses.length - 2];
              }
              if (!currentRate) {
                const metaRate = r0?.meta?.regularMarketPrice as number | undefined;
                if (metaRate && metaRate > 1 && metaRate < 10) currentRate = metaRate;
                else if (validCloses.length > 0) currentRate = validCloses[validCloses.length - 1];
              }
            }
          } catch { /* prevRate stays null — Yahoo timed out or blocked */ }
        }

        if (!currentRate || !prevRate) return nullResult;
        const changePct = ((currentRate - prevRate) / prevRate) * 100;
        return { currentRate, prevRate, changePct };
      } catch {
        return nullResult;
      }
    }),
  }),

  /** Ticker autocomplete — proxies Yahoo Finance search */
  searchTicker: publicProcedure
    .input(z.object({ q: z.string().min(1).max(30) }))
    .query(async ({ input }) => {
      try {
        const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(input.q)}&quotesCount=8&newsCount=0&enableFuzzyQuery=false&quotesQueryId=tss_match_phrase_query`;
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) return { results: [] };
        const rawBody = await res.text();
        if (!rawBody.startsWith("{") && !rawBody.startsWith("[")) return { results: [] };
        const data = JSON.parse(rawBody) as { quotes?: Array<{ symbol: string; shortname?: string; longname?: string; typeDisp?: string; exchDisp?: string }> };
        const results = (data.quotes ?? [])
          .filter((q) => q.symbol && ["equity", "etf", "index", "cryptocurrency"].includes((q.typeDisp ?? "").toLowerCase()))
          .slice(0, 8)
          .map((q) => ({
            symbol: q.symbol,
            name: q.shortname ?? q.longname ?? q.symbol,
            type: q.typeDisp ?? "",
            exchange: q.exchDisp ?? "",
          }));
        return { results };
      } catch {
        return { results: [] };
      }
    }),
});

export type AppRouter = typeof appRouter;
