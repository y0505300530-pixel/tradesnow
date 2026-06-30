/**
 * trigger_paper_freeroll.ts — Safe Stage-1 (+2R Free-Roll) paper drill
 *
 * Mode B: uses a real open position held on the polled live account (IBKR_LIVE_ACCOUNT_ID),
 * temporarily spoofs entryPrice/rValue/accountId to trip +2R, runs Open Skies Stage 1,
 * then restores spoofed metadata in a finally block.
 *
 * Usage:
 *   npx tsx scripts/trigger_paper_freeroll.ts                    # list open positions (IBKR or DB fallback)
 *   npx tsx scripts/trigger_paper_freeroll.ts 42 --confirm       # run drill on position 42
 *   npx tsx scripts/trigger_paper_freeroll.ts 42 --confirm --paper-account=DU1234567
 *
 * Requires --confirm to mutate DB / invoke the monitor (prevents accidental runs).
 * With --confirm, IBKR "ticker not held" is ignored; price falls back to DB currentPrice/entryPrice.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: "/root/tradesnow/.env" });

import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db";
import { livePositions } from "../drizzle/schema";
import { ibindRequest } from "../server/routers/ibkrProxy";
import { LIVE_ACCOUNT_ID, runLiveSlMonitor } from "../server/liveOrderExecutor";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface SpoofSnapshot {
  entryPrice: number;
  rValue: number | null;
  accountId: string | null;
  isFreeRolled: number;
}

interface IbkrHeldRow {
  ticker: string;
  mktPrice: number;
  qty: number;
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [k, v] = arg.slice(2).split("=");
      flags[k] = v ?? true;
    } else {
      positional.push(arg);
    }
  }
  return {
    positionId: positional[0] ? parseInt(positional[0], 10) : undefined,
    confirm: flags.confirm === true,
    paperAccount: (flags["paper-account"] as string) ?? process.env.FREEROLL_TEST_PAPER_ACCOUNT ?? "DU16881054",
    userId: flags["user-id"] ? parseInt(flags["user-id"] as string, 10) : 1,
    rValue: flags["r-value"] ? parseFloat(flags["r-value"] as string) : undefined,
    waitMs: flags["wait-ms"] ? parseInt(flags["wait-ms"] as string, 10) : 5000,
  };
}

async function fetchIbkrHeld(): Promise<{ held: Map<string, IbkrHeldRow>; ok: boolean }> {
  const held = new Map<string, IbkrHeldRow>();
  if (!LIVE_ACCOUNT_ID?.trim()) {
    console.warn("[freeroll] IBKR_LIVE_ACCOUNT_ID missing — skipping IBKR fetch");
    return { held, ok: false };
  }
  const res = await ibindRequest("GET", `/portfolio/${LIVE_ACCOUNT_ID}/positions/0`);
  if (!res.ok) {
    console.warn(`[freeroll] IBKR positions fetch failed (${res.status}) — falling back to DB open positions`);
    return { held, ok: false };
  }
  for (const p of (res.body as any[]) ?? []) {
    const qty = Math.abs(p.position ?? 0);
    if (qty <= 0) continue;
    const ticker = (p.ticker ?? p.contractDesc ?? "").toUpperCase().trim();
    if (!ticker) continue;
    const mktPrice = parseFloat(p.mktPrice ?? p.marketPrice ?? p.lastPrice ?? "0");
    held.set(ticker, { ticker, mktPrice, qty });
  }
  return { held, ok: true };
}

function listOpenFromDb(open: Array<typeof livePositions.$inferSelect>, userId: number) {
  console.log(`\n[freeroll] DB fallback — open positions (userId=${userId}): ${open.length}\n`);
  if (open.length === 0) {
    console.log("No open positions in livePositions.");
    return;
  }
  console.log("ID\tTICKER\tDIRECTION\tUNITS");
  for (const p of open) {
    console.log(`${p.id}\t${p.ticker}\t${p.direction}\t${p.units}`);
  }
  console.log(`\nRun: npx tsx scripts/trigger_paper_freeroll.ts <positionId> --confirm`);
}

function computeSpoofEntry(
  direction: "long" | "short",
  livePrice: number,
  rValue: number,
): number {
  const buffer = 0.05;
  if (direction === "long") {
    return +(livePrice - 2 * rValue - buffer).toFixed(4);
  }
  return +(livePrice + 2 * rValue + buffer).toFixed(4);
}

function perShareGain(direction: "long" | "short", livePrice: number, entryPrice: number): number {
  return direction === "long" ? livePrice - entryPrice : entryPrice - livePrice;
}

async function listCandidates(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const open = await db.select().from(livePositions)
    .where(and(eq(livePositions.userId, userId), eq(livePositions.status, "open")));

  const { held, ok: ibkrOk } = await fetchIbkrHeld();

  if (!ibkrOk) {
    listOpenFromDb(open, userId);
    return;
  }

  const candidates = open
    .map(p => {
      const ibkr = held.get(p.ticker.toUpperCase());
      return ibkr ? { ...p, liveMktPrice: ibkr.mktPrice, ibkrQty: ibkr.qty } : null;
    })
    .filter(Boolean) as Array<typeof open[0] & { liveMktPrice: number; ibkrQty: number }>;

  console.log(`\nPolled account: ${LIVE_ACCOUNT_ID}`);
  console.log(`IBKR-held open DB positions: ${candidates.length}\n`);

  if (candidates.length === 0) {
    console.log("No IBKR-backed candidates — listing all open DB positions instead:\n");
    listOpenFromDb(open, userId);
    return;
  }

  console.log("ID\tTICKER\tUNITS\tENTRY\tLIVE\tR\tFREE?");
  for (const c of candidates) {
    console.log(
      `${c.id}\t${c.ticker}\t${c.units}\t${c.entryPrice}\t${c.liveMktPrice}\t${c.rValue ?? "—"}\t${c.isFreeRolled ? "yes" : "no"}`,
    );
  }
  console.log(`\nRun: npx tsx scripts/trigger_paper_freeroll.ts <positionId> --confirm`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.positionId || Number.isNaN(args.positionId)) {
    await listCandidates(args.userId);
    process.exit(0);
  }

  if (!args.confirm) {
    console.error("Refusing to run without --confirm (prevents accidental production spoof).");
    console.error(`Example: npx tsx scripts/trigger_paper_freeroll.ts ${args.positionId} --confirm`);
    process.exit(1);
  }

  if (!args.paperAccount.toUpperCase().startsWith("DU")) {
    console.error(`--paper-account must be a DU paper id, got: ${args.paperAccount}`);
    process.exit(1);
  }

  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const [pos] = await db.select().from(livePositions)
    .where(and(
      eq(livePositions.id, args.positionId),
      eq(livePositions.userId, args.userId),
      eq(livePositions.status, "open"),
    ))
    .limit(1);

  if (!pos) {
    console.error(`Open position ${args.positionId} not found for userId=${args.userId}`);
    process.exit(1);
  }

  if (pos.units < 2) {
    console.error(`Position ${pos.id} has units=${pos.units}; partial close needs units >= 2`);
    process.exit(1);
  }

  const { held } = await fetchIbkrHeld();
  const ibkr = held.get(pos.ticker.toUpperCase());
  const livePrice = (ibkr?.mktPrice && ibkr.mktPrice > 0)
    ? ibkr.mktPrice
    : (pos.currentPrice ?? pos.entryPrice);

  if (!Number.isFinite(livePrice) || livePrice <= 0) {
    console.error(`No usable price for ${pos.ticker} — set currentPrice in DB or ensure IBKR mktPrice is available`);
    process.exit(1);
  }

  if (!ibkr || ibkr.mktPrice <= 0) {
    console.warn(
      `[freeroll] --confirm override: ${pos.ticker} not held on ${LIVE_ACCOUNT_ID} — ` +
      `using DB price $${livePrice}, proceeding with skipHardSync`,
    );
  }

  const rValue = (args.rValue ?? pos.rValue ?? Math.abs(pos.entryPrice - pos.initialSl)) || 2;
  if (!(rValue > 0)) {
    console.error("Could not derive a positive rValue — pass --r-value=2");
    process.exit(1);
  }

  const spoofEntry = computeSpoofEntry(pos.direction, livePrice, rValue);
  const gain = perShareGain(pos.direction, livePrice, spoofEntry);
  const expectedHalfUnits = pos.units - Math.max(1, Math.floor(pos.units * 0.5));

  const snapshot: SpoofSnapshot = {
    entryPrice: pos.entryPrice,
    rValue: pos.rValue,
    accountId: pos.accountId,
    isFreeRolled: pos.isFreeRolled,
  };

  const unitsBefore = pos.units;
  let spoofApplied = false;

  console.log("\n=== Paper Free-Roll Drill (Stage 1) ===");
  console.log(`Position:   #${pos.id} ${pos.ticker} ${pos.direction} units=${unitsBefore}`);
  console.log(
    `Live price: $${livePrice} (${ibkr?.mktPrice && ibkr.mktPrice > 0 ? `IBKR ${LIVE_ACCOUNT_ID}, qty=${ibkr.qty}` : "DB fallback"})`,
  );
  console.log(`Spoof:      entry $${snapshot.entryPrice} → $${spoofEntry}, R=$${rValue}, accountId → ${args.paperAccount}`);
  console.log(`+2R check:  gain=$${gain.toFixed(4)} vs threshold=$${(2 * rValue).toFixed(4)}`);
  console.log(`Rollback:   entryPrice, rValue, accountId restored in finally\n`);

  // Route partial-close orders to paper gateway for this process only
  const prevIbkrAccount = process.env.IBKR_ACCOUNT_ID;
  process.env.IBKR_ACCOUNT_ID = args.paperAccount;

  try {
    await db.update(livePositions).set({
      entryPrice: spoofEntry,
      rValue,
      accountId: args.paperAccount,
      isFreeRolled: 0,
      currentPrice: livePrice,
    }).where(eq(livePositions.id, pos.id));
    spoofApplied = true;
    console.log("[freeroll] Spoof applied — invoking runLiveSlMonitor (skipHardSync, single position)...");

    await runLiveSlMonitor(args.userId, {
      skipHardSync: true,
      bypassThrottle: true,
      bypassMarketHours: true,
      onlyPositionId: pos.id,
    });

    console.log(`[freeroll] Waiting ${args.waitMs}ms for async fill / DB writes...`);
    await sleep(args.waitMs);

    const [after] = await db.select().from(livePositions)
      .where(eq(livePositions.id, pos.id))
      .limit(1);

    if (!after) {
      console.error("Position row vanished after monitor run");
      process.exit(1);
    }

    const freeRolled = after.isFreeRolled === 1;
    const unitsHalved = after.units === expectedHalfUnits && after.units < unitsBefore;
    const partialPending = freeRolled && !unitsHalved;

    console.log("\n=== Result ===");
    console.log(`isFreeRolled:     ${after.isFreeRolled} ${freeRolled ? "✓" : "✗"}`);
    console.log(`units:            ${unitsBefore} → ${after.units} ${unitsHalved ? "✓ halved" : partialPending ? "~ pending fill" : "✗ unchanged"}`);
    console.log(`currentSl:        ${after.currentSl}`);
    console.log(`partialRealized:  ${after.partialRealizedPnl ?? 0}`);
    console.log(`status:           ${after.status}`);

    if (freeRolled && (unitsHalved || partialPending)) {
      console.log("\n✅ Stage 1 appears to have fired. Tail PM2 logs for [Partial] FREE_ROLL_2R:");
      console.log("   pm2 logs tradesnow-app --lines 50 | grep -E 'Partial|OPEN SKIES|FreeRoll|SAFETY'");
    } else {
      console.log("\n⚠️  Stage 1 did not fully confirm — check pm2 logs for SAFETY BLOCK / Stage 1 failed");
    }
  } finally {
    process.env.IBKR_ACCOUNT_ID = prevIbkrAccount;

    if (spoofApplied) {
      await db!.update(livePositions).set({
        entryPrice: snapshot.entryPrice,
        rValue: snapshot.rValue,
        accountId: snapshot.accountId,
      }).where(eq(livePositions.id, args.positionId!));
      console.log(`\n[freeroll] Rollback complete — restored entryPrice=$${snapshot.entryPrice}, rValue=${snapshot.rValue}, accountId=${snapshot.accountId ?? "null"}`);
      console.log("[freeroll] NOTE: isFreeRolled / units / currentSl are NOT rolled back if Stage 1 executed (real trade state).");
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error("[freeroll] Fatal:", err);
  process.exit(1);
});
