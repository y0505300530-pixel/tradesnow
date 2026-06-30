import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";
import { COOKIE_NAME } from "@shared/const";
import { requiresTwoFactor, isSessionVerified } from "../twoFactor";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
  needs2fa: boolean;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;
  let needs2fa = false;

  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    // Authentication is optional for public procedures.
    user = null;
  }

  // Enforce TOTP 2FA: if the owner is authenticated but their session
  // has not been verified via TOTP, set needs2fa = true.
  if (user && requiresTwoFactor(user.openId)) {
    const sessionToken = opts.req.cookies?.[COOKIE_NAME];
    if (sessionToken) {
      const verified = await isSessionVerified(sessionToken);
      if (!verified) {
        needs2fa = true;
      }
    } else {
      needs2fa = true;
    }
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
    needs2fa,
  };
}
