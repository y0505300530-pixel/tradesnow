/**
 * IBKRAccountPage — Dedicated page for IBKR account information
 * Shows: Connection status, Account Summary, Positions, Open Orders
 */

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  RefreshCw, Loader2, TrendingUp, TrendingDown, DollarSign,
  Activity, BarChart2, ShoppingCart, AlertTriangle, CheckCircle2,
  WifiOff, Wifi, ArrowUpRight, ArrowDownRight,
} from "lucide-react";
import { toast } from "sonner";
import { ibkrClient, type IbkrAccount, type IbkrAccountSummary, type IbkrPosition } from "@/lib/ibkr";
import { useLocation } from "wouter";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(amount: number | undefined, currency = "USD") {
  if (amount === undefined || amount === null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
}

function fmtPct(value: number | undefined) {
  if (value === undefined || value === null) return "—";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

// ── Summary Card ──────────────────────────────────────────────────────────────

function SummaryMetric({
  label, value, sub, positive, icon,
}: {
  label: string;
  value: string;
  sub?: string;
  positive?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground font-medium">{label}</span>
        {icon && <span className="text-muted-foreground">{icon}</span>}
      </div>
      <span className={`text-xl font-bold font-mono ${
        positive === true ? "text-[#65A30D]" :
        positive === false ? "text-[#FF6B6B]" :
        "text-foreground"
      }`}>{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function IBKRAccountPage() {
  const [, setLocation] = useLocation();

  const [loading, setLoading] = useState(false);
  const [authStatus, setAuthStatus] = useState<"checking" | "connected" | "disconnected">("checking");
  const [connectedVia, setConnectedVia] = useState<"iBeam" | "IBIND" | null>(null);
  const [accounts, setAccounts] = useState<IbkrAccount[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<IbkrAccount | null>(null);
  const [summary, setSummary] = useState<IbkrAccountSummary | null>(null);
  const [positions, setPositions] = useState<IbkrPosition[]>([]);
  const [openOrders, setOpenOrders] = useState<any[]>([]);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [todayCommissions, setTodayCommissions] = useState<number | null>(null);
  const [todayTrades, setTodayTrades] = useState<number | null>(null);
  const [todayVolume, setTodayVolume] = useState<number | null>(null);

  // ── Check auth + load data on mount ──────────────────────────────────────────

  const loadAll = useCallback(async (accId?: string) => {
    setLoading(true);
    try {
      // 1. Check iBeam auth OR IBIND health
      let ibeamOk = false;
      let ibindOk = false;
      try {
        const authRes = await fetch("/api/ibkr-proxy/auth-status");
        const authData = await authRes.json() as { authenticated?: boolean };
        ibeamOk = !!authData.authenticated;
      } catch { /* iBeam offline */ }
      if (!ibeamOk) {
        try {
          const ibindRes = await fetch("/api/ibind/health");
          const ibindData = await ibindRes.json() as { session_active?: boolean };
          ibindOk = !!ibindData.session_active;
        } catch { /* IBIND offline */ }
      }
      if (!ibeamOk && !ibindOk) {
        setAuthStatus("disconnected");
        setLoading(false);
        return;
      }
      setAuthStatus("connected");
      // If only IBIND is connected, load data from IBIND endpoints
      if (!ibeamOk && ibindOk) {
        setConnectedVia("IBIND");
        const [posRes, ordRes, sumRes] = await Promise.allSettled([
          fetch("/api/ibind/positions").then(r => r.json()),
          fetch("/api/ibind/orders").then(r => r.json()),
          fetch("/api/ibind/account-summary").then(r => r.json()),
        ]);
        // Unwrap { positions: [...] } wrapper if present
        const rawPositions = posRes.status === "fulfilled"
          ? (Array.isArray(posRes.value) ? posRes.value : (posRes.value?.positions ?? []))
          : [];
        if (rawPositions.length > 0) {
          // Map IBIND position schema to IbkrPosition shape
          // IBIND fields: acctId, contractDesc (ticker), conid, position, avgCost, avgPrice,
          //               mktPrice, mktValue, unrealizedPnl, realizedPnl, currency
          const mapped = rawPositions
            .filter((p: any) => (p.position ?? 0) !== 0) // hide 0-unit positions
            .map((p: any) => ({
              acctId: p.acctId ?? p.accountId ?? "",
              conid: p.conid ?? 0,
              contractDesc: p.contractDesc ?? p.symbol ?? "",
              ticker: p.contractDesc ?? p.symbol ?? "",
              name: p.contractDesc ?? p.symbol ?? "",
              fullName: p.contractDesc ?? p.symbol ?? "",
              position: p.position ?? 0,
              avgCost: p.avgCost ?? 0,
              avgPrice: p.avgPrice ?? p.avgCost ?? 0,
              mktPrice: p.mktPrice ?? (p.mktValue && p.position ? p.mktValue / p.position : 0),
              mktValue: p.mktValue ?? 0,
              unrealizedPnl: p.unrealizedPnl ?? 0,
              realizedPnl: p.realizedPnl ?? 0,
              currency: p.currency ?? "USD",
              exchs: p.exchs ?? "", expiry: p.expiry ?? "", putOrCall: p.putOrCall ?? "",
              multiplier: p.multiplier ?? 1, strike: p.strike ?? 0,
              exerciseStyle: p.exerciseStyle ?? "", undConid: p.undConid ?? 0,
              model: p.model ?? "", incrementRules: [],
              displayRule: { magnification: 0, displayRuleStep: [] },
              time: 0, chineseName: "", allExchanges: "", listingExchange: "",
              countryCode: "", lastTradingDay: "", group: "", sector: "",
              sectorGroup: "", type: p.assetClass ?? "STK", hasOptions: false, isUS: true, incrementRuleIndex: 0,
            }));
          setPositions(mapped as unknown as IbkrPosition[]);
        }
        // Unwrap { orders: [...] } wrapper if present
        const rawOrders = ordRes.status === "fulfilled"
          ? (Array.isArray(ordRes.value) ? ordRes.value : (ordRes.value?.orders ?? []))
          : [];
        if (rawOrders.length > 0) {
          setOpenOrders(rawOrders.map((o: any) => ({
            orderId: o.orderId ?? "",
            symbol: o.symbol ?? "",
            side: o.side ?? "",
            quantity: o.quantity ?? 0,
            orderType: o.orderType ?? "",
            limitPrice: o.limitPrice,
            auxPrice: o.stopPrice,
            status: o.status ?? "",
            timeInForce: o.timeInForce ?? "",
          })));
        }
        if (sumRes.status === "fulfilled" && sumRes.value && !sumRes.value.error) {
          // IBIND returns { success, summary: { netliquidation: { amount, currency }, ... } }
          // Unwrap the summary wrapper if present
          const raw = sumRes.value;
          const s = raw.summary ?? raw; // support both { summary: {...} } and flat
          setSummary(s as any);
          // Extract account ID from nested accountcode.value or flat accountId
          const accountId: string = s.accountcode?.value ?? s.accountId ?? "";
          const currency: string = s.netliquidation?.currency ?? s.currency ?? "USD";
          if (accountId) {
            setAccounts([{ accountId, accountType: "IBIND", currency } as any]);
            setSelectedAccount({ accountId, accountType: "IBIND", currency } as any);
          }
        }
        // Fetch today's commissions
      try {
        const tradesRes = await fetch("/api/ibind/trades");
        if (tradesRes.ok) {
          const tradesData = await tradesRes.json();
          setTodayCommissions(tradesData.totalCommission ?? 0);
          setTodayTrades(tradesData.totalTrades ?? 0);
          setTodayVolume(tradesData.totalVolume ?? 0);
        }
      } catch {}
      setLastRefresh(new Date());
        setLoading(false);
        return;
      }
      setConnectedVia("iBeam");

      // 2. Init brokerage session (required before portfolio calls)
      try {
        await ibkrClient.initBrokerageSession();
      } catch {
        // ignore — may already be initialized
      }

      // 3. Get accounts
      let targetAccId = accId;
      if (!targetAccId) {
        try {
          const accts = await ibkrClient.getAccounts();
          setAccounts(accts);
          if (accts.length > 0) {
            setSelectedAccount(accts[0]);
            targetAccId = accts[0].accountId;
          }
        } catch (err: any) {
          toast.error("Could not fetch accounts: " + err.message);
          setLoading(false);
          return;
        }
      }

      if (!targetAccId) {
        toast.error("No IBKR account found. Make sure you are logged in.");
        setLoading(false);
        return;
      }

      // 4. Load summary, positions, orders in parallel
      const [summaryRes, positionsRes, ordersRes] = await Promise.allSettled([
        ibkrClient.getAccountSummary(targetAccId),
        ibkrClient.getPositions(targetAccId),
        ibkrClient.getOpenOrders(),
      ]);

      if (summaryRes.status === "fulfilled") setSummary(summaryRes.value);
      else toast.error("Account summary: " + (summaryRes.reason?.message ?? "failed"));

      if (positionsRes.status === "fulfilled") setPositions(positionsRes.value);
      else toast.error("Positions: " + (positionsRes.reason?.message ?? "failed"));

      if (ordersRes.status === "fulfilled") setOpenOrders((ordersRes.value as any)?.orders ?? []);
      // orders failing is non-critical, skip toast

      setLastRefresh(new Date());
    } catch (err: any) {
      toast.error("Failed to load IBKR data: " + err.message);
      setAuthStatus("disconnected");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="container py-8">
      <div className="max-w-5xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#2563EB]/10 flex items-center justify-center">
              <Activity className="w-5 h-5 text-[#2563EB]" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">IBKR Account</h1>
              <p className="text-sm text-muted-foreground">
                {selectedAccount
                  ? `${selectedAccount.accountId} · ${selectedAccount.accountTitle || selectedAccount.displayName || selectedAccount.accountType}`
                  : "Interactive Brokers account overview"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {lastRefresh && (
              <span className="text-xs text-muted-foreground hidden sm:inline">
                Updated {lastRefresh.toLocaleTimeString()}
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => loadAll(selectedAccount?.accountId)}
              disabled={loading}
              className="gap-2"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Refresh
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setLocation("/settings")}
              className="gap-2 text-muted-foreground"
            >
              ← Settings
            </Button>
          </div>
        </div>

        {/* Connection status */}
        {authStatus === "checking" && (
          <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            Checking IBKR connection...
          </div>
        )}

        {authStatus === "disconnected" && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-700 px-4 py-4">
            <WifiOff className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-semibold text-amber-900 dark:text-amber-300">Not connected to IBKR</p>
              <p className="text-sm text-amber-400 dark:text-amber-400 mt-0.5">
                Go to Settings → Interactive Brokers to connect your account.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setLocation("/settings")}
              className="shrink-0 border-amber-400 text-amber-400 hover:bg-amber-50"
            >
              Connect
            </Button>
          </div>
        )}

        {authStatus === "connected" && (
          <div className="flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20 dark:border-emerald-700 px-4 py-2.5">
            <CheckCircle2 className="w-4 h-4 text-[#65A30D] shrink-0" />
            <span className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
              Connected via {connectedVia ?? "IBKR"}{selectedAccount?.accountId ? ` · ${selectedAccount.accountId}` : ""}
            </span>
            {selectedAccount?.accountType && (
              <Badge variant="outline" className="text-xs ml-1 border-emerald-400 text-[#65A30D]">
                {selectedAccount.accountType}
              </Badge>
            )}
            {selectedAccount?.currency && (
              <Badge variant="outline" className="text-xs border-emerald-400 text-[#65A30D]">
                {selectedAccount.currency}
              </Badge>
            )}
          </div>
        )}

        {/* Account Summary */}
        {summary && (
          <div>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-widest mb-3">Account Summary</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              <SummaryMetric
                label="Net Liquidation"
                value={fmt(summary.netliquidation?.amount, summary.netliquidation?.currency)}
                sub={summary.netliquidation?.currency}
                icon={<DollarSign className="w-4 h-4" />}
              />
              <SummaryMetric
                label="Total Cash"
                value={fmt(summary.totalcashvalue?.amount, summary.totalcashvalue?.currency)}
                sub={summary.totalcashvalue?.currency}
                icon={<DollarSign className="w-4 h-4" />}
              />
              <SummaryMetric
                label="Buying Power"
                value={fmt(summary.buyingpower?.amount, summary.buyingpower?.currency)}
                sub={summary.buyingpower?.currency}
                icon={<Wifi className="w-4 h-4" />}
              />
              <SummaryMetric
                label="Gross Position Value"
                value={fmt(summary.grosspositionvalue?.amount, summary.grosspositionvalue?.currency)}
                sub={summary.grosspositionvalue?.currency}
                icon={<BarChart2 className="w-4 h-4" />}
              />
              <SummaryMetric
                label="Unrealized P&L"
                value={fmt(summary.unrealizedpnl?.amount, summary.unrealizedpnl?.currency)}
                sub={summary.unrealizedpnl?.currency}
                positive={summary.unrealizedpnl?.amount !== undefined ? summary.unrealizedpnl.amount >= 0 : undefined}
                icon={summary.unrealizedpnl?.amount !== undefined && summary.unrealizedpnl.amount >= 0
                  ? <TrendingUp className="w-4 h-4 text-[#65A30D]" />
                  : <TrendingDown className="w-4 h-4 text-[#FF6B6B]" />}
              />
              <SummaryMetric
                label="Realized P&L"
                value={fmt(summary.realizedpnl?.amount, summary.realizedpnl?.currency)}
                sub={summary.realizedpnl?.currency}
                positive={summary.realizedpnl?.amount !== undefined ? summary.realizedpnl.amount >= 0 : undefined}
                icon={summary.realizedpnl?.amount !== undefined && summary.realizedpnl.amount >= 0
                  ? <TrendingUp className="w-4 h-4 text-[#65A30D]" />
                  : <TrendingDown className="w-4 h-4 text-[#FF6B6B]" />}
              />
              <SummaryMetric
                label="עמלות ממומשות היום"
                value={todayCommissions !== null ? `-$${todayCommissions.toFixed(2)}` : "—"}
                sub={todayTrades !== null ? `${todayTrades} ביצועים` : undefined}
                positive={false}
                icon={<DollarSign className="w-4 h-4" />}
              />
              <SummaryMetric
                label="נפח מסחר היום"
                value={todayVolume !== null ? `$${(todayVolume / 1000).toFixed(0)}K` : "—"}
                sub="Daily Volume"
                icon={<BarChart2 className="w-4 h-4" />}
              />
            </div>
          </div>
        )}

        {/* Loading skeleton for summary */}
        {loading && !summary && authStatus !== "disconnected" && (
          <div>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-widest mb-3">Account Summary</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="rounded-xl border border-border bg-card p-4 h-20 animate-pulse bg-muted/30" />
              ))}
            </div>
          </div>
        )}

        {/* Positions */}
        {authStatus === "connected" && (
          <Card className="border shadow-sm">
            <CardHeader className="pb-3 pt-4 px-5">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <BarChart2 className="h-4 w-4 text-[#2563EB]" />
                Positions
                {positions.length > 0 && (
                  <Badge variant="secondary" className="ml-auto text-xs">{positions.length}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              {loading && positions.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                  <Loader2 className="w-4 h-4 animate-spin" />Loading positions...
                </div>
              ) : positions.length === 0 ? (
                <div className="text-sm text-muted-foreground py-4 text-center">No open positions</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs border-collapse" dir="ltr">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="text-left py-2 pr-3 font-medium whitespace-nowrap">Ticker</th>
                        <th className="text-left py-2 pr-3 font-medium whitespace-nowrap">Name</th>
                        <th className="text-right py-2 pr-3 font-medium whitespace-nowrap">Position</th>
                        <th className="text-right py-2 pr-3 font-medium whitespace-nowrap">Avg Cost</th>
                        <th className="text-right py-2 pr-3 font-medium whitespace-nowrap">Mkt Price</th>
                        <th className="text-right py-2 pr-3 font-medium whitespace-nowrap">Mkt Value</th>
                        <th className="text-right py-2 pr-3 font-medium whitespace-nowrap">Unrealized P&L</th>
                        <th className="text-right py-2 font-medium whitespace-nowrap">Realized P&L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {positions.map((pos, i) => {
                        const pnlPositive = pos.unrealizedPnl >= 0;
                        const realPositive = pos.realizedPnl >= 0;
                        return (
                          <tr key={i} className="border-b border-border/40 hover:bg-muted/20 transition-colors">
                            <td className="py-2.5 pr-3 font-semibold text-foreground font-mono whitespace-nowrap">
                              {pos.ticker || pos.contractDesc}
                            </td>
                            <td className="py-2.5 pr-3 text-muted-foreground max-w-[120px] truncate">
                              {pos.name || pos.fullName || "—"}
                            </td>
                            <td className="py-2.5 pr-3 text-right font-mono font-medium whitespace-nowrap">
                              {pos.position}
                            </td>
                            <td className="py-2.5 pr-3 text-right font-mono whitespace-nowrap">
                              {fmt(pos.avgCost, pos.currency)}
                            </td>
                            <td className="py-2.5 pr-3 text-right font-mono whitespace-nowrap">
                              {fmt(pos.mktPrice, pos.currency)}
                            </td>
                            <td className="py-2.5 pr-3 text-right font-mono font-medium whitespace-nowrap">
                              {fmt(pos.mktValue, pos.currency)}
                            </td>
                            <td className={`py-2.5 pr-3 text-right font-mono font-semibold whitespace-nowrap ${pnlPositive ? "text-[#65A30D]" : "text-[#FF6B6B]"}`}>
                              <span className="inline-flex items-center justify-end gap-1">
                                {pnlPositive
                                  ? <ArrowUpRight className="w-3 h-3 shrink-0" />
                                  : <ArrowDownRight className="w-3 h-3 shrink-0" />}
                                {fmt(pos.unrealizedPnl, pos.currency)}
                              </span>
                            </td>
                            <td className={`py-2.5 text-right font-mono whitespace-nowrap ${realPositive ? "text-[#65A30D]" : "text-[#FF6B6B]"}`}>
                              {fmt(pos.realizedPnl, pos.currency)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    {/* Totals row */}
                    {positions.length > 0 && (
                      <tfoot>
                        <tr className="border-t-2 border-border bg-muted/20">
                          <td colSpan={5} className="py-2.5 pr-4 text-xs font-semibold text-muted-foreground">Total</td>
                          <td className="py-2.5 pr-4 text-right font-mono font-bold text-foreground">
                            {fmt(positions.reduce((s, p) => s + (p.mktValue ?? 0), 0))}
                          </td>
                          <td className={`py-2.5 pr-4 text-right font-mono font-bold ${
                            positions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0) >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"
                          }`}>
                            {fmt(positions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0))}
                          </td>
                          <td className={`py-2.5 text-right font-mono font-bold ${
                            positions.reduce((s, p) => s + (p.realizedPnl ?? 0), 0) >= 0 ? "text-[#65A30D]" : "text-[#FF6B6B]"
                          }`}>
                            {fmt(positions.reduce((s, p) => s + (p.realizedPnl ?? 0), 0))}
                          </td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Open Orders */}
        {authStatus === "connected" && (
          <Card className="border shadow-sm">
            <CardHeader className="pb-3 pt-4 px-5">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <ShoppingCart className="h-4 w-4 text-[#2563EB]" />
                Open Orders
                {openOrders.length > 0 && (
                  <Badge variant="secondary" className="ml-auto text-xs">{openOrders.length}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              {loading && openOrders.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                  <Loader2 className="w-4 h-4 animate-spin" />Loading orders...
                </div>
              ) : openOrders.length === 0 ? (
                <div className="text-sm text-muted-foreground py-4 text-center">No open orders</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="text-left py-2 pr-4 font-medium">Order ID</th>
                        <th className="text-left py-2 pr-4 font-medium">Ticker</th>
                        <th className="text-left py-2 pr-4 font-medium">Side</th>
                        <th className="text-left py-2 pr-4 font-medium">Type</th>
                        <th className="text-right py-2 pr-4 font-medium">Qty</th>
                        <th className="text-right py-2 pr-4 font-medium">Price</th>
                        <th className="text-right py-2 pr-4 font-medium">Filled</th>
                        <th className="text-left py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {openOrders.map((order, i) => (
                        <tr key={i} className="border-b border-border/40 hover:bg-muted/20 transition-colors">
                          <td className="py-2.5 pr-4 font-mono text-muted-foreground">{order.orderId}</td>
                          <td className="py-2.5 pr-4 font-semibold font-mono">{order.ticker}</td>
                          <td className="py-2.5 pr-4">
                            <Badge variant="outline" className={`text-xs font-semibold ${
                              order.side === "BUY" ? "text-[#65A30D] border-emerald-400 bg-emerald-50" : "text-[#FF6B6B] border-red-400 bg-red-50"
                            }`}>
                              {order.side}
                            </Badge>
                          </td>
                          <td className="py-2.5 pr-4 text-muted-foreground">{order.orderType}</td>
                          <td className="py-2.5 pr-4 text-right font-mono">{order.totalSize}</td>
                          <td className="py-2.5 pr-4 text-right font-mono">{order.price ? fmt(order.price) : "MKT"}</td>
                          <td className="py-2.5 pr-4 text-right font-mono text-muted-foreground">
                            {order.filledQuantity ?? 0}/{order.totalSize}
                          </td>
                          <td className="py-2.5">
                            <Badge variant="outline" className="text-xs">{order.status}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Account Details */}
        {selectedAccount && (
          <Card className="border shadow-sm">
            <CardHeader className="pb-3 pt-4 px-5">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Account Details
              </CardTitle>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3 text-xs">
                {[
                  { label: "Account ID", value: selectedAccount.accountId },
                  { label: "Account Title", value: selectedAccount.accountTitle || "—" },
                  { label: "Display Name", value: selectedAccount.displayName || "—" },
                  { label: "Account Type", value: selectedAccount.accountType || "—" },
                  { label: "Trading Type", value: selectedAccount.tradingType || "—" },
                  { label: "Currency", value: selectedAccount.currency || "—" },
                  { label: "Business Type", value: selectedAccount.businessType || "—" },
                  { label: "IB Entity", value: selectedAccount.ibEntity || "—" },
                  { label: "Clearing Status", value: selectedAccount.clearingStatus || "—" },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <p className="text-muted-foreground">{label}</p>
                    <p className="font-medium text-foreground mt-0.5 font-mono">{value}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Multiple accounts selector */}
        {accounts.length > 1 && (
          <Card className="border shadow-sm">
            <CardHeader className="pb-3 pt-4 px-5">
              <CardTitle className="text-sm font-semibold">Switch Account</CardTitle>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              <div className="flex flex-wrap gap-2">
                {accounts.map((acc) => (
                  <Button
                    key={acc.accountId}
                    size="sm"
                    variant={selectedAccount?.accountId === acc.accountId ? "default" : "outline"}
                    onClick={() => {
                      setSelectedAccount(acc);
                      loadAll(acc.accountId);
                    }}
                  >
                    {acc.accountId}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

      </div>
    </div>
  );
}
