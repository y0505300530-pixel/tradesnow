import { ibindRequest } from "./server/routers/ibkrProxy";

async function main() {
  // Try /help or /endpoints
  const r1 = await ibindRequest('GET', '/');
  console.log('/ Status:', r1.status, JSON.stringify(r1.body).slice(0, 500));
  
  const r2 = await ibindRequest('GET', '/help');
  console.log('/help Status:', r2.status, JSON.stringify(r2.body).slice(0, 500));

  const r3 = await ibindRequest('GET', '/health');
  console.log('/health Status:', r3.status, JSON.stringify(r3.body).slice(0, 500));
}
main().catch(e => console.error(e));
