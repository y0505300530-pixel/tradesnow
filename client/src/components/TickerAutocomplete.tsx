/**
 * TickerAutocomplete — reusable ticker search input with Yahoo Finance autocomplete dropdown.
 * Usage:
 *   <TickerAutocomplete
 *     value={ticker}
 *     onChange={(symbol, name) => { setTicker(symbol); setCompany(name); }}
 *     placeholder="TICKER or company name..."
 *     className="..."
 *   />
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

interface TickerAutocompleteProps {
  value: string;
  onChange: (symbol: string, name: string) => void;
  onEnter?: () => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** If true, typing converts input to uppercase automatically */
  uppercase?: boolean;
}

export function TickerAutocomplete({
  value,
  onChange,
  onEnter,
  placeholder = "TICKER or company name...",
  className,
  inputClassName,
  disabled,
  autoFocus,
  uppercase = true,
}: TickerAutocompleteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce: fire search 300ms after last keystroke
  useEffect(() => {
    const t = setTimeout(() => setQuery(value.trim()), 300);
    return () => clearTimeout(t);
  }, [value]);

  const searchQuery = trpc.searchTicker.useQuery(
    { q: query },
    { enabled: query.length >= 1, staleTime: 30_000 }
  );

  const results = searchQuery.data?.results ?? [];

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selectResult = useCallback((symbol: string, name: string) => {
    onChange(symbol, name);
    setOpen(false);
  }, [onChange]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || results.length === 0) {
      if (e.key === "Enter") { onEnter?.(); }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[highlightIdx];
      if (r) { selectResult(r.symbol, r.name); }
      else { setOpen(false); onEnter?.(); }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  // Reset highlight when results change
  useEffect(() => { setHighlightIdx(0); }, [results.length]);

  return (
    <div ref={wrapperRef} className={cn("relative", className)}>
      <div className="relative">
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            const v = uppercase ? e.target.value.toUpperCase() : e.target.value;
            onChange(v, "");
            setOpen(true);
          }}
          onFocus={() => value.length >= 1 && setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={cn("pr-7", inputClassName)}
          disabled={disabled}
          autoFocus={autoFocus}
          autoComplete="off"
          maxLength={30}
        />
        {searchQuery.isFetching && (
          <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 animate-spin text-muted-foreground" />
        )}
      </div>

      {/* Dropdown */}
      {open && results.length > 0 && (
        <div className="absolute top-full left-0 z-[200] mt-1 w-80 min-w-full bg-white border border-border rounded-lg shadow-xl overflow-hidden">
          {results.map((r, i) => (
            <button
              key={r.symbol}
              type="button"
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 text-left transition-colors",
                i === highlightIdx ? "bg-accent" : "hover:bg-accent/60"
              )}
              onMouseEnter={() => setHighlightIdx(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                selectResult(r.symbol, r.name);
              }}
            >
              <span className="font-mono text-xs font-bold text-foreground w-20 shrink-0">{r.symbol}</span>
              <span className="text-xs text-muted-foreground truncate flex-1">{r.name}</span>
              <span className="text-[10px] text-muted-foreground/50 shrink-0">{r.exchange}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
