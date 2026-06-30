import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { createPool } from "mysql2/promise";
import { analyses, bulkSessionAnalyses, bulkSessions, capitalEvents, channelVideos, InsertAnalysis, InsertCapitalEvent, InsertLabDailyLog, InsertLabSimulation, InsertLabTrade, InsertPortfolioHolding, InsertTradingDiaryEntry, InsertUser, knowledgeBase, labDailyLogs, labSimulations, labTrades, llmScanCache, deepAnalysisCache, masterKnowledge, parkingLotConfig, portfolioAccounts, portfolioAnalysis, portfolioHoldings, priceCache, priceAlerts, portfolioSnapshots, InsertPriceAlert, InsertPortfolioSnapshot, proficiencyMatrix, tradingDiary, tradePositions, userAssets, users, userSettings, systemSettings, portfolioChatMessages, PortfolioChatMessage, journalEvents, JournalEvent, InsertJournalEvent, systemLogs, dailyPositionChanges, InsertDailyPositionChange } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;
let _pool: ReturnType<typeof createPool> | null = null;

// Lazily create a mysql2 connection pool (max 10 connections).
// This avoids opening a new TCP connection on every request and saves ~200ms per call.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const url = new URL(process.env.DATABASE_URL);
      _pool = createPool({
        host: url.hostname,
        port: url.port ? parseInt(url.port, 10) : 3306,
        user: url.username,
        password: url.password,
        database: url.pathname.replace(/^\//, ""),
        ssl: { rejectUnauthorized: false }, // TiDB Cloud requires SSL
        connectionLimit: 10,               // Max 10 — safe under TiDB free-tier limits
        waitForConnections: true,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _db = drizzle(_pool as any);
      console.log("[Database] Connection pool initialized (max 10 connections)");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      console.error(`[Database] CRITICAL: Failed to connect: ${msg}`);
      console.error(`[Database] Stack: ${stack}`);
      _db = null;
      _pool = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// TODO: add feature queries here as your schema grows.

export async function createAnalysis(data: InsertAnalysis) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [result] = await db.insert(analyses).values(data);
  return result.insertId as number;
}

export async function getAnalysisById(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(analyses).where(eq(analyses.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Get watchlist count for multiple analysis IDs at once.
 * Returns a map of analysisId -> watchlistCount.
 */
export async function getWatchlistCountBatch(analysisIds: number[]): Promise<Record<number, number>> {
  if (analysisIds.length === 0) return {};
  const db = await getDb();
  if (!db) return {};
  const rows = await db
    .select({ id: analyses.id, analysisResult: analyses.analysisResult })
    .from(analyses)
    .where(inArray(analyses.id, analysisIds));
  const result: Record<number, number> = {};
  for (const row of rows) {
    if (!row.analysisResult) { result[row.id] = 0; continue; }
    try {
      const parsed = JSON.parse(row.analysisResult) as { rows?: Array<unknown> };
      // Count ALL rows (every ticker mentioned in the video), not just filtered watchlist rows
      result[row.id] = (parsed.rows ?? []).length;
    } catch { result[row.id] = 0; }
  }
  return result;
}

export async function updateAnalysis(id: number, data: Partial<InsertAnalysis>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(analyses).set(data).where(eq(analyses.id, id));
}

export async function getAnalysesByUser(userId: number, limit = 20) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db
    .select()
    .from(analyses)
    .where(eq(analyses.userId, userId))
    .orderBy(desc(analyses.createdAt))
    .limit(limit);
}

export async function getAllCompletedAnalysesByUser(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db
    .select()
    .from(analyses)
    .where(and(eq(analyses.userId, userId), eq(analyses.status, "done")))
    .orderBy(desc(analyses.createdAt));
}

export async function getKnowledgeBaseByUser(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(knowledgeBase).where(eq(knowledgeBase.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export async function upsertKnowledgeBase(userId: number, result: string, analysisCount: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .insert(knowledgeBase)
    .values({ userId, result, analysisCount })
    .onDuplicateKeyUpdate({ set: { result, analysisCount } });
}

// ── Proficiency Matrix helpers ──────────────────────────────────────────────

export async function getProficiencyMatrixByUser(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.select().from(proficiencyMatrix).where(eq(proficiencyMatrix.userId, userId));
}

export async function upsertProficiencyTopic(
  userId: number,
  topic: string,
  newLevel: number,
  newLogEntry: { videoTitle: string; insight: string; levelBefore: number; levelAfter: number; date: string }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Get existing row to merge log
  const existing = await db
    .select()
    .from(proficiencyMatrix)
    .where(and(eq(proficiencyMatrix.userId, userId), eq(proficiencyMatrix.topic, topic)))
    .limit(1);

  const existingLog: typeof newLogEntry[] = existing[0]?.updateLog
    ? JSON.parse(existing[0].updateLog)
    : [];

  // Keep last 10 log entries
  const updatedLog = [...existingLog, newLogEntry].slice(-10);

  await db
    .insert(proficiencyMatrix)
    .values({ userId, topic, level: newLevel, updateLog: JSON.stringify(updatedLog) })
    .onDuplicateKeyUpdate({
      set: { level: newLevel, updateLog: JSON.stringify(updatedLog) },
    });
}

export async function bulkUpsertProficiency(
  userId: number,
  updates: Array<{ topic: string; newLevel: number; logEntry: { videoTitle: string; insight: string; levelBefore: number; levelAfter: number; date: string } }>
) {
  for (const u of updates) {
    await upsertProficiencyTopic(userId, u.topic, u.newLevel, u.logEntry);
  }
}

// ── Bulk Session helpers ────────────────────────────────────────────────────

export async function createBulkSession(userId: number, totalCount: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [result] = await db.insert(bulkSessions).values({ userId, totalCount, status: "pending" });
  return result.insertId as number;
}

export async function getBulkSessionById(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(bulkSessions).where(eq(bulkSessions.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function updateBulkSession(id: number, data: { doneCount?: number; errorCount?: number; status?: "pending" | "processing" | "done" }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(bulkSessions).set(data).where(eq(bulkSessions.id, id));
}

export async function linkAnalysisToBulkSession(bulkSessionId: number, analysisId: number, position: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(bulkSessionAnalyses).values({ bulkSessionId, analysisId, position });
}

export async function getBulkSessionWithAnalyses(bulkSessionId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const session = await getBulkSessionById(bulkSessionId);
  if (!session) return null;
  const links = await db
    .select()
    .from(bulkSessionAnalyses)
    .where(eq(bulkSessionAnalyses.bulkSessionId, bulkSessionId))
    .orderBy(bulkSessionAnalyses.position);
  const analysisIds = links.map((l) => l.analysisId);
  if (analysisIds.length === 0) return { session, analyses: [] };
  const analysisRows = await db
    .select()
    .from(analyses)
    .where(inArray(analyses.id, analysisIds));
  // Re-order by position
  const analysisMap = new Map(analysisRows.map((a) => [a.id, a]));
  const orderedAnalyses = links.map((l) => analysisMap.get(l.analysisId)).filter(Boolean);
  return { session, analyses: orderedAnalyses };
}

export async function getBulkSessionsByUser(userId: number, limit = 10) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db
    .select()
    .from(bulkSessions)
    .where(eq(bulkSessions.userId, userId))
    .orderBy(desc(bulkSessions.createdAt))
    .limit(limit);
}

// ─── Master Knowledge helpers ─────────────────────────────────────────────────

export async function getMasterKnowledgeByUser(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(masterKnowledge).where(eq(masterKnowledge.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export async function upsertMasterKnowledge(
  userId: number,
  data: { technicalRules?: string; activeSignals?: string; learningStatus?: string }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const existing = await getMasterKnowledgeByUser(userId);
  if (existing) {
    await db
      .update(masterKnowledge)
      .set({ ...data })
      .where(eq(masterKnowledge.userId, userId));
  } else {
    await db.insert(masterKnowledge).values({ userId, ...data });
  }
}

// ─── User Settings helpers ────────────────────────────────────────────────────
export async function getUserSettings(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export async function upsertUserSettings(
  userId: number,
  data: {
    tradingviewWebhookUrl?: string;
    tradingviewApiKey?: string;
    platform?: string;
    startingBalance?: number;
    riskPerTrade?: number;
    stopLossBuffer?: number;
    telegramChatId?: string | null;
    telegramEnabled?: number;
  }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const existing = await getUserSettings(userId);
  if (existing) {
    await db.update(userSettings).set(data).where(eq(userSettings.userId, userId));
  } else {
    await db.insert(userSettings).values({ userId, ...data });
  }
}

// ─── Trade Positions helpers ──────────────────────────────────────────────────
export async function getTradePositionsByUser(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db
    .select()
    .from(tradePositions)
    .where(eq(tradePositions.userId, userId))
    .orderBy(desc(tradePositions.createdAt));
}

export async function upsertTradePosition(
  userId: number,
  ticker: string,
  data: {
    company?: string;
    aiEntry?: string;
    aiStopLoss?: string;
    aiTakeProfit?: string;
    aiLogic?: string;
    aiLogicDetail?: string;
    aiConfidence?: string;
    userEntry?: string;
    userStopLoss?: string;
    userTakeProfit?: string;
    userNotes?: string;
    status?: "watching" | "active" | "closed";
  }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select()
    .from(tradePositions)
    .where(and(eq(tradePositions.userId, userId), eq(tradePositions.ticker, ticker.toUpperCase())));
  if (rows.length > 0) {
    await db
      .update(tradePositions)
      .set(data)
      .where(eq(tradePositions.id, rows[0].id));
    return rows[0].id;
  } else {
    const [result] = await db
      .insert(tradePositions)
      .values({ userId, ticker: ticker.toUpperCase(), ...data });
    return Number(result.insertId);
  }
}

export async function updateTradePositionById(
  id: number,
  data: {
    userEntry?: string;
    userStopLoss?: string;
    userTakeProfit?: string;
    userNotes?: string;
    status?: "watching" | "active" | "closed";
    target1Price?: string;
    realizedProfit?: string;
    remainingExposure?: string;
  }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(tradePositions)
    .set(data)
    .where(eq(tradePositions.id, id));
}

export async function deleteTradePosition(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .delete(tradePositions)
    .where(eq(tradePositions.id, id));
}

// ─── Channel Videos DB Helpers ────────────────────────────────────────────────

export async function getChannelVideos(opts?: {
  limit?: number;
  offset?: number;
  mentor?: "cycles_trading" | "micha_stocks";
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;
  const query = db
    .select()
    .from(channelVideos)
    .orderBy(desc(channelVideos.uploadDate))
    .limit(limit)
    .offset(offset);
  if (opts?.mentor) {
    return query.where(eq(channelVideos.mentor, opts.mentor));
  }
  return query;
}

export async function countChannelVideos(mentor?: "cycles_trading" | "micha_stocks"): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const query = db.select({ count: sql<number>`count(*)` }).from(channelVideos);
  if (mentor) {
    const result = await query.where(eq(channelVideos.mentor, mentor));
    return Number(result[0]?.count ?? 0);
  }
  const result = await query;
  return Number(result[0]?.count ?? 0);
}

export async function upsertChannelVideos(
  videos: Array<{
    videoId: string;
    title: string;
    uploadDate: Date;
    thumbnailUrl?: string;
    duration?: number;
    viewCount?: number;
    isNew?: number;
    mentor?: "cycles_trading" | "micha_stocks";
  }>
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (videos.length === 0) return;
  // Insert in batches of 50 to avoid query size limits
  const BATCH = 50;
  for (let i = 0; i < videos.length; i += BATCH) {
    const batch = videos.slice(i, i + BATCH);
    await db
      .insert(channelVideos)
      .values(batch.map((v) => ({
        videoId: v.videoId,
        mentor: v.mentor ?? "cycles_trading",
        title: v.title,
        uploadDate: v.uploadDate,
        thumbnailUrl: v.thumbnailUrl ?? null,
        duration: v.duration ?? 0,
        viewCount: v.viewCount ?? 0,
        isNew: v.isNew ?? 0,
      })))
      .onDuplicateKeyUpdate({
        set: {
          title: sql`VALUES(title)`,
          thumbnailUrl: sql`VALUES(thumbnailUrl)`,
          duration: sql`VALUES(duration)`,
          viewCount: sql`VALUES(viewCount)`,
          updatedAt: sql`NOW()`,
        },
      });
  }
}

export async function markChannelVideoAnalyzed(videoId: string, analysisId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(channelVideos)
    .set({ analysisId, analyzedAt: new Date() })
    .where(eq(channelVideos.videoId, videoId));
}

export async function clearNewFlags(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(channelVideos).set({ isNew: 0 }).where(eq(channelVideos.isNew, 1));
}

export async function getChannelVideoByVideoId(videoId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(channelVideos).where(eq(channelVideos.videoId, videoId)).limit(1);
  return rows[0] ?? null;
}

export async function getExistingVideoIds(videoIds: string[]): Promise<Set<string>> {
  if (videoIds.length === 0) return new Set();
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select({ videoId: channelVideos.videoId })
    .from(channelVideos)
    .where(inArray(channelVideos.videoId, videoIds));
  return new Set(rows.map((r) => r.videoId));
}

export async function getRecentChannelVideos(sinceDate: Date, mentor?: "cycles_trading" | "micha_stocks") {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const query = db
    .select()
    .from(channelVideos)
    .orderBy(desc(channelVideos.uploadDate));
  if (mentor) {
    return query.where(and(gte(channelVideos.uploadDate, sinceDate), eq(channelVideos.mentor, mentor)));
  }
  return query.where(gte(channelVideos.uploadDate, sinceDate));
}

// ─── Lab Simulations ──────────────────────────────────────────────────────────

/**
 * Generate a unique simulation version string in the format YYYY-MM-DD.10.XXX
 * where XXX is a zero-padded 3-digit counter that auto-increments per day.
 * Example: "2026-03-06.10.001", "2026-03-06.10.002", ...
 */
export async function generateSimVersion(): Promise<string> {
  const db = await getDb();
  const today = new Date();
  const dateStr = today.toISOString().split("T")[0]; // e.g. "2026-03-06"
  const prefix = `${dateStr}.10.`;

  if (!db) {
    // Fallback: use timestamp-based suffix when DB is unavailable
    return `${prefix}001`;
  }

  // Count how many simulations already have a version starting with today's prefix
  const rows = await db
    .select({ simVersion: labSimulations.simVersion })
    .from(labSimulations)
    .where(sql`${labSimulations.simVersion} LIKE ${prefix + "%"}`);

  const count = rows.length;
  const seq = (count + 1).toString().padStart(3, "0");
  return `${prefix}${seq}`;
}

export async function createLabSimulation(data: InsertLabSimulation) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [result] = await db.insert(labSimulations).values(data);
  return result.insertId as number;
}

export async function getLabSimulation(id: number) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(labSimulations).where(eq(labSimulations.id, id));
  return rows[0] ?? null;
}

export async function getUserLabSimulations(userId: number) {
  const db = await getDb();
  if (!db) return [];
  // Select only lightweight columns for the list view.
  // Heavy blobs (scanReport, equityCurve, benchmarkData, lessonsLearned, tickerCapitals)
  // are excluded here and fetched on-demand via getLabSimulation().
  return db.select({
    id: labSimulations.id,
    userId: labSimulations.userId,
    name: labSimulations.name,
    tickers: labSimulations.tickers,
    startDate: labSimulations.startDate,
    endDate: labSimulations.endDate,
    capitalPerTrade: labSimulations.capitalPerTrade,
    status: labSimulations.status,
    totalROI: labSimulations.totalROI,
    totalProfit: labSimulations.totalProfit,
    finalWallet: labSimulations.finalWallet,
    monkeyValue: labSimulations.monkeyValue,
    profitMissed: labSimulations.profitMissed,
    simVersion: labSimulations.simVersion,
    systemCodeVersion: labSimulations.systemCodeVersion,
    errorMessage: labSimulations.errorMessage,
    minZivScore: labSimulations.minZivScore,
    targetAlphaMonthly: labSimulations.targetAlphaMonthly,
    partialLockGainThreshold: labSimulations.partialLockGainThreshold,
    riskLevel: labSimulations.riskLevel,
    maxSinglePositionPct: labSimulations.maxSinglePositionPct,
    createdAt: labSimulations.createdAt,
    updatedAt: labSimulations.updatedAt,
  }).from(labSimulations)
    .where(eq(labSimulations.userId, userId))
    .orderBy(desc(labSimulations.createdAt))
    .limit(20);
}

export async function updateLabSimulation(id: number, data: Partial<InsertLabSimulation>) {
  const db = await getDb();
  if (!db) return;
  try {
    await db.update(labSimulations).set(data).where(eq(labSimulations.id, id));
  } catch (err: unknown) {
    const e = err as { message?: string; code?: string; errno?: number; sqlMessage?: string; cause?: unknown };
    console.error('[DB] updateLabSimulation FAILED:', {
      id,
      fields: Object.keys(data),
      code: e?.code,
      errno: e?.errno,
      sqlMessage: e?.sqlMessage,
      message: e?.message?.slice(0, 300),
      cause: String(e?.cause ?? '').slice(0, 200),
    });
    throw err;
  }
}

export async function resetStuckAnalyses() {
  const db = await getDb();
  if (!db) return 0;
  const TEN_MINUTES_AGO = new Date(Date.now() - 10 * 60 * 1000);
  const result = await db.update(analyses)
    .set({
      status: "error",
      errorMessage: "Analysis was interrupted by a server restart. Please retry.",
    })
    .where(sql`${analyses.status} = 'processing' AND ${analyses.updatedAt} < ${TEN_MINUTES_AGO}`);
  const affected = (result as unknown as { rowsAffected?: number }[])?.[0]?.rowsAffected ?? 0;
  if (affected > 0) {
    console.log(`[Startup] Reset ${affected} stuck video analysis(es) to 'error' status (older than 10 min).`);
  }
  return affected;
}

export async function resetStuckSimulations() {
  const db = await getDb();
  if (!db) return 0;
  // Only reset simulations that have been stuck for more than 10 minutes.
  // Fresh simulations (< 10 min old) might just be running during a deploy — leave them alone.
  // They will be picked up by the background runner on this new instance.
  const TEN_MINUTES_AGO = new Date(Date.now() - 10 * 60 * 1000);
  const result = await db.update(labSimulations)
    .set({
      status: "error",
      errorMessage: "Simulation was interrupted by a server restart. Please run it again.",
    })
    .where(sql`${labSimulations.status} IN ('running', 'scanning') AND ${labSimulations.updatedAt} < ${TEN_MINUTES_AGO}`);
  const affected = (result as unknown as { rowsAffected?: number }[])?.[0]?.rowsAffected ?? 0;
  if (affected > 0) {
    console.log(`[Startup] Reset ${affected} stuck simulation(s) to 'error' status (older than 10 min).`);
  }
  return affected;
}

export async function deleteLabSimulation(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(labTrades).where(eq(labTrades.simulationId, id));
  await db.delete(labDailyLogs).where(eq(labDailyLogs.simulationId, id));
  await db.delete(labSimulations).where(eq(labSimulations.id, id));
}

// ─── Lab Trades ───────────────────────────────────────────────────────────────

export async function createLabTrade(data: InsertLabTrade) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [result] = await db.insert(labTrades).values(data);
  return result.insertId as number;
}

export async function batchInsertLabTrades(rows: InsertLabTrade[]) {
  if (!rows.length) return [];
  const db = await getDb();
  if (!db) return [];
  // Insert in chunks of 50 to avoid query size limits
  const CHUNK = 50;
  const insertIds: number[] = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const [result] = await db.insert(labTrades).values(rows.slice(i, i + CHUNK));
    // For batch inserts, insertId is the first ID of the batch
    if (result?.insertId) insertIds.push(result.insertId as number);
  }
  return insertIds;
}

export async function getLabTrades(simulationId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(labTrades)
    .where(eq(labTrades.simulationId, simulationId))
    .orderBy(labTrades.entryDate);
}

export async function deleteLabTrades(simulationId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(labTrades).where(eq(labTrades.simulationId, simulationId));
}

// ─── Lab Daily Logs ───────────────────────────────────────────────────────────

export async function createLabDailyLog(data: InsertLabDailyLog) {
  const db = await getDb();
  if (!db) return;
  await db.insert(labDailyLogs).values(data);
}

export async function batchInsertLabDailyLogs(rows: InsertLabDailyLog[]) {
  if (!rows.length) return;
  const db = await getDb();
  if (!db) return;
  // Insert in chunks of 100 to avoid query size limits
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(labDailyLogs).values(rows.slice(i, i + CHUNK));
  }
}

export async function getLabDailyLogs(simulationId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(labDailyLogs)
    .where(eq(labDailyLogs.simulationId, simulationId))
    .orderBy(labDailyLogs.date, labDailyLogs.id);
}

export async function deleteLabDailyLogs(simulationId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(labDailyLogs).where(eq(labDailyLogs.simulationId, simulationId));
}

// ─── User Asset List ──────────────────────────────────────────────────────────

export async function getUserAssets(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(userAssets)
    .where(and(eq(userAssets.userId, userId), eq(userAssets.archived, 0)))
    .orderBy(userAssets.sortOrder, userAssets.id);
}

export async function archiveUserAssets(userId: number, tickers: string[]) {
  const db = await getDb();
  if (!db || tickers.length === 0) return;
  const upper = tickers.map(t => t.toUpperCase());
  await db.update(userAssets)
    .set({ archived: 1, archivedAt: new Date() } as any)
    .where(and(eq(userAssets.userId, userId), inArray(userAssets.ticker, upper)));
}

export async function restoreUserAssets(userId: number, tickers: string[]) {
  const db = await getDb();
  if (!db || tickers.length === 0) return;
  const upper = tickers.map(t => t.toUpperCase());
  await db.update(userAssets)
    .set({ archived: 0, archivedAt: null } as any)
    .where(and(eq(userAssets.userId, userId), inArray(userAssets.ticker, upper)));
}

export async function getArchivedUserAssets(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(userAssets)
    .where(and(eq(userAssets.userId, userId), eq(userAssets.archived, 1)))
    .orderBy(userAssets.archivedAt);
}

export async function upsertUserAsset(userId: number, ticker: string, data: {
  companyName: string;
  sector?: string;
  exchange?: string;
  score?: number | null;
  label?: string | null;
  sortOrder?: number;
  tier?: string | null;
  note?: string | null;
  signalDate?: Date | null;
  signalExpiry?: Date | null;
  mentorSources?: string | null;
}) {
  const db = await getDb();
  if (!db) return;
  const upper = ticker.toUpperCase();
  const existing = await db.select({ id: userAssets.id })
    .from(userAssets)
    .where(and(eq(userAssets.userId, userId), eq(userAssets.ticker, upper)))
    .limit(1);
  const exchange = data.exchange ?? (upper.endsWith('.TA') ? 'TAS' : 'US');

  if (existing.length > 0) {
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.companyName) updateData.companyName = data.companyName;
    if (data.sector)      updateData.sector = data.sector;
    if (data.exchange)    updateData.exchange = exchange;
    if (data.score  != null) updateData.score = data.score;
    if (data.label  != null) updateData.label = data.label;
    if (data.sortOrder != null) updateData.sortOrder = data.sortOrder;
    if (data.tier   != null) updateData.tier = data.tier;
    if (data.note   != null) updateData.note = data.note;
    if (data.signalDate   != null) updateData.signalDate   = data.signalDate;
    if (data.signalExpiry != null) updateData.signalExpiry = data.signalExpiry;
    if (data.mentorSources != null) updateData.mentorSources = data.mentorSources;
    await db.update(userAssets).set(updateData).where(and(eq(userAssets.userId, userId), eq(userAssets.ticker, upper)));
  } else {
    await db.insert(userAssets).values({
      userId, ticker: upper, exchange,
      companyName:   data.companyName,
      sector:        data.sector ?? "מניות",
      score:         data.score ?? null,
      label:         data.label ?? null,
      sortOrder:     data.sortOrder ?? 0,
      tier:          data.tier ?? null,
      note:          data.note ?? null,
    });
  }
}


export async function updateUserAssetMeta(userId: number, ticker: string, meta: { name?: string; sector?: string; profitPotential?: number | null; note?: string | null }) {
  const db = await getDb();
  if (!db) return;
  const upper = ticker.toUpperCase();
  const updateData: Record<string, unknown> = {};
  if (meta.name) updateData.companyName = meta.name;
  if (meta.sector) updateData.sector = meta.sector;
  if (meta.profitPotential !== undefined) updateData.profitPotential = meta.profitPotential;
  if (meta.note !== undefined) updateData.note = meta.note;
  if (Object.keys(updateData).length === 0) return;
  await db.update(userAssets)
    .set(updateData)
    .where(and(eq(userAssets.userId, userId), eq(userAssets.ticker, upper)));
}

export async function updateUserAssetScore(
  userId: number,
  ticker: string,
  score: number,
  dailyChangePercent?: number | null,
  scanData?: {
    cmp?: number; ema50?: number; ema200?: number;
    proximityToEma50Pct?: number; recommendation?: string;
    reason?: string; tier?: string; weeklyEma50Slope?: number;
    donchian20High?: number; priceAction?: string;
    recommendedBuyPrice?: number; recommendedStopLoss?: number;
    hotSignal?: number;
    kronosBias?: number | null;
    kronosDirection?: string | null;
    kronosBandPct?: number | null;
    kronosPredPct?: number | null;
    kronosScannedAt?: Date | null;
  }
) {
  const db = await getDb();
  if (!db) return;
  const fields: Record<string, unknown> = { score };
  if (dailyChangePercent !== undefined) fields.dailyChangePercent = dailyChangePercent ?? null;
  if (scanData) {
    Object.assign(fields, scanData);
    fields.scannedAt = new Date();
  }
  await db.update(userAssets)
    .set(fields as any)
    .where(and(eq(userAssets.userId, userId), eq(userAssets.ticker, ticker.toUpperCase())));
}

export async function deleteUserAsset(userId: number, ticker: string) {
  const db = await getDb();
  if (!db) return;
  await db.delete(userAssets)
    .where(and(eq(userAssets.userId, userId), eq(userAssets.ticker, ticker.toUpperCase())));
}

export async function bulkDeleteUserAssets(userId: number, tickers: string[]) {
  const db = await getDb();
  if (!db || tickers.length === 0) return;
  const upper = tickers.map(t => t.toUpperCase());
  await db.delete(userAssets)
    .where(and(eq(userAssets.userId, userId), inArray(userAssets.ticker, upper)));
}

export async function bulkReplaceUserAssets(userId: number, assets: {
  ticker: string;
  companyName: string;
  sector: string;
  exchange?: string;
  score?: number | null;
  label?: string | null;
  sortOrder: number;
}[]) {
  const db = await getDb();
  if (!db) return;

  // ── SAFE REPLACE: preserve ISR (.TA) assets unless the new list contains at least one .TA ──
  // This prevents accidental wipe of Israeli assets when saving a USA-only reorder.
  const incomingTickers = new Set(assets.map(a => a.ticker.toUpperCase()));
  const hasIsrIncoming  = assets.some(a => a.ticker.toUpperCase().endsWith('.TA'));

  if (!hasIsrIncoming) {
    // Fetch existing ISR assets and keep them
    const existingIsr = await db.select().from(userAssets)
      .where(and(eq(userAssets.userId, userId), eq(userAssets.archived, 0)));
    const isrToKeep = existingIsr.filter(r => r.ticker.endsWith('.TA') && !incomingTickers.has(r.ticker));
    const allToInsert = [
      ...assets.map((a) => {
        const t = a.ticker.toUpperCase();
        return { ...a, userId, ticker: t, exchange: a.exchange ?? (t.endsWith('.TA') ? 'TASE' : 'US') };
      }),
      ...isrToKeep.map(r => ({
        userId: r.userId,
        ticker: r.ticker,
        companyName: r.companyName ?? r.ticker,
        sector: r.sector ?? 'Israel',
        exchange: 'TASE',
        score: r.score ?? null,
        label: r.label ?? null,
        sortOrder: r.sortOrder ?? 999,
        archived: 0,
      })),
    ];
    // ── Atomic replace: delete-all + re-insert in ONE transaction so a crash between
    //    the two steps can never leave the catalogue empty. (We delete all of this
    //    user's rows then re-insert non-ISR + preserved ISR — the per-user delete is
    //    intentional; ISR rows are preserved by re-inserting them above.)
    await db.transaction(async (tx) => {
      await tx.delete(userAssets).where(eq(userAssets.userId, userId));
      if (allToInsert.length > 0) {
        await tx.insert(userAssets).values(allToInsert as any[]);
      }
    });
    return;
  }

  // Full replace (new list contains ISR tickers — safe to wipe and re-insert).
  // Atomic: delete + insert in one transaction to avoid wiping the catalogue on crash.
  const fullInsert = assets.map((a) => {
    const t = a.ticker.toUpperCase();
    return { ...a, userId, ticker: t, exchange: a.exchange ?? (t.endsWith('.TA') ? 'TASE' : 'US') };
  });
  await db.transaction(async (tx) => {
    await tx.delete(userAssets).where(eq(userAssets.userId, userId));
    if (fullInsert.length > 0) {
      await tx.insert(userAssets).values(fullInsert);
    }
  });
}

// ─── v1.069 Turbo Cache: Price Data Cache helpers ─────────────────────────────

export interface PriceCacheBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Get cached price bars for a ticker within a date range.
 * Returns empty array if no cache exists.
 */
export async function getCachedPrices(
  ticker: string,
  startDate: string,  // YYYY-MM-DD
  endDate: string     // YYYY-MM-DD
): Promise<PriceCacheBar[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      date: priceCache.date,
      open: priceCache.open,
      high: priceCache.high,
      low: priceCache.low,
      close: priceCache.close,
      volume: priceCache.volume,
    })
    .from(priceCache)
    .where(
      and(
        eq(priceCache.ticker, ticker.toUpperCase()),
        gte(priceCache.date, startDate),
        lte(priceCache.date, endDate)
      )
    )
    .orderBy(priceCache.date);
  return rows;
}

/**
 * Get the cache metadata for a list of tickers:
 * last fetch time, row count, and whether the cache is stale (> 24h old).
 */
export async function getCacheStatus(tickers: string[]): Promise<
  Record<string, { lastFetchedAt: Date | null; rowCount: number; isStale: boolean }>
> {
  const db = await getDb();
  const result: Record<string, { lastFetchedAt: Date | null; rowCount: number; isStale: boolean }> = {};
  const upperTickers = tickers.map((t) => t.toUpperCase());
  for (const t of upperTickers) result[t] = { lastFetchedAt: null, rowCount: 0, isStale: true };
  if (!db || tickers.length === 0) return result;

  const rows = await db
    .select({
      ticker: priceCache.ticker,
      rowCount: sql<number>`COUNT(*)`,
      lastFetchedAt: sql<Date>`MAX(${priceCache.fetchedAt})`,
    })
    .from(priceCache)
    .where(inArray(priceCache.ticker, upperTickers))
    .groupBy(priceCache.ticker);

  const now = Date.now();
  for (const row of rows) {
    const age = row.lastFetchedAt ? now - new Date(row.lastFetchedAt).getTime() : Infinity;
    result[row.ticker] = {
      lastFetchedAt: row.lastFetchedAt ? new Date(row.lastFetchedAt) : null,
      rowCount: Number(row.rowCount),
      isStale: age > 24 * 60 * 60 * 1000, // stale if > 24h
    };
  }
  return result;
}

/**
 * Upsert price bars into the cache for a ticker.
 * Uses ON DUPLICATE KEY UPDATE to handle re-fetches gracefully.
 * Inserts in batches of 500 to avoid oversized queries.
 */
export async function upsertPriceCache(
  ticker: string,
  bars: PriceCacheBar[]
): Promise<void> {
  const db = await getDb();
  if (!db || bars.length === 0) return;
  const upper = ticker.toUpperCase();
  const now = new Date();
  const BATCH = 500;
  for (let i = 0; i < bars.length; i += BATCH) {
    const chunk = bars.slice(i, i + BATCH);
    await db
      .insert(priceCache)
      .values(chunk.map((b) => ({
        ticker: upper,
        date: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume ?? 0,
        fetchedAt: now,
      })))
      .onDuplicateKeyUpdate({
        set: {
          open: sql`VALUES(open)`,
          high: sql`VALUES(high)`,
          low: sql`VALUES(low)`,
          close: sql`VALUES(close)`,
          volume: sql`VALUES(volume)`,
          fetchedAt: now,
        },
      });
  }
}

/**
 * Get all cached bars for a list of tickers as a flat array (for CSV export).
 */
export async function getAllCachedBarsForTickers(tickers: string[]): Promise<
  Array<{ ticker: string; date: string; open: number; high: number; low: number; close: number; volume: number }>
> {
  const db = await getDb();
  if (!db || tickers.length === 0) return [];
  const upper = tickers.map((t) => t.toUpperCase());
  return db
    .select({
      ticker: priceCache.ticker,
      date: priceCache.date,
      open: priceCache.open,
      high: priceCache.high,
      low: priceCache.low,
      close: priceCache.close,
      volume: priceCache.volume,
    })
    .from(priceCache)
    .where(inArray(priceCache.ticker, upper))
    .orderBy(priceCache.ticker, priceCache.date);
}

// ─── Parking Lot Config Helpers ──────────────────────────────────────────────
const DEFAULT_PARKING_LOT_BASKET = [
  { ticker: "QQQ",  weight: 20, label: "Growth: Nasdaq-100",       sortOrder: 1 },
  { ticker: "SMH",  weight: 20, label: "Growth: Semiconductors",   sortOrder: 2 },
  { ticker: "RSP",  weight: 15, label: "Balance: Equal-Weight S&P",sortOrder: 3 },
  { ticker: "SCHD", weight: 15, label: "Balance: Dividend",        sortOrder: 4 },
  { ticker: "GLD",  weight: 10, label: "Hedge: Gold",              sortOrder: 5 },
  { ticker: "XLU",  weight: 10, label: "Hedge: Utilities",         sortOrder: 6 },
  { ticker: "BIL",  weight: 10, label: "Cash: T-Bills 4.5% yield", sortOrder: 7 },
  { ticker: "XLV",  weight:  5, label: "Sector: Healthcare",       sortOrder: 8 },
  { ticker: "TLT",  weight:  5, label: "Hedge: Long-Term Bonds",   sortOrder: 9 },
  { ticker: "IWM",  weight:  5, label: "Growth: Small-Cap",        sortOrder: 10 },
];

export async function getParkingLotConfig(userId: number) {
  const db = await getDb();
  if (!db) return DEFAULT_PARKING_LOT_BASKET;
  const rows = await db.select()
    .from(parkingLotConfig)
    .where(eq(parkingLotConfig.userId, userId))
    .orderBy(parkingLotConfig.sortOrder);
  if (rows.length === 0) return DEFAULT_PARKING_LOT_BASKET;
  return rows.map((r) => ({ ticker: r.ticker, weight: r.weight, label: r.ticker, sortOrder: r.sortOrder }));
}

export async function upsertParkingLotConfig(userId: number, items: { ticker: string; weight: number; sortOrder: number }[]) {
  const db = await getDb();
  if (!db) return;
  // Delete existing config for user and replace
  await db.delete(parkingLotConfig).where(eq(parkingLotConfig.userId, userId));
  if (items.length > 0) {
    await db.insert(parkingLotConfig).values(
      items.map((item) => ({
        userId,
        ticker: item.ticker.toUpperCase(),
        weight: item.weight,
        enabled: 1,
        sortOrder: item.sortOrder,
      }))
    );
  }
}

export async function resetParkingLotConfig(userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(parkingLotConfig).where(eq(parkingLotConfig.userId, userId));
}

// ─── v1.108 Bulk Price Loading ────────────────────────────────────────────────
/**
 * Load ALL cached price bars for multiple tickers in a SINGLE DB query.
 * Returns a map: ticker -> sorted array of OHLCV bars.
 * This replaces N separate getCachedPrices() calls with one batched query.
 */
export async function getBulkCachedPrices(
  tickers: string[],
  startDate: string,  // YYYY-MM-DD
  endDate: string     // YYYY-MM-DD
): Promise<Record<string, { date: string; open: number; high: number; low: number; close: number; volume: number }[]>> {
  const db = await getDb();
  const result: Record<string, { date: string; open: number; high: number; low: number; close: number; volume: number }[]> = {};
  if (!db || tickers.length === 0) return result;
  const upper = tickers.map((t) => t.toUpperCase());
  // v12.08 PERF: Split into sequential chunks of 50 tickers.
  // Sequential (not parallel) to avoid exhausting TiDB Cloud connection pool / throughput limits.
  // In-memory cache ensures this only happens once per hour.
  const CHUNK_SIZE = 50;
  for (let i = 0; i < upper.length; i += CHUNK_SIZE) {
    const chunk = upper.slice(i, i + CHUNK_SIZE);
    const rows = await db
      .select({
        ticker: priceCache.ticker,
        date: priceCache.date,
        open: priceCache.open,
        high: priceCache.high,
        low: priceCache.low,
        close: priceCache.close,
        volume: priceCache.volume,
      })
      .from(priceCache)
      .where(
        and(
          inArray(priceCache.ticker, chunk),
          gte(priceCache.date, startDate),
          lte(priceCache.date, endDate)
        )
      )
      .orderBy(priceCache.ticker, priceCache.date);
    for (const row of rows) {
      if (!result[row.ticker]) result[row.ticker] = [];
      result[row.ticker].push({ date: row.date, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume });
    }
  }
  return result;
}

// ─── v1.108 LLM Scan Cache ────────────────────────────────────────────────────
/**
 * Build the cache key for an LLM scan result.
 * Price is rounded to nearest $0.50 to allow minor intraday variation to hit the same cache entry.
 */
export function buildLlmCacheKey(ticker: string, date: string, price: number): { ticker: string; dateKey: string; priceKey: string } {
  const roundedPrice = (Math.round(price * 2) / 2).toFixed(2);
  return { ticker: ticker.toUpperCase(), dateKey: date, priceKey: roundedPrice };
}

/**
 * Look up multiple LLM scan cache entries in a single query.
 * Returns a map: `${ticker}|${dateKey}|${priceKey}` -> parsed ScanResult
 */
export async function getBulkLlmScanCache(
  keys: Array<{ ticker: string; dateKey: string; priceKey: string }>
): Promise<Record<string, unknown>> {
  const db = await getDb();
  if (!db || keys.length === 0) return {};
  // Build composite keys for lookup
  const result: Record<string, unknown> = {};
  // Fetch all matching rows — filter in JS (MySQL doesn't support tuple IN easily)
  const tickers = Array.from(new Set(keys.map((k) => k.ticker)));
  const dateKeys = Array.from(new Set(keys.map((k) => k.dateKey)));
  const rows = await db
    .select()
    .from(llmScanCache)
    .where(
      and(
        inArray(llmScanCache.ticker, tickers),
        inArray(llmScanCache.dateKey, dateKeys)
      )
    );
  const keySet = new Set(keys.map((k) => `${k.ticker}|${k.dateKey}|${k.priceKey}`));
  for (const row of rows) {
    const compositeKey = `${row.ticker}|${row.dateKey}|${row.priceKey}`;
    if (keySet.has(compositeKey)) {
      try { result[compositeKey] = JSON.parse(row.result); } catch { /* ignore */ }
    }
  }
  return result;
}

/**
 * Store an LLM scan result in the cache.
 */
export async function setLlmScanCache(
  ticker: string,
  dateKey: string,
  priceKey: string,
  scanResult: unknown
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(llmScanCache).values({
      ticker: ticker.toUpperCase(),
      dateKey,
      priceKey,
      result: JSON.stringify(scanResult),
    }).onDuplicateKeyUpdate({ set: { result: JSON.stringify(scanResult) } });
  } catch { /* ignore cache write failures */ }
}

// ─── Deep Analysis Cache helpers ──────────────────────────────────────────────────

const DEEP_ANALYSIS_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Get cached deep analysis result. Returns null if not found or older than 4h.
 * Also returns the row so callers can detect stale-but-present cache.
 */
export async function getDeepAnalysisCache(
  ticker: string,
  cacheKey: string
): Promise<{ result: unknown; isStale: boolean } | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const rows = await db
      .select()
      .from(deepAnalysisCache)
      .where(
        and(
          eq(deepAnalysisCache.ticker, ticker.toUpperCase()),
          eq(deepAnalysisCache.cacheKey, cacheKey)
        )
      )
      .limit(1);
    if (rows.length === 0) return null;
    const row = rows[0];
    const ageMs = Date.now() - new Date(row.createdAt).getTime();
    const isStale = ageMs > DEEP_ANALYSIS_TTL_MS;
    return { result: JSON.parse(row.result), isStale };
  } catch { return null; }
}

/**
 * Store a deep analysis result in the cache.
 */
export async function setDeepAnalysisCache(
  ticker: string,
  cacheKey: string,
  result: unknown
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(deepAnalysisCache).values({
      ticker: ticker.toUpperCase(),
      cacheKey,
      result: JSON.stringify(result),
    }).onDuplicateKeyUpdate({
      set: { result: JSON.stringify(result), createdAt: new Date() }
    });
  } catch { /* ignore cache write failures */ }
}

// ─── Real Portfolio Management helpers ───────────────────────────────────────

export async function getPortfolioAccount(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(portfolioAccounts).where(eq(portfolioAccounts.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export async function upsertPortfolioAccount(userId: number, data: { totalCapital?: number; cashBalance?: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const existing = await getPortfolioAccount(userId);
  if (existing) {
    await db.update(portfolioAccounts).set(data).where(eq(portfolioAccounts.userId, userId));
  } else {
    await db.insert(portfolioAccounts).values({ userId, totalCapital: data.totalCapital ?? 0, cashBalance: data.cashBalance ?? 0 });
  }
}

export async function getPortfolioHoldings(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(portfolioHoldings).where(eq(portfolioHoldings.userId, userId)).orderBy(portfolioHoldings.createdAt);
  // MySQL2 driver returns DOUBLE columns as strings for some precision levels.
  // Coerce stopLoss and takeProfit to numbers so the frontend always receives numbers.
  return rows.map(r => ({
    ...r,
    stopLoss: r.stopLoss != null ? Number(r.stopLoss) : null,
    takeProfit: r.takeProfit != null ? Number(r.takeProfit) : null,
    zivScore: r.zivScore != null ? Number(r.zivScore) : null,
    buyScore: r.buyScore != null ? Number(r.buyScore) : null,
    buyPrice: r.buyPrice != null ? Number(r.buyPrice) : r.buyPrice,
    units: r.units != null ? Number(r.units) : r.units,
  }));
}

export async function addPortfolioHolding(data: InsertPortfolioHolding) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [result] = await db.insert(portfolioHoldings).values(data);
  return result.insertId as number;
}

export async function updatePortfolioHolding(id: number, userId: number, data: Partial<InsertPortfolioHolding>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(portfolioHoldings).set(data).where(and(eq(portfolioHoldings.id, id), eq(portfolioHoldings.userId, userId)));
}

export async function deletePortfolioHolding(id: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(portfolioHoldings).where(and(eq(portfolioHoldings.id, id), eq(portfolioHoldings.userId, userId)));
}

export async function updatePortfolioHoldingPrice(id: number, currentPrice: number, dailyChangePercent?: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Always write dailyChangePercent: null clears stale 0 values from market-closed periods
  const fields: Record<string, unknown> = {
    currentPrice,
    priceUpdatedAt: new Date(),
    dailyChangePercent: dailyChangePercent !== undefined ? dailyChangePercent : null,
  };
  await db.update(portfolioHoldings).set(fields as any).where(eq(portfolioHoldings.id, id));
}

export async function updatePortfolioHoldingScore(id: number, userId: number, zivScore: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(portfolioHoldings).set({ zivScore }).where(and(eq(portfolioHoldings.id, id), eq(portfolioHoldings.userId, userId)));
}

export async function updatePortfolioHoldingLabFields(
  id: number,
  userId: number,
  fields: {
    zivScore?: number;
    stopLoss?: number;
    takeProfit?: number;
    positionSizePct?: number;
    peakPrice?: number;
    entryTier?: string;
  }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(portfolioHoldings).set(fields).where(and(eq(portfolioHoldings.id, id), eq(portfolioHoldings.userId, userId)));
}

export async function addCapitalEvent(data: InsertCapitalEvent) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [result] = await db.insert(capitalEvents).values(data);
  return result.insertId as number;
}

export async function getCapitalEvents(userId: number, limit = 50) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.select().from(capitalEvents).where(eq(capitalEvents.userId, userId)).orderBy(desc(capitalEvents.createdAt)).limit(limit);
}

export async function savePortfolioAnalysis(userId: number, result: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [r] = await db.insert(portfolioAnalysis).values({ userId, result });
  return r.insertId as number;
}

export async function getLatestPortfolioAnalysis(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(portfolioAnalysis).where(eq(portfolioAnalysis.userId, userId)).orderBy(desc(portfolioAnalysis.createdAt)).limit(1);
  return rows[0] ?? null;
}

// ── Trading Diary helpers ─────────────────────────────────────────────────────
export async function addTradingDiaryEntry(data: InsertTradingDiaryEntry) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [r] = await db.insert(tradingDiary).values(data);
  return r.insertId as number;
}
export async function getTradingDiaryEntries(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.select().from(tradingDiary).where(eq(tradingDiary.userId, userId)).orderBy(desc(tradingDiary.addedAt));
}
export async function deleteTradingDiaryEntry(id: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(tradingDiary).where(and(eq(tradingDiary.id, id), eq(tradingDiary.userId, userId)));
}
export async function updateTradingDiaryEntry(id: number, userId: number, data: Partial<InsertTradingDiaryEntry>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(tradingDiary).set(data).where(and(eq(tradingDiary.id, id), eq(tradingDiary.userId, userId)));
}

/**
 * Upsert diary entry on buy:
 * - If ticker not in diary → insert new entry
 * - If ticker already in diary → update with weighted-average buyPrice and new total units
 * Returns the diary entry id.
 */
export async function upsertDiaryOnBuy(
  userId: number,
  ticker: string,
  newUnits: number,
  newBuyPrice: number,
  fields: { company?: string | null; stopLoss?: number; takeProfit?: number; reason?: string; expectations?: string }
): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const existing = await db.select().from(tradingDiary)
    .where(and(eq(tradingDiary.userId, userId), eq(tradingDiary.ticker, ticker.toUpperCase())))
    .limit(1);
  if (existing.length === 0) {
    // Insert new
    const [r] = await db.insert(tradingDiary).values({
      userId,
      ticker: ticker.toUpperCase(),
      company: fields.company ?? null,
      units: newUnits,
      buyPrice: newBuyPrice,
      stopLoss: fields.stopLoss,
      takeProfit: fields.takeProfit,
      reason: fields.reason ?? `קנינו ${ticker} במחיר $${newBuyPrice}`,
      expectations: fields.expectations ?? `מעקב לפי מודל זיו`,
    });
    return r.insertId as number;
  }
  // Update: weighted-average buyPrice, add units
  const prev = existing[0];
  const totalUnits = (prev.units ?? 0) + newUnits;
  const weightedAvgPrice = ((prev.units ?? 0) * (prev.buyPrice ?? newBuyPrice) + newUnits * newBuyPrice) / totalUnits;
  await db.update(tradingDiary).set({
    units: totalUnits,
    buyPrice: weightedAvgPrice,
    // Only overwrite SL/TP if provided
    ...(fields.stopLoss ? { stopLoss: fields.stopLoss } : {}),
    ...(fields.takeProfit ? { takeProfit: fields.takeProfit } : {}),
  }).where(and(eq(tradingDiary.id, prev.id), eq(tradingDiary.userId, userId)));
  return prev.id;
}

/**
 * Update diary on partial sell: reduce units.
 * If units reach 0, close the entry with P&L and postMortem.
 */
export async function updateDiaryOnSell(
  userId: number,
  ticker: string,
  soldUnits: number,
  salePrice: number,
  postMortem?: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const { sql: sqlRaw } = await import("drizzle-orm");
  const existing = await db.select().from(tradingDiary)
    .where(and(eq(tradingDiary.userId, userId), eq(tradingDiary.ticker, ticker.toUpperCase())))
    .limit(1);
  // Filter to open entries only (diaryStatus column may not be in TS types yet)
  const openEntry = existing.find((e: any) => !e.diaryStatus || e.diaryStatus === 'open');
  if (!openEntry) return;
  const prev = openEntry;
  const remainingUnits = Math.max(0, (prev.units ?? 0) - soldUnits);
  if (remainingUnits <= 0) {
    // Full close
    const pnlUsd = (salePrice - (prev.buyPrice ?? salePrice)) * (prev.units ?? soldUnits);
    const pnlPct = prev.buyPrice ? ((salePrice - prev.buyPrice) / prev.buyPrice) * 100 : 0;
    await db.execute(sqlRaw`UPDATE tradingDiary SET units=0, closePrice=${salePrice}, closedAt=NOW(), pnlUsd=${pnlUsd}, pnlPct=${pnlPct}, postMortem=${postMortem ?? null}, diaryStatus='closed' WHERE id=${prev.id} AND userId=${userId}`);
  } else {
    // Partial sell — just reduce units
    await db.update(tradingDiary).set({ units: remainingUnits })
      .where(and(eq(tradingDiary.id, prev.id), eq(tradingDiary.userId, userId)));
  }
}

// ── Price Alerts helpers ──────────────────────────────────────────────────────
export async function createPriceAlert(data: InsertPriceAlert) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [r] = await db.insert(priceAlerts).values(data);
  return r.insertId as number;
}

export async function updatePriceAlert(id: number, userId: number, data: { targetPrice?: number; direction?: "below" | "above"; label?: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(priceAlerts)
    .set({ ...data })
    .where(and(eq(priceAlerts.id, id), eq(priceAlerts.userId, userId)));
}

export async function getPriceAlerts(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Exclude archived alerts — they are shown in the Archive section separately
  return db.select().from(priceAlerts)
    .where(and(
      eq(priceAlerts.userId, userId),
      eq(priceAlerts.dismissed, 0),
      isNull(priceAlerts.archivedAt)
    ))
    .orderBy(desc(priceAlerts.createdAt));
}

export async function getArchivedAlerts(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.select().from(priceAlerts)
    .where(and(
      eq(priceAlerts.userId, userId),
      isNotNull(priceAlerts.archivedAt)
    ))
    .orderBy(desc(priceAlerts.archivedAt));
}

export async function getActiveAlerts(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.select().from(priceAlerts)
    .where(and(
      eq(priceAlerts.userId, userId),
      eq(priceAlerts.triggered, 0),
      eq(priceAlerts.dismissed, 0)
    ));
}

export async function getTriggeredUndismissedAlerts(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Only return non-archived triggered alerts (fresh, within 48h)
  return db.select().from(priceAlerts)
    .where(and(
      eq(priceAlerts.userId, userId),
      eq(priceAlerts.triggered, 1),
      eq(priceAlerts.dismissed, 0),
      isNull(priceAlerts.archivedAt)
    ))
    .orderBy(desc(priceAlerts.triggeredAt));
}

export async function triggerPriceAlert(id: number, triggeredPrice: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(priceAlerts).set({
    triggered: 1,
    triggeredAt: new Date(),
    triggeredPrice,
    // Set lastAlertSentAt so the 24h anti-spam dedup in alertPoller prevents duplicate Telegram messages
    lastAlertSentAt: new Date(),
  }).where(eq(priceAlerts.id, id));
}

export async function dismissPriceAlert(id: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(priceAlerts).set({ dismissed: 1 }).where(
    and(eq(priceAlerts.id, id), eq(priceAlerts.userId, userId))
  );
}

export async function deletePriceAlert(id: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(priceAlerts).where(
    and(eq(priceAlerts.id, id), eq(priceAlerts.userId, userId))
  );
}

export async function deletePriceAlertsForTicker(userId: number, ticker: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(priceAlerts).where(
    and(eq(priceAlerts.userId, userId), eq(priceAlerts.ticker, ticker))
  );
}

/**
 * Upsert a SL or TP alert for a holding.
 * If an alert of the same type already exists for this ticker+userId, update its targetPrice.
 * If it was already triggered, reset it so it fires again at the new price.
 */
export async function upsertHoldingAlert(
  userId: number,
  ticker: string,
  alertType: "sl" | "tp",
  targetPrice: number
) {
  const db = await getDb();
  if (!db) return;
  const upper = ticker.toUpperCase();
  const label = alertType === "sl" ? "Stop Loss" : "Take Profit";
  const direction = alertType === "sl" ? "below" : "above";

  // Check if an alert of this type already exists
  const existing = await db.select({ id: priceAlerts.id })
    .from(priceAlerts)
    .where(and(
      eq(priceAlerts.userId, userId),
      eq(priceAlerts.ticker, upper),
      eq(priceAlerts.alertType, alertType),
      eq(priceAlerts.dismissed, 0)
    ))
    .limit(1);

  if (existing.length > 0) {
    // Update existing alert — reset triggered so it fires again at new price
    await db.update(priceAlerts).set({
      targetPrice,
      direction,
      label,
      triggered: 0,
      triggeredAt: null,
      triggeredPrice: null,
    }).where(eq(priceAlerts.id, existing[0].id));
  } else {
    // Create new alert
    await db.insert(priceAlerts).values({
      userId,
      ticker: upper,
      alertType,
      targetPrice,
      direction,
      label,
    });
  }
}

/**
 * Recycle (unarchive) a single archived alert.
 * Resets triggered/dismissed/archivedAt/triggeredAt/triggeredPrice so it becomes
 * a fresh pending alert. Optionally updates targetPrice and zivScore from Ziv Engine.
 */
export async function recycleArchivedAlert(
  id: number,
  userId: number,
  opts?: { targetPrice?: number; zivScore?: number | null }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(priceAlerts).set({
    triggered: 0,
    triggeredAt: null,
    triggeredPrice: null,
    dismissed: 0,
    archivedAt: null,
    zivScore: opts?.zivScore ?? null,
    ...(opts?.targetPrice != null ? { targetPrice: opts.targetPrice } : {}),
  }).where(and(eq(priceAlerts.id, id), eq(priceAlerts.userId, userId)));
}

/**
 * Recycle all archived alerts for a user.
 * Returns the list of recycled alert ids.
 */
export async function recycleAllArchivedAlerts(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const archived = await db.select({ id: priceAlerts.id })
    .from(priceAlerts)
    .where(and(eq(priceAlerts.userId, userId), isNotNull(priceAlerts.archivedAt)));
  if (!archived.length) return [];
  const ids = archived.map(r => r.id);
  await db.update(priceAlerts).set({
    triggered: 0,
    triggeredAt: null,
    triggeredPrice: null,
    dismissed: 0,
    archivedAt: null,
    zivScore: null,
  }).where(and(eq(priceAlerts.userId, userId), inArray(priceAlerts.id, ids)));
  return ids;
}

/**
 * Delete all SL alerts for a ticker (called when holding is removed)
 */
export async function deleteHoldingSLAlert(userId: number, ticker: string) {
  const db = await getDb();
  if (!db) return;
  await db.delete(priceAlerts).where(
    and(
      eq(priceAlerts.userId, userId),
      eq(priceAlerts.ticker, ticker.toUpperCase()),
      eq(priceAlerts.alertType, "sl")
    )
  );
}

/**
 * Upsert a Catalogue price-drop alert (fires when currentPrice <= buyPrice).
 * alertType = "custom", direction = "below", label = "Catalogue Entry Alert"
 */
export async function upsertCatalogueAlert(
  userId: number,
  ticker: string,
  targetPrice: number,
  zivScore?: number | null
) {
  const db = await getDb();
  if (!db) return;
  const upper = ticker.toUpperCase();

  const existing = await db.select({ id: priceAlerts.id })
    .from(priceAlerts)
    .where(and(
      eq(priceAlerts.userId, userId),
      eq(priceAlerts.ticker, upper),
      eq(priceAlerts.alertType, "custom"),
      eq(priceAlerts.dismissed, 0)
    ))
    .limit(1);

  if (existing.length > 0) {
    // IMPORTANT: Do NOT reset lastAlertSentAt here.
    // Preserving it ensures the 24h anti-spam dedup in slCheckScheduled
    // and alertPoller continues to work after a re-arm (triggered=0 reset).
    // Without this, the same ticker can fire multiple times per day when
    // the price oscillates around the entry level.
    await db.update(priceAlerts).set({
      targetPrice,
      direction: "below",
      label: "Catalogue Entry Alert",
      triggered: 0,
      triggeredAt: null,
      triggeredPrice: null,
      ...(zivScore != null ? { zivScore } : {}),
      // lastAlertSentAt intentionally NOT reset — preserves 24h dedup window
    }).where(eq(priceAlerts.id, existing[0].id));
  } else {
    await db.insert(priceAlerts).values({
      userId,
      ticker: upper,
      alertType: "custom",
      targetPrice,
      direction: "below",
      label: "Catalogue Entry Alert",
      ...(zivScore != null ? { zivScore } : {}),
    });
  }
}

/**
 * Delete ALL active (non-dismissed) alerts for a ticker.
 * Used when a holding is sold or an asset is removed from the catalogue.
 */
export async function deleteAllAlertsForTicker(userId: number, ticker: string) {
  const db = await getDb();
  if (!db) return;
  await db.delete(priceAlerts).where(
    and(
      eq(priceAlerts.userId, userId),
      eq(priceAlerts.ticker, ticker.toUpperCase()),
      eq(priceAlerts.dismissed, 0)
    )
  );
}

// ── Portfolio Snapshots helpers ───────────────────────────────────────────────
export async function upsertPortfolioSnapshot(data: InsertPortfolioSnapshot) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(portfolioSnapshots).values(data)
    .onDuplicateKeyUpdate({
      set: {
        totalValue: data.totalValue,
        investedValue: data.investedValue,
        cashBalance: data.cashBalance,
        totalCost: data.totalCost,
        pnlUsd: data.pnlUsd,
        pnlPct: data.pnlPct,
        totalEquity: data.totalEquity,
        unrealizedPnL: data.unrealizedPnL,
        holdingsSnapshot: data.holdingsSnapshot,
        h2Value: data.h2Value,
      }
    });
}

/** Get ALL snapshots since the beginning (for the full equity chart from April 2024) */
export async function getPortfolioSnapshotsAll(userId: number, portfolioType = "h1") {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.select().from(portfolioSnapshots)
    .where(and(eq(portfolioSnapshots.userId, userId), eq(portfolioSnapshots.portfolioType, portfolioType)))
    .orderBy(portfolioSnapshots.snapshotDate);
}

/** Check if a snapshot already exists for today (to avoid duplicate daily snapshots) */
export async function getTodaySnapshot(userId: number, portfolioType = "h1"): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db.select({ id: portfolioSnapshots.id })
    .from(portfolioSnapshots)
    .where(and(eq(portfolioSnapshots.userId, userId), eq(portfolioSnapshots.snapshotDate, today), eq(portfolioSnapshots.portfolioType, portfolioType)))
    .limit(1);
  return rows.length > 0;
}

export async function getPortfolioSnapshots(userId: number, days = 90) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Get last N days of snapshots
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10); // YYYY-MM-DD
  return db.select().from(portfolioSnapshots)
    .where(and(
      eq(portfolioSnapshots.userId, userId),
      gte(portfolioSnapshots.snapshotDate, cutoffStr)
    ))
    .orderBy(portfolioSnapshots.snapshotDate);
}

// ── System Settings helpers (global key-value store for server-side persistent flags) ──

/**
 * Get a system-level setting by key.
 * Returns the string value, or null if not found.
 */
export async function getSystemSetting(key: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const rows = await db.select().from(systemSettings).where(eq(systemSettings.key, key)).limit(1);
    return rows[0]?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Set (upsert) a system-level setting by key.
 */
export async function setSystemSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.insert(systemSettings).values({ key, value })
    .onDuplicateKeyUpdate({ set: { value } });
}

// ── Portfolio Chat Message helpers ──────────────────────────────────────────

/**
 * Save a single chat message (user or assistant) for a given user.
 */
export async function saveChatMessage(
  userId: number,
  role: "user" | "assistant",
  content: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(portfolioChatMessages).values({ userId, role, content });
  } catch (err) {
    console.error("[DB] saveChatMessage failed:", err);
  }
}

/**
 * Retrieve the last N chat messages for a user, ordered oldest-first.
 * Default limit is 50 messages.
 */
export async function getChatHistory(
  userId: number,
  limit = 50
): Promise<PortfolioChatMessage[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    // Fetch the most recent `limit` rows (desc), then reverse to get oldest-first
    const rows = await db
      .select()
      .from(portfolioChatMessages)
      .where(eq(portfolioChatMessages.userId, userId))
      .orderBy(desc(portfolioChatMessages.createdAt))
      .limit(limit);
    return rows.reverse();
  } catch (err) {
    console.error("[DB] getChatHistory failed:", err);
    return [];
  }
}

// ── Journal Event helpers ────────────────────────────────────────────────────

/**
 * Log a journal event (buy, sell, sl_order, tp_order, bracket_order, sync, note, etc.)
 */
export async function logJournalEvent(
  event: InsertJournalEvent
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(journalEvents).values(event);
  } catch (err) {
    console.error("[DB] logJournalEvent failed:", err);
  }
}

/**
 * Retrieve journal events for a user, optionally filtered by ticker.
 * Returns newest-first, up to `limit` rows.
 */
export async function getJournalEvents(
  userId: number,
  ticker?: string,
  limit = 100
): Promise<JournalEvent[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    const conditions = ticker
      ? and(eq(journalEvents.userId, userId), eq(journalEvents.ticker, ticker))
      : eq(journalEvents.userId, userId);
    return await db
      .select()
      .from(journalEvents)
      .where(conditions)
      .orderBy(desc(journalEvents.eventAt))
      .limit(limit);
  } catch (err) {
    console.error("[DB] getJournalEvents failed:", err);
    return [];
  }
}

// ── Persistent System Logs helpers ──────────────────────────────────────────

/**
 * Retrieve persistent system logs from DB (newest first).
 * Supports filtering by level and category.
 */
export async function getPersistentLogStats(): Promise<{ count: number; lastModified: string | null }> {
  const db = await getDb();
  if (!db) return { count: 0, lastModified: null };
  try {
    const [row] = await db
      .select({
        count: sql<number>`cast(count(*) as unsigned)`,
        lastModified: sql<Date | null>`max(${systemLogs.createdAt})`,
      })
      .from(systemLogs);
    return {
      count: Number(row?.count ?? 0),
      lastModified: row?.lastModified ? row.lastModified.toISOString() : null,
    };
  } catch (err) {
    console.error("[DB] getPersistentLogStats failed:", err);
    return { count: 0, lastModified: null };
  }
}

export async function getPersistentLogs(opts?: {
  level?: "critical" | "error" | "warn" | "info";
  category?: string;
  limit?: number;
}): Promise<Array<{
  id: number;
  level: string;
  category: string;
  message: string;
  stack: string | null;
  context: string | null;
  instanceId: string | null;
  createdAt: Date | null;
}>> {
  const db = await getDb();
  if (!db) return [];
  try {
    const conditions = [];
    if (opts?.level) conditions.push(eq(systemLogs.level, opts.level));
    if (opts?.category) conditions.push(eq(systemLogs.category, opts.category));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    return await db
      .select()
      .from(systemLogs)
      .where(where)
      .orderBy(desc(systemLogs.createdAt))
      .limit(opts?.limit ?? 100);
  } catch (err) {
    console.error("[DB] getPersistentLogs failed:", err);
    return [];
  }
}


// ── Daily Position Changes helpers ──────────────────────────────────────────

/**
 * Record a position change for today. Uses INSERT ... ON DUPLICATE KEY UPDATE
 * so that if the same ticker changes multiple times in one day, we keep the latest state.
 */
export async function upsertDailyPositionChange(change: InsertDailyPositionChange) {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(dailyPositionChanges).values(change)
      .onDuplicateKeyUpdate({
        set: {
          changeType: sql`VALUES(changeType)`,
          unitsBefore: sql`VALUES(unitsBefore)`,
          unitsAfter: sql`VALUES(unitsAfter)`,
          unitsDelta: sql`VALUES(unitsDelta)`,
          avgPriceBefore: sql`VALUES(avgPriceBefore)`,
          avgPriceAfter: sql`VALUES(avgPriceAfter)`,
          marketPriceAtChange: sql`VALUES(marketPriceAtChange)`,
          realizedPnl: sql`VALUES(realizedPnl)`,
        },
      });
  } catch (err) {
    console.error("[DB] upsertDailyPositionChange failed:", err);
  }
}

/**
 * Get all position changes for a user on a given date (YYYY-MM-DD).
 */
export async function getDailyPositionChanges(userId: number, date: string) {
  const db = await getDb();
  if (!db) return [];
  try {
    return await db.select().from(dailyPositionChanges)
      .where(and(
        eq(dailyPositionChanges.userId, userId),
        eq(dailyPositionChanges.date, date),
      ))
      .orderBy(desc(dailyPositionChanges.detectedAt));
  } catch (err) {
    console.error("[DB] getDailyPositionChanges failed:", err);
    return [];
  }
}

/**
 * Get all position changes for a user within a date range.
 */
export async function getDailyPositionChangesRange(userId: number, fromDate: string, toDate: string) {
  const db = await getDb();
  if (!db) return [];
  try {
    return await db.select().from(dailyPositionChanges)
      .where(and(
        eq(dailyPositionChanges.userId, userId),
        gte(dailyPositionChanges.date, fromDate),
        lte(dailyPositionChanges.date, toDate),
      ))
      .orderBy(desc(dailyPositionChanges.date), desc(dailyPositionChanges.detectedAt));
  } catch (err) {
    console.error("[DB] getDailyPositionChangesRange failed:", err);
    return [];
  }
}

// ─── Catalogue Entry Validator ──────────────────────────────────────────────
/**
 * validateTickerForCatalogue — runs price + volume checks before adding to catalogue.
 * Returns null if OK, or an error string if rejected.
 * Used by addUserAsset (manual) AND videoManagement AI pipeline.
 *
 * Thresholds:
 *   US stocks  : price >= $1.00,  avg 20-day volume >= 50,000
 *   TASE stocks: price >= ₪1.00,  avg 20-day volume >= 10,000
 */
export async function validateTickerForCatalogue(
  ticker: string,
  hints?: import("./taseTickerResolve").TaseTickerHints,
): Promise<{ ok: boolean; reason?: string; resolvedTicker?: string }> {
  const { resolveTaseTickerForCatalogue } = await import("./taseTickerResolve");
  const { evaluateCatalogueEligibility } = await import("./catalogueEligibility");
  const tickerUpper = await resolveTaseTickerForCatalogue(ticker, hints);
  const isTase = tickerUpper.endsWith(".TA");
  const cs = isTase ? "₪" : "$";

  try {
    const elig = await evaluateCatalogueEligibility(ticker, hints);

    if (elig.priceOk === null || elig.volumeOk === null) {
    console.warn(`[CatalogueValidation] Could not fetch bars for ${tickerUpper} — rejecting (fail-closed)`);
    return { ok: false, reason: `❌ ${tickerUpper}: לא ניתן לאמת מחיר/נפח — נחסם (fail-closed)` };
  }

  if (!elig.priceOk && elig.price != null) {
    const priceStr = elig.price < 0.01 ? elig.price.toFixed(6) : elig.price.toFixed(2);
    return {
      ok: false,
      reason: `❌ ${tickerUpper} נכשל בבדיקת תנאי סף: מחיר ${cs}${priceStr} נמוך מהמינימום ${cs}${elig.minPrice.toFixed(2)}. Penny stocks אינם נתמכים.`,
    };
  }

  if (!elig.volumeOk && elig.avgVolume20 != null) {
    return {
      ok: false,
      reason: `❌ ${tickerUpper} נכשל בבדיקת תנאי סף: נפח ${Math.round(elig.avgVolume20).toLocaleString()} מניות/יום נמוך מהמינימום ${elig.minVolume.toLocaleString()}. מניה לא סחירה.`,
    };
  }

  // ── Volatility check: ATR% >= 3.5% for US stocks (skip TASE) ──
  if (!isTase) {
    try {
      const { fetchBarsForTicker } = await import("./marketData");
      const bars = await fetchBarsForTicker(tickerUpper, 30);
      const avgHigh = bars.slice(-20).reduce((s, b) => s + (b.high ?? b.close), 0) / Math.min(20, bars.length);
      const avgLow  = bars.slice(-20).reduce((s, b) => s + (b.low  ?? b.close), 0) / Math.min(20, bars.length);
      const avgClose= bars.slice(-20).reduce((s, b) => s + (b.close ?? 0), 0) / Math.min(20, bars.length);
      const atrPct  = avgClose > 0 ? ((avgHigh - avgLow) / avgClose) * 100 : 0;
      const minAtr  = 3.5;
      if (atrPct > 0 && atrPct < minAtr) {
        return {
          ok: false,
          reason: `❌ ${tickerUpper} נכשל בבדיקת ולטיליות: ATR יומי ${atrPct.toFixed(1)}% נמוך מ-${minAtr}% המינימלי. מניה עייפה — לא מתאימה למנוע.`,
        };
      }
    } catch { /* non-blocking */ }
  }

    return { ok: true, resolvedTicker: tickerUpper };
  } catch (e: any) {
    console.warn(`[CatalogueValidation] Error validating ${tickerUpper}:`, e?.message ?? e);
    return { ok: true, resolvedTicker: tickerUpper };
  }
}
