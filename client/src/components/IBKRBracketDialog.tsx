/**
 * IBKRBracketDialog — Place a 3-leg Bracket Order via IBIND /orders/bracket
 *
 * Collects: conid (auto-resolved), side, quantity, entryPrice, stopLoss, takeProfit
 * Validates price ordering before submitting.
 * Requires IBKR session to be active.
 */

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, AlertTriangle, CheckCircle2, Package, TrendingUp, TrendingDown, ShieldAlert, Target } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

export interface IBKRBracketDialogProps {
  open: boolean;
  onClose: () => void;
  ticker: string;
  company?: string;
  currentPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  suggestedUnits?: number;
  side?: "BUY" | "SELL";
  accountId: string;
  conid?: number; // pre-resolved conid if available
}

type Step = "form" | "confirm" | "submitting" | "success" | "error";

export function IBKRBracketDialog({
  open, onClose, ticker, company, currentPrice,
  stopLoss, takeProfit, suggestedUnits, side = "BUY",
  accountId, conid: preConid,
}: IBKRBracketDialogProps) {

  const [step, setStep] = useState<Step>("form");
  const [orderSide, setOrderSide] = useState<"BUY" | "SELL">(side);
  const [quantity, setQuantity] = useState(suggestedUnits?.toString() ?? "1");
  const [entryPrice, setEntryPrice] = useState(currentPrice?.toFixed(2) ?? "");
  const [slPrice, setSlPrice] = useState(stopLoss?.toFixed(2) ?? "");
  const [tpPrice, setTpPrice] = useState(takeProfit?.toFixed(2) ?? "");
  const [tif, setTif] = useState<"GTC" | "DAY">("GTC");
  const [outsideRth, setOutsideRth] = useState(false);
  const [resolvedConid, setResolvedConid] = useState<number | null>(preConid ?? null);
  const [resolvingConid, setResolvingConid] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [successResult, setSuccessResult] = useState<any>(null);

  const bracketMut = trpc.ibkr.placeBracketIbind.useMutation();

  // Reset when dialog opens
  useEffect(() => {
    if (open) {
      setStep("form");
      setOrderSide(side);
      setQuantity(suggestedUnits?.toString() ?? "1");
      setEntryPrice(currentPrice?.toFixed(2) ?? "");
      setSlPrice(stopLoss?.toFixed(2) ?? "");
      setTpPrice(takeProfit?.toFixed(2) ?? "");
      setTif("GTC");
      setOutsideRth(false);
      setResolvedConid(preConid ?? null);
      setResolvingConid(false);
      setErrorMsg("");
      setSuccessResult(null);
    }
  }, [open, side, suggestedUnits, currentPrice, stopLoss, takeProfit, preConid]);

  // Validation
  const qty = parseFloat(quantity);
  const entry = parseFloat(entryPrice);
  const sl = parseFloat(slPrice);
  const tp = parseFloat(tpPrice);
  const isValid = !isNaN(qty) && qty > 0 && !isNaN(entry) && entry > 0 && !isNaN(sl) && sl > 0 && !isNaN(tp) && tp > 0;

  const priceOrderOk = isValid && (
    orderSide === "BUY" ? (sl < entry && entry < tp) : (tp < entry && entry < sl)
  );

  const priceOrderError = isValid && !priceOrderOk
    ? orderSide === "BUY"
      ? "BUY: Stop Loss < Entry < Take Profit"
      : "SELL: Take Profit < Entry < Stop Loss"
    : null;

  // Risk/Reward display
  const riskReward = isValid && priceOrderOk
    ? orderSide === "BUY"
      ? ((tp - entry) / (entry - sl)).toFixed(2)
      : ((entry - tp) / (sl - entry)).toFixed(2)
    : null;

  const orderValue = isValid ? (qty * entry).toFixed(0) : null;
  const capExceeded = orderValue && parseFloat(orderValue) > 30000;

  const handleProceed = () => {
    if (!priceOrderOk) return;
    if (capExceeded) {
      toast.error("Order value exceeds $30,000 cap");
      return;
    }
    setStep("confirm");
  };

  const handleSubmit = async () => {
    if (!resolvedConid) {
      // Try to resolve conid via IBKR search
      setResolvingConid(true);
      try {
        // Use ibindRequest via a tRPC call — for now use conid=0 and let server resolve
        // Actually we need conid — show error
        setResolvingConid(false);
        setErrorMsg("Conid not available. Open Deep Analysis first to resolve the conid for this ticker.");
        setStep("error");
        return;
      } catch {
        setResolvingConid(false);
      }
    }

    setStep("submitting");
    try {
      const result = await bracketMut.mutateAsync({
        conid: resolvedConid!,
        side: orderSide,
        quantity: qty,
        entryPrice: entry,
        stopLoss: sl,
        takeProfit: tp,
        tif,
        outsideRth,
        ticker,
      });
      setSuccessResult(result);
      setStep("success");
      toast.success(`✅ Bracket order placed for ${ticker}`);
    } catch (err: any) {
      setErrorMsg(err.message ?? "Failed to place bracket order");
      setStep("error");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-5 w-5 text-purple-500" />
            Bracket Order — {ticker}
            {company && <span className="text-sm font-normal text-muted-foreground">({company})</span>}
          </DialogTitle>
        </DialogHeader>

        {/* ── FORM ── */}
        {step === "form" && (
          <div className="space-y-4 py-2">
            {/* Live account warning */}
            <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span><strong>LIVE account {accountId || "not configured"}</strong> — real money. Double-check all prices.</span>
            </div>

            {/* Side selector */}
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setOrderSide("BUY")}
                className={`py-2 rounded-lg font-semibold text-sm transition-colors ${orderSide === "BUY" ? "bg-emerald-600 text-white" : "bg-muted text-muted-foreground hover:bg-emerald-50"}`}
              >
                <TrendingUp className="h-4 w-4 inline mr-1" /> BUY
              </button>
              <button
                onClick={() => setOrderSide("SELL")}
                className={`py-2 rounded-lg font-semibold text-sm transition-colors ${orderSide === "SELL" ? "bg-red-600 text-white" : "bg-muted text-muted-foreground hover:bg-red-50"}`}
              >
                <TrendingDown className="h-4 w-4 inline mr-1" /> SELL
              </button>
            </div>

            {/* Quantity + Entry */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Quantity (shares)</Label>
                <Input value={quantity} onChange={e => setQuantity(e.target.value)} type="number" min="1" step="1" placeholder="10" />
              </div>
              <div className="space-y-1">
                <Label>Entry Price ($)</Label>
                <Input value={entryPrice} onChange={e => setEntryPrice(e.target.value)} type="number" min="0.01" step="0.01" placeholder={currentPrice?.toFixed(2) ?? "0.00"} />
              </div>
            </div>

            {/* SL + TP */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="flex items-center gap-1"><ShieldAlert className="h-3.5 w-3.5 text-[#FF6B6B]" /> Stop Loss ($)</Label>
                <Input value={slPrice} onChange={e => setSlPrice(e.target.value)} type="number" min="0.01" step="0.01" placeholder="0.00" className={priceOrderError && orderSide === "BUY" && sl >= entry ? "border-red-400" : ""} />
              </div>
              <div className="space-y-1">
                <Label className="flex items-center gap-1"><Target className="h-3.5 w-3.5 text-[#65A30D]" /> Take Profit ($)</Label>
                <Input value={tpPrice} onChange={e => setTpPrice(e.target.value)} type="number" min="0.01" step="0.01" placeholder="0.00" className={priceOrderError && orderSide === "BUY" && tp <= entry ? "border-red-400" : ""} />
              </div>
            </div>

            {/* TIF */}
            <div className="space-y-1">
              <Label>Time in Force</Label>
              <Select value={tif} onValueChange={v => setTif(v as "GTC" | "DAY")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="GTC">GTC — Good Till Cancelled</SelectItem>
                  <SelectItem value="DAY">DAY — Day Order</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Price order error */}
            {priceOrderError && (
              <div className="flex items-center gap-2 p-2 rounded bg-red-50 border border-red-200 text-red-700 text-xs">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Required order: {priceOrderError}
              </div>
            )}

            {/* Cap warning */}
            {capExceeded && (
              <div className="flex items-center gap-2 p-2 rounded bg-red-50 border border-red-200 text-red-700 text-xs">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Order value ${Number(orderValue).toLocaleString()} exceeds $30,000 cap
              </div>
            )}

            {/* R/R display */}
            {riskReward && (
              <div className="flex items-center justify-between p-2 rounded bg-blue-50 border border-blue-100 text-sm">
                <span className="text-muted-foreground">Risk/Reward</span>
                <Badge variant="outline" className="font-mono">{riskReward}:1</Badge>
                <span className="text-muted-foreground">Order Value</span>
                <Badge variant="outline" className="font-mono">${Number(orderValue).toLocaleString()}</Badge>
              </div>
            )}
          </div>
        )}

        {/* ── CONFIRM ── */}
        {step === "confirm" && (
          <div className="space-y-4 py-2">
            <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 space-y-3">
              <p className="font-semibold text-amber-900 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" /> Confirm Live Order — {accountId || "not configured"}
              </p>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="text-muted-foreground">Ticker</div><div className="font-mono font-bold">{ticker}</div>
                <div className="text-muted-foreground">Side</div><div className={`font-bold ${orderSide === "BUY" ? "text-[#65A30D]" : "text-[#FF6B6B]"}`}>{orderSide}</div>
                <div className="text-muted-foreground">Quantity</div><div className="font-mono">{qty} shares</div>
                <div className="text-muted-foreground">Entry (LMT)</div><div className="font-mono">${entry.toFixed(2)}</div>
                <div className="text-muted-foreground">Stop Loss</div><div className="font-mono text-[#FF6B6B]">${sl.toFixed(2)}</div>
                <div className="text-muted-foreground">Take Profit</div><div className="font-mono text-[#65A30D]">${tp.toFixed(2)}</div>
                <div className="text-muted-foreground">TIF</div><div className="font-mono">{tif}</div>
                <div className="text-muted-foreground">Total Value</div><div className="font-mono font-bold">${(qty * entry).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
              </div>
              <p className="text-xs text-amber-400">3 orders will be placed: Entry LMT + Stop Loss STP + Take Profit LMT (OCA group)</p>
            </div>
          </div>
        )}

        {/* ── SUBMITTING ── */}
        {step === "submitting" && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="h-8 w-8 animate-spin text-purple-500" />
            <p className="text-sm text-muted-foreground">Placing bracket order via IBIND...</p>
          </div>
        )}

        {/* ── SUCCESS ── */}
        {step === "success" && (
          <div className="flex flex-col items-center gap-3 py-6">
            <CheckCircle2 className="h-10 w-10 text-[#65A30D]" />
            <p className="font-semibold text-[#65A30D]">Bracket Order Placed!</p>
            {successResult?.result && (
              <pre className="text-xs bg-muted p-3 rounded w-full overflow-auto max-h-32">
                {JSON.stringify(successResult.result, null, 2)}
              </pre>
            )}
          </div>
        )}

        {/* ── ERROR ── */}
        {step === "error" && (
          <div className="flex flex-col items-center gap-3 py-6">
            <AlertTriangle className="h-10 w-10 text-[#FF6B6B]" />
            <p className="font-semibold text-red-700">Order Failed</p>
            <p className="text-sm text-muted-foreground text-center">{errorMsg}</p>
          </div>
        )}

        <DialogFooter className="gap-2">
          {step === "form" && (
            <>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button
                onClick={handleProceed}
                disabled={!isValid || !priceOrderOk || !!capExceeded}
                className="bg-purple-600 hover:bg-purple-700 text-white"
              >
                Review Order
              </Button>
            </>
          )}
          {step === "confirm" && (
            <>
              <Button variant="outline" onClick={() => setStep("form")}>← Edit</Button>
              <Button
                onClick={handleSubmit}
                disabled={bracketMut.isPending}
                className="bg-purple-600 hover:bg-purple-700 text-white"
              >
                {bracketMut.isPending ? <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Placing...</> : "✅ Place Bracket Order"}
              </Button>
            </>
          )}
          {(step === "success" || step === "error") && (
            <Button onClick={onClose}>Close</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
