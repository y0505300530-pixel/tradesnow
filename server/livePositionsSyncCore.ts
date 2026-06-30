/**
 * IBKR sync uses only columns that existed before phase-3-7 migrations.
 * Drizzle's select().from(livePositions) projects the full schema — if slProtection
 * (or other new columns) are missing in MySQL, the entire sync aborts before any UPDATE.
 */
import { livePositions } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";

/** Columns required for IBKR position sync — safe on pre-migration DBs */
export const livePositionSyncSelect = {
  id: livePositions.id,
  userId: livePositions.userId,
  ticker: livePositions.ticker,
  direction: livePositions.direction,
  status: livePositions.status,
  units: livePositions.units,
  entryPrice: livePositions.entryPrice,
  allocatedCapital: livePositions.allocatedCapital,
  currentPrice: livePositions.currentPrice,
  currentSl: livePositions.currentSl,
  initialSl: livePositions.initialSl,
  initialTp: livePositions.initialTp,
  ibkrSlOrderId: livePositions.ibkrSlOrderId,
  ibkrTpOrderId: livePositions.ibkrTpOrderId,
  rValue: livePositions.rValue,
  atr14: livePositions.atr14,
  // Phoenix P-S0: origin signal is needed to test Wide-Lung-stop eligibility (P1) on close.
  // A pre-`signal` DB is impossible here (signal is NOT NULL since the engine's inception),
  // so this never aborts the sync on a pre-migration DB.
  signal: livePositions.signal,
} as const;

export type LivePositionSyncRow = {
  id: number;
  userId: number;
  ticker: string;
  direction: "long" | "short";
  status: string;
  units: number;
  entryPrice: number;
  allocatedCapital: number;
  currentPrice: number | null;
  currentSl: number;
  initialSl: number;
  initialTp: number;
  ibkrSlOrderId: string | null;
  ibkrTpOrderId: string | null;
  rValue: number | null;
  atr14: number | null;
  signal: string;
};

type Db = MySql2Database<Record<string, never>>;

const OPTIONAL_LIVE_POSITION_COLUMNS = new Set([
  "slProtection",
  "requestedQty",
  "filledQty",
  "remainingQty",
  "ibkrAvgCost",
  "ibkrUnits",
  "corporateActionFrozen",
  "pendingHalt",
  "haltRetryCount",
  "fillStatus",
  "entryStructMeta",   // Ziv ledger-fix: metadata must never block the core position insert (schema-drift safety)
  // Ghost Slots / Phoenix v1.1 — additive columns; never block the core insert/update
  // if the migration has not yet landed on the target DB (inert flags ⇒ never read anyway).
  "slotGhost",
  "countsTowardSlot",
  "ghostAt",
  "ghostStage",
  "phoenixGeneration",
  "originPosId",
]);

export function isUnknownColumnError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /unknown column/i.test(msg) || /ER_BAD_FIELD_ERROR/i.test(msg);
}

/** Unknown column or enum value not yet migrated */
export function isSchemaDriftError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return isUnknownColumnError(err)
    || /invalid enum/i.test(msg)
    || /data truncated/i.test(msg)
    || /ER_TRUNCATED_WRONG_VALUE/i.test(msg);
}

export function isDuplicateKeyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && "cause" in err
    ? String((err as { cause?: unknown }).cause ?? "")
    : "";
  return /duplicate entry/i.test(msg) || /uq_open_ticker/i.test(msg) || /uq_active_ticker/i.test(msg)
    || /duplicate entry/i.test(cause) || /uq_open_ticker/i.test(cause) || /uq_active_ticker/i.test(cause);
}

/** Close row; if uq_open_ticker blocks (prior closed row exists), purge zombie instead */
export async function safeCloseLivePosition(
  db: Db,
  positionId: number,
  fields: Record<string, unknown>,
): Promise<"closed" | "purged"> {
  try {
    await safeUpdateLivePosition(db, positionId, fields);
    return "closed";
  } catch (err) {
    if (fields.status === "closed" && isDuplicateKeyError(err)) {
      await db.delete(livePositions).where(eq(livePositions.id, positionId));
      return "purged";
    }
    throw err;
  }
}

function stripOptionalLivePositionFields(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...payload };
  for (const col of OPTIONAL_LIVE_POSITION_COLUMNS) delete out[col];
  if (out.status === "pending_entry" || out.status === "frozen" || out.status === "pending_halt") {
    out.status = "open";
  }
  return out;
}

export async function fetchOpenLivePositionsForSync(
  db: Db,
  userId: number,
): Promise<LivePositionSyncRow[]> {
  const { and, eq: eqOp, inArray } = await import("drizzle-orm");
  return db
    .select(livePositionSyncSelect)
    .from(livePositions)
    .where(and(
      eqOp(livePositions.userId, userId),
      inArray(livePositions.status, ["open", "pending_entry", "pending_exit"]),
    ));
}

/** Update livePositions — retries without optional columns if DB schema is behind code */
export async function safeUpdateLivePosition(
  db: Db,
  positionId: number,
  fields: Record<string, unknown>,
): Promise<void> {
  const payload = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  );
  if (Object.keys(payload).length === 0) return;

  try {
    await db.update(livePositions).set(payload as any).where(eq(livePositions.id, positionId));
  } catch (err) {
    if (!isUnknownColumnError(err)) throw err;
    const stripped = Object.fromEntries(
      Object.entries(payload).filter(([k]) => !OPTIONAL_LIVE_POSITION_COLUMNS.has(k)),
    );
    if (Object.keys(stripped).length === 0) throw err;
    await db.update(livePositions).set(stripped as any).where(eq(livePositions.id, positionId));
  }
}

/** Insert livePositions — retries without optional columns / enum values if DB schema lags code */
export async function safeInsertLivePosition(
  db: Db,
  values: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(livePositions).values(values as any);
  } catch (err) {
    if (!isSchemaDriftError(err)) throw err;
    const stripped = stripOptionalLivePositionFields(values);
    await db.insert(livePositions).values(stripped as any);
  }
}
