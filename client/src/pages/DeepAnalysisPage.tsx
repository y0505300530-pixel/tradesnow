/**
 * DeepAnalysisPage — Standalone full-page Deep Analysis
 * Route: /deep-analysis/:ticker
 *
 * Renders the DeepAnalysisModal content directly as a page (no overlay/backdrop).
 * Loads Holding 1 data to pass holdingContext + conid when the ticker is held.
 */
import { useParams, useLocation } from "wouter";
import { useMemo } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DeepAnalysisModal } from "@/components/DeepAnalysisModal";
import { trpc } from "@/lib/trpc";

export default function DeepAnalysisPage() {
  const params = useParams<{ ticker: string }>();
  const [, navigate] = useLocation();
  const ticker = params.ticker?.toUpperCase() ?? null;

  // Load Holding 1 data to detect if this ticker is held
  const { data: state } = trpc.portfolio.getState.useQuery(undefined, {
    staleTime: 30_000,
    enabled: !!ticker,
  });

  // Build holdingContext + conid if ticker is in Holding 1
  const { holdingContext, conid } = useMemo(() => {
    if (!ticker || !state?.holdings) return { holdingContext: undefined, conid: undefined };
    const h = (state.holdings as any[]).find(
      (h) => h.ticker?.toUpperCase() === ticker && (h.units ?? 0) > 0
    );
    if (!h) return { holdingContext: undefined, conid: undefined };
    const currentPrice = h.currentPrice ?? h.buyPrice;
    const pnlUsd = (currentPrice - h.buyPrice) * h.units;
    const pnlPct = h.buyPrice > 0 ? ((currentPrice - h.buyPrice) / h.buyPrice) * 100 : 0;
    return {
      holdingContext: {
        id: h.id > 0 ? h.id : undefined,
        buyPrice: h.buyPrice,
        units: h.units,
        currentPrice,
        pnlUsd,
        pnlPct,
        stopLoss: h.stopLoss != null ? parseFloat(String(h.stopLoss)) : undefined,
        takeProfit: h.takeProfit != null ? parseFloat(String(h.takeProfit)) : undefined,
        whyBought: h.whyBought ?? undefined,
        expectations: h.expectations ?? undefined,
      },
      conid: h.conid ?? undefined,
    };
  }, [ticker, state?.holdings]);

  if (!ticker) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <p className="text-muted-foreground">No ticker specified.</p>
        <Button variant="outline" onClick={() => navigate("/catalogue")}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Catalogue
        </Button>
      </div>
    );
  }

  return (
    <DeepAnalysisModal
      ticker={ticker}
      open={true}
      onClose={() => {
        if (window.history.length > 1) {
          window.history.back();
        } else {
          navigate("/catalogue");
        }
      }}
      pageMode={true}
      holdingContext={holdingContext}
      conid={conid}
    />
  );
}
