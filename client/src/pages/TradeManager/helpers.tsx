/**
 * TradeManager — UI Helper Functions
 *
 * Pure functions for color coding, icons, and formatting used
 * throughout the Trade Manager feature.
 *
 * Extracted from TradeManager.tsx as part of the modular refactoring (Step 2).
 *
 * NOTE: urgencyIcon uses JSX — it imports React and Lucide icons.
 * All other helpers are pure string functions with no side effects.
 */

import React from "react";
import { AlertTriangle, CheckCircle } from "lucide-react";

// ─── Color Helpers ────────────────────────────────────────────────────────────

/** Returns a Tailwind text-color class based on P&L percentage. */
export const pnlColor = (pct: number): string =>
  pct >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]";

/** Returns a Tailwind badge class set based on action string (BUY/SELL/HOLD/etc). */
export const actionColor = (action: string): string => {
  const a = action.toUpperCase();
  if (a.includes("EXIT") || a.includes("SELL")) return "bg-red-900/30 text-red-700 border-red-200";
  if (a.includes("HOLD")) return "bg-blue-50 text-blue-700 border-blue-200";
  if (a.includes("REDUCE")) return "bg-amber-50 text-amber-400 border-amber-200";
  if (a.includes("BUY") || a.includes("ADD")) return "bg-emerald-50 text-[#65A30D] border-emerald-200";
  return "bg-gray-100 text-gray-600";
};

/** Returns a Tailwind text-color class based on Ziv Engine score (0–10). */
export const scoreColor = (score: number): string => {
  if (score >= 8) return "text-[#65A30D] font-bold";
  if (score >= 6) return "text-[#2563EB] font-semibold";
  if (score >= 4) return "text-amber-600";
  return "text-[#FF6B6B]";
};

/** Returns a Tailwind text-color class based on ZIV H Health score (0–10). */
export const healthColor = (score: number): string => {
  if (score >= 8) return "text-[#65A30D]";
  if (score >= 6) return "text-[#2563EB]";
  if (score >= 4) return "text-amber-500";
  return "text-[#FF6B6B]";
};

// ─── Icon Helpers ─────────────────────────────────────────────────────────────

/** Returns a Lucide icon element based on urgency string (high/low/medium). */
export const urgencyIcon = (urgency: string): React.ReactElement => {
  if (urgency?.toLowerCase() === "high")
    return <AlertTriangle className="h-3.5 w-3.5 text-[#FF6B6B]" />;
  if (urgency?.toLowerCase() === "low")
    return <CheckCircle className="h-3.5 w-3.5 text-[#65A30D]" />;
  return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />;
};
