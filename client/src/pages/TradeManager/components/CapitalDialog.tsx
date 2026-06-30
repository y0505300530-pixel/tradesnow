import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, ArrowDownCircle, ArrowUpCircle } from "lucide-react";

interface CapitalDialogProps {
  mode: "deposit" | "withdraw";
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}

export function CapitalDialog({ mode, open, onClose, onDone }: CapitalDialogProps) {
  const [amount, setAmount] = useState("");
  const [withdrawResult, setWithdrawResult] = useState<any>(null);

  const depositMut = trpc.portfolio.deposit.useMutation({
    onSuccess: () => {
      toast.success(`$${parseFloat(amount).toLocaleString()} deposited successfully`);
      setAmount("");
      onDone();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const withdrawMut = trpc.portfolio.requestWithdrawal.useMutation({
    onSuccess: (data) => {
      setWithdrawResult(data);
      onDone();
    },
    onError: (e) => toast.error(e.message),
  });

  const handleSubmit = () => {
    if (!amount || parseFloat(amount) <= 0) return toast.error("Enter a valid amount");
    if (mode === "deposit") depositMut.mutate({ amount: parseFloat(amount) });
    else withdrawMut.mutate({ amount: parseFloat(amount) });
  };

  const isPending = depositMut.isPending || withdrawMut.isPending;

  return (
    <Dialog open={open} onOpenChange={() => { onClose(); setWithdrawResult(null); setAmount(""); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {mode === "deposit"
              ? <><ArrowDownCircle className="h-5 w-5 text-[#65A30D]" /> Deposit Capital</>
              : <><ArrowUpCircle className="h-5 w-5 text-amber-500" /> Request Withdrawal</>
            }
          </DialogTitle>
        </DialogHeader>

        {!withdrawResult ? (
          <div className="space-y-4 py-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Amount (USD) *</label>
              <Input type="number" placeholder="e.g. 5000" value={amount} onChange={e => setAmount(e.target.value)} />
            </div>
            {mode === "withdraw" && (
              <p className="text-xs text-muted-foreground bg-amber-50 border border-amber-100 rounded px-3 py-2">
                If cash balance is insufficient, the AI will recommend which positions to sell to raise the required amount.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <div className={`rounded-lg px-4 py-3 text-sm ${withdrawResult.method === "cash" ? "bg-emerald-50 text-[#65A30D]" : "bg-amber-50 text-amber-400"}`}>
              {withdrawResult.message}
            </div>
            {withdrawResult.sellRecommendations?.length > 0 && (
              <div>
                <p className="text-xs font-semibold mb-2">AI Sell Recommendations:</p>
                <div className="space-y-2">
                  {withdrawResult.sellRecommendations.map((rec: any, i: number) => (
                    <div key={i} className="flex items-start gap-3 bg-muted/40 rounded px-3 py-2 text-sm">
                      <Badge variant="outline" className="font-mono text-xs">{rec.ticker}</Badge>
                      <div className="flex-1">
                        <span className="font-medium">Sell {rec.units_to_sell} units</span>
                        <span className="text-muted-foreground ml-2">≈ ${rec.estimated_proceeds?.toLocaleString()}</span>
                        <p className="text-xs text-muted-foreground mt-0.5">{rec.reason}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => { onClose(); setWithdrawResult(null); setAmount(""); }}>
            {withdrawResult ? "Close" : "Cancel"}
          </Button>
          {!withdrawResult && (
            <Button onClick={handleSubmit} disabled={isPending} className={mode === "deposit" ? "" : "bg-amber-500 hover:bg-amber-600"}>
              {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              {mode === "deposit" ? "Deposit" : "Get Sell Plan"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
