import { ibindRequest } from "./server/routers/ibkrProxy";

async function main() {
  // Try /pnl/positions or /pnl?type=positions
  console.log("=== /pnl/positions ===");
  const r1 = await ibindRequest('GET', '/pnl/positions');
  console.log('Status:', r1.status);
  console.log(JSON.stringify(r1.body, null, 2).slice(0, 2000));
}
main().catch(e => console.error(e));
