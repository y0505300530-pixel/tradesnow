/**
 * Elza v5.0 Bloodhound — short engine config (2022 crash test).
 * Donchian breakdown + Wide Lung inverted SL + Golden DNA short exits.
 */

export const ELZA_V5_BLOODHOUND_CONFIG = {
  /** Tier-5 entry: Donchian-20 breakdown below EMA-50 + volume panic. */
  DONCHIAN_PERIOD: 20,
  VOLUME_SPIKE_RATIO: 1.5,
  TIER5_BASE_SCORE: 5.0,

  /** Wide Lung inverted SL: max(entry×1.08, EMA-50×1.01). */
  SL_PCT_CEILING: 1.08,
  SL_EMA50_MULT: 1.01,
  RC2_MAX_RISK_PCT: 12,

  /** Golden DNA short exits. */
  STAGE1_BE_R: 1.5,
  STAGE2_SCALE_R: 2.5,
  STAGE2_SCALE_FRAC: 0.4,
  RUNNER_FRAC: 0.6,
  TP_MAX_R: 5.0,
  CHANDELIER_ATR_MULT: 2.5,

  /** Fast Kill / time-stop is DEAD — shorts exit only via SL, BE, scale, TP_MAX, or TRAIL. */
  ENABLE_TIME_STOP: false,

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

  WINDOW_START: "2022-01-01",
  WINDOW_END: "2022-12-31",
  WARMUP_START: "2021-01-01",
  BARS_DAYS: 900,
  MIN_BARS: 50,
} as const;

export type ElzaV5BloodhoundConfig = typeof ELZA_V5_BLOODHOUND_CONFIG;
