/**
 * minRValueGate.ts — MIN_R_PCT geometry gate (Entry-Churn / Min-R spec, 2026-07-01).
 *
 * Pure function — no DB, no network. The single missing MIN floor beneath RC-2's
 * MAX_STRUCTURAL_RISK_PCT (0.12): RC-2 skips a setup whose structural stop is TOO FAR
 * (risk > 12% of entry); this skips a setup whose stop is TOO TIGHT (risk < minRPct of
 * entry). An extended mega-cap whose structural stop sits ~0.11% below entry
 * (AAPL $288.35 / stop $286.71) is a scalp, not a swing trade — perShareRisk>0 so today
 * it passes; this gate blocks it.
 *
 * Wired AFTER the structural stop is computed (calcEntrySlTp / wideLungSL) and BEFORE
 * sizing / order transmit, in `liveOrderExecutor.tryLiveEntry` — the SSOT covering the
 * War, manual and alert entry paths. The caller supplies the effective broker entry +
 * stop and the config's minRPct.
 *
 * ── THE INERT INVARIANT ──────────────────────────────────────────────────────────
 * The caller only computes/applies this when `minRValuePctEnabled === 1`. `minRPct <= 0`
 * (or non-finite inputs) ⇒ `skip:false` — never blocks. Byte-identical when off.
 */

export interface MinRValueGateArgs {
  entry: number;
  stop: number;
  /** Minimum |entry−stop|/entry required to trade. <= 0 disables the check. */
  minRPct: number;
}

export interface MinRValueGateResult {
  skip: boolean;
  /** Actual risk-per-share as a fraction of entry (|entry−stop|/entry). */
  rPct: number;
  reason: string;
}

/**
 * assertMinRValuePct — pure geometry check. Returns `skip:true` only when the flag's
 * floor is active (minRPct > 0) AND the entry/stop geometry is finite AND the actual
 * rPct is strictly below the floor. Anything degraded (non-finite entry/stop, entry<=0)
 * is fail-OPEN here (skip:false) — the executor's existing NaN / never-naked / rValue>0
 * guards own those cases; this gate ONLY governs the too-tight-but-valid geometry.
 */
export function assertMinRValuePct(args: MinRValueGateArgs): MinRValueGateResult {
  const { entry, stop, minRPct } = args;

  // Flag off / no floor configured ⇒ no-op.
  if (!(minRPct > 0)) {
    return { skip: false, rPct: 0, reason: "min-R floor disabled" };
  }
  // Degraded inputs ⇒ defer to the executor's own guards (fail-open here).
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || entry <= 0) {
    return { skip: false, rPct: 0, reason: "non-finite entry/stop — deferred to executor guards" };
  }

  const rPct = Math.abs(entry - stop) / entry;

  if (rPct < minRPct) {
    return {
      skip: true,
      rPct,
      reason: `r=${(rPct * 100).toFixed(2)}% < ${(minRPct * 100).toFixed(2)}% — not tradeable`,
    };
  }
  return { skip: false, rPct, reason: "ok" };
}
