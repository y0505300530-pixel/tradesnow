/**
 * elzaV45DynamicLeverageAB.ts — Model A (flat 1.9×) vs Model B (3.5× intraday / 1.9× overnight EOD trim).
 *
 * Same Golden DNA candidates, gates, exits. Only leverage + EOD trim differ.
 *
 * RUN:
 *   node --import tsx --env-file=.env scripts/elzaV45DynamicLeverageAB.ts
 */
import "dotenv/config";
import type { Bar } from "../server/zivEngine";
import {
  buildGoldenDataset,
  candsForWindow,
  computeTradeR,
  WINDOWS,
  START_EQUITY,
  MARGIN_CALL_DD,
  BASE_RISK_PCT,
  HEAT_CAP,
  MAX_POSITION_USD,
  MAX_PER_SECTOR,
  MAX_CONCURRENT,
  SCALE_BANK_FRAC,
  RUNNER_FRAC,
  SCALE_R,
  TP_FINAL_R,
  SLIPPAGE_BPS,
  COMMISSION_PER_SIDE,
  GENESIS_TIME_STOP_BARS,
  CHANDELIER_ATR_MULT,
  computeAtr14Local,
  type Candidate,
  type FrictionMode,
} from "./elzaV45GoldenDNA";

const MODEL_A_LEV = 1.9;
const MODEL_B_INTRADAY = 3.5;
const MODEL_B_OVERNIGHT = 1.9;
const FRICTION: FrictionMode = "REALISTIC";

type LevModel = "A" | "B";

interface OpenPos {
  ticker: string;
  sector: string;
  notional: number;
  riskDollars: number;
  candIdx: number;
  naturalExitDate: string;
  totalScore: number;
}

interface ClosedRow {
  ticker: string;
  entryDate: string;
  exitDate: string;
  exitReason: string;
  r: number;
  naturalR: number;
  pnl: number;
  eodTrimmed: boolean;
  murdered: boolean;
  wouldReachTarget: boolean;
}

interface LevResult {
  model: LevModel;
  windowLabel: string;
  tradesTaken: number;
  finalReturnPct: number;
  maxDrawdownPct: number;
  finalEquity: number;
  marginCallFlag: boolean;
  eodTrimCount: number;
  eodTrimR: number;
  murderedCount: number;
  murderedR: number;
  murderedTargetCount: number;
  murderedTargetR: number;
}

function rFromExitState(
  entry: number,
  sl: number,
  scaledOut: boolean,
  scaleTarget: number,
  openFrac: number,
  openExitPrice: number,
  friction: FrictionMode,
): number {
  const real = friction === "REALISTIC";
  const entryFill = real ? entry * (1 + SLIPPAGE_BPS) : entry;
  const risk = entryFill - sl;
  if (!(risk > 0)) return 0;
  const sell = (px: number): number => (real ? px * (1 - SLIPPAGE_BPS) : px);

  let r = 0;
  let exitSides = 0;
  if (scaledOut) {
    r += SCALE_BANK_FRAC * ((sell(scaleTarget) - entryFill) / risk);
    exitSides += 1;
  }
  if (openFrac > 0) {
    r += openFrac * ((sell(openExitPrice) - entryFill) / risk);
    exitSides += 1;
  }
  if (real) {
    const sharesFull = (BASE_RISK_PCT * START_EQUITY) / risk;
    const commR = sharesFull > 0 ? COMMISSION_PER_SIDE / (sharesFull * risk) : 0;
    r -= (1 + exitSides) * commR;
  }
  return Math.round(r * 100) / 100;
}

interface WalkState {
  scaledOut: boolean;
  freeRoll: boolean;
  openFrac: number;
  openExitPrice: number;
  closed: boolean;
  unrealizedR: number;
}

function walkGoldenToDate(
  c: Candidate,
  bars: Bar[],
  throughDate: string,
): WalkState | null {
  const entryIdx = bars.findIndex((b) => b.date === c.entryDate);
  const thruIdx = bars.findIndex((b) => b.date === throughDate);
  if (entryIdx < 0 || thruIdx < 0 || thruIdx < entryIdx) return null;

  const entry = c.entry;
  const sl = c.sl;
  const risk = entry - sl;
  if (!(risk > 0)) return null;

  const scaleTarget = c.scaleTarget;
  const tpFinal = entry + TP_FINAL_R * risk;

  let scaledOut = false;
  let openFrac = 1.0;
  let currentStop = sl;
  let highestHigh = bars[entryIdx].high;
  let trailStop = -Infinity;
  let openExitPrice = entry;
  let closed = false;

  for (let j = entryIdx + 1; j <= thruIdx; j++) {
    const bar = bars[j];
    if (!scaledOut) {
      if (bar.low <= currentStop) {
        openFrac = 1.0;
        openExitPrice = currentStop;
        closed = true;
        break;
      }
      if (bar.high >= scaleTarget) {
        scaledOut = true;
        openFrac = RUNNER_FRAC;
        currentStop = entry;
        highestHigh = Math.max(highestHigh, bar.high);
        const atr = computeAtr14Local(bars.slice(0, j + 1));
        trailStop =
          atr != null && atr > 0
            ? Math.max(entry, highestHigh - CHANDELIER_ATR_MULT * atr)
            : entry;
        continue;
      }
      if (j - entryIdx >= GENESIS_TIME_STOP_BARS) {
        openFrac = 1.0;
        openExitPrice = bar.close;
        closed = true;
        break;
      }
    } else {
      highestHigh = Math.max(highestHigh, bar.high);
      const atr = computeAtr14Local(bars.slice(0, j + 1));
      if (atr != null && atr > 0) {
        trailStop = Math.max(trailStop, highestHigh - CHANDELIER_ATR_MULT * atr);
      }
      currentStop = Math.max(currentStop, trailStop);

      if (bar.low <= currentStop) {
        openFrac = RUNNER_FRAC;
        openExitPrice = currentStop;
        closed = true;
        break;
      }
      if (bar.high >= tpFinal) {
        openFrac = RUNNER_FRAC;
        openExitPrice = tpFinal;
        closed = true;
        break;
      }
    }
  }

  if (!closed) {
    openExitPrice = bars[thruIdx].close;
  }

  const entryFill = FRICTION === "REALISTIC" ? entry * (1 + SLIPPAGE_BPS) : entry;
  const markR =
    risk > 0
      ? scaledOut
        ? SCALE_BANK_FRAC * SCALE_R +
          openFrac * ((openExitPrice - entryFill) / (entryFill - sl))
        : openFrac * ((openExitPrice - entryFill) / (entryFill - sl))
      : 0;

  const freeRoll = scaledOut && currentStop >= entry;

  return {
    scaledOut,
    freeRoll,
    openFrac: closed ? openFrac : openFrac,
    openExitPrice,
    closed,
    unrealizedR: markR,
  };
}

function forcedExitR(c: Candidate, bars: Bar[], trimDate: string): number {
  const st = walkGoldenToDate(c, bars, trimDate);
  if (!st) return 0;
  return rFromExitState(
    c.entry,
    c.sl,
    st.scaledOut,
    c.scaleTarget,
    st.openFrac,
    st.openExitPrice,
    FRICTION,
  );
}

function isTargetExit(reason: string): boolean {
  return reason === "TP_FINAL" || reason === "TRAIL" || reason === "TRAIL_OPEN";
}

function runLeveragePortfolio(
  windowCands: Candidate[],
  barsByTicker: Map<string, Bar[]>,
  model: LevModel,
  windowLabel: string,
): LevResult {
  const intradayCap = model === "A" ? MODEL_A_LEV : MODEL_B_INTRADAY;
  const overnightCap = MODEL_B_OVERNIGHT;

  const dates = new Set<string>();
  windowCands.forEach((c) => {
    dates.add(c.entryDate);
    dates.add(c.exitDate);
  });
  const sortedDates = [...dates].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const candsByEntryDate = new Map<string, Candidate[]>();
  windowCands.forEach((c, idx) => {
    (c as Candidate & { __idx: number }).__idx = idx;
    const arr = candsByEntryDate.get(c.entryDate) ?? [];
    arr.push(c);
    candsByEntryDate.set(c.entryDate, arr);
  });

  let equity = START_EQUITY;
  let peakEquity = equity;
  let maxDrawdownPct = 0;
  let marginCallFlag = false;

  const openByIdx = new Map<number, OpenPos>();
  const openTickers = new Set<string>();
  const closed: ClosedRow[] = [];

  let eodTrimCount = 0;
  let eodTrimR = 0;
  let murderedCount = 0;
  let murderedR = 0;
  let murderedTargetCount = 0;
  let murderedTargetR = 0;

  const grossOpenNotional = (): number => {
    let s = 0;
    for (const p of openByIdx.values()) s += p.notional;
    return s;
  };
  const grossOpenRisk = (): number => {
    let s = 0;
    for (const p of openByIdx.values()) s += p.riskDollars;
    return s;
  };
  const openCountInSector = (sec: string): number => {
    let n = 0;
    for (const p of openByIdx.values()) if (p.sector === sec) n++;
    return n;
  };

  const closePosition = (
    idx: number,
    pos: OpenPos,
    exitDate: string,
    exitReason: string,
    r: number,
    eodTrimmed: boolean,
  ) => {
    const c = windowCands[idx];
    const naturalR = computeTradeR(c, FRICTION);
    const pnl = r * pos.riskDollars;
    equity += pnl;
    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    if (dd > MARGIN_CALL_DD) marginCallFlag = true;

    const murdered = eodTrimmed && exitDate < c.exitDate;
    const wouldReachTarget = isTargetExit(c.exitReason) || c.scaledOut;

    if (eodTrimmed) {
      eodTrimCount++;
      eodTrimR += r;
    }
    if (murdered) {
      murderedCount++;
      murderedR += naturalR - r;
      if (wouldReachTarget) {
        murderedTargetCount++;
        murderedTargetR += naturalR - r;
      }
    }

    closed.push({
      ticker: c.ticker,
      entryDate: c.entryDate,
      exitDate,
      exitReason,
      r,
      naturalR,
      pnl,
      eodTrimmed,
      murdered,
      wouldReachTarget,
    });

    openByIdx.delete(idx);
    openTickers.delete(pos.ticker);
  };

  for (const day of sortedDates) {
    // (a) Natural Golden exits
    for (const [idx, pos] of [...openByIdx.entries()]) {
      if (pos.naturalExitDate !== day) continue;
      const c = windowCands[idx];
      closePosition(idx, pos, day, c.exitReason, computeTradeR(c, FRICTION), false);
    }

    // (b) EOD trim — Model B only (15:45 EST ≈ daily close proxy)
    if (model === "B") {
      const targetNotional = overnightCap * equity;
      let gross = grossOpenNotional();
      if (gross > targetNotional + 1) {
        const trimPool = [...openByIdx.entries()]
          .map(([idx, pos]) => {
            const c = windowCands[idx];
            const bars = barsByTicker.get(c.ticker);
            if (!bars) return null;
            const st = walkGoldenToDate(c, bars, day);
            if (!st || st.freeRoll) return null;
            return { idx, pos, st, totalScore: c.totalScore };
          })
          .filter((x): x is NonNullable<typeof x> => x != null)
          .sort((a, b) => a.st.unrealizedR - b.st.unrealizedR || a.totalScore - b.totalScore);

        for (const t of trimPool) {
          if (gross <= targetNotional + 1) break;
          const c = windowCands[t.idx];
          const bars = barsByTicker.get(c.ticker)!;
          const r = forcedExitR(c, bars, day);
          const notional = t.pos.notional;
          closePosition(t.idx, t.pos, day, "EOD_TRIM", r, true);
          gross -= notional;
        }
      }
    }

    // (c) Entry auction
    const todays = (candsByEntryDate.get(day) ?? [])
      .slice()
      .sort((a, b) => {
        if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
        return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
      });

    for (const c of todays) {
      const idx = (c as Candidate & { __idx: number }).__idx;
      if (openByIdx.size >= MAX_CONCURRENT) break;
      if (openTickers.has(c.ticker)) continue;
      if (openCountInSector(c.sector) >= MAX_PER_SECTOR) continue;

      const equityAtEntry = equity;
      let riskDollars = BASE_RISK_PCT * c.spyMult * c.vixMult * equityAtEntry;
      const heatAfter = (grossOpenRisk() + riskDollars) / (equityAtEntry > 0 ? equityAtEntry : 1);
      if (heatAfter > HEAT_CAP) continue;

      let notional = riskDollars / c.stopDistPct;
      if (notional > MAX_POSITION_USD) {
        const scale = MAX_POSITION_USD / notional;
        notional *= scale;
        riskDollars *= scale;
      }
      const headroom = Math.max(0, intradayCap * equityAtEntry - grossOpenNotional());
      if (notional > headroom) {
        const scale = headroom > 0 ? headroom / notional : 0;
        if (scale <= 0) continue;
        notional *= scale;
        riskDollars *= scale;
      }
      if (notional < 1) continue;

      openByIdx.set(idx, {
        ticker: c.ticker,
        sector: c.sector,
        notional,
        riskDollars,
        candIdx: idx,
        naturalExitDate: c.exitDate,
        totalScore: c.totalScore,
      });
      openTickers.add(c.ticker);
    }
  }

  return {
    model,
    windowLabel,
    tradesTaken: closed.length,
    finalReturnPct: ((equity - START_EQUITY) / START_EQUITY) * 100,
    maxDrawdownPct: maxDrawdownPct * 100,
    finalEquity: Math.round(equity),
    marginCallFlag,
    eodTrimCount,
    eodTrimR: +eodTrimR.toFixed(2),
    murderedCount,
    murderedR: +murderedR.toFixed(2),
    murderedTargetCount,
    murderedTargetR: +murderedTargetR.toFixed(2),
  };
}

function pad(s: string | number, w: number): string {
  const str = String(s);
  return str.length >= w ? str : str + " ".repeat(w - str.length);
}

function sign(n: number): string {
  return n >= 0 ? "+" : "";
}

async function main(): Promise<void> {
  console.log("Elza v4.5 — Dynamic Leverage A/B (Golden DNA harness, READ-ONLY)\n");
  console.log(`  Model A: flat ${MODEL_A_LEV}× intraday+overnight, no EOD trim, Golden exit`);
  console.log(
    `  Model B: ${MODEL_B_INTRADAY}× intraday sizing → EOD trim to ${MODEL_B_OVERNIGHT}× (losers/low-score first; Free-Roll immune)\n`,
  );

  console.log("[LOAD] Building Golden DNA candidate set (600d bars, ~149 tickers)...");
  const { cands, barsByTicker } = await buildGoldenDataset();
  console.log(`[LOAD] ${cands.length} candidates, ${barsByTicker.size} tickers\n`);

  const allResults: LevResult[] = [];

  for (const win of WINDOWS) {
    const wc = candsForWindow(cands, win.start, win.end);
    const resA = runLeveragePortfolio(wc, barsByTicker, "A", win.label);
    const resB = runLeveragePortfolio(wc, barsByTicker, "B", win.label);
    allResults.push(resA, resB);

    console.log(`══════════════════════════════════════════════════════════════════`);
    console.log(` ${win.label} — LEVERAGE A/B (REALISTIC friction, ${wc.length} candidates)`);
    console.log(`══════════════════════════════════════════════════════════════════`);
    console.log(
      `${pad("Model", 8)} | ${pad("Trades", 7)} | ${pad("Return%", 10)} | ${pad("MaxDD%", 9)} | ${pad("FinalEq$", 12)} | marginCall`,
    );
    console.log("-".repeat(72));
    for (const r of [resA, resB]) {
      const label = r.model === "A" ? `A ${MODEL_A_LEV}x` : `B ${MODEL_B_INTRADAY}/${MODEL_B_OVERNIGHT}x`;
      console.log(
        `${pad(label, 8)} | ${pad(r.tradesTaken, 7)} | ${pad(sign(r.finalReturnPct) + r.finalReturnPct.toFixed(2) + "%", 10)} | ${pad(r.maxDrawdownPct.toFixed(2) + "%", 9)} | ${pad("$" + r.finalEquity.toLocaleString(), 12)} | ${r.marginCallFlag ? "YES" : "no"}`,
      );
    }
    console.log("");
    console.log(`  Model B EOD-TRIM autopsy (${win.label}):`);
    console.log(`    Trades closed by 15:45 knife     : ${resB.eodTrimCount} (${sign(resB.eodTrimR)}${resB.eodTrimR.toFixed(2)}R realized)`);
    console.log(
      `    Murdered early (vs natural exit) : ${resB.murderedCount} trades, ${sign(resB.murderedR)}${resB.murderedR.toFixed(2)}R sacrificed`,
    );
    console.log(
      `    Of those, would've hit target path: ${resB.murderedTargetCount} trades, ${sign(resB.murderedTargetR)}${resB.murderedTargetR.toFixed(2)}R left on table`,
    );
    console.log("");
  }

  console.log("═══════════════════════════════════════════════════════════════════════════════");
  console.log(" COLD COMPARISON TABLE — Leveraged return & Max DD");
  console.log("═══════════════════════════════════════════════════════════════════════════════\n");
  console.log(
    `${pad("Window", 10)} | ${pad("Model", 14)} | ${pad("Return%", 10)} | ${pad("MaxDD%", 9)} | ${pad("Trades", 7)}`,
  );
  console.log("-".repeat(60));
  for (const r of allResults) {
    const label = r.model === "A" ? `A flat ${MODEL_A_LEV}x` : `B ${MODEL_B_INTRADAY}/${MODEL_B_OVERNIGHT}x`;
    console.log(
      `${pad(r.windowLabel, 10)} | ${pad(label, 14)} | ${pad(sign(r.finalReturnPct) + r.finalReturnPct.toFixed(2) + "%", 10)} | ${pad(r.maxDrawdownPct.toFixed(2) + "%", 9)} | ${pad(r.tradesTaken, 7)}`,
    );
  }

  console.log("\n" + JSON.stringify({ models: { A: MODEL_A_LEV, B: { intraday: MODEL_B_INTRADAY, overnight: MODEL_B_OVERNIGHT } }, results: allResults }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
