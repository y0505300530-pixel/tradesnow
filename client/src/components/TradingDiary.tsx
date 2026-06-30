/**
 * TradingDiary — יומן מסחר
 * One row per ticker. Updates on partial buy (weighted avg) or sell (units reduced / closed).
 * Closed positions show P&L + post-mortem summary column.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  BookOpen,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronUp,
  Save,
  X,
  CheckCircle2,
  TrendingUp,
  TrendingDown,
} from "lucide-react";

type DiaryEntry = {
  id: number;
  ticker: string;
  company: string | null;
  units: number;
  buyPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  reason: string | null;
  expectations: string | null;
  closePrice?: number | null;
  closedAt?: Date | string | null;
  pnlUsd?: number | null;
  pnlPct?: number | null;
  postMortem?: string | null;
  diaryStatus?: string | null;
  addedAt: Date | string;
};

function fmt(v: number | null | undefined, decimals = 2) {
  if (v == null) return "—";
  return `$${v.toFixed(decimals)}`;
}

function fmtDate(d: Date | string | null | undefined) {
  if (!d) return "—";
  const dt = new Date(d);
  return dt.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

function PnlBadge({ pnlUsd, pnlPct }: { pnlUsd?: number | null; pnlPct?: number | null }) {
  if (pnlUsd == null) return null;
  const positive = pnlUsd >= 0;
  return (
    <span
      className={`inline-flex items-center gap-1 font-bold text-sm ${positive ? "text-[#65A30D]" : "text-[#FF6B6B]"}`}
    >
      {positive ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
      {positive ? "+" : ""}{pnlUsd.toFixed(0)}$ ({positive ? "+" : ""}{pnlPct?.toFixed(1) ?? "0"}%)
    </span>
  );
}

type EditState = {
  id: number;
  reason: string;
  expectations: string;
  stopLoss: string;
  takeProfit: string;
};

export default function TradingDiary() {
  const utils = trpc.useUtils();
  const { data: entries = [], isLoading } = trpc.portfolio.getDiaryEntries.useQuery();

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<EditState | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const updateMut = trpc.portfolio.updateDiaryEntry.useMutation({
    onSuccess: () => {
      toast.success("יומן עודכן");
      setEditing(null);
      utils.portfolio.getDiaryEntries.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteMut = trpc.portfolio.deleteDiaryEntry.useMutation({
    onSuccess: () => {
      toast.success("רשומה נמחקה");
      utils.portfolio.getDiaryEntries.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startEdit = (e: DiaryEntry) => {
    setEditing({
      id: e.id,
      reason: e.reason ?? "",
      expectations: e.expectations ?? "",
      stopLoss: e.stopLoss?.toFixed(2) ?? "",
      takeProfit: e.takeProfit?.toFixed(2) ?? "",
    });
  };

  const saveEdit = () => {
    if (!editing) return;
    updateMut.mutate({
      id: editing.id,
      reason: editing.reason,
      expectations: editing.expectations,
      stopLoss: editing.stopLoss ? parseFloat(editing.stopLoss) : undefined,
      takeProfit: editing.takeProfit ? parseFloat(editing.takeProfit) : undefined,
    });
  };

  const open = entries.filter((e: any) => !e.diaryStatus || e.diaryStatus === "open");
  const closed = entries.filter((e: any) => e.diaryStatus === "closed");
  const displayed = showClosed ? entries : open;
  const rowCount = displayed.length;

  return (
    <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50/60 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-amber-200 bg-amber-900/30/70">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-amber-400" />
          <span className="font-bold text-amber-900 text-sm">Trading Diary — יומן מסחר</span>
          <span className="text-xs text-amber-600 ml-1">({rowCount} רשומות)</span>
        </div>
        <div className="flex items-center gap-2">
          {closed.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs border-amber-300 text-amber-400 bg-white hover:bg-amber-50"
              onClick={() => setShowClosed((v) => !v)}
            >
              {showClosed ? "הסתר סגורות" : `הצג סגורות (${closed.length})`}
            </Button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="p-6 text-center text-sm text-amber-600">טוען יומן...</div>
      ) : displayed.length === 0 ? (
        <div className="p-6 text-center text-sm text-amber-600">
          אין רשומות ביומן. הוסף מניה להחזקות כדי לייצר רשומה אוטומטית.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs" dir="rtl">
            <thead>
              <tr className="border-b border-amber-200 bg-amber-900/30/50 text-amber-800">
                <th className="px-3 py-2 text-right font-semibold w-8">#</th>
                <th className="px-3 py-2 text-right font-semibold">תאריך / עדכון</th>
                <th className="px-3 py-2 text-right font-semibold">טיקר / חברה</th>
                <th className="px-3 py-2 text-center font-semibold">כמות</th>
                <th className="px-3 py-2 text-center font-semibold">מחיר קנייה</th>
                <th className="px-3 py-2 text-center font-semibold text-red-700">סטופ לוס מומלץ</th>
                <th className="px-3 py-2 text-center font-semibold text-[#65A30D]">יעד רווח מומלץ</th>
                <th className="px-3 py-2 text-right font-semibold">למה קנינו</th>
                <th className="px-3 py-2 text-right font-semibold">ציפייה</th>
                <th className="px-3 py-2 text-center font-semibold">סיכום</th>
                <th className="px-3 py-2 text-center font-semibold w-16"></th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((entry: DiaryEntry, idx: number) => {
                const isClosed = (entry as any).diaryStatus === "closed";
                const isExpanded = expanded.has(entry.id);
                const isEditing = editing?.id === entry.id;

                return (
                  <>
                    <tr
                      key={entry.id}
                      className={`border-b border-amber-100 transition-colors ${
                        isClosed
                          ? "bg-gray-50/80 text-gray-500"
                          : "bg-white hover:bg-amber-50/40"
                      }`}
                    >
                      {/* # */}
                      <td className="px-3 py-2.5 text-right text-amber-400 font-semibold">{idx + 1}</td>

                      {/* Date */}
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <div>{fmtDate(entry.addedAt)}</div>
                        {isClosed && (
                          <div className="text-[10px] text-gray-400">סגור: {fmtDate((entry as any).closedAt)}</div>
                        )}
                      </td>

                      {/* Ticker */}
                      <td className="px-3 py-2.5 text-right">
                        <div className={`font-bold text-sm ${isClosed ? "text-gray-500" : "text-amber-800"}`}>
                          {entry.ticker}
                          {isClosed && (
                            <CheckCircle2 className="inline h-3 w-3 ml-1 text-gray-400" />
                          )}
                        </div>
                        <div className="text-[10px] text-gray-500 truncate max-w-[120px]">{entry.company ?? ""}</div>
                      </td>

                      {/* Units */}
                      <td className="px-3 py-2.5 text-center font-mono">{entry.units}</td>

                      {/* Buy Price */}
                      <td className="px-3 py-2.5 text-center font-mono font-semibold">
                        {isEditing ? (
                          <span className="text-gray-400">{fmt(entry.buyPrice)}</span>
                        ) : (
                          fmt(entry.buyPrice)
                        )}
                      </td>

                      {/* Stop Loss */}
                      <td className="px-3 py-2.5 text-center">
                        {isEditing ? (
                          <Input
                            type="number"
                            step="0.01"
                            className="h-6 w-20 text-xs text-center mx-auto border-red-300"
                            value={editing.stopLoss}
                            onChange={(e) => setEditing({ ...editing, stopLoss: e.target.value })}
                          />
                        ) : (
                          <span className="font-mono text-[#FF6B6B] font-semibold">{fmt(entry.stopLoss)}</span>
                        )}
                      </td>

                      {/* Take Profit */}
                      <td className="px-3 py-2.5 text-center">
                        {isEditing ? (
                          <Input
                            type="number"
                            step="0.01"
                            className="h-6 w-20 text-xs text-center mx-auto border-emerald-300"
                            value={editing.takeProfit}
                            onChange={(e) => setEditing({ ...editing, takeProfit: e.target.value })}
                          />
                        ) : (
                          <span className="font-mono text-[#65A30D] font-semibold">{fmt(entry.takeProfit)}</span>
                        )}
                      </td>

                      {/* Reason */}
                      <td className="px-3 py-2.5 text-right max-w-[180px]">
                        {isEditing ? (
                          <Textarea
                            className="text-xs h-16 resize-none"
                            value={editing.reason}
                            onChange={(e) => setEditing({ ...editing, reason: e.target.value })}
                          />
                        ) : (
                          <div
                            className={`text-xs leading-relaxed ${isExpanded ? "" : "line-clamp-2"} cursor-pointer`}
                            onClick={() => toggleExpand(entry.id)}
                          >
                            {entry.reason ?? "—"}
                          </div>
                        )}
                      </td>

                      {/* Expectations */}
                      <td className="px-3 py-2.5 text-right max-w-[180px]">
                        {isEditing ? (
                          <Textarea
                            className="text-xs h-16 resize-none"
                            value={editing.expectations}
                            onChange={(e) => setEditing({ ...editing, expectations: e.target.value })}
                          />
                        ) : (
                          <div
                            className={`text-xs leading-relaxed ${isExpanded ? "" : "line-clamp-2"} cursor-pointer`}
                            onClick={() => toggleExpand(entry.id)}
                          >
                            {entry.expectations ?? "—"}
                          </div>
                        )}
                      </td>

                      {/* Summary (closed only) */}
                      <td className="px-3 py-2.5 text-center min-w-[140px]">
                        {isClosed ? (
                          <div className="flex flex-col items-center gap-1">
                            <PnlBadge pnlUsd={(entry as any).pnlUsd} pnlPct={(entry as any).pnlPct} />
                            {(entry as any).closePrice && (
                              <span className="text-[10px] text-gray-400">
                                יציאה: {fmt((entry as any).closePrice)}
                              </span>
                            )}
                            {(entry as any).postMortem && (
                              <div
                                className={`text-[10px] text-gray-500 text-right max-w-[160px] ${isExpanded ? "" : "line-clamp-2"} cursor-pointer`}
                                onClick={() => toggleExpand(entry.id)}
                              >
                                {(entry as any).postMortem}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-[10px] text-amber-500">פתוח</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="px-2 py-2.5 text-center">
                        <div className="flex items-center justify-center gap-1">
                          {isEditing ? (
                            <>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 text-[#65A30D] hover:text-[#65A30D]"
                                onClick={saveEdit}
                                disabled={updateMut.isPending}
                              >
                                <Save className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 text-gray-400 hover:text-gray-600"
                                onClick={() => setEditing(null)}
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 text-amber-600 hover:text-amber-800"
                                onClick={() => startEdit(entry)}
                                title="ערוך"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 text-[#FF6B6B] hover:text-[#FF6B6B]"
                                onClick={() => {
                                  if (confirm(`למחוק את ${entry.ticker} מהיומן?`)) {
                                    deleteMut.mutate({ id: entry.id });
                                  }
                                }}
                                title="מחק"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 text-gray-400 hover:text-gray-600"
                                onClick={() => toggleExpand(entry.id)}
                                title={isExpanded ? "כווץ" : "הרחב"}
                              >
                                {isExpanded ? (
                                  <ChevronUp className="h-3.5 w-3.5" />
                                ) : (
                                  <ChevronDown className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
