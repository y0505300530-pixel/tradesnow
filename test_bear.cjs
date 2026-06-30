
const { calcBearScore, calcShortSL } = require('./dist/server/shortEngine');
const { callDataApi } = require('./dist/server/_core/dataApi');

async function test() {
  const tickers = ['NVDA', 'AMD', 'SMCI', 'INTC', 'COIN', 'RIVN', 'PTON', 'SNAP', 'NIO'];
  const results = [];
  
  for (const ticker of tickers) {
    try {
      const raw = await callDataApi(`/bars/daily/${ticker}?limit=250`);
      const bars = raw?.bars ?? [];
      if (bars.length < 50) { console.log(`${ticker}: insufficient bars (${bars.length})`); continue; }
      
      const bear = calcBearScore(bars);
      const sl = calcShortSL(bars, bear.price);
      const risk = sl - bear.price;
      const tp = Math.max(0, bear.price - 3 * risk);
      
      results.push({ ticker, score: bear.score.toFixed(1), tier: bear.tier, price: bear.price.toFixed(2), sl: sl.toFixed(2), tp: tp.toFixed(2) });
    } catch(e) {
      console.log(`${ticker}: error - ${e.message}`);
    }
  }
  
  console.log(JSON.stringify(results, null, 2));
}
test().catch(console.error);
