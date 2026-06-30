// Quick test: call ibindRequest directly to see raw IBKR /quotes response
import { ibindRequest } from "./server/routers/ibkrProxy";

async function main() {
  const symbols = ['RKLB', 'SNDK', 'CRWD', 'D', 'NOW', 'NVDA', 'AAPL', 'MU'];
  const res = await ibindRequest('POST', '/quotes', { symbols, exchange_hint: 'SMART' });
  console.log('Status:', res.status);
  console.log(JSON.stringify(res.body, null, 2));
}
main().catch(e => console.error(e));
