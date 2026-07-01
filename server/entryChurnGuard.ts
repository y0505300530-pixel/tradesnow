/**
 * entryChurnGuard.ts — Entry Churn Guard (Entry-Churn / Min-R spec, 2026-07-01).
 *
 * Pure helpers — no DB, no network. The DB READ of the churn ledger lives in warEngine
 * (cached ONCE per cycle, like `openTickerSet` — NOT a per-candidate query) and is only
 * performed when the flag is on; these functions operate on the resulting Set/Map.
 *
 * Two rules (flag=1):
 *   C1 — ≤ 1 automated entry / ticker / Israel calendar day. An automated entry is a
 *        `livePositions` row with `openedAt >= start-of-Israel-day` AND a signal that is
 *        NOT `MANUAL_%`. Once a ticker has one, a second automated entry is churn.
 *   C2 — a `cooldownMin` cooldown after ANY close (`closedAt`), regardless of the exit
 *        reason (MANUAL_CLOSE / SL / EOD all count). Prevents the same-day re-entry that
 *        burned budget on 30-Jun (AAPL closed 15:33 → re-entered 16:03/19:03).
 *
 * The Waiter retest pipeline is EXEMPT — it is the MANAGED re-entry (a resting LMT the
 * system itself placed), not churn. The caller (warEngine / tryLiveEntry) does not route
 * Waiter fills through this guard. Manual entries (MANUAL_%) are NOT blocked in v1.
 *
 * ── THE INERT INVARIANT ──────────────────────────────────────────────────────────
 * The caller builds the ledger and calls this ONLY when `entryChurnGuardEnabled === 1`.
 * Off ⇒ no ledger query, empty blocked sets, no call → runtime byte-identical.
 */

/** A row shape sufficient to build the churn ledger from a livePositions read. */
export interface ChurnLedgerRow {
  ticker: string;
  signal: string;
  status: string;
  openedAt: Date | string | null;
  closedAt: Date | string | null;
}

export interface ChurnLedger {
  /** Tickers (UPPERCASE) with ≥1 automated (non-MANUAL_) entry opened today. */
  automatedToday: Set<string>;
  /** ticker (UPPERCASE) → most-recent closedAt epoch ms (any exit reason). */
  lastCloseAt: Map<string, number>;
}

/** True for a system/automated signal (NOT a manual entry). MANUAL_% is exempt (C5). */
export function isAutomatedSignal(signal: string | null | undefined): boolean {
  const s = (signal ?? "").toUpperCase();
  return s.length > 0 && !s.startsWith("MANUAL_");
}

function toMs(v: Date | string | null | undefined): number | null {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Start-of-day (00:00) in Israel time, returned as an epoch-ms UTC instant. Used by the
 * caller to build the `openedAt >= start-of-Israel-day` predicate for C1. Israel is
 * UTC+2 (IST) / UTC+3 (IDT). We derive the offset from the Intl formatter so DST is
 * handled correctly rather than hard-coding +3.
 */
export function startOfIsraelDayMs(nowMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date(nowMs));
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? "0");
  const y = get("year"), mo = get("month"), d = get("day");
  let h = get("hour"); if (h === 24) h = 0; // Intl may render midnight as 24
  const mi = get("minute"), s = get("second");
  // Israel-local wall time as if UTC, minus the elapsed local seconds today = local midnight.
  const localAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const elapsedTodayMs = (h * 3600 + mi * 60 + s) * 1000;
  return localAsUtc - elapsedTodayMs;
}

/**
 * Build the churn ledger from a livePositions read. PURE — the caller does the DB query
 * (only when the flag is on) and passes the rows + the Israel-day / cooldown anchors.
 *   - automatedToday: rows opened >= dayStartMs with an automated (non-MANUAL_) signal.
 *   - lastCloseAt: closed rows whose closedAt >= cooldownFromMs → most-recent per ticker.
 */
export function buildChurnLedger(
  rows: ChurnLedgerRow[],
  opts: { dayStartMs: number; cooldownFromMs: number },
): ChurnLedger {
  const automatedToday = new Set<string>();
  const lastCloseAt = new Map<string, number>();
  for (const r of rows) {
    const tkr = (r.ticker ?? "").toUpperCase();
    if (!tkr) continue;
    const openedMs = toMs(r.openedAt);
    if (openedMs != null && openedMs >= opts.dayStartMs && isAutomatedSignal(r.signal)) {
      automatedToday.add(tkr);
    }
    if (r.status === "closed") {
      const closedMs = toMs(r.closedAt);
      if (closedMs != null && closedMs >= opts.cooldownFromMs) {
        const prev = lastCloseAt.get(tkr);
        if (prev == null || closedMs > prev) lastCloseAt.set(tkr, closedMs);
      }
    }
  }
  return { automatedToday, lastCloseAt };
}

export interface ChurnCheckArgs {
  ticker: string;
  direction: "long" | "short";
  automatedToday: Set<string>;
  lastCloseAt: Map<string, number>;
  nowMs: number;
  cooldownMin: number;
}

export interface ChurnCheckResult {
  blocked: boolean;
  reason: string;
}

/**
 * isChurnBlocked — PURE. Blocks a NON-manual (automated) entry when either:
 *   C1 — the ticker already had an automated entry today, OR
 *   C2 — the ticker closed within `cooldownMin` minutes (any exit reason).
 * Direction-symmetric (long/short share the ledger — a ticker churns regardless of side).
 * The caller must ONLY invoke this for automated signals and non-Waiter entries.
 */
export function isChurnBlocked(args: ChurnCheckArgs): ChurnCheckResult {
  const { ticker, automatedToday, lastCloseAt, nowMs, cooldownMin } = args;
  const tkr = (ticker ?? "").toUpperCase();

  // C1 — one automated entry per ticker per Israel calendar day.
  if (automatedToday.has(tkr)) {
    return { blocked: true, reason: "C1 already had an automated entry today (≤1/ticker/day)" };
  }

  // C2 — cooldown after any close.
  const lastClose = lastCloseAt.get(tkr);
  if (lastClose != null && cooldownMin > 0) {
    const elapsedMin = (nowMs - lastClose) / 60000;
    if (elapsedMin < cooldownMin) {
      return {
        blocked: true,
        reason: `C2 closed ${elapsedMin.toFixed(0)}m ago < ${cooldownMin}m cooldown`,
      };
    }
  }

  return { blocked: false, reason: "ok" };
}
