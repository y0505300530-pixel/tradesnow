/**
 * cyclePhaseEngine.ts — ELZA 2.0 P0-8 / Volume-cycle gates (Ziv methodology).
 *
 * Ziv's "trading cycles" = VOLUME behavior, NOT Gann time cycles. The entry
 * gates that matter for P0:
 *
 *   CYC-L1 (long BLOCK):  price RISING on LOW volume      → false breakout, don't chase.
 *   CYC-S1 (short BLOCK): price FALLING on HIGH volume    → bear trap / capitulation, don't short.
 *
 * Positive confirmation (NOT a block): low volume on a PULLBACK (price not rising)
 * = dry retest = healthy — so CYC-L1 only fires when price is rising.
 *
 * CYC-L2 / CYC-S2 are primarily EXIT/management signals ("BLOCK/EXIT", "BLOCK/COVER")
 * and overlap with the positive dry-pullback confirmation. They are intentionally
 * NOT implemented as entry blocks here (would block the exact dry-pullback entries
 * we want). Flagged for the owner — see design §3.2.
 *
 * Pure module: no DB, no IBKR, no side effects. `classifyCyclePhase` takes plain
 * numbers (unit-testable); `buildCyclePhaseInput` derives them from bars.
 */
import { calcEMA, calcRSI } from "./zivEngine";

/** Spec §3.2: volumeRatio < 0.85 = dry/low volume. */
export const LOW_VOL_RATIO = 0.85;
/** ELZA assumption (confirm with owner): elevated volume for bear-trap detection. */
export const HIGH_VOL_RATIO = 1.5;

export type CycleLocation = "LOW" | "HIGH" | "MID";
export type CycleGate = "OK" | "BLOCK";

export interface CycleBar { close: number; high: number; low: number; volume?: number }

export interface CyclePhaseInput {
  close: number;
  ema50: number;
  distToEma50Pct: number;    // ABS percent distance from EMA-50
  rsi: number;
  donchian20High: number;
  donchian20Low: number;
  volumeRatio: number;       // avg(last 5 vol) / avg(last 20 vol)
  priceRising: boolean;      // recent net move up (5-bar)
}

export interface CyclePhaseResult {
  location: CycleLocation;
  isLowCycle: boolean;
  isHighCycle: boolean;
  longGate: CycleGate;       // CYC-L1
  shortGate: CycleGate;      // CYC-S1
  code: "CYC-L1" | "CYC-S1" | null;
  reason: string;
}

/** Pure gate logic over numeric indicators. */
export function classifyCyclePhase(i: CyclePhaseInput): CyclePhaseResult {
  // ── Location (spec §3.2 proxy table). HIGH takes precedence when ambiguous. ──
  const midDonchian = (i.donchian20High + i.donchian20Low) / 2;
  const inUpperHalf = i.close >= midDonchian;
  const isHighCycle = i.distToEma50Pct > 5 || i.rsi > 60 || inUpperHalf;
  const isLowCycle  = !isHighCycle && (i.close <= i.ema50 || i.distToEma50Pct <= 3 || !inUpperHalf);
  const location: CycleLocation = isHighCycle ? "HIGH" : (isLowCycle ? "LOW" : "MID");

  let longGate: CycleGate = "OK";
  let shortGate: CycleGate = "OK";
  let code: CyclePhaseResult["code"] = null;
  const parts: string[] = [];

  // CYC-L1 — long: rise on LOW volume = false breakout → BLOCK.
  if (i.priceRising && i.volumeRatio < LOW_VOL_RATIO) {
    longGate = "BLOCK"; code = "CYC-L1";
    parts.push(`CYC-L1: rise on low volume (volRatio ${i.volumeRatio.toFixed(2)} < ${LOW_VOL_RATIO}) — false breakout`);
  }

  // CYC-S1 — short: drop on HIGH volume = bear trap → BLOCK.
  if (!i.priceRising && i.volumeRatio > HIGH_VOL_RATIO) {
    shortGate = "BLOCK"; code = code ?? "CYC-S1";
    parts.push(`CYC-S1: drop on high volume (volRatio ${i.volumeRatio.toFixed(2)} > ${HIGH_VOL_RATIO}) — bear trap`);
  }

  return {
    location, isLowCycle, isHighCycle, longGate, shortGate, code,
    reason: parts.length ? parts.join(" | ") : "cycle ok",
  };
}

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Derive CyclePhaseInput from daily bars. Returns null when there is not enough
 * history (<20 bars) to classify — caller should then skip the cycle gate (it is
 * an additional filter, not a safety gate; thin-data is handled by liquidity gate).
 */
export function buildCyclePhaseInput(bars: CycleBar[]): CyclePhaseInput | null {
  if (!bars || bars.length < 20) return null;
  const closes = bars.map(b => b.close);
  const last = closes[closes.length - 1];
  const ema50 = calcEMA(closes, 50);
  const last20 = bars.slice(-20);
  const donchian20High = Math.max(...last20.map(b => b.high));
  const donchian20Low  = Math.min(...last20.map(b => b.low));
  const distToEma50Pct = ema50 > 0 ? Math.abs(last - ema50) / ema50 * 100 : 999;
  const rsi = calcRSI(closes);
  const vols = bars.map(b => b.volume ?? 0);
  const volumeRatio = avg(vols.slice(-20)) > 0 ? avg(vols.slice(-5)) / avg(vols.slice(-20)) : 1;
  const ref = closes[closes.length - 6] ?? closes[0];   // 5-bar momentum reference
  const priceRising = last >= ref;
  return { close: last, ema50, distToEma50Pct, rsi, donchian20High, donchian20Low, volumeRatio, priceRising };
}

/** Convenience: classify directly from bars. Returns null when history is insufficient. */
export function classifyCyclePhaseFromBars(bars: CycleBar[]): CyclePhaseResult | null {
  const input = buildCyclePhaseInput(bars);
  return input ? classifyCyclePhase(input) : null;
}
