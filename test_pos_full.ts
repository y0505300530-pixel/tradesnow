import { ibindRequest } from "./server/routers/ibkrProxy";

async function main() {
  const posRes = await ibindRequest('GET', '/positions');
  const positions = (posRes.body as any)?.positions || posRes.body;
  if (Array.isArray(positions)) {
    for (const p of positions) {
      const ticker = (p.contractDesc || p.ticker || p.symbol || '').split(' ')[0];
      console.log(`${ticker}: pos=${p.position}, mktPrice=${p.mktPrice}, avgCost=${p.avgCost}, avgPrice=${p.avgPrice}, unrealizedPnl=${p.unrealizedPnl}, realizedPnl=${p.realizedPnl}, mktValue=${p.mktValue}`);
    }
  }
}
main().catch(e => console.error(e));
