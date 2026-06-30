import { ArrowLeft, Zap } from "lucide-react";
import { Z } from "@/lib/zIndex";

export function DeepAnalysisHeader({
  ticker,
  company,
  navList,
  onNavigate,
  onClose,
}: {
  ticker: string | null;
  company?: string;
  navList?: string[];
  onNavigate?: (ticker: string) => void;
  onClose: () => void;
}) {
  const idx = ticker && navList ? navList.indexOf(ticker) : -1;
  const prevTicker = idx > 0 && navList ? navList[idx - 1] : null;
  const nextTicker = idx >= 0 && navList && idx < navList.length - 1 ? navList[idx + 1] : null;

  return (
    <div
      className="sticky top-0 flex items-center justify-between px-3 sm:px-6 py-2 border-b bg-background/95 backdrop-blur shrink-0"
      style={{ zIndex: Z.header }}
    >
      <button
        type="button"
        onClick={onClose}
        className="flex items-center gap-1 min-h-[44px] px-2 text-[11px] sm:text-sm font-semibold text-muted-foreground hover:text-foreground"
        aria-label="חזרה"
      >
        <ArrowLeft className="h-4 w-4 shrink-0" />
        <span className="hidden sm:inline">חזרה</span>
      </button>
      <div className="flex items-center gap-2 text-[11px] sm:text-base font-semibold min-w-0">
        <Zap className="h-4 w-4 text-[#2563EB] shrink-0" />
        <span className="truncate">{ticker}</span>
        {company && (
          <span className="hidden md:inline text-xs font-normal text-muted-foreground truncate">— {company}</span>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0 max-w-[45%] sm:max-w-none">
        {navList && navList.length > 1 && onNavigate && (
          <>
            <button
              type="button"
              onClick={() => prevTicker && onNavigate(prevTicker)}
              disabled={!prevTicker}
              title={prevTicker ? `קודם: ${prevTicker}` : undefined}
              className="flex items-center gap-0.5 px-1.5 sm:px-2 py-1 rounded text-[10px] sm:text-xs font-medium border border-border hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
              <span className="hidden sm:inline">PREV</span>
            </button>
            <span className="text-[10px] sm:text-xs text-muted-foreground px-0.5">{idx + 1}/{navList.length}</span>
            <button
              type="button"
              onClick={() => nextTicker && onNavigate(nextTicker)}
              disabled={!nextTicker}
              title={nextTicker ? `הבא: ${nextTicker}` : undefined}
              className="flex items-center gap-0.5 px-1.5 sm:px-2 py-1 rounded text-[10px] sm:text-xs font-medium border border-border hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <span className="hidden sm:inline">NEXT</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="סגור"
          className="min-w-[40px] min-h-[40px] sm:min-w-[44px] sm:min-h-[44px] flex items-center justify-center rounded-full hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>
  );
}
