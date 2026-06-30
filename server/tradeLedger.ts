// server/tradeLedger.ts
// PURE read-model over CLOSED livePositions rows — the ONE owner of the closed-trade
// ledger projection. NO DB access here (the query lives in the router); these are pure
// functions over an in-memory array so they are trivially testable and deterministic.
//
// Spec: docs/ziv-engine-spec/ledger-warreport-spec.md §2 (the ledger is a VIEW over
// livePositions, not a new table). The integrity filters (phantom / no-price reasons)
// are centralized here so tradingJournal.ts can import them and the two never drift.
//
// Degrade-safe: null pnl/R rows are excluded from the relevant stat (never throw);
// entryStructMeta may be null, a JSON string, or an object — parsed defensively.
import { classifyTradeOutcome } from "./livePnlStats";

// ── Integrity filters (single source — mirror tradingJournal.ts; import from here) ──
/** No-fill phantoms — dropped from the ledger entirely (never a real trade). */
export const PHANTOM_REASONS = ["ENTRY_CANCELLED", "ENTRY_NEVER_FILLED"];
/** Closes with a FABRICATED P&L (exit price unknown) — excluded from win-rate + totals. */
export const NO_PRICE_REASONS = [
  "CLOSED_IBKR_NO_PRICE",
  "CLOSE_PRICE_UNKNOWN",
  "CLOSE_PRICE_UNKNOWN_BREAKEVEN",
];
/**
 * DB-reconcile closes — a parallel reconcile job closes phantom/orphan positions with a
 * tagged exitReason (e.g. RECONCILE_PHANTOM_<date>, CLOSED_RECONCILE). These are NOT real
 * outcomes and must never pollute win-rate/totals. Defensive CATCH-ALL: matched by pattern,
 * not an enumerated list, so any future RECONCILE_* tag is excluded automatically.
 */
export const RECONCILE_REASON_PATTERN = /RECONCILE/i;

/**
 * Single predicate for "drop this close from stats". Combines the enumerated phantom /
 * no-price reasons with the reconcile catch-all. Callers (warReport / journal pre-filters)
 * should use this so the three call-sites never drift; computeStats also applies it
 * defensively as a last line of defense.
 */
export function isExcludedFromStats(exitReason: string | null | undefined): boolean {
  if (exitReason === null || exitReason === undefined) return false;
  if (PHANTOM_REASONS.includes(exitReason)) return true;
  if (NO_PRICE_REASONS.includes(exitReason)) return true;
  if (RECONCILE_REASON_PATTERN.test(exitReason)) return true;
  return false;
}

/** Reconcile / phantom / no-price closes — suppress from journal list + Telegram close alerts. */
export function isOpsNoiseClose(exitReason: string | null | undefined): boolean {
  return isExcludedFromStats(exitReason);
}

export interface LedgerRow {
  ticker: string;
  direction: "long" | "short";
  route: string;
  entryPrice: number;
  exitPrice: number | null;
  units: number;
  realizedPnl: number | null;
  realizedR: number | null;
  exitReason: string | null;
  holdDays: number | null;
  weeklyState: string | null;
  zoneStatus: string | null;
  openedAt: number;
  closedAt: number | null;
}

export interface LedgerStats {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  totalPnl: number;
  avgR: number;
  expectancyR: number;
  medianHoldDays: number | null;
}

const MS_PER_DAY = 86_400_000;

/** Coerce anything (string | number | null | undefined | Date) to a finite number or null. */
function toNum(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Defensively parse entryStructMeta which may be:
 *   - null / undefined           → {}
 *   - a JSON string              → parsed object (or {} on malformed)
 *   - an already-parsed object   → as-is
 *   - anything else (number/etc) → {}
 * Never throws.
 */
export function parseStructMeta(raw: any): Record<string, any> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "object") {
    // Arrays / Dates are objects but not meta maps — guard against them.
    if (Array.isArray(raw) || raw instanceof Date) return {};
    return raw as Record<string, any>;
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return {};
    try {
      const parsed = JSON.parse(s);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Pull a nested string field defensively (e.g. weekly.structure). */
function nestedStr(obj: Record<string, any>, parent: string, child: string): string | null {
  const p = obj?.[parent];
  if (p && typeof p === "object") {
    const v = p[child];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * Map a raw livePositions row → canonical LedgerRow. Pure; never throws.
 * route resolves from entryStructMeta.route, falling back to signal (then "UNKNOWN").
 */
export function toLedgerRow(pos: any): LedgerRow {
  const meta = parseStructMeta(pos?.entryStructMeta);

  const direction: "long" | "short" = pos?.direction === "short" ? "short" : "long";

  const route =
    (typeof meta.route === "string" && meta.route.length > 0 && meta.route) ||
    (typeof pos?.signal === "string" && pos.signal.length > 0 && pos.signal) ||
    "UNKNOWN";

  const weeklyState =
    nestedStr(meta, "weekly", "structure") ??
    (typeof meta.weeklyState === "string" ? meta.weeklyState : null) ??
    (typeof pos?.weeklyState === "string" ? pos.weeklyState : null);

  const zoneStatus =
    nestedStr(meta, "zone", "kind") ??
    (typeof meta.zoneStatus === "string" ? meta.zoneStatus : null) ??
    (typeof pos?.zoneStatus === "string" ? pos.zoneStatus : null);

  const entryPrice = toNum(pos?.entryPrice) ?? 0;
  const exitPrice = toNum(pos?.exitPrice);
  const units = Math.abs(toNum(pos?.units) ?? 0);
  // Total realized = final-leg pnl + any banked partial (scale-out / freeroll).
  // Preserve the "null pnl ⇒ excluded" contract: only when BOTH legs are missing
  // is this a genuinely unpriced close (null). Otherwise a missing leg counts as 0.
  const finalPnl = toNum(pos?.realizedPnl);
  const partialPnl = toNum(pos?.partialRealizedPnl);
  const realizedPnl =
    finalPnl === null && partialPnl === null ? null : (finalPnl ?? 0) + (partialPnl ?? 0);

  const openedAt = toNum(pos?.openedAt) ?? 0;
  const closedAt = toNum(pos?.closedAt);

  // realizedR = realized$ / (per-share initial risk * units). Null when rValue/units missing.
  const rValue = toNum(pos?.rValue);
  let realizedR: number | null = null;
  if (realizedPnl !== null && rValue !== null && rValue > 0 && units > 0) {
    realizedR = realizedPnl / (rValue * units);
  }

  let holdDays: number | null = null;
  if (closedAt !== null && openedAt > 0 && closedAt >= openedAt) {
    holdDays = (closedAt - openedAt) / MS_PER_DAY;
  }

  return {
    ticker: typeof pos?.ticker === "string" ? pos.ticker : "",
    direction,
    route,
    entryPrice,
    exitPrice,
    units,
    realizedPnl,
    realizedR,
    exitReason: typeof pos?.exitReason === "string" ? pos.exitReason : null,
    holdDays,
    weeklyState: weeklyState ?? null,
    zoneStatus: zoneStatus ?? null,
    openedAt,
    closedAt,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Compute aggregate stats over already-projected LedgerRows.
 * Degrade-safe contract:
 *   - rows with exitReason in PHANTOM_REASONS / NO_PRICE_REASONS / RECONCILE_* are normally
 *     caller-filtered, but computeStats also drops them defensively (isExcludedFromStats);
 *     it still guards null pnl/R.
 *   - wins/losses use classifyTradeOutcome (single owner of the BE threshold).
 *   - totalPnl / win-rate exclude rows with null realizedPnl.
 *   - avgR / expectancyR average only rows with a non-null realizedR.
 *   - medianHoldDays over rows with a non-null holdDays.
 */
export function computeStats(rowsIn: LedgerRow[]): LedgerStats {
  // Defensive last line of defense: even if a caller's pre-filter missed it, drop any
  // phantom / no-price / RECONCILE-tagged close so it can never be counted as a trade.
  const rows = rowsIn.filter((r) => !isExcludedFromStats(r.exitReason));
  const trades = rows.length;

  let wins = 0;
  let losses = 0;
  let totalPnl = 0;
  for (const r of rows) {
    if (r.realizedPnl === null) continue;
    totalPnl += r.realizedPnl;
    const outcome = classifyTradeOutcome(r.realizedPnl);
    if (outcome === "win") wins++;
    else if (outcome === "loss") losses++;
  }

  const decided = wins + losses;
  const winRatePct = decided > 0 ? (wins / decided) * 100 : 0;

  const rVals = rows.map((r) => r.realizedR).filter((v): v is number => v !== null);
  const avgR = rVals.length > 0 ? rVals.reduce((s, v) => s + v, 0) / rVals.length : 0;

  const winR = rows
    .filter((r) => r.realizedPnl !== null && classifyTradeOutcome(r.realizedPnl) === "win")
    .map((r) => r.realizedR)
    .filter((v): v is number => v !== null);
  const lossR = rows
    .filter((r) => r.realizedPnl !== null && classifyTradeOutcome(r.realizedPnl) === "loss")
    .map((r) => r.realizedR)
    .filter((v): v is number => v !== null);
  const avgWinR = winR.length > 0 ? winR.reduce((s, v) => s + v, 0) / winR.length : 0;
  const avgLossR = lossR.length > 0 ? lossR.reduce((s, v) => s + v, 0) / lossR.length : 0;
  const wr = decided > 0 ? wins / decided : 0;
  const expectancyR = wr * avgWinR + (1 - wr) * avgLossR;

  const holds = rows.map((r) => r.holdDays).filter((v): v is number => v !== null);
  const medianHoldDays = median(holds);

  return { trades, wins, losses, winRatePct, totalPnl, avgR, expectancyR, medianHoldDays };
}

/**
 * Group rows by an arbitrary key (e.g. route, weeklyState, route×weeklyState) and
 * compute LedgerStats per bucket. Deterministic; key fn decides the bucket label.
 */
export function groupBy(
  rows: LedgerRow[],
  key: (r: LedgerRow) => string,
): Record<string, LedgerStats> {
  const buckets: Record<string, LedgerRow[]> = {};
  for (const r of rows) {
    const k = key(r);
    (buckets[k] ??= []).push(r);
  }
  const out: Record<string, LedgerStats> = {};
  for (const k of Object.keys(buckets)) {
    out[k] = computeStats(buckets[k]);
  }
  return out;
}
