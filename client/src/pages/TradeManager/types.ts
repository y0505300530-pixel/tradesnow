/**
 * TradeManager — Type Definitions
 *
 * All TypeScript interfaces and types used within the Trade Manager feature.
 * These are client-only types (not shared with the backend).
 *
 * Extracted from TradeManager.tsx as part of the modular refactoring (Step 1).
 */

// ─── Portfolio Holding ────────────────────────────────────────────────────────

export interface Holding {
  id: number;
  ticker: string;
  company: string | null;
  buyPrice: number;
  units: number;
  currentPrice: number | null;
  dailyChangePercent: number | null;
  zivScore: number | null;
  buyScore: number | null;  // Ziv score at time of purchase
  entryTier: string | null;  // Ziv Engine tier at entry (ליבה/צמיחה/מעקב/נמוך)
  stopLoss: number | null;  // Stop loss price from Deep Analysis
  takeProfit?: number | null;  // Take profit target
  notes: string | null;
  priceUpdatedAt: Date | string | null;
  createdAt: Date;
  transactionDate?: string | null;  // Date when the asset was actually purchased (YYYY-MM-DD)
  // IBKR order tracking
  ibkrSlOrderId?: string | null;
  ibkrSlOrderQty?: number | null;
  ibkrTpOrderId?: string | null;
  ibkrTpOrderQty?: number | null;
  // Computed from analyzeHoldings
  recPositionSizePct?: number | null;
  recSuggestedUnits?: number | null;
  // IBKR contract ID — populated from positions data when IBKR is connected
  conid?: number | null;
}

// ─── AI Analysis Results ──────────────────────────────────────────────────────

export interface HoldingRec {
  ticker: string;
  action: string;
  reasoning: string;
  stopLoss: string;
  targetPrice: string;
  urgency: string;
}

export interface BuyOpp {
  ticker: string;
  entryZone: string;
  stopLoss: string;
  targetPrice: string;
  positionSizePct: number;
  reasoning: string;
  zivScore: number;
}

export interface SwapRec {
  exitTicker: string;
  enterTicker: string;
  reasoning: string;
}

export interface AnalysisResult {
  portfolioHealthScore: number;
  portfolioHealthSummary: string;
  holdingRecommendations: HoldingRec[];
  buyOpportunities: BuyOpp[];
  swapRecommendations: SwapRec[];
  cashDeploymentPlan: string;
  keyRisks: string;
  totalPortfolioValue: number;
  cashBalance: number;
}

// ─── ZIV H Health Score ───────────────────────────────────────────────────────

export type ZivHData =
  | {
      id: number;
      ticker: string;
      score: number;
      tier: string;
      suggestedAction: string;
      details: string;
      indicators: Record<string, boolean>;
      bonuses: Record<string, boolean>;
      penalties: Record<string, boolean>;
      positionPct?: number;
      daysHeld?: number;
      slMode?: string | null;  // "Trailing" | "Static" | "Winners"
      tpMode?: string | null;  // "Escape" | "Extension" | "Static"
    }
  | undefined;
