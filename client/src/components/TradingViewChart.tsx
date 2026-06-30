/**
 * TradingViewChart — Embeds a TradingView Advanced Chart widget for a given ticker.
 * Shows the chart with full toolbars (drawing tools, indicators, side panel).
 *
 * v5 fix: Both srcDoc and S3 external-embedding approaches fail because TradingView's
 * S3 bucket returns "AccessDenied" for non-TradingView referrers.
 * Solution: Use TradingView's widgetembed endpoint directly as iframe src.
 * This loads the chart from www.tradingview.com (not S3) and works reliably.
 */
import { memo, useState, useEffect } from "react";

export interface TradingViewChartProps {
  ticker: string;
  /** Recommended buy price — shown as a horizontal line */
  buyPrice?: number;
  /** Stop loss price — shown as a horizontal line */
  stopLoss?: number;
  /** EMA-50 level */
  ema50?: number;
  /** EMA-200 level */
  ema200?: number;
  /** Height of the chart container */
  height?: number;
  /** TradingView interval: "D" = daily, "W" = weekly, "60" = 1h */
  interval?: "D" | "W" | "60" | "30" | "15";
  /** Theme */
  theme?: "light" | "dark";
}

/**
 * Convert a Yahoo Finance ticker to TradingView symbol format.
 * Israeli stocks (.TA suffix) → TASE:TICKER (e.g. QLTU.TA → TASE:QLTU)
 * London stocks (.L suffix) → LSE:TICKER (e.g. SHEL.L → LSE:SHEL)
 * All others passed through unchanged.
 */
export function toTradingViewSymbol(ticker: string): string {
  if (ticker.toUpperCase().endsWith(".TA")) {
    return `TASE:${ticker.slice(0, -3).toUpperCase()}`;
  }
  if (ticker.toUpperCase().endsWith(".L")) {
    return `LSE:${ticker.slice(0, -2).toUpperCase()}`;
  }
  return ticker;
}

/** Detect mobile viewport (< 768px) */
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < 768 : false
  );
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return isMobile;
}

function TradingViewChartInner({
  ticker,
  height = 500,
  interval = "D",
  theme = "dark",
}: TradingViewChartProps) {
  const tvSymbol = toTradingViewSymbol(ticker);
  const isMobile = useIsMobile();

  // Responsive height: mobile gets 380px minimum for usability
  const effectiveHeight = isMobile ? Math.max(Math.min(height, 380), 380) : height;

  // Generate a unique frame element ID
  const frameId = `tradingview_${ticker.replace(/[^a-zA-Z0-9]/g, "_")}`;

  // Build the TradingView widgetembed URL (loads from www.tradingview.com, not S3)
  const params = new URLSearchParams({
    frameElementId: frameId,
    symbol: tvSymbol,
    interval: interval,
    theme: theme,
    style: "1",
    locale: "en",
    timezone: "exchange",
    allow_symbol_change: "true",
    hide_top_toolbar: isMobile ? "true" : "false",
    hide_side_toolbar: isMobile ? "true" : "false",
    hide_legend: "false",
    save_image: "false",
    calendar: "false",
    withdateranges: isMobile ? "false" : "true",
    details: "false",
    hotlist: "false",
    enable_publishing: "false",
  });

  // Add EMA study for desktop
  if (!isMobile) {
    params.append("studies", "STD;EMA");
  }

  const embedUrl = `https://www.tradingview.com/widgetembed/?${params.toString()}`;

  return (
    <div
      className="w-full rounded-lg overflow-hidden border border-border"
      style={{
        height: effectiveHeight,
        minWidth: 280,
        WebkitOverflowScrolling: "touch",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <iframe
        id={frameId}
        key={`${ticker}-${interval}-${theme}`}
        src={embedUrl}
        style={{
          width: "100%",
          height: "100%",
          border: "none",
          display: "block",
        }}
        allowFullScreen
        loading="eager"
        title={`TradingView Chart — ${ticker}`}
      />
    </div>
  );
}

export const TradingViewChart = memo(TradingViewChartInner);

// ─── Analysis Overlay Info ────────────────────────────────────────────────────
/**
 * Shows key price levels as a legend below the chart.
 * TradingView free widget doesn't support programmatic line drawing,
 * so we show the levels as a clear visual legend instead.
 */
export function AnalysisLevelsLegend({
  ticker,
  currentPrice,
  buyPrice,
  stopLoss,
  ema50,
  ema200,
  takeProfit,
}: {
  ticker: string;
  currentPrice?: number;
  buyPrice?: number;
  stopLoss?: number;
  ema50?: number;
  ema200?: number;
  takeProfit?: number;
}) {
  const levels = [
    currentPrice != null && {
      label: "Current Price",
      value: currentPrice,
      color: "text-foreground",
      bg: "bg-muted/40 border-border",
      dot: "bg-gray-500",
    },
    buyPrice != null && {
      label: "Buy Zone",
      value: buyPrice,
      color: "text-[#65A30D]",
      bg: "bg-emerald-50 border-emerald-200",
      dot: "bg-emerald-500",
    },
    stopLoss != null && {
      label: "Stop Loss",
      value: stopLoss,
      color: "text-[#FF6B6B]",
      bg: "bg-red-50 border-red-200",
      dot: "bg-red-500",
    },
    takeProfit != null && {
      label: "Take Profit",
      value: takeProfit,
      color: "text-violet-700",
      bg: "bg-violet-50 border-violet-200",
      dot: "bg-violet-500",
    },
    ema50 != null && {
      label: "EMA-50",
      value: ema50,
      color: "text-blue-700",
      bg: "bg-blue-50 border-blue-200",
      dot: "bg-blue-400",
    },
    ema200 != null && {
      label: "EMA-200",
      value: ema200,
      color: "text-amber-400",
      bg: "bg-amber-50 border-amber-200",
      dot: "bg-amber-400",
    },
  ].filter(Boolean) as Array<{
    label: string; value: number; color: string; bg: string; dot: string;
  }>;

  if (levels.length === 0) return null;

  // Sort by price descending
  levels.sort((a, b) => b.value - a.value);

  return (
    <div className="mt-3">
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Key Levels — {ticker}</span>
        <span className="text-[10px] text-muted-foreground">(use these as reference lines on the chart above)</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {levels.map((level) => (
          <div
            key={level.label}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs ${level.bg}`}
          >
            <span className={`w-2 h-2 rounded-full shrink-0 ${level.dot}`} />
            <span className={`font-semibold ${level.color}`}>${level.value.toFixed(2)}</span>
            <span className={`font-semibold ${level.color}`}>{level.label}</span>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground mt-2">
        💡 Tip: On the TradingView chart, use the horizontal line tool (hotkey: Alt+H) to draw these levels manually.
      </p>
    </div>
  );
}
