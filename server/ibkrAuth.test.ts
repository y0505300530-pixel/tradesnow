/**
 * Security tests — live order endpoints must be admin + 2FA gated.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from "../shared/const";

vi.mock("./routers/ibkrProxy", () => ({
  ibindRequest: vi.fn().mockResolvedValue({ ok: true, status: 200, body: { success: true, order_id: "1" } }),
  ibindCached: vi.fn().mockResolvedValue({ ok: true, status: 200, body: { positions: [] } }),
  primeAccountsIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./db", () => ({
  getDb: vi.fn().mockResolvedValue(null),
  getIbkrSettings: vi.fn().mockResolvedValue({ accountId: "U12345678" }),
}));

const ORDER_INPUT = {
  placeMarketOrder: {
    ticker: "AAPL",
    conid: 265598,
    side: "BUY" as const,
    quantity: 1,
  },
  placeSTPOrder: {
    ticker: "AAPL",
    conid: 265598,
    quantity: 1,
    stopPrice: 140,
    accountId: "U12345678",
  },
  placeLMTOrder: {
    ticker: "AAPL",
    conid: 265598,
    quantity: 1,
    limitPrice: 150,
    accountId: "U12345678",
  },
  placeStopLossIbind: {
    ticker: "AAPL",
    conid: 265598,
    side: "SELL" as const,
    quantity: 1,
    stopPrice: 140,
  },
  placeTakeProfitIbind: {
    ticker: "AAPL",
    conid: 265598,
    side: "SELL" as const,
    quantity: 1,
    limitPrice: 160,
  },
  placeBracketIbind: {
    ticker: "AAPL",
    conid: 265598,
    side: "BUY" as const,
    quantity: 1,
    entryPrice: 150,
    stopLoss: 140,
    takeProfit: 165,
  },
  cancelOrder: {
    orderId: "12345",
    holdingId: 1,
    field: "sl" as const,
  },
};

type OrderProc = keyof typeof ORDER_INPUT;

const ORDER_PROCEDURES: OrderProc[] = [
  "placeMarketOrder",
  "placeSTPOrder",
  "placeLMTOrder",
  "placeStopLossIbind",
  "placeTakeProfitIbind",
  "placeBracketIbind",
  "cancelOrder",
];

function makeUser(role: "user" | "admin"): NonNullable<TrpcContext["user"]> {
  return {
    id: role === "admin" ? 1 : 2,
    openId: `${role}-open-id`,
    email: `${role}@example.com`,
    name: role === "admin" ? "Admin" : "User",
    loginMethod: "local",
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
}

function makeCtx(opts: {
  user?: TrpcContext["user"];
  needs2fa?: boolean;
}): TrpcContext {
  return {
    user: opts.user ?? null,
    needs2fa: opts.needs2fa ?? false,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
}

async function callOrder(proc: OrderProc, ctx: TrpcContext): Promise<unknown> {
  const caller = appRouter.createCaller(ctx);
  return (caller.ibkr as any)[proc](ORDER_INPUT[proc]);
}

describe("IBKR order auth hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const proc of ORDER_PROCEDURES) {
    it(`${proc}: unauthenticated → UNAUTHORIZED`, async () => {
      const ctx = makeCtx({ user: null });
      await expect(callOrder(proc, ctx)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        message: UNAUTHED_ERR_MSG,
      } satisfies Partial<TRPCError>);
    });

    it(`${proc}: non-admin user → FORBIDDEN`, async () => {
      const ctx = makeCtx({ user: makeUser("user"), needs2fa: false });
      await expect(callOrder(proc, ctx)).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: NOT_ADMIN_ERR_MSG,
      } satisfies Partial<TRPCError>);
    });

    it(`${proc}: admin without 2FA → TOTP_REQUIRED`, async () => {
      const ctx = makeCtx({ user: makeUser("admin"), needs2fa: true });
      await expect(callOrder(proc, ctx)).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "TOTP_REQUIRED",
      } satisfies Partial<TRPCError>);
    });
  }

  it("adminProcedure inherits protectedProcedure 2FA gate", async () => {
    const ctx = makeCtx({ user: makeUser("admin"), needs2fa: true });
    await expect(appRouter.createCaller(ctx).ibkr.getSettings()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "TOTP_REQUIRED",
    });
  });
});

describe("liveOrderExecutor exports", () => {
  it("exports LIVE_ACCOUNT_ID and resolveConid", async () => {
    const mod = await import("./liveOrderExecutor");
    expect(typeof mod.resolveConid).toBe("function");
    expect(typeof mod.LIVE_ACCOUNT_ID).toBe("string");
  });
});

describe("liveEngine IBKR path interpolation", () => {
  it("closePosition requires tracked DB row (no IBKR-only fallback)", async () => {
    const src = await import("fs/promises").then(fs =>
      fs.readFile(new URL("./routers/liveEngine.ts", import.meta.url), "utf8")
    );
    expect(src).toContain("executeLiveSell");
    expect(src).toContain("אין פוזיציה במעקב");
    expect(src).not.toContain("closePosition IBKR-only");
  });

  it("placeManualOrder partial close awaits realDeps (not the factory fn)", async () => {
    const src = await import("fs/promises").then(fs =>
      fs.readFile(new URL("./routers/liveEngine.ts", import.meta.url), "utf8")
    );
    // Regression: passing `partialDeps` without await caused `deps.getPosition is not a function`.
    expect(src).toMatch(/executeLivePartialClose\([\s\S]*?await partialDeps\(userId\)/);
    expect(src).not.toMatch(/executeLivePartialClose\([\s\S]*?,\s*partialDeps,\s*\)/);
  });
});
