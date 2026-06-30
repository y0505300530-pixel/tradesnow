import { useState, useRef } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Loader2, BarChart2, ArrowRightLeft, TrendingUp, AlertTriangle,
  ChevronUp, ChevronDown, Wallet, Bot, Send, X, MessageSquare,
} from "lucide-react";
import type { Holding, AnalysisResult } from "../types";
import { actionColor, urgencyIcon, scoreColor, healthColor } from "../helpers";
import { ScoreBadge } from "../components/ScoreBadge";

// ─── Types ────────────────────────────────────────────────────────────────────

type DailyReview = {
  dailyHealthScore: number;
  dailySummary: string;
  priorityAction: string;
  holdingActions: { ticker: string; action: string; reasoning: string; urgency: string }[];
  alerts: { type: string; ticker: string; message: string }[];
  cashDeploymentNote: string;
  addMoreSuggestions?: { ticker: string; reasoning: string; suggestedAction: string }[];
  sellSuggestions?: { ticker: string; reasoning: string; urgency: string }[];
  replaceSuggestions?: { exitTicker: string; enterTicker: string; reasoning: string }[];
  sensitivity: {
    dailyPnl: number;
    dailyPnlPct: number;
    sectorExposure: { sector: string; pct: string }[];
    concentrationRisk: { ticker: string; pct: string }[];
    tierCounts: Record<string, number>;
    cashPct: number;
  };
};

type HoldingScore = {
  id: number; ticker: string; zivScore: number; tier?: string; action: string; reasoning: string;
  stopLoss: number | null; takeProfit: number | null; positionSizePct: number | null; suggestedUnits: number | null;
  exitAlert: string | null; exitAlertType: string | null;
};

type RetestItem = {
  ticker: string; company: string; breakoutPrice: number; breakoutDate: string;
  currentPrice: number; retestZoneLow: number; retestZoneHigh: number;
  inRetestZone: boolean; distToRetestZonePct: number; zivScore: number;
  signal: "IN_ZONE" | "APPROACHING" | "ABOVE_ZONE";
};

type Replacements = {
  top5: { ticker: string; company: string | null; score: number; tier: string; reason: string }[];
  bottom5: { ticker: string; company: string | null; score: number; tier: string; action: string }[];
  scannedCount?: number;
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface AnalysisSectionProps {
  holdingsWithLive: Holding[];
  cashBalance: number;
  displayNLV?: number | null;
  displayPortfolioValue?: number | null;
  /** Callback to invalidate portfolio state after analysis */
  onAnalysisComplete: () => void;
  setLastRefreshedAt: (d: Date) => void;
  setMinutesSinceRefresh: (n: number) => void;
  /** Notify parent so it can update holdingScoreMap for position-size column */
  onHoldingScoresUpdated: (scores: HoldingScore[]) => void;
  /** Notify parent so it can update H2 analysis results */
  onH2AnalyzeResults: (results: any[]) => void;
  /** Notify parent when holdings scan completes (for HoldingsSection badge) */
  onHoldingsScanned?: (d: Date) => void;
  /** Expose analysing state to parent for the progress bar */
  analyzing: boolean;
  setAnalyzing: (v: boolean) => void;
  analysis: AnalysisResult | null;
  setAnalysis: (a: AnalysisResult | null) => void;
  /** Chat state managed in parent so it persists across re-renders */
  chatMessages: { role: "user" | "assistant"; content: string }[];
  setChatMessages: React.Dispatch<React.SetStateAction<{ role: "user" | "assistant"; content: string }[]>>;
  chatInput: string;
  setChatInput: (v: string) => void;
  chatBottomRef: React.RefObject<HTMLDivElement | null>;
  portfolioChatMut: ReturnType<typeof trpc.portfolio.portfolioChat.useMutation>;
  handleChatSend: (holdingsRef?: any[], cashRef?: number, nlvRef?: number) => void;
  prevSignalsRef: React.MutableRefObject<Record<string, string>>;
  utils: ReturnType<typeof trpc.useUtils>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AnalysisSection({
  holdingsWithLive,
  cashBalance,
  displayNLV,
  displayPortfolioValue,
  onAnalysisComplete,
  setLastRefreshedAt,
  setMinutesSinceRefresh,
  onHoldingScoresUpdated,
  onH2AnalyzeResults,
  analyzing,
  setAnalyzing,
  analysis,
  setAnalysis,
  chatMessages,
  setChatMessages,
  chatInput,
  setChatInput,
  chatBottomRef,
  portfolioChatMut,
  handleChatSend,
  prevSignalsRef,
  utils,
  onHoldingsScanned,
}: AnalysisSectionProps) {
  // ── Local state ──
  const [analyzingMode, setAnalyzingMode] = useState<"holdings" | "assets" | null>(null);
  const [holdingScores, setHoldingScores] = useState<HoldingScore[]>([]);
  const [assetListResults, setAssetListResults] = useState<any[]>([]);
  const [replacements, setReplacements] = useState<Replacements | null>(null);
  const [findingReplacements, setFindingReplacements] = useState(false);
  const [retestWatchlist, setRetestWatchlist] = useState<RetestItem[] | null>(null);
  const [scanningRetest, setScanningRetest] = useState(false);
  const [dailyReview, setDailyReview] = useState<DailyReview | null>(null);
  const [runningDailyReview, setRunningDailyReview] = useState(false);
  const [dailyReviewExpanded, setDailyReviewExpanded] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [holdingsLastScanned, setHoldingsLastScanned] = useState<Date | null>(null);
  const [catalogueLastScanned, setCatalogueLastScanned] = useState<Date | null>(null);

  // ── Mutations ──
  const analyzeMut = trpc.portfolio.analyze.useMutation({
    onSuccess: (data) => { setAnalysis(data as any); setAnalyzing(false); },
    onError: (e) => { toast.error(e.message); setAnalyzing(false); },
  });

  const analyzeHoldingsMut = trpc.portfolio.analyzeHoldings.useMutation({
    onSuccess: (data) => {
      const prev = prevSignalsRef.current;
      const changes: string[] = [];
      for (const r of data.results) {
        if (prev[r.ticker] && prev[r.ticker] !== r.action) {
          changes.push(`${r.ticker}: ${prev[r.ticker]} → ${r.action}`);
        }
        prev[r.ticker] = r.action;
      }
      if (changes.length > 0) {
        toast.warning(`⚠️ Signal change detected: ${changes.join(" | ")}`, { duration: 8000 });
      }
      setHoldingScores(data.results as HoldingScore[]);
      onHoldingScoresUpdated(data.results as HoldingScore[]);
      setAnalyzingMode(null);
      const scanDate = new Date();
      setHoldingsLastScanned(scanDate);
      onHoldingsScanned?.(scanDate);
      utils.portfolio.getState.invalidate();
      setLastRefreshedAt(new Date());
      setMinutesSinceRefresh(0);
      toast.success(`Scored ${data.results.length} holdings`);
    },
    onError: (e) => { toast.error(e.message); setAnalyzingMode(null); },
  });

  const analyzeAssetListMut = trpc.portfolio.analyzeAssetList.useMutation({
    onSuccess: (data) => {
      setAssetListResults(data.candidates);
      setAnalyzingMode(null);
      setCatalogueLastScanned(new Date());
      utils.portfolio.getCatalogueWithScores.invalidate();
      toast.success(`Scanned ${data.totalScanned} assets — scores updated`);
    },
    onError: (e) => { toast.error(e.message); setAnalyzingMode(null); },
  });

  const replacementsMut = trpc.portfolio.findReplacements.useMutation({
    onSuccess: (data) => {
      setReplacements(data);
      setFindingReplacements(false);
      if (data.top5.length === 0) {
        toast.info(`Scanned ${data.scannedCount} assets — no replacements scoring ≥9.00 found right now.`);
      } else {
        toast.success(`Found ${data.top5.length} replacement candidate${data.top5.length > 1 ? 's' : ''} scoring ≥9.00`);
      }
    },
    onError: (e) => { toast.error(e.message); setFindingReplacements(false); },
  });

  const retestMut = trpc.portfolio.getRetestWatchlist.useMutation({
    onSuccess: (data) => {
      setRetestWatchlist(data.watchlist as RetestItem[]);
      setScanningRetest(false);
      const inZone = data.watchlist.filter((w: any) => w.signal === "IN_ZONE").length;
      const approaching = data.watchlist.filter((w: any) => w.signal === "APPROACHING").length;
      if (data.watchlist.length === 0) {
        toast.info(`Scanned ${data.scannedCount} assets — no confirmed breakouts in last 30 days.`);
      } else if (inZone > 0) {
        toast.success(`🔁 ${inZone} ticker${inZone > 1 ? 's' : ''} IN Retest Zone! ${approaching > 0 ? `+${approaching} approaching.` : ''}`);
      } else {
        toast.info(`${approaching} ticker${approaching > 1 ? 's' : ''} approaching Retest Zone. Scanned ${data.scannedCount} assets.`);
      }
    },
    onError: (e) => { toast.error(e.message); setScanningRetest(false); },
  });

  const dailyReviewMut = trpc.portfolio.dailyReview.useMutation({
    onSuccess: (data) => {
      setDailyReview(data as any);
      setRunningDailyReview(false);
      setDailyReviewExpanded(true);
      toast.success(`Daily Review complete — Health Score: ${data.dailyHealthScore}/10`);
    },
    onError: (e) => { toast.error(e.message); setRunningDailyReview(false); },
  });

  // ── Handlers ──
  const handleAnalyze = () => {
    setAnalyzing(true);
    setAnalysis(null);
    analyzeMut.mutate();
  };

  const handleAnalyzeHoldings = () => {
    setAnalyzingMode("holdings");
    setHoldingScores([]);
    analyzeHoldingsMut.mutate();
  };

  const handleAnalyzeAssets = () => {
    setAnalyzingMode("assets");
    setAssetListResults([]);
    analyzeAssetListMut.mutate();
  };

  const isBusy = analyzingMode !== null || analyzing || findingReplacements || runningDailyReview || scanningRetest;

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">

      {/* ── Analyze Buttons ── */}
      <div className="grid grid-cols-2 gap-3">
        {/* Button 1: Analyze Holdings */}
        <button
          className={`group flex flex-col items-center gap-2 rounded-xl border-2 px-4 py-4 text-sm font-semibold transition-all shadow-sm hover:shadow-md ${
            analyzingMode === 'holdings' ? 'border-emerald-400 bg-emerald-50 text-[#65A30D]' :
            'border-emerald-200 hover:border-emerald-400 hover:bg-emerald-50 text-[#65A30D] bg-white'
          }`}
          onClick={handleAnalyzeHoldings}
          disabled={isBusy}
        >
          <div className="flex items-center gap-2">
            {analyzingMode === 'holdings' ? <Loader2 className="h-4 w-4 animate-spin" /> : <BarChart2 className="h-4 w-4" />}
            Analyze Holdings
          </div>
          <p className="text-xs font-normal text-[#65A30D]/80 text-center leading-tight">
            Ziv Score לכל אחזקה — HOLD / EXIT / ADD
          </p>
        </button>

        {/* Button 2: Full AI Analysis */}
        <button
          className={`group flex flex-col items-center gap-2 rounded-xl border-2 px-4 py-4 text-sm font-semibold transition-all shadow-sm hover:shadow-md ${
            analyzing ? 'border-indigo-400 bg-indigo-50 text-indigo-700' :
            'border-indigo-200 hover:border-indigo-400 hover:bg-indigo-50 text-indigo-700 bg-white'
          }`}
          onClick={handleAnalyze}
          disabled={isBusy}
        >
          <div className="flex items-center gap-2">
            {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <TrendingUp className="h-4 w-4" />}
            Full AI Analysis
          </div>
          <p className="text-xs font-normal text-indigo-600/80 text-center leading-tight">
            קנייה, מכירה, החלפה וסיכונים
          </p>
        </button>

        {/* Button 3: Find Replacements */}
        <button
          className={`group flex flex-col items-center gap-2 rounded-xl border-2 px-4 py-4 text-sm font-semibold transition-all shadow-sm hover:shadow-md ${
            findingReplacements ? 'border-amber-400 bg-amber-50 text-amber-400' :
            'border-amber-200 hover:border-amber-400 hover:bg-amber-50 text-amber-400 bg-white'
          }`}
          onClick={() => { setFindingReplacements(true); setReplacements(null); replacementsMut.mutate(); }}
          disabled={isBusy}
        >
          <div className="flex items-center gap-2">
            {findingReplacements ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />}
            Find Replacements
          </div>
          <p className="text-xs font-normal text-amber-600/80 text-center leading-tight">
            5 נכסים חזקים להחליף אחזקות חלשות
          </p>
        </button>

        {/* Button 4: Daily Review */}
        <button
          className={`group flex flex-col items-center gap-2 rounded-xl border-2 px-4 py-4 text-sm font-semibold transition-all shadow-sm hover:shadow-md ${
            runningDailyReview ? 'border-violet-400 bg-violet-50 text-violet-700' :
            'border-violet-200 hover:border-violet-400 hover:bg-violet-50 text-violet-700 bg-white'
          }`}
          onClick={() => { setRunningDailyReview(true); setDailyReview(null); dailyReviewMut.mutate(); }}
          disabled={isBusy}
        >
          <div className="flex items-center gap-2">
            {runningDailyReview ? <Loader2 className="h-4 w-4 animate-spin" /> : <BarChart2 className="h-4 w-4" />}
            Daily Review
          </div>
          <p className="text-xs font-normal text-[#C9A84C]/80 text-center leading-tight">
            HOLD / ADD / EXIT + רגישויות
          </p>
        </button>
      </div>

      {/* Progress messages */}
      {(analyzingMode === "holdings" || analyzingMode === "assets" || analyzing || runningDailyReview) && (
        <div className="flex items-center justify-center gap-3 py-2 px-4 bg-blue-50/60 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/30 rounded-xl">
          <Loader2 className="h-4 w-4 animate-spin text-[#C9A84C] shrink-0" />
          <p className="text-sm font-medium text-blue-700 dark:text-[#C9A84C] animate-pulse">
            {analyzingMode === "holdings" && "Scoring holdings with Ziv Engine (5–15s)..."}
            {analyzingMode === "assets" && "Scanning all 60 catalogue assets (30–60s)..."}
            {analyzing && "Running full AI portfolio analysis (30–60s)..."}
            {runningDailyReview && "⚡ Running Daily Review — fetching live prices + Ziv scores (15–30s)..."}
          </p>
        </div>
      )}

      {/* ── Daily Review Results Panel ── */}
      {dailyReview && (
        <Card className="border-2 border-violet-200 shadow-md bg-gradient-to-br from-violet-50/50 to-white dark:from-violet-950/20 dark:to-background">
          <CardHeader
            className="pb-3 pt-4 px-5 cursor-pointer select-none"
            onClick={() => setDailyReviewExpanded(prev => !prev)}
          >
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <BarChart2 className="h-4 w-4 text-[#C9A84C]" />
                Daily Review — סיכום יום המסחר האחרון
                <span className={`text-sm font-bold px-2 py-0.5 rounded-full ${
                  dailyReview.dailyHealthScore >= 7 ? 'bg-emerald-900/30 text-[#65A30D]' :
                  dailyReview.dailyHealthScore >= 4 ? 'bg-amber-900/30 text-amber-400' :
                  'bg-red-900/30 text-red-700'
                }`}>
                  Health: {dailyReview.dailyHealthScore}/10
                </span>
                {!dailyReviewExpanded && (
                  <span className="text-xs font-normal text-muted-foreground ml-1 hidden md:inline">לחץ להרחבה</span>
                )}
              </CardTitle>
              <div className="flex items-center gap-2">
                {dailyReviewExpanded && (
                  <button
                    onClick={e => { e.stopPropagation(); setDailyReview(null); setDailyReviewExpanded(false); }}
                    className="text-muted-foreground hover:text-foreground text-xs"
                  >× Close</button>
                )}
                {dailyReviewExpanded
                  ? <ChevronUp className="h-4 w-4 text-[#C9A84C]" />
                  : <ChevronDown className="h-4 w-4 text-[#C9A84C]" />
                }
              </div>
            </div>
          </CardHeader>
          {dailyReviewExpanded && (
            <CardContent className="px-5 pb-5 space-y-4">
              {/* Summary + Priority Action */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-white rounded-lg border p-4">
                  <p className="text-xs font-semibold uppercase text-muted-foreground mb-1">סיכום יומי</p>
                  <p className="text-sm leading-relaxed">{dailyReview.dailySummary}</p>
                </div>
                <div className="bg-violet-50 dark:bg-violet-950/20 rounded-lg border border-violet-200 p-4">
                  <p className="text-xs font-semibold uppercase text-[#C9A84C] mb-1">פעולה עדיפות להיום</p>
                  <p className="text-sm font-medium leading-relaxed">{dailyReview.priorityAction}</p>
                </div>
              </div>

              {/* Sensitivity Metrics */}
              {dailyReview.sensitivity && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="bg-white rounded-lg border p-3 text-center">
                    <p className="text-xs text-muted-foreground">Last Session P&L</p>
                    <p className={`text-lg font-bold ${dailyReview.sensitivity.dailyPnl >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                      {dailyReview.sensitivity.dailyPnl >= 0 ? '+' : ''}{dailyReview.sensitivity.dailyPnl.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                    </p>
                    <p className={`text-xs ${dailyReview.sensitivity.dailyPnlPct >= 0 ? 'text-[#65A30D]' : 'text-[#FF6B6B]'}`}>
                      {dailyReview.sensitivity.dailyPnlPct >= 0 ? '+' : ''}{dailyReview.sensitivity.dailyPnlPct.toFixed(2)}%
                    </p>
                  </div>
                  <div className="bg-white rounded-lg border p-3 text-center">
                    <p className="text-xs text-muted-foreground">Cash %</p>
                    <p className="text-lg font-bold">{dailyReview.sensitivity.cashPct.toFixed(1)}%</p>
                    <p className="text-xs text-muted-foreground">of portfolio</p>
                  </div>
                  <div className="bg-white rounded-lg border p-3 col-span-2">
                    <p className="text-xs text-muted-foreground mb-2">חשיפות סקטוריאלית</p>
                    <div className="flex flex-wrap gap-1.5">
                      {(dailyReview.sensitivity?.sectorExposure ?? []).map(s => (
                        <span key={s.sector} className="text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-2 py-0.5">
                          {s.sector}: {s.pct}%
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Holding Actions */}
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground mb-2">המלצות לפי מודל זיו</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {(dailyReview.holdingActions ?? []).map(ha => (
                    <div key={ha.ticker} className={`rounded-lg border p-3 flex gap-3 items-start ${
                      ha.action === 'ADD' ? 'bg-emerald-50 border-emerald-200 dark:bg-emerald-950/20' :
                      ha.action === 'EXIT' ? 'bg-red-50 border-red-200 dark:bg-red-950/20' :
                      ha.action === 'REDUCE' ? 'bg-amber-50 border-amber-200 dark:bg-amber-950/20' :
                      'bg-white border-border'
                    }`}>
                      <div className="flex-shrink-0">
                        <span className={`text-xs font-bold px-2 py-1 rounded ${
                          ha.action === 'ADD' ? 'bg-[#65A30D] text-white' :
                          ha.action === 'EXIT' ? 'bg-[#FF6B6B] text-white' :
                          ha.action === 'REDUCE' ? 'bg-amber-500 text-white' :
                          'bg-[#C9A84C] text-white'
                        }`}>{ha.action}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold">{ha.ticker}</p>
                        <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">{ha.reasoning}</p>
                        {ha.urgency !== 'LOW' && (
                          <span className={`text-[10px] font-medium mt-1 inline-block px-1.5 py-0.5 rounded ${
                            ha.urgency === 'HIGH' ? 'bg-red-900/30 text-red-700' : 'bg-amber-900/30 text-amber-400'
                          }`}>{ha.urgency} URGENCY</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Alerts */}
              {(dailyReview.alerts ?? []).length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase text-muted-foreground mb-2">התראות</p>
                  <div className="space-y-1.5">
                    {(dailyReview.alerts ?? []).map((a, i) => (
                      <div key={i} className={`flex items-start gap-2 text-sm rounded-lg px-3 py-2 ${
                        a.type === 'DANGER' ? 'bg-red-50 text-red-700 border border-red-200' :
                        a.type === 'WARNING' ? 'bg-amber-50 text-amber-400 border border-amber-200' :
                        'bg-blue-50 text-blue-700 border border-blue-200'
                      }`}>
                        <span className="font-semibold">{a.ticker}:</span>
                        <span>{a.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Add More Suggestions */}
              {dailyReview.addMoreSuggestions && dailyReview.addMoreSuggestions.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase text-[#65A30D] mb-2">➕ חזק פוזיציה — מניות להגדלה</p>
                  <div className="space-y-2">
                    {dailyReview.addMoreSuggestions.map((s, i) => (
                      <div key={i} className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 px-3 py-2">
                        <span className="text-xs font-bold px-2 py-1 rounded bg-[#65A30D] text-white flex-shrink-0">{s.ticker}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-emerald-800 leading-relaxed">{s.reasoning}</p>
                          <p className="text-[10px] font-medium text-[#65A30D] mt-0.5">{s.suggestedAction}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Sell Suggestions */}
              {dailyReview.sellSuggestions && dailyReview.sellSuggestions.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase text-red-700 mb-2">❌ מכור / הפחת פוזיציה</p>
                  <div className="space-y-2">
                    {dailyReview.sellSuggestions.map((s, i) => (
                      <div key={i} className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20 px-3 py-2">
                        <span className="text-xs font-bold px-2 py-1 rounded bg-[#FF6B6B] text-white flex-shrink-0">{s.ticker}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-red-800 leading-relaxed">{s.reasoning}</p>
                          <span className={`text-[10px] font-medium mt-0.5 inline-block px-1.5 py-0.5 rounded ${
                            s.urgency === 'HIGH' ? 'bg-red-200 text-red-800' : 'bg-amber-900/30 text-amber-400'
                          }`}>{s.urgency}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Replace Suggestions */}
              {dailyReview.replaceSuggestions && dailyReview.replaceSuggestions.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase text-violet-700 mb-2">⇄ החלפת מניות — מהקטלוג</p>
                  <div className="space-y-2">
                    {dailyReview.replaceSuggestions.map((s, i) => (
                      <div key={i} className="flex items-start gap-3 rounded-lg border border-violet-200 bg-violet-50 dark:bg-violet-950/20 px-3 py-2">
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <span className="text-xs font-bold px-2 py-1 rounded bg-red-500 text-white">{s.exitTicker}</span>
                          <span className="text-xs text-muted-foreground">→</span>
                          <span className="text-xs font-bold px-2 py-1 rounded bg-violet-600 text-white">{s.enterTicker}</span>
                        </div>
                        <p className="text-xs text-violet-800 leading-relaxed flex-1">{s.reasoning}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Cash Deployment Note */}
              {dailyReview.cashDeploymentNote && (
                <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 rounded-lg p-3">
                  <p className="text-xs font-semibold uppercase text-amber-400 mb-1">הערה על פריסת קש</p>
                  <p className="text-sm text-amber-800">{dailyReview.cashDeploymentNote}</p>
                </div>
              )}
            </CardContent>
          )}
        </Card>
      )}

      {/* ── Holding Scores Results (from Analyze Holdings) ── */}
      {holdingScores.length > 0 && (
        <Card className="border shadow-sm">
          <CardHeader className="pb-2 pt-4 px-5">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <BarChart2 className="h-4 w-4 text-[#65A30D]" /> Holdings Analysis — Lab Rules
              <span className="text-xs font-normal text-muted-foreground ml-1">SL/TP/Position Size + Exit Alerts (scores saved to table above)</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {/* Exit Alerts Banner */}
            {holdingScores.some(r => r.exitAlert) && (
              <div className="mx-5 mb-3 mt-3 space-y-1.5">
                {holdingScores.filter(r => r.exitAlert).map((r, i) => (
                  <div key={i} className={`flex items-start gap-2 rounded-md px-3 py-2 text-xs font-medium ${
                    r.exitAlertType === "ZIM" || r.exitAlertType === "TRASH" ? "bg-red-900/30 text-red-800 border border-red-200" :
                    "bg-amber-900/30 text-amber-800 border border-amber-200"
                  }`}>
                    <span className="font-bold font-mono shrink-0">{r.ticker}:</span>
                    <span>{r.exitAlert}</span>
                  </div>
                ))}
              </div>
            )}
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/20">
                  <TableHead className="text-xs font-semibold w-16">Ticker</TableHead>
                  <TableHead className="text-center text-xs font-semibold w-14">Score</TableHead>
                  <TableHead className="text-xs font-semibold w-28">Tier</TableHead>
                  <TableHead className="text-xs font-semibold w-20">Action</TableHead>
                  <TableHead className="text-right text-xs font-semibold w-24">Stop Loss</TableHead>
                  <TableHead className="text-right text-xs font-semibold w-24">Take Profit</TableHead>
                  <TableHead className="text-right text-xs font-semibold w-20">Pos Size</TableHead>
                  <TableHead className="text-right text-xs font-semibold w-16">Units</TableHead>
                  <TableHead className="text-xs font-semibold">Ziv Engine Reasoning</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...holdingScores].sort((a, b) => b.zivScore - a.zivScore).map((r, i) => (
                  <TableRow key={i} className={r.exitAlertType === "ZIM" || r.exitAlertType === "TRASH" ? "bg-red-50" : r.exitAlert ? "bg-amber-50" : ""}>
                    <TableCell className="font-mono font-bold text-sm">
                      {r.ticker}
                      {r.exitAlert && (
                        <span className={`ml-1 text-xs font-bold ${
                          r.exitAlertType === "ZIM" || r.exitAlertType === "TRASH" ? "text-[#FF6B6B]" : "text-amber-600"
                        }`}>⚠</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center"><ScoreBadge score={r.zivScore} /></TableCell>
                    <TableCell><Badge variant="outline" className={`text-xs ${
                      r.tier === "Gold Breakout" ? "bg-emerald-900/30 text-[#65A30D] border-emerald-200" :
                      r.tier === "Gold Retest" ? "bg-blue-100 text-blue-700 border-blue-200" :
                      r.tier === "Near Entry Watch" ? "bg-amber-900/30 text-amber-400 border-amber-200" :
                      "bg-red-900/30 text-red-700 border-red-200"
                    }`}>{r.tier ?? "—"}</Badge></TableCell>
                    <TableCell><Badge variant="outline" className={`text-xs ${actionColor(r.action)}`}>{r.action}</Badge></TableCell>
                    <TableCell className="text-right font-mono text-xs text-[#FF6B6B] font-semibold">
                      {r.stopLoss != null ? `$${r.stopLoss.toFixed(2)}` : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-[#65A30D] font-semibold">
                      {r.takeProfit != null ? `$${r.takeProfit.toFixed(2)}` : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {r.positionSizePct != null ? `${r.positionSizePct.toFixed(1)}%` : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {r.suggestedUnits != null ? r.suggestedUnits.toLocaleString() : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground break-words whitespace-normal">{r.reasoning}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {/* Legend */}
            <div className="px-5 py-2 border-t bg-muted/10 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span><strong>Stop Loss:</strong> max(8% below entry, EMA-50 −1%)</span>
              <span><strong>Take Profit:</strong> +2R scale-out (50%), trail remainder (Open Skies)</span>
              <span><strong>Pos Size:</strong> quality-scaled (score 8→min, 10→max)</span>
              <span><strong>⚠ Alerts:</strong> ZIM (7d below EMA-50), Diamond Hands (5d below EMA-20)</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Analysis Results (Full AI) ── */}
      {analysis && (
        <div className="space-y-6">
          {/* ── SECTION HEADER ── */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-indigo-500" />
              <h2 className="text-base font-bold text-foreground">Full AI Analysis</h2>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="border-indigo-300 text-indigo-700 hover:bg-indigo-50 gap-2"
              onClick={() => setChatOpen(prev => !prev)}
            >
              <MessageSquare className="h-4 w-4" />
              {chatOpen ? "סגור AI Chat" : "פתח AI Chat"}
            </Button>
          </div>

          {/* Health Score + Leverage Ratio */}
          <Card className="border-0 shadow-sm bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-indigo-950/30 dark:to-blue-950/20">
            <CardContent className="pt-5 pb-5">
              <div className="flex items-start gap-4">
                <div className="text-center">
                  <div className={`text-5xl font-black ${healthColor(analysis.portfolioHealthScore)}`}>{analysis.portfolioHealthScore}</div>
                  <div className="text-xs text-muted-foreground font-medium mt-0.5">/ 10</div>
                  <div className="text-xs font-semibold mt-1">Health Score</div>
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-sm mb-1">Portfolio Health Summary</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{analysis.portfolioHealthSummary}</p>

                  {/* Leverage Ratio */}
                  {(() => {
                    const grossPV = displayPortfolioValue;
                    const nlv = displayNLV;
                    if (!grossPV || !nlv || nlv <= 0) return null;
                    const leverageRatio = grossPV / nlv;
                    const leveragePct = Math.round(leverageRatio * 100);
                    const leverageColor = leverageRatio <= 1.0 ? 'text-[#65A30D] bg-emerald-50 border-emerald-200'
                      : leverageRatio <= 1.8 ? 'text-amber-600 bg-amber-50 border-amber-200'
                      : 'text-[#FF6B6B] bg-red-50 border-red-200';
                    const leverageLabel = leverageRatio <= 1.0 ? '✓ תקין' : leverageRatio <= 1.8 ? '⚠ מקובל' : '⛔ מסוכן';
                    return (
                      <div className={`mt-2 flex items-center gap-2 text-xs font-semibold border rounded px-2.5 py-1.5 ${leverageColor}`}>
                        <span>מינוף: {leverageRatio.toFixed(2)}x ({leveragePct}%)</span>
                        <span className="opacity-70">—</span>
                        <span>{leverageLabel}</span>
                        {leverageRatio <= 1.0 && <span className="opacity-60 font-normal">יתרת מזומנים שלילית תקינה (מינוף 100%)</span>}
                      </div>
                    );
                  })()}

                  {analysis.keyRisks && (() => {
                    const grossPV = displayPortfolioValue;
                    const nlv = displayNLV;
                    const leverageRatio = (grossPV && nlv && nlv > 0) ? grossPV / nlv : 999;
                    const isCashWarning = /cash|מזומן|שלילי|negative/i.test(analysis.keyRisks);
                    if (isCashWarning && leverageRatio <= 1.05) return null;
                    return (
                      <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-800 bg-amber-100 border border-amber-300 rounded px-2.5 py-1.5">
                        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                        <span>{analysis.keyRisks}</span>
                      </div>
                    );
                  })()}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ── PART 1: Current Holdings Analysis ── */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 border-b pb-2">
              <BarChart2 className="h-4 w-4 text-[#C9A84C]" />
              <h3 className="text-sm font-bold text-foreground">חלק א׳ — ניתוח תיק קיים</h3>
              <span className="text-xs text-muted-foreground">המלצות על האחזקות הנוכחיות</span>
            </div>

            {/* Holding Recommendations */}
            {analysis.holdingRecommendations?.length > 0 ? (
              <Card className="border shadow-sm">
                <CardHeader className="pb-2 pt-4 px-5">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <BarChart2 className="h-4 w-4 text-[#C9A84C]" /> המלצות על אחזקות ({analysis.holdingRecommendations.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/20">
                        <TableHead className="text-xs font-semibold w-16">Ticker</TableHead>
                        <TableHead className="text-xs font-semibold w-20">Action</TableHead>
                        <TableHead className="text-xs font-semibold w-24">Stop Loss</TableHead>
                        <TableHead className="text-xs font-semibold w-24">Target</TableHead>
                        <TableHead className="text-xs font-semibold w-24">Urgency</TableHead>
                        <TableHead className="text-xs font-semibold">Reasoning</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {analysis.holdingRecommendations.map((rec, i) => (
                        <TableRow key={i}>
                          <TableCell className="font-mono font-bold text-sm">{rec.ticker}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={`text-xs ${actionColor(rec.action)}`}>{rec.action}</Badge>
                          </TableCell>
                          <TableCell className="font-mono text-sm text-[#FF6B6B]">{rec.stopLoss}</TableCell>
                          <TableCell className="font-mono text-sm text-[#65A30D]">{rec.targetPrice}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1 text-xs">
                              {urgencyIcon(rec.urgency)}
                              <span className="capitalize">{rec.urgency}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground break-words whitespace-normal">{rec.reasoning}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ) : (
              <div className="text-sm text-muted-foreground bg-muted/30 rounded-lg px-4 py-3">אין המלצות ספציפיות על האחזקות הנוכחיות.</div>
            )}

            {/* Swap Recommendations */}
            {analysis.swapRecommendations?.length > 0 && (
              <Card className="border shadow-sm">
                <CardHeader className="pb-2 pt-4 px-5">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <ArrowRightLeft className="h-4 w-4 text-amber-500" /> המלצות החלפה
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-3">
                  {analysis.swapRecommendations.map((swap, i) => (
                    <div key={i} className="flex items-start gap-3 bg-amber-50/50 border border-amber-100 rounded-lg px-4 py-3">
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge variant="outline" className="font-mono bg-red-50 text-red-700 border-red-200">{swap.exitTicker}</Badge>
                        <ArrowRightLeft className="h-3.5 w-3.5 text-muted-foreground" />
                        <Badge variant="outline" className="font-mono bg-emerald-50 text-[#65A30D] border-emerald-200">{swap.enterTicker}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">{swap.reasoning}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>

          {/* ── PART 2: New Buy Plan from Catalogue ── */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 border-b pb-2">
              <TrendingUp className="h-4 w-4 text-[#65A30D]" />
              <h3 className="text-sm font-bold text-foreground">חלק ב׳ — תוכנית רכישה חדשה</h3>
              <span className="text-xs text-muted-foreground">מניות מה-Asset Catalogue עם ציון גבוה ופוטנציאל</span>
            </div>

            {/* Buy Opportunities */}
            {analysis.buyOpportunities?.length > 0 ? (
              <Card className="border shadow-sm border-emerald-200">
                <CardHeader className="pb-2 pt-4 px-5 bg-emerald-50/40">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-[#65A30D]" />
                    הזדמנויות קנייה מה-Catalogue ({analysis.buyOpportunities.length})
                    <Badge variant="outline" className="text-xs bg-emerald-900/30 text-[#65A30D] border-emerald-300 ml-1">מניות חדשות</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-emerald-50/30">
                        <TableHead className="text-xs font-semibold w-16">Ticker</TableHead>
                        <TableHead className="text-xs font-semibold w-20">Ziv Score</TableHead>
                        <TableHead className="text-xs font-semibold w-28">Entry Zone</TableHead>
                        <TableHead className="text-xs font-semibold w-24">Stop Loss</TableHead>
                        <TableHead className="text-xs font-semibold w-24">Target</TableHead>
                        <TableHead className="text-xs font-semibold w-20">Allocation</TableHead>
                        <TableHead className="text-xs font-semibold">Reasoning</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {analysis.buyOpportunities.map((opp, i) => (
                        <TableRow key={i} className="bg-emerald-50/20 hover:bg-emerald-50/50">
                          <TableCell className="font-mono font-bold text-sm text-[#65A30D]">{opp.ticker}</TableCell>
                          <TableCell>
                            <span className={`font-bold text-sm ${scoreColor(opp.zivScore)}`}>{opp.zivScore}/10</span>
                          </TableCell>
                          <TableCell className="font-mono text-sm">{opp.entryZone}</TableCell>
                          <TableCell className="font-mono text-sm text-[#FF6B6B]">{opp.stopLoss}</TableCell>
                          <TableCell className="font-mono text-sm text-[#65A30D]">{opp.targetPrice}</TableCell>
                          <TableCell className="text-sm font-semibold">{opp.positionSizePct}%</TableCell>
                          <TableCell className="text-xs text-muted-foreground break-words whitespace-normal">{opp.reasoning}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ) : (
              <div className="text-sm text-muted-foreground bg-muted/30 rounded-lg px-4 py-3">אין הזדמנויות קנייה מהקטלוג כרגע.</div>
            )}

            {/* Cash Deployment Plan */}
            {analysis.cashDeploymentPlan && cashBalance > 0 && (
              <Card className="border shadow-sm bg-blue-50/30">
                <CardContent className="pt-4 pb-4 px-5">
                  <div className="flex items-start gap-3">
                    <Wallet className="h-4 w-4 text-[#C9A84C] mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm font-semibold mb-1">תוכנית פריסת מזומן (${cashBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })} זמין)</p>
                      <p className="text-sm text-muted-foreground leading-relaxed">{analysis.cashDeploymentPlan}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* ── AI CHAT PANEL (inline with analysis) ── */}
          {chatOpen && (
            <Card className="border-2 border-indigo-200 shadow-md">
              <CardHeader className="pb-3 pt-4 px-5 bg-indigo-50/60">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Bot className="h-4 w-4 text-indigo-600" />
                  AI Chat — שוחח עם המנהל הפיננסי שלך
                  <span className="text-xs font-normal text-muted-foreground ml-1">מבוסס על הניתוח הנוכחי</span>
                  <Button variant="ghost" size="sm" className="ml-auto h-6 w-6 p-0" onClick={() => setChatOpen(false)}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="h-72 overflow-y-auto px-4 py-3 space-y-3 bg-background">
                  {chatMessages.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
                      <Bot className="h-8 w-8 mb-2 text-indigo-300" />
                      <p className="text-sm font-medium">שאל אותי כל שאלה על התיק שלך</p>
                      <p className="text-xs mt-1">לדוגמה: &quot;מה דעתך על NVDA?&quot; או &quot;כמה להשקיע ב-AAPL?&quot;</p>
                    </div>
                  )}
                  {chatMessages.map((msg, i) => (
                    <div key={i} className={`flex gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                      {msg.role === "assistant" && (
                        <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <Bot className="h-3.5 w-3.5 text-indigo-600" />
                        </div>
                      )}
                      <div className={`max-w-[80%] rounded-xl px-3 py-2 text-sm leading-relaxed ${
                        msg.role === "user"
                          ? "bg-indigo-600 text-white rounded-br-sm"
                          : "bg-muted text-foreground rounded-bl-sm"
                      }`}>
                        {msg.content}
                      </div>
                      {msg.role === "user" && (
                        <div className="w-6 h-6 rounded-full bg-indigo-600 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <span className="text-[10px] text-white font-bold">You</span>
                        </div>
                      )}
                    </div>
                  ))}
                  {portfolioChatMut.isPending && (
                    <div className="flex gap-2 justify-start">
                      <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
                        <Bot className="h-3.5 w-3.5 text-indigo-600" />
                      </div>
                      <div className="bg-muted rounded-xl rounded-bl-sm px-3 py-2">
                        <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
                      </div>
                    </div>
                  )}
                  <div ref={chatBottomRef} />
                </div>
                <div className="border-t px-4 py-3 flex gap-2 bg-muted/20">
                  <Input
                    placeholder="שאל שאלה על התיק שלך..."
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleChatSend(holdingsWithLive, cashBalance, displayNLV ?? undefined); } }}
                    className="flex-1 text-sm"
                    disabled={portfolioChatMut.isPending}
                  />
                  <Button
                    size="sm"
                    onClick={() => handleChatSend(holdingsWithLive, cashBalance, displayNLV ?? undefined)}
                    disabled={portfolioChatMut.isPending || !chatInput.trim()}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-3"
                  >
                    {portfolioChatMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── Replacements Panel ── */}
      {replacements && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4 text-amber-500" />
              Replacement Candidates
              <span className="text-xs font-normal text-muted-foreground ml-1">
                Scanned {(replacements.top5.length + replacements.bottom5.length)} assets
              </span>
            </h2>
            <Button variant="ghost" size="sm" onClick={() => setReplacements(null)} className="text-xs">× Close</Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Top-5 candidates to BUY */}
            <Card className="border shadow-sm">
              <CardHeader className="pb-2 pt-4 px-5">
                <CardTitle className="text-sm font-semibold flex items-center gap-2 text-[#65A30D]">
                  <TrendingUp className="h-4 w-4" /> Top Candidates (Score ≥9.00)
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {replacements.top5.length === 0 ? (
                  <div className="px-5 py-6 text-sm text-muted-foreground text-center">
                    No catalogue assets currently score ≥9.00. Check back later.
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/20">
                        <TableHead className="text-xs font-semibold">Ticker</TableHead>
                        <TableHead className="text-center text-xs font-semibold">Score</TableHead>
                        <TableHead className="text-xs font-semibold">Tier</TableHead>
                        <TableHead className="text-xs font-semibold">Reason</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {replacements.top5.map((r, i) => (
                        <TableRow key={i} className="bg-emerald-50/30">
                          <TableCell className="font-mono font-bold text-sm">{r.ticker}</TableCell>
                          <TableCell className="text-center"><ScoreBadge score={r.score} /></TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs bg-emerald-900/30 text-[#65A30D] border-emerald-200">{r.tier}</Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate" title={r.reason}>{r.reason}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            {/* Bottom-5 to consider REPLACING */}
            <Card className="border shadow-sm">
              <CardHeader className="pb-2 pt-4 px-5">
                <CardTitle className="text-sm font-semibold flex items-center gap-2 text-[#FF6B6B]">
                  <AlertTriangle className="h-4 w-4" /> Weakest Holdings (Consider Replacing)
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {replacements.bottom5.length === 0 ? (
                  <div className="px-5 py-6 text-sm text-muted-foreground text-center">No holdings to evaluate.</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/20">
                        <TableHead className="text-xs font-semibold">Ticker</TableHead>
                        <TableHead className="text-center text-xs font-semibold">Score</TableHead>
                        <TableHead className="text-xs font-semibold">Signal</TableHead>
                        <TableHead className="text-xs font-semibold">Tier</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {replacements.bottom5.map((r, i) => (
                        <TableRow key={i} className="bg-red-50/20">
                          <TableCell className="font-mono font-bold text-sm">{r.ticker}</TableCell>
                          <TableCell className="text-center"><ScoreBadge score={r.score} /></TableCell>
                          <TableCell>
                            <Badge variant="outline" className={`text-xs ${
                              r.action === "EXIT" ? "bg-red-900/30 text-red-700 border-red-200" :
                              r.action === "WATCH" ? "bg-amber-900/30 text-amber-400 border-amber-200" :
                              "bg-emerald-900/30 text-[#65A30D] border-emerald-200"
                            }`}>{r.action}</Badge>
                          </TableCell>
                          <TableCell><span className="text-xs text-muted-foreground">{r.tier}</span></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
