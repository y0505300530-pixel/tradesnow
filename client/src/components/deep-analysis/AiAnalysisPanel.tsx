import { Loader2, Lightbulb, Zap } from "lucide-react";
import type { DeepAnalysisResult, HoldingContext } from "./types";

export function AiAnalysisPanel({
  result,
  holdingContext,
  streamingText,
}: {
  result: DeepAnalysisResult;
  holdingContext?: HoldingContext;
  streamingText: string | null;
}) {
  return (
    <div className="space-y-3">
      <div className="p-4 bg-muted/20 border rounded-xl">
        <div className="flex items-center gap-1.5 mb-3">
          <Lightbulb className="h-4 w-4 text-[#2563EB]" />
          <span className="text-sm font-semibold">AI Analysis</span>
          {streamingText !== null && !(result.ai.summary && result.ai.positionRationale && result.ai.risks && result.ai.actionTrigger) && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[#2563EB] ml-1" />
          )}
        </div>
        {streamingText !== null && !result.ai.summary ? (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">
            {streamingText || <span className="text-muted-foreground animate-pulse">ה-AI מנתח עכשיו...</span>}
          </p>
        ) : (
          <div className="space-y-3 text-sm leading-relaxed">
            {result.ai.summary && <p className="text-foreground">{result.ai.summary}</p>}
            {result.ai.positionRationale && (
              <div>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  {holdingContext ? "ניתוח הפוזיציה" : "Entry Rationale"}
                </span>
                <p className="mt-1 text-foreground">{result.ai.positionRationale}</p>
              </div>
            )}
            {result.ai.risks && (
              <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                <span className="text-xs font-semibold text-amber-400 uppercase tracking-wide">Key Risks</span>
                <p className="mt-1 text-amber-800">{result.ai.risks}</p>
              </div>
            )}
            {result.ai.actionTrigger && (
              <div className="flex items-start gap-1.5">
                <Zap className="h-3.5 w-3.5 text-[#2563EB] mt-0.5 shrink-0" />
                <div>
                  <span className="text-xs font-semibold text-blue-700">
                    {holdingContext ? "טריגר לפעולה הבאה" : "Ideal Entry Trigger"}
                  </span>
                  <p className="mt-0.5 text-blue-800">{result.ai.actionTrigger}</p>
                </div>
              </div>
            )}
            {streamingText !== null && (!result.ai.positionRationale || !result.ai.risks || !result.ai.actionTrigger) && (
              <div className="space-y-1.5">
                <div className="h-3 bg-muted/60 rounded animate-pulse w-full" />
                <div className="h-3 bg-muted/60 rounded animate-pulse w-4/5" />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
