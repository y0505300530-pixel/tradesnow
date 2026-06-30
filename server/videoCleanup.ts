/**
 * Delete channel videos older than N days (YouTube uploadDate)
 * and linked / stale analysis records.
 */
import { and, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { analyses, bulkSessionAnalyses, channelVideos } from "../drizzle/schema";
import { getDb } from "./db";
import { log } from "./logger";

export const VIDEO_CLEANUP_DEFAULT_DAYS = 20;

export type VideoCleanupResult = {
  days: number;
  dryRun: boolean;
  channelVideos: number;
  analysesLinked: number;
  bulkSessionLinks: number;
  bulkSessionOrphan: number;
  analysesOld: number;
};

function cutoffDate(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

export async function runVideoCleanup(options?: {
  days?: number;
  dryRun?: boolean;
}): Promise<VideoCleanupResult> {
  const days = options?.days ?? VIDEO_CLEANUP_DEFAULT_DAYS;
  const dryRun = options?.dryRun ?? false;
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  const cutoff = cutoffDate(days);

  const linkedRows = await db
    .select({ analysisId: channelVideos.analysisId })
    .from(channelVideos)
    .where(and(lt(channelVideos.uploadDate, cutoff), isNotNull(channelVideos.analysisId)));

  const linkedIds = [
    ...new Set(
      linkedRows
        .map((r) => r.analysisId)
        .filter((id): id is number => id != null),
    ),
  ];

  const [cvCount] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(channelVideos)
    .where(lt(channelVideos.uploadDate, cutoff));

  const [oldAnalysisCount] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(analyses)
    .where(lt(analyses.createdAt, cutoff));

  const result: VideoCleanupResult = {
    days,
    dryRun,
    channelVideos: Number(cvCount?.n ?? 0),
    analysesLinked: linkedIds.length,
    bulkSessionLinks: 0,
    bulkSessionOrphan: 0,
    analysesOld: Number(oldAnalysisCount?.n ?? 0),
  };

  if (dryRun) return result;

  if (linkedIds.length > 0) {
    await db.delete(bulkSessionAnalyses).where(inArray(bulkSessionAnalyses.analysisId, linkedIds));
    result.bulkSessionLinks = linkedIds.length;
    await db.delete(analyses).where(inArray(analyses.id, linkedIds));
  }

  await db.delete(channelVideos).where(lt(channelVideos.uploadDate, cutoff));

  await db.execute(sql`
    DELETE FROM bulkSessionAnalyses WHERE analysisId IN (
      SELECT id FROM (
        SELECT id FROM analyses WHERE createdAt < DATE_SUB(NOW(), INTERVAL ${days} DAY)
      ) x
    )
  `);

  await db.delete(analyses).where(lt(analyses.createdAt, cutoff));

  log.info("VIDEO_CLEANUP", `Done: ${JSON.stringify(result)}`);
  return result;
}
