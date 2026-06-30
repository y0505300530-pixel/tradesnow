import { ibindRequest } from "./server/routers/ibkrProxy";

async function main() {
  const res = await ibindRequest('POST', '/quotes', { symbols: ['RKLB', 'NVDA', 'MU', 'SNDK'], exchange_hint: 'SMART' });
  const quotes = (res.body as any)?.quotes || [];
  for (const q of quotes) {
    console.log(`\n${q.ticker}:`);
    console.log(`  is_market_open: ${q.is_market_open}`);
    console.log(`  extended_hours_used: ${q.extended_hours_used}`);
    console.log(`  extended_hours_timestamp: ${q.extended_hours_timestamp ? new Date(q.extended_hours_timestamp).toISOString() : 'null'}`);
    console.log(`  _updated: ${new Date(q._updated).toISOString()}`);
    console.log(`  current_price: ${q.current_price}`);
    console.log(`  prior_close: ${q.prior_close}`);
    console.log(`  snapshot_last: ${q.snapshot_last}`);
    console.log(`  change: ${q.change}`);
    console.log(`  change_percent: ${q.change_percent}`);
    console.log(`  md_availability: ${q.md_availability}`);
  }
}
main().catch(e => console.error(e));
