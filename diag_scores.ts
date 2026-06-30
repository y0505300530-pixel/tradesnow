import * as dotenv from "dotenv";
dotenv.config();
import { fetchBarsForTicker } from "./server/marketData";
import { calcZivEngineScore } from "./server/zivEngine";
import { calcMentorBoost } from "./server/mentorScoreBoost";
import { getMarketRegime, getTickerIntelligence } from "./server/runtimeIntelligence";
import { getUserAssets } from "./server/db";

const tickers = ["NVDA","AAPL","META","CRWD","RDDT","AVGO"];
const userId = 1;
const assets = await getUserAssets(userId);

for (const ticker of tickers) {
  const bars = await fetchBarsForTicker(ticker, 420);
  const ziv = calcZivEngineScore(bars);
  const asset = assets.find((a:any) => a.ticker.toUpperCase()===ticker) as any;
  const confScore = asset?.mentorConfidence ?? undefined;
  const signalBias = asset?.signalBias ?? undefined;
  const boost = await calcMentorBoost(userId, ticker, ziv.tier, asset?.mentorSources ?? undefined, confScore);
  const final = Math.min(10, ziv.score + boost.bonus);
  const regime = await getMarketRegime();
  const intel = await getTickerIntelligence(ticker, bars);
  console.log(`${ticker}: base=${ziv.score.toFixed(1)} boost=+${boost.bonus.toFixed(2)} final=${final.toFixed(1)} bias=${signalBias||'null'} conf=${confScore||'null'} conf_score=${intel.confluenceScore.toFixed(1)} longOk=${regime.longOk} weekly=${intel.weeklyAligned}`);
}
process.exit(0);
