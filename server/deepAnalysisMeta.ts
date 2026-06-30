/**
 * deepAnalysisMeta.ts — ELZA 2.0 shared Deep Analysis meta + prompts.
 * Single source for deepAnalysisStream.ts and portfolio.analyzeAsset.
 */
import type { Bar } from "./marketData";
import { calcZivEngineScore, type ZivEngineResult } from "./zivEngine";
import { classifyCyclePhaseFromBars } from "./cyclePhaseEngine";
import { getMarketRegime } from "./runtimeIntelligence";
import { calcEntrySlTp, SCALE_OUT_TP1_R } from "./slCalculator";
import { getLiveConfig, computeLiveCapital } from "./liveOrderExecutor";
import { getDb } from "./db";
import { livePositions } from "../drizzle/schema";
import { eq, and, inArray } from "drizzle-orm";
import { positionValue } from "./services/PortfolioValueService";

export const ELZA_MAX_LONG = 12;
export const ELZA_MAX_SHORT = 6;

export interface DeepAnalysisHoldingContext {
  buyPrice: number;
  units: number;
  currentPrice: number;
  pnlUsd: number;
  pnlPct: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  diaryReason?: string | null;
  diaryExpectation?: string | null;
}

export interface DeepAnalysisCondition {
  name: string;
  pass: boolean;
  value: string;
}

export interface DeepAnalysisMeta {
  score: number;
  tier: string;
  zivReason: string;
  conditions: DeepAnalysisCondition[];
  passCount: number;
  entryReady: boolean;
  recommendedBuyPrice: number;
  buyPriceRationale: string;
  stopLoss: number;
  stopLossPct: number;
  atrStopLoss: number;
  emaStopLoss: number;
  rsi: number;
  volumeRatio: number;
  atr14: number;
  regime: string;
  longOk: boolean;
  shortOk: boolean;
  cycleBlock: string | null;
  cycleNarrativeHe: string;
  cycleBlocked: boolean;
  hasStructure: boolean;
  weeklyBullish: boolean;
  weeklyBearish: boolean;
  positionSizeUsd: number | null;
  positionSizePct: number | null;
  suggestedShares: number | null;
  positionSizeRationale: string;
  tierLabel: string;
  tierCapFraction: number | null;
  slotsOpenLong: number;
  slotsOpenShort: number;
  slotsRemainingLong: number;
  slotsRemainingShort: number;
  scaleOutR: number;
  exitApproachHe: string;
}

export function computeRsi14(closes: number[]): number {
  const rsiPeriod = 14;
  if (closes.length < rsiPeriod + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - rsiPeriod; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const rs = gains / (losses || 0.0001);
  return 100 - 100 / (1 + rs);
}

export function computeVolumeRatio(bars: Bar[]): number {
  const volumes = bars.map(b => b.volume ?? 0);
  const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const avgVol5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  return avgVol20 > 0 ? avgVol5 / avgVol20 : 1;
}

export function computeAtr14(bars: Bar[]): number {
  const last14 = bars.slice(-14);
  if (last14.length === 0) return 0;
  return last14.reduce((sum, bar, i) => {
    const prevClose = i > 0 ? last14[i - 1].close : bar.close;
    const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
    return sum + tr;
  }, 0) / last14.length;
}

function hasStructuralSetup(ziv: ZivEngineResult): boolean {
  if (ziv.tier === "Gold Breakout" || ziv.tier === "Gold Retest") return true;
  const r = ziv.reason.toLowerCase();
  return r.includes("retest") || r.includes("reversal") || r.includes("role reversal");
}

function signalSizeMult(tier: string): number {
  if (tier === "Gold Breakout") return 0.70;
  return 1.0;
}

async function countOpenSlots(userId: number): Promise<{ long: number; short: number }> {
  try {
    const db = await getDb();
    if (!db) return { long: 0, short: 0 };
    const { countsAsSlot } = await import("./slotCounter");
    const open = await db.select({
      direction: livePositions.direction,
      slotGhost: livePositions.slotGhost,
      countsTowardSlot: livePositions.countsTowardSlot,
      status: livePositions.status,
    }).from(livePositions)
      .where(and(eq(livePositions.userId, userId), inArray(livePositions.status, ["open", "pending_entry"])));
    const slotOpen = open.filter(p => countsAsSlot(p));
    return {
      long: slotOpen.filter(p => p.direction === "long").length,
      short: slotOpen.filter(p => p.direction === "short").length,
    };
  } catch {
    return { long: 0, short: 0 };
  }
}

export async function buildDeepAnalysisMeta(params: {
  userId: number;
  bars: Bar[];
  livePrice: number;
  ziv: ZivEngineResult;
  currencySymbol?: string;
}): Promise<DeepAnalysisMeta> {
  const { userId, bars, livePrice, ziv, currencySymbol = "$" } = params;
  const cs = currencySymbol;
  const closes = bars.map(b => b.close);
  const rsi = computeRsi14(closes);
  const volumeRatio = computeVolumeRatio(bars);
  const atr14 = computeAtr14(bars);

  const cyc = classifyCyclePhaseFromBars(bars);
  const regime = await getMarketRegime();

  const weeklyBullish = ziv.weeklyEma50Slope > 0.2 && livePrice > ziv.ema50;
  const weeklyBearish = ziv.weeklyEma50Slope < -0.2 && livePrice < ziv.ema50;
  const structure = hasStructuralSetup(ziv);
  const cycleBlocked = !!(cyc && (cyc.longGate === "BLOCK" || cyc.shortGate === "BLOCK"));
  const cycleBlock = cyc?.code ?? null;
  const cycleNarrativeHe = cyc?.reason && cyc.reason !== "cycle ok" ? cyc.reason : "מחזור תקין";

  const entrySlTp = calcEntrySlTp({
    entryPrice: livePrice,
    ema50: ziv.ema50,
    bars,
    weeklyEma50Slope: ziv.weeklyEma50Slope,
    direction: "long",
  });
  const atrStopLoss = parseFloat((livePrice - atr14 * 1.5).toFixed(2));
  const emaStopLoss = parseFloat((ziv.ema50 * 0.97).toFixed(2));
  const stopLoss = entrySlTp.stopLoss;
  const stopLossPct = livePrice > 0 ? ((stopLoss - livePrice) / livePrice * 100) : 0;

  let recommendedBuyPrice: number;
  let buyPriceRationale: string;
  if (ziv.tier === "Gold Breakout") {
    recommendedBuyPrice = parseFloat(livePrice.toFixed(2));
    buyPriceRationale = `פריצה עם נפח — כניסה רק אם CYC מאשר ואין חסימת מחזור (${cs}${livePrice.toFixed(2)}).`;
  } else if (ziv.tier === "Gold Retest" && structure) {
    recommendedBuyPrice = parseFloat(livePrice.toFixed(2));
    buyPriceRationale = `ריטסט מבני (לא EMA בלבד): ${ziv.reason}`;
  } else {
    recommendedBuyPrice = parseFloat(livePrice.toFixed(2));
    buyPriceRationale = `אין setup מבני — המתן לריטסט / Role Reversal / zone. לא כניסה על קרבה ל-EMA.`;
  }

  const macroOk = regime.longOk;
  const cycLongOk = !cyc || cyc.longGate !== "BLOCK";
  const zivOk = ziv.score >= 8.0;

  const conditions: DeepAnalysisCondition[] = [
    { name: "מאקרו (לונג)", pass: macroOk, value: `${regime.regime} — ${regime.regimeReason}` },
    { name: "מגמה שבועית WK-L", pass: weeklyBullish, value: `שיפוע ${ziv.weeklyEma50Slope.toFixed(2)}%` },
    { name: "מחזור Volume (CYC)", pass: cycLongOk, value: cycleNarrativeHe },
    { name: "מבנה (ריטסט/RR/zone)", pass: structure, value: ziv.reason.slice(0, 120) },
    { name: "ZIV ≥ 8.0", pass: zivOk, value: `${ziv.score.toFixed(2)}/10` },
  ];
  const passCount = conditions.filter(c => c.pass).length;
  const entryReady = macroOk && weeklyBullish && cycLongOk && structure && zivOk;

  const openSlots = await countOpenSlots(userId);
  const slotsRemainingLong = Math.max(0, ELZA_MAX_LONG - openSlots.long);
  const slotsRemainingShort = Math.max(0, ELZA_MAX_SHORT - openSlots.short);

  let positionSizeUsd: number | null = null;
  let suggestedShares: number | null = null;
  let positionSizeRationale: string;
  const sizeMult = signalSizeMult(ziv.tier);

  try {
    const config = await getLiveConfig(userId);
    if (config) {
      const { allocatedCapital } = computeLiveCapital(config);
      const longPool = allocatedCapital * (ELZA_MAX_LONG / (ELZA_MAX_LONG + ELZA_MAX_SHORT));
      const poolPerSlot = slotsRemainingLong > 0 ? longPool / ELZA_MAX_LONG : 0;
      positionSizeUsd = parseFloat((poolPerSlot * sizeMult).toFixed(0));
      if (livePrice > 0 && positionSizeUsd > 0) {
        suggestedShares = Math.floor(positionSizeUsd / livePrice);
      }
      positionSizeRationale =
        `סלוט ELZA: עד ${ELZA_MAX_LONG} לונג / ${ELZA_MAX_SHORT} שורט. ` +
        `פתוחות: ${openSlots.long} לונג, ${openSlots.short} שורט. ` +
        `סלוטים פנויים ללונג: ${slotsRemainingLong}. ` +
        `הערכת גודל לעסקה זו (×${sizeMult}): ~${cs}${positionSizeUsd?.toLocaleString() ?? "—"} — Elza מחליטה אוטומטית, לא 1% סיכון.`;
    } else {
      positionSizeRationale = `סלוט ELZA: ${ELZA_MAX_LONG} לונג / ${ELZA_MAX_SHORT} שורט — Elza מחליטה גודל אוטומטית.`;
    }
  } catch {
    positionSizeRationale = `סלוט ELZA: ${ELZA_MAX_LONG} לונג / ${ELZA_MAX_SHORT} שורט — Elza מחליטה גודל אוטומטית.`;
  }

  const exitApproachHe =
    `יציאה Approach B: מימוש 50% ב-+${SCALE_OUT_TP1_R}R, יתרה עם trail מבני (Chandelier). אין יציאה על EMA.`;

  return {
    score: ziv.score,
    tier: ziv.tier,
    zivReason: ziv.reason,
    conditions,
    passCount,
    entryReady,
    recommendedBuyPrice,
    buyPriceRationale,
    stopLoss,
    stopLossPct,
    atrStopLoss,
    emaStopLoss,
    rsi,
    volumeRatio,
    atr14,
    regime: regime.regime,
    longOk: regime.longOk,
    shortOk: regime.shortOk,
    cycleBlock,
    cycleNarrativeHe,
    cycleBlocked,
    hasStructure: structure,
    weeklyBullish,
    weeklyBearish,
    positionSizeUsd,
    positionSizePct: null,
    suggestedShares,
    positionSizeRationale,
    tierLabel: `סלוט Elza ${ELZA_MAX_LONG}/${ELZA_MAX_SHORT}`,
    tierCapFraction: null,
    slotsOpenLong: openSlots.long,
    slotsOpenShort: openSlots.short,
    slotsRemainingLong,
    slotsRemainingShort,
    scaleOutR: SCALE_OUT_TP1_R,
    exitApproachHe,
  };
}

export const DEEP_ANALYSIS_SYSTEM_PROMPT = `אתה אנליסט ELZA 2.0 (מתודולוגיית זיו + אוטומציה).
חוקים:
1. עברית בלבד
2. אסור להזכיר 1% סיכון, tier cap ב-%, Winner's Leash, או כניסה על EMA בלבד
3. גודל פוזיציה = סלוט 12 לונג / 6 שורט — Elza מחליטה, לא המשתמש
4. יציאה = 50% ב-+2R + trail מבני — לא TP קבוע קרוב, לא יציאת EMA
5. אם cycleBlock פעיל — אסור ENTER; המלצה WAIT או REJECT
6. מחזיק בנייר → ניהול בלבד (HOLD / REDUCE / EXIT) — לא "קנה", לא גודל כניסה
7. לא מחזיק → כניסה בלבד (ENTER / WAIT / REJECT)
8. תשובה תכליתית — 30 שניות לקריאה, בלי רעש`;

export function buildDeepAnalysisPrompt(params: {
  ticker: string;
  meta: DeepAnalysisMeta;
  livePrice: number;
  ziv: ZivEngineResult;
  holdingContext?: DeepAnalysisHoldingContext | null;
  currencySymbol?: string;
  pennyWarning?: string | null;
  priceDecimals?: number;
}): string {
  const { ticker, meta, livePrice, ziv, holdingContext: hc, currencySymbol = "$", pennyWarning, priceDecimals = 2 } = params;
  const cs = currencySymbol;

  const cycleSection = meta.cycleBlocked
    ? `\nחסימת מחזור פעילה: ${meta.cycleBlock} — ${meta.cycleNarrativeHe}\nהמלצה חייבת להיות WAIT או REJECT. אסור ENTER.\n`
    : `\nמחזור: ${meta.cycleNarrativeHe}\n`;

  const conditionsBlock = meta.conditions
    .map(c => `  ${c.pass ? "PASS" : "FAIL"} ${c.name}: ${c.value}`)
    .join("\n");

  const elzaRules = `
כללי ELZA 2.0 (לפני המלצה):
1. מאקרו: ${meta.regime} — לונג ${meta.longOk ? "מותר" : "חסום"} | שורט ${meta.shortOk ? "מותר" : "חסום"}
2. שבועי: WK-L=${meta.weeklyBullish ? "כן" : "לא"} — דשדוש = אין כניסה
3. מחזור CYC: ${meta.cycleNarrativeHe}
4. מבנה: רק True Retest / Role Reversal / zone / Breakout+נפח — לא EMA proximity
5. ZIV ≥ 8.0 לביצוע
6. ${meta.exitApproachHe}
${cycleSection}`;

  if (hc) {
    const currentHoldingValue = positionValue(hc.currentPrice, hc.units);
    return `אתה אנליסט ELZA 2.0. המשתמש **מחזיק** ב-${ticker} — ניתוח לניהול פוזיציה קיימת בלבד.
אל תדבר על קנייה חדשה, 1% סיכון, או גודל סלוט לכניסה.

פוזיציה נוכחית:
- כניסה: ${cs}${hc.buyPrice.toFixed(2)} × ${hc.units} יחידות
- מחיר: ${cs}${livePrice.toFixed(2)}
- שווי: ${cs}${currentHoldingValue.toFixed(0)}
- P&L: ${hc.pnlUsd >= 0 ? "+" : ""}$${hc.pnlUsd.toFixed(0)} (${hc.pnlPct >= 0 ? "+" : ""}${hc.pnlPct.toFixed(2)}%)
${hc.stopLoss ? `- SL: ${cs}${hc.stopLoss.toFixed(2)}` : "- SL: לא הוגדר"}
${hc.takeProfit ? `- TP משתמש: ${cs}${hc.takeProfit.toFixed(2)}` : "- אין TP קבוע — יציאה לפי 2R + trail מבני"}
${hc.diaryReason ? `- סיבת כניסה: ${hc.diaryReason}` : ""}
${hc.diaryExpectation ? `- ציפייה: ${hc.diaryExpectation}` : ""}

מנוע ZIV:
- ציון: ${ziv.score}/10 (${ziv.tier})
- סיבה: ${ziv.reason}
- RSI: ${meta.rsi.toFixed(1)} | Volume: ${meta.volumeRatio.toFixed(2)}x

תנאים: ${meta.passCount}/${meta.conditions.length}
${conditionsBlock}

SL מנוע (מחייב): ${cs}${meta.stopLoss.toFixed(2)}
${elzaRules}

החזר: recommendation (HOLD/REDUCE/EXIT), positionRationale, risks, actionTrigger, summary — בעברית.`;
  }

  return `אתה אנליסט ELZA 2.0. המשתמש **לא מחזיק** ב-${ticker} — האם Elza תיכנס?

${pennyWarning ? pennyWarning + "\n\n" : ""}
ZIV: ${ziv.score}/10 (${ziv.tier}) | מחיר ${cs}${livePrice.toFixed(priceDecimals)}
סיבת מנוע: ${ziv.reason}

תנאים: ${meta.passCount}/${meta.conditions.length}
${conditionsBlock}

אזור כניסה (המחשה): ${cs}${meta.recommendedBuyPrice.toFixed(2)} — ${meta.buyPriceRationale}
SL מנוע: ${cs}${meta.stopLoss.toFixed(2)}

סלוט ELZA: ${ELZA_MAX_LONG} לונג / ${ELZA_MAX_SHORT} שורט | פנוי ללונג: ${meta.slotsRemainingLong}
${meta.positionSizeRationale}

${elzaRules}

entryReady=${meta.entryReady ? "כן" : "לא"} — אם לא, המלצה WAIT או REJECT.

החזר: recommendation (ENTER/WAIT/REJECT), positionRationale, risks, actionTrigger, summary — בעברית.`;
}
