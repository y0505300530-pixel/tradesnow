import { useState } from "react";
import { toast } from "sonner";
import {
  Loader2, RefreshCw, Zap, ChevronDown, CheckCircle2, XCircle as XCircleIcon,
  Activity, TrendingUp, ShieldAlert, ArrowUpCircle, BookmarkPlus, Check,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toTradingViewSymbol } from "@/components/TradingViewChart";
import { WarEnginePanel } from "../WarEnginePanel";
import type { DeepAnalysisResult, HoldingContext, PrefetchedZivH } from "./types";

export interface AdvancedDetailsProps {
  ticker: string;
  result: DeepAnalysisResult;
  currencySymbol: string;
  livePrice: number;
  holdingContext?: HoldingContext;
  zivHData?: PrefetchedZivH | null;
  zivHLoading: boolean;
}

export function AdvancedDetails({
  ticker,
  result,
  currencySymbol: cs,
  livePrice,
  holdingContext,
  zivHData,
  zivHLoading,
}: AdvancedDetailsProps) {
  const [signalSaved, setSignalSaved] = useState(false);
  const [signalEditOpen, setSignalEditOpen] = useState(false);
  const [signalDraft, setSignalDraft] = useState<{
    ticker: string; company: string; entry: string; stopLoss: string;
    takeProfit: string; catalyst: string; zivScore: number;
  } | null>(null);

  const addSignalMut = trpc.masterKnowledge.addSignal.useMutation({
    onSuccess: (data) => {
      setSignalSaved(true);
      const alertNote = data.priceAlertId ? " + התראת מחיר נוצרה" : "";
      toast.success(
        data.isUpdate
          ? `✅ איתות ${result?.ticker} עודכן ב-איתותים פעילים${alertNote}`
          : `✅ איתות ${result?.ticker} נוסף ל-איתותים פעילים${alertNote}`
      );
      setTimeout(() => setSignalSaved(false), 4000);
    },
    onError: (e) => toast.error(`שגיאה: ${e.message}`),
  });

  function handleAddSignal() {
    const buyPriceNum = result.recommendedBuyPrice;
    const tp = buyPriceNum > 0 ? (buyPriceNum * 1.15).toFixed(2) : "";
    setSignalDraft({
      ticker: result.ticker,
      company: result.company,
      entry: buyPriceNum.toFixed(2),
      stopLoss: result.stopLoss.toFixed(2),
      takeProfit: tp,
      catalyst: result.ai.summary?.slice(0, 300) ?? `Ziv Score ${result.score}/10`,
      zivScore: result.score,
    });
    setSignalEditOpen(true);
  }

  function confirmAddSignal() {
    if (!signalDraft) return;
    const payload = JSON.stringify({ ticker: signalDraft.ticker, action: "BUY", price: signalDraft.entry });
    const ta = document.createElement("textarea"); ta.value = payload;
    document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);

    window.open(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(toTradingViewSymbol(signalDraft.ticker))}`, "_blank", "noopener,noreferrer");

    addSignalMut.mutate({
      ticker: signalDraft.ticker,
      company: signalDraft.company,
      entry: `$${signalDraft.entry}`,
      stopLoss: `$${signalDraft.stopLoss}`,
      takeProfit: signalDraft.takeProfit ? `$${signalDraft.takeProfit}` : "",
      catalyst: signalDraft.catalyst,
      source: `Deep Analysis — Ziv Score ${signalDraft.zivScore}/10`,
      signalDate: new Date().toISOString().split("T")[0],
      zivScore: signalDraft.zivScore,
    });
    setSignalEditOpen(false);
  }

  return (
    <>
            <details className="rounded-xl border border-slate-200 bg-white shadow-sm group">
              <summary className="flex items-center gap-2 cursor-pointer list-none px-4 py-3 text-[11px] sm:text-sm font-bold text-slate-700">
                <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
                פרטים מתקדמים (מדדים, ZIV H, War Engine)
              </summary>
              <div className="px-3 pb-3 space-y-4 border-t">
            {holdingContext && (
              <div className="bg-white border border-blue-100 rounded-xl p-5 shadow-sm">
                <div className="flex items-center gap-2 mb-4">
                  <TrendingUp className="h-5 w-5 text-blue-600" />
                  <span className="text-base font-bold text-slate-800">My Position</span>
                </div>
                <div className="grid grid-cols-3 md:grid-cols-6 gap-4">
                  <div className="text-center">
                    <div className="text-xs text-slate-500 mb-1">Units</div>
                    <div className="font-mono font-bold text-xl text-slate-800">{holdingContext.units.toLocaleString()}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-xs text-slate-500 mb-1">Buy Price</div>
                    <div className="font-mono font-bold text-xl text-blue-600">{cs}{holdingContext.buyPrice.toFixed(2)}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-xs text-slate-500 mb-1">Value</div>
                    <div className="font-mono font-bold text-xl text-slate-800">{cs}{(holdingContext.units * holdingContext.currentPrice).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-xs text-slate-500 mb-1">P&L</div>
                    <div className={`font-mono font-bold text-xl ${holdingContext.pnlPct >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                      {holdingContext.pnlPct >= 0 ? '+' : ''}{holdingContext.pnlPct.toFixed(2)}%
                    </div>
                    <div className={`font-mono text-xs ${holdingContext.pnlUsd >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>
                      {holdingContext.pnlUsd >= 0 ? '+' : ''}{cs}{Math.abs(holdingContext.pnlUsd).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-xs text-slate-500 mb-1">Stop Loss</div>
                    {holdingContext.stopLoss && holdingContext.stopLoss > 0
                      ? <>
                          <div className="font-mono font-bold text-xl text-red-500">{cs}{holdingContext.stopLoss.toFixed(2)}</div>
                          {(result as any)?.slMode && (result as any).slMode !== 'Static' && (
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full mt-1 inline-block ${
                              (result as any).slMode === 'Trailing' ? 'bg-orange-100 text-orange-700' : 'bg-emerald-100 text-emerald-700'
                            }`}>{(result as any).slMode === 'Trailing' ? '⚡ Trailing' : '📐 Structural'}</span>
                          )}
                        </>
                      : <div className="font-mono text-slate-400 text-lg">—</div>
                    }
                  </div>
                  <div className="text-center">
                    <div className="text-xs text-slate-500 mb-1">Take Profit</div>
                    {holdingContext.takeProfit && holdingContext.takeProfit > 0
                      ? <>
                          <div className="font-mono font-bold text-xl text-emerald-600">{cs}{holdingContext.takeProfit.toFixed(2)}</div>
                          {(result as any)?.tpMode && (result as any).tpMode !== 'Static' && (
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full mt-1 inline-block ${
                              (result as any).tpMode === 'Escape' ? 'bg-red-100 text-red-700' : 'bg-purple-100 text-purple-700'
                            }`}>{(result as any).tpMode === 'Escape' ? '🚨 Escape' : '🚀 Extension'}</span>
                          )}
                        </>
                      : <div className="font-mono text-slate-400 text-lg">—</div>
                    }
                  </div>
                </div>
                {(holdingContext.whyBought || holdingContext.diaryReason) && (
                  <div className="flex items-start gap-2 mt-4 pt-4 border-t border-slate-200">
                    <span className="text-slate-500 text-sm shrink-0 font-medium">למה קנינו:</span>
                    <span className="text-slate-700 text-sm">{holdingContext.whyBought ?? holdingContext.diaryReason}</span>
                  </div>
                )}
                {(holdingContext.expectations || holdingContext.diaryExpectation) && (
                  <div className="flex items-start gap-2 mt-1.5">
                    <span className="text-slate-500 text-sm shrink-0 font-medium">צפייה:</span>
                    <span className="text-slate-700 text-sm">{holdingContext.expectations ?? holdingContext.diaryExpectation}</span>
                  </div>
                )}
              </div>
            )}
            {/* ZIV H Health Section — shown when user holds this stock */}
            {holdingContext && zivHData && (
              <div className={`p-4 rounded-lg border-2 ${
                zivHData.score >= 8 ? 'bg-emerald-50 border-emerald-300'
                : zivHData.score >= 6 ? 'bg-blue-50 border-blue-300'
                : zivHData.score >= 4 ? 'bg-amber-50 border-amber-300'
                : 'bg-red-50 border-red-300'
              }`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold uppercase tracking-wide">ZIV H Health Score</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-bold border ${
                      zivHData.score >= 8 ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                      : zivHData.score >= 6 ? 'bg-blue-100 text-blue-700 border-blue-300'
                      : zivHData.score >= 4 ? 'bg-amber-100 text-amber-800 border-amber-300'
                      : 'bg-red-100 text-red-700 border-red-300'
                    }`}>
                      {zivHData.score >= 8 ? '🔥' : zivHData.score >= 6 ? '⭐' : zivHData.score >= 4 ? '⚠️' : '❌'} {zivHData.score.toFixed(1)} — {zivHData.tier}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">{zivHData.daysHeld}d held</span>
                </div>
                <p className={`text-sm font-semibold mb-3 ${
                  zivHData.score >= 8 ? 'text-[#65A30D]'
                  : zivHData.score >= 6 ? 'text-blue-700'
                  : zivHData.score >= 4 ? 'text-amber-400'
                  : 'text-red-700'
                }`}>💡 {zivHData.suggestedAction}</p>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  {Object.entries(zivHData.indicators).map(([key, pass]) => (
                    <div key={key} className={`flex items-center gap-1 text-xs px-2 py-1 rounded border ${
                      pass ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-red-50 border-red-300 text-red-600'
                    }`}>
                      {pass ? <CheckCircle2 className="h-3 w-3 shrink-0" /> : <XCircleIcon className="h-3 w-3 shrink-0" />}
                      <span className="truncate">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
                    </div>
                  ))}
                </div>
                {/* v2 Bonuses row */}
                {zivHData.bonuses && Object.values(zivHData.bonuses).some(Boolean) && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {zivHData.bonuses.scoreImproved && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-300 font-semibold">📈 ZIV שיפור מהכניסה</span>
                    )}
                    {zivHData.bonuses.recentBreakout && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-300 font-semibold">🔥 פריצה אחרונה מחזיקה</span>
                    )}
                    {zivHData.bonuses.nearPeak && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-300 font-semibold">🏔️ קרוב לשיא</span>
                    )}
                    {zivHData.bonuses.goodEntryTier && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-300 font-semibold">⭐ כניסה טובה</span>
                    )}
                    {zivHData.bonuses.riskFreeTrail && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-300 font-semibold">🛡️ SL מעל כניסה</span>
                    )}
                    {zivHData.bonuses.targetProximity && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-300 font-semibold">🎯 קרוב ל-TP</span>
                    )}
                  </div>
                )}
                {/* v2 Penalties row */}
                {zivHData.penalties && Object.values(zivHData.penalties).some(Boolean) && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {zivHData.penalties.scoreDegraded && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-300 font-semibold">📉 ZIV ירד מהכניסה</span>
                    )}
                    {zivHData.penalties.farFromPeak && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-300 font-semibold">⛰️ רחוק מהשיא</span>
                    )}
                    {zivHData.penalties.deadCapital && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300 font-semibold">💤 הון מת</span>
                    )}
                    {zivHData.penalties.reallocationSignal && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300 font-semibold">🔄 הזדמנות טובה יותר</span>
                    )}
                    {zivHData.penalties.underperformance && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300 font-semibold">📊 ביצועים נמוכים מ-SPY</span>
                    )}
                  </div>
                )}
                {zivHData.details && (
                  <p className="text-xs text-muted-foreground">{zivHData.details}</p>
                )}
              </div>
            )}
            {holdingContext && zivHLoading && (
              <div className="p-3 bg-muted/30 border border-border rounded-lg flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Calculating ZIV H Health Score...</span>
              </div>
            )}
            {/* ═══════════ SECTION 3: TECHNICAL ANALYSIS ═══════════ */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
              {/* Technical Indicators — clean table layout */}
              <div className="mb-5">
                <div className="flex items-center gap-2 mb-3">
                  <Activity className="h-5 w-5 text-blue-600" />
                  <span className="text-base font-bold text-slate-800">Technical Indicators</span>
                </div>
                <div className="overflow-hidden rounded-lg border border-slate-200">
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-slate-100">
                      {[
                        { label: "EMA-50", value: `${cs}${result.ema50.toFixed(2)}`, detail: `${result.distToEma50Pct >= 0 ? "+" : ""}${result.distToEma50Pct.toFixed(1)}% from price`, good: Math.abs(result.distToEma50Pct) < 3 },
                        { label: "EMA-200", value: `${cs}${result.ema200.toFixed(2)}`, detail: livePrice > result.ema200 ? "Price above" : "Price below", good: livePrice > result.ema200 },
                        { label: "RSI-14", value: result.rsi.toFixed(1), detail: result.rsi < 30 ? "Oversold" : result.rsi > 70 ? "Overbought" : "Neutral", good: result.rsi >= 40 && result.rsi <= 70 },
                        { label: "Volume Ratio", value: `${result.volumeRatio.toFixed(2)}x`, detail: result.volumeRatio >= 1.5 ? "High volume" : "Normal", good: result.volumeRatio >= 1.0 },
                        { label: "ATR-14", value: `${cs}${result.atr14.toFixed(2)}`, detail: "Daily range", good: true },
                        { label: "Donchian-20", value: `${cs}${result.donchian20High.toFixed(2)}`, detail: "20-day high", good: livePrice >= result.donchian20High * 0.95 },
                        { label: "Weekly Slope", value: result.weeklyEma50Slope.toFixed(3), detail: result.weeklyEma50Slope > 0 ? "Rising" : "Falling", good: result.weeklyEma50Slope > 0 },
                        { label: "Price Action", value: result.priceAction ?? "None", detail: result.priceAction ? "Detected" : "No signal", good: !!result.priceAction },
                      ].map((item, i) => (
                        <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-slate-50/50"}>
                          <td className="px-4 py-2.5 font-medium text-slate-600 w-36">{item.label}</td>
                          <td className="px-4 py-2.5 font-mono font-bold text-slate-900">{item.value}</td>
                          <td className="px-4 py-2.5 text-slate-500">{item.detail}</td>
                          <td className="px-4 py-2.5 text-right">
                            {item.good ? <CheckCircle2 className="h-4 w-4 text-emerald-500 inline" /> : <XCircleIcon className="h-4 w-4 text-red-400 inline" />}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Entry Conditions */}
              <div className="mb-5">
                <div className="flex items-center gap-2 mb-3">
                  <Activity className="h-5 w-5 text-slate-700" />
                  <span className="text-base font-bold text-slate-800">Entry Conditions</span>
                  <span className={`text-sm font-bold ml-2 px-2 py-0.5 rounded-full ${
                    result.passCount >= 5 ? "bg-emerald-100 text-emerald-700" : result.passCount >= 3 ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-600"
                  }`}>
                    {result.passCount}/{result.conditions.length}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {result.conditions.map((c, i) => (
                    <div key={i} className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${
                      c.pass ? "bg-emerald-50/50 border-emerald-200" : "bg-red-50/50 border-red-200"
                    }`}>
                      {c.pass ? <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" /> : <XCircleIcon className="h-4 w-4 text-red-500 shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-medium ${c.pass ? "text-emerald-800" : "text-red-700"}`}>{c.name}</div>
                        <div className="text-xs text-slate-500 font-mono truncate">{c.value}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Ziv Engine Verdict */}
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <Zap className="h-5 w-5 text-blue-600" />
                  <span className="text-base font-bold text-slate-800">Ziv Engine Verdict</span>
                </div>
                <p className="text-sm text-slate-700 leading-relaxed">{result.zivReason}</p>
              </div>
            </div>

            {/* ═══════════ SECTION 4: ENTRY / SL (when NOT holding) ═══════════ */}
            {holdingContext ? null : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Entry Rec */}
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-5 shadow-sm">
                  <div className="flex items-center gap-2 mb-3">
                    <ArrowUpCircle className="h-5 w-5 text-emerald-600" />
                    <span className="text-sm font-bold text-emerald-700">Entry Rec / Buy Price</span>
                    <button
                      onClick={handleAddSignal}
                      disabled={addSignalMut.isPending || signalSaved}
                      title="הוסף איתות קניה ל-Master Knowledge"
                      className="ml-auto flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-md border border-emerald-300 text-emerald-700 bg-white hover:bg-emerald-100 transition-colors disabled:opacity-50"
                    >
                      {signalSaved ? (
                        <><Check className="h-3.5 w-3.5" />נשמר!</>
                      ) : addSignalMut.isPending ? (
                        <><RefreshCw className="h-3.5 w-3.5 animate-spin" />שומר...</>
                      ) : (
                        <><BookmarkPlus className="h-3.5 w-3.5" />הוסף איתות</>
                      )}
                    </button>
                  </div>
                  <div className="font-mono font-bold text-3xl text-emerald-700 mb-2">{cs}{result.recommendedBuyPrice.toFixed(2)}</div>
                  <p className="text-sm text-emerald-700 leading-relaxed">{result.buyPriceRationale}</p>
                </div>
                {/* Stop Loss */}
                <div className="bg-red-50 border border-red-200 rounded-xl p-5 shadow-sm">
                  <div className="flex items-center gap-2 mb-3">
                    <ShieldAlert className="h-5 w-5 text-red-500" />
                    <span className="text-sm font-bold text-red-600">Stop Loss</span>
                    {(result as any).slMode && (result as any).slMode !== 'Static' && (
                      <span className={`ml-auto text-xs font-bold px-2 py-0.5 rounded-full ${
                        (result as any).slMode === 'Trailing' ? 'bg-orange-100 text-orange-700 border border-orange-300'
                        : 'bg-emerald-100 text-emerald-700 border border-emerald-300'
                      }`}>{(result as any).slMode === 'Trailing' ? '⚡ Trailing' : '📐 Structural'}</span>
                    )}
                  </div>
                  <div className="font-mono font-bold text-3xl text-red-600 mb-2">{cs}{result.stopLoss.toFixed(2)}</div>
                  <p className="text-sm text-red-600">
                    {result.stopLossPct.toFixed(1)}% risk from entry
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    ATR-1.5: {cs}{result.atrStopLoss.toFixed(2)} | EMA-3%: {cs}{result.emaStopLoss.toFixed(2)}
                  </p>
                </div>
              </div>
            )}
            {/* סלוט ELZA — רק כשאין פוזיציה */}
            {!holdingContext ? (
              <div className="bg-violet-50 border border-violet-200 rounded-xl p-5 shadow-sm">
                <div className="flex items-center gap-2 mb-3">
                  <TrendingUp className="h-5 w-5 text-violet-600" />
                  <span className="text-base font-bold text-violet-700">סלוט Elza</span>
                  <span className="ml-auto text-sm font-bold text-violet-600 bg-violet-100 px-2.5 py-0.5 rounded-full">{result.tierLabel}</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-3">
                  {result.slotsOpenLong != null && (
                    <div className="text-center">
                      <div className="text-xs text-violet-500 mb-1">לונג פתוח</div>
                      <div className="font-mono font-bold text-xl text-violet-700">{result.slotsOpenLong}/12</div>
                    </div>
                  )}
                  {result.slotsRemainingLong != null && (
                    <div className="text-center">
                      <div className="text-xs text-violet-500 mb-1">סלוטים פנויים</div>
                      <div className="font-mono font-bold text-xl text-blue-600">{result.slotsRemainingLong}</div>
                    </div>
                  )}
                  {result.positionSizeUsd != null && (
                    <div className="text-center">
                      <div className="text-xs text-violet-500 mb-1">הערכת גודל</div>
                      <div className="font-mono font-bold text-xl text-violet-700">{cs}{result.positionSizeUsd.toLocaleString()}</div>
                    </div>
                  )}
                  {result.suggestedShares != null && result.suggestedShares > 0 && (
                    <div className="text-center">
                      <div className="text-xs text-violet-500 mb-1">מניות (הערכה)</div>
                      <div className="font-mono font-bold text-xl text-blue-600">{result.suggestedShares}</div>
                    </div>
                  )}
                </div>
                <p className="text-sm text-violet-700 leading-relaxed">{result.positionSizeRationale}</p>
                {result.exitApproachHe && (
                  <p className="text-xs text-slate-500 mt-2">{result.exitApproachHe}</p>
                )}
              </div>
            ) : null}
            <WarEnginePanel ticker={ticker} holdingContext={holdingContext} />
              </div>
            </details>

      <Dialog open={signalEditOpen} onOpenChange={setSignalEditOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BookmarkPlus className="h-5 w-5 text-[#65A30D]" />
              ערוך איתות לפני שמירה
            </DialogTitle>
          </DialogHeader>
          {signalDraft && (
            <div className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">טיקר</Label>
                  <Input value={signalDraft.ticker} readOnly className="font-mono font-bold text-sm bg-muted" />
                </div>
                <div>
                  <Label className="text-xs">ציון ZIV</Label>
                  <Input
                    type="number" step="0.1" min="0" max="10"
                    value={signalDraft.zivScore}
                    onChange={(e) => setSignalDraft(d => d ? { ...d, zivScore: parseFloat(e.target.value) || 0 } : d)}
                    className="font-mono text-sm"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs">מחיר כניסה ($)</Label>
                  <Input
                    type="number" step="0.01"
                    value={signalDraft.entry}
                    onChange={(e) => setSignalDraft(d => d ? { ...d, entry: e.target.value } : d)}
                    className="font-mono text-sm text-[#65A30D] font-semibold"
                  />
                </div>
                <div>
                  <Label className="text-xs">Stop Loss ($)</Label>
                  <Input
                    type="number" step="0.01"
                    value={signalDraft.stopLoss}
                    onChange={(e) => setSignalDraft(d => d ? { ...d, stopLoss: e.target.value } : d)}
                    className="font-mono text-sm text-[#FF6B6B] font-semibold"
                  />
                </div>
                <div>
                  <Label className="text-xs">Take Profit ($)</Label>
                  <Input
                    type="number" step="0.01"
                    value={signalDraft.takeProfit}
                    onChange={(e) => setSignalDraft(d => d ? { ...d, takeProfit: e.target.value } : d)}
                    className="font-mono text-sm text-[#2563EB] font-semibold"
                  />
                </div>
              </div>
              <div>
                <Label className="text-xs">קטליסט / סיבה</Label>
                <Textarea
                  rows={3}
                  value={signalDraft.catalyst}
                  onChange={(e) => setSignalDraft(d => d ? { ...d, catalyst: e.target.value } : d)}
                  className="text-xs resize-none"
                  placeholder="סיבת הכניסה..."
                />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setSignalEditOpen(false)}>ביטול</Button>
            <Button
              onClick={confirmAddSignal}
              disabled={addSignalMut.isPending}
              className="bg-[#65A30D] hover:bg-[#17a87e] text-white"
            >
              {addSignalMut.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <BookmarkPlus className="h-4 w-4 mr-1" />}
              שמור איתות
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
