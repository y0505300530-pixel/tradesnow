/**
 * Security tests — hardened admin-only procedures (P0 auth hardening).
 */
import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from "../shared/const";

vi.mock("./alertPoller", () => ({
  runDailyBasePriceSnapshot: vi.fn().mockResolvedValue(undefined),
}));


vi.mock("./db", () => ({
  getDb: vi.fn().mockResolvedValue(null),
  setSystemSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./warEngine", () => ({
  runWarEngineCycle: vi.fn().mockResolvedValue({ scanned: 0, entered: 0 }),
}));

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

const ADMIN_ONLY_MUTATIONS: Array<{
  label: string;
  call: (caller: ReturnType<typeof appRouter.createCaller>) => Promise<unknown>;
}> = [
  { label: "forceBaselineRefresh", call: c => c.forceBaselineRefresh() },
  { label: "insights.runWarEngine", call: c => c.insights.runWarEngine() },
];

describe("P0 auth hardening — adminProcedure gates", () => {
  for (const { label, call } of ADMIN_ONLY_MUTATIONS) {
    it(`${label}: unauthenticated → UNAUTHORIZED`, async () => {
      const caller = appRouter.createCaller(makeCtx({ user: null }));
      await expect(call(caller)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        message: UNAUTHED_ERR_MSG,
      });
    });

    it(`${label}: non-admin user → FORBIDDEN`, async () => {
      const caller = appRouter.createCaller(
        makeCtx({ user: makeUser("user"), needs2fa: false }),
      );
      await expect(call(caller)).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: NOT_ADMIN_ERR_MSG,
      });
    });
  }

  it("forceBaselineRefresh: admin without 2FA → TOTP_REQUIRED", async () => {
    const caller = appRouter.createCaller(
      makeCtx({ user: makeUser("admin"), needs2fa: true }),
    );
    await expect(caller.forceBaselineRefresh()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "TOTP_REQUIRED",
    });
  });

  it("forceBaselineRefresh: verified admin → succeeds", async () => {
    const caller = appRouter.createCaller(
      makeCtx({ user: makeUser("admin"), needs2fa: false }),
    );
    const result = await caller.forceBaselineRefresh();
    expect(result).toMatchObject({ success: true });
  });
});
