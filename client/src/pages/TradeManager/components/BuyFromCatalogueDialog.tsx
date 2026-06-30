import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, TrendingUp } from "lucide-react";
import { ScoreBadge } from "./ScoreBadge";

interface BuyFromCatalogueDialogProps {
  ticker: string;
  company: string;
  score: number | null;
  open: boolean;
  onClose: () => void;
  onBought: () => void;
  cashBalance: number;
}

export function BuyFromCatalogueDialog({ ticker, company, score, open, onClose, onBought, cashBalance }: BuyFromCatalogueDialogProps) {
  const [units, setUnits] = useState("");
  const [customPrice, setCustomPrice] = useState("");
  const utils = trpc.useUtils();

  // Fetch live price
  const { data: liveData } = trpc.portfolio.validateTicker.useQuery(
    { ticker },
    { enabled: open }
  );
  const livePrice = liveData?.price ?? null;
  const effectivePrice = customPrice ? parseFloat(customPrice) : (livePrice ?? 0);
  const cost = effectivePrice * (parseFloat(units) || 0);

  const buyMut = trpc.portfolio.buyFromCatalogue.useMutation({
    onSuccess: (data) => {
      toast.success(`Bought ${ticker} × ${units} @ $${data.price.toFixed(2)} — Cash: $${data.newCash.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
      setUnits(""); setCustomPrice("");
      utils.portfolio.getState.invalidate();
      utils.portfolio.getCatalogueWithScores.invalidate();
      onBought();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const handleBuy = () => {
    if (!units || parseFloat(units) <= 0) return toast.error("Enter number of units");
    buyMut.mutate({ ticker, units: parseFloat(units), buyPrice: customPrice ? parseFloat(customPrice) : undefined });
  };

  return (
    <Dialog open={open} onOpenChange={() => { onClose(); setUnits(""); setCustomPrice(""); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-[#65A30D]" />
            Buy {ticker}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="flex items-center justify-between text-sm bg-muted/30 rounded-lg px-3 py-2">
            <span className="text-muted-foreground">{company}</span>
            {score !== null && <ScoreBadge score={score} />}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Live Price</label>
              <div className="h-9 flex items-center px-3 bg-muted/30 rounded-md text-sm font-mono font-semibold">
                {livePrice ? `$${livePrice.toFixed(2)}` : "Loading..."}
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Override Price (opt.)</label>
              <Input type="number" placeholder={livePrice ? livePrice.toFixed(2) : "—"} value={customPrice}
                onChange={e => setCustomPrice(e.target.value)} className="h-9" />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Units / Shares *</label>
            <Input type="number" placeholder="e.g. 10" value={units} onChange={e => setUnits(e.target.value)}
              autoFocus className="h-9" onKeyDown={e => e.key === "Enter" && handleBuy()} />
          </div>
          {parseFloat(units) > 0 && effectivePrice > 0 && (
            <div className="rounded-lg px-3 py-2.5 text-sm flex items-center justify-between bg-emerald-50 text-[#65A30D] border border-emerald-200">
              <span>Total cost: <strong>${cost.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></span>
              <span className="text-xs">Cash after: ${(cashBalance - cost).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { onClose(); setUnits(""); setCustomPrice(""); }}>Cancel</Button>
          <Button onClick={handleBuy} disabled={buyMut.isPending}
            className="bg-[#65A30D] hover:bg-[#17a87e]">
            {buyMut.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <TrendingUp className="h-4 w-4 mr-2" />}
            Buy {ticker}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
