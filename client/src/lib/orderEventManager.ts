/**
 * Order Event Manager — 7-state lifecycle for manual / live orders.
 * submitting → pending → partial → filled → syncing → complete
 * Terminal: stalled | rejected | cancelled
 */

export type OrderEventPhase =
  | "submitting"
  | "pending"
  | "partial"
  | "filled"
  | "syncing"
  | "complete"
  | "stalled"
  | "rejected"
  | "cancelled";

export const ORDER_EVENT_STEPS: OrderEventPhase[] = [
  "submitting",
  "pending",
  "partial",
  "filled",
  "syncing",
  "complete",
];

export function isTerminalPhase(phase: OrderEventPhase): boolean {
  return phase === "complete" || phase === "stalled" || phase === "rejected" || phase === "cancelled";
}

export function phaseLabelHe(phase: OrderEventPhase): string {
  switch (phase) {
    case "submitting": return "שולח ל-IBKR...";
    case "pending": return "ממתין לביצוע...";
    case "partial": return "מילוי חלקי";
    case "filled": return "בוצע ✅";
    case "syncing": return "מסנכרן הגנה...";
    case "complete": return "הושלם ✅";
    case "stalled": return "אין תגובה מ-IBKR אחרי 25ש'";
    case "rejected": return "נדחה ❌";
    case "cancelled": return "בוטל";
    default: return phase;
  }
}

export function stepIndex(phase: OrderEventPhase): number {
  if (phase === "stalled" || phase === "rejected" || phase === "cancelled") return -1;
  const i = ORDER_EVENT_STEPS.indexOf(phase);
  return i >= 0 ? i : 0;
}

/** Map legacy IBKR poll status + fill info into event phase */
export function mapIbkrToPhase(
  ibkrStatus: string,
  filledQty: number,
  totalQty: number,
): OrderEventPhase {
  const s = ibkrStatus.toLowerCase();
  if (s === "rejected" || s === "inactive") return "rejected";
  if (s === "cancelled") return "cancelled";
  if (s === "filled" || s === "filled_or_gone") {
    return filledQty > 0 && filledQty < totalQty ? "partial" : "filled";
  }
  if (filledQty > 0 && filledQty < totalQty) return "partial";
  if (s === "pending" || s === "submitted" || s === "presubmitted") return "pending";
  return "pending";
}
