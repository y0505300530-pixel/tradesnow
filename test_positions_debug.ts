import { ibindRequest } from "./server/routers/ibkrProxy";

async function main() {
  // Check /positions for per-position fields
  console.log("=== /positions ===");
  const posRes = await ibindRequest('GET', '/positions');
  const positions = (posRes.body as any)?.positions || posRes.body;
  if (Array.isArray(positions) && positions.length > 0) {
    console.log('Keys:', Object.keys(positions[0]));
    // Show RKLB and NOW specifically
    for (const p of positions) {
      const ticker = p.ticker || p.symbol || p.local_symbol || '';
      if (['RKLB', 'NOW', 'SNDK', 'CRWD'].includes(ticker.toUpperCase())) {
        console.log(`\n${ticker}:`, JSON.stringify(p));
      }
    }
  } else {
    console.log('Raw:', JSON.stringify(posRes.body).slice(0, 500));
  }

  // Check /pnl for daily P&L
  console.log("\n\n=== /pnl ===");
  const pnlRes = await ibindRequest('GET', '/pnl');
  console.log(JSON.stringify(pnlRes.body, null, 2));
}
main().catch(e => console.error(e));
