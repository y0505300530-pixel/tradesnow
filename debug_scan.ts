
import { fetchBarsForTicker } from "./server/marketData";
import { getUserAssets } from "./server/db";

async function main() {
  const assets = await getUserAssets(1);
  const usTickers = assets.filter((a: any) => !a.ticker.toUpperCase().endsWith(".TA")).slice(0,5);
  console.log("US tickers sample:", usTickers.map((a:any) => a.ticker).join(", "));
  
  for (const asset of usTickers) {
    try {
      const bars = await fetchBarsForTicker(asset.ticker.toUpperCase(), 60);
      console.log(`${asset.ticker}: bars=${bars.length} close=${bars[bars.length-1]?.close?.toFixed(2)}`);
    } catch(e:any) {
      console.log(`${asset.ticker}: ERROR ${e.message.slice(0,60)}`);
    }
  }
  process.exit(0);
}
main().catch(e => { console.error("MAIN_ERR:", e.message); process.exit(1); });
