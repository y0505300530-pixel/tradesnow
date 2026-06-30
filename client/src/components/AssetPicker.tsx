/**
 * AssetPicker — Sortable table of assets.
 * v1.056:
 *   - Converted from grid to a clean table layout
 *   - Catalogue is now stateful (Remove actually removes rows)
 *   - Edit/Replace updates the catalogue row and shows a success toast
 *   - After Check Status: rows sorted by Ziv Score descending
 *   - Fewer than 30 assets is allowed (user can remove any)
 */
import { useState, useEffect, useCallback, useMemo } from "react";
import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  Pencil,
  Trash2,
  Check,
  X,
  TrendingUp,
  ArrowUpDown,
  Plus,
  Database,
  RefreshCw,
  Download,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { ASSET_CATALOGUE, CATALOGUE_VERSION, type AssetDef } from "@/lib/assetCatalogue";
export type { AssetDef } from "@/lib/assetCatalogue";
export { ASSET_CATALOGUE } from "@/lib/assetCatalogue";

// ─── Sector colour map ────────────────────────────────────────────────────────

const SECTOR_COLORS: Record<string, string> = {
  "Semiconductors": "bg-violet-100 text-violet-700",
  "Technology":     "bg-blue-100 text-blue-700",
  "AI / Data":      "bg-indigo-100 text-indigo-700",
  "Finance":        "bg-emerald-900/30 text-[#65A30D]",
  "Healthcare":     "bg-pink-100 text-pink-700",
  "Biotech":        "bg-rose-100 text-rose-700",
  "Energy":         "bg-amber-100 text-amber-700",
  "Industrials":    "bg-orange-100 text-orange-700",
  "EV / Auto":      "bg-red-900/30 text-red-700",
  "Consumer":       "bg-lime-100 text-lime-700",
  "Crypto / Fin":   "bg-yellow-100 text-yellow-700",
  "Crypto":         "bg-yellow-100 text-yellow-700",
  "Social Media":   "bg-sky-100 text-sky-700",
  "Space":          "bg-[rgba(37,99,235,0.15)] text-[#2563EB]",
  "Media":          "bg-teal-100 text-teal-700",
  "Nuclear":        "bg-cyan-100 text-cyan-700",
};

// ─── Score types ──────────────────────────────────────────────────────────────

export type ZivScore = {
  ticker: string;
  score: number;
  label: string;
  reason: string;
  price?: number;
  ema50?: number;
  ema200?: number;
  donchian20High?: number;
  longName?: string;
};

function ScoreBadge({ score, label }: { score: number; label: string }) {
  const color =
    score <= 3 ? "bg-red-900/30 text-red-700 border-red-200" :
    score <= 6 ? "bg-amber-100 text-amber-700 border-amber-300" :
                 "bg-emerald-100 text-emerald-700 border-emerald-300";
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-bold px-2 py-0.5 rounded-full border ${color}`}>
      {score}/10 · {label}
    </span>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface AssetPickerProps {
  selected: string[];
  onChange: (tickers: string[]) => void;
  maxSelect?: number;
  scores?: ZivScore[];
  onCatalogueChange?: (tickers: string[]) => void;
  mandatoryCoreTickers?: string[]; // v1.146: tickers with score >= 8 that are locked-in
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AssetPicker({ selected, onChange, maxSelect = 10, scores, onCatalogueChange, mandatoryCoreTickers = [] }: AssetPickerProps) {
  // Stateful catalogue — loads from DB, falls back to ASSET_CATALOGUE
  const [catalogue, setCatalogue] = useState<AssetDef[]>([...ASSET_CATALOGUE]);
  const [dbLoaded, setDbLoaded] = useState(false);

  // DB procedures
  const { data: dbAssets } = trpc.assetCatalogue.getUserAssets.useQuery(undefined, {
    staleTime: Infinity, // only refetch when we explicitly invalidate
  });
  const bulkReplaceMutation = trpc.assetCatalogue.bulkReplaceUserAssets.useMutation();

  // Load from DB once data arrives
  useEffect(() => {
    if (dbLoaded) return;
    if (dbAssets === undefined) return; // still loading

    // Check if DB catalogue version matches current version
    const storedVersion = Number(localStorage.getItem("catalogue_version") ?? "0");
    const needsReset = storedVersion < CATALOGUE_VERSION;

    if (dbAssets.length > 0 && !needsReset) {
      // User has a saved list and version is current — use it
      const loaded: AssetDef[] = dbAssets.map((a) => ({
        ticker: a.ticker,
        name: a.companyName,
        sector: a.sector,
        emoji: "📌",
        score: a.score ?? undefined,
        label: a.label ?? undefined,
      }));
      setCatalogue(loaded);
      onCatalogueChange?.(loaded.map((a) => a.ticker));
    } else {
      // First time OR catalogue version upgraded — seed DB with new ASSET_CATALOGUE
      bulkReplaceMutation.mutate(
        ASSET_CATALOGUE.map((a, i) => ({
          ticker: a.ticker,
          companyName: a.name,
          sector: a.sector,
          score: null,
          label: null,
          sortOrder: i,
        }))
      );
      setCatalogue([...ASSET_CATALOGUE]);
      onCatalogueChange?.(ASSET_CATALOGUE.map((a) => a.ticker));
      localStorage.setItem("catalogue_version", String(CATALOGUE_VERSION));
    }
    setDbLoaded(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbAssets, dbLoaded]);

  // Notify parent whenever catalogue changes (for Check Status to include custom tickers)
  const updateCatalogue = useCallback((updater: (prev: AssetDef[]) => AssetDef[]) => {
    setCatalogue((prev) => {
      const next = updater(prev);
      onCatalogueChange?.(next.map((a) => a.ticker));
      // Persist the full new list to DB
      bulkReplaceMutation.mutate(
        next.map((a, i) => ({
          ticker: a.ticker,
          companyName: a.name,
          sector: a.sector,
          score: (a as AssetDef & { score?: number }).score ?? null,
          label: (a as AssetDef & { label?: string }).label ?? null,
          sortOrder: i,
        }))
      );
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCatalogueChange]);

  // Validation status map
  const [validMap, setValidMap] = useState<Record<string, "loading" | "ok" | "error">>({});

  // Edit state
  const [editingTicker, setEditingTicker] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // Add row state
  const [isAddingRow, setIsAddingRow] = useState(false);
  const [addValue, setAddValue] = useState("");

  // ── Infer sector from company longName (keyword heuristic) ──
  const inferSector = useCallback((longName: string): string => {
    const n = longName.toLowerCase();
    if (/semiconductor|chip|micro|nvidia|intel|amd|broadcom|qualcomm|tsmc|micron|astera/.test(n)) return "Semiconductors";
    if (/pharma|teva|lilly|pfizer|merck|biotech|therapeutics|bioscience/.test(n)) return "Healthcare";
    if (/bank|financial|capital|goldman|jpmorgan|morgan|visa|mastercard|payment/.test(n)) return "Finance";
    if (/energy|oil|gas|exxon|chevron|petroleum/.test(n)) return "Energy";
    if (/aerospace|defense|lockheed|raytheon|northrop|boeing|ge aerospace/.test(n)) return "Industrials";
    if (/crypto|bitcoin|coinbase|microstrategy/.test(n)) return "Crypto / Fin";
    if (/space|rocket|satellite|launch/.test(n)) return "Space";
    if (/media|spotify|netflix|disney|streaming/.test(n)) return "Media";
    if (/electric|vehicle|tesla|rivian|lucid/.test(n)) return "EV / Auto";
    if (/software|cloud|saas|microsoft|salesforce|oracle|sap/.test(n)) return "Technology";
    if (/social|reddit|snap|twitter|meta|facebook/.test(n)) return "Social Media";
    if (/nuclear|power|energy/.test(n)) return "Nuclear";
    if (/ai|artificial|palantir|data|analytics/.test(n)) return "AI / Data";
    if (/consumer|nike|starbucks|retail|apparel/.test(n)) return "Consumer";
    if (/tech|apple|amazon|alphabet|google/.test(n)) return "Technology";
    return "Custom";
  }, []);

  // Sort by score + update name/sector when scores prop changes (after Check Status)
  useEffect(() => {
    if (!scores || scores.length === 0) return;
    const scoreMap: Record<string, number> = {};
    const nameMap: Record<string, string> = {};
    for (const s of scores) {
      scoreMap[s.ticker] = s.score;
      if (s.longName) nameMap[s.ticker] = s.longName;
    }
    setCatalogue((prev) =>
      [...prev]
        .map((a) => {
          // Update name and infer sector for custom assets that got a longName back
          if (nameMap[a.ticker] && (a.sector === "Custom" || a.name === a.ticker)) {
            const newName = nameMap[a.ticker];
            return { ...a, name: newName, sector: inferSector(newName) };
          }
          return a;
        })
        .sort((a, b) => {
          const sa = scoreMap[a.ticker] ?? -1;
          const sb = scoreMap[b.ticker] ?? -1;
          return sb - sa; // descending
        })
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scores]);

  // Build score map for O(1) lookup
  const scoreMap: Record<string, ZivScore> = {};
  if (scores) {
    for (const s of scores) scoreMap[s.ticker] = s;
  }

  // Validate all assets once on mount
  const validateMutation = trpc.assetCatalogue.validateTickers.useMutation({
    onSuccess: (result: { ticker: string; valid: boolean; price?: number; longName?: string; sector?: string }[]) => {
      // MERGE into existing map — never replace the whole map (would wipe other chunks)
      setValidMap((prev) => {
        const next = { ...prev };
        for (const { ticker, valid } of result) {
          next[ticker] = valid ? "ok" : "error";
        }
        return next;
      });
      // Update name and sector for any ticker that got real data back
      setCatalogue((prev) =>
        prev.map((a) => {
          const r = result.find((x) => x.ticker === a.ticker);
          if (!r) return a;
          const newName = r.longName || a.name;
          // Use Yahoo Finance sector if available, otherwise infer from name
          const newSector = r.sector
            ? r.sector
            : (r.longName && (a.sector === "Custom" || a.name === a.ticker))
              ? inferSector(r.longName)
              : a.sector;
          return { ...a, name: newName, sector: newSector };
        })
      );
    },
  });

  // Run validation on the actual catalogue (from DB) after it loads
  const [hasValidated, setHasValidated] = useState(false);
  useEffect(() => {
    if (!dbLoaded || catalogue.length === 0 || hasValidated) return;
    const loading: Record<string, "loading"> = {};
    for (const a of catalogue) loading[a.ticker] = "loading";
    setValidMap(loading);
    setHasValidated(true);
    // Chunk into batches of 5 and run sequentially with 300ms delay
    // This prevents the 150s timeout that occurs when validating 30 tickers at once
    const tickers = catalogue.map((a) => a.ticker);
    const CHUNK = 5;
    const runChunks = async () => {
      for (let i = 0; i < tickers.length; i += CHUNK) {
        const chunk = tickers.slice(i, i + CHUNK);
        await new Promise<void>((resolve) => {
          validateMutation.mutate(
            { tickers: chunk },
            { onSettled: () => resolve() }
          );
        });
        if (i + CHUNK < tickers.length) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    };
    runChunks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbLoaded, catalogue.length]);

  // ── Selection helpers ──
  const toggle = useCallback((ticker: string) => {
    if (selected.includes(ticker)) {
      onChange(selected.filter((t) => t !== ticker));
    } else {
      if (selected.length >= maxSelect) return;
      onChange([...selected, ticker]);
    }
  }, [selected, onChange, maxSelect]);

  const clearAll = () => onChange([]);

  const selectAll = () => {
    const allTickers = catalogue.map((a) => a.ticker).slice(0, maxSelect);
    onChange(allTickers);
  };

  // ── Remove row from catalogue ──
  const removeAsset = (ticker: string) => {
    updateCatalogue((prev) => prev.filter((a) => a.ticker !== ticker));
    // Also deselect if it was selected
    if (selected.includes(ticker)) {
      onChange(selected.filter((t) => t !== ticker));
    }
  };

  // ── Edit / Replace helpers ──
  const startEdit = (e: React.MouseEvent, ticker: string) => {
    e.stopPropagation();
    setEditingTicker(ticker);
    setEditValue(ticker);
  };

  const commitEdit = (oldTicker: string) => {
    const newTicker = editValue.trim().toUpperCase();
    if (!newTicker || newTicker === oldTicker) {
      setEditingTicker(null);
      return;
    }
    // Replace in catalogue
    updateCatalogue((prev) =>
      prev.map((a) =>
        a.ticker === oldTicker
          ? { ...a, ticker: newTicker, name: newTicker, sector: "Custom", emoji: "📌" }
          : a
      )
    );
    // Replace in selection if it was selected
    if (selected.includes(oldTicker)) {
      onChange(selected.map((t) => (t === oldTicker ? newTicker : t)));
    }
    // Update validation map
    setValidMap((prev) => {
      const next = { ...prev };
      delete next[oldTicker];
      next[newTicker] = "loading";
      return next;
    });
    // Validate the new ticker (onSuccess will update name/sector automatically)
    validateMutation.mutate({ tickers: [newTicker] });
    setEditingTicker(null);
    // Success toast
    toast.success(`${oldTicker} replaced with ${newTicker}`);
  };

  const cancelEdit = () => setEditingTicker(null);

  // ── Add new asset ──
  const commitAdd = () => {
    const newTicker = addValue.trim().toUpperCase();
    if (!newTicker) { setIsAddingRow(false); return; }
    // Prevent duplicates
    if (catalogue.some((a) => a.ticker === newTicker)) {
      toast.error(`${newTicker} is already in the list`);
      setAddValue("");
      setIsAddingRow(false);
      return;
    }
    const newAsset: AssetDef = { ticker: newTicker, name: newTicker, sector: "Custom", emoji: "📌" };
    updateCatalogue((prev) => [...prev, newAsset]);
    setValidMap((prev) => ({ ...prev, [newTicker]: "loading" }));
    validateMutation.mutate({ tickers: [newTicker] });
    toast.success(`${newTicker} added to asset list`);
    setAddValue("");
    setIsAddingRow(false);
  };

  const cancelAdd = () => { setAddValue(""); setIsAddingRow(false); };

  const primeCount = scores?.filter((s) => s.score >= 7).length ?? 0;
  const trashCount = scores?.filter((s) => s.score <= 3).length ?? 0;

  // ── Cache status ─────────────────────────────────────────────────────────────
  // Stabilize with useMemo to prevent infinite re-fetch loop (new array reference every render)
  const catalogueTickers = useMemo(() => catalogue.map((a) => a.ticker), [catalogue]);
  const { data: cacheStatusData, refetch: refetchCacheStatus } = trpc.assetCatalogue.getCacheStatus.useQuery(
    { tickers: catalogueTickers },
    { enabled: catalogueTickers.length > 0, staleTime: 60_000 }
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState({ done: 0, total: 0 });
  const refreshCacheMutation = trpc.assetCatalogue.refreshCache.useMutation();
  const downloadCacheCSVQuery = trpc.assetCatalogue.downloadCacheCSV.useQuery(
    { tickers: catalogueTickers },
    { enabled: false }
  );

  const handleUpdateDatabase = async () => {
    setIsRefreshing(true);
    const total = catalogueTickers.length;
    setRefreshProgress({ done: 0, total });
    try {
      // Process in client-side batches of 20 for progress visibility
      const BATCH = 20;
      for (let i = 0; i < total; i += BATCH) {
        const batch = catalogueTickers.slice(i, i + BATCH);
        await refreshCacheMutation.mutateAsync({ tickers: batch, years: 3 });
        setRefreshProgress({ done: Math.min(i + BATCH, total), total });
      }
      await refetchCacheStatus();
      toast.success(`✅ Database updated for ${total} tickers`);
    } catch {
      toast.error("Failed to update database. Try again.");
    } finally {
      setIsRefreshing(false);
      setRefreshProgress({ done: 0, total: 0 });
    }
  };

  const handleDownloadCSV = async () => {
    const result = await downloadCacheCSVQuery.refetch();
    if (!result.data?.csv) { toast.error("No cached data to download. Update the database first."); return; }
    const blob = new Blob([result.data.csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `price-data-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${result.data.rowCount.toLocaleString()} price bars`);
  };

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-[#2563EB]" />
          <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
            Asset List
          </span>
          <span className="text-[11px] text-gray-400 font-normal normal-case">
            (select up to {maxSelect})
          </span>
          {scores && scores.length > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-gray-400">
              <ArrowUpDown className="w-3 h-3" />
              sorted by score
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {scores && scores.length > 0 && (
            <span className="text-[10px] text-gray-500">
              <span className="text-[#65A30D] font-semibold">{primeCount} Prime</span>
              {" · "}
              <span className="text-[#FF6B6B] font-semibold">{trashCount} Trash</span>
            </span>
          )}
          <button
            onClick={selectAll}
            disabled={selected.length >= maxSelect && selected.length === catalogue.length}
            className="text-[11px] text-gray-400 hover:text-[#2563EB] transition-colors disabled:opacity-30"
          >
            Select all
          </button>
          {selected.length > 0 && (
            <button
              onClick={clearAll}
              className="text-[11px] text-gray-400 hover:text-[#FF6B6B] transition-colors"
            >
              Clear all
            </button>
          )}
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
            selected.length >= maxSelect
              ? "bg-amber-100 text-amber-700"
              : selected.length > 0
              ? "bg-violet-100 text-violet-700"
              : "bg-gray-100 text-gray-500"
          }`}>
            {selected.length} / {maxSelect} selected
          </span>
        </div>
      </div>

      {/* Cache toolbar */}
      <div className="flex items-center justify-between px-1 py-1.5 bg-gray-50 rounded-lg border border-gray-200">
        <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
          <Database className="w-3.5 h-3.5 text-gray-400" />
          <span className="font-medium">Price Database:</span>
          {cacheStatusData ? (
            <span>
              <span className="text-[#65A30D] font-semibold">
                {Object.values(cacheStatusData).filter((s) => !s.isStale && s.rowCount > 0).length}
              </span>
              {" fresh · "}
              <span className="text-amber-600 font-semibold">
                {Object.values(cacheStatusData).filter((s) => s.isStale && s.rowCount > 0).length}
              </span>
              {" stale · "}
              <span className="text-gray-400">
                {Object.values(cacheStatusData).filter((s) => s.rowCount === 0).length}
              </span>
              {" not cached"}
            </span>
          ) : (
            <span className="text-gray-400">checking...</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleDownloadCSV}
            className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-[#2563EB] transition-colors px-2 py-1 rounded hover:bg-violet-50"
            title="Download all cached price data as CSV"
          >
            <Download className="w-3 h-3" />
            Download CSV
          </button>
          <button
            onClick={handleUpdateDatabase}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 text-[11px] font-semibold text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors px-2.5 py-1 rounded-md"
            title="Pre-download 3 years of price data for all tickers (makes simulations 5-8x faster)"
          >
            {isRefreshing ? (
              <><RefreshCw className="w-3 h-3 animate-spin" />{refreshProgress.total > 0 ? `${refreshProgress.done}/${refreshProgress.total}` : 'Updating...'}</>
            ) : (
              <><RefreshCw className="w-3 h-3" />Update Database Now</>
            )}
          </button>
          {isRefreshing && refreshProgress.total > 0 && (
            <div className="w-full bg-gray-200 rounded-full h-1.5 mt-1">
              <div
                className="bg-violet-600 h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${(refreshProgress.done / refreshProgress.total) * 100}%` }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Table — 2-column layout for 60 assets */}
      {(() => {
        const half = Math.ceil(catalogue.length / 2);
        const leftAssets = catalogue.slice(0, half);
        const rightAssets = catalogue.slice(half);

        const renderRow = (asset: AssetDef, idx: number) => {
          const isSelected = selected.includes(asset.ticker);
          const status = validMap[asset.ticker] ?? "loading";
          const isDisabled = !isSelected && selected.length >= maxSelect;
          const sectorColor = SECTOR_COLORS[asset.sector] ?? "bg-gray-100 text-gray-500";
          const zivScore = scoreMap[asset.ticker];
          const isMandatoryCore = mandatoryCoreTickers.includes(asset.ticker) || (zivScore && zivScore.score >= 8 && mandatoryCoreTickers.length > 0);
          const isEditing = editingTicker === asset.ticker;
          const rowBg = isSelected && isMandatoryCore
            ? "bg-amber-50/60"
            : isSelected
            ? "bg-violet-50"
            : zivScore && zivScore.score >= 7
            ? "bg-emerald-50/40"
            : zivScore && zivScore.score <= 3
            ? "bg-red-50/30"
            : "bg-white";

          return (
            <tr key={asset.ticker} className={`${rowBg} hover:bg-violet-50/60 transition-colors ${isDisabled ? "opacity-40" : ""}`}>
              <td className="px-2 py-1.5 text-[11px] text-gray-400 font-mono">{idx + 1}</td>
              <td className="px-2 py-1.5">
                {isEditing ? (
                  <div className="flex items-center gap-1">
                    <input autoFocus value={editValue}
                      onChange={(e) => setEditValue(e.target.value.toUpperCase())}
                      onKeyDown={(e) => { if (e.key === "Enter") commitEdit(asset.ticker); if (e.key === "Escape") cancelEdit(); }}
                      className="w-16 text-xs font-bold font-mono border border-violet-400 rounded px-1 py-0.5 focus:outline-none bg-white text-violet-700" maxLength={12} />
                    <button onClick={() => commitEdit(asset.ticker)} className="text-[#65A30D] hover:text-[#65A30D]"><Check className="w-3 h-3" /></button>
                    <button onClick={cancelEdit} className="text-gray-400 hover:text-gray-600"><X className="w-3 h-3" /></button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1">
                    <span className={`text-xs font-bold font-mono ${isSelected && isMandatoryCore ? "text-amber-400" : isSelected ? "text-violet-700" : "text-gray-800"}`}>{asset.ticker}</span>
                    {isMandatoryCore && (
                      <span title="Mandatory Core: score ≥ 8/10 — always included in simulation" className="inline-flex items-center text-[9px] font-bold px-1 py-0 rounded-full bg-amber-100 text-amber-700 border border-amber-300 leading-4">⭐</span>
                    )}
                  </div>
                )}
              </td>

              <td className="px-1 py-1.5 hidden lg:table-cell">
                <span className={`text-[9px] font-semibold px-1 py-0.5 rounded-full whitespace-nowrap ${sectorColor}`}>{asset.sector}</span>
              </td>
              <td className="px-2 py-1.5">
                {status === "loading" ? <Loader2 className="w-3.5 h-3.5 text-gray-300 animate-spin" />
                  : status === "ok" ? <span title="Verified"><CheckCircle2 className="w-3.5 h-3.5 text-[#65A30D]" /></span>
                  : <span title="Not found"><AlertCircle className="w-3.5 h-3.5 text-[#FF6B6B]" /></span>}
              </td>
              {scores && scores.length > 0 && (
                <td className="px-2 py-1.5">
                  {zivScore ? <div title={zivScore.reason}><ScoreBadge score={zivScore.score} label={zivScore.label} /></div>
                    : <span className="text-[10px] text-gray-300">—</span>}
                </td>
              )}
              <td className="px-2 py-1.5 text-center">
                <button
                  onClick={() => {
                    if (isMandatoryCore && isSelected) {
                      toast.error(`${asset.ticker} is Mandatory Core (score ≥ 8) — cannot be deselected`);
                      return;
                    }
                    if (!isDisabled) toggle(asset.ticker);
                  }}
                  disabled={isDisabled && !isMandatoryCore}
                  title={isMandatoryCore && isSelected ? `⭐ Mandatory Core — locked in (score ≥ 8/10)` : isDisabled ? `Maximum ${maxSelect} assets selected` : isSelected ? "Deselect" : "Select"}
                  className={`w-4 h-4 rounded border-2 flex items-center justify-center mx-auto transition-all ${
                    isSelected && isMandatoryCore ? "bg-amber-500 border-amber-500" : isSelected ? "bg-violet-600 border-violet-600" : isDisabled ? "border-gray-200 cursor-not-allowed" : "border-gray-300 hover:border-violet-400 cursor-pointer"
                  }`}>
                  {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                </button>
              </td>
              <td className="px-2 py-1.5">
                <div className="flex items-center justify-center gap-0.5">
                  <button onClick={(e) => startEdit(e, asset.ticker)} title={`Replace ${asset.ticker}`}
                    className="p-0.5 rounded text-gray-300 hover:text-[#2563EB] hover:bg-violet-100 transition-colors">
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button onClick={() => removeAsset(asset.ticker)} title={`Remove ${asset.ticker}`}
                    className="p-0.5 rounded text-gray-300 hover:text-[#FF6B6B] hover:bg-red-50 transition-colors">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </td>
            </tr>
          );
        };

        const tableHeader = (
          <tr className="bg-gray-50 border-b border-gray-200">
            <th className="w-6 px-2 py-2 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wide">#</th>
            <th className="px-2 py-2 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Ticker</th>
            <th className="px-1 py-2 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wide hidden lg:table-cell">Sector</th>
            <th className="px-2 py-2 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Status</th>
            {scores && scores.length > 0 && <th className="px-2 py-2 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Score</th>}
            <th className="px-2 py-2 text-center text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Select</th>
            <th className="px-2 py-2 text-center text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Actions</th>
          </tr>
        );

        return (
          <div className="rounded-xl border border-gray-200 overflow-x-auto">
            {catalogue.length === 0 ? (
              <div className="py-8 text-center text-sm text-gray-400">No assets in list. Add tickers to get started.</div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-gray-200 min-w-0">
                {/* Left half */}
                <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[340px]">
                  <thead>{tableHeader}</thead>
                  <tbody className="divide-y divide-gray-100">
                    {leftAssets.map((asset, i) => renderRow(asset, i))}
                  </tbody>
                  {/* Add Asset footer — only on left table */}
                  <tfoot>
                    <tr className="border-t border-dashed border-gray-200 bg-gray-50/60 hover:bg-violet-50/40 transition-colors">
                      {isAddingRow ? (
                        <>
                          <td className="px-2 py-1.5 text-[11px] text-gray-400 font-mono">{catalogue.length + 1}</td>
                          <td className="px-2 py-1.5" colSpan={1}>
                            <div className="flex items-center gap-1">
                              <input autoFocus value={addValue}
                                onChange={(e) => setAddValue(e.target.value.toUpperCase())}
                                onKeyDown={(e) => { if (e.key === "Enter") commitAdd(); if (e.key === "Escape") cancelAdd(); }}
                                placeholder="e.g. CRWD"
                                className="w-24 text-xs font-bold font-mono border border-violet-400 rounded px-1.5 py-0.5 focus:outline-none bg-white text-violet-700 placeholder:text-gray-300" maxLength={12} />
                              <button onClick={commitAdd} className="text-[#65A30D] hover:text-[#65A30D]" title="Add"><Check className="w-3 h-3" /></button>
                              <button onClick={cancelAdd} className="text-gray-400 hover:text-gray-600" title="Cancel"><X className="w-3 h-3" /></button>
                            </div>
                          </td>
                          <td colSpan={scores && scores.length > 0 ? 3 : 2} />
                        </>
                      ) : (
                        <td colSpan={scores && scores.length > 0 ? 5 : 4} className="px-2 py-1.5 cursor-pointer" onClick={() => setIsAddingRow(true)}>
                          <span className="flex items-center gap-1.5 text-[12px] text-gray-400 hover:text-[#2563EB] transition-colors select-none">
                            <Plus className="w-3.5 h-3.5" /> Add asset
                          </span>
                        </td>
                      )}
                    </tr>
                  </tfoot>
                </table>
                </div>
                {/* Right half */}
                <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[340px]">
                  <thead>{tableHeader}</thead>
                  <tbody className="divide-y divide-gray-100">
                    {rightAssets.map((asset, i) => renderRow(asset, half + i))}
                  </tbody>
                </table>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Selected tickers summary chips */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {selected.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 text-[11px] font-mono font-bold text-violet-700 bg-violet-100 border border-violet-200 px-2 py-0.5 rounded-full"
            >
              {t}
              <button
                onClick={() => toggle(t)}
                className="text-violet-400 hover:text-[#FF6B6B] transition-colors leading-none"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

