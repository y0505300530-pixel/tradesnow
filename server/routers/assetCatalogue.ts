/**
 * assetCatalogue.ts
 * Production asset-catalogue CRUD router.
 *
 * Recovered from the deleted tradingLab.ts (git 113e15e) — contains only the
 * 11 PRODUCTION procedures that live pages depend on. Simulation procedures
 * (scanTickers, getSimulation, runSimulation, etc.) are intentionally omitted.
 */
import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { callDataApi } from "../_core/dataApi";
import { swrInvalidate } from "../swrCache";
import { fetchLivePrice } from "../marketData";
import { DEFAULT_60_ASSETS } from "./portfolio";
import {
  getUserAssets,
  upsertUserAsset,
  deleteUserAsset,
  bulkDeleteUserAssets,
  bulkReplaceUserAssets,
  deleteAllAlertsForTicker,
  upsertCatalogueAlert,
  getCachedPrices,
  upsertPriceCache,
  getCacheStatus,
  getAllCachedBarsForTickers,
  updateUserAssetMeta,
} from "../db";

// ─── Price file helpers (shared with refreshCache / writePriceCacheFile) ───────
type PriceBar = { date: string; open: number; high: number; low: number; close: number; volume: number };
type PriceFileData = Record<string, PriceBar[]>;

const PRICE_CACHE_DIR = path.join(process.cwd(), ".price-cache");
const PRICE_CACHE_FILE = path.join(PRICE_CACHE_DIR, "prices.json");
const S3_PRICE_CACHE_KEY = "price-cache/all-prices.json";

let globalPriceData: PriceFileData | null = null;
let globalPriceCacheTimestamp = 0;
const PRICE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function invalidateGlobalPriceCache() {
  globalPriceData = null;
  globalPriceCacheTimestamp = 0;
}

async function writePriceCacheFile(data: PriceFileData): Promise<void> {
  try {
    if (!fs.existsSync(PRICE_CACHE_DIR)) {
      fs.mkdirSync(PRICE_CACHE_DIR, { recursive: true });
    }
    fs.writeFileSync(PRICE_CACHE_FILE, JSON.stringify(data));
    console.log(`[PriceCache] Written ${Object.keys(data).length} tickers to local file`);
  } catch (e) {
    console.error(`[PriceCache] Failed to write local file:`, e);
  }
  try {
    const { storagePut } = await import("../storage");
    const jsonStr = JSON.stringify(data);
    const { url } = await storagePut(S3_PRICE_CACHE_KEY, jsonStr, "application/json");
    console.log(`[PriceCache] Uploaded ${Object.keys(data).length} tickers to S3 → ${url.substring(0, 80)}...`);
  } catch (e) {
    console.error(`[PriceCache] Failed to upload to S3:`, e);
  }
}

/** Fetch live price history from Yahoo and upsert into DB cache. */
async function fetchAndCachePrices(
  ticker: string,
  startDate: Date,
  endDate: Date
): Promise<PriceBar[]> {
  const period1 = Math.floor((startDate.getTime() - 7 * 24 * 60 * 60 * 1000) / 1000);
  const period2 = Math.floor((endDate.getTime() + 7 * 24 * 60 * 60 * 1000) / 1000);
  const result = await callDataApi("YahooFinance/get_stock_chart", {
    query: { symbol: ticker, region: "US", interval: "1d", period1: String(period1), period2: String(period2) },
  });
  const r = result as { chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { open?: number[]; high?: number[]; low?: number[]; close?: number[]; volume?: number[] }[] } }[] } };
  if (!r?.chart?.result?.[0]) return [];
  const chartResult = r.chart.result[0];
  const timestamps: number[] = chartResult.timestamp ?? [];
  const quotes = chartResult.indicators?.quote?.[0] ?? {};
  const startTs = startDate.getTime() / 1000 - 7 * 86400;
  const endTs = endDate.getTime() / 1000 + 7 * 86400;
  const bars = timestamps
    .map((ts: number, i: number) => ({
      date: new Date(ts * 1000).toISOString().split("T")[0],
      open: quotes.open?.[i] ?? 0,
      high: quotes.high?.[i] ?? 0,
      low: quotes.low?.[i] ?? 0,
      close: quotes.close?.[i] ?? 0,
      volume: quotes.volume?.[i] ?? 0,
    }))
    .filter((d) => {
      const ts = new Date(d.date).getTime() / 1000;
      return ts >= startTs && ts <= endTs && d.close > 0;
    });
  upsertPriceCache(ticker, bars).catch((e) => console.warn(`[Cache] upsert failed for ${ticker}:`, e));
  return bars;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const assetCatalogueRouter = router({
  /**
   * Validate a list of tickers by fetching a single recent price from Yahoo Finance.
   * Returns { ticker, valid, price? } for each input ticker.
   * Used by the AssetPicker component to show green checkmarks.
   */
  validateTickers: protectedProcedure
    .input(z.object({ tickers: z.array(z.string()).max(50) }))
    .mutation(async ({ input, ctx }) => {
      const results: { ticker: string; valid: boolean; price?: number; longName?: string; sector?: string }[] = [];
      const batchSize = 10;
      for (let i = 0; i < input.tickers.length; i += batchSize) {
        const batch = input.tickers.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map(async (ticker) => {
            const timeoutPromise = new Promise<{ ticker: string; valid: boolean }>((resolve) =>
              setTimeout(() => resolve({ ticker, valid: false }), 12000)
            );
            const fetchPromise = (async () => {
              try {
                const end = Math.floor(Date.now() / 1000);
                const start = end - 30 * 86400;
                const [chartResult, profileResult] = await Promise.allSettled([
                  callDataApi("YahooFinance/get_stock_chart", {
                    query: { symbol: ticker, region: "US", interval: "1d", period1: String(start), period2: String(end) },
                  }) as Promise<{ chart?: { result?: { meta?: { longName?: string; shortName?: string }; indicators?: { quote?: { close?: (number | null)[] }[] } }[] } }>,
                  callDataApi("YahooFinance/get_stock_profile", {
                    query: { symbol: ticker, region: "US", lang: "en-US" },
                  }) as Promise<{ quoteType?: { longName?: string; shortName?: string }; assetProfile?: { sector?: string; industry?: string } }>,
                ]);
                const chartData = chartResult.status === "fulfilled" ? chartResult.value : null;
                const profileData = profileResult.status === "fulfilled" ? profileResult.value : null;
                const meta = chartData?.chart?.result?.[0]?.meta;
                const closes = chartData?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
                const lastClose = closes.filter((c): c is number => c != null).pop();
                const longName = profileData?.quoteType?.longName || profileData?.quoteType?.shortName || meta?.longName || meta?.shortName || undefined;
                const rawSector = profileData?.assetProfile?.sector || profileData?.assetProfile?.industry || undefined;
                if (lastClose != null && lastClose > 0) {
                  return { ticker, valid: true, price: lastClose, longName, sector: rawSector };
                }
                const endDate = new Date().toISOString().slice(0, 10);
                const startDate = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
                const cached = await getCachedPrices(ticker, startDate, endDate);
                if (cached.length > 0) {
                  return { ticker, valid: true, price: cached[cached.length - 1].close, longName, sector: rawSector };
                }
                return { ticker, valid: false, longName, sector: rawSector };
              } catch {
                try {
                  const endDate = new Date().toISOString().slice(0, 10);
                  const startDate = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
                  const cached = await getCachedPrices(ticker, startDate, endDate);
                  if (cached.length > 0) {
                    return { ticker, valid: true, price: cached[cached.length - 1].close };
                  }
                } catch { /* ignore */ }
                return { ticker, valid: false };
              }
            })();
            return Promise.race([fetchPromise, timeoutPromise]);
          })
        );
        results.push(...batchResults);
      }
      // Save sector + longName to DB for any ticker that got real data
      await Promise.allSettled(
        results
          .filter((r) => r.sector || r.longName)
          .map((r) =>
            updateUserAssetMeta(ctx.user.id, r.ticker, {
              ...(r.longName ? { name: r.longName } : {}),
              ...(r.sector ? { sector: r.sector } : {}),
            })
          )
      );
      return results;
    }),

  // ─── User Asset List (DB persistence) ────────────────────────────────────────
  getUserAssets: protectedProcedure.query(async ({ ctx }) => {
    const { resolveCatalogUserIdForViewer } = await import("../tradingAccounts");
    const catalogUserId = await resolveCatalogUserIdForViewer(ctx.user.id, ctx.user.role);
    return getUserAssets(catalogUserId);
  }),

  /**
   * Seed the default catalogue for the current user — ONLY when their catalogue is
   * empty. Replaces the destructive auto-seed that was removed from getCatalogueWithScores
   * (a query must never write). Idempotent: a non-empty catalogue is never overwritten.
   */
  seedDefaultCatalogue: protectedProcedure.mutation(async ({ ctx }) => {
    const existing = await getUserAssets(ctx.user.id);
    if (existing.length > 0) return { seeded: false, count: existing.length };
    await bulkReplaceUserAssets(ctx.user.id, DEFAULT_60_ASSETS);
    const after = await getUserAssets(ctx.user.id);
    return { seeded: true, count: after.length };
  }),

  upsertUserAsset: protectedProcedure
    .input(
      z.object({
        ticker: z.string().min(1).max(16),
        companyName: z.string().min(1).max(128),
        sector: z.string().min(1).max(64),
        score: z.number().int().min(1).max(10).nullable().optional(),
        label: z.string().max(64).nullable().optional(),
        sortOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await upsertUserAsset(ctx.user.id, input.ticker, {
        companyName: input.companyName,
        sector: input.sector,
        score: input.score ?? null,
        label: input.label ?? null,
        sortOrder: input.sortOrder ?? 0,
      });
      return { ok: true };
    }),

  deleteUserAsset: protectedProcedure
    .input(z.object({ ticker: z.string().min(1).max(16) }))
    .mutation(async ({ ctx, input }) => {
      await deleteUserAsset(ctx.user.id, input.ticker);
      await deleteAllAlertsForTicker(ctx.user.id, input.ticker).catch(() => {});
      swrInvalidate(`portfolio:catalogue:${ctx.user.id}`);
      return { ok: true };
    }),

  bulkDeleteUserAssets: protectedProcedure
    .input(z.object({ tickers: z.array(z.string().min(1).max(16)).min(1).max(250) }))
    .mutation(async ({ ctx, input }) => {
      await bulkDeleteUserAssets(ctx.user.id, input.tickers);
      await Promise.all(input.tickers.map((t) => deleteAllAlertsForTicker(ctx.user.id, t).catch(() => {})));
      swrInvalidate(`portfolio:catalogue:${ctx.user.id}`);
      return { ok: true, deleted: input.tickers.length };
    }),

  addUserAsset: protectedProcedure
    .input(
      z.object({
        ticker: z.string().min(1).max(16),
        companyName: z.string().min(0).max(128).default(""),
        sector: z.string().min(0).max(64).default("Custom"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const tickerUpper = input.ticker.toUpperCase();
      const existing = await getUserAssets(ctx.user.id);
      // Duplicate guard
      const alreadyExists = existing.some((a) => a.ticker.toUpperCase() === tickerUpper);
      if (alreadyExists) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `${tickerUpper} already exists in your Asset Catalogue`,
        });
      }

      // Catalogue Entry Validation — price >= $1, avg 20-day volume >= 50k
      const isTaseTicker = tickerUpper.endsWith(".TA");
      try {
        const { fetchBarsForTicker } = await import("../marketData");
        const quickBars = await fetchBarsForTicker(tickerUpper, 30);
        if (quickBars.length >= 5) {
          const lastPrice = quickBars[quickBars.length - 1].close;
          const avgVol20 = quickBars.slice(-20).reduce((s, b) => s + (b.volume ?? 0), 0) / Math.min(20, quickBars.length);
          const minPrice = 1.0;
          if (lastPrice < minPrice) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `❌ ${tickerUpper} לא עובר תנאי סף: מחיר ₪${lastPrice < 0.01 ? lastPrice.toFixed(6) : lastPrice.toFixed(2)} נמוך מהמינימום של $1.00. מניות Penny Stock אינן נתמכות.`,
            });
          }
          const minVol = isTaseTicker ? 10_000 : 50_000;
          if (avgVol20 > 0 && avgVol20 < minVol) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `❌ ${tickerUpper} לא עובר תנאי סף: נפח מסחר ממוצע ${Math.round(avgVol20).toLocaleString()} מניות/יום נמוך מהמינימום של ${minVol.toLocaleString()}. מניה לא סחירה.`,
            });
          }
        }
      } catch (e: any) {
        if (e?.code === "BAD_REQUEST") throw e;
        console.warn(`[addUserAsset] Validation fetch failed for ${tickerUpper}:`, e?.message ?? e);
      }

      const sortOrder = existing.length;
      await upsertUserAsset(ctx.user.id, tickerUpper, {
        companyName: input.companyName || tickerUpper,
        sector: input.sector || "Custom",
        sortOrder,
      });

      // Auto-create Catalogue Entry Alert with Ziv Score (fire-and-forget)
      try {
        const live = await fetchLivePrice(tickerUpper);
        if (live?.price && live.price > 0) {
          (async () => {
            try {
              const { fetchBarsForTicker } = await import("../marketData");
              const { calcZivEngineScore } = await import("../zivEngine");
              const { updateUserAssetScore } = await import("../db");
              const bars = await fetchBarsForTicker(tickerUpper, 420);
              const result = calcZivEngineScore(bars);
              await updateUserAssetScore(ctx.user.id, tickerUpper, result.score, null, {
                cmp: result.price,
                ema50: result.ema50,
                ema200: result.ema200,
                donchian20High: result.donchian20High,
                weeklyEma50Slope: result.weeklyEma50Slope,
                tier: result.tier,
                priceAction: result.priceAction ?? undefined,
                recommendedBuyPrice: result.ema50,
              });
              await upsertCatalogueAlert(ctx.user.id, tickerUpper, live.price!, result.score);
              console.log(`[addUserAsset] Auto Ziv scored ${tickerUpper}: ${result.score.toFixed(1)} (${result.tier})`);
            } catch (e) {
              await upsertCatalogueAlert(ctx.user.id, tickerUpper, live.price!);
              console.warn(`[addUserAsset] Ziv Engine failed for ${tickerUpper}, alert created without score:`, e);
            }
          })();
        }
      } catch { /* non-blocking */ }

      // Auto-fill conid in background
      try {
        const { autoFillConids } = await import("../autoFillConids");
        autoFillConids().catch(() => {});
      } catch { /* non-blocking */ }

      // Auto-sync IBKR watchlists (fire-and-forget)
      try {
        const { autoSyncWatchlists } = await import("./favorites");
        autoSyncWatchlists(ctx.user.id).catch(() => {});
      } catch { /* non-blocking */ }

      swrInvalidate(`portfolio:catalogue:${ctx.user.id}`);
      return { ok: true };
    }),

  updateAssetMeta: protectedProcedure
    .input(
      z.object({
        ticker: z.string().min(1).max(16),
        profitPotential: z.number().nullable().optional(),
        note: z.string().max(1000).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await updateUserAssetMeta(ctx.user.id, input.ticker, {
        profitPotential: input.profitPotential,
        note: input.note,
      });
      return { ok: true };
    }),

  bulkReplaceUserAssets: protectedProcedure
    .input(
      z.array(
        z.object({
          ticker: z.string().min(1).max(16),
          companyName: z.string().min(1).max(128),
          sector: z.string().min(1).max(64),
          score: z.number().int().min(1).max(10).nullable().optional(),
          label: z.string().max(64).nullable().optional(),
          sortOrder: z.number().int(),
        })
      )
    )
    .mutation(async ({ ctx, input }) => {
      await bulkReplaceUserAssets(
        ctx.user.id,
        input.map((a) => ({ ...a, score: a.score ?? null, label: a.label ?? null }))
      );
      return { ok: true };
    }),

  /** Get cache status for a list of tickers */
  getCacheStatus: protectedProcedure
    .input(z.object({ tickers: z.array(z.string().min(1).max(16)).min(1).max(250) }))
    .query(async ({ input }) => {
      const status = await getCacheStatus(input.tickers);
      return status;
    }),

  /** Refresh (pre-download) price data for a list of tickers and store in DB cache + JSON file */
  refreshCache: protectedProcedure
    .input(
      z.object({
        tickers: z.array(z.string().min(1).max(16)).min(1).max(250),
        years: z.number().int().min(1).max(5).default(3),
      })
    )
    .mutation(async ({ input }) => {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setFullYear(startDate.getFullYear() - input.years);
      const lookbackStart = new Date(startDate.getTime() - 400 * 24 * 60 * 60 * 1000);
      const results: Record<string, { bars: number; error?: string }> = {};
      const allBarsForFile: PriceFileData = {};
      const BATCH_SIZE = 20;
      for (let i = 0; i < input.tickers.length; i += BATCH_SIZE) {
        const batch = input.tickers.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.allSettled(
          batch.map(async (ticker) => {
            const bars = await fetchAndCachePrices(ticker, lookbackStart, endDate);
            return { ticker: ticker.toUpperCase(), bars };
          })
        );
        for (const r of batchResults) {
          if (r.status === "fulfilled") {
            results[r.value.ticker] = { bars: r.value.bars.length };
            allBarsForFile[r.value.ticker] = r.value.bars.map((b) => ({
              date: typeof b.date === "string" ? b.date : (b.date as Date).toISOString().split("T")[0],
              open: Number(b.open),
              high: Number(b.high),
              low: Number(b.low),
              close: Number(b.close),
              volume: Number(b.volume),
            }));
          } else {
            const idx = batchResults.indexOf(r);
            const t = batch[idx]?.toUpperCase() ?? "UNKNOWN";
            results[t] = { bars: 0, error: String(r.reason) };
          }
        }
      }
      await writePriceCacheFile(allBarsForFile);
      invalidateGlobalPriceCache();
      return results;
    }),

  /** Download all cached price data for given tickers as CSV string */
  downloadCacheCSV: protectedProcedure
    .input(z.object({ tickers: z.array(z.string().min(1).max(16)).min(1).max(250) }))
    .query(async ({ input }) => {
      const rows = await getAllCachedBarsForTickers(input.tickers);
      if (rows.length === 0) return { csv: "", rowCount: 0 };
      const header = "Ticker,Date,Open,High,Low,Close,Volume";
      const lines = rows.map(
        (r) =>
          `${r.ticker},${r.date},${r.open.toFixed(4)},${r.high.toFixed(4)},${r.low.toFixed(4)},${r.close.toFixed(4)},${r.volume}`
      );
      return { csv: [header, ...lines].join("\n"), rowCount: rows.length };
    }),
});
