/**
 * Portfolio Router — Real Portfolio Management
 * Holdings CRUD, live price refresh, capital management (deposit/withdraw),
 * and AI-powered Analyze engine that uses the Ziv trading model.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, publicProcedure, adminProcedure, router } from "../_core/trpc";
import {
  addCapitalEvent,
  addPortfolioHolding,
  addTradingDiaryEntry,
  deletePortfolioHolding,
  deleteTradingDiaryEntry,
  getCapitalEvents,
  getDb,
  getLatestPortfolioAnalysis,
  getPortfolioAccount,
  getPortfolioHoldings,
  getTradingDiaryEntries,
  getUserAssets,
  savePortfolioAnalysis,
  updatePortfolioHolding,
  updatePortfolioHoldingPrice,
  updatePortfolioHoldingScore,
  updatePortfolioHoldingLabFields,
  updateTradingDiaryEntry,
  updateUserAssetScore,
  upsertPortfolioAccount,
  bulkReplaceUserAssets,
  upsertUserAsset,
  archiveUserAssets,
  restoreUserAssets,
  getArchivedUserAssets,
  bulkDeleteUserAssets,
  upsertHoldingAlert,
  deleteHoldingSLAlert,
  deleteAllAlertsForTicker,
  upsertCatalogueAlert,
  getDeepAnalysisCache,
  setDeepAnalysisCache,
  saveChatMessage,
  getChatHistory,
  logJournalEvent,
  getJournalEvents,
  getPortfolioSnapshotsAll,
  getTodaySnapshot,
  upsertPortfolioSnapshot,
  upsertDiaryOnBuy,
  updateDiaryOnSell,
  getDailyPositionChanges,
} from "../db";
import { invokeLLM } from "../_core/llm";
import { calcEMA, calcZivEngineScore, calcZivHScore } from "../zivEngine";
import { runNightlySlResync } from "./nightlySlResync";
import { calcSlTp, calcHoldingSlTp, calcDynamicSlTp, calcEntrySlTp, ema50FromBars } from "../slCalculator";
import { fetchLivePrice, fetchBarsForTicker, fetchLivePricesBatch, fetchIbkrLivePricesBatch, fetchBarsBatch, getUsdIlsRate, normalizeBarsForTicker, isCryptoTicker, type Bar } from "../marketData";
import { normalizeBarsForTicker as normalizeBarsForTickerFx } from "../services/PriceService";
import { positionValue as calcPositionValue } from "../services/PortfolioValueService";
import {
  buildDeepAnalysisMeta,
  buildDeepAnalysisPrompt,
  DEEP_ANALYSIS_SYSTEM_PROMPT,
  ELZA_MAX_LONG,
  ELZA_MAX_SHORT,
} from "../deepAnalysisMeta";
import { log } from "../logger";
import { swrGet, swrInvalidate } from "../swrCache";
import { computeCompositeScore } from "../kronosEngine";
import { getSelectedTeamSet } from "../selectedTeam";

/** NYSE trading hours guard: Mon–Fri 09:30–16:00 ET */
function isNyseOpen(): boolean {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const month = now.getUTCMonth();
  const etOffsetHours = month >= 2 && month <= 10 ? 4 : 5;
  const etMinutes = (now.getUTCHours() - etOffsetHours) * 60 + now.getUTCMinutes();
  return etMinutes >= 9 * 60 + 30 && etMinutes < 16 * 60;
}

// ─── In-memory cache for ZIV H scores (5-minute TTL per user) ──────────────────
const ZIVH_CACHE_TTL_MS = 5 * 60 * 1000;
const _zivHCache = new Map<string, { data: unknown[]; ts: number }>();
const _zivH2Cache = new Map<string, { data: unknown[]; ts: number }>();

function getZivHFromCache(userId: number): unknown[] | null {
  const entry = _zivHCache.get(String(userId));
  if (!entry) return null;
  if (Date.now() - entry.ts > ZIVH_CACHE_TTL_MS) { _zivHCache.delete(String(userId)); return null; }
  return entry.data;
}
function setZivHCache(userId: number, data: unknown[]) {
  _zivHCache.set(String(userId), { data, ts: Date.now() });
}
function getZivH2FromCache(userId: number): unknown[] | null {
  const entry = _zivH2Cache.get(String(userId));
  if (!entry) return null;
  if (Date.now() - entry.ts > ZIVH_CACHE_TTL_MS) { _zivH2Cache.delete(String(userId)); return null; }
  return entry.data;
}
function setZivH2Cache(userId: number, data: unknown[]) {
  _zivH2Cache.set(String(userId), { data, ts: Date.now() });
}
/** Invalidate ZIV H caches for a user (call after holdings change) */
export function invalidateZivHCache(userId: number) {
  _zivHCache.delete(String(userId));
  _zivH2Cache.delete(String(userId));
}

// ─── Default 60-Asset Catalogue (seeded for every new user) ─────────────────
// ── Default Catalogue — 214 USA stocks (Ziv/Micha watchlist + core universe) ──
export const DEFAULT_60_ASSETS: { ticker: string; companyName: string; sector: string; sortOrder: number }[] = [
  // Semiconductors
  { ticker: "TSM",  companyName: "TSMC",                    sector: "Semiconductors", sortOrder: 1 },
  { ticker: "AVGO", companyName: "Broadcom",                sector: "Semiconductors", sortOrder: 2 },
  { ticker: "NVDA", companyName: "NVIDIA",                  sector: "Semiconductors", sortOrder: 3 },
  { ticker: "MU",   companyName: "Micron Technology",       sector: "Semiconductors", sortOrder: 4 },
  { ticker: "ALAB", companyName: "Astera Labs",             sector: "Semiconductors", sortOrder: 5 },
  { ticker: "AMD",  companyName: "Advanced Micro Devices",  sector: "Semiconductors", sortOrder: 6 },
  { ticker: "MRVL", companyName: "Marvell Technology",      sector: "Semiconductors", sortOrder: 7 },
  { ticker: "ARM",  companyName: "Arm Holdings",            sector: "Semiconductors", sortOrder: 8 },
  { ticker: "INTC", companyName: "Intel",                   sector: "Semiconductors", sortOrder: 9 },
  { ticker: "QCOM", companyName: "Qualcomm",                sector: "Semiconductors", sortOrder: 10 },
  { ticker: "SMCI", companyName: "Super Micro Computer",    sector: "Semiconductors", sortOrder: 11 },
  { ticker: "LRCX", companyName: "Lam Research",            sector: "Semiconductors", sortOrder: 12 },
  { ticker: "KLAC", companyName: "KLA Corporation",         sector: "Semiconductors", sortOrder: 13 },
  // Technology
  { ticker: "AAPL", companyName: "Apple",                   sector: "Technology",     sortOrder: 14 },
  { ticker: "MSFT", companyName: "Microsoft",               sector: "Technology",     sortOrder: 15 },
  { ticker: "META", companyName: "Meta Platforms",          sector: "Technology",     sortOrder: 16 },
  { ticker: "GOOGL",companyName: "Alphabet",                sector: "Technology",     sortOrder: 17 },
  { ticker: "AMZN", companyName: "Amazon",                  sector: "Technology",     sortOrder: 18 },
  { ticker: "NOW",  companyName: "ServiceNow",              sector: "Technology",     sortOrder: 19 },
  { ticker: "ORCL", companyName: "Oracle",                  sector: "Technology",     sortOrder: 20 },
  { ticker: "CRM",  companyName: "Salesforce",              sector: "Technology",     sortOrder: 21 },
  { ticker: "UBER", companyName: "Uber Technologies",       sector: "Technology",     sortOrder: 22 },
  { ticker: "ABNB", companyName: "Airbnb",                  sector: "Technology",     sortOrder: 23 },
  { ticker: "DASH", companyName: "DoorDash",                sector: "Technology",     sortOrder: 24 },
  { ticker: "RBLX", companyName: "Roblox",                  sector: "Technology",     sortOrder: 25 },
  // AI / Data
  { ticker: "PLTR", companyName: "Palantir",                sector: "AI / Data",      sortOrder: 26 },
  { ticker: "APP",  companyName: "AppLovin",                sector: "AI / Data",      sortOrder: 27 },
  { ticker: "SOUN", companyName: "SoundHound AI",           sector: "AI / Data",      sortOrder: 28 },
  { ticker: "AI",   companyName: "C3.ai",                   sector: "AI / Data",      sortOrder: 29 },
  { ticker: "BBAI", companyName: "BigBear.ai",              sector: "AI / Data",      sortOrder: 30 },
  { ticker: "GFAI", companyName: "Guardforce AI",           sector: "AI / Data",      sortOrder: 31 },
  // Crypto / Fin
  { ticker: "COIN", companyName: "Coinbase",                sector: "Crypto / Fin",   sortOrder: 32 },
  { ticker: "MSTR", companyName: "MicroStrategy",           sector: "Crypto / Fin",   sortOrder: 33 },
  { ticker: "MARA", companyName: "Marathon Digital",        sector: "Crypto / Fin",   sortOrder: 34 },
  { ticker: "HOOD", companyName: "Robinhood Markets",       sector: "Crypto / Fin",   sortOrder: 35 },
  { ticker: "PYPL", companyName: "PayPal Holdings",         sector: "Crypto / Fin",   sortOrder: 36 },
  { ticker: "CLSK", companyName: "CleanSpark",              sector: "Crypto / Fin",   sortOrder: 37 },
  { ticker: "RIOT", companyName: "Riot Platforms",          sector: "Crypto / Fin",   sortOrder: 38 },
  // Finance
  { ticker: "JPM",  companyName: "JPMorgan Chase",          sector: "Finance",        sortOrder: 39 },
  { ticker: "GS",   companyName: "Goldman Sachs",           sector: "Finance",        sortOrder: 40 },
  { ticker: "V",    companyName: "Visa",                    sector: "Finance",        sortOrder: 41 },
  { ticker: "MA",   companyName: "Mastercard",              sector: "Finance",        sortOrder: 42 },
  { ticker: "SOFI", companyName: "SoFi Technologies",       sector: "Finance",        sortOrder: 43 },
  { ticker: "UPST", companyName: "Upstart Holdings",        sector: "Finance",        sortOrder: 44 },
  // Healthcare
  { ticker: "LLY",  companyName: "Eli Lilly",               sector: "Healthcare",     sortOrder: 45 },
  { ticker: "HIMS", companyName: "Hims & Hers Health",      sector: "Healthcare",     sortOrder: 46 },
  { ticker: "CELH", companyName: "Celsius Holdings",        sector: "Healthcare",     sortOrder: 47 },
  { ticker: "RXRX", companyName: "Recursion Pharmaceuticals",sector: "Healthcare",    sortOrder: 48 },
  { ticker: "TLRY", companyName: "Tilray Brands",           sector: "Healthcare",     sortOrder: 49 },
  // EV / Auto
  { ticker: "TSLA", companyName: "Tesla",                   sector: "EV / Auto",      sortOrder: 50 },
  { ticker: "RIVN", companyName: "Rivian Automotive",       sector: "EV / Auto",      sortOrder: 51 },
  { ticker: "LCID", companyName: "Lucid Group",             sector: "EV / Auto",      sortOrder: 52 },
  { ticker: "NIO",  companyName: "NIO Inc.",                sector: "EV / Auto",      sortOrder: 53 },
  { ticker: "XPEV", companyName: "XPeng",                   sector: "EV / Auto",      sortOrder: 54 },
  { ticker: "LI",   companyName: "Li Auto",                 sector: "EV / Auto",      sortOrder: 55 },
  // Space
  { ticker: "RKLB", companyName: "Rocket Lab USA",          sector: "Space",          sortOrder: 56 },
  { ticker: "LUNR", companyName: "Intuitive Machines",      sector: "Space",          sortOrder: 57 },
  { ticker: "ASTS", companyName: "AST SpaceMobile",         sector: "Space",          sortOrder: 58 },
  { ticker: "ACHR", companyName: "Archer Aviation",         sector: "Space",          sortOrder: 59 },
  // Defense Tech
  { ticker: "AXON", companyName: "Axon Enterprise",         sector: "Defense Tech",   sortOrder: 60 },
  { ticker: "KTOS", companyName: "Kratos Defense",          sector: "Defense Tech",   sortOrder: 61 },
  { ticker: "CACI", companyName: "CACI International",      sector: "Defense Tech",   sortOrder: 62 },
  // Quantum
  { ticker: "IONQ", companyName: "IonQ",                    sector: "Quantum",        sortOrder: 63 },
  { ticker: "QUBT", companyName: "Quantum Computing Inc.",  sector: "Quantum",        sortOrder: 64 },
  { ticker: "RGTI", companyName: "Rigetti Computing",       sector: "Quantum",        sortOrder: 65 },
  { ticker: "QBTS", companyName: "D-Wave Quantum",          sector: "Quantum",        sortOrder: 66 },
  // Energy / Nuclear
  { ticker: "CEG",  companyName: "Constellation Energy",    sector: "Nuclear",        sortOrder: 67 },
  { ticker: "VST",  companyName: "Vistra Corp",             sector: "Energy",         sortOrder: 68 },
  { ticker: "NRG",  companyName: "NRG Energy",              sector: "Energy",         sortOrder: 69 },
  { ticker: "FSLR", companyName: "First Solar",             sector: "Energy",         sortOrder: 70 },
  { ticker: "ENPH", companyName: "Enphase Energy",          sector: "Energy",         sortOrder: 71 },
  // Industrials
  { ticker: "CAT",  companyName: "Caterpillar",             sector: "Industrials",    sortOrder: 72 },
  { ticker: "GE",   companyName: "GE Aerospace",            sector: "Industrials",    sortOrder: 73 },
  { ticker: "HON",  companyName: "Honeywell",               sector: "Industrials",    sortOrder: 74 },
  { ticker: "DE",   companyName: "Deere & Co.",             sector: "Industrials",    sortOrder: 75 },
  // Defense
  { ticker: "RTX",  companyName: "RTX Corporation",         sector: "Defense",        sortOrder: 76 },
  { ticker: "LMT",  companyName: "Lockheed Martin",         sector: "Defense",        sortOrder: 77 },
  { ticker: "NOC",  companyName: "Northrop Grumman",        sector: "Defense",        sortOrder: 78 },
  { ticker: "BA",   companyName: "Boeing",                  sector: "Defense",        sortOrder: 79 },
  // Media
  { ticker: "NFLX", companyName: "Netflix",                 sector: "Media",          sortOrder: 80 },
  { ticker: "SPOT", companyName: "Spotify",                 sector: "Media",          sortOrder: 81 },
  { ticker: "DIS",  companyName: "Walt Disney",             sector: "Media",          sortOrder: 82 },
  { ticker: "WBD",  companyName: "Warner Bros. Discovery",  sector: "Media",          sortOrder: 83 },
  // Social Media
  { ticker: "RDDT", companyName: "Reddit",                  sector: "Social Media",   sortOrder: 84 },
  { ticker: "SNAP", companyName: "Snap Inc.",               sector: "Social Media",   sortOrder: 85 },
  { ticker: "PINS", companyName: "Pinterest",               sector: "Social Media",   sortOrder: 86 },
  // Cybersecurity
  { ticker: "CRWD", companyName: "CrowdStrike",             sector: "Cybersecurity",  sortOrder: 87 },
  { ticker: "PANW", companyName: "Palo Alto Networks",      sector: "Cybersecurity",  sortOrder: 88 },
  { ticker: "S",    companyName: "SentinelOne",             sector: "Cybersecurity",  sortOrder: 89 },
  { ticker: "FTNT", companyName: "Fortinet",                sector: "Cybersecurity",  sortOrder: 90 },
  { ticker: "ZS",   companyName: "Zscaler",                 sector: "Cybersecurity",  sortOrder: 91 },
  // SaaS
  { ticker: "DDOG", companyName: "Datadog",                 sector: "SaaS",           sortOrder: 92 },
  { ticker: "NET",  companyName: "Cloudflare",              sector: "SaaS",           sortOrder: 93 },
  { ticker: "SNOW", companyName: "Snowflake",               sector: "SaaS",           sortOrder: 94 },
  { ticker: "MDB",  companyName: "MongoDB",                 sector: "SaaS",           sortOrder: 95 },
  { ticker: "TWLO", companyName: "Twilio",                  sector: "SaaS",           sortOrder: 96 },
  { ticker: "ZM",   companyName: "Zoom Video",              sector: "SaaS",           sortOrder: 97 },
  // E-Commerce
  { ticker: "SHOP", companyName: "Shopify",                 sector: "E-Commerce",     sortOrder: 98 },
  { ticker: "ETSY", companyName: "Etsy",                    sector: "E-Commerce",     sortOrder: 99 },
  { ticker: "WISH", companyName: "ContextLogic",            sector: "E-Commerce",     sortOrder: 100 },
  // Shipping
  { ticker: "ZIM",  companyName: "ZIM Integrated Shipping", sector: "Shipping",       sortOrder: 101 },
  { ticker: "MATX", companyName: "Matson Inc.",             sector: "Shipping",       sortOrder: 102 },
  // EdTech
  { ticker: "DUOL", companyName: "Duolingo",                sector: "EdTech",         sortOrder: 103 },
  { ticker: "COUR", companyName: "Coursera",                sector: "EdTech",         sortOrder: 104 },
  { ticker: "CHGG", companyName: "Chegg",                   sector: "EdTech",         sortOrder: 105 },
  // Ad Tech
  { ticker: "TTD",  companyName: "The Trade Desk",          sector: "Ad Tech",        sortOrder: 106 },
  { ticker: "IAS",  companyName: "Integral Ad Science",     sector: "Ad Tech",        sortOrder: 107 },
  // Fintech
  { ticker: "AFRM", companyName: "Affirm Holdings",         sector: "Fintech",        sortOrder: 108 },
  { ticker: "BILL", companyName: "Bill Holdings",           sector: "Fintech",        sortOrder: 109 },
  { ticker: "RELY", companyName: "Remitly Global",          sector: "Fintech",        sortOrder: 110 },
  // Healthcare / Biotech Extra
  { ticker: "MRNA", companyName: "Moderna",                 sector: "Healthcare",     sortOrder: 111 },
  { ticker: "BNTX", companyName: "BioNTech",               sector: "Healthcare",     sortOrder: 112 },
  { ticker: "NVAX", companyName: "Novavax",                 sector: "Healthcare",     sortOrder: 113 },
  { ticker: "SGEN", companyName: "Seagen",                  sector: "Healthcare",     sortOrder: 114 },
  // Mag-7 extras
  { ticker: "NDAQ", companyName: "Nasdaq Inc.",             sector: "Finance",        sortOrder: 115 },
  { ticker: "CME",  companyName: "CME Group",               sector: "Finance",        sortOrder: 116 },
  // Mining / Commodities
  { ticker: "MP",   companyName: "MP Materials",            sector: "Industrials",    sortOrder: 117 },
  { ticker: "VALE", companyName: "Vale S.A.",               sector: "Industrials",    sortOrder: 118 },
  { ticker: "FCX",  companyName: "Freeport-McMoRan",        sector: "Industrials",    sortOrder: 119 },
  // China Tech
  { ticker: "BABA", companyName: "Alibaba Group",           sector: "Technology",     sortOrder: 120 },
  { ticker: "JD",   companyName: "JD.com",                  sector: "Technology",     sortOrder: 121 },
  { ticker: "BIDU", companyName: "Baidu",                   sector: "Technology",     sortOrder: 122 },
  { ticker: "PDD",  companyName: "PDD Holdings",            sector: "Technology",     sortOrder: 123 },
  // Retail
  { ticker: "COST", companyName: "Costco",                  sector: "Technology",     sortOrder: 124 },
  { ticker: "WMT",  companyName: "Walmart",                 sector: "Technology",     sortOrder: 125 },
  { ticker: "TGT",  companyName: "Target",                  sector: "Technology",     sortOrder: 126 },
  // REITs / Other
  { ticker: "AMT",  companyName: "American Tower",          sector: "Technology",     sortOrder: 127 },
  { ticker: "EQIX", companyName: "Equinix",                 sector: "Technology",     sortOrder: 128 },
  // More popular watchlist
  { ticker: "NVDL", companyName: "GraniteShares 2x NVDA",  sector: "Semiconductors", sortOrder: 129 },
  { ticker: "TQQQ", companyName: "ProShares UltraPro QQQ", sector: "Technology",     sortOrder: 130 },
  { ticker: "SQQQ", companyName: "ProShares UltraPro Short QQQ", sector: "Technology", sortOrder: 131 },
  { ticker: "SPXL", companyName: "Direxion Daily S&P500 Bull 3X", sector: "Technology", sortOrder: 132 },
  { ticker: "LABU", companyName: "Direxion Daily S&P Biotech Bull 3X", sector: "Healthcare", sortOrder: 133 },
  { ticker: "SOXL", companyName: "Direxion Daily Semi Bull 3X",  sector: "Semiconductors", sortOrder: 134 },
  // Additional growth stocks from Ziv/Micha catalog
  { ticker: "ROKU", companyName: "Roku",                    sector: "Media",          sortOrder: 135 },
  { ticker: "DKNG", companyName: "DraftKings",              sector: "Technology",     sortOrder: 136 },
  { ticker: "U",    companyName: "Unity Software",          sector: "Technology",     sortOrder: 137 },
  { ticker: "PATH", companyName: "UiPath",                  sector: "AI / Data",      sortOrder: 138 },
  { ticker: "IOT",  companyName: "Samsara",                 sector: "AI / Data",      sortOrder: 139 },
  { ticker: "GTLB", companyName: "GitLab",                  sector: "SaaS",           sortOrder: 140 },
  { ticker: "CFLT", companyName: "Confluent",               sector: "SaaS",           sortOrder: 141 },
  { ticker: "HUBS", companyName: "HubSpot",                 sector: "SaaS",           sortOrder: 142 },
  { ticker: "DOCN", companyName: "DigitalOcean",            sector: "SaaS",           sortOrder: 143 },
  { ticker: "CWAN", companyName: "Clearwater Analytics",    sector: "Fintech",        sortOrder: 144 },
  { ticker: "TASK", companyName: "TaskUs",                  sector: "Technology",     sortOrder: 145 },
  { ticker: "OPEN", companyName: "Opendoor Technologies",   sector: "Technology",     sortOrder: 146 },
  { ticker: "JOBY", companyName: "Joby Aviation",           sector: "Space",          sortOrder: 147 },
  { ticker: "LILM", companyName: "Lilium",                  sector: "Space",          sortOrder: 148 },
  { ticker: "STEM", companyName: "Stem Inc.",               sector: "Energy",         sortOrder: 149 },
  { ticker: "ARRY", companyName: "Array Technologies",      sector: "Energy",         sortOrder: 150 },
  { ticker: "BE",   companyName: "Bloom Energy",            sector: "Energy",         sortOrder: 151 },
  { ticker: "SPWR", companyName: "SunPower",                sector: "Energy",         sortOrder: 152 },
  { ticker: "WOLF", companyName: "Wolfspeed",               sector: "Semiconductors", sortOrder: 153 },
  { ticker: "ON",   companyName: "ON Semiconductor",        sector: "Semiconductors", sortOrder: 154 },
  { ticker: "SWKS", companyName: "Skyworks Solutions",      sector: "Semiconductors", sortOrder: 155 },
  { ticker: "MPWR", companyName: "Monolithic Power Systems",sector: "Semiconductors", sortOrder: 156 },
  { ticker: "MTSI", companyName: "MACOM Technology",        sector: "Semiconductors", sortOrder: 157 },
  { ticker: "AEHR", companyName: "Aehr Test Systems",       sector: "Semiconductors", sortOrder: 158 },
  { ticker: "NVMI", companyName: "Nova Ltd",                sector: "Semiconductors", sortOrder: 159 },
  { ticker: "CRUS", companyName: "Cirrus Logic",            sector: "Semiconductors", sortOrder: 160 },
  { ticker: "ALGM", companyName: "Allegro MicroSystems",    sector: "Semiconductors", sortOrder: 161 },
  { ticker: "ACLS", companyName: "Axcelis Technologies",    sector: "Semiconductors", sortOrder: 162 },
  // Expansion batch — 20 USA growth/momentum (Jun 2026)
  { ticker: "AMAT", companyName: "Applied Materials",       sector: "Semiconductors", sortOrder: 163 },
  { ticker: "TTMI", companyName: "TTM Technologies",        sector: "Semiconductors", sortOrder: 164 },
  { ticker: "GEV",  companyName: "GE Vernova",              sector: "Energy",         sortOrder: 165 },
  { ticker: "ASML", companyName: "ASML Holding",            sector: "Semiconductors", sortOrder: 166 },
  { ticker: "TER",  companyName: "Teradyne",                sector: "Semiconductors", sortOrder: 167 },
  { ticker: "ENTG", companyName: "Entegris",                sector: "Semiconductors", sortOrder: 168 },
  { ticker: "CCJ",  companyName: "Cameco",                  sector: "Nuclear",        sortOrder: 169 },
  { ticker: "ETN",  companyName: "Eaton Corporation",       sector: "Industrials",    sortOrder: 170 },
  { ticker: "ANET", companyName: "Arista Networks",         sector: "AI / Data",      sortOrder: 171 },
  { ticker: "VRT",  companyName: "Vertiv Holdings",         sector: "AI / Data",      sortOrder: 172 },
  { ticker: "TTWO", companyName: "Take-Two Interactive",    sector: "Media",          sortOrder: 173 },
  { ticker: "XYZ",  companyName: "Block Inc.",              sector: "Fintech",        sortOrder: 174 },
  { ticker: "CRSP", companyName: "CRISPR Therapeutics",     sector: "Healthcare",     sortOrder: 175 },
  { ticker: "COHR", companyName: "Coherent Corp.",          sector: "Semiconductors", sortOrder: 176 },
  { ticker: "RMBS", companyName: "Rambus",                  sector: "Semiconductors", sortOrder: 177 },
  { ticker: "CYBR", companyName: "CyberArk Software",       sector: "Cybersecurity",  sortOrder: 178 },
  { ticker: "NU",   companyName: "Nu Holdings",             sector: "Fintech",        sortOrder: 179 },
  { ticker: "TOST", companyName: "Toast Inc.",              sector: "Fintech",        sortOrder: 180 },
  { ticker: "URI",  companyName: "United Rentals",          sector: "Industrials",    sortOrder: 181 },
  { ticker: "MELI", companyName: "MercadoLibre",            sector: "E-Commerce",     sortOrder: 182 },
  // Expansion batch — 32 USA stocks (Jun 2026)
  // Nuclear
  { ticker: "OKLO", companyName: "Oklo",                    sector: "Nuclear",        sortOrder: 183 },
  { ticker: "SMR",  companyName: "NuScale Power",           sector: "Nuclear",        sortOrder: 184 },
  { ticker: "UUUU", companyName: "Energy Fuels",            sector: "Nuclear",        sortOrder: 185 },
  // Crypto / Fin
  { ticker: "CORZ", companyName: "Core Scientific",         sector: "Crypto / Fin",   sortOrder: 186 },
  { ticker: "HUT",  companyName: "Hut 8",                   sector: "Crypto / Fin",   sortOrder: 187 },
  { ticker: "WULF", companyName: "TeraWulf",                sector: "Crypto / Fin",   sortOrder: 188 },
  // Defense Tech
  { ticker: "AVAV", companyName: "AeroVironment",           sector: "Defense Tech",   sortOrder: 189 },
  { ticker: "BWXT", companyName: "BWX Technologies",        sector: "Defense Tech",   sortOrder: 190 },
  { ticker: "RCAT", companyName: "Red Cat Holdings",        sector: "Defense Tech",   sortOrder: 191 },
  // Semiconductors
  { ticker: "LSCC", companyName: "Lattice Semiconductor",   sector: "Semiconductors", sortOrder: 192 },
  { ticker: "NXPI", companyName: "NXP Semiconductors",      sector: "Semiconductors", sortOrder: 193 },
  { ticker: "AMBA", companyName: "Ambarella",               sector: "Semiconductors", sortOrder: 194 },
  // Healthcare
  { ticker: "VKTX", companyName: "Viking Therapeutics",     sector: "Healthcare",     sortOrder: 195 },
  { ticker: "ALNY", companyName: "Alnylam Pharmaceuticals", sector: "Healthcare",     sortOrder: 196 },
  { ticker: "IOVA", companyName: "Iovance Biotherapeutics", sector: "Healthcare",     sortOrder: 197 },
  { ticker: "ROIV", companyName: "Roivant Sciences",        sector: "Healthcare",     sortOrder: 198 },
  { ticker: "TEM",  companyName: "Tempus AI",               sector: "Healthcare",     sortOrder: 199 },
  { ticker: "TWST", companyName: "Twist Bioscience",        sector: "Healthcare",     sortOrder: 200 },
  // AI / Data
  { ticker: "SYM",  companyName: "Symbotic",                sector: "AI / Data",      sortOrder: 201 },
  { ticker: "RBRK", companyName: "Rubrik",                  sector: "AI / Data",      sortOrder: 202 },
  { ticker: "DV",   companyName: "DoubleVerify",            sector: "AI / Data",      sortOrder: 203 },
  // Space
  { ticker: "RDW",  companyName: "Redwire",                 sector: "Space",          sortOrder: 204 },
  { ticker: "IRDM", companyName: "Iridium Communications",sector: "Space",          sortOrder: 205 },
  // Media
  { ticker: "PENN", companyName: "PENN Entertainment",      sector: "Media",          sortOrder: 206 },
  { ticker: "GENI", companyName: "Genius Sports",           sector: "Media",          sortOrder: 207 },
  // Fintech
  { ticker: "FOUR", companyName: "Shift4 Payments",           sector: "Fintech",        sortOrder: 208 },
  { ticker: "GLBE", companyName: "Global-e Online",         sector: "Fintech",        sortOrder: 209 },
  { ticker: "LC",   companyName: "LendingClub",             sector: "Fintech",        sortOrder: 210 },
  // Industrials
  { ticker: "STRL", companyName: "Sterling Infrastructure", sector: "Industrials",    sortOrder: 211 },
  { ticker: "FIX",  companyName: "Comfort Systems USA",     sector: "Industrials",    sortOrder: 212 },
  // Technology
  { ticker: "GLOB", companyName: "Globant",                 sector: "Technology",     sortOrder: 213 },
  // EV / Auto
  { ticker: "VFS",  companyName: "VinFast Auto",            sector: "EV / Auto",      sortOrder: 214 },
];

// ─── Router ───────────────────────────────────────────────────────────────────
export const portfolioRouter = router({

  // ── Get full portfolio state ──────────────────────────────────────────────
  getState: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    return swrGet(
      `portfolio:state:${userId}`,
      15_000, // TTL 15s — Live Prices (IBKR)
      async () => {
        const [account, holdings, events] = await Promise.all([
          getPortfolioAccount(userId),
          getPortfolioHoldings(userId),
          getCapitalEvents(userId, 20),
        ]);
        return { account, holdings, events };
      },
    );
  }),

  // ── Add holding ───────────────────────────────────────────────────────────
  addHolding: protectedProcedure
    .input(z.object({
      ticker: z.string().min(1).max(16).toUpperCase(),
      buyPrice: z.number().positive(),
      units: z.number().positive(),
      notes: z.string().optional(),
      transactionDate: z.string().optional(), // YYYY-MM-DD
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      // Fetch live price + company name
      const live = await fetchLivePrice(input.ticker);
      // Compute Ziv score at buy time for delta tracking
      let buyScore: number | null = null;
      let buyEntryTier: string | null = null;
      try {
        const rawBars0 = await fetchBarsForTicker(input.ticker);
        const bars0 = normalizeBarsForTicker(input.ticker, rawBars0);
        if (bars0.length >= 50) {
          const ziv = calcZivEngineScore(bars0);
          buyScore = ziv.score;
          buyEntryTier = ziv.tier;
        }
      } catch { /* non-blocking */ }

      // Check if ticker already exists - if so, merge (weighted avg buy price + sum units)
      const existingHoldings = await getPortfolioHoldings(userId);
      const existing = existingHoldings.find(h => h.ticker.toUpperCase() === input.ticker.toUpperCase());
      if (existing) {
        const totalUnits = Number(existing.units) + input.units;
        const weightedBuyPrice = (Number(existing.buyPrice) * Number(existing.units) + input.buyPrice * input.units) / totalUnits;
        await updatePortfolioHolding(existing.id, userId, {
          units: totalUnits,
          buyPrice: weightedBuyPrice,
          notes: input.notes ?? existing.notes ?? null,
        });
        // Deduct purchase cost from cash balance
        const cost = input.buyPrice * input.units;
        const account = await getPortfolioAccount(userId);
        const currentCash = account?.cashBalance ?? 0;
        const newCash = currentCash - cost;
        await upsertPortfolioAccount(userId, { cashBalance: newCash });
        await addCapitalEvent({
          userId,
          type: "buy",
          amount: cost,
          ticker: input.ticker,
          units: input.units,
          pricePerUnit: input.buyPrice,
          notes: `Added to holding: ${input.ticker} +${input.units} @ $${input.buyPrice} (merged, total ${totalUnits}) | Cash: $${currentCash.toFixed(0)} -> $${newCash.toFixed(0)}`,
        });
        swrInvalidate(`portfolio:state:${userId}`);
        return { id: existing.id, merged: true };
      }

      const id = await addPortfolioHolding({
        userId,
        ticker: input.ticker,
        company: live?.company ?? null,
        buyPrice: input.buyPrice,
        units: input.units,
        currentPrice: live?.price ?? null,
        priceUpdatedAt: live ? new Date() : null,
        notes: input.notes ?? null,
        transactionDate: input.transactionDate ? new Date(input.transactionDate) : null,
        buyScore,
        entryTier: buyEntryTier ?? undefined,
      });
      // Deduct purchase cost from cash balance
      const cost = input.buyPrice * input.units;
      const account = await getPortfolioAccount(userId);
      const currentCash = account?.cashBalance ?? 0;
      const newCash = currentCash - cost;
      await upsertPortfolioAccount(userId, { cashBalance: newCash });
      // Log buy event
      await addCapitalEvent({
        userId,
        type: "buy",
        amount: cost,
        ticker: input.ticker,
        units: input.units,
        pricePerUnit: input.buyPrice,
        notes: `Added holding: ${input.ticker} × ${input.units} @ $${input.buyPrice} | Cash: $${currentCash.toFixed(0)} → $${newCash.toFixed(0)}`,
      });
      // Log journal event for buy
      await logJournalEvent({
        userId,
        eventType: "buy",
        ticker: input.ticker,
        company: live?.company ?? null,
        units: input.units,
        price: input.buyPrice,
        notes: input.notes ?? null,
      }).catch(() => {});
      // Auto-upsert Trading Diary entry (weighted-average if ticker already exists)
      try {
        // Run Ziv Engine to get stop loss and take profit
        let stopLoss: number | null = null;
        let takeProfit: number | null = null;
        let reason = "";
        let expectations = "";
        try {
          const rawBars = await fetchBarsForTicker(input.ticker);
          const bars = normalizeBarsForTicker(input.ticker, rawBars);
          if (bars.length >= 50) {
            const ziv = calcZivEngineScore(bars);
            const slTp = calcSlTp(input.buyPrice, ziv.ema50);
            stopLoss = slTp.stopLoss;
            takeProfit = slTp.takeProfit;
          }
        } catch { /* non-blocking */ }
        // Generate AI reason + expectations only for new entries
        const existingDiary = await getTradingDiaryEntries(userId);
        const isNew = !existingDiary.some(e => e.ticker.toUpperCase() === input.ticker.toUpperCase());
        if (isNew) {
          try {
            const aiResp = await invokeLLM({
              messages: [
                { role: "system", content: "You are a trading assistant. Respond in Hebrew. Be concise (2-3 sentences each)." },
                { role: "user", content: `Stock: ${input.ticker} (${live?.company ?? input.ticker}). Buy price: $${input.buyPrice}. Units: ${input.units}. Ziv Score: ${buyScore ?? 'N/A'}. Tier: ${buyEntryTier ?? 'N/A'}. Stop Loss: ${stopLoss ? '$' + stopLoss.toFixed(2) : 'N/A'}. Take Profit: ${takeProfit ? '$' + takeProfit.toFixed(2) : 'N/A'}.

Provide JSON with two fields:
- "reason": why we bought this stock (technical setup, signals, entry rationale)
- "expectations": what we expect (price target, timeline, exit strategy)` },
              ],
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "diary_entry",
                  strict: true,
                  schema: {
                    type: "object",
                    properties: {
                      reason: { type: "string" },
                      expectations: { type: "string" },
                    },
                    required: ["reason", "expectations"],
                    additionalProperties: false,
                  },
                },
              },
            });
            const parsed = JSON.parse(aiResp.choices[0].message.content as string);
            reason = parsed.reason ?? "";
            expectations = parsed.expectations ?? "";
          } catch { /* non-blocking */ }
        }
        await upsertDiaryOnBuy(userId, input.ticker, input.units, input.buyPrice, {
          company: live?.company ?? null,
          stopLoss: stopLoss ?? undefined,
          takeProfit: takeProfit ?? undefined,
          reason: reason || (isNew ? `קנינו ${input.ticker} במחיר $${input.buyPrice}` : undefined),
          expectations: expectations || (isNew ? `מעקב לפי מודל זיו` : undefined),
        });
      } catch { /* diary upsert is non-blocking */ }
      // ── Auto-sync SL alert for this holding ──────────────────────────────
      try {
        // Get the diary entry we just created (or existing one) to get SL
        const diaryEntries = await getTradingDiaryEntries(userId);
        const diaryEntry = diaryEntries.find(e => e.ticker.toUpperCase() === input.ticker.toUpperCase());
        if (diaryEntry?.stopLoss && diaryEntry.stopLoss > 0) {
          await upsertHoldingAlert(userId, input.ticker, "sl", diaryEntry.stopLoss);
          if (diaryEntry.takeProfit && diaryEntry.takeProfit > 0) {
            await upsertHoldingAlert(userId, input.ticker, "tp", diaryEntry.takeProfit);
          }
        }
      } catch { /* non-blocking */ }
      swrInvalidate(`portfolio:state:${userId}`);
      return { id, cashAfter: newCash, cashBefore: currentCash, cost };
    }),

  // ── Update holding ────────────────────────────────────────────────────────
  updateHolding: protectedProcedure
    .input(z.object({
      id: z.number(),
      buyPrice: z.number().positive().optional(),
      units: z.number().positive().optional(),
      stopLoss: z.number().positive().optional(), // if provided, sync to alerts
      takeProfit: z.number().positive().optional(), // if provided, sync to alerts
      notes: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const { id, stopLoss, takeProfit, ...data } = input;
      // Include stopLoss and takeProfit in the DB update (they were previously excluded by destructuring)
      await updatePortfolioHolding(id, userId, {
        ...data,
        ...(stopLoss != null ? { stopLoss } : {}),
        ...(takeProfit != null ? { takeProfit } : {}),
      });
      // Sync SL/TP alerts if provided
      if (stopLoss && stopLoss > 0) {
        const holdings = await getPortfolioHoldings(userId);
        const holding = holdings.find(h => h.id === id);
        if (holding) {
          await upsertHoldingAlert(userId, holding.ticker, "sl", stopLoss).catch(() => {});
        }
      }
      if (takeProfit && takeProfit > 0) {
        const holdings = await getPortfolioHoldings(userId);
        const holding = holdings.find(h => h.id === id);
        if (holding) {
          await upsertHoldingAlert(userId, holding.ticker, "tp", takeProfit).catch(() => {});
        }
      }
      return { ok: true };
    }),

  // ── Delete holding ────────────────────────────────────────────────────────────────────────────────────
  deleteHolding: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      // Fetch holding before deleting to get its current value
      const holdings = await getPortfolioHoldings(userId);
      const holding = holdings.find(h => h.id === input.id);
      if (holding) {
        // Use currentPrice if available, otherwise fall back to buyPrice
        const salePrice = holding.currentPrice ?? holding.buyPrice;
        const saleValue = salePrice * holding.units;
        // Add sale proceeds back to cash balance
        const account = await getPortfolioAccount(userId);
        const currentCash = account?.cashBalance ?? 0;
        await upsertPortfolioAccount(userId, { cashBalance: currentCash + saleValue });
        // Log the capital event
        await addCapitalEvent({
          userId,
          type: "sell",
          amount: saleValue,
          ticker: holding.ticker,
          units: holding.units,
          pricePerUnit: salePrice,
          notes: `Sold ${holding.ticker} × ${holding.units} @ $${salePrice.toFixed(2)}`,
        });
        // Remove ALL active alerts for this ticker (no longer holding it)
        await deleteAllAlertsForTicker(userId, holding.ticker).catch(() => {});
        // Log journal event for sell
        await logJournalEvent({
          userId,
          eventType: "sell",
          ticker: holding.ticker,
          company: holding.company ?? null,
          units: holding.units,
          price: salePrice,
          notes: `מכירה ידנית: ${holding.ticker} × ${holding.units} @ $${salePrice.toFixed(2)}`,
        }).catch(() => {});
        // Update Trading Diary: reduce units or close with P&L
        await updateDiaryOnSell(userId, holding.ticker, holding.units, salePrice).catch(() => {});
      }
      await deletePortfolioHolding(input.id, userId);
      return { ok: true, cashAdded: holding ? (holding.currentPrice ?? holding.buyPrice) * holding.units : 0 };
    }),

  // ── Sync all existing holdings SL/TP to Price Alerts (called on Trade Manager load) ─────────────────
  syncHoldingAlerts: protectedProcedure
    .mutation(async ({ ctx }) => {
      const userId = ctx.user.id;
      const diaryEntries = await getTradingDiaryEntries(userId);
      const holdings = await getPortfolioHoldings(userId);
      const holdingTickers = new Set(holdings.map(h => h.ticker.toUpperCase()));
      let synced = 0;
      for (const entry of diaryEntries) {
        // Only sync for tickers that are currently held
        if (!holdingTickers.has(entry.ticker.toUpperCase())) continue;
        if (entry.stopLoss && entry.stopLoss > 0) {
          await upsertHoldingAlert(userId, entry.ticker, "sl", entry.stopLoss).catch(() => {});
          synced++;
        }
        if (entry.takeProfit && entry.takeProfit > 0) {
          await upsertHoldingAlert(userId, entry.ticker, "tp", entry.takeProfit).catch(() => {});
          synced++;
        }
      }
      return { synced };
    }),

  // ── Get live prices for a list of tickers (real-time, no DB cache) ─────────
  getLivePrices: protectedProcedure
    .input(z.object({ tickers: z.array(z.string()).min(1).max(100) }))
    .query(async ({ ctx, input }) => {
      // IBKR-only: Holding 1, Holding 2, Overview, Fast Overview use IBKR prices.
      const tickers = input.tickers.map(t => t.toUpperCase());
      const priceMap = await fetchIbkrLivePricesBatch(tickers);
      // Check if TASE is closed (holiday/weekend) — zero out change for .TA tickers
      const { isTaseClosed } = await import("../utils/marketHours");
      const taseIsClosed = isTaseClosed();

      // Per-ticker DB fallback: if ANY ticker has null live price, load DB cache
      // so that ticker gets the last known price (fixes race condition where stocks
      // succeed via IBKR but crypto fails via Binance/CoinGecko timeout).
      const hasMissingPrices = tickers.some(t => priceMap.get(t)?.price == null);
      let dbPriceMap: Map<string, { price: number | null; changePercent: number | null }> = new Map();
      if (hasMissingPrices) {
        try {
          const holdings = await getPortfolioHoldings(ctx.user.id);
          for (const h of holdings) {
            if (h.currentPrice != null) {
              dbPriceMap.set(h.ticker.toUpperCase(), {
                price: Number(h.currentPrice),
                changePercent: h.dailyChangePercent != null ? Number(h.dailyChangePercent) : null,
              });
            }
          }
        } catch { /* ignore DB errors */ }
      }

      return tickers.map(ticker => {
        const live = priceMap.get(ticker);
        const db = dbPriceMap.get(ticker);
        // When TASE is closed (holiday/weekend), zero out today's change for .TA tickers
        const isTaTicker = ticker.endsWith('.TA');
        const zeroChange = isTaTicker && taseIsClosed;
        return {
          ticker,
          price: live?.price ?? db?.price ?? null,
          change: zeroChange ? 0 : (live?.change ?? null),
          changePercent: zeroChange ? 0 : (live?.changePercent ?? db?.changePercent ?? null),
          prevClose: live?.prevClose ?? null,
          isExtendedHours: live?.isExtendedHours ?? false,
          fromCache: live?.price == null && db?.price != null,
        };
      });
    }),
  // ── Refresh live prices for all holdings (parallel fetch) ──────────────────────────────────────
  refreshPrices: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.user.id;
    const holdings = await getPortfolioHoldings(userId);
    log.info("ANALYSIS", "refreshPrices START", { userId, holdingsCount: holdings.length });
    // IBKR-only: use IBKR prices for Holding 1/2/Overview/Fast Overview
    const priceMap = await fetchIbkrLivePricesBatch(holdings.map(h => h.ticker));
    const results: { ticker: string; price: number | null; dailyChangePercent: number | null }[] = [];
    await Promise.all(
      holdings.map(async h => {
        const live = priceMap.get(h.ticker);
        if (live) {
          await updatePortfolioHoldingPrice(h.id, live.price, live.changePercent);
          results.push({ ticker: h.ticker, price: live.price, dailyChangePercent: live.changePercent });
        } else {
          log.warn("ANALYSIS", `No live price for ${h.ticker}`);
          results.push({ ticker: h.ticker, price: null, dailyChangePercent: null });
        }
      })
    );
    log.info("ANALYSIS", "refreshPrices DONE", { updated: results.length });
    return { updated: results.length, results };
  }),
  // ── Deposit capital ───────────────────────────────────────────────────────
  deposit: protectedProcedure
    .input(z.object({ amount: z.number().positive() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const account = await getPortfolioAccount(userId);
      const newTotal = (account?.totalCapital ?? 0) + input.amount;
      const newCash = (account?.cashBalance ?? 0) + input.amount;
      await upsertPortfolioAccount(userId, { totalCapital: newTotal, cashBalance: newCash });
      await addCapitalEvent({ userId, type: "deposit", amount: input.amount, notes: `Deposit of $${input.amount.toLocaleString()}` });
      return { totalCapital: newTotal, cashBalance: newCash };
    }),

  // ── Request withdrawal — AI decides which stocks to sell ─────────────────
  requestWithdrawal: protectedProcedure
    .input(z.object({ amount: z.number().positive() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const [account, holdings] = await Promise.all([
        getPortfolioAccount(userId),
        getPortfolioHoldings(userId),
      ]);
      const cashBalance = account?.cashBalance ?? 0;

      // If enough cash, just deduct
      if (cashBalance >= input.amount) {
        await upsertPortfolioAccount(userId, { cashBalance: cashBalance - input.amount });
        await addCapitalEvent({ userId, type: "withdrawal", amount: -input.amount, notes: `Cash withdrawal of $${input.amount.toLocaleString()}` });
        return {
          ok: true,
          method: "cash",
          sellRecommendations: [],
          message: `Withdrawn $${input.amount.toLocaleString()} from cash balance.`,
        };
      }

      // Need to sell some holdings — ask AI which ones
      const shortfall = input.amount - cashBalance;
      const holdingsSummary = holdings.map(h => {
        const cmp = h.currentPrice ?? h.buyPrice;
        const value = cmp * h.units;
        const pnl = (cmp - h.buyPrice) / h.buyPrice * 100;
        return `${h.ticker}: ${h.units} units @ $${h.buyPrice} cost, CMP $${cmp.toFixed(2)}, value $${value.toFixed(0)}, P&L ${pnl.toFixed(1)}%`;
      }).join("\n");

      const prompt = `You are a portfolio manager using the Ziv trading strategy.
The client wants to withdraw $${input.amount.toLocaleString()}.
Available cash: $${cashBalance.toFixed(0)}. Shortfall to raise: $${shortfall.toFixed(0)}.

Current holdings:
${holdingsSummary}

Decide which positions to sell (partially or fully) to raise the shortfall.
Rules:
1. Sell losers first (negative P&L), then weakest performers.
2. Never sell a position with >50% unrealized gain unless it's the only option.
3. Prefer partial sells over full liquidation.
4. Minimize tax impact (sell losers to offset gains).

Return JSON array: [{ ticker, units_to_sell, reason, estimated_proceeds }]`;

      const response = await invokeLLM({
        messages: [
          { role: "system", content: "You are a portfolio manager. Return only valid JSON." },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "sell_plan",
            strict: true,
            schema: {
              type: "object",
              properties: {
                sell_plan: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      ticker: { type: "string" },
                      units_to_sell: { type: "number" },
                      reason: { type: "string" },
                      estimated_proceeds: { type: "number" },
                    },
                    required: ["ticker", "units_to_sell", "reason", "estimated_proceeds"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["sell_plan"],
              additionalProperties: false,
            },
          },
        },
      });

      const content = String(response.choices?.[0]?.message?.content ?? "{}");
      const parsed = JSON.parse(content);
      const sellPlan = parsed.sell_plan ?? [];

      await addCapitalEvent({
        userId,
        type: "withdrawal",
        amount: -input.amount,
        notes: `Withdrawal request $${input.amount.toLocaleString()}. AI sell plan: ${sellPlan.map((s: any) => `${s.ticker} ×${s.units_to_sell}`).join(", ")}`,
      });

      return {
        ok: true,
        method: "sell",
        sellRecommendations: sellPlan,
        cashAvailable: cashBalance,
        shortfall,
        message: `To raise $${shortfall.toFixed(0)}, the AI recommends selling the following positions:`,
      };
    }),

  // ── Analyze portfolio — AI recommendations using Ziv engine ──────────────
  analyze: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.user.id;
    const [account, holdings, userAssets] = await Promise.all([
      getPortfolioAccount(userId),
      getPortfolioHoldings(userId),
      getUserAssets(userId),
    ]);

    if (holdings.length === 0 && (account?.cashBalance ?? 0) === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "No holdings or capital to analyze. Add holdings or deposit capital first." });
    }

    // Fetch bars for holdings + catalogue in parallel (eliminates N+1 sequential fetches)
    const catalogueTickers = (userAssets ?? []).map((a: any) => a.ticker).slice(0, 30);
    const heldTickers = new Set(holdings.map(h => h.ticker));
    const allTickersToFetch = Array.from(new Set([...holdings.map(h => h.ticker), ...catalogueTickers]));
    const allBarsMap = await fetchBarsBatch(allTickersToFetch);

    const holdingAnalysis: any[] = [];
    for (const h of holdings) {
      const rawBarsH = allBarsMap.get(h.ticker) ?? [];
      const bars = normalizeBarsForTicker(h.ticker, rawBarsH);
      if (bars.length < 50) {
        holdingAnalysis.push({ ticker: h.ticker, error: "Insufficient price data" });
        continue;
      }
      const ziv = calcZivEngineScore(bars);
      const costBasis = h.buyPrice * h.units;
      const currentValue = ziv.price * h.units;
      const pnlPct = (ziv.price - h.buyPrice) / h.buyPrice * 100;
      holdingAnalysis.push({
        ticker: h.ticker,
        company: h.company,
        units: h.units,
        buyPrice: h.buyPrice,
        cmp: ziv.price.toFixed(2),
        costBasis: costBasis.toFixed(0),
        currentValue: currentValue.toFixed(0),
        pnlPct: pnlPct.toFixed(1),
        ema50: ziv.ema50.toFixed(2),
        ema200: ziv.ema200.toFixed(2),
        weeklyEma50Slope: ziv.weeklyEma50Slope.toFixed(3),
        donchian20High: ziv.donchian20High.toFixed(2),
        priceAction: ziv.priceAction,
        tier: ziv.tier,
        zivScore: ziv.score,
        reason: ziv.reason,
      });
    }

    const watchlistCandidates: any[] = [];
    for (const ticker of catalogueTickers) {
      if (heldTickers.has(ticker)) continue; // already held
      const bars = allBarsMap.get(ticker) ?? [];
      if (bars.length < 50) continue;
      const ziv = calcZivEngineScore(bars);
      if (ziv.score >= 6) {
        watchlistCandidates.push({
          ticker,
          cmp: ziv.price.toFixed(2),
          ema50: ziv.ema50.toFixed(2),
          ema200: ziv.ema200.toFixed(2),
          weeklyEma50Slope: ziv.weeklyEma50Slope.toFixed(3),
          donchian20High: ziv.donchian20High.toFixed(2),
          priceAction: ziv.priceAction,
          tier: ziv.tier,
          zivScore: ziv.score,
          reason: ziv.reason,
          proximityToEma50Pct: ziv.distToEma50Pct.toFixed(1),
        });
      }
    }
    // Sort candidates by score desc — keep ALL score>=7 assets
    watchlistCandidates.sort((a, b) => b.zivScore - a.zivScore);

    const cashBalance = account?.cashBalance ?? 0;
    const grossPositionValue = account?.lastKnownNLV ?? null; // Gross Position Value from IBKR
    const netLiquidation = account?.lastKnownNetLiquidation ?? null; // Real Balance (NLV)
    const leverageRatio = (grossPositionValue && netLiquidation && netLiquidation > 0)
      ? grossPositionValue / netLiquidation : null;
    const totalPortfolioValue = holdingAnalysis.reduce((sum, h) => sum + parseFloat(h.currentValue ?? "0"), cashBalance);

    // Build AI prompt
    const leverageContext = leverageRatio != null
      ? `- Leverage Ratio: ${leverageRatio.toFixed(2)}x (${Math.round(leverageRatio * 100)}%) — ${leverageRatio <= 1.0 ? 'NORMAL (≤100%, negative cash is intentional and safe)' : leverageRatio <= 1.2 ? 'ELEVATED (100-120%, monitor closely)' : 'HIGH RISK (>120%, reduce exposure)'}`
      : `- Leverage: Unknown (IBKR data unavailable)`;
    const prompt = `You are the Ziv AI Portfolio Manager. Analyze this real portfolio and provide actionable recommendations.

STRATEGY CONTEXT: This portfolio uses a 100% leverage strategy. A negative cash balance is NORMAL and intentional — it means the portfolio is fully invested using margin. Do NOT treat negative cash as a warning or problem unless leverage ratio exceeds 1.2x.

PORTFOLIO SUMMARY:
- Total Value: $${totalPortfolioValue.toFixed(0)}
- Cash Balance: $${cashBalance.toFixed(0)} (${((cashBalance / totalPortfolioValue) * 100).toFixed(1)}% cash)
${leverageContext}

CURRENT HOLDINGS (with Ziv technical scores):
${JSON.stringify(holdingAnalysis, null, 2)}

TOP CATALOGUE CANDIDATES (not currently held, Ziv Score >= 7, sorted by score):
${JSON.stringify(watchlistCandidates.filter(c => c.zivScore >= 7), null, 2)}

ZIVS CORE RULES:
- Ziv Score 9-10: Donchian Breakout — strong buy signal
- Ziv Score 7-8: Pullback to EMA50 in bull trend — buy on dip
- Ziv Score 6: Above EMA200 with positive EMA50 slope — watchlist
- Ziv Score < 5: Below EMA200 or negative slope — avoid / consider exit
- EMA50 slope negative + price below EMA50 = danger zone
- RSI > 75 = overbought, reduce position; RSI < 35 = oversold, potential entry
- Cash > 30% of portfolio = deploy capital into high-score setups

Provide:
1. HOLD/REDUCE/EXIT recommendation for each current holding with reasoning
2. Top 3-5 BUY opportunities from the catalogue with entry zone, stop loss, and position size suggestion
3. SWAP recommendations: which holding to exit and replace with which catalogue stock
4. Capital allocation plan: how to deploy the cash balance
5. Overall portfolio health score (1-10) with key risks

Return structured JSON.`;

    const response = await invokeLLM({
      messages: [
        { role: "system", content: "You are the Ziv AI Portfolio Manager. Return only valid JSON matching the schema. IMPORTANT: All text fields must be written in Hebrew (עברית)." },
        { role: "user", content: prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "portfolio_analysis",
          strict: true,
          schema: {
            type: "object",
            properties: {
              portfolioHealthScore: { type: "number" },
              portfolioHealthSummary: { type: "string" },
              holdingRecommendations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    ticker: { type: "string" },
                    action: { type: "string" },
                    reasoning: { type: "string" },
                    stopLoss: { type: "string" },
                    targetPrice: { type: "string" },
                    urgency: { type: "string" },
                  },
                  required: ["ticker", "action", "reasoning", "stopLoss", "targetPrice", "urgency"],
                  additionalProperties: false,
                },
              },
              buyOpportunities: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    ticker: { type: "string" },
                    entryZone: { type: "string" },
                    stopLoss: { type: "string" },
                    targetPrice: { type: "string" },
                    positionSizePct: { type: "number" },
                    reasoning: { type: "string" },
                    zivScore: { type: "number" },
                  },
                  required: ["ticker", "entryZone", "stopLoss", "targetPrice", "positionSizePct", "reasoning", "zivScore"],
                  additionalProperties: false,
                },
              },
              swapRecommendations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    exitTicker: { type: "string" },
                    enterTicker: { type: "string" },
                    reasoning: { type: "string" },
                  },
                  required: ["exitTicker", "enterTicker", "reasoning"],
                  additionalProperties: false,
                },
              },
              cashDeploymentPlan: { type: "string" },
              keyRisks: { type: "string" },
            },
            required: ["portfolioHealthScore", "portfolioHealthSummary", "holdingRecommendations", "buyOpportunities", "swapRecommendations", "cashDeploymentPlan", "keyRisks"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = String(response.choices?.[0]?.message?.content ?? "{}");
    const analysisResult = JSON.parse(content);

    // Save to DB
    await savePortfolioAnalysis(userId, JSON.stringify({
      ...analysisResult,
      holdingAnalysis,
      watchlistCandidates: watchlistCandidates.slice(0, 10),
      totalPortfolioValue,
      cashBalance,
      analyzedAt: new Date().toISOString(),
    }));

    return {
      ...analysisResult,
      holdingAnalysis,
      watchlistCandidates: watchlistCandidates.slice(0, 10),
      totalPortfolioValue,
      cashBalance,
    };
  }),

  // ── Analyze Holdings — Full Lab Parity (Ziv Engine + SL/TP/PositionSize + Exit Alerts) ──
  analyzeHoldings: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.user.id;
    log.info("ANALYSIS", "analyzeHoldings START", { userId });
    const [holdings, account] = await Promise.all([
      getPortfolioHoldings(userId),
      getPortfolioAccount(userId),
    ]);
    if (holdings.length === 0) {
      log.warn("ANALYSIS", "analyzeHoldings called with no holdings", { userId });
      throw new TRPCError({ code: "BAD_REQUEST", message: "No holdings to analyze. Add holdings first." });
    }

    // Total portfolio value = holdings market value + cash
    const totalPortfolioValue = holdings.reduce((sum, h) => {
      const price = h.currentPrice ?? h.buyPrice;
      return sum + price * h.units;
    }, 0) + (account?.cashBalance ?? 0);

    // Lab constants (mirrors tradingLab.ts)
    const SL_PCT = 0.08;          // 8% below entry (or EMA-50 if closer)
    const RISK_REWARD = 2.5;      // TP = entry + 2.5 * risk
    const RISK_PER_TRADE_PCT = 0.02; // 2% of portfolio per trade
    const WINNERS_LEASH_PCT = 0.25;  // 25% trailing stop from peak
    const ZIM_CONFIRMATION_DAYS = 7; // days below floor before ZIM exit

    type HoldingResult = {
      id: number;
      ticker: string;
      zivScore: number;
      tier: string;
      action: string;
      reasoning: string;
      // Lab fields
      stopLoss: number | null;
      takeProfit: number | null;
      positionSizePct: number | null;
      suggestedUnits: number | null;
      // Exit alerts
      exitAlert: string | null;
      exitAlertType: "ZIM" | "DIAMOND_HANDS" | "WINNERS_LEASH" | "TRASH" | null;
    };

    // Fetch all bars in parallel (eliminates N+1)
     const holdingBarsMap2 = await fetchBarsBatch(holdings.map(h => h.ticker));
    const results: HoldingResult[] = [];
    for (const h of holdings) {
      const rawBarsH2 = holdingBarsMap2.get(h.ticker) ?? [];
      const bars = normalizeBarsForTicker(h.ticker, rawBarsH2);
      const currentPrice = h.currentPrice ?? h.buyPrice;

      if (bars.length < 50) {
        results.push({
          id: h.id, ticker: h.ticker, zivScore: 0, tier: "No Data", action: "HOLD",
          reasoning: "Insufficient price data",
          stopLoss: null, takeProfit: null, positionSizePct: null, suggestedUnits: null,
          exitAlert: null, exitAlertType: null,
        });
        continue;
      }

      const ziv = calcZivEngineScore(bars);
      const score = ziv.score;
      const closes = bars.map(b => b.close);
      const ema20 = calcEMA(closes, 20);

      // ── SL/TP Calculation (Lab logic) — direction-aware via signed units ──
      const units = Number(h.units ?? 0);
      const isShort = units < 0;
      let stopLoss: number;
      let takeProfit: number;
      if (isShort) {
        const entrySlTp = calcEntrySlTp({
          entryPrice: h.buyPrice,
          ema50: ziv.ema50,
          bars,
          direction: "short",
        });
        stopLoss = entrySlTp.stopLoss;
        takeProfit = entrySlTp.takeProfit;
      } else {
        // SL = max(8% below entry, EMA-50 - 1%) — SL must be below buyPrice (long)
        const slByPct = h.buyPrice * (1 - SL_PCT);
        const slByEma50Raw = ziv.ema50 * 0.99;
        const slByEma50 = slByEma50Raw < h.buyPrice ? slByEma50Raw : slByPct;
        const stopLossRaw = Math.max(slByPct, slByEma50);
        stopLoss = stopLossRaw < h.buyPrice ? stopLossRaw : slByPct;
        const risk = h.buyPrice - stopLoss;
        takeProfit = h.buyPrice + RISK_REWARD * risk;
      }

      // ── Position Size (score-based % of portfolio) ──
      // Tier caps: Gold Breakout → 15%, Gold Retest → 10%, Near Entry Watch → 7%, No Signal → 3%
      const tierCapPct = ziv.tier === "Gold Breakout" ? 15
        : ziv.tier === "Gold Retest" ? 10
        : ziv.tier === "Near Entry Watch" ? 7
        : 3;
      // Score bonus: score 8+ gets full cap, 6-7 gets 80%, below 6 gets 60%
      const scoreMultiplier = score >= 8 ? 1.0 : score >= 6 ? 0.8 : 0.6;
      const positionSizePct = totalPortfolioValue > 0 ? tierCapPct * scoreMultiplier : null;
      const positionSizeUsdRec = totalPortfolioValue * (positionSizePct ?? 0) / 100;
      const suggestedUnits = currentPrice > 0 ? Math.floor(positionSizeUsdRec / currentPrice) : null;

      // ── Exit Alert Detection (Lab rules) ──
      let exitAlert: string | null = null;
      let exitAlertType: HoldingResult["exitAlertType"] = null;

      // 1. Winner's Leash: if current price < peak * 0.75 (25% from peak)
      const peak = h.peakPrice ?? currentPrice;
      const newPeak = Math.max(peak, currentPrice);
      if (currentPrice < peak * (1 - WINNERS_LEASH_PCT)) {
        exitAlert = `⚠️ WINNER'S LEASH: Price ($${currentPrice.toFixed(2)}) dropped >25% from peak ($${peak.toFixed(2)}). Consider exit.`;
        exitAlertType = "WINNERS_LEASH";
      }

      // 2. Trash tier — structural downtrend
      if (!exitAlert && ziv.tier === "No Signal") {
        exitAlert = `🔴 TRASH TIER: ${ziv.reason}. Consider exiting this position.`;
        exitAlertType = "TRASH";
      }

      // 3. Diamond Hands: 5 consecutive closes below EMA-20
      if (!exitAlert && bars.length >= 7) {
        const last5Closes = closes.slice(-5);
        const ema20Series = last5Closes.map((_, i) => calcEMA(closes.slice(0, closes.length - 4 + i), 20));
        const allBelowEma20 = last5Closes.every((c, i) => c < ema20Series[i]);
        if (allBelowEma20) {
          exitAlert = `⚠️ DIAMOND HANDS: 5 consecutive closes below EMA-20 ($${ema20.toFixed(2)}). Structural weakness detected.`;
          exitAlertType = "DIAMOND_HANDS";
        }
      }

      // 4. ZIM Protocol: price below EMA-50 for ZIM_CONFIRMATION_DAYS
      if (!exitAlert && bars.length >= ZIM_CONFIRMATION_DAYS + 1) {
        const lastNBars = bars.slice(-ZIM_CONFIRMATION_DAYS);
        const allBelowEma50 = lastNBars.every(b => {
          const ema50AtBar = calcEMA(closes.slice(0, closes.indexOf(b.close) + 1), 50);
          return b.close < ema50AtBar;
        });
        // Simplified: check last N closes vs current EMA-50
        const lastNCloses = closes.slice(-ZIM_CONFIRMATION_DAYS);
        const allBelowCurrentEma50 = lastNCloses.every(c => c < ziv.ema50);
        if (allBelowCurrentEma50) {
          exitAlert = `🔴 ZIM PROTOCOL: ${ZIM_CONFIRMATION_DAYS} consecutive closes below EMA-50 ($${ziv.ema50.toFixed(2)}). Structural death — consider full exit.`;
          exitAlertType = "ZIM";
        }
      }

      // Determine action
      // Logic: ZIM/TRASH always EXIT. For other exit alerts (Diamond Hands, Winner's Leash),
      // only trigger CONSIDER EXIT if score < 7. High-score holdings (7+) should HOLD/ADD
      // even if there's a short-term weakness signal.
      let action: string;
      if (exitAlertType === "ZIM" || exitAlertType === "TRASH") {
        action = "EXIT";
      } else if (exitAlert && score < 7) {
        // Low/medium score with exit signal → consider exit
        action = "CONSIDER EXIT";
      } else if (score >= 8 || ziv.tier === "Gold Breakout") {
        action = "HOLD STRONG / ADD";
      } else if (score >= 7 || ziv.tier === "Gold Retest") {
        action = "HOLD";
      } else if (score >= 5 || ziv.tier === "Near Entry Watch") {
        action = "WATCH";
      } else {
        action = "CONSIDER EXIT";
      }

      // Persist to DB
      await updatePortfolioHoldingLabFields(h.id, userId, {
        zivScore: score,
        stopLoss,
        takeProfit,
        positionSizePct: positionSizePct ?? undefined,
        peakPrice: newPeak,
        entryTier: ziv.tier,
      });
      // Sync score to Asset Catalogue (userAssets) if this ticker exists there
      // This ensures Holdings and Asset Catalogue always show the same score
      await updateUserAssetScore(userId, h.ticker, score, undefined, {
        cmp: ziv.price,
        ema50: ziv.ema50,
        ema200: ziv.ema200,
        tier: ziv.tier,
        reason: ziv.reason,
        weeklyEma50Slope: ziv.weeklyEma50Slope,
        donchian20High: ziv.donchian20High,
        priceAction: ziv.priceAction ?? undefined,
      }).catch(() => { /* non-blocking: asset may not be in catalogue */ });

      results.push({
        id: h.id, ticker: h.ticker, zivScore: score, tier: ziv.tier, action,
        reasoning: ziv.reason,
        stopLoss, takeProfit, positionSizePct, suggestedUnits,
        exitAlert, exitAlertType,
      });
    }

    log.info("ANALYSIS", "analyzeHoldings DONE", { userId, count: results.length, exitAlerts: results.filter(r => r.exitAlert).length });
    return { results, analyzedAt: new Date().toISOString(), totalPortfolioValue };
  }),

  // ── Analyze 60-Asset Catalogue (slower: scans all catalogue assets) ──────────
  analyzeAssetList: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.user.id;
    const [holdings, userAssets] = await Promise.all([
      getPortfolioHoldings(userId),
      getUserAssets(userId),
    ]);
    const catalogueTickers = (userAssets ?? []).map((a: any) => a.ticker);
    const heldTickers = new Set(holdings.map((h: any) => h.ticker));
    // Fetch all bars + live prices in parallel before processing
    const [assetBarsMap, assetPriceMap] = await Promise.all([
      fetchBarsBatch(catalogueTickers),
      fetchLivePricesBatch(catalogueTickers),
    ]);
    // Pre-fetch USD/ILS rate once for all .TA tickers
    let ilsRate = 3.60;
    const hasTaTickets = catalogueTickers.some(t => t.toUpperCase().endsWith('.TA'));
    if (hasTaTickets) {
      try { ilsRate = await getUsdIlsRate(); } catch { /* use fallback */ }
    }

    const candidates: any[] = [];
    const skippedTickers: string[] = [];
    for (const ticker of catalogueTickers) {
      const rawBars = assetBarsMap.get(ticker) ?? [];
      const live = assetPriceMap.get(ticker);
      if (rawBars.length < 50) { skippedTickers.push(ticker); continue; }

      // Normalize .TA bars from agorot to USD via PriceService canonical rule
      const isIsraeliStock = ticker.toUpperCase().endsWith('.TA');
      const bars = normalizeBarsForTickerFx(rawBars, ticker, ilsRate);

      const ziv = calcZivEngineScore(bars);
      const score = ziv.score;
      // Persist score + full scan data to user_assets DB
      const recommendation = ziv.tier === "Gold Breakout" ? "STRONG BUY"
        : ziv.tier === "Gold Retest" ? "BUY"
        : ziv.tier === "Near Entry Watch" ? "WATCH" : "AVOID";
      // ── Recommended Buy Price ──────────────────────────────────────────────
      let recommendedBuyPrice: number;
      if (ziv.tier === "Gold Breakout") {
        recommendedBuyPrice = parseFloat(ziv.price.toFixed(2));
      } else if (ziv.tier === "Gold Retest") {
        recommendedBuyPrice = parseFloat(ziv.ema50.toFixed(2));
      } else {
        recommendedBuyPrice = parseFloat((ziv.ema50 * 0.99).toFixed(2));
      }
      // ── Stop Loss (ATR-1.5 primary, EMA-50×0.97 structural floor) ────────────
      const last14 = bars.slice(-14);
      const atr14 = last14.reduce((sum, bar, i) => {
        const prevClose = i > 0 ? last14[i - 1].close : bar.close;
        const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
        return sum + tr;
      }, 0) / 14;
      const atrStopLoss = parseFloat((recommendedBuyPrice - atr14 * 1.5).toFixed(2));
      const emaStopLoss = parseFloat((ziv.ema50 * 0.97).toFixed(2));
      const rawStop = Math.min(atrStopLoss, emaStopLoss);
      const minStop = parseFloat((recommendedBuyPrice * 0.995).toFixed(2));
      const recommendedStopLoss = Math.min(rawStop, minStop);
      // ── Hot Signal ─────────────────────────────────────────────────────────
      const hotSignal = (
        (ziv.tier === "Gold Breakout" || ziv.tier === "Gold Retest") &&
        ziv.price > ziv.ema200 &&
        ziv.weeklyEma50Slope > 0
      ) ? 1 : 0;
      await updateUserAssetScore(userId, ticker, score, live?.changePercent, {
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
      candidates.push({
        ticker,
        isHeld: heldTickers.has(ticker),
        cmp: ziv.price.toFixed(2),
        ema50: ziv.ema50.toFixed(2),
        ema200: ziv.ema200.toFixed(2),
        weeklyEma50Slope: ziv.weeklyEma50Slope.toFixed(3),
        donchian20High: ziv.donchian20High.toFixed(2),
        priceAction: ziv.priceAction,
        zivScore: score,
        tier: ziv.tier,
        reason: ziv.reason,
        proximityToEma50Pct: ziv.distToEma50Pct.toFixed(1),
        recommendedBuyPrice: recommendedBuyPrice.toFixed(2),
        recommendedStopLoss: recommendedStopLoss.toFixed(2),
        recommendation: ziv.tier === "Gold Breakout" ? "STRONG BUY"
          : ziv.tier === "Gold Retest" ? "BUY"
          : ziv.tier === "Near Entry Watch" ? "WATCH"
          : "AVOID",
      });
    }
    candidates.sort((a, b) => b.zivScore - a.zivScore);
    return { candidates, analyzedAt: new Date().toISOString(), totalScanned: candidates.length, skippedTickers };
  }),

  // ── Refresh catalogue prices only (fast — no ZIV scan, just live price + changePercent) ──
  refreshCataloguePrices: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.user.id;
    const userAssetsList = await getUserAssets(userId);
    const tickers = (userAssetsList ?? []).map((a: any) => a.ticker);
    if (tickers.length === 0) return { updated: 0, refreshedAt: new Date().toISOString() };
    const priceMap = await fetchLivePricesBatch(tickers);
    let updated = 0;
    await Promise.all(
      tickers.map(async (ticker: string) => {
        const live = priceMap.get(ticker);
        if (!live) return;
        // Update only cmp and dailyChangePercent — preserve all other scan data
        const db = await import("../db").then(m => m.getDb ? m.getDb() : null).catch(() => null);
        if (!db) return;
        const { userAssets: ua } = await import("../../drizzle/schema");
        const { eq, and } = await import("drizzle-orm");
        await db.update(ua)
          .set({ cmp: live.price, dailyChangePercent: live.changePercent, scannedAt: new Date() } as any)
          .where(and(eq(ua.userId, userId), eq(ua.ticker, ticker.toUpperCase())));
        updated++;
      })
    );
    return { updated, refreshedAt: new Date().toISOString() };
  }),

  // ── Get latest analysis ────────────────────────────────────────────
  getLatestAnalysis: protectedProcedure.query(async ({ ctx }) => {
    const row = await getLatestPortfolioAnalysis(ctx.user.id);
    if (!row) return null;
    try {
      return JSON.parse(row.result);
    } catch {
      return null;
    }
  }),

  // ── Get capital events history ────────────────────────────────────────────
  getEvents: protectedProcedure.query(async ({ ctx }) => {
    return getCapitalEvents(ctx.user.id, 50);
  }),

  // ── Validate ticker (public — used in Add Holding dialog) ─────────────────
  validateTicker: publicProcedure
    .input(z.object({ ticker: z.string().min(1).max(16) }))
    .query(async ({ input }) => {
      const ticker = input.ticker.toUpperCase().trim();
      if (!ticker) return { valid: false, company: null, price: null };
      const live = await fetchLivePrice(ticker);
      if (!live) return { valid: false, company: null, price: null };
      return { valid: true, company: live.company, price: live.price };
    }),

  // ── Buy from catalogue — deduct cash, add to holdings ────────────────────
  buyFromCatalogue: protectedProcedure
    .input(z.object({
      ticker: z.string().min(1).max(16).toUpperCase(),
      units: z.number().positive(),
      // buyPrice optional: if omitted, use live price
      buyPrice: z.number().positive().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      // Fetch live price
      const live = await fetchLivePrice(input.ticker);
      if (!live) throw new TRPCError({ code: "NOT_FOUND", message: `Could not fetch live price for ${input.ticker}` });
      const price = input.buyPrice ?? live.price;
      const cost = price * input.units;
      // Get cash balance (no restriction — allow buy regardless of balance)
      const account = await getPortfolioAccount(userId);
      const cashBalance = account?.cashBalance ?? 0;
      // Add holding
      const today = new Date().toISOString().slice(0, 10);
      const id = await addPortfolioHolding({
        userId,
        ticker: input.ticker,
        company: live.company ?? null,
        buyPrice: price,
        units: input.units,
        currentPrice: live.price,
        priceUpdatedAt: new Date(),
        notes: `Bought from catalogue @ $${price.toFixed(2)}`,
        transactionDate: new Date(today),
      });
      // Deduct cash
      const newCash = cashBalance - cost;
      await upsertPortfolioAccount(userId, { cashBalance: newCash });
      // Log event
      await addCapitalEvent({
        userId,
        type: "buy",
        amount: cost,
        ticker: input.ticker,
        units: input.units,
        pricePerUnit: price,
        notes: `Bought ${input.ticker} × ${input.units} @ $${price.toFixed(2)} from catalogue`,
      });
      return { id, cost, newCash, price };
    }),

  // ── Get catalogue with scores ─────────────────────────────────────────────
  // ── Find Replacements: Top-5 from catalogue (≥9.00) vs Bottom-5 from portfolio ──
  findReplacements: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.user.id;
    const [holdings, assets] = await Promise.all([
      getPortfolioHoldings(userId),
      getUserAssets(userId),
    ]);

    const heldTickers = new Set(holdings.map(h => h.ticker.toUpperCase()));

    // Score all catalogue assets not currently held
    const notHeld = assets.filter(a => !heldTickers.has(a.ticker.toUpperCase()));
    const scored: { ticker: string; company: string | null; score: number; tier: string; reason: string }[] = [];

    await Promise.all(
      notHeld.map(async (asset) => {
        const bars = await fetchBarsForTicker(asset.ticker);
        if (bars.length < 50) return;
        const result = calcZivEngineScore(bars);
        scored.push({
          ticker: asset.ticker,
          company: asset.companyName,
          score: result.score,
          tier: result.tier,
          reason: result.reason,
        });
      })
    );

    // Top-5: highest score ≥ 9.00 not in portfolio
    const top5 = scored
      .filter(s => s.score >= 9.00)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    // Bottom-5: lowest Ziv score in current portfolio
    const holdingScored: { ticker: string; company: string | null; score: number; tier: string; action: string }[] = [];
    await Promise.all(
      holdings.map(async (h) => {
        const bars = await fetchBarsForTicker(h.ticker);
        const result = bars.length >= 50 ? calcZivEngineScore(bars) : null;
        holdingScored.push({
          ticker: h.ticker,
          company: h.company ?? null,
          score: result?.score ?? 0,
          tier: result?.tier ?? "No Data",
          action: result && result.score < 5 ? "EXIT" : result && result.score < 7 ? "WATCH" : "HOLD",
        });
      })
    );
    const bottom5 = holdingScored
      .sort((a, b) => a.score - b.score)
      .slice(0, 5);

    return { top5, bottom5, scannedCount: scored.length };
  }),

  // v1.149: Retest Watchlist — scan catalogue assets for confirmed breakouts + retest zones
  getRetestWatchlist: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.user.id;
    const assets = await getUserAssets(userId);
    const tickers = assets.map(a => a.ticker.toUpperCase());
    const results: Array<{
      ticker: string;
      company: string;
      breakoutPrice: number;
      breakoutDate: string;
      currentPrice: number;
      retestZoneLow: number;
      retestZoneHigh: number;
      inRetestZone: boolean;
      distToRetestZonePct: number;
      zivScore: number;
      signal: "IN_ZONE" | "APPROACHING" | "ABOVE_ZONE";
    }> = [];

    // Fetch all bars in parallel (eliminates N+1 sequential fetches)
    const retestBarsMap = await fetchBarsBatch(tickers, 90);
    for (const ticker of tickers) {
      try {
        const bars = retestBarsMap.get(ticker) ?? [];
        if (!bars || bars.length < 25) continue;
        // Find the most recent volume-confirmed Donchian breakout in last 30 bars
        const recentBars = bars.slice(-30);
        let breakoutBar: typeof bars[0] | null = null;
        for (let i = 20; i < recentBars.length; i++) {
          const bar = recentBars[i];
          const prev20 = recentBars.slice(i - 20, i);
          const donchian20High = Math.max(...prev20.map(b => b.high));
          const avgVol = prev20.reduce((s, b) => s + (b.volume ?? 0), 0) / 20;
          const hasVolume = avgVol > 0 && (bar.volume ?? 0) >= avgVol * 1.5;
          if (bar.close > donchian20High && bar.close > bar.open && hasVolume) {
            breakoutBar = bar;
          }
        }
        if (!breakoutBar) continue;
        const currentBar = bars[bars.length - 1];
        const currentPrice = currentBar.close;
        const retestZoneLow = breakoutBar.close * 0.97;
        const retestZoneHigh = breakoutBar.close * 1.03;
        const inRetestZone = currentPrice >= retestZoneLow && currentPrice <= retestZoneHigh;
        const approaching = currentPrice > retestZoneHigh && currentPrice <= retestZoneHigh * 1.05;
        const distToZone = currentPrice > retestZoneHigh
          ? ((currentPrice - retestZoneHigh) / retestZoneHigh) * 100
          : currentPrice < retestZoneLow
          ? ((retestZoneLow - currentPrice) / retestZoneLow) * 100
          : 0;
        const zivResult = calcZivEngineScore(bars);
        results.push({
          ticker,
          company: assets.find(a => a.ticker.toUpperCase() === ticker)?.companyName ?? ticker,
          breakoutPrice: breakoutBar.close,
          breakoutDate: breakoutBar.date,
          currentPrice,
          retestZoneLow,
          retestZoneHigh,
          inRetestZone,
          distToRetestZonePct: distToZone,
          zivScore: zivResult.score,
          signal: inRetestZone ? "IN_ZONE" : approaching ? "APPROACHING" : "ABOVE_ZONE",
        });
      } catch {
        // skip tickers with fetch errors
      }
    }
    results.sort((a, b) => {
      const order = { IN_ZONE: 0, APPROACHING: 1, ABOVE_ZONE: 2 };
      if (order[a.signal] !== order[b.signal]) return order[a.signal] - order[b.signal];
      return b.zivScore - a.zivScore;
    });

    return { watchlist: results, scannedCount: tickers.length };
  }),

  getCatalogueWithScores: protectedProcedure.query(async ({ ctx }) => {
    const { resolveCatalogUserIdForViewer } = await import("../tradingAccounts");
    const catalogUserId = await resolveCatalogUserIdForViewer(ctx.user.id, ctx.user.role);
    const db = await getDb();
    if (!db) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    }
    return swrGet(
      `portfolio:catalogue:${catalogUserId}`,
      120_000, // TTL 120s — Static Catalogue (scanned daily)
      async () => {
    let assets = await getUserAssets(catalogUserId);

    // Dedupe by ticker (keep highest id) — guards against legacy duplicate rows
    if (assets.length > 1) {
      const byTicker = new Map<string, (typeof assets)[number]>();
      for (const a of assets) {
        const key = a.ticker.toUpperCase();
        const prev = byTicker.get(key);
        if (!prev || a.id > prev.id) byTicker.set(key, a);
      }
      assets = Array.from(byTicker.values());
    }

    // ── A GET (.query) must NOT mutate. Previously this auto-seeded the default
    //    catalogue via bulkReplaceUserAssets — a destructive write from a read path.
    //    Removed: return the empty result for an empty catalogue; a dedicated
    //    mutation handles seeding.
    if (assets.length === 0) {
      return [];
    }

    return assets.map(a => {
      const zivScore = a.score ?? null;
      const kronosBias = (a as any).kronosBias ?? null;
      const compositeScore = zivScore != null
        ? computeCompositeScore(zivScore, kronosBias)
        : null;
      return {
      id: a.id,
      ticker: a.ticker,
      company: a.companyName,
      sector: a.sector,
      score: zivScore,
      compositeScore,
      kronosBias,
      kronosDirection: (a as any).kronosDirection ?? null,
      kronosBandPct: (a as any).kronosBandPct ?? null,
      kronosPredPct: (a as any).kronosPredPct ?? null,
      kronosScannedAt: (a as any).kronosScannedAt ?? null,
      label: a.label ?? null,
      sortOrder: a.sortOrder,
      dailyChangePercent: (a as any).dailyChangePercent ?? null,
      // Scan result fields
      cmp: (a as any).cmp ?? null,
      ema50: (a as any).ema50 ?? null,
      ema200: (a as any).ema200 ?? null,
      proximityToEma50Pct: (a as any).proximityToEma50Pct ?? null,
      recommendation: (a as any).recommendation ?? null,
      reason: (a as any).reason ?? null,
      tier: (a as any).tier ?? null,
      weeklyEma50Slope: (a as any).weeklyEma50Slope ?? null,
      donchian20High: (a as any).donchian20High ?? null,
      priceAction: (a as any).priceAction ?? null,
      recommendedBuyPrice: (a as any).recommendedBuyPrice ?? null,
      recommendedStopLoss: (a as any).recommendedStopLoss ?? null,
      hotSignal: (a as any).hotSignal === 1 || (a as any).hotSignal === true,
      scannedAt: (a as any).scannedAt ?? null,
      profitPotential: (a as any).profitPotential ?? null,
      note: (a as any).note ?? null,
      catalogStatus: (a as any).catalogStatus ?? null,
      kineticScore: (a as any).kineticScore ?? null,
    };
    });
      }, // end swrGet fetcher
    );
  }),

  /**
   * getSelectedTeam — read-only VIP / SELECTED_TEAM ticker set (uppercased) so the
   * Asset Catalogue UI can badge those rows. SSOT is systemSettings.selected_team via
   * getSelectedTeamSet() (60s cache, fails open to DEFAULT_SELECTED_TEAM). No DB write,
   * no userAssets.label mutation. Fails open to [] — never breaks the catalogue list.
   */
  getSelectedTeam: protectedProcedure.query(async () => {
    try {
      const team = await getSelectedTeamSet();
      return [...team];
    } catch {
      return [] as string[];
    }
  }),

  // ── Daily Review: Ziv-model daily portfolio health check ─────────────────
  dailyReview: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.user.id;
    const [holdings, account, userAssets] = await Promise.all([
      getPortfolioHoldings(userId),
      getPortfolioAccount(userId),
      getUserAssets(userId),
    ]);

    if (holdings.length === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "No holdings to review. Add holdings first." });
    }

    // Fetch bars + live prices for all holdings in parallel (eliminates N+1)
    const dailyTickers = holdings.map(h => h.ticker);
    const [dailyBarsMap, dailyPriceMap] = await Promise.all([
      fetchBarsBatch(dailyTickers),
      fetchLivePricesBatch(dailyTickers),
    ]);
    const holdingData: any[] = [];
    for (const h of holdings) {
      const bars = dailyBarsMap.get(h.ticker) ?? [];
      const live = dailyPriceMap.get(h.ticker);
      const currentPrice = live?.price ?? h.currentPrice ?? h.buyPrice;
      // If bought today, daily % = (currentPrice - buyPrice) / buyPrice
      // This is because Yahoo's changePercent uses yesterday's close as baseline,
      // which is misleading when you bought at a higher price today.
      const todayStr = new Date().toISOString().slice(0, 10);
      const boughtToday = h.transactionDate
        ? String(h.transactionDate).slice(0, 10) === todayStr
        : h.createdAt
          ? new Date(h.createdAt).toISOString().slice(0, 10) === todayStr
          : false;
      const todayChangePct = boughtToday
        ? (currentPrice - h.buyPrice) / h.buyPrice * 100
        : (live?.changePercent ?? 0);
      const todayPnl = todayChangePct / 100 * currentPrice * h.units;
      if (bars.length < 50) {
        holdingData.push({
          ticker: h.ticker,
          company: h.company,
          units: h.units,
          buyPrice: h.buyPrice,
          currentPrice: currentPrice.toFixed(2),
          todayChangePct: todayChangePct.toFixed(2),
          todayPnl: todayPnl.toFixed(0),
          totalPnlPct: ((currentPrice - h.buyPrice) / h.buyPrice * 100).toFixed(1),
          zivScore: h.zivScore ?? 0,
          tier: "No Data",
          ema50: null,
          ema200: null,
          stopLoss: h.stopLoss,
          takeProfit: h.takeProfit,
          weeklyEma50Slope: null,
          priceAction: null,
        });
        continue;
      }
      const ziv = calcZivEngineScore(bars);
      const totalPnlPct = (currentPrice - h.buyPrice) / h.buyPrice * 100;
      holdingData.push({
        ticker: h.ticker,
        company: h.company,
        units: h.units,
        buyPrice: h.buyPrice,
        currentPrice: currentPrice.toFixed(2),
        todayChangePct: todayChangePct.toFixed(2),
        todayPnl: todayPnl.toFixed(0),
        totalPnlPct: totalPnlPct.toFixed(1),
        zivScore: ziv.score,
        tier: ziv.tier,
        ema50: ziv.ema50.toFixed(2),
        ema200: ziv.ema200.toFixed(2),
        stopLoss: h.stopLoss ?? (currentPrice * 0.92).toFixed(2),
        takeProfit: h.takeProfit,
        weeklyEma50Slope: ziv.weeklyEma50Slope.toFixed(3),
        priceAction: ziv.priceAction,
        distToEma50Pct: ziv.distToEma50Pct.toFixed(1),
      });
    }
    // Compute portfolio-level sensitivity metrics
    const totalPortfolioValue = holdingData.reduce((s, h) => s + parseFloat(h.currentPrice) * h.units, 0);
    const cashBalance = account?.cashBalance ?? 0;
    const totalWithCash = totalPortfolioValue + cashBalance;

    // Sector exposure from userAssets catalogue
    const sectorMap: Record<string, number> = {};
    for (const h of holdingData) {
      const asset = userAssets.find(a => a.ticker.toUpperCase() === h.ticker.toUpperCase());
      const sector = asset?.sector ?? "Unknown";
      const value = parseFloat(h.currentPrice) * h.units;
      sectorMap[sector] = (sectorMap[sector] ?? 0) + value;
    }
    const sectorExposure = Object.entries(sectorMap)
      .map(([sector, value]) => ({ sector, pct: totalPortfolioValue > 0 ? (value / totalPortfolioValue * 100).toFixed(1) : "0.0" }))
      .sort((a, b) => parseFloat(b.pct) - parseFloat(a.pct));

    // Top concentration (largest single holding %)
    const concentrationRisk = holdingData.map(h => ({
      ticker: h.ticker,
      pct: totalPortfolioValue > 0 ? (parseFloat(h.currentPrice) * h.units / totalPortfolioValue * 100).toFixed(1) : "0.0"
    })).sort((a, b) => parseFloat(b.pct) - parseFloat(a.pct));

    // Daily P&L
    const dailyPnl = holdingData.reduce((s, h) => s + parseFloat(h.todayPnl), 0);
    const dailyPnlPct = totalPortfolioValue > 0 ? (dailyPnl / totalPortfolioValue * 100) : 0;

    // Ziv tier distribution
    const tierCounts: Record<string, number> = {};
    for (const h of holdingData) {
      tierCounts[h.tier] = (tierCounts[h.tier] ?? 0) + 1;
    }

    // Build catalogue summary for AI (top opportunities from asset list)
    const catalogueOpportunities = (userAssets as any[])
      .filter(a => a.score != null && a.tier != null && (a.tier === 'Gold Breakout' || a.tier === 'Gold Retest'))
      .sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 10)
      .map((a: any) => ({
        ticker: a.ticker,
        company: a.company,
        score: a.score,
        tier: a.tier,
        recommendation: a.recommendation,
        proximityToEma50Pct: a.proximityToEma50Pct,
        recommendedBuyPrice: a.recommendedBuyPrice,
        reason: a.reason,
      }));

    // Weak holdings (score ≤ 4) that could be replaced
    const weakHoldings = holdingData.filter(h => h.zivScore <= 4).map(h => h.ticker);

    // Build AI prompt for daily review
    const prompt = `You are the Ziv AI Portfolio Manager conducting a DAILY REVIEW. Today is ${new Date().toLocaleDateString('he-IL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.

IMPORTANT: Write ALL text fields (dailySummary, priorityAction, reasoning, alerts, replaceSuggestions, addMoreSuggestions, sellSuggestions) in HEBREW (עברית). Use Hebrew language throughout the entire response.

PORTFOLIO DAILY SNAPSHOT:
- Total Holdings Value: $${totalPortfolioValue.toFixed(0)}
- Cash Balance: $${cashBalance.toFixed(0)} (${totalWithCash > 0 ? (cashBalance / totalWithCash * 100).toFixed(1) : 0}% of total)
- Today's P&L: ${dailyPnl >= 0 ? '+' : ''}$${dailyPnl.toFixed(0)} (${dailyPnlPct >= 0 ? '+' : ''}${dailyPnlPct.toFixed(2)}%)

HOLDINGS WITH ZIV SCORES AND TODAY'S PERFORMANCE:
${JSON.stringify(holdingData, null, 2)}

SECTOR EXPOSURE:
${JSON.stringify(sectorExposure, null, 2)}

CONCENTRATION RISK (top holdings by weight):
${JSON.stringify(concentrationRisk.slice(0, 5), null, 2)}

ASSET CATALOGUE — TOP OPPORTUNITIES (not yet held):
${catalogueOpportunities.length > 0 ? JSON.stringify(catalogueOpportunities, null, 2) : 'No catalogue data available — run Asset Catalogue scan first.'}

WEAK HOLDINGS (score ≤ 4, candidates for replacement): ${weakHoldings.length > 0 ? weakHoldings.join(', ') : 'None'}

ZIV ENGINE RULES (apply strictly):
- Score 9-10 (Gold Breakout): HOLD with Winner's Leash 25% trailing stop — do NOT exit on normal pullbacks
- Score 7-8 (Gold Retest): HOLD if price > EMA50; ADD more if within 2% of EMA50
- Score 5-6 (Neutral): HOLD with caution; monitor weekly EMA10 for exit signal
- Score 3-4 (Trash): REDUCE — exit only if weekly close below EMA10 confirmed for 7 days (ZIM rule)
- Score 1-2 (Trash): EXIT — price below EMA200 with negative weekly slope
- For stocks with 'High/Medium sentiment' (ZIM, core holdings): exit ONLY on weekly EMA10 close below
- Cash > 30%: deploy into score 7+ setups; Cash < 10%: reduce weakest positions first
- Today's big losers (< -2%): check if stop loss was breached
- Today's big winners (> +3%): check if at Donchian high — potential breakout continuation

Provide a concise daily review with:
1. Per-holding action: HOLD / ADD / REDUCE / EXIT with one-line reasoning
2. Today's key alerts (stop loss breaches, breakout signals, sector concentration warnings)
3. Daily portfolio health score (1-10)
4. One priority action for today
5. ADD MORE suggestions: holdings to increase position size (score 7+, near EMA50)
6. SELL suggestions: holdings to reduce or exit (score ≤ 4 or stop loss breached)
7. REPLACE suggestions: swap weak holdings for catalogue opportunities (pair each weak holding with a strong catalogue candidate)

Return structured JSON.`;

    const response = await invokeLLM({
      messages: [
        { role: "system", content: "You are the Ziv AI Portfolio Manager. Return only valid JSON matching the schema. IMPORTANT: All text fields must be written in Hebrew (עברית)." },
        { role: "user", content: prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "daily_review",
          strict: true,
          schema: {
            type: "object",
            properties: {
              dailyHealthScore: { type: "number" },
              dailySummary: { type: "string" },
              priorityAction: { type: "string" },
              holdingActions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    ticker: { type: "string" },
                    action: { type: "string" },
                    reasoning: { type: "string" },
                    urgency: { type: "string" },
                  },
                  required: ["ticker", "action", "reasoning", "urgency"],
                  additionalProperties: false,
                },
              },
              alerts: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    type: { type: "string" },
                    ticker: { type: "string" },
                    message: { type: "string" },
                  },
                  required: ["type", "ticker", "message"],
                  additionalProperties: false,
                },
              },
              cashDeploymentNote: { type: "string" },
              addMoreSuggestions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    ticker: { type: "string" },
                    reasoning: { type: "string" },
                    suggestedAction: { type: "string" },
                  },
                  required: ["ticker", "reasoning", "suggestedAction"],
                  additionalProperties: false,
                },
              },
              sellSuggestions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    ticker: { type: "string" },
                    reasoning: { type: "string" },
                    urgency: { type: "string" },
                  },
                  required: ["ticker", "reasoning", "urgency"],
                  additionalProperties: false,
                },
              },
              replaceSuggestions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    exitTicker: { type: "string" },
                    enterTicker: { type: "string" },
                    reasoning: { type: "string" },
                  },
                  required: ["exitTicker", "enterTicker", "reasoning"],
                  additionalProperties: false,
                },
              },
            },
            required: ["dailyHealthScore", "dailySummary", "priorityAction", "holdingActions", "alerts", "cashDeploymentNote", "addMoreSuggestions", "sellSuggestions", "replaceSuggestions"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = String(response.choices?.[0]?.message?.content ?? "{}");
    const reviewResult = JSON.parse(content);

    return {
      ...reviewResult,
      // Sensitivity metrics (computed server-side)
      sensitivity: {
        dailyPnl: parseFloat(dailyPnl.toFixed(2)),
        dailyPnlPct: parseFloat(dailyPnlPct.toFixed(2)),
        sectorExposure,
        concentrationRisk,
        tierCounts,
        cashPct: totalWithCash > 0 ? parseFloat((cashBalance / totalWithCash * 100).toFixed(1)) : 0,
      },
      holdingData,
    };
  }),

  // ── Quick Stats: price + ZIV score only (fast, ~0.5s) ─────────────────────────
  // Used by DeepAnalysisModal to show immediate data while full analysis loads
  getQuickStats: protectedProcedure
    .input(z.object({ ticker: z.string().min(1).max(16) }))
    .query(async ({ ctx, input }) => {
      const ticker = input.ticker.toUpperCase().trim();
      // Try IBKR first for price, fall back to Yahoo
      let live: { price: number; change: number; changePercent: number; prevClose: number | null; company: string; isExtendedHours?: boolean } | null = null;
      const ibkrMap = await fetchIbkrLivePricesBatch([ticker]);
      const ibkrLive = ibkrMap.get(ticker);
      if (ibkrLive?.price != null && ibkrLive.price > 0) {
        live = { price: ibkrLive.price, change: ibkrLive.change ?? 0, changePercent: ibkrLive.changePercent ?? 0, prevClose: ibkrLive.prevClose ?? null, company: ibkrLive.company ?? ticker };
      } else {
        live = await fetchLivePrice(ticker);
      }
      const bars = await fetchBarsForTicker(ticker);
      if (!live || bars.length < 50) return null;
      // Only recalculate changePercent from dailyBasePrice when IBKR data is NOT available.
      // When IBKR provides changePercent, it's the most accurate (uses real prevClose).
      const usedIbkr = ibkrLive?.price != null && ibkrLive.price > 0;
      if (!usedIbkr || live.changePercent == null || live.changePercent === 0) {
        try {
          const holdings = await getPortfolioHoldings(ctx.user.id);
          const holding = holdings.find(h => h.ticker.toUpperCase() === ticker);
          const dbBasePrice = holding?.dailyBasePrice != null ? Number(holding.dailyBasePrice) : null;
          if (dbBasePrice != null && dbBasePrice > 0 && live.price > 0) {
            live = { ...live, changePercent: ((live.price - dbBasePrice) / dbBasePrice) * 100, change: live.price - dbBasePrice, prevClose: dbBasePrice };
          }
        } catch { /* keep original */ }
      }
      const ziv = calcZivEngineScore(bars);
      const closes = bars.map(b => b.close);
      let rsi = 50;
      if (closes.length >= 15) {
        let gains = 0, losses = 0;
        for (let i = closes.length - 14; i < closes.length; i++) {
          const diff = closes[i] - closes[i - 1];
          if (diff > 0) gains += diff; else losses += Math.abs(diff);
        }
        rsi = 100 - 100 / (1 + gains / (losses || 0.0001));
      }
      const volumes = bars.map(b => b.volume ?? 0);
      const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
      const avgVol5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const volumeRatio = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;
      const last14 = bars.slice(-14);
      const atr14 = last14.reduce((sum, bar, i) => {
        const prevClose = i > 0 ? last14[i - 1].close : bar.close;
        return sum + Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
      }, 0) / 14;
      const conditions = [
        { name: "Price > EMA-200", pass: live.price > ziv.ema200, value: `$${live.price.toFixed(2)} vs $${ziv.ema200.toFixed(2)}` },
        { name: "Weekly EMA-50 Slope Positive", pass: ziv.weeklyEma50Slope > 0, value: `${ziv.weeklyEma50Slope.toFixed(3)}` },
        { name: "RSI 40-70", pass: rsi >= 40 && rsi <= 70, value: `RSI: ${rsi.toFixed(1)}` },
        { name: "Volume Confirmation", pass: volumeRatio >= 1.0, value: `${volumeRatio.toFixed(2)}x` },
        { name: "Near EMA-50 or Breakout", pass: ziv.distToEma50Pct <= 3.0 || ziv.tier === "Gold Breakout", value: `${ziv.distToEma50Pct.toFixed(1)}% from EMA-50` },
        { name: "Bullish Price Action", pass: ziv.priceAction !== null, value: ziv.priceAction ?? "None" },
      ];
      const { getCompanyBriefForUser, briefFields } = await import("../companyBrief");
      const brief = await getCompanyBriefForUser(ctx.user.id, ticker);
      const briefMeta = briefFields(brief, ticker, live.company);
      return {
        ticker,
        company: live.company,
        sector: briefMeta.sector,
        companyDescription: briefMeta.companyDescription,
        price: live.price,
        changePercent: live.changePercent,
        score: ziv.score,
        tier: ziv.tier,
        ema50: ziv.ema50,
        ema200: ziv.ema200,
        distToEma50Pct: ziv.distToEma50Pct,
        weeklyEma50Slope: ziv.weeklyEma50Slope,
        rsi,
        volumeRatio,
        atr14,
        priceAction: ziv.priceAction,
        zivReason: ziv.reason,
        conditions,
        passCount: conditions.filter(c => c.pass).length,
        entryReady: ziv.tier === "Gold Breakout" || ziv.tier === "Gold Retest",
        breakdown: ziv.breakdown ?? null,
        isOverride: ziv.breakdown?.isOverride ?? false,
      };
    }),

  // ── Deep Analysis for a single asset (per-asset modal) ──────────────────────────
  analyzeAsset: protectedProcedure
    .input(z.object({
      ticker: z.string().min(1).max(16),
      portfolioSize: z.number().optional(),
      // Holding context (if user owns this stock)
      holdingContext: z.object({
        buyPrice: z.number(),
        units: z.number(),
        currentPrice: z.number(),
        pnlUsd: z.number(),
        pnlPct: z.number(),
        stopLoss: z.number().nullable().optional(),
        takeProfit: z.number().nullable().optional(),
        diaryReason: z.string().nullable().optional(),
        diaryExpectation: z.string().nullable().optional(),
      }).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const ticker = input.ticker.toUpperCase().trim();
      const userId = ctx.user.id;

      // ── Cache key: YYYY-MM-DD + holding context hash (rounded to avoid minor price noise)
      const today = new Date().toISOString().slice(0, 10);
      const hc = input.holdingContext;
      const holdingHash = hc
        ? `${Math.round(hc.buyPrice * 100)}_${hc.units}_${Math.round(hc.currentPrice * 100)}`
        : "none";
      const cacheKey = `${today}:${holdingHash}`;

      // ── Stale-while-revalidate: return cached result immediately if < 4h old
      const cached = await getDeepAnalysisCache(ticker, cacheKey);
      if (cached && !cached.isStale) {
        const { getCompanyBriefForUser, briefFields } = await import("../companyBrief");
        const brief = await getCompanyBriefForUser(userId, ticker);
        const cachedResult = cached.result as Record<string, unknown>;
        return {
          ...cachedResult,
          ...briefFields(brief, ticker, String(cachedResult.company ?? "")),
          fromCache: true,
        };
      }
      // If stale cache exists, we proceed to refresh but will still return fresh result
      // (mutation semantics — caller waits for fresh data on stale)

      // Fetch portfolio size for position sizing (use provided value or look up from DB)
      let totalPortfolioValue = input.portfolioSize ?? 0;
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
        fetchLivePrice(ticker),
        import("../companyBrief").then(({ getCompanyBriefForUser }) => getCompanyBriefForUser(userId, ticker)),
      ]);
      if (!live) throw new TRPCError({ code: "NOT_FOUND", message: `No live data for ${ticker}` });
      if (bars.length < 50) throw new TRPCError({ code: "BAD_REQUEST", message: `Insufficient price history for ${ticker}` });

      const ziv = calcZivEngineScore(bars);

      const daMeta = await buildDeepAnalysisMeta({
        userId,
        bars,
        livePrice: live.price,
        ziv,
      });

      const hcBuyPrice = hc?.buyPrice ?? daMeta.recommendedBuyPrice;
      const hcCurrentSL = hc?.stopLoss ?? null;
      const hcCurrentTP = hc?.takeProfit ?? null;
      const zivHProxy = hc ? Math.min(10, Math.max(0, ziv.score)) : 7;
      const dynSlTp = calcDynamicSlTp(bars, zivHProxy, hcCurrentSL, hcCurrentTP, hcBuyPrice);
      const slMode = dynSlTp.slSource === "unchanged" ? "Static"
        : dynSlTp.slSource === "winners_extension" ? "Structural"
        : "Trailing";
      const tpMode = dynSlTp.tpMode === "escape" ? "Escape"
        : dynSlTp.tpMode === "extension" ? "Extension"
        : "ApproachB";

      const stopLoss = hc && dynSlTp.stopLoss > 0 && dynSlTp.stopLoss < live.price
        ? dynSlTp.stopLoss
        : daMeta.stopLoss;

      const prompt = buildDeepAnalysisPrompt({
        ticker,
        meta: { ...daMeta, stopLoss },
        livePrice: live.price,
        ziv,
        holdingContext: hc ?? null,
      });

      const aiResponse = await invokeLLM({
        messages: [
          { role: "system", content: DEEP_ANALYSIS_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "asset_deep_analysis",
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
      });
      const aiContent = String(aiResponse.choices?.[0]?.message?.content ?? "{}");
      const aiResult = JSON.parse(aiContent);

      // Persist stopLoss to portfolioHoldings if this ticker is in the user's holdings
      try {
        const allHoldings = await getPortfolioHoldings(userId);
        const matchingHolding = allHoldings.find(h => h.ticker === ticker);
        if (matchingHolding != null) {
          await updatePortfolioHolding(matchingHolding.id, userId, { stopLoss });
        }
      } catch { /* non-blocking — don't fail the analysis if DB update fails */ }
      const { briefFields } = await import("../companyBrief");
      const briefMeta = briefFields(companyBrief, ticker, live.company);
      const freshResult = {
        ticker,
        company: live.company,
        sector: briefMeta.sector,
        companyDescription: briefMeta.companyDescription,
        price: live.price,
        changePercent: live.changePercent,
        ema50: ziv.ema50,
        ema200: ziv.ema200,
        donchian20High: ziv.donchian20High,
        weeklyEma50Slope: ziv.weeklyEma50Slope,
        distToEma50Pct: ziv.distToEma50Pct,
        priceAction: ziv.priceAction,
        ...daMeta,
        score: ziv.score,
        tier: ziv.tier,
        zivReason: ziv.reason,
        stopLoss,
        stopLossPct: daMeta.stopLossPct,
        slMode,
        tpMode,
        ai: aiResult,
        totalPortfolioValue: totalPortfolioValue > 0 ? totalPortfolioValue : null,
        analyzedAt: new Date().toISOString(),
        fromCache: false,
      };
      // Save to cache (non-blocking)
      setDeepAnalysisCache(ticker, cacheKey, freshResult).catch(() => {});
      return freshResult;
    }),

  // ── Trading Diary ─────────────────────────────────────────────────────────────────────────────────
  getDiaryEntries: protectedProcedure
    .query(async ({ ctx }) => {
      return getTradingDiaryEntries(ctx.user.id);
    }),

  addDiaryEntry: protectedProcedure
    .input(z.object({
      ticker: z.string().min(1).max(16).toUpperCase(),
      company: z.string().optional(),
      units: z.number().positive(),
      buyPrice: z.number().positive(),
      stopLoss: z.coerce.number().optional(),
      takeProfit: z.coerce.number().optional(),
      reason: z.string().optional(),
      expectations: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // ── Duplicate guard: skip if ticker already in diary ──
      const existing = await getTradingDiaryEntries(ctx.user.id);
      const alreadyExists = existing.some(e => e.ticker.toUpperCase() === input.ticker.toUpperCase());
      if (alreadyExists) {
        const entry = existing.find(e => e.ticker.toUpperCase() === input.ticker.toUpperCase())!;
        return { id: entry.id, alreadyExisted: true };
      }
      // If no reason/expectations provided, generate via AI
      let reason = input.reason ?? "";
      let expectations = input.expectations ?? "";
      let stopLoss = input.stopLoss;
      let takeProfit = input.takeProfit;
      if (!stopLoss || !takeProfit) {
        try {
          const bars = await fetchBarsForTicker(input.ticker);
          if (bars.length >= 50) {
            const ziv = calcZivEngineScore(bars);
            const slByPct = input.buyPrice * 0.92;
            // For LONG positions: EMA-50 used as SL only if it's below buyPrice
            const slByEma50 = ziv.ema50 < input.buyPrice ? ziv.ema50 : slByPct;
            const computedSl = Math.max(slByPct, slByEma50);
            // Safety guard: SL must never exceed buyPrice
            const safeSl = computedSl < input.buyPrice ? computedSl : slByPct;
            stopLoss = stopLoss ?? safeSl;
            takeProfit = takeProfit ?? (input.buyPrice + 2.5 * (input.buyPrice - safeSl));
          }
        } catch { /* non-blocking */ }
      }
      if (!reason || !expectations) {
        try {
          const live = await fetchLivePrice(input.ticker);
          const aiResp = await invokeLLM({
            messages: [
              { role: "system", content: "You are a trading assistant. Respond in Hebrew. Be concise (2-3 sentences each)." },
              { role: "user", content: `Stock: ${input.ticker} (${input.company ?? live?.company ?? input.ticker}). Buy price: $${input.buyPrice}. Units: ${input.units}. Stop Loss: ${stopLoss ? '$' + stopLoss.toFixed(2) : 'N/A'}. Take Profit: ${takeProfit ? '$' + takeProfit.toFixed(2) : 'N/A'}.

Provide JSON with two fields:
- "reason": why we bought this stock (technical setup, signals, entry rationale)
- "expectations": what we expect (price target, timeline, exit strategy)` },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "diary_entry",
                strict: true,
                schema: {
                  type: "object",
                  properties: {
                    reason: { type: "string" },
                    expectations: { type: "string" },
                  },
                  required: ["reason", "expectations"],
                  additionalProperties: false,
                },
              },
            },
          });
          const parsed = JSON.parse(aiResp.choices[0].message.content as string);
          reason = reason || parsed.reason || "";
          expectations = expectations || parsed.expectations || "";
        } catch { /* non-blocking */ }
      }
      const id = await addTradingDiaryEntry({
        userId: ctx.user.id,
        ticker: input.ticker,
        company: input.company ?? null,
        units: input.units,
        buyPrice: input.buyPrice,
        stopLoss,
        takeProfit,
        reason: reason || `קנינו ${input.ticker} במחיר $${input.buyPrice}`,
        expectations: expectations || `מעקב לפי מודל זיו`,
      });
      return { id, alreadyExisted: false };
    }),

  deleteDiaryEntry: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await deleteTradingDiaryEntry(input.id, ctx.user.id);
      return { ok: true };
    }),

  updateDiaryEntry: protectedProcedure
    .input(z.object({
      id: z.number(),
      reason: z.string().optional(),
      expectations: z.string().optional(),
      stopLoss: z.number().optional(),
      takeProfit: z.number().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      await updateTradingDiaryEntry(id, ctx.user.id, data);
      return { ok: true };
    }),
  // ── Asset Archive ──────────────────────────────────────────────────────────
  archiveAssets: protectedProcedure
    .input(z.object({ tickers: z.array(z.string()).min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      await archiveUserAssets(ctx.user.id, input.tickers);
      return { ok: true, count: input.tickers.length };
    }),

  restoreAssets: protectedProcedure
    .input(z.object({ tickers: z.array(z.string()).min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      await restoreUserAssets(ctx.user.id, input.tickers);
      return { ok: true, count: input.tickers.length };
    }),

  getArchivedAssets: protectedProcedure.query(async ({ ctx }) => {
    const assets = await getArchivedUserAssets(ctx.user.id);
    return assets.map(a => ({
      id: a.id,
      ticker: a.ticker,
      company: a.companyName,
      sector: a.sector,
      score: a.score ?? null,
      tier: (a as any).tier ?? null,
      archivedAt: (a as any).archivedAt ?? null,
    }));
  }),

  bulkDeleteAssets: protectedProcedure
    .input(z.object({ tickers: z.array(z.string()).min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      await bulkDeleteUserAssets(ctx.user.id, input.tickers);
      return { ok: true, count: input.tickers.length };
    }),

  // ── Portfolio AI Chat ─────────────────────────────────────────────────────────
  // Allows free-form conversation about the portfolio analysis results.
  // Receives the full analysis context + chat history + new user message.
  portfolioChat: protectedProcedure
    .input(z.object({
      userMessage: z.string().min(1).max(2000),
      analysisContext: z.string().optional(), // JSON string of the analysis result
      holdingsContext: z.string().optional(), // JSON string of current holdings
      accountContext: z.string().optional(),  // JSON string of account balances
      chatHistory: z.array(z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      })).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;

      // Persist the user message to DB
      await saveChatMessage(userId, "user", input.userMessage);

      // Build rich context sections
      const holdingsSection = input.holdingsContext
        ? `\nCURRENT HOLDINGS:\n${input.holdingsContext}`
        : "";
      const accountSection = input.accountContext
        ? `\nACCOUNT BALANCES:\n${input.accountContext}`
        : "";
      const analysisSection = input.analysisContext
        ? `\nLATEST FULL AI ANALYSIS:\n${input.analysisContext}`
        : "";

      const systemPrompt = `You are the Ziv AI Portfolio Manager — a professional trading assistant for this portfolio owner.

IMPORTANT: Always respond in Hebrew (עברית). Be concise, actionable, and professional.
Use numbers and specific tickers when relevant. Keep answers focused and practical.

STRATEGY CONTEXT: This portfolio uses a 100% leverage strategy. A negative cash balance is NORMAL and intentional — it means the portfolio is fully invested using margin. Do NOT treat negative cash as a warning or problem.
${holdingsSection}${accountSection}${analysisSection}

You can help with:
- ניתוח אחזקות ספציפיות (stop loss, target, timing)
- הזדמנויות קנייה מהקטלוג
- ניהול סיכונים ומינוף
- גודל פוזיציה ואסטרטגיית הקצאה
- כל שאלה בנושא מסחר`;

      const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
        { role: "system", content: systemPrompt },
        ...(input.chatHistory ?? []),
        { role: "user", content: input.userMessage },
      ];

      const response = await invokeLLM({ messages });
      const reply = String(response.choices?.[0]?.message?.content ?? "");

      // Persist the assistant reply to DB
      await saveChatMessage(userId, "assistant", reply);

      return { reply };
    }),

  getChatHistory: protectedProcedure
    .query(async ({ ctx }) => {
      const history = await getChatHistory(ctx.user.id, 50);
      return history.map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content,
        createdAt: m.createdAt,
      }));
    }),

  logJournalEvent: protectedProcedure
    .input(z.object({
      eventType: z.enum(["buy", "sell", "sl_order", "tp_order", "bracket_order", "sync", "price_alert", "note"]),
      ticker: z.string().max(16).optional(),
      company: z.string().optional(),
      units: z.number().optional(),
      price: z.number().optional(),
      stopLoss: z.number().optional(),
      takeProfit: z.number().optional(),
      orderId: z.string().max(64).optional(),
      notes: z.string().optional(),
      metadata: z.string().optional(), // JSON string
      eventAt: z.date().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await logJournalEvent({
        userId: ctx.user.id,
        eventType: input.eventType,
        ticker: input.ticker ?? null,
        company: input.company ?? null,
        units: input.units ?? null,
        price: input.price ?? null,
        stopLoss: input.stopLoss ?? null,
        takeProfit: input.takeProfit ?? null,
        orderId: input.orderId ?? null,
        notes: input.notes ?? null,
        metadata: input.metadata ?? null,
        eventAt: input.eventAt ?? new Date(),
      });
      return { ok: true };
    }),

  getJournalEvents: protectedProcedure
    .input(z.object({
      ticker: z.string().optional(),
      limit: z.number().min(1).max(500).default(100),
    }))
    .query(async ({ ctx, input }) => {
      return getJournalEvents(ctx.user.id, input.ticker, input.limit);
    }),

  // ── Portfolio Performance Chart ──────────────────────────────────────────────

  /** Return all portfolio snapshots for the equity curve chart (from April 2024) */
  getSnapshotsAll: protectedProcedure
    .input(z.object({ portfolioType: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const pType = input.portfolioType ?? "h1";
      return swrGet(
        `portfolio:snapshots:${ctx.user.id}:${pType}`,
        300_000, // TTL 300s — Historical Data (equity curve, changes once per day)
        () => getPortfolioSnapshotsAll(ctx.user.id, pType),
      );
    }),

  /**
   * Record today's snapshot using the current portfolio value.
   * Called on first page load of the day, or manually via "Update Chart Now" button.
   * With forceUpdate=true: always upserts (overwrites today's snapshot with latest value).
   * Without forceUpdate: idempotent — skips if today already exists.
   */
  recordDailySnapshot: protectedProcedure
    .input(z.object({
      totalEquity: z.number().positive(),       // IBKR NLV or holdings total value
      unrealizedPnL: z.number().optional(),     // IBKR unrealized P&L
      cashBalance: z.number().optional(),       // cash from account summary
      h2Value: z.number().optional(),           // H2 portfolio total value (manual holdings)
      forceUpdate: z.boolean().optional(),      // if true, overwrite today's snapshot
      portfolioType: z.string().optional(),     // h1 | h2-tase | h2-usa | h2-crypto
    }))
    .mutation(async ({ ctx, input }) => {
      const today = new Date().toISOString().slice(0, 10);
      const pType = input.portfolioType ?? "h1";
      if (!input.forceUpdate) {
        const alreadyExists = await getTodaySnapshot(ctx.user.id, pType);
        if (alreadyExists) {
          log.debug("SYSTEM", `Daily snapshot already exists for today, skipping`, { userId: ctx.user.id, portfolioType: pType });
          return { recorded: false, reason: "already_exists" };
        }
      }
      await upsertPortfolioSnapshot({
        userId: ctx.user.id,
        snapshotDate: today,
        portfolioType: pType,
        totalValue: input.totalEquity + (input.h2Value ?? 0),
        investedValue: input.totalEquity - (input.cashBalance ?? 0) + (input.h2Value ?? 0),
        cashBalance: input.cashBalance ?? 0,
        totalCost: input.totalEquity + (input.h2Value ?? 0),
        pnlUsd: 0,
        pnlPct: 0,
        totalEquity: input.totalEquity,
        unrealizedPnL: input.unrealizedPnL ?? null,
        h2Value: input.h2Value ?? null,
      });
      log.info("SYSTEM", `Daily snapshot recorded`, { userId: ctx.user.id, date: today, portfolioType: pType, totalEquity: input.totalEquity, h2Value: input.h2Value, forced: !!input.forceUpdate });
      return { recorded: true, date: today };
    }),

  // ── Dip Analysis ─────────────────────────────────────────────────────────────
  // Standalone deep analysis for any ticker — focused on dip/entry opportunity
  // per the Ziv (Tzanua) methodology. No holding context required.
  dipAnalysis: protectedProcedure
    .input(z.object({
      ticker: z.string().min(1).max(16),
    }))
    .mutation(async ({ ctx, input }) => {
      const ticker = input.ticker.toUpperCase().trim();
      const userId = ctx.user.id;

      // Reuse today's cache if available
      const today = new Date().toISOString().slice(0, 10);
      const cacheKey = `dip:${today}:none`;
      const cached = await getDeepAnalysisCache(ticker, cacheKey);
      if (cached && !cached.isStale) {
        const { getCompanyBriefForUser, briefFields } = await import("../companyBrief");
        const brief = await getCompanyBriefForUser(userId, ticker);
        const cachedResult = cached.result as Record<string, unknown>;
        return {
          ...cachedResult,
          ...briefFields(brief, ticker, String(cachedResult.company ?? "")),
          fromCache: true,
        };
      }

      // Fetch portfolio size for position sizing
      let totalPortfolioValue = 0;
      try {
        const [account, holdings] = await Promise.all([
          getPortfolioAccount(userId),
          getPortfolioHoldings(userId),
        ]);
        const holdingsValue = holdings.reduce((sum, h) => sum + (h.currentPrice ?? h.buyPrice) * h.units, 0);
        totalPortfolioValue = holdingsValue + (account?.cashBalance ?? 0);
      } catch { /* non-blocking */ }

      const [bars, live, companyBrief] = await Promise.all([
        fetchBarsForTicker(ticker),
        fetchLivePrice(ticker),
        import("../companyBrief").then(({ getCompanyBriefForUser }) => getCompanyBriefForUser(userId, ticker)),
      ]);
      if (!live) throw new TRPCError({ code: "NOT_FOUND", message: `No live data for ${ticker}` });
      if (bars.length < 50) throw new TRPCError({ code: "BAD_REQUEST", message: `Insufficient price history for ${ticker}` });

      const ziv = calcZivEngineScore(bars);

      const daMeta = await buildDeepAnalysisMeta({
        userId,
        bars,
        livePrice: live.price,
        ziv,
      });

      const riskPerShare = daMeta.recommendedBuyPrice - daMeta.stopLoss;
      const takeProfit = riskPerShare > 0
        ? parseFloat((daMeta.recommendedBuyPrice + riskPerShare * daMeta.scaleOutR).toFixed(2))
        : daMeta.recommendedBuyPrice;
      const takeProfitPct = daMeta.recommendedBuyPrice > 0
        ? ((takeProfit - daMeta.recommendedBuyPrice) / daMeta.recommendedBuyPrice * 100)
        : 0;

      const conditionsBlock = daMeta.conditions
        .map(c => `  ${c.pass ? "✅" : "❌"} ${c.name}: ${c.value}`)
        .join("\n");

      const prompt = `אתה אנליסט ELZA 2.0. DIP ANALYSIS ל-${ticker} — האם זו הזדמנות כניסה לפי מתודולוגיית זיו 2.0?

חשוב: כל השדות בעברית. אסור 1% סיכון, Winner's Leash, או כניסה על EMA בלבד.

ZIV: ${ziv.score}/10 (${ziv.tier}) | מחיר $${live.price.toFixed(2)}
סיבת מנוע: ${ziv.reason}

תנאי ELZA: ${daMeta.passCount}/${daMeta.conditions.length}
${conditionsBlock}

אזור כניסה: $${daMeta.recommendedBuyPrice.toFixed(2)} — ${daMeta.buyPriceRationale}
SL מנוע: $${daMeta.stopLoss.toFixed(2)} (${daMeta.stopLossPct.toFixed(1)}%)
יעד מימוש ראשון (+${daMeta.scaleOutR}R): $${takeProfit.toFixed(2)} (+${takeProfitPct.toFixed(1)}%)

סלוט ELZA: ${ELZA_MAX_LONG} לונג / ${ELZA_MAX_SHORT} שורט | פנוי ללונג: ${daMeta.slotsRemainingLong}
${daMeta.positionSizeRationale}

${daMeta.exitApproachHe}
מחזור: ${daMeta.cycleNarrativeHe}${daMeta.cycleBlocked ? " — חסום, אין כניסה" : ""}
entryReady=${daMeta.entryReady ? "כן" : "לא"}

החזר JSON:
1. dipOpportunity: כן/לא/המתן
2. entryRationale: למה כן או לא לפי ELZA 2.0
3. idealEntryTrigger: טריגר מבני מדויק (ריטסט/RR/zone/פריצה+נפח)
4. risks: סיכונים עיקריים
5. summary: סיכום מנהלים 2-3 משפטים`;

      const aiResponse = await invokeLLM({
        messages: [
          { role: "system", content: DEEP_ANALYSIS_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "dip_analysis",
            strict: true,
            schema: {
              type: "object",
              properties: {
                dipOpportunity: { type: "string" },
                entryRationale: { type: "string" },
                idealEntryTrigger: { type: "string" },
                risks: { type: "string" },
                summary: { type: "string" },
              },
              required: ["dipOpportunity", "entryRationale", "idealEntryTrigger", "risks", "summary"],
              additionalProperties: false,
            },
          },
        },
      });

      const aiContent = String(aiResponse.choices?.[0]?.message?.content ?? "{}");
      const aiResult = JSON.parse(aiContent);

      const { briefFields } = await import("../companyBrief");
      const briefMeta = briefFields(companyBrief, ticker, live.company);
      const freshResult = {
        ticker,
        company: live.company,
        sector: briefMeta.sector,
        companyDescription: briefMeta.companyDescription,
        price: live.price,
        changePercent: live.changePercent,
        ema50: ziv.ema50,
        ema200: ziv.ema200,
        weeklyEma50Slope: ziv.weeklyEma50Slope,
        distToEma50Pct: ziv.distToEma50Pct,
        priceAction: ziv.priceAction,
        ...daMeta,
        score: ziv.score,
        tier: ziv.tier,
        zivReason: ziv.reason,
        takeProfit,
        takeProfitPct,
        totalPortfolioValue: totalPortfolioValue > 0 ? totalPortfolioValue : null,
        ai: aiResult,
        analyzedAt: new Date().toISOString(),
        fromCache: false,
      };

      setDeepAnalysisCache(ticker, cacheKey, freshResult).catch(() => {});
      return freshResult;
    }),

  // ── Backfill missing buyScore from current zivScore ─────────────────────────
  // For holdings added before buyScore tracking was introduced, set buyScore = zivScore
  backfillBuyScore: protectedProcedure
    .mutation(async ({ ctx }) => {
      const userId = ctx.user.id;
      const holdings = await getPortfolioHoldings(userId);
      const missing = holdings.filter(h => h.buyScore == null && h.zivScore != null && h.units !== 0);
      if (missing.length === 0) return { updated: 0, tickers: [] };
      await Promise.all(
        missing.map(h => updatePortfolioHolding(h.id, userId, { buyScore: h.zivScore! }))
      );
      log.info("SYSTEM", `backfillBuyScore: updated ${missing.length} holdings`, { userId });
      return { updated: missing.length, tickers: missing.map(h => h.ticker) };
    }),


  // ── Analyze Holding 2 (second manual portfolio) ─────────────────────────
  analyzeHolding2: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.user.id;
    log.info("ANALYSIS", "analyzeHolding2 START", { userId });
    const db = await (await import("../db")).getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
    const { holding2: h2Table } = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await db.select().from(h2Table).where(eq(h2Table.userId, userId));
    const active = rows.filter((r: any) => r.units !== 0);
    if (active.length === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "No Holding 2 positions to analyze." });
    }

    const SL_PCT = 0.08;
    const RISK_REWARD = 2.5;
    const RISK_PER_TRADE_PCT = 0.02;
    const totalPortfolioValue = active.reduce((s: number, r: any) => s + (r.currentPrice ?? r.buyPrice) * r.units, 0);

    // Deduplicate tickers before fetching bars — avoids redundant Yahoo Finance calls
    // and prevents rate-limiting timeouts when the same ticker appears multiple times
    const uniqueTickers = Array.from(new Set(active.map((r: any) => r.ticker as string)));
    log.info("ANALYSIS", "analyzeHolding2 fetching bars", { total: active.length, unique: uniqueTickers.length });

    // Fetch bars in parallel batches of 5 to speed up the analysis
    const barsMap = new Map<string, Bar[]>();
    const PARALLEL_BATCH = 5;
    for (let i = 0; i < uniqueTickers.length; i += PARALLEL_BATCH) {
      const batch = uniqueTickers.slice(i, i + PARALLEL_BATCH);
      const results = await Promise.all(batch.map(t => fetchBarsForTicker(t)));
      batch.forEach((t, idx) => barsMap.set(t, results[idx]));
      if (i + PARALLEL_BATCH < uniqueTickers.length) await new Promise(r => setTimeout(r, 400));
    }

    type H2Result = {
      id: number; ticker: string; zivScore: number; tier: string; action: string;
      reasoning: string; stopLoss: number | null; takeProfit: number | null;
      positionSizePct: number | null; suggestedUnits: number | null;
      buyPrice: number; units: number; currentPrice: number;
    };
    const results: H2Result[] = [];

    for (const r of active) {
      const bars = barsMap.get(r.ticker) ?? [];
      const currentPrice = (r.currentPrice ?? r.buyPrice) as number;
      if (bars.length < 50) {
        results.push({ id: r.id, ticker: r.ticker, zivScore: 0, tier: "No Data", action: "HOLD",
          reasoning: "Insufficient price data", stopLoss: null, takeProfit: null,
          positionSizePct: null, suggestedUnits: null,
          buyPrice: r.buyPrice as number, units: r.units as number, currentPrice });
        continue;
      }
      const ziv = calcZivEngineScore(bars);
      const score = ziv.score;
      const closes = bars.map((b: Bar) => b.close);
      const ema50Val = calcEMA(closes, 50);
      const ema200Val = closes.length >= 200 ? calcEMA(closes, 200) : calcEMA(closes, closes.length);
      const slFromEntry = currentPrice * (1 - SL_PCT);
      const stopLoss = Math.max(slFromEntry, ema50Val * 0.98);
      const risk = currentPrice - stopLoss;
      const takeProfit = currentPrice + risk * RISK_REWARD;
      const riskPerTrade = totalPortfolioValue * RISK_PER_TRADE_PCT;
      const positionSizePct = (totalPortfolioValue > 0 && risk > 0) ? (riskPerTrade / risk / totalPortfolioValue) * 100 : null;
      const suggestedUnits = risk > 0 ? Math.floor(riskPerTrade / risk) : null;
      let action = "HOLD";
      if (score >= 8) action = "ADD";
      else if (score <= 3) action = "EXIT";
      else if (currentPrice < stopLoss) action = "EXIT";
      else if (currentPrice < ema200Val * 0.97) action = "REVIEW";
      results.push({ id: r.id, ticker: r.ticker, zivScore: score, tier: ziv.tier, action,
        reasoning: ziv.reason, stopLoss, takeProfit, positionSizePct, suggestedUnits,
        buyPrice: r.buyPrice as number, units: r.units as number, currentPrice });
    }

    // Save zivScore back to DB so the H2 table shows the score without needing to re-analyze
    const { holding2: h2TableUpdate } = await import("../../drizzle/schema");
    const { eq: eqUpdate } = await import("drizzle-orm");
    await Promise.all(
      results.map(res =>
        db!.update(h2TableUpdate)
          .set({ zivScore: res.zivScore })
          .where(eqUpdate(h2TableUpdate.id, res.id))
      )
    );

    log.info("ANALYSIS", "analyzeHolding2 DONE", { userId, count: results.length });
    return { results, analyzedAt: new Date().toISOString(), totalPortfolioValue };
  }),

  // ── ZIV H Score — Single ticker (for Deep Analysis when user holds the stock) ───────────
  getZivHForTicker: protectedProcedure
    .input(z.object({
      ticker: z.string(),
      entryPrice: z.number(),
      stopLoss: z.number().nullable().optional(),
      takeProfit: z.number().nullable().optional(),
      units: z.number().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const [assets, account, holdings] = await Promise.all([
        getUserAssets(userId),
        getPortfolioAccount(userId),
        getPortfolioHoldings(userId),
      ]);
      const activeHoldings = holdings.filter(h => h.units !== 0);
      const highestWatchlistZivScore = assets.reduce((max, a) => {
        const s = a.score != null ? Number(a.score) : 0;
        return s > max ? s : max;
      }, 0);
      const cashBalance = account?.cashBalance ?? 0;
      const totalPortfolioValue = activeHoldings.reduce((sum, h) => {
        const price = h.currentPrice != null ? Number(h.currentPrice) : Number(h.buyPrice);
        return sum + calcPositionValue(price, Number(h.units));
      }, cashBalance);
      const tickersToFetch = Array.from(new Set([input.ticker, "SPY"]));
      const barsMap = await fetchBarsBatch(tickersToFetch);
      const bars = barsMap.get(input.ticker) ?? [];
      const spyBars = barsMap.get("SPY") ?? [];
      const currentPrice = bars.length > 0 ? bars[bars.length - 1].close : input.entryPrice;
      const positionValue = currentPrice * (input.units ?? 1);
      // Days held: find from holdings DB
      const holding = activeHoldings.find(h => h.ticker.toUpperCase() === input.ticker.toUpperCase());
      const assetRow = assets.find(a => a.ticker.toUpperCase() === input.ticker.toUpperCase());
      const currentEngineScore = assetRow?.score != null ? Number(assetRow.score) : null;
      const heldSince = holding ? (holding.transactionDate ?? holding.createdAt) : null;
      const daysHeld = heldSince ? Math.floor((Date.now() - new Date(heldSince).getTime()) / 86_400_000) : 0;
      // v2: fetch recent breakout level for this ticker (last 30 days)
      let recentBreakoutLevel: number | null = null;
      try {
        const { breakoutScans: bsT } = await import("../../drizzle/schema");
        const { eq: eqT, and: andT, gte: gteT, desc: descT } = await import("drizzle-orm");
        const dbT = await (await import("../db")).getDb();
        if (dbT) {
          const cutoffT = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
          const recentT = await dbT.select({ breakoutLevel: bsT.breakoutLevel })
            .from(bsT)
            .where(andT(eqT(bsT.userId, userId), eqT(bsT.ticker, input.ticker.toUpperCase()), eqT(bsT.signalType, "BREAKOUT"), gteT(bsT.scannedAt, cutoffT)))
            .orderBy(descT(bsT.scannedAt)).limit(1);
          if (recentT.length > 0) recentBreakoutLevel = recentT[0].breakoutLevel ?? null;
        }
      } catch { /* non-blocking */ }
      const zivH = calcZivHScore(bars, input.entryPrice, input.stopLoss ?? null, input.takeProfit ?? null, {
        totalPortfolioValue,
        positionValue,
        daysHeld,
        highestWatchlistZivScore,
        spyBars,
        buyScore: holding?.buyScore != null ? Number(holding.buyScore) : null,
        currentEngineScore,
        peakPrice: holding?.peakPrice != null ? Number(holding.peakPrice) : null,
        entryTier: holding?.entryTier ?? assetRow?.tier ?? null,
        ibkrUnrealizedPnl: holding?.ibkrUnrealizedPnl != null ? Number(holding.ibkrUnrealizedPnl) : null,
        recentBreakoutLevel,
        minutesInTrade: daysHeld * 24 * 60,
      });
      // Return live SL/TP (may differ from input if dynamic update applied)
      // getZivHForTicker is read-only (Deep Analysis) — DB update is handled by getZivHScores
      // but we return the effective values so the UI reflects the latest DB state
      const effectiveSL = holding?.stopLoss != null ? Number(holding.stopLoss) : (input.stopLoss ?? null);
      const effectiveTP = holding?.takeProfit != null ? Number(holding.takeProfit) : (input.takeProfit ?? null);
      return {
        ...zivH,
        positionValue,
        positionPct: totalPortfolioValue > 0 ? (positionValue / totalPortfolioValue) * 100 : 0,
        daysHeld,
        highestWatchlistZivScore,
        // Always return the freshest SL/TP from DB (not the input values which may be stale)
        stopLoss: effectiveSL,
        takeProfit: effectiveTP,
      };
    }),

  // ── ZIV H Score — Health scores for all holdings ───────────────────────────────────────────
  getZivHScores: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    // Serve from in-memory cache if fresh (< 5 min)
    const cached = getZivHFromCache(userId);
    if (cached) return cached;

    const [holdings, assets, account] = await Promise.all([
      getPortfolioHoldings(userId),
      getUserAssets(userId),
      getPortfolioAccount(userId),
    ]);
    const activeHoldings = holdings.filter(h => h.units !== 0);
    if (activeHoldings.length === 0) return [];

    // Highest ZIV score in watchlist (userAssets)
    const highestWatchlistZivScore = assets.reduce((max, a) => {
      const s = a.score != null ? Number(a.score) : 0;
      return s > max ? s : max;
    }, 0);

    // Total portfolio value: sum of (currentPrice * units) + cash
    const cashBalance = account?.cashBalance ?? 0;
    const totalPortfolioValue = activeHoldings.reduce((sum, h) => {
      const price = h.currentPrice != null ? Number(h.currentPrice) : Number(h.buyPrice);
      return sum + price * Number(h.units);
    }, cashBalance);

    // Fetch bars for all holdings + SPY
    const tickersToFetch = Array.from(new Set([...activeHoldings.map(h => h.ticker), "SPY"]));
    const barsMap = await fetchBarsBatch(tickersToFetch);
    const spyBars = barsMap.get("SPY") ?? [];

    const results = await Promise.all(activeHoldings.map(async (h) => {
      const bars = barsMap.get(h.ticker) ?? [];
      const entryPrice = h.buyPrice != null ? Number(h.buyPrice) : 0;
      const stopLoss = h.stopLoss != null ? Number(h.stopLoss) : null;
      const takeProfit = h.takeProfit != null ? Number(h.takeProfit) : null;
      // Use the latest bar close as currentPrice — consistent with what calcZivHScore uses internally.
      // Falls back to stored currentPrice, then to buyPrice.
      const livePrice = bars.length > 0 ? bars[bars.length - 1].close : null;
      const currentPrice = livePrice ?? (h.currentPrice != null ? Number(h.currentPrice) : entryPrice);
      const positionValue = calcPositionValue(currentPrice, Number(h.units));

      // Days held: use transactionDate if available, else createdAt
      const heldSince = h.transactionDate ?? h.createdAt;
      const daysHeld = heldSince
        ? Math.floor((Date.now() - new Date(heldSince).getTime()) / 86_400_000)
        : 0;

      const zivH = calcZivHScore(bars, entryPrice, stopLoss, takeProfit, {
        totalPortfolioValue,
        positionValue,
        daysHeld,
        highestWatchlistZivScore,
        spyBars,
        minutesInTrade: daysHeld * 24 * 60,
      });

      // ── Dynamic SL/TP: always compute and update DB ──
      let effectiveSL = stopLoss;
      let effectiveTP = takeProfit;
      // Determine current mode from DB (what was last saved)
      let currentSlMode: string = h.slMode ?? "Static";
      let currentTpMode: string = h.tpMode ?? "Static";
      if (bars.length >= 20 && entryPrice > 0 && Number(h.units ?? 0) >= 0) {
        const dynResult = calcDynamicSlTp(bars, zivH.score, stopLoss, takeProfit, entryPrice);
        if (dynResult.changed) {
          const newSL = dynResult.stopLoss > 0 ? dynResult.stopLoss : stopLoss;
          const newTP = dynResult.takeProfit > 0 ? dynResult.takeProfit : takeProfit;
          // Determine mode labels
          const newSlMode = dynResult.slSource === "unchanged" ? "Static"
            : dynResult.slSource === "winners_extension" ? "Winners"
            : "Trailing";
          const newTpMode = dynResult.tpMode === "escape" ? "Escape"
            : dynResult.tpMode === "extension" ? "Extension"
            : "Static";
          const updateFields: Record<string, any> = {};
          if (newSL != null && newSL !== stopLoss) updateFields.stopLoss = newSL;
          if (newTP != null && newTP !== takeProfit) updateFields.takeProfit = newTP;
          updateFields.slMode = newSlMode;
          updateFields.tpMode = newTpMode;
          updatePortfolioHolding(h.id, userId, updateFields as any)
            .then(async () => {
              if (newSL != null && newSL !== stopLoss && newSL > 0) {
                await upsertHoldingAlert(userId, h.ticker, "sl", newSL).catch(() => {});
              }
              if (newTP != null && newTP !== takeProfit && newTP > 0) {
                await upsertHoldingAlert(userId, h.ticker, "tp", newTP).catch(() => {});
              }
            })
            .catch(err => log.error("SYSTEM", `[DynamicSL] DB update failed for ${h.ticker}: ${err}`));
          effectiveSL = newSL;
          effectiveTP = newTP;
          currentSlMode = newSlMode;
          currentTpMode = newTpMode;
          log.info("SYSTEM", `[DynamicSL] ${h.ticker} H=${zivH.score.toFixed(1)} slMode=${newSlMode} tpMode=${newTpMode} SL=${newSL?.toFixed(2)} TP=${newTP?.toFixed(2)}`);
        }
      }

      return {
        id: h.id,
        ticker: h.ticker,
        score: zivH.score,
        tier: zivH.tier,
        suggestedAction: zivH.suggestedAction,
        indicators: zivH.indicators,
        bonuses: zivH.bonuses,
        penalties: zivH.penalties,
        details: zivH.details,
        // Context values for display
        positionValue,
        positionPct: totalPortfolioValue > 0 ? (positionValue / totalPortfolioValue) * 100 : 0,
        daysHeld,
        // Live SL/TP (may have been dynamically updated this cycle)
        stopLoss: effectiveSL,
        takeProfit: effectiveTP,
        // Dynamic mode labels
        slMode: currentSlMode,
        tpMode: currentTpMode,
      };
    }));

    setZivHCache(userId, results);
    return results;
  }),

  // ── ZIV H Health Scores for Holding 2 ─────────────────────────────────────────────
  getZivHScoresH2: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    // Serve from in-memory cache if fresh (< 5 min)
    const cachedH2 = getZivH2FromCache(userId);
    if (cachedH2) return cachedH2;

    const db = await (await import("../db")).getDb();
    if (!db) return [];
    const { holding2: h2Table } = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await db.select().from(h2Table).where(eq(h2Table.userId, userId));
    const active = rows.filter((r: any) => r.units !== 0);
    if (active.length === 0) return [];

    // Total H2 portfolio value (no separate cash balance for H2)
    const totalPortfolioValue = active.reduce((sum: number, r: any) => {
      const price = r.currentPrice != null ? Number(r.currentPrice) : Number(r.buyPrice);
      return sum + price * Number(r.units);
    }, 0);

    // Fetch bars for all H2 tickers + SPY
    const tickersToFetch = Array.from(new Set([...active.map((r: any) => r.ticker as string), "SPY"]));
    const barsMap = await fetchBarsBatch(tickersToFetch);
    const spyBars = barsMap.get("SPY") ?? [];

    const results = await Promise.all(active.map(async (h: any) => {
      const bars = barsMap.get(h.ticker) ?? [];
      const entryPrice = h.buyPrice != null ? Number(h.buyPrice) : 0;
      // H2 table has no stopLoss/takeProfit columns
      const stopLoss: number | null = null;
      const takeProfit: number | null = null;
      const livePrice = bars.length > 0 ? bars[bars.length - 1].close : null;
      const currentPrice = livePrice ?? (h.currentPrice != null ? Number(h.currentPrice) : entryPrice);
      const positionValue = calcPositionValue(currentPrice, Number(h.units));
      const heldSince = h.createdAt;
      const daysHeld = heldSince
        ? Math.floor((Date.now() - new Date(heldSince).getTime()) / 86_400_000)
        : 0;

      const stopLossVal: number | null = h.stopLoss != null ? Number(h.stopLoss) : null;
      const takeProfitVal: number | null = h.takeProfit != null ? Number(h.takeProfit) : null;

      const zivH = calcZivHScore(bars, entryPrice, stopLossVal, takeProfitVal, {
        totalPortfolioValue,
        positionValue,
        daysHeld,
        highestWatchlistZivScore: 0,
        spyBars,
        minutesInTrade: daysHeld * 24 * 60,
      });

      // ── Dynamic SL/TP for H2: silent DB update during NYSE trading hours ──
      let effectiveSL = stopLossVal;
      let effectiveTP = takeProfitVal;
      let currentSlMode: string = h.slMode ?? "Static";
      let currentTpMode: string = h.tpMode ?? "Static";
      if (bars.length >= 20 && entryPrice > 0) {
        const dynResult = calcDynamicSlTp(bars, zivH.score, stopLossVal, takeProfitVal, entryPrice);
        if (dynResult.changed) {
          const newSL = dynResult.stopLoss > 0 ? dynResult.stopLoss : stopLossVal;
          const newTP = dynResult.takeProfit > 0 ? dynResult.takeProfit : takeProfitVal;
          const newSlMode = dynResult.slSource === "unchanged" ? "Static"
            : dynResult.slSource === "winners_extension" ? "Winners"
            : "Trailing";
          const newTpMode = dynResult.tpMode === "escape" ? "Escape"
            : dynResult.tpMode === "extension" ? "Extension"
            : "Static";
          const updateFields: Record<string, any> = {};
          if (newSL != null && newSL !== stopLossVal) updateFields.stopLoss = newSL;
          if (newTP != null && newTP !== takeProfitVal) updateFields.takeProfit = newTP;
          updateFields.slMode = newSlMode;
          updateFields.tpMode = newTpMode;
          db.update(h2Table)
            .set(updateFields as any)
            .where(eq(h2Table.id, h.id))
            .catch((err: unknown) => log.error("SYSTEM", `[DynamicSL-H2] DB update failed for ${h.ticker}: ${err}`));
          log.info("SYSTEM", `[DynamicSL-H2] ${h.ticker} H=${zivH.score.toFixed(1)} slMode=${newSlMode} tpMode=${newTpMode} SL=${newSL?.toFixed(2)} TP=${newTP?.toFixed(2)}`);
          effectiveSL = newSL;
          effectiveTP = newTP;
          currentSlMode = newSlMode;
          currentTpMode = newTpMode;
        }
      }

      return {
        id: h.id,
        ticker: h.ticker,
        score: zivH.score,
        tier: zivH.tier,
        suggestedAction: zivH.suggestedAction,
        indicators: zivH.indicators,
        bonuses: zivH.bonuses,
        penalties: zivH.penalties,
        details: zivH.details,
        positionValue,
        positionPct: totalPortfolioValue > 0 ? (positionValue / totalPortfolioValue) * 100 : 0,
        daysHeld,
        stopLoss: effectiveSL,
        takeProfit: effectiveTP,
        slMode: currentSlMode,
        tpMode: currentTpMode,
      };
    }));

    setZivH2Cache(userId, results);
    return results;
  }),

  // ── Admin: Refresh ZIV scores for ALL users' catalogue assets ─────────────
  adminRefreshAllCatalogueScores: adminProcedure
    .mutation(async () => {
      const { getDb } = await import("../db");
      const { users: usersTable, userAssets: ua } = await import("../../drizzle/schema");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      // 1. Get all users
      const allUsers = await db.select({ id: usersTable.id }).from(usersTable);

      // 2. Collect unique tickers across all users
      const allAssetRows = await db.select({ userId: ua.userId, ticker: ua.ticker }).from(ua);
      const uniqueTickers = Array.from(new Set(allAssetRows.map(r => r.ticker.toUpperCase())));

      if (uniqueTickers.length === 0) return { updated: 0, tickers: [] };

      // 3. Fetch bars for all unique tickers (batched, with rate-limit delays)
      const barsMap = await fetchBarsBatch(uniqueTickers, 420);

      // 4. Compute ZIV score for each ticker
      const scoreMap = new Map<string, { score: number; label: string; reason: string; price: number; ema50: number; ema200: number; donchian20High: number }>();
      for (const ticker of uniqueTickers) {
        const bars = barsMap.get(ticker) ?? [];
        if (bars.length < 50) continue;
        try {
          const ziv = calcZivEngineScore(bars);
          scoreMap.set(ticker, {
            score: ziv.score,
            label: ziv.tier,
            reason: ziv.reason,
            price: ziv.price,
            ema50: ziv.ema50,
            ema200: ziv.ema200,
            donchian20High: ziv.donchian20High,
          });
        } catch { /* skip */ }
      }

      // 5. Update scores for every user-asset row
      let updated = 0;
      for (const row of allAssetRows) {
        const s = scoreMap.get(row.ticker.toUpperCase());
        if (!s) continue;
        await updateUserAssetScore(row.userId, row.ticker, s.score, null, {
          cmp: s.price,
          ema50: s.ema50,
          ema200: s.ema200,
          donchian20High: s.donchian20High,
          tier: s.label,
          reason: s.reason,
        });
        updated++;
      }

      return { updated, tickers: Array.from(scoreMap.keys()), users: allUsers.length };
    }),

  // ── Admin: Copy owner's catalogue to a target user ────────────────────────
  adminCopyCatalogueToUser: adminProcedure
    .input(z.object({ targetUserId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const { getDb, eq: dbEq, and: dbAnd } = await import("../db").then(async m => {
        const { eq, and } = await import("drizzle-orm");
        return { ...m, eq, and };
      });
      const { userAssets: ua } = await import("../../drizzle/schema");
      const { eq, and } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      // Get owner's assets (all non-archived)
      const ownerAssets = await db.select().from(ua)
        .where(and(eq(ua.userId, ctx.user.id), eq(ua.archived, 0)));
      if (ownerAssets.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Owner has no assets" });
      // Get target user's existing tickers
      const targetAssets = await db.select({ ticker: ua.ticker }).from(ua)
        .where(eq(ua.userId, input.targetUserId));
      const existingTickers = new Set(targetAssets.map(r => r.ticker.toUpperCase()));
      // Insert missing assets
      let added = 0;
      for (const asset of ownerAssets) {
        const t = asset.ticker.toUpperCase();
        if (existingTickers.has(t)) continue;
        await db.insert(ua).values({
          userId: input.targetUserId,
          ticker: t,
          companyName: asset.companyName,
          sector: asset.sector,
          score: asset.score,
          label: asset.label,
          sortOrder: asset.sortOrder,
          cmp: asset.cmp,
          ema50: asset.ema50,
          ema200: asset.ema200,
          proximityToEma50Pct: asset.proximityToEma50Pct,
          recommendation: asset.recommendation,
          reason: asset.reason,
          tier: asset.tier,
          weeklyEma50Slope: asset.weeklyEma50Slope,
          donchian20High: asset.donchian20High,
          priceAction: asset.priceAction,
          recommendedBuyPrice: asset.recommendedBuyPrice,
          recommendedStopLoss: asset.recommendedStopLoss,
          hotSignal: asset.hotSignal ?? 0,
          profitPotential: asset.profitPotential,
        });
        added++;
      }
      return { added, total: ownerAssets.length, targetUserId: input.targetUserId };
    }),

  // Force SL/TP re-sync from Ziv Engine (admin only)
  forceSlResync: adminProcedure.mutation(async ({ ctx }) => {
    const result = await runNightlySlResync(ctx.user.id);
    // Invalidate the portfolio state SWR cache so the UI gets fresh SL/TP values
    swrInvalidate(`portfolio:state:${ctx.user.id}`);
    return result;
  }),

  // Dedup Holdings: merge duplicate tickers into one row
  dedupHoldings: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.user.id;
    const { getDb } = await import("../db");
    const { eq, and } = await import("drizzle-orm");
    const { portfolioHoldings } = await import("../../drizzle/schema");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

    // Get all holdings for this user
    const all = await db.select().from(portfolioHoldings)
      .where(eq(portfolioHoldings.userId, userId));

    // Group by ticker
    const byTicker = new Map<string, typeof all>();
    for (const h of all) {
      const key = h.ticker.toUpperCase();
      if (!byTicker.has(key)) byTicker.set(key, []);
      byTicker.get(key)!.push(h);
    }

    let merged = 0;
    for (const [, rows] of Array.from(byTicker)) {
      if (rows.length <= 1) continue;
      // Sort by id ascending - keep the first (oldest) row
      rows.sort((a: { id: number }, b: { id: number }) => a.id - b.id);
      const [keep, ...dupes] = rows;
      // Weighted avg buy price + sum units
      let totalUnits = keep.units;
      let totalCost = keep.buyPrice * keep.units;
      for (const d of dupes) {
        totalUnits += d.units;
        totalCost += d.buyPrice * d.units;
      }
      const weightedBuy = totalUnits > 0 ? totalCost / totalUnits : keep.buyPrice;
      // Update the kept row
      await db.update(portfolioHoldings)
        .set({ units: totalUnits, buyPrice: weightedBuy })
        .where(eq(portfolioHoldings.id, keep.id));
      // Delete duplicate rows
      for (const d of dupes) {
        await db.delete(portfolioHoldings)
          .where(and(eq(portfolioHoldings.id, d.id), eq(portfolioHoldings.userId, userId)));
      }
      merged += dupes.length;
    }
    return { merged, message: merged > 0 ? `Merged ${merged} duplicate rows` : "No duplicates found" };
  }),

  // ── Live price polling for Deep Analysis (lightweight — no ZIV, just price + changePercent) ──
  // Priority: IBKR (real-time) → Yahoo (fallback)
  // Today% is recalculated using dailyBasePrice for consistency with PortfolioDetail.
  getLivePriceForTicker: protectedProcedure
    .input(z.object({ ticker: z.string().min(1).max(16) }))
    .query(async ({ ctx, input }) => {
      const ticker = input.ticker.toUpperCase().trim();

      // Try IBKR first (single ticker batch)
      let price: number | null = null;
      let changePercent: number | null = null;
      let change: number | null = null;
      let prevClose: number | null = null;
      let isExtendedHours = false;
      let source: 'ibkr' | 'yahoo' = 'yahoo';

      const ibkrMap = await fetchIbkrLivePricesBatch([ticker]);
      const ibkrLive = ibkrMap.get(ticker);
      if (ibkrLive?.price != null && ibkrLive.price > 0) {
        price = ibkrLive.price;
        change = ibkrLive.change ?? null;
        changePercent = ibkrLive.changePercent ?? null;
        prevClose = ibkrLive.prevClose ?? null;
        isExtendedHours = ibkrLive.isExtendedHours ?? false;
        source = 'ibkr';
      } else {
        // Fallback to Yahoo
        const yahooLive = await fetchLivePrice(ticker);
        if (!yahooLive) return null;
        price = yahooLive.price;
        change = yahooLive.change;
        changePercent = yahooLive.changePercent;
        prevClose = yahooLive.prevClose;
        isExtendedHours = yahooLive.isExtendedHours ?? false;
      }

      // Use IBKR changePercent directly when available (most accurate during RTH).
      // Only recalculate from dailyBasePrice when using Yahoo fallback and no IBKR data.
      if (source === 'yahoo' || changePercent == null) {
        try {
          const holdings = await getPortfolioHoldings(ctx.user.id);
          const holding = holdings.find(h => h.ticker.toUpperCase() === ticker);
          const dbBasePrice = holding?.dailyBasePrice != null ? Number(holding.dailyBasePrice) : null;
          if (dbBasePrice != null && dbBasePrice > 0 && price != null && price > 0) {
            changePercent = ((price - dbBasePrice) / dbBasePrice) * 100;
            change = price - dbBasePrice;
            prevClose = dbBasePrice;
          } else {
            // Also check H2 holdings
            const { holding2 } = await import("../../drizzle/schema");
            const { eq, and } = await import("drizzle-orm");
            const db = await (await import("../db")).getDb();
            if (db) {
              const [h2Row] = await db.select().from(holding2)
                .where(and(eq(holding2.userId, ctx.user.id), eq(holding2.ticker, ticker)))
                .limit(1);
              const h2Base = h2Row?.dailyBasePrice != null ? Number(h2Row.dailyBasePrice) : null;
              if (h2Base != null && h2Base > 0 && price != null && price > 0) {
                changePercent = ((price - h2Base) / h2Base) * 100;
                change = price - h2Base;
                prevClose = h2Base;
              }
            }
          }
        } catch { /* DB error — keep original changePercent */ }
      }

      return {
        ticker,
        price,
        changePercent,
        change,
        prevClose,
        isExtendedHours,
        source,
        fetchedAt: new Date().toISOString(),
      };
    }),

  // ── Daily Position Changes ─────────────────────────────────────────────────
  // Returns all position changes (opened/closed/increased/reduced) for a given date.
  getDailyPositionChanges: protectedProcedure
    .input(z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // YYYY-MM-DD, defaults to today (Israel time)
    }))
    .query(async ({ ctx, input }) => {
      // Default to today in Israel time (UTC+3)
      let date = input.date;
      if (!date) {
        const nowMs = Date.now() + 3 * 3600 * 1000;
        date = new Date(nowMs).toISOString().slice(0, 10);
      }
      const changes = await getDailyPositionChanges(ctx.user.id, date);
      return { date, changes };
    }),

  // ── Persist H1 live prices (dailyChangePercent) from IBKR quotes to DB ──
  // Called by frontend when IBKR quotes return non-zero changePercent.
  // This allows pre-market fallback to show last session's change.
  updateH1Prices: protectedProcedure
    .input(z.object({
      prices: z.array(z.object({
        ticker: z.string(),
        price: z.number(),
        changePercent: z.number().nullable(),
      })),
    }))
    .mutation(async ({ ctx, input }) => {
      const { getDb } = await import("../db");
      const db = await getDb();
      if (!db) return { updated: [] };
      const { portfolioHoldings } = await import("../../drizzle/schema");
      const { eq, and } = await import("drizzle-orm");
      const updated: string[] = [];
      for (const p of input.prices) {
        if (p.changePercent === null || p.changePercent === 0) continue;
        try {
          await db.update(portfolioHoldings)
            .set({
              currentPrice: p.price,
              dailyChangePercent: p.changePercent,
              priceUpdatedAt: new Date(),
            })
            .where(
              and(
                eq(portfolioHoldings.userId, ctx.user.id),
                eq(portfolioHoldings.ticker, p.ticker)
              )
            );
          updated.push(p.ticker);
        } catch { /* skip individual failures */ }
      }
      return { updated };
    }),
});