/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  liquidateLongCore.ts                                                       ║
 * ║                                                                            ║
 * ║  ███  LIVE MONEY  ███  —  DRY-RUN BY DEFAULT.                               ║
 * ║                                                                            ║
 * ║  This script reads the CURRENT OPEN live positions and, by DEFAULT, only   ║
 * ║  PRINTS the close plan — it sends NOTHING. It will place LIVE market-style  ║
 * ║  close orders ONLY when BOTH:                                              ║
 * ║     (1) process.argv includes  --execute   AND                            ║
 * ║     (2) env  LIQUIDATE_CONFIRM=YES_LIQUIDATE_LIVE  is set.                  ║
 * ║                                                                            ║
 * ║  The manager runs the execute path with explicit auth, at the console,     ║
 * ║  EYES-ON. Market-at-open has SLIPPAGE — every close is a marketable LMT     ║
 * ║  (never a naked MKT) via the SAME live helper the SL monitor uses, but a    ║
 * ║  gap-open can still fill materially away from the last print. Treat this    ║
 * ║  as a real-money operation, not a sim.                                      ║
 * ║                                                                            ║
 * ║  CLOSE HELPER: executeLiveSell(...) from server/liveOrderExecutor.ts —      ║
 * ║  the EXACT helper liveOrderExecutor's own close path uses (emergencyExitAll  ║
 * ║  loops it per position). It cancels both bracket legs, prices a marketable  ║
 * ║  LMT off real-time IBKR truth (POST /quotes → fetchIbkrLivePricesBatch),    ║
 * ║  posts POST /orders/limit IOC then retries DAY — NEVER a naked MKT, never    ║
 * ║  prices off stale EOD. We do NOT re-implement any of that.                  ║
 * ║                                                                            ║
 * ║  READ PATH: livePositions WHERE userId=? AND status='open' (the same DB     ║
 * ║  read emergencyExitAll / the SL monitor use). We additionally pull the      ║
 * ║  broker /portfolio/{acct}/positions/0 snapshot WITH RETRY for an FYI cross- ║
 * ║  check of live qty (gateway flakiness → retry reads), but the DB is the      ║
 * ║  source of truth for WHAT to close (only positions Elza opened).            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * RUN — DRY-RUN (default; sends nothing):
 *   node --import tsx --env-file=.env scripts/liquidateLongCore.ts
 *   node --import tsx --env-file=.env scripts/liquidateLongCore.ts --user 1
 *
 * RUN — EXECUTE (manager only, explicit auth; sends LIVE close orders):
 *   LIQUIDATE_CONFIRM=YES_LIQUIDATE_LIVE \
 *     node --import tsx --env-file=.env scripts/liquidateLongCore.ts --execute --user 1
 *
 * BUILD-CHECK (local, no run):
 *   npx esbuild scripts/liquidateLongCore.ts --bundle --platform=node --packages=external --outdir=/tmp/liqbc
 */

import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db";
import { livePositions } from "../drizzle/schema";
import { LIVE_ACCOUNT_ID, executeLiveSell } from "../server/liveOrderExecutor";
import { ibindRequest } from "../server/routers/ibkrProxy";

const CONFIRM_FLAG = "YES_LIQUIDATE_LIVE";
const CONFIRM_ENV = "LIQUIDATE_CONFIRM";

// ─── CLI parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): { execute: boolean; userId: number } {
  const execute = argv.includes("--execute");
  let userId = 1; // matches the default userId used by runDeleveragingCycle / live engine
  const ui = argv.indexOf("--user");
  if (ui >= 0 && argv[ui + 1]) {
    const n = parseInt(argv[ui + 1], 10);
    if (Number.isFinite(n) && n > 0) userId = n;
  }
  return { execute, userId };
}

// ─── Broker positions snapshot (FYI cross-check) WITH RETRY (gateway flakiness) ─
async function fetchBrokerPositionsWithRetry(attempts = 3): Promise<any[] | null> {
  for (let a = 1; a <= attempts; a++) {
    try {
      const res = await ibindRequest("GET", `/portfolio/${LIVE_ACCOUNT_ID}/positions/0`);
      if (res.ok) return ((res.body as any[]) ?? []);
      console.log(`  [broker-read] attempt ${a}/${attempts} → HTTP ${res.status} (retrying)`);
    } catch (e) {
      console.log(`  [broker-read] attempt ${a}/${attempts} threw: ${(e as Error).message ?? e} (retrying)`);
    }
    // small backoff between retries (no foreground sleep dependency required)
    await new Promise(r => setTimeout(r, 750 * a));
  }
  return null;
}

function brokerQtyFor(ticker: string, brokerPositions: any[] | null): number | null {
  if (!brokerPositions) return null;
  const up = ticker.toUpperCase().trim();
  for (const p of brokerPositions) {
    const t = (p.ticker ?? p.contractDesc ?? "").toString().toUpperCase().trim();
    if (t === up) return Number(p.position ?? 0);
  }
  return 0; // broker responded but has no row for this ticker
}

function fmt(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(dp);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { execute, userId } = parseArgs(process.argv.slice(2));
  const confirmOk = process.env[CONFIRM_ENV] === CONFIRM_FLAG;
  const willExecute = execute && confirmOk;

  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  console.log(`  liquidateLongCore — LIVE-position liquidation  (account ${LIVE_ACCOUNT_ID})`);
  console.log(`  userId=${userId}   mode=${willExecute ? "███ EXECUTE (LIVE ORDERS) ███" : "DRY-RUN (sends nothing)"}`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);

  if (execute && !confirmOk) {
    console.log(`  [SAFETY] --execute was passed but ${CONFIRM_ENV}=${CONFIRM_FLAG} is NOT set.`);
    console.log(`           Refusing to send live orders. Falling back to DRY-RUN.`);
  }

  const db = await getDb();
  if (!db) {
    console.log(`  [FATAL] DB unavailable — cannot read live positions. Aborting (nothing sent).`);
    process.exit(1);
    return;
  }

  // ── READ PATH: the SAME query emergencyExitAll / the SL monitor use. ──
  const openPos = await db.select().from(livePositions)
    .where(and(eq(livePositions.userId, userId), eq(livePositions.status, "open")));

  if (openPos.length === 0) {
    console.log(`  No OPEN live positions for userId=${userId}. Nothing to liquidate.`);
    return;
  }

  // FYI broker cross-check (retry on gateway flakiness; never blocks the plan).
  const brokerPositions = await fetchBrokerPositionsWithRetry();
  if (brokerPositions == null) {
    console.log(`  [broker-read] WARN: could not read broker /positions after retries — showing DB only (broker qty = "?").`);
  }

  // ── PRINT THE PLAN — one row per position we WOULD close. ──
  console.log("");
  console.log(`  ── CLOSE PLAN (${openPos.length} open position${openPos.length === 1 ? "" : "s"}) ──`);
  console.log(`  ${"ticker".padEnd(10)}${"side".padEnd(7)}${"qty".padStart(8)}${"curPx".padStart(12)}${"unrlzPnl$".padStart(14)}${"brokerQty".padStart(11)}`);
  console.log(`  ${"─".repeat(62)}`);

  let totalUnrealized = 0;
  for (const pos of openPos) {
    const qty = Math.abs(pos.units);
    const curPx = pos.currentPrice ?? pos.entryPrice;
    const upnl = pos.unrealizedPnl ?? 0;
    totalUnrealized += upnl;
    const bq = brokerQtyFor(pos.ticker, brokerPositions);
    console.log(
      `  ${pos.ticker.padEnd(10)}${pos.direction.padEnd(7)}${String(qty).padStart(8)}` +
      `${("$" + fmt(curPx)).padStart(12)}${(sign(upnl) + "$" + fmt(Math.abs(upnl))).padStart(14)}` +
      `${(bq == null ? "?" : String(bq)).padStart(11)}`,
    );
  }
  console.log(`  ${"─".repeat(62)}`);
  console.log(`  total unrealized P&L (DB): ${sign(totalUnrealized)}$${fmt(Math.abs(totalUnrealized))}`);

  // ── DRY-RUN: stop here, send nothing. ──
  if (!willExecute) {
    console.log("");
    console.log(`  DRY-RUN COMPLETE — NO ORDERS SENT.`);
    console.log(`  To execute: set ${CONFIRM_ENV}=${CONFIRM_FLAG} AND pass --execute  (manager only).`);
    console.log(`  Each close would be a marketable LMT via executeLiveSell (never a naked MKT).`);
    return;
  }

  // ── EXECUTE PATH: send one live close per position via executeLiveSell. ──
  console.log("");
  console.log(`  ███ EXECUTING LIVE CLOSES — ${openPos.length} position(s) via executeLiveSell (marketable LMT, IOC→DAY) ███`);
  let closed = 0, failed = 0;
  for (const pos of openPos) {
    console.log(`  [close] ${pos.ticker} (id=${pos.id}, qty=${Math.abs(pos.units)}) …`);
    try {
      const r = await executeLiveSell({ userId, positionId: pos.id, reason: "MANUAL_LIQUIDATE_LONG_CORE" });
      if (r.success) { closed++; console.log(`          OK — ${r.reason}`); }
      else { failed++; console.log(`          FAILED — ${r.reason}`); }
    } catch (e) {
      failed++;
      console.log(`          THREW — ${(e as Error).message ?? e}`);
    }
  }
  console.log("");
  console.log(`  EXECUTE COMPLETE: closed=${closed}  failed=${failed}.`);
  console.log(`  Verify fills + residual qty in IBKR — gap-open slippage is real.`);
}

function sign(n: number): string { return n >= 0 ? "+" : "-"; }

main().catch(err => {
  console.error(`[FATAL] ${(err as Error).stack ?? err}`);
  process.exit(1);
});
