/**
 * TickerLink
 *
 * A reusable component that renders a ticker symbol as a clickable link.
 * Clicking it navigates to /deep-analysis/:ticker (full standalone page).
 *
 * Usage:
 *   <TickerLink ticker="AAPL" />
 *   <TickerLink ticker="AAPL" className="text-white font-bold text-lg" />
 *   <TickerLink ticker="AAPL" variant="plain" />   // no badge styling
 */
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";

interface TickerLinkProps {
  ticker: string;
  /** Visual style preset */
  variant?: "badge" | "plain" | "gold";
  className?: string;
  /** Extra content rendered after the ticker text (e.g. price) */
  children?: React.ReactNode;
}

export function TickerLink({ ticker, variant = "plain", className, children }: TickerLinkProps) {
  const [, navigate] = useLocation();

  const baseStyles = "cursor-pointer select-none transition-colors";
  const variantStyles: Record<string, string> = {
    badge:
      "inline-flex items-center px-2.5 py-1 rounded-md text-xs font-bold bg-primary/15 text-primary border border-primary/25 tracking-wide hover:bg-primary/25",
    plain:
      "font-bold font-mono hover:text-[#2563EB] hover:underline underline-offset-2",
    gold:
      "font-bold font-mono text-[#2563EB] hover:underline underline-offset-2",
  };

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        navigate(`/deep-analysis/${encodeURIComponent(ticker)}`);
      }}
      className={cn(baseStyles, variantStyles[variant] ?? variantStyles.plain, className)}
      title={`Deep Analysis: ${ticker}`}
    >
      {ticker}
      {children}
    </button>
  );
}
