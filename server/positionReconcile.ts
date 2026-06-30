/**
 * positionReconcile.ts — DB-drift reconcile (Elza Live Engine)
 * ─────────────────────────────────────────────────────────────────────────────
 * livePositions DB rows can diverge from IBKR truth: a position closed at the
 * broker (manual TWS close / margin call / OCA stop fill the sync missed) can
 * leave a "phantom" DB row that is still status=open|zombie. Phantoms inflate
 * the heat meter and falsely block new entries.
 *
 * reconcilePhantomPositions() closes ONLY confirmed phantom rows — DB rows whose
 * ticker/conid is NOT present in a TRUSTED IBKR /positions read.
 *
 * SAFETY (live money — this is the only function here that touches position state):
 *   • Gated behind liveEngineConfig.dbReconcileEnabled (DEFAULT 0 = INERT). When
 *     OFF the function no-ops immediately — never reads, never writes.
 *   • The ibind gateway returns DEGRADED-EMPTY 200s (a single read lies). We
 *     require 2 CONSISTENT non-empty reads, retrying up to 3x, before trusting.
 *   • MASS-DISAPPEARANCE GUARD: if IBKR returns 0 positions, OR phantoms would be
 *     >50% of the open rows, ABORT and close NOTHING — a degraded read must never
 *     wipe the book.
 *   • Phantom closes are tagged exitReason='RECONCILE_PHANTOM_<YYYYMMDD>' so the
 *     ledger filter (built in parallel) drops them from win-rate.
 *
 * NOT wired to any cron yet — exported for manual / dry-run verification first.
 */

import { ibindRequest } from "./routers/ibkrProxy";
import { getDb } from "./db";
import { livePositions } from "../drizzle/schema";
import { and, eq, inArray } from "drizzle-orm";
import { log } from "./logger";
import { getLiveConfig } from "./liveOrderExecutor";

export interface ReconcileResult {
  checked: number;
  closed: string[];
  aborted?: string;
}

/** Normalize an IBKR /positions response body (object {positions:[]} or raw array). */
function extractIbkrPositionRows(body: unknown): any[] {
  if (Array.isArray(body)) return body;
  const arr = (body as any)?.positions;
  return Array.isArray(arr) ? arr : [];
}

/** Build the trusted identity set (tickers + conids) from a /positions read, qty != 0 only. */
function buildIbkrKeySet(rows: any[]): { tickers: Set<string>; conids: Set<string>; count: number } {
  const tickers = new Set<string>();
  const conids = new Set<string>();
  let count = 0;
  for (const p of rows) {
    if (Math.abs(Number(p?.position ?? 0)) <= 0) continue;
    count++;
    const tk = String(p?.contractDesc ?? p?.ticker ?? "").toUpperCase().trim();
    if (tk) tickers.add(tk);
    const conid = p?.conid ?? p?.conidEx ?? null;
    if (conid != null && String(conid).trim() !== "") conids.add(String(conid).trim());
  }
  return { tickers, conids, count };
}

/**
 * Read IBKR /positions WITH RETRY until two CONSISTENT non-empty reads agree on the
 * same trusted key set. The gateway returns degraded-empty 200s, so a single read is
 * not trustworthy. Returns null if we never got two consistent non-empty reads.
 */
async function fetchTrustedIbkrPositions(maxAttempts = 3): Promise<{ tickers: Set<string>; conids: Set<string>; count: number } | null> {
  let prevKey: string | null = null;
  let prevSet: { tickers: Set<string>; conids: Set<string>; count: number } | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 600));
    let rows: any[] = [];
    try {
      const res = await ibindRequest("GET", "/positions");
      if (!res.ok) {
        log.warn("LIVE_EXEC", `[Reconcile] /positions read attempt ${attempt + 1} not ok (HTTP ${res.status}) — retrying`);
        continue;
      }
      rows = extractIbkrPositionRows(res.body);
    } catch (e: any) {
      log.warn("LIVE_EXEC", `[Reconcile] /positions read attempt ${attempt + 1} threw: ${e?.message} — retrying`);
      continue;
    }

    const set = buildIbkrKeySet(rows);
    // A degraded-empty 200 is NOT trustworthy — never let an empty read become the trusted set.
    if (set.count === 0) {
      log.warn("LIVE_EXEC", `[Reconcile] /positions read attempt ${attempt + 1} returned 0 positions — possible degraded read, not trusting`);
      prevKey = null;
      prevSet = null;
      continue;
    }

    const key = [...set.tickers].sort().join(",") + "|" + [...set.conids].sort().join(",");
    if (prevKey != null && key === prevKey) {
      // Two consecutive non-empty reads agree → trust it.
      return set;
    }
    prevKey = key;
    prevSet = set;
  }

  // Never got two CONSISTENT non-empty reads → untrusted.
  return null;
}

/**
 * Close ONLY phantom livePositions rows (DB-open but absent from trusted IBKR truth).
 *
 * @param userId  owner user id
 * @param opts.dryRun  when true, computes + reports phantoms but writes NOTHING
 * @returns { checked, closed, aborted? }
 *          - checked: number of DB open/zombie rows examined
 *          - closed:  tickers whose rows were marked closed (empty in dryRun)
 *          - aborted: set when a guard tripped; NOTHING was closed
 */
export async function reconcilePhantomPositions(
  userId: number,
  opts?: { dryRun?: boolean },
): Promise<ReconcileResult> {
  const dryRun = opts?.dryRun === true;

  // ── INERT gate: flag OFF (DEFAULT) → no-op. Never reads, never writes. ───────
  const config = await getLiveConfig(userId);
  if (!config || ((config as any).dbReconcileEnabled ?? 0) !== 1) {
    return { checked: 0, closed: [], aborted: "disabled (dbReconcileEnabled=0)" };
  }

  const db = await getDb();
  if (!db) return { checked: 0, closed: [], aborted: "DB unavailable" };

  // ── Load DB rows that occupy a slot / heat: open + zombie ────────────────────
  const dbRows = await db.select().from(livePositions)
    .where(and(eq(livePositions.userId, userId), inArray(livePositions.status, ["open", "zombie"])));
  const checked = dbRows.length;
  if (checked === 0) return { checked: 0, closed: [] };

  // ── Trusted IBKR truth (2 consistent non-empty reads, retry up to 3x) ────────
  const trusted = await fetchTrustedIbkrPositions(3);
  if (!trusted) {
    log.warn("LIVE_EXEC", `[Reconcile] No two-consistent IBKR reads — ABORT (degraded gateway). Nothing closed.`);
    return { checked, closed: [], aborted: "mass-disappearance guard" };
  }

  // ── MASS-DISAPPEARANCE GUARD #1: IBKR reports 0 positions → never wipe book. ──
  // (fetchTrustedIbkrPositions already rejects empty reads, but guard explicitly.)
  if (trusted.count === 0) {
    log.warn("LIVE_EXEC", `[Reconcile] IBKR trusted set is empty — ABORT (mass-disappearance guard). Nothing closed.`);
    return { checked, closed: [], aborted: "mass-disappearance guard" };
  }

  // ── Identify phantoms: a DB row absent from the trusted IBKR ticker+conid set ──
  const phantoms = dbRows.filter((r) => {
    const tk = r.ticker.toUpperCase().trim();
    const tickerMatch = trusted.tickers.has(tk);
    // conid cross-check: if we ever wire conid onto livePositions, prefer it. Today the
    // row has no conid column, so ticker membership is the identity. (Future-proofed.)
    const conidMatch = false;
    return !tickerMatch && !conidMatch;
  });

  // ── MASS-DISAPPEARANCE GUARD #2: phantoms > 50% of open rows → degraded read. ──
  if (phantoms.length > checked * 0.5) {
    log.warn("LIVE_EXEC",
      `[Reconcile] phantoms ${phantoms.length}/${checked} (>50%) — ABORT (mass-disappearance guard). Nothing closed.`,
      { context: { checked, phantoms: phantoms.length, trustedCount: trusted.count } },
    );
    return { checked, closed: [], aborted: "mass-disappearance guard" };
  }

  if (phantoms.length === 0) {
    return { checked, closed: [] };
  }

  const closedTickers = phantoms.map((p) => p.ticker.toUpperCase());

  if (dryRun) {
    log.info("LIVE_EXEC",
      `[Reconcile] DRY-RUN — would close ${phantoms.length} phantom(s): ${closedTickers.join(", ")} (checked ${checked}, IBKR ${trusted.count})`,
      { context: { checked, phantoms: closedTickers, trustedCount: trusted.count } },
    );
    return { checked, closed: closedTickers };
  }

  // ── Confirmed phantoms — close ONLY these rows, ledger-tagged ────────────────
  const d = new Date();
  const yyyymmdd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const exitReason = `RECONCILE_PHANTOM_${yyyymmdd}`;
  const ids = phantoms.map((p) => p.id);

  await db.update(livePositions)
    .set({ status: "closed", exitReason, closedAt: new Date() })
    .where(inArray(livePositions.id, ids));

  log.warn("LIVE_EXEC",
    `[Reconcile] closed ${phantoms.length} phantom(s) [${exitReason}]: ${closedTickers.join(", ")} (checked ${checked}, IBKR ${trusted.count})`,
    { context: { checked, closed: closedTickers, exitReason, trustedCount: trusted.count } },
  );

  return { checked, closed: closedTickers };
}
