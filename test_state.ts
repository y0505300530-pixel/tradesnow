import * as dotenv from "dotenv";
dotenv.config();
// Simulate getState
import { swrGet } from "./server/swrCache";
import { getPortfolioAccount, getPortfolioHoldings, getCapitalEvents } from "./server/db";
const userId = 1;
const result = await swrGet(
  "portfolio:state:test:" + userId,
  15000,
  async () => {
    const [account, holdings, events] = await Promise.all([
      getPortfolioAccount(userId),
      getPortfolioHoldings(userId),
      getCapitalEvents(userId, 20),
    ]);
    return { account, holdings, events };
  }
);
console.log("getState result - holdings:", result?.holdings?.length, "account cash:", result?.account?.cashBalance);
if (result?.holdings) {
  console.log("First ticker:", result.holdings[0]?.ticker);
}
process.exit(0);
