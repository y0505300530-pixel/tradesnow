import { useState, useEffect } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";

interface EditCatalogueDialogProps {
  asset: { id: number; ticker: string; company: string; sector: string } | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function EditCatalogueDialog({ asset, open, onClose, onSaved }: EditCatalogueDialogProps) {
  const [company, setCompany] = useState(asset?.company ?? "");
  const [sector, setSector] = useState(asset?.sector ?? "");

  useEffect(() => {
    if (asset) {
      setCompany(asset.company);
      setSector(asset.sector);
    }
  }, [asset]);

  const utils = trpc.useUtils();
  const updateMut = trpc.assetCatalogue.upsertUserAsset.useMutation({
    onSuccess: () => {
      toast.success(`${asset?.ticker} updated`);
      utils.portfolio.getCatalogueWithScores.invalidate();
      onSaved();
      onClose();
    },
    onError: (e: { message: string }) => toast.error(e.message),
  });

  if (!asset) return null;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit {asset.ticker}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Company Name</label>
            <Input value={company} onChange={e => setCompany(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Sector</label>
            <Input value={sector} onChange={e => setSector(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => updateMut.mutate({ ticker: asset.ticker, companyName: company, sector })}
            disabled={updateMut.isPending}
          >
            {updateMut.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

