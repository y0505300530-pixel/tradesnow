/**
 * Above-the-fold trading UI: price, Ziv, action grid, chart.
 */
import { BarChart2 } from "lucide-react";
import { TradeActionGrid } from "@/components/TradeActionGrid";
import { TradingViewChart, AnalysisLevelsLegend } from "@/components/TradingViewChart";
import { ScoreBadge } from "@/components/deep-analysis/badges";
import type { DeepAnalysisResult, HoldingContext } from "@/components/deep-analysis/types";

export interface TradingCommandBarProps {
  ticker: string;
  result: DeepAnalysisResult;
  currencySymbol: string;
  livePrice: number;
  liveChangePercent: number;
  warAction?: string;
  warScore?: number;
  ibkrConnected: boolean;
  ibkrConid: number;
  manualPending: boolean;
  blockedBuy: boolean;
  blockedSell: boolean;
  longUnits: number;
  shortUnits: number;
  holdingContext?: HoldingContext;
  onOpenManualOrder: (intent: import("@/lib/manualOrderContract").ManualOrderIntent) => void;
}

export function TradingCommandBar({
  ticker,
  result,
  currencySymbol: cs,
  livePrice,
  liveChangePercent,
  warAction,
  warScore,
  ibkrConnected,
  ibkrConid,
  manualPending,
  blockedBuy,
  blockedSell,
  longUnits,
  shortUnits,
  holdingContext,
  onOpenManualOrder,
}: TradingCommandBarProps) {
  return (
    <>
      <div className="bg-gradient-to-r from-slate-50 to-white border border-slate-200 rounded-xl p-3 sm:p-4 shadow-sm space-y-3">
        <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3 justify-between">
          <div className="min-w-0">
            <div className="text-[11px] text-slate-500 font-medium">מחיר</div>
            <div className="font-mono font-bold text-2xl sm:text-3xl text-slate-900 truncate">
              {cs}{livePrice.toFixed(2)}
            </div>
            <div className={`text-[11px] sm:text-sm font-semibold ${liveChangePercent >= 0 ? "text-emerald-600" : "text-red-500"}`}>
              {liveChangePercent >= 0 ? "+" : ""}{liveChangePercent.toFixed(2)}% היום
            </div>
          </div>
          <div className="flex flex-col items-center gap-0.5 shrink-0">
            <div className="text-[11px] text-slate-500">Ziv</div>
            <ScoreBadge score={result.score} />
            {warAction != null && warScore != null && (
              <span className="text-[10px] font-bold text-amber-600">{warAction} {warScore.toFixed(1)}</span>
            )}
          </div>
          <TradeActionGrid
            ibkrConnected={ibkrConnected}
            ibkrConid={ibkrConid}
            manualPending={manualPending}
            blockedBuy={blockedBuy}
            blockedSell={blockedSell}
            longUnits={longUnits}
            shortUnits={shortUnits}
            onOpen={onOpenManualOrder}
          />
          <div className="text-[11px] text-slate-500 w-full sm:w-auto sm:text-right">
            {ibkrConnected
              ? <span className="text-emerald-600 font-semibold">● IBKR מחובר</span>
              : <span className="text-red-500">○ IBKR לא מחובר</span>}
          </div>
        </div>
        {result.ai.recommendation && (
          <p className="text-[11px] sm:text-sm text-slate-600 line-clamp-2 border-t pt-2">{result.ai.recommendation}</p>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-3 sm:p-4 shadow-sm">
        <div className="flex items-center gap-2 mb-2">
          <BarChart2 className="h-5 w-5 text-blue-600 shrink-0" />
          <span className="text-[11px] sm:text-base font-bold text-slate-800 truncate">Chart — {ticker}</span>
        </div>
        <div className="min-h-[240px] sm:min-h-[360px]">
          <TradingViewChart
            ticker={ticker}
            buyPrice={result.recommendedBuyPrice}
            stopLoss={result.stopLoss}
            ema50={result.ema50}
            ema200={result.ema200}
            height={360}
            interval="D"
            theme="light"
          />
        </div>
        <AnalysisLevelsLegend
          ticker={ticker}
          currentPrice={livePrice}
          buyPrice={result.recommendedBuyPrice}
          stopLoss={result.stopLoss}
          ema50={result.ema50}
          ema200={result.ema200}
          takeProfit={holdingContext?.takeProfit ?? undefined}
        />
      </div>
    </>
  );
}
