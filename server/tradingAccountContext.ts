/**
 * Per-cycle IBKR gateway + account routing (AsyncLocalStorage).
 * War Engine / Live Executor run inside runWithTradingAccount() so ibindRequest
 * hits the correct IBIND instance and accountId resolves per book.
 */
import { AsyncLocalStorage } from "async_hooks";
import { ENV } from "./_core/env";

export interface GatewayRuntime {
  id: number;
  slug: string;
  baseUrl: string;
  host: string;
  port: number;
  apiSecret: string;
  hmacSecret: string;
}

export interface TradingAccountRuntime {
  tradingAccountId: number;
  slug: string;
  label: string;
  ibkrAccountId: string;
  catalogUserId: number;
  ownerUserId: number;
  gateway: GatewayRuntime;
}

const als = new AsyncLocalStorage<TradingAccountRuntime>();

export function runWithTradingAccount<T>(
  ctx: TradingAccountRuntime,
  fn: () => Promise<T>,
): Promise<T> {
  return als.run(ctx, fn);
}

/** Synchronous bind for long async functions that cannot be wrapped in als.run(). */
export function enterTradingAccount(ctx: TradingAccountRuntime): void {
  als.enterWith(ctx);
}

export function getTradingAccountRuntime(): TradingAccountRuntime | undefined {
  return als.getStore();
}

/** Active IBKR account id for orders/sync — context or env fallback. */
export function getLiveAccountId(): string {
  const fromCtx = als.getStore()?.ibkrAccountId?.trim();
  if (fromCtx) return fromCtx;
  return ENV.ibkrLiveAccountId.trim();
}

export function getCatalogUserId(fallbackUserId: number): number {
  return als.getStore()?.catalogUserId ?? fallbackUserId;
}

export function getTradingAccountId(): number | undefined {
  return als.getStore()?.tradingAccountId;
}

export function parseGatewayUrl(baseUrl: string): { host: string; port: number } {
  try {
    const u = new URL(baseUrl);
    const port = u.port
      ? parseInt(u.port, 10)
      : u.protocol === "https:" ? 443 : 80;
    return { host: u.hostname, port };
  } catch {
    return {
      host: process.env.IBIND_HOST_OVERRIDE ?? "127.0.0.1",
      port: parseInt(process.env.IBIND_PORT_OVERRIDE ?? "5000", 10),
    };
  }
}

export function resolveEnvSecret(envKey: string | null | undefined, fallback: string): string {
  if (!envKey?.trim()) return fallback;
  const v = process.env[envKey.trim()];
  return v?.trim() ? v.trim() : fallback;
}
