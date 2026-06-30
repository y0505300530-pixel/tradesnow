/**
 * warRoomProgress.ts — lightweight, module-level progress store for the War Room
 * "Run Cycle" / "Refresh Candidates" UI. Polled by liveEngine.getCycleProgress
 * (~1s) and snapshotted by liveEngine.getCycleSummary at the end of a run.
 *
 * Purely in-memory (single-process server). NO DB, NO IBKR, NO order placement —
 * this is display plumbing only and must NEVER feed any trading decision.
 *
 * The scan/cycle endpoints call setProgress() at natural phase boundaries
 * (regime → manage/stops → scan → persist → done) so the UI can render a live
 * progress bar with a Hebrew phase label.
 */

export interface CycleProgress {
  running: boolean;
  /** 0–100 */
  pct: number;
  /** Hebrew phase label, e.g. "סורק מועמדים…" */
  phase: string;
}

export interface CycleSummary {
  errors: string[];
  successes: string[];
  actions: string[];
  finishedAt: string | null;
}

// ─── Hebrew phase labels (single source so endpoints + warEngine agree) ─────────
export const WR_PHASE = {
  IDLE:    "ממתין",
  START:   "מאתחל מחזור…",
  REGIME:  "בודק חומות מאקרו…",
  MANAGE:  "בודק סטופים…",
  SCAN:    "סורק מועמדים…",
  GATES:   "בודק חוקי כניסה…",
  PERSIST: "שומר תוצאות…",
  DONE:    "הושלם",
} as const;

// ─── Module-level state (single process) ────────────────────────────────────────
let _progress: CycleProgress = { running: false, pct: 0, phase: WR_PHASE.IDLE };
let _summary: CycleSummary = { errors: [], successes: [], actions: [], finishedAt: null };

/** Read the current live progress (for getCycleProgress). Returns a copy. */
export function getProgress(): CycleProgress {
  return { ..._progress };
}

/** Overwrite the live progress. pct is clamped to 0–100. */
export function setProgress(p: Partial<CycleProgress>): void {
  const next: CycleProgress = { ..._progress, ...p };
  if (typeof next.pct === "number") next.pct = Math.max(0, Math.min(100, next.pct));
  _progress = next;
}

/** Mark a run as started — running=true, pct=0, START phase, fresh summary buffers. */
export function startProgress(phase: string = WR_PHASE.START): void {
  _progress = { running: true, pct: 0, phase };
}

/**
 * Mark a run finished — running=false, pct=100, DONE phase — and snapshot the
 * last-run summary (read by getCycleSummary). Always call this in a finally{}.
 */
export function finishProgress(summary: Omit<CycleSummary, "finishedAt">): void {
  _progress = { running: false, pct: 100, phase: WR_PHASE.DONE };
  _summary = { ...summary, finishedAt: new Date().toISOString() };
}

/** Read the last completed cycle's summary (for getCycleSummary). Returns a copy. */
export function getSummary(): CycleSummary {
  return {
    errors: [..._summary.errors],
    successes: [..._summary.successes],
    actions: [..._summary.actions],
    finishedAt: _summary.finishedAt,
  };
}
