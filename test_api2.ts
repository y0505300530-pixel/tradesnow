import * as dotenv from "dotenv";
dotenv.config();
import { getPortfolioHoldings, getPortfolioAccount } from "./server/db";
const holdings = await getPortfolioHoldings(1);
const account  = await getPortfolioAccount(1);
console.log("Holdings:", holdings.length, "items");
console.log("Cash:", account?.cashBalance);
console.log("Tickers:", holdings.map((h:any)=>h.ticker).join(", "));
process.exit(0);
