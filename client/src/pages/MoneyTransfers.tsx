import { useState, useMemo, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
  ReferenceLine,
} from "recharts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ArrowDownCircle,
  ArrowUpCircle,
  ArrowLeftRight,
  Plus,
  RefreshCw,
  Trash2,
  Wallet,
  BarChart2,
  Activity,
  Info,
} from "lucide-react";

// ── Helpers ──────────────────────────────────────────────────────────────────
const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

const fmtIls = (n: number) =>
  new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(n);

const fmtPct = (n: number) =>
  `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

// ── Dual Amount (USD + ILS) ───────────────────────────────────────────────────
function DualAmount({
  usd,
  rate,
  color,
  prefix = "",
}: {
  usd: number;
  rate: number;
  color?: string;
  prefix?: string;
}) {
  return (
    <div>
      <span className="font-mono font-semibold" style={{ color: color ?? "#1a202c" }}>
        {prefix}{fmt(usd)}
      </span>
      {rate > 0 && (
        <div className="text-xs font-mono mt-0.5 text-[#4A5568]">
          {prefix}{fmtIls(usd * rate)}
        </div>
      )}
    </div>
  );
}

// ── Stat Card ─────────────────────────────────────────────────────────────────
function StatCard({
  icon,
  label,
  value,
  valueIls,
  sub,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueIls?: string;
  sub?: string;
  color: string;
}) {
  return (
    <Card className="border-gray-200 bg-white shadow-sm">
      <CardContent className="p-4 flex items-start gap-3">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: `${color}18`, color }}
        >
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium text-[#4A5568]">{label}</p>
          <p className="text-lg font-bold mt-0.5 leading-tight text-[#1a202c]">{value}</p>
          {valueIls && (
            <p className="text-xs font-mono mt-0.5 text-[#4A5568]">{valueIls}</p>
          )}
          {sub && (
            <p className="text-xs mt-0.5 text-[#4A5568]">{sub}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Add Transfer Modal ────────────────────────────────────────────────────────
function AddTransferModal({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [type, setType] = useState<"DEPOSIT" | "WITHDRAWAL">("DEPOSIT");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");

  const equityQ = trpc.moneyTransfers.getEquity.useQuery(undefined, {
    enabled: open,
    staleTime: 30_000,
  });

  const currentEquity = equityQ.data?.equity ?? null;
  const equitySource = equityQ.data?.source ?? "none";
  const amt = parseFloat(amount) || 0;
  const balanceBefore = currentEquity;
  const balanceAfter =
    currentEquity != null
      ? type === "DEPOSIT"
        ? currentEquity + amt
        : currentEquity - amt
      : null;

  const addMut = trpc.moneyTransfers.add.useMutation({
    onSuccess: () => {
      toast.success(`${type} of ${fmt(Number(amount))} saved.`);
      onAdded();
      onClose();
      setAmount(""); setNotes("");
    },
    onError: (e) => toast.error(e.message),
  });

  const handleSubmit = () => {
    if (!amt || amt <= 0) {
      toast.error("Invalid amount — must be a positive number");
      return;
    }
    addMut.mutate({
      type,
      amount: amt,
      timestamp: new Date(date).getTime(),
      balanceBefore: balanceBefore ?? undefined,
      balanceAfter: balanceAfter ?? undefined,
      notes: notes || undefined,
    });
  };

  useEffect(() => {
    if (!open) { setAmount(""); setNotes(""); setType("DEPOSIT"); }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md w-[calc(100vw-2rem)] mx-auto bg-white border-gray-200">
        <DialogHeader>
          <DialogTitle className="text-[#1a202c]">Add Transfer</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-[#4A5568]">Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as "DEPOSIT" | "WITHDRAWAL")}>
              <SelectTrigger className="bg-white border-gray-300 text-[#1a202c]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-white border-gray-200">
                <SelectItem value="DEPOSIT">DEPOSIT — הפקדה</SelectItem>
                <SelectItem value="WITHDRAWAL">WITHDRAWAL — משיכה</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[#4A5568]">Amount (USD $)</Label>
            <Input
              type="number"
              placeholder="10000"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="bg-white border-gray-300 text-[#1a202c]"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[#4A5568]">Date</Label>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="bg-white border-gray-300 text-[#1a202c]"
            />
          </div>

          <div className="rounded-lg p-3 space-y-1.5 bg-gray-50 border border-gray-200">
            <p className="text-xs font-semibold uppercase tracking-wider text-[#4A5568]">
              Portfolio Balance (auto)
            </p>
            {equityQ.isLoading ? (
              <p className="text-xs text-[#4A5568]">Fetching current equity…</p>
            ) : currentEquity == null ? (
              <p className="text-xs text-[#4A5568]">
                No equity data available (IBKR offline / no snapshots)
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-[#4A5568]">Before transfer</p>
                  <p className="text-sm font-mono font-semibold text-[#1a202c]">
                    {fmt(currentEquity)}
                  </p>
                  <p className="text-xs text-[#4A5568]">
                    via {equitySource === "ibkr" ? "IBKR live" : "last snapshot"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[#4A5568]">After transfer</p>
                  <p
                    className="text-sm font-mono font-semibold"
                    style={{ color: amt > 0 ? (type === "DEPOSIT" ? "#16a34a" : "#dc2626") : "#1a202c" }}
                  >
                    {balanceAfter != null ? fmt(balanceAfter) : "—"}
                  </p>
                  <p className="text-xs text-[#4A5568]">
                    {amt > 0 ? `${type === "DEPOSIT" ? "+" : "-"}${fmt(amt)}` : "enter amount"}
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-[#4A5568]">Notes (opt)</Label>
            <Input
              placeholder="Wire transfer, broker deposit…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="bg-white border-gray-300 text-[#1a202c]"
            />
          </div>
        </div>
        <DialogFooter className="flex-row gap-2 justify-end">
          <Button
            variant="outline"
            onClick={onClose}
            className="border-gray-300 text-[#4A5568] bg-white hover:bg-gray-50"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={addMut.isPending}
            style={{ background: type === "DEPOSIT" ? "#65A30D" : "#FF6B6B", color: "#fff", border: "none" }}
          >
            {addMut.isPending ? "Saving…" : `Add ${type}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── TWR Explanation Card ──────────────────────────────────────────────────────
function TwrExplainer() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-[#4A5568] hover:text-[#2563EB] transition-colors"
      >
        <Info className="w-3.5 h-3.5" />
        What is TWR Clean Growth?
      </button>
      {open && (
        <div className="mt-2 rounded-lg p-3 text-xs leading-relaxed bg-blue-50 border border-blue-200 text-[#4A5568]">
          <p className="font-semibold mb-1 text-[#1a202c]">Time-Weighted Return (TWR)</p>
          <p>
            כשמפקידים או מושכים כסף, הגרף הרגיל "קופץ" — זה לא תשואה אמיתית.
            TWR מנטרל את ההפקדות/משיכות ומציג רק את ביצועי הניהול בפועל.
          </p>
          <p className="mt-1.5">
            <span className="font-semibold text-[#1a202c]">דוגמה:</span> אם הפקדת $10k ביום שהשוק עלה 5% —
            הגרף הרגיל יראה קפיצה גדולה. TWR יראה רק את ה-5% של השוק, ללא השפעת ההפקדה.
          </p>
          <p className="mt-1.5">
            <span className="font-semibold text-[#1a202c]">ציר Y:</span> אחוז תשואה מצטבר מתחילת המדידה.
            0% = אין שינוי, +10% = עלייה של 10% בביצועי הניהול.
          </p>
          <p className="mt-1.5 text-xs text-[#4A5568]">
            הגרף מחושב מ-snapshots שעתיים של תיק ההשקעות + רשימת ההעברות שהזנת.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function MoneyTransfers() {
  const utils = trpc.useUtils();
  const [showAdd, setShowAdd] = useState(false);

  const listQ = trpc.moneyTransfers.list.useQuery(undefined);
  const monthlyQ = trpc.moneyTransfers.monthlySummary.useQuery();
  const twrQ = trpc.moneyTransfers.twrCurve.useQuery();
  const forexQ = trpc.forex.getRate.useQuery();
  const rate = forexQ.data?.usdIls ?? 0;

  const deleteMut = trpc.moneyTransfers.delete.useMutation({
    onSuccess: () => {
      utils.moneyTransfers.list.invalidate();
      utils.moneyTransfers.monthlySummary.invalidate();
      utils.moneyTransfers.twrCurve.invalidate();
      toast.success("Transfer deleted");
    },
    onError: (e) => toast.error(e.message),
  });

  const syncMut = trpc.moneyTransfers.detectFromIbkr.useMutation({
    onSuccess: (data) => {
      if ("error" in data && data.error) {
        toast.error(`IBKR Sync: ${data.error}`);
      } else {
        toast.success(`IBKR Sync: Detected ${data.detected} new transfer(s).`);
        utils.moneyTransfers.list.invalidate();
        utils.moneyTransfers.monthlySummary.invalidate();
        utils.moneyTransfers.twrCurve.invalidate();
      }
    },
    onError: (e) => toast.error(`IBKR Sync failed: ${e.message}`),
  });

  const handleAdded = () => {
    utils.moneyTransfers.list.invalidate();
    utils.moneyTransfers.monthlySummary.invalidate();
    utils.moneyTransfers.twrCurve.invalidate();
  };

  const stats = useMemo(() => {
    const rows = listQ.data ?? [];
    const totalDeposited = rows.filter((r) => r.type === "DEPOSIT").reduce((s, r) => s + r.amount, 0);
    const totalWithdrawn = rows.filter((r) => r.type === "WITHDRAWAL").reduce((s, r) => s + r.amount, 0);
    return {
      totalDeposited,
      totalWithdrawn,
      netFlow: totalDeposited - totalWithdrawn,
      count: rows.length,
    };
  }, [listQ.data]);

  const twrData = useMemo(() => {
    const curve = twrQ.data?.twr ?? [];
    return curve.map((pt) => ({
      date: new Date(pt.ts).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      twr: parseFloat(pt.twr.toFixed(2)),
    }));
  }, [twrQ.data]);

  const monthlyData = useMemo(() => {
    return (monthlyQ.data ?? []).map((m) => ({
      month: m.month,
      Deposits: m.deposits,
      Withdrawals: m.withdrawals,
      Net: m.net,
    }));
  }, [monthlyQ.data]);

  const ACCENT = "#2563EB";

  return (
    <div className="min-h-screen bg-[#F4F6F8]">
      {/* ── Header ───────────────────────────────────────────────────────────── */}
      <div className="sticky top-16 z-[100] px-4 py-3 bg-white border-b border-gray-200 shadow-sm">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-blue-50">
            <ArrowLeftRight className="w-3.5 h-3.5 text-[#2563EB]" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-bold leading-tight text-[#1a202c]">Transfer Ledger</h1>
            <p className="text-xs leading-tight text-[#4A5568]">הפקדות ומשיכות — נרמול TWR</p>
          </div>
          {rate > 0 && (
            <span className="ml-auto text-xs px-2 py-0.5 rounded-full shrink-0 bg-blue-50 text-[#2563EB] font-medium">
              1$ = ₪{rate.toFixed(2)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => syncMut.mutate()}
            disabled={syncMut.isPending}
            className="gap-1.5 flex-1 text-xs border-gray-300 text-[#4A5568] bg-white hover:bg-gray-50"
          >
            <RefreshCw className={`w-3 h-3 ${syncMut.isPending ? "animate-spin" : ""}`} />
            Sync IBKR
          </Button>
          <Button
            size="sm"
            onClick={() => setShowAdd(true)}
            className="gap-1.5 flex-1 text-xs font-semibold bg-[#2563EB] hover:bg-[#1d4ed8] text-white"
          >
            <Plus className="w-3 h-3" />
            Add Transfer
          </Button>
        </div>
      </div>

      <div className="px-4 py-4 space-y-4 max-w-7xl mx-auto">
        {/* ── Summary Cards ─────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3">
          <StatCard
            icon={<ArrowDownCircle className="w-4 h-4" />}
            label="Total Deposited"
            value={fmt(stats.totalDeposited)}
            valueIls={rate > 0 ? fmtIls(stats.totalDeposited * rate) : undefined}
            color="#65A30D"
          />
          <StatCard
            icon={<ArrowUpCircle className="w-4 h-4" />}
            label="Total Withdrawn"
            value={fmt(stats.totalWithdrawn)}
            valueIls={rate > 0 ? fmtIls(stats.totalWithdrawn * rate) : undefined}
            color="#FF6B6B"
          />
          <StatCard
            icon={<Wallet className="w-4 h-4" />}
            label="Net Flow"
            value={fmt(stats.netFlow)}
            valueIls={rate > 0 ? fmtIls(stats.netFlow * rate) : undefined}
            sub={stats.netFlow >= 0 ? "Net inflow" : "Net outflow"}
            color={stats.netFlow >= 0 ? "#65A30D" : "#FF6B6B"}
          />
          <StatCard
            icon={<BarChart2 className="w-4 h-4" />}
            label="Transfer Count"
            value={String(stats.count)}
            sub="all time"
            color={ACCENT}
          />
        </div>

        {/* ── Charts ────────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Monthly Bar Chart */}
          <Card className="border-gray-200 bg-white shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-[#1a202c] flex items-center gap-2">
                <BarChart2 className="w-4 h-4 text-[#2563EB]" />
                Monthly Cash Flows
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {monthlyData.length === 0 ? (
                <div className="h-44 flex items-center justify-center text-sm text-[#4A5568]">
                  No transfers recorded yet
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={monthlyData} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                    <XAxis
                      dataKey="month"
                      tick={{ fill: "#4A5568", fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fill: "#4A5568", fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                      width={42}
                    />
                    <Tooltip
                      contentStyle={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 8 }}
                      labelStyle={{ color: "#1a202c", fontWeight: 600 }}
                      formatter={(v: number, name: string) => [
                        rate > 0 ? `${fmt(v)}  /  ${fmtIls(v * rate)}` : fmt(v),
                        name,
                      ]}
                    />
                    <Legend wrapperStyle={{ fontSize: 11, color: "#4A5568" }} />
                    <Bar dataKey="Deposits" fill="#65A30D" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="Withdrawals" fill="#FF6B6B" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* TWR Clean Growth Chart */}
          <Card className="border-gray-200 bg-white shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-[#1a202c] flex items-center gap-2">
                <Activity className="w-4 h-4 text-[#2563EB]" />
                TWR Clean Growth
                <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-blue-50 text-[#2563EB] font-normal">
                  ביצועי ניהול בלבד
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="mb-3">
                <TwrExplainer />
              </div>
              {twrData.length === 0 ? (
                <div className="h-40 flex flex-col items-center justify-center gap-2 rounded-lg text-center px-4 bg-gray-50">
                  <Activity className="w-6 h-6 text-gray-300" />
                  <p className="text-sm text-[#4A5568]">
                    {twrQ.isLoading
                      ? "Loading TWR data…"
                      : stats.count === 0
                      ? "הוסף העברה ראשונה כדי להפעיל את הגרף"
                      : "אין מספיק snapshots שעתיים עדיין"}
                  </p>
                  <p className="text-xs text-[#4A5568]">
                    הגרף יופיע לאחר שיצטברו snapshots שעתיים של התיק
                  </p>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={twrData} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                    <XAxis
                      dataKey="date"
                      tick={{ fill: "#4A5568", fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      interval="preserveStartEnd"
                      minTickGap={48}
                    />
                    <YAxis
                      tick={{ fill: "#4A5568", fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v) => `${v}%`}
                      width={42}
                    />
                    <Tooltip
                      contentStyle={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 8 }}
                      labelStyle={{ color: "#1a202c", fontWeight: 600 }}
                      formatter={(v: number) => [fmtPct(v), "TWR"]}
                    />
                    <ReferenceLine y={0} stroke="#9CA3AF" strokeDasharray="4 4" />
                    <Line
                      type="monotone"
                      dataKey="twr"
                      stroke={ACCENT}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: ACCENT }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Transfers Table ───────────────────────────────────────────────── */}
        <Card className="border-gray-200 bg-white shadow-sm overflow-hidden">
          <CardHeader className="pb-3 border-b border-gray-100">
            <CardTitle className="text-base text-[#1a202c] flex items-center gap-2">
              <ArrowLeftRight className="w-4 h-4 text-[#2563EB]" />
              Transfer History
              <span className="ml-auto text-xs font-normal text-[#4A5568] px-2 py-0.5 rounded-full bg-gray-100">
                {listQ.data?.length ?? 0} records
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {listQ.isLoading ? (
              <div className="px-4 py-8 text-center text-sm text-[#4A5568]">
                Loading transfers…
              </div>
            ) : !listQ.data || listQ.data.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <ArrowLeftRight className="w-8 h-8 mx-auto mb-3 text-gray-300" />
                <p className="text-sm font-medium text-[#4A5568]">No transfers yet</p>
                <p className="text-xs mt-1 text-[#4A5568]">
                  לחץ "Add Transfer" כדי להתחיל לעקוב אחר הפקדות ומשיכות
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      {["Date", "Type", "Amount", "Bal. Before", "Bal. After", "Notes", ""].map((h) => (
                        <th
                          key={h}
                          className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider whitespace-nowrap text-[#4A5568]"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {listQ.data.map((row, i) => {
                      const isDeposit = row.type === "DEPOSIT";
                      return (
                        <tr
                          key={row.id}
                          className="border-b border-gray-50 hover:bg-blue-50/30 transition-colors"
                          style={{ background: i % 2 === 0 ? "transparent" : "#FAFAFA" }}
                        >
                          <td className="px-3 py-3 whitespace-nowrap text-xs text-[#4A5568]">
                            {new Date(row.timestamp).toLocaleDateString("en-US", {
                              year: "numeric", month: "short", day: "numeric",
                            })}
                          </td>
                          <td className="px-3 py-3">
                            <span
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold uppercase whitespace-nowrap"
                              style={{
                                background: isDeposit ? "rgba(32,201,151,0.12)" : "rgba(255,107,107,0.12)",
                                color: isDeposit ? "#0d9488" : "#dc2626",
                              }}
                            >
                              {isDeposit ? <ArrowDownCircle className="w-3 h-3" /> : <ArrowUpCircle className="w-3 h-3" />}
                              {row.type}
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            <DualAmount
                              usd={row.amount}
                              rate={rate}
                              color={isDeposit ? "#0d9488" : "#dc2626"}
                              prefix={isDeposit ? "+" : "-"}
                            />
                          </td>
                          <td className="px-3 py-3">
                            {row.balanceBefore != null ? (
                              <DualAmount usd={row.balanceBefore} rate={rate} />
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                          <td className="px-3 py-3">
                            {row.balanceAfter != null ? (
                              <DualAmount usd={row.balanceAfter} rate={rate} />
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                          <td className="px-3 py-3 max-w-[140px] truncate text-xs text-[#4A5568]">
                            {row.notes ?? <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-3 py-3">
                            <button
                              onClick={() => {
                                if (confirm("Delete this transfer?")) {
                                  deleteMut.mutate({ id: row.id });
                                }
                              }}
                              className="p-1.5 rounded hover:bg-red-50 transition-colors text-red-300 hover:text-red-500"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <AddTransferModal open={showAdd} onClose={() => setShowAdd(false)} onAdded={handleAdded} />
    </div>
  );
}
