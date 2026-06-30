import * as dotenv from "dotenv";
dotenv.config();
import { fetchBarsForTicker } from "./server/marketData";
import { calcZivEngineScore } from "./server/zivEngine";
import { calcMentorBoost } from "./server/mentorScoreBoost";
import { getMarketRegime, getTickerIntelligence } from "./server/runtimeIntelligence";
import { getUserAssets, getDb } from "./server/db";
import { paperPositions } from "./drizzle/schema";
import { eq, inArray, and } from "drizzle-orm";

const userId = 1;
const ticker = "NVDA";
const assets = await getUserAssets(userId);
const bars = await fetchBarsForTicker(ticker, 420);
const ziv = calcZivEngineScore(bars);
const asset = assets.find((a:any) => a.ticker.toUpperCase()===ticker) as any;
const confScore = asset?.mentorConfidence ?? undefined;
const boost = await calcMentorBoost(userId, ticker, ziv.tier, asset?.mentorSources ?? undefined, confScore);
const final = Math.min(10, ziv.score + boost.bonus);
const regime = await getMarketRegime();
const intel = await getTickerIntelligence(ticker, bars);

// Check open positions
const db = await getDb();
const openPositions = db ? await db.select().from(paperPositions).where(and(eq(paperPositions.userId, userId), inArray(paperPositions.status, ["open","pending_entry"]))) : [];
const alreadyOpen = openPositions.some((p:any) => p.ticker === ticker && p.direction === "long");

console.log("NVDA FULL DIAG:");
console.log("  score:", final.toFixed(2), ">=7.0?", final >= 7.0);
console.log("  confluence:", intel.confluenceScore.toFixed(1), ">=4.5?", intel.confluenceScore >= 4.5);
console.log("  liquidity:", intel.liquidityScore.toFixed(1), ">=2.0?", intel.liquidityScore >= 2.0);
console.log("  weeklyAligned:", intel.weeklyAligned);
console.log("  longOk:", regime.longOk);
console.log("  alreadyOpen:", alreadyOpen);
console.log("  signalBias:", asset?.signalBias);
console.log("  openPositions total:", openPositions.length);
console.log("  MAX_WAR_POSITIONS check (5):", openPositions.length >= 5);
process.exit(0);
