/**
 * Money Transfer Ledger Router
 * Tracks deposits and withdrawals for TWR performance normalization.
 */
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { moneyTransfers, hourlySnapshots } from "../../drizzle/schema";
import { eq, desc, and } from "drizzle-orm";
import { ibindRequest } from "./ibkrProxy";

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── TWR Calculation ───────────────────────────────────────────────────────────
/**
 * Time-Weighted Return (TWR) — chains sub-period returns.
 * Each transfer creates a sub-period boundary.
 * TWR = Π (1 + Ri) - 1
 * where Ri = (EndValue_i - ExternalFlow_i) / BeginValue_i - 1
 */
function calcTWR(
  snapshots: { ts: number; equity: number }[],
  transfers: { timestamp: number; type: string; amount: number }[]
): { ts: number; twr: number }[] {
  if (snapshots.length === 0) return [];

  const sorted = [...snapshots].sort((a, b) => a.ts - b.ts);
  const sortedTransfers = [...transfers].sort((a, b) => a.timestamp - b.timestamp);

  const result: { ts: number; twr: number }[] = [];
  let cumulativeTWR = 1.0;
  let prevEquity = sorted[0].equity;

  for (let i = 1; i < sorted.length; i++) {
    const snap = sorted[i];
    // Find any transfer that happened between prev and current snapshot
    const periodTransfers = sortedTransfers.filter(
      (t) => t.timestamp > sorted[i - 1].ts && t.timestamp <= snap.ts
    );
    const netFlow = periodTransfers.reduce((sum, t) => {
      return sum + (t.type === "DEPOSIT" ? t.amount : -t.amount);
    }, 0);

    // Sub-period return: exclude the external cash flow
    const beginValue = prevEquity;
    const endValue = snap.equity - netFlow; // strip out the transfer
    if (beginValue > 0) {
      const subReturn = endValue / beginValue;
      cumulativeTWR *= subReturn;
    }
    result.push({ ts: snap.ts, twr: +(cumulativeTWR - 1) * 100 });
    prevEquity = snap.equity;
  }

  return result;
}

// ── Router ────────────────────────────────────────────────────────────────────

export const moneyTransfersRouter = router({
  // List all transfers for the user
  list: protectedProcedure
    .input(z.object({
      limit: z.number().min(1).max(500).default(200),
    }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const rows = await db
        .select()
        .from(moneyTransfers)
        .where(eq(moneyTransfers.userId, ctx.user.id))
        .orderBy(desc(moneyTransfers.timestamp))
        .limit(input?.limit ?? 200);
      return rows;
    }),

  // Add a manual transfer
  add: protectedProcedure
    .input(z.object({
      type: z.enum(["DEPOSIT", "WITHDRAWAL"]),
      amount: z.number().positive(),
      timestamp: z.number().optional(), // UTC ms, defaults to now
      balanceBefore: z.number().optional(),
      balanceAfter: z.number().optional(),
      notes: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const ts = input.timestamp ?? Date.now();
      await db.insert(moneyTransfers).values({
        userId: ctx.user.id,
        timestamp: ts,
        type: input.type,
        amount: input.amount,
        balanceBefore: input.balanceBefore ?? null,
        balanceAfter: input.balanceAfter ?? null,
        source: "MANUAL",
        notes: input.notes ?? null,
      });
      return { ok: true };
    }),

  // Delete a transfer
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      await db
        .delete(moneyTransfers)
        .where(and(eq(moneyTransfers.id, input.id), eq(moneyTransfers.userId, ctx.user.id)));
      return { ok: true };
    }),

  // Monthly summary: net flow per month
  monthlySummary: protectedProcedure
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) return [];
      const rows = await db
        .select()
        .from(moneyTransfers)
        .where(eq(moneyTransfers.userId, ctx.user.id))
        .orderBy(moneyTransfers.timestamp);

      // Group by YYYY-MM
      const map: Record<string, { deposits: number; withdrawals: number; net: number }> = {};
      for (const row of rows) {
        const d = new Date(row.timestamp);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!map[key]) map[key] = { deposits: 0, withdrawals: 0, net: 0 };
        if (row.type === "DEPOSIT") {
          map[key].deposits += row.amount;
          map[key].net += row.amount;
        } else {
          map[key].withdrawals += row.amount;
          map[key].net -= row.amount;
        }
      }

      return Object.entries(map)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, v]) => ({ month, ...v }));
    }),

  // TWR Clean Growth — uses hourly snapshots + transfers
  twrCurve: protectedProcedure
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) return { twr: [], totalDeposited: 0, totalWithdrawn: 0, transferCount: 0 };

      // Pull hourly snapshots from DB
      const { hourlySnapshots } = await import("../../drizzle/schema");
      const snaps = await db
        .select({ ts: hourlySnapshots.snapshotTs, equity: hourlySnapshots.combinedValue })
        .from(hourlySnapshots)
        .where(eq(hourlySnapshots.userId, ctx.user.id))
        .orderBy(hourlySnapshots.snapshotTs);

      const transfers = await db
        .select()
        .from(moneyTransfers)
        .where(eq(moneyTransfers.userId, ctx.user.id))
        .orderBy(moneyTransfers.timestamp);

      const snapshots = snaps.map((s) => ({ ts: Number(s.ts), equity: s.equity }));
      const twr = calcTWR(snapshots, transfers);

      return {
        twr,
        totalDeposited: transfers.filter((t) => t.type === "DEPOSIT").reduce((s, t) => s + t.amount, 0),
        totalWithdrawn: transfers.filter((t) => t.type === "WITHDRAWAL").reduce((s, t) => s + t.amount, 0),
        transferCount: transfers.length,
      };
    }),

  // Get current portfolio equity — tries IBKR live, falls back to latest hourly snapshot
  getEquity: protectedProcedure
    .query(async ({ ctx }) => {
      // 1. Try IBKR live net liquidation
      try {
        const res = await ibindRequest("GET", "/account/summary");
        if (res.ok && res.body) {
          const data = res.body as Record<string, any>;
          const nlv =
            data.net_liquidation ?? data.netliquidation ?? data.netLiquidation ?? null;
          const equity = typeof nlv === "number" ? nlv : (nlv?.amount ?? null);
          if (equity != null && equity > 0) {
            return { equity: equity as number, source: "ibkr" as const };
          }
        }
      } catch {
        // fall through to snapshot
      }

      // 2. Fall back to latest hourly snapshot
      const db = await getDb();
      if (!db) return { equity: null, source: "none" as const };
      const snaps = await db
        .select({ ts: hourlySnapshots.snapshotTs, equity: hourlySnapshots.combinedValue })
        .from(hourlySnapshots)
        .where(eq(hourlySnapshots.userId, ctx.user.id))
        .orderBy(desc(hourlySnapshots.snapshotTs))
        .limit(1);
      if (snaps.length > 0) {
        return { equity: snaps[0].equity, source: "snapshot" as const };
      }
      return { equity: null, source: "none" as const };
    }),

  // Auto-detect transfers from IBKR ledger endpoint
  detectFromIbkr: protectedProcedure
    .mutation(async ({ ctx }) => {
      try {
        // First get positions to discover the account_id dynamically
        const posRes = await ibindRequest("GET", "/positions");
        if (!posRes.ok) return { detected: 0, error: "IBKR not connected" };
        const posBody = posRes.body as any;
        const accountId: string | null = posBody?.account_id ?? null;
        if (!accountId) return { detected: 0, error: "Could not determine IBKR account ID" };

        const res = await ibindRequest("GET", `/portfolio/${accountId}/ledger`);
        if (!res.ok) return { detected: 0, error: "IBKR ledger unavailable" };

        const data = res.body as Record<string, unknown>;
        // IBKR ledger returns { BASE: { cashbalance, settledcash, ... }, USD: {...} }
        // For now, return the raw ledger data for manual review.
        return { detected: 0, ledger: data, accountId };
      } catch (err: any) {
        return { detected: 0, error: err.message ?? "Could not reach IBKR" };
      }
    }),
});
