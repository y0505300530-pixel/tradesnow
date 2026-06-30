/**
 * HoldingRow — Single row in the Holdings table
 *
 * Extracted from TradeManager.tsx as part of the modular refactoring (Step 3).
 * Wrapped in React.memo for performance — only re-renders when props change.
 *
 * Dependencies:
 *  - Types: Holding, ZivHData (from ../types)
 *  - Helpers: pnlColor (from ../helpers)
 *  - Sub-components: ScoreBadge, ZivHBadge (from ./ScoreBadge, ./ZivHBadge)
 *  - External: DeepAnalysisModal (lazy-loaded inline)
 */

import { useState, memo, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  Loader2, Edit2, Check, X,
} from "lucide-react";
import type { Holding, ZivHData } from "../types";
import { pnlColor } from "../helpers";
import {
  positionTodayPct,
  positionValue,
} from "@/lib/positionMath";
import { ScoreBadge } from "./ScoreBadge";
import { ZivHBadge } from "./ZivHBadge";

// ─── Props ────────────────────────────────────────────────────────────────────

interface HoldingRowProps {
  holding: Holding;
  rowNum: number;
  onUpdate: () => void;
  onSellMarket?: (h: Holding) => void;
  isExtendedHours?: boolean;
  /** Today P&L in USD: change × units from IBKR live */
  todayPnl?: number | null;
  /** Live price from Yahoo/IBKR — used for current value display */
  livePrice?: number | null;
  /** Prior close from IBKR quotes — for Today % denominator */
  prevClose?: number | null;
  navList?: string[];
  onNavigate?: (ticker: string) => void;
  zivHData?: ZivHData;
}

// ─── Component ────────────────────────────────────────────────────────────────


// ── FlickerCell: Bloomberg-style tick flash on value change ──────────────────
function FlickerCell({ value, fmt, className }: {
  value: number | null | undefined;
  fmt: (v: number) => string;
  className?: string;
}) {
  const prev = useRef<number | null | undefined>(value);
  const [flash, setFlash] = useState<"up"|"down"|null>(null);
  useEffect(() => {
    if (value == null || prev.current == null) { prev.current = value; return; }
    if (value > prev.current) {
      setFlash("up");
      setTimeout(() => setFlash(null), 600);
    } else if (value < prev.current) {
      setFlash("down");
      setTimeout(() => setFlash(null), 600);
    }
    prev.current = value;
  }, [value]);
  return (
    <span className={cn(
      "font-mono tabular-nums transition-colors duration-150",
      flash === "up"   && "text-emerald-500",
      flash === "down" && "text-red-500",
      className
    )}>
      {value == null ? "—" : fmt(value)}
    </span>
  );
}

export const HoldingRow = memo(function HoldingRow({
  holding,
  rowNum,
  onUpdate,
  onSellMarket,
  isExtendedHours,
  todayPnl,
  livePrice,
  prevClose: prevCloseLive,
  navList,
  onNavigate,
  zivHData,
}: HoldingRowProps) {
  const [, navigate] = useLocation();

  // Inline SL/TP editing
  const [editingSL, setEditingSL] = useState(false);
  const [editSLValue, setEditSLValue] = useState("");
  const [editingTP, setEditingTP] = useState(false);
  const [editTPValue, setEditTPValue] = useState("");

  const updateSLMut = trpc.portfolio.updateHolding.useMutation({
    onSuccess: () => {
      setEditingSL(false);
      onUpdate();
      toast.success(`${holding.ticker} SL updated`);
    },
    onError: (e) => toast.error(e.message),
  });

  const updateTPMut = trpc.portfolio.updateHolding.useMutation({
    onSuccess: () => {
      setEditingTP(false);
      onUpdate();
      toast.success(`${holding.ticker} TP updated`);
    },
    onError: (e) => toast.error(e.message),
  });

  const handleSaveSL = () => {
    const val = parseFloat(editSLValue);
    if (isNaN(val) || val <= 0) return toast.error("Invalid SL value");
    updateSLMut.mutate({ id: holding.id, stopLoss: val });
  };

  const handleSaveTP = () => {
    const val = parseFloat(editTPValue);
    if (isNaN(val) || val <= 0) return toast.error("Invalid TP value");
    updateTPMut.mutate({ id: holding.id, takeProfit: val });
  };

  // ─── Computed values ──────────────────────────────────────────────────────

  const cmp = livePrice ?? holding.currentPrice ?? holding.buyPrice;
  // Signed market value — matches footer totalValue (shorts = negative liability)
  const hasRealPrice = (livePrice ?? holding.currentPrice) != null;
  const isShort = holding.units < 0;
  const absUnits = Math.abs(holding.units);
  const currentValue = hasRealPrice ? positionValue(cmp, holding.units) : null;
  const costBasis = holding.buyPrice * absUnits;
  // SHORT P&L: profit when price drops (buyPrice - currentPrice) × units
  // LONG P&L: profit when price rises (currentPrice - buyPrice) × units
  const pnlDollar = currentValue != null
    ? (isShort ? costBasis - currentValue : currentValue - costBasis)
    : null;
  const pnlPctRaw = pnlDollar != null && costBasis > 0 ? (pnlDollar / costBasis) * 100 : null;
  // Cap display at ±9999% — very low buy prices (e.g. $0.10) produce misleading 100,000%+ values.
  // The $ P&L is always accurate; the % is capped for readability.
  const PNL_PCT_CAP = 9999;
  const pnlPctCapped = pnlPctRaw != null && Math.abs(pnlPctRaw) > PNL_PCT_CAP;
  const pnlPct = pnlPctRaw != null ? (pnlPctCapped ? Math.sign(pnlPctRaw) * PNL_PCT_CAP : pnlPctRaw) : null;

  const prevCloseForToday =
    prevCloseLive != null && prevCloseLive > 0
      ? prevCloseLive
      : holding.dailyChangePercent != null && cmp > 0
        ? cmp / (1 + holding.dailyChangePercent / 100)
        : cmp;
  const todayPct =
    todayPnl != null
      ? positionTodayPct(todayPnl, prevCloseForToday, holding.units)
      : null;

  // Score alert logic
  const currentScore = holding.zivScore ?? null;
  const buyScore = holding.buyScore ?? null;
  const scoreDelta =
    currentScore !== null && buyScore !== null ? currentScore - buyScore : null;
  const isExitAlert = currentScore !== null && currentScore <= 2;
  const isWatchAlert = scoreDelta !== null && scoreDelta <= -3 && !isExitAlert;

  // Stop loss proximity alert: warn if current price is within 0.5% of stop loss
  // DB returns decimal columns as strings in some drivers — coerce to number
  const stopLossPrice =
    holding.stopLoss != null ? parseFloat(String(holding.stopLoss)) : null;
  // Direction-aware proximity: positive = price on the safe side of the stop.
  // Long: safe above SL → (cmp - SL). Short: safe below SL → (SL - cmp).
  const slProximityPct =
    stopLossPrice && cmp > 0
      ? ((isShort ? stopLossPrice - cmp : cmp - stopLossPrice) / cmp) * 100
      : null;
  const isNearStopLoss =
    slProximityPct !== null && slProximityPct <= 0.5 && slProximityPct >= 0;
  // isBelowStopLoss === "stop breached" (price reached the stop) for both directions
  const isBelowStopLoss = slProximityPct !== null && slProximityPct < 0;

  // Take profit proximity — direction-aware. Positive = TP not yet reached.
  // Long: TP above → (TP - cmp). Short: TP below → (cmp - TP).
  const takeProfitPrice =
    holding.takeProfit != null ? parseFloat(String(holding.takeProfit)) : null;
  const tpProximityPct =
    takeProfitPrice && cmp > 0
      ? ((isShort ? cmp - takeProfitPrice : takeProfitPrice - cmp) / cmp) * 100
      : null;
  const isNearTakeProfit =
    tpProximityPct !== null && tpProximityPct <= 3 && tpProximityPct >= 0;
  // isAboveTakeProfit === "TP hit" for both directions
  const isAboveTakeProfit = tpProximityPct !== null && tpProximityPct < 0;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <TableRow
      className={`group ${
        isNearStopLoss || isBelowStopLoss
          ? "border-l-4 border-l-red-500"
          : ""
      }`}
    >
      {/* # */}
      <TableCell className="text-xs text-center w-8 select-none" style={{ color: '#6B7280' }}>
        {rowNum}
      </TableCell>

      {/* Ticker */}
      <TableCell className="font-mono font-semibold text-sm">
        <button
          className="font-mono font-semibold text-sm hover:underline cursor-pointer bg-transparent border-none p-0" style={{ color: '#C9A84C' }}
          onClick={() => navigate(`/deep-analysis/${encodeURIComponent(holding.ticker)}`)}
          title={`Deep Analysis: ${holding.ticker}`}
        >
          {holding.ticker}
        </button>
        {holding.units < 0 ? (
          <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-700 text-white">▼ SHORT</span>
        ) : (
          <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-700 text-white">▲ LONG</span>
        )}
        {(isNearStopLoss || isBelowStopLoss) && (
          <span className="ml-1.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-red-600 text-white animate-pulse">
            ⚠ {isBelowStopLoss ? (isShort ? "ABOVE SL" : "BELOW SL") : "NEAR SL"}
          </span>
        )}
      </TableCell>

      {/* Units */}
      <TableCell className="text-right">
        <span className="font-mono text-sm">{holding.units}</span>
      </TableCell>

      {/* Buy Price */}
      <TableCell className="text-right">
        <span className="font-mono text-sm">${holding.buyPrice.toFixed(2)}</span>
      </TableCell>

      {/* Current Price */}
      <TableCell className="text-right font-mono text-sm">
        {cmp > 0 ? (
          `$${cmp.toFixed(2)}`
        ) : (
          <span style={{ color: '#9CA3AF' }}>—</span>
        )}
      </TableCell>

      {/* Daily Change % — position-aware (short flips sign vs stock CHG%) */}
      <TableCell className="text-right">
        {todayPct != null ? (
          <div className="flex flex-col items-end gap-0.5">
            <span
              className={`font-mono text-sm font-medium ${
                todayPct >= 0
                  ? "text-[#65A30D]"
                  : "text-[#FF6B6B]"
              }`}
            >
              {todayPct >= 0 ? "+" : ""}
              {todayPct.toFixed(2)}%
            </span>
            {isExtendedHours && (
              <span className="text-[10px] px-1 py-0 rounded font-medium leading-tight" style={{ background: 'rgba(37,99,235,0.10)', color: '#2563EB', border: '1px solid rgba(37,99,235,0.25)' }}>
                PM
              </span>
            )}
          </div>
        ) : (
          <span className="text-sm" style={{ color: '#9CA3AF' }}>—</span>
        )}
      </TableCell>

      {/* Today $ — daily P&L in USD */}
      <TableCell className="text-right font-mono text-sm">
        {todayPnl != null ? (
          <span className={todayPnl >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"}>
            {todayPnl >= 0 ? "+" : ""}
            ${Math.abs(todayPnl).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
          </span>
        ) : (
          <span style={{ color: '#9CA3AF' }}>—</span>
        )}
      </TableCell>

      {/* Current Value */}
      <TableCell className="text-right font-semibold">
        <FlickerCell
          value={currentValue}
          fmt={v => `$${v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
          className="text-sm"
        />
      </TableCell>

      {/* P&L */}
      <TableCell className="text-right">
        {/* $ P&L — always accurate, shown first when % is extreme */}
        {pnlDollar != null ? (
          <div className={`font-mono text-sm font-medium ${pnlColor(pnlDollar)}`}>
            {pnlDollar >= 0 ? "+" : ""}$
            {pnlDollar.toLocaleString(undefined, {
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
            })}
          </div>
        ) : (
          <div className="font-mono text-sm" style={{ color: '#9CA3AF' }}>—</div>
        )}
        {/* % P&L — hidden when buy price is very low (misleading 100,000%+) */}
        {pnlPct != null ? (
          pnlPctCapped ? (
            <div className="text-xs" style={{ color: '#9CA3AF' }}>N/A</div>
          ) : (
            <div className={`text-xs ${pnlColor(pnlPct)}`}>
              {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
            </div>
          )
        ) : null}
      </TableCell>

      {/* Stop Loss (inline edit) */}
      <TableCell className="text-right">
        {editingSL ? (
          <div className="flex items-center justify-end gap-1">
            <Input
              type="number"
              value={editSLValue}
              onChange={(e) => setEditSLValue(e.target.value)}
              className="h-7 w-24 text-right text-sm"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveSL();
                if (e.key === "Escape") setEditingSL(false);
              }}
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-[#65A30D]"
              onClick={handleSaveSL}
              disabled={updateSLMut.isPending}
            >
              {updateSLMut.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Check className="h-3 w-3" />
              )}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-gray-400"
              onClick={() => setEditingSL(false)}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        ) : (
          <div
            className="group/sl flex items-center justify-end gap-1 cursor-pointer"
            onClick={() => {
              setEditSLValue(
                stopLossPrice != null ? String(stopLossPrice.toFixed(2)) : ""
              );
              setEditingSL(true);
            }}
            title="Click to edit Stop Loss"
          >
            {stopLossPrice != null ? (
              <div
                className={`font-mono text-sm font-medium ${
                  isBelowStopLoss
                    ? "text-[#FF6B6B] font-bold"
                    : isNearStopLoss
                    ? "text-orange-400 font-bold"
                    : "text-gray-500"
                }`}
              >
                ${stopLossPrice.toFixed(2)}
                {slProximityPct !== null && (
                  <div className="text-[10px] font-normal">
                    {isBelowStopLoss ? (
                      <span className="text-[#FF6B6B] font-bold">BREACHED</span>
                    ) : (
                      <span
                        className={
                          isNearStopLoss
                            ? "text-orange-400"
                            : "text-gray-400"
                        }
                      >
                        {slProximityPct.toFixed(1)}% away
                      </span>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <span className="text-xs" style={{ color: '#9CA3AF' }}>—</span>
            )}
            <Edit2 className="h-3 w-3 opacity-0 group-hover/sl:opacity-60 transition-opacity flex-shrink-0" style={{ color: '#2563EB' }} />
          </div>
        )}
      </TableCell>

      {/* Take Profit (inline edit) */}
      <TableCell className="text-right">
        {editingTP ? (
          <div className="flex items-center justify-end gap-1">
            <Input
              type="number"
              value={editTPValue}
              onChange={(e) => setEditTPValue(e.target.value)}
              className="h-7 w-24 text-right text-sm"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveTP();
                if (e.key === "Escape") setEditingTP(false);
              }}
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-[#65A30D]"
              onClick={handleSaveTP}
              disabled={updateTPMut.isPending}
            >
              {updateTPMut.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Check className="h-3 w-3" />
              )}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-gray-400"
              onClick={() => setEditingTP(false)}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        ) : (
          <div
            className="group/tp flex items-center justify-end gap-1 cursor-pointer"
            onClick={() => {
              const tp =
                holding.takeProfit != null
                  ? parseFloat(String(holding.takeProfit))
                  : null;
              setEditTPValue(tp != null ? String(tp.toFixed(2)) : "");
              setEditingTP(true);
            }}
            title="Click to edit Take Profit"
          >
            {takeProfitPrice != null && takeProfitPrice > 0 ? (
              <div
                className={`font-mono text-sm font-medium ${
                  isAboveTakeProfit
                    ? "text-[#65A30D] font-bold"
                    : isNearTakeProfit
                    ? "text-[#5EDFC5] font-bold"
                    : "text-[#65A30D]"
                }`}
              >
                ${takeProfitPrice.toFixed(2)}
                {tpProximityPct !== null && (
                  <div className="text-[10px] font-normal">
                    {isAboveTakeProfit ? (
                      <span className="text-[#65A30D] font-bold">🎯 HIT</span>
                    ) : (
                      <span
                        className={
                          isNearTakeProfit
                            ? "text-[#5EDFC5]"
                            : "text-gray-400"
                        }
                      >
                        away {tpProximityPct.toFixed(1)}%
                      </span>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <span className="text-xs" style={{ color: '#9CA3AF' }}>—</span>
            )}
            <Edit2 className="h-3 w-3 opacity-0 group-hover/tp:opacity-60 transition-opacity flex-shrink-0" style={{ color: '#2563EB' }} />
          </div>
        )}
      </TableCell>

      {/* Ziv Score */}
      <TableCell className="text-center">
        <div className="flex flex-col items-center gap-0.5">
          <ScoreBadge score={holding.zivScore ?? null} />
          {buyScore !== null && currentScore !== null && (
            <span
              className={`text-[10px] font-medium ${
                isExitAlert
                  ? "text-[#FF6B6B]"
                  : isWatchAlert
                  ? "text-orange-400"
                  : scoreDelta !== null && scoreDelta > 0
                  ? "text-[#65A30D]"
                  : "text-gray-400"
              }`}
            >
              {scoreDelta !== null && scoreDelta > 0
                ? "▲"
                : scoreDelta !== null && scoreDelta < 0
                ? "▼"
                : "="}
              {Math.abs(scoreDelta ?? 0).toFixed(0)} from {buyScore.toFixed(0)}
            </span>
          )}
          {isExitAlert && (
            <span className="text-[9px] font-bold px-1 rounded" style={{ color: '#f87171', background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.30)' }}>
              EXIT
            </span>
          )}
          {isWatchAlert && (
            <span className="text-[9px] font-bold px-1 rounded" style={{ color: '#fb923c', background: 'rgba(251,146,60,0.15)', border: '1px solid rgba(251,146,60,0.30)' }}>
              WATCH
            </span>
          )}
        </div>
      </TableCell>

      {/* ZIV H Health */}
      <TableCell className="text-center">
        <ZivHBadge data={zivHData} />
      </TableCell>

      {/* Actions */}
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-3 text-sm font-black rounded-md shadow-sm"
            style={{ background: '#65A30D', color: '#fff', border: '2px solid #17a87e' }}
            title="קנה עוד"
            onClick={() => navigate(`/deep-analysis/${encodeURIComponent(holding.ticker)}`)}
          >
            קנייה
          </Button>
          {onSellMarket && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-3 text-sm font-black rounded-md shadow-sm"
              style={{ background: '#FF6B6B', color: '#fff', border: '2px solid #e05555' }}
              title={`מכור בשוק — ${holding.ticker} (${holding.units} מניות)`}
              onClick={() => onSellMarket(holding)}
            >
              מכירה
            </Button>
          )}
        </div>
      </TableCell>


    </TableRow>
  );
}); // end memo(HoldingRow)
