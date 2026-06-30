import { ibindRequest } from "./server/routers/ibkrProxy";

async function main() {
  // Try various endpoints that might give per-position daily P&L
  
  // 1. /pnl with conid parameter
  console.log("=== /pnl?conid=787273575 (RKLB) ===");
  const r1 = await ibindRequest('GET', '/pnl?conid=787273575');
  console.log('Status:', r1.status, JSON.stringify(r1.body).slice(0, 500));

  // 2. /positions/pnl
  console.log("\n=== /positions/pnl ===");
  const r2 = await ibindRequest('GET', '/positions/pnl');
  console.log('Status:', r2.status, JSON.stringify(r2.body).slice(0, 500));

  // 3. /portfolio/positions
  console.log("\n=== /portfolio/positions ===");
  const r3 = await ibindRequest('GET', '/portfolio/positions');
  console.log('Status:', r3.status, JSON.stringify(r3.body).slice(0, 500));

  // 4. Check if /quotes has a refresh/force option
  console.log("\n=== /quotes with force_refresh ===");
  const r4 = await ibindRequest('POST', '/quotes', { symbols: ['RKLB'], exchange_hint: 'SMART', force_refresh: true });
  console.log('Status:', r4.status, JSON.stringify(r4.body).slice(0, 500));
}
main().catch(e => console.error(e));
