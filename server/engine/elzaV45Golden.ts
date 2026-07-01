/**
 * Elza v4.5 Golden DNA — core config.
 * Wide Lung SL + Alpha/VIX macro guards + Golden 5:1 scale-out.
 */

export const ELZA_V45_GOLDEN_CONFIG = {
  /** Wide Lung: max(entry×0.92, EMA-50×0.99) — minimum 8% or 1% under EMA-50. */
  SL_PCT_FLOOR: 0.92,
  SL_EMA50_MULT: 0.99,

  RC2_MAX_RISK_PCT: 14,

  /** Golden Scale-Out @ +2.5R: bank 40%, BE on 60%. Runner → +5R or 2.5×ATR trail. */
  GOLDEN_SCALE_R: 2.5,
  GOLDEN_SCALE_FRAC: 0.4,
  RUNNER_FRAC: 0.6,
  TP_MAX_R: 5.0,
  CHANDELIER_ATR_MULT: 2.5,

  /** Generous pre-scale backstop (NO fast-kill). */
  TIME_STOP_BARS: 60,

  /** Alpha Mode — SPY vs EMA-50 on entry day. */
  ALPHA_ATTACK_MULT: 1.0,
  ALPHA_SAFE_HAVEN_MULT: 0.5,

  /** VIX guards on entry day. */
  VIX_REDUCE_THRESHOLD: 25,
  VIX_REDUCE_MULT: 0.7,
  VIX_BLOCK_THRESHOLD: 35,

  MAX_CONCURRENT: 12,
  MAX_PER_SECTOR: 3,
  START_EQUITY: 100_000,
  RISK_PCT: 0.01,
  HEAT_CAP: 0.20,
  MAX_POSITION_USD: 85_000,
  LEVERAGE_1X: 1.0,
  LEVERAGE_19X: 1.9,

  SLIPPAGE_BPS: 0.0005,
  COMMISSION_PER_SIDE: 1.0,

  BARS_DAYS: 600,
  MIN_BARS: 50,

  WINDOWS: [
    { label: "W-CAL2025", start: "2025-01-01", end: "2025-12-31" },
    { label: "W-2026", start: "2026-01-01", end: null as string | null },
  ],
} as const;

export type ElzaV45GoldenConfig = typeof ELZA_V45_GOLDEN_CONFIG;
