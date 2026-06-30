import { ibindRequest } from "./server/routers/ibkrProxy";

async function main() {
  // Try /snapshot for RKLB (conid 787273575)
  console.log("=== /snapshot/787273575 ===");
  const r1 = await ibindRequest('GET', '/snapshot/787273575');
  console.log('Status:', r1.status);
  console.log(JSON.stringify(r1.body, null, 2).slice(0, 1000));

  // Try /market-data/history for RKLB
  console.log("\n=== /market-data/history ===");
  const r2 = await ibindRequest('GET', '/market-data/history?conid=787273575&period=1d&bar=1d');
  console.log('Status:', r2.status);
  console.log(JSON.stringify(r2.body, null, 2).slice(0, 1000));

  // Try /quotes with snapshot_fields
  console.log("\n=== /quotes with fields ===");
  const r3 = await ibindRequest('POST', '/quotes', { 
    symbols: ['RKLB'], 
    exchange_hint: 'SMART',
    fields: ['prior_close', 'close', 'last', 'change', 'change_percent', 'open', 'high', 'low']
  });
  console.log('Status:', r3.status);
  console.log(JSON.stringify(r3.body, null, 2).slice(0, 1000));
}
main().catch(e => console.error(e));
