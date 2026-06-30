/**
 * elzaV4Autopsy.ts — post-mortem on v4 Hybrid (FAST_TIME + cash drag)
 * RUN: npx tsx scripts/elzaV4Autopsy.ts
 */
import "dotenv/config";
import { fetchBarsForTicker } from "../server/marketData";
import type { Bar } from "../server/zivEngine";
import { ELZA_MAX_LONG } from "../server/deepAnalysisMeta";
import { loadProductionCatalogueWithStats } from "./lib/productionCatalogue";

// Mirror v4 constants
const PARTIAL_TP1_R = 1.5;
const FAST_TIME_BAR = 4;
const FAST_TIME_MIN_R = 1.0;
const SL_LOOKBACK = 10;
const RC2_MAX = 12;
const CHAND_MULT = 2.5;
const ATR_PERIOD = 14;
const SHALLOW_BAND = 0.025;
const TP_LOW_BUFFER_R = 0.25;
const BARS_DAYS = 420;
const MIN_BARS = 50;
const EARLIEST = "2025-01-01";
const MAX_SLOTS = ELZA_MAX_LONG;
const CF_HORIZON_BARS = 20; // counterfactual bars after FAST_TIME cut

import { calcZivEngineScore, calcEMA, type ZivScoreResult } from "../server/zivEngine";
import { confirmVolume } from "../server/volumeConfirm";

type ExitReason = "SL" | "FAST_TIME" | "TRAIL" | "TRAIL_OPEN" | "OPEN";
type EntryKind = "retest" | "breakout" | "override";

interface RawTrade {
  ticker: string;
  signalDate: string;
  entryDate: string;
  exitDate: string;
  entryKind: EntryKind;
  score: number;
  entry: number;
  sl: number;
  exitReason: ExitReason;
  exitBarIdx: number;
  entryBarIdx: number;
  mfeCloseRAtCut: number;
}

function atr14(bars: Bar[], end: number): number | null {
  if (end < 1) return null;
  const slice = bars.slice(0, end + 1);
  const p = Math.min(ATR_PERIOD, slice.length - 1);
  let sum = 0;
  for (let i = slice.length - p; i < slice.length; i++) {
    sum += Math.max(slice[i].high - slice[i].low, Math.abs(slice[i].high - slice[i - 1].close), Math.abs(slice[i].low - slice[i - 1].close));
  }
  return sum / p;
}

function classifyEntry(res: ZivScoreResult, bars: Bar[], i: number): EntryKind | null {
  const wb = bars.slice(0, i + 1);
  const closes = wb.map(b => b.close);
  const px = closes[closes.length - 1];
  const ema20 = calcEMA(closes, 20);
  const ema50 = res.ema50;
  const ema200 = res.ema200;
  if (res.weeklyEma50Slope < 0) return null;
  if (res.tier === "Gold Breakout" && res.score >= 9) {
    if (px < ema200 || px <= ema50) return null;
    if (!confirmVolume(wb, res.donchian20High, "long").confirmed) return null;
    return "breakout";
  }
  if (res.breakdown?.isOverride && res.score >= 6) {
    const vols = wb.map(b => b.volume ?? 0);
    const avg20 = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
    if (avg20 > 0 && (vols[vols.length - 1] ?? 0) / avg20 >= 2.0) return "override";
  }
  if (px < ema200) return null;
  if (res.tier !== "Gold Retest" || res.score < 7) return null;
  const d20 = ema20 > 0 ? Math.abs(px - ema20) / ema20 : 999;
  const d50 = ema50 > 0 ? Math.abs(px - ema50) / ema50 : 999;
  if (!(d20 <= SHALLOW_BAND || (d50 <= SHALLOW_BAND && px >= ema50 * 0.995))) return null;
  if (bars[i].low <= ema50 * 1.002) return null;
  return "retest";
}

function simulateTicker(ticker: string, bars: Bar[], out: RawTrade[]): void {
  let i = 0;
  while (i < bars.length && bars[i].date < EARLIEST) i++;
  for (; i < bars.length - 1; i++) {
    if (i + 1 < MIN_BARS || i + 1 < SL_LOOKBACK) continue;
    let res: ZivScoreResult;
    try { res = calcZivEngineScore(bars.slice(0, i + 1)); } catch { continue; }
    if (res.tier === "No Data" || res.tier === "Error") continue;
    const kind = classifyEntry(res, bars, i);
    if (!kind) continue;
    const entryIdx = i + 1;
    const entry = bars[entryIdx].open;
    if (!(entry > 0)) continue;
    const sl = Math.min(...bars.slice(i - (SL_LOOKBACK - 1), i + 1).map(b => b.low));
    if (!(sl < entry) || ((entry - sl) / entry) * 100 > RC2_MAX) continue;
    const risk = entry - sl;
    const target15 = entry + PARTIAL_TP1_R * risk;
    let exitReason: ExitReason = "OPEN";
    let exitIdx = bars.length - 1;
    let mfeCloseR = 0;
    let partial = false;
    let stop = sl;
    let trail = -Infinity;
    let peak = bars[entryIdx].high;

    for (let j = entryIdx; j < bars.length; j++) {
      const bar = bars[j];
      const held = j - entryIdx + 1;
      const closeR = (bar.close - entry) / risk;
      if (closeR > mfeCloseR) mfeCloseR = closeR;
      if (!partial) {
        if (bar.low <= stop) { exitReason = "SL"; exitIdx = j; break; }
        if (bar.low > stop + TP_LOW_BUFFER_R * risk && bar.high >= target15) {
          partial = true; stop = entry;
          peak = Math.max(peak, bar.high);
          const a = atr14(bars, j);
          trail = a ? Math.max(entry, peak - CHAND_MULT * a) : entry;
          stop = trail;
          exitReason = "TRAIL"; exitIdx = j;
          continue;
        }
        if (held >= FAST_TIME_BAR && mfeCloseR < FAST_TIME_MIN_R) {
          exitReason = "FAST_TIME"; exitIdx = j; break;
        }
        if (j === bars.length - 1) { exitReason = "OPEN"; exitIdx = j; }
      } else {
        peak = Math.max(peak, bar.high);
        const a = atr14(bars, j);
        if (a) trail = Math.max(trail, peak - CHAND_MULT * a);
        stop = trail;
        if (bar.low <= stop) { exitReason = "TRAIL"; exitIdx = j; break; }
        if (j === bars.length - 1) { exitReason = "TRAIL_OPEN"; exitIdx = j; }
      }
    }

    out.push({
      ticker, signalDate: bars[i].date, entryDate: bars[entryIdx].date, exitDate: bars[exitIdx].date,
      entryKind: kind, score: res.score, entry, sl, exitReason,
      exitBarIdx: exitIdx, entryBarIdx: entryIdx, mfeCloseRAtCut: mfeCloseR,
    });
    i = exitIdx;
  }
}

/** Counterfactual: if held after FAST_TIME cut, hit 1.5R before SL? */
function counterfactualAfterFastKill(t: RawTrade, bars: Bar[]): {
  hit15R: boolean; hit1R: boolean; maxHighR: number; stoppedBefore15: boolean;
} {
  const risk = t.entry - t.sl;
  const target15 = t.entry + PARTIAL_TP1_R * risk;
  let maxHighR = 0;
  let hit15R = false;
  let hit1R = false;
  let stopped = false;
  const end = Math.min(bars.length - 1, t.exitBarIdx + CF_HORIZON_BARS);
  for (let j = t.exitBarIdx + 1; j <= end; j++) {
    const bar = bars[j];
    maxHighR = Math.max(maxHighR, (bar.high - t.entry) / risk);
    if (bar.high >= t.entry + risk) hit1R = true;
    if (bar.low <= t.sl) { stopped = true; break; }
    if (bar.high >= target15) { hit15R = true; break; }
  }
  return { hit15R, hit1R, maxHighR: Math.round(maxHighR * 100) / 100, stoppedBefore15: stopped && !hit15R };
}

function runPortfolioTaken(trades: RawTrade[]): { taken: RawTrade[]; skippedQueue: number } {
  const byDate = new Map<string, number[]>();
  trades.forEach((t, idx) => {
    if (!byDate.has(t.entryDate)) byDate.set(t.entryDate, []);
    byDate.get(t.entryDate)!.push(idx);
  });
  for (const ids of byDate.values()) ids.sort((a, b) => trades[b].score - trades[a].score);

  const dates = [...new Set([...trades.map(t => t.entryDate), ...trades.map(t => t.exitDate)])].sort();
  const open = new Set<number>();
  const taken: RawTrade[] = [];
  let skippedQueue = 0;

  for (const d of dates) {
    for (const idx of [...open]) {
      if (trades[idx].exitDate === d) open.delete(idx);
    }
    for (const idx of byDate.get(d) ?? []) {
      if (open.size >= MAX_SLOTS) { skippedQueue++; continue; }
      open.add(idx);
      taken.push(trades[idx]);
    }
  }
  return { taken, skippedQueue };
}

function slotUtilization(taken: RawTrade[], tradingDays: string[]): {
  avgOpen: number; avgEmpty: number; pctDaysZero: number; pctDaysFull: number; maxOpen: number;
} {
  const openRanges = taken.map(t => ({ start: t.entryDate, end: t.exitDate }));
  let sumOpen = 0;
  let daysZero = 0;
  let daysFull = 0;
  let maxOpen = 0;
  for (const day of tradingDays) {
    let n = 0;
    for (const r of openRanges) {
      if (r.start <= day && r.end >= day) n++;
    }
    sumOpen += n;
    if (n === 0) daysZero++;
    if (n >= MAX_SLOTS) daysFull++;
    maxOpen = Math.max(maxOpen, n);
  }
  const d = tradingDays.length || 1;
  return {
    avgOpen: sumOpen / d,
    avgEmpty: MAX_SLOTS - sumOpen / d,
    pctDaysZero: (100 * daysZero) / d,
    pctDaysFull: (100 * daysFull) / d,
    maxOpen,
  };
}

async function main() {
  const cat = await loadProductionCatalogueWithStats();
  const barsMap = new Map<string, Bar[]>();
  const all: RawTrade[] = [];

  for (const { ticker } of cat.assets) {
    try {
      let bars = await fetchBarsForTicker(ticker, BARS_DAYS);
      bars = [...bars].sort((a, b) => a.date.localeCompare(b.date));
      barsMap.set(ticker, bars);
      simulateTicker(ticker, bars, all);
    } catch { /* skip */ }
  }

  const win2025 = all.filter(t => t.entryDate >= "2025-01-01" && t.entryDate <= "2025-12-31");
  const { taken, skippedQueue } = runPortfolioTaken(win2025);
  const takenAll = runPortfolioTaken(all.filter(t => t.entryDate >= "2025-01-01")).taken;

  const spyBars = [...(await fetchBarsForTicker("SPY", BARS_DAYS))].sort((a, b) => a.date.localeCompare(b.date));
  const days2025 = spyBars.filter(b => b.date >= "2025-01-01" && b.date <= "2025-12-31").map(b => b.date);

  const fastTaken = taken.filter(t => t.exitReason === "FAST_TIME");
  const fastAll = takenAll.filter(t => t.exitReason === "FAST_TIME");

  let wouldHit15 = 0;
  let wouldHit1 = 0;
  let stoppedFirst = 0;
  for (const t of fastTaken) {
    const bars = barsMap.get(t.ticker);
    if (!bars) continue;
    const cf = counterfactualAfterFastKill(t, bars);
    if (cf.hit15R) wouldHit15++;
    else if (cf.hit1R) wouldHit1++;
    if (cf.stoppedBefore15) stoppedFirst++;
  }

  const slots = slotUtilization(taken, days2025);

  console.log("=== ELZA v4 POST-MORTEM (2025 CAL, 148 USA) ===\n");

  console.log("Q1 — FAST_KILL victims (portfolio taken trades)");
  console.log(`  FAST_TIME exits 2025:     ${fastTaken.length} (all windows taken: ${fastAll.length})`);
  console.log(`  Would hit +1.5R within ${CF_HORIZON_BARS}d if NOT cut: ${wouldHit15} (${fastTaken.length ? (100 * wouldHit15 / fastTaken.length).toFixed(1) : 0}%)`);
  console.log(`  Would hit +1.0R but NOT 1.5R:              ${wouldHit1 - wouldHit15} (approx)`);
  console.log(`  Hit SL before 1.5R (cut was right):        ${fastTaken.length - wouldHit15 - Math.max(0, wouldHit1 - wouldHit15)}`);
  console.log(`  Stopped out first in CF window:            ${stoppedFirst}`);
  console.log(`  mfeCloseR at cut (avg):                    ${fastTaken.length ? (fastTaken.reduce((s, t) => s + t.mfeCloseRAtCut, 0) / fastTaken.length).toFixed(2) : 0}R`);

  console.log("\nQ2 — OPPORTUNITY COST / CASH DRAG (2025)");
  console.log(`  Raw v4 signals in 2025 window:  ${win2025.length}`);
  console.log(`  Trades TAKEN (12-slot book):    ${taken.length}`);
  console.log(`  Score-queue rejects:            ${skippedQueue}`);
  console.log(`  Signal→fill rate:               ${win2025.length ? (100 * taken.length / win2025.length).toFixed(1) : 0}%`);
  console.log(`  Trading days (SPY 2025):        ${days2025.length}`);
  console.log(`  Avg open slots / day:           ${slots.avgOpen.toFixed(2)} / ${MAX_SLOTS}`);
  console.log(`  Avg EMPTY slots / day:          ${slots.avgEmpty.toFixed(2)} / ${MAX_SLOTS}`);
  console.log(`  Days with 0 positions:        ${slots.pctDaysZero.toFixed(1)}%`);
  console.log(`  Days book full (12/12):         ${slots.pctDaysFull.toFixed(1)}%`);
  console.log(`  Max concurrent seen:            ${slots.maxOpen}`);
  console.log(`  Implied cash drag:              ~${(100 * slots.avgEmpty / MAX_SLOTS).toFixed(0)}% of slot-capacity idle`);

  console.log("\n=== END AUTOPSY ===");
}

main().catch(e => { console.error(e); process.exit(1); });
