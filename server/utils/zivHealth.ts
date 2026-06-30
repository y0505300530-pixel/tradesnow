/**
 * zivHealth.ts — ZIV Health score utilities for live monitoring.
 * Re-exports core scoring from zivEngine for use by liveOrderExecutor shadow mode.
 */
export {
  calcZivHScore,
  getZivHTradingMode,
  type ZivHContext,
  type ZivHScoreResult,
  type ZivHTradingMode,
} from "../zivEngine";
