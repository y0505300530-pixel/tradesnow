import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, Plus, CheckCircle, XCircle } from "lucide-react";
import { TickerAutocomplete } from "@/components/TickerAutocomplete";

interface AddHoldingDialogProps {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
  cashBalance?: number;
}

export function AddHoldingDialog({ open, onClose, onAdded, cashBalance = 0 }: AddHoldingDialogProps) {
  const [ticker, setTicker] = useState("");
  const [buyPrice, setBuyPrice] = useState("");
  const [units, setUnits] = useState("");
  const [notes, setNotes] = useState("");
  const [transactionDate, setTransactionDate] = useState(() => new Date().toISOString().split("T")[0]);
  // Live ticker validation
  const [tickerStatus, setTickerStatus] = useState<"idle" | "checking" | "valid" | "invalid">("idle");
  const [validatedCompany, setValidatedCompany] = useState<string | null>(null);
  const [validatedPrice, setValidatedPrice] = useState<number | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const utils = trpc.useUtils();

  useEffect(() => {
    const t = ticker.trim().toUpperCase();
    if (!t || t.length < 1) {
      setTickerStatus("idle");
      setValidatedCompany(null);
      setValidatedPrice(null);
      return;
    }
    setTickerStatus("checking");
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const result = await utils.portfolio.validateTicker.fetch({ ticker: t });
        if (result.valid) {
          setTickerStatus("valid");
          setValidatedCompany(result.company);
          setValidatedPrice(result.price);
          if (!buyPrice && result.price) setBuyPrice(result.price.toFixed(2));
        } else {
          setTickerStatus("invalid");
          setValidatedCompany(null);
          setValidatedPrice(null);
        }
      } catch {
        setTickerStatus("invalid");
      }
    }, 700);
  }, [ticker]);

  const addMut = trpc.portfolio.addHolding.useMutation({
    onSuccess: (data) => {
      const cost = parseFloat(buyPrice || "0") * parseFloat(units || "0");
      const cashAfter = data.cashAfter ?? cashBalance - cost;
      toast.success(`${ticker.toUpperCase()} added · Cash: $${cashAfter.toLocaleString(undefined, { maximumFractionDigits: 0 })}`, { duration: 4000 });
      setTicker(""); setBuyPrice(""); setUnits(""); setNotes("");
      setTickerStatus("idle"); setValidatedCompany(null); setValidatedPrice(null);
      onAdded();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const handleAdd = () => {
    if (!ticker || !buyPrice || !units) return toast.error("Ticker, buy price and units are required");
    if (tickerStatus === "invalid") return toast.error("Ticker not found — please check the symbol");
    const cost = parseFloat(buyPrice || "0") * parseFloat(units || "0");
    if (cost > cashBalance) {
      toast.warning(`Insufficient cash — need $${cost.toLocaleString(undefined, { maximumFractionDigits: 0 })} but have $${cashBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })}. Adding anyway (overdraft).`, { duration: 5000 });
    }
    addMut.mutate({
      ticker: ticker.toUpperCase(),
      buyPrice: parseFloat(buyPrice),
      units: parseFloat(units),
      notes: notes || undefined,
      transactionDate: transactionDate || undefined,
    });
  };

  const tickerIcon = () => {
    if (tickerStatus === "checking") return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
    if (tickerStatus === "valid") return <CheckCircle className="h-4 w-4 text-[#65A30D]" />;
    if (tickerStatus === "invalid") return <XCircle className="h-4 w-4 text-[#FF6B6B]" />;
    return null;
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5 text-[#C9A84C]" /> Add Holding
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {/* Ticker with live validation */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Ticker Symbol *</label>
            <div className="relative">
              <TickerAutocomplete
                value={ticker}
                onChange={(symbol, name) => {
                  setTicker(symbol);
                  if (name && !validatedCompany) setValidatedCompany(name);
                }}
                placeholder="e.g. AAPL"
                inputClassName={`font-mono pr-9 ${
                  tickerStatus === "valid" ? "border-emerald-400 focus-visible:ring-emerald-300" :
                  tickerStatus === "invalid" ? "border-red-400 focus-visible:ring-red-300" : ""
                }`}
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none z-10">{tickerIcon()}</div>
            </div>
            {tickerStatus === "valid" && validatedCompany && (
              <div className="mt-1 flex items-center gap-2 text-xs text-[#65A30D]">
                <CheckCircle className="h-3 w-3" />
                <span className="font-medium">{validatedCompany}</span>
                {validatedPrice && <span className="text-muted-foreground">— ${validatedPrice.toFixed(2)}</span>}
              </div>
            )}
            {tickerStatus === "invalid" && (
              <p className="mt-1 text-xs text-[#FF6B6B]">Ticker not found on Yahoo Finance</p>
            )}
          </div>
          {/* Units + Buy Price */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Units / Shares *</label>
              <Input type="number" placeholder="e.g. 10" value={units} onChange={e => setUnits(e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Buy Price (USD) *</label>
              <Input type="number" placeholder="e.g. 185.50" value={buyPrice} onChange={e => setBuyPrice(e.target.value)} />
            </div>
          </div>
          {/* Transaction Date */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Transaction Date</label>
            <Input
              type="date"
              value={transactionDate}
              onChange={e => setTransactionDate(e.target.value)}
              max={new Date().toISOString().split("T")[0]}
            />
          </div>
          {/* Notes */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Notes (optional)</label>
            <Input placeholder="e.g. Breakout entry" value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
          {/* Cost basis summary */}
          {buyPrice && units && (() => {
            const cost = parseFloat(buyPrice || "0") * parseFloat(units || "0");
            const cashAfter = cashBalance - cost;
            const insufficient = cost > cashBalance;
            return (
              <div className={`text-xs rounded px-3 py-2 space-y-1 ${
                insufficient ? "bg-red-500/10 border border-red-400/30" : "bg-muted/40"
              }`}>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Total cost:</span>
                  <span className="font-semibold text-foreground">${cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Cash balance now:</span>
                  <span className="font-semibold text-foreground">${cashBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                </div>
                <div className="flex items-center justify-between border-t border-border/40 pt-1">
                  <span className={insufficient ? "text-[#FF6B6B] font-medium" : "text-muted-foreground"}>Cash after purchase:</span>
                  <span className={`font-bold ${
                    insufficient ? "text-[#FF6B6B]" : cashAfter < cashBalance * 0.1 ? "text-amber-500" : "text-[#65A30D]"
                  }`}>${cashAfter.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                </div>
                {insufficient && (
                  <p className="text-[#FF6B6B] text-[10px] mt-1">⚠ Insufficient cash balance — will result in overdraft</p>
                )}
              </div>
            );
          })()}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleAdd} disabled={addMut.isPending || tickerStatus === "checking"}>
            {addMut.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
            Add Holding
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
