/**
 * ZivHBadge — ZIV H Health Score display badge
 *
 * Extracted from TradeManager.tsx as part of the modular refactoring (Step 3).
 * Displays a color-coded badge for the ZIV H position health score (0–10),
 * with tier label and tooltip showing the suggested action and details.
 */

import type { ZivHData } from "../types";

export function ZivHBadge({ data }: { data: ZivHData }) {
  if (!data) return <span className="text-muted-foreground text-xs">—</span>;

  const { score, tier } = data;
  const hiddenDistribution = (data.penalties as Record<string, boolean>)?.hiddenDistribution === true;
  const slMode = data.slMode;
  const tpMode = data.tpMode;

  const color =
    score >= 8
      ? "bg-emerald-50 text-emerald-800 border-emerald-300"
      : score >= 6
      ? "bg-blue-100 text-blue-800 border-blue-300"
      : score >= 4
      ? "bg-amber-50 text-amber-800 border-amber-300"
      : "bg-red-50 text-red-700 border-red-300";

  const icon =
    score >= 8 ? "🔥" : score >= 6 ? "⭐" : score >= 4 ? "⚠️" : "❌";

  // SL mode badge colors
  const slModeStyle = slMode === "Trailing"
    ? "bg-orange-100 text-orange-700 border-orange-300"
    : slMode === "Winners"
    ? "bg-emerald-100 text-emerald-700 border-emerald-300"
    : null; // Static = no badge

  // TP mode badge colors
  const tpModeStyle = tpMode === "Escape"
    ? "bg-red-100 text-red-700 border-red-300"
    : tpMode === "Extension"
    ? "bg-purple-100 text-purple-700 border-purple-300"
    : null; // Static = no badge

  return (
    <div
      className="flex flex-col items-center gap-0.5"
      title={`${data.suggestedAction}\n${data.details}${hiddenDistribution ? '\n\n⚠️ Hidden Distribution: מוסדיים מוכרים בשקט בזמן שהמחיר יציב' : ''}${slMode && slMode !== 'Static' ? `\nSL Mode: ${slMode}` : ''}${tpMode && tpMode !== 'Static' ? `\nTP Mode: ${tpMode}` : ''}`}
    >
      <span
        className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[10px] font-bold ${color}`}
      >
        {icon} {score.toFixed(1)}
        {hiddenDistribution && (
          <span
            className="ml-0.5 text-[9px] text-orange-500"
            title="Hidden Distribution — OBV declining while price stable"
          >
            ⚠️
          </span>
        )}
      </span>
      <span className="text-[9px] text-muted-foreground leading-tight text-center max-w-[72px] truncate">
        {tier}
      </span>
      {/* SL/TP Mode badges — only shown when not Static */}
      {(slModeStyle || tpModeStyle) && (
        <div className="flex items-center gap-0.5 flex-wrap justify-center">
          {slModeStyle && (
            <span className={`inline-flex items-center px-1 py-0 rounded border text-[8px] font-semibold ${slModeStyle}`}
              title={`SL Mode: ${slMode}`}>
              SL:{slMode}
            </span>
          )}
          {tpModeStyle && (
            <span className={`inline-flex items-center px-1 py-0 rounded border text-[8px] font-semibold ${tpModeStyle}`}
              title={`TP Mode: ${tpMode}`}>
              TP:{tpMode}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
