/**
 * Elza v5 Short Engine — core config.
 * Bear Wall + EMA breakdown entries + Fakeout SL + Parabolic Free-Fall Lock.
 */

export const ELZA_V5_SHORT_CONFIG = {
  /** Only short names trading below the 200-day EMA. */
  BEAR_WALL_EMA: 200,

  /** Breakdown trigger MAs. */
  BREAKDOWN_EMAS: [20, 50] as const,

  /** Volume spike threshold for score boost (bar vol / 20d avg). */
  VOLUME_SPIKE_RATIO: 1.5,

  /** Initial SL sits just above the breakdown candle high (+buffer bps). */
  SL_ABOVE_BREAKDOWN_BPS: 0.0005,

  /** RC-2 guard: skip if (SL − entry) / entry exceeds this %. */
  RC2_MAX_RISK_PCT: 12,

  /** Parabolic Free-Fall Lock stages (short R-multiples). */
  STAGE1_BE_R: 1.5,
  STAGE2_SCALE_R: 3.0,
  STAGE2_SCALE_FRACTION: 0.5,
  STAGE3_CHAND_ATR_MULT: 1.5,

  /** Portfolio */
  MAX_CONCURRENT: 12,
  MAX_PER_SECTOR: 3,
  START_EQUITY: 100_000,
  RISK_PCT: 0.01,
  HEAT_CAP: 0.20,
  MAX_POSITION_USD: 85_000,
  LEVERAGE_1X: 1.0,
  LEVERAGE_19X: 1.9,

  /** Friction (REALISTIC headline). */
  SLIPPAGE_BPS: 0.0005,
  COMMISSION_PER_SIDE: 1.0,

  /** 2022 bear-market window */
  WINDOW_START: "2022-01-01",
  WINDOW_END: "2022-12-31",
  WARMUP_START: "2021-01-01",

  /** Fetch enough history for EMA-200 warmup before 2022. */
  BARS_DAYS: 900,
  MIN_BARS: 50,
} as const;

export type ElzaV5ShortConfig = typeof ELZA_V5_SHORT_CONFIG;
