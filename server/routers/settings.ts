import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import { getUserSettings, upsertUserSettings } from "../db";

const settingsSchema = z.object({
  tradingviewWebhookUrl: z.string().max(512).optional().default(""),
  tradingviewApiKey: z.string().max(256).optional().default(""),
  platform: z.enum(["tradingview", "interactive_brokers", "paper"]).default("tradingview"),
  startingBalance: z.number().min(100).max(10_000_000).default(10000),
  riskPerTrade: z.number().min(0.1).max(20).default(2),
  stopLossBuffer: z.number().min(0).max(5).default(0.5),
});

export const settingsRouter = router({
  // ── Telegram settings — accessible to ALL authenticated users ──────────────
  getTelegram: protectedProcedure.query(async ({ ctx }) => {
    const row = await getUserSettings(ctx.user.id);
    return {
      telegramChatId: row?.telegramChatId ?? "",
      telegramEnabled: (row?.telegramEnabled ?? 1) === 1,
    };
  }),

  saveTelegram: protectedProcedure
    .input(z.object({
      telegramChatId: z.string().max(64),
      telegramEnabled: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      await upsertUserSettings(ctx.user.id, {
        telegramChatId: input.telegramChatId || null,
        telegramEnabled: input.telegramEnabled ? 1 : 0,
      });
      return { success: true };
    }),

  testTelegram: protectedProcedure
    .input(z.object({ telegramChatId: z.string() }))
    .mutation(async ({ input }) => {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Telegram bot not configured" });
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: input.telegramChatId,
          text: "\u2705 *trade-snow2.vip* \u2014 Telegram connected!\n\nYou will receive alerts here.",
          parse_mode: "Markdown",
        }),
      });
      const data = await res.json() as { ok: boolean; description?: string };
      if (!data.ok) throw new TRPCError({ code: "BAD_REQUEST", message: data.description ?? "Failed to send message" });
      return { success: true };
    }),

  // ── Admin-only settings ────────────────────────────────────────────────────
  get: adminProcedure.query(async ({ ctx }) => {
    const row = await getUserSettings(ctx.user.id);
    if (!row) {
      return {
        tradingviewWebhookUrl: "",
        tradingviewApiKey: "",
        platform: "tradingview" as const,
        startingBalance: 10000,
        riskPerTrade: 2,
        stopLossBuffer: 0.5,
      };
    }
    return {
      tradingviewWebhookUrl: row.tradingviewWebhookUrl ?? "",
      tradingviewApiKey: row.tradingviewApiKey ?? "",
      platform: (row.platform ?? "tradingview") as "tradingview" | "interactive_brokers" | "paper",
      startingBalance: row.startingBalance,
      riskPerTrade: row.riskPerTrade / 10,
      stopLossBuffer: row.stopLossBuffer / 10,
    };
  }),

  save: adminProcedure.input(settingsSchema).mutation(async ({ ctx, input }) => {
    await upsertUserSettings(ctx.user.id, {
      tradingviewWebhookUrl: input.tradingviewWebhookUrl,
      tradingviewApiKey: input.tradingviewApiKey,
      platform: input.platform,
      startingBalance: Math.round(input.startingBalance),
      riskPerTrade: Math.round(input.riskPerTrade * 10),
      stopLossBuffer: Math.round(input.stopLossBuffer * 10),
    });
    return { success: true };
  }),
});
