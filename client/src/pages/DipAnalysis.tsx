/**
 * Deep Analysis Page — standalone page wrapping DeepAnalysisModal
 * Provides autocomplete ticker search using Yahoo Finance, then renders
 * the full DeepAnalysisModal inline (always open, no backdrop overlay).
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { Input } from "@/components/ui/input";
import { Loader2, Search, Zap, X, CheckCircle2, TrendingDown, History } from "lucide-react";
import { DeepAnalysisModal } from "@/components/DeepAnalysisModal";
import { cn } from "@/lib/utils";
import { useLocation } from "wouter";

// ─── Search History helpers ───────────────────────────────────────────────────
const HISTORY_KEY = "ziv_search_history";
const MAX_HISTORY = 25;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(ticker: string, prev: string[]): string[] {
  const deduped = [ticker, ...prev.filter((t) => t !== ticker)].slice(0, MAX_HISTORY);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(deduped)); } catch { /* ignore */ }
  return deduped;
}

// ─── Ticker Autocomplete ──────────────────────────────────────────────────────
function TickerSearch({ onSelect }: { onSelect: (symbol: string) => void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const { data, isFetching } = trpc.searchTicker.useQuery(
    { q: debouncedQ },
    { enabled: debouncedQ.length >= 1, staleTime: 30_000 }
  );

  const results = data?.results ?? [];

  useEffect(() => {
    setOpen(focused && debouncedQ.length >= 1 && results.length > 0);
  }, [focused, debouncedQ, results.length]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFocused(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSelect = (symbol: string) => {
    setQuery(symbol);
    setOpen(false);
    setFocused(false);
    onSelect(symbol.toUpperCase());
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && query.trim()) handleSelect(query.trim().toUpperCase());
    if (e.key === "Escape") { setOpen(false); setFocused(false); }
  };

  const handleClear = () => {
    setQuery("");
    setDebouncedQ("");
    setOpen(false);
    inputRef.current?.focus();
  };

  return (
    <div ref={containerRef} className="relative w-full max-w-lg mx-auto">
      <div className="relative flex items-center">
        <Search className="absolute left-3 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value.toUpperCase())}
          onFocus={() => setFocused(true)}
          onKeyDown={handleKeyDown}
          placeholder="חפש מניה — AAPL, NVDA, TSLA..."
          className="pl-9 pr-10 h-12 text-base font-mono tracking-wide border-2 focus:border-[#2563EB] transition-colors"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          dir="ltr"
        />
        {isFetching && (
          <Loader2 className="absolute right-3 h-4 w-4 animate-spin text-muted-foreground" />
        )}
        {!isFetching && query && (
          <button onClick={handleClear} className="absolute right-3 text-muted-foreground hover:text-foreground transition-colors">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {open && results.length > 0 && (
        <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-background border rounded-xl shadow-xl overflow-hidden">
          {results.map((r) => (
            <button
              key={r.symbol}
              onClick={() => handleSelect(r.symbol)}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/60 transition-colors text-left border-b last:border-b-0"
            >
              <span className="font-mono font-bold text-[#2563EB] text-sm w-16 shrink-0">{r.symbol}</span>
              <span className="text-sm text-foreground truncate flex-1">{r.name}</span>
              <span className={cn(
                "text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0",
                r.type.toLowerCase() === "equity" ? "bg-emerald-50 text-emerald-700" :
                r.type.toLowerCase() === "etf" ? "bg-blue-100 text-blue-700" :
                "bg-muted text-muted-foreground"
              )}>{r.type}</span>
              <span className="text-[10px] text-muted-foreground shrink-0">{r.exchange}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────
export default function DeepAnalysisPage() {
  const [, navigate] = useLocation();
  const [searchHistory, setSearchHistory] = useState<string[]>(() => loadHistory());

  // Support ?ticker=NVDA query param
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("ticker");
    if (t) {
      const sym = t.toUpperCase();
      navigate(`/deep-analysis/${encodeURIComponent(sym)}`);
      setSearchHistory((prev) => saveHistory(sym, prev));
    }
  }, []);

  const handleSelect = useCallback((symbol: string) => {
    navigate(`/deep-analysis/${encodeURIComponent(symbol)}`);
    setSearchHistory((prev) => saveHistory(symbol, prev));
  }, []);

  const handleClose = useCallback(() => {
    if (window.location.search) navigate("/dip-analysis", { replace: true });
  }, [navigate]);

  const handleClearHistory = useCallback(() => {
    try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
    setSearchHistory([]);
  }, []);

  const quickPicks = ["NVDA", "AAPL", "MSFT", "TSLA", "AMZN", "META", "GOOG", "PLTR"];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-muted/20 px-4 py-4">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-2 mb-1">
            <Zap className="h-5 w-5 text-[#2563EB]" />
            <h1 className="text-xl font-bold">Deep Analysis</h1>
            <span className="text-xs text-muted-foreground ml-1">מנוע Ziv Engine</span>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            ניתוח מעמיק לפי חוקי הצנוע — 6 תנאי כניסה, מחיר כניסה, SL, TP, גודל פוזיציה
          </p>
          <TickerSearch onSelect={handleSelect} />

          <div className="flex flex-wrap gap-2 mt-3">
            {quickPicks.map((sym) => (
              <button
                key={sym}
                onClick={() => handleSelect(sym)}
                className="text-xs font-mono px-2.5 py-1 rounded-full border border-border hover:border-[#2563EB] hover:text-[#2563EB] hover:bg-blue-50/50 dark:hover:bg-blue-900/20 transition-colors"
              >
                {sym}
              </button>
            ))}
          </div>

          {/* Search History */}
          {searchHistory.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center gap-2 mb-2">
                <History className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground font-medium">25 חיפושים אחרונים</span>
                <button
                  onClick={handleClearHistory}
                  className="text-[10px] text-muted-foreground hover:text-[#FF6B6B] transition-colors ml-auto"
                >
                  נקה היסטוריה
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {searchHistory.map((sym) => (
                  <button
                    key={sym}
                    onClick={() => handleSelect(sym)}
                    className="text-xs font-mono px-2.5 py-1 rounded-full bg-muted/60 border border-border hover:border-amber-400 hover:text-amber-600 hover:bg-amber-50/50 dark:hover:bg-amber-900/20 transition-colors"
                  >
                    {sym}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Empty state */}
      {(
        <div className="flex flex-col items-center justify-center py-24 px-4 text-center">
          <div className="w-16 h-16 rounded-full bg-blue-100  flex items-center justify-center mb-4">
            <TrendingDown className="h-8 w-8 text-[#2563EB]" />
          </div>
          <h2 className="text-lg font-semibold mb-2">חפש מניה לניתוח</h2>
          <p className="text-sm text-muted-foreground max-w-sm">
            הזן טיקר או שם חברה בשדה החיפוש למעלה. המנוע יבצע ניתוח מלא לפי 6 תנאי הכניסה של שיטת הצנוע.
          </p>
          <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs text-muted-foreground max-w-md">
            {[
              "Ziv Engine Score",
              "מחיר כניסה מומלץ",
              "Stop Loss (ATR)",
              "Take Profit (+2R scale-out)",
              "גודל לפי איכות איתות",
              "התראת Telegram + TV",
            ].map((f) => (
              <div key={f} className="flex items-center gap-1.5 bg-muted/40 rounded-lg px-3 py-2">
                <CheckCircle2 className="h-3 w-3 text-[#65A30D] shrink-0" />
                <span>{f}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* DeepAnalysisModal — full-page overlay */}

    </div>
  );
}
