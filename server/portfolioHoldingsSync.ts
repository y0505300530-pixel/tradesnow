/**
 * portfolioHoldingsSync.ts
 *
 * Keeps portfolioHoldings aligned with livePositions (Elza / War Room).
 * livePositions.entryPrice is the source of truth for buyPrice.
 * Short positions use signed units (units < 0); SL above entry, TP below entry.
 */

import { and, eq } from "drizzle-orm";
import type { getDb } from "./db";
import { portfolioHoldings, livePositions } from "../drizzle/schema";
import type { LivePosition } from "../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export function isShortHolding(units: number): boolean {
  return units < 0;
}

export function signedUnitsFromLive(
  pos: Pick<LivePosition, "units" | "direction">,
): number {
  const qty = Math.abs(pos.units);
  return pos.direction === "short" ? -qty : qty;
}

export interface HoldingFieldsFromLive {
  buyPrice: number;
  units: number;
  stopLoss: number;
  takeProfit: number;
  currentPrice: number | null;
  source: "elza";
  transactionDate?: Date | null;
}

export function holdingFieldsFromLivePosition(
  pos: Pick<
    LivePosition,
    "entryPrice" | "units" | "direction" | "currentSl" | "currentTp" | "currentPrice" | "openedAt"
  >,
): HoldingFieldsFromLive {
  return {
    buyPrice: pos.entryPrice,
    units: signedUnitsFromLive(pos),
    stopLoss: pos.currentSl,
    takeProfit: pos.currentTp,
    currentPrice: pos.currentPrice ?? null,
    source: "elza",
    transactionDate: pos.openedAt ?? null,
  };
}

export async function fetchOpenLivePositionsByTicker(
  db: Db,
  userId: number,
): Promise<Map<string, LivePosition>> {
  const rows = await db
    .select()
    .from(livePositions)
    .where(and(eq(livePositions.userId, userId), eq(livePositions.status, "open")));
  const map = new Map<string, LivePosition>();
  for (const row of rows) map.set(row.ticker.toUpperCase(), row);
  return map;
}

/** Merge IBKR sync row with matching open livePosition when present. */
export function mergeIbkrHoldingWithLive(
  ticker: string,
  ibkr: { position: number; avgCost: number; mktPrice: number },
  liveByTicker: Map<string, LivePosition>,
): {
  buyPrice: number;
  units: number;
  stopLoss?: number;
  takeProfit?: number;
  source?: "elza";
} {
  const live = liveByTicker.get(ticker.toUpperCase());
  if (live) {
    const fields = holdingFieldsFromLivePosition(live);
    // IBKR position qty is SSOT; livePositions entryPrice + SL/TP override IBKR avgCost.
    return {
      buyPrice: fields.buyPrice,
      units: ibkr.position,
      stopLoss: fields.stopLoss,
      takeProfit: fields.takeProfit,
      source: "elza",
    };
  }
  return {
    buyPrice: ibkr.avgCost,
    units: ibkr.position,
  };
}

export async function reconcileHoldingFromLivePosition(
  db: Db,
  userId: number,
  ticker: string,
): Promise<{
  updated: boolean;
  reason?: string;
  before?: Record<string, unknown>;
  after?: HoldingFieldsFromLive;
}> {
  const t = ticker.toUpperCase();
  const [lp] = await db
    .select()
    .from(livePositions)
    .where(
      and(
        eq(livePositions.userId, userId),
        eq(livePositions.ticker, t),
        eq(livePositions.status, "open"),
      ),
    )
    .limit(1);

  if (!lp) {
    return { updated: false, reason: `No open livePosition for ${t}` };
  }

  const fields = holdingFieldsFromLivePosition(lp);
  const [existing] = await db
    .select()
    .from(portfolioHoldings)
    .where(and(eq(portfolioHoldings.userId, userId), eq(portfolioHoldings.ticker, t)))
    .limit(1);

  if (existing) {
    const before = {
      buyPrice: existing.buyPrice,
      units: existing.units,
      stopLoss: existing.stopLoss,
      takeProfit: existing.takeProfit,
    };
    await db
      .update(portfolioHoldings)
      .set({
        buyPrice: fields.buyPrice,
        units: fields.units,
        stopLoss: fields.stopLoss,
        takeProfit: fields.takeProfit,
        currentPrice: fields.currentPrice ?? existing.currentPrice,
        source: "elza",
        transactionDate: fields.transactionDate ?? existing.transactionDate,
        updatedAt: new Date(),
      })
      .where(eq(portfolioHoldings.id, existing.id));
    return { updated: true, before, after: fields };
  }

  await db.insert(portfolioHoldings).values({
    userId,
    ticker: t,
    company: lp.companyName ?? t,
    buyPrice: fields.buyPrice,
    units: fields.units,
    stopLoss: fields.stopLoss,
    takeProfit: fields.takeProfit,
    currentPrice: fields.currentPrice,
    source: "elza",
    transactionDate: fields.transactionDate ?? null,
  });
  return { updated: true, after: fields };
}

/** Reconcile every open livePosition into portfolioHoldings. */
export async function syncAllElzaHoldingsFromLivePositions(
  db: Db,
  userId: number,
): Promise<{ synced: number; tickers: string[] }> {
  const liveByTicker = await fetchOpenLivePositionsByTicker(db, userId);
  const tickers: string[] = [];
  for (const ticker of liveByTicker.keys()) {
    const result = await reconcileHoldingFromLivePosition(db, userId, ticker);
    if (result.updated) tickers.push(ticker);
  }
  return { synced: tickers.length, tickers };
}
