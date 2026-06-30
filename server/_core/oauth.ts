import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";
import { requiresTwoFactor, initiateTwoFactor } from "../twoFactor";
import { sendTelegramMessage } from "../telegram";
import { log } from "../logger";

/** 1-hour cooldown per openId to prevent login alert spam */
const loginAlertCooldown = new Map<string, number>();
const LOGIN_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/** Send a login alert to the owner's Telegram */
async function sendLoginAlert(req: Request, name: string, email: string | null, openId?: string) {
  // Cooldown: skip if same user logged in within the last hour
  if (openId) {
    const lastSent = loginAlertCooldown.get(openId) ?? 0;
    if (Date.now() - lastSent < LOGIN_ALERT_COOLDOWN_MS) {
      return; // suppress duplicate login alert
    }
    loginAlertCooldown.set(openId, Date.now());
  }
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
  const ua = req.headers["user-agent"] || "unknown";
  const now = new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", hour12: false });
  // Detect device type from user-agent
  const device = /mobile|android|iphone|ipad/i.test(ua) ? "📱 Mobile" : "🖥️ Desktop";
  const browser = ua.match(/(Chrome|Firefox|Safari|Edge|Opera)\/[\d.]+/)?.[0] || "Unknown browser";
  const msg = [
    "🔐 <b>Login Alert — trade-snow2.vip</b>",
    "",
    `👤 <b>User:</b> ${name || "(no name)"}${email ? ` (${email})` : ""}`,
    `🕐 <b>Time:</b> ${now}`,
    `🌐 <b>IP:</b> <code>${ip}</code>`,
    `${device} | ${browser}`,
  ].join("\n");
  await sendTelegramMessage(msg).catch(() => {/* non-critical */});
}

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

export function registerOAuthRoutes(app: Express) {
  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");

    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);

      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }

      await db.upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: new Date(),
      });

      // 2FA: if this is the owner, redirect to Google Authenticator TOTP verification
      log.info("AUTH", `OAuth login`, { openId: userInfo.openId, requires2FA: requiresTwoFactor(userInfo.openId) });
      if (requiresTwoFactor(userInfo.openId)) {
        log.info("AUTH", `Redirecting to 2FA`, { openId: userInfo.openId });
        // Alert sent after TOTP verification, not here
        await initiateTwoFactor(userInfo.openId, req, res);
        return;
      }

      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      log.info("AUTH", `Login success`, { openId: userInfo.openId, name: userInfo.name });

      // Send login alert (non-blocking, 1h cooldown)
      sendLoginAlert(req, userInfo.name || "", userInfo.email ?? null, userInfo.openId);

      res.redirect(302, "/");
    } catch (error: any) {
      log.error("AUTH", "OAuth callback failed", { error: error?.message });
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}
