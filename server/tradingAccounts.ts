/**
 * Trading accounts + gateways — DB access and runtime context builder.
 */
import { eq, and, asc } from "drizzle-orm";
import { getDb } from "./db";
import {
  ibkrGateways,
  tradingAccounts,
  liveEngineConfig,
  type TradingAccount,
  type IbkrGateway,
} from "../drizzle/schema";
import { ENV } from "./_core/env";
import {
  type TradingAccountRuntime,
  parseGatewayUrl,
  resolveEnvSecret,
} from "./tradingAccountContext";

export type TradingAccountRow = TradingAccount & { gateway: IbkrGateway };

export async function listTradingAccounts(activeOnly = true): Promise<TradingAccountRow[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(tradingAccounts)
    .orderBy(asc(tradingAccounts.sortOrder), asc(tradingAccounts.id));
  const gateways = await db.select().from(ibkrGateways);
  const gwMap = new Map(gateways.map((g) => [g.id, g]));
  return rows
    .filter((r) => !activeOnly || r.isActive === 1)
    .map((r) => ({ ...r, gateway: gwMap.get(r.gatewayId)! }))
    .filter((r) => r.gateway);
}

export async function getTradingAccountBySlug(slug: string): Promise<TradingAccountRow | null> {
  const all = await listTradingAccounts(false);
  return all.find((a) => a.slug === slug) ?? null;
}

export async function getTradingAccountById(id: number): Promise<TradingAccountRow | null> {
  const all = await listTradingAccounts(false);
  return all.find((a) => a.id === id) ?? null;
}

export async function getDefaultTradingAccountForUser(userId: number): Promise<TradingAccountRow | null> {
  const all = await listTradingAccounts();
  return all.find((a) => a.slug === "ceo") ?? all.find((a) => a.ownerUserId === userId) ?? all[0] ?? null;
}

export function buildTradingAccountRuntime(
  account: TradingAccountRow,
  ibkrAccountIdOverride?: string,
): TradingAccountRuntime {
  const { host, port } = parseGatewayUrl(account.gateway.baseUrl);
  const apiSecret = resolveEnvSecret(account.gateway.apiSecretEnvKey, ENV.ibindApiSecret);
  const hmacSecret = resolveEnvSecret(account.gateway.hmacSecretEnvKey, ENV.ibindHmacSecret);
  const ibkrId = (ibkrAccountIdOverride ?? account.ibkrAccountId)?.trim()
    || ENV.ibkrLiveAccountId.trim();
  return {
    tradingAccountId: account.id,
    slug: account.slug,
    label: account.label,
    ibkrAccountId: ibkrId,
    catalogUserId: account.catalogUserId,
    ownerUserId: account.ownerUserId,
    gateway: {
      id: account.gateway.id,
      slug: account.gateway.slug,
      baseUrl: account.gateway.baseUrl,
      host,
      port,
      apiSecret,
      hmacSecret,
    },
  };
}

/** Accounts the app user may view in War Room. */
export async function listTradingAccountsForViewer(
  appUserId: number,
  role: string,
): Promise<TradingAccountRow[]> {
  const all = await listTradingAccounts();
  if (role === "admin") return all;
  return all.filter((a) => a.linkedLocalUserId === appUserId);
}

export async function assertTradingAccountAccess(
  appUserId: number,
  role: string,
  accountSlug: string,
): Promise<TradingAccountRow> {
  const account = await getTradingAccountBySlug(accountSlug);
  if (!account) throw new Error("TRADING_ACCOUNT_NOT_FOUND");
  if (role === "admin") return account;
  if (account.linkedLocalUserId === appUserId) return account;
  throw new Error("TRADING_ACCOUNT_FORBIDDEN");
}

export async function getLiveConfigForTradingAccount(
  tradingAccountId: number,
): Promise<typeof liveEngineConfig.$inferSelect | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(liveEngineConfig)
    .where(eq(liveEngineConfig.tradingAccountId, tradingAccountId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getMinOrderUsd(config: typeof liveEngineConfig.$inferSelect | null): Promise<number> {
  const v = Number((config as { minOrderUsd?: number })?.minOrderUsd);
  if (Number.isFinite(v) && v > 0) return v;
  return 5000;
}
