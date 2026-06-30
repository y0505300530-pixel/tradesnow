/**
 * kronosConvictionJob.ts — Kronos ENTRY-CONVICTION pipeline (NEW path).
 * ─────────────────────────────────────────────────────────────────────────────
 * SEPARATE concern from the legacy catalogue-bias path in kronosEngine.ts /
 * kronosCatalogueRefresh.ts (which writes a signed [-2,+2] bias to userAssets for
 * ranking only). This file owns the [0,2.5] conviction ADDON that gates LIVE
 * entries via the combined score:  combined = ZIV(≤7.5) + kronosAddon(0..2.5).
 *
 * Two surfaces:
 *   1. runKronosConvictionJob(userId)  — hourly, OFF the war slots (:05). Spawns
 *      kronos on the ZIV≥floor survivors, maps forecast→addon, upserts the cache.
 *      Best-effort: one ticker's failure never crashes the job.
 *   2. getKronosAddon(ticker, dir, cfg) — read helper for the War Engine. NEVER
 *      throws, NEVER spawns kronos. Returns {addon:0, stale:true} on miss/stale/
 *      weight=0/direction-mismatch so a kronos outage can never freeze entries.
 *
 * MAPPING + run params are the quant ruleset (2026-06-25-kronos-mapping-ruleset.md).
 * CRITICAL: the kronos JSON `band_width_pct` is the FULL low-to-high width — it is
 * NOT halved here; all §3.2 thresholds compare against the full width.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { getDb, getUserAssets } from "./db";
import { getLiveConfig } from "./liveOrderExecutor";
import { isKronosEligible, type KronosDirection } from "./kronosEngine";
import { kronosConvictionCache, type LiveEngineConfig } from "../drizzle/schema";
import { sql } from "drizzle-orm";

// ── Kronos run params (quant §6 — swing horizon) ──────────────────────────────
// CORRECT live skill path (kronosEngine.ts:36 still has the stale .cursor path; the
// ADR says flag-but-do-not-fix that legacy file — this NEW job uses the right one).
const KRONOS_SCRIPT = path.join(
  process.env.HOME ?? "/root",
  ".claude/skills/kronos/scripts/run_kronos.py",
);
const RUN_PERIOD   = "1y";
const RUN_INTERVAL = "1d";
const RUN_PRED_LEN = 7;
const RUN_SAMPLES  = "20";              // KRONOS_SAMPLES — stabilises the band (our primary signal)
const PER_TICKER_TIMEOUT_MS = 180_000;  // 3 min/ticker (first run may download model)
const JOB_WALLCLOCK_BUDGET_MS = 50 * 60 * 1000; // bound a slow run so it can't bleed into the next hour

// ── Mapping constants (quant §3 / §4 / §8.3) ──────────────────────────────────
const AGREE_DEADBAND = 1.0;   // % — matches script's own UP/DOWN bar
const VETO_THRESHOLD = -2.0;  // % — opposing forecast hard-block trigger
const VETO_MAX_BAND  = 15.0;  // % — only veto on a CREDIBLE (non-noise) opposing forecast
const W_TIGHT = 4.0;          // % full-band → C = 1.0
const W_WIDE  = 20.0;         // % full-band → C = 0.0
const M_MIN   = 1.0;          // % move floor for any magnitude credit
const M_FULL  = 6.0;          // % move saturation (wild forecasts clipped here)

export type TradeDir = "long" | "short";

// ── Re-entrancy guard ─────────────────────────────────────────────────────────
// The :05 trigger can double-fire under timer drift; a second concurrent run would
// spawn ~25 more python subprocesses (CPU storm). Module-level lock: a run already
// in flight short-circuits the duplicate. Reset in finally so a crash never wedges it.
let _kronosJobRunning = false;

export interface KronosAddonResult {
  /** 0..2.5 conviction addon (full precision; do NOT round before the gate compare). */
  addon: number;
  /** Hard veto — credible opposing forecast. Engine BLOCKS regardless of ZIV. */
  veto: boolean;
  /** Cache miss/stale/weight-0 → fail-open bonus (addon 0), never blocks. */
  stale: boolean;
  /** Human-readable reason for logs/telemetry. */
  reason: string;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Pure mapping: kronos forecast (from the trade's perspective) → addon ∈ [0,2.5].
 * `pctChange` is the signed JSON pct_change (LONG perspective); `bandWidthPct` is
 * the FULL 95% width. `dir` is the candidate's trade direction. Returns the addon
 * and a veto flag. No I/O, no rounding (caller rounds for display only).
 */
export function mapKronosAddon(
  pctChange: number,
  bandWidthPct: number,
  dir: TradeDir,
): { addon: number; veto: boolean } {
  // signedMove > 0 ⇒ forecast agrees with the trade. For SHORT a DOWN forecast agrees.
  const signedMove = dir === "long" ? pctChange : -pctChange;
  const w = bandWidthPct;

  // §4 veto FIRST: credible opposing forecast (tight-ish band) → hard block.
  if (signedMove <= VETO_THRESHOLD && w <= VETO_MAX_BAND) {
    return { addon: 0, veto: true };
  }
  // FLAT / deadband (incl. noisy opposition, band>15) → no contribution, no veto.
  if (signedMove < AGREE_DEADBAND) {
    return { addon: 0, veto: false };
  }

  const A = 1;
  const C = clamp01((W_WIDE - w) / (W_WIDE - W_TIGHT)); // narrow = high
  const m = Math.abs(signedMove);
  const M = clamp01((m - M_MIN) / (M_FULL - M_MIN));     // saturating, clipped at 6%
  return { addon: 2.5 * A * C * M, veto: false };
}

// ── Raw kronos JSON we consume (quant §2 — five fields) ───────────────────────
interface KronosConvictionForecast {
  ticker: string;
  direction: KronosDirection;
  pctChange: number;     // signed % (LONG perspective)
  bandWidthPct: number;  // FULL 95% width % (consumed as-is, NOT halved)
}

/**
 * Spawn run_kronos.py for one ticker and parse the conviction-relevant JSON fields.
 * Reads the JSON's OWN `band_width_pct` (full width, vs pred_close) per the quant
 * note — does NOT recompute it (kronosEngine.ts recomputes off last_close, which is
 * the legacy catalogue path; this entry path must honour the JSON field exactly).
 * Resolves null on any failure (timeout / non-zero exit / bad JSON) — fail-open.
 */
function spawnKronosForecast(ticker: string): Promise<KronosConvictionForecast | null> {
  return new Promise((resolve) => {
    const args = [
      KRONOS_SCRIPT,
      ticker.toUpperCase(),
      RUN_PERIOD,
      RUN_INTERVAL,
      String(RUN_PRED_LEN),
      "--json",
    ];
    // DEFENSE-IN-DEPTH (live engine): spawn() can throw SYNCHRONOUSLY (bad options,
    // EMFILE). The common live failure — the ~/.claude/skills/kronos script path does
    // NOT exist on the droplet — surfaces ASYNC as ENOENT via child.on("error") below.
    // Both branches resolve(null) (fail-open): a missing-script ENOENT can NEVER throw
    // or produce an unhandledRejection. (Job-level loop also try/catches per ticker.)
    let child;
    try {
      child = spawn("python3", args, {
        env: { ...process.env, KRONOS_SAMPLES: RUN_SAMPLES },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      console.warn(`[KronosConviction] spawn threw ${ticker}:`, err?.message ?? err);
      resolve(null);
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      console.warn(`[KronosConviction] timeout ${ticker}`);
      resolve(null);
    }, PER_TICKER_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.warn(`[KronosConviction] ${ticker} exit ${code}: ${stderr.slice(0, 200)}`);
        resolve(null);
        return;
      }
      try {
        const line = stdout.trim().split("\n").find((l) => l.startsWith("{"));
        if (!line) { console.warn(`[KronosConviction] ${ticker}: no JSON`); resolve(null); return; }
        const raw = JSON.parse(line);
        const pctChange = Number(raw.pct_change);
        const bandWidthPct = Number(raw.band_width_pct); // FULL width — consume as-is
        if (!Number.isFinite(pctChange) || !Number.isFinite(bandWidthPct)) {
          console.warn(`[KronosConviction] ${ticker}: bad numeric fields`);
          resolve(null);
          return;
        }
        resolve({
          ticker: ticker.toUpperCase(),
          direction: (raw.direction as KronosDirection) ?? "FLAT",
          pctChange,
          bandWidthPct,
        });
      } catch (e) {
        console.warn(`[KronosConviction] ${ticker} parse error:`, e);
        resolve(null);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      console.warn(`[KronosConviction] spawn error ${ticker}:`, err.message);
      resolve(null);
    });
  });
}

/**
 * HOURLY JOB (fire-and-forget from alertPoller :05). Picks the ZIV≥floor survivors
 * (catalogue score, the quant-recommended pre-filter), runs kronos per name, and
 * upserts ONE cache row per ticker. Direction-agnostic at write time: it stores the
 * kronos forecast direction + the LONG-perspective addon ingredients; the read
 * helper re-derives the per-trade-direction addon. Best-effort: a single ticker's
 * failure is logged and skipped — the whole job is wrapped to never throw.
 */
export async function runKronosConvictionJob(userId: number): Promise<{
  scored: number;
  scanned: number;
  skipped: number;
}> {
  // RE-ENTRANCY GUARD — never let a drifted :05 trigger double the subprocess load.
  if (_kronosJobRunning) {
    console.warn("[KronosConviction] previous run still in flight — skipping duplicate trigger");
    return { scored: 0, scanned: 0, skipped: 0 };
  }
  _kronosJobRunning = true;
  try {
    return await _runKronosConvictionJob(userId);
  } finally {
    _kronosJobRunning = false;
  }
}

async function _runKronosConvictionJob(userId: number): Promise<{
  scored: number;
  scanned: number;
  skipped: number;
}> {
  const cfg = await getLiveConfig(userId);
  // COMPUTE / GATING DECOUPLE (2026-06-25): the job RUNS (populates the cache for UI
  // DISPLAY/validation) when EITHER kronosComputeEnabled=1 OR kronosConvictionWeight>0.
  // weight>0 still means "armed for gating" (warEngine reads + gates); kronosComputeEnabled
  // alone means "compute + cache for display only" — the gate is untouched because the
  // warEngine read helper snaps weight=0 to addon-0 (no gating effect). When BOTH are off,
  // skip entirely (do not spawn kronos).
  const computeEnabled = ((cfg as { kronosComputeEnabled?: number } | null)?.kronosComputeEnabled ?? 0) === 1;
  const weightArmed = (cfg?.kronosConvictionWeight ?? 0) > 0;
  if (!cfg || (!computeEnabled && !weightArmed)) {
    console.log("[KronosConviction] compute OFF (kronosComputeEnabled=0 & weight=0) — job skipped (pure-ZIV mode, no cache)");
    return { scored: 0, scanned: 0, skipped: 0 };
  }
  if (computeEnabled && !weightArmed) {
    console.log("[KronosConviction] DISPLAY mode — kronosComputeEnabled=1, weight=0: computing for UI only (no gating effect)");
  }

  const db = await getDb();
  if (!db) { console.warn("[KronosConviction] no db — skipped"); return { scored: 0, scanned: 0, skipped: 0 }; }

  const floor = cfg.zivStructuralFloor ?? 6.5;
  const universeSize = cfg.kronosUniverseSize ?? 25;

  // Universe = ZIV≥floor catalogue survivors (quant §10 OQ-2 recommendation:
  // kronos is irrelevant for names that fail the structural floor), kronos-eligible,
  // top-N by ZIV score. This is the cheapest set that still covers every name that
  // could plausibly clear the combined gate this hour.
  const assets = await getUserAssets(userId);
  const universe = assets
    .filter((a) => isKronosEligible(a.ticker))
    .filter((a) => (a as { catalogStatus?: string | null }).catalogStatus !== "IPO_INCUBATOR")
    .filter((a) => Number((a as { score?: number | null }).score ?? 0) >= floor)
    .sort((a, b) => Number((b as any).score ?? 0) - Number((a as any).score ?? 0))
    .slice(0, universeSize)
    .map((a) => a.ticker.toUpperCase());

  console.log(`[KronosConviction] job START — ${universe.length} survivors (ZIV≥${floor}), samples=${RUN_SAMPLES}`);

  const startedAt = Date.now();
  let scored = 0, scanned = 0, skipped = 0;

  for (const ticker of universe) {
    if (Date.now() - startedAt > JOB_WALLCLOCK_BUDGET_MS) {
      console.warn(`[KronosConviction] wall-clock budget hit — stopping after ${scanned} (${universe.length - scanned} unscored, will refresh next hour)`);
      break;
    }
    scanned++;
    try {
      const fc = await spawnKronosForecast(ticker);
      if (!fc) { skipped++; continue; } // fail-open: no row written → read sees miss → addon 0

      // Store the LONG-perspective addon ingredients. The veto/direction logic is
      // re-applied per trade-direction at read time, so we persist the raw signed
      // forecast + band and a LONG-perspective addon for quick display.
      const longMap = mapKronosAddon(fc.pctChange, fc.bandWidthPct, "long");
      const addonForStore = longMap.veto ? 0 : longMap.addon;

      await db
        .insert(kronosConvictionCache)
        .values({
          ticker,
          direction: fc.direction,
          addon: addonForStore,
          rawForecastPct: fc.pctChange,
          bandWidthPct: fc.bandWidthPct,
          computedAt: new Date(),
        })
        .onDuplicateKeyUpdate({
          set: {
            direction: fc.direction,
            addon: addonForStore,
            rawForecastPct: fc.pctChange,
            bandWidthPct: fc.bandWidthPct,
            computedAt: new Date(),
          },
        });
      scored++;
    } catch (e) {
      // Defensive: a single ticker (spawn/DB) failure must not crash the job.
      skipped++;
      console.warn(`[KronosConviction] ${ticker} job-row error:`, e);
    }
  }

  console.log(`[KronosConviction] job DONE — scored=${scored} scanned=${scanned} skipped=${skipped}`);
  return { scored, scanned, skipped };
}

/**
 * READ HELPER for the War Engine. NEVER throws, NEVER spawns kronos.
 * Caller passes the already-fetched cache row (cycle pre-loads them in one query)
 * and the live config. Applies: weight-0 bypass, staleness decay, direction re-map,
 * veto. Returns {addon:0, stale:true} for miss/stale/weight-0 so an outage can
 * never freeze entries (DEGRADED MODE — caller drops the gate to degradedGate).
 *
 * `row` is the persisted cache row or null/undefined (miss).
 */
export function getKronosAddonFromRow(
  row: { addon: number; direction: string | null; rawForecastPct: number | null; bandWidthPct: number | null; computedAt: Date | string | null } | null | undefined,
  dir: TradeDir,
  cfg: Pick<LiveEngineConfig, "kronosConvictionWeight" | "kronosStalenessMin"> | null | undefined,
): KronosAddonResult {
  // WEIGHT FOOT-GUN GUARD (clamp-on-read): the addon is capped at `weight`, so a
  // config weight in (0, 0.5) would make max-combined < the 8.0 combinedGate and
  // SILENTLY freeze every kronos-active entry. Valid domain is {0} ∪ [0.5, 2.5].
  // A fat-finger small positive value is treated as OFF (snap-to-0, the SAFE choice:
  // it reverts to legacy ZIV-alone entries rather than freezing them). >2.5 is capped.
  const rawWeight = cfg?.kronosConvictionWeight ?? 0;
  const weight = rawWeight < 0.5 ? 0 : Math.min(rawWeight, 2.5);
  // KILL-SWITCH — clean total bypass of the kronos path (also catches snapped 0<w<0.5).
  if (weight <= 0) {
    return { addon: 0, veto: false, stale: false, reason: "kronos OFF (weight<0.5 → snapped to 0)" };
  }
  if (!row || row.computedAt == null) {
    return { addon: 0, veto: false, stale: true, reason: "kronos cache miss" };
  }
  const staleMin = cfg?.kronosStalenessMin ?? 90;
  const ageMs = Date.now() - new Date(row.computedAt).getTime();
  if (ageMs > staleMin * 60_000) {
    return { addon: 0, veto: false, stale: true, reason: `kronos stale (${Math.round(ageMs / 60_000)}min > ${staleMin})` };
  }

  // Fresh row → re-derive addon + veto from the PER-TRADE-DIRECTION perspective,
  // using the persisted raw forecast (so a SHORT reads a DOWN forecast as agreement
  // and an UP forecast as a potential veto). Recomputing here keeps the cache
  // direction-agnostic and avoids storing two addons.
  const pct = Number(row.rawForecastPct);
  const band = Number(row.bandWidthPct);
  if (!Number.isFinite(pct) || !Number.isFinite(band)) {
    return { addon: 0, veto: false, stale: true, reason: "kronos cache: bad raw fields" };
  }
  const { addon, veto } = mapKronosAddon(pct, band, dir);
  if (veto) {
    return {
      addon: 0,
      veto: true,
      stale: false,
      reason: `kronos veto: forecast opposes direction (${pct.toFixed(1)}%, band ${band.toFixed(1)}%)`,
    };
  }
  // Clamp the addon to the configured weight (the master cap, 0..2.5).
  const capped = Math.min(addon, weight);
  return { addon: capped, veto: false, stale: false, reason: `kronos addon ${capped.toFixed(2)}` };
}

/**
 * Convenience reader: fetch all fresh cache rows for a set of tickers in one query.
 * Returns a Map keyed by UPPER ticker. Never throws (returns empty map on failure)
 * so the War Engine cycle cannot be wedged by a cache read.
 */
export async function loadKronosConvictionCache(
  tickers: string[],
): Promise<Map<string, { addon: number; direction: string | null; rawForecastPct: number | null; bandWidthPct: number | null; computedAt: Date | string | null }>> {
  const out = new Map<string, any>();
  if (tickers.length === 0) return out;
  try {
    const db = await getDb();
    if (!db) return out;
    const upper = tickers.map((t) => t.toUpperCase());
    const rows = await db
      .select()
      .from(kronosConvictionCache)
      .where(sql`UPPER(${kronosConvictionCache.ticker}) IN (${sql.join(upper.map((t) => sql`${t}`), sql`, `)})`);
    for (const r of rows) out.set(r.ticker.toUpperCase(), r);
  } catch (e) {
    console.warn("[KronosConviction] cache load failed (treating as empty):", e);
  }
  return out;
}
