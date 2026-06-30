/**
 * Manual order confirmation dialog — presets, qty, optional SL/TP hints.
 * Server always applies protection on live entries.
 */
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  intentLabelHe,
  isValidLivePrice,
  type ManualOrderIntent,
} from "@/lib/manualOrderContract";
import type { DeepAnalysisResult } from "@/components/deep-analysis/types";
import { Z } from "@/lib/zIndex";

const BUY_PRESETS = [5000, 10000, 15000, 20000, 30000, 40000] as const;

export interface ManualOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticker: string;
  manualIntent: ManualOrderIntent | null;
  result: DeepAnalysisResult | null;
  currencySymbol: string;
  livePrice: number;
  mktQty: string;
  onMktQtyChange: (v: string) => void;
  manualSl: string;
  onManualSlChange: (v: string) => void;
  manualTp: string;
  onManualTpChange: (v: string) => void;
  longUnits: number;
  shortUnits: number;
  warScore?: number;
  manualPending: boolean;
  submitDisabled: boolean;
  onSubmit: () => void;
}

export function ManualOrderDialog({
  open,
  onOpenChange,
  ticker,
  manualIntent,
  result,
  currencySymbol: cs,
  livePrice,
  mktQty,
  onMktQtyChange,
  manualSl,
  onManualSlChange,
  manualTp,
  onManualTpChange,
  longUnits,
  shortUnits,
  warScore,
  manualPending,
  submitDisabled,
  onSubmit,
}: ManualOrderDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto w-[calc(100vw-1.5rem)] sm:w-full" style={{ zIndex: Z.dialog }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[11px] sm:text-base font-bold">
            {manualIntent && intentLabelHe(manualIntent)} — {ticker}
          </DialogTitle>
        </DialogHeader>
        {result && manualIntent && (
          <div className="space-y-3 py-2 text-[11px] sm:text-sm">
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-gray-50 rounded-lg p-2 text-center border">
                <p className="text-[11px] text-muted-foreground">מחיר</p>
                <p className="font-mono font-bold">{cs}{livePrice.toFixed(2)}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-2 text-center border">
                <p className="text-[11px] text-muted-foreground">שווי משוער</p>
                <p className="font-mono font-bold">
                  {mktQty && parseFloat(mktQty) > 0
                    ? `$${(parseFloat(mktQty) * livePrice).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
                    : "—"}
                </p>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="da-mkt-qty" className="text-[11px]">כמות (מניות)</Label>
              <Input id="da-mkt-qty" type="number" step="1" min="1" value={mktQty}
                onChange={(e) => onMktQtyChange(e.target.value)} className="font-mono min-h-[44px]" />
            </div>
            {(manualIntent === "open_long" || manualIntent === "open_short") && (
              <div className="space-y-1">
                <Label className="text-[11px]">סכום מהיר ($)</Label>
                {!isValidLivePrice(livePrice) ? (
                  <p className="text-[11px] text-amber-700">אין מחיר חי — presets מושבתים עד לעדכון פיד</p>
                ) : (
                  <div className="grid grid-cols-3 gap-1">
                    {BUY_PRESETS.map((amount) => {
                      const qty = Math.max(1, Math.floor(amount / livePrice));
                      return (
                        <button key={amount} type="button" onClick={() => onMktQtyChange(String(qty))}
                          className={`min-h-[44px] rounded border text-[11px] font-bold ${mktQty === String(qty) ? "bg-emerald-600 text-white border-emerald-700" : "bg-gray-50"}`}>
                          ${amount / 1000}K
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {(manualIntent === "close_long" || manualIntent === "close_short") && (
              <div className="space-y-1">
                <Label className="text-[11px]">אחוז מהפוזיציה</Label>
                <div className="grid grid-cols-4 gap-1">
                  {([0.1, 0.25, 0.5, 1] as const).map((pct) => {
                    const base = manualIntent === "close_long" ? longUnits : shortUnits;
                    const qty = Math.max(1, Math.round(base * pct));
                    return (
                      <button key={pct} type="button" onClick={() => onMktQtyChange(String(qty))}
                        className={`min-h-[44px] rounded border text-[11px] font-bold ${mktQty === String(qty) ? "bg-red-600 text-white border-red-700" : "bg-gray-50"}`}>
                        {pct * 100}%
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-[11px]">SL (אופציונלי)</Label>
                <Input value={manualSl} onChange={(e) => onManualSlChange(e.target.value)}
                  placeholder="ריק = אוטומטי מהשרת" className="font-mono min-h-[44px]" />
              </div>
              <div>
                <Label className="text-[11px]">TP (אופציונלי)</Label>
                <Input value={manualTp} onChange={(e) => onManualTpChange(e.target.value)}
                  placeholder="ריק = אוטומטי מהשרת" className="font-mono min-h-[44px]" />
              </div>
            </div>
            <p className="text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded p-2 leading-snug">
              השרת יחיל SL/TP אוטומטית על כניסה חיה — אין כניסה עירומה.
            </p>
            {warScore != null && warScore < 7 && (
              <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
                המנוע ממליץ להמתין (ציון {warScore.toFixed(1)}) — אתה פועל ידנית.
              </div>
            )}
            {manualIntent === "open_long" && shortUnits > 0 && (
              <div className="text-[11px] text-amber-900 bg-amber-50 border border-amber-300 rounded p-2">
                ⚠️ כבר יש פוזיציית שורט ({shortUnits} מניות) — BUY יפתח לונג. שקול COVER קודם.
              </div>
            )}
            {manualIntent === "open_short" && longUnits > 0 && (
              <div className="text-[11px] text-amber-900 bg-amber-50 border border-amber-300 rounded p-2">
                ⚠️ כבר יש פוזיציית לונג ({longUnits} מניות) — SHORT יפתח שורט. שקול SELL או הוסף ללונג.
              </div>
            )}
            {mktQty && parseFloat(mktQty) * livePrice > 25000 && (
              <div className="text-[11px] text-orange-800 bg-orange-50 border border-orange-200 rounded p-2">
                חריגה ממגבלת גודל מומלצת ($25,000) — אישור ידני.
              </div>
            )}
          </div>
        )}
        <DialogFooter className="flex-col-reverse sm:flex-row gap-2">
          <Button variant="outline" className="min-h-[44px] text-[11px] w-full sm:w-auto" onClick={() => onOpenChange(false)}>ביטול</Button>
          <Button
            className="min-h-[44px] text-[11px] gap-1 bg-[#2563EB] hover:bg-blue-700 text-white w-full sm:w-auto"
            disabled={submitDisabled || manualPending}
            onClick={onSubmit}
          >
            {manualPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            אשר ושלח ל-IBKR
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
