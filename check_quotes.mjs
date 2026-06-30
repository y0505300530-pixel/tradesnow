// Check what IBKR Gateway returns for H1 tickers right now
const baseUrl = 'http://127.0.0.1:3000';
const symbols = ['NVDA','AAPL','SNDK','MU','CRWD','GOOG','RKLB','NOW','MRVL','ALAB','D'];
const url = `${baseUrl}/api/trpc/ibkr.getIbkrQuotes?input=${encodeURIComponent(JSON.stringify({json:{ symbols }}))}`;

const res = await fetch(url);
const data = await res.json();

if (data?.result?.data?.json?.quotes) {
  console.log('Symbol     | price      | prevClose  | changePercent | error');
  console.log('-----------|------------|------------|---------------|------');
  for (const q of data.result.data.json.quotes) {
    const sym = (q.symbol || '').padEnd(10);
    const price = (q.price != null ? q.price.toFixed(2) : 'null').padEnd(10);
    const prev = (q.prevClose != null ? q.prevClose.toFixed(2) : 'null').padEnd(10);
    const chg = (q.changePercent != null ? q.changePercent.toFixed(4) + '%' : 'null').padEnd(13);
    console.log(`${sym} | ${price} | ${prev} | ${chg} | ${q.error || ''}`);
  }
  console.log('\nTotal quotes:', data.result.data.json.quotes.length);
  console.log('Unresolved:', data.result.data.json.unresolved);
} else {
  console.log('Unexpected response:', JSON.stringify(data).substring(0, 1000));
}
