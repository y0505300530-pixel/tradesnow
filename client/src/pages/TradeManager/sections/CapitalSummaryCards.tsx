/**
 * CapitalSummaryCards — Portfolio summary rows
 *
 * All three rows (H1, H2, Unified) use the SAME 5-column layout:
 *   Col 1: Portfolio Value (main value card — colored)
 *   Col 2: Today P&L
 *   Col 3: Cash Balance / Cost Basis
 *   Col 4: Holdings P&L
 *   Col 5: Real Balance / extra metric (admin) or Total Cost
 *
 * Every cell is always rendered so the grid stays perfectly aligned.
 */
import { memo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { pnlColor } from "../helpers";
import type { Holding } from "../types";
import type { PortfolioMetrics } from "@/hooks/usePortfolioMetrics";

// ─── Types ────────────────────────────────────────────────────────────────────

interface H2Row {
  ticker: string;
  units: number;
  buyPrice: number;
  currentPrice: number | null;
  prevClose?: number | null;
  dailyChangePercent?: number | null;
}

interface CapitalSummaryCardsProps {
  holdingsWithLive: Holding[];
  holdingLivePriceMap: Record<string, {
    price: number | null;
    change: number | null;
    changePercent: number | null;
    prevClose?: number | null;
    isExtendedHours?: boolean;
  }>;
  totalValue: number;
  totalPnl: number;
  totalPnlPct: number;
  totalCost: number;
  cashBalance: number;
  grandTotal: number;
  displayNLV: number | null;
  ibkrTodayPnl: number | null;
  summarySource: string | undefined;
  summaryIsLive: boolean;
  summaryIsCached: boolean;
  lastIbkrSyncAt: Date | null;
  isAdmin: boolean;
  h2Data?: H2Row[] | null;
  h2LivePriceMap?: Record<string, { price: number | null; change: number | null; changePercent: number | null; prevClose?: number | null }>;
  /** SSOT: centralized metrics from usePortfolioMetrics. When provided, overrides local calculations. */
  portfolioMetrics?: PortfolioMetrics;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pnlSign(v: number) { return v >= 0 ? "+" : "-"; }
function fmtUsd(v: number) {
  return `$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
function fmtPct(v: number | null | undefined) { if (v == null) return "—"; return `${pnlSign(v)}${v.toFixed(2)}%`; }

// ─── Card atoms ───────────────────────────────────────────────────────────────

function ValueCard({ label, value, sub }: {
  label: string; value: string; sub?: string; gradient?: string;
}) {
  return (
    <div
      className="rounded-xl overflow-hidden relative"
      style={{
        background: "linear-gradient(135deg, #FFFFFF 0%, #F4F6F8 100%)",
        border: "1px solid rgba(37,99,235,0.40)",
        boxShadow: "0 0 20px rgba(37,99,235,0.12), inset 0 1px 0 rgba(37,99,235,0.15)",
      }}
    >
      <div className="absolute inset-0 opacity-5" style={{ backgroundImage: "radial-gradient(circle at 80% 20%, #2563EB 0%, transparent 60%)" }} />
      <div className="pt-4 pb-4 px-4 relative">
        <p className="text-[11px] font-bold uppercase tracking-widest" style={{ color: "rgba(37,99,235,0.75)" }}>{label}</p>
        <p className="text-2xl font-extrabold mt-1" style={{ color: "#3B82F6" }}>{value}</p>
        {sub && <p className="text-xs mt-0.5" style={{ color: "#4A5568" }}>{sub}</p>}
      </div>
    </div>
  );
}

function MetricCard({ label, value, sub, valueClass }: {
  label: string; value: string; sub?: string; valueClass: string;
}) {
  return (
    <div
      className="rounded-xl hover:shadow-lg transition-shadow"
      style={{
        background: "#FFFFFF",
        border: "1px solid rgba(37,99,235,0.18)",
      }}
    >
      <div className="pt-4 pb-4 px-4">
        <p className="text-[11px] font-bold uppercase tracking-widest" style={{ color: "rgba(37,99,235,0.55)" }}>{label}</p>
        <p className={`text-2xl font-extrabold mt-1 ${valueClass}`}>{value}</p>
        {sub && <p className={`text-xs mt-0.5 font-medium ${valueClass}`}>{sub}</p>}
      </div>
    </div>
  );
}

function RowLabel({ label }: { label: string; color?: string }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: "#2563EB" }}>{label}</span>
      <div className="flex-1 h-px" style={{ background: "rgba(37,99,235,0.25)" }} />
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export const CapitalSummaryCards = memo(function CapitalSummaryCards({
  holdingsWithLive,
  holdingLivePriceMap,
  totalValue,
  totalPnl,
  totalPnlPct,
  totalCost,
  cashBalance,
  grandTotal,
  displayNLV,
  ibkrTodayPnl,
  summarySource,
  summaryIsLive,
  summaryIsCached,
  lastIbkrSyncAt,
  isAdmin,
  h2Data,
  h2LivePriceMap,
  portfolioMetrics,
}: CapitalSummaryCardsProps) {
  const isIbkrLive = summarySource === "ibind" || summarySource === "ibeam";

  const syncLabel = lastIbkrSyncAt
    ? lastIbkrSyncAt.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })
    : null;

  // ── SSOT: use portfolioMetrics when provided, else fall back to local calculations ──
  // This ensures all numbers are identical to H1H2Dashboard and TradeManager header.
  const hasLivePrices = Object.keys(holdingLivePriceMap).length > 0;
  const priceSource = hasLivePrices ? "Yahoo live" : "last refresh";

  // H1 Today P&L — SSOT from portfolioMetrics (PriceService backend change, no local recalculation)
  const h1TodayPnl: number | null = portfolioMetrics != null
    ? portfolioMetrics.h1TodayPnl
    : (() => {
        // Fallback (no portfolioMetrics): use backend-provided change directly
        const yahooTodayPnl = holdingsWithLive.reduce((s, h) => {
          const lp = holdingLivePriceMap[h.ticker];
          // Priority 1: backend change (PriceService) — already correct for all market states
          if (lp?.change != null) return s + lp.change * h.units;
          // Priority 2: prevClose-based fallback
          if (lp?.price != null && lp?.prevClose != null && lp.prevClose > 0) return s + (lp.price - lp.prevClose) * h.units;
          return s;
        }, 0);
        return hasLivePrices ? yahooTodayPnl : (ibkrTodayPnl ?? yahooTodayPnl);
      })();
  const h1TodayPct: number | null = portfolioMetrics != null
    ? portfolioMetrics.h1TodayPct
    : (h1TodayPnl != null && (totalValue - h1TodayPnl) > 0 ? (h1TodayPnl / (totalValue - h1TodayPnl)) * 100 : null);
  // Source label: 'IBKR live' when ibkrTodayPnl is non-null (from /pnl endpoint), else Yahoo/last refresh
  const h1TodaySource = portfolioMetrics != null && summaryIsLive && ibkrTodayPnl != null
    ? "IBKR /pnl"
    : priceSource;

  // H2 calculations — SSOT first
  const h2Rows = (h2Data ?? []).filter(r => r.units !== 0);
  const hasH2 = h2Rows.length > 0;
  const h2TotalValue = portfolioMetrics?.h2TotalValue ?? h2Rows.reduce((s, r) => s + ((h2LivePriceMap?.[r.ticker]?.price ?? r.currentPrice ?? r.buyPrice) * r.units), 0);
  const h2TotalCost = portfolioMetrics?.h2TotalCost ?? h2Rows.reduce((s, r) => s + r.buyPrice * r.units, 0);
  const h2TotalPnl = portfolioMetrics?.h2TotalPnl ?? (h2TotalValue - h2TotalCost);
  const h2TotalPnlPct = portfolioMetrics?.h2TotalPnlPct ?? (h2TotalCost > 0 ? (h2TotalPnl / h2TotalCost) * 100 : 0);
  const h2Count = portfolioMetrics?.h2Count ?? h2Rows.length;
  const h2TodayPnl: number | null = portfolioMetrics != null
    ? portfolioMetrics.h2TodayPnl
    : h2Rows.reduce((s, r) => {
    const live = h2LivePriceMap?.[r.ticker];
    // Priority 1: backend change (PriceService) — already correct for all market states
    if (live?.change != null) return s + live.change * r.units;
    // Priority 2: prevClose-based fallback
    if (live?.price != null && live?.prevClose != null && live.prevClose > 0) return s + (live.price - live.prevClose) * r.units;
    return s;
  }, 0) as number | null;
  const h2TodayPct: number | null = portfolioMetrics != null
    ? portfolioMetrics.h2TodayPct
    : (h2TodayPnl != null && (h2TotalValue - h2TodayPnl) > 0 ? (h2TodayPnl / (h2TotalValue - h2TodayPnl)) * 100 : null);
  const h2CashEquiv = 0;

  // Unified — SSOT first
  const h1NLV = portfolioMetrics?.h1NLV ?? (displayNLV ?? grandTotal);
  const unifiedValue = portfolioMetrics?.unifiedValue ?? (h1NLV + h2TotalValue);
  const combinedPnl = portfolioMetrics?.unifiedTotalPnl ?? (totalPnl + h2TotalPnl);
  const combinedCost = portfolioMetrics?.unifiedTotalCost ?? (totalCost + h2TotalCost);
  const combinedPct = portfolioMetrics?.unifiedTotalPnlPct ?? (combinedCost > 0 ? (combinedPnl / combinedCost) * 100 : 0);
  const unifiedTodayPnl: number | null = portfolioMetrics != null
    ? portfolioMetrics.unifiedTodayPnl
    : (h1TodayPnl != null && h2TodayPnl != null ? h1TodayPnl + h2TodayPnl : null);
  const unifiedTodayPct: number | null = portfolioMetrics != null
    ? portfolioMetrics.unifiedTodayPct
    : (unifiedTodayPnl != null && (unifiedValue - unifiedTodayPnl) > 0 ? (unifiedTodayPnl / (unifiedValue - unifiedTodayPnl)) * 100 : null);
  const unifiedCash = cashBalance;

  // ─────────────────────────────────────────────────────────────────────────────
  // Column layout (same order for all 3 rows):
  //   [0] Portfolio Value (colored)
  //   [1] Today P&L
  //   [2] Cash Balance
  //   [3] Holdings P&L
  //   [4] Real Balance / extra (admin) or Total Cost
  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-5">

      {/* ══ H1 ══════════════════════════════════════════════════════════════════ */}
      <div>
        <RowLabel label="H1 — תיק ראשי" />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">

          {/* [0] Portfolio Value */}
          <ValueCard
            label="Portfolio Value"
            value={`$${grandTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
            sub={h1TodayPnl != null ? `שינוי מאתמול: ${h1TodayPnl >= 0 ? '+' : '-'}$${Math.abs(h1TodayPnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : (isIbkrLive ? "IBKR live •" : "Holdings + Cash")}
            gradient=""
          />

          {/* [1] Today P&L */}
          <MetricCard
            label="Today P&L"
            value={h1TodayPnl != null ? `${pnlSign(h1TodayPnl)}${fmtUsd(h1TodayPnl)}` : "—"}
            sub={h1TodayPnl != null ? `${h1TodaySource} · ${fmtPct(h1TodayPct)}` : "IBKR live"}
            valueClass={h1TodayPnl == null ? "text-white/40" : h1TodayPnl >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"}
          />

          {/* [2] Cash Balance */}
          <MetricCard
            label="Cash Balance"
            value={`${cashBalance < 0 ? "-" : ""}${fmtUsd(cashBalance)}`}
            sub={isIbkrLive ? "Net Cash · IBKR live •" : grandTotal > 0 ? `${((cashBalance / grandTotal) * 100).toFixed(1)}% of portfolio` : ""}
            valueClass={cashBalance < 0 ? "text-[#FF6B6B]" : "text-white"}
          />

          {/* [3] Holdings P&L */}
          <MetricCard
            label="Holdings P&L"
            value={`${pnlSign(totalPnl)}${fmtUsd(totalPnl)}`}
            sub={`total return ${fmtPct(totalPnlPct)}`}
            valueClass={totalPnl >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"}
          />

          {/* [4] Real Balance (admin) or Total Cost (non-admin) */}
          {isAdmin ? (
            <ValueCard
              label="Real Balance"
              value={displayNLV != null ? `$${displayNLV.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—"}
              sub={isIbkrLive ? "Net Liquidation · IBKR live" : summaryIsCached && syncLabel ? `Cached ${syncLabel}` : "Connect IBKR"}
              gradient=""
            />
          ) : (
            <MetricCard
              label="Total Cost"
              value={fmtUsd(totalCost)}
              sub="invested"
              valueClass="text-white/50"
            />
          )}
        </div>
      </div>

      {/* ══ H2 ══════════════════════════════════════════════════════════════════ */}
      {hasH2 && (
        <div>
          <RowLabel label="H2 — תיק שני" />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">

            {/* [0] H2 Portfolio Value */}
            <ValueCard
              label="Holding 2 Value"
              value={fmtUsd(h2TotalValue)}
              sub={h2TodayPnl != null ? `שינוי מאתמול: ${h2TodayPnl >= 0 ? '+' : '-'}$${Math.abs(h2TodayPnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : `${h2Count} פוזיציות`}
              gradient=""
            />

            {/* [1] H2 Today P&L */}
            <MetricCard
              label="Today P&L"
              value={h2TodayPnl != null ? `${pnlSign(h2TodayPnl)}${fmtUsd(h2TodayPnl)}` : "—"}
              sub={h2TodayPnl != null ? `today ${fmtPct(h2TodayPct)}` : "Yahoo live"}
              valueClass={h2TodayPnl == null ? "text-white/40" : h2TodayPnl >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"}
            />

            {/* [2] Cash Balance — H2 has no separate cash, show "—" */}
            <MetricCard
              label="Cash Balance"
              value={h2CashEquiv === 0 ? "—" : fmtUsd(h2CashEquiv)}
              sub="fully invested"
              valueClass="text-white/50"
            />

            {/* [3] Holdings P&L */}
            <MetricCard
              label="Holdings P&L"
              value={`${pnlSign(h2TotalPnl)}${fmtUsd(h2TotalPnl)}`}
              sub={`total return ${fmtPct(h2TotalPnlPct)}`}
              valueClass={h2TotalPnl >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"}
            />

            {/* [4] Total Cost */}
            <MetricCard
              label="Total Cost"
              value={fmtUsd(h2TotalCost)}
              sub="invested"
              valueClass="text-white/50"
            />
          </div>
        </div>
      )}

      {/* ══ Unified ══════════════════════════════════════════════════════════════ */}
      {hasH2 && (
        <div>
          <RowLabel label="מאוחד — Unified" />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">

            {/* [0] Unified Value */}
            <ValueCard
              label="שווי מאוחד"
              value={fmtUsd(unifiedValue)}
              sub={unifiedTodayPnl != null ? `שינוי מאתמול: ${unifiedTodayPnl >= 0 ? '+' : '-'}$${Math.abs(unifiedTodayPnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "Real Balance + Holding 2"}
              gradient=""
            />

            {/* [1] Unified Today P&L */}
            <MetricCard
              label="Today P&L מאוחד"
              value={unifiedTodayPnl != null ? `${pnlSign(unifiedTodayPnl)}${fmtUsd(unifiedTodayPnl)}` : "—"}
              sub={unifiedTodayPnl != null ? `today ${fmtPct(unifiedTodayPct)}` : "IBKR live"}
              valueClass={unifiedTodayPnl == null ? "text-white/40" : unifiedTodayPnl >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"}
            />

            {/* [2] Cash (H1 cash only) */}
            <MetricCard
              label="Cash Balance"
              value={`${unifiedCash < 0 ? "-" : ""}${fmtUsd(unifiedCash)}`}
              sub="H1 cash only"
              valueClass={unifiedCash < 0 ? "text-[#FF6B6B]" : "text-white"}
            />

            {/* [3] Combined Holdings P&L */}
            <MetricCard
              label="P&L מאוחד"
              value={`${pnlSign(combinedPnl)}${fmtUsd(combinedPnl)}`}
              sub={`total ${fmtPct(combinedPct)}`}
              valueClass={combinedPnl >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"}
            />

            {/* [4] Combined Cost */}
            <MetricCard
              label="Total Cost"
              value={fmtUsd(combinedCost)}
              sub="H1 + H2 invested"
              valueClass="text-white/50"
            />
          </div>
        </div>
      )}
    </div>
  );
});
