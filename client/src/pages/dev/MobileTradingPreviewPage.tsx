/**
 * Dev-only mobile QA preview — mock data, no live orders.
 * Route: /dev/mobile-trading-preview (DEV only)
 */
import { useState, useEffect } from "react";
import { TradingCommandBar } from "@/components/deep-analysis/TradingCommandBar";
import { ManualOrderDialog } from "@/components/deep-analysis/ManualOrderDialog";
import { HoldToConfirmButton } from "@/components/HoldToConfirmButton";
import type { DeepAnalysisResult } from "@/components/deep-analysis/types";
import type { ManualOrderIntent } from "@/lib/manualOrderContract";

const MOCK: DeepAnalysisResult = {
  ticker: "AAPL",
  company: "Apple Inc.",
  score: 7.42,
  tier: "Gold Retest",
  price: 198.5,
  changePercent: 1.24,
  ema50: 192.1,
  ema200: 178.4,
  donchian20High: 205.2,
  weeklyEma50Slope: 0.012,
  distToEma50Pct: 3.3,
  rsi: 58.2,
  volumeRatio: 1.15,
  atr14: 3.8,
  priceAction: "Higher low",
  zivReason: "Retest of breakout zone holding.",
  conditions: [],
  passCount: 5,
  entryReady: true,
  recommendedBuyPrice: 195.0,
  buyPriceRationale: "Near EMA-50 support",
  stopLoss: 188.5,
  stopLossPct: 3.3,
  atrStopLoss: 187.2,
  emaStopLoss: 186.3,
  ai: {
    recommendation: "HOLD — momentum intact, wait for volume confirmation on add.",
    positionRationale: "",
    risks: "",
    actionTrigger: "",
    summary: "",
  },
  positionSizeUsd: 10000,
  positionSizePct: 5,
  suggestedShares: 50,
  positionSizeRationale: "Tier cap",
  tierLabel: "Gold",
  totalPortfolioValue: 200000,
  analyzedAt: new Date().toISOString(),
  currencySymbol: "$",
};

export default function MobileTradingPreviewPage() {
  const [intent, setIntent] = useState<ManualOrderIntent | null>(null);
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState("50");
  const [sl, setSl] = useState("188.50");
  const [tp, setTp] = useState("224.00");

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("dialog");
    if (q === "buy") {
      setIntent("open_long");
      setOpen(true);
    }
  }, []);

  const openIntent = (i: ManualOrderIntent) => {
    setIntent(i);
    setOpen(true);
  };

  return (
    <div className="min-h-screen bg-slate-100 p-2 max-w-[375px] mx-auto" data-testid="mobile-trading-preview">
      <p className="text-[10px] text-center text-slate-500 mb-2">DEV QA · 375px · mock · no orders</p>
      <TradingCommandBar
        ticker="AAPL"
        result={MOCK}
        currencySymbol="$"
        livePrice={198.5}
        liveChangePercent={1.24}
        warAction="HOLD"
        warScore={6.8}
        ibkrConnected
        ibkrConid={265598}
        manualPending={false}
        blockedBuy={false}
        blockedSell={true}
        longUnits={120}
        shortUnits={0}
        onOpenManualOrder={(i) => openIntent(i)}
      />
      <div className="mt-3 p-2 bg-orange-50 border border-orange-200 rounded text-[11px] text-orange-900">
        SELL חסום לדוגמה (stalled AAPL:SELL) — BUY פעיל
      </div>
      <div className="mt-3 flex items-center justify-between p-3 bg-white border rounded-xl">
        <span className="text-[11px] font-bold">חיסול × (War Room)</span>
        <HoldToConfirmButton
          title="חיסול מהיר — החזק 0.6 שניות"
          className="w-11 h-11 border border-red-200 text-red-500"
          onConfirm={() => {}}
        >
          <span className="text-base font-bold">×</span>
        </HoldToConfirmButton>
      </div>
      <ManualOrderDialog
        open={open}
        onOpenChange={(o) => { setOpen(o); if (!o) setIntent(null); }}
        ticker="AAPL"
        manualIntent={intent}
        result={MOCK}
        currencySymbol="$"
        livePrice={198.5}
        mktQty={qty}
        onMktQtyChange={setQty}
        manualSl={sl}
        onManualSlChange={setSl}
        manualTp={tp}
        onManualTpChange={setTp}
        longUnits={120}
        shortUnits={0}
        warScore={6.8}
        manualPending={false}
        submitDisabled={false}
        onSubmit={() => setOpen(false)}
      />
    </div>
  );
}
