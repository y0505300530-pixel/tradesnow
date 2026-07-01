/**
 * Verify Dror site routing → IBIND2 (:5002).
 * Usage: node --env-file=.env --import tsx scripts/verify-dror-ibind2.ts
 */
import { getTradingAccountBySlug, buildTradingAccountRuntime } from "../server/tradingAccounts";
import { runWithTradingAccount } from "../server/tradingAccountContext";
import { ibindRequest } from "../server/routers/ibkrProxy";

async function main() {
  const account = await getTradingAccountBySlug("dror");
  if (!account) {
    console.error("FAIL: trading account 'dror' not found");
    process.exit(1);
  }

  const runtime = buildTradingAccountRuntime(account);
  const { host, port, slug: gwSlug } = runtime.gateway;

  console.log("=== Dror gateway config ===");
  console.log(`  baseUrl: ${runtime.gateway.baseUrl}`);
  console.log(`  resolved: ${host}:${port}`);
  console.log(`  gateway slug: ${gwSlug}`);
  console.log(`  apiSecretEnvKey: ${account.gateway.apiSecretEnvKey}`);
  console.log(`  apiSecret loaded: ${runtime.gateway.apiSecret ? "yes" : "NO"}`);
  console.log(`  hmacSecret loaded: ${runtime.gateway.hmacSecret ? "yes" : "NO"}`);

  if (port !== 5002) {
    console.error(`FAIL: expected port 5002, got ${port} — run drizzle/0148_dror_gateway_5002.sql`);
    process.exit(1);
  }

  const result = await runWithTradingAccount(runtime, () =>
    ibindRequest("GET", "/health"),
  );

  console.log("\n=== IBIND2 health (via ibindRequest) ===");
  console.log(`  status: ${result.status}`);
  console.log(`  ok: ${result.ok}`);
  console.log(`  body: ${JSON.stringify(result.body)}`);

  if (result.status === 401 || result.status === 403) {
    console.error("FAIL: auth mismatch between tradesnow .env and ibind-oauth-dror");
    process.exit(1);
  }

  if (result.status === 503 && typeof result.body === "object" && result.body !== null) {
    const body = result.body as Record<string, unknown>;
    if (body.mode === "dror_dormant" || body.error === "oauth_pending") {
      console.log("\nOK: Connected to IBIND2 (dormant — OAuth not wired yet)");
      process.exit(0);
    }
  }

  if (result.ok) {
    console.log("\nOK: Connected to IBIND2");
    process.exit(0);
  }

  console.error("\nFAIL: unexpected response from IBIND2");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
