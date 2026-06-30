/**
 * IBKROrderDialog — Place a buy or sell order via IBKR Client Portal Gateway
 *
 * Pre-fills quantity, order type, and SL/TP from Ziv Engine analysis.
 * Handles the two-step order confirmation flow (some orders require a reply confirmation).
 */

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, AlertTriangle, CheckCircle2, TrendingUp, TrendingDown } from "lucide-react";
import { toast } from "sonner";
import { ibkrClient, type IbkrOrderResult } from "@/lib/ibkr";
import { trpc } from "@/lib/trpc";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IBKROrderDialogProps {
  open: boolean;
  onClose: () => void;
  ticker: string;
  company?: string;
  currentPrice?: number;
  // Pre-filled from Ziv Engine analysis
  suggestedUnits?: number;
  stopLoss?: number;
  takeProfit?: number;
  side?: "BUY" | "SELL";
  // IBKR account context
  accountId: string;
  gatewayUrl: string;
}

type OrderStep = "form" | "confirming" | "success" | "error";

// ── Component ─────────────────────────────────────────────────────────────────

export function IBKROrderDialog({
  open, onClose, ticker, company, currentPrice,
  suggestedUnits, stopLoss, takeProfit, side = "BUY",
  accountId, gatewayUrl,
}: IBKROrderDialogProps) {

  const logOrderMut = trpc.ibkr.logOrder.useMutation();

  // Form state
  const [orderSide, setOrderSide] = useState<"BUY" | "SELL">(side);
  const [orderType, setOrderType] = useState<"MKT" | "LMT" | "STP">("LMT");
  const [quantity, setQuantity] = useState(suggestedUnits?.toString() ?? "1");
  const [limitPrice, setLimitPrice] = useState(currentPrice?.toFixed(2) ?? "");
  const [stopPrice, setStopPrice] = useState("");
  const [tif, setTif] = useState<"DAY" | "GTC">("DAY");

  // Order flow state
  const [step, setStep] = useState<OrderStep>("form");
  const [conid, setConid] = useState<number | null>(null);
  const [pendingReplyId, setPendingReplyId] = useState<string | null>(null);
  const [orderResult, setOrderResult] = useState<IbkrOrderResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [lookingUpConid, setLookingUpConid] = useState(false);

  // Reset when dialog opens
  useEffect(() => {
    if (open) {
      setOrderSide(side);
      setOrderType("LMT");
      setQuantity(suggestedUnits?.toString() ?? "1");
      setLimitPrice(currentPrice?.toFixed(2) ?? "");
      setStopPrice(stopLoss?.toFixed(2) ?? "");
      setStep("form");
      setConid(null);
      setPendingReplyId(null);
      setOrderResult(null);
      setErrorMsg("");
    }
  }, [open, side, suggestedUnits, currentPrice, stopLoss]);

  // Look up conid when dialog opens
  useEffect(() => {
    if (!open || !ticker) return;
    setLookingUpConid(true);
    ibkrClient.setGatewayUrl(gatewayUrl);
    ibkrClient.getConidForTicker(ticker)
      .then(id => { setConid(id); })
      .catch(() => { setConid(null); })
      .finally(() => setLookingUpConid(false));
  }, [open, ticker, gatewayUrl]);

  const handlePlaceOrder = async () => {
    if (!conid) {
      setErrorMsg(`Could not find contract ID for ${ticker}. The Gateway may not be connected.`);
      setStep("error");
      return;
    }

    const qty = parseFloat(quantity);
    if (!qty || qty <= 0) {
      toast.error("Invalid quantity");
      return;
    }

    setStep("confirming");
    setErrorMsg("");

    try {
      ibkrClient.setGatewayUrl(gatewayUrl);

      const orderParams: Parameters<typeof ibkrClient.placeOrder>[1] = {
        conid,
        side: orderSide,
        orderType,
        quantity: qty,
        tif,
      };

      if (orderType === "LMT" && limitPrice) {
        orderParams.price = parseFloat(limitPrice);
      }
      if (orderType === "STP" && stopPrice) {
        orderParams.auxPrice = parseFloat(stopPrice);
      }

      const results = await ibkrClient.placeOrder(accountId, orderParams);
      const result = results[0];

      // Check if confirmation required (stop orders, etc.)
      if (result?.id && result?.message) {
        // Gateway wants confirmation
        setPendingReplyId(result.id);
        setOrderResult(result);
        // Auto-confirm
        const confirmResults = await ibkrClient.confirmOrder(result.id);
        const confirmed = confirmResults[0];
        setOrderResult(confirmed);
        setStep("success");

        // Log to DB
        await logOrderMut.mutateAsync({
          ticker, conid, side: orderSide, orderType, quantity: qty,
          price: orderType === "LMT" ? parseFloat(limitPrice) : undefined,
          stopPrice: orderType === "STP" ? parseFloat(stopPrice) : undefined,
          ibkrOrderId: confirmed.order_id,
          status: confirmed.order_status,
          accountId,
        });
      } else if (result?.order_id) {
        setOrderResult(result);
        setStep("success");

        // Log to DB
        await logOrderMut.mutateAsync({
          ticker, conid, side: orderSide, orderType, quantity: qty,
          price: orderType === "LMT" ? parseFloat(limitPrice) : undefined,
          ibkrOrderId: result.order_id,
          status: result.order_status,
          accountId,
        });
      } else {
        throw new Error(result?.encrypt_message ?? "Unexpected response from Gateway");
      }

      toast.success(`${orderSide} order for ${qty} ${ticker} submitted!`);

    } catch (err: any) {
      setErrorMsg(err.message ?? "Order failed");
      setStep("error");
      toast.error("Order failed: " + (err.message ?? "Unknown error"));
    }
  };

  const risk = stopLoss && currentPrice ? currentPrice - stopLoss : null;
  const rr = risk && takeProfit && currentPrice ? ((takeProfit - currentPrice) / risk).toFixed(1) : null;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {orderSide === "BUY"
              ? <TrendingUp className="h-4 w-4 text-[#65A30D]" />
              : <TrendingDown className="h-4 w-4 text-[#FF6B6B]" />
            }
            IBKR Order — {ticker}
            {company && <span className="text-sm font-normal text-muted-foreground">{company}</span>}
          </DialogTitle>
        </DialogHeader>

        {step === "form" && (
          <div className="space-y-4 py-2">

            {/* Account + conid info */}
            <div className="flex items-center justify-between text-xs text-muted-foreground bg-muted/30 rounded-md px-3 py-2">
              <span>Account: <strong className="text-foreground">{accountId}</strong></span>
              <span>
                {lookingUpConid
                  ? <Loader2 className="h-3 w-3 animate-spin inline" />
                  : conid
                  ? <span className="text-[#65A30D]">conid: {conid}</span>
                  : <span className="text-amber-600">conid not found</span>
                }
              </span>
            </div>

            {/* Ziv Engine context */}
            {(stopLoss || takeProfit) && (
              <div className="grid grid-cols-3 gap-2 text-xs">
                {currentPrice && (
                  <div className="rounded-md bg-muted/30 px-2 py-1.5 text-center">
                    <p className="text-muted-foreground">Current</p>
                    <p className="font-mono font-semibold">${currentPrice.toFixed(2)}</p>
                  </div>
                )}
                {stopLoss && (
                  <div className="rounded-md bg-red-50 border border-red-100 px-2 py-1.5 text-center">
                    <p className="text-[#FF6B6B]">Stop Loss</p>
                    <p className="font-mono font-semibold text-red-700">${stopLoss.toFixed(2)}</p>
                  </div>
                )}
                {takeProfit && (
                  <div className="rounded-md bg-emerald-50 border border-emerald-100 px-2 py-1.5 text-center">
                    <p className="text-[#65A30D]">Take Profit</p>
                    <p className="font-mono font-semibold text-[#65A30D]">${takeProfit.toFixed(2)}</p>
                  </div>
                )}
              </div>
            )}
            {rr && <p className="text-xs text-center text-muted-foreground">Risk/Reward: <strong>{rr}R</strong></p>}

            {/* Order form */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs mb-1 block">Side</Label>
                <Select value={orderSide} onValueChange={v => setOrderSide(v as "BUY" | "SELL")}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="BUY">BUY</SelectItem>
                    <SelectItem value="SELL">SELL</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs mb-1 block">Order Type</Label>
                <Select value={orderType} onValueChange={v => setOrderType(v as "MKT" | "LMT" | "STP")}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MKT">Market (MKT)</SelectItem>
                    <SelectItem value="LMT">Limit (LMT)</SelectItem>
                    <SelectItem value="STP">Stop (STP)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs mb-1 block">Quantity</Label>
                <Input
                  value={quantity}
                  onChange={e => setQuantity(e.target.value)}
                  type="number"
                  min="1"
                  className="h-8 text-xs font-mono"
                  placeholder="e.g. 10"
                />
                {suggestedUnits && (
                  <p className="text-xs text-muted-foreground mt-0.5">Suggested: {suggestedUnits} (2% risk)</p>
                )}
              </div>
              <div>
                <Label className="text-xs mb-1 block">Time in Force</Label>
                <Select value={tif} onValueChange={v => setTif(v as "DAY" | "GTC")}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="DAY">Day</SelectItem>
                    <SelectItem value="GTC">GTC</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {orderType === "LMT" && (
                <div className="col-span-2">
                  <Label className="text-xs mb-1 block">Limit Price</Label>
                  <Input
                    value={limitPrice}
                    onChange={e => setLimitPrice(e.target.value)}
                    type="number"
                    step="0.01"
                    className="h-8 text-xs font-mono"
                    placeholder="e.g. 150.00"
                  />
                </div>
              )}
              {orderType === "STP" && (
                <div className="col-span-2">
                  <Label className="text-xs mb-1 block">Stop Price</Label>
                  <Input
                    value={stopPrice}
                    onChange={e => setStopPrice(e.target.value)}
                    type="number"
                    step="0.01"
                    className="h-8 text-xs font-mono"
                    placeholder={stopLoss?.toFixed(2) ?? "e.g. 140.00"}
                  />
                </div>
              )}
            </div>

            {/* Warning for live account */}
            {accountId && !accountId.startsWith("DU") && (
              <div className="flex items-center gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span><strong>Live account</strong> — this will place a real order with real money.</span>
              </div>
            )}
          </div>
        )}

        {step === "confirming" && (
          <div className="flex flex-col items-center gap-3 py-6">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Submitting order to IBKR...</p>
          </div>
        )}

        {step === "success" && orderResult && (
          <div className="flex flex-col items-center gap-3 py-4">
            <CheckCircle2 className="h-10 w-10 text-[#65A30D]" />
            <p className="text-sm font-semibold">Order Submitted!</p>
            <div className="text-xs text-muted-foreground text-center space-y-1">
              <p>Order ID: <strong className="font-mono text-foreground">{orderResult.order_id}</strong></p>
              <p>Status: <Badge variant="outline" className="text-xs">{orderResult.order_status}</Badge></p>
            </div>
          </div>
        )}

        {step === "error" && (
          <div className="flex flex-col items-center gap-3 py-4">
            <AlertTriangle className="h-10 w-10 text-[#FF6B6B]" />
            <p className="text-sm font-semibold text-red-700">Order Failed</p>
            <p className="text-xs text-muted-foreground text-center max-w-xs">{errorMsg}</p>
          </div>
        )}

        <DialogFooter>
          {step === "form" && (
            <>
              <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
              <Button
                size="sm"
                onClick={handlePlaceOrder}
                disabled={!conid || lookingUpConid}
                className={orderSide === "BUY" ? "bg-[#65A30D] hover:bg-[#17a87e]" : "bg-[#FF6B6B] hover:bg-[#e05555]"}
              >
                {lookingUpConid
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                  : null
                }
                Place {orderSide} Order
              </Button>
            </>
          )}
          {(step === "success" || step === "error") && (
            <Button size="sm" onClick={onClose}>Close</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
