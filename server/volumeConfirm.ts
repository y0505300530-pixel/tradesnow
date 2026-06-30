/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║          ZIV ENGINE — Phase 4 · נמ"ס Volume Confirmation             ║
 * ║  Pure module. No DB, no IO, no clock. Single source of truth for     ║
 * ║  the breakout-bar volume-confirmation gate (spec: docs/ziv-engine-   ║
 * ║  spec/phase4-volume-spec.md).                                        ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * נמ"ס = ALL THREE (AND), evaluated on the LAST bar (the break bar):
 *   מ (volume)         — volRatio = lastBar.volume / avg(prior N=20 vols) >= VOL_MULT
 *   נ (healthy candle) — |close − open| / (high − low) >= HEALTHY_CANDLE_MIN
 *   ס (close near edge)— long: (close − low)/(high − low) >= CLOSE_NEAR_EXTREME_MIN
 *                        short:(high − close)/(high − low) >= CLOSE_NEAR_EXTREME_MIN
 *
 * Degrade-safe principle: uncertainty about volume ALWAYS resolves to
 * NOT-confirmed. A breakout that cannot be volume-verified is exactly the
 * naked chase RC-1 killed — never let a data gap re-open that door.
 *   - any of the last N+1 bars missing/zero volume → hasVolumeData=false → not confirmed
 *   - fewer than N+1 bars                          → hasVolumeData=false → not confirmed
 * The function NEVER throws and is pure (identical inputs → identical output).
 */

import type { Bar } from "./zivEngine";

// ─── Constants (SSOT — see spec §7) ──────────────────────────────────────────
export const VOL_AVG_WINDOW = 20; // N — baseline window of prior bars (מ)
export const VOL_MULT = 1.5; // מ — break-bar volume >= VOL_MULT × avg(N)
export const HEALTHY_CANDLE_MIN = 0.5; // נ — body / range
export const CLOSE_NEAR_EXTREME_MIN = 0.75; // ס — close in the top/bottom 25% of range

export interface VolumeConfirmResult {
  confirmed: boolean; // n && m && s && hasVolumeData
  volRatio: number; // lastBar.volume / avgVol(N)  (0 when no data)
  healthyCandle: boolean; // n && s (candle quality, volume-independent)
  n: boolean; // healthy candle (body >= half range)
  m: boolean; // break-bar volume >= VOL_MULT
  s: boolean; // close near the extreme (top/bottom 25% of range)
  hasVolumeData: boolean; // false ⇒ degrade-safe NOT confirmed
  reason: string; // human string for the funnel / measurement row
}

/**
 * Pure נמ"ס check on the LAST bar of `bars`.
 *
 * @param bars       daily bars; only the last bar + the prior N volumes are used.
 * @param level      breakout level: donchian20High (long) / donchian20Low (short).
 *                   Used only to flavour the human `reason`; the geometry is
 *                   level-independent (body/range + close-position).
 * @param direction  "long" | "short".
 */
export function confirmVolume(
  bars: Bar[],
  level: number,
  direction: "long" | "short",
): VolumeConfirmResult {
  const fail = (reason: string): VolumeConfirmResult => ({
    confirmed: false,
    volRatio: 0,
    healthyCandle: false,
    n: false,
    m: false,
    s: false,
    hasVolumeData: false,
    reason,
  });

  // ── < N+1 bars → no baseline (degrade-safe NOT confirmed) ──
  if (!Array.isArray(bars) || bars.length < VOL_AVG_WINDOW + 1) {
    return fail(`נמ"ס: insufficient bars for vol baseline (need ${VOL_AVG_WINDOW + 1})`);
  }

  const last = bars[bars.length - 1];
  if (!last) return fail('נמ"ס: missing last bar');

  // ── Volume baseline = the N bars PRIOR to the break bar ──
  // window = [-(N+1), -1) i.e. the N bars immediately before `last`.
  const baseline = bars.slice(-(VOL_AVG_WINDOW + 1), -1);
  const lastVol = last.volume;

  const baselineComplete =
    baseline.length === VOL_AVG_WINDOW &&
    baseline.every((b) => typeof b.volume === "number" && (b.volume as number) > 0);
  const hasVolumeData =
    baselineComplete && typeof lastVol === "number" && (lastVol as number) > 0;

  if (!hasVolumeData) {
    return fail('נמ"ס: no volume data — degrade-safe NOT confirmed');
  }

  const avgVol = (baseline as Bar[]).reduce((a, b) => a + (b.volume as number), 0) / VOL_AVG_WINDOW;
  if (avgVol <= 0) return fail('נמ"ס: avgVol <= 0 — degrade-safe NOT confirmed');

  const volRatio = (lastVol as number) / avgVol;
  const m = volRatio >= VOL_MULT;

  // ── Candle geometry (div-by-zero guarded) ──
  const range = Math.max(last.high - last.low, 1e-9);
  const body = Math.abs(last.close - last.open);
  const n = body / range >= HEALTHY_CANDLE_MIN;

  const s =
    direction === "long"
      ? (last.close - last.low) / range >= CLOSE_NEAR_EXTREME_MIN
      : (last.high - last.close) / range >= CLOSE_NEAR_EXTREME_MIN;

  const healthyCandle = n && s;
  const confirmed = n && m && s && hasVolumeData;

  const edge = direction === "long" ? "high" : "low";
  const reason = confirmed
    ? `נמ"ס OK: vol ${volRatio.toFixed(1)}x, healthy candle, close near ${edge} (level ${level})`
    : `נמ"ס FAIL: ${[
        !m && `vol ${volRatio.toFixed(1)}x < ${VOL_MULT}`,
        !n && "candle not healthy",
        !s && `close not near ${edge}`,
      ]
        .filter(Boolean)
        .join("; ")}`;

  return { confirmed, volRatio, healthyCandle, n, m, s, hasVolumeData, reason };
}
