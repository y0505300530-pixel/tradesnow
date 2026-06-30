/**
 * localUsers router — admin-only CRUD for local email/password accounts.
 * These users do NOT use Manus OAuth. They log in via /api/local-auth/login.
 * Each local user gets a linked `users` row so all existing userId-based
 * queries work without modification.
 */
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb, upsertUserSettings } from "../db";
import { localUsers, users, userAssets } from "../../drizzle/schema";
import { eq, desc } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { ENV } from "../_core/env";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Ensure the caller is the owner/admin */
function assertAdmin(ctx: { user: { role: string } | null }) {
  if (!ctx.user || ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin only" });
  }
}

/**
 * Ensure a linked `users` row exists for a local user.
 * Returns the users.id (integer PK).
 */
async function ensureLinkedUser(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  localUser: { id: number; email: string; name: string | null }
): Promise<number> {
  // Use a synthetic openId so it never collides with Manus OAuth openIds
  const syntheticOpenId = `local:${localUser.id}`;
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.openId, syntheticOpenId))
    .limit(1);

  if (existing.length > 0) return existing[0].id;

  // Create the users row
  const [res] = await db.insert(users).values({
    openId: syntheticOpenId,
    name: localUser.name ?? localUser.email,
    email: localUser.email,
    loginMethod: "local",
    role: "user",
  });
  const newId = res.insertId as number;

  // Back-link
  await db
    .update(localUsers)
    .set({ linkedUserId: newId })
    .where(eq(localUsers.id, localUser.id));

  return newId;
}

/**
 * Copy all active assets from the admin user to a newly created user.
 * Gives new users a starting catalogue identical to the admin's.
 */
async function copyAdminAssetsToUser(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  newUserId: number
) {
  try {
    const adminRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "admin"))
      .limit(1);
    if (adminRows.length === 0) return;
    const adminUserId = adminRows[0].id;

    const adminAssets = await db
      .select()
      .from(userAssets)
      .where(eq(userAssets.userId, adminUserId));
    if (adminAssets.length === 0) return;

    const inserts = adminAssets.map((a) => ({
      userId: newUserId,
      ticker: a.ticker,
      companyName: a.companyName,
      sector: a.sector,
      score: a.score,
      label: a.label,
      sortOrder: a.sortOrder,
      archived: 0 as const,
      profitPotential: a.profitPotential,
      note: a.note,
    }));

    for (let i = 0; i < inserts.length; i += 50) {
      await db.insert(userAssets).values(inserts.slice(i, i + 50));
    }
  } catch (err) {
    console.error("[localUsers] copyAdminAssetsToUser error:", err);
    // Non-fatal — user is created, assets copy failed
  }
}

// ── router ───────────────────────────────────────────────────────────────────

export const localUsersRouter = router({
  /** List all local users (admin only) */
  list: protectedProcedure.query(async ({ ctx }) => {
    assertAdmin(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const rows = await db
      .select({
        id: localUsers.id,
        email: localUsers.email,
        name: localUsers.name,
        role: localUsers.role,
        isActive: localUsers.isActive,
        linkedUserId: localUsers.linkedUserId,
        createdAt: localUsers.createdAt,
        lastSignedIn: localUsers.lastSignedIn,
        telegramChatId: localUsers.telegramChatId,
      })
      .from(localUsers)
      .orderBy(desc(localUsers.createdAt));
    return rows;
  }),

  /** Create a new local user (admin only) */
  create: protectedProcedure
    .input(
      z.object({
        email: z.string().email(),
        password: z.string().min(6),
        name: z.string().min(1).max(128),
      })
    )
    .mutation(async ({ ctx, input }) => {
      assertAdmin(ctx);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Check duplicate
      const existing = await db
        .select({ id: localUsers.id })
        .from(localUsers)
        .where(eq(localUsers.email, input.email.toLowerCase()))
        .limit(1);
      if (existing.length > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Email already in use",
        });
      }

      const passwordHash = await bcrypt.hash(input.password, 12);
      const [res] = await db.insert(localUsers).values({
        email: input.email.toLowerCase(),
        passwordHash,
        name: input.name,
        role: "user",
        isActive: true,
      });
      const newId = res.insertId as number;

      // Eagerly create the linked users row
      const newLocalUser = { id: newId, email: input.email.toLowerCase(), name: input.name };
      const linkedUserId = await ensureLinkedUser(db, newLocalUser);

      // Copy admin's Asset Catalogue to the new user
      await copyAdminAssetsToUser(db, linkedUserId);

      return { id: newId };
    }),

  /** Update a local user's name / active status (admin only) */
  update: protectedProcedure
    .input(
      z.object({
        id: z.number().int(),
        name: z.string().min(1).max(128).optional(),
        isActive: z.boolean().optional(),
        password: z.string().min(6).optional(), // reset password
        telegramChatId: z.string().max(64).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      assertAdmin(ctx);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.isActive !== undefined) patch.isActive = input.isActive;
      if (input.password) patch.passwordHash = await bcrypt.hash(input.password, 12);
       if (input.telegramChatId !== undefined) patch.telegramChatId = input.telegramChatId;
      if (Object.keys(patch).length === 0) return { success: true };
      await db.update(localUsers).set(patch).where(eq(localUsers.id, input.id));
      // Sync telegramChatId to userSettings so alertPoller and test-send work correctly
      if (input.telegramChatId !== undefined) {
        const localUser = await db.select({ linkedUserId: localUsers.linkedUserId }).from(localUsers).where(eq(localUsers.id, input.id)).limit(1);
        const linkedUserId = localUser[0]?.linkedUserId;
        if (linkedUserId) {
          await upsertUserSettings(linkedUserId, {
            telegramChatId: input.telegramChatId,
            telegramEnabled: 1,
          });
        }
      }
      return { success: true };
    }),

  /** Delete a local user (admin only) */
  delete: protectedProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      assertAdmin(ctx);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.delete(localUsers).where(eq(localUsers.id, input.id));
      return { success: true };
    }),
});
