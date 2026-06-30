/**
 * selectedTeam.ts — SELECTED_TEAM rank-priority SSOT (owner-ratified 2026-06-30).
 *
 * ── WHAT THIS IS ──────────────────────────────────────────────────────────────────
 * The 15 owner-picked "selected team" tickers get a SORT-ONLY bonus so they rank
 * higher in the War candidates list and are more likely to make the Armed-Watcher
 * top-N. "Priority = scanned first + ranked higher, NOT bought at any price."
 *
 * ── WHAT THIS IS NOT (non-negotiable) ─────────────────────────────────────────────
 * This bonus NEVER touches a gate, sizing, FOMO/anti-chase, gapGuard, RC2/VixSize,
 * the combinedGate, the zivStructural floor, or the sector cap. It feeds ONLY the
 * derived score used for ranking / top-N selection. A team name that fails a gate is
 * still BLOCKED/SKIPped exactly as before — it merely sorts higher among ENTERs.
 *
 * ── STORAGE (Git SSOT, owner-editable) ────────────────────────────────────────────
 * The live list lives in `systemSettings` under key `selected_team` as a JSON array
 * of ticker strings. `seedSelectedTeam()` does an idempotent insert of DEFAULT.
 * `DEFAULT_SELECTED_TEAM` is the seed/fallback ONLY — never the live source once the
 * row exists. Read once per cycle (cached, short TTL) into an uppercased Set.
 */

import { getDb } from "./db";

/** Score bonus applied to a selected-team ticker for SORT/RANK only (capped at 10). */
export const SELECTED_TEAM_BOOST = 0.4;

/** systemSettings key holding the owner-editable JSON array. */
export const SELECTED_TEAM_KEY = "selected_team";

/** Seed / fallback ONLY. The live source is the systemSettings row once seeded. */
export const DEFAULT_SELECTED_TEAM: readonly string[] = [
  "SNDK", "MU", "INTC", "MRVL", "AMD", "DELL", "FLEX", "STX",
  "WDC", "HUM", "DDOG", "AMAT", "PANW", "KLAC", "LRCX",
] as const;

// ── Per-process cache (short TTL — read-once-per-cycle semantics) ──────────────────
const CACHE_TTL_MS = 60_000;
let _cache: Set<string> | null = null;
let _cacheAt = 0;

/** Uppercase + trim + dedupe a raw string[] into a Set. */
function toSet(arr: readonly unknown[]): Set<string> {
  const s = new Set<string>();
  for (const t of arr) {
    const u = String(t ?? "").trim().toUpperCase();
    if (u) s.add(u);
  }
  return s;
}

/**
 * seedSelectedTeam — idempotent insert of DEFAULT_SELECTED_TEAM under SELECTED_TEAM_KEY.
 * Never overwrites an existing owner-edited row (onDuplicateKeyUpdate is a no-op write
 * of the SAME key so an existing value is preserved by the WHERE-on-unique-key). Best-
 * effort: a DB miss/throw is swallowed (the code-level DEFAULT remains the fallback).
 */
export async function seedSelectedTeam(): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const { systemSettings } = await import("../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(systemSettings)
      .where(eq(systemSettings.key, SELECTED_TEAM_KEY)).limit(1);
    if ((row as any)?.value) return;   // already seeded / owner-edited → leave untouched
    const value = JSON.stringify([...DEFAULT_SELECTED_TEAM]);
    await db.insert(systemSettings).values({ key: SELECTED_TEAM_KEY, value } as any)
      .onDuplicateKeyUpdate({ set: {} as any });   // race-safe no-op if a peer just seeded
  } catch { /* seeding is best-effort — DEFAULT_SELECTED_TEAM is the fallback */ }
}

/**
 * getSelectedTeamSet — the live selected-team set (uppercased), read once per cycle
 * and cached for CACHE_TTL_MS. Source of truth: systemSettings.selected_team JSON
 * array; falls back to DEFAULT_SELECTED_TEAM when the row is missing/empty/unparseable
 * (and seeds it best-effort in the background). NEVER throws.
 */
export async function getSelectedTeamSet(): Promise<Set<string>> {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL_MS) return _cache;
  try {
    const db = await getDb();
    if (!db) return _cache ?? toSet(DEFAULT_SELECTED_TEAM);
    const { systemSettings } = await import("../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(systemSettings)
      .where(eq(systemSettings.key, SELECTED_TEAM_KEY)).limit(1);
    if (!(row as any)?.value) {
      // Not seeded yet → seed in the background, use DEFAULT this cycle.
      void seedSelectedTeam();
      _cache = toSet(DEFAULT_SELECTED_TEAM);
      _cacheAt = now;
      return _cache;
    }
    const parsed = JSON.parse((row as any).value);
    const arr = Array.isArray(parsed) ? parsed : DEFAULT_SELECTED_TEAM;
    _cache = arr.length ? toSet(arr) : toSet(DEFAULT_SELECTED_TEAM);
    _cacheAt = now;
    return _cache;
  } catch {
    return _cache ?? toSet(DEFAULT_SELECTED_TEAM);
  }
}

/** Synchronous test/seed helper — the DEFAULT set as an uppercased Set. */
export function defaultSelectedTeamSet(): Set<string> {
  return toSet(DEFAULT_SELECTED_TEAM);
}

/**
 * effectiveSortScore — PURE. The score a candidate sorts/ranks by. When the ticker is
 * on the selected team, base + SELECTED_TEAM_BOOST (capped at 10); otherwise base
 * unchanged. SORT/RANK/top-N ONLY — never a gate, size, or order input.
 */
export function effectiveSortScore(base: number, ticker: string, team: Set<string>): number {
  const t = String(ticker ?? "").trim().toUpperCase();
  const b = Number.isFinite(base) ? base : 0;
  return team.has(t) ? Math.min(10, b + SELECTED_TEAM_BOOST) : b;
}

/** Test-only: clear the per-process cache. */
export function __resetSelectedTeamCache(): void {
  _cache = null;
  _cacheAt = 0;
}
