import * as dotenv from "dotenv";
dotenv.config();
import { fetchIbkrLivePricesBatch } from "./server/marketData";
const tickers = ["AVGO","NVDA","RTX","CWAN","ETSY"];
const prices = await fetchIbkrLivePricesBatch(tickers);
if (typeof prices.get === "function") {
  for (const t of tickers) console.log(t, "->", prices.get(t));
} else {
  console.log(JSON.stringify(prices, null, 2));
}
process.exit(0);
