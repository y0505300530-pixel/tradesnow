/**
 * corporateActionSync.ts — Pre-Market Corporate Actions Guard (V2.00)
 *
 * Runs once daily before market open (14:30–16:20 Israel time = US pre-market).
 * Compares IBKR live portfolio (qty + avg cost) against DB records.
 * If a split or unexpected qty change is detected → FREEZE the position.
 *
 * Freeze protocol:
 *   1. Set livePositions.status = 'frozen'
 *   2. Set corporateActionFrozen = 1, frozenReason = <description>
 *   3. Send Telegram alert for manual review
 *   4. warEngine + SL monitor skip frozen positions entirely
 */

import { getDb }            from "./db";
import { livePositions }    from "../drizzle/schema";
import { eq, and }          from "drizzle-orm";
import { ibindRequest }     from "./routers/ibkrProxy";
import { sendTelegramMessage } from "./telegram";
import { log }              from "./logger";

const SPLIT_PRICE_RATIO_THRESHOLD = 0.55; // price drop >45% vs avg cost = probable split
const QTY_CHANGE_THRESHOLD_PCT    = 0.02; // >2% qty change not from our orders = flag

let _lastSyncDate = "";  // YYYY-MM-DD — run only once per day

export async function runCorporateActionSync(userId: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (_lastSyncDate === today) return;  // already ran today

  const db = await getDb();
  if (!db) return;

  log.info("CORP_ACTION", "[CorporateActionSync] Starting pre-market sync...");

  // 1. Fetch IBKR live positions
  let ibkrPositions: any[] = [];
  try {
    const posRes = await ibindRequest("GET", "/positions");
    if (!posRes.ok) {
      log.warn("CORP_ACTION", "[CorporateActionSync] IBKR positions unavailable — skipping");
      return;
    }
    ibkrPositions = ((posRes.body as any)?.positions ?? [])
      .filter((p: any) => p.position !== 0);
  } catch (e: any) {
    log.warn("CORP_ACTION", `[CorporateActionSync] IBKR fetch error: ${e.message}`);
    return;
  }

  // 2. Fetch all open DB positions for this user
  const dbPositions = await db
    .select()
    .from(livePositions)
    .where(and(eq(livePositions.userId, userId), eq(livePositions.status, "open")));

  if (dbPositions.length === 0) {
    _lastSyncDate = today;
    return;
  }

  const ibkrMap = new Map<string, { qty: number; avgCost: number }>();
  for (const p of ibkrPositions) {
    const sym = (p.contractDesc ?? p.ticker ?? "").toUpperCase().replace(/ /g, "");
    ibkrMap.set(sym, {
      qty:     Math.abs(p.position ?? 0),
      avgCost: Math.abs(p.mktPrice ?? p.avgCost ?? 0),
    });
  }

  let frozenCount = 0;

  for (const pos of dbPositions) {
    const ibkr = ibkrMap.get(pos.ticker.toUpperCase());
    if (!ibkr) continue; // position not found in IBKR — handled by Hard Sync

    const dbQty   = Math.abs(pos.units ?? 0);
    const dbEntry = pos.entryPrice ?? 0;

    // ── Check 1: Quantity anomaly (unexpected split or reverse split) ──────
    const qtyRatio  = ibkr.qty / dbQty;
    const qtyDelta  = Math.abs(qtyRatio - 1);

    // Round ratios common in splits: 2x, 3x, 5x, 10x, 0.5x, 0.1x
    const splitRatios = [2, 3, 4, 5, 10, 0.5, 0.25, 0.1, 0.2];
    const isSplitRatio = splitRatios.some(r => Math.abs(qtyRatio - r) < 0.05);

    // ── Check 2: Price anomaly (split causes price to drop proportionally) ─
    const avgCostRatio = dbEntry > 0 ? ibkr.avgCost / dbEntry : 1;
    const isPriceSplit = avgCostRatio < SPLIT_PRICE_RATIO_THRESHOLD;

    const isCorporateActionSuspect = isSplitRatio || (isPriceSplit && qtyDelta > QTY_CHANGE_THRESHOLD_PCT);

    if (isCorporateActionSuspect) {
      const reason = isSplitRatio
        ? `QTY ratio ${qtyRatio.toFixed(2)}x vs DB — probable split/reverse-split`
        : `AvgCost ratio ${avgCostRatio.toFixed(2)} — price anomaly vs DB entry $${dbEntry}`;

      log.error("CORP_ACTION",
        `[CorporateActionSync] 🔴 FROZEN: ${pos.ticker} — ${reason}`,
        { ticker: pos.ticker, dbQty, ibkrQty: ibkr.qty, dbEntry, ibkrAvgCost: ibkr.avgCost }
      );

      // Freeze the position
      await db.update(livePositions).set({
        status: "frozen" as any,
        corporateActionFrozen: 1,
        frozenReason: reason.slice(0, 127),
        ibkrAvgCost: ibkr.avgCost,
        ibkrUnits:   ibkr.qty,
      }).where(eq(livePositions.id, pos.id));

      // Telegram alert
      try {
        await sendTelegramMessage(
          `🔴 *CORPORATE ACTION DETECTED — POSITION FROZEN*\n` +
          `Ticker: ${pos.ticker}\n` +
          `DB entry: $${dbEntry.toFixed(2)} × ${dbQty} shares\n` +
          `IBKR now: $${ibkr.avgCost.toFixed(2)} × ${ibkr.qty} shares\n` +
          `Reason: ${reason}\n` +
          `⚠️ Manual review required. Position is FROZEN — engine will skip it.`
        );
      } catch {}

      frozenCount++;
    } else {
      // Update IBKR baseline for future comparison
      await db.update(livePositions).set({
        ibkrAvgCost: ibkr.avgCost,
        ibkrUnits:   ibkr.qty,
      }).where(eq(livePositions.id, pos.id));
    }
  }

  _lastSyncDate = today;
  log.info("CORP_ACTION",
    `[CorporateActionSync] Done — ${dbPositions.length} positions checked, ${frozenCount} frozen`
  );
}
