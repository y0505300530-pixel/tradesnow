import { z } from "zod";
import { router, protectedProcedure, adminProcedure } from "../_core/trpc";
import {
  listTradingAccountsForViewer,
  assertTradingAccountAccess,
  getTradingAccountBySlug,
  buildTradingAccountRuntime,
} from "../tradingAccounts";
import { enterTradingAccount } from "../tradingAccountContext";

export const tradingAccountsRouter = router({
  /** Accounts visible to the current user (admin = all, user = linked only). */
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await listTradingAccountsForViewer(ctx.user.id, ctx.user.role);
    return rows.map((a) => ({
      id: a.id,
      slug: a.slug,
      label: a.label,
      ibkrAccountId: a.ibkrAccountId,
      gatewaySlug: a.gateway.slug,
      sortOrder: a.sortOrder,
    }));
  }),

  /** Resolve account + bind gateway context for downstream IBKR reads (admin or owner). */
  resolve: protectedProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const account = await assertTradingAccountAccess(ctx.user.id, ctx.user.role, input.slug);
      enterTradingAccount(buildTradingAccountRuntime(account));
      return {
        id: account.id,
        slug: account.slug,
        label: account.label,
        ibkrAccountId: buildTradingAccountRuntime(account).ibkrAccountId,
        catalogUserId: account.catalogUserId,
        gateway: { slug: account.gateway.slug, baseUrl: account.gateway.baseUrl },
      };
    }),

  /** UI + nav capabilities for the logged-in user (scoped trading-book viewers vs admin). */
  viewerContext: protectedProcedure.query(async ({ ctx }) => {
    const accounts = await listTradingAccountsForViewer(ctx.user.id, ctx.user.role);
    const isScopedViewer = ctx.user.role !== "admin" && accounts.length > 0;
    const primary = accounts[0] ?? null;
    return {
      isScopedViewer,
      primaryAccountSlug: primary?.slug ?? null,
      primaryAccountLabel: primary?.label ?? null,
      warRoomPath: isScopedViewer && primary ? `/war-room/${primary.slug}` : "/war-room-live",
      nav: {
        showH1H2: !isScopedViewer,
        showTransfers: !isScopedViewer,
        showKnowledge: !isScopedViewer,
        showSystemLogs: ctx.user.role === "admin",
        showWarReport: ctx.user.role === "admin",
        overviewOnlyHolding1: isScopedViewer,
      },
    };
  }),

  /** Admin: update IBKR account id after gateway login is live. */
  updateIbkrAccountId: adminProcedure
    .input(z.object({ slug: z.string(), ibkrAccountId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("../db");
      const { tradingAccounts } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      await db.update(tradingAccounts)
        .set({ ibkrAccountId: input.ibkrAccountId.toUpperCase() })
        .where(eq(tradingAccounts.slug, input.slug));
      return { ok: true };
    }),
});
