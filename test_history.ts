import { ibindRequest } from "./server/routers/ibkrProxy";

async function main() {
  // Try /history endpoint for RKLB to get yesterday's close
  console.log("=== /history?conid=787273575&period=2d&bar=1d ===");
  const r1 = await ibindRequest('GET', '/history?conid=787273575&period=2d&bar=1d');
  console.log('Status:', r1.status, JSON.stringify(r1.body).slice(0, 1000));

  // Try /bars
  console.log("\n=== /bars?conid=787273575&period=2d&bar=1d ===");
  const r2 = await ibindRequest('GET', '/bars?conid=787273575&period=2d&bar=1d');
  console.log('Status:', r2.status, JSON.stringify(r2.body).slice(0, 1000));

  // Try /market-data
  console.log("\n=== /market-data?conid=787273575 ===");
  const r3 = await ibindRequest('GET', '/market-data?conid=787273575');
  console.log('Status:', r3.status, JSON.stringify(r3.body).slice(0, 1000));
}
main().catch(e => console.error(e));
