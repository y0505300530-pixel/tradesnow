/**
 * Shared types for Deep Analysis modal and extracted sub-components.
 */
export type ZivTier = "Gold Breakout" | "Gold Retest" | "Near Entry Watch" | "No Signal" | "No Data" | "Error";

export interface DeepAnalysisResult {
  ticker: string;
  company: string;
  sector?: string | null;
  companyDescription?: string | null;
  score: number;
  tier: ZivTier;
  price: number;
  changePercent: number;
  ema50: number;
  ema200: number;
  donchian20High: number;
  weeklyEma50Slope: number;
  distToEma50Pct: number;
  rsi: number;
  volumeRatio: number;
  atr14: number;
  priceAction: string | null;
  zivReason: string;
  conditions: Array<{ name: string; pass: boolean; value: string }>;
  passCount: number;
  entryReady: boolean;
  recommendedBuyPrice: number;
  buyPriceRationale: string;
  stopLoss: number;
  stopLossPct: number;
  atrStopLoss: number;
  emaStopLoss: number;
  ai: {
    recommendation: string;
    positionRationale: string;
    risks: string;
    actionTrigger: string;
    summary: string;
  };
  positionSizeUsd: number | null;
  positionSizePct: number | null;
  suggestedShares: number | null;
  positionSizeRationale: string;
  tierLabel: string;
  tierCapFraction?: number | null;
  slotsOpenLong?: number;
  slotsOpenShort?: number;
  slotsRemainingLong?: number;
  slotsRemainingShort?: number;
  scaleOutR?: number;
  exitApproachHe?: string;
  regime?: string;
  cycleNarrativeHe?: string;
  slMode?: string;
  tpMode?: string;
  totalPortfolioValue: number | null;
  analyzedAt: string;
  currencySymbol?: string;
  currency?: string;
  fromCache?: boolean;
}

export interface HoldingContext {
  id?: number;
  buyPrice: number;
  units: number;
  currentPrice: number;
  pnlUsd: number;
  pnlPct: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  diaryReason?: string | null;
  diaryExpectation?: string | null;
  whyBought?: string | null;
  expectations?: string | null;
}

export interface PrefetchedZivH {
  score: number;
  tier: string;
  phase: string;
  suggestedAction: string;
  indicators: Record<string, boolean | number>;
  bonuses?: Record<string, boolean>;
  penalties?: Record<string, boolean>;
  details?: string;
  daysHeld?: number;
}
