import { bigint, boolean, date, double, index, int, json, longtext, mediumtext, mysqlEnum, mysqlTable, text, timestamp, tinyint, smallint, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
  totpSecret: varchar("totpSecret", { length: 64 }), // Google Authenticator TOTP secret (base32)
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// TODO: Add your tables here

export const analyses = mysqlTable("analyses", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  videoUrl: text("videoUrl").notNull(),
  videoId: varchar("videoId", { length: 32 }).notNull(),
  videoTitle: text("videoTitle"),
  channelName: text("channelName"),
  thumbnailUrl: text("thumbnailUrl"),
  publishDate: timestamp("publishDate"), // Original YouTube video publish date (NOT analysis date)
  transcript: text("transcript"),
  analysisResult: text("analysisResult"), // JSON string of trading rows
  status: mysqlEnum("status", ["pending", "processing", "done", "error"]).default("pending").notNull(),
  errorMessage: text("errorMessage"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Analysis = typeof analyses.$inferSelect;
export type InsertAnalysis = typeof analyses.$inferInsert;

export const knowledgeBase = mysqlTable("knowledgeBase", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(), // one knowledge base per user
  result: text("result"), // JSON string of synthesized knowledge
  analysisCount: int("analysisCount").default(0).notNull(), // how many analyses were used
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type KnowledgeBase = typeof knowledgeBase.$inferSelect;
export type InsertKnowledgeBase = typeof knowledgeBase.$inferInsert;

// AI Proficiency Matrix — one row per user per topic (15 topics total)
export const proficiencyMatrix = mysqlTable("proficiencyMatrix", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  topic: varchar("topic", { length: 128 }).notNull(), // e.g. "Moving Averages"
  level: int("level").default(1).notNull(), // 1-10
  updateLog: text("updateLog"), // JSON array of {videoTitle, insight, levelBefore, levelAfter, date}
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ProficiencyRow = typeof proficiencyMatrix.$inferSelect;
export type InsertProficiencyRow = typeof proficiencyMatrix.$inferInsert;

// Bulk analysis sessions — groups multiple analyses together
export const bulkSessions = mysqlTable("bulkSessions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  totalCount: int("totalCount").notNull(), // how many URLs were submitted
  doneCount: int("doneCount").default(0).notNull(),
  errorCount: int("errorCount").default(0).notNull(),
  status: mysqlEnum("status", ["pending", "processing", "done"]).default("pending").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type BulkSession = typeof bulkSessions.$inferSelect;
export type InsertBulkSession = typeof bulkSessions.$inferInsert;

// Master Knowledge JSON — single source of truth per user
export const masterKnowledge = mysqlTable("masterKnowledge", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(), // one master JSON per user
  technicalRules: text("technicalRules"), // JSON: { [topic]: { rule, example, level } }
  activeSignals: text("activeSignals"),   // JSON: [{ ticker, company, entry, stopLoss, takeProfit, catalyst, status }]
  learningStatus: text("learningStatus"), // JSON: { [topic]: { level, lastInsight } }
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type MasterKnowledge = typeof masterKnowledge.$inferSelect;
export type InsertMasterKnowledge = typeof masterKnowledge.$inferInsert;

// User Settings — TradingView connectivity + simulation parameters
export const userSettings = mysqlTable("userSettings", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(),
  tradingviewWebhookUrl: text("tradingviewWebhookUrl"),
  tradingviewApiKey: text("tradingviewApiKey"),
  platform: varchar("platform", { length: 64 }).default("tradingview").notNull(),
  startingBalance: int("startingBalance").default(10000).notNull(),
  riskPerTrade: int("riskPerTrade").default(2).notNull(),
  stopLossBuffer: int("stopLossBuffer").default(0).notNull(),
  telegramChatId: varchar("telegramChatId", { length: 64 }),
  telegramEnabled: tinyint("telegramEnabled").default(1).notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type UserSettings = typeof userSettings.$inferSelect;
export type InsertUserSettings = typeof userSettings.$inferInsert;

// Trade Positions — saved trade setups with user overrides
export const tradePositions = mysqlTable("tradePositions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  company: text("company"),
  // AI-generated suggestions (based on live price at scan time)
  aiEntry: text("aiEntry"),
  aiStopLoss: text("aiStopLoss"),
  aiTakeProfit: text("aiTakeProfit"),
  aiLogic: text("aiLogic"),           // strategy badge label
  aiLogicDetail: text("aiLogicDetail"), // full explanation
  aiConfidence: varchar("aiConfidence", { length: 16 }),
  // User overrides (editable)
  userEntry: text("userEntry"),
  userStopLoss: text("userStopLoss"),
  userTakeProfit: text("userTakeProfit"),
  userNotes: text("userNotes"),
  // Partial Take-Profit tracking (Ziv strategy)
  target1Price: text("target1Price"),            // user-defined Target 1 level
  realizedProfit: text("realizedProfit"),        // profit locked in from 50% sold
  remainingExposure: text("remainingExposure"),  // remaining 50% capital at risk
  // Status
  status: mysqlEnum("status", ["watching", "active", "closed"]).default("watching").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type TradePosition = typeof tradePositions.$inferSelect;
export type InsertTradePosition = typeof tradePositions.$inferInsert;

// Channel Videos — cached video list from YouTube channels (multi-mentor)
export const channelVideos = mysqlTable("channelVideos", {
  id: int("id").autoincrement().primaryKey(),
  videoId: varchar("videoId", { length: 32 }).notNull().unique(), // YouTube video ID
  mentor: mysqlEnum("mentor", ["cycles_trading", "micha_stocks"]).default("cycles_trading").notNull(),
  title: text("title").notNull(),
  uploadDate: timestamp("uploadDate").notNull(), // parsed from publishedTimeText
  thumbnailUrl: text("thumbnailUrl"),
  duration: int("duration").default(0), // seconds
  viewCount: int("viewCount").default(0),
  isNew: int("isNew").default(0).notNull(), // 1 = discovered in last sync
  analysisId: int("analysisId"), // FK to analyses.id if analyzed
  analyzedAt: timestamp("analyzedAt"), // when it was analyzed
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ChannelVideo = typeof channelVideos.$inferSelect;
export type InsertChannelVideo = typeof channelVideos.$inferInsert;

// Trading Lab — simulation sessions
export const labSimulations = mysqlTable("labSimulations", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  name: varchar("name", { length: 128 }).default("Simulation").notNull(),
  tickers: text("tickers").notNull(),          // JSON: string[]
  startDate: timestamp("startDate").notNull(),
  endDate: timestamp("endDate").notNull(),
  capitalPerTrade: int("capitalPerTrade").default(10000).notNull(),
  tickerCapitals: text("tickerCapitals"),        // JSON: {ticker: initialCapital} per-ticker wallet
  status: mysqlEnum("status", ["pending", "scanning", "running", "done", "error"]).default("pending").notNull(),
  scanReport: mediumtext("scanReport"),         // JSON: pre-trade AI report per ticker (can exceed 65KB with 30 tickers)
  equityCurve: text("equityCurve"),            // JSON: [{date, equity}]
  totalROI: text("totalROI"),                  // e.g. "23.5"
  totalProfit: text("totalProfit"),            // e.g. "4700"
  finalWallet: text("finalWallet"),            // e.g. "249579" — total portfolio value at end (cash + unrealized)
  monkeyValue: text("monkeyValue"),            // e.g. "132711" — buy-and-hold baseline for total capital
  profitMissed: text("profitMissed"),          // e.g. "1564" — total $ missed from early exits (UI badge value)
  simVersion: varchar("simVersion", { length: 32 }),  // e.g. "2026-03-06.10.001" — auto-incremented per day
  systemCodeVersion: varchar("systemCodeVersion", { length: 16 }), // e.g. "v1.050" — engine version at time of run
  errorMessage: text("errorMessage"),
  benchmarkData: text("benchmarkData"),        // JSON: {ticker, startPrice, endPrice, buyHoldRoi, strategyRoi, alpha}[]
  lessonsLearned: text("lessonsLearned"),       // JSON: {ticker, note, severity: 'critical'|'warning'|'ok'}[]
  minZivScore: int("minZivScore").default(4),    // v1.145: dynamic entry gate — tickers with Ziv score < this are blocked from new entries
  targetAlphaMonthly: int("targetAlphaMonthly").default(15),  // v1.147: Target Alpha Engine — monthly alpha gap target (%) above monkey. Safe Haven mode when met, Alpha Attack when below.
  partialLockGainThreshold: int("partialLockGainThreshold").default(50), // v1.147: Partial Profit Lock — unrealized gain % that triggers partial sell (40% of position locked)
  riskLevel: int("riskLevel").default(5),  // v1.175: Risk Level 1-10 (1=ultra-conservative, 5=balanced, 10=aggressive)
  maxSinglePositionPct: int("maxSinglePositionPct").default(20),  // v1.180: Max single position % of total capital (default 20%)
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type LabSimulation = typeof labSimulations.$inferSelect;
export type InsertLabSimulation = typeof labSimulations.$inferInsert;

// Trading Lab — individual simulated trades
export const labTrades = mysqlTable("labTrades", {
  id: int("id").autoincrement().primaryKey(),
  simulationId: int("simulationId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  entryDate: timestamp("entryDate"),
  exitDate: timestamp("exitDate"),
  entryPrice: text("entryPrice"),
  exitPrice: text("exitPrice"),
  stopLoss: text("stopLoss"),
  takeProfit: text("takeProfit"),
  capitalUsed: int("capitalUsed").default(10000).notNull(),
  startingBalance: text("startingBalance"),       // wallet balance before this trade
  endingBalance: text("endingBalance"),           // wallet balance after this trade (startingBalance + P&L)
  profitLoss: text("profitLoss"),              // dollar P&L
  roiPct: text("roiPct"),                      // percentage
  outcome: mysqlEnum("outcome", ["win", "loss", "open", "skipped"]).default("open").notNull(),
  exitReason: varchar("exitReason", { length: 32 }),  // "tp", "sl", "end_of_period"
  entryReasoning: text("entryReasoning"),          // narrative: setup type, RSI, EMA50 dist, rule triggered
  exitReasoning: text("exitReasoning"),            // narrative: exit trigger, rule name, price vs EMA levels
  // Partial Take-Profit (Ziv strategy)
  target1Price: text("target1Price"),            // Target 1 price level (first resistance)
  partialTpHit: tinyint("partialTpHit").default(0).notNull(), // 1 if 50% was sold at Target 1
  partialTpDate: timestamp("partialTpDate"),     // date 50% was sold
  realizedProfit: text("realizedProfit"),        // P&L from the 50% sold at Target 1
  remainingExposure: text("remainingExposure"),  // capital still in the trade (50%)
  runnersRoi: text("runnersRoi"),                // final ROI using Ziv trailing stop on runners
  target1Roi: text("target1Roi"),                // ROI if 100% sold at Target 1
  // Benchmark & direction fields
  direction: mysqlEnum("direction", ["long", "short"]).default("long").notNull(),
  buyHoldRoi: text("buyHoldRoi"),                // Buy & Hold ROI for this ticker over the simulation period
  alpha: text("alpha"),                          // AI_ROI - BuyHold_ROI (strategy edge)
  opportunityCost: text("opportunityCost"),      // Profit missed by exiting early (max possible - actual)
  // UTP v4.1 Pillar 7: Systemic Failure Audit
  tightExitError: tinyint("tightExitError").default(0).notNull(), // 1 if price was 5%+ higher 10 days after exit
  price10DaysAfterExit: text("price10DaysAfterExit"),             // closing price 10 trading days after exit
  opportunityGap: text("opportunityGap"),                        // % gain missed in 10-day window post-exit
  stopLossAdjustment: text("stopLossAdjustment"),                // +2% SL widening applied to next trade for this ticker
  // v1.071: formation type for filtering parking lot trades from opportunity cost
  zivFormation: varchar("zivFormation", { length: 32 }),           // "breakout"|"pullback"|"parking_lot"|"slow_grind"|etc.
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  simIdIdx: index("labTrades_simulationId_idx").on(t.simulationId),
  tickerIdx: index("labTrades_ticker_idx").on(t.ticker),
}));

export type LabTrade = typeof labTrades.$inferSelect;
export type InsertLabTrade = typeof labTrades.$inferInsert;

// Trading Lab — daily activity log (one row per action per virtual trading day)
// v1.108: Added indexes on simulationId and date for fast log queries
export const labDailyLogs = mysqlTable("labDailyLogs", {
  id: int("id").autoincrement().primaryKey(),
  simulationId: int("simulationId").notNull(),
  date: varchar("date", { length: 16 }).notNull(),          // YYYY-MM-DD virtual date
  ticker: varchar("ticker", { length: 16 }).notNull(),
  action: varchar("action", { length: 64 }).notNull(),       // ENTERED_LONG, ENTERED_SHORT, MOVED_SL_BREAKEVEN, TRAILING_STOP, EARLY_EXIT, CLOSED_TP, CLOSED_SL, CLOSED_EOD, SKIPPED
  detail: text("detail"),                                    // human-readable description
  totalWallet: text("totalWallet"),                          // ticker wallet at this point (initial + realized + unrealized P&L)
  runningRoi: text("runningRoi"),                            // cumulative ROI% from start of simulation
  // v1.032: Monkey Value & Strategy Alpha (reality-check metrics)
  monkeyValue: text("monkeyValue"),                          // (initialCapital / Day1Price) * currentPrice — buy & hold benchmark
  strategyAlpha: text("strategyAlpha"),                      // ((totalWallet / monkeyValue) - 1) * 100 — how much we beat/lag the monkey
  profitMissed: text("profitMissed"),                        // cumulative $ missed from tight exits (Pillar 7 Systemic Failure Audit)
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  simIdIdx: index("labDailyLogs_simulationId_idx").on(t.simulationId),
  dateIdx: index("labDailyLogs_date_idx").on(t.date),
}));
export type LabDailyLog = typeof labDailyLogs.$inferSelect;
export type InsertLabDailyLog = typeof labDailyLogs.$inferInsert;

// User Asset List — persists the user's custom Asset List (catalogue) per user
export const userAssets = mysqlTable("userAssets", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  exchange: varchar("exchange", { length: 8 }).default("US").notNull(), // 'US' | 'TASE' | 'CRYPTO'
  companyName: varchar("companyName", { length: 128 }).notNull(),
  sector: varchar("sector", { length: 64 }).notNull(),
  score: double("score"),  // Changed from int to double to preserve decimal precision (e.g. 8.26 not 8)
  label: varchar("label", { length: 64 }),
  dailyChangePercent: double("dailyChangePercent"),
  sortOrder: int("sortOrder").default(0).notNull(),
  // Scan result columns (populated by analyzeAssetList)
  cmp: double("cmp"),
  ema50: double("ema50"),
  ema200: double("ema200"),
  proximityToEma50Pct: double("proximityToEma50Pct"),
  recommendation: varchar("recommendation", { length: 16 }),
  reason: text("reason"),
  tier: varchar("tier", { length: 32 }),
  weeklyEma50Slope: double("weeklyEma50Slope"),
  donchian20High: double("donchian20High"),
  priceAction: varchar("priceAction", { length: 32 }),
  recommendedBuyPrice: double("recommendedBuyPrice"),
  recommendedStopLoss: double("recommendedStopLoss"),
  hotSignal: tinyint("hotSignal").default(0), // 1 = all Ziv entry conditions met
  scannedAt: timestamp("scannedAt"),
  archived: tinyint("archived").default(0).notNull(), // 1 = archived
  archivedAt: timestamp("archivedAt"),
  lastSignalSentAt: timestamp("lastSignalSentAt"), // when the last BUY signal was sent for this ticker (anti-spam)
  profitPotential: double("profitPotential"),  // % upside potential (user-entered)
  note: text("note"),                          // free-text monthly note (user-entered)
  // Kronos forecast bias (catalogue display/rank only — Elsa entry uses raw Ziv score)
  kronosBias: double("kronosBias"),            // -2.0 to +2.0 adjustment
  kronosDirection: varchar("kronosDirection", { length: 8 }), // UP | DOWN | FLAT
  kronosBandPct: double("kronosBandPct"),      // 95% band width as % of price
  kronosPredPct: double("kronosPredPct"),      // mean predicted % change
  kronosScannedAt: timestamp("kronosScannedAt"),
  /** IPO_INCUBATOR | DATA_BLIP_BYPASS | null — Elza / kinetic gates */
  catalogStatus: varchar("catalogStatus", { length: 32 }),
  /** Rank-percentile kinetic score (0–100); null for non-scorable statuses */
  kineticScore: double("kineticScore"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("userAssets_userId_idx").on(t.userId),
  userArchivedIdx: index("userAssets_userId_archived_idx").on(t.userId, t.archived),
}));

export type UserAsset = typeof userAssets.$inferSelect;
export type InsertUserAsset = typeof userAssets.$inferInsert;

// v1.069 Turbo Cache: pre-downloaded OHLCV price data for simulation tickers
// Unique index on (ticker, date) ensures no duplicate bars.
// fetchedAt tracks when the row was last refreshed from Yahoo Finance.
export const priceCache = mysqlTable("priceCache", {
  id: int("id").autoincrement().primaryKey(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  date: varchar("date", { length: 16 }).notNull(),       // YYYY-MM-DD
  open: double("open").notNull(),
  high: double("high").notNull(),
  low: double("low").notNull(),
  close: double("close").notNull(),
  volume: bigint("volume", { mode: "number" }).default(0).notNull(),
  fetchedAt: timestamp("fetchedAt").defaultNow().notNull(),
}, (t) => ({
  tickerDateIdx: uniqueIndex("priceCache_ticker_date_idx").on(t.ticker, t.date),
}));
export type PriceCache = typeof priceCache.$inferSelect;
export type InsertPriceCache = typeof priceCache.$inferInsert;

// Link analyses to a bulk session
export const bulkSessionAnalyses = mysqlTable("bulkSessionAnalyses", {
  id: int("id").autoincrement().primaryKey(),
  bulkSessionId: int("bulkSessionId").notNull(),
  analysisId: int("analysisId").notNull(),
  position: int("position").notNull(), // order in the bulk list (0-indexed)
  signalDate:    timestamp("signalDate"),                             // date of mentor video
  signalExpiry:  timestamp("signalExpiry"),                           // auto-archive after this date
  mentorSources: varchar("mentorSources", { length: 64 }),
  mentorConfidence: tinyint("mentorConfidence"),      // Phase 1: LLM confidence 1-5
  signalBias: mysqlEnum("signalBias", ["LONG", "SHORT", "WATCH", "REJECTED"]), // Phase 1: Hebrew Slang Guard            // "ziv" | "micha" | "ziv+micha"
});
// v1.072 Smart Multi-Asset Parking Lot: per-user configurable ETF basket
// Default basket: QQQ(20%), SMH(20%), RSP(15%), SCHD(15%), GLD(10%), XLU(10%), BIL(10%), XLV(5%), TLT(5%), IWM(5%)
// Each row = one ETF slot in the parking lot basket for a given user.
export const parkingLotConfig = mysqlTable("parkingLotConfig", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  weight: double("weight").notNull(),       // allocation weight 0-100 (percentage)
  enabled: tinyint("enabled").default(1).notNull(), // 1=active, 0=disabled
  sortOrder: int("sortOrder").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type ParkingLotConfig = typeof parkingLotConfig.$inferSelect;
export type InsertParkingLotConfig = typeof parkingLotConfig.$inferInsert;

// v1.108 LLM Scan Cache: cache AI scan results by (ticker, dateKey, priceSnapshot)
// Prevents re-calling the LLM for the same ticker+date+price combination across simulation runs.
// Cache key = ticker + YYYY-MM-DD + price rounded to nearest $0.50
export const llmScanCache = mysqlTable("llmScanCache", {
  id: int("id").autoincrement().primaryKey(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  dateKey: varchar("dateKey", { length: 16 }).notNull(),     // YYYY-MM-DD
  priceKey: varchar("priceKey", { length: 16 }).notNull(),   // price rounded to nearest $0.50 as string
  result: text("result").notNull(),                          // JSON: ScanResult
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  cacheKeyIdx: uniqueIndex("llmScanCache_key_idx").on(t.ticker, t.dateKey, t.priceKey),
}));
export type LlmScanCache = typeof llmScanCache.$inferSelect;
export type InsertLlmScanCache = typeof llmScanCache.$inferInsert;

// v13.50 Deep Analysis Cache: cache LLM result for deep analysis by (ticker, cacheKey)
// cacheKey = YYYY-MM-DD + holdingContext hash (changes when holding P&L changes significantly)
// TTL: 4 hours — serve stale immediately, refresh in background
export const deepAnalysisCache = mysqlTable("deepAnalysisCache", {
  id: int("id").autoincrement().primaryKey(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  cacheKey: varchar("cacheKey", { length: 64 }).notNull(),  // YYYY-MM-DD:holdingHash
  result: text("result").notNull(),                         // Full JSON response
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  deepAnalysisCacheKeyIdx: uniqueIndex("deepAnalysisCache_key_idx").on(t.ticker, t.cacheKey),
}));
export type DeepAnalysisCache = typeof deepAnalysisCache.$inferSelect;
export type InsertDeepAnalysisCache = typeof deepAnalysisCache.$inferInsert;

// ─── Real Portfolio Management ────────────────────────────────────────────────
// portfolioAccounts: one account per user (total capital, cash balance)
export const portfolioAccounts = mysqlTable("portfolioAccounts", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(),
  totalCapital: double("totalCapital").default(0).notNull(),   // total deposited capital (ever)
  cashBalance: double("cashBalance").default(0).notNull(),     // uninvested cash
  currency: varchar("currency", { length: 8 }).default("USD").notNull(),
  // Last known IBKR values — persisted so they survive offline periods
  lastKnownNLV: double("lastKnownNLV"),                    // Gross Position Value (שווי תיק) from IBKR
  lastKnownNetLiquidation: double("lastKnownNetLiquidation"), // Net Liquidation Value (after margin/loans) from IBKR
  lastKnownCash: double("lastKnownCash"),                    // totalcashvalue from IBKR
  lastKnownTodayPnl: double("lastKnownTodayPnl"),            // dailypnl from IBKR
  lastKnownNLVAt: timestamp("lastKnownNLVAt"),               // when these values were last fetched
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type PortfolioAccount = typeof portfolioAccounts.$inferSelect;
export type InsertPortfolioAccount = typeof portfolioAccounts.$inferInsert;

// ibkrConnectionLog: persisted connection log entries (last 100, per user)
export const ibkrConnectionLog = mysqlTable("ibkrConnectionLog", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  message: text("message").notNull(),
  type: varchar("type", { length: 16 }).notNull().default("info"), // info | success | error | warn
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("ibkrConnectionLog_userId_idx").on(t.userId),
}));
export type IbkrConnectionLogEntry = typeof ibkrConnectionLog.$inferSelect;

// portfolioHoldings: one row per open position (ticker, buy price, units)
export const portfolioHoldings = mysqlTable("portfolioHoldings", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  company: text("company"),
  buyPrice: double("buyPrice").notNull(),          // average cost basis per unit
  units: double("units").notNull(),                // number of shares/units held
  // Live data (refreshed on page load)
  currentPrice: double("currentPrice"),            // last fetched market price
  dailyChangePercent: double("dailyChangePercent"), // today's % change (from Yahoo Finance)
  priceUpdatedAt: timestamp("priceUpdatedAt"),     // when currentPrice was last fetched
  // Transaction date (when the user actually bought the asset)
  transactionDate: date("transactionDate"),
  // Ziv Score (1.00-10.00) from last Analyze Holdings run — decimal precision
  zivScore: double("zivScore"),
  // Lab-parity trading fields (computed by Ziv Engine)
  stopLoss: double("stopLoss"),           // SL price: max(8% below entry, EMA-50)
  takeProfit: double("takeProfit"),        // TP price: entry + 2.5 * (entry - SL)
  positionSizePct: double("positionSizePct"), // % of total portfolio for this position
  peakPrice: double("peakPrice"),          // highest price since entry (for Winner's Leash)
  entryTier: varchar("entryTier", { length: 32 }), // Ziv Engine tier at entry
  buyScore: double("buyScore"),              // Ziv Score at time of purchase (for delta tracking)
  // Notes
  notes: text("notes"),
  // IBKR live P&L — saved on every sync from IBKR positions
  ibkrUnrealizedPnl: double("ibkrUnrealizedPnl"),   // unrealized P&L from IBKR (today's change for open positions)
  // IBKR contract ID — populated on Sync Now from IBKR positions
  conid: int("conid"),                              // IBKR Contract ID (required for order placement)
  // IBKR order tracking — orderId saved when SL/TP order is placed via IBKR
  ibkrSlOrderId: varchar("ibkrSlOrderId", { length: 32 }),   // IBKR orderId for active SL order
  
  ibkrTpOrderId: varchar("ibkrTpOrderId", { length: 32 }),   // IBKR orderId for active TP order
  ibkrSlOrderQty: double("ibkrSlOrderQty"),                  // qty when SL order was placed
  ibkrTpOrderQty: double("ibkrTpOrderQty"),                  // qty when TP order was placed
  
  // Dynamic SL/TP mode tracking (set by getZivHScores every 5 min during NYSE hours)
  slMode: varchar("slMode", { length: 32 }),  // "Trailing" | "Static" | "Winners"
  tpMode: varchar("tpMode", { length: 32 }),  // "Escape" | "Extension" | "Static"
  // Daily baseline price — set at 23:30 Israel time each day for accurate "Today" P&L
  dailyBasePrice: double("dailyBasePrice"),   // price at 23:30 Israel (our official close)
  dailyBaseTs: bigint("dailyBaseTs", { mode: "number" }), // unix ms when dailyBasePrice was set
  source:      varchar("source", { length: 32 }).default("manual"), // manual | elza
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  userTickerIdx: uniqueIndex("portfolioHoldings_userId_ticker_idx").on(t.userId, t.ticker),
}));
export type PortfolioHolding = typeof portfolioHoldings.$inferSelect;
export type InsertPortfolioHolding = typeof portfolioHoldings.$inferInsert;

// capitalEvents: log of deposits, withdrawals, and AI-suggested sell orders
export const capitalEvents = mysqlTable("capitalEvents", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  type: mysqlEnum("type", ["deposit", "withdrawal", "buy", "sell"]).notNull(),
  amount: double("amount").notNull(),              // positive for deposit/buy, negative for withdrawal/sell
  ticker: varchar("ticker", { length: 16 }),       // set for buy/sell events
  units: double("units"),                          // shares bought/sold
  pricePerUnit: double("pricePerUnit"),            // execution price
  notes: text("notes"),                            // e.g. "AI recommended sell for withdrawal"
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type CapitalEvent = typeof capitalEvents.$inferSelect;
export type InsertCapitalEvent = typeof capitalEvents.$inferInsert;

// portfolioAnalysis: cached AI analysis results for the real portfolio
export const portfolioAnalysis = mysqlTable("portfolioAnalysis", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  result: text("result").notNull(),               // JSON: full AI analysis output
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type PortfolioAnalysis = typeof portfolioAnalysis.$inferSelect;
export type InsertPortfolioAnalysis = typeof portfolioAnalysis.$inferInsert;

// ibkrSettings: per-user IBKR Client Portal Gateway configuration
export const ibkrSettings = mysqlTable("ibkrSettings", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(),
  gatewayUrl: varchar("gatewayUrl", { length: 255 }).notNull().default("https://localhost:5000"),
  accountId: varchar("accountId", { length: 32 }),   // e.g. DU1234567 (paper) or U1234567 (live)
  accountType: mysqlEnum("accountType", ["paper", "live"]).default("paper"),
  sessionCookie: text("sessionCookie"),  // manually pasted IBKR session cookie for hosted gateways
  lastConnectedAt: timestamp("lastConnectedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type IbkrSettings = typeof ibkrSettings.$inferSelect;
export type InsertIbkrSettings = typeof ibkrSettings.$inferInsert;

// tvAlerts: incoming TradingView webhook alerts log
export const tvAlerts = mysqlTable("tvAlerts", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  ticker: varchar("ticker", { length: 32 }).notNull(),
  action: varchar("action", { length: 16 }).notNull(),   // BUY | SELL | ALERT
  price: double("price"),
  qty: double("qty"),
  strategy: varchar("strategy", { length: 128 }),
  rawPayload: text("rawPayload"),                         // full JSON from TradingView
  status: mysqlEnum("status", ["received", "forwarded_ibkr", "ibkr_ok", "ibkr_error", "ignored"]).default("received").notNull(),
  ibkrOrderId: varchar("ibkrOrderId", { length: 64 }),   // set if forwarded to IBKR
  ibkrError: text("ibkrError"),                           // set if IBKR rejected
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type TvAlert = typeof tvAlerts.$inferSelect;
export type InsertTvAlert = typeof tvAlerts.$inferInsert;

// tradingDiary: per-user trade journal — auto-filled when a stock is added to Holdings
export const tradingDiary = mysqlTable("tradingDiary", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  company: text("company"),
  units: double("units").notNull(),
  buyPrice: double("buyPrice").notNull(),
  stopLoss: double("stopLoss"),
  takeProfit: double("takeProfit"),
  reason: text("reason"),          // AI-generated: why we bought
  expectations: text("expectations"), // AI-generated: what we expect
  // Closure fields — filled when position is fully sold
  closePrice: double("closePrice"),   // average exit price
  closedAt: timestamp("closedAt"),    // when position was closed
  pnlUsd: double("pnlUsd"),          // realized P&L in USD
  pnlPct: double("pnlPct"),          // realized P&L in %
  postMortem: text("postMortem"),     // AI/user summary: what happened, mistakes, lessons
  status: mysqlEnum("diaryStatus", ["open", "closed"]).default("open").notNull(),
  addedAt: timestamp("addedAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  userIdx: index("tradingDiary_userId_idx").on(t.userId),
}));
export type TradingDiaryEntry = typeof tradingDiary.$inferSelect;
export type InsertTradingDiaryEntry = typeof tradingDiary.$inferInsert;

// priceAlerts: per-user price alert rules for SL/TP notifications
export const priceAlerts = mysqlTable("priceAlerts", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  alertType: mysqlEnum("alertType", ["sl", "tp", "custom"]).notNull(), // sl=stop-loss, tp=take-profit, custom=user-defined
  targetPrice: double("targetPrice").notNull(),
  direction: mysqlEnum("direction", ["below", "above"]).notNull(), // trigger when price goes below/above target
  label: varchar("label", { length: 64 }),  // e.g. "Stop Loss", "Take Profit", "Custom Alert"
  triggered: tinyint("triggered").default(0).notNull(), // 1 = already fired
  triggeredAt: timestamp("triggeredAt"),
  triggeredPrice: double("triggeredPrice"),
  dismissed: tinyint("dismissed").default(0).notNull(), // 1 = user dismissed notification
  zivScore: double("zivScore"),                           // Ziv Engine score at time of trigger (null = not evaluated)
  archivedAt: timestamp("archivedAt"),                    // set when alert is moved to archive (stale >48h or score <8)
  lastAlertSentAt: timestamp("lastAlertSentAt"),            // anti-spam: last time Telegram was sent for this alert (24h dedup)
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  userTickerIdx: index("priceAlerts_userId_ticker_idx").on(t.userId, t.ticker),
  triggeredDismissedIdx: index("priceAlerts_triggered_dismissed_idx").on(t.triggered, t.dismissed),
  userTriggeredDismissedIdx: index("priceAlerts_userId_triggered_dismissed_idx").on(t.userId, t.triggered, t.dismissed),
}));
export type PriceAlert = typeof priceAlerts.$inferSelect;
export type InsertPriceAlert = typeof priceAlerts.$inferInsert;

// portfolioSnapshots: daily portfolio value snapshots for performance chart
export const portfolioSnapshots = mysqlTable("portfolioSnapshots", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  snapshotDate: varchar("snapshotDate", { length: 16 }).notNull(), // YYYY-MM-DD
  portfolioType: varchar("portfolioType", { length: 16 }).notNull().default("h1"), // h1 | h2-tase | h2-usa | h2-crypto
  totalValue: double("totalValue").notNull(),    // total portfolio value (invested + cash)
  investedValue: double("investedValue").notNull(), // sum of (currentPrice * units) for all holdings
  cashBalance: double("cashBalance").notNull(),  // uninvested cash
  totalCost: double("totalCost").notNull(),      // sum of (buyPrice * units) — cost basis
  pnlUsd: double("pnlUsd").notNull(),           // totalValue - totalCost
  pnlPct: double("pnlPct").notNull(),           // pnlUsd / totalCost * 100
  totalEquity: double("totalEquity"),            // IBKR Net Liquidation Value (Real Balance) — primary chart metric
  unrealizedPnL: double("unrealizedPnL"),        // IBKR unrealized P&L from account summary
  h2Value: double("h2Value"),                     // H2 portfolio total value (manual holdings)
  holdingsSnapshot: text("holdingsSnapshot"),   // JSON: [{ticker, buyPrice, units, currentPrice, pnl}]
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  userDatePortfolioIdx: uniqueIndex("portfolioSnapshots_userId_date_portfolio_idx").on(t.userId, t.snapshotDate, t.portfolioType),
}));
export type PortfolioSnapshot = typeof portfolioSnapshots.$inferSelect;
export type InsertPortfolioSnapshot = typeof portfolioSnapshots.$inferInsert;

// tvWebhookSettings: per-user TradingView webhook config
export const tvWebhookSettings = mysqlTable("tvWebhookSettings", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(),
  webhookSecret: varchar("webhookSecret", { length: 64 }).notNull(),  // random token
  autoTradeEnabled: boolean("autoTradeEnabled").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type TvWebhookSettings = typeof tvWebhookSettings.$inferSelect;
export type InsertTvWebhookSettings = typeof tvWebhookSettings.$inferInsert;

// OTP codes for Telegram 2FA login
export const otpCodes = mysqlTable("otpCodes", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull(),         // user openId from OAuth
  code: varchar("code", { length: 8 }).notNull(),               // 6-digit OTP
  pendingToken: varchar("pendingToken", { length: 128 }).notNull().unique(), // temp token in cookie
  expiresAt: timestamp("expiresAt").notNull(),
  used: tinyint("used").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type OtpCode = typeof otpCodes.$inferSelect;
export type InsertOtpCode = typeof otpCodes.$inferInsert;

// watchlistDismissed: tickers the user has dismissed from the Ziv watchlist
export const watchlistDismissed = mysqlTable("watchlistDismissed", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  dismissedAt: timestamp("dismissedAt").defaultNow().notNull(),
}, (t) => ({
  userTickerIdx: uniqueIndex("watchlistDismissed_userId_ticker_idx").on(t.userId, t.ticker),
}));
export type WatchlistDismissed = typeof watchlistDismissed.$inferSelect;
export type InsertWatchlistDismissed = typeof watchlistDismissed.$inferInsert;

// snoozedTickers: 12h Snooze/Ignore for War Room candidates (BUG #2).
// snoozedUntil is unix-epoch MILLISECONDS; an active snooze is `snoozedUntil > Date.now()`.
// Snooze gates ENTRY + candidate VISIBILITY only — it NEVER disables exit management on a held position.
export const snoozedTickers = mysqlTable("snoozedTickers", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  snoozedUntil: bigint("snoozedUntil", { mode: "number" }).notNull(),
  reason: varchar("reason", { length: 255 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  userTickerIdx: uniqueIndex("snoozedTickers_userId_ticker_idx").on(t.userId, t.ticker),
}));
export type SnoozedTicker = typeof snoozedTickers.$inferSelect;
export type InsertSnoozedTicker = typeof snoozedTickers.$inferInsert;

// systemSettings: global server-side key-value store for persistent flags (e.g. isPushPaused)
export const systemSettings = mysqlTable("systemSettings", {
  id: int("id").autoincrement().primaryKey(),
  key: varchar("key", { length: 128 }).notNull().unique(),
  value: text("value").notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type SystemSetting = typeof systemSettings.$inferSelect;
export type InsertSystemSetting = typeof systemSettings.$inferInsert;

// portfolioChatMessages: persisted AI Portfolio Chat messages per user (global portfolio chat)
export const portfolioChatMessages = mysqlTable("portfolioChatMessages", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  role: mysqlEnum("role", ["user", "assistant"]).notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("portfolioChat_userId_idx").on(t.userId),
}));
export type PortfolioChatMessage = typeof portfolioChatMessages.$inferSelect;
export type InsertPortfolioChatMessage = typeof portfolioChatMessages.$inferInsert;

// journalEvents: auto-logged events for the trading journal (buy/sell/order/sync)
export const journalEvents = mysqlTable("journalEvents", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  eventType: mysqlEnum("eventType", ["buy", "sell", "sl_order", "tp_order", "bracket_order", "sync", "price_alert", "note"]).notNull(),
  ticker: varchar("ticker", { length: 16 }),
  company: text("company"),
  units: double("units"),
  price: double("price"),
  stopLoss: double("stopLoss"),
  takeProfit: double("takeProfit"),
  orderId: varchar("orderId", { length: 64 }),  // IBKR order ID if applicable
  notes: text("notes"),                          // free-text notes or AI reason
  metadata: text("metadata"),                    // JSON: any extra fields
  eventAt: timestamp("eventAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("journalEvents_userId_idx").on(t.userId),
  userTickerIdx: index("journalEvents_userId_ticker_idx").on(t.userId, t.ticker),
}));
export type JournalEvent = typeof journalEvents.$inferSelect;
export type InsertJournalEvent = typeof journalEvents.$inferInsert;

// engineChatHistory: persisted chat messages per user+ticker for Trading Engine Chat
export const engineChatHistory = mysqlTable("engineChatHistory", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  role: varchar("role", { length: 16 }).notNull(), // "engine" | "user"
  text: text("text").notNull(),
  updatedSL: varchar("updatedSL", { length: 32 }),  // if engine updated SL in this message
  updatedTP: varchar("updatedTP", { length: 32 }),  // if engine updated TP in this message
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  userTickerIdx: index("engineChat_userId_ticker_idx").on(t.userId, t.ticker),
}));
export type EngineChatHistory = typeof engineChatHistory.$inferSelect;
export type InsertEngineChatHistory = typeof engineChatHistory.$inferInsert;

// ─── Holding 2: Second Manual Portfolio ─────────────────────────────────────
// A separate manual portfolio (no IBKR sync). User enters ticker, units, buy price.
// Live price is fetched from Yahoo Finance for P&L calculation.
export const holding2 = mysqlTable("holding2", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  company: text("company"),
  buyPrice: double("buyPrice").notNull(),          // average cost basis per unit
  units: double("units").notNull(),                // number of shares held
  // Live data (refreshed on page load)
  currentPrice: double("currentPrice"),
  prevClose: double("prevClose"),              // previous session close (USD) — for Today P&L
  dailyChangePercent: double("dailyChangePercent"),
  priceUpdatedAt: timestamp("priceUpdatedAt"),
  // Ziv Engine score (cached)
  zivScore: double("zivScore"),
  // Dynamic SL/TP (updated by ZIV H engine during trading hours)
  stopLoss: double("stopLoss"),
  takeProfit: double("takeProfit"),
  // Dynamic SL/TP mode tracking
  slMode: varchar("slMode", { length: 32 }),  // "Trailing" | "Static" | "Winners"
  tpMode: varchar("tpMode", { length: 32 }),  // "Escape" | "Extension" | "Static"
  // Daily baseline price — set at 23:30 Israel time each day for accurate "Today" P&L
  dailyBasePrice: double("dailyBasePrice"),   // price at 23:30 Israel (our official close)
  dailyBaseTs: bigint("dailyBaseTs", { mode: "number" }), // unix ms when dailyBasePrice was set
  // Optional notes
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  userTickerIdx: index("holding2_userId_ticker_idx").on(t.userId, t.ticker),
}));
export type Holding2 = typeof holding2.$inferSelect;
export type InsertHolding2 = typeof holding2.$inferInsert;

// ─── Local Users: email/password accounts (non-Manus OAuth) ─────────────────
// Admin creates these users manually from the Settings page.
// Each local user has their own isolated Holdings (portfolioHoldings, holding2).
// All other data (analyses, watchlist, master knowledge) is shared/read-only.
export const localUsers = mysqlTable("localUsers", {
  id: int("id").autoincrement().primaryKey(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  passwordHash: varchar("passwordHash", { length: 128 }).notNull(),
  name: varchar("name", { length: 128 }).notNull(),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  // The linked users.id row (created automatically on first local login)
  linkedUserId: int("linkedUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn"),
  telegramChatId: varchar("telegramChatId", { length: 64 }),
});

export type LocalUser = typeof localUsers.$inferSelect;
export type InsertLocalUser = typeof localUsers.$inferInsert;

// ─── Telegram Group Monitor ───────────────────────────────────────────────────
// Admin can add public Telegram group handles to monitor.
// The bot polls these groups and classifies messages via LLM.
export const telegramMonitorGroups = mysqlTable("telegramMonitorGroups", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  groupHandle: varchar("groupHandle", { length: 128 }).notNull(), // e.g. @gotliveir
  displayName: varchar("displayName", { length: 128 }),
  isActive: boolean("isActive").default(true).notNull(),
  lastCheckedAt: bigint("lastCheckedAt", { mode: "number" }),
  lastMessageId: bigint("lastMessageId", { mode: "number" }),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
});

export type TelegramMonitorGroup = typeof telegramMonitorGroups.$inferSelect;
export type InsertTelegramMonitorGroup = typeof telegramMonitorGroups.$inferInsert;

export const telegramMonitorMessages = mysqlTable("telegramMonitorMessages", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  groupId: int("groupId").notNull(),
  groupHandle: varchar("groupHandle", { length: 128 }).notNull(),
  messageId: bigint("messageId", { mode: "number" }).notNull(),
  messageText: text("messageText").notNull(),
  messageDate: bigint("messageDate", { mode: "number" }).notNull(),
  senderName: varchar("senderName", { length: 128 }),
  // LLM classification
  category: varchar("category", { length: 64 }), // 'buy_recommendation' | 'insider_buying' | 'other'
  ticker: varchar("ticker", { length: 20 }),
  upside: varchar("upside", { length: 64 }), // e.g. "25%" or "$150 target"
  summary: text("summary"), // LLM-generated Hebrew summary
  isRelevant: boolean("isRelevant").default(false).notNull(),
  capturedAt: bigint("capturedAt", { mode: "number" }).notNull(),
});

export type TelegramMonitorMessage = typeof telegramMonitorMessages.$inferSelect;
export type InsertTelegramMonitorMessage = typeof telegramMonitorMessages.$inferInsert;

// ─── Order Audit Log ──────────────────────────────────────────────────────────
// Persistent audit trail for every order placed via the platform.
// Stores who placed it, from which IP, what was ordered, and the result.
export const orderAuditLog = mysqlTable("orderAuditLog", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  userEmail: varchar("userEmail", { length: 256 }),
  ipAddress: varchar("ipAddress", { length: 64 }).notNull(),
  userAgent: varchar("userAgent", { length: 512 }),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  side: mysqlEnum("side", ["BUY", "SELL"]).notNull(),
  orderType: mysqlEnum("orderType", ["MKT", "LMT", "STP"]).notNull(),
  quantity: varchar("quantity", { length: 32 }).notNull(),
  price: varchar("price", { length: 32 }),
  stopPrice: varchar("stopPrice", { length: 32 }),
  ibkrOrderId: varchar("ibkrOrderId", { length: 64 }),
  status: varchar("status", { length: 64 }),
  accountId: varchar("accountId", { length: 32 }),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
}, (t) => ({
  userIdIdx: index("orderAuditLog_userId_idx").on(t.userId),
  createdAtIdx: index("orderAuditLog_createdAt_idx").on(t.createdAt),
  userCreatedIdx: index("orderAuditLog_userId_createdAt_idx").on(t.userId, t.createdAt),
}));
export type OrderAuditLog = typeof orderAuditLog.$inferSelect;
export type InsertOrderAuditLog = typeof orderAuditLog.$inferInsert;

// ── IBKR Conid Cache ─────────────────────────────────────────────────────────
// Persistent symbol → conid mapping so we only resolve each symbol once.
// conids are stable for the life of the instrument.
export const ibkrConidCache = mysqlTable("ibkrConidCache", {
  id: int("id").autoincrement().primaryKey(),
  symbol: varchar("symbol", { length: 32 }).notNull().unique(),
  conid: int("conid").notNull(),
  exchange: varchar("exchange", { length: 32 }),
  currency: varchar("currency", { length: 8 }),
  assetClass: varchar("assetClass", { length: 16 }),
  resolvedAt: bigint("resolvedAt", { mode: "number" }).notNull(), // unix ms
});
export type IbkrConidCache = typeof ibkrConidCache.$inferSelect;
export type InsertIbkrConidCache = typeof ibkrConidCache.$inferInsert;

// ── Hourly NLV Snapshots ──────────────────────────────────────────────────────
// Stores hourly portfolio value snapshots for intraday chart (1D view).
// snapshotTs = Unix ms timestamp of when the snapshot was taken.
export const hourlySnapshots = mysqlTable("hourlySnapshots", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  snapshotTs: bigint("snapshotTs", { mode: "number" }).notNull(), // Unix ms
  h1Value: double("h1Value"),       // IBKR Net Liquidation Value (H1)
  h2Value: double("h2Value"),       // H2 manual holdings total value
  combinedValue: double("combinedValue").notNull(), // h1Value + h2Value
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  userTsIdx: uniqueIndex("hourlySnapshots_userId_ts_idx").on(t.userId, t.snapshotTs),
}));
export type HourlySnapshot = typeof hourlySnapshots.$inferSelect;
export type InsertHourlySnapshot = typeof hourlySnapshots.$inferInsert;

// ── Paper Lab Execution Logs ──────────────────────────────────────────────────
// Terminal-style log of every paper trade execution attempt.
export const labExecutionLogs = mysqlTable("labExecutionLogs", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  action: varchar("action", { length: 32 }).notNull(),       // e.g. "SNIPER_BUY"
  units: int("units").notNull(),
  price: double("price").notNull(),
  sl: double("sl"),
  tp: double("tp"),
  zivScore: double("zivScore"),
  amount: double("amount").notNull(),                        // USD notional
  status: varchar("status", { length: 32 }).notNull(),       // "submitted" | "failed"
  message: text("message").notNull(),
  orderId: varchar("orderId", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("labExecutionLogs_userId_idx").on(t.userId),
}));
export type LabExecutionLog = typeof labExecutionLogs.$inferSelect;
export type InsertLabExecutionLog = typeof labExecutionLogs.$inferInsert;

// ── Money Transfer Ledger ─────────────────────────────────────────────────────
// Tracks all deposits and withdrawals for TWR performance normalization.
export const moneyTransfers = mysqlTable("moneyTransfers", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  timestamp: bigint("timestamp", { mode: "number" }).notNull(), // UTC ms
  type: varchar("type", { length: 16 }).notNull(),              // 'DEPOSIT' | 'WITHDRAWAL'
  amount: double("amount").notNull(),                           // USD, always positive
  balanceBefore: double("balanceBefore"),                       // equity before transfer
  balanceAfter: double("balanceAfter"),                         // equity after transfer
  source: varchar("source", { length: 32 }).default("MANUAL"), // 'MANUAL' | 'IBKR_AUTO'
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  userTsIdx: index("moneyTransfers_userId_ts_idx").on(t.userId, t.timestamp),
}));
export type MoneyTransfer = typeof moneyTransfers.$inferSelect;
export type InsertMoneyTransfer = typeof moneyTransfers.$inferInsert;


// ── Breakout Scanner Results ──────────────────────────────────────────────────
// Stores detected breakout events from the Breakout Scanner.
export const breakoutScans = mysqlTable("breakoutScans", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  companyName: varchar("companyName", { length: 128 }),
  price: double("price").notNull(),
  donchian20High: double("donchian20High"),
  ema50: double("ema50"),
  zivScore: double("zivScore"),
  tier: varchar("tier", { length: 32 }),
  volumeRatio: double("volumeRatio"),
  breakoutPct: double("breakoutPct"),
  signalType: varchar("signalType", { length: 16 }).notNull().default("BREAKOUT"),
  retestLevel: double("retestLevel"),
  breakoutLevel: double("breakoutLevel").default(0),   // Donchian high at time of breakout (for RETEST tracking)
  currentPrice: double("currentPrice").default(0),    // Live price at scan time
  alertSent: tinyint("alertSent").default(0),
  scannedAt: timestamp("scannedAt").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("breakoutScans_userId_idx").on(t.userId),
  userTickerIdx: index("breakoutScans_userId_ticker_idx").on(t.userId, t.ticker),
  scannedAtIdx: index("breakoutScans_scannedAt_idx").on(t.scannedAt),
}));
export type BreakoutScan = typeof breakoutScans.$inferSelect;
export type InsertBreakoutScan = typeof breakoutScans.$inferInsert;

// ══════════════════════════════════════════════════════════════════════════════
// PAPER LAB — Virtual Exchange (fully detached from IBKR)
// These tables are isolated from all live/IBKR trading tables.
// ══════════════════════════════════════════════════════════════════════════════

// ── Paper Lab Ledger ──────────────────────────────────────────────────────────
// One row per user. Tracks available cash and total equity.
// Initialised with $100,000 on first use.
export const paperLedger = mysqlTable("paperLedger", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(),
  availableCash: double("availableCash").notNull().default(100000),
  initialCapital: double("initialCapital").notNull().default(100000),
  sessionId: int("sessionId").notNull().default(1), // increments on each reset — current session
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("paperLedger_userId_idx").on(t.userId),
}));
export type PaperLedger = typeof paperLedger.$inferSelect;
export type InsertPaperLedger = typeof paperLedger.$inferInsert;

// ── Paper Lab Active Positions ────────────────────────────────────────────────
// One row per open virtual position. Closed rows stay for history.
export const paperPositions = mysqlTable("paperPositions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  companyName: varchar("companyName", { length: 128 }),
  signal: varchar("signal", { length: 32 }).notNull(),
  zivScore: double("zivScore"),
  units: int("units").notNull(),
  entryPrice: double("entryPrice").notNull(),
  rawEntryPrice: double("rawEntryPrice").notNull(),
  allocatedCapital: double("allocatedCapital").notNull(),
  initialSl: double("initialSl").notNull(),
  initialTp: double("initialTp").notNull(),
  currentSl: double("currentSl").notNull(),
  currentTp: double("currentTp").notNull(),
  currentPrice: double("currentPrice"),
  unrealizedPnl: double("unrealizedPnl").default(0),
  unrealizedPnlPct: double("unrealizedPnlPct").default(0),
  zivHScore: double("zivHScore"),
  slHitCount: int("slHitCount").default(0),
  positionSizeUsd: double("positionSizeUsd").default(5000),
  profitLockTriggered: int("profitLockTriggered").default(0), // 1 = partial profit lock already executed (prevents double-trigger)
  peakPrice: double("peakPrice"), // Highest price since entry — for Winner's Leash (15% drawdown exit)
  wideLungActive: int("wideLungActive").default(0), // 1 = Wide Lung Mode active (TP disabled, EMA-20 trailing)
  wideLungActivatedAt: timestamp("wideLungActivatedAt"), // When Wide Lung was activated
  finalOrderMode: int("finalOrderMode").default(0), // 1 = Final Order Mode (Ziv >= 9, no TP from start)
  topUpCount: int("topUpCount").default(0), // Number of conviction top-ups applied (max 1)
  isColdStrategy: int("isColdStrategy").default(0), // 1 = Cold Strategy contrarian entry (RSI<30)
  isParkingLot: int("isParkingLot").default(0), // 1 = Parking Lot ETF position (auto-deployed idle cash)
  isJoinTheMove: int("isJoinTheMove").default(0), // 1 = Join The Move momentum entry
  isDonchianBreakout: int("isDonchianBreakout").default(0), // 1 = Donchian 20-day breakout entry
  gannNextTightenDay: int("gannNextTightenDay"), // next Gann cycle day for SL tightening (7,14,21,30,45,60,90)
  // Phase 5 columns
  partialTpHit: int("partialTpHit").default(0), // 1 = Target 1 partial TP executed (sold 50%)
  slMovedToBreakEven: int("slMovedToBreakEven").default(0), // 1 = SL moved to entry price after partial TP
  target1Price: double("target1Price"), // midpoint between entry and TP for partial TP
  remainingUnits: int("remainingUnits"), // units remaining after partial TP sell
  partialRealizedPnl: double("partialRealizedPnl").default(0), // P&L from partial TP sell
  extremeMomentumMode: int("extremeMomentumMode").default(0), // 1 = RSI>60 + price>EMA-50, bypass EMA-20 exit
  slowGrindCount: int("slowGrindCount").default(0), // consecutive candle closes below EMA-20 (exit at 2)
  riskLevel: int("riskLevel").default(5), // 1-10 risk scale affecting sizing and thresholds
  status: varchar("status", { length: 16 }).notNull().default("open"), // open | pending_entry | pending_exit | closed | orphan_stuck
  exitRetryCount: int("exitRetryCount").default(0), // number of SELL retry attempts (for pending_exit state machine)
  sessionId: int("sessionId").notNull().default(1), // which reset session this position belongs to
  // ── Point-in-Time Entry Snapshot ─────────────────────────────────────────────
  atr14AtEntry: double("atr14AtEntry"),             // ATR-14 at entry
  ema50AtEntry: double("ema50AtEntry"),             // EMA-50 value at entry
  equityAtEntry: double("equityAtEntry"),           // Total equity when opened
  rsiAtEntry: double("rsiAtEntry"),                 // RSI-14 at entry
  distFromEma20AtEntryPct: double("distFromEma20AtEntryPct"),
  // ── Phase 3: Backtesting Foundation ──────────────────────────────────────
  patternId:              int("patternId"),                // FK → mentorPatterns.id (nullable)
  outcomeR:               double("outcomeR"),              // realized R-multiple at close (e.g. 2.3, -1.0)
  outcomeResult:          mysqlEnum("outcomeResult", ["win","loss","breakeven"]), // trade result // % distance from EMA-20 at entry
  relativeVolumeAtEntry: double("relativeVolumeAtEntry"),     // RVOL (today vol / 20-day avg vol)
  ema50SlopeAtEntry: double("ema50SlopeAtEntry"),   // EMA-50 slope at entry
  // ── Analytics Phase 2: MFE/MAE + Market Context ────────────────────────────
  mfePriceHigh: double("mfePriceHigh"),    // Maximum Favorable Excursion: highest price during hold
  maePriceLow: double("maePriceLow"),      // Maximum Adverse Excursion: lowest price during hold
  spyPriceAtEntry: double("spyPriceAtEntry"), // SPY price at time of entry (market context)
  sector: varchar("sector", { length: 64 }),  // Stock sector (e.g., "Technology", "Healthcare")
  exchange: varchar("exchange", { length: 8 }).default("US").notNull(), // 'US' | 'TASE' | 'CRYPTO'
  lmtSlippagePct: double("lmtSlippagePct").default(3).notNull(), // Aggressive LMT exit slippage % (editable per position)
  // ── v16.0 Deterministic Order Tracking ────────────────────────────────────────
  ibkrEntryOrderId: varchar("ibkrEntryOrderId", { length: 64 }), // IBKR order_id for entry order (captured from wrapper response)
  ibkrSlOrderId: varchar("ibkrSlOrderId", { length: 64 }),       // IBKR order_id for active SL order
  ibkrTpOrderId: varchar("ibkrTpOrderId", { length: 64 }),       // IBKR order_id for active TP order
  ibkrExitOrderId: varchar("ibkrExitOrderId", { length: 64 }),   // IBKR order_id for SELL/exit order (audit trail)
  // ── Short Engine v1.0 ─────────────────────────────────────────────────────────
  direction: mysqlEnum("direction", ["long", "short"]).default("long").notNull(), // long = BUY, short = SELL
  isShort: int("isShort").default(0), // 1 = short position (SELL to open, BUY to close)
  bearTier: varchar("bearTier", { length: 32 }), // "Bear Breakdown" | "Bear Retest" | "Weak Bear"
  shortSqueezeGuard: int("shortSqueezeGuard").default(1), // 1 = enabled (exit if +3% adverse move)
  wideLungShortActive: int("wideLungShortActive").default(0), // 1 = Wide Lung SHORT active (trail EMA-20 from above)
  openedAt: timestamp("openedAt").defaultNow().notNull(),
  closedAt: timestamp("closedAt"),
}, (t) => ({
  userIdx: index("paperPositions_userId_idx").on(t.userId),
  statusIdx: index("paperPositions_status_idx").on(t.status),
  userStatusIdx: index("paperPositions_userId_status_idx").on(t.userId, t.status),
  sessionIdIdx: index("paperPositions_sessionId_idx").on(t.sessionId),
  userSessionStatusIdx: index("paperPositions_userId_sessionId_status_idx").on(t.userId, t.sessionId, t.status),
}));
export type PaperPosition = typeof paperPositions.$inferSelect;
export type InsertPaperPosition = typeof paperPositions.$inferInsert;

// ── Paper Lab Trade History ───────────────────────────────────────────────────
// Immutable record of every completed (closed) paper trade.
export const paperTrades = mysqlTable("paperTrades", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  positionId: int("positionId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  signal: varchar("signal", { length: 32 }).notNull(),
  // Entry parameters
  zivScore: double("zivScore"),           // ZivH score at entry
  zivHAtEntry: double("zivHAtEntry"),     // ZivH score at entry (explicit)
  zivHAtExit: double("zivHAtExit"),       // ZivH score at exit
  atr14AtEntry: double("atr14AtEntry"),   // ATR14 at entry (used for SL calc)
  ema50AtEntry: double("ema50AtEntry"),   // EMA50 at entry
  rsiAtEntry: double("rsiAtEntry"),       // RSI-14 at entry
  distFromEma20AtEntryPct: double("distFromEma20AtEntryPct"), // % distance from EMA-20 at entry
  relativeVolumeAtEntry: double("relativeVolumeAtEntry"),     // RVOL at entry
  ema50SlopeAtEntry: double("ema50SlopeAtEntry"),             // EMA-50 slope at entry
  units: int("units").notNull(),
  entryPrice: double("entryPrice").notNull(),
  exitPrice: double("exitPrice").notNull(),
  initialSl: double("initialSl"),         // SL set at entry
  initialTp: double("initialTp"),         // TP set at entry
  finalSl: double("finalSl"),             // SL at time of exit (may have trailed)
  finalTp: double("finalTp"),             // TP at time of exit
  rrRatio: double("rrRatio"),             // R:R ratio = (TP-entry)/(entry-SL)
  allocatedCapital: double("allocatedCapital").notNull(),
  equityAtEntry: double("equityAtEntry"), // Total equity when position was opened
  realizedPnl: double("realizedPnl").notNull(),
  realizedPnlPct: double("realizedPnlPct").notNull(),
  holdTimeMinutes: int("holdTimeMinutes"), // How long position was held
  exitReason: varchar("exitReason", { length: 32 }).notNull(),
  // ── Exit Snapshot ────────────────────────────────────────────────────────────
  rsiAtExit: double("rsiAtExit"),                   // RSI-14 at exit
  atr14AtExit: double("atr14AtExit"),               // ATR-14 at exit
  ema50AtExit: double("ema50AtExit"),               // EMA-50 at exit
  distFromEma20AtExitPct: double("distFromEma20AtExitPct"), // % distance from EMA-20 at exit
  relativeVolumeAtExit: double("relativeVolumeAtExit"),     // RVOL at exit
  executionSlippage: double("executionSlippage").default(0), // gap slippage: actualExit - intendedExit (negative = bad slippage on SL, positive = good slippage on TP)
  gapExecution: tinyint("gapExecution").default(0),          // 1 if filled at open due to gap, 0 if filled at SL/TP
  // ── Analytics Phase 2: MFE/MAE + Market Context ────────────────────────────
  mfePriceHigh: double("mfePriceHigh"),    // Maximum Favorable Excursion: highest price during hold
  maePriceLow: double("maePriceLow"),      // Maximum Adverse Excursion: lowest price during hold
  spyPriceAtEntry: double("spyPriceAtEntry"), // SPY price at time of entry (market context)
  sector: varchar("sector", { length: 64 }),  // Stock sector (e.g., "Technology", "Healthcare")
  sessionId: int("sessionId").notNull().default(1), // which reset session this trade belongs to
  openedAt: timestamp("openedAt").notNull(),
  closedAt: timestamp("closedAt").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("paperTrades_userId_idx").on(t.userId),
  closedAtIdx: index("paperTrades_closedAt_idx").on(t.closedAt),
  sessionIdIdx: index("paperTrades_sessionId_idx").on(t.sessionId),
  userSessionIdIdx: index("paperTrades_userId_sessionId_idx").on(t.userId, t.sessionId),
}));
export type PaperTrade = typeof paperTrades.$inferSelect;
export type InsertPaperTrade = typeof paperTrades.$inferInsert;

// ── Paper Lab Equity Snapshots ────────────────────────────────────────────────
// Hourly snapshots of total equity for Daily / Weekly / Monthly yield calculation.
export const paperEquitySnapshots = mysqlTable("paperEquitySnapshots", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  totalEquity: double("totalEquity").notNull(),
  snapshotTs: bigint("snapshotTs", { mode: "number" }).notNull(), // Unix ms
  sessionId: int("sessionId").notNull().default(1), // which reset session this snapshot belongs to
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  userTsIdx: uniqueIndex("paperEquitySnapshots_userId_ts_idx").on(t.userId, t.snapshotTs),
  sessionIdIdx: index("paperEquitySnapshots_sessionId_idx").on(t.sessionId),
  userSessionIdIdx: index("paperEquitySnapshots_userId_sessionId_idx").on(t.userId, t.sessionId),
}));
export type PaperEquitySnapshot = typeof paperEquitySnapshots.$inferSelect;

// ── Paper Lab Entry Lock ──────────────────────────────────────────────────────
// Atomic entry lock — prevents concurrent AlertPoller instances from opening
// duplicate positions for the same ticker. A row exists here IFF the ticker
// currently has an open position. INSERT succeeds only once (UNIQUE on userId+ticker);
// any concurrent INSERT throws a duplicate-key error which tryPaperEntry catches
// and treats as "already entered". Row is deleted when the position is closed.
export const paperEntryLock = mysqlTable("paperEntryLock", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  positionId: int("positionId"),           // set after position row is created
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  uniqueUserTicker: uniqueIndex("paperEntryLock_userId_ticker_uniq").on(t.userId, t.ticker),
}));
export type PaperEntryLock = typeof paperEntryLock.$inferSelect;

// ── Paper Lab Anti-Churn Penalty Box ──────────────────────────────────────────
// v20.72: Tracks SL hits per ticker within a rolling 14-day window.
// When a ticker accumulates 2 SL hits in 14 days → enters a 5-day penalty box.
// During penalty, no new entries are allowed for that ticker.
// Persisted in DB so it survives server restarts (unlike the old in-memory blacklist).
export const paperPenaltyBox = mysqlTable("paperPenaltyBox", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  /** Date/time the penalty box was activated */
  activatedAt: timestamp("activatedAt").defaultNow().notNull(),
  /** Date/time the penalty box expires (5 days after activation) */
  expiresAt: timestamp("expiresAt").notNull(),
  /** Number of SL hits that triggered this penalty (always 2) */
  slHitCount: int("slHitCount").notNull().default(2),
  /** Session ID for scoping to current lab session */
  sessionId: int("sessionId").notNull().default(1),
}, (t) => ({
  userTickerIdx: index("paperPenaltyBox_userId_ticker_idx").on(t.userId, t.ticker),
  expiresIdx: index("paperPenaltyBox_expiresAt_idx").on(t.expiresAt),
}));
export type PaperPenaltyBox = typeof paperPenaltyBox.$inferSelect;
export type InsertPaperPenaltyBox = typeof paperPenaltyBox.$inferInsert;

// ── Paper Lab Ticker Wallet ─────────────────────────────────────────────────
// v20.95: Per-ticker wallet tracking cumulative P&L across all trades.
// Each ticker gets its own "wallet" that accumulates profits/losses.
export const paperTickerWallet = mysqlTable("paperTickerWallet", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  totalPnl: double("totalPnl").notNull().default(0), // cumulative P&L in USD
  tradeCount: int("tradeCount").notNull().default(0), // total trades for this ticker
  winCount: int("winCount").notNull().default(0), // winning trades
  lossCount: int("lossCount").notNull().default(0), // losing trades
  lastTradeAt: timestamp("lastTradeAt"),
  sessionId: int("sessionId").notNull().default(1),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  userTickerSessionIdx: uniqueIndex("paperTickerWallet_userId_ticker_session_uniq").on(t.userId, t.ticker, t.sessionId),
}));
export type PaperTickerWallet = typeof paperTickerWallet.$inferSelect;
export type InsertPaperTickerWallet = typeof paperTickerWallet.$inferInsert;

// ── Paper Lab Re-entry Watchlist ─────────────────────────────────────────────
// v20.95: Tracks recently exited tickers for re-entry protocols:
// Three-Day Rule, Hot Watchlist/Bear Trap, Immediate Recovery
export const paperReentryWatch = mysqlTable("paperReentryWatch", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  exitPrice: double("exitPrice").notNull(),
  exitReason: varchar("exitReason", { length: 32 }).notNull(),
  exitDate: timestamp("exitDate").notNull(),
  candlesAboveExitPrice: int("candlesAboveExitPrice").default(0), // for Three-Day Rule
  snapBackEligible: int("snapBackEligible").default(0), // 1 = exited via EMA-20 breakdown (Bear Trap candidate)
  recoveryChecked: int("recoveryChecked").default(0), // 1 = Immediate Recovery already attempted
  reentryExecuted: int("reentryExecuted").default(0), // 1 = re-entry was executed
  sessionId: int("sessionId").notNull().default(1),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  userTickerSessionIdx: index("paperReentryWatch_userId_ticker_session_idx").on(t.userId, t.ticker, t.sessionId),
}));
export type PaperReentryWatch = typeof paperReentryWatch.$inferSelect;
export type InsertPaperReentryWatch = typeof paperReentryWatch.$inferInsert;

// ── Paper Lab Tight Exit Audit ──────────────────────────────────────────────
// v20.95: Tracks tickers where price rose 5%+ after exit → widen SL next time
export const paperTightExitAudit = mysqlTable("paperTightExitAudit", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  exitPrice: double("exitPrice").notNull(),
  postExitHighPrice: double("postExitHighPrice"), // highest price seen after exit
  postExitGainPct: double("postExitGainPct").default(0), // % gain after exit
  slWidenMultiplier: double("slWidenMultiplier").default(1.0), // multiplier for next SL (1.0 = normal, 1.2 = 20% wider)
  sessionId: int("sessionId").notNull().default(1),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  userTickerSessionIdx: uniqueIndex("paperTightExitAudit_userId_ticker_session_uniq").on(t.userId, t.ticker, t.sessionId),
}));
export type PaperTightExitAudit = typeof paperTightExitAudit.$inferSelect;
export type InsertPaperTightExitAudit = typeof paperTightExitAudit.$inferInsert;

// ── Price Cache Blob ──────────────────────────────────────────────────────────
// Single-row table storing ALL price data as JSON for instant simulation loading
// LONGTEXT supports up to 4GB — more than enough for 200+ tickers × 5 years
export const priceCacheBlob = mysqlTable("priceCacheBlob", {
  id: int("id").autoincrement().primaryKey(),
  data: longtext("data").notNull(), // JSON string of all ticker prices (compact format)
  tickerCount: int("tickerCount").notNull().default(0),
  totalBars: int("totalBars").notNull().default(0),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type PriceCacheBlob = typeof priceCacheBlob.$inferSelect;

// ── Persistent System Logs ──────────────────────────────────────────────────
// Critical errors and events written directly to DB so they survive Cloud Run
// instance termination. Ring buffer logs die with the instance; these persist.
export const systemLogs = mysqlTable("systemLogs", {
  id: int("id").autoincrement().primaryKey(),
  level: mysqlEnum("level", ["critical", "error", "warn", "info"]).notNull(),
  category: varchar("category", { length: 32 }).notNull(), // SCAN, SIM, IBKR, DB, SYSTEM, PAPER, ALERTS, AUTH
  message: text("message").notNull(),
  stack: text("stack"),                    // full Error.stack
  context: text("context"),                // JSON string of relevant variables
  instanceId: varchar("instanceId", { length: 64 }), // unique per Cloud Run instance
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  levelIdx: index("systemLogs_level_idx").on(t.level),
  categoryIdx: index("systemLogs_category_idx").on(t.category),
  createdAtIdx: index("systemLogs_createdAt_idx").on(t.createdAt),
}));
export type SystemLog = typeof systemLogs.$inferSelect;
export type InsertSystemLog = typeof systemLogs.$inferInsert;

// ── Daily Position Changes ──────────────────────────────────────────────────
// Tracks daily position changes detected during IBKR sync: opened, closed, increased, reduced.
// One row per ticker per date per user. Updated if multiple changes happen on the same day.
export const dailyPositionChanges = mysqlTable("dailyPositionChanges", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  ticker: varchar("ticker", { length: 16 }).notNull(),
  date: varchar("date", { length: 16 }).notNull(), // YYYY-MM-DD (Israel time)
  changeType: mysqlEnum("changeType", ["opened", "closed", "increased", "reduced"]).notNull(),
  unitsBefore: double("unitsBefore").notNull().default(0),
  unitsAfter: double("unitsAfter").notNull().default(0),
  unitsDelta: double("unitsDelta").notNull().default(0), // positive = added, negative = removed
  avgPriceBefore: double("avgPriceBefore"), // avg cost basis before change
  avgPriceAfter: double("avgPriceAfter"),   // avg cost basis after change
  marketPriceAtChange: double("marketPriceAtChange"), // live price when change detected
  realizedPnl: double("realizedPnl"),       // estimated realized P&L for closed/reduced positions
  detectedAt: timestamp("detectedAt").defaultNow().notNull(), // when the change was first detected
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  userDateIdx: index("dailyPositionChanges_userId_date_idx").on(t.userId, t.date),
  userTickerDateIdx: uniqueIndex("dailyPositionChanges_userId_ticker_date_idx").on(t.userId, t.ticker, t.date),
}));
export type DailyPositionChange = typeof dailyPositionChanges.$inferSelect;
export type InsertDailyPositionChange = typeof dailyPositionChanges.$inferInsert;

// ── Sector Configuration (Paper Lab UI) ─────────────────────────────────────
export const sectorConfig = mysqlTable("sectorConfig", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  sectorName: varchar("sectorName", { length: 64 }).notNull(), // e.g. "Mag 7", "Chips & Hardware", "TASE"
  isEnabled: tinyint("isEnabled").default(1).notNull(), // 1 = enabled, 0 = disabled
  tickers: json("tickers").notNull(), // JSON array of ticker strings
  displayOrder: int("displayOrder").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  userIdx: index("sectorConfig_userId_idx").on(t.userId),
  userSectorIdx: uniqueIndex("sectorConfig_userId_sectorName_idx").on(t.userId, t.sectorName),
}));
export type SectorConfig = typeof sectorConfig.$inferSelect;
export type InsertSectorConfig = typeof sectorConfig.$inferInsert;

// ── Agent Insights (Daily AI Briefing + Approval Queue) ──────────────────────
export const agentInsights = mysqlTable("agentInsights", {
  id:              int("id").autoincrement().primaryKey(),
  userId:          int("userId").notNull(),
  date:            date("date").notNull(),
  type:            mysqlEnum("type", ["daily_summary","market_outlook","new_ticker","dual_signal","pattern_learned","code_change"]).notNull(),
  status:          mysqlEnum("status", ["pending","approved","rejected","applied"]).notNull().default("pending"),
  title:           varchar("title", { length: 255 }).notNull(),
  body:            text("body").notNull(),
  ticker:          varchar("ticker", { length: 16 }),
  mentor:          varchar("mentor", { length: 32 }),
  priority:        mysqlEnum("priority", ["critical","high","medium","low"]).notNull().default("medium"),
  codeChangePatch: text("codeChangePatch"),
  approvedAt:      timestamp("approvedAt"),
  createdAt:       timestamp("createdAt").defaultNow().notNull(),
});
export type AgentInsight = typeof agentInsights.$inferSelect;
export type InsertAgentInsight = typeof agentInsights.$inferInsert;

// ── Mentor Patterns (Continuous Learning) ────────────────────────────────────
export const mentorPatterns = mysqlTable("mentorPatterns", {
  id:           int("id").autoincrement().primaryKey(),
  userId:       int("userId").notNull(),
  mentor:       mysqlEnum("mentor", ["cycles_trading","micha_stocks","both"]).notNull(),
  patternName:  varchar("patternName", { length: 64 }).notNull(),
  description:  text("description").notNull(),
  occurrences:  int("occurrences").notNull().default(1),
  successRate:  double("successRate"),
  avgReturn:    double("avgReturn"),
  tickers:      text("tickers"),     // JSON array
  rawExamples:  text("rawExamples"), // JSON array of {videoId, quote}
  lastSeenAt:   timestamp("lastSeenAt").defaultNow().notNull(),
  createdAt:    timestamp("createdAt").defaultNow().notNull(),
  updatedAt:    timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  uniqUserMentorPattern: uniqueIndex("uniq_user_mentor_pattern").on(t.userId, t.mentor, t.patternName),
}));
export type MentorPattern = typeof mentorPatterns.$inferSelect;
export type InsertMentorPattern = typeof mentorPatterns.$inferInsert;

// ── Elza Live Engine — Positions ─────────────────────────────────────────────
// Tracks all positions opened by Elza on the REAL IBKR account (U16881054).
// Completely separate from paperPositions — only Elza's entries appear here.
export const livePositions = mysqlTable("livePositions", {
  id:                  int("id").autoincrement().primaryKey(),
  userId:              int("userId").notNull(),
  accountId:           varchar("accountId", { length: 32 }).notNull().default(""),
  ticker:              varchar("ticker", { length: 16 }).notNull(),
  companyName:         varchar("companyName", { length: 128 }),
  direction:           mysqlEnum("direction", ["long", "short"]).notNull().default("long"),
  units:               int("units").notNull(),
  entryPrice:          double("entryPrice").notNull(),
  allocatedCapital:    double("allocatedCapital").notNull(),
  currentSl:           double("currentSl").notNull(),
  currentTp:           double("currentTp").notNull(),
  initialSl:           double("initialSl").notNull(),
  initialTp:           double("initialTp").notNull(),
  currentPrice:        double("currentPrice"),
  unrealizedPnl:       double("unrealizedPnl").default(0),
  unrealizedPnlPct:    double("unrealizedPnlPct").default(0),
  status:              mysqlEnum("status", ["open", "closed", "pending_exit", "pending_entry", "zombie", "frozen", "pending_halt"]).notNull().default("open"),
  signal:              varchar("signal", { length: 32 }).notNull(),
  zivScore:            double("zivScore"),
  sector:              varchar("sector", { length: 64 }),
  // Ziv Phase-1 structural snapshot at entry (nullable; only populated when gates ran).
  // route + zone meta + weekly state → per-route win-rate/expectancy with no join.
  entryStructMeta:     json("entryStructMeta"),
  // IBKR order tracking — only orders Elza placed
  ibkrEntryOrderId:    varchar("ibkrEntryOrderId", { length: 64 }),
  ibkrTpOrderId:       varchar("ibkrTpOrderId", { length: 64 }),
  ibkrExitOrderId:     varchar("ibkrExitOrderId", { length: 64 }),
  exitRetryCount:      int("exitRetryCount").default(0),
  // P&L at close
  exitPrice:           double("exitPrice"),
  realizedPnl:         double("realizedPnl"),
  exitReason:          varchar("exitReason", { length: 64 }),
  openedAt:            timestamp("openedAt").defaultNow().notNull(),
  closedAt:            timestamp("closedAt"),
  // War Engine tracking
  slMovedToBreakEven:  tinyint("slMovedToBreakEven").default(0),
  partialTpHit:        tinyint("partialTpHit").default(0),
  partialRealizedPnl:  double("partialRealizedPnl").default(0),
  // V2.00: LULD halt + partial fill tracking
  pendingHalt:         tinyint("pendingHalt").default(0),
  haltRetryCount:      int("haltRetryCount").default(0),
  fillStatus:          mysqlEnum("fillStatus", ["none", "partial", "full"]).default("none"),
  slProtection:        varchar("slProtection", { length: 16 }).notNull().default("ibkr"), // ibkr | software
  requestedQty:        int("requestedQty"),
  filledQty:           int("filledQty").default(0),
  remainingQty:          int("remainingQty").default(0),
  ibkrAvgCost:         double("ibkrAvgCost"),
  ibkrUnits:           int("ibkrUnits"),
  corporateActionFrozen: tinyint("corporateActionFrozen").default(0),
  ibkrSlOrderId:       varchar("ibkrSlOrderId", { length: 64 }),
  // ── Asymmetric Fat-Tail Engine v2.0 — running metadata ──────────────────────
  rValue:              double("rValue"),                       // |entryPrice - initialSl|, per share
  isFreeRolled:        tinyint("isFreeRolled").notNull().default(0),
  peakPrice:           double("peakPrice"),                    // peak (long) / trough (short) since entry
  atr14:               double("atr14"),                        // Daily ATR snapshot at entry (Chandelier trail)
  // ── Pyramid Engine v1.0 — single-row scale-in metadata ─────────────────────
  originalUnits:       int("originalUnits"),                   // frozen at first fill; sizing anchor for +50%
  pyramidDone:         tinyint("pyramidDone").notNull().default(0), // max one scale-in per position
  pyramidUnits:        int("pyramidUnits").notNull().default(0),
  pyramidEntryPrice:   double("pyramidEntryPrice"),            // fill price of add leg
  pyramidSl:           double("pyramidSl"),                    // SL peg for add leg (= original entryPrice)
  pyramidAt:           timestamp("pyramidAt"),
  pyramidOrderId:      varchar("pyramidOrderId", { length: 64 }),
  // ── Ghost Slots v1.1 (2026-06-29, ghost-slots-phoenix-protocol §2.3) — INERT BY DEFAULT ──
  // slotGhost=1 frees the ELZA slot ONLY (countsTowardSlot=0) once the +1.5R breakeven
  // stop is BROKER-VERIFIED resting on IBKR; status stays `open`, IBKR gross/margin and
  // openTickerSet are UNCHANGED (slot ≠ margin). Default 0/1 ⇒ today's behavior. Only the
  // warEngine slot counter + heat recalc consult these, and ONLY when ghostSlotsEnabled=1.
  slotGhost:           tinyint("slotGhost").notNull().default(0),       // 1 = slot freed (ghost)
  countsTowardSlot:    tinyint("countsTowardSlot").notNull().default(1),// 0 when ghost; 1 normally
  ghostAt:             bigint("ghostAt", { mode: "number" }),           // epoch ms the slot was ghosted
  ghostStage:          varchar("ghostStage", { length: 32 }),          // 'FREE_ROLL_1.5R_BE'
  // ── Phoenix Protocol v1.1 (2026-06-29, §3.6) — INERT BY DEFAULT ──
  // 0 = origin/normal position; 1 = a phoenix re-entry child. originPosId links to the
  // stopped origin's livePositions.id (lineage / per-ticker anti-loop join).
  phoenixGeneration:   tinyint("phoenixGeneration").notNull().default(0),
  originPosId:         int("originPosId"),
  // ── THE WAITER v1.0 (2026-06-30, §7) — INERT BY DEFAULT ──
  // A Waiter retest resting LMT is a livePositions row at status="pending_entry",
  // countsTowardSlot=1 (committed slot), isWaiterEntry=1. ibkrEntryOrderId holds the
  // resting LMT order id (cancel/re-quote handle). waiterEmaAtPlace = the EMA-20 the
  // limit was computed off (R2 drift re-quote basis). waiterStage tracks the lifecycle.
  // Default 0/null → existing rows + the flag-off path are byte-identical.
  isWaiterEntry:       tinyint("isWaiterEntry").notNull().default(0),     // 1 = a Waiter retest resting LMT
  waiterEmaAtPlace:    double("waiterEmaAtPlace"),                        // EMA-20 used for the resting limit (re-quote drift basis)
  waiterStage:         varchar("waiterStage", { length: 24 }),           // 'RESTING' | 'FILLED_ARMING' | 'MANAGED'
}, (t) => ({
  userIdx:     index("livePositions_userId_idx").on(t.userId),
  statusIdx:   index("livePositions_status_idx").on(t.status),
  tickerIdx:   index("livePositions_ticker_idx").on(t.ticker),
  // Tier-1 perf (2026-07-01, migration 0146): composite indexes for the hot engine predicates.
  // userId+status = every cycle/reconcile/4s-poll; +closedAt = daily-loss breaker; +openedAt =
  // open-today count; userId+ticker+status = entry dedup + getStatus. Additive; behavior unchanged.
  userStatusIdx:         index("livePositions_userId_status_idx").on(t.userId, t.status),
  userStatusClosedAtIdx: index("livePositions_userId_status_closedAt_idx").on(t.userId, t.status, t.closedAt),
  userOpenedAtIdx:       index("livePositions_userId_openedAt_idx").on(t.userId, t.openedAt),
  userTickerStatusIdx:   index("livePositions_userId_ticker_status_idx").on(t.userId, t.ticker, t.status),
}));
export type LivePosition = typeof livePositions.$inferSelect;
export type InsertLivePosition = typeof livePositions.$inferInsert;

// ── Phoenix Protocol — re-entry ledger (anti-loop SSOT) ───────────────────────
// One row per Wide-Lung-stop that becomes eligible for a same-day 5m-reclaim re-entry.
// The anti-loop guards (≤1/ticker/day, ≤3/account/day, 30-min cooldown, ghost-open
// block) are ALL read from THIS table — never from in-memory counters — because the
// engine restarts constantly and an in-memory counter would reset → unbounded re-entry.
export const phoenixLedger = mysqlTable("phoenixLedger", {
  id:             int("id").autoincrement().primaryKey(),
  userId:         int("userId").notNull(),
  originPosId:    int("originPosId").notNull(),                       // livePositions.id of the stopped origin
  ticker:         varchar("ticker", { length: 16 }).notNull(),
  tradeDate:      varchar("tradeDate", { length: 10 }).notNull(),    // Israel-time YYYY-MM-DD (per-day key)
  breakoutLine:   double("breakoutLine").notNull(),                  // frozen donchian20High × 0.995 at origin
  stopPrice:      double("stopPrice").notNull(),                     // the wide-lung stop that was hit
  reclaimPrice:   double("reclaimPrice"),                            // 5m reclaim close that armed re-entry
  status:         varchar("status", { length: 16 }).notNull().default("eligible"), // eligible|reentered|stopped|expired|blocked
  phoenixQty:     int("phoenixQty"),                                 // shares the re-entry sized to
  plannedRiskUsd: double("plannedRiskUsd"),                          // qty × |entry-stop| at re-entry
  reenteredPosId: int("reenteredPosId"),                            // livePositions.id of the phoenix child
  cooldownUntil:  bigint("cooldownUntil", { mode: "number" }),       // epoch ms; 30-min cooldown after a phoenix stop
  createdAt:      bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt:      bigint("updatedAt", { mode: "number" }).notNull(),
}, (t) => ({
  userDateIdx: index("phoenixLedger_user_date_idx").on(t.userId, t.tradeDate),
  tickerIdx:   index("phoenixLedger_ticker_idx").on(t.ticker),
  statusIdx:   index("phoenixLedger_status_idx").on(t.status),
}));
export type PhoenixLedger = typeof phoenixLedger.$inferSelect;
export type InsertPhoenixLedger = typeof phoenixLedger.$inferInsert;

// ── Elza Live Engine — Configuration ─────────────────────────────────────────
// Controls the live engine: on/off, capital allocation %, market hours.
export const liveEngineConfig = mysqlTable("liveEngineConfig", {
  id:                  int("id").autoincrement().primaryKey(),
  userId:              int("userId").notNull().unique(),
  isEnabled:           tinyint("isEnabled").notNull().default(0),      // 0=off, 1=on
  allocatedPct:        double("allocatedPct").notNull().default(10),   // % of NLV to deploy (0-100)
  maxPositions:        int("maxPositions").notNull().default(12),      // legacy — total max
  maxLongPositions:    int("maxLongPositions").notNull().default(12),  // max long positions
  maxShortPositions:   int("maxShortPositions").notNull().default(12),  // max short positions (symmetric-short §5.1: == maxLong)
  positionSizePct:     double("positionSizePct").notNull().default(10),// % of allocated capital per position
  marketOpen:          varchar("marketOpen", { length: 8 }).notNull().default("16:30"),  // Israel time
  marketClose:         varchar("marketClose", { length: 8 }).notNull().default("23:00"), // Israel time
  accountId:           varchar("accountId", { length: 32 }).notNull().default(""),
  totalNlv:            double("totalNlv").default(120000),             // full account NLV (updated from IBKR)
  dailyEntryLimit:     int("dailyEntryLimit").notNull().default(10),
  intradayMultiplier:  double("intradayMultiplier").notNull().default(3.9),   // x3.9 buying power 16:30-22:45
  overnightMultiplier: double("overnightMultiplier").notNull().default(1.9),  // x1.9 overnight hard cap
  minPositionUsd:      double("minPositionUsd").notNull().default(1000),      // Minimum position size in USD
  maxPositionUsd:      double("maxPositionUsd").notNull().default(50000),     // Maximum position size in USD
  maxDailyOrders:      int("maxDailyOrders").notNull().default(50),           // entries-only daily cap (UI-managed)
  deleverageCutoffTime: varchar("deleverageCutoffTime", { length: 5 }).notNull().default("22:45"), // EOD deleverage trigger
  dailyLossEnabled:    tinyint("dailyLossEnabled").notNull().default(1),   // 1=on — Iron Rule 4 circuit breaker
  dailyLossLimitUsd:   double("dailyLossLimitUsd").notNull().default(2000), // max daily realized loss + commissions
  // ── Kronos Conviction Scoring (2026-06-25, ADR kronos-conviction-scoring) ──
  // Combined entry score = ZIV(≤cap) + kronosAddon(0–2.5). All owner-tunable live.
  // Domain of kronosConvictionWeight is {0} ∪ [0.5, 2.5]. 0 = OFF kill-switch (pure ZIV,
  // gate→zivOnlyFloor). A value in (0,0.5) is a FOOT-GUN — it caps the addon below the gap
  // to combinedGate and would freeze entries; getKronosAddonFromRow snaps 0<w<0.5 to OFF.
  kronosConvictionWeight: double("kronosConvictionWeight").notNull().default(0),  // {0} ∪ [0.5, 2.5] cap on addon. 0 = OFF (pure ZIV). (0,0.5) snapped to OFF on read.
  // DISPLAY/COMPUTE decouple (2026-06-25): when 1, the hourly :05 job COMPUTES + caches
  // kronos scores for UI validation even while kronosConvictionWeight=0 (gating stays OFF).
  // The job runs when (kronosComputeEnabled=1 OR kronosConvictionWeight>0). Default 0 = off.
  kronosComputeEnabled: tinyint("kronosComputeEnabled").notNull().default(0),     // 1 = compute+cache scores for DISPLAY (no gating effect unless weight>0)
  zivStructuralCap:    double("zivStructuralCap").notNull().default(7.5),   // ceiling of (ZIV+mentor) structural component
  zivStructuralFloor:  double("zivStructuralFloor").notNull().default(6.5), // structural floor when kronos is ON
  zivOnlyFloor:        double("zivOnlyFloor").notNull().default(7.5),       // floor used when kronos is OFF/STALE (preserves legacy ZIV-alone behaviour)
  combinedGate:        double("combinedGate").notNull().default(8.0),       // combined-score entry gate AND sizing-band floor (kronos FRESH only)
  degradedGate:        double("degradedGate").notNull().default(6.8),       // DEPRECATED gate: stale/cold cache now reverts to zivOnlyFloor (ZIV-alone), not a separate gate
  kronosStalenessMin:  int("kronosStalenessMin").notNull().default(90),     // minutes before a cached addon decays to 0
  kronosUniverseSize:  int("kronosUniverseSize").notNull().default(25),     // top-N ZIV survivors the hourly job scores
  // ── Gold Breakout kill-switch (2026-06-26, owner-disabled RC-1) ───────────────
  // 0 = OFF (DEFAULT, per owner): the top ZIV tier "Gold Breakout" (fresh ≥20-day
  // Donchian breakout) is barred from ENTER — it chases extended daily breakouts (the
  // #1 stop-out cause). Such names are SKIPped (still shown in the funnel) and may
  // still enter later via the confirmed Gold Retest tier. 1 = re-enable raw breakouts.
  goldBreakoutEnabled: tinyint("goldBreakoutEnabled").notNull().default(0),  // 0 = OFF (owner-killed breakout-chasing); 1 = allow raw Gold Breakout entries
  // ── Symmetric Short Engine (2026-06-26, spec 2026-06-26-symmetric-short-engine) ──
  // breadthThreshold: weak-breadth short-enable knob (§1.4). When the % of the scanned
  // universe trading below its EMA-200 ≥ this value, shorts are turned ON even if the
  // SPY regime reads BULL (the Mag7-masked tape the SPY-only gate uniquely suppressed).
  breadthThreshold:    double("breadthThreshold").notNull().default(0.55),
  // bearBreakdownEnabled: SHORT mirror of goldBreakoutEnabled (§3). 0 = OFF (DEFAULT):
  // a fresh ≥20-day Donchian-LOW breakdown ("Bear Breakdown") is barred from ENTER and
  // held as SKIP (still shown in the funnel) — it may enter later via Bear Retest.
  bearBreakdownEnabled: tinyint("bearBreakdownEnabled").notNull().default(0),
  // ── Ziv Phase 1 gates (2026-06-26, ziv-engine-spec/phase1-architecture §4) ──────
  // SAFE DEFAULT = 0 (OFF) = engine byte-identical to today. Flipped ON via UI post-QA.
  zonesGateEnabled:    tinyint("zonesGateEnabled").notNull().default(0),    // 1 = entries must sit at a qualifying demand/supply zone
  weeklyAnchorEnabled: tinyint("weeklyAnchorEnabled").notNull().default(0), // 1 = HARD weekly gate (WK-L long / WK-S short; blocks consolidation/knife)
  retestV2Enabled:     tinyint("retestV2Enabled").notNull().default(0),     // Phase 2: 1 = ±0.5×ATR band retest gate; 0 = legacy ±2% path
  riskSizingEnabled:   tinyint("riskSizingEnabled").notNull().default(0),   // Phase 3: 1 = 1%-risk sizing (qty=risk/SL-dist); 0 = legacy fixed-capital
  heatMaxPct:          double("heatMaxPct").notNull().default(0.07),         // Phase 3: max aggregate open-risk as fraction of NLV
  volumeConfirmEnabled: tinyint("volumeConfirmEnabled").notNull().default(0), // Phase 4: 1 = a breakout/breakdown may ENTER only if volume-confirmed (נמ"ס); 0 = stays SKIP
  structuralExitsEnabled: tinyint("structuralExitsEnabled").notNull().default(0), // Phase 5: 1 = arm 50%@2R free-roll + structural TP; 0 = observe-only (today)
  cyclePhaseGateEnabled: tinyint("cyclePhaseGateEnabled").notNull().default(1),   // 1 = cycle-phase gate ON (today's behavior); 0 = bypass it (loosen entries)
  // ── DB-drift reconcile (2026-06-27, positionReconcile.ts) — INERT BY DEFAULT ──
  // 0 = OFF (DEFAULT): reconcilePhantomPositions() reads this flag and no-ops. When 1,
  // a (not-yet-wired) cron may close ONLY phantom DB rows absent from a trusted IBKR read,
  // behind a mass-disappearance guard. Flip to 1 ONLY after a dry-run verification at
  // market-open — this is the sole knob that lets the job mutate position state.
  dbReconcileEnabled:  tinyint("dbReconcileEnabled").notNull().default(0),
  // ── Elza v4.5 Master gap-walls live wiring (2026-06-28) — INERT BY DEFAULT ──
  // 0 = OFF (DEFAULT): EVERY new gap-wall code path (never-naked verify-or-flatten,
  // EOD overnight-gross trim, idempotent circuit-breaker flatten) is skipped →
  // behavior byte-identical to today. Flip to 1 ONLY after a market-open dry-run
  // verification. This is the sole switch that arms the 3 Elza v4.5 safety guards.
  elzaV45LiveEnabled:  tinyint("elzaV45LiveEnabled").notNull().default(0),
  // ── Ziv Rotation Flush (2026-06-28) — INERT BY DEFAULT ──
  // 1 = arm Ziv Rotation Flush (displace weakest dead-money long for a Tier-4 breakout); 0 = inert
  zivRotationFlushEnabled: tinyint("zivRotationFlushEnabled").notNull().default(0),
  // ── Intraday Armed-Watcher (2026-06-29, BUILD-spec F2) — INERT BY DEFAULT ──
  // 0 = OFF (DEFAULT): the armed-watcher tick early-returns before any fetch/state
  // mutation, the tiered cadence keeps today's :00/:20/:40 universe cadence, and
  // watcherStatus is null → runtime byte-identical to today. 1 = arm intraday
  // breakout-cross detection (ARMED→CROSSED→HELD_5M→ENTER, anti-chase, fail-closed),
  // fired ONLY after the §5 backtest arm-gate passes. Owner-only flip. Build != arm.
  elzaIntradayWatcherEnabled: tinyint("elzaIntradayWatcherEnabled").notNull().default(0),
  // Armed-Watcher SHADOW MODE (2026-06-30) — detect + log would-be entries, NO order. Default 0.
  elzaIntradayWatcherShadow: tinyint("elzaIntradayWatcherShadow").notNull().default(0),
  // ── Ghost Slots (2026-06-29, ghost-slots-phoenix-protocol §6) — INERT BY DEFAULT ──
  // 0 = OFF (DEFAULT): the warEngine slot counter, heat recalc and onBreakevenConfirmed
  // hook all consult the flag and early-return → no row is ever ghosted, every position
  // counts toward the slot cap exactly as today → runtime byte-identical. 1 = arm the
  // +1.5R-BE slot-ghost (slot freed at zero dollar risk; IBKR gross/margin unchanged).
  // Owner-only flip after G-S1 tests pass. Build != arm.
  ghostSlotsEnabled:   tinyint("ghostSlotsEnabled").notNull().default(0),
  // ── Phoenix Protocol (2026-06-29, §6) — INERT BY DEFAULT ──
  // 0 = OFF (DEFAULT): the Wide-Lung eligibility write and the isolated 5m watcher both
  // early-return on the flag → no phoenixLedger row is ever written and no re-entry is
  // ever attempted → runtime byte-identical. 1 = arm same-day breakout re-entry (5m
  // reclaim, DB-persisted anti-loop, 1%-recalc sizing, origin-qty cap). Owner-only flip.
  phoenixProtocolEnabled: tinyint("phoenixProtocolEnabled").notNull().default(0),
  phoenixMaxPerDay:    int("phoenixMaxPerDay").notNull().default(3),        // ≤N phoenix re-entries / account / day
  phoenix5mPollSec:    int("phoenix5mPollSec").notNull().default(60),       // watcher cadence (seconds)
  phoenixQtyCapMult:   double("phoenixQtyCapMult").notNull().default(1.25), // re-entry qty ≤ originQty × this
  // ── THE WAITER — retest resting-limit system (2026-06-30, §7) — INERT BY DEFAULT ──
  // 0 = OFF (DEFAULT): the Waiter tick early-returns before ANY candidate load / order /
  // DB write / extra fetch; the war cycle's R1 skip and ibkrSync's Waiter reconcile are
  // no-ops → runtime byte-identical. 1 = arm managed resting-LMT retest entries (1%-risk,
  // wideLungSL stop, Golden ladder exits — only the entry mechanism changes). Owner-only.
  waiterEnabled:       tinyint("waiterEnabled").notNull().default(0),
  // maxRetestSlots — # of concurrent resting/open retests (open + pending_entry LMTs),
  // counted atomically under the shared entrySlotLock. The 30% sleeve is the harder bound.
  maxRetestSlots:      int("maxRetestSlots").notNull().default(8),
  // waiterNlvPct — HARD SUB-CAP within the shared budget+_optimisticBP (NOT a separate
  // additive sleeve): Σ(open-retest value + resting-retest-LMT notional) + thisOrder ≤ pct×NLV.
  waiterNlvPct:        double("waiterNlvPct").notNull().default(0.30),
  // ── Entry Churn Guard (2026-07-01, entry-churn-min-r spec) — INERT BY DEFAULT ──
  // 0 = OFF (DEFAULT): warEngine builds NO churn ledger (zero extra DB reads), the
  // long/short blocked sets stay empty, and tryLiveEntry's churn check is a no-op →
  // runtime byte-identical. 1 = arm: ≤1 automated entry / ticker / Israel calendar day
  // (C1) + a churnCooldownMin cooldown after ANY close (C2, incl. MANUAL_CLOSE/SL/EOD).
  // The Waiter retest pipeline is EXEMPT (managed re-entry, not churn). Manual entries
  // (MANUAL_%) are NOT blocked in v1. Owner-only flip. Build != arm.
  entryChurnGuardEnabled: tinyint("entryChurnGuardEnabled").notNull().default(0),
  churnCooldownMin:    int("churnCooldownMin").notNull().default(90),   // C2: minutes after any close before re-entry
  // ── MIN_R_PCT gate (2026-07-01) — INERT BY DEFAULT ──
  // 0 = OFF (DEFAULT) or minRValuePct<=0: the geometry gate is skipped → byte-identical.
  // 1 = arm: skip an entry when |entry−stop|/entry < minRValuePct (the too-tight scalp
  // that RC-2's MAX_STRUCTURAL_RISK_PCT=0.12 max does NOT catch). Enforced in tryLiveEntry
  // (the SSOT covering War + manual + alert). Owner-only flip. Build != arm.
  minRValuePctEnabled: tinyint("minRValuePctEnabled").notNull().default(0),
  minRValuePct:        double("minRValuePct").notNull().default(0.015),  // 1.5% min risk-per-share floor
  updatedAt:           timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type LiveEngineConfig = typeof liveEngineConfig.$inferSelect;
export type InsertLiveEngineConfig = typeof liveEngineConfig.$inferInsert;

// ── Kronos Conviction Cache ───────────────────────────────────────────────────
// Per-ticker entry-conviction addon written by the hourly kronosConvictionJob.
// The War Engine entry path ONLY reads this (never spawns kronos). One row/ticker.
// SEPARATE from the legacy [-2,+2] catalogue bias on userAssets (kronosBias etc.) —
// different scale, semantics, staleness window and owner (do not merge).
export const kronosConvictionCache = mysqlTable("kronosConvictionCache", {
  id:           int("id").autoincrement().primaryKey(),
  ticker:       varchar("ticker", { length: 16 }).notNull(),
  direction:    varchar("direction", { length: 8 }).notNull(),       // UP | DOWN | FLAT (kronos forecast direction)
  addon:        double("addon").notNull().default(0),                // 0.0 .. 2.5 (quant-mapped conviction addon, full precision)
  rawForecastPct: double("rawForecastPct"),                          // audit: signed pct_change from kronos JSON
  bandWidthPct: double("bandWidthPct"),                              // audit: FULL 95% band width % (from kronos JSON, not halved)
  computedAt:   timestamp("computedAt").defaultNow().notNull(),      // staleness anchor (>kronosStalenessMin → addon decays to 0)
}, (t) => ({
  tickerIdx: uniqueIndex("kronos_conv_ticker_idx").on(t.ticker),
}));
export type KronosConvictionCache = typeof kronosConvictionCache.$inferSelect;
export type InsertKronosConvictionCache = typeof kronosConvictionCache.$inferInsert;

// ── Live Engine Entry Lock (single-flight per ticker) ─────────────────────────
export const liveEntryLock = mysqlTable("liveEntryLock", {
  id:         int("id").autoincrement().primaryKey(),
  userId:     int("userId").notNull(),
  ticker:     varchar("ticker", { length: 16 }).notNull(),
  positionId: int("positionId"),
  createdAt:  timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  uniqueUserTicker: uniqueIndex("liveEntryLock_userId_ticker_uniq").on(t.userId, t.ticker),
}));
export type LiveEntryLock = typeof liveEntryLock.$inferSelect;

// ── Elza Live Engine — Trades Log ─────────────────────────────────────────────
export const liveTrades = mysqlTable("liveTrades", {
  id:            int("id").autoincrement().primaryKey(),
  userId:        int("userId").notNull(),
  positionId:    int("positionId").notNull(),
  ticker:        varchar("ticker", { length: 16 }).notNull(),
  side:          mysqlEnum("side", ["BUY", "SELL"]).notNull(),
  units:         int("units").notNull(),
  price:         double("price").notNull(),
  reason:        varchar("reason", { length: 64 }),
  ibkrOrderId:   varchar("ibkrOrderId", { length: 64 }),
  status:        mysqlEnum("status", ["filled", "failed", "partial"]).notNull().default("filled"),
  executedAt:    timestamp("executedAt").defaultNow().notNull(),
});
export type LiveTrade = typeof liveTrades.$inferSelect;
export type InsertLiveTrade = typeof liveTrades.$inferInsert;
