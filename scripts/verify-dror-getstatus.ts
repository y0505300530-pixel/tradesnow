/**
 * Verify liveEngine.getStatus routing for Dror → IBIND2.
 * Usage: node --env-file=.env --import tsx scripts/verify-dror-getstatus.ts
 */
import {
  getTradingAccountBySlug,
  buildTradingAccountRuntime,
  getLiveConfigForTradingAccount,
} from "../server/tradingAccounts";
import { runWithTradingAccount } from "../server/tradingAccountContext";
import { ibindRequest } from "../server/routers/ibkrProxy";

async function main() {
  const account = await getTradingAccountBySlug("dror");
  if (!account) {
    console.error("FAIL: dror account not found");
    process.exit(1);
  }

  const result = await runWithTradingAccount(buildTradingAccountRuntime(account), async () => {
    const port = buildTradingAccountRuntime(account).gateway.port;
    const [healthRes, config] = await Promise.all([
      ibindRequest("GET", "/health"),
      getLiveConfigForTradingAccount(account.id),
    ]);

    let positionsRes: { ok: boolean; status: number } = { ok: false, status: 0 };
    try {
      positionsRes = await ibindRequest("GET", "/positions");
    } catch {
      /* dormant may return 503 on session endpoints */
    }

    return {
      port,
      health: healthRes,
      positionsStatus: positionsRes.status,
      config: config
        ? { isEnabled: config.isEnabled, tradingAccountId: (config as { tradingAccountId?: number }).tradingAccountId }
        : null,
      account: { slug: account.slug, label: account.label },
    };
  });

  console.log("=== liveEngine.getStatus routing (Dror) ===");
  console.log(`  gateway port: ${result.port}`);
  console.log(`  ibkrConnected: ${result.health.ok}`);
  console.log(`  ibkrSessionActive: ${(result.health.body as Record<string, unknown>)?.session_active}`);
  console.log(`  ibind mode: ${(result.health.body as Record<string, unknown>)?.mode}`);
  console.log(`  /positions status: ${result.positionsStatus}`);
  console.log(`  liveEngineConfig: ${JSON.stringify(result.config)}`);
  console.log(`  account: ${JSON.stringify(result.account)}`);

  if (result.port !== 5002) {
    console.error("FAIL: not routing to port 5002");
    process.exit(1);
  }
  if (!result.health.ok) {
    console.error("FAIL: health check failed");
    process.exit(1);
  }
  if (result.config?.isEnabled === 1) {
    console.error("WARN: Dror engine isEnabled=1 — should be dormant (0)");
  }

  console.log("\nOK: getStatus path routes Dror → IBIND2 (dormant)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
