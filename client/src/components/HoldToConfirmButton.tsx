/**
 * Hold-to-confirm action button (spec: 600ms for War Room liquidate).
 * Min touch target 44×44px; pointer capture prevents accidental cancel on drag.
 * Keyboard: Enter/Space calls onKeyboardConfirm (regular confirm dialog path).
 */
import { useRef, useState, useCallback, type ReactNode, type KeyboardEvent } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { HOLD_TO_LIQUIDATE_MS } from "@/lib/manualOrderContract";

interface HoldToConfirmButtonProps {
  onConfirm: () => void;
  /** Accessible alternate — e.g. open AlertDialog instead of hold */
  onKeyboardConfirm?: () => void;
  disabled?: boolean;
  loading?: boolean;
  holdMs?: number;
  title?: string;
  className?: string;
  fillClassName?: string;
  ringClassName?: string;
  children: ReactNode;
}

export function HoldToConfirmButton({
  onConfirm,
  onKeyboardConfirm,
  disabled = false,
  loading = false,
  holdMs = HOLD_TO_LIQUIDATE_MS,
  title = "חיסול מהיר — החזק לאישור",
  className,
  fillClassName = "bg-red-500/40",
  ringClassName = "border-red-500",
  children,
}: HoldToConfirmButtonProps) {
  const [progress, setProgress] = useState(0);
  const [holding, setHolding] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef(0);
  const pointerIdRef = useRef<number | null>(null);
  const isDisabled = disabled || loading;

  const ariaLabel = onKeyboardConfirm
    ? `${title} — החזק לאישור, או Enter לאישור בדיאלוג`
    : title;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setHolding(false);
    setProgress(0);
    pointerIdRef.current = null;
  }, []);

  const startHold = useCallback(() => {
    if (isDisabled) return;
    setHolding(true);
    startRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startRef.current;
      const p = Math.min(1, elapsed / holdMs);
      setProgress(p);
      if (p >= 1) {
        clearTimer();
        onConfirm();
      }
    }, 16);
  }, [isDisabled, holdMs, onConfirm, clearTimer]);

  const releasePointer = useCallback((el: HTMLButtonElement, pointerId: number) => {
    if (el.hasPointerCapture(pointerId)) {
      el.releasePointerCapture(pointerId);
    }
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (onKeyboardConfirm) {
        onKeyboardConfirm();
      }
    }
  }, [isDisabled, onKeyboardConfirm]);

  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      disabled={isDisabled}
      onPointerDown={(e) => {
        if (isDisabled) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        pointerIdRef.current = e.pointerId;
        startHold();
      }}
      onPointerUp={(e) => {
        releasePointer(e.currentTarget, e.pointerId);
        clearTimer();
      }}
      onPointerCancel={(e) => {
        releasePointer(e.currentTarget, e.pointerId);
        clearTimer();
      }}
      onLostPointerCapture={() => {
        clearTimer();
      }}
      onKeyDown={handleKeyDown}
      className={cn(
        "relative overflow-hidden min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full border transition-all text-[11px] font-bold select-none touch-none",
        isDisabled && "opacity-40 cursor-not-allowed",
        className,
      )}
    >
      {holding && (
        <>
          <span
            className={cn("absolute inset-y-0 left-0 pointer-events-none transition-none", fillClassName)}
            style={{ width: `${progress * 100}%` }}
          />
          <span className={cn("absolute inset-0 rounded-full border-2 pointer-events-none", ringClassName)} />
        </>
      )}
      <span className="relative z-10 flex items-center justify-center gap-1">
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : children}
      </span>
    </button>
  );
}
