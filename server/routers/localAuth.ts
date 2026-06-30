/**
 * Local auth routes — email/password login for non-Manus users.
 * POST /api/local-auth/login  → sets app_session_id cookie
 * POST /api/local-auth/logout → clears cookie
 */
import type { Express, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { localUsers, users } from "../../drizzle/schema";
import { sdk } from "../_core/sdk";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { getSessionCookieOptions } from "../_core/cookies";

/** Synthetic openId for a local user — must match ensureLinkedUser in localUsers.ts */
function syntheticOpenId(localUserId: number) {
  return `local:${localUserId}`;
}

export function registerLocalAuthRoutes(app: Express) {
  // ── POST /api/local-auth/login ─────────────────────────────────────────────
  app.post("/api/local-auth/login", async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body as { email?: string; password?: string };

      if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
      }

      const db = await getDb();
      if (!db) return res.status(503).json({ error: "Database unavailable" });

      // Find local user
      const rows = await db
        .select()
        .from(localUsers)
        .where(eq(localUsers.email, email.toLowerCase().trim()))
        .limit(1);

      const localUser = rows[0];
      if (!localUser) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      if (!localUser.isActive) {
        return res.status(403).json({ error: "Account is disabled" });
      }

      // Verify password
      const valid = await bcrypt.compare(password, localUser.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      // Ensure the linked users row exists (idempotent)
      const openId = syntheticOpenId(localUser.id);
      const existingUser = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.openId, openId))
        .limit(1);

      if (existingUser.length === 0) {
        // Create users row — use role from localUsers
        const [ins] = await db.insert(users).values({
          openId,
          name: localUser.name,
          email: localUser.email,
          loginMethod: "local",
          role: localUser.role,
        });
        const newUserId = ins.insertId as number;
        await db
          .update(localUsers)
          .set({ linkedUserId: newUserId })
          .where(eq(localUsers.id, localUser.id));
      } else {
        // Sync role from localUsers → users on every login
        await db
          .update(users)
          .set({ role: localUser.role, name: localUser.name })
          .where(eq(users.openId, openId));
      }

      // Update lastSignedIn
      await db
        .update(localUsers)
        .set({ lastSignedIn: new Date() })
        .where(eq(localUsers.id, localUser.id));

      // Create session JWT (same mechanism as Manus OAuth)
      const token = await sdk.createSessionToken(openId, {
        expiresInMs: ONE_YEAR_MS,
        name: localUser.name,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, token, {
        ...cookieOptions,
        maxAge: ONE_YEAR_MS,
      });

      return res.json({
        success: true,
        user: {
          id: localUser.id,
          email: localUser.email,
          name: localUser.name,
        },
      });
    } catch (err) {
      console.error("[LocalAuth] Login error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── POST /api/local-auth/logout ────────────────────────────────────────────
  app.post("/api/local-auth/logout", (req: Request, res: Response) => {
    const cookieOptions = getSessionCookieOptions(req);
    res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
    return res.json({ success: true });
  });

  // ── POST /api/local-auth/change-password ─────────────────────────
  // Session-bound: the session identifies WHO; currentPassword proves it's
  // really them; newPassword is the change. Email is NOT accepted from the body.
  app.post("/api/local-auth/change-password", async (req: Request, res: Response) => {
    try {
      let openId: string;
      try {
        const sessionUser = await sdk.authenticateRequest(req);
        openId = sessionUser.openId;
      } catch {
        return res.status(401).json({ error: "Not authenticated" });
      }

      if (!openId.startsWith("local:")) {
        return res.status(400).json({ error: "This account has no local password" });
      }
      const localUserId = Number(openId.slice("local:".length));
      if (!Number.isInteger(localUserId) || localUserId <= 0) {
        return res.status(400).json({ error: "Invalid account" });
      }

      const { currentPassword, newPassword } = req.body as {
        currentPassword?: string; newPassword?: string;
      };
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: "Current and new password are required" });
      }
      if (newPassword.length < 10) {
        return res.status(400).json({ error: "New password must be at least 10 characters" });
      }
      if (newPassword === currentPassword) {
        return res.status(400).json({ error: "New password must differ from the current password" });
      }

      const db = await getDb();
      if (!db) return res.status(503).json({ error: "Database unavailable" });

      const rows = await db
        .select()
        .from(localUsers)
        .where(eq(localUsers.id, localUserId))
        .limit(1);
      const localUser = rows[0];
      if (!localUser || !localUser.isActive) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const valid = await bcrypt.compare(currentPassword, localUser.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: "Current password is incorrect" });
      }

      const newHash = await bcrypt.hash(newPassword, 12);
      await db
        .update(localUsers)
        .set({ passwordHash: newHash })
        .where(eq(localUsers.id, localUser.id));

      return res.json({ success: true });
    } catch (err) {
      console.error("[LocalAuth] Change-password error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });
}
