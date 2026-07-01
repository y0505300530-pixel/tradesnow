import { useEffect } from "react";
import { useLocation } from "wouter";
import { useTradingViewerContext } from "@/hooks/useTradingViewerContext";

/** Blocks scoped trading-book viewers from CEO-only portfolio / knowledge routes. */
export function RequireFullViewer({ children }: { children: React.ReactNode }) {
  const { isScopedViewer, isLoading } = useTradingViewerContext();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && isScopedViewer) setLocation("/overview");
  }, [isLoading, isScopedViewer, setLocation]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (isScopedViewer) return null;
  return <>{children}</>;
}
