/**
 * Hold-to-confirm action button (spec: 600ms for War Room liquidate).
 * Min touch target 44×44px; pointer capture prevents accidental cancel on drag.
 * Keyboard: Enter/Space calls onKeyboardConfirm (regular confirm dialog path).
 *
 * BUGFIX 2026-07-02: touch-action:none + immediate pointer capture meant a
 * finger merely scrolling the mobile positions list over this button (or
 * grazing it while tapping the adjacent ticker) could accidentally trigger
 * a full liquidate if the touch dwelled >=600ms. Added a movement-cancel
 * threshold — any pointer movement past MOVE_CANCEL_PX cancels the hold,
 * exactly like native swipe-action lists behave.
 */
import { useRef, useState, useCallback, type ReactNode, type KeyboardEvent } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { HOLD_TO_LIQUIDATE_MS } from "@/lib/manualOrderContract";

const MOVE_CANCEL_PX = 10;

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
  const startPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
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
        startPosRef.current = { x: e.clientX, y: e.clientY };
        startHold();
      }}
      onPointerMove={(e) => {
        // Any real movement (scroll attempt / finger sliding off) cancels the hold.
        if (pointerIdRef.current !== e.pointerId) return;
        const dx = e.clientX - startPosRef.current.x;
        const dy = e.clientY - startPosRef.current.y;
        if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) {
          releasePointer(e.currentTarget, e.pointerId);
          clearTimer();
        }
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
