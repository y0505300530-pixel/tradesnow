/**
 * tradeOutputValidator.ts — bounds validation for LLM-suggested trade levels (Phase 7)
 */
import { z } from "zod";

const tickerSchema = z.string().min(1).max(16).regex(/^[A-Z0-9][A-Z0-9.\-]{0,15}$/i);

export interface TradeLevelValidation {
  valid: boolean;
  errors: string[];
  sl?: number;
  tp?: number;
}

export function validateDetectedTradeLevels(params: {
  ticker: string;
  entry: number;
  direction: "long" | "short";
  sl?: number | string | null;
  tp?: number | string | null;
}): TradeLevelValidation {
  const errors: string[] = [];
  const { entry, direction } = params;

  const tickerResult = tickerSchema.safeParse(params.ticker?.trim());
  if (!tickerResult.success) errors.push(`Invalid ticker: ${params.ticker}`);

  if (!entry || entry <= 0 || !Number.isFinite(entry)) {
    errors.push(`Invalid entry price: ${entry}`);
    return { valid: false, errors };
  }

  const sl = params.sl != null && params.sl !== "" ? Number(params.sl) : undefined;
  const tp = params.tp != null && params.tp !== "" ? Number(params.tp) : undefined;

  if (sl != null && (!Number.isFinite(sl) || sl <= 0)) errors.push(`Invalid SL: ${params.sl}`);
  if (tp != null && (!Number.isFinite(tp) || tp <= 0)) errors.push(`Invalid TP: ${params.tp}`);

  if (sl != null && Number.isFinite(sl)) {
    if (direction === "long") {
      if (sl >= entry) errors.push(`LONG SL ($${sl}) must be below entry ($${entry})`);
      if (entry - sl > entry * 0.15) errors.push(`LONG SL too wide: >15% from entry`);
    } else {
      if (sl <= entry) errors.push(`SHORT SL ($${sl}) must be above entry ($${entry})`);
      if (sl - entry > entry * 0.15) errors.push(`SHORT SL too wide: >15% from entry`);
    }
  }

  if (tp != null && Number.isFinite(tp)) {
    if (direction === "long") {
      if (tp <= entry) errors.push(`LONG TP ($${tp}) must be above entry ($${entry})`);
    } else {
      if (tp >= entry) errors.push(`SHORT TP ($${tp}) must be below entry ($${entry})`);
    }
  }

  if (sl != null && tp != null && Number.isFinite(sl) && Number.isFinite(tp)) {
    if (direction === "long" && !(sl < entry && entry < tp)) {
      errors.push(`LONG geometry violated: need SL < entry < TP`);
    }
    if (direction === "short" && !(tp < entry && entry < sl)) {
      errors.push(`SHORT geometry violated: need TP < entry < SL`);
    }
    const risk = direction === "long" ? entry - sl : sl - entry;
    const reward = direction === "long" ? tp - entry : entry - tp;
    if (risk > 0 && reward / risk < 1.0) {
      errors.push(`R/R below 1:1 (risk=$${risk.toFixed(2)} reward=$${reward.toFixed(2)})`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    sl: sl != null && Number.isFinite(sl) ? sl : undefined,
    tp: tp != null && Number.isFinite(tp) ? tp : undefined,
  };
}
