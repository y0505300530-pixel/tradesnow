/**
 * Admin-only SL/TP execution panel — no duplicate TradeActionGrid (command bar is SSOT).
 */
import { Loader2, Target, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DeepAnalysisResult, HoldingContext } from "./types";

export function AdminSlTpPanel({
  result,
  currencySymbol: cs,
  ibkrConnected,
  editedTP,
  onEditedTPChange,
  editedSL,
  onEditedSLChange,
  ibkrTpQty,
  onIbkrTpQtyChange,
  ibkrQty,
  onIbkrQtyChange,
  holdingContext,
  placeLMTPending,
  placeSTPPending,
  onOpenTpDialog,
  onOpenSlDialog,
}: {
  result: DeepAnalysisResult;
  currencySymbol: string;
  ibkrConnected: boolean;
  editedTP: string;
  onEditedTPChange: (v: string) => void;
  editedSL: string;
  onEditedSLChange: (v: string) => void;
  ibkrTpQty: string;
  onIbkrTpQtyChange: (v: string) => void;
  ibkrQty: string;
  onIbkrQtyChange: (v: string) => void;
  holdingContext?: HoldingContext;
  placeLMTPending: boolean;
  placeSTPPending: boolean;
  onOpenTpDialog: () => void;
  onOpenSlDialog: () => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 bg-muted/20 border rounded-xl">
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <Target className="h-4 w-4 text-[#65A30D]" />
          <span className="text-xs font-semibold">Execute Take Profit — IBKR</span>
          {ibkrConnected
            ? <span className="ml-auto text-[10px] text-[#65A30D]">● Connected</span>
            : <span className="ml-auto text-[10px] text-[#FF6B6B]">○ Offline</span>}
        </div>
        <div className="flex gap-2">
          <Input type="number" step="0.01" min="0.01" className="h-8 text-sm font-mono"
            value={editedTP} onChange={(e) => onEditedTPChange(e.target.value)}
            placeholder={result.recommendedBuyPrice > 0 ? (result.recommendedBuyPrice * 1.15).toFixed(2) : "ריק = אוטומטי מהשרת"} />
          <Input type="number" step="1" min="1" className="h-8 w-20 text-sm font-mono"
            value={ibkrTpQty} onChange={(e) => onIbkrTpQtyChange(e.target.value)}
            placeholder={holdingContext?.units?.toString() ?? "qty"} />
          <Button size="sm" className="h-8 bg-[#65A30D] hover:bg-[#17a87e] text-white gap-1 shrink-0"
            disabled={!editedTP || !ibkrTpQty || placeLMTPending} onClick={onOpenTpDialog}>
            {placeLMTPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Target className="h-3.5 w-3.5" />}
            LMT
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">Rec: {cs}{(result.recommendedBuyPrice * 1.15).toFixed(2)} · Qty: {holdingContext?.units ?? "—"}</p>
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <ShieldOff className="h-4 w-4 text-[#FF6B6B]" />
          <span className="text-xs font-semibold">Execute Stop Loss — IBKR</span>
          {ibkrConnected
            ? <span className="ml-auto text-[10px] text-[#65A30D]">● Connected</span>
            : <span className="ml-auto text-[10px] text-[#FF6B6B]">○ Offline</span>}
        </div>
        <div className="flex gap-2">
          <Input type="number" step="0.01" min="0.01" className="h-8 text-sm font-mono"
            value={editedSL} onChange={(e) => onEditedSLChange(e.target.value)}
            placeholder={result.stopLoss.toFixed(2)} />
          <Input type="number" step="1" min="1" className="h-8 w-20 text-sm font-mono"
            value={ibkrQty} onChange={(e) => onIbkrQtyChange(e.target.value)}
            placeholder={holdingContext?.units?.toString() ?? "qty"} />
          <Button size="sm" className="h-8 bg-[#FF6B6B] hover:bg-[#e05555] text-white gap-1 shrink-0"
            disabled={!editedSL || !ibkrQty || placeSTPPending} onClick={onOpenSlDialog}>
            {placeSTPPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
            STP
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">Rec: {cs}{result.stopLoss.toFixed(2)} ({result.stopLossPct.toFixed(1)}% risk) · Qty: {holdingContext?.units ?? "—"}</p>
      </div>
    </div>
  );
}
