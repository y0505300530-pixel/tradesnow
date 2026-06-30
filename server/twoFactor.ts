/**
 * Google Authenticator TOTP — Two-Factor Authentication
 *
 * SECURITY MODEL (v4 — speakeasy):
 *  - Every session issued by OAuth callback is UNVERIFIED by default.
 *  - A session becomes VERIFIED only after the owner enters a correct TOTP code.
 *  - The verified_sessions DB table is the single source of truth.
 *  - requiresTotpVerification() is called on EVERY authenticated request.
 *  - If the session is not in verified_sessions → 403 with needs_2fa:true.
 *  - Frontend detects needs_2fa and redirects to /verify-2fa.
 *
 * Login flow:
 *  1. Owner logs in → OAuth callback → initiateTwoFactor() called
 *  2. totpSecret exists → issue short-lived session JWT → HTML redirect /verify-2fa
 *  3. Owner enters 6-digit code → POST /api/2fa/verify-existing → TOTP checked via speakeasy
 *  4. Session inserted into verified_sessions → owner can use the app
 *
 * Rate limiting:
 *  - /api/2fa/verify-existing: max 5 attempts per IP per minute
 */

import type { Express, Request, Response } from "express";
import crypto from "crypto";
import speakeasy from "speakeasy";
import QRCode from "qrcode";
import { getDb } from "./db";
import { users } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { sdk } from "./_core/sdk";
import { getSessionCookieOptions } from "./_core/cookies";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { ENV } from "./_core/env";
import mysql from "mysql2/promise";
import { sendTelegramMessage } from "./telegram";

/** Send a Telegram alert on a failed TOTP attempt */
async function sendFailedTotpAlert(req: Request, openId: string): Promise<void> {
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
  const ua = req.headers["user-agent"] || "unknown";
  const now = new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", hour12: false });
  const device = /mobile|android|iphone|ipad/i.test(ua) ? "📱 Mobile" : "🖥️ Desktop";
  const browser = ua.match(/(Chrome|Firefox|Safari|Edge|Opera)\/[\d.]+/)?.[0] || "Unknown browser";
  const msg = [
    "⚠️ <b>Failed 2FA Attempt — trade-snow2.vip</b>",
    "",
    `❌ <b>Incorrect TOTP code entered</b>`,
    `🕐 <b>Time:</b> ${now}`,
    `🌐 <b>IP:</b> <code>${ip}</code>`,
    `${device} | ${browser}`,
    "",
    "<i>If this wasn't you, consider revoking all sessions immediately.</i>",
  ].join("\n");
  await sendTelegramMessage(msg).catch(() => {/* non-critical */});
}

/** 1-hour cooldown per openId to prevent 2FA login alert spam */
const totpAlertCooldown = new Map<string, number>();
const TOTP_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/** Send a Telegram alert after successful TOTP verification */
async function sendTotpLoginAlert(req: Request, openId: string): Promise<void> {
  // Cooldown: skip if same user verified within the last hour
  const lastSent = totpAlertCooldown.get(openId) ?? 0;
  if (Date.now() - lastSent < TOTP_ALERT_COOLDOWN_MS) {
    return; // suppress duplicate login alert
  }
  totpAlertCooldown.set(openId, Date.now());

  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
  const ua = req.headers["user-agent"] || "unknown";
  const now = new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", hour12: false });
  const device = /mobile|android|iphone|ipad/i.test(ua) ? "📱 Mobile" : "🖥️ Desktop";
  const browser = ua.match(/(Chrome|Firefox|Safari|Edge|Opera)\/[\d.]+/)?.[0] || "Unknown browser";
  const msg = [
    "🔐 <b>Login Alert — trade-snow2.vip</b>",
    "",
    `✅ <b>2FA verified successfully</b>`,
    `🕐 <b>Time:</b> ${now}`,
    `🌐 <b>IP:</b> <code>${ip}</code>`,
    `${device} | ${browser}`,
  ].join("\n");
  await sendTelegramMessage(msg).catch(() => {/* non-critical */});
}

const PENDING_TTL_MS = 30 * 60 * 1000; // 30 minutes to enter the code

/**
 * Verify a TOTP code against a base32 secret using speakeasy.
 * window: 1 allows ±30 seconds tolerance (one step before/after current).
 */
function verifyTOTP(code: string, secret: string): boolean {
  try {
    return speakeasy.totp.verify({
      secret,
      encoding: "base32",
      token: code.trim(),
      window: 1,
    });
  } catch (e) {
    console.error("[2FA] speakeasy.totp.verify failed:", e);
    return false;
  }
}

/**
 * Determine if this user should go through 2FA.
 * Only the platform owner requires 2FA.
 */
export function requiresTwoFactor(openId: string): boolean {
  // Local password users (openId starts with "local:") are already authenticated
  // via password — no additional TOTP required.
  if (openId.startsWith("local:")) return false;
  if (ENV.ownerOpenId && openId === ENV.ownerOpenId) return true;
  return openId === "jaDEMUoCJyxDvKw6XvdrrS";
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(ip: string, key: string, maxHits: number, windowMs = 60_000): boolean {
  const bucket = `${key}:${ip}`;
  const now = Date.now();
  const entry = rateLimitMap.get(bucket);

  if (!entry || now - entry.windowStart > windowMs) {
    rateLimitMap.set(bucket, { count: 1, windowStart: now });
    return true;
  }

  entry.count += 1;
  return entry.count <= maxHits;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of Array.from(rateLimitMap.entries())) {
    if (now - entry.windowStart > 120_000) rateLimitMap.delete(key);
  }
}, 5 * 60 * 1000);

/** Get real client IP (respects X-Forwarded-For behind proxy) */
function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

// ─── DB helpers (raw mysql2 to avoid drizzle migration) ──────────────────────

let _conn: mysql.Connection | null = null;
async function getConn(): Promise<mysql.Connection> {
  if (_conn) {
    try { await _conn.ping(); return _conn; } catch { _conn = null; }
  }
  _conn = await mysql.createConnection(process.env.DATABASE_URL!);
  return _conn;
}

/** Mark a session token as TOTP-verified in the DB */
export async function markSessionVerified(sessionToken: string, openId: string, expiresInMs?: number): Promise<void> {
  try {
    const conn = await getConn();
    const now = Date.now();
    const expiresAt = now + (expiresInMs ?? 4 * 60 * 60 * 1000); // default 4h
    await conn.execute(
      "INSERT IGNORE INTO verified_sessions (session_token, open_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      [sessionToken, openId, now, expiresAt]
    );
  } catch (e) {
    console.error("[2FA] Failed to mark session verified:", e);
  }
}

/** Check if a session token has been TOTP-verified */
export async function isSessionVerified(sessionToken: string): Promise<boolean> {
  try {
    const conn = await getConn();
    const now = Date.now();
    const [rows] = await conn.execute(
      "SELECT expires_at FROM verified_sessions WHERE session_token = ? LIMIT 1",
      [sessionToken]
    ) as [mysql.RowDataPacket[], mysql.FieldPacket[]];
    if (rows.length === 0) return false;
    const expiresAt = rows[0].expires_at;
    // If expires_at is set and has passed → not verified
    if (expiresAt && now > expiresAt) {
      // Clean up expired entry
      conn.execute("DELETE FROM verified_sessions WHERE session_token = ?", [sessionToken]).catch(() => {});
      return false;
    }
    return true;
  } catch (e) {
    console.error("[2FA] Failed to check session verified:", e);
    return false;
  }
}

/** Remove all verified sessions for an openId (force re-auth) */
export async function revokeAllSessions(openId: string): Promise<void> {
  try {
    const conn = await getConn();
    await conn.execute("DELETE FROM verified_sessions WHERE open_id = ?", [openId]);
    console.log(`[2FA] Revoked all sessions for ${openId}`);
  } catch (e) {
    console.error("[2FA] Failed to revoke sessions:", e);
  }
}

// ─── Express routes ──────────────────────────────────────────────────────────

export function registerTwoFactorRoutes(app: Express) {
  /**
   * GET /api/totp/status
   * Returns whether TOTP is configured for the current owner session.
   */
  app.get("/api/totp/status", async (req: Request, res: Response) => {
    const sessionToken = req.cookies?.[COOKIE_NAME];
    if (!sessionToken) { res.status(401).json({ error: "Not authenticated" }); return; }
    let openId: string;
    try {
      const result = await sdk.verifySession(sessionToken);
      if (!result) throw new Error("invalid");
      openId = result.openId;
    } catch { res.status(401).json({ error: "Invalid session" }); return; }

    const db = await getDb();
    if (!db) { res.status(500).json({ error: "Database unavailable" }); return; }
    const rows = await db.select({ totpSecret: users.totpSecret }).from(users).where(eq(users.openId, openId)).limit(1);
    const configured = rows.length > 0 && !!rows[0].totpSecret;
    const verified = await isSessionVerified(sessionToken);
    res.json({ configured, verified });
  });

  /**
   * POST /api/2fa/verify-existing
   * For sessions that are already authenticated (have a valid JWT) but not yet
   * TOTP-verified (needs2fa = true). Accepts { code, rememberDevice } and marks the session verified.
   * Rate limited: 5 attempts per IP per minute.
   */
  app.post("/api/2fa/verify-existing", async (req: Request, res: Response) => {
    const ip = getClientIp(req);
    if (!checkRateLimit(ip, "2fa-verify-existing", 5)) {
      res.status(429).json({ error: "Too many attempts. Please wait a minute and try again." }); return;
    }

    const sessionToken = req.cookies?.[COOKIE_NAME];
    console.log(`[2FA/verify-existing] cookie present: ${!!sessionToken}, len: ${sessionToken?.length ?? 0}`);
    if (!sessionToken) {
      console.warn("[2FA/verify-existing] No session cookie. Cookie header:", req.headers.cookie?.substring(0, 100));
      res.status(401).json({ error: "Not authenticated" }); return;
    }

    let openId: string;
    try {
      const result = await sdk.verifySession(sessionToken);
      console.log(`[2FA/verify-existing] verifySession: ${result ? `openId=${result.openId}` : "null"}`);
      if (!result) throw new Error("invalid");
      openId = result.openId;
    } catch (e) {
      console.warn("[2FA/verify-existing] verifySession failed:", String(e));
      res.status(401).json({ error: "Invalid session" }); return;
    }

    if (!requiresTwoFactor(openId)) {
      await markSessionVerified(sessionToken, openId);
      res.json({ success: true }); return;
    }

    const { code, rememberDevice } = req.body as { code?: string; rememberDevice?: boolean };
    if (!code) { res.status(400).json({ error: "code is required" }); return; }

    const db = await getDb();
    if (!db) { res.status(500).json({ error: "Database unavailable" }); return; }
    const rows = await db.select({ totpSecret: users.totpSecret }).from(users).where(eq(users.openId, openId)).limit(1);
    if (rows.length === 0 || !rows[0].totpSecret) {
      res.status(401).json({ error: "TOTP not configured — contact admin" }); return;
    }

    const secret = rows[0].totpSecret;
    console.log(`[2FA/verify-existing] secret length: ${secret.length}, code: ${code.trim()}`);

    const isValid = verifyTOTP(code, secret);
    console.log(`[2FA/verify-existing] isValid: ${isValid}`);

    if (!isValid) {
      sendFailedTotpAlert(req, openId).catch(() => {});
      res.status(401).json({ error: "Incorrect code — try again" }); return;
    }

    // If "Remember this device" — issue a new long-lived session (30 days)
    // Always issue a new long-lived session after successful 2FA.
    // Default: 4 hours. With "Remember device": 30 days.
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const sessionDuration = rememberDevice ? THIRTY_DAYS_MS : FOUR_HOURS_MS;
    const finalSessionToken = await sdk.createSessionToken(openId, {
      name: "",
      expiresInMs: sessionDuration,
    });
    const cookieOptions = getSessionCookieOptions(req);
    res.cookie(COOKIE_NAME, finalSessionToken, { ...cookieOptions, maxAge: sessionDuration });

    await markSessionVerified(finalSessionToken, openId, sessionDuration);
    sendTotpLoginAlert(req, openId).catch(() => {});

    res.json({ success: true });
  });

  /**
   * POST /api/2fa/revoke-all
   * Emergency endpoint: revoke all verified sessions for the owner.
   */
  app.post("/api/2fa/revoke-all", async (req: Request, res: Response) => {
    const sessionToken = req.cookies?.[COOKIE_NAME];
    if (!sessionToken) { res.status(401).json({ error: "Not authenticated" }); return; }
    let openId: string;
    try {
      const result = await sdk.verifySession(sessionToken);
      if (!result) throw new Error("invalid");
      openId = result.openId;
    } catch { res.status(401).json({ error: "Invalid session" }); return; }
    if (!requiresTwoFactor(openId)) {
      res.status(403).json({ error: "Only the platform owner can revoke sessions" }); return;
    }
    await revokeAllSessions(openId);
    res.clearCookie(COOKIE_NAME);
    res.json({ success: true, message: "All sessions revoked. Please log in again." });
  });
}

/**
 * Called from the OAuth callback for the owner.
 * Issues a short-lived session JWT and redirects to /verify-2fa via HTML+JS
 * (not 302) so the cookie is reliably saved before navigation.
 */
export async function initiateTwoFactor(
  openId: string,
  req: Request,
  res: Response
): Promise<void> {
  const db = await getDb();
  if (!db) { res.status(500).json({ error: "Database unavailable" }); return; }

  const rows = await db.select({ totpSecret: users.totpSecret }).from(users).where(eq(users.openId, openId)).limit(1);
  const totpSecret = rows[0]?.totpSecret ?? null;

  if (!totpSecret) {
    // TOTP not configured — this should not happen in production (setup was removed).
    // Issue a short session and show an error page.
    const sessionToken = await sdk.createSessionToken(openId, { name: "", expiresInMs: 10 * 60 * 1000 });
    const cookieOptions = getSessionCookieOptions(req);
    res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: 10 * 60 * 1000 });
    res.setHeader("Content-Type", "text/html");
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Setup Required</title></head><body><p>TOTP not configured. Contact admin.</p></body></html>`);
    return;
  }

  // Issue a short-lived session JWT (30 min) and redirect to /verify-2fa via HTML+JS.
  // Using HTML+JS redirect (not 302) so the browser saves the cookie before navigating.
  const sessionToken = await sdk.createSessionToken(openId, {
    name: "",
    expiresInMs: PENDING_TTL_MS,
  });
  const cookieOptions = getSessionCookieOptions(req);
  res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: PENDING_TTL_MS });

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Redirecting...</title></head><body><script>window.location.replace("/verify-2fa");</script><noscript><meta http-equiv="refresh" content="0;url=/verify-2fa"></noscript></body></html>`);
}
