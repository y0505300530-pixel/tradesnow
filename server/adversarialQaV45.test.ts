/**
 * adversarialQaV45.test.ts — Adversarial QA for elzaV45LiveEnabled (4.0x go-live).
 *
 * These tests PROVE the parity gaps between the v4.5 Golden BACKTEST config
 * (server/engine/elzaV45Golden.ts, used ONLY by scripts/elzaV45Golden*.ts) and
 * the LIVE path (slCalculator + sizingEngine + liveOrderExecutor). Green here =
 * the documented (current) reality, NOT the spec. Each `expect` is annotated
 * with the spec it violates.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  calcSlTp,
  calcEntrySlTp,
  SCALE_OUT_TP1_R,
  SCALE_OUT_SELL_FRAC,
  freeRollTriggerGain,
  type Bar,
} from "./slCalculator";
import { computeRiskSizedQty } from "./sizingEngine";
import { computePartialPlan } from "./partialCloseLogic";
import { ELZA_V45_GOLDEN_CONFIG as V45 } from "./engine/elzaV45Golden";

const origMode = process.env.ELSA_TRADING_MODE;
afterEach(() => {
  if (origMode == null) delete process.env.ELSA_TRADING_MODE;
  else process.env.ELSA_TRADING_MODE = origMode;
});

// Synthetic descending-then-flat bars so the 20-bar structural low is well below entry.
function makeBars(entry: number): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < 60; i++) {
    const c = entry * (1 + (i - 30) * 0.002); // gentle ramp through entry
    bars.push({ close: c, high: c * 1.01, low: c * 0.985, open: c, volume: 1_000_000 });
  }
  return bars;
}

describe("Sector 1.1 — Initial SL parity (Wide Lung vs LIVE swing)", () => {
  it("v4.5 Wide Lung intraday formula = max(entry×0.92, EMA50×0.99)", () => {
    process.env.ELSA_TRADING_MODE = "intraday";
    const entry = 100;
    const ema50 = 96; // ema50×0.99 = 95.04  < entry×0.92 = 92 → pct wins
    const r = calcSlTp(entry, ema50);
    expect(r.stopLoss).toBeCloseTo(Math.max(entry * 0.92, ema50 * 0.99), 6);
  });

  it("LIVE DEFAULT (swing) does NOT use the Wide Lung formula — SHIP PARITY GAP", () => {
    // Live engine default ELSA_TRADING_MODE = 'swing' (slCalculator.getElsaTradingMode).
    process.env.ELSA_TRADING_MODE = "swing";
    const entry = 100;
    const ema50 = 96;
    const bars = makeBars(entry);
    const live = calcEntrySlTp({ entryPrice: entry, ema50, bars, direction: "long" });
    const wideLung = Math.max(entry * 0.92, ema50 * 0.99);
    // Live swing stop is structural (20-bar low − 0.5·ATR) / ATR-fallback — NOT Wide Lung.
    expect(live.slSource === "structural" || live.slSource === "atr").toBe(true);
    expect(Math.abs(live.stopLoss - wideLung)).toBeGreaterThan(0.01);
  });
});

describe("Sector 1.3 — Golden Scale-Out parity (2.5R/40% vs LIVE 2.0R/50%)", () => {
  it("v4.5 config = 2.5R / bank 40% / runner 60%", () => {
    expect(V45.GOLDEN_SCALE_R).toBe(2.5);
    expect(V45.GOLDEN_SCALE_FRAC).toBe(0.4);
    expect(V45.RUNNER_FRAC).toBe(0.6);
  });

  it("LIVE scale-out = 2.0R / 50% — SHIP PARITY GAP", () => {
    expect(SCALE_OUT_TP1_R).toBe(2.0); // spec/v4.5 wants 2.5
    expect(SCALE_OUT_SELL_FRAC).toBe(0.5); // spec/v4.5 wants 0.40
    const R = 1.5;
    // Live free-roll trigger fires at +2.0R, not +2.5R.
    expect(freeRollTriggerGain(R)).toBe(2.0 * R);
    expect(freeRollTriggerGain(R)).not.toBe(V45.GOLDEN_SCALE_R * R);
  });

  it("Golden 40% floor-whole-shares math (illustrative) vs LIVE 50% floor", () => {
    const units = 137;
    const goldenBank = Math.floor(units * 0.4); // 54
    const goldenRunner = units - goldenBank; // 83 (60%)
    expect(goldenBank).toBe(54);
    expect(goldenRunner).toBe(83);
    // LIVE actually closes floor(50%) via computePartialPlan(fraction=0.5):
    const livePlan = computePartialPlan(
      { id: 1, ticker: "T", direction: "long", units, entryPrice: 100, allocatedCapital: 13700 },
      0.5,
    );
    expect(livePlan.qtyToClose).toBe(68); // floor(137*0.5)=68, NOT 54
    expect(livePlan.qtyToClose).not.toBe(goldenBank);
  });
});

describe("Sector 4.2 — VIX threshold mismatch (config 35, spec 36)", () => {
  it("v4.5 VIX_BLOCK_THRESHOLD = 35 (spec requested 36)", () => {
    expect(V45.VIX_BLOCK_THRESHOLD).toBe(35);
    expect(V45.VIX_BLOCK_THRESHOLD).not.toBe(36);
  });
});

describe("Sector 4.3 — sizingEngine fail-closed on bad NLV (the GOOD guard)", () => {
  const base = {
    entryPrice: 100,
    slPrice: 92,
    direction: "long" as const,
    maxPositionUsd: 85_000,
    leverageCapUsd: 200_000,
    openHeatUsd: 0,
  };
  it("NLV NaN → SKIP (no phantom order)", () => {
    const r = computeRiskSizedQty({ ...base, nlv: Number.NaN });
    expect(r.skip).toBe(true);
    expect(r.reason).toBe("NLV_UNAVAILABLE");
    expect(r.qty).toBe(0);
  });
  it("NLV 0 → SKIP", () => {
    const r = computeRiskSizedQty({ ...base, nlv: 0 });
    expect(r.skip).toBe(true);
    expect(r.qty).toBe(0);
  });
  it("NLV valid → sizes (1% risk / SL distance)", () => {
    const r = computeRiskSizedQty({ ...base, nlv: 120_000 });
    // 1% of 120k = $1200 risk; SL dist = 8 → 150 shares.
    expect(r.skip).toBe(false);
    expect(r.qty).toBe(150);
  });
});

describe("Sector 1 — wiring: v4.5 Golden config is BACKTEST-ONLY", () => {
  it("the live SL/scale-out constants are independent of V45 config", () => {
    // If the live constants ever equalled V45, this would be wired. They are not.
    expect(SCALE_OUT_TP1_R).not.toBe(V45.GOLDEN_SCALE_R);
    expect(SCALE_OUT_SELL_FRAC).not.toBe(V45.GOLDEN_SCALE_FRAC);
  });
});
