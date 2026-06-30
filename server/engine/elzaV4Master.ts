/**
 * Elza v4.0 High-Beta Master — core engine config.
 *
 * Pivot: shallow v4 entry + Genesis exit (NO Fast Kill) + options leverage sim.
 * Used by scripts/elzaV4MasterRun.ts (READ-ONLY backtest).
 */

export const ELZA_V4_MASTER_CONFIG = {
  /** Fast Kill is dead — let winners run to free-roll / trail. */
  ENABLE_FAST_KILL: false,

  /** Map stock R-multiples to ATM call premium R (high-beta names). */
  SIMULATE_OPTIONS: true,

  /**
   * Effective leverage: 1 stock R ≈ N option R on premium-at-risk basis.
   * High-beta ATM calls: ~0.9 stock R (≈4–5% underlying) → ~40–50% premium ≈ 10–12R.
   */
  OPTIONS_LEVERAGE_MULTIPLIER: 12,

  /** Pessimistic theta drag per calendar day held (option R). */
  OPTIONS_THETA_R_PER_DAY: 0.04,

  /** Round-trip bid-ask + slippage on premium (option R, one-time per trade). */
  OPTIONS_SPREAD_COST_R: 0.20,

  /** Max loss cap: full premium (-1R option) even if underlying stop would be wider. */
  OPTIONS_MAX_LOSS_R: -1.0,

  /** Portfolio window — continuous 2025 + 2026. */
  WINDOW_START: "2025-01-01",
  WINDOW_END: null as string | null,

  CONFIG_ID: "V4_MASTER" as const,
} as const;

export type ElzaV4MasterConfig = typeof ELZA_V4_MASTER_CONFIG;

export interface OptionTradeInputs {
  stockR: number;
  heldDays: number;
  friction: "FRICTIONLESS" | "REALISTIC";
}

/** Convert friction-mode stock R to option premium R (High-Beta ATM call model). */
export function computeOptionTradeR(
  inputs: OptionTradeInputs,
  cfg: ElzaV4MasterConfig = ELZA_V4_MASTER_CONFIG,
): number {
  if (!cfg.SIMULATE_OPTIONS) return inputs.stockR;

  let optR = inputs.stockR * cfg.OPTIONS_LEVERAGE_MULTIPLIER;

  if (inputs.friction === "REALISTIC") {
    optR -= inputs.heldDays * cfg.OPTIONS_THETA_R_PER_DAY;
    optR -= cfg.OPTIONS_SPREAD_COST_R;
  }

  if (optR < cfg.OPTIONS_MAX_LOSS_R) optR = cfg.OPTIONS_MAX_LOSS_R;

  return Math.round(optR * 100) / 100;
}

/** Calendar days between YYYY-MM-DD dates (inclusive minimum 1). */
export function heldDaysBetween(entryDate: string, exitDate: string): number {
  const a = new Date(`${entryDate}T12:00:00Z`).getTime();
  const b = new Date(`${exitDate}T12:00:00Z`).getTime();
  const days = Math.max(1, Math.round((b - a) / 86_400_000));
  return days;
}
