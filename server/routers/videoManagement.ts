import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../_core/trpc";
import { callDataApi } from "../_core/dataApi";
import {
  getChannelVideos,
  countChannelVideos,
  upsertChannelVideos,
  markChannelVideoAnalyzed,
  clearNewFlags,
  getExistingVideoIds,
  getRecentChannelVideos,
  createAnalysis,
  updateAnalysis,
  getAnalysisById,
  getWatchlistCountBatch,
  upsertUserAsset,
  validateTickerForCatalogue,
  getUserAssets,
  updateUserAssetScore,
} from "../db";
import { getDb } from "../db";
import { analyses, channelVideos, watchlistDismissed } from "../../drizzle/schema";
import { eq, gte, gte, desc, inArray, and } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { calcZivEngineScore } from "../zivEngine";
import { fetchBarsForTicker, fetchLivePrice } from "../marketData";
import { decodeHtmlEntities, youtubeThumbnailUrl } from "../../shared/htmlEntities";
import {
  inferTaseTickerSync,
  isTaseMarketTicker,
  type TaseTickerHints,
} from "../taseTickerResolve";

// ─── Constants ────────────────────────────────────────────────────────────────

const CHANNELS = {
  cycles_trading: {
    id: "UChaPkfdV0OxX3bdX_D9qaOA",
    name: "Cycles Trading (Ziv Hakshurian)",
    handle: "@cyclestrading",
  },
  micha_stocks: {
    id: "UCSxjNbPriyBh9RNl_QNSAtw",
    name: "Micha.Stocks",
    handle: "@Micha.Stocks",
  },
} as const;

type MentorKey = keyof typeof CHANNELS;

const MAX_PAGES = 30; // ~900 videos max (30 per page × 30 pages)
const mentorSchema = z.enum(["cycles_trading", "micha_stocks"]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse YouTube's relative time text into an approximate Date.
 * e.g. "3 days ago", "2 weeks ago", "5 months ago", "1 year ago"
 */
function parsePublishedTime(text: string): Date {
  const now = new Date();
  if (!text) return now;
  const lower = text.toLowerCase().trim();

  const match = lower.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
  if (!match) return now;

  const n = parseInt(match[1], 10);
  const unit = match[2];
  const ms = {
    second: 1000,
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 7 * 86_400_000,
    month: 30 * 86_400_000,
    year: 365 * 86_400_000,
  }[unit] ?? 0;

  return new Date(now.getTime() - n * ms);
}

/**
 * Fetch latest channel videos via YouTube RSS feed (no API key needed, returns last 15 videos).
 * Cursor is ignored for RSS (always returns latest 15).
 */
async function fetchPage(channelId: string, _cursor?: string): Promise<{
  videos: Array<{
    videoId: string;
    title: string;
    uploadDate: Date;
    thumbnailUrl?: string;
    duration: number;
    viewCount: number;
  }>;
  nextCursor?: string;
}> {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetch(rssUrl, {
    headers: { "Accept": "application/atom+xml, text/xml, */*" },
  });
  if (!res.ok) throw new Error(`YouTube RSS fetch failed: ${res.status} ${res.statusText}`);
  const xml = await res.text();

  // Parse <entry> blocks from Atom XML
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  const videos: Array<{
    videoId: string; title: string; uploadDate: Date;
    thumbnailUrl?: string; duration: number; viewCount: number;
  }> = [];

  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const videoId = (/<yt:videoId>([^<]+)<\/yt:videoId>/.exec(block) ?? [])[1] ?? "";
    const title = (/<media:title>([^<]*)<\/media:title>/.exec(block) ?? [])[1]
      ?? (/<title>([^<]*)<\/title>/.exec(block) ?? [])[1] ?? "Untitled";
    const published = (/<published>([^<]+)<\/published>/.exec(block) ?? [])[1] ?? "";
    const thumbnailUrl = (/media:thumbnail[^>]+url="([^"]+)"/.exec(block) ?? [])[1];
    const uploadDate = published ? new Date(published) : new Date();

    if (videoId) {
      videos.push({
        videoId,
        title: decodeHtmlEntities(title),
        uploadDate,
        thumbnailUrl: thumbnailUrl ?? youtubeThumbnailUrl(videoId),
        duration: 0,
        viewCount: 0,
      });
    }
  }

  // RSS always returns latest 15 — no pagination cursor needed for sync
  return { videos, nextCursor: undefined };
}

/**
 * Fetch all channel videos via Supadata API (returns up to 500 video IDs)
 * then enriches them with oEmbed metadata.
 * Used for full fetchAll operations (archive sync).
 */
async function fetchAllVideosFromChannel(channelId: string): Promise<Array<{
  videoId: string; title: string; uploadDate: Date;
  thumbnailUrl?: string; duration: number; viewCount: number;
}>> {
  const supadataKey = process.env.SUPADATA_API_KEY ?? "";
  if (!supadataKey) throw new Error("SUPADATA_API_KEY not configured");

  // Supadata returns list of videoIds for channel
  const supaRes = await fetch(
    `https://api.supadata.ai/v1/youtube/channel/videos?id=${channelId}&limit=500`,
    { headers: { "x-api-key": supadataKey } }
  );
  if (!supaRes.ok) throw new Error(`Supadata channel/videos failed: ${supaRes.status}`);
  const supaData = (await supaRes.json()) as { videoIds?: string[] };
  const videoIds = supaData.videoIds ?? [];

  // Enrich with oEmbed (title, thumbnail) — batch with small delay
  const results: Array<{ videoId: string; title: string; uploadDate: Date; thumbnailUrl?: string; duration: number; viewCount: number }> = [];
  for (const videoId of videoIds.slice(0, 200)) {  // limit to 200 for perf
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
      const oRes = await fetch(oembedUrl);
      if (oRes.ok) {
        const oData = (await oRes.json()) as { title?: string; thumbnail_url?: string };
        results.push({
          videoId,
          title: decodeHtmlEntities(oData.title ?? "Untitled"),
          uploadDate: new Date(), // oEmbed doesn't provide upload date — approximate
          thumbnailUrl: oData.thumbnail_url ?? youtubeThumbnailUrl(videoId),
          duration: 0,
          viewCount: 0,
        });
      }
    } catch { /* skip failed enrichments */ }
    await new Promise(r => setTimeout(r, 50)); // gentle rate limit
  }
  return results;
}

// ─── Watchlist report helpers ────────────────────────────────────────────────

function rowHints(row: {
  company: string; entry_zone: string; stop_loss: string;
  strategy: string; catalyst: string;
}): TaseTickerHints {
  return {
    company: row.company,
    entryZone: row.entry_zone,
    stopLoss: row.stop_loss,
    strategy: row.strategy,
    catalyst: row.catalyst,
  };
}

function isTickerInCatalogue(ticker: string, catalogueSet: Set<string>, hints?: TaseTickerHints): boolean {
  const t = inferTaseTickerSync(ticker, hints);
  if (catalogueSet.has(t)) return true;
  if (!t.endsWith(".TA") && catalogueSet.has(`${t}.TA`)) return true;
  if (t.endsWith(".TA") && catalogueSet.has(t.replace(/\.TA$/, ""))) return true;
  return false;
}

type WatchlistReportRow = {
  ticker: string;
  company: string;
  strategy: string;
  entry_zone: string;
  stop_loss: string;
  catalyst: string;
  tradingview_alert: string;
  watchlist: string;
  normalizedTicker: string;
  market: "USA" | "TASE";
  inCatalogue: boolean;
  sector: string | null;
  companyDescription: string | null;
  eligibility: {
    priceOk: boolean | null;
    volumeOk: boolean | null;
    price: number | null;
    avgVolume20: number | null;
    minPrice: number;
    minVolume: number;
    currencySymbol: string;
    suitable: boolean;
  } | null;
};

function enrichWatchlistRow(
  row: {
    ticker: string; company: string; strategy: string;
    entry_zone: string; stop_loss: string; catalyst: string;
    tradingview_alert: string; watchlist: string;
  },
  catalogueSet: Set<string>,
): WatchlistReportRow {
  const hints = rowHints(row);
  const normalizedTicker = inferTaseTickerSync(row.ticker, hints);
  const market: "USA" | "TASE" = isTaseMarketTicker(normalizedTicker, hints) ? "TASE" : "USA";
  return {
    ...row,
    normalizedTicker,
    market,
    inCatalogue: isTickerInCatalogue(row.ticker, catalogueSet, hints),
    sector: null,
    companyDescription: null,
    eligibility: null,
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const videoManagementRouter = router({
  /**
   * Get paginated list of channel videos from DB (already fetched).
   * Filter by mentor to show only one channel's videos.
   */
  list: protectedProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(50),
      offset: z.number().min(0).default(0),
      mentor: mentorSchema.optional(),
    }))
    .query(async ({ input }) => {
      const [videos, total] = await Promise.all([
        getChannelVideos({ limit: input.limit, offset: input.offset, mentor: input.mentor }),
        countChannelVideos(input.mentor),
      ]);
      // Fetch watchlist counts for all analyzed videos
      const analysisIds = videos.map((v) => v.analysisId).filter((id): id is number => id != null);
      const [watchlistCounts, analysisStatusMap] = await Promise.all([
        getWatchlistCountBatch(analysisIds),
        (async () => {
          if (analysisIds.length === 0) return {} as Record<number, string>;
          const db = await getDb();
          if (!db) return {} as Record<number, string>;
          const rows = await db
            .select({ id: analyses.id, status: analyses.status })
            .from(analyses)
            .where(inArray(analyses.id, analysisIds));
          return Object.fromEntries(rows.map((r) => [r.id, r.status]));
        })(),
      ]);
      return {
        videos: videos.map((v) => ({
          id: v.id,
          videoId: v.videoId,
          mentor: v.mentor,
          title: decodeHtmlEntities(v.title),
          uploadDate: v.uploadDate,
          thumbnailUrl: v.thumbnailUrl ?? youtubeThumbnailUrl(v.videoId),
          duration: v.duration,
          viewCount: v.viewCount,
          isNew: v.isNew === 1,
          analysisId: v.analysisId,
          analyzedAt: v.analyzedAt,
          analysisStatus: v.analysisId != null ? (analysisStatusMap[v.analysisId] ?? null) : null,
          watchlistCount: v.analysisId != null ? (watchlistCounts[v.analysisId] ?? 0) : null,
        })),
        total,
      };
    }),

  /**
   * Full channel fetch — fetches up to MAX_PAGES pages and stores all videos.
   * Accepts a mentor parameter to fetch from the correct channel.
   */
  fetchAll: protectedProcedure
    .input(z.object({ mentor: mentorSchema.default("cycles_trading") }))
    .mutation(async ({ input }) => {
      const channel = CHANNELS[input.mentor as MentorKey];
      let totalFetched = 0;
      let pageCount = 0;

      // Use Supadata + oEmbed for full archive fetch
      const allVideos = await fetchAllVideosFromChannel(channel.id);
      if (allVideos.length > 0) {
        await upsertChannelVideos(allVideos.map((v) => ({ ...v, mentor: input.mentor as MentorKey })));
        totalFetched = allVideos.length;
        pageCount = 1;
      }

      const total = await countChannelVideos(input.mentor as MentorKey);
      return { fetched: totalFetched, pages: pageCount, total, mentor: input.mentor };
    }),

  /**
   * Sync new videos — fetches only the first 3 pages (most recent ~90 videos)
   * and marks any new ones with isNew=1.
   * Accepts a mentor parameter to sync the correct channel.
   */
  syncNew: protectedProcedure
    .input(z.object({ mentor: mentorSchema.default("cycles_trading") }))
    .mutation(async ({ input }) => {
      const channel = CHANNELS[input.mentor as MentorKey];

      // Clear old "new" flags for this mentor only
      await clearNewFlags();

      const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
      let newCount = 0;
      let cursor: string | undefined;

      // Fetch first 3 pages (most recent ~90 videos) to find new ones
      for (let i = 0; i < 3; i++) {
        const { videos, nextCursor } = await fetchPage(channel.id, cursor);
        if (videos.length === 0) break;

        // Check which video IDs are already in DB
        const ids = videos.map((v) => v.videoId);
        const existing = await getExistingVideoIds(ids);

        // New = not in DB yet, or uploaded within last 3 days
        const newVideos = videos.filter(
          (v) => !existing.has(v.videoId) || v.uploadDate >= threeDaysAgo
        );

        if (newVideos.length > 0) {
          await upsertChannelVideos(
            newVideos.map((v) => ({ ...v, isNew: 1, mentor: input.mentor as MentorKey }))
          );
          newCount += newVideos.filter((v) => !existing.has(v.videoId)).length;
        }

        if (!nextCursor) break;
        cursor = nextCursor;
        await new Promise((r) => setTimeout(r, 200));
      }

      const recentVideos = await getRecentChannelVideos(threeDaysAgo, input.mentor as MentorKey);
      return { newVideos: newCount, recentCount: recentVideos.length, mentor: input.mentor };
    }),

  /**
   * Get the watchlist summary report for an analyzed video.
   * Returns the structured rows from the analysis result.
   */
  getWatchlistReport: protectedProcedure
    .input(z.object({ analysisId: z.number() }))
    .query(async ({ input, ctx }) => {
      const analysis = await getAnalysisById(input.analysisId);
      if (!analysis) throw new TRPCError({ code: "NOT_FOUND", message: "Analysis not found" });
      if (!analysis.analysisResult) {
        return { rows: [], allRows: [], watchlistCount: 0, general_notes: "", videoTitle: analysis.videoTitle ?? "", createdAt: analysis.createdAt };
      }
      try {
        const parsed = JSON.parse(analysis.analysisResult) as { rows: Array<{
          ticker: string; company: string; strategy: string;
          entry_zone: string; stop_loss: string; catalyst: string;
          tradingview_alert: string; watchlist: string;
        }>; general_notes: string };

        const userAssets = await getUserAssets(ctx.user.id);
        const catalogueSet = new Set(userAssets.map((a) => a.ticker.toUpperCase()));
        const catalogueByTicker = new Map(
          userAssets.map((a) => [
            a.ticker.toUpperCase(),
            { sector: a.sector, companyName: a.companyName },
          ]),
        );

        const allRows = parsed.rows.map((r) => enrichWatchlistRow(r, catalogueSet));
        const watchlistRows = allRows.filter(
          (r) => r.watchlist !== "—" || r.entry_zone !== "—" || r.stop_loss !== "—"
        );

        const { getCompanyBriefBatch } = await import("../companyBrief");
        const tickersForBrief = [...new Set(allRows.map((r) => r.normalizedTicker.toUpperCase()))];
        const rowCompanyByTicker = new Map(
          allRows.map((r) => [r.normalizedTicker.toUpperCase(), r.company]),
        );
        const briefMap = await getCompanyBriefBatch(tickersForBrief, catalogueByTicker, rowCompanyByTicker);

        const { evaluateCatalogueEligibilityBatch } = await import("../catalogueEligibility");
        const eligibilityItems = allRows.map((r) => ({
          ticker: r.normalizedTicker,
          hints: rowHints(r),
        }));
        const eligibilityMap = await evaluateCatalogueEligibilityBatch(eligibilityItems);

        const attachEnrichment = (row: WatchlistReportRow): WatchlistReportRow => {
          const brief = briefMap.get(row.normalizedTicker.toUpperCase());
          return {
            ...row,
            sector: brief?.sector ?? (row.market === "TASE" ? "TASE" : null),
            companyDescription: brief?.description ?? null,
            eligibility: eligibilityMap.get(row.normalizedTicker.toUpperCase()) ?? null,
          };
        };

        return {
          rows: watchlistRows.map(attachEnrichment),
          allRows: allRows.map(attachEnrichment),
          watchlistCount: allRows.length,
          general_notes: parsed.general_notes ?? "",
          videoTitle: analysis.videoTitle ?? "",
          createdAt: analysis.createdAt,
        };
      } catch {
        return { rows: [], allRows: [], watchlistCount: 0, general_notes: "", videoTitle: analysis.videoTitle ?? "", createdAt: analysis.createdAt };
      }
    }),

  /**
   * Re-analyze an already-analyzed video using the latest LLM prompt.
   * Uses the stored transcript if available; otherwise re-runs the full pipeline.
   */
  reAnalyze: protectedProcedure
    .input(z.object({ analysisId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const analysis = await getAnalysisById(input.analysisId);
      if (!analysis) throw new TRPCError({ code: "NOT_FOUND", message: "Analysis not found" });

      const { analyzeTranscript, analyzeVideoDirectly, withTimeout } = await import("./analyze");

      // Mark as re-processing
      await updateAnalysis(input.analysisId, { status: "processing" });

      try {
        let result: { rows: import("./analyze").TradingRow[]; general_notes: string };

        if (analysis.transcript && analysis.transcript.length > 100) {
          // Fast path: re-run LLM on stored transcript
          result = await withTimeout(
            analyzeTranscript(analysis.transcript),
            60_000,
            "re-analyze transcript"
          );
        } else {
          // Fallback: re-run full video analysis
          const videoUrl = `https://www.youtube.com/watch?v=${analysis.videoId}`;
          result = await withTimeout(
            analyzeVideoDirectly(videoUrl),
            180_000,
            "re-analyze video"
          );
        }

        await updateAnalysis(input.analysisId, {
          analysisResult: JSON.stringify(result),
          status: "done",
          errorMessage: null,
        });

        return { success: true, rowCount: result.rows.length };
      } catch (err) {
        await updateAnalysis(input.analysisId, {
          status: "error",
          errorMessage: err instanceof Error ? err.message : "Re-analysis failed",
        });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Re-analysis failed" });
      }
    }),

  /**
   * Send a video to the analysis engine.
   * Creates an analysis record, runs the pipeline, marks the channel video as analyzed.
   */
  sendToAnalyze: protectedProcedure
    .input(z.object({ videoId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const videoUrl = `https://www.youtube.com/watch?v=${input.videoId}`;

      // Import helpers from analyze router
      const { extractVideoId, runPipeline, withTimeout } = await import("./analyze");

      const videoId = extractVideoId(videoUrl);
      if (!videoId) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid video ID" });

      const analysisId = await createAnalysis({
        userId: ctx.user.id,
        videoUrl,
        videoId,
        status: "processing",
      });

      // Run pipeline async — frontend polls for status
      withTimeout(runPipeline(analysisId, videoId, videoUrl, ctx.user.id), 240_000, "pipeline").catch(async (err) => {
        await updateAnalysis(analysisId, {
          status: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      });

      // Mark the channel video as linked to this analysis
      await markChannelVideoAnalyzed(input.videoId, analysisId);

      return { analysisId, videoUrl };
    }),

  /**
   * Get all watchlist stocks from all analyzed videos (for the Watchlist page)
   */
  getAllWatchlistStocks: protectedProcedure
    .input(z.object({
      mentor: z.enum(["cycles_trading", "micha_stocks"]).optional(),
      limit: z.number().min(1).max(500).default(200),
    }))
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) return { stocks: [] };

      // Get all analyses + dismissed tickers for this user
      const [doneAnalyses, userAssetsData, dismissedRows] = await Promise.all([
        db
          .select({
            id: analyses.id,
            videoId: analyses.videoId,
            analysisResult: analyses.analysisResult,
            createdAt: analyses.createdAt,
            channelName: analyses.channelName,
          })
          .from(analyses)
          .where(
            and(
              eq(analyses.userId, ctx.user.id),
              // Auto-expire: only show analyses from the last 30 days
              gte(analyses.createdAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
            )
          )
          .orderBy(desc(analyses.createdAt))
          .limit(200),
        getUserAssets(ctx.user.id),
        db.select({ ticker: watchlistDismissed.ticker })
          .from(watchlistDismissed)
          .where(eq(watchlistDismissed.userId, ctx.user.id)),
      ]);

      // Build dismissed set
      const dismissedSet = new Set(dismissedRows.map((r) => r.ticker.toUpperCase()));

      // Build score map from userAssets (ticker → score)
      const scoreMap = new Map<string, number | null>();
      for (const a of userAssetsData) {
        scoreMap.set(a.ticker.toUpperCase(), a.score ?? null);
      }

      // For each analysis, get the channel video upload date, title, and mentor
      const videoIds = doneAnalyses.map((a) => a.videoId).filter(Boolean) as string[];
      const videos = videoIds.length > 0
        ? await db.select({ videoId: channelVideos.videoId, title: channelVideos.title, uploadDate: channelVideos.uploadDate, mentor: channelVideos.mentor })
            .from(channelVideos)
            .where(inArray(channelVideos.videoId, videoIds))
        : [];
      const videoMap = new Map(videos.map((v) => [v.videoId, v]));

      // Build a raw list — analyses are already ordered newest first
      // We deduplicate by ticker: first occurrence (= newest video) wins
      const seenTickers = new Set<string>();
      const stockType = {} as {
        analysisId: number;
        videoId: string | null;
        videoTitle: string;
        videoDate: string;
        videoDateRaw: number; // epoch ms for sorting
        ticker: string;
        companyName: string;
        entryZone: string;
        stopLoss: string;
        strategy: string;
        watchlistStatus: string;
        isWatchlist: boolean;
        zivScore: number | null;
        mentor: "cycles_trading" | "micha_stocks";
      };
      const stocks: typeof stockType[] = [];

      for (const analysis of doneAnalyses) {
        if (!analysis.analysisResult) continue;
        try {
          const parsed = JSON.parse(analysis.analysisResult) as { rows?: Array<Record<string, string>>; general_notes?: string };
          const rows = parsed.rows ?? [];
          const videoInfo = analysis.videoId ? videoMap.get(analysis.videoId) : null;
          const rawDate = videoInfo?.uploadDate ?? analysis.createdAt;
          const videoDateRaw = new Date(rawDate).getTime();
          const videoDate = new Date(rawDate).toLocaleDateString("he-IL", { year: "numeric", month: "short", day: "numeric" });

          // Determine mentor: from channelVideos.mentor, or fall back to analyses.channelName
          const mentorFromVideo = videoInfo?.mentor;
          const channelNameLower = (analysis.channelName ?? "").toLowerCase();
          const mentor: "cycles_trading" | "micha_stocks" =
            mentorFromVideo ??
            (channelNameLower.includes("micha") ? "micha_stocks" : "cycles_trading");
          for (const row of rows) {
            if (!row.ticker || row.ticker === "—" || row.ticker === "-") continue;
            const tickerUpper = row.ticker.toUpperCase();
            // Skip dismissed tickers
            if (dismissedSet.has(tickerUpper)) continue;
            // Deduplicate: keep only the first (newest) occurrence per ticker
            if (seenTickers.has(tickerUpper)) continue;
            seenTickers.add(tickerUpper);
            stocks.push({
              analysisId: analysis.id,
              videoId: analysis.videoId,
              videoTitle: videoInfo?.title ?? `ניתוח #${analysis.id}`,
              videoDate,
              videoDateRaw,
              ticker: row.ticker,
              companyName: row.company_name ?? row.ticker,
              entryZone: row.entry_zone ?? "—",
              stopLoss: row.stop_loss ?? "—",
              strategy: row.strategy ?? "—",
              watchlistStatus: row.watchlist ?? "—",
              isWatchlist: !!(row.watchlist && row.watchlist !== "—" && row.watchlist !== "-"),
              zivScore: scoreMap.get(tickerUpper) ?? null,
              inCatalog: scoreMap.has(tickerUpper), // ← true if ticker exists in engine catalog
              mentor,
            });
          }
        } catch {
          // skip malformed
        }
      }

      return { stocks };
    }),

  /**
   * Dismiss a ticker from the watchlist (hide it permanently)
   */
  dismissWatchlistTicker: protectedProcedure
    .input(z.object({ ticker: z.string().min(1).max(16) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const tickerUpper = input.ticker.toUpperCase();
      // Upsert: ignore if already dismissed
      await db.insert(watchlistDismissed)
        .values({ userId: ctx.user.id, ticker: tickerUpper })
        .onDuplicateKeyUpdate({ set: { ticker: tickerUpper } });
      return { ticker: tickerUpper };
    }),

  /**
   * Scan Ziv scores for all unique watchlist tickers that don't have a score yet
   */
  scanWatchlistScores: protectedProcedure
    .input(z.object({
      forceAll: z.boolean().default(false), // if true, rescan even tickers that already have a score
    }).optional())
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const forceAll = input?.forceAll ?? false;

      // 1. Get all watchlist stocks
      const db = await getDb();
      if (!db) return { scanned: 0, skipped: 0, errors: 0, results: [] };

      const doneAnalyses = await db
        .select({ analysisResult: analyses.analysisResult })
        .from(analyses)
        .where(eq(analyses.userId, userId))
        .orderBy(desc(analyses.createdAt))
        .limit(200);

      // Collect unique tickers from watchlist
      const uniqueTickers = new Set<string>();
      for (const analysis of doneAnalyses) {
        if (!analysis.analysisResult) continue;
        try {
          const parsed = JSON.parse(analysis.analysisResult) as { rows?: Array<Record<string, string>> };
          for (const row of (parsed.rows ?? [])) {
            if (row.ticker && row.ticker !== "—" && row.ticker !== "-") {
              uniqueTickers.add(row.ticker.toUpperCase());
            }
          }
        } catch { /* skip */ }
      }

      // 2. Get existing userAssets scores
      const existingAssets = await getUserAssets(userId);
      const scoreMap = new Map<string, number | null>();
      for (const a of existingAssets) {
        scoreMap.set(a.ticker.toUpperCase(), a.score ?? null);
      }

      // 3. Determine which tickers need scanning
      const tickersToScan = Array.from(uniqueTickers).filter(ticker => {
        if (forceAll) return true;
        const existing = scoreMap.get(ticker);
        return existing == null; // only scan if no score
      });

      if (tickersToScan.length === 0) {
        return { scanned: 0, skipped: uniqueTickers.size, errors: 0, results: [] };
      }

      // 4. Scan each ticker with Ziv engine
      const results: Array<{ ticker: string; score: number | null; tier: string; error?: string }> = [];
      let scanned = 0;
      let errors = 0;

      // Process in batches of 5 to avoid overwhelming the market data API
      const BATCH_SIZE = 5;
      for (let i = 0; i < tickersToScan.length; i += BATCH_SIZE) {
        const batch = tickersToScan.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (ticker) => {
          try {
            const bars = await fetchBarsForTicker(ticker);
            if (bars.length < 20) {
              results.push({ ticker, score: null, tier: "No Data", error: "Insufficient bars" });
              errors++;
              return;
            }
            const ziv = calcZivEngineScore(bars);

            // Try to get live price for dailyChangePercent
            let dailyChangePct: number | null = null;
            try {
              const live = await fetchLivePrice(ticker);
              dailyChangePct = live?.changePercent ?? null;
            } catch { /* ignore */ }

            // ── Catalogue validation before upsert ──────────────────────
            const val1 = await validateTickerForCatalogue(ticker);
            if (!val1.ok) {
              results.push({ ticker, score: null, tier: "Rejected", error: val1.reason });
              errors++;
            } else {
              // Upsert into userAssets (create if not exists, update if exists)
              await upsertUserAsset(userId, ticker, {
                companyName: ticker,
                sector: "מניות",
                label: "Ziv Watchlist",
                score: ziv.score,
              });
              // Then update with full scan data
              await updateUserAssetScore(userId, ticker, ziv.score, dailyChangePct, {
                cmp: bars[bars.length - 1]?.close,
                tier: ziv.tier,
                reason: ziv.reason,
                recommendation: ziv.score >= 8 ? "BUY" : ziv.score >= 6 ? "WATCH" : "AVOID",
              });

              results.push({ ticker, score: ziv.score, tier: ziv.tier });
              scanned++;
            }
          } catch (err) {
            results.push({ ticker, score: null, tier: "Error", error: String(err) });
            errors++;
          }
        }));
      }

      return {
        scanned,
        skipped: uniqueTickers.size - tickersToScan.length,
        errors,
        results: results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
      };
    }),

  /**
   * Add a stock from a video analysis to the Ziv Asset Catalog
   */
  /**
   * Auto-sync: fetch new videos, analyze new ones, update catalog with deduplication.
   * Called by the daily 7:00 automation agent.
   */
  autoSyncAndAnalyze: protectedProcedure
    .input(z.object({ dryRun: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      type TickerEntry = {
        ticker: string; mentor: string; entryZone: string;
        strategy: string; stopLoss: string; isNew: boolean; signalScore: number;
      };
      const results: {
        newVideos: number; analyzed: number; failed: number;
        addedToCatalog: number; upgraded: number; errors: string[];
        tickers: TickerEntry[];
      } = { newVideos: 0, analyzed: 0, failed: 0, addedToCatalog: 0, upgraded: 0, errors: [], tickers: [] };

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      // ── Step 1: Sync both channels ──────────────────────────────────────
      for (const mentorKey of ["cycles_trading", "micha_stocks"] as const) {
        try {
          const channel = CHANNELS[mentorKey];
          await clearNewFlags();
          const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
          let newCount = 0;
          let cursor: string | undefined;
          for (let i = 0; i < 3; i++) {
            const { videos, nextCursor } = await fetchPage(channel.id, cursor);
            if (videos.length === 0) break;
            const ids = videos.map((v) => v.videoId);
            const existing = await getExistingVideoIds(ids);
            const newVids = videos.filter((v) => !existing.has(v.videoId) || v.uploadDate >= threeDaysAgo);
            if (newVids.length > 0) {
              await upsertChannelVideos(newVids.map((v) => ({ ...v, isNew: 1, mentor: mentorKey })));
              newCount += newVids.filter((v) => !existing.has(v.videoId)).length;
            }
            if (!nextCursor) break;
            cursor = nextCursor;
            await new Promise((r) => setTimeout(r, 200));
          }
          results.newVideos += newCount;
        } catch (e) {
          results.errors.push("sync " + mentorKey + ": " + String(e).slice(0, 60));
        }
      }

      // ── Step 2: Find unanalyzed videos from last 14 days ────────────────
      const cutoffDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const unanalyzed = await db
        .select({ videoId: channelVideos.videoId, mentor: channelVideos.mentor, title: channelVideos.title })
        .from(channelVideos)
        .where(and(
          eq(channelVideos.analysisId, null as unknown as number),
          // uploadDate >= cutoffDate handled by filtering in JS (drizzle gte)
        ))
        .orderBy(desc(channelVideos.uploadDate))
        .limit(20);

      // filter by date in JS to avoid sql template issues
      const recentUnanalyzed = unanalyzed.filter(v => {
        // we already ordered DESC, grab last 14 days
        return true; // limit 20 is enough
      });

      // ── Step 3: Analyze each unanalyzed video ───────────────────────────
      if (!input.dryRun) {
        const { runPipeline, withTimeout } = await import("./analyze") as {
          runPipeline: (id: number, videoId: string, url: string, userId: number) => Promise<void>;
          withTimeout: <T>(p: Promise<T>, ms: number, label: string) => Promise<T>;
        };

        for (const video of recentUnanalyzed.slice(0, 5)) {
          try {
            const videoUrl = "https://www.youtube.com/watch?v=" + video.videoId;
            const analysisId = await createAnalysis({
              userId: ctx.user.id, videoUrl, videoId: video.videoId, status: "processing",
            });
            await withTimeout(runPipeline(analysisId, video.videoId, videoUrl, ctx.user.id), 180_000, "pipeline");
            await markChannelVideoAnalyzed(video.videoId, analysisId);
            results.analyzed++;
          } catch (e) {
            results.failed++;
            results.errors.push("analyze " + video.videoId + ": " + String(e).slice(0, 60));
          }
        }
      }

      // ── Step 4: Collect tickers from recent analyses ─────────────────────
      // DEDUPLICATION: if same ticker appears from BOTH mentors → boost score
      const recentAnalyses = await db
        .select({ id: analyses.id, videoId: analyses.videoId, analysisResult: analyses.analysisResult })
        .from(analyses)
        .where(and(
          eq(analyses.userId, ctx.user.id),
          eq(analyses.status, "done"),
        ))
        .orderBy(desc(analyses.createdAt))
        .limit(30);

      const videoIds2 = recentAnalyses.map((a) => a.videoId).filter(Boolean) as string[];
      const videoRows2 = videoIds2.length > 0
        ? await db
            .select({ videoId: channelVideos.videoId, mentor: channelVideos.mentor, uploadDate: channelVideos.uploadDate })
            .from(channelVideos)
            .where(inArray(channelVideos.videoId, videoIds2))
        : [];
      const videoMentorMap = new Map(videoRows2.map((v) => [v.videoId, { mentor: v.mentor, uploadDate: v.uploadDate }]));

      const existingAssets = await getUserAssets(ctx.user.id);
      const existingMap = new Map(existingAssets.map((a) => [a.ticker.toUpperCase(), a]));

      // Map: ticker → { mentors: Set, rows, bestEntryZone, bestStrategy, bestSL, videoDate }
      const tickerMap = new Map<string, {
        mentors: Set<string>; entryZone: string; strategy: string;
        stopLoss: string; watchlisted: boolean; videoDate: Date;
      }>();

      // signal expiry: 14 days from video date
      const SIGNAL_EXPIRY_DAYS = 14;

      for (const analysis of recentAnalyses) {
        if (!analysis.analysisResult) continue;
        try {
          const parsed = JSON.parse(analysis.analysisResult) as { rows?: Array<Record<string, string>> };
          const rows = parsed.rows ?? [];
          const videoInfo = analysis.videoId ? videoMentorMap.get(analysis.videoId) : null;
          const mentor = videoInfo?.mentor ?? "cycles_trading";
          const videoDate = videoInfo?.uploadDate ? new Date(videoInfo.uploadDate) : new Date(0);

          // Only process signals from last SIGNAL_EXPIRY_DAYS days
          const ageMs = Date.now() - videoDate.getTime();
          if (ageMs > SIGNAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000) continue;

          for (const row of rows) {
            if (!row.ticker || row.ticker === "—") continue;
            const t = row.ticker.toUpperCase();
            const hasEntry = row.entry_zone && row.entry_zone !== "—";
            const isWatchlisted = row.watchlist && row.watchlist !== "—";
            if (!hasEntry && !isWatchlisted) continue; // skip pure "לא נוגע" rows

            if (!tickerMap.has(t)) {
              tickerMap.set(t, {
                mentors: new Set([mentor]),
                entryZone: row.entry_zone ?? "—",
                strategy: row.strategy ?? "—",
                stopLoss: row.stop_loss ?? "—",
                watchlisted: !!isWatchlisted,
                videoDate,
              });
            } else {
              const existing2 = tickerMap.get(t)!;
              existing2.mentors.add(mentor);
              // Prefer entry zone with actual content
              if (existing2.entryZone === "—" && hasEntry) existing2.entryZone = row.entry_zone!;
              if (existing2.strategy === "—" && row.strategy && row.strategy !== "—") existing2.strategy = row.strategy;
              if (existing2.stopLoss === "—" && row.stop_loss && row.stop_loss !== "—") existing2.stopLoss = row.stop_loss;
              // Keep most recent video date
              if (videoDate > existing2.videoDate) existing2.videoDate = videoDate;
            }
          }
        } catch { /* skip malformed */ }
      }

      // ── Step 5: Upsert to catalog with deduplication logic ───────────────
      for (const [ticker, info] of tickerMap.entries()) {
        const isNew = !existingMap.has(ticker);
        const bothMentors = info.mentors.size >= 2; // Ziv + Micha = double signal
        const baseScore = 7;
        const signalScore = bothMentors ? Math.min(baseScore + 1.5, 10) : baseScore; // +1.5 for dual mentor

        // Determine tier
        const tier = bothMentors ? "Dual Signal Watch" : "Watch";
        // Signal expiry: SIGNAL_EXPIRY_DAYS from video date
        const expiresAt = new Date(info.videoDate.getTime() + SIGNAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

        results.tickers.push({
          ticker, mentor: [...info.mentors].join("+"), entryZone: info.entryZone,
          strategy: info.strategy, stopLoss: info.stopLoss, isNew, signalScore,
        });

        if (!input.dryRun) {
          const noteParts: string[] = [];
          if (info.strategy !== "—") noteParts.push("אסטרטגיה: " + info.strategy);
          if (info.entryZone !== "—") noteParts.push("כניסה: " + info.entryZone);
          if (info.stopLoss !== "—")  noteParts.push("SL: " + info.stopLoss);
          noteParts.push("תפוגה: " + expiresAt.toLocaleDateString("he-IL"));
          if (bothMentors) noteParts.push("⭐ איתות משני מנטורים!");

          const label = bothMentors
            ? "Dual Signal (Ziv+Micha)"
            : info.mentors.has("micha_stocks") ? "Micha Watchlist" : "Ziv Watchlist";

          if (isNew) {
            // ── Catalogue validation ──────────────────────────────────────
            const valAI = await validateTickerForCatalogue(ticker);
            if (!valAI.ok) {
              console.warn(`[VideoSync] Skipping ${ticker}: ${valAI.reason}`);
              // Skip silently — penny/illiquid stocks from video analysis are dropped
            } else {
            await upsertUserAsset(ctx.user.id, ticker, {
              companyName: ticker,
              sector: "מניות",
              label,
              score: signalScore,
              tier,
              note: noteParts.join(" | "),
            });
            existingMap.set(ticker, { ticker, score: signalScore, tier } as typeof existingAssets[0]);
            results.addedToCatalog++;
            } // end validation ok
          } else {
            // Existing ticker — upgrade tier if dual signal
            const currentAsset = existingMap.get(ticker)!;
            const currentTier = currentAsset.tier ?? "";
            if (bothMentors && !currentTier.includes("Dual")) {
              await upsertUserAsset(ctx.user.id, ticker, {
                companyName: currentAsset.companyName ?? ticker,
                tier,
                score: signalScore,
                label,
                note: noteParts.join(" | "),
                signalDate:    info.videoDate,
                signalExpiry:  expiresAt,
                mentorSources: [...info.mentors].join("+"),
              });
              results.upgraded++;
            }
          }
        }
      }

      // ── Step 6: Learn patterns + build AgentInsights ─────────────────
      if (!input.dryRun) {
        try {
          const { learnPatternsFromAnalyses, buildDailyInsights } = await import("./learnPatterns");
          await learnPatternsFromAnalyses(ctx.user.id);
          await buildDailyInsights(ctx.user.id, {
            newVideos:      results.newVideos,
            analyzed:       results.analyzed,
            addedToCatalog: results.addedToCatalog,
            upgraded:       results.upgraded,
            tickers:        results.tickers,
            errors:         results.errors,
          });
        } catch (e) {
          results.errors.push("learn: " + String(e).slice(0, 60));
        }
      }

            return results;
    }),


  /**
   * Expire watch signals that passed their signalExpiry date.
   * Moves them to archived. Called daily by automation.
   */
  expireWatchSignals: protectedProcedure
    .mutation(async ({ ctx }) => {
      const db = await getDb();
      if (!db) return { expired: 0 };

      // Archive Watch tickers whose signalExpiry has passed
      await db.execute(
        sql`UPDATE userAssets
            SET archived=1, archivedAt=NOW(), tier='Expired Signal',
                note=CONCAT(COALESCE(note,''), ' | ⏱ פג תוקף אוטומטית')
            WHERE userId=${ctx.user.id}
              AND archived=0
              AND signalExpiry IS NOT NULL
              AND signalExpiry < NOW()
              AND (tier LIKE '%Watch%')`
      );

      const countRow = await db.execute(sql`SELECT ROW_COUNT() as n`);
      const n = (countRow as unknown as Array<{n: number}>)[0]?.n ?? 0;
      return { expired: Number(n) };
    }),

  addToAssetCatalog: protectedProcedure
    .input(z.object({
      ticker: z.string().min(1).max(16),
      companyName: z.string().default(""),
      sector: z.string().default("מניות"),
      label: z.string().optional(),
      entryZone: z.string().optional(),
      stopLoss: z.string().optional(),
      strategy: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const label = input.label ?? "Ziv Watchlist";
      // Build a note from the analysis data
      const noteParts: string[] = [];
      if (input.strategy && input.strategy !== "—") noteParts.push(`אסטרטגיה: ${input.strategy}`);
      if (input.entryZone && input.entryZone !== "—") noteParts.push(`כניסה: ${input.entryZone}`);
      if (input.stopLoss  && input.stopLoss  !== "—") noteParts.push(`SL: ${input.stopLoss}`);

      const signalDateNow = new Date();
      const signalExpiryDate = new Date(signalDateNow.getTime() + 14 * 24 * 60 * 60 * 1000);
      const hints: TaseTickerHints = {
        company: input.companyName,
        entryZone: input.entryZone,
        stopLoss: input.stopLoss,
        strategy: input.strategy,
      };
      const valManual = await validateTickerForCatalogue(input.ticker, hints);
      if (!valManual.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: valManual.reason! });
      }
      const resolvedTicker = valManual.resolvedTicker ?? inferTaseTickerSync(input.ticker, hints);
      await upsertUserAsset(ctx.user.id, resolvedTicker, {
        companyName: input.companyName || resolvedTicker,
        sector: resolvedTicker.endsWith(".TA") ? "TASE" : (input.sector || "מניות"),
        label,
        score: 7,
        tier: "Watch",
        note: noteParts.length > 0 ? noteParts.join(" | ") : undefined,
        signalDate:    signalDateNow,
        signalExpiry:  signalExpiryDate,
        mentorSources: label.includes("Micha") ? "micha" : "ziv",
      });
      return { success: true, ticker: resolvedTicker };
    }),
});
