/**
 * BUY / SELL / SHORT / COVER action grid — isolated for review (manual trading UX).
 */
import { ArrowUpCircle, ArrowDownCircle, TrendingDown, TrendingUp } from "lucide-react";
import type { ManualOrderIntent } from "@/lib/manualOrderContract";

const TRADE_BTN =
  "flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-1.5 min-h-[44px] w-full px-2 text-[11px] sm:text-sm font-bold rounded-lg border transition-all disabled:opacity-40 disabled:cursor-not-allowed";

export function TradeActionGrid({
  ibkrConnected,
  ibkrConid,
  manualPending,
  orderBlocked,
  blockedBuy: blockedBuyProp,
  blockedSell: blockedSellProp,
  longUnits,
  shortUnits,
  onOpen,
}: {
  ibkrConnected: boolean;
  ibkrConid: number;
  manualPending: boolean;
  /** Per-side block (ticker+side STALLED/inflight) — not global */
  blockedBuy?: boolean;
  blockedSell?: boolean;
  /** @deprecated use blockedBuy/blockedSell */
  orderBlocked?: boolean;
  longUnits: number;
  shortUnits: number;
  onOpen: (intent: ManualOrderIntent) => void;
}) {
  const blockedBuy = blockedBuyProp ?? orderBlocked ?? false;
  const blockedSell = blockedSellProp ?? orderBlocked ?? false;
  const blocked = manualPending;
  const hints: string[] = [];
  if (blockedBuy || blockedSell) {
    const parts: string[] = [];
    if (blockedBuy) parts.push("BUY/COVER");
    if (blockedSell) parts.push("SELL/SHORT");
    hints.push(`${parts.join("/")} חסום לטיקר זה — בדוק ב-IBKR לפני שליחה חוזרת`);
  }
  if (ibkrConnected && (!ibkrConid || ibkrConid <= 0)) {
    hints.push("חסר conid — סנכרן פוזיציות מ-IBKR");
  }

  const sellTitle = longUnits <= 0 ? "אין פוזיציית לונג" : undefined;
  const coverTitle = shortUnits <= 0 ? "אין פוזיציית שורט" : undefined;
  const ibkrDownTitle = "IBKR לא מחובר — חבר בחשבון IBKR";

  return (
    <div className="w-full">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
        <button type="button"
          className={`${TRADE_BTN} bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100`}
          disabled={!ibkrConnected || !ibkrConid || ibkrConid <= 0 || blocked || blockedBuy}
          title={!ibkrConnected ? ibkrDownTitle : undefined}
          onClick={() => onOpen("open_long")}
        >
          <ArrowUpCircle className="h-4 w-4 shrink-0" />
          <span>BUY</span>
        </button>
        <button type="button"
          className={`${TRADE_BTN} bg-red-50 text-red-600 border-red-200 hover:bg-red-100`}
          disabled={!ibkrConnected || !ibkrConid || ibkrConid <= 0 || blocked || blockedSell || longUnits <= 0}
          title={!ibkrConnected ? ibkrDownTitle : sellTitle}
          onClick={() => onOpen("close_long")}
        >
          <ArrowDownCircle className="h-4 w-4 shrink-0" />
          <span>SELL</span>
        </button>
        <button type="button"
          className={`${TRADE_BTN} border-dashed border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-100`}
          disabled={!ibkrConnected || !ibkrConid || ibkrConid <= 0 || blocked || blockedSell}
          title={!ibkrConnected ? ibkrDownTitle : undefined}
          onClick={() => onOpen("open_short")}
        >
          <TrendingDown className="h-4 w-4 shrink-0" />
          <span>SHORT</span>
        </button>
        <button type="button"
          className={`${TRADE_BTN} bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100`}
          disabled={!ibkrConnected || !ibkrConid || ibkrConid <= 0 || blocked || blockedBuy || shortUnits <= 0}
          title={!ibkrConnected ? ibkrDownTitle : coverTitle}
          onClick={() => onOpen("close_short")}
        >
          <TrendingUp className="h-4 w-4 shrink-0" />
          <span>COVER</span>
        </button>
      </div>
      {!ibkrConnected && (
        <p className="mt-1.5 text-[11px] text-amber-700 leading-snug">{ibkrDownTitle}</p>
      )}
      {hints.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {hints.map((h) => (
            <p key={h} className="text-[11px] text-slate-500 leading-snug">{h}</p>
          ))}
        </div>
      )}
    </div>
  );
}
