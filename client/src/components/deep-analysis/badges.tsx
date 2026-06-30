import { Badge } from "@/components/ui/badge";
import { AlertCircle, CheckCircle2, XCircle as XCircleIcon } from "lucide-react";
import type { ZivTier } from "@/components/deep-analysis/types";

export function ScoreBadge({ score }: { score: number | null }) {
  if (score === null || score === undefined) return <span className="text-muted-foreground text-xs">—</span>;
  const bg = score >= 8 ? "bg-emerald-100 text-emerald-700 border-emerald-300"
    : score >= 6 ? "bg-blue-100 text-blue-700 border-blue-300"
    : score >= 4 ? "bg-amber-100 text-amber-700 border-amber-300"
    : "bg-red-100 text-red-700 border-red-300";
  const display = typeof score === "number" ? score.toFixed(2) : score;
  return (
    <span className={`inline-flex items-center justify-center min-w-[3.5rem] h-7 px-2 rounded-full text-sm font-black border-2 shadow-sm ${bg}`}>
      {display}
    </span>
  );
}

export function TierBadge({ tier }: { tier: ZivTier | null }) {
  if (!tier) return <span className="text-muted-foreground text-xs">—</span>;
  const cls = tier === "Gold Breakout" ? "bg-emerald-100 text-emerald-700 border-emerald-300"
    : tier === "Gold Retest" ? "bg-blue-100 text-blue-700 border-blue-300"
    : tier === "Near Entry Watch" ? "bg-amber-100 text-amber-700 border-amber-300"
    : "bg-red-100 text-red-700 border-red-300";
  return <Badge variant="outline" className={`text-sm font-bold px-3 py-0.5 border-2 ${cls}`}>{tier}</Badge>;
}

export function RecommendationBadge({ rec }: { rec: string }) {
  const r = rec.toUpperCase();
  const keyword = (() => {
    if (r.includes("STRONG BUY")) return "STRONG BUY";
    if (r.includes("ENTER NOW")) return "ENTER NOW";
    if (r.includes("STRONG HOLD")) return "STRONG HOLD";
    if (r.includes("ADD")) return "ADD";
    if (r.includes("REDUCE")) return "REDUCE";
    if (r.includes("EXIT")) return "EXIT";
    if (r.includes("WAIT")) return "WAIT";
    if (r.includes("HOLD")) return "HOLD";
    return rec.split(/[\s\-—,]/)[0].toUpperCase();
  })();
  const cls = keyword === "STRONG BUY" || keyword === "ENTER NOW" || keyword === "ADD"
    ? "bg-[#65A30D] text-white border-[#17a87e]"
    : keyword === "WAIT" || keyword === "HOLD" || keyword === "STRONG HOLD"
    ? "bg-amber-500 text-white border-amber-600"
    : "bg-red-500 text-white border-red-600";
  const icon = keyword === "STRONG BUY" || keyword === "ENTER NOW" || keyword === "ADD"
    ? <CheckCircle2 className="h-3.5 w-3.5" />
    : keyword === "WAIT" || keyword === "HOLD" || keyword === "STRONG HOLD"
    ? <AlertCircle className="h-3.5 w-3.5" />
    : <XCircleIcon className="h-3.5 w-3.5" />;
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-sm font-black border-2 shadow-sm ${cls}`}>
      {icon}
      {keyword}
    </span>
  );
}
