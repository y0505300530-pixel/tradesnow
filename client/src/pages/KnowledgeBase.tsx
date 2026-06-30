import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  BookOpen,
  Brain,
  RefreshCw,
  TrendingUp,
  Shield,
  Target,
  Layers,
  BarChart2,
  Zap,
  ChevronRight,
  LogIn,
  Clock,
  Youtube,
  Star,
  ChevronDown,
  ChevronUp,
  Activity,
  GraduationCap,
  Database,
  Bookmark,
  Lightbulb,
  ArrowUpRight,
  Users,
} from "lucide-react";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Link, useSearch } from "wouter";
import type { KnowledgeResult } from "../../../server/routers/knowledgeBase";
import type { TechnicalRule, ActiveSignal, LearningStatus } from "../../../server/routers/masterKnowledge";

// ─── Constants ────────────────────────────────────────────────────────────────

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getLevelColor(level: number): string {
  if (level >= 8) return "text-[#65A30D]";
  if (level >= 6) return "text-amber-400";
  if (level >= 4) return "text-[#2563EB]";
  return "text-slate-400";
}

function getLevelBg(level: number): string {
  if (level >= 8) return "bg-emerald-500";
  if (level >= 6) return "bg-amber-500";
  if (level >= 4) return "bg-[#2563EB]";
  return "bg-slate-500";
}

function getLevelLabel(level: number): string {
  if (level >= 9) return "Expert";
  if (level >= 7) return "Advanced";
  if (level >= 5) return "Intermediate";
  if (level >= 3) return "Developing";
  return "Novice";
}

// ─── Proficiency Matrix Components ───────────────────────────────────────────

type LogEntry = {
  videoTitle: string;
  insight: string;
  knowledgeSummary?: string;
  levelBefore: number;
  levelAfter: number;
  date: string;
};

type TopicRow = {
  topic: string;
  isBig5: boolean;
  level: number;
  updateLog: LogEntry[];
  updatedAt: Date | null;
};

function TopicCard({ row }: { row: TopicRow }) {
  const [expanded, setExpanded] = useState(false);
  const pct = (row.level / 10) * 100;
  const hasLogs = row.updateLog.length > 0;
  const latestLog = hasLogs ? row.updateLog[row.updateLog.length - 1] : null;
  const knowledgeSummary = latestLog?.knowledgeSummary || "";

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden transition-all hover:border-border/80">
      <div className="p-4">
        {/* Header: topic title + level badge */}
        <div className="flex items-start justify-between gap-3 mb-2">
          <span className="font-semibold text-sm text-foreground leading-tight">{row.topic}</span>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className={`text-xs font-medium px-2 py-0.5 rounded border ${
              row.level >= 8
                ? "bg-emerald-500/15 text-[#65A30D] border-emerald-500/25"
                : row.level >= 6
                ? "bg-amber-500/15 text-amber-400 border-amber-500/25"
                : row.level >= 4
                ? "bg-[#2563EB]/15 text-[#2563EB] border-[#2563EB]/25"
                : "bg-slate-500/15 text-slate-400 border-slate-500/25"
            }`}>
              {getLevelLabel(row.level)}
            </span>
            <span className={`text-lg font-bold tabular-nums ${getLevelColor(row.level)}`}>
              {row.level}<span className="text-xs text-muted-foreground font-normal">/10</span>
            </span>
          </div>
        </div>

        {/* Knowledge summary — what this topic means */}
        {knowledgeSummary && (
          <p className="text-xs text-primary/80 italic mb-2 leading-relaxed border-l-2 border-primary/30 pl-2">
            {knowledgeSummary}
          </p>
        )}

        {/* Progress bar */}
        <div className="h-1.5 rounded-full bg-border overflow-hidden mb-2">
          <div
            className={`h-full rounded-full transition-all duration-500 ${getLevelBg(row.level)}`}
            style={{ width: `${pct}%` }}
          />
        </div>

        {/* Latest insight from videos */}
        {hasLogs && (
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[10px] text-muted-foreground/60 mb-0.5 uppercase tracking-wide">Latest from: {latestLog?.videoTitle}</p>
              <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                {latestLog?.insight}
              </p>
            </div>
            {row.updateLog.length > 1 && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors mt-0.5"
              >
                {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Expanded history */}
      {expanded && hasLogs && (
        <div className="border-t border-border/50 bg-muted/20 p-4 space-y-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Learning History</p>
          {[...row.updateLog].reverse().map((entry, i) => (
            <div key={i} className="flex gap-3">
              <div className="flex flex-col items-center gap-1 shrink-0">
                <div className="w-5 h-5 rounded-full bg-primary/15 border border-primary/25 flex items-center justify-center">
                  <span className="text-[10px] font-bold text-primary">{entry.levelAfter}</span>
                </div>
                {i < row.updateLog.length - 1 && (
                  <div className="w-px flex-1 bg-border/50 min-h-[12px]" />
                )}
              </div>
              <div className="pb-2 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-xs font-medium text-foreground truncate">{entry.videoTitle}</span>
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {entry.levelBefore}→{entry.levelAfter}
                  </span>
                </div>
                {entry.knowledgeSummary && (
                  <p className="text-xs text-primary/70 italic mb-1 leading-relaxed">{entry.knowledgeSummary}</p>
                )}
                <p className="text-xs text-muted-foreground leading-relaxed">{entry.insight}</p>
                <p className="text-[10px] text-muted-foreground/50 mt-0.5">
                  {new Date(entry.date).toLocaleDateString()}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProficiencyMatrix() {
  const { data: matrix, isLoading } = trpc.proficiency.get.useQuery();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm gap-2">
        <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        Loading knowledge matrix...
      </div>
    );
  }

  if (!matrix || matrix.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-14 h-14 rounded-2xl bg-muted border border-border flex items-center justify-center mb-4">
          <GraduationCap className="w-7 h-7 text-muted-foreground" />
        </div>
        <h3 className="font-semibold text-foreground mb-1">No topics learned yet</h3>
        <p className="text-sm text-muted-foreground max-w-sm leading-relaxed">
          Analyze a YouTube trading video to automatically build your knowledge matrix. Topics are extracted directly from the video content.
        </p>
      </div>
    );
  }

  const avgLevel = Math.round(matrix.reduce((s, r) => s + r.level, 0) / matrix.length);
  const totalUpdates = matrix.reduce((s, r) => s + r.updateLog.length, 0);
  const expertTopics = matrix.filter((r) => r.level >= 7);
  const developingTopics = matrix.filter((r) => r.level < 7);

  return (
    <div className="space-y-8">
      {/* Overview stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-border bg-card p-4 text-center">
          <p className="text-2xl font-bold text-primary">{avgLevel}<span className="text-sm text-muted-foreground font-normal">/10</span></p>
          <p className="text-xs text-muted-foreground mt-1">Average Level</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 text-center">
          <p className="text-2xl font-bold text-amber-400">{matrix.length}</p>
          <p className="text-xs text-muted-foreground mt-1">Topics Learned</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 text-center">
          <p className="text-2xl font-bold text-[#65A30D]">{totalUpdates}</p>
          <p className="text-xs text-muted-foreground mt-1">Video Updates</p>
        </div>
      </div>

      {/* Advanced topics (level 7+) */}
      {expertTopics.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <Star className="w-4 h-4 text-amber-400" />
            <h3 className="font-semibold text-foreground text-sm">Advanced Knowledge</h3>
            <span className="text-xs text-muted-foreground">(Level 7+ — from your videos)</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {expertTopics.map((row) => (
              <TopicCard key={row.topic} row={row as TopicRow} />
            ))}
          </div>
        </div>
      )}

      {/* Developing topics */}
      {developingTopics.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <Activity className="w-4 h-4 text-[#2563EB]" />
            <h3 className="font-semibold text-foreground text-sm">Developing Topics</h3>
            <span className="text-xs text-muted-foreground">(Extracted from analyzed videos)</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {developingTopics.map((row) => (
              <TopicCard key={row.topic} row={row as TopicRow} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionCard({
  icon: Icon,
  title,
  color,
  children,
}: {
  icon: React.ElementType;
  title: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className={`flex items-center gap-2.5 px-5 py-3.5 border-b border-border ${color}`}>
        <Icon className="w-4 h-4" />
        <h2 className="font-semibold text-sm tracking-wide uppercase">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function TagList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
          <ChevronRight className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function FrequencyBadge({ freq }: { freq: string }) {
  const lower = freq.toLowerCase();
  const cls =
    lower.includes("very") || lower.includes("high")
      ? "bg-emerald-500/15 text-[#65A30D] border-emerald-500/25"
      : lower.includes("common") || lower.includes("medium")
      ? "bg-amber-500/15 text-amber-400 border-amber-500/25"
      : "bg-slate-500/15 text-slate-400 border-slate-500/25";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${cls}`}>{freq}</span>
  );
}

function MentionsBadge({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-primary/15 text-primary text-xs font-bold border border-primary/25">
      {count}
    </span>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-5">
        <Brain className="w-8 h-8 text-primary" />
      </div>
      <h2 className="text-xl font-semibold text-foreground mb-2">No Knowledge Base Yet</h2>
      <p className="text-muted-foreground text-sm max-w-sm mb-6">
        Analyze at least one YouTube trading video first, then come back here to generate your personalized trading methodology.
      </p>
      <Link href="/">
        <Button className="gap-2">
          <Youtube className="w-4 h-4" />
          Analyze a Video
        </Button>
      </Link>
    </div>
  );
}

// ─── Knowledge display ────────────────────────────────────────────────────────

function KnowledgeDisplay({
  result,
  analysisCount,
  updatedAt,
  onRegenerate,
  isRegenerating,
}: {
  result: KnowledgeResult;
  analysisCount: number;
  updatedAt: Date;
  onRegenerate: () => void;
  isRegenerating: boolean;
}) {
  return (
    <div className="space-y-6">
      {/* Meta bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Youtube className="w-3.5 h-3.5 text-primary" />
            Based on <strong className="text-foreground">{analysisCount}</strong> video{analysisCount !== 1 ? "s" : ""}
          </span>
          <span className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            Updated {new Date(updatedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })} at {new Date(updatedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-2 text-xs"
          onClick={onRegenerate}
          disabled={isRegenerating}
        >
          {isRegenerating ? (
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          Regenerate
        </Button>
      </div>

      {/* Trading style — hero card */}
      <div className="rounded-xl border border-primary/30 bg-primary/5 p-6">
        <div className="flex items-center gap-2 mb-3">
          <Brain className="w-5 h-5 text-primary" />
          <h2 className="font-bold text-base text-foreground">Trading Style</h2>
        </div>
        <p className="text-muted-foreground leading-relaxed">{result.trading_style}</p>
      </div>

      {/* Overall philosophy */}
      <SectionCard icon={BookOpen} title="Overall Philosophy" color="text-violet-400">
        <p className="text-sm text-muted-foreground leading-relaxed">{result.overall_philosophy}</p>
      </SectionCard>

      {/* 2-column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SectionCard icon={Zap} title="Preferred Strategies" color="text-amber-400">
          <div className="space-y-4">
            {result.preferred_strategies.map((s, i) => (
              <div key={i} className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">{s.name}</span>
                  <FrequencyBadge freq={s.frequency} />
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{s.description}</p>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard icon={Layers} title="Market Themes" color="text-[#2563EB]">
          <div className="space-y-4">
            {result.market_themes.map((t, i) => (
              <div key={i} className="space-y-1">
                <span className="text-sm font-semibold text-foreground">{t.theme}</span>
                <p className="text-xs text-muted-foreground leading-relaxed">{t.description}</p>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard icon={Target} title="Entry Patterns" color="text-[#65A30D]">
          <TagList items={result.entry_patterns} />
        </SectionCard>

        <SectionCard icon={Shield} title="Exit & Risk Management Rules" color="text-[#FF6B6B]">
          <TagList items={result.exit_and_risk_rules} />
        </SectionCard>
      </div>

      {/* Top tickers */}
      <SectionCard icon={TrendingUp} title="Most Tracked Tickers" color="text-primary">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left pb-3 font-medium text-muted-foreground w-24">Ticker</th>
                <th className="text-left pb-3 font-medium text-muted-foreground w-40">Company</th>
                <th className="text-left pb-3 font-medium text-muted-foreground w-20 text-center">Mentions</th>
                <th className="text-left pb-3 font-medium text-muted-foreground">Context</th>
              </tr>
            </thead>
            <tbody>
              {result.top_tickers.map((t, i) => (
                <tr key={i} className="border-b border-border/40 hover:bg-muted/20 transition-colors">
                  <td className="py-3 pr-4">
                    <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-bold bg-primary/15 text-primary border border-primary/25 tracking-wide">
                      {t.ticker}
                    </span>
                  </td>
                  <td className="py-3 pr-4 font-medium text-foreground text-sm">{t.company}</td>
                  <td className="py-3 pr-4 text-center">
                    <MentionsBadge count={t.mentions} />
                  </td>
                  <td className="py-3 text-xs text-muted-foreground leading-relaxed">{t.context}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {/* Key levels approach */}
      <SectionCard icon={BarChart2} title="Key Levels Approach" color="text-cyan-400">
        <p className="text-sm text-muted-foreground leading-relaxed">{result.key_levels_approach}</p>
      </SectionCard>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

type Tab = "methodology" | "proficiency" | "master" | "patterns";

// ─── Master Knowledge Tab Component ──────────────────────────────────────────
function MasterKnowledgeTab() {
  const { data, isLoading, refetch } = trpc.masterKnowledge.get.useQuery();
  const [activeSubTab, setActiveSubTab] = useState<"rules" | "signals" | "learning">("rules");
  const [isBoosting, setIsBoosting] = useState(false);
  const [boostResult, setBoostResult] = useState<{ enrichedCount: number; contradictions: number } | null>(null);

  const generateMutation = trpc.masterKnowledge.generate.useMutation({
    onSuccess: () => { toast.success("Master Knowledge generated!"); refetch(); },
    onError: (err) => toast.error(err.message),
  });

  const deepResearchMutation = trpc.masterKnowledge.deepResearch.useMutation({
    onSuccess: (result) => {
      setBoostResult({ enrichedCount: result.enrichedCount, contradictions: result.contradictions });
      toast.success(`🚀 ${result.enrichedCount} rules boosted to 10/10!`);
      setIsBoosting(false);
      refetch();
    },
    onError: (err) => { toast.error(err.message); setIsBoosting(false); },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground text-sm gap-2">
        <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        Loading Master Knowledge...
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center gap-4">
        <div className="w-14 h-14 rounded-2xl bg-muted border border-border flex items-center justify-center">
          <Database className="w-7 h-7 text-muted-foreground" />
        </div>
        <h3 className="font-semibold text-foreground">No Master Knowledge Yet</h3>
        <p className="text-sm text-muted-foreground max-w-sm leading-relaxed">
          Analyze at least one YouTube trading video, then generate your Master Knowledge — the single source of truth for your trading system.
        </p>
        <Button onClick={() => generateMutation.mutate()} disabled={generateMutation.isPending} className="gap-2">
          {generateMutation.isPending ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Generating...</> : <><Database className="w-4 h-4" />Generate Master Knowledge</>}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Info banner */}
      <div className="rounded-xl border border-primary/20 bg-primary/5 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <Database className="w-5 h-5 text-primary shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-foreground mb-1">Master Knowledge JSON</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {data.Technical_Rules.length} rules · {data.Active_Signals.length} signals · {data.Learning_Status.length} topics
                · Updated {new Date(data.updatedAt).toLocaleDateString("he-IL")}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              onClick={() => { setIsBoosting(true); setBoostResult(null); deepResearchMutation.mutate(); }}
              disabled={isBoosting || deepResearchMutation.isPending}
              size="sm"
              className="bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white border-0"
            >
              {isBoosting ? <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Researching...</> : <>🚀 Boost 10/10</>}
            </Button>
            <Button onClick={() => generateMutation.mutate()} disabled={generateMutation.isPending} size="sm" variant="outline">
              {generateMutation.isPending ? "Generating..." : "Regenerate"}
            </Button>
          </div>
        </div>
      </div>

      {/* Boost banners */}
      {isBoosting && (
        <div className="p-4 rounded-xl border border-violet-200 bg-violet-50 flex items-center gap-4">
          <div className="w-5 h-5 border-2 border-violet-600 border-t-transparent rounded-full animate-spin shrink-0" />
          <p className="text-sm font-semibold text-violet-900">Deep Research in progress... (30–60s)</p>
        </div>
      )}
      {boostResult && !isBoosting && (
        <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50 flex items-center justify-between gap-4">
          <p className="text-sm font-semibold text-emerald-900">🚀 {boostResult.enrichedCount} rules boosted! {boostResult.contradictions > 0 && `${boostResult.contradictions} contradictions flagged.`}</p>
          <button onClick={() => setBoostResult(null)} className="text-emerald-600 text-lg">&times;</button>
        </div>
      )}

      {/* Sub-tabs */}
      <div className="flex gap-1 p-1 rounded-xl bg-muted/40 border border-border w-fit">
        {(["rules", "signals", "learning"] as const).map((tab) => (
          <button key={tab} onClick={() => setActiveSubTab(tab)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeSubTab === tab ? "bg-card text-foreground shadow-sm border border-border" : "text-muted-foreground hover:text-foreground"
            }`}>
            {tab === "rules" && `Technical Rules (${data.Technical_Rules.length})`}
            {tab === "signals" && `Active Signals (${data.Active_Signals.length})`}
            {tab === "learning" && `Learning Status (${data.Learning_Status.length})`}
          </button>
        ))}
      </div>

      {/* Sub-tab content */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="p-5">
          {activeSubTab === "rules" && (
            data.Technical_Rules.length > 0 ? (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border">
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground uppercase">Topic</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground uppercase">Rule</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground uppercase hidden md:table-cell">Confidence</th>
                </tr></thead>
                <tbody>
                  {data.Technical_Rules.map((rule: TechnicalRule, i: number) => (
                    <tr key={i} className="border-b border-border/50 hover:bg-muted/30">
                      <td className="py-2.5 px-3 font-mono text-xs text-primary font-semibold whitespace-nowrap">{rule.topic}</td>
                      <td className="py-2.5 px-3 text-foreground text-xs leading-relaxed">{rule.rule}</td>
                      <td className="py-2.5 px-3 hidden md:table-cell">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${
                          rule.level >= 8 ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/25" :
                          rule.level >= 5 ? "bg-amber-500/15 text-amber-500 border-amber-500/25" :
                          "bg-muted text-muted-foreground border-border"
                        }`}>{rule.level}/10</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="text-muted-foreground text-sm text-center py-8">No technical rules yet.</p>
          )}
          {activeSubTab === "signals" && (
            data.Active_Signals.length > 0 ? (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border">
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground uppercase">Ticker</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground uppercase hidden sm:table-cell">Company</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground uppercase">Entry</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground uppercase">Stop</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground uppercase hidden sm:table-cell">Target</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground uppercase">Status</th>
                </tr></thead>
                <tbody>
                  {data.Active_Signals.map((s: ActiveSignal, i: number) => (
                    <tr key={i} className="border-b border-border/50 hover:bg-muted/30">
                      <td className="py-2.5 px-3 font-mono text-xs font-bold text-primary">{s.ticker}</td>
                      <td className="py-2.5 px-3 text-xs text-muted-foreground hidden sm:table-cell max-w-[120px] truncate">{s.company}</td>
                      <td className="py-2.5 px-3 text-xs font-mono text-foreground">{s.entry}</td>
                      <td className="py-2.5 px-3 text-xs font-mono text-red-500">{s.stopLoss}</td>
                      <td className="py-2.5 px-3 text-xs font-mono text-emerald-600 hidden sm:table-cell">{s.takeProfit}</td>
                      <td className="py-2.5 px-3">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded border uppercase ${
                          s.status === "active" ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/25" :
                          s.status === "watch" ? "bg-amber-500/15 text-amber-500 border-amber-500/25" :
                          "bg-muted text-muted-foreground border-border"
                        }`}>{s.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="text-muted-foreground text-sm text-center py-8">No active signals yet.</p>
          )}
          {activeSubTab === "learning" && (
            data.Learning_Status.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {data.Learning_Status.map((s: LearningStatus, i: number) => (
                  <div key={i} className="rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-foreground truncate">{s.topic}</span>
                      <span className={`text-sm font-bold tabular-nums ${
                        s.level >= 8 ? "text-emerald-600" : s.level >= 5 ? "text-amber-500" : s.level >= 3 ? "text-primary" : "text-muted-foreground"
                      }`}>{s.level}/10</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-border overflow-hidden">
                      <div className={`h-full rounded-full ${
                        s.level >= 8 ? "bg-emerald-500" : s.level >= 5 ? "bg-amber-500" : s.level >= 3 ? "bg-primary" : "bg-muted-foreground"
                      }`} style={{ width: `${(s.level / 10) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : <p className="text-muted-foreground text-sm text-center py-8">No learning data yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}


// ─── Mentor Patterns Tab ──────────────────────────────────────────────────────
const MENTOR_LABEL: Record<string, { name: string; color: string; bg: string }> = {
  cycles_trading: { name: "Ziv",        color: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200" },
  micha_stocks:   { name: "Micha",      color: "text-blue-700",   bg: "bg-blue-50 border-blue-200" },
  both:           { name: "Ziv + Micha",color: "text-amber-700",  bg: "bg-amber-50 border-amber-200" },
};

function MentorPatternsTab() {
  const [mentor, setMentor] = useState<"all" | "cycles_trading" | "micha_stocks">("all");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const { data, isLoading, refetch } = trpc.insights.listPatterns.useQuery(
    { mentor: mentor === "all" ? "all" : mentor },
    { refetchOnWindowFocus: false }
  );
  const { data: insightsData } = trpc.insights.getSummaryStats.useQuery();

  const patterns = (data?.patterns ?? []) as unknown as {
    id: number; mentor: string; patternName: string; description: string;
    occurrences: number; successRate: number | null; avgReturn: number | null;
    tickers: string | null; lastSeenAt: string;
  }[];

  const toggle = (id: number) =>
    setExpanded(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  return (
    <div className="space-y-6">
      {/* Info banner */}
      <div className="rounded-xl border border-violet-200 bg-violet-50 p-4 flex items-start gap-3">
        <Lightbulb className="w-5 h-5 text-violet-600 mt-0.5 shrink-0" />
        <div>
          <p className="text-sm font-semibold text-violet-800 mb-1">למידה מתמשכת מסרטוני זיו ומיכה</p>
          <p className="text-xs text-violet-700 leading-relaxed">
            כל ניתוח סרטון חדש מאמן את המנוע מחדש — הדפוסים כאן מבוססים על {insightsData?.patterns ?? 0} תבניות
            שחולצו מהסרטונים. כשדפוס חוזר יותר פעמים, הציון שלו במנוע המסחר עולה אוטומטית.
          </p>
        </div>
      </div>

      {/* Mentor filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1 p-1 rounded-xl bg-muted/40 border border-border w-fit">
          {([["all","הכל"], ["cycles_trading","Ziv"], ["micha_stocks","Micha"]] as const).map(([v,l]) => (
            <button key={v} onClick={() => setMentor(v)}
              className={`text-sm px-3 py-1.5 rounded-lg font-medium transition-all ${
                mentor === v ? "bg-card text-foreground shadow-sm border border-border" : "text-muted-foreground hover:text-foreground"
              }`}>{l}</button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">{patterns.length} דפוסים נלמדו</span>
        <button onClick={() => refetch()}
          className="mr-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground border border-border rounded-lg px-2 py-1">
          <RefreshCw className="w-3 h-3" /> רענן
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
          <RefreshCw className="w-4 h-4 animate-spin" /> טוען דפוסים...
        </div>
      ) : patterns.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
          <Lightbulb className="w-10 h-10 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">
            הסוכן ילמד דפוסים אחרי ניתוח מספר סרטונים.<br />
            הפעל את הניתוח מדף Videos.
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {patterns.map(p => {
            const tickers: string[] = (() => { try { return JSON.parse(p.tickers ?? "[]"); } catch { return []; } })();
            const meta = MENTOR_LABEL[p.mentor] ?? MENTOR_LABEL.cycles_trading;
            const isExp = expanded.has(p.id);

            return (
              <div key={p.id} className="rounded-xl border border-border bg-card shadow-sm">
                <div className="flex items-center gap-3 px-4 py-3">
                  <Lightbulb className="w-4 h-4 text-violet-500 shrink-0" />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-foreground text-sm">{p.patternName}</span>
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-lg border ${meta.bg} ${meta.color}`}>
                        {meta.name}
                      </span>
                      <span className="text-xs text-muted-foreground">{p.occurrences}× נצפה</span>
                      {p.successRate != null && (
                        <span className={`text-xs font-medium ${p.successRate >= 60 ? "text-emerald-600" : "text-orange-500"}`}>
                          הצלחה: {p.successRate.toFixed(0)}%
                        </span>
                      )}
                    </div>
                    {tickers.length > 0 && (
                      <div className="flex gap-1 flex-wrap mt-1.5">
                        {tickers.slice(0, 8).map(t => (
                          <span key={t} className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded font-mono">{t}</span>
                        ))}
                        {tickers.length > 8 && <span className="text-[10px] text-muted-foreground">+{tickers.length - 8}</span>}
                      </div>
                    )}
                  </div>

                  {/* Bar */}
                  <div className="hidden md:flex items-center gap-2 w-28">
                    <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div className="h-full bg-violet-500 rounded-full"
                        style={{ width: `${Math.min(100, (p.occurrences / 10) * 100)}%` }} />
                    </div>
                    <span className="text-xs text-muted-foreground w-4 text-right">{p.occurrences}</span>
                  </div>

                  <button onClick={() => toggle(p.id)}
                    className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                    {isExp ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                </div>

                {isExp && (
                  <div className="border-t border-border px-5 py-3 bg-muted/30 rounded-b-xl">
                    <p className="text-sm text-foreground/80 leading-relaxed">{p.description}</p>
                    <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      נצפה לאחרונה: {new Date(p.lastSeenAt).toLocaleDateString("he-IL")}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function KnowledgeBase() {
  const { user, isAuthenticated, loading: authLoading } = useAuth();
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isBoosting, setIsBoosting] = useState(false);
  const [boostResult, setBoostResult] = useState<{ enrichedCount: number; contradictions: number } | null>(null);
  const search = useSearch();
  const initialTab = new URLSearchParams(search).get("tab") as Tab | null;
  const [activeTab, setActiveTab] = useState<Tab>(initialTab === "master" ? "master" : initialTab === "proficiency" ? "proficiency" : initialTab === "patterns" ? "patterns" : "methodology");

  const { data: kb, isLoading, refetch } = trpc.knowledgeBase.get.useQuery(undefined, {
    enabled: isAuthenticated,
  });

  const generateMutation = trpc.knowledgeBase.generate.useMutation({
    onSuccess: () => {
      toast.success("Knowledge base updated!");
      refetch();
      setIsRegenerating(false);
    },
    onError: (err) => {
      toast.error(err.message);
      setIsRegenerating(false);
    },
  });

  const handleGenerate = () => {
    setIsRegenerating(true);
    generateMutation.mutate();
  };

  const deepResearchMutation = trpc.masterKnowledge.deepResearch.useMutation({
    onSuccess: (data) => {
      setBoostResult({ enrichedCount: data.enrichedCount, contradictions: data.contradictions });
      toast.success(`🚀 ${data.enrichedCount} rules boosted to 10/10! ${data.contradictions} mentor contradictions found.`);
      setIsBoosting(false);
    },
    onError: (err) => {
      toast.error(err.message);
      setIsBoosting(false);
    },
  });

  const handleBoost = () => {
    setIsBoosting(true);
    setBoostResult(null);
    deepResearchMutation.mutate();
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
        <Brain className="w-12 h-12 text-primary opacity-60" />
        <p className="text-muted-foreground text-sm">Sign in to view your trading knowledge base</p>
        <Button asChild>
          <a href="/login">
            <LogIn className="w-4 h-4 mr-2" />
            Sign In
          </a>
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-16 z-[100]">
        <div className="container flex items-center justify-between h-14">
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors text-sm">
              <TrendingUp className="w-4 h-4 text-primary" />
              <span className="font-semibold text-foreground">Trading Analyzer</span>
            </Link>
            <span className="text-border">/</span>
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Brain className="w-4 h-4 text-primary" />
              Knowledge Base
            </span>
          </div>
          <div className="flex items-center gap-3">
            {user && (
              <span className="text-xs text-muted-foreground hidden sm:block">
                {user.name ?? user.email}
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Page content */}
      <main className="container py-8 max-w-5xl">
        {/* Page title + generate button */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2.5 mb-1">
              <Brain className="w-6 h-6 text-primary" />
              Your Trading Knowledge Base
            </h1>
            <p className="text-sm text-muted-foreground">
              AI-synthesized trading methodology and proficiency matrix built from all your analyzed videos
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!kb && !isLoading && activeTab === "methodology" && (
              <Button onClick={handleGenerate} disabled={isRegenerating} className="gap-2">
                {isRegenerating ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Brain className="w-4 h-4" />
                )}
                {isRegenerating ? "Generating..." : "Generate Knowledge Base"}
              </Button>
            )}
            {kb && (
              <Button
                onClick={handleBoost}
                disabled={isBoosting}
                className="gap-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white border-0 shadow-md"
              >
                {isBoosting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Deep Researching...
                  </>
                ) : (
                  <>
                    <span className="text-base">🚀</span>
                    Boost to 10/10 Proficiency
                  </>
                )}
              </Button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 p-1 rounded-xl bg-muted/40 border border-border mb-8 w-fit">
          <button
            onClick={() => setActiveTab("methodology")}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === "methodology"
                ? "bg-card text-foreground shadow-sm border border-border"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <BookOpen className="w-4 h-4" />
            Trading Methodology
          </button>
          <button
            onClick={() => setActiveTab("proficiency")}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === "proficiency"
                ? "bg-card text-foreground shadow-sm border border-border"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <GraduationCap className="w-4 h-4" />
            AI Proficiency Matrix
            <span className="text-xs bg-primary/15 text-primary border border-primary/25 rounded px-1.5 py-0.5">15 Topics</span>
          </button>
          <button
            onClick={() => setActiveTab("master")}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === "master"
                ? "bg-card text-foreground shadow-sm border border-border"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Database className="w-4 h-4" />
            Master Knowledge
          </button>
          <button
            onClick={() => setActiveTab("patterns")}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === "patterns"
                ? "bg-card text-foreground shadow-sm border border-border"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Lightbulb className="w-4 h-4" />
            דפוסי מנטורים
          </button>
        </div>

        {/* Boost progress banner */}
        {isBoosting && (
          <div className="mb-6 p-4 rounded-xl border border-violet-200 bg-violet-50 flex items-center gap-4">
            <div className="w-10 h-10 rounded-full bg-violet-100 border border-violet-200 flex items-center justify-center shrink-0">
              <div className="w-5 h-5 border-2 border-violet-600 border-t-transparent rounded-full animate-spin" />
            </div>
            <div>
              <p className="font-semibold text-violet-900 text-sm">Deep Research in progress...</p>
              <p className="text-xs text-[#2563EB] mt-0.5">The AI is consulting W.D. Gann manuscripts, CMT curriculum, CFA Institute research, and institutional whitepapers. This may take 30–60 seconds.</p>
            </div>
          </div>
        )}

        {/* Boost result card */}
        {boostResult && !isBoosting && (
          <div className="mb-6 p-4 rounded-xl border border-emerald-200 bg-emerald-50 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🚀</span>
              <div>
                <p className="font-semibold text-emerald-900 text-sm">{boostResult.enrichedCount} rules boosted to 10/10 Proficiency</p>
                <p className="text-xs text-[#65A30D] mt-0.5">
                  Enriched with institutional research.
                  {boostResult.contradictions > 0 && (
                    <span className="ml-1 text-amber-400 font-medium">{boostResult.contradictions} mentor contradiction{boostResult.contradictions !== 1 ? "s" : ""} flagged — check Technical Rules for details.</span>
                  )}
                </p>
              </div>
            </div>
            <button onClick={() => setBoostResult(null)} className="text-[#65A30D] hover:text-[#65A30D] text-lg leading-none">&times;</button>
          </div>
        )}

        {/* Tab: Methodology */}
        {activeTab === "methodology" && (
          <>
            {isLoading && (
              <div className="flex flex-col items-center justify-center py-24 gap-3 text-muted-foreground">
                <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                <p className="text-sm">Loading knowledge base...</p>
              </div>
            )}

            {isRegenerating && !kb && (
              <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
                <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <Brain className="w-8 h-8 text-primary animate-pulse" />
                </div>
                <div>
                  <p className="font-semibold text-foreground mb-1">Synthesizing your trading methodology...</p>
                  <p className="text-sm text-muted-foreground">The AI is reading all your video analyses and building your knowledge base</p>
                </div>
              </div>
            )}

            {!isLoading && !isRegenerating && !kb && <EmptyState />}

            {!isLoading && kb && (
              <KnowledgeDisplay
                result={kb.result}
                analysisCount={kb.analysisCount}
                updatedAt={kb.updatedAt}
                onRegenerate={handleGenerate}
                isRegenerating={isRegenerating}
              />
            )}
          </>
        )}

        {/* Tab: Proficiency Matrix */}
        {activeTab === "proficiency" && (
          <div className="space-y-6">
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-5">
              <div className="flex items-start gap-3">
                <GraduationCap className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                <div>
                  <h3 className="font-semibold text-foreground mb-1">AI Technical Knowledge Proficiency Matrix</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    This matrix tracks the AI's learning level (1–10) across 15 technical analysis topics, updated automatically each time you analyze a new video. 
                    At <strong className="text-foreground">Level 8+</strong>, analyses become more sophisticated — identifying divergences, hidden traps, and complex patterns.
                    <span className="inline-flex items-center gap-1 ml-2 text-amber-400"><Star className="w-3 h-3" /> = Big 5 priority topics</span>
                  </p>
                </div>
              </div>
            </div>

            <ProficiencyMatrix />
          </div>
        )}

        {/* Tab: Master Knowledge */}
        {activeTab === "master" && <MasterKnowledgeTab />}

        {/* Tab: Mentor Patterns — AI learning from Ziv & Micha */}
        {activeTab === "patterns" && <MentorPatternsTab />}
      </main>
    </div>
  );
}
