/**
 * WarEnginePanel.tsx
 * Shows War Engine intelligence for a single ticker inside DeepAnalysisPage.
 * - Live Ziv score + Bear score
 * - Market regime
 * - Mentor pattern bonuses
 * - H2 portfolio status (if held)
 * - Recommended action
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { RefreshCw, Swords, TrendingUp, TrendingDown, Brain, Shield,
         Target, Activity, Lightbulb, CheckCircle2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface WarEnginePanelProps {
  ticker: string;
  holdingContext?: {
    buyPrice?: number;
    units?: number;
    currentPrice?: number;
    pnlPct?: number;
  } | null;
}

const ACTION_STYLE: Record<string, { bg: string; text: string; icon: React.ReactNode }> = {
  ENTER:  { bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-800", icon: <TrendingUp className="w-4 h-4 text-emerald-600" /> },
  ADD:    { bg: "bg-blue-50 border-blue-200",       text: "text-blue-800",    icon: <TrendingUp className="w-4 h-4 text-blue-600" /> },
  HOLD:   { bg: "bg-amber-50 border-amber-200",     text: "text-amber-800",   icon: <Shield className="w-4 h-4 text-amber-600" /> },
  WATCH:  { bg: "bg-slate-50 border-slate-200",     text: "text-slate-700",   icon: <Activity className="w-4 h-4 text-slate-500" /> },
  EXIT:   { bg: "bg-red-50 border-red-200",         text: "text-red-800",     icon: <TrendingDown className="w-4 h-4 text-red-600" /> },
  REDUCE: { bg: "bg-orange-50 border-orange-200",   text: "text-orange-800",  icon: <TrendingDown className="w-4 h-4 text-orange-600" /> },
  SKIP:   { bg: "bg-muted border-border",           text: "text-muted-foreground", icon: <Activity className="w-4 h-4" /> },
};

const SCORE_COLOR = (s: number) =>
  s >= 8 ? "text-emerald-600" : s >= 6 ? "text-amber-500" : s >= 4 ? "text-blue-500" : "text-red-500";

export function WarEnginePanel({ ticker, holdingContext }: WarEnginePanelProps) {
  const [expanded, setExpanded] = useState(false);

  const isTase = ticker.toUpperCase().endsWith(".TA");

  const { data, isLoading, refetch } = trpc.insights.getWarTickerAnalysis.useQuery(
    { ticker },
    { staleTime: 5 * 60_000, refetchOnWindowFocus: false }
  );

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card/50 p-4 flex items-center gap-3 text-sm text-muted-foreground">
        <RefreshCw className="w-4 h-4 animate-spin text-primary" />
        <span>War Engine מנתח...</span>
      </div>
    );
  }

  if (!data) return null;

  const style = ACTION_STYLE[data.action] ?? ACTION_STYLE.SKIP;

  return (
    <div className={`rounded-xl border ${style.bg} p-4`}>
      {/* Header */}
      <div className="flex items-center gap-3 mb-3">
        <Swords className="w-4 h-4 text-red-600 shrink-0" />
        <span className="text-sm font-bold text-foreground">War Engine — {ticker}</span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => refetch()}
            className="p-1 rounded hover:bg-muted transition-colors">
            <RefreshCw className="w-3 h-3 text-muted-foreground" />
          </button>
          <button onClick={() => setExpanded(e => !e)}
            className="text-xs text-muted-foreground hover:text-foreground border border-border rounded px-2 py-0.5">
            {expanded ? "פחות" : "פרטים"}
          </button>
        </div>
      </div>

      {/* Scores row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <div className="rounded-lg bg-white/60 border border-white px-3 py-2 text-center">
          <div className={`text-xl font-bold ${SCORE_COLOR(data.finalScore)}`}>{data.finalScore.toFixed(1)}</div>
          <div className="text-[10px] text-muted-foreground">War Score</div>
        </div>
        <div className="rounded-lg bg-white/60 border border-white px-3 py-2 text-center">
          <div className={`text-xl font-bold ${SCORE_COLOR(data.baseScore)}`}>{data.baseScore.toFixed(1)}</div>
          <div className="text-[10px] text-muted-foreground">Ziv Score</div>
        </div>
        <div className="rounded-lg bg-white/60 border border-white px-3 py-2 text-center">
          <div className={`text-xl font-bold ${data.mentorBonus > 0 ? "text-violet-600" : "text-muted-foreground"}`}>
            +{data.mentorBonus.toFixed(2)}
          </div>
          <div className="text-[10px] text-muted-foreground">Mentor Bonus</div>
        </div>
        <div className="rounded-lg bg-white/60 border border-white px-3 py-2 text-center">
          <div className={`text-sm font-bold ${data.regime === "BULL" ? "text-emerald-600" : data.regime === "BEAR" ? "text-red-600" : "text-amber-500"}`}>
            {data.regime}
          </div>
          <div className="text-[10px] text-muted-foreground">Regime</div>
        </div>
      </div>

      {/* Action recommendation */}
      <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${style.bg} mb-2`}>
        {style.icon}
        <span className={`text-sm font-bold ${style.text}`}>{data.action}</span>
        <span className={`text-xs ${style.text} opacity-80`}>— {data.reason}</span>
      </div>

      {/* Mentor patterns */}
      {data.mentorReasons.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {data.mentorReasons.map((r: string, i: number) => (
            <span key={i} className="text-[10px] bg-violet-100 text-violet-700 border border-violet-200 rounded px-1.5 py-0.5 flex items-center gap-1">
              <Lightbulb className="w-2.5 h-2.5" />{r}
            </span>
          ))}
        </div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="mt-3 border-t border-white/60 pt-3 space-y-1 text-xs text-muted-foreground">
          <div className="flex justify-between">
            <span>Confluence Score</span>
            <span className="font-medium text-foreground">{data.confluence?.toFixed(1) ?? "—"}/10</span>
          </div>
          <div className="flex justify-between">
            <span>Liquidity Score</span>
            <span className="font-medium text-foreground">{data.liquidity?.toFixed(1) ?? "—"}/10</span>
          </div>
          {data.tier && (
            <div className="flex justify-between">
              <span>Tier</span>
              <span className="font-medium text-foreground">{data.tier}</span>
            </div>
          )}
          {holdingContext?.pnlPct != null && (
            <div className="flex justify-between">
              <span>P&L נוכחי</span>
              <span className={`font-medium ${holdingContext.pnlPct >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                {holdingContext.pnlPct.toFixed(2)}%
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
